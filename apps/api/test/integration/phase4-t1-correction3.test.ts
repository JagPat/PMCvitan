import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
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
 * database is ALWAYS referentially valid. These probes drive BOTH orderings 10× each.
 */
describe('Phase 4 Task 1 correction 3 — concurrency-safe worker-skill integrity (live PG)', () => {
  let t: TestApp;
  let f: TwoProjectFixture;
  let labour: LabourService;
  let capabilities: CapabilitiesService;
  let seq = 0;

  const TRUNCATE =
    'TRUNCATE TABLE "DomainEvent", "OutboxDelivery", "ProcessedEvent", "ProjectionCursor", "ProjectionGeneration", "DecisionProjection", "DailyLogProjection", "DrawingsProjection", "InspectionsProjection", "ActivitiesProjection", "MaterialReadinessProjection", "StockTransaction", "MaterialIssue", "StockLot", "CommandExecution", "DeliveryPromise", "DeliveryCommitment", "PurchaseOrderLine", "PurchaseOrderVersion", "PurchaseOrder", "VendorQuoteLine", "QuoteComparison", "VendorQuote", "Rfq", "RequisitionLine", "Requisition", "ApprovedSubstitution", "CrewMembership", "Crew", "WorkerDevice", "WorkerSkill", "Worker", "LabourDemandSlice", "LabourRequirementSpec", "LabourTrade", "LabourSkill", "MaterialRequirementSpec", "ActivityRequirement", "ActivityRequirementRoot", "DecisionApprovalRevision", "ProjectCapability"';

  const pmc = (projectId: string): AuthUser => ({ sub: f.memberUser.id, role: 'pmc', projectId }) as AuthUser;

  beforeAll(async () => {
    t = await createTestApp();
    f = await createTwoProjectFixture(t.prisma);
    labour = t.app.get(LabourService);
    capabilities = t.app.get(CapabilitiesService);
  });
  afterAll(async () => {
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

  // A two-party rendezvous: the first operation completes and signals; the second only then begins,
  // so the ordering is DETERMINISTIC. The first transaction commits after signalling — the second's
  // operation then contends for the FK-locked skill row and resolves (blocked-then-fails, or fails).
  const signal = () => {
    let fire!: () => void;
    const gate = new Promise<void>((r) => (fire = r));
    return { gate, fire };
  };

  // ── Ordering 1 — the WORKER (its skill row) commits first; a concurrent skill delete then loses ──
  it('ORDERING 1 (worker first): a worker references a skill, a concurrent DELETE of that skill loses; no orphan, 10x', async () => {
    const projectId = await freshProject();
    await enableLabour(projectId);
    for (let i = 0; i < 10; i++) {
      const code = `sk1-${i}`;
      await labour.upsertSkill(projectId, { code, name: `Skill ${i}` }, pmc(projectId));
      const s = signal();
      // party A onboards a worker referencing `code` (WorkerSkill insert takes a KEY-SHARE lock),
      // signals, then returns (its command transaction commits).
      const a = (async () => {
        const w = await labour.onboardWorker(projectId, { name: `W${i}`, tradeCode: 'mason', skillCodes: [code], activeFrom: '2026-06-01' }, pmc(projectId));
        s.fire();
        return w;
      })();
      // party B waits until A has onboarded, then attempts to delete the skill A referenced.
      const b = (async () => {
        await s.gate;
        return t.prisma.$executeRawUnsafe(`DELETE FROM "LabourSkill" WHERE "projectId"=$1 AND "code"=$2`, projectId, code);
      })();
      const [ra, rb] = await Promise.allSettled([a, b]);
      expect(ra.status, `round ${i}: the worker onboard must succeed`).toBe('fulfilled');
      expect(rb.status, `round ${i}: the delete of a referenced skill must be REJECTED`).toBe('rejected');
      // the invariant: no WorkerSkill row points at a missing skill.
      expect(await orphanCount(projectId), `round ${i}: an orphaned worker-skill reference exists`).toBe(0);
    }
  });

  // ── Ordering 2 — the skill DELETE commits first; a concurrent worker referencing it then loses ───
  it('ORDERING 2 (delete first): a skill is deleted, a concurrent worker referencing it loses; no orphan, 10x', async () => {
    const projectId = await freshProject();
    await enableLabour(projectId);
    for (let i = 0; i < 10; i++) {
      const code = `sk2-${i}`;
      await labour.upsertSkill(projectId, { code, name: `Skill ${i}` }, pmc(projectId));
      const s = signal();
      // party A deletes the skill inside an interactive transaction, signals AFTER acquiring the
      // row lock, then commits.
      const a = t.prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`DELETE FROM "LabourSkill" WHERE "projectId"=$1 AND "code"=$2`, projectId, code);
        s.fire();
        // give the racing worker onboard a moment to CONTEND for the now-locked/deleted skill row
        // before this transaction commits (bounded, no external state — a scheduling yield).
        await new Promise((r) => setImmediate(r));
      });
      // party B waits until the delete has begun, then onboards a worker referencing that skill —
      // its WorkerSkill insert must fail (the skill is being/has been removed).
      const b = (async () => {
        await s.gate;
        return labour.onboardWorker(projectId, { name: `W${i}`, tradeCode: 'mason', skillCodes: [code], activeFrom: '2026-06-01' }, pmc(projectId));
      })();
      const [ra, rb] = await Promise.allSettled([a, b]);
      expect(ra.status, `round ${i}: the skill delete must succeed`).toBe('fulfilled');
      expect(rb.status, `round ${i}: onboarding a worker referencing a deleted skill must be REJECTED`).toBe('rejected');
      expect(await orphanCount(projectId), `round ${i}: an orphaned worker-skill reference exists`).toBe(0);
    }
  });

  // ── multi-skill worker + concurrent deletes cannot deadlock and cannot orphan ──────────────────
  it('MULTI-SKILL: a worker referencing several skills races concurrent deletes of each; no deadlock, no orphan, 10x', async () => {
    const projectId = await freshProject();
    await enableLabour(projectId);
    for (let i = 0; i < 10; i++) {
      const codes = [`m-${i}-a`, `m-${i}-b`, `m-${i}-c`];
      for (const [j, c] of codes.entries()) await labour.upsertSkill(projectId, { code: c, name: `M ${i}-${j}` }, pmc(projectId));
      const s = signal();
      const a = (async () => {
        const w = await labour.onboardWorker(projectId, { name: `WM${i}`, tradeCode: 'mason', skillCodes: codes, activeFrom: '2026-06-01' }, pmc(projectId));
        s.fire();
        return w;
      })();
      const b = (async () => {
        await s.gate;
        // concurrent deletes of every referenced skill, in an ORDER different from the worker's
        // (reverse) — proving the stable FK locking cannot deadlock.
        return Promise.allSettled(
          [...codes].reverse().map((c) => t.prisma.$executeRawUnsafe(`DELETE FROM "LabourSkill" WHERE "projectId"=$1 AND "code"=$2`, projectId, c)),
        );
      })();
      const [ra] = await Promise.allSettled([a, b]);
      expect(ra.status, `round ${i}: the multi-skill onboard must succeed`).toBe('fulfilled');
      // whichever deletes lost, no WorkerSkill row may reference a missing skill.
      expect(await orphanCount(projectId), `round ${i}: an orphaned worker-skill reference exists`).toBe(0);
    }
  });
});
