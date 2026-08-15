import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { createTestApp, type TestApp } from './test-app';
import { createTwoProjectFixture, type TwoProjectFixture, seedProjectClient, wipeDecisions } from './fixtures';
import { ActivitiesService } from '../../src/activities/activities.service';
import { ActivitiesQueryService } from '../../src/activities/activities.query';
import { RequirementsService } from '../../src/activities/requirements.service';
import { ACTIVITIES_PROJECTION } from '../../src/activities/activities.projection';
import { LABOUR_MISMATCH_BLOCK } from '../../src/activities/activity.participant';
import { LabourService } from '../../src/labour/labour.service';
import { LabourCapacityService } from '../../src/labour/labour-capacity.service';
import { LabourRequirementQuery } from '../../src/labour/labour.query';
import { DailyLogService } from '../../src/daily-log/daily-log.service';
import { MediaService } from '../../src/media/media.service';
import { CapabilitiesService, LABOUR_CAPABILITY, MATERIALS_CAPABILITY } from '../../src/platform/capabilities.service';
import { OutboxRelay } from '../../src/platform/outbox/relay.service';
import { lockProjectReadiness } from '../../src/common/readiness-lock';
import { SystemClock } from '../../src/common/clock';
import { recordLabourMismatchSchema } from '../../src/contracts';
import type { AuthUser } from '../../src/common/auth';

/**
 * Phase 4 Task 5 — §E Daily-Log labour reconciliation + §I planned-vs-actual productivity,
 * proven live against PostgreSQL, reproduce-first.
 *
 * Covered (the plan's required Task-5 probes):
 *   §E mismatch-first — an unresolved `LabourMismatch` fact makes the DERIVED Team gate `fail`
 *      even when every slice is present AND worked, and `start` refuses naming team even when the
 *      operational status was hostilely reset (the FACTS protect the start, not the stored state)
 *   §E authority — pmc/engineer record; ONLY pmc resolves (engineer 403); keyed replay appends
 *      exactly one observation
 *   §E register — ONE resolution per observation (second resolve 409); the observation is never
 *      edited; PG append-only seals on all three Task-5 tables
 *   §E presence read — per-worker musters with joined identity + UNRESOLVED mismatches only;
 *      the whole surface 404s off-pilot (§D — daily-log module untouched, CrewRow display-only)
 *   §E handover — a material block and a labour dispute on the SAME activity: resolving the
 *      material mismatch first RE-ASSERTS the labour block (never a silent drop), resolving the
 *      labour mismatch then restores; `awaiting_signoff` is never operationally moved
 *   §E races — resolve vs start under the deterministic readiness-lock barrier, BOTH orderings
 *   §G projection — `activity.labour_blocked`/`activity.labour_unblocked` refresh the activities
 *      projection (a caught-up projection shows the block transition; projection == live)
 *   §I effort — `LabourQuery.effortFor` groups worked minutes per (activity, civilDate, shift)
 *   §I output — `ActivityWorkOutput` immutable; cited photo evidence is not deletable (409)
 *   §I productivity — output ÷ effort composed Activities-side; zero effort → null (never ∞)
 */
