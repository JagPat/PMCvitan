import { fileURLToPath } from 'node:url';
import { dirname, join, sep } from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as ts from 'typescript';
import { describe, it, expect } from 'vitest';
import { RequestMethod } from '@nestjs/common';
import { PATH_METADATA, METHOD_METADATA } from '@nestjs/common/constants';
import type { ModuleManifest } from '@vitan/shared';
import { readEncapsulation } from '@vitan/shared';
import { MODULE_MANIFESTS, MANIFEST_BY_ID, validateModuleRegistry } from './registry';
import { RAW_SQL_WRITE_WAIVERS, CROSS_MODULE_WRITE_WAIVERS } from './boundary-waivers';
import {
  analyzeRuntimeBoundaries,
  analyzeModelOwnership,
  analyzeRoutes,
  analyzePersistence,
  appControllers,
  mutatingControllerRoutes,
  ownerOfModel,
  kindOfModule,
  prismaModelDelegates,
  type BoundaryFinding,
} from './boundary-analyzer';

/**
 * Phase 2 PR C Task 4 — the STRUCTURALLY-COMPLETE module boundary CI check.
 *
 * This replaces the old filename/regex scan with the metadata/compiler analyzer
 * ({@link ./boundary-analyzer}). It proves, against the compiled application:
 *
 *   1. the module registry validates (one owner per model, acyclic, unique routes/commands);
 *   2. Prisma DMMF model ownership EXACTLY equals the manifests' `ownsModels`;
 *   3. the Nest-derived fully-qualified mutating routes EXACTLY equal the manifests' `routes`;
 *   4. NO analyzed persistence write (delegate OR raw SQL) crosses a module boundary except
 *      the declared, bounded waivers — and every participant writes only its own tables;
 *   5. the ONE cross-module delegate edge is auth → orgs identity provisioning, and it is real
 *      and bounded (names a removal task).
 *
 * The adversarial fixtures then prove the analyzer actually FAILS — for the exact right reason —
 * on a controller write, a helper write, a transaction-alias write, a destructured-delegate
 * write, a raw INSERT, a writable CTE, a dynamic bracket delegate, a duplicate route, a missing
 * model owner, and an unused waiver.
 */

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const TSCONFIG = join(SRC, '..', 'tsconfig.json');

// The real analysis (builds the Program once, reused across the real-code assertions below).
const analysis = analyzeRuntimeBoundaries({ srcRoot: SRC, tsconfigPath: TSCONFIG });

const OWNER = ownerOfModel(MODULE_MANIFESTS);
const KIND = kindOfModule(MODULE_MANIFESTS);
const DELEGATES = prismaModelDelegates();

// A self-contained Prisma-shaped stub every fixture prepends: a structural `PrismaLike`
// (raw methods + model delegates) so the type checker resolves it as a Prisma holder exactly
// as it resolves the real `PrismaService` / `Prisma.TransactionClient`.
const STUB = `
interface Delegate {
  create(a?: unknown): Promise<{ id: string }>;
  createMany(a?: unknown): Promise<unknown>;
  createManyAndReturn(a?: unknown): Promise<unknown>;
  update(a?: unknown): Promise<unknown>;
  updateMany(a?: unknown): Promise<unknown>;
  updateManyAndReturn(a?: unknown): Promise<unknown>;
  upsert(a?: unknown): Promise<unknown>;
  delete(a?: unknown): Promise<unknown>;
  deleteMany(a?: unknown): Promise<unknown>;
}
interface PrismaLike {
  $queryRaw(strings?: TemplateStringsArray, ...values: unknown[]): Promise<unknown>;
  $queryRawUnsafe(query: string, ...values: unknown[]): Promise<unknown>;
  $executeRaw(strings?: TemplateStringsArray, ...values: unknown[]): Promise<number>;
  $executeRawUnsafe(query: string, ...values: unknown[]): Promise<number>;
  activity: Delegate; decision: Delegate; drawing: Delegate; media: Delegate; inspection: Delegate; user: Delegate; projectNode: Delegate;
  // Phase 4 Task 1 correction 4 — the labour-owned, read-encapsulated WorkerSkill (correction 3's
  // normalized worker-skill relation). A foreign module reading it must be flagged cross-module-read.
  workerSkill: Delegate;
  // Phase 4 Task 4 — the Activities-owned, read-encapsulated requirement row. The labour-readiness
  // projection's read-model must be EVENT-PAYLOAD-sourced; a labour file reading this is flagged.
  activityRequirement: Delegate;
}
type TxLike = PrismaLike;
`;

interface FixtureWaivers {
  rawWaivers?: typeof RAW_SQL_WRITE_WAIVERS;
  crossWaivers?: typeof CROSS_MODULE_WRITE_WAIVERS;
}

