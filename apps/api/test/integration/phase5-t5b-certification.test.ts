import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { Prisma, PrismaClient } from '@prisma/client';
import { createTestApp, type TestApp } from './test-app';
import { createTwoProjectFixture, type TwoProjectFixture } from './fixtures';
import { RequirementsService } from '../../src/activities/requirements.service';
import { ProcurementService } from '../../src/procurement/procurement.service';
import { PurchaseOrdersService } from '../../src/procurement/purchase-orders.service';
import { VendorsService } from '../../src/procurement/vendors.service';
import { InventoryService } from '../../src/inventory/inventory.service';
import { LabourService } from '../../src/labour/labour.service';
import { LabourProcurementService } from '../../src/labour/labour-procurement.service';
import { LabourCapacityService } from '../../src/labour/labour-capacity.service';
import { ActivitiesService } from '../../src/activities/activities.service';
import { ActivityParticipant } from '../../src/activities/activity.participant';
import { CommercialActivationService } from '../../src/commercial/commercial-activation.service';
import { CommercialBillService } from '../../src/commercial/commercial-bill.service';
import { CommercialVerificationService } from '../../src/commercial/commercial-verification.service';
import { CommercialCertificationService } from '../../src/commercial/commercial-certification.service';
import { CommercialMeasurementService } from '../../src/commercial/commercial-measurement.service';
import { CapabilitiesService, LABOUR_CAPABILITY, MATERIALS_CAPABILITY } from '../../src/platform/capabilities.service';
import type { AuthUser } from '../../src/common/auth';
import type { CreateRequirementInput } from '../../src/contracts';

/**
 * Phase 5 Task 5B — §E/§F/§G/§I CERTIFICATION, proven live against PostgreSQL, reproduce-first.
 *
 * The centre of this file is the FROZEN CONSUMPTION SET. A certificate that recorded only an amount
 * would let the evidence underneath it be swapped after the fact, and §E is explicit that neither
 * half of `(rowId, consumedQty)` is sufficient alone — so every guard probe here comes in a PAIR:
 * the withdrawal that must be REFUSED, and the neighbouring one that must still be ALLOWED. A
 * refusal on its own proves only that something is strict; it does not prove it is right.
 */
