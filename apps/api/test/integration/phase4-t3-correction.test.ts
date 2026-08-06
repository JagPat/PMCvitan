import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { createTestApp, type TestApp } from './test-app';
import { createTwoProjectFixture, type TwoProjectFixture } from './fixtures';
import { RequirementsService } from '../../src/activities/requirements.service';
import { LabourService } from '../../src/labour/labour.service';
import { LabourProcurementService } from '../../src/labour/labour-procurement.service';
import { LabourCapacityService } from '../../src/labour/labour-capacity.service';
import { WorkerDevicesService } from '../../src/orgs/worker-devices.service';
import { MediaService } from '../../src/media/media.service';
import { VendorsService } from '../../src/procurement/vendors.service';
import { CapabilitiesService, LABOUR_CAPABILITY } from '../../src/platform/capabilities.service';
import type { AuthUser } from '../../src/common/auth';

/**
 * Phase 4 Task 3 CORRECTION — the four review findings, reproduce-first against live PostgreSQL.
 * Every probe here FAILED at `main` `cb589dd` (the merged Task-3 head) and passes after the fix.
 *
 *   F1 (P1) an allocation could name a requirement owned by a DIFFERENT activity — the two FKs
 *           were unrelated, so PostgreSQL accepted the incoherent row.
 *   F2 (P1) attendance was accepted with NO trusted evidence at all, and a nonexistent
 *           `evidenceMediaId` was accepted because no same-project Media FK existed.
 *   F3 (P1) the §F bound-3 trigger COUNTED without serializing, so two concurrent raw
 *           transactions each saw zero and BOTH committed against a quantity-1 commitment.
 *   F4 (P2) a CANCELLED requirement head still accepted new allocations (the labour spec is
 *           copied onto the cancellation revision), and cancellation ignored live allocations.
 */
