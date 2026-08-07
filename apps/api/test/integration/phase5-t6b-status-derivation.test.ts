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

  // Condition-based synchronization for R1-F3's barrier (NOT a fixed sleep): poll for a backend
  // that is ACTIVELY WAITING on a lock while running the given statement. The observer runs on the
  // app's client, a different connection from the two racing sessions, so it cannot perturb them.
  // This is the idiom the cleared Phase-4 correction-4 probes established.
  const waitUntilBlocked = async (queryLike: string): Promise<void> => {
    for (let i = 0; i < 200; i++) {
      const rows = await t.prisma.$queryRawUnsafe<Array<{ c: number }>>(
        `SELECT COUNT(*)::int AS c FROM pg_stat_activity
          WHERE wait_event_type = 'Lock' AND state = 'active' AND query ILIKE $1`,
        queryLike,
      );
      if (Number(rows[0]!.c) >= 1) return;
      await new Promise((r) => setTimeout(r, 50));
    }
    const all = await t.prisma.$queryRawUnsafe<Array<{ s: string; w: string | null; q: string }>>(
      `SELECT state AS s, wait_event_type AS w, left(query, 120) AS q FROM pg_stat_activity
        WHERE datname = current_database() AND query NOT ILIKE '%pg_stat_activity%'`);
    throw new Error(`barrier timeout: expected a backend blocked on a table lock while running ${queryLike}\n${JSON.stringify(all, null, 1)}`);
  };

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

  // ── Codex round 1 — the family was a PROXY for the derivation ─────────────────────────────────
  //
  // The first head guarded MEMBERSHIP at PostgreSQL and left the MEMBER to the service. These four
  // probes are the bypasses that opened, each written as the finding describes it and each RED at
  // `392b46f`. The seal is one function fired from five tables, so the probes go at it from both
  // sides — the bill moving without its folds, and the folds moving without the bill.

  it('R1-F1 (§F): a direct status flip inside the family is REFUSED — the DB derives the member, not just the family', async () => {
    const projectId = await freshProject();
    const billId = await certifiedClaim(projectId);
    expect(await expectDerived(projectId, billId, 'certified, nothing approved')).toBe('certified');

    // one statement, every 6A seal satisfied, a live certificate standing — and before the
    // derivation seal this committed, after which every read surface reported an unpaid bill as
    // paid until some unrelated command happened to re-derive it
    for (const forged of ['paid', 'part-paid', 'approved-for-payment']) {
      await expect(
        t.prisma.$executeRawUnsafe(
          `UPDATE "VendorBill" SET "status"=$3, "statusChangedAt"=now() WHERE "projectId"=$1 AND "id"=$2`,
          projectId, billId, forged,
        ),
        `a bill with APPROVED = PAID = 0 must not be storable as \`${forged}\``,
      ).rejects.toThrow(/its own folds derive/u);
    }
    expect(await expectDerived(projectId, billId, 'after three refused flips')).toBe('certified');

    // …and the seal tracks the folds rather than pinning one member: once a real approval moves
    // them, the member that WAS legal becomes illegal and the new one becomes the only legal value.
    // (The precise-not-strict half — the same UPDATE statement ACCEPTED when its value matches the
    // derivation — needs a stale stored status to write over, which only R1-F2 below can construct,
    // and that is where it is proven.)
    await payments.approve(projectId, { billId, amount: '40.00' }, approver(projectId));
    expect(await expectDerived(projectId, billId, 'approved through the service')).toBe('approved-for-payment');
    await expect(t.prisma.$executeRawUnsafe(
      `UPDATE "VendorBill" SET "status"='certified', "statusChangedAt"=now() WHERE "projectId"=$1 AND "id"=$2`,
      projectId, billId,
    ), 'the member that was legal a moment ago is now the forgery').rejects.toThrow(/its own folds derive/u);
  });

  it('R1-F4 (§F): a bypass write to ANY fold table that leaves the status behind is REFUSED', async () => {
    const projectId = await freshProject();
    const billId = await certifiedClaim(projectId);
    const certificate = await t.prisma.billCertificate.findFirstOrThrow({
      where: { projectId, billId, supersededAt: null }, select: { id: true },
    });
    // A ledger row must cite the command that PRODUCED it (5A's provenance floor), so each bypass
    // below carries a real, succeeded command of the right TYPE and actor. The point of the probe is
    // that a row can be perfectly well-formed by every EARLIER seal and still leave the status
    // behind — a weaker forgery would be rejected before it reached the derivation.
    const mint = async (type: string, actorId: string, resultRef: string): Promise<string> => t.prisma.$transaction(async (tx) => {
      const c = await tx.commandExecution.create({
        data: {
          scopeKind: 'project', organizationId: f.orgA.id, projectId, actorId,
          commandType: type, idempotencyKey: `t6bi-bypass-${seq++}`, requestHash: 'x', status: 'reserved',
        },
        select: { id: true },
      });
      await tx.commandExecution.update({
        where: { id: c.id }, data: { status: 'succeeded', resultRef, completedAt: new Date() },
      });
      return c.id;
    });
    const forgedApproval = `it-6bi-bypass-approval-${seq++}`;
    const forgedPayment = `it-6bi-bypass-payment-${seq++}`;
    const forgedDeduction = `it-6bi-bypass-deduction-${seq++}`;

    // A VALID approval — every 6A seal met, live certificate, within the payable — appended without
    // moving the status. The folds now derive `approved-for-payment`; the column still says
    // `certified`. Sealing only `VendorBill` would have closed the other mouth and left this one.
    await expect(t.prisma.$executeRawUnsafe(
      `INSERT INTO "PaymentApproval"("id","projectId","certificateId","billId","amount","approvedById","sourceCommandId")
       VALUES ($1,$2,$3,$4,40.00,$5,$6)`,
      forgedApproval, projectId, certificate.id, billId, f.ownerUser.id,
      await mint('commercial.payment.approve', f.ownerUser.id, forgedApproval),
    )).rejects.toThrow(/its own folds derive/u);

    // …the same row through the SERVICE, which re-derives in the same transaction, is accepted
    const approval = await payments.approve(projectId, { billId, amount: '40.00' }, approver(projectId));
    expect(await expectDerived(projectId, billId, 'the service path')).toBe('approved-for-payment');

    // and a bypass PAYMENT is refused by the same seal, through a different trigger
    await expect(t.prisma.$executeRawUnsafe(
      `INSERT INTO "Payment"("id","projectId","approvalId","billId","amount","method","paidById","sourceCommandId")
       VALUES ($1,$2,$3,$4,10.00,'neft',$5,$6)`,
      forgedPayment, projectId, approval.id, billId, f.memberUser.id,
      await mint('commercial.payment.record', f.memberUser.id, forgedPayment),
    )).rejects.toThrow(/its own folds derive/u);

    // A bypass WITHHOLDING that does NOT change the answer is ACCEPTED, and that is the seal being
    // precise rather than a blanket ban on writing a fold table. ₹60 withheld against ₹100
    // certified with ₹40 approved and nothing paid still derives `approved-for-payment`: the fold
    // moved, the derivation did not, so there is nothing incoherent to refuse.
    await t.prisma.$executeRawUnsafe(
      `INSERT INTO "BillDeduction"("id","projectId","certificateId","billId","type","amount","recordedById","sourceCommandId")
       VALUES ($1,$2,$3,$4,'retention',60.00,$5,$6)`,
      forgedDeduction, projectId, certificate.id, billId, f.memberUser.id,
      await mint('commercial.deduction.record', f.memberUser.id, forgedDeduction),
    );
    expect(await expectDerived(projectId, billId, 'a fold write that does not move the answer')).toBe('approved-for-payment');

    // …and one that DOES change it is refused, through the certificate hop. A second bill with no
    // approval standing, withholding the WHOLE payable: NET_PAYABLE and PAID are both zero, which
    // §F calls `paid`, while the column still says `certified`.
    const second = await certifiedClaim(projectId);
    const secondCert = await t.prisma.billCertificate.findFirstOrThrow({
      where: { projectId, billId: second, supersededAt: null }, select: { id: true },
    });
    const forgedFull = `it-6bi-bypass-deduction-full-${seq++}`;
    await expect(t.prisma.$executeRawUnsafe(
      `INSERT INTO "BillDeduction"("id","projectId","certificateId","billId","type","amount","recordedById","sourceCommandId")
       VALUES ($1,$2,$3,$4,'retention',100.00,$5,$6)`,
      forgedFull, projectId, secondCert.id, second, f.memberUser.id,
      await mint('commercial.deduction.record', f.memberUser.id, forgedFull),
    )).rejects.toThrow(/its own folds derive/u);

    // and the fifth trigger — a bypass RELEASE, which reaches the bill through TWO hops. Withhold
    // the whole payable through the SERVICE (deriving `paid`), then give ₹40 back behind its back:
    // NET_PAYABLE rises to ₹40 above a PAID of zero, so the truth is `certified` and the column
    // still says `paid`. This is the non-monotonic direction, sealed.
    const held = await deductions.record(projectId, { billId: second, type: 'retention', amount: '100.00' }, pmc(projectId));
    expect(await expectDerived(projectId, second, 'fully withheld through the service')).toBe('paid');
    const forgedRelease = `it-6bi-bypass-release-${seq++}`;
    await expect(t.prisma.$executeRawUnsafe(
      `INSERT INTO "BillDeductionRelease"("id","projectId","deductionId","amount","reason","releasedById","sourceCommandId")
       VALUES ($1,$2,$3,40.00,'behind its back',$4,$5)`,
      forgedRelease, projectId, held.id, f.memberUser.id,
      await mint('commercial.deduction.release', f.memberUser.id, forgedRelease),
    )).rejects.toThrow(/its own folds derive/u);

    // every refusal above left the truth intact
    expect(await expectDerived(projectId, billId, 'after every refused bypass')).toBe('approved-for-payment');
    expect(await expectDerived(projectId, second, 'the second claim too')).toBe('paid');
  });

  it('R1-F5 (§F): the CERTIFICATE is a fold table too — a raw replacement cannot leave the status behind', async () => {
    // JagPat, alongside Codex round 1. The correction above said the seal fires from every table
    // that can make the equation false and then enumerated the four ledger tables plus the bill —
    // leaving out `BillCertificate`, which is a fold INPUT twice over: it supplies
    // `certifiedAmount` to NET_PAYABLE, and its `supersededAt IS NULL` is the predicate deciding
    // which approvals count toward APPROVED at all. `certificate.certify` and `certificate.supersede`
    // are two of this unit's six declared movers, so a mover whose table was unsealed was a mover
    // the database was not actually watching.
    //
    // The bypass is ONE otherwise-valid raw transaction, and every part of it is legitimate on its
    // own: superseding a certificate is the §F correction path, and replacing it with a coherent
    // certificate over the same version and evidence is what a correction IS.
    const projectId = await freshProject();
    const billId = await certifiedClaim(projectId);
    const c1 = await t.prisma.billCertificate.findFirstOrThrow({
      where: { projectId, billId, supersededAt: null }, select: { id: true, versionId: true, certifiedById: true },
    });
    await payments.approve(projectId, { billId, amount: '40.00' }, approver(projectId));
    expect(await expectDerived(projectId, billId, 'an authority stands on C1')).toBe('approved-for-payment');

    // supersede C1, certify C2 over the SAME version and the SAME evidence, touch nothing else.
    // The approval was made on C1, so it leaves live APPROVED and the folds now derive `certified`
    // — while the Task-5B projection seal is perfectly satisfied (still exactly one live
    // certificate beside an in-family status) and no ledger row and no bill row was written, so
    // none of the five other triggers has anything to fire on.
    const replace = async () => {
      const c2 = `it-6bi-cert-replace-${seq++}`;
      const commandId = `it-6bi-cert-cmd-${seq++}`;
      await t.prisma.$transaction(async (tx) => {
        await tx.commandExecution.create({
          data: {
            id: commandId, scopeKind: 'project', organizationId: f.orgA.id, projectId,
            actorId: f.memberUser.id, commandType: 'commercial.bill.certify',
            idempotencyKey: `t6bi-cert-${seq++}`, requestHash: 'x', status: 'reserved',
          },
        });
        await tx.commandExecution.update({
          where: { id: commandId }, data: { status: 'succeeded', resultRef: c2, completedAt: new Date() },
        });
        await tx.$executeRawUnsafe(
          `UPDATE "BillCertificate" SET "supersededAt"=now(), "supersededById"=$2, "supersedeReason"='corrected'
            WHERE "projectId"=$3 AND "id"=$1`,
          c1.id, f.memberUser.id, projectId,
        );
        await tx.$executeRawUnsafe(
          `INSERT INTO "BillCertificate"("id","projectId","billId","versionId","certifiedAmount","certifiedById","sourceCommandId")
           VALUES ($1,$2,$3,$4,100.00,$5,$6)`,
          c2, projectId, billId, c1.versionId, c1.certifiedById, commandId,
        );
        await tx.$executeRawUnsafe(
          `INSERT INTO "CertifiedAcceptanceConsumption"("id","projectId","certificateId","stockTransactionId","consumedQty")
           SELECT gen_random_uuid()::text, "projectId", $1, "stockTransactionId", "consumedQty"
             FROM "CertifiedAcceptanceConsumption" WHERE "projectId"=$2 AND "certificateId"=$3`,
          c2, projectId, c1.id,
        );
      });
      return c2;
    };
    await expect(replace(), 'the certificate table must be sealed like every other fold input')
      .rejects.toThrow(/its own folds derive/u);

    // nothing moved: C1 still stands and the authority on it is still live
    expect(await expectDerived(projectId, billId, 'after the refused replacement')).toBe('approved-for-payment');
    expect(await t.prisma.billCertificate.count({ where: { projectId, billId, supersededAt: null } })).toBe(1);

    // …and the SAME replacement carrying the status its folds derive is ACCEPTED, so the seal is
    // about coherence and not a ban on correcting a certification.
    const c2 = `it-6bi-cert-ok-${seq++}`;
    const okCommand = `it-6bi-cert-okcmd-${seq++}`;
    await t.prisma.$transaction(async (tx) => {
      await tx.commandExecution.create({
        data: {
          id: okCommand, scopeKind: 'project', organizationId: f.orgA.id, projectId,
          actorId: f.memberUser.id, commandType: 'commercial.bill.certify',
          idempotencyKey: `t6bi-cert-ok-${seq++}`, requestHash: 'x', status: 'reserved',
        },
      });
      await tx.commandExecution.update({
        where: { id: okCommand }, data: { status: 'succeeded', resultRef: c2, completedAt: new Date() },
      });
      await tx.$executeRawUnsafe(
        `UPDATE "BillCertificate" SET "supersededAt"=now(), "supersededById"=$2, "supersedeReason"='corrected'
          WHERE "projectId"=$3 AND "id"=$1`,
        c1.id, f.memberUser.id, projectId,
      );
      await tx.$executeRawUnsafe(
        `INSERT INTO "BillCertificate"("id","projectId","billId","versionId","certifiedAmount","certifiedById","sourceCommandId")
         VALUES ($1,$2,$3,$4,100.00,$5,$6)`,
        c2, projectId, billId, c1.versionId, c1.certifiedById, okCommand,
      );
      await tx.$executeRawUnsafe(
        `INSERT INTO "CertifiedAcceptanceConsumption"("id","projectId","certificateId","stockTransactionId","consumedQty")
         SELECT gen_random_uuid()::text, "projectId", $1, "stockTransactionId", "consumedQty"
           FROM "CertifiedAcceptanceConsumption" WHERE "projectId"=$2 AND "certificateId"=$3`,
        c2, projectId, c1.id,
      );
      await tx.$executeRawUnsafe(
        `UPDATE "VendorBill" SET "status"='certified', "statusChangedAt"=now() WHERE "projectId"=$1 AND "id"=$2`,
        projectId, billId,
      );
    });
    expect(await expectDerived(projectId, billId, 'the coherent replacement')).toBe('certified');
  });

  it('R1-F2 (§F): the migration BACKFILLS a bill 6A left behind, and never invents a fold', async () => {
    // The 6A schema stored `certified` on a bill that was already approved and paid, and that was
    // the CORRECT value under 6A's rule — its own PROBE 9 pinned it. This reconstructs that state
    // by disabling the new seals for one statement (the only way to reach it now), then runs the
    // migration's own backfill expression and requires it to land on the derived status.
    const projectId = await freshProject();
    const billId = await certifiedClaim(projectId);
    const approval = await payments.approve(projectId, { billId, amount: '100.00' }, approver(projectId));
    await payments.record(projectId, { approvalId: approval.id, amount: '100.00', method: 'neft' }, pmc(projectId));
    expect(await expectDerived(projectId, billId, 'fully paid through the service')).toBe('paid');

    // Reconstruct the pre-migration state the only way it is still reachable — with triggers
    // suppressed for ONE transaction. `set_config(..., true)` is TRANSACTION-local and restores
    // itself at commit or rollback; `ALTER TABLE … DISABLE TRIGGER` (the first draft here) is a
    // SCHEMA change visible to every session, so a throw between disable and enable would have
    // left the seal off for every suite that ran afterwards. In a shared-database suite that is a
    // footgun regardless of whether it happens to fire today.
    await t.prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SELECT set_config('session_replication_role', 'replica', true)`);
      await tx.$executeRawUnsafe(
        `UPDATE "VendorBill" SET "status"='certified', "statusChangedAt"=now() WHERE "projectId"=$1 AND "id"=$2`,
        projectId, billId,
      );
    });
    expect(await storedStatus(projectId, billId), 'the pre-migration state 6A legitimately left').toBe('certified');

    // the migration's backfill, verbatim — idempotent because its WHERE clause IS the fixpoint
    const backfill = `
      UPDATE "VendorBill" b
         SET "status" = phase5_t6b_derive_bill_status(b."projectId", b."id"),
             "statusChangedAt" = now()
       WHERE phase5_t6b_derived_bill_status(b."status")
         AND b."status" <> phase5_t6b_derive_bill_status(b."projectId", b."id")`;
    expect(await t.prisma.$executeRawUnsafe(backfill), 'the stale bill is corrected').toBeGreaterThanOrEqual(1);
    expect(await expectDerived(projectId, billId, 'after the backfill')).toBe('paid');
    expect(await t.prisma.$executeRawUnsafe(backfill), 'a second run moves nothing — idempotent').toBe(0);

    // it invented no money: the approval and payment rows are exactly what the service wrote
    expect(await t.prisma.paymentApproval.count({ where: { projectId, billId } })).toBe(1);
    expect(await t.prisma.payment.count({ where: { projectId, billId } })).toBe(1);
  });

  it('R1-F6 (upgrade): the migration is ONE serialized cutover — the OLD writer cannot commit into the gap', async () => {
    // JagPat, on the upgrade path. The backfill and the seal are two moments, and `docs/DEPLOY.md`
    // says the previous production container keeps serving until the new deploy succeeds — so
    // between them the OLD `commercial.payment.approve` can lock a coherent `certified` bill, append
    // a valid approval and commit with the status unmoved. That was CORRECT under 6A. A constraint
    // trigger does not validate rows written before it existed, so the bill would be permanently
    // stored `certified` while its folds derive `approved-for-payment`, with no future write
    // required to expose it and none able to repair it.
    //
    // Two halves, because the claim has two parts and each can fail on its own.

    // ── 1. the barrier is IN the migration, and BEFORE the two things it has to cover ────────────
    const migration = readFileSync(
      join(__dirname, '../../prisma/migrations/20270610000000_phase5_t6b_status_derivation/migration.sql'),
      'utf8',
    );
    // the MODE is part of the claim, not decoration: `SHARE ROW EXCLUSIVE` (the first draft) does
    // not conflict with `ROW SHARE`, so it would have let every `SELECT … FOR UPDATE` through
    const barrier = migration.search(/^LOCK TABLE "VendorBill" IN EXCLUSIVE MODE;$/mu);
    const backfill = migration.search(/^\s*UPDATE "VendorBill" b$/mu);
    // anchored at column 0 so this matches the STATEMENT, not the prose above it that names it —
    // the first draft of this probe matched its own comment and reported the barrier as too late
    const firstTrigger = migration.search(/^CREATE CONSTRAINT TRIGGER/mu);
    expect(barrier, 'the migration takes no cutover barrier, so the backfill and the seal are two moments an old writer can get between').toBeGreaterThan(-1);
    expect(backfill, 'the backfill moved or was renamed — this probe is asserting against text that no longer exists').toBeGreaterThan(-1);
    expect(firstTrigger, 'no constraint trigger is created — this probe is asserting against text that no longer exists').toBeGreaterThan(-1);
    expect(barrier, 'the barrier must precede the BACKFILL').toBeLessThan(backfill);
    expect(barrier, 'the barrier must precede the first TRIGGER install').toBeLessThan(firstTrigger);

    // ── 2. …and it actually excludes the old fold movers, which is a different claim ─────────────
    //
    // Every §F mover begins at `lockBill` (§0b bill-first), which is `SELECT … FOR UPDATE` and takes
    // ROW SHARE. `EXCLUSIVE` conflicts with it. The probe holds the migration's exact lock
    // in one session and proves a second session cannot get past that first step — deterministic,
    // via `pg_stat_activity`, never a sleep.
    const projectId = await freshProject();
    const billId = await certifiedClaim(projectId);
    expect(await expectDerived(projectId, billId, 'a coherent bill, exactly as the backfill leaves it')).toBe('certified');

    let releaseBarrier!: () => void;
    const held = new Promise<void>((r) => { releaseBarrier = r; });
    let barrierTaken!: () => void;
    const taken = new Promise<void>((r) => { barrierTaken = r; });

    const migrator = new PrismaClient();
    const oldWriter = new PrismaClient();
    try {
      const cutover = migrator.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`LOCK TABLE "VendorBill" IN EXCLUSIVE MODE`);
        barrierTaken();
        await held;
      }, { timeout: 60_000 });

      await taken;
      // the old container's very first step, verbatim: lock the bill it is about to approve against
      const blocked = oldWriter.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(
          `SELECT "id" FROM "VendorBill" WHERE "projectId"=$1 AND "id"=$2 FOR UPDATE`,
          projectId, billId,
        );
      }, { timeout: 60_000 }).then(() => 'committed', () => 'failed');

      await waitUntilBlocked('%FOR UPDATE%');
      // it is still waiting, and the bill is untouched — the old writer cannot reach its INSERT
      expect(await storedStatus(projectId, billId), 'the bill moved while the cutover barrier was held').toBe('certified');

      releaseBarrier();
      await cutover;
      expect(await blocked, 'the old writer should proceed once the cutover has committed').toBe('committed');
    } finally {
      releaseBarrier();
      await migrator.$disconnect();
      await oldWriter.$disconnect();
    }

    // …and after the cutover the bill is exactly what the derivation says, with the seal now live
    expect(await expectDerived(projectId, billId, 'after the cutover')).toBe('certified');
  });

  it('R1-F3 (§F): the payment ledger answers from ONE snapshot — a commit cannot land mid-read', async () => {
    // A DETERMINISTIC interleaving, not a timing loop. The first draft of this probe read the
    // ledger 25 times with nothing else writing and asserted the response was internally
    // consistent — which passed at the reviewed head too, because a serial read has no seam to
    // straddle. It proved nothing, and a probe that is green against the defect it names is worse
    // than no probe: it reports the bug as fixed.
    //
    // The seam is opened with a TABLE LOCK, so the interleaving is enforced by PostgreSQL rather
    // than guessed at:
    //   1. session A locks `PaymentApproval` and holds it,
    //   2. the ledger read starts: `VendorBill` succeeds (status `certified`), then it BLOCKS on
    //      the approvals query — confirmed via `pg_stat_activity`, condition-based, never a sleep,
    //   3. while it is blocked, session A appends an approval AND moves the status exactly as
    //      `payment.approve` does, then commits and releases the lock,
    //   4. the approvals query finally runs.
    //
    // At the reviewed head those two reads are separate statements, so step 4 sees the approval
    // that step 2 could not: `approved: 40.00` beside `billStatus: certified`, three numbers that
    // were each true once and are not true together. Under one repeatable-read snapshot the view is
    // fixed at step 2, so the whole response describes that instant and agrees with itself.
    const projectId = await freshProject();
    const billId = await certifiedClaim(projectId);
    const certificate = await t.prisma.billCertificate.findFirstOrThrow({
      where: { projectId, billId, supersededAt: null }, select: { id: true },
    });

    // The two waits are SEPARATE and both condition-based, so nothing here depends on ordering
    // luck: `locked` resolves when the writer has the table lock, `gate` is what the test opens
    // once it has SEEN the reader blocked. Polling from inside the transaction callback would
    // starve the reader of its turn on the event loop — the first attempt did exactly that and
    // timed out with the reader having issued no query at all.
    let lockedResolve!: () => void;
    const locked = new Promise<void>((r) => { lockedResolve = r; });
    let gateResolve!: () => void;
    const gate = new Promise<void>((r) => { gateResolve = r; });

    const raceDb = new PrismaClient();
    try {
      const held = raceDb.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`LOCK TABLE "PaymentApproval" IN ACCESS EXCLUSIVE MODE`);
        lockedResolve();
        await gate;
        // the approval and the status move together, as the service does — the seam under test is
        // the READ's, not a forged write's
        const commandId = `it-6bi-race-cmd-${seq++}`;
        const approvalId = `it-6bi-race-approval-${seq++}`;
        // reserved first, then completed — a receipt inserted already `succeeded` records a command
        // that never ran, and the platform floor refuses it
        await tx.commandExecution.create({
          data: {
            id: commandId, scopeKind: 'project', organizationId: f.orgA.id, projectId,
            actorId: f.ownerUser.id, commandType: 'commercial.payment.approve',
            idempotencyKey: `t6bi-race-${seq++}`, requestHash: 'x', status: 'reserved',
          },
        });
        await tx.commandExecution.update({
          where: { id: commandId },
          data: { status: 'succeeded', resultRef: approvalId, completedAt: new Date() },
        });
        await tx.$executeRawUnsafe(
          `INSERT INTO "PaymentApproval"("id","projectId","certificateId","billId","amount","approvedById","sourceCommandId")
           VALUES ($1,$2,$3,$4,40.00,$5,$6)`,
          approvalId, projectId, certificate.id, billId, f.ownerUser.id, commandId,
        );
        await tx.$executeRawUnsafe(
          `UPDATE "VendorBill" SET "status"='approved-for-payment', "statusChangedAt"=now()
            WHERE "projectId"=$1 AND "id"=$2`,
          projectId, billId,
        );
      }, { timeout: 60_000 });

      await locked;
      const reading = payments.ledger(projectId, billId, pmc(projectId));
      await waitUntilBlocked('%"public"."PaymentApproval"%');
      gateResolve();
      await held;
      const ledger = await reading;

      const netPayable = new Prisma.Decimal(ledger.approvable!).add(ledger.approved);
      expect(
        derivedBillStatus({
          netPayable,
          approved: new Prisma.Decimal(ledger.approved),
          paid: new Prisma.Decimal(ledger.paid),
        }),
        `the response straddles the commit: billStatus=${ledger.billStatus} beside approved=${ledger.approved}`,
      ).toBe(ledger.billStatus);
    } finally {
      await raceDb.$disconnect();
    }

    // …and once the writer has committed, the next read reports the new instant coherently, so the
    // snapshot delays the news rather than losing it
    expect(await expectDerived(projectId, billId, 'after the racing commit')).toBe('approved-for-payment');
    const [p, d] = await Promise.all([
      payments.ledger(projectId, billId, pmc(projectId)),
      deductions.readLedger(projectId, billId, pmc(projectId)),
    ]);
    expect(p.billStatus, 'the two ledgers read the same way and answer the same').toBe(d.billStatus);
    expect(p.approved).toBe('40.00');
  });
});
