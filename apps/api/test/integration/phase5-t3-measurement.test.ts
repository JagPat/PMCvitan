import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { createTestApp, type TestApp } from './test-app';
import { MediaService } from '../../src/media/media.service';
import { createTwoProjectFixture, type TwoProjectFixture } from './fixtures';
import { RequirementsService } from '../../src/activities/requirements.service';
import { ActivitiesService } from '../../src/activities/activities.service';
import { ActivityParticipant } from '../../src/activities/activity.participant';
import { LabourService } from '../../src/labour/labour.service';
import { LabourProcurementService } from '../../src/labour/labour-procurement.service';
import { LabourCapacityService } from '../../src/labour/labour-capacity.service';
import { VendorsService } from '../../src/procurement/vendors.service';
import { CommercialActivationService } from '../../src/commercial/commercial-activation.service';
import { CommercialMeasurementService } from '../../src/commercial/commercial-measurement.service';
import { CommercialBudgetQuery } from '../../src/commercial/commercial-budget.query';
import { CapabilitiesService, COMMERCIAL_CAPABILITY, LABOUR_CAPABILITY } from '../../src/platform/capabilities.service';
import type { AuthUser } from '../../src/common/auth';
import { takeMeasurementSchema } from '../../src/contracts';

/**
 * Phase 5 Task 3 — §D MEASUREMENT, proven live against PostgreSQL, reproduce-first.
 *
 *   5c   §D a measurement citing NO work output is refused; a PHYSICAL-unit output is accepted
 *        with no same-unit cap; the quantity cap is `EFFORT(poLine)`; and the same effort cannot
 *        be consumed by two PO lines
 *   5i   §0 `OUTPUT` is a PREDICATE, not a pool — two lines on one activity both measure against
 *        ONE output, each bounded by its OWN effort
 *   5k   §D measurement vs sign-off revert: a rejection can never leave a measurement standing
 *        against an activity whose sign-off was withdrawn
 *   5n   §0 `MEASURED` floor: record 100, correct −150 is REFUSED and the fold stays at 100
 *   5as  §D measurement is bounded by ORDERED authority too
 *   5bo  §D labour close-short cannot move the ordered line below MEASURED
 */
