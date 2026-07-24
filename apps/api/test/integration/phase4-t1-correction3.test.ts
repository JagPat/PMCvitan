import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { createTestApp, type TestApp } from './test-app';
import { createTwoProjectFixture, type TwoProjectFixture } from './fixtures';
import { LabourService } from '../../src/labour/labour.service';
import { CapabilitiesService, LABOUR_CAPABILITY } from '../../src/platform/capabilities.service';
import type { AuthUser } from '../../src/common/auth';

/**
 * Phase 4 Task 1 CORRECTION 3 — the worker-skill referential invariant is CONCURRENCY-SAFE.
 *
 * Re-review P1: the `Worker.skillCodes` forward trigger and the `LabourSkill` reverse guard were
 * separate row-level triggers reading each other's table without a shared lock, so two concurrent
 * transactions — a worker referencing a skill, and a delete/re-key of that skill — could each pass
 * its own check (neither sees the other's uncommitted row) and BOTH commit, orphaning the reference.
 *
 * The fix normalizes skills into `WorkerSkill(projectId, workerId, skillCode)` with a composite FK to
 * `LabourSkill(projectId, code)` — so PostgreSQL's real FK concurrency semantics serialize the two
 * operations: the WorkerSkill insert takes a KEY-SHARE lock on the referenced skill row, and a
 * concurrent skill delete/re-key blocks then fails (or vice versa). Exactly one side commits; the
 * database is ALWAYS referentially valid.
 *
 * CORRECTION 4 (concurrency-evidence): the two ORDERING probes are now REAL two-session overlaps.
 * Session A opens an interactive transaction, performs its write (a WorkerSkill insert, or a
 * LabourSkill delete) — acquiring the row lock — and HOLDS the transaction open (uncommitted).
 * Session B then attempts the conflicting operation and BLOCKS on that FK lock; the test CONFIRMS B
 * is waiting via `pg_stat_activity` (condition-based synchronization — a bounded poll of the real
 * lock-wait state, NOT a fixed sleep) before committing A. B then resolves: it is REJECTED and the
 * database has zero orphans. Both orderings run 10× each. The MULTI-SKILL probe is (and is now
 * labelled as) a SEQUENTIAL referential-integrity + no-deadlock test, not a concurrent overlap.
 */
