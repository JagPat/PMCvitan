import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { createTestApp, type TestApp } from './test-app';
import { createTwoProjectFixture, type TwoProjectFixture } from './fixtures';
import { RequirementsService } from '../../src/activities/requirements.service';
import { LabourService } from '../../src/labour/labour.service';
import { CapabilitiesService, LABOUR_CAPABILITY } from '../../src/platform/capabilities.service';
import type { AuthUser } from '../../src/common/auth';

/**
 * Phase 4 Task 1 CORRECTION 2 — the re-review findings, proven live against PostgreSQL.
 *
 * The previous correction sealed the labour demand + skill references only at INITIAL insertion.
 * The re-review showed both invariants could be broken by a LATER mutation:
 *
 *   Finding 1 (P1) — the demand seal fired only on LabourRequirementSpec INSERT, so a slice appended
 *     in a later transaction was never re-validated and the sealed aggregate silently drifted.
 *   Finding 2 (P2) — the Worker.skillCodes containment fired only on worker INSERT/UPDATE, so a
 *     LabourSkill could be deleted (or re-keyed) out from under a worker still referencing it.
 *
 * These probes assert the DURABLE behaviour. They are RED at `b627359` (both later mutations were
 * accepted there) and GREEN after the correction: the later mutation is refused and the original
 * rows are unchanged. (Finding 3 — the permanently pinned nested-include/select analyzer fixture —
 * lives in `src/platform/module-registry/boundary.test.ts`.)
 */
