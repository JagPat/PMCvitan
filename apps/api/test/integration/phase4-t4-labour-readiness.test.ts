import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { createTestApp, type TestApp } from './test-app';
import { createTwoProjectFixture, type TwoProjectFixture } from './fixtures';
import { ActivitiesService } from '../../src/activities/activities.service';
import { RequirementsService } from '../../src/activities/requirements.service';
import { LabourService } from '../../src/labour/labour.service';
import { LabourProcurementService } from '../../src/labour/labour-procurement.service';
import { LabourCapacityService } from '../../src/labour/labour-capacity.service';
import { LabourCoverageService } from '../../src/labour/labour-coverage.service';
import { LabourRequirementQuery } from '../../src/labour/labour.query';
import { loadLabourCoverageRequirements } from '../../src/activities/labour-coverage-requirements';
import { deriveTeamReading } from '../../src/labour/team-readiness';
import { computeLabourReadinessDto, LABOUR_READINESS_PROJECTION } from '../../src/labour/labour-readiness.projection';
import { VendorsService } from '../../src/procurement/vendors.service';
import { CapabilitiesService, LABOUR_CAPABILITY } from '../../src/platform/capabilities.service';
import { OutboxRelay } from '../../src/platform/outbox/relay.service';
import { ProjectionRebuilder } from '../../src/platform/projections/rebuilder.service';
import { ProjectionRebuildOperations } from '../../src/platform/projections/rebuild-operations';
import { readServableGeneration } from '../../src/platform/projections/generation';
import { lockProjectReadiness } from '../../src/common/readiness-lock';
import { SystemClock } from '../../src/common/clock';
import { addCivilDays } from '../../src/common/civil-date';
import type { AuthUser } from '../../src/common/auth';
import type { LabourReadinessDto } from '@vitan/shared';

/**
 * Phase 4 Task 4 — canonical labour coverage + the derived Team gate + combined readiness + the
 * SEVENTH projection (§A/§G), proven live against PostgreSQL, reproduce-first.
 *
 * Covered (the plan's required Task-4 probes):
 *   §A EXECUTION rows — before-window `wait` (start refused), overdue-unfulfilled `fail`, a
 *      worked past window satisfied (an empty due-today set never yields a vacuous ok),
 *      under-allocated `fail`, allocated-not-present `wait` (muster pending), present `ok` → start
 *   §A FORECAST vs EXECUTION — allocation alone is forecast-`ready` but execution-`wait`
 *   §A forecast `at-risk` dated at the covering commitment; a default returns it to `blocked`
 *   §A gate replacement — the stored team flag is NOT writable on a labour-pilot project
 *      (update/create rejected) and NOT read (a hostile stored 'ok' cannot start an
 *      under-allocated activity); off-pilot it stays the byte-identical stored stub
 *   §C carry-forward — responsible-only revision preserves the allocation; a trade revision
 *      strands it; a headcount increase preserves existing coverage but surfaces the shortfall
 *   §B substitution — an ACTIVE approval re-satisfies a stranded allocation; revocation ends it
 *   Combined worst-gate — material-ok/labour-fail refuses naming team, labour-ok/material-fail
 *      refuses naming material
 *   §A races (deterministic barrier, BOTH orderings) — release vs start, attendance vs start,
 *      requirement-revision vs start; plus cross-gate serialization on the ONE project lock
 *   §G projection — live == projection == rebuild; a rebuild emits ZERO events + notifications;
 *      projection lag never changes a start verdict; the read-model fold is payload-sourced
 *      (created/revised/cancelled reflected without any Activities persistence read)
 */
