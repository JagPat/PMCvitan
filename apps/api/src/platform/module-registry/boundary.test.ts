import { fileURLToPath } from 'node:url';
import { dirname, join, sep } from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as ts from 'typescript';
import { describe, it, expect } from 'vitest';
import type { ModuleManifest } from '@vitan/shared';
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
  update(a?: unknown): Promise<unknown>;
  updateMany(a?: unknown): Promise<unknown>;
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
}
type TxLike = PrismaLike;
`;

interface FixtureWaivers {
  rawWaivers?: typeof RAW_SQL_WRITE_WAIVERS;
  crossWaivers?: typeof CROSS_MODULE_WRITE_WAIVERS;
}

/** Compile in-memory fixture files and run the persistence analyzer over them. */
function analyzeFixture(files: Record<string, string>, waivers: FixtureWaivers = {}): BoundaryFinding[] {
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
    expect(declared.length).toBe(67); // the documented command inventory §4
    // no route contributed by two controllers or two manifests, no missing/unexpected route
    expect(analysis.routeFindings).toEqual([]);
  });

  it('NO analyzed persistence write crosses a module boundary except the declared waivers', () => {
    expect(analysis.persistence.findings).toEqual([]);
    // the sole runtime raw write is the outbox relay lease claim (waived)
    expect(analysis.persistence.rawWrites.map((r) => `${r.file}:${r.symbol}`)).toEqual(['platform/outbox/relay.service.ts:claim']);
    // and no un-analyzable dynamic delegate exists in runtime code
    expect(analysis.persistence.dynamicWrites).toEqual([]);
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
