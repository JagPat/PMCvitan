import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { createTestApp, type TestApp } from './test-app';
import { createTwoProjectFixture, type TwoProjectFixture } from './fixtures';
import { RequirementsService } from '../../src/activities/requirements.service';
import { LabourService } from '../../src/labour/labour.service';
import { LabourProcurementService } from '../../src/labour/labour-procurement.service';
import { LabourCapacityService, SHIFT_MINUTES } from '../../src/labour/labour-capacity.service';
import { WorkerDevicesService } from '../../src/orgs/worker-devices.service';
import { VendorsService } from '../../src/procurement/vendors.service';
import { CapabilitiesService, LABOUR_CAPABILITY } from '../../src/platform/capabilities.service';
import { lockProjectReadiness } from '../../src/common/readiness-lock';
import type { AuthUser } from '../../src/common/auth';

/**
 * Phase 4 Task 3 — the §C TIME-CAPACITY facts, proven live against PostgreSQL, reproduce-first.
 *
 * Labour is EXPIRING capacity: three immutable observation families with DISTINCT units plus ONE
 * frozen-identity CAS assignment. There is no bucket ledger and no current-quantity column, so
 * every assertion here reads the FACTS.
 *
 * Covered (the plan's required Task-3 probes):
 *   §C.2 slice arithmetic (2 workers × 3 days = 6 person-shifts; one slice never satisfies another)
 *   §C.2 duplicate allocation rejected; release frees the slice; frozen identity + one-way lifecycle
 *   §C.2 RACES — competing activities, worker-vs-crew, overlapping crews (deadlock-free, stable
 *        ascending workerId lock order), each admitting EXACTLY one
 *   §C.3 one attendance per worker/date/shift; revocation is a correction; device evidence must be
 *        BOUND to that worker
 *   §C.4 cumulative Σ workedMinutes ≤ shiftMinutes (a per-row CHECK cannot catch this)
 *   §F bound 3 — allocated ≤ committed per slice, incl. a partial date-range commitment covering
 *        ONLY its own slices, and under a barrier race
 *   §B widening — a substitution pins the requirement's CURRENT head; a revision strands it
 *   §H containment — a cross-project worker/device/activity reference is unrepresentable
 *   §D capability-off inertness; §C rule ii — a keyed replay appends NOTHING
 */
