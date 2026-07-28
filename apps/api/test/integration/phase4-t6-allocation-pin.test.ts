import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { createTestApp, type TestApp } from './test-app';
import { createTwoProjectFixture, type TwoProjectFixture } from './fixtures';
import { RequirementsService } from '../../src/activities/requirements.service';
import { LabourService } from '../../src/labour/labour.service';
import { LabourCapacityService } from '../../src/labour/labour-capacity.service';
import { CapabilitiesService, LABOUR_CAPABILITY } from '../../src/platform/capabilities.service';
import type { AuthUser } from '../../src/common/auth';

/**
 * Phase 4 Task 6 — Codex review round 3 (P1): allocation commands PIN the requirement head the
 * caller selected against.
 *
 * The defect (RED at `0172dc2`): `labour.allocation.allocate` derived `originRevision` and
 * `labourSpecFingerprint` from the CURRENT head at execution time with no way for the caller to
 * state which head it chose the worker for. An offline-queued browser command replaying after a
 * revision (mason → carpenter, day → night…) would therefore insert the stale worker as coverage
 * for the NEW demand whenever the activity and civil date still matched — silent wrong-crew
 * coverage instead of a refusal.
 *
 * The fix: the allocate contract carries an OPTIONAL `originRevision`; when present and not equal
 * to the live head revision the server refuses with a deterministic 409 (terminal — the client
 * outbox drops it and reconciles), and when equal (or absent — pre-round-3 clients) the command
 * behaves byte-for-byte as before. The allocation's shift/fingerprint stay SERVER-derived.
 */
