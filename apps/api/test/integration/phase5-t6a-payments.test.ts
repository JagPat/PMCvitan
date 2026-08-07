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
    'TRUNCATE TABLE "VendorAdvance", "PaymentReversal", "Payment", "PaymentApproval", "BillDeductionRelease", "BillDeduction", "SodException", "SodGrant", "CertifiedMeasurementConsumption", "CertifiedAcceptanceConsumption", "BillCertificate", "BillVerification", "VendorBillLine", "VendorBillVersion", "VendorBill", "DomainEvent", "OutboxDelivery", "ProcessedEvent", "ProjectionCursor", "ProjectionGeneration", "DecisionProjection", "DailyLogProjection", "DrawingsProjection", "InspectionsProjection", "ActivitiesProjection", "MaterialReadinessProjection", "LabourReadinessProjection", "Measurement", "BudgetException", "BudgetLine", "CommitmentAttribution", "CostHead", "LabourMismatchResolution", "LabourMismatch", "ActivityWorkOutput", "LabourWorkFact", "WorkerAllocation", "LabourAttendance", "ApprovedSkillSubstitution", "CapacityPromise", "CapacityCommitment", "LabourPurchaseOrderLine", "LabourPurchaseOrderVersion", "LabourPurchaseOrder", "LabourQuoteComparison", "SupplierLabourQuoteLine", "SupplierLabourQuote", "LabourRfq", "LabourRequisitionLine", "LabourRequisition", "VendorLabourProfile", "StockTransaction", "MaterialIssue", "StockLot", "DeliveryPromise", "DeliveryCommitment", "PurchaseOrderLine", "PurchaseOrderVersion", "PurchaseOrder", "VendorQuoteLine", "QuoteComparison", "VendorQuote", "Rfq", "RequisitionLine", "Requisition", "ProjectVendor", "CommandExecution", "CrewMembership", "Crew", "WorkerDevice", "WorkerSkill", "Worker", "ApprovedSubstitution", "LabourDemandSlice", "LabourRequirementSpec", "LabourTrade", "LabourSkill", "MaterialRequirementSpec", "ActivityRequirement", "ActivityRequirementRoot", "DecisionApprovalRevision", "ProjectCapability" CASCADE';

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

  it('PROBE 20 (§B/§J): approving is a headroom MOVER, so it clears the exception it healed', async () => {
    // Codex round 2 (P2). §J defines `certified-payable` as `NET_PAYABLE − APPROVED`, and this task
    // taught the fold that subtraction without making the write a mover — so an approval that
    // healed a head's exposure left the old exception open and the budget went on reporting a
    // breach nobody could clear.
    const projectId = await freshProject();
    await budget.setBudget(projectId, { costHeadCode: 'CIVIL', amount: '50.00', reason: 'thin plan' }, pmc(projectId));
    const billId = await certifiedClaim(projectId);

    const breached = await positionOf(projectId);
    expect(breached.certifiedPayable).toBe('100.00');
    expect(breached.exception, 'a 100 payable against a 50 budget is a breach').not.toBeNull();

    // approving 60 leaves 40 payable against a 50 budget — healthy
    await payments.approve(projectId, { billId, amount: '60.00' }, approver(projectId));
    const healed = await positionOf(projectId);
    expect(healed.certifiedPayable).toBe('40.00');
    expect(healed.exception, 'the approval healed the head and must have cleared its exception in the same transaction').toBeNull();

    // the register keeps the history — the row is CLEARED, never deleted
    const closed = await t.prisma.budgetException.findFirstOrThrow({
      where: { projectId, costHeadCode: 'CIVIL' }, orderBy: { raisedAt: 'desc' },
    });
    expect(closed.clearedAt).not.toBeNull();

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
});