describe('Phase 4 Task 1 correction 2 — DURABLE labour-demand + worker-skill seals (live PG)', () => {
  let t: TestApp;
  let f: TwoProjectFixture;
  let requirements: RequirementsService;
  let labour: LabourService;
  let capabilities: CapabilitiesService;
  let seq = 0;

  const TRUNCATE =
    'TRUNCATE TABLE "DomainEvent", "OutboxDelivery", "ProcessedEvent", "ProjectionCursor", "ProjectionGeneration", "DecisionProjection", "DailyLogProjection", "DrawingsProjection", "InspectionsProjection", "ActivitiesProjection", "MaterialReadinessProjection", "StockTransaction", "MaterialIssue", "StockLot", "CommandExecution", "DeliveryPromise", "DeliveryCommitment", "PurchaseOrderLine", "PurchaseOrderVersion", "PurchaseOrder", "VendorQuoteLine", "QuoteComparison", "VendorQuote", "Rfq", "RequisitionLine", "Requisition", "ApprovedSubstitution", "CrewMembership", "Crew", "WorkerDevice", "Worker", "LabourDemandSlice", "LabourRequirementSpec", "LabourTrade", "LabourSkill", "MaterialRequirementSpec", "ActivityRequirement", "ActivityRequirementRoot", "DecisionApprovalRevision", "ProjectCapability"';

  const pmc = (projectId: string): AuthUser => ({ sub: f.memberUser.id, role: 'pmc', projectId }) as AuthUser;

  beforeAll(async () => {
    t = await createTestApp();
    f = await createTwoProjectFixture(t.prisma);
    requirements = t.app.get(RequirementsService);
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
      ['auditLog', { projectId: { startsWith: 'it-p4c2-' } }],
      ['activity', { projectId: { startsWith: 'it-p4c2-' } }],
      ['membership', { projectId: { startsWith: 'it-p4c2-' } }],
      ['project', { id: { startsWith: 'it-p4c2-' } }],
    ] as const) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (t.prisma as any)[model].deleteMany({ where });
    }
  });

  const freshProject = async (): Promise<string> => {
    const id = `it-p4c2-${Date.now() % 1e6}-${seq++}`;
    await t.prisma.project.create({
      data: { id, orgId: f.orgA.id, name: id, short: 'P', descriptor: '', stage: 'x', siteCode: 'P', projStart: 'a', projEnd: 'b', elapsedPct: 0, todayDay: 0, milestonePct: 0, timeZone: 'Asia/Kolkata', scheduleStartDate: new Date('2026-06-01T00:00:00.000Z') },
    });
    await t.prisma.membership.create({ data: { projectId: id, userId: f.memberUser.id, role: 'pmc', status: 'active' } });
    return id;
  };
  const freshActivity = async (projectId: string): Promise<string> => {
    const id = `IT-P4C2-ACT-${Date.now() % 1e6}-${seq++}`;
    await t.prisma.activity.create({ data: { id, projectId, name: `Act ${seq}`, zone: 'Zone 1', plannedStart: 0, plannedEnd: 10 } });
    return id;
  };
  const enableLabour = async (projectId: string): Promise<void> => {
    await capabilities.enable(projectId, LABOUR_CAPABILITY, f.memberUser.id);
    await labour.upsertTrade(projectId, { code: 'mason', name: 'Mason' }, pmc(projectId));
    await labour.upsertSkill(projectId, { code: 'bar-bending', name: 'Bar Bending' }, pmc(projectId));
  };
  // a valid labour requirement: 2 + 5 = 7 person-shifts; requiredBy = max civil date (2026-08-12)
  const labourReq = (activityId: string) =>
    ({
      type: 'labour', activityId, tradeCode: 'mason', skillCode: 'bar-bending', shift: 'day',
      demandSlices: [{ civilDate: '2026-08-10', personShiftQty: 2 }, { civilDate: '2026-08-12', personShiftQty: 5 }],
      decisionId: null, responsibleId: null, criticality: 'normal', tolerance: null,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any;

  // ── Finding 1 — the demand seal is DURABLE: a slice appended AFTER the initial commit is refused ──
  it('DURABLE DEMAND: appending a 1-unit slice to a sealed 7-person-shift revision FAILS at commit; the original aggregate is unchanged', async () => {
    const projectId = await freshProject();
    await enableLabour(projectId);
    const act = await freshActivity(projectId);
    const created = await requirements.create(projectId, labourReq(act), pmc(projectId));
    const rid = created.requirementId;

    // baseline: the sealed revision (revision 1) carries exactly its two slices summing to 7.
    const before = await t.prisma.labourDemandSlice.findMany({ where: { projectId, requirementId: rid, revision: 1 } });
    expect(before).toHaveLength(2);
    expect(before.reduce((s, x) => s + x.personShiftQty, 0)).toBe(7);

    // A LATER, separate transaction appends a 1-unit slice on a NEW civil date. Before the fix this
    // committed (the seal fired only on spec insert); after the fix the slice-insert seal re-checks
    // the WHOLE aggregate at commit — sum(8) != requiredQty(7) AND max date drifts — and REFUSES it.
    await expect(
      t.prisma.$executeRawUnsafe(
        `INSERT INTO "LabourDemandSlice" ("id","projectId","requirementId","revision","civilDate","personShiftQty") VALUES ($1,$2,$3,1,'2026-08-13'::date,1)`,
        `lds-extra-${rid}`, projectId, rid,
      ),
    ).rejects.toThrow(/requiredQty .* must equal SUM|requiredBy .* must equal MAX/);

    // the sealed aggregate is UNCHANGED — the append did not partially land.
    const after = await t.prisma.labourDemandSlice.findMany({ where: { projectId, requirementId: rid, revision: 1 } });
    expect(after).toHaveLength(2);
    expect(after.reduce((s, x) => s + x.personShiftQty, 0)).toBe(7);
  });

  // ── Finding 2 — worker-skill referential integrity is BIDIRECTIONAL: deleting/re-keying a
  //    referenced LabourSkill is refused, so a Worker.skillCodes element can never be orphaned. ─────
  it('DURABLE SKILL REF: deleting or re-keying a LabourSkill a worker references FAILS; both rows are unchanged', async () => {
    const projectId = await freshProject();
    await enableLabour(projectId);
    await labour.upsertSkill(projectId, { code: 'tiling', name: 'Tiling' }, pmc(projectId));
    const w = await labour.onboardWorker(
      projectId,
      { name: 'Tara', tradeCode: 'mason', skillCodes: ['tiling'], activeFrom: '2026-06-01' },
      pmc(projectId),
    );

    // DELETE the referenced skill — before the fix this succeeded (orphaning the worker); after the
    // fix the reverse guard refuses it.
    await expect(
      t.prisma.$executeRawUnsafe(`DELETE FROM "LabourSkill" WHERE "projectId"=$1 AND "code"='tiling'`, projectId),
    ).rejects.toThrow(/referenced by a Worker/i);

    // RE-KEY the referenced skill (code change) — equally refused: it would dangle the reference.
    await expect(
      t.prisma.$executeRawUnsafe(`UPDATE "LabourSkill" SET "code"='tiling-2' WHERE "projectId"=$1 AND "code"='tiling'`, projectId),
    ).rejects.toThrow(/referenced by a Worker/i);

    // both rows are unchanged: the skill still exists, the worker still references it.
    const skill = await t.prisma.labourSkill.findUnique({ where: { projectId_code: { projectId, code: 'tiling' } } });
    expect(skill).not.toBeNull();
    const worker = await t.prisma.worker.findUniqueOrThrow({ where: { id: w.id } });
    expect(worker.skillCodes).toContain('tiling');

    // a NON-referenced skill can still be deleted (the guard is precise, not a blanket lock).
    await labour.upsertSkill(projectId, { code: 'painting', name: 'Painting' }, pmc(projectId));
    await t.prisma.$executeRawUnsafe(`DELETE FROM "LabourSkill" WHERE "projectId"=$1 AND "code"='painting'`, projectId);
    const gone = await t.prisma.labourSkill.findUnique({ where: { projectId_code: { projectId, code: 'painting' } } });
    expect(gone).toBeNull();
  });
});
