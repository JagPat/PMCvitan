import 'reflect-metadata';
import { dirname, join, relative, sep } from 'node:path';
import * as ts from 'typescript';
import { RequestMethod } from '@nestjs/common';
import { PATH_METADATA, METHOD_METADATA, MODULE_METADATA } from '@nestjs/common/constants';
import { Prisma } from '@prisma/client';
import type { ModuleManifest } from '@vitan/shared';
import { readEncapsulation } from '@vitan/shared';
import { AppModule } from '../../app.module';
import { MODULE_MANIFESTS } from './registry';
import { RAW_SQL_WRITE_WAIVERS, CROSS_MODULE_WRITE_WAIVERS, type RawSqlWriteWaiver, type CrossModuleWriteWaiver } from './boundary-waivers';

/**
 * Phase 2 PR C Task 4 — the STRUCTURALLY-COMPLETE module boundary analyzer.
 *
 * This replaces the old filename/regex approximation with three metadata/compiler sources
 * of truth, so a boundary can never drift behind a naming convention:
 *
 *   1. MODEL OWNERSHIP is read from the Prisma DMMF (`Prisma.dmmf.datamodel.models`) — the
 *      generated schema itself — and must exactly equal the union of the manifests'
 *      `ownsModels`. A model with no owner, a model owned twice, or a manifest owning a
 *      non-existent model is a finding.
 *   2. HTTP ROUTES are read from Nest's controller + handler metadata (`PATH_METADATA` /
 *      `METHOD_METADATA`) off the classes the AppModule actually registers, combined into a
 *      fully-qualified `"<METHOD> /path"`, and must exactly equal the union of the manifests'
 *      `routes`. Duplicate contributions are findings.
 *   3. PERSISTENCE is read from the TypeScript type checker: a Program is built over the
 *      files the running application loads (reachable from `main.ts` / `app.module.ts` — this
 *      is the precise meaning of "runtime" and it naturally excludes tests, generated client
 *      code, and the seed/CLI entrypoints that are not part of the server). Every symbol whose
 *      type originates from `PrismaService` / `PrismaClient` / `Prisma.TransactionClient` is
 *      followed through property access, parameters, aliases and destructuring, and each
 *      `create|createMany|update|updateMany|upsert|delete|deleteMany` call plus each raw
 *      write-SQL statement is attributed to a (file, model). A write to a model owned by a
 *      DIFFERENT non-platform module — or an un-analyzable dynamic `prisma[name]` delegate, or
 *      a raw write with no exact waiver — is a finding.
 *
 * Every function here is pure w.r.t. its inputs so the adversarial fixtures can drive the
 * analyzer against crafted programs; the real check wires the live manifests/DMMF/controllers.
 */

export interface BoundaryFinding {
  /** Machine code, e.g. `cross-module-write`, `dynamic-delegate`, `raw-write-unwaived`. */
  readonly code: string;
  /** Human-readable explanation. */
  readonly message: string;
  readonly file?: string;
  readonly symbol?: string;
  readonly model?: string;
  readonly route?: string;
}

/** The Prisma delegate write methods (a call to one of these mutates rows). Includes the
 *  `*AndReturn` variants (Prisma ≥6, PostgreSQL, GA — no preview flag), which also insert/update. */
export const WRITE_METHODS: ReadonlySet<string> = new Set([
  'create',
  'createMany',
  'createManyAndReturn',
  'update',
  'updateMany',
  'updateManyAndReturn',
  'upsert',
  'delete',
  'deleteMany',
]);

/** Prisma NESTED write operations — inside a write's `data`/`create`/`update`, a relation field
 *  keyed to one of these mutates the RELATED model's table (never a delegate call of its own), so the
 *  analyzer must attribute the write to that related model or a cross-module nested write is invisible. */
const NESTED_WRITE_OPS: ReadonlySet<string> = new Set([
  'create',
  'createMany',
  'connectOrCreate',
  'update',
  'updateMany',
  'upsert',
  'delete',
  'deleteMany',
]);

/** The Prisma delegate READ methods (a call to one of these reads rows). Tracked only to enforce
 *  READ-ENCAPSULATION (Task 8): a read of a read-encapsulated model from another module is a
 *  `cross-module-read` finding. Non-encapsulated models' reads are ignored (the default). */