describe('Phase 5 Task 3 — §D measurement (live PG)', () => {
  let t: TestApp;
  let f: TwoProjectFixture;
  let requirements: RequirementsService;
  let activities: ActivitiesService;
  let activityParticipant: ActivityParticipant;
  let labour: LabourService;
  let labourCommercial: LabourProcurementService;
  let capacity: LabourCapacityService;
  let vendors: VendorsService;
  let activation: CommercialActivationService;
  let measurement: CommercialMeasurementService;
  let budgetQuery: CommercialBudgetQuery;
  let capabilities: CapabilitiesService;
  let seq = 0;

  const TRUNCATE =
    'TRUNCATE TABLE "VendorBillLine", "VendorBillVersion", "VendorBill", "DomainEvent", "OutboxDelivery", "ProcessedEvent", "ProjectionCursor", "ProjectionGeneration", "DecisionProjection", "DailyLogProjection", "DrawingsProjection", "InspectionsProjection", "ActivitiesProjection", "MaterialReadinessProjection", "LabourReadinessProjection", "Measurement", "BudgetException", "BudgetLine", "CommitmentAttribution", "CostHead", "LabourMismatchResolution", "LabourMismatch", "ActivityWorkOutput", "LabourWorkFact", "WorkerAllocation", "LabourAttendance", "ApprovedSkillSubstitution", "CapacityPromise", "CapacityCommitment", "LabourPurchaseOrderLine", "LabourPurchaseOrderVersion", "LabourPurchaseOrder", "SupplierLabourQuoteLine", "SupplierLabourQuote", "LabourQuoteComparison", "LabourRfq", "LabourRequisitionLine", "LabourRequisition", "VendorLabourProfile", "ProjectVendor", "CommandExecution", "CrewMembership", "Crew", "WorkerDevice", "WorkerSkill", "Worker", "LabourDemandSlice", "LabourRequirementSpec", "LabourTrade", "LabourSkill", "MaterialRequirementSpec", "ActivityRequirement", "ActivityRequirementRoot", "DecisionApprovalRevision", "ProjectCapability" CASCADE';

  const pmc = (projectId: string): AuthUser => ({ sub: f.memberUser.id, role: 'pmc', projectId }) as AuthUser;
  const contractor = (projectId: string): AuthUser => ({ sub: f.memberUser.id, role: 'contractor', projectId }) as AuthUser;
  const orgAdmin = (): AuthUser => ({ sub: f.ownerUser.id, role: 'pmc', projectId: '' }) as AuthUser;

  beforeAll(async () => {
    t = await createTestApp();
    f = await createTwoProjectFixture(t.prisma);
    requirements = t.app.get(RequirementsService);
    activities = t.app.get(ActivitiesService);
    activityParticipant = t.app.get(ActivityParticipant);
    labour = t.app.get(LabourService);
    labourCommercial = t.app.get(LabourProcurementService);
    capacity = t.app.get(LabourCapacityService);
    vendors = t.app.get(VendorsService);
    activation = t.app.get(CommercialActivationService);
    measurement = t.app.get(CommercialMeasurementService);
    budgetQuery = t.app.get(CommercialBudgetQuery);
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
      ['auditLog', { projectId: { startsWith: 'it-p5t3-' } }],
      ['media', { projectId: { startsWith: 'it-p5t3-' } }],
      ['activity', { projectId: { startsWith: 'it-p5t3-' } }],
      ['membership', { projectId: { startsWith: 'it-p5t3-' } }],
      ['project', { id: { startsWith: 'it-p5t3-' } }],
    ] as const) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (t.prisma as any)[model].deleteMany({ where });
    }
  });

  // ── fixtures (the Phase-4 labour chain, reused) ───────────────────────────────────────────────

  const freshProject = async (timeZone = 'Asia/Kolkata'): Promise<string> => {
    const id = `it-p5t3-${Date.now() % 1e6}-${seq++}`;
    await t.prisma.project.create({
      data: { id, orgId: f.orgA.id, name: id, short: 'P', descriptor: '', stage: 'x', siteCode: 'P', projStart: 'a', projEnd: 'b', elapsedPct: 0, todayDay: 0, milestonePct: 0, timeZone, scheduleStartDate: new Date('2026-06-01T00:00:00.000Z') },
    });
    await t.prisma.membership.create({ data: { projectId: id, userId: f.memberUser.id, role: 'pmc', status: 'active' } });
    await capabilities.enable(id, LABOUR_CAPABILITY, f.memberUser.id);
    await labour.upsertTrade(id, { code: 'mason', name: 'Mason' }, pmc(id));
    await labour.upsertTrade(id, { code: 'helper', name: 'Helper' }, pmc(id));
    await labour.upsertSkill(id, { code: 'bar-bending', name: 'Bar Bending' }, pmc(id));
    await activation.activate(id, f.memberUser.id, {
      costHeads: [{ code: 'CIVIL', name: 'Civil works' }], materialLines: [], labourLines: [], reason: 'pilot activation',
    });
    return id;
  };

  const freshActivity = async (projectId: string): Promise<string> => {
    const id = `IT-P5T3-ACT-${Date.now() % 1e6}-${seq++}`;
    await t.prisma.activity.create({ data: { id, projectId, name: `Act ${seq}`, zone: 'Zone 1', plannedStart: 0, plannedEnd: 10 } });
    return id;
  };

  /** the activity is DONE with its closing sign-off — the state §D requires before measuring */
  const signOff = (projectId: string, activityId: string) =>
    t.prisma.activity.updateMany({ where: { id: activityId, projectId }, data: { status: 'done', doneAt: new Date() } });

  const freshMedia = async (projectId: string): Promise<string> => {
    const row = await t.prisma.media.create({ data: { projectId, kind: 'progress', mime: 'image/jpeg', uploadedBy: f.memberUser.id, sizeBytes: 3 } });
    return row.id;
  };

  /** recorded physical progress — §0's OUTPUT predicate, in a PHYSICAL unit (sqm), not shifts */
  const recordOutput = async (projectId: string, activityId: string, quantity = '100', uom = 'sqm'): Promise<string> => {
    const out = await activities.recordOutput(projectId, {
      activityId, civilDate: '2026-08-10', shift: 'day', quantity, uom, evidenceMediaId: await freshMedia(projectId),
    }, pmc(projectId));
    return out.id;
  };

  const labourRequirement = async (
    projectId: string, activityId: string, civilDate: string, personShiftQty: number, tradeCode = 'mason',
    extraDates: readonly string[] = [],
  ): Promise<{ requirementId: string; revision: number }> => {
    const r = await requirements.create(projectId, {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      type: 'labour', activityId, tradeCode, skillCode: 'bar-bending', shift: 'day',
      // a requisition line may only name a slice the requirement actually DEMANDS, so a second
      // order line needs a second demand slice behind it
      demandSlices: [{ civilDate, personShiftQty }, ...extraDates.map((d) => ({ civilDate: d, personShiftQty }))],
      decisionId: null, responsibleId: null, criticality: 'normal', tolerance: null,
    } as any, pmc(projectId));
    return { requirementId: r.requirementId, revision: r.revision };
  };

  /** an ISSUED labour PO line + its committed capacity for ONE slice */
  const committedCapacity = async (
    projectId: string, req: { requirementId: string; revision: number }, civilDate: string, qty: number,
    opts: { extraSlice?: string } = {},
  ): Promise<{ commitmentId: string; poLineId: string; poId: string }> => {
    const vendor = await vendors.create(f.orgA.id, { name: `Supplier ${seq++}` }, orgAdmin());
    await vendors.bind(projectId, { vendorId: vendor.id }, pmc(projectId));
    const requisition = await labourCommercial.createRequisition(projectId, { title: `req ${seq++}`, lines: [
      { requirementId: req.requirementId, revision: req.revision, civilDate, personShiftQty: qty },
      // a SECOND slice left uncommitted keeps the PO version `partially_committed`, which is what
      // a close-short acts on — committing every line completes the version and close-short is
      // then correctly refused as a terminal-state transition
      ...(opts.extraSlice ? [{ requirementId: req.requirementId, revision: req.revision, civilDate: opts.extraSlice, personShiftQty: qty }] : []),
    ] }, pmc(projectId));
    const line = requisition.lines[0]!;
    await labourCommercial.submitRequisition(projectId, requisition.id, pmc(projectId));
    await labourCommercial.approveRequisition(projectId, requisition.id, pmc(projectId));
    const rfq = await labourCommercial.createRfq(projectId, { requisitionId: requisition.id }, pmc(projectId));
    await labourCommercial.recordQuote(projectId, rfq.id, { vendorId: vendor.id, validUntil: '2026-12-31', lines: [{ requisitionLineId: line.id, ratePerPersonShift: '1000', shiftPremium: '0', landedPerPersonShift: '1000', matchesSpecification: true }] }, pmc(projectId));
    await labourCommercial.createComparison(projectId, rfq.id, pmc(projectId));
    const quoteId = (await labourCommercial.readRfq(projectId, rfq.id, pmc(projectId))).quotes[0]!.id;
    await labourCommercial.approveComparison(projectId, rfq.id, { selectedQuoteId: quoteId, reason: 'single in-spec quote' }, pmc(projectId));
    const comparisonId = (await labourCommercial.readRfq(projectId, rfq.id, pmc(projectId))).comparison!.id;
    const po = await labourCommercial.createPo(projectId, { comparisonId, lines: requisition.lines.map((l) => ({ requisitionLineId: l.id, personShiftQty: qty })) }, pmc(projectId));
    const poLine = po.currentVersion.lines.find((l) => l.requisitionLineId === line.id)!;
    await labourCommercial.issuePo(projectId, po.id, { costHeads: po.currentVersion.lines.map((l) => ({ labourPoLineId: l.id, costHeadCode: 'CIVIL' })) }, pmc(projectId));
    const commitment = await labourCommercial.commitCapacity(projectId, { poLineId: poLine.id, promisedDate: civilDate }, pmc(projectId));
    return { commitmentId: commitment.id, poLineId: poLine.id, poId: po.id };
  };

  /**
   * Worked EFFORT DRAWN FROM a named commitment: `workers` × one full shift each.
   *
   * `capacityCommitmentId` is the whole point. §0's `EFFORT(poLine)` joins
   * `LabourWorkFact -> WorkerAllocation -> CapacityCommitment -> LabourPurchaseOrderLine`, so an
   * OWN-WORKFORCE allocation (no commitment) attributes to NO PO line — correctly, since nobody is
   * billing a supplier for it. Omitting it here made every probe read zero effort, which is the
   * fold telling the truth about a fixture that had not actually drawn supplier capacity.
   */
  const workShifts = async (
    projectId: string, activityId: string, req: { requirementId: string; revision: number },
    civilDate: string, commitmentId: string, workers: number, minutesEach = 720,
  ): Promise<void> => {
    for (let i = 0; i < workers; i += 1) {
      const w = await labour.onboardWorker(projectId, { name: `W${seq++}`, tradeCode: 'mason', skillCodes: ['bar-bending'], activeFrom: '2026-01-01' }, pmc(projectId));
      const { allocations } = await capacity.allocate(projectId, {
        activityId, requirementId: req.requirementId, civilDate, workerId: w.id, capacityCommitmentId: commitmentId,
      }, pmc(projectId));
      await capacity.recordWork(projectId, { allocationId: allocations[0]!.id, workedMinutes: minutesEach }, pmc(projectId));
    }
  };

  /**
   * A server-reserved one-shot command row, so a DIRECT hostile insert can satisfy the NOT NULL
   * `sourceCommandId` composite FK and be rejected by the seal under test rather than by provenance.
   */
  const freshCommand = async (projectId: string): Promise<string> => {
    const project = await t.prisma.project.findUniqueOrThrow({ where: { id: projectId }, select: { orgId: true } });
    // Reserved-then-completed, because the receipt protocol is DB-sealed (20270425000000) and a
    // directly minted `succeeded` row is exactly the forgery it refuses.
    const row = await t.prisma.$transaction(async (tx) => {
      const created = await tx.commandExecution.create({
        data: {
          scopeKind: 'project', organizationId: project.orgId, projectId, actorId: f.memberUser.id,
          commandType: 'test.hostile', idempotencyKey: `hostile-${(seq += 1)}`, requestHash: 'x', status: 'reserved',
        },
      });
      await tx.commandExecution.update({
        where: { id: created.id }, data: { status: 'succeeded', completedAt: new Date() },
      });
      return created;
    });
    return row.id;
  };

  /**
   * A SECOND measurable line inside an EXISTING project. The round-4 seals are about naming the
   * wrong work WITHIN one project — across projects the composite FKs already refuse it, so a
   * cross-project fixture would let those probes pass without exercising the seal at all.
   */
  const siblingLine = async (
    projectId: string, opts: { orderedQty?: number; civilDate?: string } = {},
  ): Promise<{ activityId: string; poLineId: string; outputId: string }> => {
    const civilDate = opts.civilDate ?? '2026-08-10';
    const qty = opts.orderedQty ?? 2;
    const activityId = await freshActivity(projectId);
    const req = await labourRequirement(projectId, activityId, civilDate, qty);
    const { poLineId, commitmentId } = await committedCapacity(projectId, req, civilDate, qty);
    await workShifts(projectId, activityId, req, civilDate, commitmentId, qty);
    const outputId = await recordOutput(projectId, activityId);
    await signOff(projectId, activityId);
    return { activityId, poLineId, outputId };
  };

  /** the whole chain: a signed-off activity with recorded output, a committed PO line, and effort */
  const measurableLine = async (
    opts: { orderedQty?: number; workedWorkers?: number; civilDate?: string; timeZone?: string } = {},
  ): Promise<{ projectId: string; activityId: string; poLineId: string; poId: string; outputId: string }> => {
    const civilDate = opts.civilDate ?? '2026-08-10';
    const orderedQty = opts.orderedQty ?? 2;
    const projectId = await freshProject(opts.timeZone);
    const activityId = await freshActivity(projectId);
    const req = await labourRequirement(projectId, activityId, civilDate, orderedQty);
    const { poLineId, poId, commitmentId } = await committedCapacity(projectId, req, civilDate, orderedQty);
    await workShifts(projectId, activityId, req, civilDate, commitmentId, opts.workedWorkers ?? orderedQty);
    const outputId = await recordOutput(projectId, activityId);
    await signOff(projectId, activityId);
    return { projectId, activityId, poLineId, poId, outputId };
  };

  // ── PROBE 5c — the evidence requirement and the EFFORT cap ────────────────────────────────────

  it('PROBE 5c (§D): a measurement needs cited output, accepts a PHYSICAL-unit one with no same-unit cap, and is capped by EFFORT', async () => {
    const { projectId, activityId, poLineId, outputId } = await measurableLine({ orderedQty: 2, workedWorkers: 2 });

    // NO cited output → refused. Sign-off alone would let a commercial actor author the ONLY
    // quantity evidence in the chain, and verification would then certify from commercial input
    // rather than from the Phase-1–4 facts this phase exists to consume.
    await expect(
      measurement.take(projectId, { labourPoLineId: poLineId, activityId, quantity: '1', citedOutputId: 'MISSING' }, pmc(projectId)),
    ).rejects.toMatchObject({ status: 409 });
    expect(await t.prisma.measurement.count({ where: { projectId } })).toBe(0);

    // the cited output is 100 SQM and the measurement is in PERSON-SHIFTS. A same-unit cap would
    // be unsatisfiable here — it would refuse a valid attended shift whenever progress is recorded
    // in a physical unit, or push teams to fabricate person-shift outputs to bill.
    const taken = await measurement.take(projectId, {
      labourPoLineId: poLineId, activityId, quantity: '2', citedOutputId: outputId,
    }, pmc(projectId));
    expect(taken.quantity).toBe('2');

    // EFFORT is the quantity cap: 2 workers × 720 minutes = 2 person-shifts, all consumed
    await expect(
      measurement.take(projectId, { labourPoLineId: poLineId, activityId, quantity: '0.5', citedOutputId: outputId }, pmc(projectId)),
    ).rejects.toMatchObject({ status: 409 });

    const register = await measurement.read(projectId, poLineId, pmc(projectId));
    expect(register.measured).toBe('2');
    expect(register.effort).toBe('2');
  });

  it('PROBE 5c (§0 EFFORT): the same worked effort cannot be consumed by two PO lines', async () => {
    // Two lines on ONE activity. Effort is joined through the commitment that FUNDED the
    // allocation, never fingerprint + slice, so line B cannot bill line A's attendance.
    const projectId = await freshProject();
    const activityId = await freshActivity(projectId);
    const reqA = await labourRequirement(projectId, activityId, '2026-08-10', 1);
    const reqB = await labourRequirement(projectId, activityId, '2026-08-11', 1);
    const a = await committedCapacity(projectId, reqA, '2026-08-10', 1);
    const b = await committedCapacity(projectId, reqB, '2026-08-11', 1);
    // effort exists ONLY under line A's commitment
    await workShifts(projectId, activityId, reqA, '2026-08-10', a.commitmentId, 1);
    const outputId = await recordOutput(projectId, activityId);
    await signOff(projectId, activityId);

    // A can measure its own shift…
    await measurement.take(projectId, { labourPoLineId: a.poLineId, activityId, quantity: '1', citedOutputId: outputId }, pmc(projectId));
    // …and B, which funded nothing, has ZERO attributable effort
    const registerB = await measurement.read(projectId, b.poLineId, pmc(projectId));
    expect(registerB.effort).toBe('0');
    await expect(
      measurement.take(projectId, { labourPoLineId: b.poLineId, activityId, quantity: '1', citedOutputId: outputId }, pmc(projectId)),
    ).rejects.toMatchObject({ status: 409 });
  });

  // ── PROBE 5i — OUTPUT is a PREDICATE, not a pool ──────────────────────────────────────────────

  it('PROBE 5i (§0): two PO lines measure against ONE output, each bounded by its OWN effort', async () => {
    const projectId = await freshProject();
    const activityId = await freshActivity(projectId);
    const mason = await labourRequirement(projectId, activityId, '2026-08-10', 1, 'mason');
    const helper = await labourRequirement(projectId, activityId, '2026-08-11', 1, 'mason');
    const m = await committedCapacity(projectId, mason, '2026-08-10', 1);
    const h = await committedCapacity(projectId, helper, '2026-08-11', 1);
    await workShifts(projectId, activityId, mason, '2026-08-10', m.commitmentId, 1);
    await workShifts(projectId, activityId, helper, '2026-08-11', h.commitmentId, 1);
    // ONE 100 sqm output — both crews worked to produce it
    const outputId = await recordOutput(projectId, activityId);
    await signOff(projectId, activityId);

    await measurement.take(projectId, { labourPoLineId: m.poLineId, activityId, quantity: '1', citedOutputId: outputId }, pmc(projectId));
    // the SECOND line is NOT blocked by the first: the output was never drawn down. Consuming it
    // would either block this line or push the team to fabricate a duplicate output row to bill
    // honest attendance — inventing evidence to satisfy an accounting artefact.
    const second = await measurement.take(projectId, { labourPoLineId: h.poLineId, activityId, quantity: '1', citedOutputId: outputId }, pmc(projectId));
    expect(second.citedOutputId).toBe(outputId);
    expect((await measurement.read(projectId, m.poLineId, pmc(projectId))).measured).toBe('1');
    expect((await measurement.read(projectId, h.poLineId, pmc(projectId))).measured).toBe('1');
  });

  // ── PROBE 5k — measurement vs sign-off revert ─────────────────────────────────────────────────

  it('PROBE 5k (§D): an unsigned activity cannot be measured, and a sign-off carrying a live measurement cannot be withdrawn', async () => {
    const { projectId, activityId, poLineId, outputId } = await measurableLine({ orderedQty: 1, workedWorkers: 1 });

    // the guard's other direction first: return the activity to execution and measuring is refused
    await t.prisma.activity.updateMany({ where: { id: activityId, projectId }, data: { status: 'in_progress', doneAt: null } });
    await expect(
      measurement.take(projectId, { labourPoLineId: poLineId, activityId, quantity: '1', citedOutputId: outputId }, pmc(projectId)),
    ).rejects.toMatchObject({ status: 409 });
    await signOff(projectId, activityId);

    await measurement.take(projectId, { labourPoLineId: poLineId, activityId, quantity: '1', citedOutputId: outputId }, pmc(projectId));

    // NOW the withdrawal guard: a rejected closing inspection would revert the sign-off, leaving an
    // IMMUTABLE measurement resting on evidence that no longer stands. Refused, naming the line.
    await expect(
      t.prisma.$transaction((tx) => activityParticipant.revertSignOff(tx, { projectId, activityId })),
    ).rejects.toMatchObject({ status: 409 });
    expect((await t.prisma.activity.findFirstOrThrow({ where: { id: activityId } })).status).toBe('done');

    // the ORDERING the guard insists on: correct the measurement to zero, THEN withdraw
    const row = await t.prisma.measurement.findFirstOrThrow({ where: { projectId, labourPoLineId: poLineId } });
    await measurement.correct(projectId, { measurementId: row.id, quantity: '-1', reason: 'work re-opened by the closing inspection' }, pmc(projectId));
    await t.prisma.$transaction((tx) => activityParticipant.revertSignOff(tx, { projectId, activityId }));
    expect((await t.prisma.activity.findFirstOrThrow({ where: { id: activityId } })).status).toBe('in_progress');
    // and BOTH rows survive — the correction is evidence, not an erasure
    expect(await t.prisma.measurement.count({ where: { projectId, labourPoLineId: poLineId } })).toBe(2);
  });

  // ── PROBE 5n — the MEASURED floor ─────────────────────────────────────────────────────────────

  it('PROBE 5n (§0): a correction below zero is REFUSED and the fold stays where it was', async () => {
    const { projectId, activityId, poLineId, outputId } = await measurableLine({ orderedQty: 2, workedWorkers: 2 });
    const taken = await measurement.take(projectId, { labourPoLineId: poLineId, activityId, quantity: '2', citedOutputId: outputId }, pmc(projectId));

    // −3 against a fold of 2 would leave −1: not a record of anything, and it would permanently
    // fail `BILLED_QTY <= MEASURED` for work that WAS done.
    await expect(
      measurement.correct(projectId, { measurementId: taken.id, quantity: '-3', reason: 'over-measured' }, pmc(projectId)),
    ).rejects.toMatchObject({ status: 409 });
    expect((await measurement.read(projectId, poLineId, pmc(projectId))).measured).toBe('2');

    // a LEGAL reduction lands, and the original row is untouched — a correction is a new row
    await measurement.correct(projectId, { measurementId: taken.id, quantity: '-0.5', reason: 'half a shift was a re-do' }, pmc(projectId));
    expect((await measurement.read(projectId, poLineId, pmc(projectId))).measured).toBe('1.5');
    const original = await t.prisma.measurement.findFirstOrThrow({ where: { id: taken.id } });
    expect(original.quantity.toString()).toBe('2');

    // …and PostgreSQL refuses to edit or delete either row
    await expect(
      t.prisma.$executeRawUnsafe(`UPDATE "Measurement" SET "quantity" = 99 WHERE "id" = $1`, taken.id),
    ).rejects.toThrow(/immutable/u);
    await expect(
      t.prisma.$executeRawUnsafe(`DELETE FROM "Measurement" WHERE "id" = $1`, taken.id),
    ).rejects.toThrow(/immutable/u);
  });

  // ── PROBE 5as — ORDERED authority bounds measurement ──────────────────────────────────────────

  it('PROBE 5as (§D): worked effort beyond the ORDERED quantity cannot be measured', async () => {
    // Getting EFFORT above ORDERED takes a real site event, and finding that out was worth the
    // trip: §F bound 3 caps LIVE allocations at the committed quantity, so simply adding a third
    // worker is refused at allocation. What is NOT capped is history — a supplier's worker leaves
    // mid-job and is REPLACED. Both people did real work, both work facts stand, and the ordered
    // authority is still 1 shift. That is precisely why §D bounds measurement by the ORDER as well
    // as by effort: without it, the replacement's shift becomes billable work nobody authorised.
    const projectId = await freshProject();
    const activityId = await freshActivity(projectId);
    const req = await labourRequirement(projectId, activityId, '2026-08-10', 1);
    const { poLineId, commitmentId } = await committedCapacity(projectId, req, '2026-08-10', 1);

    const first = await labour.onboardWorker(projectId, { name: `W${seq++}`, tradeCode: 'mason', skillCodes: ['bar-bending'], activeFrom: '2026-01-01' }, pmc(projectId));
    const a1 = await capacity.allocate(projectId, { activityId, requirementId: req.requirementId, civilDate: '2026-08-10', workerId: first.id, capacityCommitmentId: commitmentId }, pmc(projectId));
    await capacity.recordWork(projectId, { allocationId: a1.allocations[0]!.id, workedMinutes: 720 }, pmc(projectId));
    await capacity.release(projectId, a1.allocations[0]!.id, { reason: 'worker left the site' }, pmc(projectId));

    const replacement = await labour.onboardWorker(projectId, { name: `W${seq++}`, tradeCode: 'mason', skillCodes: ['bar-bending'], activeFrom: '2026-01-01' }, pmc(projectId));
    const a2 = await capacity.allocate(projectId, { activityId, requirementId: req.requirementId, civilDate: '2026-08-10', workerId: replacement.id, capacityCommitmentId: commitmentId }, pmc(projectId));
    await capacity.recordWork(projectId, { allocationId: a2.allocations[0]!.id, workedMinutes: 720 }, pmc(projectId));

    const outputId = await recordOutput(projectId, activityId);
    await signOff(projectId, activityId);

    const register = await measurement.read(projectId, poLineId, pmc(projectId));
    expect(register.effort).toBe('2');
    expect(register.orderedPersonShiftQty).toBe(1);

    // EFFORT alone would permit 3 — and because COMMITTED consumes measured person-shifts, the
    // forecast would carry a shift of unauthorised work long before any bill refused it.
    await expect(
      measurement.take(projectId, { labourPoLineId: poLineId, activityId, quantity: '2', citedOutputId: outputId }, pmc(projectId)),
    ).rejects.toMatchObject({ status: 409 });
    // the ordered quantity IS measurable
    await measurement.take(projectId, { labourPoLineId: poLineId, activityId, quantity: '1', citedOutputId: outputId }, pmc(projectId));
    expect((await measurement.read(projectId, poLineId, pmc(projectId))).measured).toBe('1');
  });

  // ── PROBE 5bo — close-short cannot cut the ordered line below MEASURED ────────────────────────

  it('PROBE 5bo (§D/§G): a labour close-short below MEASURED is refused; at or above it is permitted', async () => {
    // A close-short needs a version that is still `issued`/`partially_committed`, so the order
    // carries TWO slices and only the first is committed — the everyday shape of a close-short:
    // part of the order was sourced and the rest never will be.
    const { projectId, activityId, poLineId, poId, outputId } = await measurableLine({ orderedQty: 2, workedWorkers: 2 });
    await measurement.take(projectId, { labourPoLineId: poLineId, activityId, quantity: '2', citedOutputId: outputId }, pmc(projectId));

    // Committing the whole line COMPLETES the version, and a completed version is not closeable —
    // correctly, it is terminal. This probe is about the Task-3 measured floor, not that Task-2
    // transition, so the version is put back into the state a real partially-sourced order would
    // be in. Stated plainly because it IS a test-only setup step.
    await t.prisma.$executeRawUnsafe(
      `UPDATE "LabourPurchaseOrderVersion" SET "status" = 'partially_committed' WHERE "poId" = $1`, poId,
    );

    // Closing short KEEPS only the committed portion. Drop that below the measured 2 and the
    // ordered cap moves underneath work already agreed — Task 4 would then dispute the vendor's
    // honest 2-shift claim against an authority cut after the fact.
    await t.prisma.$executeRawUnsafe(`UPDATE "LabourPurchaseOrderLine" SET "committedQty" = 1 WHERE "id" = $1`, poLineId);
    await expect(
      labourCommercial.closeShortPo(projectId, poId, { reason: 'supplier withdrew' }, pmc(projectId)),
    ).rejects.toMatchObject({ status: 409 });
    expect((await t.prisma.labourPurchaseOrderVersion.findFirstOrThrow({ where: { projectId, poId }, orderBy: { version: 'desc' } })).status)
      .not.toBe('closed_short');

    // restore it to the measured figure and the close-short is PERMITTED — the practice may still
    // end the obligation, just not below work it agreed happened
    await t.prisma.$executeRawUnsafe(`UPDATE "LabourPurchaseOrderLine" SET "committedQty" = 2 WHERE "id" = $1`, poLineId);
    await labourCommercial.closeShortPo(projectId, poId, { reason: 'supplier withdrew the balance' }, pmc(projectId));
    expect((await t.prisma.labourPurchaseOrderVersion.findFirstOrThrow({ where: { projectId, poId }, orderBy: { version: 'desc' } })).status)
      .toBe('closed_short');
  });

  // ── Codex round-1 findings ────────────────────────────────────────────────────────────────────

  it('R1 (§D): effort is scoped to the MEASURED activity — another activity\'s sign-off cannot fund this line', async () => {
    // Line L funds work on activity A, which is NOT signed off. Activity B is signed off and has
    // its own recorded output. Naming B while pointing at L would pass the sign-off and evidence
    // checks against B and satisfy the quantity cap with A's work — an immutable measurement for a
    // line whose own activity nobody ever signed off.
    const projectId = await freshProject();
    const activityA = await freshActivity(projectId);
    const activityB = await freshActivity(projectId);
    const reqA = await labourRequirement(projectId, activityA, '2026-08-10', 1);
    const { poLineId, commitmentId } = await committedCapacity(projectId, reqA, '2026-08-10', 1);
    await workShifts(projectId, activityA, reqA, '2026-08-10', commitmentId, 1);

    const outputB = await recordOutput(projectId, activityB);
    await signOff(projectId, activityB);          // B is signed off…
    // …and A deliberately is NOT.

    await expect(
      measurement.take(projectId, { labourPoLineId: poLineId, activityId: activityB, quantity: '1', citedOutputId: outputB }, pmc(projectId)),
    ).rejects.toMatchObject({ status: 409 });
    expect(await t.prisma.measurement.count({ where: { projectId } })).toBe(0);
    // the register agrees: scoped to B, this line funded nothing
    expect((await measurement.read(projectId, poLineId, pmc(projectId))).effort).toBe('1');
  });

  it('R2 (§D): a DEFAULTED commitment authorises nothing, even while its version is still live', async () => {
    const { projectId, activityId, poLineId, outputId } = await measurableLine({ orderedQty: 1, workedWorkers: 1 });
    // the supplier reneges AFTER the work was recorded. The version can still read `issued`, but a
    // defaulted commitment can never be re-committed, so the line authorises nothing — measuring
    // its historical effort would move money into received-not-billed for an order nobody owes.
    const commitment = await t.prisma.capacityCommitment.findFirstOrThrow({ where: { projectId, poLineId } });
    await labourCommercial.defaultCapacity(projectId, commitment.id, pmc(projectId));

    await expect(
      measurement.take(projectId, { labourPoLineId: poLineId, activityId, quantity: '1', citedOutputId: outputId }, pmc(projectId)),
    ).rejects.toMatchObject({ status: 409 });
    expect(await t.prisma.measurement.count({ where: { projectId } })).toBe(0);
  });

  it('R3 (§D): `measuredOn` defaults to the PROJECT\'s civil day, not the server\'s UTC date', async () => {
    // This has to BITE at every hour, or it is vacuous for most of the day: with Asia/Kolkata the
    // site date differs from UTC only between 18:30 and 24:00 UTC, so the probe passed against the
    // very bug it was written for. UTC+14 and UTC-11 sit on opposite sides of the date line, so at
    // EVERY instant at least one of them is on a different civil date from UTC — pick whichever
    // currently is, and the assertion can never coincide with the UTC answer.
    const utcToday = new Date().toISOString().slice(0, 10);
    const civilIn = (tz: string) => new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date());
    const timeZone = civilIn('Pacific/Kiritimati') !== utcToday ? 'Pacific/Kiritimati' : 'Pacific/Midway';
    const siteToday = civilIn(timeZone);
    expect(siteToday, 'the chosen zone must differ from UTC or the probe proves nothing').not.toBe(utcToday);

    const { projectId, activityId, poLineId, outputId } = await measurableLine({ orderedQty: 1, workedWorkers: 1, timeZone });
    const taken = await measurement.take(projectId, { labourPoLineId: poLineId, activityId, quantity: '1', citedOutputId: outputId }, pmc(projectId));
    expect(taken.measuredOn).toBe(siteToday);
  });

  it('R4 (§D): a correction is bounded by the ROW it adjusts, not by the line total', async () => {
    const { projectId, activityId, poLineId, outputId } = await measurableLine({ orderedQty: 2, workedWorkers: 2 });
    const a = await measurement.take(projectId, { labourPoLineId: poLineId, activityId, quantity: '1', citedOutputId: outputId }, pmc(projectId));
    const b = await measurement.take(projectId, { labourPoLineId: poLineId, activityId, quantity: '1', citedOutputId: outputId }, pmc(projectId));

    // correcting A by −2 keeps the LINE total at a perfectly legal 0, but silently wipes B's
    // payable evidence with nothing naming or justifying a correction to B
    await expect(
      measurement.correct(projectId, { measurementId: a.id, quantity: '-2', reason: 'over-measured' }, pmc(projectId)),
    ).rejects.toMatchObject({ status: 409 });
    expect((await measurement.read(projectId, poLineId, pmc(projectId))).measured).toBe('2');

    // withdrawing A's OWN shift is permitted, and B is untouched
    await measurement.correct(projectId, { measurementId: a.id, quantity: '-1', reason: 'A was a re-do' }, pmc(projectId));
    expect((await measurement.read(projectId, poLineId, pmc(projectId))).measured).toBe('1');
    // …and A has nothing left to withdraw
    await expect(
      measurement.correct(projectId, { measurementId: a.id, quantity: '-1', reason: 'again' }, pmc(projectId)),
    ).rejects.toMatchObject({ status: 409 });
    // correcting B is the real path, and it works
    await measurement.correct(projectId, { measurementId: b.id, quantity: '-1', reason: 'B was a re-do too' }, pmc(projectId));
    expect((await measurement.read(projectId, poLineId, pmc(projectId))).measured).toBe('0');
  });

  it('R5 (§D): a REDUCING correction still works after the line stops being live', async () => {
    // `assertWorkEvidenceRevisable` tells an operator to correct a measurement to zero before
    // withdrawing a sign-off. If the line had since been cancelled, refusing every write on a dead
    // line made that correction impossible and left the activity permanently stuck on the very
    // evidence it was being told to withdraw.
    const { projectId, activityId, poLineId, poId, outputId } = await measurableLine({ orderedQty: 1, workedWorkers: 1 });
    const taken = await measurement.take(projectId, { labourPoLineId: poLineId, activityId, quantity: '1', citedOutputId: outputId }, pmc(projectId));

    // (a cancelled version must carry its reason — a Task-2 CHECK, satisfied here rather than
    // worked around, because a stamp-free cancellation is exactly what that seal exists to refuse)
    await t.prisma.$executeRawUnsafe(
      `UPDATE "LabourPurchaseOrderVersion" SET "status" = 'cancelled', "cancelReason" = $2 WHERE "poId" = $1`,
      poId, 'supplier withdrew entirely',
    );
    // a NEW positive measurement against the dead line is still refused…
    await expect(
      measurement.take(projectId, { labourPoLineId: poLineId, activityId, quantity: '1', citedOutputId: outputId }, pmc(projectId)),
    ).rejects.toMatchObject({ status: 409 });
    // …but withdrawing what was recorded is always permitted, and the sign-off can then be revoked
    await measurement.correct(projectId, { measurementId: taken.id, quantity: '-1', reason: 'order cancelled; work re-opened' }, pmc(projectId));
    expect((await measurement.read(projectId, poLineId, pmc(projectId))).measured).toBe('0');
    await t.prisma.$transaction((tx) => activityParticipant.revertSignOff(tx, { projectId, activityId }));
    expect((await t.prisma.activity.findFirstOrThrow({ where: { id: activityId } })).status).toBe('in_progress');
  });

  it('R6 (§D/§0b): the measured floor covers DEFAULT too, not just close-short', async () => {
    // Round 1's own fix created this: once `defaulted` maps to a live authority of 0, defaulting
    // cuts authority exactly as close-short does — and the floor was on only one of the two sites.
    const { projectId, activityId, poLineId, outputId } = await measurableLine({ orderedQty: 1, workedWorkers: 1 });
    await measurement.take(projectId, { labourPoLineId: poLineId, activityId, quantity: '1', citedOutputId: outputId }, pmc(projectId));
    const commitment = await t.prisma.capacityCommitment.findFirstOrThrow({ where: { projectId, poLineId } });

    // defaulting would take the live authority to 0 while an immutable 1-shift measurement stands,
    // leaving the budget carrying received-not-billed value for work no live order authorises
    await expect(
      labourCommercial.defaultCapacity(projectId, commitment.id, pmc(projectId)),
    ).rejects.toMatchObject({ status: 409 });
    expect((await t.prisma.capacityCommitment.findFirstOrThrow({ where: { id: commitment.id } })).status).not.toBe('defaulted');

    // the ordering the guard insists on: disclaim the work first, THEN the default is free
    const row = await t.prisma.measurement.findFirstOrThrow({ where: { projectId, labourPoLineId: poLineId } });
    await measurement.correct(projectId, { measurementId: row.id, quantity: '-1', reason: 'supplier never actually attended' }, pmc(projectId));
    await labourCommercial.defaultCapacity(projectId, commitment.id, pmc(projectId));
    expect((await t.prisma.capacityCommitment.findFirstOrThrow({ where: { id: commitment.id } })).status).toBe('defaulted');
  });

  it('R7 (§A): an impossible civil date is a 400 at the boundary, never a 500 from the parser', async () => {
    // `2026-02-31` is well-SHAPED and impossible. A shape regex lets it through and the service's
    // `fromIsoCivilDate` then throws a plain Error — an internal error for a plainly bad request.
    const { projectId, activityId, poLineId, outputId } = await measurableLine({ orderedQty: 1, workedWorkers: 1 });
    const parsed = takeMeasurementSchema.safeParse({
      labourPoLineId: poLineId, activityId, quantity: '1', citedOutputId: outputId, measuredOn: '2026-02-31',
    });
    expect(parsed.success).toBe(false);
    // …and a REAL date still parses, so the schema is precise rather than merely strict
    expect(takeMeasurementSchema.safeParse({
      labourPoLineId: poLineId, activityId, quantity: '1', citedOutputId: outputId, measuredOn: '2026-02-28',
    }).success).toBe(true);
  });

  it('R8 (§D): a correction may not target another correction — the tree stays ONE level deep', async () => {
    // A chain makes the row-level floor unsound: with A <- +1 <- -1, a direct-children `netOf`
    // reads A as 2 while its real subtree is 1, so a -2 correction to A passes the floor and eats
    // another row's evidence. Getting a correction wrong is fixed by a further delta on the SAME
    // original, which nets identically and keeps the tree flat.
    const { projectId, activityId, poLineId, outputId } = await measurableLine({ orderedQty: 2, workedWorkers: 2 });
    const a = await measurement.take(projectId, { labourPoLineId: poLineId, activityId, quantity: '1', citedOutputId: outputId }, pmc(projectId));
    await measurement.take(projectId, { labourPoLineId: poLineId, activityId, quantity: '1', citedOutputId: outputId }, pmc(projectId));
    const plusOne = await measurement.correct(projectId, { measurementId: a.id, quantity: '-0.5', reason: 'half of A was a re-do' }, pmc(projectId));

    await expect(
      measurement.correct(projectId, { measurementId: plusOne.id, quantity: '0.5', reason: 'undo that correction' }, pmc(projectId)),
    ).rejects.toMatchObject({ status: 409 });
    // …and PostgreSQL refuses it too, so a chain is unrepresentable rather than merely refused
    await expect(t.prisma.$executeRawUnsafe(
      `INSERT INTO "Measurement"("id","projectId","labourPoLineId","activityId","quantity","correctsId","reason","measuredOn","citedOutputId","takenById","sourceCommandId")
       SELECT 'HOSTILE-CHAIN',$1,$2,$3,0.5,$4,'forced','2026-08-10',$5,"takenById","sourceCommandId" FROM "Measurement" WHERE "id"=$4`,
      projectId, poLineId, activityId, plusOne.id, outputId,
    )).rejects.toThrow(/may not target another correction/u);

    // the real path — a further delta on the ORIGINAL — works and nets the same
    await measurement.correct(projectId, { measurementId: a.id, quantity: '0.5', reason: 'A stands after all' }, pmc(projectId));
    expect((await measurement.read(projectId, poLineId, pmc(projectId))).measured).toBe('2');
  });

  it('R9 (§D): an ORIGINAL measurement is POSITIVE at PostgreSQL; only a correction carries a sign', async () => {
    const { projectId, activityId, poLineId, outputId } = await measurableLine({ orderedQty: 1, workedWorkers: 1 });
    const row = await measurement.take(projectId, { labourPoLineId: poLineId, activityId, quantity: '1', citedOutputId: outputId }, pmc(projectId));

    // an original recording NEGATIVE work is not a record of anything, and because the row is
    // immutable such an insert would corrupt the register permanently and bypass every
    // service-side floor the sign-off and ordered guards reason over
    await expect(t.prisma.$executeRawUnsafe(
      `INSERT INTO "Measurement"("id","projectId","labourPoLineId","activityId","quantity","measuredOn","citedOutputId","takenById","sourceCommandId")
       SELECT 'HOSTILE-NEG',$1,$2,$3,-5,'2026-08-10',$4,"takenById","sourceCommandId" FROM "Measurement" WHERE "id"=$5`,
      projectId, poLineId, activityId, outputId, row.id,
    )).rejects.toThrow(/Measurement_quantity_check/u);
    expect((await measurement.read(projectId, poLineId, pmc(projectId))).measured).toBe('1');
  });

  it('R10 (§A): a stale or cross-project evidence photo is a 400, never a 500 from the FK', async () => {
    const { projectId, activityId, poLineId, outputId } = await measurableLine({ orderedQty: 1, workedWorkers: 1 });
    // a photo that does not exist at all
    await expect(measurement.take(projectId, {
      labourPoLineId: poLineId, activityId, quantity: '1', citedOutputId: outputId, evidenceMediaId: 'NO-SUCH-MEDIA',
    }, pmc(projectId))).rejects.toMatchObject({ status: 400 });
    // a photo belonging to ANOTHER project — the same-project composite FK is the authority
    const other = await freshProject();
    const foreign = await freshMedia(other);
    await expect(measurement.take(projectId, {
      labourPoLineId: poLineId, activityId, quantity: '1', citedOutputId: outputId, evidenceMediaId: foreign,
    }, pmc(projectId))).rejects.toMatchObject({ status: 400 });
    expect(await t.prisma.measurement.count({ where: { projectId } })).toBe(0);

    // …and this project's OWN photo is accepted, so the check is precise rather than merely strict
    const own = await freshMedia(projectId);
    const taken = await measurement.take(projectId, {
      labourPoLineId: poLineId, activityId, quantity: '1', citedOutputId: outputId, evidenceMediaId: own,
    }, pmc(projectId));
    expect(taken.evidenceMediaId).toBe(own);
  });

  // ── §D authority + the COMMITTED consumption term ─────────────────────────────────────────────

  it('§D/§I: measuring is pmc/engineer authority, and MEASURED consumes COMMITTED into received-not-billed', async () => {
    const { projectId, activityId, poLineId, outputId } = await measurableLine({ orderedQty: 2, workedWorkers: 2 });

    await expect(
      measurement.take(projectId, { labourPoLineId: poLineId, activityId, quantity: '1', citedOutputId: outputId }, contractor(projectId)),
    ).rejects.toMatchObject({ status: 403 });
    expect(await t.prisma.measurement.count({ where: { projectId } })).toBe(0);

    // the ₹2,000 order (2 shifts at ₹1,000) is wholly OUTSTANDING before measurement
    let position = (await t.prisma.$transaction((tx) => budgetQuery.positionsFor(tx, projectId, ['CIVIL']))).get('CIVIL')!;
    expect(position.committed.toString()).toBe('2000');
    expect(position.receivedNotBilled.toString()).toBe('0');

    // measuring HALF of it moves half the money to the received side — the buckets PARTITION, so
    // exposure is conserved and a ₹2,000 order never forecasts ₹4,000
    await measurement.take(projectId, { labourPoLineId: poLineId, activityId, quantity: '1', citedOutputId: outputId }, pmc(projectId));
    position = (await t.prisma.$transaction((tx) => budgetQuery.positionsFor(tx, projectId, ['CIVIL']))).get('CIVIL')!;
    expect(position.committed.toString()).toBe('1000');
    expect(position.receivedNotBilled.toString()).toBe('1000');
    expect(position.exposure.toString()).toBe('2000');
  });

  // ── Codex round 4 — the seals must hold against CONCURRENCY and DIRECT writers ────────────────

  it('R11 (§D): the correction-target seal is DEFERRED, and no concurrent interleaving lands a chain', async () => {
    // The seal now fires at COMMIT rather than BEFORE INSERT. What is actually reachable, measured
    // rather than assumed (the ground truth is in the packet):
    //
    //   • an UNCOMMITTED target is refused by the FK outright — PostgreSQL does NOT block and wait
    //     for it, the invisible row simply is not there ("Key … is not present");
    //   • a COMMITTED target is refused by the correction-target seal.
    //
    // The one gap between them is intra-statement: the BEFORE trigger's snapshot and the FK's are
    // taken at different moments, so a target committing between them was seen by the FK and missed
    // by the trigger. That window is real and cannot be hit deterministically from a test — which
    // is exactly why the check belongs at COMMIT, where no interleaving precedes it.
    expect(await t.prisma.$queryRawUnsafe<{ n: bigint }[]>(
      `SELECT COUNT(*)::int AS n FROM pg_trigger WHERE tgname = 'Measurement_correction_target' AND tgdeferrable AND tginitdeferred`,
    )).toEqual([{ n: 1 }]);

    const { projectId, activityId, poLineId, outputId } = await measurableLine({ orderedQty: 2, workedWorkers: 2 });
    const a = await measurement.take(projectId, { labourPoLineId: poLineId, activityId, quantity: '2', citedOutputId: outputId }, pmc(projectId));
    const cmd = (await t.prisma.measurement.findFirstOrThrow({ where: { projectId, id: a.id } })).sourceCommandId;
    const insert = (id: string, correctsId: string, qty: string) =>
      `INSERT INTO "Measurement"("id","projectId","labourPoLineId","activityId","quantity","correctsId","reason","measuredOn","citedOutputId","takenById","sourceCommandId")
       VALUES('${id}','${projectId}','${poLineId}','${activityId}',${qty},'${correctsId}','concurrent','2026-08-10','${outputId}','${f.memberUser.id}','${cmd}')`;

    // (1) session 1 holds correction B uncommitted; session 2 names it and is refused NOW
    const held = new PrismaClient();
    let release!: () => void; let inserted!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const bInserted = new Promise<void>((r) => { inserted = r; });
    const session1 = held.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(insert('R11-B', a.id, '-0.5'));
      inserted();
      await gate;
    }, { timeout: 30_000 });
    await bInserted;
    await expect(t.prisma.$executeRawUnsafe(insert('R11-C', 'R11-B', '0.5'))).rejects.toThrow(/not present|foreign key/iu);
    release();
    await session1;
    await held.$disconnect();

    // (2) now that B is committed, the DEFERRED seal refuses the same chain at commit
    await expect(t.prisma.$executeRawUnsafe(insert('R11-C', 'R11-B', '0.5')))
      .rejects.toThrow(/may not target another correction/u);

    // either way the register holds exactly one correction and the tree is ONE level deep
    const rows = await t.prisma.measurement.findMany({ where: { projectId }, select: { id: true, correctsId: true } });
    expect(rows.filter((r) => r.correctsId !== null).map((r) => r.id)).toEqual(['R11-B']);
    expect(rows.every((r) => r.correctsId === null || rows.find((x) => x.id === r.correctsId)!.correctsId === null)).toBe(true);
  });

  it('R12 (§D): a cited output must belong to the measuring activity AT PostgreSQL', async () => {
    // Project containment alone let a direct writer store activityId = A while citing B's output.
    // The row is immutable, so sign-off withdrawal and billing would read B's progress as A's
    // evidence permanently. The service already refused it; this proves the DATABASE does.
    const one = await measurableLine({ orderedQty: 1, workedWorkers: 1 });
    // a sibling activity in the SAME project, so ONLY the activity binding can reject the row
    const two = await siblingLine(one.projectId, { orderedQty: 1 });
    const cmd = await freshCommand(one.projectId);

    await expect(t.prisma.$executeRawUnsafe(
      `INSERT INTO "Measurement"("id","projectId","labourPoLineId","activityId","quantity","measuredOn","citedOutputId","takenById","sourceCommandId")
       VALUES('R12-X','${one.projectId}','${one.poLineId}','${one.activityId}',1,'2026-08-10','${two.outputId}','${f.memberUser.id}','${cmd}')`,
    )).rejects.toThrow();
    expect(await t.prisma.measurement.count({ where: { projectId: one.projectId, id: 'R12-X' } })).toBe(0);

    // the SAME insert citing this activity's OWN output is accepted — the seal is precise, and
    // without this the rejection above could be any of the row's other constraints
    await t.prisma.$executeRawUnsafe(
      `INSERT INTO "Measurement"("id","projectId","labourPoLineId","activityId","quantity","measuredOn","citedOutputId","takenById","sourceCommandId")
       VALUES('R12-OK','${one.projectId}','${one.poLineId}','${one.activityId}',1,'2026-08-10','${one.outputId}','${f.memberUser.id}','${cmd}')`,
    );
    expect(await t.prisma.measurement.count({ where: { projectId: one.projectId, id: 'R12-OK' } })).toBe(1);
  });

  it('R13 (§D): a correction carries the target row’s whole work identity', async () => {
    // A correction naming original A while describing B's line/activity/output would apply its
    // signed quantity to B while `netOf(A)` counted it as A's child — the register adding or
    // withdrawing payable evidence for a line the correction does not name.
    const one = await measurableLine({ orderedQty: 2, workedWorkers: 2 });
    // the other line lives in the SAME project, so only the identity binding can reject the row
    const two = await siblingLine(one.projectId, { orderedQty: 2 });
    const a = await measurement.take(one.projectId, { labourPoLineId: one.poLineId, activityId: one.activityId, quantity: '1', citedOutputId: one.outputId }, pmc(one.projectId));
    const cmd = await freshCommand(one.projectId);

    // same project, same target row — but the correction describes the OTHER line's work
    await expect(t.prisma.$executeRawUnsafe(
      `INSERT INTO "Measurement"("id","projectId","labourPoLineId","activityId","quantity","correctsId","reason","measuredOn","citedOutputId","takenById","sourceCommandId")
       VALUES('R13-X','${one.projectId}','${two.poLineId}','${two.activityId}',-1,'${a.id}','forged','2026-08-10','${two.outputId}','${f.memberUser.id}','${cmd}')`,
    )).rejects.toThrow();
    expect(await t.prisma.measurement.count({ where: { projectId: one.projectId, id: 'R13-X' } })).toBe(0);

    // the honest correction — same work as its target — is still accepted, so the seal is precise
    const ok = await measurement.correct(one.projectId, { measurementId: a.id, quantity: '-1', reason: 'over-measured' }, pmc(one.projectId));
    expect(ok.correctsId).toBe(a.id);
  });

  it('R14 (§D): a photo cited as measurement evidence cannot be deleted', async () => {
    const { projectId, activityId, poLineId, outputId } = await measurableLine({ orderedQty: 1, workedWorkers: 1 });
    const photo = await t.prisma.media.create({
      data: { projectId, kind: 'progress', mime: 'image/png', data: Buffer.from('x'), sizeBytes: 1, uploadedBy: f.memberUser.id },
    });
    await measurement.take(projectId, { labourPoLineId: poLineId, activityId, quantity: '1', citedOutputId: outputId, evidenceMediaId: photo.id }, pmc(projectId));

    // a CONTROLLED refusal (409), not the raw P2003 500 the bare FK produced
    await expect(t.app.get(MediaService).remove(photo.id, pmc(projectId))).rejects.toMatchObject({ status: 409 });
    expect(await t.prisma.media.count({ where: { id: photo.id } })).toBe(1);

    // an UNCITED photo on the same project still deletes — the guard is precise, not blanket
    const loose = await t.prisma.media.create({
      data: { projectId, kind: 'progress', mime: 'image/png', data: Buffer.from('y'), sizeBytes: 1, uploadedBy: f.memberUser.id },
    });
    expect(await t.app.get(MediaService).remove(loose.id, pmc(projectId))).toBe(true);
  });

  it('R15 (§D): the register reports the LIVE authority, not the frozen order', async () => {
    // The write path caps by live authority, so publishing only the frozen order stated a cap that
    // was not real: a closed-short line showed its original quantity while measurement above the
    // committed portion was refused.
    const { projectId, activityId, poLineId, poId, outputId } = await measurableLine({ orderedQty: 2, workedWorkers: 2 });
    await measurement.take(projectId, { labourPoLineId: poLineId, activityId, quantity: '1', citedOutputId: outputId }, pmc(projectId));

    let register = await measurement.read(projectId, poLineId, pmc(projectId));
    expect(register.orderedPersonShiftQty).toBe(2);
    expect(register.liveAuthorityPersonShiftQty).toBe(2);
    expect(register.defaulted).toBe(false);

    // close short to the 1 shift already measured: the ORDER is history, the AUTHORITY is now 1.
    // (A close-short needs a version still `issued`/`partially_committed` and keeps only the
    // committed portion — the probe-5bo setup, since fully committing the order completes it.)
    await t.prisma.$executeRawUnsafe(
      `UPDATE "LabourPurchaseOrderVersion" SET "status" = 'partially_committed' WHERE "poId" = $1`, poId,
    );
    await t.prisma.$executeRawUnsafe(`UPDATE "LabourPurchaseOrderLine" SET "committedQty" = 1 WHERE "id" = $1`, poLineId);
    await labourCommercial.closeShortPo(projectId, poId, { reason: 'supplier withdrew the balance' }, pmc(projectId));
    register = await measurement.read(projectId, poLineId, pmc(projectId));
    expect(register.orderedPersonShiftQty).toBe(2);
    expect(register.liveAuthorityPersonShiftQty).toBe(1);
    // …and the published cap is the one the write path actually enforces
    await expect(
      measurement.take(projectId, { labourPoLineId: poLineId, activityId, quantity: '1', citedOutputId: outputId }, pmc(projectId)),
    ).rejects.toMatchObject({ status: 409 });
  });

  // ── §D — the surface is absent off-pilot ──────────────────────────────────────────────────────

  it('§D: a project without the commercial capability has no measurement surface and no rows', async () => {
    const projectId = await freshProject();
    await t.prisma.projectCapability.deleteMany({ where: { projectId, capability: COMMERCIAL_CAPABILITY } });
    const activityId = await freshActivity(projectId);
    await expect(
      measurement.take(projectId, { labourPoLineId: 'X', activityId, quantity: '1', citedOutputId: 'Y' }, pmc(projectId)),
    ).rejects.toMatchObject({ status: 404 });
    await expect(measurement.read(projectId, 'X', pmc(projectId))).rejects.toMatchObject({ status: 404 });
    expect(await t.prisma.measurement.count({ where: { projectId } })).toBe(0);
  });
});