describe('Phase 4 Task 6 round 3 — allocation pinned to the selected requirement head (live PG)', () => {
  let t: TestApp;
  let f: TwoProjectFixture;
  let requirements: RequirementsService;
  let labour: LabourService;
  let capacity: LabourCapacityService;
  let capabilities: CapabilitiesService;
  let seq = 0;

  const TRUNCATE =
    'TRUNCATE TABLE "DomainEvent", "OutboxDelivery", "ProcessedEvent", "ProjectionCursor", "ProjectionGeneration", "DecisionProjection", "DailyLogProjection", "DrawingsProjection", "InspectionsProjection", "ActivitiesProjection", "MaterialReadinessProjection", "LabourReadinessProjection", "LabourWorkFact", "WorkerAllocation", "LabourAttendance", "ApprovedSkillSubstitution", "CapacityPromise", "CapacityCommitment", "LabourPurchaseOrderLine", "LabourPurchaseOrderVersion", "LabourPurchaseOrder", "SupplierLabourQuoteLine", "SupplierLabourQuote", "LabourQuoteComparison", "LabourRfq", "LabourRequisitionLine", "LabourRequisition", "VendorLabourProfile", "ProjectVendor", "CommandExecution", "CrewMembership", "Crew", "WorkerDevice", "WorkerSkill", "Worker", "LabourDemandSlice", "LabourRequirementSpec", "LabourTrade", "LabourSkill", "MaterialRequirementSpec", "ActivityRequirement", "ActivityRequirementRoot", "DecisionApprovalRevision", "ProjectCapability" CASCADE';

  const pmc = (projectId: string): AuthUser => ({ sub: f.memberUser.id, role: 'pmc', projectId }) as AuthUser;

  beforeAll(async () => {
    t = await createTestApp();
    f = await createTwoProjectFixture(t.prisma);
    requirements = t.app.get(RequirementsService);
    labour = t.app.get(LabourService);
    capacity = t.app.get(LabourCapacityService);
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
      ['auditLog', { projectId: { startsWith: 'it-p4pin-' } }],
      ['activity', { projectId: { startsWith: 'it-p4pin-' } }],
      ['membership', { projectId: { startsWith: 'it-p4pin-' } }],
      ['project', { id: { startsWith: 'it-p4pin-' } }],
    ] as const) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (t.prisma as any)[model].deleteMany({ where });
    }
  });

  const fixture = async () => {
    const projectId = `it-p4pin-${Date.now() % 1e6}-${seq++}`;
    await t.prisma.project.create({
      data: { id: projectId, orgId: f.orgA.id, name: projectId, short: 'P', descriptor: '', stage: 'x', siteCode: 'P', projStart: 'a', projEnd: 'b', elapsedPct: 0, todayDay: 0, milestonePct: 0, timeZone: 'Asia/Kolkata', scheduleStartDate: new Date('2026-06-01T00:00:00.000Z') },
    });
    await t.prisma.membership.create({ data: { projectId, userId: f.memberUser.id, role: 'pmc', status: 'active' } });
    const activityId = `IT-P4PIN-ACT-${Date.now() % 1e6}-${seq++}`;
    await t.prisma.activity.create({ data: { id: activityId, projectId, name: `Act ${seq}`, zone: 'Zone 1', plannedStart: 0, plannedEnd: 10 } });
    await capabilities.enable(projectId, LABOUR_CAPABILITY, f.memberUser.id);
    await labour.upsertTrade(projectId, { code: 'mason', name: 'Mason' }, pmc(projectId));
    await labour.upsertTrade(projectId, { code: 'carpenter', name: 'Carpenter' }, pmc(projectId));
    const r = await requirements.create(
      projectId,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { type: 'labour', activityId, tradeCode: 'mason', skillCode: null, shift: 'day', demandSlices: [{ civilDate: '2026-08-10', personShiftQty: 2 }], decisionId: null, responsibleId: null, criticality: 'normal', tolerance: null } as any,
      pmc(projectId),
    );
    const workers: string[] = [];
    for (let i = 0; i < 3; i++) {
      const w = await labour.onboardWorker(projectId, { name: `W${seq}-${i}`, tradeCode: 'mason', skillCodes: [], activeFrom: '2026-01-01', activeTo: null }, pmc(projectId));
      workers.push(w.id);
    }
    return { projectId, activityId, requirementId: r.requirementId, revision: r.revision, workers };
  };

  it('a MATCHING originRevision allocates; an OMITTED pin keeps pre-round-3 semantics byte-for-byte', async () => {
    const { projectId, activityId, requirementId, revision, workers } = await fixture();
    // pinned to the live head — accepted, and the row still carries the server-derived identity
    const pinned = await capacity.allocate(projectId, { activityId, requirementId, civilDate: '2026-08-10', workerId: workers[0], originRevision: revision }, pmc(projectId));
    expect(pinned.allocations).toHaveLength(1);
    expect(pinned.allocations[0]!.originRevision).toBe(revision);
    // unpinned (a pre-round-3 client / persisted queue entry) — unchanged behaviour
    const unpinned = await capacity.allocate(projectId, { activityId, requirementId, civilDate: '2026-08-10', workerId: workers[1] }, pmc(projectId));
    expect(unpinned.allocations).toHaveLength(1);
    expect(unpinned.allocations[0]!.originRevision).toBe(revision);
  });

  it('a STALE originRevision — the offline replay landing after a revision — is a deterministic 409 that allocates NOTHING', async () => {
    const { projectId, activityId, requirementId, revision, workers } = await fixture();
    // the head moves: the demand becomes CARPENTER (same activity, same civil date, same qty), so a
    // worker chosen for the mason head no longer answers the live demand
    await requirements.revise(
      projectId, requirementId,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { type: 'labour', activityId, tradeCode: 'carpenter', skillCode: null, shift: 'day', demandSlices: [{ civilDate: '2026-08-10', personShiftQty: 2 }], decisionId: null, responsibleId: null, criticality: 'normal', tolerance: null, expectedRevision: revision } as any,
      pmc(projectId),
    );
    await expect(
      capacity.allocate(projectId, { activityId, requirementId, civilDate: '2026-08-10', workerId: workers[2], originRevision: revision }, pmc(projectId)),
    ).rejects.toMatchObject({ status: 409 });
    expect(await t.prisma.workerAllocation.count({ where: { projectId } })).toBe(0);
    // the SAME command re-pinned to the live head is accepted — the refusal is head drift, not the worker
    const head = await t.prisma.labourRequirementSpec.findFirstOrThrow({ where: { projectId, requirementId }, orderBy: { revision: 'desc' } });
    const ok = await capacity.allocate(projectId, { activityId, requirementId, civilDate: '2026-08-10', workerId: workers[2], originRevision: head.revision }, pmc(projectId));
    expect(ok.allocations).toHaveLength(1);
    expect(ok.allocations[0]!.labourSpecFingerprint).toBe(head.labourSpecFingerprint);
  });
});
