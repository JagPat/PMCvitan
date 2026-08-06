import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { PrismaClient, Prisma } from '@prisma/client';
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
import { CommercialActivationService } from '../../src/commercial/commercial-activation.service';
import { CommercialBillService } from '../../src/commercial/commercial-bill.service';
import { CommercialBudgetService } from '../../src/commercial/commercial-budget.service';
import { CommercialVerificationService } from '../../src/commercial/commercial-verification.service';
import { CommercialCertificationService } from '../../src/commercial/commercial-certification.service';
import { CommercialMeasurementService } from '../../src/commercial/commercial-measurement.service';
import { CommercialDeductionService } from '../../src/commercial/commercial-deduction.service';
import { CommercialPaymentService } from '../../src/commercial/commercial-payment.service';
import { CapabilitiesService, LABOUR_CAPABILITY, MATERIALS_CAPABILITY } from '../../src/platform/capabilities.service';
import type { AuthUser } from '../../src/common/auth';
import type { CostHeadPositionDto } from '@vitan/shared';
import type { CreateRequirementInput } from '../../src/contracts';

/**
 * Phase 5 Task 6A — §F/§G/§I PAYMENT AUTHORITY, proven live against PostgreSQL, reproduce-first.
 *
 * Every bound is probed as a PAIR: the write that must be REFUSED and the neighbouring one that
 * must still be ALLOWED. A refusal alone proves only that something is strict, not that it is
 * right — Task 3's audit closed that as a rule, and 5C's rounds 8 and 10 both turned on it. Round
 * 10 in particular was three findings that each refused VALID work, so the acceptances here carry
 * as much weight as the refusals.
 */
