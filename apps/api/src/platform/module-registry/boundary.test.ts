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
    expect(declared.length).toBe(116); // the documented command inventory §4 (+7: Phase-4 Task-1 labour onboarding)
    // no route contributed by two controllers or two manifests, no missing/unexpected route
    expect(analysis.routeFindings).toEqual([]);
  });

  it('NO analyzed persistence write crosses a module boundary except the declared waivers', () => {
    expect(analysis.persistence.findings).toEqual([]);
    // the only runtime raw writes are the outbox relay's two lease claims (both waived)
    expect(analysis.persistence.rawWrites.map((r) => `${r.file}:${r.symbol}`).sort()).toEqual([
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
    expect(decisions?.readEncapsulated).toEqual(['decision', 'decisionOption', 'decisionEvent', 'decisionApprovalRevision', 'changeRequest', 'decisionProjection']);
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