// Synthetic relation map for the stub models, so NESTED-write fixtures resolve a relation field to
// its foreign delegate exactly as the live DMMF map does for real models.
const FIXTURE_RELATIONS = new Map<string, Map<string, string>>([
  ['decision', new Map([['drawings', 'drawing'], ['activities', 'activity'], ['media', 'media']])],
  // Activity really carries a `decision` relation (Activity.decisionId → Decision) — it is the
  // relation the correction-2 nested-read fixtures exercise, and the one whose latent read the
  // analyzer caught in activities.service.ts.
  ['activity', new Map([['inspections', 'inspection'], ['decision', 'decision']])],
]);

// Synthetic read-encapsulation for the fixtures: `decision` is read-private to the `decisions` module
// (Task 8), exactly as the live manifest declares. A foreign read of it is a `cross-module-read`.
const FIXTURE_READ_ENCAPSULATION = new Map<string, string>([['decision', 'decisions']]);

/** Compile in-memory fixture files and run the persistence analyzer over them. `readEncapsulatedBy`
 *  defaults to the synthetic `decision`-only map; a fixture may inject the REAL manifest-derived
 *  read-encapsulation (`readEncapsulation(MODULE_MANIFESTS)`) to couple its assertion to the live
 *  manifests — so removing a model from a manifest's `readEncapsulated` makes that fixture fail. */