export const READ_METHODS: ReadonlySet<string> = new Set([
  'findUnique',
  'findUniqueOrThrow',
  'findFirst',
  'findFirstOrThrow',
  'findMany',
  'count',
  'aggregate',
  'groupBy',
]);

/** The Prisma raw-query methods (tagged-template or call form). */
export const RAW_METHOD_NAMES: readonly string[] = ['$queryRaw', '$queryRawUnsafe', '$executeRaw', '$executeRawUnsafe'];

/** HTTP methods that mutate — the manifest `routes` enumerate exactly these. */
const MUTATING_HTTP = new Set<number>([RequestMethod.POST, RequestMethod.PUT, RequestMethod.PATCH, RequestMethod.DELETE]);

/**
 * A source file's top-level `src/<dir>` → its owning module id. Infra directories that only
 * touch shared/platform tables (or nothing) map to `platform`; anything unmapped (root-level
 * files) is `platform` too.
 */
export const DEFAULT_DIR_TO_MODULE: Readonly<Record<string, string>> = {
  decisions: 'decisions',
  activities: 'activities',
  inspections: 'inspections',
  drawings: 'drawings',
  'daily-log': 'daily-log',
  nodes: 'nodes',
  media: 'media',
  orgs: 'orgs',
  auth: 'auth',
  platform: 'platform',
  push: 'platform',
  realtime: 'platform',
  snapshot: 'platform',
  common: 'platform',
  domain: 'platform',
};

// ── (1) Model ownership from the Prisma DMMF ──────────────────────────────────────────────

/** Every Prisma model's delegate name (camelCase first letter), as `PrismaService` exposes it. */
export function prismaModelDelegates(): Set<string> {
  return new Set(Prisma.dmmf.datamodel.models.map((m) => m.name.charAt(0).toLowerCase() + m.name.slice(1)));
}

/** `delegate (lower-first) -> { relationField -> related delegate (lower-first) }`, from the DMMF.
 *  A Prisma NESTED write (`data: { <relation>: { create|update|delete|… } }`) mutates the RELATED
 *  model's table, so the analyzer resolves the relation field to the foreign delegate through this. */
export function prismaModelRelations(): Map<string, Map<string, string>> {
  const toDelegate = (n: string): string => n.charAt(0).toLowerCase() + n.slice(1);
  const out = new Map<string, Map<string, string>>();
  for (const m of Prisma.dmmf.datamodel.models) {
    const rels = new Map<string, string>();
    for (const f of m.fields) if (f.kind === 'object') rels.set(f.name, toDelegate(f.type));
    out.set(toDelegate(m.name), rels);
  }
  return out;
}

/** Compare the DMMF model set to the union of manifest `ownsModels` — exact equality required. */
export function analyzeModelOwnership(
  manifests: readonly ModuleManifest[],
  delegates: Set<string> = prismaModelDelegates(),
): { findings: BoundaryFinding[]; delegates: Set<string> } {
  const findings: BoundaryFinding[] = [];
  const owned = new Map<string, string[]>();
  for (const m of manifests) {
    for (const model of m.ownsModels) {
      const owners = owned.get(model) ?? [];
      owners.push(m.id);
      owned.set(model, owners);
    }
  }
  for (const [model, owners] of owned) {
    if (owners.length > 1) findings.push({ code: 'model-duplicate-owner', message: `model '${model}' is owned by multiple modules: ${owners.join(', ')}`, model });
  }
  for (const delegate of delegates) {
    if (!owned.has(delegate)) findings.push({ code: 'model-no-owner', message: `Prisma model delegate '${delegate}' has no manifest owner — add it to a module's ownsModels`, model: delegate });
  }
  for (const model of owned.keys()) {
    if (!delegates.has(model)) findings.push({ code: 'model-unknown', message: `a manifest owns '${model}', which is not a Prisma model delegate`, model });
  }
  return { findings, delegates };
}

/** `prisma model delegate -> owning module id`, from the manifests. */
export function ownerOfModel(manifests: readonly ModuleManifest[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of manifests) for (const model of m.ownsModels) out.set(model, m.id);
  return out;
}

/** `module id -> kind`, from the manifests. */
export function kindOfModule(manifests: readonly ModuleManifest[]): Map<string, ModuleManifest['kind']> {
  const out = new Map<string, ModuleManifest['kind']>();
  for (const m of manifests) out.set(m.id, m.kind);
  return out;
}