describe('Phase 4 Task 3 correction — the four review findings (live PG)', () => {
  let t: TestApp;
  let f: TwoProjectFixture;
  let requirements: RequirementsService;
  let labour: LabourService;
  let commercial: LabourProcurementService;
  let capacity: LabourCapacityService;
  let devices: WorkerDevicesService;
  let media: MediaService;
  let vendors: VendorsService;
  let capabilities: CapabilitiesService;
  let seq = 0;

  const TRUNCATE =
    'TRUNCATE TABLE "Payment", "PaymentApproval", "BillDeductionRelease", "BillDeduction", "SodException", "SodGrant", "CertifiedMeasurementConsumption", "CertifiedAcceptanceConsumption", "BillCertificate", "DomainEvent", "OutboxDelivery", "ProcessedEvent", "ProjectionCursor", "ProjectionGeneration", "DecisionProjection", "DailyLogProjection", "DrawingsProjection", "InspectionsProjection", "ActivitiesProjection", "MaterialReadinessProjection", "LabourReadinessProjection", "LabourWorkFact", "WorkerAllocation", "LabourAttendance", "ApprovedSkillSubstitution", "CapacityPromise", "CapacityCommitment", "LabourPurchaseOrderLine", "LabourPurchaseOrderVersion", "LabourPurchaseOrder", "SupplierLabourQuoteLine", "SupplierLabourQuote", "LabourQuoteComparison", "LabourRfq", "LabourRequisitionLine", "LabourRequisition", "VendorLabourProfile", "ProjectVendor", "CommandExecution", "CrewMembership", "Crew", "WorkerDevice", "WorkerSkill", "Worker", "LabourDemandSlice", "LabourRequirementSpec", "LabourTrade", "LabourSkill", "MaterialRequirementSpec", "ActivityRequirement", "ActivityRequirementRoot", "DecisionApprovalRevision", "ProjectCapability", "Media" CASCADE';

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
    media = t.app.get(MediaService);
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
      ['auditLog', { projectId: { startsWith: 'it-p4x-' } }],
      ['activity', { projectId: { startsWith: 'it-p4x-' } }],
      ['membership', { projectId: { startsWith: 'it-p4x-' } }],
      ['project', { id: { startsWith: 'it-p4x-' } }],
    ] as const) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (t.prisma as any)[model].deleteMany({ where });
    }
  });

  // ── fixtures ──────────────────────────────────────────────────────────────────────────────────

  const freshProject = async (): Promise<string> => {
    const id = `it-p4x-${Date.now() % 1e6}-${seq++}`;
    await t.prisma.project.create({
      data: { id, orgId: f.orgA.id, name: id, short: 'P', descriptor: '', stage: 'x', siteCode: 'P', projStart: 'a', projEnd: 'b', elapsedPct: 0, todayDay: 0, milestonePct: 0, timeZone: 'Asia/Kolkata', scheduleStartDate: new Date('2026-06-01T00:00:00.000Z') },
    });
    await t.prisma.membership.create({ data: { projectId: id, userId: f.memberUser.id, role: 'pmc', status: 'active' } });
    return id;
  };
  const freshActivity = async (projectId: string): Promise<string> => {
    const id = `IT-P4X-ACT-${Date.now() % 1e6}-${seq++}`;
    await t.prisma.activity.create({ data: { id, projectId, name: `Act ${seq}`, zone: 'Zone 1', plannedStart: 0, plannedEnd: 10 } });
    return id;
  };
  const enableLabour = async (projectId: string): Promise<void> => {
    await capabilities.enable(projectId, LABOUR_CAPABILITY, f.memberUser.id);
    await labour.upsertTrade(projectId, { code: 'mason', name: 'Mason' }, pmc(projectId));
    await labour.upsertSkill(projectId, { code: 'bar-bending', name: 'Bar Bending' }, pmc(projectId));
  };
  const labourRequirement = async (
    projectId: string, activityId: string, slices: Array<{ civilDate: string; personShiftQty: number }>,
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
  /** a worker with a BOUND device — the trusted-evidence path the muster needs */
  const workerWithDevice = async (projectId: string): Promise<{ workerId: string; deviceId: string }> => {
    const workerId = await onboardWorker(projectId);
    const device = await t.prisma.workerDevice.create({ data: { projectId, token: `tok-${Date.now()}-${seq++}` } });
    await devices.bind(projectId, device.id, { workerId }, pmc(projectId));
    return { workerId, deviceId: device.id };
  };
  const freshMedia = async (projectId: string): Promise<string> => {
    const m = await t.prisma.media.create({
      data: { projectId, kind: 'attendance', mime: 'image/png', sizeBytes: 1, uploadedBy: f.memberUser.id },
    });
    return m.id;
  };
  /** an ISSUED labour PO line + its CapacityCommitment for ONE (civilDate, qty) slice */
  const committedCapacity = async (
    projectId: string, req: { requirementId: string; revision: number }, civilDate: string, qty: number,
  ): Promise<string> => {
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
    return (await commercial.commitCapacity(projectId, { poLineId: poLine.id, promisedDate: civilDate }, pmc(projectId))).id;
  };

  // ── F1 — the allocation must name the requirement's OWN activity ──────────────────────────────

  it('F1: an allocation naming a DIFFERENT activity than the requirement owns is refused (service + PostgreSQL)', async () => {
    const projectId = await freshProject();
    await enableLabour(projectId);
    const [ownActivity, otherActivity] = [await freshActivity(projectId), await freshActivity(projectId)];
    // the requirement belongs to `ownActivity`
    const req = await labourRequirement(projectId, ownActivity, [{ civilDate: '2026-08-10', personShiftQty: 1 }]);
    const workerId = await onboardWorker(projectId);

    // RED at cb589dd: the service validated the spec and the activity INDEPENDENTLY, so this
    // incoherent pairing was accepted and PostgreSQL had no constraint relating the two FKs.
    await expect(
      capacity.allocate(projectId, { activityId: otherActivity, requirementId: req.requirementId, civilDate: '2026-08-10', workerId }, pmc(projectId)),
    ).rejects.toMatchObject({ status: 400 });
    expect(await t.prisma.workerAllocation.count({ where: { projectId } })).toBe(0);

    // the coherent pairing still works, and its row carries the requirement's own activity
    const ok = await capacity.allocate(projectId, { activityId: ownActivity, requirementId: req.requirementId, civilDate: '2026-08-10', workerId }, pmc(projectId));
    expect(ok.allocations[0]!.activityId).toBe(ownActivity);

    // and a DIRECT SQL forgery of the same mismatch is unrepresentable — the demand-identity FK
    const template = await t.prisma.workerAllocation.findFirstOrThrow({ where: { projectId } });
    const other = await onboardWorker(projectId);
    await expect(
      t.prisma.$executeRawUnsafe(
        `INSERT INTO "WorkerAllocation" ("id","projectId","workerId","civilDate","shift","activityId","requirementId","originRevision","labourSpecFingerprint","allocatedById","sourceCommandId")
         VALUES ('f1-forged',$1,$2,DATE '2026-08-10',$3,$4,$5,$6,$7,$8,$9)`,
        projectId, other, template.shift, otherActivity, template.requirementId,
        template.originRevision, template.labourSpecFingerprint, template.allocatedById, template.sourceCommandId,
      ),
    ).rejects.toThrow(/foreign key|violates/i);
    expect(await t.prisma.workerAllocation.count({ where: { projectId } })).toBe(1);
  });

  // ── F2 — attendance needs trusted evidence ────────────────────────────────────────────────────

  it('F2: attendance with NO trusted evidence is refused; a manual muster is an explicit attributable exception', async () => {
    const projectId = await freshProject();
    await enableLabour(projectId);
    const { workerId, deviceId } = await workerWithDevice(projectId);

    // RED at cb589dd: deviceId and evidenceMediaId were BOTH optional, so this bare claim was
    // accepted and would have counted as execution readiness.
    await expect(
      capacity.recordAttendance(projectId, { workerId, civilDate: '2026-08-10', shift: 'day' }, pmc(projectId)),
    ).rejects.toMatchObject({ status: 400 });
    expect(await t.prisma.labourAttendance.count({ where: { projectId } })).toBe(0);

    // the DEVICE path (the worker's own bound device) is the canonical trusted muster
    const trusted = await capacity.recordAttendance(projectId, { workerId, civilDate: '2026-08-10', shift: 'day', deviceId }, pmc(projectId));
    expect(trusted).toMatchObject({ deviceId, manualReason: null });

    // the MANUAL path exists but is an EXPLICIT, attributable exception — never a silent default
    const worker2 = await onboardWorker(projectId);
    const manual = await capacity.recordAttendance(
      projectId, { workerId: worker2, civilDate: '2026-08-10', shift: 'day', manualReason: 'device battery dead; foreman vouched at the gate' }, pmc(projectId),
    );
    expect(manual.manualReason).toBe('device battery dead; foreman vouched at the gate');
    expect(manual.deviceId).toBeNull();
    expect(manual.recordedById).toBe(f.memberUser.id);
    // a manual muster is pmc authority (labour.override) — an engineer cannot vouch unsupported presence
    const worker3 = await onboardWorker(projectId);
    await expect(
      capacity.recordAttendance(projectId, { workerId: worker3, civilDate: '2026-08-10', shift: 'day', manualReason: 'no device' }, { ...pmc(projectId), role: 'engineer' } as AuthUser),
    ).rejects.toMatchObject({ status: 403 });

    // the DB seal: an evidence-free row is unrepresentable even by direct SQL
    const cmd = await t.prisma.commandExecution.findFirstOrThrow({ where: { projectId } });
    await expect(
      t.prisma.$executeRawUnsafe(
        `INSERT INTO "LabourAttendance" ("id","projectId","workerId","civilDate","shift","recordedById","sourceCommandId")
         VALUES ('f2-bare',$1,$2,DATE '2026-08-11','day',$3,$4)`,
        projectId, workerId, f.memberUser.id, cmd.id,
      ),
    ).rejects.toThrow(/evidence|violates check/i);
  });

  it('F2: `evidenceMediaId` must reference same-project Media, and cited media cannot be deleted', async () => {
    const projectId = await freshProject();
    await enableLabour(projectId);
    const { workerId, deviceId } = await workerWithDevice(projectId);

    // RED at cb589dd: a NONEXISTENT media id was accepted — there was no FK at all
    await expect(
      capacity.recordAttendance(projectId, { workerId, civilDate: '2026-08-10', shift: 'day', deviceId, evidenceMediaId: 'does-not-exist' }, pmc(projectId)),
    ).rejects.toThrow();
    expect(await t.prisma.labourAttendance.count({ where: { projectId } })).toBe(0);

    // a CROSS-PROJECT media id is likewise unrepresentable
    const otherProject = await freshProject();
    const foreignMedia = await freshMedia(otherProject);
    await expect(
      capacity.recordAttendance(projectId, { workerId, civilDate: '2026-08-10', shift: 'day', deviceId, evidenceMediaId: foreignMedia }, pmc(projectId)),
    ).rejects.toThrow();

    // the same-project selfie is accepted …
    const mediaId = await freshMedia(projectId);
    const recorded = await capacity.recordAttendance(projectId, { workerId, civilDate: '2026-08-10', shift: 'day', deviceId, evidenceMediaId: mediaId }, pmc(projectId));
    expect(recorded.evidenceMediaId).toBe(mediaId);

    // … and while it is CITED as presence evidence it can never be deleted (the muster is a fact)
    await expect(media.remove(mediaId, pmc(projectId))).rejects.toMatchObject({ status: 409 });
    expect(await t.prisma.media.count({ where: { projectId, id: mediaId } })).toBe(1);

    // revoking the muster does NOT free the media: a revoked observation survives as history and
    // still cites its evidence, so the evidence must survive with it
    await capacity.revokeAttendance(projectId, recorded.id, { reason: 'mis-mustered' }, pmc(projectId));
    await expect(media.remove(mediaId, pmc(projectId))).rejects.toMatchObject({ status: 409 });

    // an UNcited photo in the same project is still freely deletable
    const spare = await freshMedia(projectId);
    expect(await media.remove(spare, pmc(projectId))).toBe(true);
  });

  // ── F3 — §F bound 3 must be a REAL database invariant under concurrency ───────────────────────

  it('F3: two INDEPENDENT raw transactions drawing from a quantity-1 commitment — exactly one commits', async () => {
    const projectId = await freshProject();
    await enableLabour(projectId);
    const activityId = await freshActivity(projectId);
    const req = await labourRequirement(projectId, activityId, [{ civilDate: '2026-08-10', personShiftQty: 1 }]);
    const commitmentId = await committedCapacity(projectId, req, '2026-08-10', 1);
    const [w1, w2] = [await onboardWorker(projectId), await onboardWorker(projectId)];
    const spec = await t.prisma.labourRequirementSpec.findFirstOrThrow({ where: { projectId, requirementId: req.requirementId } });
    const project = await t.prisma.project.findFirstOrThrow({ where: { id: projectId }, select: { orgId: true } });
    // reserved-then-completed: the receipt protocol is DB-sealed (20270425000000), and a
    // directly minted `succeeded` row is exactly the forgery it refuses.
    const cmd = await t.prisma.$transaction(async (tx) => {
      const created = await tx.commandExecution.create({
        data: { scopeKind: 'project', organizationId: project.orgId, projectId, actorId: f.memberUser.id, commandType: 'labour.allocation.allocate', idempotencyKey: `f3-${seq++}`, requestHash: 'f3', status: 'reserved' },
      });
      await tx.commandExecution.update({
        where: { id: created.id }, data: { status: 'succeeded', resultRef: `fixture-${created.id}`, completedAt: new Date() },
      });
      return created;
    });

    // Two SEPARATE PrismaClients = two genuinely independent PostgreSQL sessions. Each opens a
    // transaction and inserts a drawing allocation; the test holds BOTH open until each has
    // issued its INSERT, so a count-only trigger sees zero in both (RED at cb589dd: both committed).
    const clientA = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });
    const clientB = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });
    const insert = (workerId: string, id: string) =>
      `INSERT INTO "WorkerAllocation" ("id","projectId","workerId","civilDate","shift","activityId","requirementId","originRevision","labourSpecFingerprint","capacityCommitmentId","allocatedById","sourceCommandId")
       VALUES ('${id}','${projectId}','${workerId}',DATE '2026-08-10','day','${activityId}','${req.requirementId}',${spec.revision},'${spec.labourSpecFingerprint}','${commitmentId}','${f.memberUser.id}','${cmd.id}')`;

    try {
      const outcomes = await Promise.allSettled([
        clientA.$transaction(async (tx) => {
          await tx.$executeRawUnsafe(insert(w1, 'f3-a'));
          // hold the transaction open so B's insert overlaps A's uncommitted row
          await new Promise((r) => setTimeout(r, 750));
        }, { timeout: 20_000, maxWait: 10_000 }),
        // start B slightly after A so A's insert is definitely in flight first
        new Promise((r) => setTimeout(r, 150)).then(() =>
          clientB.$transaction(async (tx) => {
            await tx.$executeRawUnsafe(insert(w2, 'f3-b'));
          }, { timeout: 20_000, maxWait: 10_000 }),
        ),
      ]);
      const committed = outcomes.filter((o) => o.status === 'fulfilled').length;
      expect(committed, 'exactly one raw transaction may draw the single committed person-shift').toBe(1);
    } finally {
      await clientA.$disconnect();
      await clientB.$disconnect();
    }

    const live = await t.prisma.workerAllocation.count({ where: { projectId, capacityCommitmentId: commitmentId, status: 'active' } });
    expect(live, '§F bound 3 is a DATABASE invariant, not merely a service one').toBe(1);
  });

  // ── F4 — a cancelled requirement head accepts no new allocations ──────────────────────────────

  it('F4: a CANCELLED requirement head refuses new allocations, and cancellation refuses to strand live ones', async () => {
    const projectId = await freshProject();
    await enableLabour(projectId);
    const activityId = await freshActivity(projectId);
    const req = await labourRequirement(projectId, activityId, [{ civilDate: '2026-08-10', personShiftQty: 2 }]);
    const [w1, w2] = [await onboardWorker(projectId), await onboardWorker(projectId)];

    // an active allocation BLOCKS cancellation — cancelling would strand real committed capacity
    const live = await capacity.allocate(projectId, { activityId, requirementId: req.requirementId, civilDate: '2026-08-10', workerId: w1 }, pmc(projectId));
    await expect(
      requirements.cancel(projectId, req.requirementId, { expectedRevision: req.revision, reason: 'scope dropped' }, pmc(projectId)),
    ).rejects.toMatchObject({ status: 409 });

    // release it, and cancellation proceeds (an explicit, attributable disposition)
    await capacity.release(projectId, live.allocations[0]!.id, { reason: 'scope dropped' }, pmc(projectId));
    const cancelled = await requirements.cancel(projectId, req.requirementId, { expectedRevision: req.revision, reason: 'scope dropped' }, pmc(projectId));
    expect(cancelled.status).toBe('cancelled');

    // RED at cb589dd: `headSpec()` read only the highest LabourRequirementSpec revision, and the
    // cancel copies the spec + slices forward, so this allocation SUCCEEDED against dead demand.
    await expect(
      capacity.allocate(projectId, { activityId, requirementId: req.requirementId, civilDate: '2026-08-10', workerId: w2 }, pmc(projectId)),
    ).rejects.toMatchObject({ status: 409 });
    expect(await t.prisma.workerAllocation.count({ where: { projectId, status: 'active' } })).toBe(0);

    // the DB seal: a direct insert against a cancelled head is unrepresentable too
    const spec = await t.prisma.labourRequirementSpec.findFirstOrThrow({ where: { projectId, requirementId: req.requirementId }, orderBy: { revision: 'desc' } });
    const cmd = await t.prisma.commandExecution.findFirstOrThrow({ where: { projectId } });
    await expect(
      t.prisma.$executeRawUnsafe(
        `INSERT INTO "WorkerAllocation" ("id","projectId","workerId","civilDate","shift","activityId","requirementId","originRevision","labourSpecFingerprint","allocatedById","sourceCommandId")
         VALUES ('f4-forged',$1,$2,DATE '2026-08-10','day',$3,$4,$5,$6,$7,$8)`,
        projectId, w2, activityId, req.requirementId, spec.revision, spec.labourSpecFingerprint, f.memberUser.id, cmd.id,
      ),
    ).rejects.toThrow(/cancelled/i);
  });
});