describe('Phase 4 Task 1 correction 3 — concurrency-safe worker-skill integrity (live PG)', () => {
  let t: TestApp;
  let f: TwoProjectFixture;
  let labour: LabourService;
  let capabilities: CapabilitiesService;
  let seq = 0;
  // A DEDICATED PrismaClient for the two-session race: the held transaction (session A), the
  // conflicting statement (session B) and the pg_stat_activity poll each need their OWN backend
  // connection AT THE SAME TIME. Running them on the app's shared PrismaService can starve session B
  // of a pooled connection (it then never reaches the server, so nothing ever blocks); a separate
  // client with its own pool makes the two sessions genuinely independent.
  let raceDb: PrismaClient;

  const TRUNCATE =
    'TRUNCATE TABLE "DomainEvent", "OutboxDelivery", "ProcessedEvent", "ProjectionCursor", "ProjectionGeneration", "DecisionProjection", "DailyLogProjection", "DrawingsProjection", "InspectionsProjection", "ActivitiesProjection", "MaterialReadinessProjection", "StockTransaction", "MaterialIssue", "StockLot", "CommandExecution", "DeliveryPromise", "DeliveryCommitment", "PurchaseOrderLine", "PurchaseOrderVersion", "PurchaseOrder", "VendorQuoteLine", "QuoteComparison", "VendorQuote", "Rfq", "RequisitionLine", "Requisition", "ApprovedSubstitution", "CrewMembership", "Crew", "WorkerDevice", "WorkerSkill", "Worker", "LabourDemandSlice", "LabourRequirementSpec", "LabourTrade", "LabourSkill", "MaterialRequirementSpec", "ActivityRequirement", "ActivityRequirementRoot", "DecisionApprovalRevision", "ProjectCapability"';

  const pmc = (projectId: string): AuthUser => ({ sub: f.memberUser.id, role: 'pmc', projectId }) as AuthUser;

  beforeAll(async () => {
    t = await createTestApp();
    f = await createTwoProjectFixture(t.prisma);
    labour = t.app.get(LabourService);
    capabilities = t.app.get(CapabilitiesService);
    raceDb = new PrismaClient(); // its own connection pool, isolated from the app's PrismaService
    await raceDb.$connect();
  });
  afterAll(async () => {
    await raceDb?.$disconnect();
    await t?.prisma.$executeRawUnsafe(TRUNCATE);
    await f?.cleanup();
    await t?.close();
  });
  afterEach(async () => {
    await t.prisma.$executeRawUnsafe(TRUNCATE);
    for (const [model, where] of [
      ['auditLog', { projectId: { startsWith: 'it-p4c3-' } }],
      ['membership', { projectId: { startsWith: 'it-p4c3-' } }],
      ['project', { id: { startsWith: 'it-p4c3-' } }],
    ] as const) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (t.prisma as any)[model].deleteMany({ where });
    }
  });

  const freshProject = async (): Promise<string> => {
    const id = `it-p4c3-${Date.now() % 1e6}-${seq++}`;
    await t.prisma.project.create({
      data: { id, orgId: f.orgA.id, name: id, short: 'P', descriptor: '', stage: 'x', siteCode: 'P', projStart: 'a', projEnd: 'b', elapsedPct: 0, todayDay: 0, milestonePct: 0, timeZone: 'Asia/Kolkata', scheduleStartDate: new Date('2026-06-01T00:00:00.000Z') },
    });
    await t.prisma.membership.create({ data: { projectId: id, userId: f.memberUser.id, role: 'pmc', status: 'active' } });
    return id;
  };
  const enableLabour = async (projectId: string): Promise<void> => {
    await capabilities.enable(projectId, LABOUR_CAPABILITY, f.memberUser.id);
    await labour.upsertTrade(projectId, { code: 'mason', name: 'Mason' }, pmc(projectId));
  };

  /** every (projectId, workerId, skillCode) row of WorkerSkill references a real same-project skill */
  const orphanCount = async (projectId: string): Promise<number> => {
    const rows = await t.prisma.$queryRawUnsafe<Array<{ n: bigint }>>(
      `SELECT count(*)::bigint AS n FROM "WorkerSkill" ws WHERE ws."projectId" = $1 AND NOT EXISTS (SELECT 1 FROM "LabourSkill" k WHERE k."projectId" = ws."projectId" AND k."code" = ws."skillCode")`,
      projectId,
    );
    return Number(rows[0].n);
  };

  // A one-shot gate the held transaction awaits before it commits — so the test controls the exact
  // moment session A releases its FK lock, AFTER it has confirmed session B is already blocked on it.
  const gate = () => {
    let open!: () => void;
    const promise = new Promise<void>((r) => (open = r));
    return { promise, open };
  };

  // Prisma raw-query promises are LAZY — the statement is NOT dispatched to the server until a
  // continuation is attached. `reflect` attaches one (so session B actually runs and blocks) AND
  // captures the settled outcome so the test can assert it AFTER releasing the held transaction.
  const reflect = <T>(p: Promise<T>): Promise<{ status: 'fulfilled'; value: T } | { status: 'rejected'; reason: unknown }> =>
    p.then((value) => ({ status: 'fulfilled' as const, value }), (reason) => ({ status: 'rejected' as const, reason }));

  // Condition-based synchronization (NOT a fixed sleep): poll pg_stat_activity for a backend that is
  // ACTIVELY WAITING on a lock while running the given statement. Returns once ≥1 such waiter exists.
  // The OBSERVER poll runs on the app's PrismaService (`t.prisma`), a DIFFERENT client than the two
  // racing sessions (`raceDb`), so the observation is fully independent of the race.
  const blockedWaiters = async (queryLike: string): Promise<number> => {
    const rows = await t.prisma.$queryRawUnsafe<Array<{ c: number }>>(
      `SELECT COUNT(*)::int AS c FROM pg_stat_activity
        WHERE wait_event_type = 'Lock' AND state = 'active' AND query ILIKE $1`,
      queryLike,
    );
    return Number(rows[0]!.c);
  };
  // The CONDITION (a Lock-waiting backend running the given statement) is what gates progress; the
  // 50ms interval is only the observation cadence. Bounded to ~10s. Session B is dispatched via
  // `reflect` before this runs, so it is already at the server and blocking by the first poll.
  const waitUntilBlocked = async (queryLike: string): Promise<void> => {
    for (let i = 0; i < 200; i++) {
      if ((await blockedWaiters(queryLike)) >= 1) return;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(`barrier timeout: expected a backend blocked on an FK lock while running ${queryLike}`);
  };

  /** A bare committed worker (no skills) so a later WorkerSkill insert satisfies its Worker FK. */
  const bareWorker = async (projectId: string, name: string): Promise<string> => {
    const w = await labour.onboardWorker(projectId, { name, tradeCode: 'mason', skillCodes: [], activeFrom: '2026-06-01' }, pmc(projectId));
    return w.id;
  };

  // ── ORDERING 1 — a REAL overlap: the WorkerSkill INSERT holds its FK lock (uncommitted); a
  //    concurrent LabourSkill DELETE blocks on it (confirmed via pg_stat_activity), then loses. ──
  it('ORDERING 1 (insert holds, delete waits): the WorkerSkill insert holds the FK lock, a concurrent DELETE of that skill blocks then is REJECTED; no orphan, 10x', async () => {
    const projectId = await freshProject();
    await enableLabour(projectId);
    for (let i = 0; i < 10; i++) {
      const code = `sk1-${i}`;
      await labour.upsertSkill(projectId, { code, name: `Skill ${i}` }, pmc(projectId));
      const workerId = await bareWorker(projectId, `W${i}`);
      const g = gate();
      // Session A: INSERT a WorkerSkill referencing `code` — this takes a KEY-SHARE lock on the
      // referenced LabourSkill row — then HOLD the transaction open (uncommitted) until released.
      let inserted!: () => void;
      const insertedP = new Promise<void>((r) => (inserted = r));
      const a = raceDb.$transaction(
        async (tx) => {
          await tx.$executeRawUnsafe(`INSERT INTO "WorkerSkill" ("projectId","workerId","skillCode") VALUES ($1,$2,$3)`, projectId, workerId, code);
          inserted();
          await g.promise;
        },
        { timeout: 20_000, maxWait: 10_000 },
      );
      await insertedP; // A has the FK lock
      // Session B: DELETE the referenced skill — it must BLOCK on A's KEY-SHARE lock. `reflect`
      // attaches a continuation, which BOTH dispatches the (lazy) statement to the server and
      // captures its eventual outcome.
      const b = reflect(raceDb.$executeRawUnsafe(`DELETE FROM "LabourSkill" WHERE "projectId"=$1 AND "code"=$2`, projectId, code));
      await waitUntilBlocked('%DELETE FROM "LabourSkill"%'); // confirm B is genuinely waiting on the FK lock
      g.open(); // let A commit — the WorkerSkill row is now committed and references the skill
      const ra = await reflect(a);
      const rb = await b;
      expect(ra.status, `round ${i}: the held WorkerSkill insert must commit`).toBe('fulfilled');
      expect(rb.status, `round ${i}: the delete of a referenced skill must be REJECTED`).toBe('rejected');
      expect(await orphanCount(projectId), `round ${i}: an orphaned worker-skill reference exists`).toBe(0);
    }
  });

  // ── ORDERING 2 — the symmetric overlap: the LabourSkill DELETE holds its row lock (uncommitted);
  //    a concurrent WorkerSkill INSERT referencing it blocks (confirmed), then loses. ──
  it('ORDERING 2 (delete holds, insert waits): the LabourSkill delete holds the row lock, a concurrent WorkerSkill insert referencing it blocks then is REJECTED; no orphan, 10x', async () => {
    const projectId = await freshProject();
    await enableLabour(projectId);
    for (let i = 0; i < 10; i++) {
      const code = `sk2-${i}`;
      await labour.upsertSkill(projectId, { code, name: `Skill ${i}` }, pmc(projectId));
      const workerId = await bareWorker(projectId, `W${i}`);
      const g = gate();
      // Session A: DELETE the skill inside an interactive transaction — acquiring the row lock — then
      // HOLD the transaction open (uncommitted) until released.
      let deleted!: () => void;
      const deletedP = new Promise<void>((r) => (deleted = r));
      const a = raceDb.$transaction(
        async (tx) => {
          await tx.$executeRawUnsafe(`DELETE FROM "LabourSkill" WHERE "projectId"=$1 AND "code"=$2`, projectId, code);
          deleted();
          await g.promise;
        },
        { timeout: 20_000, maxWait: 10_000 },
      );
      await deletedP; // A holds the row lock on the (to-be-deleted) skill
      // Session B: INSERT a WorkerSkill referencing that skill — its FK check needs a KEY-SHARE lock
      // on the row A is deleting, so it must BLOCK. `reflect` dispatches the (lazy) statement and
      // captures its outcome.
      const b = reflect(raceDb.$executeRawUnsafe(`INSERT INTO "WorkerSkill" ("projectId","workerId","skillCode") VALUES ($1,$2,$3)`, projectId, workerId, code));
      await waitUntilBlocked('%INSERT INTO "WorkerSkill"%'); // confirm B is genuinely waiting on the FK lock
      g.open(); // let A commit — the skill is now gone
      const ra = await reflect(a);
      const rb = await b;
      expect(ra.status, `round ${i}: the held skill delete must commit`).toBe('fulfilled');
      expect(rb.status, `round ${i}: inserting a worker-skill referencing a deleted skill must be REJECTED`).toBe('rejected');
      expect(await orphanCount(projectId), `round ${i}: an orphaned worker-skill reference exists`).toBe(0);
    }
  });

  // ── MULTI-SKILL — a SEQUENTIAL referential-integrity + no-deadlock test (NOT a concurrent overlap):
  //    a worker with several skills is onboarded and COMMITTED first; then concurrent reverse-order
  //    deletes of each referenced skill are ALL rejected by the composite FK, without deadlock and
  //    without leaving an orphan. This complements (does not duplicate) the two genuine-overlap probes
  //    above; it asserts that FK protection holds across MANY references and that reverse-order
  //    concurrent deletes cannot deadlock. ──
  it('MULTI-SKILL (sequential): a committed worker referencing several skills — concurrent reverse-order deletes of each are all REJECTED; no deadlock, no orphan, 10x', async () => {
    const projectId = await freshProject();
    await enableLabour(projectId);
    for (let i = 0; i < 10; i++) {
      const codes = [`m-${i}-a`, `m-${i}-b`, `m-${i}-c`];
      for (const [j, c] of codes.entries()) await labour.upsertSkill(projectId, { code: c, name: `M ${i}-${j}` }, pmc(projectId));
      // onboard-and-COMMIT the worker referencing every skill (sequential — no held transaction).
      const w = await labour.onboardWorker(projectId, { name: `WM${i}`, tradeCode: 'mason', skillCodes: codes, activeFrom: '2026-06-01' }, pmc(projectId));
      expect(w.id, `round ${i}: the multi-skill onboard must succeed`).toBeTruthy();
      // concurrent deletes of every referenced skill, in an ORDER different from the worker's (reverse)
      // — each must be rejected by the composite FK, and the stable FK locking cannot deadlock.
      const results = await Promise.allSettled(
        [...codes].reverse().map((c) => t.prisma.$executeRawUnsafe(`DELETE FROM "LabourSkill" WHERE "projectId"=$1 AND "code"=$2`, projectId, c)),
      );
      for (const [k, r] of results.entries()) {
        expect(r.status, `round ${i}: delete of referenced skill #${k} must be REJECTED`).toBe('rejected');
      }
      // no WorkerSkill row may reference a missing skill (none was deleted).
      expect(await orphanCount(projectId), `round ${i}: an orphaned worker-skill reference exists`).toBe(0);
    }
  });
});