function analyzeFixture(
  files: Record<string, string>,
  waivers: FixtureWaivers = {},
  readEncapsulatedBy: ReadonlyMap<string, string> = FIXTURE_READ_ENCAPSULATION,
): BoundaryFinding[] {
  const dir = mkdtempSync(join(tmpdir(), 'boundary-fx-'));
  try {
    const abs: string[] = [];
    for (const [rel, src] of Object.entries(files)) {
      const p = join(dir, rel);
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, `${STUB}\n${src}`);
      abs.push(p);
    }
    const program = ts.createProgram({
      rootNames: abs,
      options: { target: ts.ScriptTarget.ES2022, noEmit: true, skipLibCheck: true, strict: false, types: [] },
    });
    const norm = `${dir.split(sep).join('/')}/`;
    const fileSet = new Set(program.getSourceFiles().filter((sf) => sf.fileName.startsWith(norm) && !sf.isDeclarationFile).map((sf) => sf.fileName));
    return analyzePersistence({
      program,
      files: fileSet,
      rootDir: dir,
      ownerOf: OWNER,
      kindOf: KIND,
      delegates: DELEGATES,
      relationsOf: FIXTURE_RELATIONS,
      readEncapsulatedBy,
      rawWaivers: waivers.rawWaivers ?? [],
      crossWaivers: waivers.crossWaivers ?? [],
    }).findings;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const EMPTY_MANIFEST: ModuleManifest = {
  id: '', title: '', kind: 'domain', ownsModels: [], dependsOn: [], workflowParticipants: [],
  producesEvents: [], consumesEvents: [], commands: [], queries: [], routes: [], permissions: [],
};

describe('Phase 2 Task 4 — structurally-complete module boundary check', () => {
  it('the module registry validates (one owner per model, acyclic, unique routes + commands)', () => {
    expect(validateModuleRegistry()).toEqual([]);
  });

  it('Prisma DMMF model ownership EXACTLY equals the manifests (no unowned, no double-owned)', () => {
    const delegates = prismaModelDelegates();
    const owned = MODULE_MANIFESTS.flatMap((m) => m.ownsModels);
    // every Prisma model has exactly one manifest owner, and every owned name is a real model
    expect([...delegates].sort()).toEqual([...new Set(owned)].sort());
    expect(owned.length).toBe(new Set(owned).size); // no duplicate ownership across manifests
    expect(analysis.ownershipFindings).toEqual([]);
  });

  it('the Nest-derived fully-qualified mutating routes EXACTLY equal the manifests', () => {
    const derived = mutatingControllerRoutes(appControllers());
    const declared = MODULE_MANIFESTS.flatMap((m) => m.routes);
    expect([...derived.keys()].sort()).toEqual([...declared].sort());
    expect(declared.length).toBe(new Set(declared).size); // globally unique
    expect(declared.length).toBe(168); // the documented command inventory §4 (+1: Phase-6 task-4a decisions.withdraw)
    // no route contributed by two controllers or two manifests, no missing/unexpected route
    expect(analysis.routeFindings).toEqual([]);
  });

  it('NO analyzed persistence write crosses a module boundary except the declared waivers', () => {
    expect(analysis.persistence.findings).toEqual([]);
    // the only runtime raw writes are the outbox relay's two lease claims and the 4a
    // cancellation pair — the tombstone INSERT and (visible since the round-14 aliased-UPDATE
    // detection) the subject-stamp UPDATE, each under its OWN named waiver symbol (all four
    // waived, all four platform-own-table writes)
    expect(analysis.persistence.rawWrites.map((r) => `${r.file}:${r.symbol}`).sort()).toEqual([
      'platform/outbox/cancellation.ts:cancelPass',
      'platform/outbox/cancellation.ts:cancelQueuedPushBySubject',
      'platform/outbox/relay.service.ts:claim',
      'platform/outbox/relay.service.ts:claimExternalRecovery',
    ]);
    // and no un-analyzable dynamic delegate exists in runtime code
    expect(analysis.persistence.dynamicWrites).toEqual([]);
    // Task 8 — no module outside `decisions` reads a read-encapsulated decision model directly
    // (every cross-module decision read goes through the decisions query contract)
    expect(analysis.persistence.reads).toEqual([]);
  });

  it('the decisions module is read-encapsulated (Task 8 — first fully-extracted backend module)', () => {
    const decisions = MODULE_MANIFESTS.find((m) => m.id === 'decisions');
    // Task 9 adds `decisionProjection` — the module's own rebuildable read-model table, also read-encapsulated.
    // The Phase-3 Task-1 round-2 correction adds `decisionApprovalRevision` — the immutable approval register.
    // Phase 6 task 4a round 13 adds `decisionOptionTouch` — the per-transaction option touch
    // note behind the withdrawal entry seal (written only by DB trigger, read by no module).
    // Phase 6 task 4b adds `decisionLegacyApproval` — the one-time record of which approvals
    // predate attribution (written once by a migration, then sealed against INSERT).
    expect(decisions?.readEncapsulated).toEqual(['decision', 'decisionOption', 'decisionOptionTouch', 'decisionEvent', 'decisionApprovalRevision', 'decisionLegacyApproval', 'changeRequest', 'decisionProjection']);
    // OWNED and READ-ENCAPSULATED must stay the same set for this module: a model added to one and
    // forgotten in the other is readable from anywhere with no boundary finding, so the omission is
    // pinned here rather than left to be noticed.
    expect([...(decisions?.ownsModels ?? [])].sort()).toEqual([...(decisions?.readEncapsulated ?? [])].sort());
    // it declares the queries other modules reach it through, and depends on nothing
    expect(decisions?.queries.length).toBeGreaterThan(0);
    // and every module that reads decisions now declares the dependency
    for (const id of ['activities', 'daily-log', 'nodes', 'orgs', 'drawings', 'media']) {
      expect(MANIFEST_BY_ID.get(id)?.dependsOn, `${id} must depend on decisions`).toContain('decisions');
    }
  });

  it('every workflow/init participant writes ONLY its owning module\'s tables', () => {
    const participantWrites = analysis.persistence.writes.filter((w) => w.file.endsWith('.participant.ts'));
    expect(participantWrites.length).toBeGreaterThan(0);
    for (const w of participantWrites) {
      const ownOrPlatform = w.owner === w.module || (!!w.owner && MANIFEST_BY_ID.get(w.owner)?.kind === 'platform');
      expect(ownOrPlatform, `${w.file} writes non-owned model '${w.model}'`).toBe(true);
    }
  });

  it('the ONE cross-module delegate edge is auth → orgs identity provisioning, and it is REAL + BOUNDED', () => {
    // real: auth's runtime code actually writes the orgs-owned identity rows
    const authIdentity = new Set(analysis.persistence.writes.filter((w) => w.module === 'auth' && w.owner === 'orgs').map((w) => w.model));
    expect([...authIdentity].sort()).toEqual(['membership', 'user', 'workerDevice']);
    // and auth is the ONLY module that writes a foreign (non-platform) domain's tables
    const crossingModules = new Set(
      analysis.persistence.writes
        .filter((w) => !!w.owner && MANIFEST_BY_ID.get(w.owner!)?.kind !== 'platform' && w.owner !== w.module)
        .map((w) => w.module),
    );
    expect([...crossingModules]).toEqual(['auth']);
    // bounded: every cross-module waiver names a removal task (no indefinite waivers)
    for (const w of CROSS_MODULE_WRITE_WAIVERS) expect(w.removalTask, `waiver ${w.module}->${w.model} must name a removal task`).toBeTruthy();
    expect(CROSS_MODULE_WRITE_WAIVERS.map((w) => `${w.module}:${w.model}:${w.owner}`).sort()).toEqual(['auth:membership:orgs', 'auth:user:orgs', 'auth:workerDevice:orgs']);
  });

  // ── Adversarial fixtures (Task 4 Step 1): each MUST fail the boundary for its exact reason ──
  describe('adversarial fixtures fail for the intended reason', () => {
    it('a controller writing a foreign model → cross-module-write', () => {
      const f = analyzeFixture({
        'decisions/evil.controller.ts': `class EvilController { constructor(private readonly prisma: PrismaLike) {} async run() { await this.prisma.activity.create({ data: {} }); } }`,
      });
      expect(f).toHaveLength(1);
      expect(f[0].code).toBe('cross-module-write');
      expect(f[0].model).toBe('activity');
    });

    it('a helper function writing a foreign model → cross-module-write', () => {
      const f = analyzeFixture({
        'inspections/evil-helper.ts': `export async function evilHelper(prisma: PrismaLike) { return prisma.drawing.update({ where: {}, data: {} }); }`,
      });
      expect(f).toHaveLength(1);
      expect(f[0].code).toBe('cross-module-write');
      expect(f[0].model).toBe('drawing');
    });

    it('a transaction-alias write to a foreign model → cross-module-write', () => {
      const f = analyzeFixture({
        'nodes/evil-alias.ts': `export async function evilAlias(tx: TxLike) { const t = tx; await t.media.delete({ where: {} }); }`,
      });
      expect(f).toHaveLength(1);
      expect(f[0].code).toBe('cross-module-write');
      expect(f[0].model).toBe('media');
    });

    it('a destructured-delegate write to a foreign model → cross-module-write', () => {
      const f = analyzeFixture({
        'media/evil-destructure.ts': `export async function evilDestructure(prisma: PrismaLike) { const { inspection } = prisma; await inspection.update({ where: {}, data: {} }); }`,
      });
      expect(f).toHaveLength(1);
      expect(f[0].code).toBe('cross-module-write');
      expect(f[0].model).toBe('inspection');
    });

    it('a NESTED relation write to a foreign model → cross-module-write (own-model delegate call, foreign rows in the payload)', () => {
      const f = analyzeFixture({
        'decisions/evil-nested.ts': `export async function evilNested(prisma: PrismaLike) { await prisma.decision.update({ where: {}, data: { title: 'x', drawings: { create: { number: 'A1' } } } }); }`,
      });
      // the decision.update is own-module (no finding); the nested drawings.create is the cross write
      expect(f).toHaveLength(1);
      expect(f[0].code).toBe('cross-module-write');
      expect(f[0].model).toBe('drawing');
    });

    it('a deeply nested relation write (decision → activity → inspection) attributes the deepest foreign model', () => {
      const f = analyzeFixture({
        'decisions/evil-deep.ts': `export async function evilDeep(prisma: PrismaLike) { await prisma.decision.create({ data: { activities: { create: { inspections: { create: { id: 'i1' } } } } } }); }`,
      });
      // activities.create (→activity) AND the deeper inspections.create (→inspection), both foreign to decisions
      expect(f.map((x) => x.model).sort()).toEqual(['activity', 'inspection']);
      expect(f.every((x) => x.code === 'cross-module-write')).toBe(true);
    });

    it('a *AndReturn write to a foreign model → cross-module-write', () => {
      const f = analyzeFixture({
        'decisions/evil-return.ts': `export async function evilReturn(prisma: PrismaLike) { await prisma.activity.createManyAndReturn({ data: [{ id: '1' }] }); }`,
      });
      expect(f).toHaveLength(1);
      expect(f[0].code).toBe('cross-module-write');
      expect(f[0].model).toBe('activity');
    });

    it('a foreign module READING a read-encapsulated model → cross-module-read (Task 8)', () => {
      const f = analyzeFixture({
        'activities/evil-read.ts': `export async function evilRead(prisma: PrismaLike) { await prisma.decision.findFirst({ where: {} }); }`,
      });
      expect(f).toHaveLength(1);
      expect(f[0].code).toBe('cross-module-read');
      expect(f[0].model).toBe('decision');
    });

    it('the OWNING module reading its own read-encapsulated model is NOT a finding', () => {
      const f = analyzeFixture({
        'decisions/own-read.ts': `export async function ownRead(prisma: PrismaLike) { await prisma.decision.count({ where: {} }); }`,
      });
      expect(f).toEqual([]);
    });

    // Phase 4 Task 1 correction 4 — an ADVERSARIAL fixture proving the boundary analyzer flags a
    // foreign read of the labour-owned, read-encapsulated WorkerSkill (correction 3's normalized
    // worker-skill relation). This fixture is COUPLED to the LIVE manifests: it analyzes against the
    // REAL `readEncapsulation(MODULE_MANIFESTS)` (not the synthetic `decision`-only map), so if a
    // future edit removes `workerSkill` from the labour manifest's `readEncapsulated`, the model drops
    // out of that map, the analyzer no longer flags the read, and THIS test fails (length 0 ≠ 1).
    it('a foreign module reading the labour-owned WorkerSkill → cross-module-read owned by Labour (coupled to the live manifest)', () => {
      const realEnc = readEncapsulation(MODULE_MANIFESTS);
      // sanity: the coupling target really is present in the live manifest read-encapsulation
      expect(realEnc.get('workerSkill'), 'workerSkill must be read-encapsulated by labour in the live manifest').toBe('labour');
      const f = analyzeFixture(
        {
          'activities/evil-workerskill-read.ts': `export async function evilWorkerSkillRead(prisma: PrismaLike) { await prisma.workerSkill.findMany({ where: {} }); }`,
        },
        {},
        realEnc,
      );
      expect(f).toHaveLength(1);
      expect(f[0].code).toBe('cross-module-read');
      expect(f[0].model).toBe('workerSkill');
      // the owning module (labour) is attributed in the finding message — matching the shape of every
      // other cross-module-read/-write finding, which carry the owner in the message, not a field.
      expect(f[0].message).toContain("owned by 'labour'");
    });

    // Phase 4 Task 4 — the INVERSE coupling proof: Labour is a LEAF whose requirement read-model is
    // folded from `requirement.*` event PAYLOADS. If the labour-readiness projection (or any labour
    // file) instead read the Activities-owned `ActivityRequirement` by delegate, the analyzer flags
    // it — coupled to the LIVE manifests exactly like the workerSkill fixture above.
    it('a labour file reading the Activities-owned ActivityRequirement → cross-module-read (the read-model must stay payload-sourced)', () => {
      const realEnc = readEncapsulation(MODULE_MANIFESTS);
      expect(realEnc.get('activityRequirement'), 'activityRequirement must be read-encapsulated by activities in the live manifest').toBe('activities');
      const f = analyzeFixture(
        {
          'labour/evil-requirement-read.ts': `export async function evilRequirementRead(prisma: PrismaLike) { await prisma.activityRequirement.findMany({ where: {} }); }`,
        },
        {},
        realEnc,
      );
      expect(f).toHaveLength(1);
      expect(f[0].code).toBe('cross-module-read');
      expect(f[0].model).toBe('activityRequirement');
      expect(f[0].message).toContain("owned by 'activities'");
    });

    // Phase 4 Task 3 correction 3 (finding 2) — RAW SQL names TABLES, not delegates, so the
    // delegate-level analysis above was blind to `tx.$queryRaw`SELECT … FROM "ActivityRequirementRoot"
    // … FOR UPDATE``: precisely the read that let a LEAF module reach into Activities' persistence.
    // These fixtures pin the raw-read detection permanently, in BOTH raw forms, and prove it is
    // ownership-driven rather than name-driven.
    it('a foreign module RAW-READING a read-encapsulated table → cross-module-read (tagged template)', () => {
      const f = analyzeFixture({
        'activities/evil-raw-read.ts':
          'export async function evilRawRead(prisma: PrismaLike, id: string) { await prisma.$queryRaw`SELECT "id" FROM "Decision" WHERE "id" = ${id} FOR UPDATE`; }',
      });
      expect(f).toHaveLength(1);
      expect(f[0].code).toBe('cross-module-read');
      expect(f[0].model).toBe('decision');
      expect(f[0].message).toContain("owned by 'decisions'");
    });

    it('a foreign module RAW-READING a read-encapsulated table → cross-module-read ($queryRawUnsafe)', () => {
      const f = analyzeFixture({
        'activities/evil-raw-read-unsafe.ts':
          'export async function evilRawReadUnsafe(prisma: PrismaLike, id: string) { await prisma.$queryRawUnsafe(`SELECT count(*) FROM "Decision" WHERE "id" = $1`, id); }',
      });
      expect(f).toHaveLength(1);
      expect(f[0].code).toBe('cross-module-read');
      expect(f[0].model).toBe('decision');
    });

    it('the OWNING module raw-reading its own read-encapsulated table is NOT a finding', () => {
      const f = analyzeFixture({
        'decisions/own-raw-read.ts':
          'export async function ownRawRead(prisma: PrismaLike, id: string) { await prisma.$queryRaw`SELECT "id" FROM "Decision" WHERE "id" = ${id} FOR UPDATE`; }',
      });
      expect(f).toEqual([]);
    });

    // Round-3 re-review (finding 3) — literals directly under the call are not the only SQL a raw
    // call executes. Naming the statement is the obvious way to write it, and the obvious way to
    // slip past a literals-only scan; each of these fixtures is RED against that earlier version.
    it('SQL held in a module-scope const is followed → cross-module-read', () => {
      const f = analyzeFixture({
        'activities/evil-const-sql.ts':
          'const SQL = `SELECT "id" FROM "Decision" WHERE "id" = $1 FOR UPDATE`;\n' +
          'export async function evilConstSql(prisma: PrismaLike, id: string) { await prisma.$queryRawUnsafe(SQL, id); }',
      });
      expect(f).toHaveLength(1);
      expect(f[0].code).toBe('cross-module-read');
      expect(f[0].model).toBe('decision');
    });

    it('SQL reached through a local alias of a const is followed → cross-module-read', () => {
      const f = analyzeFixture({
        'activities/evil-alias-sql.ts':
          'const BASE = `SELECT "id" FROM "Decision"`;\n' +
          'export async function evilAliasSql(prisma: PrismaLike) { const sql = BASE; await prisma.$queryRawUnsafe(sql); }',
      });
      expect(f).toHaveLength(1);
      expect(f[0].code).toBe('cross-module-read');
      expect(f[0].model).toBe('decision');
    });

    // Round-7 re-review — an IMPORTED name resolves to an ALIAS symbol whose only declaration is the
    // `ImportSpecifier`: no initializer, no `for…of` source, so the walker gathered nothing and
    // moving an otherwise-detected query into a shared constant bypassed the boundary entirely.
    // RED at 170bcd6 (zero findings). Both fixtures below name the SAME query from another file.
    it('SQL IMPORTED from another module file is followed → cross-module-read (named import)', () => {
      const f = analyzeFixture({
        'shared/queries.ts': 'export const DECISION_SQL = `SELECT "id" FROM "Decision" WHERE "id" = $1`;',
        'activities/evil-imported-sql.ts':
          "import { DECISION_SQL } from '../shared/queries';\n" +
          'export async function evilImportedSql(prisma: PrismaLike, id: string) { await prisma.$queryRawUnsafe(DECISION_SQL, id); }',
      });
      expect(f).toHaveLength(1);
      expect(f[0].code).toBe('cross-module-read');
      expect(f[0].model).toBe('decision');
    });

    it('SQL reached through an ALIASED import is followed → cross-module-read', () => {
      const f = analyzeFixture({
        'shared/queries2.ts': 'export const DECISION_SQL = `SELECT "id" FROM "Decision"`;',
        'activities/evil-renamed-import.ts':
          "import { DECISION_SQL as Q } from '../shared/queries2';\n" +
          'export async function evilRenamedImport(prisma: PrismaLike) { await prisma.$queryRawUnsafe(Q); }',
      });
      expect(f).toHaveLength(1);
      expect(f[0].code).toBe('cross-module-read');
      expect(f[0].model).toBe('decision');
    });

    // Round 3h — a FUNCTION that returns SQL has no initializer at all, so the declaration walk
    // gathered nothing: `function sql() { return 'SELECT … FROM "Decision"' }` followed by
    // `$queryRawUnsafe(sql())` produced ZERO findings while the identical inline statement (and,
    // since round 7, the identical imported constant) was caught. RED at cd7b30c for both shapes.
    it('SQL RETURNED by a local function declaration is followed → cross-module-read', () => {
      const f = analyzeFixture({
        'activities/evil-fn-sql.ts':
          'function decisionSql(): string { return `SELECT "id" FROM "Decision"`; }\n' +
          'export async function evilFnSql(prisma: PrismaLike) { await prisma.$queryRawUnsafe(decisionSql()); }',
      });
      expect(f).toHaveLength(1);
      expect(f[0].code).toBe('cross-module-read');
      expect(f[0].model).toBe('decision');
    });

    it('SQL RETURNED by an IMPORTED function is followed → cross-module-read', () => {
      const f = analyzeFixture({
        'shared/queries3.ts': 'export function decisionSql(): string { return `SELECT "id" FROM "Decision"`; }',
        'activities/evil-imported-fn.ts':
          "import { decisionSql } from '../shared/queries3';\n" +
          'export async function evilImportedFn(prisma: PrismaLike) { await prisma.$queryRawUnsafe(decisionSql()); }',
      });
      expect(f).toHaveLength(1);
      expect(f[0].code).toBe('cross-module-read');
      expect(f[0].model).toBe('decision');
    });

    it('SQL held in a const ARRAY of statements is followed → cross-module-read', () => {
      const f = analyzeFixture({
        'activities/evil-array-sql.ts':
          'const STATEMENTS = [`SELECT 1`, `SELECT "id" FROM "Decision"`];\n' +
          'export async function evilArraySql(prisma: PrismaLike) { for (const s of STATEMENTS) await prisma.$executeRawUnsafe(s); }',
      });
      expect(f).toHaveLength(1);
      expect(f[0].code).toBe('cross-module-read');
      expect(f[0].model).toBe('decision');
    });

    it('a const naming only OWN-module tables stays clean when resolved', () => {
      const f = analyzeFixture({
        'decisions/own-const-sql.ts':
          'const SQL = `SELECT "id" FROM "Decision" WHERE "id" = $1`;\n' +
          'export async function ownConstSql(prisma: PrismaLike, id: string) { await prisma.$queryRawUnsafe(SQL, id); }',
      });
      expect(f).toEqual([]);
    });

    it('the raw-read detection is COUPLED to the live manifests — Activities raw-reading a labour table is flagged', () => {
      // Same coupling discipline as the WorkerSkill fixture above: analyzed against the REAL
      // manifest-derived read-encapsulation, so dropping `workerSkill` from labour's
      // `readEncapsulated` makes this fixture fail rather than silently stop protecting anything.
      const realEnc = readEncapsulation(MODULE_MANIFESTS);
      const f = analyzeFixture(
        {
          'activities/evil-raw-workerskill.ts':
            'export async function evilRaw(prisma: PrismaLike, p: string) { await prisma.$queryRawUnsafe(`SELECT "skillCode" FROM "WorkerSkill" WHERE "projectId" = $1`, p); }',
        },
        {},
        realEnc,
      );
      expect(f).toHaveLength(1);
      expect(f[0].code).toBe('cross-module-read');
      expect(f[0].model).toBe('workerSkill');
      expect(f[0].message).toContain("owned by 'labour'");
    });

    // Phase 4 Task 1 correction 2 (re-review finding 3) — permanently pin the NESTED foreign read
    // detection the packet claimed. An own-module delegate call whose include/select pulls a
    // read-encapsulated FOREIGN relation is a cross-module-read, exactly like a direct foreign read.
    it('a foreign relation pulled through a NESTED include → cross-module-read (own delegate, foreign read-encapsulated relation)', () => {
      const f = analyzeFixture({
        'activities/evil-nested-read.ts': `export async function evilNestedRead(prisma: PrismaLike) { await prisma.activity.findFirst({ where: {}, include: { decision: true } }); }`,
      });
      // the activity.findFirst is own-module (no finding); the nested `decision` relation resolves to
      // the decisions-owned, read-encapsulated Decision model — the cross read.
      expect(f).toHaveLength(1);
      expect(f[0].code).toBe('cross-module-read');
      expect(f[0].model).toBe('decision');
    });

    it('a foreign relation pulled through a NESTED select → cross-module-read', () => {
      const f = analyzeFixture({
        'activities/evil-nested-select.ts': `export async function evilNestedSelect(prisma: PrismaLike) { await prisma.activity.findMany({ select: { id: true, decision: { select: { status: true } } } }); }`,
      });
      expect(f).toHaveLength(1);
      expect(f[0].code).toBe('cross-module-read');
      expect(f[0].model).toBe('decision');
    });

    it('the OWNING module pulling its OWN read-encapsulated model through a nested include is NOT a finding', () => {
      const f = analyzeFixture({
        // a decisions file reading activity with a nested `decision` include: the nested Decision is
        // owned by decisions (== this module), so it is NOT a cross read — and activity itself is not
        // read-encapsulated, so the outer read is fine too.
        'decisions/own-nested-read.ts': `export async function ownNestedRead(prisma: PrismaLike) { await prisma.activity.findFirst({ include: { decision: true } }); }`,
      });
      expect(f).toEqual([]);
    });

    it('a raw TRUNCATE of a foreign table with no waiver → raw-write-unwaived', () => {
      const f = analyzeFixture({
        'decisions/evil-truncate.ts': `export async function evilTruncate(prisma: PrismaLike) { await prisma.$executeRawUnsafe('TRUNCATE "Activity"'); }`,
      });
      expect(f).toHaveLength(1);
      expect(f[0].code).toBe('raw-write-unwaived');
      expect(f[0].symbol).toBe('evilTruncate');
    });

    it('two controller routes colliding only by param name → route-structural-duplicate', () => {
      class CtrlA { patch(): void {} }
      class CtrlB { patch(): void {} }
      Reflect.defineMetadata(PATH_METADATA, 'projects/:projectId/decisions/:id', CtrlA);
      Reflect.defineMetadata(METHOD_METADATA, RequestMethod.PATCH, CtrlA.prototype.patch);
      Reflect.defineMetadata(PATH_METADATA, '', CtrlA.prototype.patch);
      Reflect.defineMetadata(PATH_METADATA, 'projects/:projectId/decisions/:decisionId', CtrlB);
      Reflect.defineMetadata(METHOD_METADATA, RequestMethod.PATCH, CtrlB.prototype.patch);
      Reflect.defineMetadata(PATH_METADATA, '', CtrlB.prototype.patch);
      const findings = analyzeRoutes([], [CtrlA as never, CtrlB as never]);
      expect(findings.some((x) => x.code === 'route-structural-duplicate')).toBe(true);
    });

    it('a raw INSERT with no waiver → raw-write-unwaived', () => {
      const f = analyzeFixture({
        'decisions/evil-insert.ts': `export async function evilInsert(prisma: PrismaLike) { await prisma.$executeRawUnsafe('INSERT INTO "Decision" ("id") VALUES (1)'); }`,
      });
      expect(f).toHaveLength(1);
      expect(f[0].code).toBe('raw-write-unwaived');
      expect(f[0].symbol).toBe('evilInsert');
    });

    // Round 14 (Codex, PR #337): `UPDATE "T" alias SET …` slipped past `isWriteSql` — the
    // UPDATE_RE required the table token IMMEDIATELY before SET, so an aliased set-based
    // update (the `UPDATE … FROM` join shape) was invisible to the raw-write tripwire
    // entirely: unwaived AND unflagged. The alias (bare or `AS`-prefixed) is now admitted;
    // the `SELECT … FOR UPDATE` row lock stays a non-write (the lookahead keeps
    // `UPDATE "T" SET` parsing as table+SET, never table+alias).
    it('an ALIASED raw UPDATE (UPDATE "T" alias SET … FROM …) is a raw write → raw-write-unwaived', () => {
      const f = analyzeFixture({
        'decisions/evil-aliased-update.ts': `export async function evilAliasedUpdate(prisma: PrismaLike) { await prisma.$executeRawUnsafe('UPDATE "Decision" d SET "title" = o."label" FROM "DecisionOption" o WHERE o."decisionId" = d."id"'); }`,
      });
      expect(f).toHaveLength(1);
      expect(f[0].code).toBe('raw-write-unwaived');
      expect(f[0].symbol).toBe('evilAliasedUpdate');
    });

    it('an AS-aliased raw UPDATE is a raw write; a SELECT … FOR UPDATE row lock still is NOT', () => {
      const f = analyzeFixture({
        'decisions/evil-as-update.ts': `export async function evilAsUpdate(prisma: PrismaLike) { await prisma.$executeRawUnsafe('UPDATE "Decision" AS d SET "title" = $1'); }`,
      });
      expect(f.map((x) => x.code)).toEqual(['raw-write-unwaived']);
      const lock = analyzeFixture({
        'decisions/row-lock.ts': `export async function lockRow(prisma: PrismaLike) { await prisma.$queryRawUnsafe('SELECT 1 FROM "Decision" WHERE "id" = $1 FOR UPDATE'); }`,
      });
      expect(lock.filter((x) => x.code === 'raw-write-unwaived')).toHaveLength(0);
    });

    it('a writable CTE with no waiver → raw-write-unwaived', () => {
      const f = analyzeFixture({
        'decisions/evil-cte.ts': 'export async function evilCte(prisma: PrismaLike) { await prisma.$queryRaw`WITH moved AS (UPDATE "Decision" SET "x" = 1 RETURNING *) SELECT * FROM moved`; }',
      });
      expect(f).toHaveLength(1);
      expect(f[0].code).toBe('raw-write-unwaived');
      expect(f[0].symbol).toBe('evilCte');
    });

    it('a SELECT … FOR UPDATE row lock is NOT mistaken for a write (negative control)', () => {
      const f = analyzeFixture({
        'decisions/read-lock.ts': 'export async function readLock(prisma: PrismaLike) { await prisma.$queryRaw`SELECT "id" FROM "Decision" WHERE "id" = 1 FOR UPDATE`; }',
      });
      expect(f).toEqual([]);
    });

    it('a dynamic prisma[name] delegate → dynamic-delegate', () => {
      const f = analyzeFixture({
        'decisions/evil-dynamic.ts': `export async function evilDynamic(prisma: PrismaLike, name: string) { await prisma[name as keyof PrismaLike].create({}); }`,
      });
      expect(f).toHaveLength(1);
      expect(f[0].code).toBe('dynamic-delegate');
    });

    it('a duplicate route contribution → route-duplicate', () => {
      const dup: ModuleManifest = { ...EMPTY_MANIFEST, id: 'dup', routes: ['POST /projects/:projectId/decisions'] };
      const findings = analyzeRoutes([...MODULE_MANIFESTS, dup], appControllers());
      expect(findings.some((x) => x.code === 'route-duplicate' && x.route === 'POST /projects/:projectId/decisions')).toBe(true);
    });

    it('a Prisma model with no manifest owner → model-no-owner', () => {
      const without = MODULE_MANIFESTS.filter((m) => m.id !== 'decisions');
      const { findings } = analyzeModelOwnership(without);
      expect(findings.some((x) => x.code === 'model-no-owner' && x.model === 'decision')).toBe(true);
    });

    it('an unused raw-SQL waiver → unused-raw-waiver', () => {
      const f = analyzeFixture(
        { 'platform/ok.ts': `export async function ok(prisma: PrismaLike) { await prisma.$executeRawUnsafe('SELECT 1'); }` },
        { rawWaivers: [{ file: 'platform/ghost.ts', symbol: 'ghost', owner: 'platform', reason: 'stale' }] },
      );
      expect(f).toHaveLength(1);
      expect(f[0].code).toBe('unused-raw-waiver');
    });
  });
});
