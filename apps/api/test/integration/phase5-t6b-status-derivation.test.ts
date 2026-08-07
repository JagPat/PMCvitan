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
import type { CashForecastDto, CostHeadPositionDto } from '@vitan/shared';
import type { CreateRequirementInput } from '../../src/contracts';
import { CommercialDeductionQuery } from '../../src/commercial/commercial-deduction.query';
import { derivedBillStatus } from '../../src/commercial/commercial-status';
import { CommercialService } from '../../src/commercial/commercial.service';
import { CASH_FORECAST_PROJECTION, computeCashForecastDto } from '../../src/commercial/cash-forecast.projection';
import { readServableGeneration } from '../../src/platform/projections/generation';
import { ProjectionRebuilder } from '../../src/platform/projections/rebuilder.service';
import { ProjectionRebuildOperations } from '../../src/platform/projections/rebuild-operations';
import { OutboxRelay } from '../../src/platform/outbox/relay.service';

/**
 * Phase 5 Task 6B-i — §F's DERIVED payment status, proven live against PostgreSQL.
 *
 * Every bound is probed as a PAIR: the write that must be REFUSED and the neighbouring one that
 * must still be ALLOWED. A refusal alone proves only that something is strict, not that it is
 * right — Task 3's audit closed that as a rule, and 5C's rounds 8 and 10 both turned on it. Round
 * 10 in particular was three findings that each refused VALID work, so the acceptances here carry
 * as much weight as the refusals.
 */