// ── (2) Full routes from Nest metadata ────────────────────────────────────────────────────

function joinRoutePath(base: string, method: string): string {
  const parts = [base, method].flatMap((p) => (p ?? '').split('/')).map((s) => s.trim()).filter(Boolean);
  return `/${parts.join('/')}`;
}

/** The controller classes the AppModule registers (structural — a new controller shows up here). */
export function appControllers(): ReadonlyArray<new (...args: never[]) => unknown> {
  return (Reflect.getMetadata(MODULE_METADATA.CONTROLLERS, AppModule) as Array<new (...args: never[]) => unknown> | undefined) ?? [];
}

/** `"<METHOD> /fully/qualified/path"` -> the controller class names that declare it (mutating only). */
export function mutatingControllerRoutes(controllers: ReadonlyArray<new (...args: never[]) => unknown>): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const Controller of controllers) {
    const base = (Reflect.getMetadata(PATH_METADATA, Controller) as string | undefined) ?? '';
    const proto = Controller.prototype as Record<string, unknown>;
    for (const name of Object.getOwnPropertyNames(proto)) {
      if (name === 'constructor') continue;
      const handler = proto[name];
      if (typeof handler !== 'function') continue;
      const httpMethod = Reflect.getMetadata(METHOD_METADATA, handler) as number | undefined;
      if (httpMethod === undefined || !MUTATING_HTTP.has(httpMethod)) continue;
      const methodPath = (Reflect.getMetadata(PATH_METADATA, handler) as string | undefined) ?? '';
      const route = `${RequestMethod[httpMethod]} ${joinRoutePath(base, methodPath)}`;
      const owners = out.get(route) ?? [];
      owners.push(Controller.name);
      out.set(route, owners);
    }
  }
  return out;
}

/** Require exact equality between the manifests' `routes` and the controllers' mutating routes. */
export function analyzeRoutes(
  manifests: readonly ModuleManifest[],
  controllers: ReadonlyArray<new (...args: never[]) => unknown>,
): BoundaryFinding[] {
  const findings: BoundaryFinding[] = [];
  const derived = mutatingControllerRoutes(controllers);
  const declared = new Map<string, string[]>();
  for (const m of manifests) {
    for (const r of m.routes) {
      const owners = declared.get(r) ?? [];
      owners.push(m.id);
      declared.set(r, owners);
    }
  }
  for (const [route, ctrls] of derived) if (ctrls.length > 1) findings.push({ code: 'route-duplicate', message: `route '${route}' is declared by multiple controllers: ${ctrls.join(', ')}`, route });
  for (const [route, mods] of declared) if (mods.length > 1) findings.push({ code: 'route-duplicate', message: `route '${route}' is contributed by multiple manifests: ${mods.join(', ')}`, route });
  // Param-name-insensitive collision: two routes with the same METHOD + structural path but different
  // param names (`…/decisions/:id` vs `…/decisions/:decisionId`) are distinct strings yet collide at
  // Nest runtime. Normalize every param to a positional placeholder and flag a structural duplicate.
  const structural = new Map<string, Set<string>>();
  for (const route of derived.keys()) {
    const norm = route.replace(/:[A-Za-z0-9_]+/g, ':_');
    (structural.get(norm) ?? structural.set(norm, new Set()).get(norm)!).add(route);
  }
  for (const routes of structural.values()) {
    if (routes.size > 1) findings.push({ code: 'route-structural-duplicate', message: `routes collide structurally (same path, differing param names): ${[...routes].join(' / ')}`, route: [...routes][0] });
  }
  for (const route of derived.keys()) if (!declared.has(route)) findings.push({ code: 'route-missing-owner', message: `controller route '${route}' is declared by no manifest`, route });
  for (const route of declared.keys()) if (!derived.has(route)) findings.push({ code: 'route-unexpected', message: `a manifest declares route '${route}' that no registered controller exposes`, route });
  return findings;
}

// ── (3) Compiler-symbol persistence analysis ──────────────────────────────────────────────