describe('Phase 4 Task 5 — §E labour reconciliation + §I productivity (live PG)', () => {
  let t: TestApp;
  let f: TwoProjectFixture;
  let activities: ActivitiesService;
  let query: ActivitiesQueryService;
  let requirements: RequirementsService;
  let labour: LabourService;
  let capacity: LabourCapacityService;
  let labourQuery: LabourRequirementQuery;
  let dailyLog: DailyLogService;
  let media: MediaService;
  let capabilities: CapabilitiesService;
  let relay: OutboxRelay;
  let seq = 0;

  const today = new SystemClock().today('Asia/Kolkata');

  const TRUNCATE =
    'TRUNCATE TABLE "VendorAdvance", "PaymentReversal", "Payment", "PaymentApproval", "BillDeductionRelease", "BillDeduction", "SodException", "SodGrant", "CertifiedMeasurementConsumption", "CertifiedAcceptanceConsumption", "BillCertificate", "DomainEvent", "OutboxDelivery", "ProcessedEvent", "ProjectionCursor", "ProjectionGeneration", "DecisionProjection", "DailyLogProjection", "DrawingsProjection", "InspectionsProjection", "ActivitiesProjection", "MaterialReadinessProjection", "CashForecastProjection", "LabourReadinessProjection", "LabourMismatchResolution", "LabourMismatch", "ActivityWorkOutput", "MismatchResolution", "SiteMaterial", "LabourWorkFact", "WorkerAllocation", "LabourAttendance", "ApprovedSkillSubstitution", "CapacityPromise", "CapacityCommitment", "LabourPurchaseOrderLine", "LabourPurchaseOrderVersion", "LabourPurchaseOrder", "SupplierLabourQuoteLine", "SupplierLabourQuote", "LabourQuoteComparison", "LabourRfq", "LabourRequisitionLine", "LabourRequisition", "VendorLabourProfile", "ProjectPartyVendorSource", "ProjectPartyCompanySource", "ProjectParty", "ProjectVendor", "CommandExecution", "CrewMembership", "Crew", "WorkerDevice", "WorkerSkill", "Worker", "LabourDemandSlice", "LabourRequirementSpec", "LabourTrade", "LabourSkill", "MaterialRequirementSpec", "ActivityRequirement", "ActivityRequirementRoot", "DecisionApprovalRevision", "ProjectCapability" CASCADE';

  const pmc = (projectId: string): AuthUser => ({ sub: f.memberUser.id, role: 'pmc', projectId }) as AuthUser;

  beforeAll(async () => {
    t = await createTestApp();
    f = await createTwoProjectFixture(t.prisma);
    activities = t.app.get(ActivitiesService);
    query = t.app.get(ActivitiesQueryService);
    requirements = t.app.get(RequirementsService);
    labour = t.app.get(LabourService);
    capacity = t.app.get(LabourCapacityService);
    labourQuery = t.app.get(LabourRequirementQuery);
    dailyLog = t.app.get(DailyLogService);
    media = t.app.get(MediaService);
    capabilities = t.app.get(CapabilitiesService);
    relay = t.app.get(OutboxRelay);
  });
  afterAll(async () => {
    await t?.prisma.$executeRawUnsafe(TRUNCATE);
    await f?.cleanup();
    await t?.close();
  });
  afterEach(async () => {
    await t.prisma.$executeRawUnsafe(TRUNCATE);
    const pids = { startsWith: 'it-p4t5-' };
    for (const [model, where] of [
      ['auditLog', { projectId: pids }],
      ['notification', { projectId: pids }],
      ['crewRow', { dailyLog: { projectId: pids } }],
      ['dailyLog', { projectId: pids }],
      ['media', { projectId: pids }],
      ['activity', { projectId: pids }],
    ] as const) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (t.prisma as any)[model].deleteMany({ where });
    }
    // Phase 6 task 4b: decisions carry OPTIONS now (the two-option publication floor) and a
    // published decision's options are frozen, so the wipe goes through the sanctioned named-seal
    // helper — AFTER the activities that reference them, BEFORE the memberships that hold them
    await wipeDecisions(t.prisma, { projectId: pids });
    for (const [model, where] of [
      ['membership', { projectId: pids }],
      ['user', { id: { startsWith: 'it-p4t5-u-' } }],
      ['project', { id: pids }],
    ] as const) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (t.prisma as any)[model].deleteMany({ where });
    }
  });

  // ── fixtures (the Task-4 harness, re-homed on it-p4t5-) ──────────────────────────────────────

  const freshProject = async (): Promise<{ id: string; engId: string }> => {
    const id = `it-p4t5-${Date.now() % 1e6}-${seq++}`;
    await t.prisma.project.create({
      data: { id, orgId: f.orgA.id, name: id, short: 'P', descriptor: '', stage: 'x', siteCode: 'P', projStart: 'a', projEnd: 'b', elapsedPct: 0, todayDay: 0, milestonePct: 0, timeZone: 'Asia/Kolkata', scheduleStartDate: new Date('2026-06-01T00:00:00.000Z') },
    });
    await t.prisma.membership.create({ data: { projectId: id, userId: f.memberUser.id, role: 'pmc', status: 'active' } });
    // Phase 6 task 4b: a decision's default decider is the client, and publishing into a
    // project with no active one is refused — an ad-hoc project needs the same cast a real one has
    await seedProjectClient(t.prisma, id, f.clientUser.id);
    const engId = `it-p4t5-u-eng-${seq}`;
    await t.prisma.user.create({ data: { id: engId, projectId: id, role: 'engineer', name: 'Eng One', email: `${engId}@t.local` } });
    await t.prisma.membership.create({ data: { projectId: id, userId: engId, role: 'engineer', status: 'active' } });
    return { id, engId };
  };
  const eng = (projectId: string, engId: string): AuthUser => ({ sub: engId, role: 'engineer', projectId }) as AuthUser;
  const freshActivity = async (projectId: string, over: { decisionId?: string } = {}): Promise<string> => {
    const id = `IT-P4T5-ACT-${Date.now() % 1e6}-${seq++}`;
    await t.prisma.activity.create({ data: { id, projectId, name: `Act ${seq}`, zone: 'Zone 1', plannedStart: 0, plannedEnd: 10, ...over } });
    return id;
  };
  const enableLabour = async (projectId: string): Promise<void> => {
    await capabilities.enable(projectId, LABOUR_CAPABILITY, f.memberUser.id);
    await labour.upsertTrade(projectId, { code: 'mason', name: 'Mason' }, pmc(projectId));
    await labour.upsertSkill(projectId, { code: 'bar-bending', name: 'Bar Bending' }, pmc(projectId));
  };
  const labourRequirement = async (
    projectId: string, activityId: string,
    slices: Array<{ civilDate: string; personShiftQty: number }>,
  ): Promise<{ requirementId: string; revision: number }> => {
    const r = await requirements.create(
      projectId,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { type: 'labour', activityId, tradeCode: 'mason', skillCode: 'bar-bending', shift: 'day', demandSlices: slices, decisionId: null, responsibleId: null, criticality: 'normal', tolerance: null } as any,
      pmc(projectId),
    );
    return { requirementId: r.requirementId, revision: r.revision };
  };
  const onboardWorker = async (projectId: string, name = `W${seq++}`): Promise<string> => {
    const w = await labour.onboardWorker(projectId, { name, tradeCode: 'mason', skillCodes: ['bar-bending'], activeFrom: '2026-01-01', activeTo: null }, pmc(projectId));
    return w.id;
  };
  const allocate = async (projectId: string, activityId: string, requirementId: string, workerId: string): Promise<string> => {
    const r = await capacity.allocate(projectId, { activityId, requirementId, civilDate: today, workerId }, pmc(projectId));
    return r.allocations[0]!.id;
  };
  const muster = (projectId: string, workerId: string) =>
    capacity.recordAttendance(projectId, { workerId, civilDate: today, shift: 'day', manualReason: 'roll call — Task-5 probe' }, pmc(projectId));
  const recordMismatch = (projectId: string, activityId: string, user?: AuthUser, key?: string) =>
    capacity.recordMismatch(projectId, { activityId, civilDate: today, shift: 'day', kind: 'shortfall', note: 'crew short vs allocated' }, user ?? pmc(projectId), key);
  const freshMedia = async (projectId: string): Promise<string> => {
    const m = await t.prisma.media.create({ data: { projectId, kind: 'progress', mime: 'image/png', sizeBytes: 1, uploadedBy: f.memberUser.id } });
    return m.id;
  };
  const activityRow = (projectId: string, id: string) =>
    t.prisma.activity.findFirstOrThrow({ where: { projectId, id }, select: { status: true, block: true, gateMaterial: true } });

  /** the §A EXECUTION Team reading — the SAME authority `activities.start` reads */
  const teamOf = (projectId: string, activityId: string) =>
    t.prisma.$transaction((tx) => activities.teamReading(tx, projectId, { id: activityId }, today));

  /** a covered (allocated + present) due-today labour slice — coverage `ok` before any mismatch */
  const coveredActivity = async (projectId: string): Promise<{ activityId: string; requirementId: string; workerId: string; allocationId: string }> => {
    const activityId = await freshActivity(projectId);
    const req = await labourRequirement(projectId, activityId, [{ civilDate: today, personShiftQty: 1 }]);
    const workerId = await onboardWorker(projectId);
    const allocationId = await allocate(projectId, activityId, req.requirementId, workerId);
    await muster(projectId, workerId);
    return { activityId, requirementId: req.requirementId, workerId, allocationId };
  };

  /** Drain every pending activities.schedule delivery for a project (the Module-4 helper). */
  const applyProjection = async (projectId: string): Promise<void> => {
    for (let pass = 0; pass < 60; pass++) {
      const ds = await t.prisma.outboxDelivery.findMany({ where: { consumer: ACTIVITIES_PROJECTION, projectId, status: { in: ['pending', 'leased'] } }, orderBy: { streamPosition: 'asc' } });
      if (!ds.length) return;
      let progressed = false;
      for (const d of ds) {
        const o = await relay.dispatchOne(d.id);
        if (o === 'succeeded' || o === 'duplicate' || o === 'dead') progressed = true;
      }
      if (!progressed) return;
    }
  };

  // ── deterministic race barrier (the Phase-3/T4 pattern) ──────────────────────────────────────
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

  // ── §D off-pilot: the whole Task-5 surface is ABSENT ─────────────────────────────────────────

  it('§D OFF-PILOT: mismatch record/resolve, presence, output and productivity all 404 on a non-pilot project', async () => {
    const p = await freshProject();
    const act = await freshActivity(p.id);
    await expect(recordMismatch(p.id, act)).rejects.toMatchObject({ status: 404 });
    await expect(capacity.resolveMismatch(p.id, 'nope', { resolution: 'x', reason: 'y' }, pmc(p.id))).rejects.toMatchObject({ status: 404 });
    await expect(capacity.presence(p.id, today, pmc(p.id))).rejects.toMatchObject({ status: 404 });
    await expect(activities.recordOutput(p.id, { activityId: act, civilDate: today, shift: 'day', quantity: '1', uom: 'm3' }, pmc(p.id))).rejects.toMatchObject({ status: 404 });
    await expect(query.labourProductivity(p.id)).rejects.toMatchObject({ status: 404 });
  });

  // ── §E mismatch-first Team gate ──────────────────────────────────────────────────────────────

  it('§E MISMATCH-FIRST: an unresolved observation fails the DERIVED gate even when present+worked cover; a hostile status reset cannot start; resolution restores', async () => {
    const p = await freshProject();
    await enableLabour(p.id);
    const c = await coveredActivity(p.id);
    await capacity.recordWork(p.id, { allocationId: c.allocationId, workedMinutes: 480 }, pmc(p.id));
    expect((await teamOf(p.id, c.activityId)).v, 'present AND worked → execution ok').toBe('ok');

    const m = await recordMismatch(p.id, c.activityId);
    // the operational consequence: status blocked + the labour banner
    expect(await activityRow(p.id, c.activityId)).toMatchObject({ status: 'blocked', block: LABOUR_MISMATCH_BLOCK });
    // the DERIVED gate: mismatch-first fail BEFORE coverage (§A first-match)
    const failed = await teamOf(p.id, c.activityId);
    expect(failed.v).toBe('fail');
    expect(failed.reason).toContain('mismatch');

    // HOSTILE: wipe the operational block — the FACTS still protect the start authority
    await t.prisma.activity.update({ where: { id: c.activityId }, data: { status: 'not_started', block: null } });
    await expect(activities.start(p.id, c.activityId, pmc(p.id))).rejects.toMatchObject({
      status: 409, message: expect.stringMatching(/team:.*mismatch/i),
    });

    // pmc resolution closes the observation; coverage truth (still present+worked) rules again
    await capacity.resolveMismatch(p.id, m.id, { resolution: 'crew corrected on site', reason: 'two masons swapped in from B-crew' }, pmc(p.id));
    expect((await teamOf(p.id, c.activityId)).v).toBe('ok');
    await activities.start(p.id, c.activityId, pmc(p.id));
    expect((await activityRow(p.id, c.activityId)).status).toBe('in_progress');
  });

  it('§E CONTRACT: wrong_trade requires the worker; shortfall forbids one (the discriminated zod refinement)', () => {
    const base = { activityId: 'A', civilDate: today, shift: 'day', note: 'n' };
    expect(recordLabourMismatchSchema.safeParse({ ...base, kind: 'wrong_trade' }).success, 'wrong_trade without workerId refused').toBe(false);
    expect(recordLabourMismatchSchema.safeParse({ ...base, kind: 'wrong_trade', workerId: 'W1' }).success).toBe(true);
    expect(recordLabourMismatchSchema.safeParse({ ...base, kind: 'shortfall', workerId: 'W1' }).success, 'shortfall naming a worker refused').toBe(false);
    expect(recordLabourMismatchSchema.safeParse({ ...base, kind: 'shortfall' }).success).toBe(true);
  });

  it('§E AUTHORITY: the engineer records (keyed replay appends exactly one); ONLY pmc resolves (engineer 403)', async () => {
    const p = await freshProject();
    await enableLabour(p.id);
    const act = await freshActivity(p.id);
    await labourRequirement(p.id, act, [{ civilDate: today, personShiftQty: 1 }]);

    const key = `it-p4t5-mismatch-${seq++}`;
    const first = await recordMismatch(p.id, act, eng(p.id, p.engId), key);
    const replay = await recordMismatch(p.id, act, eng(p.id, p.engId), key);
    expect(replay.id, 'keyed replay returns the SAME observation').toBe(first.id);
    expect(await t.prisma.labourMismatch.count({ where: { projectId: p.id } }), 'exactly one row').toBe(1);
    expect(first.recordedById).toBe(p.engId);

    await expect(
      capacity.resolveMismatch(p.id, first.id, { resolution: 'x', reason: 'y' }, eng(p.id, p.engId)),
    ).rejects.toMatchObject({ status: 403 });
    const resolved = await capacity.resolveMismatch(p.id, first.id, { resolution: 'crew swap', reason: 'verified' }, pmc(p.id));
    expect(resolved.resolution?.resolvedById).toBe(f.memberUser.id);
  });

  it('§E REGISTER: one resolution per observation — a second resolve is a deterministic 409; the observation row is never edited', async () => {
    const p = await freshProject();
    await enableLabour(p.id);
    const act = await freshActivity(p.id);
    const m = await recordMismatch(p.id, act);
    const before = await t.prisma.labourMismatch.findFirstOrThrow({ where: { projectId: p.id, id: m.id } });
    await capacity.resolveMismatch(p.id, m.id, { resolution: 'first', reason: 'r1' }, pmc(p.id));
    await expect(capacity.resolveMismatch(p.id, m.id, { resolution: 'second', reason: 'r2' }, pmc(p.id))).rejects.toMatchObject({ status: 409 });
    const after = await t.prisma.labourMismatch.findFirstOrThrow({ where: { projectId: p.id, id: m.id } });
    expect(after).toEqual(before); // the observation itself is untouched — resolution is a SEPARATE register row
    expect(await t.prisma.labourMismatchResolution.count({ where: { projectId: p.id, mismatchId: m.id } })).toBe(1);
  });

  it('§E/§I SEALS: PostgreSQL rejects UPDATE and DELETE on all three Task-5 tables (append-only)', async () => {
    const p = await freshProject();
    await enableLabour(p.id);
    const act = await freshActivity(p.id);
    const m = await recordMismatch(p.id, act);
    await capacity.resolveMismatch(p.id, m.id, { resolution: 'x', reason: 'y' }, pmc(p.id));
    await activities.recordOutput(p.id, { activityId: act, civilDate: today, shift: 'day', quantity: '5', uom: 'm3' }, pmc(p.id));

    for (const [table, set] of [
      ['LabourMismatch', `"note" = 'forged'`],
      ['LabourMismatchResolution', `"reason" = 'forged'`],
      ['ActivityWorkOutput', `"quantity" = 999`],
    ] as const) {
      await expect(
        t.prisma.$executeRawUnsafe(`UPDATE "${table}" SET ${set} WHERE "projectId" = '${p.id}'`),
        `UPDATE ${table} rejected`,
      ).rejects.toThrow(/append-only/i);
      await expect(
        t.prisma.$executeRawUnsafe(`DELETE FROM "${table}" WHERE "projectId" = '${p.id}'`),
        `DELETE ${table} rejected`,
      ).rejects.toThrow(/append-only/i);
    }
  });

  // ── §E presence read ─────────────────────────────────────────────────────────────────────────

  it('§E PRESENCE: per-worker musters with JOINED identity + UNRESOLVED mismatches only; CrewRow stays display-only', async () => {
    const p = await freshProject();
    await enableLabour(p.id);
    const act = await freshActivity(p.id);
    await labourRequirement(p.id, act, [{ civilDate: today, personShiftQty: 2 }]);
    const w1 = await onboardWorker(p.id, 'Ravi');
    const w2 = await onboardWorker(p.id, 'Suresh');
    await muster(p.id, w1);
    await muster(p.id, w2);
    const open = await recordMismatch(p.id, act);
    const closed = await capacity.recordMismatch(p.id, { activityId: act, civilDate: today, shift: 'day', kind: 'wrong_trade', workerId: w2, note: 'carpenter sent for mason work' }, pmc(p.id));
    await capacity.resolveMismatch(p.id, closed.id, { resolution: 'reassigned', reason: 'ok' }, pmc(p.id));

    const presence = await capacity.presence(p.id, today, pmc(p.id));
    expect(presence.civilDate).toBe(today);
    expect(presence.musters.map((mu) => mu.workerName).sort()).toEqual(['Ravi', 'Suresh']);
    expect(presence.musters.every((mu) => mu.tradeCode === 'mason' && mu.manualReason)).toBe(true);
    // unresolved only — the resolved observation never re-enters the Daily-Log active list
    expect(presence.mismatches.map((mm) => mm.id)).toEqual([open.id]);

    // the legacy aggregate CrewRow is DISPLAY-ONLY: a hostile 99-count stepper changes NO labour truth
    await dailyLog.start(p.id, pmc(p.id));
    const log = await t.prisma.dailyLog.findFirstOrThrow({ where: { projectId: p.id } });
    await t.prisma.crewRow.create({ data: { dailyLogId: log.id, trade: 'Mason', count: 99 } });
    expect((await teamOf(p.id, act)).v, 'the derived gate still fails on the unresolved mismatch').toBe('fail');
    const again = await capacity.presence(p.id, today, pmc(p.id));
    expect(again.musters).toHaveLength(2); // musters come from LabourAttendance, never the stepper
  });

  // ── §E handover + lifecycle preservation ─────────────────────────────────────────────────────

  it('§E HANDOVER: material resolved FIRST re-asserts the labour block; labour resolution then restores (never a silent drop)', async () => {
    const p = await freshProject();
    await capabilities.enable(p.id, MATERIALS_CAPABILITY, f.memberUser.id);
    await enableLabour(p.id);
    const decisionId = `DL-p4t5-${seq++}`;
    // Phase 6 task 4b: the two-option floor is judged at BOTH publication doors, so a row that
    // is published at INSERT arrives with zero options — it is born unpublished instead.
    await t.prisma.decision.create({ data: { id: decisionId, projectId: p.id, title: 'Flooring', room: 'Living', status: 'approved', photoSwatch: 'marble', publishedAt: null } });
    await t.prisma.decisionOption.createMany({ data: [
      { decisionId: decisionId, label: 'A', optionKey: 'a', material: 'A', delta: 0, swatch: 'marble', order: 0 },
      { decisionId: decisionId, label: 'B', optionKey: 'b', material: 'B', delta: 0, swatch: 'teak', order: 1 },
    ] });
    await t.prisma.decision.update({ where: { id: decisionId }, data: { publishedAt: new Date() } });

    const act = await freshActivity(p.id, { decisionId });
    await labourRequirement(p.id, act, [{ civilDate: today, personShiftQty: 1 }]);

    // material dispute blocks with the MATERIAL banner
    await dailyLog.start(p.id, pmc(p.id));
    await dailyLog.addMaterial(p.id, { name: 'Marble', qty: '20 boxes', zone: 'GF', swatch: 'marble', decisionId }, pmc(p.id));
    await dailyLog.flagMismatch(p.id, { decisionId }, pmc(p.id));
    expect(await activityRow(p.id, act)).toMatchObject({ status: 'blocked', gateMaterial: 'fail', block: 'Material ≠ approved' });

    // the labour dispute lands while already blocked — the material banner is NOT overwritten
    const lm = await recordMismatch(p.id, act);
    expect((await activityRow(p.id, act)).block).toBe('Material ≠ approved');

    // material resolved FIRST → the labour dispute is RE-ASSERTED, not dropped: still blocked,
    // banner handed over to labour, material gate honestly `wait` (never a fabricated ok)
    const mat = await t.prisma.siteMaterial.findFirstOrThrow({ where: { projectId: p.id, decisionId } });
    await dailyLog.resolveMismatch(p.id, { siteMaterialId: mat.id, resolution: 'right marble confirmed', reason: 'batch relabelled' }, pmc(p.id));
    expect(await activityRow(p.id, act)).toMatchObject({ status: 'blocked', gateMaterial: 'wait', block: LABOUR_MISMATCH_BLOCK });

    // labour resolved SECOND → the activity finally restores
    await capacity.resolveMismatch(p.id, lm.id, { resolution: 'crew corrected', reason: 'verified' }, pmc(p.id));
    expect(await activityRow(p.id, act)).toMatchObject({ status: 'not_started', block: null });
  });

  it('§E LIFECYCLE: awaiting_signoff is never operationally moved by a labour dispute (the derived gate still fails); in_progress IS blocked and restores to in_progress', async () => {
    const p = await freshProject();
    await enableLabour(p.id);

    const parked = await freshActivity(p.id);
    await labourRequirement(p.id, parked, [{ civilDate: today, personShiftQty: 1 }]);
    await t.prisma.activity.update({ where: { id: parked }, data: { status: 'awaiting_signoff' } });
    const pm = await recordMismatch(p.id, parked);
    expect((await activityRow(p.id, parked)).status, 'the pending completion claim is preserved').toBe('awaiting_signoff');
    expect((await teamOf(p.id, parked)).v, 'the mismatch FACT still fails the derived gate').toBe('fail');
    await capacity.resolveMismatch(p.id, pm.id, { resolution: 'x', reason: 'y' }, pmc(p.id));
    expect((await activityRow(p.id, parked)).status).toBe('awaiting_signoff');

    const running = await freshActivity(p.id);
    await labourRequirement(p.id, running, [{ civilDate: today, personShiftQty: 1 }]);
    await t.prisma.activity.update({ where: { id: running }, data: { status: 'in_progress', actualStartDate: new Date() } });
    const rm = await recordMismatch(p.id, running);
    expect(await activityRow(p.id, running)).toMatchObject({ status: 'blocked', block: LABOUR_MISMATCH_BLOCK });
    await capacity.resolveMismatch(p.id, rm.id, { resolution: 'x', reason: 'y' }, pmc(p.id));
    expect((await activityRow(p.id, running)).status, 'restores by recorded work state').toBe('in_progress');
  });

  // ── §E races (deterministic barrier, BOTH orderings) ─────────────────────────────────────────

  it('§E RACE resolve vs start — start first: refused on the mismatch FACT; the later resolve clears; a fresh start succeeds', async () => {
    const p = await freshProject();
    await enableLabour(p.id);
    const c = await coveredActivity(p.id);
    const m = await recordMismatch(p.id, c.activityId);
    await t.prisma.activity.update({ where: { id: c.activityId }, data: { status: 'not_started', block: null } });

    const [start, resolve] = await race(
      p.id,
      () => activities.start(p.id, c.activityId, pmc(p.id)),
      () => capacity.resolveMismatch(p.id, m.id, { resolution: 'raced', reason: 'r' }, pmc(p.id)),
    );
    expect(start.status).toBe('rejected');
    expect(String((start as PromiseRejectedResult).reason?.message)).toMatch(/team:.*mismatch/i);
    expect(resolve.status).toBe('fulfilled');
    await activities.start(p.id, c.activityId, pmc(p.id));
    expect((await activityRow(p.id, c.activityId)).status).toBe('in_progress');
  });

  it('§E RACE resolve vs start — resolve first: the start serialized behind it sees the closed register and succeeds', async () => {
    const p = await freshProject();
    await enableLabour(p.id);
    const c = await coveredActivity(p.id);
    const m = await recordMismatch(p.id, c.activityId);
    await t.prisma.activity.update({ where: { id: c.activityId }, data: { status: 'not_started', block: null } });

    const [resolve, start] = await race(
      p.id,
      () => capacity.resolveMismatch(p.id, m.id, { resolution: 'raced', reason: 'r' }, pmc(p.id)),
      () => activities.start(p.id, c.activityId, pmc(p.id)),
    );
    expect(resolve.status).toBe('fulfilled');
    expect(start.status).toBe('fulfilled');
    expect((await activityRow(p.id, c.activityId)).status).toBe('in_progress');
  });

  it('§E RACE record vs complete (Codex round 2, F-A): a completion committed MID-FLIGHT is never overwritten — the CAS observes awaiting_signoff, the claim survives, the FACT still fails the gate', async () => {
    const p = await freshProject();
    await enableLabour(p.id);
    const c = await coveredActivity(p.id);
    await t.prisma.activity.update({ where: { id: c.activityId }, data: { status: 'in_progress', actualStartDate: new Date() } });

    // Session A holds the Activity ROW lock — the shape a concurrent `activities.complete`
    // transaction holds while writing `awaiting_signoff` (complete does NOT take the readiness
    // lock, so the advisory-lock barrier cannot serialize this pair; only the row CAS can).
    let release!: () => void;
    let locked!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const held = new Promise<void>((r) => (locked = r));
    const holder = t.prisma.$transaction(async (htx) => {
      await htx.$queryRawUnsafe(`SELECT "id" FROM "Activity" WHERE "id" = '${c.activityId}' FOR UPDATE`);
      locked();
      await gate;
      // the completion claim commits while the mismatch command is blocked on this row
      await htx.$executeRawUnsafe(`UPDATE "Activity" SET "status" = 'awaiting_signoff' WHERE "id" = '${c.activityId}'`);
    }, { timeout: 20_000, maxWait: 10_000 });
    await held;

    const pending = recordMismatch(p.id, c.activityId);
    // condition-based barrier: the mismatch command must be BLOCKED on the held row lock before
    // the completion commits (never a fixed sleep). The first blocked statement is the
    // LabourMismatch INSERT itself — its composite activity FK takes a KEY SHARE lock on the
    // Activity row, which conflicts with the completion's row-exclusive write.
    try {
      for (let i = 0; ; i++) {
        const waiters = await t.prisma.$queryRaw<Array<{ c: number }>>`
          SELECT COUNT(*)::int AS c FROM pg_stat_activity
          WHERE wait_event_type = 'Lock'
            AND (query ILIKE '%"Activity"%' OR query ILIKE '%"LabourMismatch"%')`;
        if (waiters[0]!.c >= 1) break;
        if (i >= 400) throw new Error('barrier timeout: mismatch command never blocked on the Activity row');
        await new Promise((r) => setTimeout(r, 25));
      }
    } finally {
      release(); // even a barrier failure must free the held row lock — never wedge the suite
    }
    await holder;
    const m = await pending; // the observation itself is recorded — the FACT is never lost

    expect((await activityRow(p.id, c.activityId)).status, 'the pending completion claim SURVIVES').toBe('awaiting_signoff');
    expect((await activityRow(p.id, c.activityId)).block ?? null).toBeNull();
    expect(await t.prisma.domainEvent.count({ where: { projectId: p.id, eventType: 'activity.labour_blocked' } }), 'no block signal for a transition that did not happen').toBe(0);
    expect(await t.prisma.labourMismatch.count({ where: { projectId: p.id, id: m.id } })).toBe(1);
    expect((await teamOf(p.id, c.activityId)).v, 'the mismatch FACT still fails the derived gate').toBe('fail');
  });

  // ── §G projection freshness ──────────────────────────────────────────────────────────────────

  it('§G PROJECTION: activity.labour_blocked/unblocked refresh the activities projection — a caught-up projection shows both transitions; projection == live', async () => {
    const p = await freshProject();
    await enableLabour(p.id);
    const act = await freshActivity(p.id);
    await labourRequirement(p.id, act, [{ civilDate: today, personShiftQty: 1 }]);
    await applyProjection(p.id);

    const m = await recordMismatch(p.id, act);
    expect(await t.prisma.domainEvent.count({ where: { projectId: p.id, eventType: 'activity.labour_blocked' } })).toBe(1);
    await applyProjection(p.id);
    let proj = await query.projectionSlice(p.id);
    expect(proj.generation, 'served from a caught-up generation').not.toBeNull();
    expect(proj.slices.activities.find((a) => a.id === act)).toMatchObject({ status: 'blocked', block: LABOUR_MISMATCH_BLOCK });

    await capacity.resolveMismatch(p.id, m.id, { resolution: 'x', reason: 'y' }, pmc(p.id));
    expect(await t.prisma.domainEvent.count({ where: { projectId: p.id, eventType: 'activity.labour_unblocked' } })).toBe(1);
    await applyProjection(p.id);
    proj = await query.projectionSlice(p.id);
    const restored = proj.slices.activities.find((a) => a.id === act)!;
    expect(restored.status).toBe('not-started'); // the serialized DTO status (hyphenated)
    expect(restored.block ?? null).toBeNull();
  });

  // ── §I effort + output + productivity ────────────────────────────────────────────────────────

  it('§I EFFORT + PRODUCTIVITY: effortFor groups worked minutes; productivity = output ÷ effort per (civilDate, shift); zero effort → null', async () => {
    const p = await freshProject();
    await enableLabour(p.id);
    const act = await freshActivity(p.id);
    const req = await labourRequirement(p.id, act, [{ civilDate: today, personShiftQty: 2 }]);
    const w1 = await onboardWorker(p.id);
    const w2 = await onboardWorker(p.id);
    const a1 = await allocate(p.id, act, req.requirementId, w1);
    const a2 = await allocate(p.id, act, req.requirementId, w2);
    await muster(p.id, w1);
    await muster(p.id, w2);
    await capacity.recordWork(p.id, { allocationId: a1, workedMinutes: 480 }, pmc(p.id));
    await capacity.recordWork(p.id, { allocationId: a2, workedMinutes: 240 }, pmc(p.id));
    await activities.recordOutput(p.id, { activityId: act, civilDate: today, shift: 'day', quantity: '12', uom: 'm3', note: 'slab pour bay 2' }, pmc(p.id));

    const effort = await labourQuery.effortFor(p.id, { activityIds: [act] });
    expect(effort).toEqual([{ activityId: act, civilDate: today, shift: 'day', workedMinutes: 720 }]);

    const prod = await query.labourProductivity(p.id);
    const row = prod.activities.find((a) => a.activityId === act)!.rows.find((r) => r.civilDate === today && r.shift === 'day')!;
    expect(row).toMatchObject({ plannedPersonShifts: 2, presentWorkers: 2, workedMinutes: 720 });
    expect(row.outputs).toEqual([{ quantity: '12', uom: 'm3' }]);
    // 12 m3 over 12 worked hours → 1.000000 per hour, composed Activities-side (§I)
    expect(row.productivityPerHour).toEqual([{ uom: 'm3', quantityPerHour: '1.000000' }]);

    // an output with NO worked minutes reports null — never a division by zero or a fabricated rate
    const idle = await freshActivity(p.id);
    await activities.recordOutput(p.id, { activityId: idle, civilDate: today, shift: 'day', quantity: '3', uom: 'bags' }, pmc(p.id));
    const idleRow = (await query.labourProductivity(p.id)).activities.find((a) => a.activityId === idle)!.rows[0]!;
    expect(idleRow.workedMinutes).toBe(0);
    expect(idleRow.productivityPerHour).toBeNull();

    // Decimal fidelity (Codex round 2, F-E): a full-scale Decimal(18,6) quantity over exactly one
    // worked hour must come back EXACT — float64 arithmetic corrupts the 6-dp tail at this
    // magnitude (Number round-trip yields ...345673, not ...345678)
    const big = await freshActivity(p.id);
    const bigReq = await labourRequirement(p.id, big, [{ civilDate: today, personShiftQty: 1 }]);
    const w3 = await onboardWorker(p.id);
    const a3 = await allocate(p.id, big, bigReq.requirementId, w3);
    await capacity.recordWork(p.id, { allocationId: a3, workedMinutes: 60 }, pmc(p.id));
    await activities.recordOutput(p.id, { activityId: big, civilDate: today, shift: 'day', quantity: '123456789012.345678', uom: 't' }, pmc(p.id));
    const bigRow = (await query.labourProductivity(p.id)).activities.find((a) => a.activityId === big)!.rows.find((r) => r.civilDate === today)!;
    expect(bigRow.productivityPerHour).toEqual([{ uom: 't', quantityPerHour: '123456789012.345678' }]);
  });

  it('§I EVIDENCE: a photo cited as measured-output evidence is not deletable (409); an uncited photo still deletes', async () => {
    const p = await freshProject();
    await enableLabour(p.id);
    const act = await freshActivity(p.id);
    const cited = await freshMedia(p.id);
    const loose = await freshMedia(p.id);
    await activities.recordOutput(p.id, { activityId: act, civilDate: today, shift: 'day', quantity: '2', uom: 'm3', evidenceMediaId: cited }, pmc(p.id));

    await expect(media.remove(cited, pmc(p.id))).rejects.toMatchObject({ status: 409 });
    expect(await t.prisma.media.count({ where: { id: cited } }), 'the cited photo survives').toBe(1);
    expect(await media.remove(loose, pmc(p.id))).toBe(true);

    // cross-project AND nonexistent evidence are refused by the same-project composite FK — the
    // validation AUTHORITY (no Activities→Media read exists; the FK violation surfaces as a 400)
    const other = await freshProject();
    await enableLabour(other.id);
    const otherAct = await freshActivity(other.id);
    await expect(
      activities.recordOutput(other.id, { activityId: otherAct, civilDate: today, shift: 'day', quantity: '1', uom: 'm3', evidenceMediaId: cited }, pmc(other.id)),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      activities.recordOutput(other.id, { activityId: otherAct, civilDate: today, shift: 'day', quantity: '1', uom: 'm3', evidenceMediaId: 'MEDIA-DOES-NOT-EXIST' }, pmc(other.id)),
    ).rejects.toMatchObject({ status: 400 });
  });
});
