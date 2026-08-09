import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
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
import { CapabilitiesService, LABOUR_CAPABILITY, MATERIALS_CAPABILITY } from '../../src/platform/capabilities.service';
import type { AuthUser } from '../../src/common/auth';
import type { CostHeadPositionDto } from '@vitan/shared';
import type { CreateRequirementInput } from '../../src/contracts';

/**
 * Phase 5 Task 5B unit C — §J's `certified-payable` bucket, proven live against PostgreSQL.
 *
 * The claim under test is one sentence: **certification settles WHO OWES WHAT, not HOW MUCH.** A
 * certificate does not create exposure; it moves exposure that already existed from
 * `awaiting-certification` into `certified-payable`. So every probe here asserts the MOVE and the
 * TOTAL together — a bucket pair on its own would pass for an implementation that simply added a
 * new bucket and double-counted the money, which is the exact defect §J's residual rule exists to
 * prevent and which two earlier revisions of that section shipped.
 *
 * The second claim is about SOURCE. `certified-payable` is derived from the CERTIFICATE, not from
 * the claim lines of a certified bill. Those agree today, so only PROBE 3 can tell the two
 * implementations apart — and without it the whole file would pass over a fold that never reads a
 * certificate at all.
 */
describe('Phase 5 Task 5B unit C — §J certified-payable (live PG)', () => {
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
  let capabilities: CapabilitiesService;
  let seq = 0;

  const TRUNCATE =
    'TRUNCATE TABLE "VendorAdvance", "PaymentReversal", "Payment", "PaymentApproval", "BillDeductionRelease", "BillDeduction", "SodException", "SodGrant", "CertifiedMeasurementConsumption", "CertifiedAcceptanceConsumption", "BillCertificate", "BillVerification", "VendorBillLine", "VendorBillVersion", "VendorBillRevision", "VendorBill", "DomainEvent", "OutboxDelivery", "ProcessedEvent", "ProjectionCursor", "ProjectionGeneration", "DecisionProjection", "DailyLogProjection", "DrawingsProjection", "InspectionsProjection", "ActivitiesProjection", "MaterialReadinessProjection", "CashForecastProjection", "LabourReadinessProjection", "Measurement", "BudgetException", "BudgetLine", "CommitmentAttribution", "CostHead", "LabourMismatchResolution", "LabourMismatch", "ActivityWorkOutput", "LabourWorkFact", "WorkerAllocation", "LabourAttendance", "ApprovedSkillSubstitution", "CapacityPromise", "CapacityCommitment", "LabourPurchaseOrderLine", "LabourPurchaseOrderVersion", "LabourPurchaseOrder", "LabourQuoteComparison", "SupplierLabourQuoteLine", "SupplierLabourQuote", "LabourRfq", "LabourRequisitionLine", "LabourRequisition", "VendorLabourProfile", "StockTransaction", "MaterialIssue", "StockLot", "DeliveryPromise", "DeliveryCommitment", "PurchaseOrderLine", "PurchaseOrderVersion", "PurchaseOrder", "VendorQuoteLine", "QuoteComparison", "VendorQuote", "Rfq", "RequisitionLine", "Requisition", "ProjectVendor", "CommandExecution", "CrewMembership", "Crew", "WorkerDevice", "WorkerSkill", "Worker", "ApprovedSubstitution", "LabourDemandSlice", "LabourRequirementSpec", "LabourTrade", "LabourSkill", "MaterialRequirementSpec", "ActivityRequirement", "ActivityRequirementRoot", "DecisionApprovalRevision", "ProjectCapability" CASCADE';

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
    capabilities = t.app.get(CapabilitiesService);
  });
  afterAll(async () => {
    await t?.prisma.$executeRawUnsafe(TRUNCATE);
    await t?.prisma.vendor.deleteMany({ where: { orgId: f.orgA.id } });
    await t?.prisma.membership.deleteMany({ where: { projectId: { startsWith: 'it-p5t5c-' } } });
    await t?.prisma.project.deleteMany({ where: { id: { startsWith: 'it-p5t5c-' } } });
    await f?.cleanup();
    await t?.close();
  });
  afterEach(async () => {
    await t.prisma.$executeRawUnsafe(TRUNCATE);
    await t.prisma.vendor.deleteMany({ where: { orgId: f.orgA.id } });
    for (const [model, where] of [
      ['auditLog', { projectId: { startsWith: 'it-p5t5c-' } }],
      ['media', { projectId: { startsWith: 'it-p5t5c-' } }],
      ['activity', { projectId: { startsWith: 'it-p5t5c-' } }],
      ['membership', { projectId: { startsWith: 'it-p5t5c-' } }],
      ['project', { id: { startsWith: 'it-p5t5c-' } }],
    ] as const) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (t.prisma as any)[model].deleteMany({ where });
    }
  });

  // ── fixtures (the cleared units A/B chain, verbatim — unit C adds no write path) ──────────────

  const freshProject = async (): Promise<string> => {
    const id = `it-p5t5c-${Date.now() % 1e6}-${seq++}`;
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
    const id = `IT-P5T5C-ACT-${Date.now() % 1e6}-${seq++}`;
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

  /** One cost head's position off the READ surface — the same DTO the product serves. */
  const positionOf = async (projectId: string, code = 'CIVIL'): Promise<CostHeadPositionDto> => {
    const { positions } = await budget.readBudget(projectId, pmc(projectId));
    return positions.find((p) => p.costHeadCode === code)!;
  };

  /**
   * The SIX exposure buckets that exist at this tree, summed. §J: `budget` is authority and is
   * never an addend — adding it would put the money in two places, which is the mistake probe 5bc
   * is written against.
   */
  const exposureOf = (p: CostHeadPositionDto): string => (
    Number(p.committed) + Number(p.receivedNotBilled) + Number(p.awaitingCertification) + Number(p.certifiedPayable)
  ).toFixed(2);

  // ── the bucket MOVE ──────────────────────────────────────────────────────────────────────────

  it('PROBE 1 (§J): certifying MOVES money between buckets — it does not leave it awaiting certification', async () => {
    const projectId = await freshProject();
    // a real BUDGET, so `headroom` is a number rather than the null an unbudgeted head reports —
    // the partition claim below is about a total, and comparing null to null would assert nothing
    await budget.setBudget(projectId, { costHeadCode: 'CIVIL', amount: '500.00', reason: 'civil plan' }, pmc(projectId));
    const line = await issuedMaterialLine(projectId, { qty: '100' });
    await acceptOnLine(projectId, line, '100');
    const billId = await verifiedClaim(projectId, line.vendorId, [{ poLineId: line.poLineId, quantity: '100' }]);

    const claimed = await positionOf(projectId);
    expect(claimed.awaitingCertification).toBe('100.00');
    expect(claimed.certifiedPayable).toBe('0.00');
    expect(claimed.headroom).toBe('400.00');

    await certification.certify(projectId, { billId }, pmc(projectId));

    // §J's buckets PARTITION: the claim has been certified, so it is payable rather than pending,
    // and the total exposure is unchanged because certification settles WHO OWES WHAT and not HOW
    // MUCH. A surface still reporting ₹100 awaiting certification says the act has not happened
    // after it has.
    const certified = await positionOf(projectId);
    expect(certified.awaitingCertification).toBe('0.00');
    expect(certified.certifiedPayable).toBe('100.00');
    expect(certified.headroom).toBe(claimed.headroom);
    expect(exposureOf(certified)).toBe(exposureOf(claimed));

    // …and superseding it puts the money back where it was, because the bill is `verified` again
    // and the certificate no longer counts in any live fold
    await certification.supersede(projectId, { billId, reason: 'restated' }, pmc(projectId));
    const superseded = await positionOf(projectId);
    expect(superseded.awaitingCertification).toBe('100.00');
    expect(superseded.certifiedPayable).toBe('0.00');
    expect(superseded.headroom).toBe(claimed.headroom);
  });

  it('PROBE 2 (§J): the labour side moves by the same rule, on its own PO-line branch', async () => {
    // the two branches of the fold are separate code, so a material-only file would prove the rule
    // for half the money. Labour is ₹1,000 per person-shift here, so 2 shifts is ₹2,000.
    const projectId = await freshProject();
    await budget.setBudget(projectId, { costHeadCode: 'CIVIL', amount: '5000.00', reason: 'civil plan' }, pmc(projectId));
    const l = await labourMeasurableLine(projectId, 2);
    await measurement.take(projectId, {
      labourPoLineId: l.poLineId, activityId: l.activityId, quantity: '2',
      measuredOn: '2026-08-10', citedOutputId: l.outputId,
    }, await store(projectId));
    const billId = await verifiedClaim(projectId, l.vendorId, [{ poLineId: l.poLineId, quantity: '2', kind: 'labour' }]);

    const claimed = await positionOf(projectId);
    expect(claimed.awaitingCertification).toBe('2000.00');
    expect(claimed.certifiedPayable).toBe('0.00');

    await certification.certify(projectId, { billId }, pmc(projectId));
    const certified = await positionOf(projectId);
    expect(certified.awaitingCertification).toBe('0.00');
    expect(certified.certifiedPayable).toBe('2000.00');
    expect(exposureOf(certified)).toBe(exposureOf(claimed));
  });

  // ── the SOURCE of the number ─────────────────────────────────────────────────────────────────

  it('PROBE 3 (§G/§J): the bucket reads the CERTIFICATE, not the claim lines of a certified bill', async () => {
    // §G bound 3 is `CERTIFIED <= BILLED_AMOUNT` — a BOUND, not an equality. `certify` writes the
    // full amount today, so a fold that summed the certified bill's LINES would agree with every
    // other probe in this file while reading the wrong fact. This is the probe that tells them
    // apart: a PARTIAL certificate is legal at PostgreSQL, so one is written directly and the
    // bucket must report ₹60 — the certifier's number — and not ₹100, the vendor's.
    const projectId = await freshProject();
    await budget.setBudget(projectId, { costHeadCode: 'CIVIL', amount: '500.00', reason: 'civil plan' }, pmc(projectId));
    const line = await issuedMaterialLine(projectId, { qty: '100' });
    await acceptOnLine(projectId, line, '100');
    const billId = await verifiedClaim(projectId, line.vendorId, [{ poLineId: line.poLineId, quantity: '100' }]);
    const cert = await certification.certify(projectId, { billId }, pmc(projectId));
    expect((await positionOf(projectId)).certifiedPayable).toBe('100.00');

    // supersede the full certificate and put a PARTIAL one in its place, carrying the same frozen
    // evidence. Nothing here forges provenance: the amount is the only thing that differs, and
    // ₹60 <= ₹100 satisfies bound 3, so the commit-time seal accepts it.
    // ONE transaction: the bill is `certified` and the status↔certificate correspondence is a
    // DEFERRED constraint, so the swap is only legal if the replacement lands before commit. That
    // the seal refuses the halves separately is itself unit A's rule holding.
    const version = await t.prisma.vendorBillVersion.findFirstOrThrow({ where: { projectId, billId, supersededAt: null } });
    await t.prisma.$transaction([
      t.prisma.$executeRawUnsafe(
        `UPDATE "BillCertificate" SET "supersededAt" = now(), "supersededById" = "certifiedById", "supersedeReason" = 'restated' WHERE "projectId" = $1 AND "id" = $2`,
        projectId, cert.id,
      ),
      t.prisma.$executeRawUnsafe(
        `INSERT INTO "BillCertificate" ("id","projectId","billId","versionId","certifiedAmount","certifiedById","sourceCommandId","reviewedLifecycleVersion")
         SELECT $4, $1, $2, $3, 60, "certifiedById", "sourceCommandId", (SELECT r."revision" FROM "VendorBillRevision" r WHERE r."projectId"="BillCertificate"."projectId" AND r."billId"="BillCertificate"."billId") FROM "BillCertificate" WHERE "projectId" = $1 AND "id" = $5`,
        projectId, billId, version.id, `${cert.id}-partial`, cert.id,
      ),
      // …carrying the SAME frozen evidence, because unit A's seal requires a certificate to rest on
      // exactly the evidence it claims. Only the AMOUNT differs — which is the whole point: the
      // claim and the evidence are unchanged, so anything that reports ₹100 is reading them and
      // not the certificate.
      t.prisma.$executeRawUnsafe(
        `INSERT INTO "CertifiedAcceptanceConsumption" ("id","projectId","certificateId","stockTransactionId","consumedQty")
         SELECT "id" || '-p', $1, $2, "stockTransactionId", "consumedQty"
         FROM "CertifiedAcceptanceConsumption" WHERE "projectId" = $1 AND "certificateId" = $3`,
        projectId, `${cert.id}-partial`, cert.id,
      ),
    ]);

    const partial = await positionOf(projectId);
    expect(partial.certifiedPayable).toBe('60.00');
    // the ₹40 the certifier did NOT allow stays in `awaiting-certification` by §J's residual rule
    // — `BILLED − CERTIFIED`, exactly as `approved` is `APPROVED − PAID`. It is still exposure:
    // the vendor claimed it and the disallowance has not been settled with them.
    expect(partial.awaitingCertification).toBe('40.00');
    expect(exposureOf(partial)).toBe('100.00');
  });

  it('PROBE 4 (§J): a certificate is SHARED across the cost heads its claim spans, never counted whole on each', async () => {
    // the denominator is the WHOLE certified version. Two lines on two heads, ₹100 and ₹300: if a
    // line took the certificate's full amount, each head would report ₹400 payable for a ₹400
    // certificate — ₹800 of money from ₹400 of claim.
    const projectId = await freshProject();
    await budget.setBudget(projectId, { costHeadCode: 'CIVIL', amount: '500.00', reason: 'civil' }, pmc(projectId));
    await budget.setBudget(projectId, { costHeadCode: 'MEP', amount: '500.00', reason: 'mep' }, pmc(projectId));
    const civilLine = await issuedMaterialLine(projectId, { qty: '100', costHeadCode: 'CIVIL' });
    const mepLine = await issuedMaterialLine(projectId, { qty: '300', costHeadCode: 'MEP', vendorId: civilLine.vendorId });
    await acceptOnLine(projectId, civilLine, '100');
    await acceptOnLine(projectId, mepLine, '300');
    // ONE claim spanning both, so ONE certificate covers both heads. The vendor must be the same
    // party for a single claim, so the second line's PO is re-billed by the first line's vendor —
    // §E compares rate and quantity, and both lines are ₹1 a unit.
    const billId = await verifiedClaim(projectId, civilLine.vendorId, [
      { poLineId: civilLine.poLineId, quantity: '100' },
      { poLineId: mepLine.poLineId, quantity: '300' },
    ]);
    await certification.certify(projectId, { billId }, pmc(projectId));

    expect((await positionOf(projectId, 'CIVIL')).certifiedPayable).toBe('100.00');
    expect((await positionOf(projectId, 'MEP')).certifiedPayable).toBe('300.00');
    expect((await positionOf(projectId, 'CIVIL')).awaitingCertification).toBe('0.00');
    expect((await positionOf(projectId, 'MEP')).awaitingCertification).toBe('0.00');
  });

  // ── §B — the mover obligation ────────────────────────────────────────────────────────────────

  it('PROBE 5 (§B): certification evaluates the budget and, being exposure-neutral, opens nothing', async () => {
    // The mover rule is not "call evaluate when you expect a breach" — it is "every write the fold
    // reads from discharges raise-or-clear in its own transaction". Certification writes a term the
    // fold reads, so it evaluates; a FULL certification moves no total, so the honest outcome is
    // that nothing is raised. Both halves are asserted: a silent new exception on certification
    // would be a false over-budget signal, and a missing evaluation would be the gap that bites the
    // day 5C's deductions make the term move.
    const projectId = await freshProject();
    await budget.setBudget(projectId, { costHeadCode: 'CIVIL', amount: '500.00', reason: 'civil plan' }, pmc(projectId));
    const line = await issuedMaterialLine(projectId, { qty: '100' });
    await acceptOnLine(projectId, line, '100');
    const billId = await verifiedClaim(projectId, line.vendorId, [{ poLineId: line.poLineId, quantity: '100' }]);
    const before = await t.prisma.budgetException.count({ where: { projectId } });

    await certification.certify(projectId, { billId }, pmc(projectId));
    expect(await t.prisma.budgetException.count({ where: { projectId } })).toBe(before);
    expect((await positionOf(projectId)).exception).toBeNull();

    // and an ALREADY-open exception is not falsely cleared by an act that recovered no headroom:
    // drop the authority under the claim, then certify a second one on the same head
    await budget.setBudget(projectId, { costHeadCode: 'CIVIL', amount: '10.00', reason: 'cut' }, pmc(projectId));
    const open = await positionOf(projectId);
    expect(open.exception, 'the cut must breach, or the second half of this probe asserts nothing').not.toBeNull();

    const second = await issuedMaterialLine(projectId, { qty: '10' });
    await acceptOnLine(projectId, second, '10');
    const secondBill = await verifiedClaim(projectId, second.vendorId, [{ poLineId: second.poLineId, quantity: '10' }]);
    await certification.certify(projectId, { billId: secondBill }, pmc(projectId));
    expect((await positionOf(projectId)).exception).not.toBeNull();
  });

  // ── the labour fixture (unit B's, verbatim — the chain this task reads, not one it changes) ────

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
});