describe('Phase 5 Task 5B — §E certification (live PG)', () => {
  let t: TestApp;
  let f: TwoProjectFixture;
  let requirements: RequirementsService;
  let procurement: ProcurementService;
  let pos: PurchaseOrdersService;
  let vendors: VendorsService;
  let inventory: InventoryService;
  let labour: LabourService;
  let labourCommercial: LabourProcurementService;
  let capacity: LabourCapacityService;
  let activities: ActivitiesService;
  let activityParticipant: ActivityParticipant;
  let activation: CommercialActivationService;
  let bills: CommercialBillService;
  let verification: CommercialVerificationService;
  let certification: CommercialCertificationService;
  let measurement: CommercialMeasurementService;
  let capabilities: CapabilitiesService;
  let seq = 0;

  const TRUNCATE =
    'TRUNCATE TABLE "CertifiedMeasurementConsumption", "CertifiedAcceptanceConsumption", "BillCertificate", "BillVerification", "VendorBillLine", "VendorBillVersion", "VendorBill", "DomainEvent", "OutboxDelivery", "ProcessedEvent", "ProjectionCursor", "ProjectionGeneration", "DecisionProjection", "DailyLogProjection", "DrawingsProjection", "InspectionsProjection", "ActivitiesProjection", "MaterialReadinessProjection", "LabourReadinessProjection", "Measurement", "BudgetException", "BudgetLine", "CommitmentAttribution", "CostHead", "LabourMismatchResolution", "LabourMismatch", "ActivityWorkOutput", "LabourWorkFact", "WorkerAllocation", "LabourAttendance", "ApprovedSkillSubstitution", "CapacityPromise", "CapacityCommitment", "LabourPurchaseOrderLine", "LabourPurchaseOrderVersion", "LabourPurchaseOrder", "LabourQuoteComparison", "SupplierLabourQuoteLine", "SupplierLabourQuote", "LabourRfq", "LabourRequisitionLine", "LabourRequisition", "VendorLabourProfile", "StockTransaction", "MaterialIssue", "StockLot", "DeliveryPromise", "DeliveryCommitment", "PurchaseOrderLine", "PurchaseOrderVersion", "PurchaseOrder", "VendorQuoteLine", "QuoteComparison", "VendorQuote", "Rfq", "RequisitionLine", "Requisition", "ProjectVendor", "CommandExecution", "CrewMembership", "Crew", "WorkerDevice", "WorkerSkill", "Worker", "ApprovedSubstitution", "LabourDemandSlice", "LabourRequirementSpec", "LabourTrade", "LabourSkill", "MaterialRequirementSpec", "ActivityRequirement", "ActivityRequirementRoot", "DecisionApprovalRevision", "ProjectCapability" CASCADE';

  const pmc = (projectId: string): AuthUser => ({ sub: f.memberUser.id, role: 'pmc', projectId }) as AuthUser;
  const asUser = (projectId: string, userId: string): AuthUser => ({ sub: userId, role: 'pmc', projectId }) as AuthUser;
  const orgAdmin = (): AuthUser => ({ sub: f.ownerUser.id, role: 'pmc', projectId: '' }) as AuthUser;

  beforeAll(async () => {
    t = await createTestApp();
    f = await createTwoProjectFixture(t.prisma);
    requirements = t.app.get(RequirementsService);
    procurement = t.app.get(ProcurementService);
    pos = t.app.get(PurchaseOrdersService);
    vendors = t.app.get(VendorsService);
    inventory = t.app.get(InventoryService);
    labour = t.app.get(LabourService);
    labourCommercial = t.app.get(LabourProcurementService);
    capacity = t.app.get(LabourCapacityService);
    activities = t.app.get(ActivitiesService);
    activityParticipant = t.app.get(ActivityParticipant);
    activation = t.app.get(CommercialActivationService);
    bills = t.app.get(CommercialBillService);
    verification = t.app.get(CommercialVerificationService);
    certification = t.app.get(CommercialCertificationService);
    measurement = t.app.get(CommercialMeasurementService);
    capabilities = t.app.get(CapabilitiesService);
  });
  afterAll(async () => {
    await t?.prisma.$executeRawUnsafe(TRUNCATE);
    await t?.prisma.vendor.deleteMany({ where: { orgId: f.orgA.id } });
    await t?.prisma.membership.deleteMany({ where: { projectId: { startsWith: 'it-p5t5b-' } } });
    await t?.prisma.project.deleteMany({ where: { id: { startsWith: 'it-p5t5b-' } } });
    await f?.cleanup();
    await t?.close();
  });
  afterEach(async () => {
    await t.prisma.$executeRawUnsafe(TRUNCATE);
    await t.prisma.vendor.deleteMany({ where: { orgId: f.orgA.id } });
    for (const [model, where] of [
      ['auditLog', { projectId: { startsWith: 'it-p5t5b-' } }],
      ['media', { projectId: { startsWith: 'it-p5t5b-' } }],
      ['activity', { projectId: { startsWith: 'it-p5t5b-' } }],
      ['membership', { projectId: { startsWith: 'it-p5t5b-' } }],
      ['project', { id: { startsWith: 'it-p5t5b-' } }],
    ] as const) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (t.prisma as any)[model].deleteMany({ where });
    }
  });

  // ── fixtures (the Task-5A chain, unchanged — this task adds only what happens after `verified`) ──

  const freshProject = async (): Promise<string> => {
    const id = `it-p5t5b-${Date.now() % 1e6}-${seq++}`;
    await t.prisma.project.create({
      data: { id, orgId: f.orgA.id, name: id, short: 'P', descriptor: '', stage: 'x', siteCode: 'P', projStart: 'a', projEnd: 'b', elapsedPct: 0, todayDay: 0, milestonePct: 0, timeZone: 'Asia/Kolkata', scheduleStartDate: new Date('2026-06-01T00:00:00.000Z') },
    });
    await t.prisma.membership.create({ data: { projectId: id, userId: f.memberUser.id, role: 'pmc', status: 'active' } });
    await capabilities.enable(id, MATERIALS_CAPABILITY, f.memberUser.id);
    await activation.activate(id, f.memberUser.id, {
      costHeads: [{ code: 'CIVIL', name: 'Civil works' }], materialLines: [], labourLines: [], reason: 'pilot activation',
    });
    return id;
  };

  /**
   * A SECOND active pmc on the project. Two probes need one for two different reasons, and both
   * are §I: an exception needs an APPROVER who is not the actor, and every probe that is NOT about
   * segregation needs a STORE USER who is not the certifier — because in a practice that is the
   * ordinary arrangement, and §I encodes exactly that. Idempotent, so a probe can ask for both.
   */
  const secondPmc = async (projectId: string): Promise<string> => {
    await t.prisma.membership.upsert({
      where: { projectId_userId: { projectId, userId: f.ownerUser.id } },
      create: { projectId, userId: f.ownerUser.id, role: 'pmc', status: 'active' },
      update: { role: 'pmc', status: 'active' },
    });
    return f.ownerUser.id;
  };

  /** The store user: records evidence, never certifies. The ordinary separation §I assumes. */
  const store = async (projectId: string): Promise<AuthUser> => asUser(projectId, await secondPmc(projectId));

  const freshActivity = async (projectId: string): Promise<string> => {
    const id = `IT-P5T5B-ACT-${Date.now() % 1e6}-${seq++}`;
    await t.prisma.activity.create({ data: { id, projectId, name: `Act ${seq}`, zone: 'Zone 1', plannedStart: 0, plannedEnd: 10 } });
    return id;
  };

  const freshMedia = async (projectId: string): Promise<string> => {
    const row = await t.prisma.media.create({ data: { projectId, kind: 'material', mime: 'image/jpeg', uploadedBy: f.memberUser.id, sizeBytes: 3 } });
    return row.id;
  };

  const issuedMaterialLine = async (
    projectId: string, opts: { qty?: string; baseRate?: string } = {},
  ): Promise<{ poLineId: string; vendorId: string; commitmentId: string }> => {
    const qty = opts.qty ?? '100';
    const activityId = await freshActivity(projectId);
    const input: CreateRequirementInput = {
      activityId, materialCategory: 'Cement', make: 'UltraTech', grade: 'OPC 53', attributes: `grey-${seq++}`,
      baseUom: 'bag', qty, requiredBy: '2026-08-15', criticality: 'normal', decisionId: null,
      responsibleId: null, tolerance: null,
    };
    const req = await requirements.create(projectId, input, pmc(projectId));
    const created = await procurement.createRequisition(projectId, { title: `Req ${seq++}`, lines: [{ requirementId: req.requirementId, revision: req.revision, qty }] }, pmc(projectId));
    await procurement.submit(projectId, created.id, pmc(projectId));
    const requisition = await procurement.approve(projectId, created.id, pmc(projectId));
    const lineId = requisition.lines[0]!.id;
    const rfq = await procurement.createRfq(projectId, { requisitionId: requisition.id }, pmc(projectId));
    const v = await vendors.create(f.orgA.id, { name: `Vendor ${seq++}` }, orgAdmin());
    await vendors.bind(projectId, { vendorId: v.id }, pmc(projectId));
    const withQuote = await procurement.recordQuote(projectId, rfq.id, {
      vendorId: v.id, validUntil: '2027-01-01',
      lines: [{ requisitionLineId: lineId, baseRate: opts.baseRate ?? '1', taxAmount: '0', freightAmount: '0', landedCost: '999.99', quotedMake: 'make', matchesSpecification: true }],
    }, pmc(projectId));
    const quoteId = withQuote.quotes.find((q) => q.status === 'recorded')!.id;
    await procurement.createComparison(projectId, rfq.id, pmc(projectId));
    const approved = await procurement.approveComparison(projectId, rfq.id, { selectedQuoteId: quoteId, reason: 'single quote, in spec' }, pmc(projectId));
    const po = await pos.create(projectId, { comparisonId: approved.comparison!.id, lines: [{ requisitionLineId: lineId, purchaseQty: qty }] }, pmc(projectId));
    const line = await t.prisma.purchaseOrderLine.findFirstOrThrow({ where: { projectId, requisitionLineId: lineId } });
    await pos.issue(projectId, po.id, { costHeads: [{ poLineId: line.id, costHeadCode: 'CIVIL' }] }, pmc(projectId));
    const commitment = await pos.commitDelivery(projectId, { poLineId: line.id, promisedDate: '2026-09-01' }, pmc(projectId));
    return { poLineId: line.id, vendorId: v.id, commitmentId: commitment.id };
  };

  /** Receive and ACCEPT, optionally as a NAMED user — §I asks who recorded the acceptance. */
  const acceptOnLine = async (
    projectId: string, line: { poLineId: string; commitmentId: string },
    qty: string, as?: AuthUser,
  ): Promise<{ acceptanceTxId: string }> => {
    const recorder = as ?? await store(projectId);
    const lot = await inventory.recordReceipt(projectId, {
      poLineId: line.poLineId, commitmentId: line.commitmentId, storeLocation: 'main', purchaseQty: qty,
    }, pmc(projectId));
    await inventory.accept(projectId, {
      lotId: lot.id, storeLocation: 'main', qty, qualityResult: 'pass', evidenceMediaId: await freshMedia(projectId),
    }, recorder);
    const acceptance = await t.prisma.stockTransaction.findFirstOrThrow({
      where: { projectId, lotId: lot.id, type: 'acceptance' }, orderBy: { recordedAt: 'desc' },
    });
    return { acceptanceTxId: acceptance.id };
  };

  /** record → submit → begin-verification → verify. Everything this task builds on. */
  const verifiedClaim = async (
    projectId: string, vendorId: string, poLineId: string, quantity: string, kind: 'material' | 'labour' = 'material',
  ) => {
    const recorded = await bills.record(projectId, {
      vendorId, vendorBillNumber: `V-${seq++}`, documentDate: '2026-08-20',
      lines: [kind === 'material'
        ? { poLineId, quantity, rate: '1' }
        : { labourPoLineId: poLineId, quantity, rate: '1000' }],
    }, pmc(projectId));
    await bills.submit(projectId, { billId: recorded.id }, pmc(projectId));
    await bills.beginVerification(projectId, { billId: recorded.id }, pmc(projectId));
    const verdict = await verification.verify(projectId, { billId: recorded.id }, pmc(projectId));
    expect(verdict.verdict, 'the fixture must reach `verified`, or the probe is about the wrong thing').toBe('matched');
    return recorded.id;
  };

  const statusOf = async (projectId: string, billId: string): Promise<string> =>
    (await t.prisma.vendorBill.findFirstOrThrow({ where: { projectId, id: billId } })).status;

  /** The LABOUR chain: an ordered line with signed-off, measured work behind it. */
  const labourMeasurableLine = async (
    projectId: string, orderedQty = 2,
  ): Promise<{ poLineId: string; vendorId: string; activityId: string; outputId: string }> => {
    await capabilities.enable(projectId, LABOUR_CAPABILITY, f.memberUser.id);
    await labour.upsertTrade(projectId, { code: 'mason', name: 'Mason' }, pmc(projectId));
    await labour.upsertSkill(projectId, { code: 'bar-bending', name: 'Bar Bending' }, pmc(projectId));
    const activityId = await freshActivity(projectId);
    const civilDate = '2026-08-10';
    const req = await requirements.create(projectId, {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      type: 'labour', activityId, tradeCode: 'mason', skillCode: 'bar-bending', shift: 'day',
      demandSlices: [{ civilDate, personShiftQty: orderedQty }],
      decisionId: null, responsibleId: null, criticality: 'normal', tolerance: null,
    } as any, pmc(projectId));

    const vendor = await vendors.create(f.orgA.id, { name: `Supplier ${seq++}` }, orgAdmin());
    await vendors.bind(projectId, { vendorId: vendor.id }, pmc(projectId));
    const requisition = await labourCommercial.createRequisition(projectId, {
      title: `req ${seq++}`, lines: [{ requirementId: req.requirementId, revision: req.revision, civilDate, personShiftQty: orderedQty }],
    }, pmc(projectId));
    const line = requisition.lines[0]!;
    await labourCommercial.submitRequisition(projectId, requisition.id, pmc(projectId));
    await labourCommercial.approveRequisition(projectId, requisition.id, pmc(projectId));
    const rfq = await labourCommercial.createRfq(projectId, { requisitionId: requisition.id }, pmc(projectId));
    await labourCommercial.recordQuote(projectId, rfq.id, { vendorId: vendor.id, validUntil: '2026-12-31', lines: [{ requisitionLineId: line.id, ratePerPersonShift: '1000', shiftPremium: '0', landedPerPersonShift: '1000', matchesSpecification: true }] }, pmc(projectId));
    await labourCommercial.createComparison(projectId, rfq.id, pmc(projectId));
    const quoteId = (await labourCommercial.readRfq(projectId, rfq.id, pmc(projectId))).quotes[0]!.id;
    await labourCommercial.approveComparison(projectId, rfq.id, { selectedQuoteId: quoteId, reason: 'single in-spec quote' }, pmc(projectId));
    const comparisonId = (await labourCommercial.readRfq(projectId, rfq.id, pmc(projectId))).comparison!.id;
    const po = await labourCommercial.createPo(projectId, { comparisonId, lines: [{ requisitionLineId: line.id, personShiftQty: orderedQty }] }, pmc(projectId));
    const poLine = po.currentVersion.lines[0]!;
    await labourCommercial.issuePo(projectId, po.id, { costHeads: [{ labourPoLineId: poLine.id, costHeadCode: 'CIVIL' }] }, pmc(projectId));
    const commitment = await labourCommercial.commitCapacity(projectId, { poLineId: poLine.id, promisedDate: civilDate }, pmc(projectId));

    for (let i = 0; i < orderedQty; i += 1) {
      const w = await labour.onboardWorker(projectId, { name: `W${seq++}`, tradeCode: 'mason', skillCodes: ['bar-bending'], activeFrom: '2026-01-01' }, pmc(projectId));
      const { allocations } = await capacity.allocate(projectId, {
        activityId, requirementId: req.requirementId, civilDate, workerId: w.id, capacityCommitmentId: commitment.id,
      }, pmc(projectId));
      await capacity.recordWork(projectId, { allocationId: allocations[0]!.id, workedMinutes: 720 }, pmc(projectId));
    }
    const output = await activities.recordOutput(projectId, {
      activityId, civilDate, shift: 'day', quantity: '100', uom: 'sqm', evidenceMediaId: await freshMedia(projectId),
    }, pmc(projectId));
    await t.prisma.activity.updateMany({ where: { id: activityId, projectId }, data: { status: 'done', doneAt: new Date() } });
    return { poLineId: poLine.id, vendorId: vendor.id, activityId, outputId: output.id };
  };

  // ── §F — the arrow, and the fact behind it ───────────────────────────────────────────────────

  it('PROBE 1 (§F/§G): a verified claim CERTIFIES, and the certificate — not the status — is the fact', async () => {
    const projectId = await freshProject();
    const line = await issuedMaterialLine(projectId, { qty: '100' });
    const { acceptanceTxId } = await acceptOnLine(projectId, line, '100');
    const billId = await verifiedClaim(projectId, line.vendorId, line.poLineId, '100');

    const cert = await certification.certify(projectId, { billId }, pmc(projectId));
    expect(await statusOf(projectId, billId)).toBe('certified');
    // §G bound 3 — the certified amount IS `BILLED_AMOUNT(bill)`: 100 units at rate 1
    expect(cert.certifiedAmount).toBe('100');
    expect(cert.supersededAt).toBeNull();
    // §E — the FROZEN evidence: WHICH row, and HOW MUCH of it
    expect(cert.acceptanceConsumption).toEqual([{ rowId: acceptanceTxId, consumedQty: '100' }]);
    expect(cert.measurementConsumption).toEqual([]);

    // the status is the certificate's PROJECTION, and PostgreSQL says so: a hostile flip with no
    // certificate behind it is refused, so `certified` can never be asserted into existence. A
    // SECOND order line, because a second claim on the first would exceed the evidence the
    // certified one already stands on and be disputed at submission — the probe would then be
    // refused by the wrong seal.
    const second = await issuedMaterialLine(projectId, { qty: '10' });
    await acceptOnLine(projectId, second, '10');
    const other = await verifiedClaim(projectId, second.vendorId, second.poLineId, '10');
    await expect(t.prisma.$executeRawUnsafe(
      `UPDATE "VendorBill" SET "status" = 'certified', "statusChangedAt" = now() WHERE "projectId" = $1 AND "id" = $2`,
      projectId, other,
    )).rejects.toThrow(/LIVE certificate exists for it/u);
  });

  it('PROBE 2 (§F): certification applies ONLY to a verified claim', async () => {
    const projectId = await freshProject();
    const line = await issuedMaterialLine(projectId, { qty: '100' });
    await acceptOnLine(projectId, line, '100');
    const recorded = await bills.record(projectId, {
      vendorId: line.vendorId, vendorBillNumber: `V-${seq++}`, documentDate: '2026-08-20',
      lines: [{ poLineId: line.poLineId, quantity: '100', rate: '1' }],
    }, pmc(projectId));
    await bills.submit(projectId, { billId: recorded.id }, pmc(projectId));
    await expect(certification.certify(projectId, { billId: recorded.id }, pmc(projectId)))
      .rejects.toThrow(/cannot be certified/u);
  });

  it('PROBE 3 (§E): a claim that no longer verifies is REFUSED at certification', async () => {
    const projectId = await freshProject();
    const line = await issuedMaterialLine(projectId, { qty: '100' });
    const { acceptanceTxId } = await acceptOnLine(projectId, line, '100');
    const billId = await verifiedClaim(projectId, line.vendorId, line.poLineId, '100');

    // the evidence moves AFTER the verdict — the claim is disputed by the withdrawal guard, and
    // certifying it would authorise money the evidence no longer supports
    await inventory.reverse(projectId, { txId: acceptanceTxId, reason: 'mis-accepted' }, pmc(projectId));
    expect(await statusOf(projectId, billId)).toBe('disputed');
    await expect(certification.certify(projectId, { billId }, pmc(projectId)))
      .rejects.toThrow(/cannot be certified/u);
  });

  // ── §E — the frozen set, and the two-sided guards it makes possible ──────────────────────────

  it('PROBE 4 (§E): the freeze is `(rowId, consumedQty)` — the unused remainder stays reversible, the consumed part does not', async () => {
    const projectId = await freshProject();
    const line = await issuedMaterialLine(projectId, { qty: '100' });
    const { acceptanceTxId } = await acceptOnLine(projectId, line, '100');
    // an 80-unit claim against a 100-unit acceptance row: exactly §E's example
    const billId = await verifiedClaim(projectId, line.vendorId, line.poLineId, '80');
    const cert = await certification.certify(projectId, { billId }, pmc(projectId));
    expect(cert.acceptanceConsumption).toEqual([{ rowId: acceptanceTxId, consumedQty: '80' }]);

    // REFUSED — a full reversal would take the row to 0, below the 80 a live certificate froze.
    // §C rule iii reverses a ledger row IN FULL, so the "unused 20 stays reversible" half of §E's
    // example is a statement about the guard's ARITHMETIC rather than about a partial reversal
    // command: the refusal names 80, not 100, and PROBE 5 proves the other row of the same line
    // is still reversible. Claiming a partial reversal here would be claiming a command that does
    // not exist.
    await expect(inventory.reverse(projectId, { txId: acceptanceTxId, reason: 'mis-accepted' }, pmc(projectId)))
      .rejects.toThrow(/carries 80 base units frozen under live certificate/u);

    // and the operator path in the refusal WORKS: supersede, then reverse
    await certification.supersede(projectId, { billId, reason: 'evidence withdrawn on site' }, pmc(projectId));
    expect(await statusOf(projectId, billId)).toBe('verified');
    await expect(inventory.reverse(projectId, { txId: acceptanceTxId, reason: 'mis-accepted' }, pmc(projectId)))
      .resolves.toBeDefined();
  });

  it('PROBE 5 (§E): the guard is precise — a reversal on a DIFFERENT row of the same line is allowed', async () => {
    const projectId = await freshProject();
    const line = await issuedMaterialLine(projectId, { qty: '200' });
    const first = await acceptOnLine(projectId, line, '100');
    const second = await acceptOnLine(projectId, line, '100');
    // the claim consumes 100, which the greedy ascending draw takes entirely from ONE row
    const billId = await verifiedClaim(projectId, line.vendorId, line.poLineId, '100');
    const cert = await certification.certify(projectId, { billId }, pmc(projectId));
    expect(cert.acceptanceConsumption).toHaveLength(1);
    const consumed = cert.acceptanceConsumption[0]!.rowId;
    const untouched = consumed === first.acceptanceTxId ? second.acceptanceTxId : first.acceptanceTxId;

    // REFUSED on the consumed row …
    await expect(inventory.reverse(projectId, { txId: consumed, reason: 'x' }, pmc(projectId)))
      .rejects.toThrow(/frozen under live certificate/u);
    // … and ALLOWED on the other one. An aggregate check would have permitted BOTH, which is
    // exactly the evidence swap §E names: same total, different rows, different recorder.
    await expect(inventory.reverse(projectId, { txId: untouched, reason: 'genuinely mis-accepted' }, pmc(projectId)))
      .resolves.toBeDefined();
  });

  it('PROBE 6 (§E/§D): a sign-off cannot be withdrawn while a certificate rests on its measured work', async () => {
    const projectId = await freshProject();
    const l = await labourMeasurableLine(projectId, 2);
    await measurement.take(projectId, {
      labourPoLineId: l.poLineId, activityId: l.activityId, quantity: '2',
      measuredOn: '2026-08-10', citedOutputId: l.outputId,
    }, await store(projectId));
    const billId = await verifiedClaim(projectId, l.vendorId, l.poLineId, '2', 'labour');

    // BEFORE certification the revert is allowed by the certificate arm and refused by the
    // MEASUREMENT arm — a different refusal, with a different instruction
    await expect(t.prisma.$transaction((tx) => activityParticipant.revertSignOff(tx, { projectId, activityId: l.activityId })))
      .rejects.toThrow(/Correct them to zero first/u);

    const cert = await certification.certify(projectId, { billId }, pmc(projectId));
    expect(cert.measurementConsumption).toHaveLength(1);
    expect(cert.measurementConsumption[0]!.consumedQty).toBe('2');

    // AFTER certification the instruction changes, because "correct the measurements to zero" is
    // a route the row-level floor would then refuse
    await expect(t.prisma.$transaction((tx) => activityParticipant.revertSignOff(tx, { projectId, activityId: l.activityId })))
      .rejects.toThrow(/supersede the certification first/u);
  });

  it('PROBE 7 (§D/§E): the measurement floor is ROW-LEVEL — the aggregate would let the evidence be swapped', async () => {
    const projectId = await freshProject();
    const l = await labourMeasurableLine(projectId, 4);
    // row A: 2 person-shifts, taken by the member
    const a = await measurement.take(projectId, {
      labourPoLineId: l.poLineId, activityId: l.activityId, quantity: '2',
      measuredOn: '2026-08-10', citedOutputId: l.outputId,
    }, await store(projectId));
    const billId = await verifiedClaim(projectId, l.vendorId, l.poLineId, '2', 'labour');
    const cert = await certification.certify(projectId, { billId }, pmc(projectId));
    expect(cert.measurementConsumption).toEqual([{ rowId: a.id, consumedQty: '2' }]);

    // row B: another 2, by a DIFFERENT actor. The fold is now 4 and the claim is 2, so an
    // aggregate floor is satisfied no matter which row is walked back.
    await measurement.take(projectId, {
      labourPoLineId: l.poLineId, activityId: l.activityId, quantity: '2',
      measuredOn: '2026-08-11', citedOutputId: l.outputId,
    }, pmc(projectId));

    // REFUSED: correcting A to zero would leave the certificate resting on a row that no longer
    // says what it said — the swap. The aggregate stays at 2 and would have allowed it.
    await expect(measurement.correct(projectId, {
      measurementId: a.id, quantity: '-2', reason: 'restating A',
    }, pmc(projectId))).rejects.toThrow(/frozen under live certificate/u);

    // ALLOWED: superseding the certificate releases the row, and the same correction then applies
    await certification.supersede(projectId, { billId, reason: 'evidence restated' }, pmc(projectId));
    await expect(measurement.correct(projectId, {
      measurementId: a.id, quantity: '-2', reason: 'restating A',
    }, pmc(projectId))).resolves.toBeDefined();
  });

  // ── §I — segregation of duties ───────────────────────────────────────────────────────────────

  it('PROBE 8 (§I): the actor who recorded the evidence may not certify it', async () => {
    const projectId = await freshProject();
    const line = await issuedMaterialLine(projectId, { qty: '100' });
    // the acceptance is recorded by the member — the same actor who will attempt certification.
    // §I binds MATERIAL bills too: with no `Measurement` row, the acceptance actor IS the measurer.
    await acceptOnLine(projectId, line, '100', pmc(projectId));
    const billId = await verifiedClaim(projectId, line.vendorId, line.poLineId, '100');

    // This unit ships the RULE; the attributable override that lets a two-person practice certify
    // its own recorded evidence is the next unit's. Until it exists the refusal is unconditional,
    // which is strictly more restrictive than the finished rule — so no state reachable here
    // permits an act the finished rule would refuse.
    await expect(certification.certify(projectId, { billId }, pmc(projectId)))
      .rejects.toThrow(/Segregation of duties/u);
    expect(await t.prisma.billCertificate.count({ where: { projectId } })).toBe(0);
  });

  it('PROBE 9 (§I): a certification by someone who recorded NO evidence needs no exception', async () => {
    const projectId = await freshProject();
    const line = await issuedMaterialLine(projectId, { qty: '100' });
    // the acceptance is recorded by the OTHER pmc, so the member certifying is not the recorder
    await acceptOnLine(projectId, line, '100');
    const billId = await verifiedClaim(projectId, line.vendorId, line.poLineId, '100');
    const cert = await certification.certify(projectId, { billId }, pmc(projectId));
    expect(cert.certifiedAmount).toBe('100');
  });

  // ── §F — supersession, replay, and the append-only seals ─────────────────────────────────────

  it('PROBE 10 (§F): a REPLAY returns the certificate THAT call made, not the live one', async () => {
    const projectId = await freshProject();
    const line = await issuedMaterialLine(projectId, { qty: '100' });
    await acceptOnLine(projectId, line, '100');
    const billId = await verifiedClaim(projectId, line.vendorId, line.poLineId, '100');

    const key = `it-certify-${seq++}`;
    const first = await certification.certify(projectId, { billId }, pmc(projectId), key);
    // a straight retry appends NOTHING and returns the same certificate
    const replay = await certification.certify(projectId, { billId }, pmc(projectId), key);
    expect(replay.id).toBe(first.id);
    expect(await t.prisma.billCertificate.count({ where: { projectId } })).toBe(1);

    // supersede, re-certify — and replay the FIRST key again. A bill-scoped read would hand back
    // the SECOND certificate as though it were the answer to a call that produced the first.
    await certification.supersede(projectId, { billId, reason: 'restated' }, pmc(projectId));
    const second = await certification.certify(projectId, { billId }, pmc(projectId), `it-certify-${seq++}`);
    expect(second.id).not.toBe(first.id);
    const replayedAgain = await certification.certify(projectId, { billId }, pmc(projectId), key);
    expect(replayedAgain.id).toBe(first.id);
    expect(replayedAgain.supersededAt).not.toBeNull();
    expect(replayedAgain.supersedeReason).toBe('restated');
    expect(await t.prisma.billCertificate.count({ where: { projectId } })).toBe(2);
  });

  it('PROBE 11 (§F): EXACTLY ONE live certificate per bill, enforced at PostgreSQL', async () => {
    const projectId = await freshProject();
    const line = await issuedMaterialLine(projectId, { qty: '100' });
    await acceptOnLine(projectId, line, '100');
    const billId = await verifiedClaim(projectId, line.vendorId, line.poLineId, '100');
    const cert = await certification.certify(projectId, { billId }, pmc(projectId));

    const version = await t.prisma.vendorBillVersion.findFirstOrThrow({ where: { projectId, billId, supersededAt: null } });
    await expect(t.prisma.$executeRawUnsafe(
      `INSERT INTO "BillCertificate" ("id","projectId","billId","versionId","certifiedAmount","certifiedById","sourceCommandId")
       SELECT 'forged-live', $1, $2, $3, 1, "certifiedById", "sourceCommandId" FROM "BillCertificate" WHERE "id" = $4`,
      projectId, billId, version.id, cert.id,
    )).rejects.toThrow(/Key \("projectId", "billId"\)=.* already exists/u);
  });

  it('PROBE 12 (§E): every new table is APPEND-ONLY at PostgreSQL', async () => {
    const projectId = await freshProject();
    const line = await issuedMaterialLine(projectId, { qty: '100' });
    await acceptOnLine(projectId, line, '100');
    const billId = await verifiedClaim(projectId, line.vendorId, line.poLineId, '100');
    const cert = await certification.certify(projectId, { billId }, pmc(projectId));

    // the certificate: amount and attribution frozen, deletion refused, supersession one-way
    await expect(t.prisma.$executeRawUnsafe(
      `UPDATE "BillCertificate" SET "certifiedAmount" = 999 WHERE "id" = $1`, cert.id,
    )).rejects.toThrow(/IMMUTABLE/u);
    await expect(t.prisma.$executeRawUnsafe(`DELETE FROM "BillCertificate" WHERE "id" = $1`, cert.id))
      .rejects.toThrow(/never deleted/u);
    await certification.supersede(projectId, { billId, reason: 'restated' }, pmc(projectId));
    await expect(t.prisma.$executeRawUnsafe(
      `UPDATE "BillCertificate" SET "supersedeReason" = 'rewritten' WHERE "id" = $1`, cert.id,
    )).rejects.toThrow(/not rewritable/u);

    // the consumption set: fully immutable, both arms
    for (const table of ['CertifiedAcceptanceConsumption']) {
      await expect(t.prisma.$executeRawUnsafe(
        `UPDATE "${table}" SET "projectId" = "projectId" WHERE "projectId" = $1`, projectId,
      )).rejects.toThrow(/IMMUTABLE/u);
      await expect(t.prisma.$executeRawUnsafe(
        `DELETE FROM "${table}" WHERE "projectId" = $1`, projectId,
      )).rejects.toThrow(/append-only/u);
    }
  });

  it('PROBE 13 (§G bound 3): a certificate above the claim it certifies is refused at COMMIT', async () => {
    const projectId = await freshProject();
    const line = await issuedMaterialLine(projectId, { qty: '100' });
    await acceptOnLine(projectId, line, '100');
    const billId = await verifiedClaim(projectId, line.vendorId, line.poLineId, '100');
    const cert = await certification.certify(projectId, { billId }, pmc(projectId));

    // supersede first, so the one-live index is not what refuses — the probe must fail on the
    // BOUND, or it proves the wrong seal (the §E round-5 lesson, at its next site)
    await certification.supersede(projectId, { billId, reason: 'restated' }, pmc(projectId));
    const version = await t.prisma.vendorBillVersion.findFirstOrThrow({ where: { projectId, billId, supersededAt: null } });
    await expect(t.prisma.$executeRawUnsafe(
      `INSERT INTO "BillCertificate" ("id","projectId","billId","versionId","certifiedAmount","certifiedById","sourceCommandId")
       SELECT 'forged-bound', $1, $2, $3, 150, "certifiedById", "sourceCommandId" FROM "BillCertificate" WHERE "id" = $4`,
      projectId, billId, version.id, cert.id,
    )).rejects.toThrow(/Bound 3 breached/u);

    // …and the seal is PRECISE, not merely strict: the same insert AT the claimed amount is
    // accepted. A refusal with no matching acceptance proves only that something is strict.
    //
    // The status moves WITH it, in ONE transaction. That is not scaffolding around the probe — it
    // is the round-1 projection seal doing its job: a live certificate on a bill that is not
    // `certified` is exactly the incoherence R1-F2 closes, so an acceptance case that left the
    // status behind would be testing a state the database is right to refuse.
    // …with its EVIDENCE and its status, all in ONE transaction. Round 2 added the completeness
    // seal, so a certificate resting on nothing is refused however it is written — an acceptance
    // case that omitted the consumption rows would be testing a state the database is right to
    // refuse, and would prove nothing about bound 3.
    const acceptanceRow = await t.prisma.stockTransaction.findFirstOrThrow({
      where: { projectId, type: 'acceptance' }, select: { id: true },
    });
    await expect(t.prisma.$transaction([
      t.prisma.$executeRawUnsafe(
        `INSERT INTO "BillCertificate" ("id","projectId","billId","versionId","certifiedAmount","certifiedById","sourceCommandId")
         SELECT 'coherent-bound', $1, $2, $3, 100, "certifiedById", "sourceCommandId" FROM "BillCertificate" WHERE "id" = $4`,
        projectId, billId, version.id, cert.id,
      ),
      t.prisma.$executeRawUnsafe(
        `INSERT INTO "CertifiedAcceptanceConsumption" ("id","projectId","certificateId","stockTransactionId","consumedQty")
         VALUES ('coherent-bound-ev',$1,'coherent-bound',$2,100)`, projectId, acceptanceRow.id,
      ),
      t.prisma.$executeRawUnsafe(
        `UPDATE "VendorBill" SET "status"='certified', "statusChangedAt"=now() WHERE "projectId"=$1 AND "id"=$2`,
        projectId, billId,
      ),
    ])).resolves.toBeDefined();
  });

  it('PROBE 14 (§D): every certification surface is ABSENT off-pilot', async () => {
    const id = `it-p5t5b-off-${Date.now() % 1e6}-${seq++}`;
    await t.prisma.project.create({
      data: { id, orgId: f.orgA.id, name: id, short: 'P', descriptor: '', stage: 'x', siteCode: 'P', projStart: 'a', projEnd: 'b', elapsedPct: 0, todayDay: 0, milestonePct: 0, timeZone: 'Asia/Kolkata' },
    });
    await t.prisma.membership.create({ data: { projectId: id, userId: f.memberUser.id, role: 'pmc', status: 'active' } });
    for (const call of [
      () => certification.certify(id, { billId: 'x' }, pmc(id)),
      () => certification.supersede(id, { billId: 'x', reason: 'r' }, pmc(id)),
      () => certification.readCertificate(id, 'x', pmc(id)),
    ]) await expect(call()).rejects.toMatchObject({ status: 404 });
  });

  // ── Codex round-1 findings, each reproduced RED before its fix ───────────────────────────────

  it('R1-F1 (§E/§0b): certification takes the LOTS before the BILL, so a concurrent reversal cannot deadlock it', async () => {
    const projectId = await freshProject();
    const line = await issuedMaterialLine(projectId, { qty: '100' });
    const { acceptanceTxId } = await acceptOnLine(projectId, line, '100');
    const billId = await verifiedClaim(projectId, line.vendorId, line.poLineId, '100');
    const lotId = (await t.prisma.stockTransaction.findFirstOrThrow({
      where: { projectId, id: acceptanceTxId }, select: { lotId: true },
    })).lotId;

    // The deadlock the old order produced: certification held the BILL and waited for the LOT,
    // while `stock.reverse` held the LOT and waited to dispute the BILL — each holding what the
    // other needed next.
    //
    // The barrier is CONDITION-BASED, not a sleep, and the first draft of this probe is why it has
    // to be: with a 300 ms sleep it passed against the OLD order too, because certification had
    // not yet reached its lock by the time the holder released. It proved nothing. Here session A
    // holds the LOT, the test WAITS until certification is genuinely blocked on a lock
    // (`pg_stat_activity`), and only then lets A take the bill — which is precisely the ordering
    // that deadlocks a bill-first certifier and cannot deadlock a lot-first one.
    const other = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL! } } });
    const watcher = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL! } } });
    try {
      const blockedSessions = async (): Promise<number> => {
        const rows = await watcher.$queryRaw<Array<{ c: number }>>`
          SELECT COUNT(*)::int AS c FROM pg_stat_activity
           WHERE wait_event_type = 'Lock' AND state = 'active'`;
        return rows[0]!.c;
      };
      const waitUntilBlocked = async (): Promise<void> => {
        for (let i = 0; i < 400; i += 1) {
          if ((await blockedSessions()) >= 1) return;
          await new Promise((r) => setTimeout(r, 25));
        }
        throw new Error('barrier timeout: certification never blocked on a lock');
      };

      let release!: () => void;
      let acquired!: () => void;
      const held = new Promise<void>((r) => { release = r; });
      // A signals once it HOLDS the lot. Without this the test raced its own fixture: session B
      // could run to completion before A's transaction callback had even started, and the barrier
      // then timed out having proven nothing about ordering.
      const holdingLot = new Promise<void>((r) => { acquired = r; });
      const sessionA = other.$transaction(async (tx) => {
        await tx.$queryRawUnsafe(`SELECT "id" FROM "StockLot" WHERE "projectId" = $1 AND "id" = $2 FOR UPDATE`, projectId, lotId);
        acquired();
        await held;
        await tx.$queryRawUnsafe(`SELECT "id" FROM "VendorBill" WHERE "projectId" = $1 AND "id" = $2 FOR UPDATE`, projectId, billId);
      }, { timeout: 30_000 });

      await holdingLot;
      const sessionB = certification.certify(projectId, { billId }, pmc(projectId));
      await waitUntilBlocked();
      release();
      await sessionA;
      // Under the CORRECTED order B was blocked on the LOT while holding no bill, so A takes the
      // bill freely, commits, and B proceeds. Under the old order B held the bill A now wants and
      // PostgreSQL kills one of them with a deadlock.
      const cert = await sessionB;
      expect(cert.certifiedAmount).toBe('100');
      expect(await statusOf(projectId, billId)).toBe('certified');
    } finally {
      await other.$disconnect();
      await watcher.$disconnect();
    }
  });

  it('R1-F2 (§F): a certificate and its bill STATUS move together — neither can be left behind', async () => {
    const projectId = await freshProject();
    const line = await issuedMaterialLine(projectId, { qty: '100' });
    await acceptOnLine(projectId, line, '100');
    const billId = await verifiedClaim(projectId, line.vendorId, line.poLineId, '100');
    const cert = await certification.certify(projectId, { billId }, pmc(projectId));

    // a STANDALONE supersession leaves a `certified` bill whose live certificate is gone —
    // `readCertificate` would 404 on a bill that says money is authorised
    await expect(t.prisma.$executeRawUnsafe(
      `UPDATE "BillCertificate" SET "supersededAt"=now(), "supersededById"=$2, "supersedeReason"='forged' WHERE "id"=$1`,
      cert.id, f.memberUser.id,
    )).rejects.toThrow(/live certificate\(s\) — the status is the certificate/u);

    // …and the other direction: moving the bill off `certified` while its certificate still stands
    await expect(t.prisma.$executeRawUnsafe(
      `UPDATE "VendorBill" SET "status"='verified', "statusChangedAt"=now() WHERE "projectId"=$1 AND "id"=$2`,
      projectId, billId,
    )).rejects.toThrow(/while a LIVE certificate still stands/u);

    // the SERVICE moves both in one transaction, which is what makes it the only coherent path
    await expect(certification.supersede(projectId, { billId, reason: 'restated' }, pmc(projectId)))
      .resolves.toBeDefined();
    expect(await statusOf(projectId, billId)).toBe('verified');
  });

  it('R1-F3/F4 (§E): a certificate can only freeze evidence its OWN claim rests on', async () => {
    const projectId = await freshProject();
    const line = await issuedMaterialLine(projectId, { qty: '100' });
    const { acceptanceTxId } = await acceptOnLine(projectId, line, '100');
    const billId = await verifiedClaim(projectId, line.vendorId, line.poLineId, '100');
    const cert = await certification.certify(projectId, { billId }, pmc(projectId));

    // a RECEIPT is not acceptance evidence, even on the very line the bill claims
    const receipt = await t.prisma.stockTransaction.findFirstOrThrow({
      where: { projectId, type: 'receipt' }, select: { id: true },
    });
    await expect(t.prisma.$executeRawUnsafe(
      `INSERT INTO "CertifiedAcceptanceConsumption"("id","projectId","certificateId","stockTransactionId","consumedQty")
       VALUES ('forged-receipt',$1,$2,$3,1)`, projectId, cert.id, receipt.id,
    )).rejects.toThrow(/only freeze an ACCEPTANCE row/u);

    // an acceptance on a purchase-order line this bill does NOT claim
    const other = await issuedMaterialLine(projectId, { qty: '50' });
    const foreign = await acceptOnLine(projectId, other, '50');
    await expect(t.prisma.$executeRawUnsafe(
      `INSERT INTO "CertifiedAcceptanceConsumption"("id","projectId","certificateId","stockTransactionId","consumedQty")
       VALUES ('forged-foreign',$1,$2,$3,1)`, projectId, cert.id, foreign.acceptanceTxId,
    )).rejects.toThrow(/purchase-order line its own bill claims/u);

    // …and the row the certificate DID draw on is accepted, so the seal is precise not merely strict
    expect(cert.acceptanceConsumption).toEqual([{ rowId: acceptanceTxId, consumedQty: '100' }]);
  });

  it('R1-F4 (§D/§E): a CORRECTION row is the amendment of evidence, never evidence itself', async () => {
    const projectId = await freshProject();
    const l = await labourMeasurableLine(projectId, 4);
    const original = await measurement.take(projectId, {
      labourPoLineId: l.poLineId, activityId: l.activityId, quantity: '2',
      measuredOn: '2026-08-10', citedOutputId: l.outputId,
    }, await store(projectId));
    // a SECOND original on the same line, which the claim below does not reach. The probe needs a
    // measurement the certificate does NOT rest on, because a correction to a frozen row is refused
    // by the withdrawal guard long before this seal is asked — and it needs the certificate to be
    // LIVE, because Codex round 5 added an append-closure that refuses ANY row on history and would
    // otherwise answer this probe in place of the seal under test.
    const spare = await measurement.take(projectId, {
      labourPoLineId: l.poLineId, activityId: l.activityId, quantity: '2',
      measuredOn: '2026-08-11', citedOutputId: l.outputId,
    }, await store(projectId));
    const billId = await verifiedClaim(projectId, l.vendorId, l.poLineId, '2', 'labour');
    const cert = await certification.certify(projectId, { billId }, pmc(projectId));
    expect(cert.measurementConsumption).toHaveLength(1);
    const untouched = cert.measurementConsumption[0]!.rowId === original.id ? spare.id : original.id;

    // a correction against the same line — real, in-project, on the right PO line, and still not
    // evidence: it is the row that WALKS BACK evidence
    const correction = await measurement.correct(projectId, {
      measurementId: untouched, quantity: '-1', reason: 'over-measured',
    }, await store(projectId));
    await expect(t.prisma.$executeRawUnsafe(
      `INSERT INTO "CertifiedMeasurementConsumption"("id","projectId","certificateId","measurementId","consumedQty")
       VALUES ('forged-correction',$1,$2,$3,1)`, projectId, cert.id, correction.id,
    )).rejects.toThrow(/only freeze an ORIGINAL measurement/u);
  });

  it('R1-F5 (§I): segregation asks about the rows this certificate DRAWS on, not every row on the line', async () => {
    const projectId = await freshProject();
    const storeUser = await store(projectId);
    const line = await issuedMaterialLine(projectId, { qty: '200' });
    // acceptance A is recorded by the MEMBER — the actor who will certify
    const a = await acceptOnLine(projectId, line, '100', pmc(projectId));
    // acceptance B by the store user
    await acceptOnLine(projectId, line, '100', storeUser);

    // a first certificate consumes A entirely (certified by the store user, who did not record it)
    const firstBill = await verifiedClaim(projectId, line.vendorId, line.poLineId, '100');
    const first = await certification.certify(projectId, { billId: firstBill }, storeUser);
    expect(first.acceptanceConsumption).toEqual([{ rowId: a.acceptanceTxId, consumedQty: '100' }]);

    // The SECOND claim is for a DIFFERENT quantity, and deliberately so: two live claims with
    // identical totals on one purchase-order line from one vendor are §E's `duplicate-claim`, so a
    // 100/100 pair would never reach `verified` and this probe would assert nothing about §I.
    //
    // It can only draw on B, which the member did not record. §I must therefore permit it:
    // refusing would refuse on the strength of a row this act does not rest on.
    const secondBill = await verifiedClaim(projectId, line.vendorId, line.poLineId, '60');
    const second = await certification.certify(projectId, { billId: secondBill }, pmc(projectId));
    expect(second.acceptanceConsumption.map((c) => c.rowId)).not.toContain(a.acceptanceTxId);
  });

  it('R2-F1 (§E): a certificate with NO frozen evidence cannot commit, however it is written', async () => {
    const projectId = await freshProject();
    const line = await issuedMaterialLine(projectId, { qty: '100' });
    await acceptOnLine(projectId, line, '100');
    const billId = await verifiedClaim(projectId, line.vendorId, line.poLineId, '100');
    const cert = await certification.certify(projectId, { billId }, pmc(projectId));
    const version = await t.prisma.vendorBillVersion.findFirstOrThrow({ where: { projectId, billId, supersededAt: null } });
    await certification.supersede(projectId, { billId, reason: 'restated' }, pmc(projectId));

    // a certificate + its status, coherent by every ROW-level seal, and resting on NOTHING. The
    // withdrawal guards would find no frozen rows and permit the reversal it exists to block.
    await expect(t.prisma.$transaction([
      t.prisma.$executeRawUnsafe(
        `INSERT INTO "BillCertificate" ("id","projectId","billId","versionId","certifiedAmount","certifiedById","sourceCommandId")
         SELECT 'evidence-free', $1, $2, $3, 100, "certifiedById", "sourceCommandId" FROM "BillCertificate" WHERE "id" = $4`,
        projectId, billId, version.id, cert.id,
      ),
      t.prisma.$executeRawUnsafe(
        `UPDATE "VendorBill" SET "status"='certified', "statusChangedAt"=now() WHERE "projectId"=$1 AND "id"=$2`,
        projectId, billId,
      ),
    ])).rejects.toThrow(/freezes 0 of accepted evidence/u);
  });

  it('R2-F2 (§I): a certificate by the evidence RECORDER cannot commit, however it is written', async () => {
    const projectId = await freshProject();
    const line = await issuedMaterialLine(projectId, { qty: '100' });
    // the member records the acceptance, so §I refuses them as certifier — through the service,
    // and (this probe's subject) at the database, which is the direction a fresh insert takes
    await acceptOnLine(projectId, line, '100', pmc(projectId));
    const billId = await verifiedClaim(projectId, line.vendorId, line.poLineId, '100');
    const acceptance = await t.prisma.stockTransaction.findFirstOrThrow({
      where: { projectId, type: 'acceptance' }, select: { id: true },
    });
    const version = await t.prisma.vendorBillVersion.findFirstOrThrow({ where: { projectId, billId, supersededAt: null } });
    const cmd = await t.prisma.commandExecution.findFirstOrThrow({ where: { projectId }, select: { id: true } });

    await expect(t.prisma.$transaction([
      t.prisma.$executeRawUnsafe(
        `INSERT INTO "BillCertificate" ("id","projectId","billId","versionId","certifiedAmount","certifiedById","sourceCommandId")
         VALUES ('recorder',$1,$2,$3,100,$4,$5)`, projectId, billId, version.id, f.memberUser.id, cmd.id,
      ),
      t.prisma.$executeRawUnsafe(
        `INSERT INTO "CertifiedAcceptanceConsumption" ("id","projectId","certificateId","stockTransactionId","consumedQty")
         VALUES ('recorder-ev',$1,'recorder',$2,100)`, projectId, acceptance.id,
      ),
      t.prisma.$executeRawUnsafe(
        `UPDATE "VendorBill" SET "status"='certified', "statusChangedAt"=now() WHERE "projectId"=$1 AND "id"=$2`,
        projectId, billId,
      ),
    ])).rejects.toThrow(/who recorded evidence it rests on — §I refuses the act/u);

    // precision: the SAME act by a certifier who recorded none of it is ACCEPTED, so the seal is
    // reading the evidence-actor set rather than refusing every direct certificate
    await expect(t.prisma.$transaction([
      t.prisma.$executeRawUnsafe(
        `INSERT INTO "BillCertificate" ("id","projectId","billId","versionId","certifiedAmount","certifiedById","sourceCommandId")
         VALUES ('outsider',$1,$2,$3,100,$4,$5)`, projectId, billId, version.id, f.strangerUser.id, cmd.id,
      ),
      t.prisma.$executeRawUnsafe(
        `INSERT INTO "CertifiedAcceptanceConsumption" ("id","projectId","certificateId","stockTransactionId","consumedQty")
         VALUES ('outsider-ev',$1,'outsider',$2,100)`, projectId, acceptance.id,
      ),
      t.prisma.$executeRawUnsafe(
        `UPDATE "VendorBill" SET "status"='certified', "statusChangedAt"=now() WHERE "projectId"=$1 AND "id"=$2`,
        projectId, billId,
      ),
    ])).resolves.toBeDefined();
  });

  it('R2-F3 (§E): frozen evidence cannot exceed the evidence that exists', async () => {
    const projectId = await freshProject();
    const line = await issuedMaterialLine(projectId, { qty: '200' });
    // 100 accepted across TWO rows — a one-unit row and a 99-unit row. The claim is 100, so the
    // honest draw takes 1 from the small row and 99 from the large one, and a forged freeze of the
    // FULL 100 against the small row alone satisfies completeness (100 == 100) while exceeding
    // what that row ever carried. Without the split the completeness seal fires first, and a
    // refusal from the wrong seal proves nothing about this one.
    const { acceptanceTxId } = await acceptOnLine(projectId, line, '1');
    await acceptOnLine(projectId, line, '99');
    const billId = await verifiedClaim(projectId, line.vendorId, line.poLineId, '100');
    const cert = await certification.certify(projectId, { billId }, pmc(projectId));
    expect(cert.acceptanceConsumption).toHaveLength(2);

    // A FRESH certificate freezing 100 units of that ONE-unit acceptance — Codex's scenario
    // exactly. Identity is right, the line is right, completeness passes (a 1-unit claim is more
    // than covered by a 100-unit freeze), bound 3 passes; only the QUANTITY never existed.
    //
    // It has to be a fresh certificate rather than a second row on the existing one: a second row
    // for the same `(certificate, acceptance)` pair trips the per-pair unique FIRST, and a
    // refusal from the wrong seal proves nothing about this one.
    const version = await t.prisma.vendorBillVersion.findFirstOrThrow({ where: { projectId, billId, supersededAt: null } });
    await certification.supersede(projectId, { billId, reason: 'restated' }, pmc(projectId));
    await expect(t.prisma.$transaction([
      t.prisma.$executeRawUnsafe(
        `INSERT INTO "BillCertificate" ("id","projectId","billId","versionId","certifiedAmount","certifiedById","sourceCommandId")
         SELECT 'inflated', $1, $2, $3, 100, "certifiedById", "sourceCommandId" FROM "BillCertificate" WHERE "id" = $4`,
        projectId, billId, version.id, cert.id,
      ),
      t.prisma.$executeRawUnsafe(
        `INSERT INTO "CertifiedAcceptanceConsumption" ("id","projectId","certificateId","stockTransactionId","consumedQty")
         VALUES ('inflated-ev',$1,'inflated',$2,100)`, projectId, acceptanceTxId,
      ),
      t.prisma.$executeRawUnsafe(
        `UPDATE "VendorBill" SET "status"='certified', "statusChangedAt"=now() WHERE "projectId"=$1 AND "id"=$2`,
        projectId, billId,
      ),
    ])).rejects.toThrow(/frozen evidence cannot exceed the evidence/u);
  });

  it('R2-F4 (§E/§F): a live certificate must name the bill\'s LIVE claim version', async () => {
    const projectId = await freshProject();
    const line = await issuedMaterialLine(projectId, { qty: '100' });
    const { acceptanceTxId } = await acceptOnLine(projectId, line, '100');
    const billId = await verifiedClaim(projectId, line.vendorId, line.poLineId, '100');
    const cert = await certification.certify(projectId, { billId }, pmc(projectId));
    const v1 = await t.prisma.vendorBillVersion.findFirstOrThrow({ where: { projectId, billId, supersededAt: null } });
    expect(cert.versionId).toBe(v1.id);

    // supersede, amend (which supersedes v1 and makes v2 live), then write a certificate that
    // points BACK at v1 — reported against a claim that is no longer live while every bound check
    // reads v2
    await certification.supersede(projectId, { billId, reason: 'restated' }, pmc(projectId));
    await bills.amend(projectId, {
      billId, reason: 'corrected quantity',
      lines: [{ poLineId: line.poLineId, quantity: '100', rate: '1' }],
    }, pmc(projectId));
    const v2 = await t.prisma.vendorBillVersion.findFirstOrThrow({ where: { projectId, billId, supersededAt: null } });
    expect(v2.id).not.toBe(v1.id);

    await expect(t.prisma.$transaction([
      t.prisma.$executeRawUnsafe(
        `INSERT INTO "BillCertificate" ("id","projectId","billId","versionId","certifiedAmount","certifiedById","sourceCommandId")
         SELECT 'stale-version', $1, $2, $3, 100, "certifiedById", "sourceCommandId" FROM "BillCertificate" WHERE "id" = $4`,
        projectId, billId, v1.id, cert.id,
      ),
      t.prisma.$executeRawUnsafe(
        `INSERT INTO "CertifiedAcceptanceConsumption" ("id","projectId","certificateId","stockTransactionId","consumedQty")
         VALUES ('stale-version-ev',$1,'stale-version',$2,100)`, projectId, acceptanceTxId,
      ),
    ])).rejects.toThrow(/cannot outlive it/u);
  });

  // ── Codex round-3 findings ───────────────────────────────────────────────────────────────────

  it('R3-F1 (§D/§E/§0b): the LABOUR evidence is locked before the bill too, so a correction cannot deadlock it', async () => {
    const projectId = await freshProject();
    const l = await labourMeasurableLine(projectId, 4);
    const original = await measurement.take(projectId, {
      labourPoLineId: l.poLineId, activityId: l.activityId, quantity: '2',
      measuredOn: '2026-08-10', citedOutputId: l.outputId,
    }, await store(projectId));
    const billId = await verifiedClaim(projectId, l.vendorId, l.poLineId, '2', 'labour');

    // Round 1 moved the material LOTS above the bill and left the labour half exactly as it was.
    // The measurement-correction path locks the activity, inserts the correction (an FK row lock on
    // the original `Measurement`), and only then disputes the bill — so a bill-first certifier
    // holds B waiting for M while the correction holds M waiting to dispute B.
    const other = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL! } } });
    const watcher = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL! } } });
    try {
      const waitUntilBlocked = async (): Promise<void> => {
        for (let i = 0; i < 400; i += 1) {
          const rows = await watcher.$queryRaw<Array<{ c: number }>>`
            SELECT COUNT(*)::int AS c FROM pg_stat_activity
             WHERE wait_event_type = 'Lock' AND state = 'active'`;
          if ((rows[0]?.c ?? 0) >= 1) return;
          await new Promise((r) => setTimeout(r, 25));
        }
        throw new Error('barrier timeout: certification never blocked on a lock');
      };

      let release!: () => void;
      let acquired!: () => void;
      const held = new Promise<void>((r) => { release = r; });
      const holdingMeasurement = new Promise<void>((r) => { acquired = r; });
      const sessionA = other.$transaction(async (tx) => {
        await tx.$queryRawUnsafe(`SELECT "id" FROM "Measurement" WHERE "projectId" = $1 AND "id" = $2 FOR UPDATE`, projectId, original.id);
        acquired();
        await held;
        await tx.$queryRawUnsafe(`SELECT "id" FROM "VendorBill" WHERE "projectId" = $1 AND "id" = $2 FOR UPDATE`, projectId, billId);
      }, { timeout: 30_000 });

      await holdingMeasurement;
      const sessionB = certification.certify(projectId, { billId }, pmc(projectId));
      await waitUntilBlocked();
      release();
      await sessionA;
      const cert = await sessionB;
      expect(cert.measurementConsumption).toEqual([{ rowId: original.id, consumedQty: '2' }]);
    } finally {
      await other.$disconnect();
      await watcher.$disconnect();
    }
  });

  it('R3-F4 (§E): the frozen set is CLOSED after certification — no later evidence may be appended', async () => {
    const projectId = await freshProject();
    const line = await issuedMaterialLine(projectId, { qty: '200' });
    const a = await acceptOnLine(projectId, line, '1');
    const b = await acceptOnLine(projectId, line, '100');
    const billId = await verifiedClaim(projectId, line.vendorId, line.poLineId, '1');
    const cert = await certification.certify(projectId, { billId }, pmc(projectId));
    expect(cert.acceptanceConsumption).toEqual([{ rowId: a.acceptanceTxId, consumedQty: '1' }]);

    // acceptance B is real, on the same claimed line, and unconsumed — every per-row rule passes.
    // Appending it would make `readCertificate` and the reversal guard treat B as evidence this
    // certificate never rested on.
    await expect(t.prisma.$executeRawUnsafe(
      `INSERT INTO "CertifiedAcceptanceConsumption" ("id","projectId","certificateId","stockTransactionId","consumedQty")
       VALUES ('appended',$1,$2,$3,1)`, projectId, cert.id, b.acceptanceTxId,
    )).rejects.toThrow(/rests on EXACTLY the evidence it claimed/u);
  });

  it('R3-F5 (§E): withdrawing evidence re-checks the freeze at the DATABASE, not only in the service', async () => {
    const projectId = await freshProject();
    const line = await issuedMaterialLine(projectId, { qty: '200' });
    const a = await acceptOnLine(projectId, line, '100');
    const billId = await verifiedClaim(projectId, line.vendorId, line.poLineId, '100');
    const cert = await certification.certify(projectId, { billId }, pmc(projectId));
    expect(cert.acceptanceConsumption).toEqual([{ rowId: a.acceptanceTxId, consumedQty: '100' }]);

    // a SECOND acceptance keeps the aggregate high, so the older aggregate bound stays satisfied
    // while THIS certificate's frozen row is emptied underneath it
    await acceptOnLine(projectId, line, '100');
    const lot = await t.prisma.stockTransaction.findFirstOrThrow({
      where: { projectId, id: a.acceptanceTxId }, select: { lotId: true, storeLocation: true, qty: true },
    });
    const cmd = await t.prisma.commandExecution.findFirstOrThrow({ where: { projectId }, select: { id: true } });

    // a MAINTENANCE reversal, bypassing the service guard entirely
    await expect(t.prisma.$executeRawUnsafe(
      `INSERT INTO "StockTransaction" ("id","projectId","lotId","storeLocation","type","qty","fromBucket","toBucket","recordedById","sourceCommandId","reversedTxId","reason")
       VALUES ('forged-reversal',$1,$2,$3,'reversal',$4,'acceptedOnHand','quarantine',$5,$6,$7,'maintenance')`,
      projectId, lot.lotId, lot.storeLocation, lot.qty, f.memberUser.id, cmd.id, a.acceptanceTxId,
    )).rejects.toThrow(/frozen evidence cannot exceed the evidence/u);
  });

  it('R3-F6 (§I): the author of a POSITIVE correction is an evidence actor too', async () => {
    const projectId = await freshProject();
    const storeUser = await store(projectId);
    const l = await labourMeasurableLine(projectId, 4);
    // the STORE user takes the original 2 person-shifts …
    const original = await measurement.take(projectId, {
      labourPoLineId: l.poLineId, activityId: l.activityId, quantity: '2',
      measuredOn: '2026-08-10', citedOutputId: l.outputId,
    }, storeUser);
    // … and the MEMBER adds 2 more by correction, then tries to certify the resulting 4-shift claim.
    // The draw freezes the ORIGINAL's id, so asking only `takenById` would miss the member entirely
    // — and they supplied half the evidence being certified.
    await measurement.correct(projectId, {
      measurementId: original.id, quantity: '2', reason: 'under-measured',
    }, pmc(projectId));
    const billId = await verifiedClaim(projectId, l.vendorId, l.poLineId, '4', 'labour');

    await expect(certification.certify(projectId, { billId }, pmc(projectId)))
      .rejects.toThrow(/Segregation of duties/u);

    // the store user did not author the correction that grew it, but DID take the original, so §I
    // binds them as well — the rule is about the evidence, not about who touched it last
    await expect(certification.certify(projectId, { billId }, storeUser))
      .rejects.toThrow(/Segregation of duties/u);
  });

  // ── Codex round-4 findings ───────────────────────────────────────────────────────────────────

  it('R4-F1 (§D/§E/§0b): the ACTIVITY is locked before the MEASUREMENT, matching the correction path', async () => {
    const projectId = await freshProject();
    const l = await labourMeasurableLine(projectId, 4);
    const original = await measurement.take(projectId, {
      labourPoLineId: l.poLineId, activityId: l.activityId, quantity: '2',
      measuredOn: '2026-08-10', citedOutputId: l.outputId,
    }, await store(projectId));
    const billId = await verifiedClaim(projectId, l.vendorId, l.poLineId, '2', 'labour');

    // Round 3 moved the labour evidence above the bill and got the INTERNAL order backwards:
    // `CommercialMeasurementService.append` locks the ACTIVITY and then inserts the correction
    // (whose FK key-share-locks the original measurement), so a certifier holding M and waiting for
    // A deadlocks against a correction holding A and waiting for M.
    const other = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL! } } });
    const watcher = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL! } } });
    try {
      const waitUntilBlocked = async (): Promise<void> => {
        for (let i = 0; i < 400; i += 1) {
          const rows = await watcher.$queryRaw<Array<{ c: number }>>`
            SELECT COUNT(*)::int AS c FROM pg_stat_activity
             WHERE wait_event_type = 'Lock' AND state = 'active'`;
          if ((rows[0]?.c ?? 0) >= 1) return;
          await new Promise((r) => setTimeout(r, 25));
        }
        throw new Error('barrier timeout: certification never blocked on a lock');
      };

      let release!: () => void;
      let acquired!: () => void;
      const held = new Promise<void>((r) => { release = r; });
      const holdingActivity = new Promise<void>((r) => { acquired = r; });
      // session A takes the CORRECTION path's order: activity, then the measurement
      const sessionA = other.$transaction(async (tx) => {
        await tx.$queryRawUnsafe(`SELECT "id" FROM "Activity" WHERE "projectId" = $1 AND "id" = $2 FOR UPDATE`, projectId, l.activityId);
        acquired();
        await held;
        await tx.$queryRawUnsafe(`SELECT "id" FROM "Measurement" WHERE "projectId" = $1 AND "id" = $2 FOR UPDATE`, projectId, original.id);
      }, { timeout: 30_000 });

      await holdingActivity;
      const sessionB = certification.certify(projectId, { billId }, pmc(projectId));
      await waitUntilBlocked();
      release();
      await sessionA;
      const cert = await sessionB;
      expect(cert.measurementConsumption).toEqual([{ rowId: original.id, consumedQty: '2' }]);
    } finally {
      await other.$disconnect();
      await watcher.$disconnect();
    }
  });

  it('R4-F2 (§E): two concurrent freezes against ONE acceptance row cannot both commit', async () => {
    const projectId = await freshProject();
    const line = await issuedMaterialLine(projectId, { qty: '200' });
    // TWO acceptance rows so two bills can each verify honestly, and two BILLS because the
    // one-live-certificate-per-bill index would otherwise refuse the second forgery — a refusal
    // from the wrong seal proves nothing about the missing row lock.
    const a = await acceptOnLine(projectId, line, '100');
    await acceptOnLine(projectId, line, '100');
    const bill1 = await verifiedClaim(projectId, line.vendorId, line.poLineId, '100');
    const bill2 = await verifiedClaim(projectId, line.vendorId, line.poLineId, '60');
    const v1 = await t.prisma.vendorBillVersion.findFirstOrThrow({ where: { projectId, billId: bill1, supersededAt: null } });
    const v2 = await t.prisma.vendorBillVersion.findFirstOrThrow({ where: { projectId, billId: bill2, supersededAt: null } });
    const cmd = await t.prisma.commandExecution.findFirstOrThrow({ where: { projectId }, select: { id: true } });

    // `SET CONSTRAINTS ALL IMMEDIATE` fires the deferred checks at a moment the TEST chooses,
    // while BOTH transactions are still open. That is what makes this deterministic: simply
    // committing two transactions lets PostgreSQL serialize the commits, so the second one's check
    // sees the first's rows and refuses for the right answer by accident. Here each check runs
    // with the other transaction still uncommitted — the exact READ COMMITTED window the finding
    // names. Without `FOR UPDATE` on the acceptance row, both see only their own consumption and
    // both pass; with it, the second blocks until the first commits and is then refused.
    const forge = async (client: PrismaClient, id: string, billId: string, versionId: string, qty: number,
                         checked: () => void, commitWhen: Promise<void>) =>
      client.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(
          `INSERT INTO "BillCertificate" ("id","projectId","billId","versionId","certifiedAmount","certifiedById","sourceCommandId")
           VALUES ($5,$1,$2,$3,$6,$4,$7)`,
          projectId, billId, versionId, f.memberUser.id, id, qty, cmd.id,
        );
        await tx.$executeRawUnsafe(
          `INSERT INTO "CertifiedAcceptanceConsumption" ("id","projectId","certificateId","stockTransactionId","consumedQty")
           VALUES ($2,$1,$3,$4,$5)`, projectId, `${id}-ev`, id, a.acceptanceTxId, qty,
        );
        await tx.$executeRawUnsafe(
          `UPDATE "VendorBill" SET "status"='certified', "statusChangedAt"=now() WHERE "projectId"=$1 AND "id"=$2`,
          projectId, billId,
        );
        // fire the deferred checks NOW, with the sibling transaction still open …
        await tx.$executeRawUnsafe('SET CONSTRAINTS ALL IMMEDIATE');
        checked();
        // … and hold OPEN afterwards, so neither transaction's rows become visible to the other's
        // check. Committing right after the check lets whichever runs second see the first's rows
        // and refuse for the right answer by accident — which is what the first two versions of
        // this probe did, passing against the unlocked predicate.
        await commitWhen;
      }, { timeout: 30_000 });

    const c1 = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL! } } });
    const c2 = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL! } } });
    try {
      let commit!: () => void;
      const mayCommit = new Promise<void>((r) => { commit = r; });
      let aChecked!: () => void;
      const firstChecked = new Promise<void>((r) => { aChecked = r; });
      const t1 = forge(c1, 'race-a', bill1, v1.id, 100, aChecked, mayCommit);
      await firstChecked;
      // T1 has PASSED its check and is holding open. Under the fix it also holds `FOR UPDATE` on
      // the acceptance row, so T2's check BLOCKS here; without it, T2's check sees only its own
      // consumption and passes too.
      const t2 = forge(c2, 'race-b', bill2, v2.id, 60, () => {}, mayCommit);
      await new Promise((r) => setTimeout(r, 500));
      commit();
      await Promise.allSettled([t1, t2]);

      // whatever survives, the frozen total on that row can never exceed what the row carries
      const frozen = await t.prisma.certifiedAcceptanceConsumption.findMany({
        where: { projectId, stockTransactionId: a.acceptanceTxId, certificate: { is: { supersededAt: null } } },
        select: { consumedQty: true },
      });
      const total = frozen.reduce((acc, r) => acc.add(r.consumedQty), new Prisma.Decimal(0));
      expect(total.toNumber(), 'live certificates freeze more of this acceptance than it carries').toBeLessThanOrEqual(100);
    } finally {
      await c1.$disconnect();
      await c2.$disconnect();
    }
  });

  it('R4-F4 (§F): the LIVE certificate read never reports a superseded one', async () => {
    const projectId = await freshProject();
    const line = await issuedMaterialLine(projectId, { qty: '100' });
    await acceptOnLine(projectId, line, '100');
    const billId = await verifiedClaim(projectId, line.vendorId, line.poLineId, '100');
    await certification.certify(projectId, { billId }, pmc(projectId));

    // The window is BETWEEN resolving the live certificate and reading it back. Asserting only that
    // a fully-committed supersession 404s would pass against the defective code too, so the probe
    // makes the supersession land INSIDE the read: the client is proxied so the first
    // `billCertificate.findFirst` triggers a supersede before returning.
    //
    // With the liveness predicate carried into the single query, the read either returns a
    // certificate that WAS live or nothing. Without it, the second query reloads by id and hands
    // back a row stamped `supersededAt` from a route documented to return the live one.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const svc = certification as any;
    const realPrisma = svc.prisma;
    let fired = false;
    svc.prisma = new Proxy(realPrisma, {
      get(target: never, prop: string) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const value = (target as any)[prop];
        if (prop !== 'billCertificate') return typeof value === 'function' ? value.bind(target) : value;
        return new Proxy(value, {
          get(delegate: never, method: string) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const fn = (delegate as any)[method];
            if (method !== 'findFirst') return typeof fn === 'function' ? fn.bind(delegate) : fn;
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            return async (args: any) => {
              const result = await fn.call(delegate, args);
              if (!fired) {
                fired = true;
                await certification.supersede(projectId, { billId, reason: 'raced' }, pmc(projectId));
              }
              return result;
            };
          },
        });
      },
    });
    try {
      const read = await certification.readCertificate(projectId, billId, pmc(projectId)).catch((e) => e);
      if (read instanceof Error) {
        expect(read).toMatchObject({ status: 404 });
      } else {
        expect(read.supersededAt, 'the LIVE route reported a superseded certificate').toBeNull();
      }
    } finally {
      svc.prisma = realPrisma;
    }

    // and once the supersession is settled, the live route is a plain 404
    await expect(certification.readCertificate(projectId, billId, pmc(projectId)))
      .rejects.toMatchObject({ status: 404 });
  });

  // ── Codex round-5 findings, and the restructure they forced ─────────────────────────────────

  it('R5-F1 (§E): a SUPERSEDED certificate never gains new evidence', async () => {
    const projectId = await freshProject();
    const line = await issuedMaterialLine(projectId, { qty: '200' });
    const a = await acceptOnLine(projectId, line, '100');
    const b = await acceptOnLine(projectId, line, '100');
    const billId = await verifiedClaim(projectId, line.vendorId, line.poLineId, '100');
    const cert = await certification.certify(projectId, { billId }, pmc(projectId));
    expect(cert.acceptanceConsumption).toEqual([{ rowId: a.acceptanceTxId, consumedQty: '100' }]);
    await certification.supersede(projectId, { billId, reason: 'restated' }, pmc(projectId));

    // Acceptance B is real, unconsumed, and on a line the bill's LIVE version still claims, so the
    // per-row seal passes it — and the whole-certificate seal deliberately returns early for
    // history. Appending it would make the certificate's own replay report evidence the original
    // act never consumed. What a certification RESTED ON is not editable afterwards.
    await expect(t.prisma.$executeRawUnsafe(
      `INSERT INTO "CertifiedAcceptanceConsumption" ("id","projectId","certificateId","stockTransactionId","consumedQty")
       VALUES ('late-evidence',$1,$2,$3,1)`, projectId, cert.id, b.acceptanceTxId,
    )).rejects.toThrow(/history does not gain new rows/u);

    // precision: the same append on a LIVE certificate is refused by the COMPLETENESS seal, not by
    // the append-closure — the two rules are distinct and each still reaches its own case
    const relived = await certification.certify(projectId, { billId }, pmc(projectId));
    await expect(t.prisma.$executeRawUnsafe(
      `INSERT INTO "CertifiedAcceptanceConsumption" ("id","projectId","certificateId","stockTransactionId","consumedQty")
       VALUES ('live-append',$1,$2,$3,1)`, projectId, relived.id, b.acceptanceTxId,
    )).rejects.toThrow(/rests on EXACTLY the evidence it claimed/u);
  });

  it('R5-F3 (§I): the DATABASE seal counts correction authors too — the service is not its own witness', async () => {
    const projectId = await freshProject();
    const storeUser = await store(projectId);
    const l = await labourMeasurableLine(projectId, 4);
    const original = await measurement.take(projectId, {
      labourPoLineId: l.poLineId, activityId: l.activityId, quantity: '2',
      measuredOn: '2026-08-10', citedOutputId: l.outputId,
    }, storeUser);
    // the CERTIFIER supplies the other half by correction — round 3 taught the service this and
    // left the SQL seal reading `takenById` alone, so a direct path could certify anyway
    await measurement.correct(projectId, {
      measurementId: original.id, quantity: '2', reason: 'under-measured',
    }, pmc(projectId));
    const billId = await verifiedClaim(projectId, l.vendorId, l.poLineId, '4', 'labour');
    const version = await t.prisma.vendorBillVersion.findFirstOrThrow({ where: { projectId, billId, supersededAt: null } });
    const cmd = await t.prisma.commandExecution.findFirstOrThrow({ where: { projectId }, select: { id: true } });

    // the forged certificate freezes the ORIGINAL row's id — taken by the store user — so the old
    // seal saw a certifier who had recorded none of it
    await expect(t.prisma.$transaction([
      t.prisma.$executeRawUnsafe(
        `INSERT INTO "BillCertificate" ("id","projectId","billId","versionId","certifiedAmount","certifiedById","sourceCommandId")
         VALUES ('corrector',$1,$2,$3,4,$4,$5)`, projectId, billId, version.id, f.memberUser.id, cmd.id,
      ),
      t.prisma.$executeRawUnsafe(
        `INSERT INTO "CertifiedMeasurementConsumption" ("id","projectId","certificateId","measurementId","consumedQty")
         VALUES ('corrector-ev',$1,'corrector',$2,4)`, projectId, original.id,
      ),
      t.prisma.$executeRawUnsafe(
        `UPDATE "VendorBill" SET "status"='certified', "statusChangedAt"=now() WHERE "projectId"=$1 AND "id"=$2`,
        projectId, billId,
      ),
    ])).rejects.toThrow(/who recorded evidence it rests on — §I refuses the act/u);

    // precision: the SAME forgery by a certifier who is in neither the taker nor the corrector set
    // is accepted, so the seal is counting the actor set and not simply refusing labour evidence
    await expect(t.prisma.$transaction([
      t.prisma.$executeRawUnsafe(
        `INSERT INTO "BillCertificate" ("id","projectId","billId","versionId","certifiedAmount","certifiedById","sourceCommandId")
         VALUES ('outsider',$1,$2,$3,4,$4,$5)`, projectId, billId, version.id, f.strangerUser.id, cmd.id,
      ),
      t.prisma.$executeRawUnsafe(
        `INSERT INTO "CertifiedMeasurementConsumption" ("id","projectId","certificateId","measurementId","consumedQty")
         VALUES ('outsider-ev',$1,'outsider',$2,4)`, projectId, original.id,
      ),
      t.prisma.$executeRawUnsafe(
        `UPDATE "VendorBill" SET "status"='certified', "statusChangedAt"=now() WHERE "projectId"=$1 AND "id"=$2`,
        projectId, billId,
      ),
    ])).resolves.toBeDefined();
  });

  // ── Codex round-6 finding, carried into this unit ───────────────────────────────────────────

  it('R6 (§E): the append-closure SERIALIZES against a supersession rather than racing it', async () => {
    const projectId = await freshProject();
    const line = await issuedMaterialLine(projectId, { qty: '200' });
    const a = await acceptOnLine(projectId, line, '100');
    const b = await acceptOnLine(projectId, line, '100');
    const billId = await verifiedClaim(projectId, line.vendorId, line.poLineId, '100');
    const cert = await certification.certify(projectId, { billId }, pmc(projectId));
    expect(cert.acceptanceConsumption).toEqual([{ rowId: a.acceptanceTxId, consumedQty: '100' }]);

    // Round 5 added the append-closure and read `supersededAt` WITHOUT a lock. Round 6's finding is
    // that an unlocked read is a decision about a row another transaction may be changing: at READ
    // COMMITTED the appending transaction sees the certificate's OLD version, decides it is open,
    // and the completeness check — which returns early for history — then waves the row through
    // onto a certificate that became history in between.
    //
    // The probe holds the supersession UNCOMMITTED while the append runs, which is the window the
    // finding names. `FOR UPDATE` turns it into a wait: the append blocks on the supersession's row
    // lock, and once that commits it re-reads the certificate as history and refuses. Without the
    // lock the append reads the stale live row and commits evidence onto a superseded certificate.
    const holder = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL! } } });
    const appender = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL! } } });
    try {
      let release!: () => void;
      const mayCommit = new Promise<void>((r) => { release = r; });
      let stamped!: () => void;
      const isStamped = new Promise<void>((r) => { stamped = r; });

      const supersession = holder.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(
          `UPDATE "BillCertificate" SET "supersededAt"=now(), "supersededById"=$3, "supersedeReason"='restated'
            WHERE "projectId"=$1 AND "id"=$2`, projectId, cert.id, f.memberUser.id,
        );
        await tx.$executeRawUnsafe(
          `UPDATE "VendorBill" SET "status"='verified', "statusChangedAt"=now() WHERE "projectId"=$1 AND "id"=$2`,
          projectId, billId,
        );
        stamped();
        await mayCommit;
      }, { timeout: 30_000 });
      await isStamped;

      // the append fires its deferred checks while the supersession is still OPEN
      const append = appender.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(
          `INSERT INTO "CertifiedAcceptanceConsumption" ("id","projectId","certificateId","stockTransactionId","consumedQty")
           VALUES ('late-race',$1,$2,$3,1)`, projectId, cert.id, b.acceptanceTxId,
        );
        await tx.$executeRawUnsafe('SET CONSTRAINTS ALL IMMEDIATE');
      }, { timeout: 30_000 });
      const settled = append.then(() => 'committed' as const, () => 'refused' as const);

      // Condition-based, never a sleep: wait for the appending session to be WAITING on a lock.
      // The wait is TOLERANT on purpose — under the defect no lock is taken and nothing ever
      // blocks, and a hard assertion here would end the probe on the mechanism rather than on the
      // outcome. The outcome is what must carry the finding, so the probe releases either way and
      // asserts what actually happened to the evidence.
      const blocked = await (async () => {
        for (let i = 0; i < 60; i++) {
          const rows = await t.prisma.$queryRaw<Array<{ n: bigint }>>(Prisma.sql`
            SELECT COUNT(*) AS n FROM pg_stat_activity
             WHERE wait_event_type = 'Lock' AND state = 'active' AND query ILIKE '%SET CONSTRAINTS%'`);
          if (Number(rows[0]!.n) > 0) return true;
          if ((await Promise.race([settled, Promise.resolve('pending' as const)])) !== 'pending') return false;
          await new Promise((r) => setTimeout(r, 100));
        }
        return false;
      })();

      release();
      await supersession;

      // THE MECHANISM is what this probe isolates, and the reason is worth stating rather than
      // leaving a reader to wonder why the outcome assertion below is not the primary one.
      //
      // The interleaving the finding names lives INSIDE one trigger invocation: the append-closure
      // reads the certificate live, the supersession commits, and the completeness check — a
      // separate statement, so a separate READ COMMITTED snapshot — then sees history and returns
      // early. Scheduling a commit between two statements of one trigger call is not something a
      // test can do from outside without a debug hook, so an outcome assertion here CANNOT isolate
      // this finding: with the lock removed the append is still refused, but by the completeness
      // seal noticing 101 frozen against 100 claimed. That is a refusal from the wrong seal, and
      // this file has been caught by exactly that four times.
      //
      // What the probe can prove, deterministically, is the fix itself: the append now WAITS on
      // the certificate row instead of reading a stale version of it, which is what closes the
      // window rather than narrowing it. Without `FOR UPDATE` nothing ever blocks and this fails.
      expect(blocked, 'the append never waited on the certificate row — it read it unlocked').toBe(true);
      // and the outcome, which holds either way and is asserted because it is what a reader cares
      // about: history gained no rows
      expect(await settled).toBe('refused');
      expect(await t.prisma.certifiedAcceptanceConsumption.count({
        where: { projectId, certificateId: cert.id },
      })).toBe(1);
    } finally {
      await holder.$disconnect();
      await appender.$disconnect();
    }
  });

  it('PROBE 15 (§0): the three new tables are closed under the shared-database reset', async () => {
    // The reset lists are hand-mirrored across ~40 suites, and a table with an inbound FK that is
    // missing from one of them fails in whichever suite tears down LAST rather than in the one
    // that leaked. `truncate-closure.test.ts` derives the rule from the DMMF — but two of these
    // three tables reach `StockTransaction` and `Measurement` through RAW-SQL foreign keys the
    // DMMF cannot see, so this asks PostgreSQL itself.
    const rows = await t.prisma.$queryRaw<Array<{ referrer: string; target: string }>>(Prisma.sql`
      SELECT c.conrelid::regclass::text AS "referrer", c.confrelid::regclass::text AS "target"
        FROM pg_constraint c
       WHERE c.contype = 'f'
         AND c.confrelid::regclass::text IN (
           '"BillCertificate"', '"CertifiedAcceptanceConsumption"',
           '"CertifiedMeasurementConsumption"')`);
    const listed = new Set([...TRUNCATE.matchAll(/"([A-Za-z0-9_]+)"/gu)].map((m) => m[1]!));
    const missing = rows
      .map((r) => r.referrer.replace(/"/gu, ''))
      .filter((referrer) => !listed.has(referrer));
    expect([...new Set(missing)].sort()).toEqual([]);
    // precision: the query must have found the real graph, not an empty one
    expect(rows.length).toBeGreaterThan(0);
  });
});
