import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { Prisma } from '@prisma/client';
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
    'TRUNCATE TABLE "SodException", "CertifiedMeasurementConsumption", "CertifiedAcceptanceConsumption", "BillCertificate", "BillVerification", "VendorBillLine", "VendorBillVersion", "VendorBill", "DomainEvent", "OutboxDelivery", "ProcessedEvent", "ProjectionCursor", "ProjectionGeneration", "DecisionProjection", "DailyLogProjection", "DrawingsProjection", "InspectionsProjection", "ActivitiesProjection", "MaterialReadinessProjection", "LabourReadinessProjection", "Measurement", "BudgetException", "BudgetLine", "CommitmentAttribution", "CostHead", "LabourMismatchResolution", "LabourMismatch", "ActivityWorkOutput", "LabourWorkFact", "WorkerAllocation", "LabourAttendance", "ApprovedSkillSubstitution", "CapacityPromise", "CapacityCommitment", "LabourPurchaseOrderLine", "LabourPurchaseOrderVersion", "LabourPurchaseOrder", "LabourQuoteComparison", "SupplierLabourQuoteLine", "SupplierLabourQuote", "LabourRfq", "LabourRequisitionLine", "LabourRequisition", "VendorLabourProfile", "StockTransaction", "MaterialIssue", "StockLot", "DeliveryPromise", "DeliveryCommitment", "PurchaseOrderLine", "PurchaseOrderVersion", "PurchaseOrder", "VendorQuoteLine", "QuoteComparison", "VendorQuote", "Rfq", "RequisitionLine", "Requisition", "ProjectVendor", "CommandExecution", "CrewMembership", "Crew", "WorkerDevice", "WorkerSkill", "Worker", "ApprovedSubstitution", "LabourDemandSlice", "LabourRequirementSpec", "LabourTrade", "LabourSkill", "MaterialRequirementSpec", "ActivityRequirement", "ActivityRequirementRoot", "DecisionApprovalRevision", "ProjectCapability" CASCADE';

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
    expect(cert.sodException).toBeNull();
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

  it('PROBE 8 (§I): the actor who recorded the evidence may not certify it, and the exception is NAMED', async () => {
    const projectId = await freshProject();
    const approver = await secondPmc(projectId);
    const line = await issuedMaterialLine(projectId, { qty: '100' });
    // the acceptance is recorded by the member — the same actor who will attempt certification.
    // §I binds MATERIAL bills too: with no `Measurement` row, the acceptance actor IS the measurer.
    await acceptOnLine(projectId, line, '100', pmc(projectId));
    const billId = await verifiedClaim(projectId, line.vendorId, line.poLineId, '100');

    await expect(certification.certify(projectId, { billId }, pmc(projectId)))
      .rejects.toThrow(/Segregation of duties/u);

    // the approver must not be the actor being excused — a signature on a mirror
    await expect(certification.certify(projectId, {
      billId, sodOverride: { approverId: f.memberUser.id, reason: 'two-person practice' },
    }, pmc(projectId))).rejects.toThrow(/cannot be authorised by the actor it excuses/u);

    // and must be an ACTIVE pmc on this project
    await expect(certification.certify(projectId, {
      billId, sodOverride: { approverId: f.strangerUser.id, reason: 'two-person practice' },
    }, pmc(projectId))).rejects.toThrow(/active pmc on this project/u);

    const cert = await certification.certify(projectId, {
      billId, sodOverride: { approverId: approver, reason: 'two-person practice; site engineer is the only store user' },
    }, pmc(projectId));
    expect(cert.sodException).toEqual({
      rule: 'evidence-recorder-may-not-certify',
      actorId: f.memberUser.id,
      approverId: approver,
      reason: 'two-person practice; site engineer is the only store user',
      recordedAt: expect.any(String),
    });
    // §I — the exception is bound to THAT certificate, never a standing waiver
    const rows = await t.prisma.sodException.findMany({ where: { projectId } });
    expect(rows.map((r) => r.certificateId)).toEqual([cert.id]);
  });

  it('PROBE 9 (§I): a certification by someone who recorded NO evidence needs no exception', async () => {
    const projectId = await freshProject();
    const line = await issuedMaterialLine(projectId, { qty: '100' });
    // the acceptance is recorded by the OTHER pmc, so the member certifying is not the recorder
    await acceptOnLine(projectId, line, '100');
    const billId = await verifiedClaim(projectId, line.vendorId, line.poLineId, '100');
    const cert = await certification.certify(projectId, { billId }, pmc(projectId));
    expect(cert.sodException).toBeNull();
    expect(await t.prisma.sodException.count({ where: { projectId } })).toBe(0);
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

  it('PROBE 12 (§E/§I): every new table is APPEND-ONLY at PostgreSQL', async () => {
    const projectId = await freshProject();
    const approver = await secondPmc(projectId);
    const line = await issuedMaterialLine(projectId, { qty: '100' });
    await acceptOnLine(projectId, line, '100', pmc(projectId));
    const billId = await verifiedClaim(projectId, line.vendorId, line.poLineId, '100');
    const cert = await certification.certify(projectId, {
      billId, sodOverride: { approverId: approver, reason: 'two-person practice' },
    }, pmc(projectId));

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

    // the consumption sets and the exception: fully immutable, both arms
    for (const table of ['CertifiedAcceptanceConsumption', 'SodException']) {
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
    await expect(t.prisma.$executeRawUnsafe(
      `INSERT INTO "BillCertificate" ("id","projectId","billId","versionId","certifiedAmount","certifiedById","sourceCommandId")
       SELECT 'coherent-bound', $1, $2, $3, 100, "certifiedById", "sourceCommandId" FROM "BillCertificate" WHERE "id" = $4`,
      projectId, billId, version.id, cert.id,
    )).resolves.toBeDefined();
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

  it('PROBE 15 (§0): the four new tables are closed under the shared-database reset', async () => {
    // The reset lists are hand-mirrored across ~40 suites, and a table with an inbound FK that is
    // missing from one of them fails in whichever suite tears down LAST rather than in the one
    // that leaked. `truncate-closure.test.ts` derives the rule from the DMMF — but three of these
    // four tables reach `StockTransaction`, `Measurement` and `CommandExecution` through RAW-SQL
    // foreign keys the DMMF cannot see, so this asks PostgreSQL itself.
    const rows = await t.prisma.$queryRaw<Array<{ referrer: string; target: string }>>(Prisma.sql`
      SELECT c.conrelid::regclass::text AS "referrer", c.confrelid::regclass::text AS "target"
        FROM pg_constraint c
       WHERE c.contype = 'f'
         AND c.confrelid::regclass::text IN (
           '"BillCertificate"', '"CertifiedAcceptanceConsumption"',
           '"CertifiedMeasurementConsumption"', '"SodException"')`);
    const listed = new Set([...TRUNCATE.matchAll(/"([A-Za-z0-9_]+)"/gu)].map((m) => m[1]!));
    const missing = rows
      .map((r) => r.referrer.replace(/"/gu, ''))
      .filter((referrer) => !listed.has(referrer));
    expect([...new Set(missing)].sort()).toEqual([]);
    // precision: the query must have found the real graph, not an empty one
    expect(rows.length).toBeGreaterThan(0);
  });
});
