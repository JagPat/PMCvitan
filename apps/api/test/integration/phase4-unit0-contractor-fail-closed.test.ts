import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { ROLE_POLICY } from '@vitan/shared';
import { createTestApp, type TestApp } from './test-app';
import { createTwoProjectFixture, type TwoProjectFixture } from './fixtures';
import { RequirementsService } from '../../src/activities/requirements.service';
import { ActivitiesService } from '../../src/activities/activities.service';
import { LabourService } from '../../src/labour/labour.service';
import { LabourCapacityService } from '../../src/labour/labour-capacity.service';
import { WorkerDevicesService } from '../../src/orgs/worker-devices.service';
import { CapabilitiesService, LABOUR_CAPABILITY } from '../../src/platform/capabilities.service';
import type { AuthUser } from '../../src/common/auth';

/**
 * Contractor capture UNIT 0 (docs/ux/CONTRACTOR_CAPTURE_PROPOSAL.md §4 item 0) — FAIL CLOSED,
 * proven live against PostgreSQL, reproduce-first.
 *
 * The three §C capture writes carry an intentional CONTRACTOR grant (§1.5: the seals make the
 * recording party untrusted by construction), but NO ownership relation ties a record to the
 * calling party: `recordWork` validates allocation liveness and live demand, `recordOutput`
 * validates activity containment, and neither names the caller — so through the open API
 * contractor A could submit contractor B's ids and mint immutable evidence (§2). Until the
 * ownership units land, each write refuses a contractor caller INSIDE its transaction.
 *
 * REPRODUCE-FIRST: every "fail closed" probe here is RED at the base `7ba95421` — the same
 * contractor-token calls SUCCEED there (the §2 exposure, demonstrated rather than asserted) —
 * and GREEN with unit 0 applied. The pmc/engineer probes pass at BOTH heads: behaviour for the
 * office roles is byte-untouched, and the grants themselves stay declared (this is unit 0,
 * not the refused O3).
 */