describe('Phase 4 Task 3 — §C time-capacity facts (live PG)', () => {
  let t: TestApp;
  let f: TwoProjectFixture;
  let requirements: RequirementsService;
  let labour: LabourService;
  let commercial: LabourProcurementService;
  let capacity: LabourCapacityService;
  let devices: WorkerDevicesService;
  let vendors: VendorsService;
  let capabilities: CapabilitiesService;
  let seq = 0;

  const TRUNCATE =
    'TRUNCATE TABLE "SodException", "CertifiedMeasurementConsumption", "CertifiedAcceptanceConsumption", "BillCertificate", "DomainEvent", "OutboxDelivery", "ProcessedEvent", "ProjectionCursor", "ProjectionGeneration", "DecisionProjection", "DailyLogProjection", "DrawingsProjection", "InspectionsProjection", "ActivitiesProjection", "MaterialReadinessProjection", "LabourReadinessProjection", "LabourWorkFact", "WorkerAllocation", "LabourAttendance", "ApprovedSkillSubstitution", "CapacityPromise", "CapacityCommitment", "LabourPurchaseOrderLine", "LabourPurchaseOrderVersion", "LabourPurchaseOrder", "SupplierLabourQuoteLine", "SupplierLabourQuote", "LabourQuoteComparison", "LabourRfq", "LabourRequisitionLine", "LabourRequisition", "VendorLabourProfile", "ProjectVendor", "CommandExecution", "CrewMembership", "Crew", "WorkerDevice", "WorkerSkill", "Worker", "LabourDemandSlice", "LabourRequirementSpec", "LabourTrade", "LabourSkill", "MaterialRequirementSpec", "ActivityRequirement", "ActivityRequirementRoot", "DecisionApprovalRevision", "ProjectCapability" CASCADE';

  const pmc = (projectId: string): AuthUser => ({ sub: f.memberUser.id, role: 'pmc', projectId }) as AuthUser;
  const orgAdmin = (): AuthUser => ({ sub: f.ownerUser.id, role: 'pmc', projectId: '' }) as AuthUser;

  beforeAll(async () => {
    t = await createTestApp();
    f = await createTwoProjectFixture(t.prisma);
    requirements = t.app.get(RequirementsService);
    labour = t.app.get(LabourService);
    commercial = t.app.get(LabourProcurementService);
    capacity = t.app.get(LabourCapacityService);
    devices = t.app.get(WorkerDevicesService);
    vendors = t.app.get(VendorsService);
    capabilities = t.app.get(CapabilitiesService);
  });
  afterAll(async () => {
    await t?.prisma.$executeRawUnsafe(TRUNCATE);
    await t?.prisma.vendor.deleteMany({ where: { orgId: f.orgA.id } });
    await f?.cleanup();
    await t?.close();
  });
  afterEach(async () => {
    await t.prisma.$executeRawUnsafe(TRUNCATE);
    await t.prisma.vendor.deleteMany({ where: { orgId: f.orgA.id } });
    for (const [model, where] of [
      ['auditLog', { projectId: { startsWith: 'it-p4c-' } }],
      ['activity', { projectId: { startsWith: 'it-p4c-' } }],
      ['membership', { projectId: { startsWith: 'it-p4c-' } }],
      ['project', { id: { startsWith: 'it-p4c-' } }],
    ] as const) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (t.prisma as any)[model].deleteMany({ where });
    }
  });

  // ── fixtures ──────────────────────────────────────────────────────────────────────────────────

  const freshProject = async (): Promise<string> => {
    const id = `it-p4c-${Date.now() % 1e6}-${seq++}`;
    await t.prisma.project.create({
      data: { id, orgId: f.orgA.id, name: id, short: 'P', descriptor: '', stage: 'x', siteCode: 'P', projStart: 'a', projEnd: 'b', elapsedPct: 0, todayDay: 0, milestonePct: 0, timeZone: 'Asia/Kolkata', scheduleStartDate: new Date('2026-06-01T00:00:00.000Z') },
    });
    await t.prisma.membership.create({ data: { projectId: id, userId: f.memberUser.id, role: 'pmc', status: 'active' } });
    return id;
  };
  const freshActivity = async (projectId: string): Promise<string> => {
    const id = `IT-P4C-ACT-${Date.now() % 1e6}-${seq++}`;
    await t.prisma.activity.create({ data: { id, projectId, name: `Act ${seq}`, zone: 'Zone 1', plannedStart: 0, plannedEnd: 10 } });
    return id;
  };
  const enableLabour = async (projectId: string): Promise<void> => {
    await capabilities.enable(projectId, LABOUR_CAPABILITY, f.memberUser.id);
    await labour.upsertTrade(projectId, { code: 'mason', name: 'Mason' }, pmc(projectId));
    await labour.upsertTrade(projectId, { code: 'carpenter', name: 'Carpenter' }, pmc(projectId));
    await labour.upsertSkill(projectId, { code: 'bar-bending', name: 'Bar Bending' }, pmc(projectId));
    await labour.upsertSkill(projectId, { code: 'shuttering', name: 'Shuttering' }, pmc(projectId));
  };
  /** a labour requirement demanding `personShiftQty` on each of the given civil dates */
  const labourRequirement = async (
    projectId: string, activityId: string,
    slices: Array<{ civilDate: string; personShiftQty: number }>,
    spec: { tradeCode?: string; skillCode?: string | null; shift?: 'day' | 'night' } = {},
  ): Promise<{ requirementId: string; revision: number }> => {
    const r = await requirements.create(
      projectId,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { type: 'labour', activityId, tradeCode: spec.tradeCode ?? 'mason', skillCode: spec.skillCode === undefined ? 'bar-bending' : spec.skillCode, shift: spec.shift ?? 'day', demandSlices: slices, decisionId: null, responsibleId: null, criticality: 'normal', tolerance: null } as any,
      pmc(projectId),
    );
    return { requirementId: r.requirementId, revision: r.revision };
  };
  const onboardWorker = async (projectId: string, name = `W${seq++}`, activeTo: string | null = null): Promise<string> => {
    const w = await labour.onboardWorker(projectId, { name, tradeCode: 'mason', skillCodes: ['bar-bending'], activeFrom: '2026-01-01', activeTo }, pmc(projectId));
    return w.id;
  };
  const formCrew = async (projectId: string, workerIds: string[]): Promise<string> => {
    const crew = await labour.formCrew(projectId, { name: `Crew ${seq++}`, activeFrom: '2026-01-01' }, pmc(projectId));
    for (const workerId of workerIds) await labour.addCrewMember(projectId, crew.id, { workerId }, pmc(projectId));
    return crew.id;
  };

  /** an ISSUED labour PO line + its CapacityCommitment for ONE (civilDate, qty) slice */
  const committedCapacity = async (
    projectId: string, req: { requirementId: string; revision: number }, civilDate: string, qty: number,
  ): Promise<{ commitmentId: string; poLineId: string }> => {
    const vendor = await vendors.create(f.orgA.id, { name: `Supplier ${seq++}` }, orgAdmin());
    await vendors.bind(projectId, { vendorId: vendor.id }, pmc(projectId));
    const requisition = await commercial.createRequisition(projectId, { title: `req ${seq++}`, lines: [{ requirementId: req.requirementId, revision: req.revision, civilDate, personShiftQty: qty }] }, pmc(projectId));
    const line = requisition.lines[0]!;
    await commercial.submitRequisition(projectId, requisition.id, pmc(projectId));
    await commercial.approveRequisition(projectId, requisition.id, pmc(projectId));
    const rfq = await commercial.createRfq(projectId, { requisitionId: requisition.id }, pmc(projectId));
    await commercial.recordQuote(projectId, rfq.id, { vendorId: vendor.id, validUntil: '2026-12-31', lines: [{ requisitionLineId: line.id, ratePerPersonShift: '1000', shiftPremium: '0', landedPerPersonShift: '1000', matchesSpecification: true }] }, pmc(projectId));
    await commercial.createComparison(projectId, rfq.id, pmc(projectId));
    const quoteId = (await commercial.readRfq(projectId, rfq.id, pmc(projectId))).quotes[0]!.id;
    await commercial.approveComparison(projectId, rfq.id, { selectedQuoteId: quoteId, reason: 'single in-spec quote' }, pmc(projectId));
    const comparisonId = (await commercial.readRfq(projectId, rfq.id, pmc(projectId))).comparison!.id;
    const po = await commercial.createPo(projectId, { comparisonId, lines: [{ requisitionLineId: line.id, personShiftQty: qty }] }, pmc(projectId));
    const poLine = po.currentVersion.lines[0]!;
    await commercial.issuePo(projectId, po.id, {}, pmc(projectId));
    const commitment = await commercial.commitCapacity(projectId, { poLineId: poLine.id, promisedDate: civilDate }, pmc(projectId));
    return { commitmentId: commitment.id, poLineId: poLine.id };
  };

  // The deterministic RACE barrier (the Phase-3 pattern): every §C command takes
  // lockProjectReadiness first, so the test holds that advisory lock, parks both commands in its
  // wait queue (verified via pg_stat_activity), and releases — grant order = enqueue order.
  const readinessWaiters = async (): Promise<number> => {
    const rows = await t.prisma.$queryRaw<Array<{ c: number }>>`
      SELECT COUNT(*)::int AS c FROM pg_stat_activity
      WHERE wait_event_type = 'Lock' AND wait_event = 'advisory'
        AND query LIKE '%pg_advisory_xact_lock%'`;
    return rows[0]!.c;
  };
  const waitForReadinessWaiters = async (n: number): Promise<void> => {
    for (let i = 0; i < 400; i++) {
      if ((await readinessWaiters()) >= n) return;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error(`barrier timeout: expected ${n} readiness-lock waiter(s)`);
  };
  const race = async (projectId: string, first: () => Promise<unknown>, second: () => Promise<unknown>) => {
    let release!: () => void;
    let acquired!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const held = new Promise<void>((r) => (acquired = r));
    const holder = t.prisma.$transaction(
      async (tx) => { await lockProjectReadiness(tx, projectId); acquired(); await gate; },
      { timeout: 20_000, maxWait: 10_000 },
    );
    await held;
    const a = first();
    await waitForReadinessWaiters(1);
    const b = second();
    await waitForReadinessWaiters(2);
    release();
    await holder;
    return Promise.allSettled([a, b]);
  };

  // ── §C.2 slice arithmetic ─────────────────────────────────────────────────────────────────────

  it('§C.2 SLICE ARITHMETIC: 2 workers × 3 days = 6 person-shifts; capacity for one slice never satisfies another', async () => {
    const projectId = await freshProject();
    await enableLabour(projectId);
    const act = await freshActivity(projectId);
    const dates = ['2026-08-10', '2026-08-11', '2026-08-12'];
    const req = await labourRequirement(projectId, act, dates.map((d) => ({ civilDate: d, personShiftQty: 2 })));
    const [w1, w2] = [await onboardWorker(projectId), await onboardWorker(projectId)];

    for (const civilDate of dates) {
      for (const workerId of [w1, w2]) {
        await capacity.allocate(projectId, { activityId: act, requirementId: req.requirementId, civilDate, workerId }, pmc(projectId));
      }
    }
    // 2 workers × 3 days = 6 person-shift rows — one row IS one person-shift (no quantity column)
    const rows = await t.prisma.workerAllocation.findMany({ where: { projectId, status: 'active' } });
    expect(rows).toHaveLength(6);
    expect(new Set(rows.map((r) => r.workerId)).size).toBe(2);
    expect(new Set(rows.map((r) => r.civilDate.toISOString().slice(0, 10))).size).toBe(3);
    // each row pins the head revision's identity (provenance), never a caller-authored value
    expect(new Set(rows.map((r) => r.labourSpecFingerprint)).size).toBe(1);
    expect(rows.every((r) => r.originRevision === req.revision && r.shift === 'day')).toBe(true);

    // a worker fully allocated on the 10th is still free on a DIFFERENT date; and allocating onto
    // a date the head revision does NOT demand is refused — one slice cannot satisfy another
    await expect(
      capacity.allocate(projectId, { activityId: act, requirementId: req.requirementId, civilDate: '2026-08-13', workerId: w1 }, pmc(projectId)),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('§C.2 CONSERVATION: a second live allocation of one worker for one (date, shift) is unrepresentable; release frees it', async () => {
    const projectId = await freshProject();
    await enableLabour(projectId);
    const [actA, actB] = [await freshActivity(projectId), await freshActivity(projectId)];
    const reqA = await labourRequirement(projectId, actA, [{ civilDate: '2026-08-10', personShiftQty: 1 }]);
    const reqB = await labourRequirement(projectId, actB, [{ civilDate: '2026-08-10', personShiftQty: 1 }]);
    const workerId = await onboardWorker(projectId);

    const first = await capacity.allocate(projectId, { activityId: actA, requirementId: reqA.requirementId, civilDate: '2026-08-10', workerId }, pmc(projectId));
    // the SAME worker on the SAME slice for a DIFFERENT activity — refused by the partial unique
    await expect(
      capacity.allocate(projectId, { activityId: actB, requirementId: reqB.requirementId, civilDate: '2026-08-10', workerId }, pmc(projectId)),
    ).rejects.toMatchObject({ status: 409 });

    // releasing frees the slice — the released row survives as honest provenance
    const allocationId = first.allocations[0]!.id;
    const released = await capacity.release(projectId, allocationId, { reason: 'reassigned to the pour' }, pmc(projectId));
    expect(released.status).toBe('released');
    expect(released.releasedById).toBe(f.memberUser.id);
    const reallocated = await capacity.allocate(projectId, { activityId: actB, requirementId: reqB.requirementId, civilDate: '2026-08-10', workerId }, pmc(projectId));
    expect(reallocated.allocations[0]!.activityId).toBe(actB);
    expect(await t.prisma.workerAllocation.count({ where: { projectId, workerId } })).toBe(2); // history retained

    // a released allocation is terminal (a second release is a deterministic 409)
    await expect(capacity.release(projectId, allocationId, { reason: 'again' }, pmc(projectId))).rejects.toMatchObject({ status: 409 });
    // the events are one per fact row
    const types = (await t.prisma.domainEvent.findMany({ where: { projectId, eventType: { startsWith: 'allocation.' } }, orderBy: { streamPosition: 'asc' } })).map((e) => e.eventType);
    expect(types).toEqual(['allocation.made', 'allocation.released', 'allocation.made']);
  });

  it('§C.2 FROZEN IDENTITY: only status + release attribution may change; a released row never re-activates; no deletes', async () => {
    const projectId = await freshProject();
    await enableLabour(projectId);
    const act = await freshActivity(projectId);
    const req = await labourRequirement(projectId, act, [{ civilDate: '2026-08-10', personShiftQty: 1 }]);
    const workerId = await onboardWorker(projectId);
    const { allocations } = await capacity.allocate(projectId, { activityId: act, requirementId: req.requirementId, civilDate: '2026-08-10', workerId }, pmc(projectId));
    const id = allocations[0]!.id;

    await expect(
      t.prisma.$executeRawUnsafe(`UPDATE "WorkerAllocation" SET "civilDate" = DATE '2026-08-11' WHERE "id" = $1`, id),
    ).rejects.toThrow(/FROZEN/i);
    await expect(
      t.prisma.$executeRawUnsafe(`UPDATE "WorkerAllocation" SET "activityId" = 'forged' WHERE "id" = $1`, id),
    ).rejects.toThrow(/FROZEN/i);
    await expect(t.prisma.$executeRawUnsafe(`DELETE FROM "WorkerAllocation" WHERE "id" = $1`, id)).rejects.toThrow(/never deleted/i);

    await capacity.release(projectId, id, { reason: 'done' }, pmc(projectId));
    await expect(
      t.prisma.$executeRawUnsafe(`UPDATE "WorkerAllocation" SET "status" = 'active' WHERE "id" = $1`, id),
    ).rejects.toThrow(/never be re-activated/i);
  });

  // ── §C.2 races (round-3 guardrail 1: stable ascending workerId lock order) ────────────────────

  it('§C.2 COMPETING-ACTIVITY RACE: two activities claiming one worker for one slice — EXACTLY one wins', async () => {
    const projectId = await freshProject();
    await enableLabour(projectId);
    const [actA, actB] = [await freshActivity(projectId), await freshActivity(projectId)];
    const reqA = await labourRequirement(projectId, actA, [{ civilDate: '2026-08-10', personShiftQty: 1 }]);
    const reqB = await labourRequirement(projectId, actB, [{ civilDate: '2026-08-10', personShiftQty: 1 }]);
    const workerId = await onboardWorker(projectId);

    const [a, b] = await race(
      projectId,
      () => capacity.allocate(projectId, { activityId: actA, requirementId: reqA.requirementId, civilDate: '2026-08-10', workerId }, pmc(projectId)),
      () => capacity.allocate(projectId, { activityId: actB, requirementId: reqB.requirementId, civilDate: '2026-08-10', workerId }, pmc(projectId)),
    );
    expect(a!.status).toBe('fulfilled');
    expect(b!.status).toBe('rejected');
    expect((b as PromiseRejectedResult).reason).toMatchObject({ status: 409 });
    expect(await t.prisma.workerAllocation.count({ where: { projectId, status: 'active' } })).toBe(1);
  });

  it('§C.2 WORKER-vs-CREW RACE: the same worker allocated directly and via a crew — EXACTLY one wins', async () => {
    const projectId = await freshProject();
    await enableLabour(projectId);
    const [actA, actB] = [await freshActivity(projectId), await freshActivity(projectId)];
    const reqA = await labourRequirement(projectId, actA, [{ civilDate: '2026-08-10', personShiftQty: 1 }]);
    const reqB = await labourRequirement(projectId, actB, [{ civilDate: '2026-08-10', personShiftQty: 2 }]);
    const shared = await onboardWorker(projectId, 'shared');
    const other = await onboardWorker(projectId, 'other');
    const crewId = await formCrew(projectId, [shared, other]);

    const [direct, viaCrew] = await race(
      projectId,
      () => capacity.allocate(projectId, { activityId: actA, requirementId: reqA.requirementId, civilDate: '2026-08-10', workerId: shared }, pmc(projectId)),
      () => capacity.allocate(projectId, { activityId: actB, requirementId: reqB.requirementId, civilDate: '2026-08-10', crewId }, pmc(projectId)),
    );
    // the direct allocation is enqueued first and wins; the crew expansion collides on the SHARED
    // member and the WHOLE crew allocation rolls back (it is one transaction) — `other` is untouched
    expect(direct!.status).toBe('fulfilled');
    expect(viaCrew!.status).toBe('rejected');
    expect((viaCrew as PromiseRejectedResult).reason).toMatchObject({ status: 409 });
    const live = await t.prisma.workerAllocation.findMany({ where: { projectId, status: 'active' } });
    expect(live).toHaveLength(1);
    expect(live[0]!.workerId).toBe(shared);
    expect(live[0]!.crewId).toBeNull();
  });

  it('§C.2 OVERLAPPING-CREWS RACE: two crews sharing a worker — EXACTLY one wins and NEITHER deadlocks', async () => {
    const projectId = await freshProject();
    await enableLabour(projectId);
    const [actA, actB] = [await freshActivity(projectId), await freshActivity(projectId)];
    const reqA = await labourRequirement(projectId, actA, [{ civilDate: '2026-08-10', personShiftQty: 3 }]);
    const reqB = await labourRequirement(projectId, actB, [{ civilDate: '2026-08-10', personShiftQty: 3 }]);
    // deliberately shaped so a NAIVE membership-order lock would invert between the two crews:
    // crew 1 = [shared, onlyA]; crew 2 = [onlyB, shared] — only the stable ascending workerId
    // ordering makes both take the shared lock in the same position.
    const shared = await onboardWorker(projectId, 'shared');
    const onlyA = await onboardWorker(projectId, 'onlyA');
    const onlyB = await onboardWorker(projectId, 'onlyB');
    const crew1 = await formCrew(projectId, [shared, onlyA]);
    const crew2 = await formCrew(projectId, [onlyB, shared]);

    const [a, b] = await race(
      projectId,
      () => capacity.allocate(projectId, { activityId: actA, requirementId: reqA.requirementId, civilDate: '2026-08-10', crewId: crew1 }, pmc(projectId)),
      () => capacity.allocate(projectId, { activityId: actB, requirementId: reqB.requirementId, civilDate: '2026-08-10', crewId: crew2 }, pmc(projectId)),
    );
    // BOTH transactions COMPLETE (no deadlock — a deadlock surfaces as PG error 40P01, never a 409)
    expect(a!.status).toBe('fulfilled');
    expect(b!.status).toBe('rejected');
    const reason = (b as PromiseRejectedResult).reason as { status?: number; message?: string };
    expect(reason.status).toBe(409);
    expect(String(reason.message)).not.toMatch(/deadlock/i);
    // exactly the winning crew's members hold live allocations
    const live = await t.prisma.workerAllocation.findMany({ where: { projectId, status: 'active' }, orderBy: { workerId: 'asc' } });
    expect(live).toHaveLength(2);
    expect(live.map((r) => r.workerId).sort()).toEqual([onlyA, shared].sort());
    expect(live.every((r) => r.crewId === crew1)).toBe(true);
  });

  // ── §C.3 attendance ───────────────────────────────────────────────────────────────────────────

  it('§C.3 ATTENDANCE: one live muster per worker/date/shift; revocation is a correction that frees a re-record', async () => {
    const projectId = await freshProject();
    await enableLabour(projectId);
    const workerId = await onboardWorker(projectId);
    // Task-3 correction F2 — a muster carries TRUSTED evidence, so bind the worker's own device
    // first. (A bare presence claim is refused; that rule has its own probe in the correction suite.)
    const device = await t.prisma.workerDevice.create({ data: { projectId, token: `tok-${Date.now()}-${seq++}` } });
    await devices.bind(projectId, device.id, { workerId }, pmc(projectId));

    const first = await capacity.recordAttendance(projectId, { workerId, civilDate: '2026-08-10', shift: 'day', deviceId: device.id }, pmc(projectId));
    expect(first).toMatchObject({ workerId, civilDate: '2026-08-10', shift: 'day', revokedAt: null });
    // a second live muster for the same slice is unrepresentable
    await expect(capacity.recordAttendance(projectId, { workerId, civilDate: '2026-08-10', shift: 'day', deviceId: device.id }, pmc(projectId))).rejects.toMatchObject({ status: 409 });
    // the NIGHT shift of the same day is a DIFFERENT slice and is allowed
    await capacity.recordAttendance(projectId, { workerId, civilDate: '2026-08-10', shift: 'night', deviceId: device.id }, pmc(projectId));

    const revoked = await capacity.revokeAttendance(projectId, first.id, { reason: 'mis-mustered' }, pmc(projectId));
    expect(revoked).toMatchObject({ revokeReason: 'mis-mustered', revokedById: f.memberUser.id });
    // the corrected re-record is now allowed; the revoked observation SURVIVES as history
    await capacity.recordAttendance(projectId, { workerId, civilDate: '2026-08-10', shift: 'day', deviceId: device.id }, pmc(projectId));
    expect(await t.prisma.labourAttendance.count({ where: { projectId, workerId, shift: 'day' } })).toBe(2);
    // a revoked row is terminal + append-only under a direct write
    await expect(capacity.revokeAttendance(projectId, first.id, { reason: 'again' }, pmc(projectId))).rejects.toMatchObject({ status: 409 });
    await expect(
      t.prisma.$executeRawUnsafe(`UPDATE "LabourAttendance" SET "civilDate" = DATE '2026-08-11' WHERE "id" = $1`, first.id),
    ).rejects.toThrow(/APPEND-ONLY/i);
  });

  it('§H TRUSTED EVIDENCE: a device may evidence a muster only for the worker it is BOUND to', async () => {
    const projectId = await freshProject();
    await enableLabour(projectId);
    const [w1, w2] = [await onboardWorker(projectId, 'w1'), await onboardWorker(projectId, 'w2')];
    const unbound = await t.prisma.workerDevice.create({ data: { projectId, token: `tok-${seq++}`, name: 'tap-in' } });

    // an UNBOUND device (anonymous QR/tap onboarding — still supported) is not readiness evidence
    await expect(
      capacity.recordAttendance(projectId, { workerId: w1, civilDate: '2026-08-10', shift: 'day', deviceId: unbound.id }, pmc(projectId)),
    ).rejects.toThrow(/not bound to a Worker/i);

    // bind it (the orgs-owned command, capability-gated + pmc authority) and the muster stands
    await devices.bind(projectId, unbound.id, { workerId: w1 }, pmc(projectId));
    const ok = await capacity.recordAttendance(projectId, { workerId: w1, civilDate: '2026-08-10', shift: 'day', deviceId: unbound.id }, pmc(projectId));
    expect(ok.deviceId).toBe(unbound.id);

    // the same device can never evidence a DIFFERENT worker's presence
    await expect(
      capacity.recordAttendance(projectId, { workerId: w2, civilDate: '2026-08-10', shift: 'day', deviceId: unbound.id }, pmc(projectId)),
    ).rejects.toThrow(/bound to worker/i);
    // and it can never be re-pointed (its past musters are attributed to w1)
    await expect(devices.bind(projectId, unbound.id, { workerId: w2 }, pmc(projectId))).rejects.toMatchObject({ status: 409 });
  });

  // ── §C.4 effort ───────────────────────────────────────────────────────────────────────────────

  it('§C.4 CUMULATIVE BOUND: two records summing past the shift are refused (a per-row CHECK cannot catch this)', async () => {
    const projectId = await freshProject();
    await enableLabour(projectId);
    const act = await freshActivity(projectId);
    const req = await labourRequirement(projectId, act, [{ civilDate: '2026-08-10', personShiftQty: 1 }]);
    const workerId = await onboardWorker(projectId);
    const { allocations } = await capacity.allocate(projectId, { activityId: act, requirementId: req.requirementId, civilDate: '2026-08-10', workerId }, pmc(projectId));
    const allocationId = allocations[0]!.id;

    // each record is INDIVIDUALLY within the per-row CHECK (<= 720) …
    const first = await capacity.recordWork(projectId, { allocationId, workedMinutes: 500 }, pmc(projectId));
    // … the effort fact copies its allocation's worker/activity/slice identity
    expect(first).toMatchObject({ workerId, activityId: act, civilDate: '2026-08-10', shift: 'day', workedMinutes: 500 });
    // … but together they would exceed the shift, so the CUMULATIVE bound refuses
    await expect(capacity.recordWork(projectId, { allocationId, workedMinutes: 300 }, pmc(projectId))).rejects.toMatchObject({ status: 409 });
    // the remainder exactly fills the shift and is accepted
    await capacity.recordWork(projectId, { allocationId, workedMinutes: SHIFT_MINUTES - 500 }, pmc(projectId));
    const total = await t.prisma.labourWorkFact.aggregate({ where: { projectId, workerId }, _sum: { workedMinutes: true } });
    expect(total._sum.workedMinutes).toBe(SHIFT_MINUTES);
    // one more minute is refused
    await expect(capacity.recordWork(projectId, { allocationId, workedMinutes: 1 }, pmc(projectId))).rejects.toMatchObject({ status: 409 });

    // effort is fully immutable — a correction is a new row, never an edit
    await expect(
      t.prisma.$executeRawUnsafe(`UPDATE "LabourWorkFact" SET "workedMinutes" = 1 WHERE "id" = $1`, first.id),
    ).rejects.toThrow();
    // and it can never be forged onto a slice its allocation does not name
    await expect(
      t.prisma.$executeRawUnsafe(
        `INSERT INTO "LabourWorkFact" ("id","projectId","workerId","allocationId","activityId","civilDate","shift","workedMinutes","recordedById","sourceCommandId")
         SELECT 'forged', "projectId", "workerId", "id", "activityId", DATE '2026-08-11', "shift", 60, "allocatedById", "sourceCommandId" FROM "WorkerAllocation" WHERE "id" = $1`,
        allocationId,
      ),
    ).rejects.toThrow(/allocation's worker\/activity\/slice/i);
  });

  it('§C.4 CUMULATIVE BOUND (RACE): two 400-minute records on one shift — the second is refused', async () => {
    const projectId = await freshProject();
    await enableLabour(projectId);
    const act = await freshActivity(projectId);
    const req = await labourRequirement(projectId, act, [{ civilDate: '2026-08-10', personShiftQty: 1 }]);
    const workerId = await onboardWorker(projectId);
    const { allocations } = await capacity.allocate(projectId, { activityId: act, requirementId: req.requirementId, civilDate: '2026-08-10', workerId }, pmc(projectId));
    const allocationId = allocations[0]!.id;

    const [a, b] = await race(
      projectId,
      () => capacity.recordWork(projectId, { allocationId, workedMinutes: 400 }, pmc(projectId)),
      () => capacity.recordWork(projectId, { allocationId, workedMinutes: 400 }, pmc(projectId)),
    );
    expect(a!.status).toBe('fulfilled');
    expect(b!.status).toBe('rejected');
    expect((b as PromiseRejectedResult).reason).toMatchObject({ status: 409 });
    const total = await t.prisma.labourWorkFact.aggregate({ where: { projectId, workerId }, _sum: { workedMinutes: true } });
    expect(total._sum.workedMinutes).toBe(400);
  });

  // ── §F bound 3 ────────────────────────────────────────────────────────────────────────────────

  it('§F BOUND 3: allocated ≤ committed per slice; a partial date-range commitment covers ONLY its own slice', async () => {
    const projectId = await freshProject();
    await enableLabour(projectId);
    const act = await freshActivity(projectId);
    const req = await labourRequirement(projectId, act, [
      { civilDate: '2026-08-10', personShiftQty: 2 },
      { civilDate: '2026-08-11', personShiftQty: 2 },
    ]);
    // the supplier commits capacity for the 10th ONLY (a partial date-range commitment)
    const { commitmentId } = await committedCapacity(projectId, req, '2026-08-10', 2);
    const [w1, w2, w3] = [await onboardWorker(projectId), await onboardWorker(projectId), await onboardWorker(projectId)];

    await capacity.allocate(projectId, { activityId: act, requirementId: req.requirementId, civilDate: '2026-08-10', workerId: w1, capacityCommitmentId: commitmentId }, pmc(projectId));
    await capacity.allocate(projectId, { activityId: act, requirementId: req.requirementId, civilDate: '2026-08-10', workerId: w2, capacityCommitmentId: commitmentId }, pmc(projectId));
    // the third person-shift over-draws the 2-person-shift commitment
    await expect(
      capacity.allocate(projectId, { activityId: act, requirementId: req.requirementId, civilDate: '2026-08-10', workerId: w3, capacityCommitmentId: commitmentId }, pmc(projectId)),
    ).rejects.toMatchObject({ status: 409 });

    // capacity committed for the 10th can NEVER be drawn for the 11th
    await expect(
      capacity.allocate(projectId, { activityId: act, requirementId: req.requirementId, civilDate: '2026-08-11', workerId: w3, capacityCommitmentId: commitmentId }, pmc(projectId)),
    ).rejects.toMatchObject({ status: 400 });
    // the 11th is still allocatable from OWN workforce (no commitment cited)
    const own = await capacity.allocate(projectId, { activityId: act, requirementId: req.requirementId, civilDate: '2026-08-11', workerId: w3 }, pmc(projectId));
    expect(own.allocations[0]!.capacityCommitmentId).toBeNull();

    // releasing a drawn allocation returns its person-shift to the commitment
    const drawn = await t.prisma.workerAllocation.findFirstOrThrow({ where: { projectId, workerId: w1, capacityCommitmentId: commitmentId } });
    await capacity.release(projectId, drawn.id, { reason: 'sick' }, pmc(projectId));
    const replacement = await capacity.allocate(projectId, { activityId: act, requirementId: req.requirementId, civilDate: '2026-08-10', workerId: w1, capacityCommitmentId: commitmentId }, pmc(projectId));
    expect(replacement.allocations[0]!.capacityCommitmentId).toBe(commitmentId);
  });

  it('§F BOUND 3 (RACE): two allocations racing the LAST committed person-shift admit EXACTLY one', async () => {
    const projectId = await freshProject();
    await enableLabour(projectId);
    const act = await freshActivity(projectId);
    const req = await labourRequirement(projectId, act, [{ civilDate: '2026-08-10', personShiftQty: 1 }]);
    const { commitmentId } = await committedCapacity(projectId, req, '2026-08-10', 1);
    const [w1, w2] = [await onboardWorker(projectId), await onboardWorker(projectId)];

    const [a, b] = await race(
      projectId,
      () => capacity.allocate(projectId, { activityId: act, requirementId: req.requirementId, civilDate: '2026-08-10', workerId: w1, capacityCommitmentId: commitmentId }, pmc(projectId)),
      () => capacity.allocate(projectId, { activityId: act, requirementId: req.requirementId, civilDate: '2026-08-10', workerId: w2, capacityCommitmentId: commitmentId }, pmc(projectId)),
    );
    expect(a!.status).toBe('fulfilled');
    expect(b!.status).toBe('rejected');
    expect((b as PromiseRejectedResult).reason).toMatchObject({ status: 409 });
    expect(await t.prisma.workerAllocation.count({ where: { projectId, capacityCommitmentId: commitmentId, status: 'active' } })).toBe(1);
  });

  it('§F BOUND 3 (DB SEAL): a hostile over-draw and a mis-sliced draw are both rejected by PostgreSQL', async () => {
    const projectId = await freshProject();
    await enableLabour(projectId);
    const act = await freshActivity(projectId);
    const req = await labourRequirement(projectId, act, [
      { civilDate: '2026-08-10', personShiftQty: 2 },
      { civilDate: '2026-08-11', personShiftQty: 2 },
    ]);
    const { commitmentId } = await committedCapacity(projectId, req, '2026-08-10', 2);
    const [w1, w2, w3] = [await onboardWorker(projectId), await onboardWorker(projectId), await onboardWorker(projectId)];
    await capacity.allocate(projectId, { activityId: act, requirementId: req.requirementId, civilDate: '2026-08-10', workerId: w1, capacityCommitmentId: commitmentId }, pmc(projectId));

    const template = await t.prisma.workerAllocation.findFirstOrThrow({ where: { projectId, workerId: w1 } });
    const forge = (id: string, workerId: string, civilDate: string) =>
      t.prisma.$executeRawUnsafe(
        `INSERT INTO "WorkerAllocation" ("id","projectId","workerId","civilDate","shift","activityId","requirementId","originRevision","labourSpecFingerprint","capacityCommitmentId","allocatedById","sourceCommandId")
         VALUES ($1,$2,$3,$4::date,$5,$6,$7,$8,$9,$10,$11,$12)`,
        id, projectId, workerId, civilDate, template.shift, template.activityId, template.requirementId,
        template.originRevision, template.labourSpecFingerprint, commitmentId, template.allocatedById, template.sourceCommandId,
      );
    // a draw on a date the commitment does not cover — the five-column FK makes it unrepresentable
    // (the commitment still has 1 of its 2 person-shifts free, so the bound is NOT what refuses it)
    await expect(forge('forged-misslice', w2, '2026-08-11')).rejects.toThrow(/foreign key|violates/i);
    // now exhaust the commitment legitimately; a third draw over-draws it and the §F bound-3
    // trigger refuses the hostile insert
    await capacity.allocate(projectId, { activityId: act, requirementId: req.requirementId, civilDate: '2026-08-10', workerId: w2, capacityCommitmentId: commitmentId }, pmc(projectId));
    await expect(forge('forged-overdraw', w3, '2026-08-10')).rejects.toThrow(/bound 3/i);
    expect(await t.prisma.workerAllocation.count({ where: { projectId } })).toBe(2);
  });

  // ── §B widening (approved skill substitution) ────────────────────────────────────────────────

  it('§B SUBSTITUTION: `from` is the requirement HEAD (server-derived); a revision strands the approval', async () => {
    const projectId = await freshProject();
    await enableLabour(projectId);
    const act = await freshActivity(projectId);
    const req = await labourRequirement(projectId, act, [{ civilDate: '2026-08-10', personShiftQty: 1 }]);
    const headSpec = await t.prisma.labourRequirementSpec.findFirstOrThrow({ where: { projectId, requirementId: req.requirementId }, orderBy: { revision: 'desc' } });

    const sub = await capacity.approveSkillSubstitution(
      projectId,
      { requirementId: req.requirementId, tradeCode: 'carpenter', skillCode: 'shuttering', shift: 'day', reason: 'no mason available' },
      pmc(projectId),
    );
    expect(sub.fromFingerprint).toBe(headSpec.labourSpecFingerprint);
    expect(sub.toFingerprint).not.toBe(sub.fromFingerprint);
    expect(sub.approvedById).toBe(f.memberUser.id);
    // the requirement's own identity is never a "substitution" of itself
    await expect(
      capacity.approveSkillSubstitution(projectId, { requirementId: req.requirementId, tradeCode: 'mason', skillCode: 'bar-bending', shift: 'day', reason: 'x' }, pmc(projectId)),
    ).rejects.toMatchObject({ status: 400 });
    // one ACTIVE authorization per (requirement, from, to)
    await expect(
      capacity.approveSkillSubstitution(projectId, { requirementId: req.requirementId, tradeCode: 'carpenter', skillCode: 'shuttering', shift: 'day', reason: 'again' }, pmc(projectId)),
    ).rejects.toMatchObject({ status: 409 });

    // REVISING the requirement to a different identity strands the approval: its frozen
    // `fromFingerprint` no longer equals the new head, so it authorizes nothing (the T6-F2 rule)
    await requirements.revise(
      projectId, req.requirementId,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { type: 'labour', activityId: act, tradeCode: 'mason', skillCode: 'shuttering', shift: 'day', demandSlices: [{ civilDate: '2026-08-10', personShiftQty: 1 }], decisionId: null, responsibleId: null, criticality: 'normal', tolerance: null, expectedRevision: req.revision } as any,
      pmc(projectId),
    );
    const newHead = await t.prisma.labourRequirementSpec.findFirstOrThrow({ where: { projectId, requirementId: req.requirementId }, orderBy: { revision: 'desc' } });
    expect(newHead.labourSpecFingerprint).not.toBe(sub.fromFingerprint);
    const stored = await t.prisma.approvedSkillSubstitution.findFirstOrThrow({ where: { projectId, id: sub.id } });
    expect(stored.fromFingerprint).toBe(headSpec.labourSpecFingerprint); // frozen, not re-pointed

    // revocation is a stamp; the row survives as history and the authorization is gone
    const revoked = await capacity.revokeSkillSubstitution(projectId, sub.id, { reason: 'masons available again' }, pmc(projectId));
    expect(revoked.revokeReason).toBe('masons available again');
    await expect(capacity.revokeSkillSubstitution(projectId, sub.id, { reason: 'again' }, pmc(projectId))).rejects.toMatchObject({ status: 409 });
    expect(await t.prisma.approvedSkillSubstitution.count({ where: { projectId } })).toBe(1);
  });

  // ── §H containment + §D inertness + §C rule ii ────────────────────────────────────────────────

  it('§H CONTAINMENT: a cross-project worker, activity or device reference is unrepresentable', async () => {
    const [pA, pB] = [await freshProject(), await freshProject()];
    await enableLabour(pA);
    await enableLabour(pB);
    const actA = await freshActivity(pA);
    const actB = await freshActivity(pB);
    const reqA = await labourRequirement(pA, actA, [{ civilDate: '2026-08-10', personShiftQty: 1 }]);
    const workerB = await onboardWorker(pB, 'foreign');

    // project A's requirement + project B's worker: refused before PostgreSQL is even asked
    await expect(
      capacity.allocate(pA, { activityId: actA, requirementId: reqA.requirementId, civilDate: '2026-08-10', workerId: workerB }, pmc(pA)),
    ).rejects.toMatchObject({ status: 400 });
    // project A's requirement + project B's activity: likewise
    const workerA = await onboardWorker(pA, 'own');
    await expect(
      capacity.allocate(pA, { activityId: actB, requirementId: reqA.requirementId, civilDate: '2026-08-10', workerId: workerA }, pmc(pA)),
    ).rejects.toMatchObject({ status: 400 });

    // and a DIRECT forgery is rejected by the same-project composite FKs. The template is a REAL
    // project-A allocation, so every other column is legitimate and ONLY the foreign worker is wrong.
    await capacity.allocate(pA, { activityId: actA, requirementId: reqA.requirementId, civilDate: '2026-08-10', workerId: workerA }, pmc(pA));
    const template = await t.prisma.workerAllocation.findFirstOrThrow({ where: { projectId: pA, workerId: workerA } });
    await expect(
      t.prisma.$executeRawUnsafe(
        `INSERT INTO "WorkerAllocation" ("id","projectId","workerId","civilDate","shift","activityId","requirementId","originRevision","labourSpecFingerprint","allocatedById","sourceCommandId")
         VALUES ('forged-xproj',$1,$2,DATE '2026-08-10',$3,$4,$5,$6,$7,$8,$9)`,
        pA, workerB, template.shift, template.activityId, template.requirementId,
        template.originRevision, template.labourSpecFingerprint, template.allocatedById, template.sourceCommandId,
      ),
    ).rejects.toThrow(/absent from its project|foreign key|violates/i);
    expect(await t.prisma.workerAllocation.count({ where: { projectId: pA } })).toBe(1);

    // a device in project B can never evidence a muster in project A
    const deviceB = await t.prisma.workerDevice.create({ data: { projectId: pB, token: `tok-${seq++}`, workerId: workerB } });
    await expect(
      capacity.recordAttendance(pA, { workerId: workerA, civilDate: '2026-08-10', shift: 'day', deviceId: deviceB.id }, pmc(pA)),
    ).rejects.toThrow(/absent from its project|foreign key/i);
  });

  it('§D INERTNESS + §C rule ii: every §C surface 404s off-pilot, and a keyed replay appends NOTHING', async () => {
    const offPilot = await freshProject();
    const act = await freshActivity(offPilot);
    // §D — no labour capability: every §C command AND the register read are absent (404)
    for (const call of [
      () => capacity.allocate(offPilot, { activityId: act, requirementId: 'x', civilDate: '2026-08-10', workerId: 'w' }, pmc(offPilot)),
      () => capacity.release(offPilot, 'a', { reason: 'r' }, pmc(offPilot)),
      () => capacity.recordAttendance(offPilot, { workerId: 'w', civilDate: '2026-08-10', shift: 'day', deviceId: 'd' }, pmc(offPilot)),
      () => capacity.revokeAttendance(offPilot, 'a', { reason: 'r' }, pmc(offPilot)),
      () => capacity.recordWork(offPilot, { allocationId: 'a', workedMinutes: 60 }, pmc(offPilot)),
      () => capacity.approveSkillSubstitution(offPilot, { requirementId: 'r', tradeCode: 'mason', shift: 'day', reason: 'x' }, pmc(offPilot)),
      () => capacity.revokeSkillSubstitution(offPilot, 's', { reason: 'r' }, pmc(offPilot)),
      () => capacity.capacity(offPilot, pmc(offPilot)),
      () => devices.bind(offPilot, 'd', { workerId: 'w' }, pmc(offPilot)),
    ]) {
      await expect(call()).rejects.toMatchObject({ status: 404 });
    }
    expect(await t.prisma.workerAllocation.count({ where: { projectId: offPilot } })).toBe(0);

    // §C rule ii — a keyed replay is absorbed by the command ledger and appends no second fact
    const projectId = await freshProject();
    await enableLabour(projectId);
    const activityId = await freshActivity(projectId);
    const req = await labourRequirement(projectId, activityId, [{ civilDate: '2026-08-10', personShiftQty: 1 }]);
    const workerId = await onboardWorker(projectId);
    const key = `it-p4c-key-${seq++}`;
    const input = { activityId, requirementId: req.requirementId, civilDate: '2026-08-10', workerId };
    const first = await capacity.allocate(projectId, input, pmc(projectId), key);
    const replay = await capacity.allocate(projectId, input, pmc(projectId), key);
    expect(replay.allocations[0]!.id).toBe(first.allocations[0]!.id);
    expect(await t.prisma.workerAllocation.count({ where: { projectId } })).toBe(1);
    expect(await t.prisma.domainEvent.count({ where: { projectId, eventType: 'allocation.made' } })).toBe(1);
    // every fact records the command that produced it (§C rule ii)
    const row = await t.prisma.workerAllocation.findFirstOrThrow({ where: { projectId } });
    expect(row.sourceCommandId).toBeTruthy();
    expect(await t.prisma.commandExecution.count({ where: { projectId, id: row.sourceCommandId } })).toBe(1);
  });

  it('labour.capacity READ: the §C register serves the facts for a civil-date window (pmc/engineer)', async () => {
    const projectId = await freshProject();
    await enableLabour(projectId);
    const act = await freshActivity(projectId);
    const req = await labourRequirement(projectId, act, [
      { civilDate: '2026-08-10', personShiftQty: 1 },
      { civilDate: '2026-08-12', personShiftQty: 1 },
    ]);
    const workerId = await onboardWorker(projectId);
    const a1 = await capacity.allocate(projectId, { activityId: act, requirementId: req.requirementId, civilDate: '2026-08-10', workerId }, pmc(projectId));
    await capacity.allocate(projectId, { activityId: act, requirementId: req.requirementId, civilDate: '2026-08-12', workerId }, pmc(projectId));
    const device = await t.prisma.workerDevice.create({ data: { projectId, token: `tok-${Date.now()}-${seq++}` } });
    await devices.bind(projectId, device.id, { workerId }, pmc(projectId));
    await capacity.recordAttendance(projectId, { workerId, civilDate: '2026-08-10', shift: 'day', deviceId: device.id }, pmc(projectId));
    await capacity.recordWork(projectId, { allocationId: a1.allocations[0]!.id, workedMinutes: 480 }, pmc(projectId));

    const all = await capacity.capacity(projectId, pmc(projectId));
    expect(all.allocations).toHaveLength(2);
    expect(all.attendance).toHaveLength(1);
    expect(all.workFacts).toHaveLength(1);
    // the window filters by civil date
    const windowed = await capacity.capacity(projectId, pmc(projectId), '2026-08-11', '2026-08-13');
    expect(windowed.allocations).toHaveLength(1);
    expect(windowed.allocations[0]!.civilDate).toBe('2026-08-12');
    expect(windowed.attendance).toHaveLength(0);
    // the register is not a client surface
    await expect(capacity.capacity(projectId, { ...pmc(projectId), role: 'client' } as AuthUser)).rejects.toMatchObject({ status: 403 });
  });
});
