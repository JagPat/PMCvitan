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
import { CommercialDeductionQuery } from '../../src/commercial/commercial-deduction.query';
import { derivedBillStatus } from '../../src/commercial/commercial-status';

/**
 * Phase 5 Task 6B-i — §F's DERIVED payment status, proven live against PostgreSQL.
 *
 * Every bound is probed as a PAIR: the write that must be REFUSED and the neighbouring one that
 * must still be ALLOWED. A refusal alone proves only that something is strict, not that it is
 * right — Task 3's audit closed that as a rule, and 5C's rounds 8 and 10 both turned on it. Round
 * 10 in particular was three findings that each refused VALID work, so the acceptances here carry
 * as much weight as the refusals.
 */
describe('Phase 5 Task 6B-i — the §F status derivation over three folds (live PG)', () => {
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
    await t?.prisma.membership.deleteMany({ where: { projectId: { startsWith: 'it-p5t6b-' } } });
    await t?.prisma.project.deleteMany({ where: { id: { startsWith: 'it-p5t6b-' } } });
    await f?.cleanup();
    await t?.close();
  });
  afterEach(async () => {
    await t.prisma.$executeRawUnsafe(TRUNCATE);
    await t.prisma.vendor.deleteMany({ where: { orgId: f.orgA.id } });
    for (const [model, where] of [
      ['auditLog', { projectId: { startsWith: 'it-p5t6b-' } }],
      ['media', { projectId: { startsWith: 'it-p5t6b-' } }],
      ['activity', { projectId: { startsWith: 'it-p5t6b-' } }],
      ['membership', { projectId: { startsWith: 'it-p5t6b-' } }],
      ['project', { id: { startsWith: 'it-p5t6b-' } }],
    ] as const) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (t.prisma as any)[model].deleteMany({ where });
    }
  });

  // ── fixtures (the cleared units A/B chain, verbatim — unit C adds no write path) ──────────────

  const freshProject = async (): Promise<string> => {
    const id = `it-p5t6b-${Date.now() % 1e6}-${seq++}`;
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

  // ── the derivation's own inputs, read the way the service reads them ──────────────────────────

  const foldsOf = async (projectId: string, billId: string) =>
    t.app.get(CommercialDeductionQuery).foldsFor(t.prisma as never, projectId, billId);

  const storedStatus = async (projectId: string, billId: string): Promise<string> =>
    (await t.prisma.vendorBill.findFirstOrThrow({ where: { projectId, id: billId }, select: { status: true } })).status;

  /**
   * THE ALL-MOVER INVARIANT, as a function rather than a list.
   *
   * §F's obligation is "one derivation, every writer that can move ANY of the three folds", and the
   * defect it guards against is a stored status that disagrees with its own folds. So the check is
   * not "did mover X set status Y" — that would re-state the truth table once per mover and go
   * stale the moment a seventh mover appears. It reads the three folds and requires the STORED
   * status to equal what the derivation says about them, and it is called after every command in
   * every probe below.
   */
  const expectDerived = async (projectId: string, billId: string, why: string): Promise<string> => {
    const folds = await foldsOf(projectId, billId);
    const stored = await storedStatus(projectId, billId);
    expect(
      stored,
      `${why}: the stored status disagrees with its own folds (netPayable=${folds.netPayable.toFixed(2)}, approved=${folds.approved.toFixed(2)}, paid=${folds.paid.toFixed(2)})`,
    ).toBe(derivedBillStatus(folds));
    return stored;
  };

  // ── the §F truth table, every arm reached through real commands ───────────────────────────────

  it('PROBE 1 (§F): APPROVED = 0 derives `certified` — payable, not yet approved', async () => {
    const projectId = await freshProject();
    const billId = await certifiedClaim(projectId);
    expect(await expectDerived(projectId, billId, 'after certify')).toBe('certified');
  });

  it('PROBE 2 (§F): PAID = 0 < APPROVED derives `approved-for-payment`', async () => {
    const projectId = await freshProject();
    const billId = await certifiedClaim(projectId);
    await payments.approve(projectId, { billId, amount: '100' }, approver(projectId));
    expect(await expectDerived(projectId, billId, 'after approve')).toBe('approved-for-payment');
  });

  it('PROBE 3 (§F): 0 < PAID < APPROVED derives `part-paid`', async () => {
    const projectId = await freshProject();
    const billId = await certifiedClaim(projectId);
    const approval = await payments.approve(projectId, { billId, amount: '100' }, approver(projectId));
    await payments.record(projectId, { approvalId: approval.id, amount: '40', method: 'neft' }, pmc(projectId));
    expect(await expectDerived(projectId, billId, 'after part payment')).toBe('part-paid');
  });

  it('PROBE 4 (§F): NET_PAYABLE = PAID derives `paid`, and it is the FIRST arm', async () => {
    const projectId = await freshProject();
    const billId = await certifiedClaim(projectId);
    const approval = await payments.approve(projectId, { billId, amount: '100' }, approver(projectId));
    await payments.record(projectId, { approvalId: approval.id, amount: '100', method: 'neft' }, pmc(projectId));
    expect(await expectDerived(projectId, billId, 'after full payment')).toBe('paid');
  });

  it('PROBE 5 (§F): PAID = APPROVED < NET_PAYABLE stays `certified` — the rest is UNAPPROVED, not unpaid', async () => {
    const projectId = await freshProject();
    const billId = await certifiedClaim(projectId);
    // approve and pay only PART of the payable: the approved portion is settled, ₹40 is not yet
    // authorised by anyone, and calling that `paid` would report a claim as finished with money owed
    const approval = await payments.approve(projectId, { billId, amount: '60' }, approver(projectId));
    await payments.record(projectId, { approvalId: approval.id, amount: '60', method: 'neft' }, pmc(projectId));
    const folds = await foldsOf(projectId, billId);
    expect(folds.paid.equals(folds.approved), 'fixture: PAID must equal APPROVED').toBe(true);
    expect(folds.approved.lessThan(folds.netPayable), 'fixture: APPROVED must be below NET_PAYABLE').toBe(true);
    expect(await expectDerived(projectId, billId, 'part-approved, fully paid')).toBe('certified');
  });

  // ── the non-monotonic case: the whole reason the CAS has no forward-only guard ────────────────

  it('PROBE 6 (§F): a retention RELEASE moves a `paid` bill BACK to `certified`', async () => {
    const projectId = await freshProject();
    const billId = await certifiedClaim(projectId);
    // certify ₹100, withhold ₹10 → payable ₹90; approve and pay ₹90 → `paid`
    const held = await deductions.record(projectId, { billId, type: 'retention', amount: '10.00' }, pmc(projectId));
    expect(await expectDerived(projectId, billId, 'after withholding')).toBe('certified');
    const approval = await payments.approve(projectId, { billId, amount: '90' }, approver(projectId));
    await payments.record(projectId, { approvalId: approval.id, amount: '90', method: 'neft' }, pmc(projectId));
    expect(await expectDerived(projectId, billId, 'fully paid against the reduced payable')).toBe('paid');

    // …now release ₹5. NET_PAYABLE rises to ₹95 while APPROVED = PAID = ₹90, so ₹5 is payable that
    // no approval covers. Leaving the bill `paid` would contradict §J, which reports that ₹5 owed
    // from the same folds.
    await deductions.release(projectId, { deductionId: held.id, amount: '5.00', reason: 'partial release' }, pmc(projectId));
    expect(await expectDerived(projectId, billId, 'after the release')).toBe('certified');
  });

  it('PROBE 7 (§F): a withholding that offsets the WHOLE payable derives `paid` with no cash moving', async () => {
    const projectId = await freshProject();
    const billId = await certifiedClaim(projectId);
    await deductions.record(projectId, { billId, type: 'other', amount: '100.00', reason: 'fully offset' }, pmc(projectId));
    const folds = await foldsOf(projectId, billId);
    expect(folds.netPayable.isZero(), 'fixture: the payable must be fully offset').toBe(true);
    expect(folds.paid.isZero(), 'fixture: no cash has moved').toBe(true);
    // `paid` here means nothing remains payable, not that money was sent. Approval and payment rows
    // are strictly positive (§H), so if this derived `certified` there would exist NO legal row
    // anyone could write to advance it — the bill would be stranded forever.
    expect(await expectDerived(projectId, billId, 'fully offset certificate')).toBe('paid');
  });

  it('PROBE 8 (§F): a release with NO approval never invents one — it stays `certified`', async () => {
    const projectId = await freshProject();
    const billId = await certifiedClaim(projectId);
    const held = await deductions.record(projectId, { billId, type: 'retention', amount: '10.00' }, pmc(projectId));
    await deductions.release(projectId, { deductionId: held.id, amount: '5.00', reason: 'early release' }, pmc(projectId));
    const folds = await foldsOf(projectId, billId);
    expect(folds.approved.isZero(), 'fixture: nobody has approved anything').toBe(true);
    // deriving `approved-for-payment` from NET_PAYABLE > APPROVED would put the bill into the
    // POST-approval lifecycle with APPROVED = 0. A status that overstates authority invites a
    // payment; one that understates cash only delays it.
    expect(await expectDerived(projectId, billId, 'released with no approval')).toBe('certified');
  });

  // ── every mover, in one walk, with the invariant checked after each ───────────────────────────

  it('PROBE 9 (§F): ALL SIX movers leave the stored status equal to its own folds', async () => {
    const projectId = await freshProject();
    const billId = await certifiedClaim(projectId);
    await expectDerived(projectId, billId, 'mover: certificate.certify');

    const held = await deductions.record(projectId, { billId, type: 'retention', amount: '10.00' }, pmc(projectId));
    await expectDerived(projectId, billId, 'mover: deduction.record');

    await deductions.release(projectId, { deductionId: held.id, amount: '4.00', reason: 'r' }, pmc(projectId));
    await expectDerived(projectId, billId, 'mover: deductions.release');

    const approval = await payments.approve(projectId, { billId, amount: '50' }, approver(projectId));
    await expectDerived(projectId, billId, 'mover: payment.approve');

    await payments.record(projectId, { approvalId: approval.id, amount: '25', method: 'neft' }, pmc(projectId));
    await expectDerived(projectId, billId, 'mover: payment.record');

    // …and the sixth mover on a claim with NO cash against it. Superseding THIS bill is refused
    // while its ₹25 stands (PROBE 13), so the mover is proven where it is legal.
    const clean = await certifiedClaim(projectId);
    await expectDerived(projectId, clean, 'mover: certificate.certify (second claim)');
    await certification.supersede(projectId, { billId: clean, reason: 'correction' }, pmc(projectId));
    expect(await storedStatus(projectId, clean), 'supersede returns the bill to `verified`').toBe('verified');
  });

  it('PROBE 13 (§0): the WIDENED supersede guard does not open a paid certificate to correction', async () => {
    // This task widens `supersede`'s status guard from the single member `certified` to the whole
    // derived FAMILY, because §F makes `approved-for-payment`/`part-paid`/`paid` reachable on a bill
    // whose certificate is still live, and the member guard would have refused those with the false
    // reason that no certification exists. The obligation that comes with widening is to prove the
    // §0 rule — cash already gone is not corrected by correcting a document — still holds on every
    // newly-reachable member. It does, and NOT because this service restates it: Task 6A's §G
    // bound-5 seal (`BillCertificate_paid_bound_sealed`, deferred to commit) refuses any supersession
    // that would leave `PAID` above the `APPROVED` it drops to, which is every case where cash
    // stands against the live certificate. A second service-level refusal here would be the same
    // rule at a second site with a second message — the drift this module keeps removing.
    const projectId = await freshProject();
    const billId = await certifiedClaim(projectId);
    const approval = await payments.approve(projectId, { billId, amount: '100' }, approver(projectId));

    // `approved-for-payment` is newly reachable AND legitimately correctable: supersession takes the
    // approval out of `APPROVED` and no cash is orphaned, so the widened guard must let it through.
    const other = await certifiedClaim(projectId);
    await payments.approve(projectId, { billId: other, amount: '100' }, approver(projectId));
    expect(await expectDerived(projectId, other, 'approved but unpaid')).toBe('approved-for-payment');
    await certification.supersede(projectId, { billId: other, reason: 'approved but unpaid' }, pmc(projectId));
    expect(await storedStatus(projectId, other), 'an approved-but-unpaid claim is still correctable').toBe('verified');

    // …`part-paid` is newly reachable and is NOT. Supersession would drop `APPROVED` to 0 while
    // `PAID` stands, leaving `PAID > APPROVED` with both rows append-only — §G bound 5 broken by
    // evidence nothing can walk back, and a real outflow hidden behind a lower payable. Recovering
    // money is its own attributable act; the reversal that makes this legal is 6B-ii's.
    await payments.record(projectId, { approvalId: approval.id, amount: '40', method: 'neft' }, pmc(projectId));
    expect(await expectDerived(projectId, billId, 'cash has left')).toBe('part-paid');
    await expect(certification.supersede(projectId, { billId, reason: 'too late' }, pmc(projectId)))
      .rejects.toThrow(/exceed the/u);
    expect(await expectDerived(projectId, billId, 'the refused supersede changed nothing')).toBe('part-paid');
  });

  it('PROBE 10 (§F): the derivation is CONTAINED — a sibling project bill is untouched', async () => {
    const a = await freshProject();
    const b = await freshProject();
    const billA = await certifiedClaim(a);
    const billB = await certifiedClaim(b);
    const approval = await payments.approve(a, { billId: billA, amount: '100' }, approver(a));
    await payments.record(a, { approvalId: approval.id, amount: '100', method: 'neft' }, pmc(a));
    expect(await expectDerived(a, billA, 'the project that was paid')).toBe('paid');
    expect(await expectDerived(b, billB, 'the untouched sibling project')).toBe('certified');
  });

  it('PROBE 11 (§F): a keyed REPLAY re-derives to the same status and appends nothing', async () => {
    const projectId = await freshProject();
    const billId = await certifiedClaim(projectId);
    const key = `it-6bi-replay-${seq++}`;
    const first = await payments.approve(projectId, { billId, amount: '100' }, approver(projectId), key);
    const after = await expectDerived(projectId, billId, 'first approval');
    const replay = await payments.approve(projectId, { billId, amount: '100' }, approver(projectId), key);
    expect(replay.id, 'a keyed replay answers with the SAME approval').toBe(first.id);
    expect(await t.prisma.paymentApproval.count({ where: { projectId, billId } }), 'a replay appends no second approval').toBe(1);
    expect(await expectDerived(projectId, billId, 'after the replay'), 'the status is unchanged by a replay').toBe(after);
  });

  it('PROBE 12 (§F): the READ surface reports the same status the folds derive', async () => {
    const projectId = await freshProject();
    const billId = await certifiedClaim(projectId);
    const approval = await payments.approve(projectId, { billId, amount: '100' }, approver(projectId));
    await payments.record(projectId, { approvalId: approval.id, amount: '40', method: 'neft' }, pmc(projectId));
    const derived = await expectDerived(projectId, billId, 'part paid');
    const ledger = await payments.ledger(projectId, billId, pmc(projectId));
    expect(ledger.billStatus, 'the ledger read must not answer from a stale column').toBe(derived);
  });
});