export interface DelegateWrite {
  readonly file: string;
  readonly module: string;
  readonly model: string;
  readonly owner?: string;
  readonly ownerKind?: string;
  readonly symbol: string;
}
export interface RawWrite {
  readonly file: string;
  readonly module: string;
  readonly symbol: string;
  readonly sql: string;
}
export interface DynamicWrite {
  readonly file: string;
  readonly module: string;
  readonly symbol: string;
}

export interface PersistenceOptions {
  readonly program: ts.Program;
  /** Absolute file names (TS forward-slash form) to analyze. */
  readonly files: ReadonlySet<string>;
  /** The source root; module ownership + relative paths are computed against it. */
  readonly rootDir: string;
  readonly ownerOf: ReadonlyMap<string, string>;
  readonly kindOf: ReadonlyMap<string, string>;
  readonly dirToModule?: Readonly<Record<string, string>>;
  readonly rawWaivers?: readonly RawSqlWriteWaiver[];
  readonly crossWaivers?: readonly CrossModuleWriteWaiver[];
  readonly delegates?: Set<string>;
  /** `delegate -> { relationField -> related delegate }` for NESTED-write attribution (defaults to
   *  the live DMMF via {@link prismaModelRelations}). Fixtures inject a synthetic map. */
  readonly relationsOf?: ReadonlyMap<string, ReadonlyMap<string, string>>;
  /** `read-encapsulated model -> owning module id` (Task 8). A READ of one of these models from a
   *  module other than its owner is a `cross-module-read` finding. Empty ⇒ reads are unrestricted. */
  readonly readEncapsulatedBy?: ReadonlyMap<string, string>;
}

export interface PersistenceResult {
  readonly findings: BoundaryFinding[];
  readonly writes: DelegateWrite[];
  readonly rawWrites: RawWrite[];
  readonly dynamicWrites: DynamicWrite[];
  /** Reads of read-encapsulated models, attributed to the reading module (Task 8). */
  readonly reads: DelegateWrite[];
}

const INSERT_RE = /\binsert\s+into\b/i;
const DELETE_RE = /\bdelete\s+from\b/i;
// A real UPDATE writes `UPDATE <table> SET …` (a `SELECT … FOR UPDATE` row lock has no SET).
const UPDATE_RE = /\bupdate\s+(?:"[^"]+"|[a-z_][\w.]*)\s+set\b/i;
// An UPDATE whose table was interpolated away (`UPDATE ${Prisma.raw(t)} SET …` → "UPDATE  SET …"
// after the interpolation is gathered out): still a write, and must not slip past classification.
const UPDATE_INTERP_RE = /\bupdate\s+set\b/i;
const TRUNCATE_RE = /\btruncate\b/i;
const MERGE_RE = /\bmerge\s+into\b/i;
// COPY "<table>" FROM … loads rows (COPY … TO is a read; require FROM after COPY).
const COPY_FROM_RE = /\bcopy\b[\s\S]*?\bfrom\b/i;

function isWriteSql(sql: string): boolean {
  return (
    INSERT_RE.test(sql) ||
    DELETE_RE.test(sql) ||
    UPDATE_RE.test(sql) ||
    UPDATE_INTERP_RE.test(sql) ||
    TRUNCATE_RE.test(sql) ||
    MERGE_RE.test(sql) ||
    COPY_FROM_RE.test(sql)
  );
}

/**
 * Analyze Prisma persistence over the given program/files. Follows every write-method call and
 * raw write-SQL statement to a model + writing module, and flags a boundary crossing, an
 * un-analyzable dynamic delegate, or an un-waived raw write.
 */