describe('Phase 5 Tasks 6–7A — the §F/§H/§J money folds (live PG)', () => {
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
  let commercial: CommercialService;
  let relay: OutboxRelay;
  let ops: ProjectionRebuildOperations;
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
    commercial = t.app.get(CommercialService);
    relay = t.app.get(OutboxRelay);
    ops = new ProjectionRebuildOperations(t.prisma, t.app.get(ProjectionRebuilder));
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

  /**
   * A REAL, succeeded command receipt of the given type and actor, minted outside the services.
   *
   * Every money row must cite the command that PRODUCED it (5A's provenance floor, sealed at
   * `phase5_t6a_command_succeeded`), so a bypass probe that skipped this would be rejected by an
   * EARLIER seal and prove nothing about the one under test. Hoisted here in 6B-ii because a second
   * probe needed it: two copies of a forgery helper is how two probes start forging differently.
   */
  const mintCommand = async (
    projectId: string, type: string, actorId: string, resultRef: string,
  ): Promise<string> => t.prisma.$transaction(async (tx) => {
    const c = await tx.commandExecution.create({
      data: {
        scopeKind: 'project', organizationId: f.orgA.id, projectId, actorId,
        commandType: type, idempotencyKey: `t6b-bypass-${seq++}`, requestHash: 'x', status: 'reserved',
      },
      select: { id: true },
    });
    await tx.commandExecution.update({
      where: { id: c.id }, data: { status: 'succeeded', resultRef, completedAt: new Date() },
    });
    return c.id;
  });

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
    const mint = (type: string, actorId: string, resultRef: string): Promise<string> =>
      mintCommand(projectId, type, actorId, resultRef);
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

  // ══════════════════════════════════════════════════════════════════════════════════════════════
  // Task 6B unit ii — the reversal, and a `PAID` that can FALL
  // ══════════════════════════════════════════════════════════════════════════════════════════════
  //
  // These live in this file rather than a sibling because they are §F probes: every one of them
  // asserts the SAME invariant the unit-i probes above assert — the stored status equals what its
  // own folds derive — through a mover that lowers `PAID` instead of raising it. They reuse
  // `certifiedClaim`, `approver`, `expectDerived`, `mintCommand` and the barrier helper unchanged.
  //
  // A sibling file would have had to restate ~290 lines of fixture, and a fixture stated twice is
  // the drift this module keeps deleting: the two copies disagree the first time either is fixed.

  /** certified ₹100 → approved ₹100 → paid `amount`, returned with the payment that moved it. */
  const paidClaim = async (
    projectId: string, amount = '100',
  ): Promise<{ billId: string; approvalId: string; paymentId: string }> => {
    const billId = await certifiedClaim(projectId);
    const approval = await payments.approve(projectId, { billId, amount: '100' }, approver(projectId));
    const payment = await payments.record(
      projectId, { approvalId: approval.id, amount, method: 'neft' }, pmc(projectId),
    );
    return { billId, approvalId: approval.id, paymentId: payment.id };
  };

  it('PROBE 14 (§0): a reversal SUBTRACTS from `PAID` — never adds, and never a negative row', async () => {
    const projectId = await freshProject();
    const { billId, paymentId } = await paidClaim(projectId);
    expect((await foldsOf(projectId, billId)).paid.toFixed(2)).toBe('100.00');

    const after = await payments.reverse(
      projectId, { paymentId, amount: '50', reason: 'wrong account' }, pmc(projectId),
    );
    // ₹50, never ₹150. The row TYPE carries the direction, so the fold subtracts rather than the
    // row being signed — which is what makes both of the alternatives below unrepresentable.
    expect((await foldsOf(projectId, billId)).paid.toFixed(2)).toBe('50.00');
    expect(after.amount, 'the payment itself is untouched — it is what it always was').toBe('100.00');
    expect(after.reversed).toBe('50.00');
    expect(after.reversals).toHaveLength(1);
    expect(after.reversals[0]!.reason).toBe('wrong account');

    // a NEGATIVE reversal is refused by PostgreSQL, so "reversing a reversal" cannot be spelled as
    // a minus sign either. §H's sign rule holds on this table exactly as it does on `Payment`.
    const forged = `it-6bii-negative-${seq++}`;
    await expect(t.prisma.$executeRawUnsafe(
      `INSERT INTO "PaymentReversal"("id","projectId","paymentId","billId","amount","reason","reversedById","sourceCommandId")
       VALUES ($1,$2,$3,$4,-10.00,'a negative reversal',$5,$6)`,
      forged, projectId, paymentId, billId, f.memberUser.id,
      await mintCommand(projectId, 'commercial.payment.reverse', f.memberUser.id, forged),
    )).rejects.toThrow(/PaymentReversal_amount_positive/u);

    // …and a ZERO one, which would be a row claiming an act that moved nothing
    const forgedZero = `it-6bii-zero-${seq++}`;
    await expect(t.prisma.$executeRawUnsafe(
      `INSERT INTO "PaymentReversal"("id","projectId","paymentId","billId","amount","reason","reversedById","sourceCommandId")
       VALUES ($1,$2,$3,$4,0.00,'nothing moved',$5,$6)`,
      forgedZero, projectId, paymentId, billId, f.memberUser.id,
      await mintCommand(projectId, 'commercial.payment.reverse', f.memberUser.id, forgedZero),
    )).rejects.toThrow(/PaymentReversal_amount_positive/u);

    // the row is APPEND-ONLY: money that came back is evidence in the same sense money leaving is
    const row = await t.prisma.paymentReversal.findFirstOrThrow({ where: { projectId, paymentId } });
    await expect(t.prisma.$executeRawUnsafe(
      `UPDATE "PaymentReversal" SET "amount" = 10.00 WHERE "id" = $1`, row.id,
    )).rejects.toThrow(/append-only/u);
    await expect(t.prisma.$executeRawUnsafe(
      `DELETE FROM "PaymentReversal" WHERE "id" = $1`, row.id,
    )).rejects.toThrow(/append-only/u);

    // a blank reason is refused too — a reversal's justification IS its reason, and an append-only
    // row cannot acquire one later
    await expect(payments.reverse(
      projectId, { paymentId, amount: '1', reason: '   ' }, pmc(projectId),
    )).rejects.toThrow();
    expect(await expectDerived(projectId, billId, 'after every refused write')).toBe('part-paid');
  });

  it('PROBE 15 (§0): a reversal cannot return more than its OWN payment moved — service and PG', async () => {
    const projectId = await freshProject();
    // TWO payments against one approval, so the bill-level total is not the question: reversing ₹80
    // against a ₹40 payment keeps `Σ reversals ≤ Σ payments` at the BILL while the attribution is a
    // lie. That is the shape 6A round 3 found on the paying side, asked here on the returning side.
    const billId = await certifiedClaim(projectId);
    const approval = await payments.approve(projectId, { billId, amount: '100' }, approver(projectId));
    const first = await payments.record(projectId, { approvalId: approval.id, amount: '40', method: 'neft' }, pmc(projectId));
    await payments.record(projectId, { approvalId: approval.id, amount: '60', method: 'neft' }, pmc(projectId));
    expect((await foldsOf(projectId, billId)).paid.toFixed(2)).toBe('100.00');

    await expect(payments.reverse(
      projectId, { paymentId: first.id, amount: '80', reason: 'too much' }, pmc(projectId),
    )).rejects.toThrow(/would return more than payment .* it paid 40\.00/u);

    // EXACTLY the payment's amount is PERMITTED — the bound is precise, not merely strict, and an
    // off-by-one here would make a full reversal (the only kind §0's ordering accepts) impossible
    await payments.reverse(projectId, { paymentId: first.id, amount: '40', reason: 'wrong account' }, pmc(projectId));
    expect((await foldsOf(projectId, billId)).paid.toFixed(2)).toBe('60.00');

    // …and one paisa more, cumulatively, is refused: two part-reversals cannot exceed together what
    // neither could alone
    await expect(payments.reverse(
      projectId, { paymentId: first.id, amount: '0.01', reason: 'once more' }, pmc(projectId),
    )).rejects.toThrow(/40\.00 has already come back, so 0\.00 remains reversible/u);

    // the same over-reversal from a writer that never called the service is refused by PostgreSQL,
    // with every earlier seal satisfied — a real succeeded receipt of the right type and actor
    const forged = `it-6bii-over-${seq++}`;
    await expect(t.prisma.$executeRawUnsafe(
      `INSERT INTO "PaymentReversal"("id","projectId","paymentId","billId","amount","reason","reversedById","sourceCommandId")
       VALUES ($1,$2,$3,$4,10.00,'behind its back',$5,$6)`,
      forged, projectId, first.id, billId, f.memberUser.id,
      await mintCommand(projectId, 'commercial.payment.reverse', f.memberUser.id, forged),
    )).rejects.toThrow(/which moved only/u);

    expect(await expectDerived(projectId, billId, 'after the refusals')).toBe('part-paid');
  });

  it('PROBE 16 (§F): a reversal runs the derivation BACKWARDS, in its own transaction', async () => {
    const projectId = await freshProject();
    const { billId, paymentId } = await paidClaim(projectId);
    expect(await expectDerived(projectId, billId, 'fully paid')).toBe('paid');

    // partial: `0 < PAID < APPROVED` → `part-paid`
    await payments.reverse(projectId, { paymentId, amount: '40', reason: 'partial recall' }, pmc(projectId));
    expect(await expectDerived(projectId, billId, 'after a partial reversal')).toBe('part-paid');

    // full: `PAID = 0 < APPROVED` → `approved-for-payment`. The authority still stands; only the
    // cash came back. A lifecycle that only moved forward would have stranded this bill at `paid`
    // while `PAID` was zero — a stored status claiming money left that is sitting in the bank.
    await payments.reverse(projectId, { paymentId, amount: '60', reason: 'recall the rest' }, pmc(projectId));
    expect(await expectDerived(projectId, billId, 'after the full reversal')).toBe('approved-for-payment');
    expect((await foldsOf(projectId, billId)).paid.toFixed(2)).toBe('0.00');

    // …and the money can leave again against the SAME approval, because a reversal frees that
    // authority's own headroom too (`paidForApproval` nets). Without it the bill would derive
    // `approved-for-payment` while the only approval on it refused every payment.
    await payments.record(projectId, { approvalId: (await payments.ledger(projectId, billId, pmc(projectId))).approvals[0]!.id, amount: '100', method: 'neft' }, pmc(projectId));
    expect(await expectDerived(projectId, billId, 're-paid against the same authority')).toBe('paid');
  });

  it('PROBE 17 (§0): the correction ORDERING — reverse in full, THEN supersede, THEN re-approve', async () => {
    // The plan's 5ad/5ah, end to end. Until this unit existed the first step had no command, so a
    // certificate carrying cash was correct and permanently uncorrectable: bound 5 refuses a
    // supersession that would drop `APPROVED` to 0 beneath a standing `PAID`, and nothing could
    // lower `PAID`. That refusal was right; what was missing was the way out of it.
    const projectId = await freshProject();
    const { billId, paymentId } = await paidClaim(projectId);
    expect(await expectDerived(projectId, billId, 'certified, approved and paid')).toBe('paid');

    // (1) superseding now is REFUSED — ₹100 paid would stand against ₹0 approved
    await expect(certification.supersede(projectId, { billId, reason: 'over-certified' }, pmc(projectId)))
      .rejects.toThrow(/exceed the/u);

    // (2) a PARTIAL reversal is not enough, and this is the half an "excess only" rule gets wrong:
    // reverse ₹50, supersede to ₹50, and `APPROVED` is ₹0 while `PAID` is ₹50. Still refused.
    await payments.reverse(projectId, { paymentId, amount: '50', reason: 'partial recall' }, pmc(projectId));
    expect(await expectDerived(projectId, billId, 'half the cash back')).toBe('part-paid');
    await expect(certification.supersede(projectId, { billId, reason: 'over-certified' }, pmc(projectId)))
      .rejects.toThrow(/exceed the/u);

    // (3) the FULL reversal takes `PAID` to zero, and the supersession is then PERMITTED — both
    // sides of bound 5 are 0, which holds trivially
    await payments.reverse(projectId, { paymentId, amount: '50', reason: 'recall the rest' }, pmc(projectId));
    expect(await expectDerived(projectId, billId, 'all the cash back')).toBe('approved-for-payment');
    await certification.supersede(projectId, { billId, reason: 'over-certified' }, pmc(projectId));

    // the bill returns to the FORWARD lifecycle, and BOTH folds are zero: the ₹100 approval survives
    // on the superseded certificate as history — it records what was authorised then — while
    // `APPROVED` counts the live certificate only
    expect(await storedStatus(projectId, billId)).toBe('verified');
    const folds = await foldsOf(projectId, billId);
    expect(folds.approved.toFixed(2), 'the superseded certificate takes its approvals with it').toBe('0.00');
    expect(folds.paid.toFixed(2), 'the cash was recovered by its own attributable act').toBe('0.00');
    const ledger = await payments.ledger(projectId, billId, pmc(projectId));
    expect(ledger.approvals, 'the ₹100 approval is retained as history').toHaveLength(1);
    expect(ledger.approved, 'but it no longer counts, because its certificate no longer stands').toBe('0.00');

    // (4) …and the corrected amount needs a FRESH attributable approval. Re-certifying puts the
    // claim back at the START of the payment lifecycle — `certified`, with `APPROVED` at zero —
    // rather than inheriting the authority that was granted against the certificate it replaced.
    //
    // The certified amount itself is the CLAIM's, not this command's: `certify` folds the live
    // version, so correcting ₹100 down to ₹50 is a claim AMENDMENT (Task 4's `bills.amend`, already
    // cleared) and not something the payment side can or should do. What §0's ordering fixes, and
    // what this probe is about, is the SEQUENCE in which cash and document move — so the probe
    // re-certifies the unchanged claim and asserts the authority did not survive.
    await certification.certify(projectId, { billId }, pmc(projectId));
    expect(await expectDerived(projectId, billId, 're-certified')).toBe('certified');
    const reFolds = await foldsOf(projectId, billId);
    expect(reFolds.netPayable.toFixed(2), 'the claim is payable again').toBe('100.00');
    expect(reFolds.approved.toFixed(2), 'and no approval carried over from the superseded certificate').toBe('0.00');
    await payments.approve(projectId, { billId, amount: '100' }, approver(projectId));
    expect(await expectDerived(projectId, billId, 'freshly approved')).toBe('approved-for-payment');
  });

  it('PROBE 18 (§F): a bypass reversal that leaves the status behind is REFUSED — the sixth fold table', async () => {
    // `PaymentReversal` is a NEW input to `PAID`, so it needs its OWN derivation seal. This is the
    // trigger 6B-i's convergence closure was written to demand: its delegate extractor is
    // mutation-tested against exactly this addition, so the closure failed at the desk until the
    // trigger existed. This probe is the database half of the same question.
    const projectId = await freshProject();
    const { billId, paymentId } = await paidClaim(projectId);

    const forged = `it-6bii-behind-${seq++}`;
    await expect(t.prisma.$executeRawUnsafe(
      `INSERT INTO "PaymentReversal"("id","projectId","paymentId","billId","amount","reason","reversedById","sourceCommandId")
       VALUES ($1,$2,$3,$4,100.00,'behind its back',$5,$6)`,
      forged, projectId, paymentId, billId, f.memberUser.id,
      await mintCommand(projectId, 'commercial.payment.reverse', f.memberUser.id, forged),
    )).rejects.toThrow(/its own folds derive/u);
    expect(await expectDerived(projectId, billId, 'the refusal changed nothing')).toBe('paid');

    // …and the seal is PRECISE rather than a blanket ban on writing the table — the distinction
    // R1-F4 established for the other five, asked here. A claim approved ₹100 and paid ₹60 derives
    // `part-paid` from `0 < PAID < APPROVED`; a bypass reversal of ₹20 lowers `PAID` to ₹40, which
    // is STILL that arm. The fold moved and the derivation did not, so there is nothing incoherent
    // to refuse and the write is ACCEPTED.
    const second = await freshProject();
    const secondBill = await certifiedClaim(second);
    const approval = await payments.approve(second, { billId: secondBill, amount: '100' }, approver(second));
    const payment = await payments.record(second, { approvalId: approval.id, amount: '60', method: 'neft' }, pmc(second));
    expect(await expectDerived(second, secondBill, 'part paid')).toBe('part-paid');

    const benign = `it-6bii-benign-${seq++}`;
    await t.prisma.$executeRawUnsafe(
      `INSERT INTO "PaymentReversal"("id","projectId","paymentId","billId","amount","reason","reversedById","sourceCommandId")
       VALUES ($1,$2,$3,$4,20.00,'still part-paid',$5,$6)`,
      benign, second, payment.id, secondBill, f.memberUser.id,
      await mintCommand(second, 'commercial.payment.reverse', f.memberUser.id, benign),
    );
    expect(await expectDerived(second, secondBill, 'a fold write that does not move the answer')).toBe('part-paid');

    // …while the REST of it does move the answer — `PAID` to zero, which §F calls
    // `approved-for-payment` — and is refused
    const moving = `it-6bii-moving-${seq++}`;
    await expect(t.prisma.$executeRawUnsafe(
      `INSERT INTO "PaymentReversal"("id","projectId","paymentId","billId","amount","reason","reversedById","sourceCommandId")
       VALUES ($1,$2,$3,$4,40.00,'takes PAID to zero',$5,$6)`,
      moving, second, payment.id, secondBill, f.memberUser.id,
      await mintCommand(second, 'commercial.payment.reverse', f.memberUser.id, moving),
    )).rejects.toThrow(/its own folds derive/u);

    // …and the same write THROUGH the service, which re-derives in its own transaction, is accepted
    await payments.reverse(second, { paymentId: payment.id, amount: '40', reason: 'recall the rest' }, pmc(second));
    expect(await expectDerived(second, secondBill, 'the service path')).toBe('approved-for-payment');

    // provenance is sealed too: a reversal citing a command of the WRONG TYPE is refused, so the
    // third arm of `phase5_t6a_command_succeeded` is really installed rather than merely written
    const forgedType = `it-6bii-wrongtype-${seq++}`;
    await expect(t.prisma.$executeRawUnsafe(
      `INSERT INTO "PaymentReversal"("id","projectId","paymentId","billId","amount","reason","reversedById","sourceCommandId")
       VALUES ($1,$2,$3,$4,10.00,'wrong receipt',$5,$6)`,
      forgedType, projectId, paymentId, billId, f.memberUser.id,
      await mintCommand(projectId, 'commercial.payment.record', f.memberUser.id, forgedType),
    )).rejects.toThrow(/records the command that PRODUCED it/u);
  });

  it('PROBE 19 (§0b): a reversal SERIALIZES — on the bill through the service, on the payment at PG', async () => {
    // The plan names this shape: *"Concurrent reversals over-release `PAID` by the identical
    // shape"* two concurrent payments break bound 5. Under READ COMMITTED both sessions read
    // `reversed = 0` against a ₹80 payment, both pass a ₹50 bound, and both commit — ₹100 returned
    // against ₹80 that left, with every row append-only.
    //
    // Two halves, because there are two writers to serialize and they are stopped in different
    // places. Both are CONDITION-based (`pg_blocking_pids`), never a sleep, and both assert WHICH
    // statement is waiting rather than that something is: "a backend is blocked" is a PROXY, and
    // the first draft of half (b) passed against a deliberately un-serialized trigger because of it.
    const projectId = await freshProject();
    const billId = await certifiedClaim(projectId);
    const approval = await payments.approve(projectId, { billId, amount: '100' }, approver(projectId));
    const payment = await payments.record(projectId, { approvalId: approval.id, amount: '80', method: 'neft' }, pmc(projectId));

    /** poll until some backend is waiting on another's lock, and return WHAT it was running */
    const blockedQuery = async (why: string): Promise<string> => {
      for (let i = 0; i < 400; i++) {
        const rows = await t.prisma.$queryRawUnsafe<Array<{ q: string }>>(
          `SELECT query AS q FROM pg_stat_activity
            WHERE datname = current_database() AND cardinality(pg_blocking_pids(pid)) > 0`,
        );
        if (rows.length > 0) return rows[0]!.q;
        await new Promise((r) => setTimeout(r, 25));
      }
      throw new Error(`barrier timeout: ${why}`);
    };

    // ── (a) the SERVICE path serializes on the BILL (§0b's order, taken FIRST) ─────────────────
    const other = new PrismaClient();
    try {
      let release!: () => void; let staged!: () => void;
      const held = new Promise<void>((r) => { release = r; });
      const ready = new Promise<void>((r) => { staged = r; });
      const holder = other.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SELECT "id" FROM "VendorBill" WHERE "projectId"=$1 AND "id"=$2 FOR UPDATE`, projectId, billId);
        staged();
        await held;
      }, { timeout: 30_000 });
      await ready;

      const reversing = payments
        .reverse(projectId, { paymentId: payment.id, amount: '50', reason: 'session B' }, pmc(projectId))
        .then(() => 'committed' as const, (e: Error) => e);
      const waiting = await blockedQuery('the reversal must WAIT for the bill lock — a fold read ahead of it decides on a balance that can still change');
      expect(waiting, 'the reversal is blocked somewhere other than the bill row it is required to take FIRST').toMatch(/"VendorBill"/u);

      release();
      await holder;
      expect(await reversing, 'the reversal, unblocked, commits').toBe('committed');
    } finally {
      await other.$disconnect();
    }
    expect((await foldsOf(projectId, billId)).paid.toFixed(2)).toBe('30.00');

    // ── (b) the DATABASE bound SERIALIZES rather than merely counting ──────────────────────────
    //
    // Phase 4 T3's F3 is the finding this half exists to avoid repeating: a commit-time trigger that
    // COUNTS without locking lets two independent sessions each see zero and both commit. So the
    // claim is not "the trigger rejects an over-reversal" (PROBE 15 shows that) but "it takes the
    // lock" — and a lock is only observable by making something WAIT on it.
    //
    // The gate therefore holds `FOR NO KEY UPDATE`, and the mode is the whole design. An INSERT
    // into `PaymentReversal` takes `FOR KEY SHARE` on its referenced `Payment` row for the foreign
    // key, and `FOR KEY SHARE` conflicts ONLY with `FOR UPDATE` — so a gate holding `FOR UPDATE`
    // would block the INSERT itself, and the barrier would be satisfied by the FK rather than by
    // the trigger. That is exactly what the first draft did, and it passed against a trigger with
    // the `FOR UPDATE` deliberately removed. `FOR NO KEY UPDATE` lets the FK through and conflicts
    // only with the trigger's own `FOR UPDATE`, so the wait it observes can have no other cause.
    const gate = new PrismaClient();
    const racer = new PrismaClient();
    try {
      let release!: () => void; let staged!: () => void;
      const held = new Promise<void>((r) => { release = r; });
      const ready = new Promise<void>((r) => { staged = r; });
      const holder = gate.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SELECT "id" FROM "Payment" WHERE "projectId"=$1 AND "id"=$2 FOR NO KEY UPDATE`, projectId, payment.id);
        staged();
        await held;
      }, { timeout: 30_000 });
      await ready;

      // a bypass reversal of ₹10 leaves `PAID` at ₹20 — still `part-paid`, so the derivation seal
      // has nothing to refuse and the ONLY thing that can make this wait is the bound's own lock
      const forged = `it-6bii-serialize-${seq++}`;
      const commandId = await mintCommand(projectId, 'commercial.payment.reverse', f.memberUser.id, forged);
      const racing = racer.$executeRawUnsafe(
        `INSERT INTO "PaymentReversal"("id","projectId","paymentId","billId","amount","reason","reversedById","sourceCommandId")
         VALUES ($1,$2,$3,$4,10.00,'serialized',$5,$6)`,
        forged, projectId, payment.id, billId, f.memberUser.id, commandId,
      ).then(() => 'committed' as const, (e: Error) => e);
      const waiting = await blockedQuery('the commit-time bound must TAKE the payment row — a trigger that only counted would not wait for it, and two sessions would each read a stale balance');
      // the waiter is the COMMIT of the racing insert: PostgreSQL reports the statement that owns
      // the deferred trigger, so the blocked query is the INSERT and the lock it wants is the
      // trigger's. What matters is that it waits at all, with the FK path deliberately unblocked.
      expect(waiting, 'something other than the racing reversal is blocked').toMatch(/PaymentReversal/u);

      release();
      await holder;
      expect(await racing, 'once the row is free the write commits').toBe('committed');
    } finally {
      await Promise.all([gate.$disconnect(), racer.$disconnect()]);
    }

    // …and the arithmetic is conserved: ₹80 left, ₹60 has come back, ₹20 stands
    expect((await foldsOf(projectId, billId)).paid.toFixed(2)).toBe('20.00');
    expect(await expectDerived(projectId, billId, 'after both barriers')).toBe('part-paid');
    await expect(payments.reverse(
      projectId, { paymentId: payment.id, amount: '30', reason: 'one too many' }, pmc(projectId),
    )).rejects.toThrow(/60\.00 has already come back, so 20\.00 remains reversible/u);
  });
  it('PROBE 20 (§D/§0): containment, replay and authority', async () => {
    const a = await freshProject();
    const b = await freshProject();
    const { paymentId, billId } = await paidClaim(a);

    // a sibling project cannot reach this payment — the command is project-scoped and the row is
    // resolved inside that scope, so there is nothing to authorise against
    await expect(payments.reverse(b, { paymentId, amount: '10', reason: 'wrong project' }, pmc(b)))
      .rejects.toThrow(/not found in this project/u);

    // an engineer may read the commercial register and may not recover money from it
    const engineer = { sub: f.memberUser.id, role: 'engineer', projectId: a } as AuthUser;
    await expect(payments.reverse(a, { paymentId, amount: '10', reason: 'not mine to make' }, engineer))
      .rejects.toThrow(/pmc surface/u);

    // a KEYED replay appends nothing and re-derives to the same status — the command ledger's own
    // rule, asserted on the row count because "the same answer" is not the same as "no second row"
    const key = `it-6bii-replay-${seq++}`;
    const first = await payments.reverse(a, { paymentId, amount: '25', reason: 'recall' }, pmc(a), key);
    const again = await payments.reverse(a, { paymentId, amount: '25', reason: 'recall' }, pmc(a), key);
    // the REVERSAL's identity, not the payment's — both calls return the payment either way, so
    // comparing `id` would be true even if the second call had appended a second reversal
    expect(again.reversals.map((r) => r.id)).toEqual(first.reversals.map((r) => r.id));
    expect(again.reversed).toBe('25.00');
    expect(await t.prisma.paymentReversal.count({ where: { projectId: a, paymentId } })).toBe(1);
    expect((await foldsOf(a, billId)).paid.toFixed(2)).toBe('75.00');
    expect(await expectDerived(a, billId, 'after the replay')).toBe('part-paid');
  });

  it('PROBE 21 (§F): the payment ledger reports the reversal and the `PAID` it lowered', async () => {
    const projectId = await freshProject();
    const { billId, paymentId, approvalId } = await paidClaim(projectId);
    await payments.reverse(projectId, { paymentId, amount: '30', reason: 'duplicate transfer' }, pmc(projectId));

    const ledger = await payments.ledger(projectId, billId, pmc(projectId));
    // the fold and the rows it is folded from agree, at every level of the response
    expect(ledger.paid, '§G bound 5’s left side is net of reversals').toBe('70.00');
    expect(ledger.billStatus).toBe('part-paid');
    const approval = ledger.approvals.find((a) => a.id === approvalId)!;
    expect(approval.paid, 'the authority reports what it actually released').toBe('70.00');
    const payment = approval.payments.find((p) => p.id === paymentId)!;
    expect(payment.amount, 'the payment is still what it was — money did leave').toBe('100.00');
    expect(payment.reversed).toBe('30.00');
    expect(payment.reversals).toHaveLength(1);
    expect(payment.reversals[0]!.reason, 'a reviewer can see WHY it came back, not only that it did').toBe('duplicate transfer');
    expect(payment.reversals[0]!.reversedById).toBe(f.memberUser.id);

    // and the read is one instant: the status beside the folds it is derived from
    expect(
      derivedBillStatus({
        netPayable: new Prisma.Decimal((await foldsOf(projectId, billId)).netPayable),
        approved: new Prisma.Decimal(ledger.approved),
        paid: new Prisma.Decimal(ledger.paid),
      }),
    ).toBe(ledger.billStatus);
  });

  // ══════════════════════════════════════════════════════════════════════════════════════════════
  // Task 6C — the ADVANCE, and the recovery that draws it down
  // ══════════════════════════════════════════════════════════════════════════════════════════════
  //
  // Same file, same reason as unit ii: these reuse `issuedMaterialLine` / `acceptOnLine` /
  // `verifiedClaim` / `certifiedClaim` / `expectDerived` / `mintCommand` unchanged, and a sibling
  // file would have restated ~290 lines of fixture. A fixture stated twice is the drift this module
  // keeps deleting — the two copies disagree the first time either is fixed.
  //
  // What is genuinely new here is a bound that is NOT bill-scoped. §H's advance pool belongs to a
  // COUNTERPARTY, so probe 24 is the one that matters most: two recoveries on two DIFFERENT bills
  // of the same vendor take two different bill locks and never meet.

  /** a certified ₹`qty` claim, with its counterparty named — every 6C probe needs both. */
  const certifiedClaimFor = async (
    projectId: string, vendorId?: string, qty = '100',
  ): Promise<{ billId: string; vendorId: string }> => {
    const line = await issuedMaterialLine(projectId, { qty, vendorId });
    await acceptOnLine(projectId, line, qty);
    const billId = await verifiedClaim(projectId, line.vendorId, [{ poLineId: line.poLineId, quantity: qty }]);
    await certification.certify(projectId, { billId }, pmc(projectId));
    return { billId, vendorId: line.vendorId };
  };

  const advancePositionOf = async (projectId: string, billId: string) =>
    (await deductions.readLedger(projectId, billId, pmc(projectId))).advance;

  it('PROBE 22 (§H): a recovery cannot take back more than actually went out — the plan’s 5bp, in order', async () => {
    const projectId = await freshProject();
    // a ₹200 certificate, deliberately. §H's bound 1 (a withholding cannot exceed what the
    // certificate leaves payable) is checked FIRST, so a ₹150 recovery against a ₹100 certificate
    // is refused by the CERTIFICATE and never reaches the advance ceiling — the first draft of this
    // probe asserted the advance message and got bound 1's, which is the two bounds being distinct
    // rather than either being wrong. PROBE 26 is the mirror: bound 1 firing while the pool is fine.
    const { billId, vendorId } = await certifiedClaimFor(projectId, undefined, '200');

    // nothing advanced yet: the ceiling is zero, so even ₹1 is refused. This is the arm that makes
    // the whole task necessary — without it the sign, fold and status probes all pass while the
    // vendor is underpaid by whatever was "recovered".
    await expect(deductions.record(
      projectId, { billId, type: 'advance-recovery', amount: '1' }, pmc(projectId),
    )).rejects.toThrow(/0\.00 went out, 0\.00 has already been recovered, so 0\.00 remains/u);

    await deductions.payAdvance(projectId, {
      vendorId, amount: '100', reason: 'mobilisation', method: 'neft',
    }, pmc(projectId));
    expect((await advancePositionOf(projectId, billId)).recoverable).toBe('100.00');

    // ₹150 REFUSED, naming the balance — a message that only says "too much" leaves the practice
    // guessing at the number it is allowed
    await expect(deductions.record(
      projectId, { billId, type: 'advance-recovery', amount: '150' }, pmc(projectId),
    )).rejects.toThrow(/100\.00 went out, 0\.00 has already been recovered, so 100\.00 remains/u);

    // …₹100 PERMITTED. The bound is PRECISE, not merely strict: an off-by-one here would make a
    // full recovery — the ordinary case — impossible.
    await deductions.record(projectId, { billId, type: 'advance-recovery', amount: '100' }, pmc(projectId));
    const after = await advancePositionOf(projectId, billId);
    expect(after.advanced).toBe('100.00');
    expect(after.recovered).toBe('100.00');
    expect(after.recoverable).toBe('0.00');

    // …and a further ₹1 REFUSED, cumulatively. Two part-recoveries cannot exceed together what
    // neither could alone, which is what "the fold, with no stored balance" buys.
    const second = await certifiedClaimFor(projectId, vendorId);
    await expect(deductions.record(
      projectId, { billId: second.billId, type: 'advance-recovery', amount: '1' }, pmc(projectId),
    )).rejects.toThrow(/100\.00 has already been recovered, so 0\.00 remains/u);
  });

  it('PROBE 23 (§F): a fully-offset certificate reaches `paid` with no cash moving — the plan’s 5bs', async () => {
    // §F's FIRST arm is `NET_PAYABLE = PAID`, and this is the case that ordering exists for. Offset
    // a ₹100 certificate entirely with a ₹100 advance-recovery and all three folds are zero. If
    // `APPROVED = 0` were asked first the bill would sit at `certified` forever — approval and
    // payment rows are STRICTLY POSITIVE (§H), so there is no legal row anyone could write to
    // advance it. Until 6C the arm was unreachable through a recovery, because the type did not
    // exist; this is the probe the plan wrote it for.
    const projectId = await freshProject();
    const { billId, vendorId } = await certifiedClaimFor(projectId);
    await deductions.payAdvance(projectId, {
      vendorId, amount: '100', reason: 'mobilisation', method: 'neft',
    }, pmc(projectId));

    expect(await expectDerived(projectId, billId, 'certified, nothing offset yet')).toBe('certified');
    await deductions.record(projectId, { billId, type: 'advance-recovery', amount: '100' }, pmc(projectId));

    const folds = await foldsOf(projectId, billId);
    expect(folds.netPayable.toFixed(2), 'the whole payable is offset').toBe('0.00');
    expect(folds.approved.toFixed(2)).toBe('0.00');
    expect(folds.paid.toFixed(2), 'no cash moved — the recovery is a withholding, not a payment').toBe('0.00');
    expect(await expectDerived(projectId, billId, 'nothing remains payable')).toBe('paid');

    // …and `paid` here means "nothing remains payable", not "money was sent". The advance is not in
    // `PAID(bill)` and cannot be: `paidFor` folds `"Payment"` by `billId`, and an advance has none.
    const ledger = await payments.ledger(projectId, billId, pmc(projectId));
    expect(ledger.paid, 'the advance never entered PAID').toBe('0.00');
  });

  it('PROBE 24 (§0b): the ceiling serializes on the COUNTERPARTY — two bills, one vendor', async () => {
    // The defect this exists to prevent, and the reason §0b's bill-first lock is not enough on its
    // own: two recoveries on two DIFFERENT bills of the same vendor take two DIFFERENT bill locks
    // and never meet. Under READ COMMITTED both read the same ₹100 recoverable, both pass, and both
    // commit — ₹200 recovered against ₹100 that went out, with every row append-only.
    const projectId = await freshProject();
    const first = await certifiedClaimFor(projectId);
    const second = await certifiedClaimFor(projectId, first.vendorId);
    await deductions.payAdvance(projectId, {
      vendorId: first.vendorId, amount: '100', reason: 'mobilisation', method: 'neft',
    }, pmc(projectId));

    const gate = new PrismaClient();
    try {
      let release!: () => void; let staged!: () => void;
      const held = new Promise<void>((r) => { release = r; });
      const ready = new Promise<void>((r) => { staged = r; });
      // a third session holds the BINDING — the one row both recoveries must touch
      const holder = gate.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SELECT "vendorId" FROM "ProjectVendor" WHERE "projectId"=$1 AND "vendorId"=$2 FOR UPDATE`, projectId, first.vendorId);
        staged();
        await held;
      }, { timeout: 30_000 });
      await ready;

      const recovering = deductions
        .record(projectId, { billId: first.billId, type: 'advance-recovery', amount: '100' }, pmc(projectId))
        .then(() => 'committed' as const, (e: Error) => e);

      // CONDITION-based, and it asserts WHICH statement waits. "A backend is blocked" is a PROXY:
      // this recovery also takes a bill lock and a readiness lock, so a bare blocked-count would be
      // satisfied by either and would pass against a build that never locked the vendor at all.
      let waiting = '';
      for (let i = 0; i < 400 && !waiting; i++) {
        const rows = await t.prisma.$queryRawUnsafe<Array<{ q: string }>>(
          `SELECT query AS q FROM pg_stat_activity
            WHERE datname = current_database() AND cardinality(pg_blocking_pids(pid)) > 0`);
        waiting = rows[0]?.q ?? '';
        if (!waiting) await new Promise((r) => setTimeout(r, 25));
      }
      expect(waiting, 'the recovery must WAIT for the vendor binding — the bill lock alone lets two bills of one counterparty read the same balance').toMatch(/"ProjectVendor"/u);

      release();
      await holder;
      expect(await recovering, 'the first recovery, unblocked, commits').toBe('committed');
    } finally {
      await gate.$disconnect();
    }

    // …and the SECOND bill's recovery is now refused: the pool is empty, and it found that out
    // because the binding serialized the two
    await expect(deductions.record(
      projectId, { billId: second.billId, type: 'advance-recovery', amount: '100' }, pmc(projectId),
    )).rejects.toThrow(/100\.00 has already been recovered, so 0\.00 remains/u);
    expect((await advancePositionOf(projectId, second.billId)).recovered, 'exactly one ₹100 came back').toBe('100.00');
  });

  it('PROBE 30 (§0b): the DATABASE ceiling SERIALIZES on the binding — it does not merely count', async () => {
    // PROBE 24 proves the SERVICE waits, and that is a different claim: it holds the binding through
    // `ProcurementParticipant.lockVendorBinding`, so a gate on that row blocks the service whether
    // or not the SEAL locks anything. Run the mutation and PROBE 24 still passes — which is the
    // definition of a probe asserting a proxy, and 6B-ii's PROBE 19(b) is the same lesson one unit
    // earlier: a lock is only observable by making something WAIT on it.
    //
    // So this one skips the service entirely. A raw `BillDeduction` insert takes FK key-share locks
    // on its certificate and its bill and touches `ProjectVendor` NOWHERE — there is no foreign key
    // to it from this table — so the ONLY thing that can make this write wait on the binding is
    // `phase5_t6c_recoverable_check` taking it at COMMIT. Remove that `FOR UPDATE` and the barrier
    // below times out.
    const projectId = await freshProject();
    const { billId, vendorId } = await certifiedClaimFor(projectId);
    await deductions.payAdvance(projectId, {
      vendorId, amount: '100', reason: 'mobilisation', method: 'neft',
    }, pmc(projectId));
    const cert = await t.prisma.billCertificate.findFirstOrThrow({
      where: { projectId, billId, supersededAt: null }, select: { id: true },
    });

    const gate = new PrismaClient();
    const racer = new PrismaClient();
    try {
      let release!: () => void; let staged!: () => void;
      const held = new Promise<void>((r) => { release = r; });
      const ready = new Promise<void>((r) => { staged = r; });
      const holder = gate.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SELECT "vendorId" FROM "ProjectVendor" WHERE "projectId"=$1 AND "vendorId"=$2 FOR NO KEY UPDATE`, projectId, vendorId);
        staged();
        await held;
      }, { timeout: 30_000 });
      await ready;

      // a WITHIN-BOUND recovery, so the only possible outcome is "commits, after waiting" — a
      // refusal here would prove nothing about the lock
      const forged = `it-6c-serialize-${seq++}`;
      const commandId = await mintCommand(projectId, 'commercial.deduction.record', f.memberUser.id, forged);
      const racing = racer.$executeRawUnsafe(
        `INSERT INTO "BillDeduction"("id","projectId","certificateId","billId","type","amount","recordedById","sourceCommandId")
         VALUES ($1,$2,$3,$4,'advance-recovery',50.00,$5,$6)`,
        forged, projectId, cert.id, billId, f.memberUser.id, commandId,
      ).then(() => 'committed' as const, (e: Error) => e);

      let waiting = '';
      for (let i = 0; i < 400 && !waiting; i++) {
        const rows = await t.prisma.$queryRawUnsafe<Array<{ q: string }>>(
          `SELECT query AS q FROM pg_stat_activity
            WHERE datname = current_database() AND cardinality(pg_blocking_pids(pid)) > 0`);
        waiting = rows[0]?.q ?? '';
        if (!waiting) await new Promise((r) => setTimeout(r, 25));
      }
      expect(waiting, 'the commit-time ceiling must TAKE the binding — a seal that only counted would let two bypass writers each read the same balance and both commit').toMatch(/BillDeduction/u);

      release();
      await holder;
      expect(await racing, 'once the binding is free the write commits').toBe('committed');
    } finally {
      await Promise.all([gate.$disconnect(), racer.$disconnect()]);
    }
    expect((await advancePositionOf(projectId, billId)).recoverable).toBe('50.00');
  });

  it('PROBE 25 (§H): an advance to one counterparty cannot be recovered from another’s claim', async () => {
    const projectId = await freshProject();
    const a = await certifiedClaimFor(projectId);
    const b = await certifiedClaimFor(projectId);   // a DIFFERENT vendor — `issuedMaterialLine` mints one
    expect(a.vendorId).not.toBe(b.vendorId);

    await deductions.payAdvance(projectId, {
      vendorId: a.vendorId, amount: '100', reason: 'mobilisation', method: 'neft',
    }, pmc(projectId));

    // B's claim sees a zero pool, because the fold is scoped to the claim's own counterparty
    expect((await advancePositionOf(projectId, b.billId)).recoverable).toBe('0.00');
    await expect(deductions.record(
      projectId, { billId: b.billId, type: 'advance-recovery', amount: '100' }, pmc(projectId),
    )).rejects.toThrow(/0\.00 went out/u);

    // …while A's own claim recovers it, so the refusal above is containment and not a blanket ban
    await deductions.record(projectId, { billId: a.billId, type: 'advance-recovery', amount: '100' }, pmc(projectId));
    expect((await advancePositionOf(projectId, a.billId)).recoverable).toBe('0.00');
  });

  it('PROBE 26 (§H): BOTH ceilings apply — the certificate’s and the advance’s', async () => {
    // A recovery is a `BillDeduction`, so §H's bound 1 (a withholding cannot exceed what the
    // certificate leaves payable) still governs it. 6C adds a SECOND ceiling rather than replacing
    // the first, and the probe that matters is the case where one is satisfied and the other is not:
    // a ₹200 advance against a ₹100 certificate has plenty of pool and no payable to take it from.
    const projectId = await freshProject();
    const { billId, vendorId } = await certifiedClaimFor(projectId);
    await deductions.payAdvance(projectId, {
      vendorId, amount: '200', reason: 'over-advanced', method: 'neft',
    }, pmc(projectId));

    await expect(deductions.record(
      projectId, { billId, type: 'advance-recovery', amount: '150' }, pmc(projectId),
    )).rejects.toThrow(/can carry 100\.00 more of withholding/u);

    // ₹100 fits both ceilings and is taken; the remaining ₹100 of advance stays recoverable against
    // a LATER certificate, which is exactly what §H's bound-1 refusal tells the operator to do
    await deductions.record(projectId, { billId, type: 'advance-recovery', amount: '100' }, pmc(projectId));
    expect((await advancePositionOf(projectId, billId)).recoverable).toBe('100.00');
  });

  it('PROBE 27 (§H): the advance fact’s own seals, and its provenance', async () => {
    const projectId = await freshProject();
    const { billId, vendorId } = await certifiedClaimFor(projectId);

    // an unbound counterparty is refused by the OWNER of the binding, not by a local read
    await expect(deductions.payAdvance(projectId, {
      vendorId: 'not-a-bound-vendor', amount: '10', reason: 'x', method: 'neft',
    }, pmc(projectId))).rejects.toThrow(/not bound to this project/u);

    // §H sign discipline, at the service and at PG
    await expect(deductions.payAdvance(projectId, {
      vendorId, amount: '0', reason: 'nothing moved', method: 'neft',
    }, pmc(projectId))).rejects.toThrow(/strictly positive/u);

    const advance = await deductions.payAdvance(projectId, {
      vendorId, amount: '100', reason: 'mobilisation', method: 'neft',
    }, pmc(projectId));

    const forged = `it-6c-negative-${seq++}`;
    await expect(t.prisma.$executeRawUnsafe(
      `INSERT INTO "VendorAdvance"("id","projectId","vendorId","amount","reason","method","paidById","sourceCommandId")
       VALUES ($1,$2,$3,-10.00,'a negative advance','neft',$4,$5)`,
      forged, projectId, vendorId, f.memberUser.id,
      await mintCommand(projectId, 'commercial.advance.pay', f.memberUser.id, forged),
    )).rejects.toThrow(/VendorAdvance_amount_positive/u);

    const blank = `it-6c-blank-${seq++}`;
    await expect(t.prisma.$executeRawUnsafe(
      `INSERT INTO "VendorAdvance"("id","projectId","vendorId","amount","reason","method","paidById","sourceCommandId")
       VALUES ($1,$2,$3,10.00,'   ','neft',$4,$5)`,
      blank, projectId, vendorId, f.memberUser.id,
      await mintCommand(projectId, 'commercial.advance.pay', f.memberUser.id, blank),
    )).rejects.toThrow(/VendorAdvance_reason_nonblank/u);

    // append-only: cash that left is evidence, and recovering it is a deduction, never an edit here
    await expect(t.prisma.$executeRawUnsafe(
      `UPDATE "VendorAdvance" SET "amount" = 1000.00 WHERE "id" = $1`, advance.id,
    )).rejects.toThrow(/append-only/u);
    await expect(t.prisma.$executeRawUnsafe(
      `DELETE FROM "VendorAdvance" WHERE "id" = $1`, advance.id,
    )).rejects.toThrow(/append-only/u);

    // provenance — the fourth arm of `phase5_t6a_command_succeeded` is really installed
    const wrongType = `it-6c-wrongtype-${seq++}`;
    await expect(t.prisma.$executeRawUnsafe(
      `INSERT INTO "VendorAdvance"("id","projectId","vendorId","amount","reason","method","paidById","sourceCommandId")
       VALUES ($1,$2,$3,10.00,'wrong receipt','neft',$4,$5)`,
      wrongType, projectId, vendorId, f.memberUser.id,
      await mintCommand(projectId, 'commercial.payment.record', f.memberUser.id, wrongType),
    )).rejects.toThrow(/records the command that PRODUCED it/u);

    // …and a raw OVER-recovery is refused by the database, with every earlier seal satisfied
    await deductions.record(projectId, { billId, type: 'advance-recovery', amount: '100' }, pmc(projectId));
    const cert = await t.prisma.billCertificate.findFirstOrThrow({
      where: { projectId, billId, supersededAt: null }, select: { id: true },
    });
    const overRecovery = `it-6c-over-${seq++}`;
    await expect(t.prisma.$executeRawUnsafe(
      `INSERT INTO "BillDeduction"("id","projectId","certificateId","billId","type","amount","recordedById","sourceCommandId")
       VALUES ($1,$2,$3,$4,'advance-recovery',10.00,$5,$6)`,
      overRecovery, projectId, cert.id, billId, f.memberUser.id,
      await mintCommand(projectId, 'commercial.deduction.record', f.memberUser.id, overRecovery),
    )).rejects.toThrow(/there is no more of it to take/u);
  });

  it('PROBE 28 (§H): a SUPERSEDED certificate’s recovery still counts — supersession never refunds cash', async () => {
    // The one scoping decision in this fold that could plausibly have gone the other way, so it is
    // probed rather than asserted in a comment. A superseded certificate's deductions leave
    // `NET_PAYABLE` (§H) — but the advance they recovered did not come back. Scoping the recovered
    // side to LIVE certificates would free the balance for a second recovery of the same money.
    const projectId = await freshProject();
    const { billId, vendorId } = await certifiedClaimFor(projectId);
    await deductions.payAdvance(projectId, {
      vendorId, amount: '100', reason: 'mobilisation', method: 'neft',
    }, pmc(projectId));
    await deductions.record(projectId, { billId, type: 'advance-recovery', amount: '100' }, pmc(projectId));
    expect((await advancePositionOf(projectId, billId)).recoverable).toBe('0.00');

    // supersede: `NET_PAYABLE` is restated onto the replacement (§H re-statement), and the advance
    // position must NOT reopen
    await certification.supersede(projectId, { billId, reason: 'corrected' }, pmc(projectId));
    await certification.certify(projectId, { billId }, pmc(projectId));
    const position = await advancePositionOf(projectId, billId);
    expect(position.advanced).toBe('100.00');
    expect(position.recovered, 'the recovered balance survives the correction — the cash did not come back').toBe('100.00');
    expect(position.recoverable).toBe('0.00');
  });

  it('PROBE 29 (§D): authority and replay on the advance', async () => {
    const projectId = await freshProject();
    const { billId, vendorId } = await certifiedClaimFor(projectId);

    const engineer = { sub: f.memberUser.id, role: 'engineer', projectId } as AuthUser;
    await expect(deductions.payAdvance(projectId, {
      vendorId, amount: '100', reason: 'not mine to commit', method: 'neft',
    }, engineer)).rejects.toThrow(/pmc surface/u);

    const key = `it-6c-replay-${seq++}`;
    const first = await deductions.payAdvance(projectId, {
      vendorId, amount: '100', reason: 'mobilisation', method: 'neft',
    }, pmc(projectId), key);
    const again = await deductions.payAdvance(projectId, {
      vendorId, amount: '100', reason: 'mobilisation', method: 'neft',
    }, pmc(projectId), key);
    expect(again.id).toBe(first.id);
    expect(await t.prisma.vendorAdvance.count({ where: { projectId, vendorId } })).toBe(1);
    // the fold saw ONE advance, not two — a replay that appended would silently double the ceiling
    expect((await advancePositionOf(projectId, billId)).advanced).toBe('100.00');
  });

  // ══════════════════════════════════════════════════════════════════════════════════════════════
  // Task 7A — the §J cash forecast: SIX exposure buckets that partition, and a budget that does not
  // ══════════════════════════════════════════════════════════════════════════════════════════════

  /** every §J bucket for one cost head, as the read reports them. */
  const bucketsOf = async (projectId: string, code = 'CIVIL') => {
    const p = await positionOf(projectId, code);
    return {
      budget: p.budget, committed: p.committed, receivedNotBilled: p.receivedNotBilled,
      awaitingCertification: p.awaitingCertification, certifiedPayable: p.certifiedPayable,
      approved: p.approved, paid: p.paid, exposure: p.exposure, headroom: p.headroom,
    };
  };
  /** the SIX exposure buckets, summed exactly — `budget` is NOT one of them (§J). */
  const sumSix = (b: Awaited<ReturnType<typeof bucketsOf>>): string =>
    [b.committed, b.receivedNotBilled, b.awaitingCertification, b.certifiedPayable, b.approved, b.paid]
      .reduce((t, v) => t.add(new Prisma.Decimal(v)), new Prisma.Decimal(0))
      .toFixed(2);

  it('PROBE 31 (§J): PAYING moves money BETWEEN buckets and never moves the total', async () => {
    // THE IDENTITY `commercial.contract.test.ts` CITES BY NAME.
    //
    // `FOLD_INPUTS` classifies `PAID` as partition-only — exempt from §B's raise-or-clear pin —
    // because §J defines `approved` as `APPROVED − PAID` and `paid` as `PAID`, so the two sum to
    // `APPROVED` for every value of `PAID`. That is an identity, not a judgement, and an identity
    // asserted in a comment is the shape this module keeps finding defects in. So it is exercised.
    //
    // If it were false, `payments.record` would be a headroom mover with no evaluator, and a
    // practice would watch its budget breach or heal every time it settled an invoice it had
    // already authorised.
    const projectId = await freshProject();
    await budget.setBudget(projectId, { costHeadCode: 'CIVIL', amount: '1000', reason: 'pilot budget' }, pmc(projectId));
    const billId = await certifiedClaim(projectId);
    const approval = await payments.approve(projectId, { billId, amount: '100' }, approver(projectId));

    const beforePay = await bucketsOf(projectId);
    expect(beforePay.approved, 'authorised and not yet gone').toBe('100.00');
    expect(beforePay.paid).toBe('0.00');

    await payments.record(projectId, { approvalId: approval.id, amount: '40', method: 'neft' }, pmc(projectId));
    const afterPay = await bucketsOf(projectId);

    // the buckets MOVED …
    expect(afterPay.approved, '`APPROVED − PAID`').toBe('60.00');
    expect(afterPay.paid, 'the only raw fold').toBe('40.00');
    // …and the total did NOT. This is the identity.
    expect(afterPay.exposure, 'paying settled WHO HOLDS the exposure, not how much there is').toBe(beforePay.exposure);
    expect(afterPay.headroom).toBe(beforePay.headroom);
    // …and never ₹140 across the two, which is the §J failure a raw `APPROVED` bucket would cause
    expect(new Prisma.Decimal(afterPay.approved).add(new Prisma.Decimal(afterPay.paid)).toFixed(2)).toBe('100.00');

    // a REVERSAL runs the same identity backwards — it is the other writer the partition-only row
    // names, so leaving it unprobed would exempt half the classification
    const payment = (await payments.ledger(projectId, billId, pmc(projectId))).approvals[0]!.payments[0]!;
    await payments.reverse(projectId, { paymentId: payment.id, amount: '40', reason: 'wrong account' }, pmc(projectId));
    const afterReverse = await bucketsOf(projectId);
    expect(afterReverse.approved).toBe('100.00');
    expect(afterReverse.paid, '§0 — `PAID` is Σ payments MINUS Σ reversals').toBe('0.00');
    expect(afterReverse.exposure, 'recovering cash moves no headroom either').toBe(beforePay.exposure);
  });

  it('PROBE 32 (§J): the SIX exposure buckets partition, and `budget` is authority — the plan’s 5o/5bm', async () => {
    // §J's central claim, and the one an earlier spelling of probe 5o got wrong in two ways at
    // once: it summed SEVEN buckets and stated an inequality where the invariant is an equality.
    // `budget` is the CEILING the six are measured against, never a seventh addend.
    const projectId = await freshProject();
    await budget.setBudget(projectId, { costHeadCode: 'CIVIL', amount: '100', reason: 'pilot budget' }, pmc(projectId));

    // a ₹100 order fully accepted and unbilled: the money is in `received-not-billed` and NOWHERE
    // else — `committed` is OUTSTANDING, so a fully-accepted order has nothing outstanding
    const line = await issuedMaterialLine(projectId, { qty: '100' });
    await acceptOnLine(projectId, line, '100');
    const accepted = await bucketsOf(projectId);
    expect(accepted.committed, 'a fully accepted order is no longer an outstanding obligation').toBe('0.00');
    expect(accepted.receivedNotBilled).toBe('100.00');
    expect(sumSix(accepted), 'the six sum to exactly the exposure').toBe(accepted.exposure);
    expect(accepted.exposure).toBe('100.00');
    expect(accepted.headroom, 'ceiling ₹100 less ₹100 of exposure').toBe('0.00');

    // …and the partition holds as the money walks the chain. Each step moves it ONE bucket along
    // and leaves the total alone — that is what "residual" means.
    const billId = await verifiedClaim(projectId, line.vendorId, [{ poLineId: line.poLineId, quantity: '100' }]);
    const billed = await bucketsOf(projectId);
    expect(billed.receivedNotBilled, 'the claim moved it out').toBe('0.00');
    expect(billed.awaitingCertification).toBe('100.00');
    expect(sumSix(billed)).toBe(billed.exposure);
    expect(billed.exposure, 'claiming changed WHERE the exposure sits, not how much').toBe('100.00');

    await certification.certify(projectId, { billId }, pmc(projectId));
    const certified = await bucketsOf(projectId);
    expect(certified.awaitingCertification).toBe('0.00');
    expect(certified.certifiedPayable).toBe('100.00');
    expect(sumSix(certified)).toBe(certified.exposure);
    expect(certified.exposure).toBe('100.00');

    await payments.approve(projectId, { billId, amount: '100' }, approver(projectId));
    const approved = await bucketsOf(projectId);
    expect(approved.certifiedPayable, '§J — `NET_PAYABLE − APPROVED`').toBe('0.00');
    expect(approved.approved).toBe('100.00');
    expect(sumSix(approved)).toBe(approved.exposure);
    expect(approved.exposure).toBe('100.00');
    expect(approved.headroom, 'and the headroom never moved through any of it').toBe('0.00');
  });

  it('PROBE 33 (§J): headroom goes NEGATIVE on over-commitment — it is a signal, not an error', async () => {
    // 5bm's second half. RED against `BUDGET − COMMITTED`, which reports ₹100 of headroom for a
    // fully-accepted order because `COMMITTED` is already zero — the exact reading that would tell
    // a practice it has money it has already spent.
    const projectId = await freshProject();
    await budget.setBudget(projectId, { costHeadCode: 'CIVIL', amount: '100', reason: 'pilot budget' }, pmc(projectId));
    const line = await issuedMaterialLine(projectId, { qty: '150' });
    await acceptOnLine(projectId, line, '150');

    const over = await bucketsOf(projectId);
    expect(over.committed, 'fully accepted — nothing outstanding').toBe('0.00');
    expect(over.receivedNotBilled).toBe('150.00');
    expect(over.exposure).toBe('150.00');
    expect(over.headroom, 'the over-commitment signal §B fires on, not an error to clamp away').toBe('-50.00');
    expect(sumSix(over)).toBe(over.exposure);
  });

  it('PROBE 34 (§J): the partition survives tax and freight — the plan’s 5t', async () => {
    // §J is explicit that the two sides of `received-not-billed` must be the same KIND of money.
    // `BILLED_AMOUNT` includes claimed tax and freight, so pricing the received side at
    // quantity × rate makes a fully-accepted line with tax and freight report a NEGATIVE bucket
    // once billed, and leaves real exposure outside headroom before billing even though
    // `COMMITTED` is already zero. This asserts the fold reads landed money on both sides.
    const projectId = await freshProject();
    await budget.setBudget(projectId, { costHeadCode: 'CIVIL', amount: '10000', reason: 'pilot budget' }, pmc(projectId));
    const line = await issuedMaterialLine(projectId, { qty: '100' });
    await acceptOnLine(projectId, line, '100');

    const b = await bucketsOf(projectId);
    expect(b.committed, '5t — a fully accepted line leaves ₹0 outstanding, never the tax and freight remainder').toBe('0.00');
    expect(sumSix(b), 'and the six still partition').toBe(b.exposure);
  });

  // ══════════════════════════════════════════════════════════════════════════════════════════════
  // Task 7A — the EIGHTH rebuildable projection (§J/§G): live == projection == rebuild
  // ══════════════════════════════════════════════════════════════════════════════════════════════
  //
  // The standing projection contract, plus ONE probe this projection needs and the seven before it
  // did not: it has TWO refresh paths (an ordered consumer for foreign events, write-through for
  // commercial's own writes, because `commercial.producesEvents` is `[]`), so "the two paths agree"
  // is a real question rather than a tautology. It is only true because both call
  // `computeCashForecastDto` — which is exactly the kind of claim that is true when written and
  // quietly false two units later.

  const drainRelay = async (): Promise<void> => { for (let i = 0; i < 8; i++) await relay.runOnce(); };
  const liveForecast = (projectId: string) => t.prisma.$transaction((tx) => computeCashForecastDto(tx, projectId));
  const storedForecast = async (projectId: string) => {
    const gen = await readServableGeneration(t.prisma, CASH_FORECAST_PROJECTION, projectId);
    if (!gen) return null;
    const row = await t.prisma.cashForecastProjection.findUnique({
      where: { generationId_projectId: { generationId: gen.id, projectId } }, select: { dto: true },
    });
    return row?.dto ?? null;
  };
  /** The active generation's stored row REGARDLESS of servability — so a write-through refresh can
   *  be observed on a generation the relay has not caught up on. */
  const storedRowAnyGen = async (projectId: string) => {
    const gen = await t.prisma.projectionGeneration.findFirst({
      where: { consumer: CASH_FORECAST_PROJECTION, projectId, status: 'active' }, select: { id: true },
    });
    if (!gen) return null;
    const row = await t.prisma.cashForecastProjection.findUnique({
      where: { generationId_projectId: { generationId: gen.id, projectId } }, select: { dto: true },
    });
    return (row?.dto ?? null) as unknown as CashForecastDto | null;
  };
  const rebuildForecast = () => ops.run({ operatorIdentity: 'op', reason: 'test rebuild', consumers: [CASH_FORECAST_PROJECTION] });

  it('PROBE 35 (§J/§G): live == projection == rebuild, and a rebuild emits ZERO events + ZERO notifications', async () => {
    const projectId = await freshProject();
    await budget.setBudget(projectId, { costHeadCode: 'CIVIL', amount: '1000', reason: 'pilot budget' }, pmc(projectId));
    const billId = await certifiedClaim(projectId);
    const approval = await payments.approve(projectId, { billId, amount: '100' }, approver(projectId));
    await payments.record(projectId, { approvalId: approval.id, amount: '40', method: 'neft' }, pmc(projectId));
    await drainRelay();

    const live = await liveForecast(projectId);
    expect(live.totals.paid, 'the fixture actually moved money — otherwise this compares two zeroes').toBe('40.00');
    expect(await storedForecast(projectId)).toEqual(live);

    const eventsBefore = await t.prisma.domainEvent.count({ where: { projectId } });
    const notifsBefore = await t.prisma.notification.count({ where: { projectId } });
    const report = await rebuildForecast();
    expect(report.ok).toBe(true);
    expect(report.corruptAfter).toBe(0);
    expect(report.failures).toBe(0);
    // recompute-only (§G): a rebuild replay derives NO canonical event and NO notification
    expect(await t.prisma.domainEvent.count({ where: { projectId } })).toBe(eventsBefore);
    expect(await t.prisma.notification.count({ where: { projectId } })).toBe(notifsBefore);
    expect(await storedForecast(projectId)).toEqual(live);
  });

  it('PROBE 36 (§J): the WRITE-THROUGH path and the CONSUMER path agree — the two-seam risk', async () => {
    // This projection is the only one whose own module emits no events, so commercial's writes
    // refresh in-transaction while foreign facts refresh through the ordered consumer. Two paths
    // is a real hazard: it is exactly how a projection acquires two opinions. The reason it is
    // safe is that NEITHER computes anything — both call `computeCashForecastDto`.
    const projectId = await freshProject();
    await budget.setBudget(projectId, { costHeadCode: 'CIVIL', amount: '1000', reason: 'pilot budget' }, pmc(projectId));
    // The FOREIGN half establishes the generation: issuing and accepting a PO emits canonical
    // events, so the ordered consumer runs and the project acquires an active generation. (A
    // project with no events never gets one, and the read correctly falls back to live — probe 38.)
    const line = await issuedMaterialLine(projectId, { qty: '100' });
    await acceptOnLine(projectId, line, '100');
    await drainRelay();
    expect((await storedRowAnyGen(projectId))!.totals.receivedNotBilled, 'the consumer path stored the accepted value').toBe('100.00');

    // Now COMMERCIAL-only writes, with the relay deliberately NOT drained afterwards. Nothing is
    // emitted for it to drain — that is the whole point — so if the write-through seam were
    // missing the stored row would still hold the pre-certification picture.
    const billId = await verifiedClaim(projectId, line.vendorId, [{ poLineId: line.poLineId, quantity: '100' }]);
    await certification.certify(projectId, { billId }, pmc(projectId));
    const beforeApproval = await storedRowAnyGen(projectId);
    expect(beforeApproval!.totals.certifiedPayable, 'certification is a commercial write with no event — write-through is the ONLY thing that could have stored this').toBe('100.00');
    expect(beforeApproval!.totals.receivedNotBilled, 'and the claim moved the money OUT of the received bucket').toBe('0.00');

    await payments.approve(projectId, { billId, amount: '100' }, approver(projectId));
    const afterApproval = await storedRowAnyGen(projectId);
    expect(afterApproval!.totals.certifiedPayable, '§J — `NET_PAYABLE − APPROVED`').toBe('0.00');
    expect(afterApproval!.totals.approved).toBe('100.00');
    // …and it equals what the LIVE compute says, with no relay involvement at all
    expect(afterApproval).toEqual(await liveForecast(projectId));

    // now the CONSUMER path, on the same project: draining changes nothing, because the two paths
    // store the same answer. A consumer that recomputed differently would show up here.
    await drainRelay();
    expect(await storedRowAnyGen(projectId)).toEqual(afterApproval);
  });

  it('PROBE 37 (§J): defining or RENAMING a cost head refreshes the forecast — the second seam', async () => {
    // The one write that changes what the forecast SAYS while moving no money at all, so §B's
    // evaluation would never fire for it. CLOSURE C pins that this seam exists; this proves it
    // works. RED without the `refreshCashForecast` call in `defineCostHead`.
    const projectId = await freshProject();
    await budget.setBudget(projectId, { costHeadCode: 'CIVIL', amount: '1000', reason: 'pilot budget' }, pmc(projectId));
    await issuedMaterialLine(projectId, { qty: '100' }); // emits events, so a generation exists
    await drainRelay();
    expect((await storedRowAnyGen(projectId))!.heads.map((h) => h.costHeadCode)).toEqual(['CIVIL', 'MEP']);

    await commercial.defineCostHead(projectId, { code: 'FINISHES', name: 'Finishing works' }, pmc(projectId));
    const added = await storedRowAnyGen(projectId);
    expect(added!.heads.map((h) => h.costHeadCode), 'a new head APPEARS as an all-zero row').toEqual(['CIVIL', 'FINISHES', 'MEP']);
    expect(added!.heads.find((h) => h.costHeadCode === 'FINISHES')!.exposure).toBe('0.00');

    await commercial.defineCostHead(projectId, { code: 'FINISHES', name: 'Finishes & fit-out' }, pmc(projectId));
    const renamed = await storedRowAnyGen(projectId);
    expect(renamed!.heads.find((h) => h.costHeadCode === 'FINISHES')!.costHeadName).toBe('Finishes & fit-out');
    expect(renamed, 'and the whole picture still equals the live compute').toEqual(await liveForecast(projectId));
  });

  it('PROBE 38 (§J): the read falls back to LIVE rather than serving a stale or absent generation', async () => {
    // The standing read discipline. A lagging generation is never served as authoritative — the
    // caller gets the canonical compute instead, through the SAME function, so a fallback is a
    // fresher answer and never a different one.
    const projectId = await freshProject();
    await budget.setBudget(projectId, { costHeadCode: 'CIVIL', amount: '1000', reason: 'pilot budget' }, pmc(projectId));

    // Real money on the project, and the relay deliberately NOT drained: the events exist but no
    // generation does yet, because the relay is what establishes one. So the read MUST compute live
    // rather than report an absent projection as an empty money picture.
    await issuedMaterialLine(projectId, { qty: '100' });
    const cold = await budget.readCashForecast(projectId, pmc(projectId));
    expect(cold.refreshedAt, 'a live answer is honestly dated null, never stamped `now`').toBeNull();
    expect(cold.totals.budget).toBe('1000.00');
    expect(cold.totals.committed, 'and it is REAL money, not an empty page that would match anything').toBe('100.00');

    await drainRelay();
    const warm = await budget.readCashForecast(projectId, pmc(projectId));
    expect(warm.refreshedAt, 'once a servable generation holds a row, the read says how old it is').not.toBeNull();
    const { refreshedAt: _a, ...warmBody } = warm;
    const { refreshedAt: _b, ...coldBody } = cold;
    expect(warmBody, 'projection and live are the same money — one is merely dated').toEqual(coldBody);

    // …and §D: the read is capability-gated like every other commercial surface.
    await expect(budget.readCashForecast(f.projectB.id, pmc(f.projectB.id))).rejects.toMatchObject({ status: 404 });
  });
});