describe('Phase 5 Task 6A — §F/§G/§I payment authority (live PG)', () => {
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
  let activation: CommercialActivationService;
  let bills: CommercialBillService;
  let budget: CommercialBudgetService;
  let verification: CommercialVerificationService;
  let certification: CommercialCertificationService;
  let measurement: CommercialMeasurementService;
  let deductions: CommercialDeductionService;
  let payments: CommercialPaymentService;
  let capabilities: CapabilitiesService;
  let seq = 0;

  const TRUNCATE =
    'TRUNCATE TABLE "Payment", "PaymentApproval", "BillDeductionRelease", "BillDeduction", "SodException", "SodGrant", "CertifiedMeasurementConsumption", "CertifiedAcceptanceConsumption", "BillCertificate", "BillVerification", "VendorBillLine", "VendorBillVersion", "VendorBill", "DomainEvent", "OutboxDelivery", "ProcessedEvent", "ProjectionCursor", "ProjectionGeneration", "DecisionProjection", "DailyLogProjection", "DrawingsProjection", "InspectionsProjection", "ActivitiesProjection", "MaterialReadinessProjection", "LabourReadinessProjection", "Measurement", "BudgetException", "BudgetLine", "CommitmentAttribution", "CostHead", "LabourMismatchResolution", "LabourMismatch", "ActivityWorkOutput", "LabourWorkFact", "WorkerAllocation", "LabourAttendance", "ApprovedSkillSubstitution", "CapacityPromise", "CapacityCommitment", "LabourPurchaseOrderLine", "LabourPurchaseOrderVersion", "LabourPurchaseOrder", "LabourQuoteComparison", "SupplierLabourQuoteLine", "SupplierLabourQuote", "LabourRfq", "LabourRequisitionLine", "LabourRequisition", "VendorLabourProfile", "StockTransaction", "MaterialIssue", "StockLot", "DeliveryPromise", "DeliveryCommitment", "PurchaseOrderLine", "PurchaseOrderVersion", "PurchaseOrder", "VendorQuoteLine", "QuoteComparison", "VendorQuote", "Rfq", "RequisitionLine", "Requisition", "ProjectVendor", "CommandExecution", "CrewMembership", "Crew", "WorkerDevice", "WorkerSkill", "Worker", "ApprovedSubstitution", "LabourDemandSlice", "LabourRequirementSpec", "LabourTrade", "LabourSkill", "MaterialRequirementSpec", "ActivityRequirement", "ActivityRequirementRoot", "DecisionApprovalRevision", "ProjectCapability" CASCADE';

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
    activation = t.app.get(CommercialActivationService);
    bills = t.app.get(CommercialBillService);
    budget = t.app.get(CommercialBudgetService);
    verification = t.app.get(CommercialVerificationService);
    certification = t.app.get(CommercialCertificationService);
    measurement = t.app.get(CommercialMeasurementService);
    deductions = t.app.get(CommercialDeductionService);
    payments = t.app.get(CommercialPaymentService);
    capabilities = t.app.get(CapabilitiesService);
  });
  afterAll(async () => {
    await t?.prisma.$executeRawUnsafe(TRUNCATE);
    await t?.prisma.vendor.deleteMany({ where: { orgId: f.orgA.id } });
    await t?.prisma.membership.deleteMany({ where: { projectId: { startsWith: 'it-p5t5h-' } } });
    await t?.prisma.project.deleteMany({ where: { id: { startsWith: 'it-p5t5h-' } } });
    await f?.cleanup();
    await t?.close();
  });
  afterEach(async () => {
    await t.prisma.$executeRawUnsafe(TRUNCATE);
    await t.prisma.vendor.deleteMany({ where: { orgId: f.orgA.id } });
    for (const [model, where] of [
      ['auditLog', { projectId: { startsWith: 'it-p5t5h-' } }],
      ['media', { projectId: { startsWith: 'it-p5t5h-' } }],
      ['activity', { projectId: { startsWith: 'it-p5t5h-' } }],
      ['membership', { projectId: { startsWith: 'it-p5t5h-' } }],
      ['project', { id: { startsWith: 'it-p5t5h-' } }],
    ] as const) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (t.prisma as any)[model].deleteMany({ where });
    }
  });

  // ── fixtures (the cleared units A/B chain, verbatim — unit C adds no write path) ──────────────

  const freshProject = async (): Promise<string> => {
    const id = `it-p5t5h-${Date.now() % 1e6}-${seq++}`;
    await t.prisma.project.create({
      data: { id, orgId: f.orgA.id, name: id, short: 'P', descriptor: '', stage: 'x', siteCode: 'P', projStart: 'a', projEnd: 'b', elapsedPct: 0, todayDay: 0, milestonePct: 0, timeZone: 'Asia/Kolkata', scheduleStartDate: new Date('2026-06-01T00:00:00.000Z') },
    });
    await t.prisma.membership.create({ data: { projectId: id, userId: f.memberUser.id, role: 'pmc', status: 'active' } });
    await capabilities.enable(id, MATERIALS_CAPABILITY, f.memberUser.id);
    await activation.activate(id, f.memberUser.id, {
      costHeads: [{ code: 'CIVIL', name: 'Civil works' }, { code: 'MEP', name: 'MEP works' }],
      materialLines: [], labourLines: [], reason: 'pilot activation',
    });
    return id;
  };

  const secondPmc = async (projectId: string): Promise<string> => {
    await t.prisma.membership.upsert({
      where: { projectId_userId: { projectId, userId: f.ownerUser.id } },
      create: { projectId, userId: f.ownerUser.id, role: 'pmc', status: 'active' },
      update: { role: 'pmc', status: 'active' },
    });
    return f.ownerUser.id;
  };

  /** The store user records evidence and never certifies — §I's ordinary separation. */
  const store = async (projectId: string): Promise<AuthUser> => asUser(projectId, await secondPmc(projectId));

  const freshActivity = async (projectId: string): Promise<string> => {
    const id = `IT-P5T5H-ACT-${Date.now() % 1e6}-${seq++}`;
    await t.prisma.activity.create({ data: { id, projectId, name: `Act ${seq}`, zone: 'Zone 1', plannedStart: 0, plannedEnd: 10 } });
    return id;
  };

  const freshMedia = async (projectId: string): Promise<string> => {
    const row = await t.prisma.media.create({ data: { projectId, kind: 'material', mime: 'image/jpeg', uploadedBy: f.memberUser.id, sizeBytes: 3 } });
    return row.id;
  };

  /** One issued, committed material PO line of `qty` at ₹1 — so a 100-unit line is ₹100. */
  const issuedMaterialLine = async (
    projectId: string, opts: { qty?: string; costHeadCode?: string; vendorId?: string } = {},
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
    // an EXISTING vendor may be reused: a bill draws on one counterparty's orders only, so a
    // multi-line claim needs its lines ordered from the same party
    const v = opts.vendorId
      ? { id: opts.vendorId }
      : await (async () => {
        const created = await vendors.create(f.orgA.id, { name: `Vendor ${seq++}` }, orgAdmin());
        await vendors.bind(projectId, { vendorId: created.id }, pmc(projectId));
        return created;
      })();
    const withQuote = await procurement.recordQuote(projectId, rfq.id, {
      vendorId: v.id, validUntil: '2027-01-01',
      lines: [{ requisitionLineId: lineId, baseRate: '1', taxAmount: '0', freightAmount: '0', landedCost: '999.99', quotedMake: 'make', matchesSpecification: true }],
    }, pmc(projectId));
    const quoteId = withQuote.quotes.find((q) => q.status === 'recorded')!.id;
    await procurement.createComparison(projectId, rfq.id, pmc(projectId));
    const approved = await procurement.approveComparison(projectId, rfq.id, { selectedQuoteId: quoteId, reason: 'single quote, in spec' }, pmc(projectId));
    const po = await pos.create(projectId, { comparisonId: approved.comparison!.id, lines: [{ requisitionLineId: lineId, purchaseQty: qty }] }, pmc(projectId));
    const line = await t.prisma.purchaseOrderLine.findFirstOrThrow({ where: { projectId, requisitionLineId: lineId } });
    await pos.issue(projectId, po.id, { costHeads: [{ poLineId: line.id, costHeadCode: opts.costHeadCode ?? 'CIVIL' }] }, pmc(projectId));
    const commitment = await pos.commitDelivery(projectId, { poLineId: line.id, promisedDate: '2026-09-01' }, pmc(projectId));
    return { poLineId: line.id, vendorId: v.id, commitmentId: commitment.id };
  };

  const acceptOnLine = async (
    projectId: string, line: { poLineId: string; commitmentId: string }, qty: string,
  ): Promise<void> => {
    const recorder = await store(projectId);
    const lot = await inventory.recordReceipt(projectId, {
      poLineId: line.poLineId, commitmentId: line.commitmentId, storeLocation: 'main', purchaseQty: qty,
    }, pmc(projectId));
    await inventory.accept(projectId, {
      lotId: lot.id, storeLocation: 'main', qty, qualityResult: 'pass', evidenceMediaId: await freshMedia(projectId),
    }, recorder);
  };

  /** record → submit → begin-verification → verify, over one or more PO lines. */
  const verifiedClaim = async (
    projectId: string,
    vendorId: string,
    claims: ReadonlyArray<{ poLineId: string; quantity: string; kind?: 'material' | 'labour' }>,
  ): Promise<string> => {
    const recorded = await bills.record(projectId, {
      vendorId, vendorBillNumber: `V-${seq++}`, documentDate: '2026-08-20',
      lines: claims.map((c) => (c.kind === 'labour'
        ? { labourPoLineId: c.poLineId, quantity: c.quantity, rate: '1000' }
        : { poLineId: c.poLineId, quantity: c.quantity, rate: '1' })),
    }, pmc(projectId));
    await bills.submit(projectId, { billId: recorded.id }, pmc(projectId));
    await bills.beginVerification(projectId, { billId: recorded.id }, pmc(projectId));
    const verdict = await verification.verify(projectId, { billId: recorded.id }, pmc(projectId));
    expect(verdict.verdict, 'the fixture must reach `verified`, or the probe is about the wrong thing').toBe('matched');
    return recorded.id;
  };


  /** certify a ₹100 claim on CIVIL and hand back the bill — every probe below starts here. */
  const certifiedClaim = async (projectId: string, qty = '100'): Promise<string> => {
    const line = await issuedMaterialLine(projectId, { qty });
    await acceptOnLine(projectId, line, qty);
    const billId = await verifiedClaim(projectId, line.vendorId, [{ poLineId: line.poLineId, quantity: qty }]);
    await certification.certify(projectId, { billId }, pmc(projectId));
    return billId;
  };
  // A second person, because §I's whole point is that one actor cannot do both halves. The 5C
  // fixture certifies as `f.memberUser`, so every approval below is made by `f.ownerUser`.
  const approver = (projectId: string): AuthUser => asUser(projectId, f.ownerUser.id);

  it('PROBE 1 (§I): the person who certified may not approve, and someone else may', async () => {
    const projectId = await freshProject();
    const billId = await certifiedClaim(projectId);

    // the certifier is `f.memberUser` — the same actor `pmc()` returns
    await expect(payments.approve(projectId, { billId, amount: '10.00' }, pmc(projectId)))
      .rejects.toThrow(/may not also approve/u);

    // …and a DIFFERENT actor may, so the rule is about the separation and not about approval
    const approval = await payments.approve(projectId, { billId, amount: '10.00' }, approver(projectId));
    expect(approval.amount).toBe('10.00');
    expect(approval.billId).toBe(billId);
  });

  it('PROBE 2 (§G bound 4): approval is capped by what is payable NET of withholdings', async () => {
    const projectId = await freshProject();
    const billId = await certifiedClaim(projectId);
    await deductions.record(projectId, { billId, type: 'retention', amount: '10.00' }, pmc(projectId));

    // gross is 100, but 10 is withheld — approving the gross would make the §H ledger decorative,
    // recording a withholding that never withheld anything
    await expect(payments.approve(projectId, { billId, amount: '100.00' }, approver(projectId)))
      .rejects.toThrow(/past the 90\.00 payable/u);

    // …and exactly the net IS approvable, so the bound is precise rather than merely strict
    await payments.approve(projectId, { billId, amount: '90.00' }, approver(projectId));
    const ledger = await payments.ledger(projectId, billId, pmc(projectId));
    expect(ledger.approved).toBe('90.00');
    expect(ledger.approvable).toBe('0.00');
  });

  it('PROBE 3 (§G bound 4): the cap is CUMULATIVE — two approvals cannot exceed it between them', async () => {
    const projectId = await freshProject();
    const billId = await certifiedClaim(projectId);

    await payments.approve(projectId, { billId, amount: '60.00' }, approver(projectId));
    // 60 + 60 = 120 against a 100 payable. A per-row check would pass both.
    await expect(payments.approve(projectId, { billId, amount: '60.00' }, approver(projectId)))
      .rejects.toThrow(/60\.00 is already approved, so 40\.00 remains/u);

    // the remainder is approvable exactly
    await payments.approve(projectId, { billId, amount: '40.00' }, approver(projectId));
    expect((await payments.ledger(projectId, billId, pmc(projectId))).approved).toBe('100.00');
  });

  it('PROBE 4 (§I): the approval ceiling binds the CUMULATIVE total, so splitting does not clear it', async () => {
    const projectId = await freshProject();
    const billId = await certifiedClaim(projectId);
    // a 50 ceiling on the approver's membership in THIS project
    await t.prisma.membership.updateMany({
      where: { projectId, userId: f.ownerUser.id },
      data: { approvalLimit: new Prisma.Decimal('50.00') },
    });

    // one 60 is over the ceiling
    await expect(payments.approve(projectId, { billId, amount: '60.00' }, approver(projectId)))
      .rejects.toThrow(/above your approval ceiling of 50\.00/u);

    // …and so is 50 + 10, which is the defeat a per-row check would allow: each row within limit,
    // bound 4 satisfied, the ceiling gone
    await payments.approve(projectId, { billId, amount: '50.00' }, approver(projectId));
    await expect(payments.approve(projectId, { billId, amount: '10.00' }, approver(projectId)))
      .rejects.toThrow(/would take the approved total on this claim to 60\.00/u);
  });

  it('PROBE 5 (§G bound 5): money may only leave against an authority that covers it', async () => {
    const projectId = await freshProject();
    const billId = await certifiedClaim(projectId);
    const approval = await payments.approve(projectId, { billId, amount: '40.00' }, approver(projectId));

    await expect(payments.record(projectId, { approvalId: approval.id, amount: '50.00', method: 'neft' }, pmc(projectId)))
      .rejects.toThrow(/past the 40\.00 approved/u);

    // …and the approved amount pays, in parts that sum to it
    await payments.record(projectId, { approvalId: approval.id, amount: '25.00', method: 'neft', reference: 'UTR-1' }, pmc(projectId));
    await payments.record(projectId, { approvalId: approval.id, amount: '15.00', method: 'cheque' }, pmc(projectId));
    await expect(payments.record(projectId, { approvalId: approval.id, amount: '0.01', method: 'neft' }, pmc(projectId)))
      .rejects.toThrow(/past the 40\.00 approved/u);

    const ledger = await payments.ledger(projectId, billId, pmc(projectId));
    expect(ledger.paid).toBe('40.00');
    expect(ledger.approvals[0]!.payments).toHaveLength(2);
  });

  it('PROBE 6 (§0b): an approval and a payment are append-only, and neither takes a negative', async () => {
    const projectId = await freshProject();
    const billId = await certifiedClaim(projectId);
    const approval = await payments.approve(projectId, { billId, amount: '20.00' }, approver(projectId));
    const payment = await payments.record(projectId, { approvalId: approval.id, amount: '20.00', method: 'neft' }, pmc(projectId));

    // raising an authority after the fact is not an authority
    await expect(t.prisma.$executeRawUnsafe(
      `UPDATE "PaymentApproval" SET "amount"=999.00 WHERE "id"=$1`, approval.id,
    )).rejects.toThrow(/append-only/u);
    await expect(t.prisma.$executeRawUnsafe(
      `DELETE FROM "Payment" WHERE "id"=$1`, payment.id,
    )).rejects.toThrow(/append-only/u);

    // and direction is carried by the ROW KIND, never by a negative amount
    await expect(payments.approve(projectId, { billId, amount: '-5.00' }, approver(projectId)))
      .rejects.toThrow();
  });

  it('PROBE 7 (§G): a bypass writer cannot exceed either bound — the seals are at PostgreSQL', async () => {
    const projectId = await freshProject();
    const billId = await certifiedClaim(projectId);
    const cert = await t.prisma.billCertificate.findFirstOrThrow({ where: { projectId, billId, supersededAt: null } });
    // reserve AND complete in ONE transaction: the platform refuses a completion that arrives from
    // a different one, because a receipt finished outside its own command run did not come from a
    // command run at all
    const mint = async (type: string, ref: string): Promise<string> => t.prisma.$transaction(async (tx) => {
      const c = await tx.commandExecution.create({
        data: {
          scopeKind: 'project', organizationId: f.orgA.id, projectId, actorId: f.ownerUser.id,
          commandType: type, idempotencyKey: `t6a-${seq++}`, requestHash: 'x', status: 'reserved',
        },
        select: { id: true },
      });
      await tx.commandExecution.update({
        where: { id: c.id }, data: { status: 'succeeded', resultRef: ref, completedAt: new Date() },
      });
      return c.id;
    });

    // bound 4 at PG: 150 approved against a 100 payable, with no service in the way
    const overId = `${cert.id}-over`;
    await expect(t.prisma.$executeRawUnsafe(
      `INSERT INTO "PaymentApproval"("id","projectId","certificateId","billId","amount","approvedById","sourceCommandId")
       VALUES($1,$2,$3,$4,150.00,$5,$6)`,
      overId, projectId, cert.id, billId, f.ownerUser.id, await mint('commercial.payment.approve', overId),
    )).rejects.toThrow(/exceed the 100\.00 payable/u);

    // a coherent approval IS accepted, so the seal is precise
    const okId = `${cert.id}-ok`;
    await t.prisma.$executeRawUnsafe(
      `INSERT INTO "PaymentApproval"("id","projectId","certificateId","billId","amount","approvedById","sourceCommandId")
       VALUES($1,$2,$3,$4,30.00,$5,$6)`,
      okId, projectId, cert.id, billId, f.ownerUser.id, await mint('commercial.payment.approve', okId),
    );

    // bound 5 at PG: paying more than the 30 approved
    const payId = `${cert.id}-pay`;
    await expect(t.prisma.$executeRawUnsafe(
      `INSERT INTO "Payment"("id","projectId","approvalId","billId","amount","method","paidById","sourceCommandId")
       VALUES($1,$2,$3,$4,40.00,'neft',$5,$6)`,
      payId, projectId, okId, billId, f.ownerUser.id, await mint('commercial.payment.record', payId),
    )).rejects.toThrow(/exceed the 30\.00 approved/u);
  });

  it('PROBE 8 (§H/§G): a withholding recorded AFTER an approval cannot put the bill in breach', async () => {
    // the ledger is append-only, so without the same seal on the deduction side a practice could
    // approve the gross and then withhold against it, with no write left to refuse
    const projectId = await freshProject();
    const billId = await certifiedClaim(projectId);
    await payments.approve(projectId, { billId, amount: '100.00' }, approver(projectId));

    await expect(deductions.record(projectId, { billId, type: 'retention', amount: '10.00' }, pmc(projectId)))
      .rejects.toThrow(/Approvals of 100\.00 exceed the 90\.00 payable/u);

    // …and a withholding that still leaves the approvals covered is ACCEPTED
    const other = await freshProject();
    const otherBill = await certifiedClaim(other);
    await payments.approve(other, { billId: otherBill, amount: '80.00' }, approver(other));
    await deductions.record(other, { billId: otherBill, type: 'retention', amount: '20.00' }, pmc(other));
    expect((await payments.ledger(other, otherBill, pmc(other))).approvable).toBe('0.00');
  });

  it('PROBE 9 (§D): the read reports folds, and the status is what IS rather than a guess', async () => {
    const projectId = await freshProject();
    const billId = await certifiedClaim(projectId);
    const empty = await payments.ledger(projectId, billId, pmc(projectId));
    expect(empty.approved).toBe('0.00');
    expect(empty.paid).toBe('0.00');
    expect(empty.approvable).toBe('100.00');

    const approval = await payments.approve(projectId, { billId, amount: '70.00' }, approver(projectId));
    await payments.record(projectId, { approvalId: approval.id, amount: '30.00', method: 'neft' }, pmc(projectId));

    const after = await payments.ledger(projectId, billId, pmc(projectId));
    expect(after.approved).toBe('70.00');
    expect(after.paid).toBe('30.00');
    expect(after.approvable).toBe('30.00');
    // §F's derivation is 6B's, beside the reversal rows that make it correct. Until then the status
    // is the STORED one — reporting what is, not what a partial derivation would guess.
    expect(after.billStatus).toBe('certified');
  });
});