export function analyzePersistence(opts: PersistenceOptions): PersistenceResult {
  const { program, files, rootDir, ownerOf, kindOf } = opts;
  const dirToModule = opts.dirToModule ?? DEFAULT_DIR_TO_MODULE;
  const rawWaivers = opts.rawWaivers ?? [];
  const crossWaivers = opts.crossWaivers ?? [];
  const delegates = opts.delegates ?? prismaModelDelegates();
  const relationsOf = opts.relationsOf ?? prismaModelRelations();
  const readEncapsulatedBy = opts.readEncapsulatedBy ?? new Map<string, string>();
  const checker = program.getTypeChecker();
  const moduleIds = new Set(kindOf.keys());

  const writes: DelegateWrite[] = [];
  const rawWrites: RawWrite[] = [];
  const dynamicWrites: DynamicWrite[] = [];
  const reads: DelegateWrite[] = [];

  const hasRaw = (t: ts.Type): boolean => RAW_METHOD_NAMES.some((m) => !!t.getProperty(m));
  const typeLooksPrisma = (t: ts.Type): boolean => {
    if (hasRaw(t) || hasRaw(checker.getApparentType(t))) return true;
    const names = [t.symbol?.name, t.aliasSymbol?.name].filter((n): n is string => typeof n === 'string');
    return names.some((n) => /Prisma(Service|Client)|TransactionClient/.test(n));
  };
  const isPrismaHolder = (expr: ts.Expression): boolean => typeLooksPrisma(checker.getTypeAtLocation(expr));

  type DelegateResolution = { kind: 'model'; model: string } | { kind: 'dynamic' } | null;
  const resolveDelegate = (recv: ts.Expression): DelegateResolution => {
    if (ts.isPropertyAccessExpression(recv)) {
      const name = recv.name.text;
      if (delegates.has(name) && isPrismaHolder(recv.expression)) return { kind: 'model', model: name };
      return null;
    }
    if (ts.isElementAccessExpression(recv)) {
      if (isPrismaHolder(recv.expression)) return { kind: 'dynamic' };
      return null;
    }
    if (ts.isIdentifier(recv)) {
      const decl = checker.getSymbolAtLocation(recv)?.declarations?.[0];
      if (!decl) return null;
      // destructured delegate: `const { activity } = prisma` / `const { activity: a } = prisma`
      if (ts.isBindingElement(decl)) {
        const pattern = decl.parent;
        if (ts.isObjectBindingPattern(pattern) && ts.isVariableDeclaration(pattern.parent) && pattern.parent.initializer && isPrismaHolder(pattern.parent.initializer)) {
          const prop = decl.propertyName && ts.isIdentifier(decl.propertyName) ? decl.propertyName.text : ts.isIdentifier(decl.name) ? decl.name.text : undefined;
          if (prop && delegates.has(prop)) return { kind: 'model', model: prop };
        }
        return null;
      }
      // aliased delegate: `const d = prisma.activity`
      if (ts.isVariableDeclaration(decl) && decl.initializer) return resolveDelegate(decl.initializer);
    }
    return null;
  };

  const enclosingSymbol = (node: ts.Node): string => {
    let n: ts.Node | undefined = node.parent;
    while (n) {
      if (ts.isMethodDeclaration(n) || ts.isFunctionDeclaration(n) || ts.isGetAccessorDeclaration(n) || ts.isSetAccessorDeclaration(n)) {
        return n.name && ts.isIdentifier(n.name) ? n.name.text : '<anonymous>';
      }
      if (ts.isConstructorDeclaration(n)) return 'constructor';
      if (ts.isFunctionExpression(n) || ts.isArrowFunction(n)) {
        const p = n.parent;
        if (ts.isVariableDeclaration(p) && ts.isIdentifier(p.name)) return p.name.text;
        if (ts.isPropertyDeclaration(p) && ts.isIdentifier(p.name)) return p.name.text;
        if (ts.isPropertyAssignment(p) && ts.isIdentifier(p.name)) return p.name.text;
      }
      n = n.parent;
    }
    return '<module>';
  };

  const collectSqlText = (node: ts.Node): string => {
    let sql = '';
    const gather = (n: ts.Node): void => {
      if (
        ts.isStringLiteral(n) ||
        ts.isNoSubstitutionTemplateLiteral(n) ||
        n.kind === ts.SyntaxKind.TemplateHead ||
        n.kind === ts.SyntaxKind.TemplateMiddle ||
        n.kind === ts.SyntaxKind.TemplateTail
      ) {
        sql += ` ${(n as ts.LiteralLikeNode).text}`;
      }
      ts.forEachChild(n, gather);
    };
    gather(node);
    return sql.trim();
  };

  // ── Nested-write attribution (a relation-keyed create/update/delete inside a write's payload) ──
  const unwrapExpr = (e: ts.Expression): ts.Expression => {
    let x: ts.Expression = e;
    while (ts.isParenthesizedExpression(x) || ts.isAsExpression(x) || ts.isSatisfiesExpression(x)) x = x.expression;
    return x;
  };
  const propKeyName = (n: ts.PropertyName): string | undefined =>
    ts.isIdentifier(n) || ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) ? n.text : undefined;
  const propValueOf = (obj: ts.ObjectLiteralExpression, key: string): ts.Expression | undefined => {
    for (const p of obj.properties) if (ts.isPropertyAssignment(p) && propKeyName(p.name) === key) return p.initializer;
    return undefined;
  };
  /** The object literal(s) an expression denotes: itself, each array element, or a variable's
   *  object-literal initializer (one level) — so `data: rows` and `data: [ {…} ]` are both seen. */
  const objectLiteralsOf = (expr: ts.Expression): ts.ObjectLiteralExpression[] => {
    const e = unwrapExpr(expr);
    if (ts.isObjectLiteralExpression(e)) return [e];
    if (ts.isArrayLiteralExpression(e)) return e.elements.flatMap((el) => objectLiteralsOf(el));
    if (ts.isIdentifier(e)) {
      const decl = checker.getSymbolAtLocation(e)?.declarations?.[0];
      if (decl && ts.isVariableDeclaration(decl) && decl.initializer) return objectLiteralsOf(decl.initializer);
    }
    return [];
  };
  /** The nested-write payload object literals reachable from one relation op's value — the value
   *  itself and its `data`/`create`/`update` sub-objects — so deeper relation writes keep resolving. */
  const innerPayloadsOf = (opValue: ts.Expression): ts.ObjectLiteralExpression[] => {
    const out: ts.ObjectLiteralExpression[] = [];
    for (const o of objectLiteralsOf(opValue)) {
      out.push(o);
      for (const sub of ['data', 'create', 'update']) {
        const v = propValueOf(o, sub);
        if (v) out.push(...objectLiteralsOf(v));
      }
    }
    return out;
  };
  const recordModelWrite = (model: string, node: ts.Node, rel: string, mod: string): void => {
    const owner = ownerOf.get(model);
    writes.push({ file: rel, module: mod, model, owner, ownerKind: owner ? kindOf.get(owner) : undefined, symbol: enclosingSymbol(node) });
  };
  /** Walk a write payload in the context of `model`: any relation field whose value carries a nested
   *  write op mutates the RELATED model — record it and recurse into that op's payload for deeper ones. */
  const scanNestedWrites = (payload: ts.ObjectLiteralExpression, model: string, node: ts.Node, rel: string, mod: string, depth: number): void => {
    if (depth > 8) return;
    const rels = relationsOf.get(model);
    if (!rels) return;
    for (const p of payload.properties) {
      if (!ts.isPropertyAssignment(p)) continue;
      const key = propKeyName(p.name);
      const target = key ? rels.get(key) : undefined;
      if (!target) continue;
      for (const opsObj of objectLiteralsOf(p.initializer)) {
        for (const op of opsObj.properties) {
          if (!ts.isPropertyAssignment(op)) continue;
          const opKey = propKeyName(op.name);
          if (!opKey || !NESTED_WRITE_OPS.has(opKey)) continue;
          recordModelWrite(target, node, rel, mod);
          for (const inner of innerPayloadsOf(op.initializer)) scanNestedWrites(inner, target, node, rel, mod, depth + 1);
        }
      }
    }
  };
  /** Entry: scan a write call's top-level `data`/`create`/`update` payload(s) for nested writes. */
  const scanCallNestedWrites = (node: ts.CallExpression, model: string, rel: string, mod: string): void => {
    const arg0 = node.arguments[0];
    if (!arg0) return;
    for (const optsObj of objectLiteralsOf(arg0)) {
      for (const payloadKey of ['data', 'create', 'update']) {
        const payload = propValueOf(optsObj, payloadKey);
        if (payload) for (const pObj of objectLiteralsOf(payload)) scanNestedWrites(pObj, model, node, rel, mod, 0);
      }
    }
  };

  const moduleOf = (rel: string): string => {
    const top = rel.includes('/') ? rel.slice(0, rel.indexOf('/')) : '';
    return dirToModule[top] ?? 'platform';
  };

  for (const sf of program.getSourceFiles()) {
    if (!files.has(sf.fileName) || sf.isDeclarationFile) continue;
    const rel = relative(rootDir, sf.fileName).split(sep).join('/');
    const mod = moduleOf(rel);
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
        const method = node.expression.name.text;
        if (WRITE_METHODS.has(method)) {
          const res = resolveDelegate(node.expression.expression);
          if (res?.kind === 'dynamic') dynamicWrites.push({ file: rel, module: mod, symbol: enclosingSymbol(node) });
          else if (res?.kind === 'model') {
            const owner = ownerOf.get(res.model);
            writes.push({ file: rel, module: mod, model: res.model, owner, ownerKind: owner ? kindOf.get(owner) : undefined, symbol: enclosingSymbol(node) });
            // Also attribute any NESTED writes in this call's payload (a relation-keyed create/update/
            // delete mutates the related model's table without a delegate call of its own).
            scanCallNestedWrites(node, res.model, rel, mod);
          }
        }
        // Task 8 — a READ of a read-encapsulated model. Only tracked for encapsulated models (the
        // owning module reads its own; any other module reading it directly is a boundary crossing).
        if (READ_METHODS.has(method) && readEncapsulatedBy.size > 0) {
          const res = resolveDelegate(node.expression.expression);
          if (res?.kind === 'model' && readEncapsulatedBy.has(res.model)) {
            const owner = readEncapsulatedBy.get(res.model)!;
            if (owner !== mod) reads.push({ file: rel, module: mod, model: res.model, owner, ownerKind: kindOf.get(owner), symbol: enclosingSymbol(node) });
          }
        }
        if (RAW_METHOD_NAMES.includes(method)) {
          const sql = collectSqlText(node);
          if (isWriteSql(sql)) rawWrites.push({ file: rel, module: mod, symbol: enclosingSymbol(node), sql });
        }
      }
      if (ts.isTaggedTemplateExpression(node) && ts.isPropertyAccessExpression(node.tag) && RAW_METHOD_NAMES.includes(node.tag.name.text)) {
        const sql = collectSqlText(node);
        if (isWriteSql(sql)) rawWrites.push({ file: rel, module: mod, symbol: enclosingSymbol(node), sql });
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }

  // Assemble findings.
  const findings: BoundaryFinding[] = [];

  for (const d of dynamicWrites) {
    findings.push({ code: 'dynamic-delegate', message: `${d.file} (${d.symbol}) writes through a DYNAMIC prisma[...] delegate — un-analyzable; use a static delegate`, file: d.file, symbol: d.symbol });
  }

  const crossUsed = new Set<number>();
  for (const w of writes) {
    if (!w.owner) {
      findings.push({ code: 'write-unowned-model', message: `${w.file} writes model '${w.model}', which has no manifest owner`, file: w.file, model: w.model });
      continue;
    }
    if (w.ownerKind === 'platform') continue; // shared infra, appendable everywhere
    if (w.owner === w.module) continue; // own-module write
    const idx = crossWaivers.findIndex((cw) => cw.module === w.module && cw.model === w.model && cw.owner === w.owner);
    if (idx >= 0) {
      crossUsed.add(idx);
      continue;
    }
    findings.push({ code: 'cross-module-write', message: `${w.file} (module '${w.module}', ${w.symbol}) writes foreign model '${w.model}' owned by '${w.owner}' with no declared waiver`, file: w.file, model: w.model, symbol: w.symbol });
  }
  crossWaivers.forEach((cw, i) => {
    if (!crossUsed.has(i)) findings.push({ code: 'unused-cross-module-waiver', message: `cross-module waiver ${cw.module} -> ${cw.model} (owner ${cw.owner}) matched no runtime write — remove it`, model: cw.model });
  });

  const rawMatches = new Map<number, number>();
  for (const r of rawWrites) {
    const idx = rawWaivers.findIndex((rw) => rw.file === r.file && rw.symbol === r.symbol);
    if (idx >= 0) {
      rawMatches.set(idx, (rawMatches.get(idx) ?? 0) + 1);
      continue;
    }
    findings.push({ code: 'raw-write-unwaived', message: `${r.file} (${r.symbol}) executes a raw write SQL statement with no declared waiver: ${r.sql.slice(0, 90)}`, file: r.file, symbol: r.symbol });
  }
  rawWaivers.forEach((rw, i) => {
    const count = rawMatches.get(i) ?? 0;
    if (count === 0) findings.push({ code: 'unused-raw-waiver', message: `raw-SQL waiver ${rw.file} (${rw.symbol}) matched no analyzed write site — remove it`, file: rw.file, symbol: rw.symbol });
    else if (count > 1) findings.push({ code: 'ambiguous-raw-waiver', message: `raw-SQL waiver ${rw.file} (${rw.symbol}) matched ${count} write sites — narrow it`, file: rw.file, symbol: rw.symbol });
    if (!moduleIds.has(rw.owner)) findings.push({ code: 'raw-waiver-bad-owner', message: `raw-SQL waiver ${rw.file} names unknown owner module '${rw.owner}'`, file: rw.file });
  });

  // Task 8 — a read of a read-encapsulated model from any module other than its owner. There is NO
  // read waiver: a cross-module read must be routed through the owning module's query contract (spec
  // §6 permits a same-transaction query/validation, not a foreign direct read).
  for (const r of reads) {
    findings.push({ code: 'cross-module-read', message: `${r.file} (module '${r.module}', ${r.symbol}) reads read-encapsulated model '${r.model}' owned by '${r.owner}' — route it through ${r.owner}'s query contract`, file: r.file, model: r.model, symbol: r.symbol });
  }

  return { findings, writes, rawWrites, dynamicWrites, reads };
}

