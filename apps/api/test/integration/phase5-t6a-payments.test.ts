import { readFileSync } from 'node:fs';
import { join } from 'node:path';
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
import { OrgsParticipant } from '../../src/orgs/orgs.participant';
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
    'TRUNCATE TABLE "VendorAdvance", "PaymentReversal", "Payment", "PaymentApproval", "BillDeductionRelease", "BillDeduction", "SodException", "SodGrant", "CertifiedMeasurementConsumption", "CertifiedAcceptanceConsumption", "BillCertificate", "BillVerification", "VendorBillLine", "VendorBillVersion", "VendorBill", "DomainEvent", "OutboxDelivery", "ProcessedEvent", "ProjectionCursor", "ProjectionGeneration", "DecisionProjection", "DailyLogProjection", "DrawingsProjection", "InspectionsProjection", "ActivitiesProjection", "MaterialReadinessProjection", "CashForecastProjection", "LabourReadinessProjection", "Measurement", "BudgetException", "BudgetLine", "CommitmentAttribution", "CostHead", "LabourMismatchResolution", "LabourMismatch", "ActivityWorkOutput", "LabourWorkFact", "WorkerAllocation", "LabourAttendance", "ApprovedSkillSubstitution", "CapacityPromise", "CapacityCommitment", "LabourPurchaseOrderLine", "LabourPurchaseOrderVersion", "LabourPurchaseOrder", "LabourQuoteComparison", "SupplierLabourQuoteLine", "SupplierLabourQuote", "LabourRfq", "LabourRequisitionLine", "LabourRequisition", "VendorLabourProfile", "StockTransaction", "MaterialIssue", "StockLot", "DeliveryPromise", "DeliveryCommitment", "PurchaseOrderLine", "PurchaseOrderVersion", "PurchaseOrder", "VendorQuoteLine", "QuoteComparison", "VendorQuote", "Rfq", "RequisitionLine", "Requisition", "ProjectVendor", "CommandExecution", "CrewMembership", "Crew", "WorkerDevice", "WorkerSkill", "Worker", "ApprovedSubstitution", "LabourDemandSlice", "LabourRequirementSpec", "LabourTrade", "LabourSkill", "MaterialRequirementSpec", "ActivityRequirement", "ActivityRequirementRoot", "DecisionApprovalRevision", "ProjectCapability" CASCADE';

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
  const positionOf = async (projectId: string, code = 'CIVIL') => {
    const { positions } = await budget.readBudget(projectId, pmc(projectId));
    return positions.find((p) => p.costHeadCode === code)!;
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

    // a coherent approval IS accepted, so the seal is precise.
    //
    // Task 6B-i — it carries the status the approval derives, in the same transaction. §F's
    // coherence seal refuses a bypass writer that moves a fold and leaves `VendorBill.status`
    // behind, and a ₹30 approval on a ₹100 payable derives `approved-for-payment`. Bound 4 is what
    // decides whether this row may exist and that is untouched; what changed is that a raw writer
    // must now do the whole of what `payment.approve` does, not the half it finds convenient.
    const okId = `${cert.id}-ok`;
    await t.prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(
        `INSERT INTO "PaymentApproval"("id","projectId","certificateId","billId","amount","approvedById","sourceCommandId")
         VALUES($1,$2,$3,$4,30.00,$5,$6)`,
        okId, projectId, cert.id, billId, f.ownerUser.id, await mint('commercial.payment.approve', okId),
      );
      await tx.$executeRawUnsafe(
        `UPDATE "VendorBill" SET "status"='approved-for-payment', "statusChangedAt"=now()
          WHERE "projectId"=$1 AND "id"=$2`,
        projectId, billId,
      );
    });

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
    // The read has ALWAYS reported the stored status rather than guessing — what changed in Task
    // 6B-i is what the stored status is worth. `payment.record` now re-derives it in the same
    // transaction, so ₹30 paid against ₹70 approved on a ₹100 payable stores `part-paid`, and this
    // read reports it without knowing anything new. 6A pinned `certified` here deliberately, saying
    // the derivation was 6B's; this is 6B changing it knowingly.
    expect(after.billStatus).toBe('part-paid');
  });

  it('PROBE 10 (§I): the certifier-vs-approver rule is sealed at PostgreSQL, not only in the service', async () => {
    // Codex round 1 (P1). The service refused this and that was the ONLY thing refusing it: a
    // bypass writer can mint a succeeded approve command for the certifier and forge a within-net
    // approval. The rule this whole task exists for was the one rule not sealed.
    const projectId = await freshProject();
    const billId = await certifiedClaim(projectId);
    const cert = await t.prisma.billCertificate.findFirstOrThrow({ where: { projectId, billId, supersededAt: null } });
    const mint = async (type: string, ref: string, actorId: string): Promise<string> => t.prisma.$transaction(async (tx) => {
      const c = await tx.commandExecution.create({
        data: {
          scopeKind: 'project', organizationId: f.orgA.id, projectId, actorId,
          commandType: type, idempotencyKey: `t6a-sod-${seq++}`, requestHash: 'x', status: 'reserved',
        },
        select: { id: true },
      });
      await tx.commandExecution.update({ where: { id: c.id }, data: { status: 'succeeded', resultRef: ref, completedAt: new Date() } });
      return c.id;
    });

    // the certifier is `f.memberUser`; a forged approval in their own name
    const forged = `${cert.id}-forged`;
    await expect(t.prisma.$executeRawUnsafe(
      `INSERT INTO "PaymentApproval"("id","projectId","certificateId","billId","amount","approvedById","sourceCommandId")
       VALUES($1,$2,$3,$4,10.00,$5,$6)`,
      forged, projectId, cert.id, billId, f.memberUser.id,
      await mint('commercial.payment.approve', forged, f.memberUser.id),
    )).rejects.toThrow(/who certified this claim/u);

    // …and a FORGED override does not make it valid. Codex round 2 (P1): the earlier seal tested
    // `EXISTS` on an exception naming this approval, so a bypass writer could insert the forbidden
    // approval plus an exception naming any colleague as `approverId` and reusing the approval's
    // own command id. A different id is not a stronger authority; it is a name typed into a field.
    const excused = `${cert.id}-excused`;
    const cmd = await mint('commercial.payment.approve', excused, f.memberUser.id);
    await expect(t.prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(
        `INSERT INTO "PaymentApproval"("id","projectId","certificateId","billId","amount","approvedById","sourceCommandId")
         VALUES($1,$2,$3,$4,10.00,$5,$6)`,
        excused, projectId, cert.id, billId, f.memberUser.id, cmd,
      );
      await tx.$executeRawUnsafe(
        `INSERT INTO "SodException"("id","projectId","approvalId","rule","actorId","approverId","reason","sourceCommandId")
         VALUES($1,$2,$3,'certifier-may-not-approve',$4,$5,'two-person practice',$6)`,
        `${excused}-x`, projectId, excused, f.memberUser.id, f.ownerUser.id, cmd,
      );
    })).rejects.toThrow(/who certified this claim|does not rest on a `certifier-may-not-approve` grant/u);
    expect(await t.prisma.paymentApproval.count({ where: { projectId, id: excused } })).toBe(0);
  });

  it('PROBE 15 (§I): the override is an act the approver PERFORMED, and the certifier may then approve', async () => {
    // Codex round 2 (P1), the service half. §I is explicit that silently banning the override is
    // not an option — a two-person practice must still be able to operate — and equally explicit
    // that it is legitimate only because a stronger authority ACTED. So it is the same two-act
    // mechanism certification uses: the approver issues a grant with their own authenticated
    // command, and the act consumes it.
    const projectId = await freshProject();
    const billId = await certifiedClaim(projectId);
    const other = await secondPmc(projectId);

    // with no grant, the certifier is refused and told exactly what would authorise it
    await expect(payments.approve(projectId, { billId, amount: '10.00' }, pmc(projectId)))
      .rejects.toThrow(/`commercial.sod.grant` naming the `certifier-may-not-approve` rule/u);

    // a grant for the CERTIFICATION rule does not authorise a payment approval — §I has two halves
    await certification.grantSodException(projectId, {
      billId, actorId: f.memberUser.id, reason: 'wrong half', rule: 'evidence-recorder-may-not-certify',
    }, asUser(projectId, other));
    await expect(payments.approve(projectId, { billId, amount: '10.00' }, pmc(projectId)))
      .rejects.toThrow(/may not also approve its payment/u);

    // …and the payment-side grant does, with the override readable on the approval it excused
    await certification.grantSodException(projectId, {
      billId, actorId: f.memberUser.id, reason: 'only pmc on site this week', rule: 'certifier-may-not-approve',
    }, asUser(projectId, other));
    const approval = await payments.approve(projectId, { billId, amount: '10.00' }, pmc(projectId));
    expect(approval.sodException).not.toBeNull();
    expect(approval.sodException!.rule).toBe('certifier-may-not-approve');
    expect(approval.sodException!.approverId).toBe(other);
    // the REASON is the approver's, not the excused actor's — the read reports it as the
    // authorisation, so leaving it free would let the person being excused write it
    expect(approval.sodException!.reason).toBe('only pmc on site this week');

    // the grant is SINGLE-USE: a second approval by the certifier needs a second authorisation
    const grant = await t.prisma.sodGrant.findFirstOrThrow({
      where: { projectId, rule: 'certifier-may-not-approve', consumedAt: { not: null } },
    });
    expect(grant.consumedByApprovalId).toBe(approval.id);
    expect(grant.consumedByCertificateId).toBeNull();
    await expect(payments.approve(projectId, { billId, amount: '5.00' }, pmc(projectId)))
      .rejects.toThrow(/may not also approve its payment/u);
  });

  it('PROBE 16 (§I): the ceiling read DECIDES standing, so a downgrade mid-flight refuses', async () => {
    // Codex round 2 (P1). An earlier spelling read `approvalLimit` from the active membership and
    // locked THAT — never looking at the role. A request authorised as pmc at the guard could still
    // append an approval after a concurrent downgrade to engineer committed: the lock protected the
    // number and not the authority the number qualifies.
    const projectId = await freshProject();
    const billId = await certifiedClaim(projectId);
    await secondPmc(projectId);

    await t.prisma.membership.updateMany({
      where: { projectId, userId: f.ownerUser.id }, data: { role: 'engineer' },
    });
    await expect(payments.approve(projectId, { billId, amount: '10.00' }, approver(projectId)))
      .rejects.toThrow(/no longer hold the standing/u);

    // …and restoring it approves, so the guard is about live standing and not about refusing
    await t.prisma.membership.updateMany({
      where: { projectId, userId: f.ownerUser.id }, data: { role: 'pmc' },
    });
    expect((await payments.approve(projectId, { billId, amount: '10.00' }, approver(projectId))).amount).toBe('10.00');
  });

  it('PROBE 17 (§I): an org owner with no project membership may approve; a zero ceiling refuses', async () => {
    // Codex round 2 (P2). Treating an ABSENT membership as a zero ceiling refused the ordinary
    // org-owner/admin fallback: that user switches into the project as pmc with no `Membership` row
    // at all, holds live authority everywhere else, and could approve nothing.
    const projectId = await freshProject();
    const billId = await certifiedClaim(projectId);
    // the fixture's evidence recorder is the org owner, so the membership is removed AFTER the
    // claim is built: what is under test is the arm that applies when no active membership exists
    await t.prisma.membership.deleteMany({ where: { projectId, userId: f.ownerUser.id } });
    expect(await t.prisma.membership.count({ where: { projectId, userId: f.ownerUser.id } })).toBe(0);

    const approval = await payments.approve(projectId, { billId, amount: '25.00' }, approver(projectId));
    expect(approval.amount).toBe('25.00');

    // …and a ceiling of ZERO on a real membership is a real ceiling: "may not approve" is a thing a
    // practice may legitimately want to say about a role
    await secondPmc(projectId);
    await t.prisma.membership.updateMany({
      where: { projectId, userId: f.ownerUser.id }, data: { approvalLimit: new Prisma.Decimal('0.00') },
    });
    await expect(payments.approve(projectId, { billId, amount: '1.00' }, approver(projectId)))
      .rejects.toThrow(/above your approval ceiling of 0\.00/u);
  });

  it('PROBE 18 (§G): the liveness guard runs UNDER the bill lock, and PG refuses stale authority', async () => {
    // Codex round 2 (P1), both halves of one defect. The service checked the certificate BEFORE
    // taking the bill lock, so a supersession committing in between passed a guard on a fact that
    // was no longer true; and the PostgreSQL bound is bill-scoped, so it admits a payment on a
    // stale approval whenever another live approval happens to cover the total.
    const projectId = await freshProject();
    const billId = await certifiedClaim(projectId);
    const stale = await payments.approve(projectId, { billId, amount: '40.00' }, approver(projectId));

    // a second session HOLDS the bill row and supersedes the certificate without committing
    const other = new PrismaClient();
    try {
      let released!: () => void;
      let ready!: () => void;
      const holding = new Promise<void>((resolve) => { released = resolve; });
      const staged = new Promise<void>((resolve) => { ready = resolve; });
      const held = other.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SELECT "id" FROM "VendorBill" WHERE "projectId"=$1 AND "id"=$2 FOR UPDATE`, projectId, billId);
        await tx.$executeRawUnsafe(`UPDATE "BillCertificate" SET "supersededAt"=now(), "supersedeReason"='raced', "supersededById"=$3 WHERE "projectId"=$1 AND "billId"=$2 AND "supersededAt" IS NULL`, projectId, billId, f.memberUser.id);
        // the bill status is the certificate's projection and the two move together (5B's seal),
        // so the holder performs the WHOLE supersession — this probe is about ordering, not about
        // finding a half-supersession PostgreSQL already refuses
        await tx.$executeRawUnsafe(`UPDATE "VendorBill" SET "status"='verified', "statusChangedAt"=now() WHERE "projectId"=$1 AND "id"=$2`, projectId, billId);
        ready();
        await holding;
      }, { timeout: 30_000 });
      // the conflicting session only starts once the holder DEMONSTRABLY holds the row — the wait
      // this probe is about is not observable if the race is started before the lock is taken
      await staged;

      // the payment now blocks — CONDITION-based, never a fixed sleep
      const paying = payments
        .record(projectId, { approvalId: stale.id, amount: '40.00', method: 'neft' }, pmc(projectId))
        .then(() => 'committed' as const, (e: Error) => e);
      let blocked = false;
      for (let i = 0; i < 400 && !blocked; i++) {
        const rows = await t.prisma.$queryRawUnsafe<Array<{ n: bigint }>>(
          `SELECT COUNT(*) AS n FROM pg_stat_activity
            WHERE datname=current_database() AND cardinality(pg_blocking_pids(pid)) > 0`,
        );
        blocked = Number(rows[0]!.n) > 0;
        if (!blocked) await new Promise((r) => setTimeout(r, 25));
      }
      expect(blocked, 'the payment must WAIT for the bill lock — a guard read ahead of the lock decides on a fact that can still change').toBe(true);

      released();
      await held;
      const outcome = await paying;
      expect(outcome).toBeInstanceOf(Error);
      expect((outcome as Error).message).toMatch(/has since been superseded/u);
    } finally {
      await other.$disconnect();
    }
    expect(await t.prisma.payment.count({ where: { projectId, billId } })).toBe(0);
  });

  it('PROBE 19 (§G): PostgreSQL refuses money nested under authority that no longer stands', async () => {
    // Codex round 2 (P1). Approve 40 on C1, supersede C1, certify C2 and approve 40 there, then
    // insert a Payment against the OLD approval: the bill-scoped fold counts C2 on the approved
    // side and the stale payment on the paid side, so `40 <= 40` passes. The row-level question the
    // fold cannot ask is asked at the row.
    const projectId = await freshProject();
    const billId = await certifiedClaim(projectId);
    const stale = await payments.approve(projectId, { billId, amount: '40.00' }, approver(projectId));
    await certification.supersede(projectId, { billId, reason: 'corrected' }, pmc(projectId));
    const live = await certification.certify(projectId, { billId }, pmc(projectId));
    const fresh = await payments.approve(projectId, { billId, amount: '40.00' }, approver(projectId));

    const mint = async (type: string, ref: string): Promise<string> => t.prisma.$transaction(async (tx) => {
      const c = await tx.commandExecution.create({
        data: {
          scopeKind: 'project', organizationId: f.orgA.id, projectId, actorId: f.ownerUser.id,
          commandType: type, idempotencyKey: `t6a-live-${seq++}`, requestHash: 'x', status: 'reserved',
        },
        select: { id: true },
      });
      await tx.commandExecution.update({ where: { id: c.id }, data: { status: 'succeeded', resultRef: ref, completedAt: new Date() } });
      return c.id;
    });

    const staleId = `${stale.id}-cash`;
    await expect(t.prisma.$executeRawUnsafe(
      `INSERT INTO "Payment"("id","projectId","approvalId","billId","amount","method","paidById","sourceCommandId")
       VALUES($1,$2,$3,$4,40.00,'neft',$5,$6)`,
      staleId, projectId, stale.id, billId, f.ownerUser.id, await mint('commercial.payment.record', staleId),
    )).rejects.toThrow(/superseded/u);

    // …and the SIBLING the finding did not name: an approval on a superseded certificate passes
    // every fold by being invisible to all of them, and is still a false authority in an
    // append-only register
    const ghost = `${stale.id}-ghost`;
    const dead = await t.prisma.billCertificate.findFirstOrThrow({ where: { projectId, billId, supersededAt: { not: null } } });
    await expect(t.prisma.$executeRawUnsafe(
      `INSERT INTO "PaymentApproval"("id","projectId","certificateId","billId","amount","approvedById","sourceCommandId")
       VALUES($1,$2,$3,$4,10.00,$5,$6)`,
      ghost, projectId, dead.id, billId, f.ownerUser.id, await mint('commercial.payment.approve', ghost),
    )).rejects.toThrow(/superseded/u);

    // …and the LIVE authority pays, so the seals are precise rather than merely strict
    await payments.record(projectId, { approvalId: fresh.id, amount: '40.00', method: 'neft' }, pmc(projectId));
    expect(live.id).not.toBe(dead.id);
    expect((await payments.ledger(projectId, billId, pmc(projectId))).paid).toBe('40.00');
  });

  it('PROBE 20 (§B/§J): approving MOVES money between buckets and heals nothing — authorising is not unspending', async () => {
    // REWRITTEN BY PHASE 5 TASK 7A, and the rewrite is the finding.
    //
    // Task 6A wrote this probe to assert that approving CLEARS the exception it healed, and that
    // was true against the fold as 6A left it: §J defines `certified-payable` as
    // `NET_PAYABLE − APPROVED`, 6A taught the fold that subtraction, and there was nowhere for the
    // subtracted money to go — so approving genuinely lowered total exposure.
    //
    // §J always specified where it goes: `approved` = `APPROVED − PAID`. Task 7A added that bucket
    // and this probe failed on the spot. The failure is the CORRECT answer, and the old assertion
    // was the incomplete one: **money a practice has authorised is money it still owes.** A budget
    // that healed when a payable was approved would tell a practice it had room the moment it
    // committed to spending, which is the opposite of what a budget is for.
    //
    // So the probe now asserts the partition, and `FOLD_INPUTS` reclassifies `APPROVED` as
    // partition-only to match. The `payment_approval` label stays wired for the reason `measurement`
    // does — the closure's rule is mechanical, not a judgement about arithmetic.
    const projectId = await freshProject();
    await budget.setBudget(projectId, { costHeadCode: 'CIVIL', amount: '50.00', reason: 'thin plan' }, pmc(projectId));
    const billId = await certifiedClaim(projectId);

    const breached = await positionOf(projectId);
    expect(breached.certifiedPayable).toBe('100.00');
    expect(breached.exposure, 'a 100 payable is 100 of exposure').toBe('100.00');
    expect(breached.exception, 'a 100 payable against a 50 budget is a breach').not.toBeNull();

    // approving 60 moves 60 from `certified-payable` into `approved` — and moves the total NOWHERE
    await payments.approve(projectId, { billId, amount: '60.00' }, approver(projectId));
    const approved = await positionOf(projectId);
    expect(approved.certifiedPayable, '§J — `NET_PAYABLE − APPROVED`').toBe('40.00');
    expect(approved.approved, '§J — `APPROVED − PAID`, and nothing is paid yet').toBe('60.00');
    expect(
      new Prisma.Decimal(approved.certifiedPayable).add(new Prisma.Decimal(approved.approved)).toFixed(2),
      'the two sum to what was payable before — that is the identity FOLD_INPUTS cites',
    ).toBe('100.00');
    expect(approved.exposure, 'authorising money does not unspend it').toBe(breached.exposure);
    expect(approved.headroom).toBe(breached.headroom);
    expect(approved.exception, 'the breach is real and STANDS — nothing about the money changed').not.toBeNull();

    // the register is append-only either way: the standing row is the SAME row, never re-raised
    const rows = await t.prisma.budgetException.findMany({
      where: { projectId, costHeadCode: 'CIVIL' }, orderBy: { raisedAt: 'asc' },
    });
    expect(rows, 'an exposure-neutral write must not stack a duplicate observation').toHaveLength(1);
    expect(rows[0]!.clearedAt, 'nor clear the one that stands').toBeNull();

    // …and `payment_approval` is a real label the CHECK admits, not a name only TypeScript knows.
    // An approval can only ever LOWER exposure, so like `measurement` it is wired and labelled
    // rather than demonstrated by a raise — the closure's rule is mechanical, and carving out an
    // exception on the strength of my own arithmetic is what went wrong twice in Task 2.
    await t.prisma.$executeRawUnsafe(
      `INSERT INTO "BudgetException"("id","projectId","costHeadCode","headroom","budget","exposure","raisedBy","raisedById")
       VALUES($1,$2,'MEP',-1.00,10.00,11.00,'payment_approval',$3)`,
      `${projectId}-label`, projectId, f.memberUser.id,
    );
    await expect(t.prisma.$executeRawUnsafe(
      `INSERT INTO "BudgetException"("id","projectId","costHeadCode","headroom","budget","exposure","raisedBy","raisedById")
       VALUES($1,$2,'MEP',-1.00,10.00,11.00,'not-a-mover',$3)`,
      `${projectId}-bad`, projectId, f.memberUser.id,
    )).rejects.toThrow();
  });

  it('PROBE 21 (§G bound 5): a payment may not overdraw the ONE approval it is nested under', async () => {
    // Codex round 3 (P2). The bill-scoped bound is right for what it measures and is not the whole
    // rule: with A1=40 and A2=40, paying 40 against A1 twice leaves the bill total conserved
    // (80 approved, 80 paid) while A1 reports paying 80 on an authority of 40 and A2 sits unused.
    // §C's rule is that every unit of money answers to exactly one authority.
    const projectId = await freshProject();
    const billId = await certifiedClaim(projectId);
    const a1 = await payments.approve(projectId, { billId, amount: '40.00' }, approver(projectId));
    const a2 = await payments.approve(projectId, { billId, amount: '40.00' }, approver(projectId));

    await payments.record(projectId, { approvalId: a1.id, amount: '40.00', method: 'neft' }, pmc(projectId));
    await expect(payments.record(projectId, { approvalId: a1.id, amount: '40.00', method: 'neft' }, pmc(projectId)))
      .rejects.toThrow(/above the 40\.00 it authorises/u);

    // PostgreSQL refuses the same forgery with the service bypassed — and the amount is chosen so
    // the BILL bound PASSES (80 approved, 80 paid) and only the approval-scoped one can refuse it.
    // Anything larger would be caught by the bill fold and prove nothing about this seal.
    const mint = async (ref: string): Promise<string> => t.prisma.$transaction(async (tx) => {
      const c = await tx.commandExecution.create({
        data: {
          scopeKind: 'project', organizationId: f.orgA.id, projectId, actorId: f.memberUser.id,
          commandType: 'commercial.payment.record', idempotencyKey: `t6a-a-${seq++}`, requestHash: 'x', status: 'reserved',
        },
        select: { id: true },
      });
      await tx.commandExecution.update({ where: { id: c.id }, data: { status: 'succeeded', resultRef: ref, completedAt: new Date() } });
      return c.id;
    });
    const over = `${a1.id}-over`;
    await expect(t.prisma.$executeRawUnsafe(
      `INSERT INTO "Payment"("id","projectId","approvalId","billId","amount","method","paidById","sourceCommandId")
       VALUES($1,$2,$3,$4,40.00,'neft',$5,$6)`,
      over, projectId, a1.id, billId, f.memberUser.id, await mint(over),
    )).rejects.toThrow(/authorises only/u);

    // …and A2 still pays its own 40, so the bound is about ATTRIBUTION rather than about refusing
    await payments.record(projectId, { approvalId: a2.id, amount: '40.00', method: 'neft' }, pmc(projectId));
    const ledger = await payments.ledger(projectId, billId, pmc(projectId));
    expect(ledger.paid).toBe('80.00');
    expect(ledger.approvals.map((a) => a.paid).sort()).toEqual(['40.00', '40.00']);
  });

  it('PROBE 22 (§I): a grant cannot be burned against an approval that never consumed it', async () => {
    // Codex round 3 (P2). Task 5's grant seal validates the certificate arm and its clause is
    // guarded by `consumedByCertificateId IS NOT NULL`, so the approval-side consume this task
    // added skipped it entirely — a direct writer could stamp any approval id and permanently burn
    // an approver's authority against an act it never excused.
    const projectId = await freshProject();
    const billId = await certifiedClaim(projectId);
    const other = await secondPmc(projectId);
    const unrelated = await payments.approve(projectId, { billId, amount: '10.00' }, approver(projectId));

    const grant = await certification.grantSodException(projectId, {
      billId, actorId: f.memberUser.id, reason: 'only pmc on site', rule: 'certifier-may-not-approve',
    }, asUser(projectId, other));

    // the grant is live and unconsumed; burning it against an approval carrying no matching
    // override is refused
    await expect(t.prisma.$executeRawUnsafe(
      `UPDATE "SodGrant" SET "consumedAt"=now(), "consumedByApprovalId"=$2 WHERE "id"=$1`,
      grant.id, unrelated.id,
    )).rejects.toThrow(/carries no matching override/u);

    // …and the LEGITIMATE consume still works, so the seal is precise rather than merely strict
    const excused = await payments.approve(projectId, { billId, amount: '10.00' }, pmc(projectId));
    expect(excused.sodException!.grantId).toBe(grant.id);
    const spent = await t.prisma.sodGrant.findFirstOrThrow({ where: { projectId, id: grant.id } });
    expect(spent.consumedByApprovalId).toBe(excused.id);
  });

  it('PROBE 23 (§I): the ORG-ARM fallback serializes against a membership that revokes it', async () => {
    // Codex round 3 (P2). `FOR UPDATE` locks rows that EXIST, and the org-owner arm's whole premise
    // is that none does. `hasProjectRoleStanding` documents the insert direction as safe because it
    // "only ever grants authority the operator did not have" — true of its original callers, FALSE
    // here: an active membership takes PRECEDENCE over the org arm, so an insert REVOKES.
    // The participant is exercised DIRECTLY, in a transaction that does NOT take the readiness
    // lock first. `approve` happens to take it as its opening statement, so driving this through
    // `approve` would prove the COARSE lock works and say nothing about the arm — which is the
    // whole point of the finding: a guard whose correctness rests on a lock somebody else takes is
    // a coincidence, not a guard.
    //
    // What this asserts is that the arm TAKES the lock, read out of `pg_locks` for this backend.
    // Stated plainly, because the claim should not be bigger than the evidence: the serialization
    // is complete because `MembersService.add`/`updateRole` take the SAME lock (readiness-lock.ts
    // names membership activation and removal among its holders), so an insert either waits for
    // this decision or lands before it. This probe owns one half of that and names the other.
    const projectId = await freshProject();
    await t.prisma.membership.deleteMany({ where: { projectId, userId: f.ownerUser.id } });
    const orgs = t.app.get(OrgsParticipant);
    const advisoryHeld = async (tx: Prisma.TransactionClient): Promise<number> => {
      const rows = await tx.$queryRawUnsafe<Array<{ n: number }>>(
        `SELECT COUNT(*)::int AS n FROM pg_locks
          WHERE locktype = 'advisory' AND pid = pg_backend_pid()
            AND ((classid::bigint << 32) | objid::bigint) = hashtextextended($1, 0)`,
        `readiness:${projectId}`,
      );
      return rows[0]!.n;
    };

    // (a) the ORG arm — no membership row exists, so no row lock can serialize the decision
    await t.prisma.$transaction(async (tx) => {
      expect(await advisoryHeld(tx), 'the probe must start with the lock UNHELD, or it proves nothing').toBe(0);
      const authority = await orgs.approvalAuthorityFor(tx, projectId, f.ownerUser.id, ['pmc']);
      expect(authority).toEqual({ standing: true, ceiling: null });
      expect(
        await advisoryHeld(tx),
        'the org arm returned unlimited authority without taking the readiness lock — a membership INSERT can revoke it behind this decision',
      ).toBe(1);
    });

    // (b) the ORDINARY arm — an active membership exists, the row lock settles it, and the extra
    // lock is NOT taken. A fix that locked unconditionally would serialize every approval in the
    // project against every membership write, which is a cost the row lock already avoids.
    await secondPmc(projectId);
    await t.prisma.membership.updateMany({
      where: { projectId, userId: f.ownerUser.id }, data: { approvalLimit: new Prisma.Decimal('0.00') },
    });
    await t.prisma.$transaction(async (tx) => {
      const authority = await orgs.approvalAuthorityFor(tx, projectId, f.ownerUser.id, ['pmc']);
      expect(authority).toEqual({ standing: true, ceiling: new Prisma.Decimal('0.00') });
      expect(await advisoryHeld(tx), 'the membership row decides this case; the project-wide lock is not needed for it').toBe(0);
    });
  });

  it('PROBE 24 (§B): the shared contract admits every label the DB CHECK does', async () => {
    // Codex round 3 (P2). A label a client is told is impossible, and which the server can still
    // return, is a client that mishandles the first real one it sees. Derived from the migration
    // rather than remembered, so a future mover cannot be admitted at PG and forgotten here.
    const sql = readFileSync(
      join(__dirname, '..', '..', 'prisma', 'migrations', '20270601000000_phase5_t6a_payment_authority', 'migration.sql'),
      'utf8',
    );
    const check = /BudgetException_raisedBy_check"?\s*\n?\s*CHECK \("raisedBy" IN \(([^)]*)\)\)/u.exec(sql)?.[1] ?? '';
    const admitted = [...check.matchAll(/'([a-z_]+)'/gu)].map((m) => m[1]!);
    expect(admitted.length, 'the raisedBy CHECK could not be parsed — the pin is not reading the migration').toBeGreaterThan(5);

    const dto = readFileSync(
      join(__dirname, '..', '..', '..', '..', 'packages', 'shared', 'src', 'contracts', 'commercial.ts'),
      'utf8',
    );
    const union = /raisedBy: ('[a-z_]+'(?:\s*\|\s*'[a-z_]+')*);/u.exec(dto)?.[1] ?? '';
    const declared = new Set([...union.matchAll(/'([a-z_]+)'/gu)].map((m) => m[1]!));
    for (const label of admitted) {
      expect(declared.has(label), `PostgreSQL admits raisedBy='${label}' and the shared DTO union does not`).toBe(true);
    }
  });

  it('PROBE 11 (§G bound 5): superseding a certificate cannot strand a payment above its authority', async () => {
    // Codex round 1 (P1), and reachable on the ORDINARY service path — no bypass writer needed.
    // The paid fold excludes approvals on superseded certificates, so supersession itself can break
    // the bound with no Payment insert to notice: approve 100, pay 100, supersede, and the approval
    // leaves APPROVED while the payment stays in PAID.
    const projectId = await freshProject();
    const billId = await certifiedClaim(projectId);
    const approval = await payments.approve(projectId, { billId, amount: '100.00' }, approver(projectId));
    await payments.record(projectId, { approvalId: approval.id, amount: '100.00', method: 'neft' }, pmc(projectId));

    await expect(certification.supersede(projectId, { billId, reason: 'corrected' }, pmc(projectId)))
      .rejects.toThrow(/exceed the/u);

    // …and superseding a certificate whose payments are still covered is ACCEPTED, so the seal is
    // about the breach and not about supersession
    const other = await freshProject();
    const otherBill = await certifiedClaim(other);
    await payments.approve(other, { billId: otherBill, amount: '40.00' }, approver(other));
    await certification.supersede(other, { billId: otherBill, reason: 'corrected' }, pmc(other));
    expect(await t.prisma.billCertificate.count({ where: { projectId: other, billId: otherBill, supersededAt: null } })).toBe(0);
  });

  it('PROBE 12 (§G): a payment may not rest on an approval whose certificate was superseded', async () => {
    // Codex round 1 (P1). APPROVED counts only approvals on the LIVE certificate, so paying against
    // a stale one attaches append-only cash evidence to an authority outside the bound entirely.
    const projectId = await freshProject();
    const billId = await certifiedClaim(projectId);
    const stale = await payments.approve(projectId, { billId, amount: '40.00' }, approver(projectId));

    await certification.supersede(projectId, { billId, reason: 'corrected' }, pmc(projectId));
    await certification.certify(projectId, { billId }, pmc(projectId));
    const live = await payments.approve(projectId, { billId, amount: '40.00' }, approver(projectId));

    await expect(payments.record(projectId, { approvalId: stale.id, amount: '40.00', method: 'neft' }, pmc(projectId)))
      .rejects.toThrow(/has since been superseded/u);

    // …and the LIVE approval pays
    await payments.record(projectId, { approvalId: live.id, amount: '40.00', method: 'neft' }, pmc(projectId));
    expect((await payments.ledger(projectId, billId, pmc(projectId))).paid).toBe('40.00');
  });

  it('PROBE 13 (§A/§0b): sub-paisa and blank evidence are refused before they reach an append-only row', async () => {
    const projectId = await freshProject();
    const billId = await certifiedClaim(projectId);

    // 0.005 passed every comparison and was then coerced by DECIMAL(18,2) to 0.01, so the ledger
    // recorded an amount the command never asked for — on a row that cannot be corrected
    await expect(payments.approve(projectId, { billId, amount: '0.005' }, approver(projectId)))
      .rejects.toThrow(/finer than the paisa/u);
    await expect(payments.approve(projectId, { billId, amount: 'not-money' }, approver(projectId)))
      .rejects.toThrow(/is not an amount/u);

    const approval = await payments.approve(projectId, { billId, amount: '10.00' }, approver(projectId));
    await expect(payments.record(projectId, { approvalId: approval.id, amount: '0.005', method: 'neft' }, pmc(projectId)))
      .rejects.toThrow(/finer than the paisa/u);

    // a whitespace-only bank reference is a present-but-useless one on an append-only row
    await expect(t.prisma.$executeRawUnsafe(
      `INSERT INTO "Payment"("id","projectId","approvalId","billId","amount","method","reference","paidById","sourceCommandId")
       VALUES($1,$2,$3,$4,1.00,'neft','   ',$5,$6)`,
      `${approval.id}-blank`, projectId, approval.id, billId, f.memberUser.id, approval.id,
    )).rejects.toThrow();
  });

  it('PROBE 14 (§J): approved money leaves certified-payable', async () => {
    // Codex round 1 (P2). The contract defines the bucket as NET_PAYABLE − APPROVED; the fold
    // subtracted only withholdings, so a fully approved bill still reported as awaiting approval.
    const projectId = await freshProject();
    await budget.setBudget(projectId, { costHeadCode: 'CIVIL', amount: '500.00', reason: 'civil plan' }, pmc(projectId));
    const billId = await certifiedClaim(projectId);
    expect((await positionOf(projectId)).certifiedPayable).toBe('100.00');

    await payments.approve(projectId, { billId, amount: '60.00' }, approver(projectId));
    expect((await positionOf(projectId)).certifiedPayable).toBe('40.00');

    await payments.approve(projectId, { billId, amount: '40.00' }, approver(projectId));
    expect((await positionOf(projectId)).certifiedPayable).toBe('0.00');
  });

  // ── 7B-iii-h correction — the PAYMENT half of §I learns the reviewed state too ───────────────
  //
  // 7B-iii-h taught the CERTIFICATION resolver that a grant records the claim state its approver
  // reviewed, and left this half exactly as it was. Two implementations of one question, and only
  // the one the unit was named for got fixed — which is the root PR #310's audit names first, and
  // the specific shape this service's own §I comments already warned about twice.

  it('PROBE 25 (§I): a payment authorisation must still match the state its approver reviewed', async () => {
    const projectId = await freshProject();
    const billId = await certifiedClaim(projectId);
    const other = await secondPmc(projectId);

    // authorised while the claim reads `certified` — nothing on it is approved yet
    const grant = await certification.grantSodException(projectId, {
      billId, actorId: f.memberUser.id, reason: 'only pmc on site this week', rule: 'certifier-may-not-approve',
    }, asUser(projectId, other));
    expect((await t.prisma.sodGrant.findFirstOrThrow({ where: { projectId, id: grant.id } })).reviewedStatus)
      .toBe('certified');

    // …and then the other pmc authorises part of it themselves. The VERSION has not moved, so the
    // version pin still matches — but ₹10 of this claim is now approved money, which is not the
    // claim the approver was looking at when they wrote the exception.
    await payments.approve(projectId, { billId, amount: '10.00' }, approver(projectId));
    expect((await t.prisma.vendorBill.findFirstOrThrow({ where: { projectId, id: billId } })).status)
      .toBe('approved-for-payment');

    await expect(payments.approve(projectId, { billId, amount: '10.00' }, pmc(projectId)))
      .rejects.toThrow(/granted against a claim state that no longer holds/u);

    // THE LEGAL PATH: re-authorised against what is true now, the certifier may approve. A guard
    // that only ever refuses is indistinguishable from one that never permits.
    const fresh = await certification.grantSodException(projectId, {
      billId, actorId: f.memberUser.id, reason: 'still the only pmc on site', rule: 'certifier-may-not-approve',
    }, asUser(projectId, other));
    const approval = await payments.approve(projectId, { billId, amount: '10.00' }, pmc(projectId));
    expect(approval.sodException?.grantId).toBe(fresh.id);
    // the stale one is untouched: it authorised a state that no longer stands, and it is inert
    // rather than spent — history, not a lock
    expect((await t.prisma.sodGrant.findFirstOrThrow({ where: { projectId, id: grant.id } })).consumedAt)
      .toBeNull();
  });

  it('PROBE 26 (§I): an approval cannot come to rest on a grant recorded at a state it never approved', async () => {
    const projectId = await freshProject();
    const billId = await certifiedClaim(projectId);
    const other = await secondPmc(projectId);
    const grant = await certification.grantSodException(projectId, {
      billId, actorId: f.memberUser.id, reason: 'only pmc on site this week', rule: 'certifier-may-not-approve',
    }, asUser(projectId, other));
    const approval = await payments.approve(projectId, { billId, amount: '10.00' }, pmc(projectId));
    expect(approval.sodException?.grantId, 'the fixture must produce a REAL §I chain').toBe(grant.id);

    // The bypass writer a DATABASE seal exists for. ONE trigger is disabled BY NAME inside a
    // transaction and re-enabled before it ends, so the seal is restored on the way out or the DDL
    // rolls back with the abort. It is the only way to reach the state the finding describes: the
    // service refuses to create it and `SodGrant_append_only` refuses to edit a consumed grant at
    // all. The question the probe asks is whether the DATABASE would notice.
    //
    // `SET CONSTRAINTS ALL IMMEDIATE` is load-bearing: the deferred seals queue behind the UPDATE
    // and PostgreSQL refuses to ALTER a table with pending trigger events.
    const regress = async (to: string): Promise<void> => {
      await t.prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe('ALTER TABLE "SodGrant" DISABLE TRIGGER "SodGrant_append_only"');
        await tx.$executeRawUnsafe(
          'UPDATE "SodGrant" SET "reviewedStatus"=$3 WHERE "projectId"=$1 AND "id"=$2', projectId, grant.id, to,
        );
        await tx.$executeRawUnsafe('SET CONSTRAINTS ALL IMMEDIATE');
        await tx.$executeRawUnsafe('ALTER TABLE "SodGrant" ENABLE TRIGGER "SodGrant_append_only"');
      });
    };

    await expect(regress('verified'))
      .rejects.toThrow(/state no `certifier-may-not-approve` authority can be spent from/u);
    expect((await t.prisma.sodGrant.findFirstOrThrow({ where: { projectId, id: grant.id } })).reviewedStatus)
      .toBe('certified');
    // …and another state this authority CAN legitimately be spent from is accepted, so the seal is
    // the admissible set and not a single hard-coded status
    await expect(regress('part-paid')).resolves.toBeUndefined();
  });

  it('PROBE 27 (§I): a RECYCLED status label does not bring a spent-past authorisation back to life', async () => {
    // Codex round 2 (P1), and the deeper half of the same defect this unit exists for.
    //
    // Round 1 recorded the claim STATE a grant was justified against, and compared that state to
    // what is true now. But `certified` is not a point in time — §F DERIVES it from the folds, and
    // the derivation genuinely returns to a label it has left before. So an authorisation given
    // when nothing on the claim was approved could be spent after somebody had approved AND PAID
    // the whole payable, purely because a later release put the label back.
    //
    // A status is a description; it is not an identity. What the reviewed identity needs is a fact
    // that only ever moves FORWARD — which is what the claim's REVISION is.
    const projectId = await freshProject();
    const billId = await certifiedClaim(projectId);
    const other = await secondPmc(projectId);

    // ₹100 certified, ₹10 withheld → ₹90 payable, and the claim reads `certified`
    const retention = await deductions.record(
      projectId, { billId, type: 'retention', amount: '10.00' }, pmc(projectId),
    );
    const reads = async (): Promise<string> =>
      (await t.prisma.vendorBill.findFirstOrThrow({ where: { projectId, id: billId } })).status;
    expect(await reads()).toBe('certified');

    // authorised HERE: nothing on this claim is approved, and ₹90 stands payable
    const grant = await certification.grantSodException(projectId, {
      billId, actorId: f.memberUser.id, reason: 'only pmc on site this week', rule: 'certifier-may-not-approve',
    }, asUser(projectId, other));
    expect((await t.prisma.sodGrant.findFirstOrThrow({ where: { projectId, id: grant.id } })).reviewedStatus)
      .toBe('certified');

    // …then the OTHER pmc approves and pays the whole payable. Nothing about this is irregular.
    const approval = await payments.approve(projectId, { billId, amount: '90.00' }, approver(projectId));
    await payments.record(projectId, { approvalId: approval.id, amount: '90.00', method: 'neft' }, pmc(projectId));
    expect(await reads()).toBe('paid');

    // …and a release raises the payable again, so §F derives the claim BACK to `certified`. The
    // label is identical to the one the approver reviewed; the claim underneath is not — ₹90 has
    // been authorised and has left the practice since.
    await deductions.release(
      projectId, { deductionId: retention.id, amount: '5.00', reason: 'defects made good' }, pmc(projectId),
    );
    expect(await reads(), 'the fixture must RECYCLE the label, or this probe is about nothing').toBe('certified');

    await expect(payments.approve(projectId, { billId, amount: '5.00' }, pmc(projectId)))
      .rejects.toThrow(/granted against a claim state that no longer holds/u);

    // THE LEGAL PATH: re-authorised against the claim as it stands now, the certifier may approve
    // the newly payable ₹5 — the guard is precise, not a permanent block.
    await certification.grantSodException(projectId, {
      billId, actorId: f.memberUser.id, reason: 'still the only pmc on site', rule: 'certifier-may-not-approve',
    }, asUser(projectId, other));
    const second = await payments.approve(projectId, { billId, amount: '5.00' }, pmc(projectId));
    expect(second.amount).toBe('5.00');
    // and the stale one is still unspent — inert history, not a lock
    expect((await t.prisma.sodGrant.findFirstOrThrow({ where: { projectId, id: grant.id } })).consumedAt)
      .toBeNull();
  });

  it('PROBE 28 (§F): the lifecycle version is monotonic across EVERY status writer', async () => {
    // The bump is a BEFORE UPDATE trigger rather than a line in each service, because there are six
    // separate writers of `VendorBill.status` across four services and "remember to also bump it"
    // is precisely the instruction this review lineage keeps proving nobody remembers. One site,
    // and no writer can opt out of it.
    const projectId = await freshProject();
    const billId = await certifiedClaim(projectId);
    const other = await secondPmc(projectId);
    const version = async (): Promise<number> =>
      (await t.prisma.vendorBillRevision.findFirst({ where: { projectId, billId } }))?.revision ?? 0;

    // it already moved, because reaching `certified` is several forward transitions
    const atCertified = await version();
    expect(atCertified).toBeGreaterThan(0);

    const approval = await payments.approve(projectId, { billId, amount: '100.00' }, approver(projectId));
    const atApproved = await version();
    expect(atApproved, 'a DERIVED transition bumps it too').toBeGreaterThan(atCertified);

    await payments.record(projectId, { approvalId: approval.id, amount: '100.00', method: 'neft' }, pmc(projectId));
    const atPaid = await version();
    expect(atPaid).toBeGreaterThan(atApproved);

    // …and a write that does NOT move the status does not move the version either: it counts
    // lifecycle transitions, not writes, or an approver's pin would go stale for no reason
    await certification.grantSodException(projectId, {
      billId, actorId: f.memberUser.id, reason: 'unrelated', rule: 'certifier-may-not-approve',
    }, asUser(projectId, other));
    expect(await version()).toBe(atPaid);

    // a direct writer cannot walk it backwards, so a stale pin cannot be made to match again
    await expect(t.prisma.$executeRawUnsafe(
      'UPDATE "VendorBillRevision" SET "revision"=1 WHERE "projectId"=$1 AND "billId"=$2', projectId, billId,
    )).rejects.toThrow(/only ever moves forward/u);
  });

  it('PROBE 29 (§I): the reviewed identity moves when the MONEY moves, not only when the label does', async () => {
    // Codex round 3 (P1), and it is round 2's finding one level deeper. Round 2 said "a status
    // label recycles, so pin a counter"; I then bumped that counter only when the LABEL changed.
    //
    // The label is not the money. §F's first two arms are `NET_PAYABLE = PAID` and `APPROVED = 0`,
    // so a claim with nothing approved reads `certified` at ANY payable — ₹90 or ₹95 or ₹900. A
    // retention release raises what is owed without moving the label at all, and the approver who
    // authorised against ₹90 never saw the ₹95.
    //
    // What has to advance is the CLAIM'S COMMERCIAL REVISION: anything a reviewer would have seen.
    const projectId = await freshProject();
    const billId = await certifiedClaim(projectId);
    const other = await secondPmc(projectId);

    const retention = await deductions.record(
      projectId, { billId, type: 'retention', amount: '10.00' }, pmc(projectId),
    );
    const reads = async () => t.prisma.vendorBill.findFirstOrThrow({ where: { projectId, id: billId } });
    expect((await reads()).status).toBe('certified');
    // `approvable` IS the net payable while nothing is approved — read through the ordinary
    // surface rather than a private fold, so the probe measures what a reviewer would see
    expect((await payments.ledger(projectId, billId, pmc(projectId))).approvable).toBe('90.00');

    // authorised against a ₹90 payable
    const grant = await certification.grantSodException(projectId, {
      billId, actorId: f.memberUser.id, reason: 'only pmc on site this week', rule: 'certifier-may-not-approve',
    }, asUser(projectId, other));
    const atGrant = (await t.prisma.vendorBillRevision.findFirst({ where: { projectId, billId } }))?.revision ?? 0;
    expect((await t.prisma.sodGrant.findFirstOrThrow({ where: { projectId, id: grant.id } })).reviewedLifecycleVersion)
      .toBe(atGrant);

    // …and ₹5 of the retention comes back. The claim now owes ₹95 and STILL reads `certified`.
    await deductions.release(
      projectId, { deductionId: retention.id, amount: '5.00', reason: 'defects made good' }, pmc(projectId),
    );
    expect((await reads()).status, 'the LABEL must not move, or this probe is about the recycling case again')
      .toBe('certified');
    expect((await payments.ledger(projectId, billId, pmc(projectId))).approvable).toBe('95.00');
    expect((await t.prisma.vendorBillRevision.findFirst({ where: { projectId, billId } }))?.revision ?? 0,
      'the money moved, so the reviewed identity must have moved').toBeGreaterThan(atGrant);

    await expect(payments.approve(projectId, { billId, amount: '95.00' }, pmc(projectId)))
      .rejects.toThrow(/granted against a claim state that no longer holds/u);

    // THE LEGAL PATH: re-authorised against what is owed now, the certifier may approve it
    await certification.grantSodException(projectId, {
      billId, actorId: f.memberUser.id, reason: 'still the only pmc on site', rule: 'certifier-may-not-approve',
    }, asUser(projectId, other));
    expect((await payments.approve(projectId, { billId, amount: '95.00' }, pmc(projectId))).amount)
      .toBe('95.00');
  });

  it('PROBE 30 (§I): EVERY fold source moves the reviewed identity', async () => {
    // Enumerated rather than sampled, because the defect this answers was a counter that moved on
    // one kind of change and not another. §F reads three folds — NET_PAYABLE, APPROVED, PAID — and
    // six tables feed them. A seventh fold source added tomorrow without a bump is exactly the
    // hole Codex just found, so this probe is the list.
    const projectId = await freshProject();
    const billId = await certifiedClaim(projectId);          // BillCertificate
    const at = async (): Promise<number> =>
      (await t.prisma.vendorBillRevision.findFirst({ where: { projectId, billId } }))?.revision ?? 0;
    const moved = async (label: string, act: () => Promise<unknown>): Promise<void> => {
      const before = await at();
      await act();
      expect(await at(), `${label} moves a payment fold, so it must move the reviewed identity`)
        .toBeGreaterThan(before);
    };

    let retentionId = '';
    await moved('BillDeduction', async () => {
      retentionId = (await deductions.record(
        projectId, { billId, type: 'retention', amount: '20.00' }, pmc(projectId),
      )).id;
    });
    await moved('BillDeductionRelease', () => deductions.release(
      projectId, { deductionId: retentionId, amount: '5.00', reason: 'partial release' }, pmc(projectId),
    ));
    let approvalId = '';
    await moved('PaymentApproval', async () => {
      approvalId = (await payments.approve(projectId, { billId, amount: '50.00' }, approver(projectId))).id;
    });
    let paymentId = '';
    await moved('Payment', async () => {
      paymentId = (await payments.record(
        projectId, { approvalId, amount: '50.00', method: 'neft' }, pmc(projectId),
      )).id;
    });
    await moved('PaymentReversal', () => payments.reverse(
      projectId, { paymentId, amount: '10.00', reason: 'bank returned it' }, pmc(projectId),
    ));
  });

  it('PROBE 31 (§I): an act cannot CLAIM a revision it was not performed at, nor rewrite it after', async () => {
    // Codex round 4 (P1), and it is the objection that invalidated round 3's premise. The consume
    // seal compares the grant's revision to the ACT'S — but both columns are written by the same
    // writer, so a bypass could insert the certificate carrying whatever revision matched the
    // stale grant it wanted to spend. "Two frozen columns" proved only that the writer agreed
    // with itself.
    const projectId = await freshProject();
    const billId = await certifiedClaim(projectId);
    const now = async (): Promise<number> =>
      (await t.prisma.vendorBillRevision.findFirst({ where: { projectId, billId } }))?.revision ?? 0;
    const at = await now();
    expect(at, 'the fixture must have advanced the claim, or the probe is about nothing').toBeGreaterThan(0);

    const cert = await t.prisma.billCertificate.findFirstOrThrow({ where: { projectId, billId, supersededAt: null } });
    // strictly BEFORE the current one: the certify transaction advances the claim twice more (its
    // own certificate row, then the status transition), and the act records what it acted ON
    expect(cert.reviewedLifecycleVersion, 'the honest act recorded the revision it acted at')
      .toBeLessThan(at);
    expect(cert.reviewedLifecycleVersion).toBeGreaterThanOrEqual(0);

    // a WRONG claim about which passage this act was performed on is refused at INSERT, checked
    // against the claim itself rather than against another row the same writer wrote
    const mint = async (ref: string): Promise<string> => t.prisma.$transaction(async (tx) => {
      const c = await tx.commandExecution.create({
        data: {
          scopeKind: 'project', organizationId: f.orgA.id, projectId, actorId: f.memberUser.id,
          commandType: 'commercial.payment.approve', idempotencyKey: `t7h-rev-${seq++}`, requestHash: 'x', status: 'reserved',
        }, select: { id: true },
      });
      await tx.commandExecution.update({ where: { id: c.id }, data: { status: 'succeeded', resultRef: ref, completedAt: new Date() } });
      return c.id;
    });
    await expect(t.prisma.$executeRawUnsafe(
      `INSERT INTO "PaymentApproval"("id","projectId","certificateId","billId","amount","approvedById","reviewedLifecycleVersion","sourceCommandId")
       VALUES($1,$2,$3,$4,10.00,$5,$6,$7)`,
      'forged-rev', projectId, cert.id, billId, f.ownerUser.id, at - 1, await mint('forged-rev'),
    )).rejects.toThrow(/an act carries the passage of the claim it was actually performed on/u);

    // …and once written it is EVIDENCE: a later update cannot rewrite which passage it names
    await expect(t.prisma.$executeRawUnsafe(
      'UPDATE "BillCertificate" SET "reviewedLifecycleVersion"=0 WHERE "projectId"=$1 AND "id"=$2',
      projectId, cert.id,
    )).rejects.toThrow(/cannot be rewritten/u);
  });

  it('PROBE 32 (§I): the revision row cannot be moved or removed, only advanced', async () => {
    // The counter's IDENTITY is as much a part of the fact as its number (Codex round 4), and its
    // EXISTENCE is too — this enumeration's own addition. Both routes end the same way: the claim
    // reads `COALESCE(..., 0)` again and every authorisation ever pinned at 0 comes back.
    const projectId = await freshProject();
    const billId = await certifiedClaim(projectId);
    const other = await freshProject();

    await expect(t.prisma.$executeRawUnsafe(
      'DELETE FROM "VendorBillRevision" WHERE "projectId"=$1 AND "billId"=$2', projectId, billId,
    )).rejects.toThrow(/never deleted/u);
    await expect(t.prisma.$executeRawUnsafe(
      'UPDATE "VendorBillRevision" SET "billId"=$3, "revision"="revision"+1 WHERE "projectId"=$1 AND "billId"=$2',
      projectId, billId, `${billId}-elsewhere`,
    )).rejects.toThrow(/cannot be moved|violates foreign key/u);
    expect(other).toBeDefined();
  });
});