describe('Contractor capture unit 0 — the three §C writes fail closed for a contractor (live PG)', () => {
  let t: TestApp;
  let f: TwoProjectFixture;
  let requirements: RequirementsService;
  let activities: ActivitiesService;
  let labour: LabourService;
  let capacity: LabourCapacityService;
  let devices: WorkerDevicesService;
  let capabilities: CapabilitiesService;
  let seq = 0;

  const TRUNCATE =
    'TRUNCATE TABLE "DomainEvent", "OutboxDelivery", "ProcessedEvent", "ProjectionCursor", "ProjectionGeneration", "LabourReadinessProjection", "ActivitiesProjection", "LabourMismatchResolution", "LabourMismatch", "ActivityWorkOutput", "LabourWorkFact", "WorkerAllocation", "LabourAttendance", "ApprovedSkillSubstitution", "CommandExecution", "CrewMembership", "Crew", "WorkerDevice", "WorkerSkill", "Worker", "LabourDemandSlice", "LabourRequirementSpec", "LabourTrade", "LabourSkill", "MaterialRequirementSpec", "ActivityRequirement", "ActivityRequirementRoot", "ProjectCapability" CASCADE';

  const pmc = (projectId: string): AuthUser => ({ sub: f.memberUser.id, role: 'pmc', projectId }) as AuthUser;

  beforeAll(async () => {
    t = await createTestApp();
    f = await createTwoProjectFixture(t.prisma);
    requirements = t.app.get(RequirementsService);
    activities = t.app.get(ActivitiesService);
    labour = t.app.get(LabourService);
    capacity = t.app.get(LabourCapacityService);
    devices = t.app.get(WorkerDevicesService);
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
      ['auditLog', { projectId: { startsWith: 'it-p4u0-' } }],
      ['activity', { projectId: { startsWith: 'it-p4u0-' } }],
      ['membership', { projectId: { startsWith: 'it-p4u0-' } }],
      ['user', { id: { startsWith: 'u-p4u0-' } }],
      ['project', { id: { startsWith: 'it-p4u0-' } }],
    ] as const) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (t.prisma as any)[model].deleteMany({ where });
    }
  });

  // ── fixtures (the Task-3 suite's shapes, trimmed to what unit 0 needs) ────────────────────────

  const freshProject = async (): Promise<string> => {
    const id = `it-p4u0-${Date.now() % 1e6}-${seq++}`;
    await t.prisma.project.create({
      data: { id, orgId: f.orgA.id, name: id, short: 'P', descriptor: '', stage: 'x', siteCode: 'P', projStart: 'a', projEnd: 'b', elapsedPct: 0, todayDay: 0, milestonePct: 0, timeZone: 'Asia/Kolkata', scheduleStartDate: new Date('2026-06-01T00:00:00.000Z') },
    });
    await t.prisma.membership.create({ data: { projectId: id, userId: f.memberUser.id, role: 'pmc', status: 'active' } });
    return id;
  };
  /** an ACTIVE member of the fresh project holding the given role, with a matching token */
  const memberToken = async (projectId: string, role: 'contractor' | 'engineer'): Promise<AuthUser> => {
    const u = await t.prisma.user.create({
      data: { id: `u-p4u0-${Date.now() % 1e6}-${seq++}`, projectId, role, name: `${role} probe`, email: `p4u0-${Date.now() % 1e6}-${seq++}@probe.test` },
    });
    await t.prisma.membership.create({ data: { projectId, userId: u.id, role, status: 'active' } });
    return { sub: u.id, role, projectId } as AuthUser;
  };
  const freshActivity = async (projectId: string): Promise<string> => {
    const id = `IT-P4U0-ACT-${Date.now() % 1e6}-${seq++}`;
    await t.prisma.activity.create({ data: { id, projectId, name: `Act ${seq}`, zone: 'Zone 1', plannedStart: 0, plannedEnd: 10 } });
    return id;
  };
  const enableLabour = async (projectId: string): Promise<void> => {
    await capabilities.enable(projectId, LABOUR_CAPABILITY, f.memberUser.id);
    await labour.upsertTrade(projectId, { code: 'mason', name: 'Mason' }, pmc(projectId));
    await labour.upsertSkill(projectId, { code: 'bar-bending', name: 'Bar Bending' }, pmc(projectId));
  };
  const onboardWorker = async (projectId: string): Promise<string> => {
    const w = await labour.onboardWorker(projectId, { name: `W${seq++}`, tradeCode: 'mason', skillCodes: ['bar-bending'], activeFrom: '2026-01-01', activeTo: null }, pmc(projectId));
    return w.id;
  };
  const boundDevice = async (projectId: string, workerId: string): Promise<string> => {
    const device = await t.prisma.workerDevice.create({ data: { projectId, token: `tok-p4u0-${Date.now()}-${seq++}` } });
    await devices.bind(projectId, device.id, { workerId }, pmc(projectId));
    return device.id;
  };
  /** an ACTIVE allocation for `workerId` on 2026-08-10/day, created by the pmc (unchanged authority) */
  const activeAllocation = async (projectId: string, activityId: string, workerId: string): Promise<string> => {
    const r = await requirements.create(
      projectId,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { type: 'labour', activityId, tradeCode: 'mason', skillCode: 'bar-bending', shift: 'day', demandSlices: [{ civilDate: '2026-08-10', personShiftQty: 2 }], decisionId: null, responsibleId: null, criticality: 'normal', tolerance: null } as any,
      pmc(projectId),
    );
    const a = await capacity.allocate(projectId, { activityId, requirementId: r.requirementId, civilDate: '2026-08-10', workerId }, pmc(projectId));
    return a.id;
  };
  const failClosed = { status: 403, message: expect.stringContaining('Contractor capture is fail-closed') };

  // ── the three refusals (each RED at the base: the same call SUCCEEDS there) ───────────────────

  it('UNIT 0 · labour.work.record — a contractor token cannot book effort under ANY allocation, and nothing is appended', async () => {
    const projectId = await freshProject();
    await enableLabour(projectId);
    const act = await freshActivity(projectId);
    const workerId = await onboardWorker(projectId);
    const allocationId = await activeAllocation(projectId, act, workerId);
    const contractor = await memberToken(projectId, 'contractor');

    // The §2 exposure: the allocation was created by the pmc — from the contractor's view it is
    // "another party's id" (no relation says otherwise, which is the whole point). At the base
    // this call SUCCEEDS and mints an immutable LabourWorkFact.
    await expect(
      capacity.recordWork(projectId, { allocationId, civilDate: '2026-08-10', shift: 'day', workedMinutes: 60 }, contractor),
    ).rejects.toMatchObject(failClosed);
    // fail closed means NOTHING appended — the refusal is inside the transaction
    expect(await t.prisma.labourWorkFact.count({ where: { projectId } })).toBe(0);
  });

  it('UNIT 0 · attendance.record — a contractor token cannot muster even with the worker\'s BOUND device, and nothing is appended', async () => {
    const projectId = await freshProject();
    await enableLabour(projectId);
    const workerId = await onboardWorker(projectId);
    const deviceId = await boundDevice(projectId, workerId);
    const contractor = await memberToken(projectId, 'contractor');

    // The deviceId branch is the path §1.4 leaves open to site roles, and the id is valid and
    // bound — citation-only evidence in a contractor's hands. At the base this call SUCCEEDS.
    await expect(
      capacity.recordAttendance(projectId, { workerId, civilDate: '2026-08-10', shift: 'day', deviceId }, contractor),
    ).rejects.toMatchObject(failClosed);
    expect(await t.prisma.labourAttendance.count({ where: { projectId } })).toBe(0);
  });

  it('UNIT 0 · activity.output.record — a contractor token cannot record output on ANY activity, and nothing is appended', async () => {
    const projectId = await freshProject();
    await enableLabour(projectId);
    const act = await freshActivity(projectId);
    const contractor = await memberToken(projectId, 'contractor');

    // recordOutput validates only activity containment — the schema carries no worker or party
    // fact at all (§1.3), so at the base ANY contractor token can write output here. SUCCEEDS
    // at the base; refused by unit 0.
    await expect(
      activities.recordOutput(projectId, { activityId: act, civilDate: '2026-08-10', shift: 'day', quantity: '5', uom: 'm3' }, contractor),
    ).rejects.toMatchObject(failClosed);
    expect(await t.prisma.activityWorkOutput.count({ where: { projectId } })).toBe(0);
  });

  // ── what unit 0 does NOT change ───────────────────────────────────────────────────────────────

  it('UNTOUCHED · pmc and engineer still record attendance, work and output exactly as before (green at BOTH heads)', async () => {
    const projectId = await freshProject();
    await enableLabour(projectId);
    const act = await freshActivity(projectId);
    const workerId = await onboardWorker(projectId);
    const deviceId = await boundDevice(projectId, workerId);
    const allocationId = await activeAllocation(projectId, act, workerId);
    const engineer = await memberToken(projectId, 'engineer');

    // engineer: the device-evidenced muster + effort + output
    const muster = await capacity.recordAttendance(projectId, { workerId, civilDate: '2026-08-10', shift: 'day', deviceId }, engineer);
    expect(muster).toMatchObject({ workerId, civilDate: '2026-08-10', shift: 'day' });
    const work = await capacity.recordWork(projectId, { allocationId, civilDate: '2026-08-10', shift: 'day', workedMinutes: 60 }, engineer);
    expect(work.workedMinutes).toBe(60);
    const out = await activities.recordOutput(projectId, { activityId: act, civilDate: '2026-08-10', shift: 'day', quantity: '5', uom: 'm3' }, engineer);
    expect(out.id).toBeTruthy();

    // pmc: the manual-exception muster (labour.override, the OTHER evidence branch) + effort + output
    const manual = await capacity.recordAttendance(projectId, { workerId, civilDate: '2026-08-10', shift: 'night', manualReason: 'device battery dead — verified at the gate' }, pmc(projectId));
    expect(manual.shift).toBe('night');
    const work2 = await capacity.recordWork(projectId, { allocationId, civilDate: '2026-08-10', shift: 'day', workedMinutes: 30 }, pmc(projectId));
    expect(work2.workedMinutes).toBe(30);
    const out2 = await activities.recordOutput(projectId, { activityId: act, civilDate: '2026-08-10', shift: 'night', quantity: '2', uom: 'm3' }, pmc(projectId));
    expect(out2.id).toBeTruthy();
  });

  it('NOT O3 · the three contractor grants stay DECLARED in ROLE_POLICY — unit 0 refuses at the service, it does not trim the policy', () => {
    expect(ROLE_POLICY['attendance.record']).toContain('contractor');
    expect(ROLE_POLICY['labour.work.record']).toContain('contractor');
    expect(ROLE_POLICY['activity.output.record']).toContain('contractor');
  });
});