// ── Runtime program + the wired real check ────────────────────────────────────────────────

/**
 * Build a TypeScript Program over the files the running application loads — every source file
 * reachable from `main.ts` / `app.module.ts`. This is the precise "runtime" set: it excludes
 * the generated Prisma client (node_modules), the test suite, and the standalone seed/CLI
 * entrypoints (`prisma/seed.ts` helpers, `outbox.cli.ts`) that the server never imports.
 */
export function buildRuntimeProgram({ srcRoot, tsconfigPath }: { srcRoot: string; tsconfigPath: string }): {
  program: ts.Program;
  runtimeFiles: Set<string>;
  rootDir: string;
} {
  const configFile = ts.readConfigFile(tsconfigPath, ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(configFile.config, ts.sys, dirname(tsconfigPath));
  const options: ts.CompilerOptions = {
    ...parsed.options,
    noEmit: true,
    incremental: false,
    composite: false,
    tsBuildInfoFile: undefined,
    sourceMap: false,
    declaration: false,
  };
  const program = ts.createProgram({ rootNames: [join(srcRoot, 'main.ts'), join(srcRoot, 'app.module.ts')], options });
  const normSrc = `${srcRoot.split(sep).join('/')}/`;
  const runtimeFiles = new Set<string>();
  for (const sf of program.getSourceFiles()) {
    if (sf.isDeclarationFile) continue;
    if (!sf.fileName.startsWith(normSrc)) continue;
    if (/\.(test|spec)\.ts$/.test(sf.fileName)) continue;
    runtimeFiles.add(sf.fileName);
  }
  return { program, runtimeFiles, rootDir: srcRoot };
}

/** Run all three boundary analyses against the live manifests / DMMF / controllers / waivers. */
export function analyzeRuntimeBoundaries({ srcRoot, tsconfigPath }: { srcRoot: string; tsconfigPath: string }): {
  delegates: Set<string>;
  ownershipFindings: BoundaryFinding[];
  routeFindings: BoundaryFinding[];
  persistence: PersistenceResult;
  runtimeFiles: Set<string>;
} {
  const delegates = prismaModelDelegates();
  const { findings: ownershipFindings } = analyzeModelOwnership(MODULE_MANIFESTS, delegates);
  const routeFindings = analyzeRoutes(MODULE_MANIFESTS, appControllers());
  const { program, runtimeFiles, rootDir } = buildRuntimeProgram({ srcRoot, tsconfigPath });
  const persistence = analyzePersistence({
    program,
    files: runtimeFiles,
    rootDir,
    ownerOf: ownerOfModel(MODULE_MANIFESTS),
    kindOf: kindOfModule(MODULE_MANIFESTS),
    rawWaivers: RAW_SQL_WRITE_WAIVERS,
    crossWaivers: CROSS_MODULE_WRITE_WAIVERS,
    delegates,
    readEncapsulatedBy: readEncapsulation(MODULE_MANIFESTS),
  });
  return { delegates, ownershipFindings, routeFindings, persistence, runtimeFiles };
}