describe('Phase 4 Task 4 — §A labour readiness (live PG)', () => {
  let t: TestApp;
  let f: TwoProjectFixture;
  let activities: ActivitiesService;
  let requirements: RequirementsService;
  let labour: LabourService;
  let commercial: LabourProcurementService;
  let capacity: LabourCapacityService;
  let coverage: LabourCoverageService;
  let labourQuery: LabourRequirementQuery;
  let vendors: VendorsService;
  let capabilities: CapabilitiesService;
  let relay: OutboxRelay;
  let ops: ProjectionRebuildOperations;
  let seq = 0;

  const today = new SystemClock().today('Asia/Kolkata');
  const day = (offset: number): string => addCivilDays(today, offset);

  const TRUNCATE =
    'TRUNCATE TABLE "DomainEvent", "OutboxDelivery", "ProcessedEvent", "ProjectionCursor", "ProjectionGeneration", "DecisionProjection", "DailyLogProjection", "DrawingsProjection", "InspectionsProjection", "ActivitiesProjection", "MaterialReadinessProjection", "LabourReadinessProjection", "LabourWorkFact", "WorkerAllocation", "LabourAttendance", "ApprovedSkillSubstitution", "CapacityPromise", "CapacityCommitment", "LabourPurchaseOrderLine", "LabourPurchaseOrderVersion", "LabourPurchaseOrder", "SupplierLabourQuoteLine", "SupplierLabourQuote", "LabourQuoteComparison", "LabourRfq", "LabourRequisitionLine", "LabourRequisition", "VendorLabourProfile", "ProjectVendor", "CommandExecution", "CrewMembership", "Crew", "WorkerDevice", "WorkerSkill", "Worker", "LabourDemandSlice", "LabourRequirementSpec", "LabourTrade", "LabourSkill", "MaterialRequirementSpec", "ActivityRequirement", "ActivityRequirementRoot", "DecisionApprovalRevision", "ProjectCapability" CASCADE';

  const pmc = (projectId: string): AuthUser => ({ sub: f.memberUser.id, role: 'pmc', projectId }) as AuthUser;
  const orgAdmin = (): AuthUser => ({ sub: f.ownerUser.id, role: 'pmc', projectId: '' }) as AuthUser;

  beforeAll(async () => {
    t = await createTestApp();
    f = await createTwoProjectFixture(t.prisma);
    activities = t.app.get(ActivitiesService);
    requirements = t.app.get(RequirementsService);
    labour = t.app.get(LabourService);
    commercial = t.app.get(LabourProcurementService);
    capacity = t.app.get(LabourCapacityService);
    coverage = t.app.get(LabourCoverageService);
    labourQuery = t.app.get(LabourRequirementQuery);
    vendors = t.app.get(VendorsService);
    capabilities = t.app.get(CapabilitiesService);
    relay = t.app.get(OutboxRelay);
    ops = new ProjectionRebuildOperations(t.prisma, t.app.get(ProjectionRebuilder));
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
      ['auditLog', { projectId: { startsWith: 'it-p4t4-' } }],
      ['activity', { projectId: { startsWith: 'it-p4t4-' } }],
      ['membership', { projectId: { startsWith: 'it-p4t4-' } }],
      ['project', { id: { startsWith: 'it-p4t4-' } }],
    ] as const) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (t.prisma as any)[model].deleteMany({ where });
    }
  });

  // ── fixtures (the Task-3 harness, re-homed on it-p4t4-) ──────────────────────────────────────

  const freshProject = async (): Promise<string> => {
    const id = `it-p4t4-${Date.now() % 1e6}-${seq++}`;
    await t.prisma.project.create({
      data: { id, orgId: f.orgA.id, name: id, short: 'P', descriptor: '', stage: 'x', siteCode: 'P', projStart: 'a', projEnd: 'b', elapsedPct: 0, todayDay: 0, milestonePct: 0, timeZone: 'Asia/Kolkata', scheduleStartDate: new Date('2026-06-01T00:00:00.000Z') },
    });
    await t.prisma.membership.create({ data: { projectId: id, userId: f.memberUser.id, role: 'pmc', status: 'active' } });
    return id;
  };
  const freshActivity = async (projectId: string): Promise<string> => {
    const id = `IT-P4T4-ACT-${Date.now() % 1e6}-${seq++}`;
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
  const labourRequirement = async (
    projectId: string, activityId: string,
    slices: Array<{ civilDate: string; personShiftQty: number }>,
    spec: { tradeCode?: string; skillCode?: string | null; shift?: 'day' | 'night'; responsibleId?: string | null } = {},
  ): Promise<{ requirementId: string; revision: number }> => {
    const r = await requirements.create(
      projectId,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { type: 'labour', activityId, tradeCode: spec.tradeCode ?? 'mason', skillCode: spec.skillCode === undefined ? 'bar-bending' : spec.skillCode, shift: spec.shift ?? 'day', demandSlices: slices, decisionId: null, responsibleId: spec.responsibleId ?? null, criticality: 'normal', tolerance: null } as any,
      pmc(projectId),
    );
    return { requirementId: r.requirementId, revision: r.revision };
  };
  const reviseLabour = async (
    projectId: string, req: { requirementId: string; revision: number },
    activityId: string,
    slices: Array<{ civilDate: string; personShiftQty: number }>,
    spec: { tradeCode?: string; skillCode?: string | null; shift?: 'day' | 'night'; responsibleId?: string | null } = {},
  ): Promise<{ requirementId: string; revision: number }> => {
    const r = await requirements.revise(
      projectId, req.requirementId,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { type: 'labour', activityId, tradeCode: spec.tradeCode ?? 'mason', skillCode: spec.skillCode === undefined ? 'bar-bending' : spec.skillCode, shift: spec.shift ?? 'day', demandSlices: slices, decisionId: null, responsibleId: spec.responsibleId ?? null, criticality: 'normal', tolerance: null, expectedRevision: req.revision } as any,
      pmc(projectId),
    );
    return { requirementId: r.requirementId, revision: r.revision };
  };
  const onboardWorker = async (projectId: string, name = `W${seq++}`): Promise<string> => {
    const w = await labour.onboardWorker(projectId, { name, tradeCode: 'mason', skillCodes: ['bar-bending'], activeFrom: '2026-01-01', activeTo: null }, pmc(projectId));
    return w.id;
  };
  const allocate = (projectId: string, activityId: string, requirementId: string, civilDate: string, workerId: string) =>
    capacity.allocate(projectId, { activityId, requirementId, civilDate, workerId }, pmc(projectId));
  const muster = (projectId: string, workerId: string, civilDate: string) =>
    capacity.recordAttendance(projectId, { workerId, civilDate, shift: 'day', manualReason: 'roll call — Task-4 probe' }, pmc(projectId));

  /** the §A EXECUTION Team reading for one activity — the SAME authority `activities.start` reads */
  const teamOf = (projectId: string, activityId: string, asOf = today) =>
    t.prisma.$transaction((tx) => activities.teamReading(tx, projectId, { id: activityId }, asOf));
  /** the §A FORECAST rows for one activity's requirements (presence never consulted) */
  const forecastOf = async (projectId: string, activityId: string) =>
    t.prisma.$transaction(async (tx) => {
      const reqs = await loadLabourCoverageRequirements(tx, projectId, labourQuery, [activityId]);
      return coverage.forecastFor(tx, projectId, reqs);
    });

  /** an ISSUED labour PO line + its CapacityCommitment for ONE (civilDate, qty) slice (Task-2 chain) */
  const committedCapacity = async (
    projectId: string, req: { requirementId: string; revision: number }, civilDate: string, qty: number,
  ): Promise<{ commitmentId: string }> => {
    const vendor = await vendors.create(f.orgA.id, { name: `Supplier ${seq++}` }, orgAdmin());
    await vendors.bind(projectId, { vendorId: vendor.id }, pmc(projectId));
    const requisition = await commercial.createRequisition(projectId, { title: `req ${seq++}`, lines: [{ requirementId: req.requirementId, revision: req.revision, civilDate, personShiftQty: qty }] }, pmc(projectId));
    const line = requisition.lines[0]!;
    await commercial.submitRequisition(projectId, requisition.id, pmc(projectId));
    await commercial.approveRequisition(projectId, requisition.id, pmc(projectId));
    const rfq = await commercial.createRfq(projectId, { requisitionId: requisition.id }, pmc(projectId));
    await commercial.recordQuote(projectId, rfq.id, { vendorId: vendor.id, validUntil: '2027-12-31', lines: [{ requisitionLineId: line.id, ratePerPersonShift: '1000', shiftPremium: '0', landedPerPersonShift: '1000', matchesSpecification: true }] }, pmc(projectId));
    await commercial.createComparison(projectId, rfq.id, pmc(projectId));
    const quoteId = (await commercial.readRfq(projectId, rfq.id, pmc(projectId))).quotes[0]!.id;
    await commercial.approveComparison(projectId, rfq.id, { selectedQuoteId: quoteId, reason: 'single in-spec quote' }, pmc(projectId));
    const comparisonId = (await commercial.readRfq(projectId, rfq.id, pmc(projectId))).comparison!.id;
    const po = await commercial.createPo(projectId, { comparisonId, lines: [{ requisitionLineId: line.id, personShiftQty: qty }] }, pmc(projectId));
    const poLine = po.currentVersion.lines[0]!;
    await commercial.issuePo(projectId, po.id, pmc(projectId));
    const commitment = await commercial.commitCapacity(projectId, { poLineId: poLine.id, promisedDate: civilDate }, pmc(projectId));
    return { commitmentId: commitment.id };
  };

  // ── deterministic race barrier (the Phase-3/T3 pattern) ──────────────────────────────────────
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

  // ── §D capability-off byte identity ───────────────────────────────────────────────────────────

  it('§D OFF-PILOT: the stored team flag stays the writable stub that drives start; the readiness read 404s', async () => {
    const projectId = await freshProject();
    const act = await freshActivity(projectId);
    // the stored stub is writable and drives readiness exactly as before Phase 4
    await activities.update(projectId, act, { gateTeam: 'wait' } as never, pmc(projectId));
    await expect(activities.start(projectId, act, pmc(projectId))).rejects.toMatchObject({ status: 409 });
    await activities.update(projectId, act, { gateTeam: 'ok' } as never, pmc(projectId));
    await activities.start(projectId, act, pmc(projectId));
    expect((await t.prisma.activity.findUniqueOrThrow({ where: { id: act } })).status).toBe('in_progress');
    // no labour capability → the labour readiness read does not exist for this project
    await expect(capacity.readiness(projectId, pmc(projectId))).rejects.toMatchObject({ status: 404 });
  });

  it('§A GATE REPLACEMENT: on a labour-pilot project the stored team flag is neither writable nor read', async () => {
    const projectId = await freshProject();
    await enableLabour(projectId);
    const act = await freshActivity(projectId);
    // mutation rejected — update and explicit non-default create
    await expect(activities.update(projectId, act, { gateTeam: 'ok' } as never, pmc(projectId))).rejects.toMatchObject({ status: 409 });
    await expect(
      activities.create(projectId, { name: 'seeded', zone: 'Z', plannedStart: 0, plannedEnd: 5, gateMaterial: 'na', gateTeam: 'ok' } as never, pmc(projectId)),
    ).rejects.toMatchObject({ status: 409 });
    // NOT READ: a hostile stored 'ok' (written beneath the service) cannot start an
    // under-allocated activity — the Team gate derives entirely from canonical labour facts
    await labourRequirement(projectId, act, [{ civilDate: today, personShiftQty: 1 }]);
    await t.prisma.activity.update({ where: { id: act }, data: { gateTeam: 'ok' } });
    await expect(activities.start(projectId, act, pmc(projectId))).rejects.toMatchObject({ status: 409 });
    const team = await teamOf(projectId, act);
    expect(team.v).toBe('fail');
    expect(team.source).toBe('derived');
  });

  // ── §A execution rows ─────────────────────────────────────────────────────────────────────────

  it('§A ROW 3 (before-window): a labour window that has not begun is wait — start refused, never vacuously ok', async () => {
    const projectId = await freshProject();
    await enableLabour(projectId);
    const act = await freshActivity(projectId);
    await labourRequirement(projectId, act, [{ civilDate: day(2), personShiftQty: 1 }, { civilDate: day(3), personShiftQty: 1 }]);
    const team = await teamOf(projectId, act);
    expect(team.v).toBe('wait');
    expect(team.reason).toContain('window has not begun');
    await expect(activities.start(projectId, act, pmc(projectId))).rejects.toMatchObject({ status: 409 });
  });

  it('§A ROW 4 (overdue): an unfulfilled past slice is fail; a WORKED past window is genuinely satisfied (ok)', async () => {
    const projectId = await freshProject();
    await enableLabour(projectId);
    const act = await freshActivity(projectId);
    // demand YESTERDAY only — an empty due-today set with an unfulfilled past slice must be fail
    const req = await labourRequirement(projectId, act, [{ civilDate: day(-1), personShiftQty: 1 }]);
    expect((await teamOf(projectId, act)).v).toBe('fail');
    expect((await teamOf(projectId, act)).reason).toContain('Overdue');
    await expect(activities.start(projectId, act, pmc(projectId))).rejects.toMatchObject({ status: 409 });

    // work the past slice: allocate yesterday + record the effort → the window is satisfied and
    // today's empty due-today set reaches ok NON-vacuously (rows 3–4 declined to fire)
    const w = await onboardWorker(projectId);
    const alloc = (await allocate(projectId, act, req.requirementId, day(-1), w)).allocations[0]!;
    await capacity.recordWork(projectId, { allocationId: alloc.id, workedMinutes: 480 }, pmc(projectId));
    const team = await teamOf(projectId, act);
    expect(team.v).toBe('ok');
    await activities.start(projectId, act, pmc(projectId));
  });

  it('§A ROWS 5–7 (due today): under-allocated fail → allocated-not-present wait → present ok → start allowed', async () => {
    const projectId = await freshProject();
    await enableLabour(projectId);
    const act = await freshActivity(projectId);
    const req = await labourRequirement(projectId, act, [{ civilDate: today, personShiftQty: 2 }]);
    // row 7 — nothing allocated
    expect((await teamOf(projectId, act)).v).toBe('fail');
    // row 6 — fully allocated, no muster yet
    const [w1, w2] = [await onboardWorker(projectId), await onboardWorker(projectId)];
    await allocate(projectId, act, req.requirementId, today, w1);
    await allocate(projectId, act, req.requirementId, today, w2);
    const waitTeam = await teamOf(projectId, act);
    expect(waitTeam.v).toBe('wait');
    expect(waitTeam.reason).toContain('muster pending');
    await expect(activities.start(projectId, act, pmc(projectId))).rejects.toMatchObject({ status: 409 });
    // partial muster is still row 6 (1 of 2 present)
    await muster(projectId, w1, today);
    expect((await teamOf(projectId, act)).v).toBe('wait');
    // row 5 — allocated AND present → ok, and the combined five-gate start goes through
    await muster(projectId, w2, today);
    expect((await teamOf(projectId, act)).v).toBe('ok');
    await activities.start(projectId, act, pmc(projectId));
    expect((await t.prisma.activity.findUniqueOrThrow({ where: { id: act } })).status).toBe('in_progress');
  });

  // ── §A forecast vs execution ──────────────────────────────────────────────────────────────────

  it('§A FORECAST vs EXECUTION: allocation alone is forecast-ready but execution-wait (presence is the only difference)', async () => {
    const projectId = await freshProject();
    await enableLabour(projectId);
    const act = await freshActivity(projectId);
    const req = await labourRequirement(projectId, act, [{ civilDate: today, personShiftQty: 1 }]);
    const w = await onboardWorker(projectId);
    await allocate(projectId, act, req.requirementId, today, w);
    expect((await teamOf(projectId, act)).v).toBe('wait');
    const [fc] = await forecastOf(projectId, act);
    expect(fc!.verdict).toBe('ready');
    // the labour.readiness read serves the same forecast truth
    const dto = await capacity.readiness(projectId, pmc(projectId));
    expect(dto.forecast[act]?.verdict).toBe('ready');
  });

  it('§A FORECAST: an uncovered future slice is blocked; a live commitment for THAT slice makes it at-risk dated at the promise; a default returns it to blocked', async () => {
    const projectId = await freshProject();
    await enableLabour(projectId);
    const act = await freshActivity(projectId);
    const futureDate = day(5);
    const req = await labourRequirement(projectId, act, [{ civilDate: futureDate, personShiftQty: 2 }]);
    expect((await forecastOf(projectId, act))[0]!.verdict).toBe('blocked');

    const { commitmentId } = await committedCapacity(projectId, req, futureDate, 2);
    const atRisk = (await forecastOf(projectId, act))[0]!;
    expect(atRisk.verdict).toBe('at-risk');
    expect(atRisk.coveringDate).toBe(futureDate);
    expect((await capacity.readiness(projectId, pmc(projectId))).forecast[act]).toMatchObject({ verdict: 'at-risk', coveringDate: futureDate });

    await commercial.defaultCapacity(projectId, commitmentId, pmc(projectId));
    expect((await forecastOf(projectId, act))[0]!.verdict).toBe('blocked');
  });

  // ── §C compatible-revision carry-forward (three probes) ──────────────────────────────────────

  it('§C CARRY-FORWARD: responsible-only revision preserves; a trade revision strands; a headcount increase preserves + shortfall', async () => {
    const projectId = await freshProject();
    await enableLabour(projectId);
    const act = await freshActivity(projectId);
    let req = await labourRequirement(projectId, act, [{ civilDate: today, personShiftQty: 1 }]);
    const w = await onboardWorker(projectId);
    await allocate(projectId, act, req.requirementId, today, w);
    await muster(projectId, w, today);
    expect((await teamOf(projectId, act)).v).toBe('ok');

    // (a) responsible-only revision — the fingerprint is over (trade, skill, shift) only, so the
    // head fingerprint is unchanged and the rev-1 allocation still satisfies the new head
    req = await reviseLabour(projectId, req, act, [{ civilDate: today, personShiftQty: 1 }], { responsibleId: f.memberUser.id });
    expect((await teamOf(projectId, act)).v).toBe('ok');

    // (c) headcount increase — same identity, larger quantity: the existing allocation is
    // PRESERVED as coverage (1 counted) and the added quantity surfaces as a shortfall
    req = await reviseLabour(projectId, req, act, [{ civilDate: today, personShiftQty: 2 }], { responsibleId: f.memberUser.id });
    const short = await teamOf(projectId, act);
    expect(short.v).toBe('fail');
    expect(short.reason).toContain('1 of 2');

    // (b) trade revision — the head fingerprint changes, the still-active allocation is STRANDED
    req = await reviseLabour(projectId, req, act, [{ civilDate: today, personShiftQty: 1 }], { tradeCode: 'carpenter', skillCode: 'shuttering' });
    const stranded = await teamOf(projectId, act);
    expect(stranded.v).toBe('fail');
    expect(stranded.reason).toContain('0 of 1');
    // the stale active allocation still holds the worker's capacity until explicitly released
    expect(await t.prisma.workerAllocation.count({ where: { projectId, status: 'active' } })).toBe(1);
  });

  it('§B SUBSTITUTION: an ACTIVE approval re-satisfies a stranded allocation; revocation ends it', async () => {
    const projectId = await freshProject();
    await enableLabour(projectId);
    const act = await freshActivity(projectId);
    let req = await labourRequirement(projectId, act, [{ civilDate: today, personShiftQty: 1 }]);
    const w = await onboardWorker(projectId);
    await allocate(projectId, act, req.requirementId, today, w);
    await muster(projectId, w, today);
    // revise to carpenter — the mason allocation (old fingerprint) is stranded
    req = await reviseLabour(projectId, req, act, [{ civilDate: today, personShiftQty: 1 }], { tradeCode: 'carpenter', skillCode: 'shuttering' });
    expect((await teamOf(projectId, act)).v).toBe('fail');
    // pmc approves substituting the OLD identity for the new head → the allocation satisfies again
    const sub = await capacity.approveSkillSubstitution(projectId, { requirementId: req.requirementId, tradeCode: 'mason', skillCode: 'bar-bending', shift: 'day', reason: 'masons may stand in' }, pmc(projectId));
    expect((await teamOf(projectId, act)).v).toBe('ok');
    await capacity.revokeSkillSubstitution(projectId, sub.id, { reason: 'carpenters arrived' }, pmc(projectId));
    expect((await teamOf(projectId, act)).v).toBe('fail');
  });

  // ── combined worst-gate composition ───────────────────────────────────────────────────────────

  it('§A COMBINED: material-ok with labour-blocked refuses naming team; labour-ok with material-fail refuses naming material', async () => {
    const projectId = await freshProject();
    await enableLabour(projectId);
    const act = await freshActivity(projectId);
    const req = await labourRequirement(projectId, act, [{ civilDate: today, personShiftQty: 1 }]);
    // material ok (the legacy stored flag — materials capability off), labour under-allocated
    await t.prisma.activity.update({ where: { id: act }, data: { gateMaterial: 'ok' } });
    await expect(activities.start(projectId, act, pmc(projectId))).rejects.toThrow(/team:/);
    // labour ok, material fail — the refusal names material
    const w = await onboardWorker(projectId);
    await allocate(projectId, act, req.requirementId, today, w);
    await muster(projectId, w, today);
    await t.prisma.activity.update({ where: { id: act }, data: { gateMaterial: 'fail' } });
    await expect(activities.start(projectId, act, pmc(projectId))).rejects.toThrow(/material:/);
    // both ok → allowed
    await t.prisma.activity.update({ where: { id: act }, data: { gateMaterial: 'ok' } });
    await activities.start(projectId, act, pmc(projectId));
  });

  // ── §A races (both orderings under the ONE project readiness lock) ───────────────────────────

  it('§A RACE allocation-release vs start (both orderings): the loser observes the winner', async () => {
    for (const releaseFirst of [true, false]) {
      const projectId = await freshProject();
      await enableLabour(projectId);
      const act = await freshActivity(projectId);
      const req = await labourRequirement(projectId, act, [{ civilDate: today, personShiftQty: 1 }]);
      const w = await onboardWorker(projectId);
      const alloc = (await allocate(projectId, act, req.requirementId, today, w)).allocations[0]!;
      await muster(projectId, w, today);

      const releaseCmd = () => capacity.release(projectId, alloc.id, { reason: 'race probe' }, pmc(projectId));
      const startCmd = () => activities.start(projectId, act, pmc(projectId));
      const [a, b] = releaseFirst
        ? await race(projectId, releaseCmd, startCmd)
        : await race(projectId, startCmd, releaseCmd);
      if (releaseFirst) {
        // release landed strictly before → start observes the freed slice and refuses
        expect(a!.status).toBe('fulfilled');
        expect(b!.status).toBe('rejected');
        expect((await t.prisma.activity.findUniqueOrThrow({ where: { id: act } })).status).toBe('not_started');
      } else {
        // start landed strictly before → it saw allocated+present; the release lands after
        expect(a!.status).toBe('fulfilled');
        expect(b!.status).toBe('fulfilled');
        expect((await t.prisma.activity.findUniqueOrThrow({ where: { id: act } })).status).toBe('in_progress');
      }
    }
  });

  it('§A RACE attendance-record vs start (both orderings): presence lands strictly before or strictly after', async () => {
    for (const musterFirst of [true, false]) {
      const projectId = await freshProject();
      await enableLabour(projectId);
      const act = await freshActivity(projectId);
      const req = await labourRequirement(projectId, act, [{ civilDate: today, personShiftQty: 1 }]);
      const w = await onboardWorker(projectId);
      await allocate(projectId, act, req.requirementId, today, w);

      const musterCmd = () => muster(projectId, w, today);
      const startCmd = () => activities.start(projectId, act, pmc(projectId));
      const [a, b] = musterFirst
        ? await race(projectId, musterCmd, startCmd)
        : await race(projectId, startCmd, musterCmd);
      if (musterFirst) {
        expect(a!.status).toBe('fulfilled');
        expect(b!.status).toBe('fulfilled'); // start observed the committed muster
        expect((await t.prisma.activity.findUniqueOrThrow({ where: { id: act } })).status).toBe('in_progress');
      } else {
        expect(a!.status).toBe('rejected'); // start first — muster pending at its snapshot
        expect(b!.status).toBe('fulfilled');
        expect((await t.prisma.activity.findUniqueOrThrow({ where: { id: act } })).status).toBe('not_started');
      }
    }
  });

  it('§A RACE requirement-revision vs start (both orderings): a strand-revision refuses the later start', async () => {
    for (const reviseFirst of [true, false]) {
      const projectId = await freshProject();
      await enableLabour(projectId);
      const act = await freshActivity(projectId);
      const req = await labourRequirement(projectId, act, [{ civilDate: today, personShiftQty: 1 }]);
      const w = await onboardWorker(projectId);
      await allocate(projectId, act, req.requirementId, today, w);
      await muster(projectId, w, today);

      const reviseCmd = () => reviseLabour(projectId, req, act, [{ civilDate: today, personShiftQty: 1 }], { tradeCode: 'carpenter', skillCode: 'shuttering' });
      const startCmd = () => activities.start(projectId, act, pmc(projectId));
      const [a, b] = reviseFirst
        ? await race(projectId, reviseCmd, startCmd)
        : await race(projectId, startCmd, reviseCmd);
      if (reviseFirst) {
        expect(a!.status).toBe('fulfilled');
        expect(b!.status).toBe('rejected'); // the head changed strictly before — the allocation is stranded
        expect((await t.prisma.activity.findUniqueOrThrow({ where: { id: act } })).status).toBe('not_started');
      } else {
        expect(a!.status).toBe('fulfilled'); // start observed the old satisfied head strictly before
        expect(b!.status).toBe('fulfilled');
        expect((await t.prisma.activity.findUniqueOrThrow({ where: { id: act } })).status).toBe('in_progress');
      }
    }
  });

  it('§A CROSS-GATE: a material-side command and a labour allocation serialize on the ONE project readiness lock', async () => {
    const projectId = await freshProject();
    await enableLabour(projectId);
    await capabilities.enable(projectId, 'materials', f.memberUser.id);
    const act = await freshActivity(projectId);
    const req = await labourRequirement(projectId, act, [{ civilDate: today, personShiftQty: 1 }]);
    const w = await onboardWorker(projectId);

    // both commands park in the SAME advisory-lock wait queue and complete in enqueue order —
    // material and labour writes on one project serialize on one lock (§A), so `start` can never
    // observe a torn cross-gate snapshot
    const materialCmd = () =>
      requirements.create(
        projectId,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        { activityId: act, materialCategory: 'Cement', make: 'UltraTech', grade: 'OPC 53', attributes: 'grey', baseUom: 'bag', qty: '10', requiredBy: day(5), decisionId: null, responsibleId: null, criticality: 'normal', tolerance: null } as any,
        pmc(projectId),
      );
    const labourCmd = () => allocate(projectId, act, req.requirementId, today, w);
    const [a, b] = await race(projectId, materialCmd, labourCmd);
    expect(a!.status).toBe('fulfilled');
    expect(b!.status).toBe('fulfilled');
    expect(await t.prisma.workerAllocation.count({ where: { projectId, status: 'active' } })).toBe(1);
    expect(await t.prisma.activityRequirement.count({ where: { projectId, type: 'material' } })).toBe(1);
  });

  // ── §G the seventh projection ─────────────────────────────────────────────────────────────────

  const drainRelay = async (): Promise<void> => { for (let i = 0; i < 8; i++) await relay.runOnce(); };
  const storedDto = async (projectId: string): Promise<LabourReadinessDto | null> => {
    const gen = await readServableGeneration(t.prisma, LABOUR_READINESS_PROJECTION, projectId);
    if (!gen) return null;
    const row = await t.prisma.labourReadinessProjection.findUnique({
      where: { generationId_projectId: { generationId: gen.id, projectId } }, select: { dto: true },
    });
    return (row?.dto as unknown as LabourReadinessDto) ?? null;
  };
  const storedRowAnyGen = async (projectId: string): Promise<LabourReadinessDto | null> => {
    const row = await t.prisma.labourReadinessProjection.findFirst({ where: { projectId }, orderBy: { updatedAt: 'desc' }, select: { dto: true } });
    return (row?.dto as unknown as LabourReadinessDto) ?? null;
  };
  const liveDto = (projectId: string): Promise<LabourReadinessDto> =>
    t.prisma.$transaction((tx) => computeLabourReadinessDto(tx, projectId));

  it('§G PROJECTION: live == projection == rebuild; a rebuild emits ZERO events + notifications; the fold is payload-sourced', async () => {
    const projectId = await freshProject();
    await enableLabour(projectId);
    const act = await freshActivity(projectId);
    const req = await labourRequirement(projectId, act, [{ civilDate: today, personShiftQty: 1 }]);
    const w = await onboardWorker(projectId);
    await allocate(projectId, act, req.requirementId, today, w);
    await drainRelay();

    const live = await liveDto(projectId);
    expect(live.forecast[act]?.verdict).toBe('ready');
    expect(await storedDto(projectId)).toEqual(live);

    // a CANCELLED requirement leaves the fold (the read-model is built from the event payloads —
    // the projection never reads ActivityRequirement persistence)
    const act2 = await freshActivity(projectId);
    const req2 = await labourRequirement(projectId, act2, [{ civilDate: day(3), personShiftQty: 1 }]);
    await requirements.cancel(projectId, req2.requirementId, { reason: 'descoped', expectedRevision: req2.revision } as never, pmc(projectId));
    await drainRelay();
    const afterCancel = await liveDto(projectId);
    expect(afterCancel.forecast[act2]).toBeUndefined();
    expect(await storedDto(projectId)).toEqual(afterCancel);

    // rebuild: recompute-only — zero domain events, zero notifications, identical dto
    const eventsBefore = await t.prisma.domainEvent.count({ where: { projectId } });
    const notifsBefore = await t.prisma.notification.count({ where: { projectId } });
    const report = await ops.run({ operatorIdentity: 'op', reason: 'task-4 probe', consumers: [LABOUR_READINESS_PROJECTION] });
    expect(report.ok).toBe(true);
    expect(report.corruptAfter).toBe(0);
    expect(await t.prisma.domainEvent.count({ where: { projectId } })).toBe(eventsBefore);
    expect(await t.prisma.notification.count({ where: { projectId } })).toBe(notifsBefore);
    expect(await storedDto(projectId)).toEqual(afterCancel);
  });

  it('§G PROJECTION LAG never changes a start verdict: a stale ready forecast cannot start a stranded activity', async () => {
    const projectId = await freshProject();
    await enableLabour(projectId);
    const act = await freshActivity(projectId);
    const req = await labourRequirement(projectId, act, [{ civilDate: today, personShiftQty: 1 }]);
    const w = await onboardWorker(projectId);
    await allocate(projectId, act, req.requirementId, today, w);
    await muster(projectId, w, today);
    await drainRelay();
    expect((await storedDto(projectId))?.forecast[act]?.verdict).toBe('ready');

    // strand the allocation (trade revision) but DO NOT drain the relay — the stored projection
    // row still physically holds the pre-revision 'ready' verdict
    await reviseLabour(projectId, req, act, [{ civilDate: today, personShiftQty: 1 }], { tradeCode: 'carpenter', skillCode: 'shuttering' });
    expect((await storedRowAnyGen(projectId))?.forecast[act]?.verdict).toBe('ready'); // stale
    // the start authority reads CANONICAL execution coverage in-tx — never the stale projection
    await expect(activities.start(projectId, act, pmc(projectId))).rejects.toMatchObject({ status: 409 });
    // and the live recompute already reflects the strand
    expect((await liveDto(projectId)).forecast[act]?.verdict).toBe('blocked');
  });

  // ── Codex round-1 corrections (5 findings on head 09db0a5) — each reproduced RED first ────────

  it('ROUND-1 F1 (retry-safe migration): re-applying the Task-4 migration SQL to a migrated database is a no-op', async () => {
    // A crash between CREATE TABLE and Prisma recording the migration must leave a RERUNNABLE
    // migration. The table already exists on this migrated test DB — every statement must be
    // guarded (IF NOT EXISTS) so the retry passes instead of stopping on "relation already exists".
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const sql = readFileSync(
      join(__dirname, '..', '..', 'prisma', 'migrations', '20270301000000_phase4_t4_labour_readiness', 'migration.sql'),
      'utf8',
    );
    const executable = sql.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');
    const statements = executable.split(';').map((s) => s.trim()).filter((s) => s.length > 0);
    expect(statements.length).toBeGreaterThan(0);
    for (const statement of statements) {
      await t.prisma.$executeRawUnsafe(statement); // RED at 09db0a5: "already exists"
    }
  });

  it('ROUND-1 F3 (present ∪ worked): two distinct people — one mustered, one with a work fact — cover a two-person slice', async () => {
    const projectId = await freshProject();
    await enableLabour(projectId);
    const act = await freshActivity(projectId);
    const req = await labourRequirement(projectId, act, [{ civilDate: today, personShiftQty: 2 }]);
    const wA = await onboardWorker(projectId);
    const wB = await onboardWorker(projectId);
    await allocate(projectId, act, req.requirementId, today, wA);
    const allocB = (await allocate(projectId, act, req.requirementId, today, wB)).allocations[0]!;
    await muster(projectId, wA, today); // A is present, has not worked
    await capacity.recordWork(projectId, { allocationId: allocB.id, workedMinutes: 480 }, pmc(projectId)); // B worked, never mustered
    // Every required person-shift is either mustered or already delivered — §A row 5 is satisfied
    // by the UNION of the two one-person sets, not by max(1, 1) = 1.
    const team = await teamOf(projectId, act);
    expect(team.v).toBe('ok'); // RED at 09db0a5: 'wait' (muster pending)

    // The same union governs FORECAST sourcing (allocated ∪ worked): release B after the work —
    // one active allocation + one delivered person-shift still fully sources the slice.
    await capacity.release(projectId, allocB.id, { reason: 'shift delivered' }, pmc(projectId));
    const rows = await forecastOf(projectId, act);
    expect(rows[0]!.verdict).toBe('ready');
  });

  it('ROUND-1 F4 (activity binding): allocations pinned to a previous activity never cover the revised head on a NEW activity', async () => {
    const projectId = await freshProject();
    await enableLabour(projectId);
    const actA = await freshActivity(projectId);
    const actB = await freshActivity(projectId);
    const req = await labourRequirement(projectId, actA, [{ civilDate: today, personShiftQty: 1 }]);
    const w = await onboardWorker(projectId);
    await allocate(projectId, actA, req.requirementId, today, w);
    await muster(projectId, w, today);
    expect((await teamOf(projectId, actA)).v).toBe('ok');

    // Revise the requirement onto activity B — same fingerprint, same slice. The allocation stays
    // FK-pinned to activity A, so NOTHING actually targets B; its Team gate must not inherit A's crew.
    await reviseLabour(projectId, req, actB, [{ civilDate: today, personShiftQty: 1 }]);
    const team = await teamOf(projectId, actB);
    expect(team.v).toBe('fail'); // RED at 09db0a5: 'ok' — A's crew counted for B
    expect(team.reason).toContain('Under-allocated');
    // and the forecast agrees: no allocation targets B
    const rows = await forecastOf(projectId, actB);
    expect(rows[0]!.verdict).toBe('blocked');
  });

  it('ROUND-1 F2 (conserved commitments): one committed person-shift covers at most ONE forecast shortfall, and a drawn commitment is spent GLOBALLY', async () => {
    const projectId = await freshProject();
    await enableLabour(projectId);
    const actA = await freshActivity(projectId);
    const actB = await freshActivity(projectId);
    const d = day(3);
    const reqA = await labourRequirement(projectId, actA, [{ civilDate: d, personShiftQty: 1 }]);
    const reqB = await labourRequirement(projectId, actB, [{ civilDate: d, personShiftQty: 1 }]);
    const { commitmentId } = await committedCapacity(projectId, reqA, d, 1);

    // (a) Both requirements are short one person-shift of the SAME (fingerprint, civilDate, shift)
    // slice; the single quantity-1 commitment can make only ONE of them at-risk — the other stays
    // blocked. RED at 09db0a5: both at-risk (the residual was recomputed per requirement).
    const verdicts = async (): Promise<Map<string, string>> =>
      new Map(Object.entries((await liveDto(projectId)).forecast).map(([id, fc]) => [id, fc.verdict]));
    const both = await verdicts();
    expect([...both.values()].sort()).toEqual(['at-risk', 'blocked']);
    // deterministic + input-order-invariant: the projection recompute agrees with itself
    expect(await verdicts()).toEqual(both);

    // (b) Draw the commitment down with a REAL allocation for requirement A: the person-shift is
    // spent for EVERY requirement, not only the one whose allocation drew it. A is now sourced by
    // its allocation (ready); B's shortfall has NO undrawn commitment left → blocked.
    // RED at 09db0a5: B stayed at-risk because A's draw was invisible to B's per-row counts.
    const w = await onboardWorker(projectId);
    await capacity.allocate(projectId, { activityId: actA, requirementId: reqA.requirementId, civilDate: d, workerId: w, capacityCommitmentId: commitmentId }, pmc(projectId));
    const after = await verdicts();
    expect(after.get(actA)).toBe('ready');
    expect(after.get(actB)).toBe('blocked');
  });

  it('ROUND-1 F5 (drawable forecast): a REVISED commitment cannot be drawn by allocation, so the forecast never advertises it', async () => {
    const projectId = await freshProject();
    await enableLabour(projectId);
    const act = await freshActivity(projectId);
    const d = day(2);
    const req = await labourRequirement(projectId, act, [{ civilDate: d, personShiftQty: 1 }]);
    const { commitmentId } = await committedCapacity(projectId, req, d, 1);
    expect((await forecastOf(projectId, act))[0]!.verdict).toBe('at-risk');

    // The supplier re-promises: the commitment enters 'revised' — a state the allocation command
    // (and its DB trigger) REFUSE to draw down. Advertising it as covering the shortfall would be
    // §A cover that cannot convert into execution capacity.
    await commercial.reviseCapacity(projectId, commitmentId, { promisedDate: d, reason: 'supplier re-promise' }, pmc(projectId));
    const w = await onboardWorker(projectId);
    await expect(
      capacity.allocate(projectId, { activityId: act, requirementId: req.requirementId, civilDate: d, workerId: w, capacityCommitmentId: commitmentId }, pmc(projectId)),
    ).rejects.toMatchObject({ status: 409 }); // ground truth: not drawable
    expect((await forecastOf(projectId, act))[0]!.verdict).toBe('blocked'); // RED at 09db0a5: 'at-risk'
  });

  // ── Codex round-2 corrections (3 findings on the 38e5c42 review) — each reproduced RED first ──

  it('ROUND-2 A: a commitment for a SUBSTITUTE fingerprint is never forecast — allocation draws only the head fingerprint', async () => {
    const projectId = await freshProject();
    await enableLabour(projectId);
    const act = await freshActivity(projectId);
    const d = day(3);
    // head A (mason/bar-bending): commit supplier capacity carrying fingerprint A
    const req = await labourRequirement(projectId, act, [{ civilDate: d, personShiftQty: 1 }]);
    const { commitmentId } = await committedCapacity(projectId, req, d, 1);
    // revise to head B (carpenter/shuttering), then approve the A spec as a SUBSTITUTE for B —
    // acceptable fingerprints are now {B, A}, but only B is DRAWABLE
    await reviseLabour(projectId, req, act, [{ civilDate: d, personShiftQty: 1 }], { tradeCode: 'carpenter', skillCode: 'shuttering' });
    await capacity.approveSkillSubstitution(projectId, { requirementId: req.requirementId, tradeCode: 'mason', skillCode: 'bar-bending', shift: 'day', reason: 'masons may stand in' }, pmc(projectId));
    // ground truth: the A commitment cannot be drawn for head B
    const w = await onboardWorker(projectId);
    await expect(
      capacity.allocate(projectId, { activityId: act, requirementId: req.requirementId, civilDate: d, workerId: w, capacityCommitmentId: commitmentId }, pmc(projectId)),
    ).rejects.toMatchObject({ status: 400 });
    // so the forecast must not advertise it (RED at e8b1c4a: 'at-risk')
    expect((await forecastOf(projectId, act))[0]!.verdict).toBe('blocked');
  });

  it('ROUND-2 B: a released allocation with a WORK FACT keeps its commitment draw consumed; a workless release frees it', async () => {
    const projectId = await freshProject();
    await enableLabour(projectId);
    const actA = await freshActivity(projectId);
    const actB = await freshActivity(projectId);
    const d = day(2);
    const reqA = await labourRequirement(projectId, actA, [{ civilDate: d, personShiftQty: 1 }]);
    await labourRequirement(projectId, actB, [{ civilDate: d, personShiftQty: 1 }]);
    const { commitmentId } = await committedCapacity(projectId, reqA, d, 1);
    const w = await onboardWorker(projectId);
    const first = (await capacity.allocate(projectId, { activityId: actA, requirementId: reqA.requirementId, civilDate: d, workerId: w, capacityCommitmentId: commitmentId }, pmc(projectId))).allocations[0]!;

    // (a) release with NO work: the supplier person-shift was never delivered — the commitment is
    // freed (the allocation command may re-draw it), so it may cover exactly ONE shortfall again
    await capacity.release(projectId, first.id, { reason: 'reassigned before the shift' }, pmc(projectId));
    const freed = await liveDto(projectId);
    expect([freed.forecast[actA]?.verdict, freed.forecast[actB]?.verdict].sort()).toEqual(['at-risk', 'blocked']);

    // (b) re-draw, DELIVER (work fact), then release: the person-shift was SPENT — reqA stays
    // sourced via the §A worked guardrail, and the commitment must NOT resurface for B
    const second = (await capacity.allocate(projectId, { activityId: actA, requirementId: reqA.requirementId, civilDate: d, workerId: w, capacityCommitmentId: commitmentId }, pmc(projectId))).allocations[0]!;
    await capacity.recordWork(projectId, { allocationId: second.id, workedMinutes: 480 }, pmc(projectId));
    await capacity.release(projectId, second.id, { reason: 'shift delivered' }, pmc(projectId));
    const after = await liveDto(projectId);
    expect(after.forecast[actA]?.verdict).toBe('ready'); // delivered work keeps A sourced
    expect(after.forecast[actB]?.verdict).toBe('blocked'); // RED at e8b1c4a: 'at-risk' — the release freed the draw
  });

  it('ROUND-2 C: a requirement revised onto a NEW activity leaves NO labour demand on the old one — heads resolve before activity scoping', async () => {
    const projectId = await freshProject();
    await enableLabour(projectId);
    const actA = await freshActivity(projectId);
    const actB = await freshActivity(projectId);
    const req = await labourRequirement(projectId, actA, [{ civilDate: today, personShiftQty: 1 }]);
    await reviseLabour(projectId, req, actB, [{ civilDate: today, personShiftQty: 1 }]);
    // Activity A no longer owns any labour demand: its Team gate is na. RED at e8b1c4a: the
    // A-scoped loader chose the head WITHIN the activity filter, resurrecting revision 1 as an
    // open head and failing A on demand that activity B now owns.
    expect((await teamOf(projectId, actA)).v).toBe('na');
    // B carries the real (unsatisfied) demand
    expect((await teamOf(projectId, actB)).v).toBe('fail');
  });

  // ── Codex round 12 (PR #246) — supplier drawdown requires a HEAD-NATIVE worker ────────────────

  it('ROUND-12: a substitution-only worker cannot draw supplier capacity committed for the head identity; own-workforce and a native worker still can', async () => {
    const projectId = await freshProject();
    await enableLabour(projectId);
    const act = await freshActivity(projectId);
    const d = day(3);
    // head mason/bar-bending, 2 person-shifts; supplier capacity committed FOR THE HEAD identity
    const req = await labourRequirement(projectId, act, [{ civilDate: d, personShiftQty: 2 }]);
    const { commitmentId } = await committedCapacity(projectId, req, d, 1);
    // a carpenter becomes eligible ONLY through an approved substitution (head ← carpenter)
    await capacity.approveSkillSubstitution(projectId, { requirementId: req.requirementId, tradeCode: 'carpenter', skillCode: 'shuttering', shift: 'day', reason: 'carpenters may stand in' }, pmc(projectId));
    const carp = (await labour.onboardWorker(projectId, { name: `Carp${seq++}`, tradeCode: 'carpenter', skillCodes: ['shuttering'], activeFrom: '2026-01-01', activeTo: null }, pmc(projectId))).id;
    // RED at 19106d7: the draw was ACCEPTED — `acceptable` admitted substitution targets, so the
    // head-trade supplier commitment was consumed while substitute labour actually arrived.
    await expect(
      capacity.allocate(projectId, { activityId: act, requirementId: req.requirementId, civilDate: d, workerId: carp, capacityCommitmentId: commitmentId }, pmc(projectId)),
    ).rejects.toMatchObject({ status: 400, message: expect.stringMatching(/committed for the head identity/) });
    // the substitute is still allocatable as OWN workforce (no commitment id)
    await allocate(projectId, act, req.requirementId, d, carp);
    // and a NATIVE mason draws the commitment exactly as before
    const mason = await onboardWorker(projectId);
    await capacity.allocate(projectId, { activityId: act, requirementId: req.requirementId, civilDate: d, workerId: mason, capacityCommitmentId: commitmentId }, pmc(projectId));
  });
});
