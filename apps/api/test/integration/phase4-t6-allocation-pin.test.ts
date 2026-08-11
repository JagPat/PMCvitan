import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
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
    'TRUNCATE TABLE "VendorAdvance", "PaymentReversal", "Payment", "PaymentApproval", "BillDeductionRelease", "BillDeduction", "SodException", "SodGrant", "CertifiedMeasurementConsumption", "CertifiedAcceptanceConsumption", "BillCertificate", "DomainEvent", "OutboxDelivery", "ProcessedEvent", "ProjectionCursor", "ProjectionGeneration", "DecisionProjection", "DailyLogProjection", "DrawingsProjection", "InspectionsProjection", "ActivitiesProjection", "MaterialReadinessProjection", "CashForecastProjection", "LabourReadinessProjection", "LabourWorkFact", "WorkerAllocation", "LabourAttendance", "ApprovedSkillSubstitution", "CapacityPromise", "CapacityCommitment", "LabourPurchaseOrderLine", "LabourPurchaseOrderVersion", "LabourPurchaseOrder", "SupplierLabourQuoteLine", "SupplierLabourQuote", "LabourQuoteComparison", "LabourRfq", "LabourRequisitionLine", "LabourRequisition", "VendorLabourProfile", "ProjectPartyVendorSource", "ProjectPartyCompanySource", "ProjectParty", "ProjectVendor", "CommandExecution", "CrewMembership", "Crew", "WorkerDevice", "WorkerSkill", "Worker", "LabourDemandSlice", "LabourRequirementSpec", "LabourTrade", "LabourSkill", "MaterialRequirementSpec", "ActivityRequirement", "ActivityRequirementRoot", "DecisionApprovalRevision", "ProjectCapability" CASCADE';

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

  it('CODEX R7-1 — effort against a RELEASED allocation is a deterministic 409 that records NOTHING (the stale queued replay cannot undo a no-work release)', async () => {
    const { projectId, activityId, requirementId, revision, workers } = await fixture();
    const a = await capacity.allocate(projectId, { activityId, requirementId, civilDate: '2026-08-10', workerId: workers[0], originRevision: revision }, pmc(projectId));
    const allocationId = a.allocations[0]!.id;
    // the pmc releases the worker WITHOUT any work — §C frees the worker and the slice's coverage
    await capacity.release(projectId, allocationId, { reason: 'reassigned' }, pmc(projectId));
    // the browser's queued work op now flushes — accepting it would mint delivered-effort
    // evidence (coverage + productivity) that the release was meant to remove
    await expect(
      capacity.recordWork(projectId, { allocationId, workedMinutes: 480 }, pmc(projectId)),
    ).rejects.toMatchObject({ status: 409 });
    expect(await t.prisma.labourWorkFact.count({ where: { projectId } })).toBe(0);
    // control — the refusal is the RELEASED state, not the command: an ACTIVE allocation records
    const b = await capacity.allocate(projectId, { activityId, requirementId, civilDate: '2026-08-10', workerId: workers[1], originRevision: revision }, pmc(projectId));
    const fact = await capacity.recordWork(projectId, { allocationId: b.allocations[0]!.id, workedMinutes: 480 }, pmc(projectId));
    expect(fact.workedMinutes).toBe(480);
  });

  it('CODEX R8-4 — the stated eligibility BASIS is verified: a revoked or unknown substitution authority is a deterministic 409', async () => {
    const { projectId, activityId, requirementId, revision, workers } = await fixture();
    const carp1 = await labour.onboardWorker(projectId, { name: 'Carp1', tradeCode: 'carpenter', skillCodes: [], activeFrom: '2026-01-01', activeTo: null }, pmc(projectId));
    const carp2 = await labour.onboardWorker(projectId, { name: 'Carp2', tradeCode: 'carpenter', skillCodes: [], activeFrom: '2026-01-01', activeTo: null }, pmc(projectId));
    const sub = await capacity.approveSkillSubstitution(projectId, { requirementId, tradeCode: 'carpenter', skillCode: null, shift: 'day', reason: 'carpenters may stand in' } as Parameters<typeof capacity.approveSkillSubstitution>[1], pmc(projectId));
    const carpFp = sub.toFingerprint;
    const headFp = (await t.prisma.labourRequirementSpec.findFirstOrThrow({ where: { projectId, requirementId, revision }, select: { labourSpecFingerprint: true } })).labourSpecFingerprint;
    // an ACTIVE substitution basis is accepted; the FROZEN identity stays the HEAD identity —
    // the cleared §C seal (`WorkerAllocation_spec_fkey` pins the spec's WHOLE frozen identity,
    // verified by the T3C deploy seals) makes a substitute identity on the row unrepresentable;
    // undoing a substitution-backed assignment is the pmc's `allocation.release`.
    const res = await capacity.allocate(projectId, { activityId, requirementId, civilDate: '2026-08-10', workerId: carp1.id, originRevision: revision, labourSpecFingerprint: carpFp }, pmc(projectId));
    expect(res.allocations[0]!.labourSpecFingerprint).toBe(headFp);
    // once REVOKED, the basis no longer verifies — a queued replay cannot land on dead authority
    await capacity.revokeSkillSubstitution(projectId, sub.id, { reason: 'withdrawn' }, pmc(projectId));
    await expect(
      capacity.allocate(projectId, { activityId, requirementId, civilDate: '2026-08-10', workerId: carp2.id, originRevision: revision, labourSpecFingerprint: carpFp }, pmc(projectId)),
    ).rejects.toMatchObject({ status: 409 });
    // an arbitrary (never-approved) fingerprint is refused outright
    await expect(
      capacity.allocate(projectId, { activityId, requirementId, civilDate: '2026-08-10', workerId: carp2.id, originRevision: revision, labourSpecFingerprint: 'a'.repeat(64) }, pmc(projectId)),
    ).rejects.toMatchObject({ status: 409 });
    // the HEAD identity stated explicitly stays byte-identical to an unstated basis
    const head = await capacity.allocate(projectId, { activityId, requirementId, civilDate: '2026-08-10', workerId: workers[0], originRevision: revision, labourSpecFingerprint: headFp }, pmc(projectId));
    expect(head.allocations[0]!.labourSpecFingerprint).toBe(headFp);
  });

  it('CODEX R10-1 — revoking a substitution RELEASES the allocations it ALONE authorized; native and otherwise-covered rows survive', async () => {
    const { projectId, activityId, requirementId, revision, workers } = await fixture();
    await labour.upsertSkill(projectId, { code: 'formwork', name: 'Formwork' }, pmc(projectId));
    // carp1 is eligible ONLY through substitution A (carpenter); carp2 also carries the formwork
    // skill, so substitution B (carpenter+formwork) covers them independently of A
    const carp1 = await labour.onboardWorker(projectId, { name: 'CarpOnly', tradeCode: 'carpenter', skillCodes: [], activeFrom: '2026-01-01', activeTo: null }, pmc(projectId));
    const carp2 = await labour.onboardWorker(projectId, { name: 'CarpForm', tradeCode: 'carpenter', skillCodes: ['formwork'], activeFrom: '2026-01-01', activeTo: null }, pmc(projectId));
    const subA = await capacity.approveSkillSubstitution(projectId, { requirementId, tradeCode: 'carpenter', skillCode: null, shift: 'day', reason: 'stand-in' } as Parameters<typeof capacity.approveSkillSubstitution>[1], pmc(projectId));
    const subB = await capacity.approveSkillSubstitution(projectId, { requirementId, tradeCode: 'carpenter', skillCode: 'formwork', shift: 'day', reason: 'formwork stand-in' } as Parameters<typeof capacity.approveSkillSubstitution>[1], pmc(projectId));
    // three allocations onto the 2-qty slice would exceed demand — widen via a second civil date?
    // No: worker-level conservation is per (worker, date, shift); the slice qty bounds NOTHING at
    // allocate time (coverage reads it) — all three rows are legal §C facts.
    const viaA = await capacity.allocate(projectId, { activityId, requirementId, civilDate: '2026-08-10', workerId: carp1.id, originRevision: revision, labourSpecFingerprint: subA.toFingerprint }, pmc(projectId));
    const viaB = await capacity.allocate(projectId, { activityId, requirementId, civilDate: '2026-08-10', workerId: carp2.id, originRevision: revision, labourSpecFingerprint: subA.toFingerprint }, pmc(projectId));
    const native = await capacity.allocate(projectId, { activityId, requirementId, civilDate: '2026-08-10', workerId: workers[0], originRevision: revision }, pmc(projectId));
    // REVOKE A — the authority that alone qualified carp1. Pre-round-10 all three rows stayed
    // ACTIVE and coverage kept counting carp1 as native head-fingerprint sourcing forever.
    await capacity.revokeSkillSubstitution(projectId, subA.id, { reason: 'withdrawn' }, pmc(projectId));
    const carp1Row = await t.prisma.workerAllocation.findFirstOrThrow({ where: { projectId, id: viaA.allocations[0]!.id } });
    expect(carp1Row.status).toBe('released');
    expect(carp1Row.releaseReason).toContain('skill substitution revoked');
    expect(carp1Row.releasedById).toBe(f.memberUser.id);
    // carp2 is still covered by the LIVE substitution B — untouched
    expect((await t.prisma.workerAllocation.findFirstOrThrow({ where: { projectId, id: viaB.allocations[0]!.id } })).status).toBe('active');
    // the natively-qualified mason is untouched
    expect((await t.prisma.workerAllocation.findFirstOrThrow({ where: { projectId, id: native.allocations[0]!.id } })).status).toBe('active');
    // revoking B ends carp2's LAST live authority — now that row is released too
    await capacity.revokeSkillSubstitution(projectId, subB.id, { reason: 'also withdrawn' }, pmc(projectId));
    expect((await t.prisma.workerAllocation.findFirstOrThrow({ where: { projectId, id: viaB.allocations[0]!.id } })).status).toBe('released');
    expect((await t.prisma.workerAllocation.findFirstOrThrow({ where: { projectId, id: native.allocations[0]!.id } })).status).toBe('active');
  });

  it('CODEX R11-3 — a work replay against an allocation whose demand MOVED is a deterministic 409 that records NOTHING', async () => {
    const { projectId, activityId, requirementId, revision, workers } = await fixture();
    const a = await capacity.allocate(projectId, { activityId, requirementId, civilDate: '2026-08-10', workerId: workers[0], originRevision: revision }, pmc(projectId));
    const allocationId = a.allocations[0]!.id;
    // the demand becomes CARPENTER — the mason allocation stays ACTIVE but coverage strands it
    await requirements.revise(
      projectId, requirementId,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { type: 'labour', activityId, tradeCode: 'carpenter', skillCode: null, shift: 'day', demandSlices: [{ civilDate: '2026-08-10', personShiftQty: 2 }], decisionId: null, responsibleId: null, criticality: 'normal', tolerance: null, expectedRevision: revision } as any,
      pmc(projectId),
    );
    // the queued work op now flushes — accepting it would book actual effort + §I productivity
    // onto a slice coverage no longer counts (round 7 only checked `status === 'active'`)
    await expect(
      capacity.recordWork(projectId, { allocationId, workedMinutes: 480 }, pmc(projectId)),
    ).rejects.toMatchObject({ status: 409 });
    expect(await t.prisma.labourWorkFact.count({ where: { projectId } })).toBe(0);
    // control — an allocation matching the LIVE head still records (the refusal is the drift)
    const carp = await labour.onboardWorker(projectId, { name: 'CarpR11', tradeCode: 'carpenter', skillCodes: [], activeFrom: '2026-01-01', activeTo: null }, pmc(projectId));
    const head = await t.prisma.labourRequirementSpec.findFirstOrThrow({ where: { projectId, requirementId }, orderBy: { revision: 'desc' } });
    const b = await capacity.allocate(projectId, { activityId, requirementId, civilDate: '2026-08-10', workerId: carp.id, originRevision: head.revision }, pmc(projectId));
    const fact = await capacity.recordWork(projectId, { allocationId: b.allocations[0]!.id, workedMinutes: 480 }, pmc(projectId));
    expect(fact.workedMinutes).toBe(480);
  });

  it('CODEX R11-6 — a worker who satisfies neither the head identity nor an ACTIVE substitution cannot be allocated at all', async () => {
    const { projectId, activityId, requirementId, revision, workers } = await fixture();
    await labour.upsertTrade(projectId, { code: 'electrician', name: 'Electrician' }, pmc(projectId));
    const elec = await labour.onboardWorker(projectId, { name: 'Elec', tradeCode: 'electrician', skillCodes: [], activeFrom: '2026-01-01', activeTo: null }, pmc(projectId));
    // a DIRECT command (no stated basis — the UI's compatible picker never offers this) placing an
    // electrician onto the mason head previously SUCCEEDED, froze the mason fingerprint and made
    // coverage count the row as native mason sourcing
    await expect(
      capacity.allocate(projectId, { activityId, requirementId, civilDate: '2026-08-10', workerId: elec.id, originRevision: revision }, pmc(projectId)),
    ).rejects.toMatchObject({ status: 400 });
    expect(await t.prisma.workerAllocation.count({ where: { projectId } })).toBe(0);
    // an ACTIVE substitution widening the demand to electricians makes the same worker legal…
    await capacity.approveSkillSubstitution(projectId, { requirementId, tradeCode: 'electrician', skillCode: null, shift: 'day', reason: 'electricians may stand in' } as Parameters<typeof capacity.approveSkillSubstitution>[1], pmc(projectId));
    const ok = await capacity.allocate(projectId, { activityId, requirementId, civilDate: '2026-08-10', workerId: elec.id, originRevision: revision }, pmc(projectId));
    expect(ok.allocations).toHaveLength(1);
    // …and the natively-qualified mason was always legal
    const mason = await capacity.allocate(projectId, { activityId, requirementId, civilDate: '2026-08-10', workerId: workers[0], originRevision: revision }, pmc(projectId));
    expect(mason.allocations).toHaveLength(1);
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
    // a command re-pinned to the live head with a worker who SATISFIES it is accepted — the
    // refusal above is head drift, not the command shape (round 11: the mason workers no longer
    // qualify for the carpenter head, so the control uses a carpenter)
    const head = await t.prisma.labourRequirementSpec.findFirstOrThrow({ where: { projectId, requirementId }, orderBy: { revision: 'desc' } });
    const carp = await labour.onboardWorker(projectId, { name: 'CarpPin', tradeCode: 'carpenter', skillCodes: [], activeFrom: '2026-01-01', activeTo: null }, pmc(projectId));
    const ok = await capacity.allocate(projectId, { activityId, requirementId, civilDate: '2026-08-10', workerId: carp.id, originRevision: head.revision }, pmc(projectId));
    expect(ok.allocations).toHaveLength(1);
    expect(ok.allocations[0]!.labourSpecFingerprint).toBe(head.labourSpecFingerprint);
  });

  it('CODEX R12-2 — a TRANSIENT failure inside the live-demand recheck propagates raw (retryable), never the terminal 409 that drops queued effort', async () => {
    const { projectId, activityId, requirementId, revision, workers } = await fixture();
    const a = await capacity.allocate(projectId, { activityId, requirementId, civilDate: '2026-08-10', workerId: workers[0], originRevision: revision }, pmc(projectId));
    const allocationId = a.allocations[0]!.id;
    // RED at 19106d7: the R11-3 recheck wrapped BOTH lookups in a blanket try/catch, so this
    // infrastructure blip became `live = false` → ConflictException — a 409 the web outbox
    // treats as TERMINAL, permanently discarding legitimate worked-minutes evidence.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const spy = vi.spyOn(capacity as any, 'requirementHead').mockRejectedValueOnce(new Error('connection reset'));
    try {
      await expect(
        capacity.recordWork(projectId, { allocationId, workedMinutes: 480 }, pmc(projectId)),
      ).rejects.toThrow('connection reset'); // the raw error, NOT the revised/cancelled 409
    } finally {
      spy.mockRestore();
    }
    expect(await t.prisma.labourWorkFact.count({ where: { projectId } })).toBe(0);
    // control — the same replay against healthy infrastructure records exactly once
    const fact = await capacity.recordWork(projectId, { allocationId, workedMinutes: 480 }, pmc(projectId));
    expect(fact.workedMinutes).toBe(480);
    // and the EXPECTED demand-gone signal is still the deterministic 409 (R11-3 unchanged)
    await requirements.revise(
      projectId, requirementId,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { type: 'labour', activityId, tradeCode: 'carpenter', skillCode: null, shift: 'day', demandSlices: [{ civilDate: '2026-08-10', personShiftQty: 2 }], decisionId: null, responsibleId: null, criticality: 'normal', tolerance: null, expectedRevision: revision } as any,
      pmc(projectId),
    );
    await expect(
      capacity.recordWork(projectId, { allocationId, workedMinutes: 120 }, pmc(projectId)),
    ).rejects.toMatchObject({ status: 409 });
  });
});
