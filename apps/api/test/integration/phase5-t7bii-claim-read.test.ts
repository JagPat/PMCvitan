import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { createTestApp, type TestApp } from './test-app';
import { createTwoProjectFixture, type TwoProjectFixture } from './fixtures';
import { RequirementsService } from '../../src/activities/requirements.service';
import { ProcurementService } from '../../src/procurement/procurement.service';
import { PurchaseOrdersService } from '../../src/procurement/purchase-orders.service';
import { VendorsService } from '../../src/procurement/vendors.service';
import { InventoryService } from '../../src/inventory/inventory.service';
import { CommercialActivationService } from '../../src/commercial/commercial-activation.service';
import { CommercialBillService } from '../../src/commercial/commercial-bill.service';
import { CommercialVerificationService } from '../../src/commercial/commercial-verification.service';
import { CommercialCertificationService } from '../../src/commercial/commercial-certification.service';
import { CommercialDeductionService } from '../../src/commercial/commercial-deduction.service';
import { CommercialPaymentService } from '../../src/commercial/commercial-payment.service';
import { CommercialClaimQuery } from '../../src/commercial/commercial-claim.query';
import { CapabilitiesService, MATERIALS_CAPABILITY } from '../../src/platform/capabilities.service';
import type { AuthUser } from '../../src/common/auth';
import type { CreateRequirementInput } from '../../src/contracts';

/**
 * Phase 5 Task 7B-ii (§M) — THE CLAIM LIFECYCLE READ, proven live against PostgreSQL.
 *
 * The §M claim page shows six things about one claim. Read separately they can contradict each
 * other, and not hypothetically: `payments.approvable` is DERIVED from `deductions.netPayable`, so
 * a withholding committing between those two requests puts a net payable and an approvable on one
 * screen that were never true together. Each of those reads already opens a repeatable-read
 * snapshot for exactly this reason at its own level; this is that rule one layer up.
 *
 *   1  COMPOSITION — the bundle agrees, field for field, with the six narrow reads it replaces.
 *      Nothing is re-derived here, so nothing can drift; this is the probe that would catch it.
 *   2  ONE INSTANT — a withholding committed BETWEEN two narrow reads makes them disagree
 *      (`netPayable` vs the `approvable` derived from it). The same interleaving against the
 *      bundle cannot: it answers from one snapshot. RED before 7B-ii — there was no bundle.
 *   3  `certificate: null`, not 404 — an uncertified claim is an ordinary state of this page.
 *   4  MEASUREMENTS are the labour lines' registers, keyed by line; a material-only claim carries
 *      an empty map rather than a set of empty registers.
 *   5  §D gating — 404 off-pilot, 403 for a role without `commercial.read`, 404 for a claim in
 *      another project.
 */
describe('Phase 5 Task 7B-ii — the §M claim lifecycle read (live PG)', () => {
  let t: TestApp;
  let f: TwoProjectFixture;
  let requirements: RequirementsService;
  let procurement: ProcurementService;
  let pos: PurchaseOrdersService;
  let vendors: VendorsService;
  let inventory: InventoryService;
  let activation: CommercialActivationService;
  let bills: CommercialBillService;
  let verification: CommercialVerificationService;
  let certification: CommercialCertificationService;
  let deductions: CommercialDeductionService;
  let payments: CommercialPaymentService;
  let claims: CommercialClaimQuery;
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
    activation = t.app.get(CommercialActivationService);
    bills = t.app.get(CommercialBillService);
    verification = t.app.get(CommercialVerificationService);
    certification = t.app.get(CommercialCertificationService);
    deductions = t.app.get(CommercialDeductionService);
    payments = t.app.get(CommercialPaymentService);
    claims = t.app.get(CommercialClaimQuery);
    capabilities = t.app.get(CapabilitiesService);
  });
  afterAll(async () => {
    await t?.prisma.$executeRawUnsafe(TRUNCATE);
    await t?.prisma.vendor.deleteMany({ where: { orgId: f.orgA.id } });
    await t?.prisma.membership.deleteMany({ where: { projectId: { startsWith: 'it-p57bii-' } } });
    await t?.prisma.project.deleteMany({ where: { id: { startsWith: 'it-p57bii-' } } });
    await f?.cleanup();
    await t?.close();
  });
  afterEach(async () => {
    await t.prisma.$executeRawUnsafe(TRUNCATE);
    await t.prisma.vendor.deleteMany({ where: { orgId: f.orgA.id } });
    for (const [model, where] of [
      ['auditLog', { projectId: { startsWith: 'it-p57bii-' } }],
      ['media', { projectId: { startsWith: 'it-p57bii-' } }],
      ['activity', { projectId: { startsWith: 'it-p57bii-' } }],
      ['membership', { projectId: { startsWith: 'it-p57bii-' } }],
      ['project', { id: { startsWith: 'it-p57bii-' } }],
    ] as const) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (t.prisma as any)[model].deleteMany({ where });
    }
  });

  // ── fixtures (the cleared 6A chain — this unit adds no write path) ───────────────────────────

  const freshProject = async (): Promise<string> => {
    const id = `it-p57bii-${Date.now() % 1e6}-${seq++}`;
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

  const secondPmc = async (projectId: string): Promise<string> => {
    await t.prisma.membership.upsert({
      where: { projectId_userId: { projectId, userId: f.ownerUser.id } },
      create: { projectId, userId: f.ownerUser.id, role: 'pmc', status: 'active' },
      update: { role: 'pmc', status: 'active' },
    });
    return f.ownerUser.id;
  };
  const store = async (projectId: string): Promise<AuthUser> => asUser(projectId, await secondPmc(projectId));

  const freshActivity = async (projectId: string): Promise<string> => {
    const id = `IT-P57BII-ACT-${Date.now() % 1e6}-${seq++}`;
    await t.prisma.activity.create({ data: { id, projectId, name: `Act ${seq}`, zone: 'Zone 1', plannedStart: 0, plannedEnd: 10 } });
    return id;
  };
  const freshMedia = async (projectId: string): Promise<string> => {
    const row = await t.prisma.media.create({ data: { projectId, kind: 'material', mime: 'image/jpeg', uploadedBy: f.memberUser.id, sizeBytes: 3 } });
    return row.id;
  };

  const issuedMaterialLine = async (
    projectId: string, opts: { qty?: string } = {},
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
      lines: [{ requisitionLineId: lineId, baseRate: '1', taxAmount: '0', freightAmount: '0', landedCost: '999.99', quotedMake: 'make', matchesSpecification: true }],
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

  const verifiedClaim = async (
    projectId: string, vendorId: string, poLineId: string, quantity: string,
  ): Promise<string> => {
    const recorded = await bills.record(projectId, {
      vendorId, vendorBillNumber: `V-${seq++}`, documentDate: '2026-08-20',
      lines: [{ poLineId, quantity, rate: '1' }],
    }, pmc(projectId));
    await bills.submit(projectId, { billId: recorded.id }, pmc(projectId));
    await bills.beginVerification(projectId, { billId: recorded.id }, pmc(projectId));
    const verdict = await verification.verify(projectId, { billId: recorded.id }, pmc(projectId));
    expect(verdict.verdict, 'the fixture must reach `verified`, or the probe is about the wrong thing').toBe('matched');
    return recorded.id;
  };

  /** a VERIFIED but uncertified ₹100 claim */
  const verifiedOnly = async (projectId: string, qty = '100'): Promise<string> => {
    const line = await issuedMaterialLine(projectId, { qty });
    await acceptOnLine(projectId, line, qty);
    return verifiedClaim(projectId, line.vendorId, line.poLineId, qty);
  };
  /** a CERTIFIED ₹100 claim on CIVIL */
  const certifiedClaim = async (projectId: string, qty = '100'): Promise<string> => {
    const billId = await verifiedOnly(projectId, qty);
    await certification.certify(projectId, { billId }, pmc(projectId));
    return billId;
  };

  // ── 1 — composition: the bundle IS the six narrow reads ──────────────────────────────────────

  it('1: the bundle agrees field-for-field with the six reads it replaces', async () => {
    const projectId = await freshProject();
    const billId = await certifiedClaim(projectId);
    await deductions.record(projectId, {
      billId, type: 'retention', amount: '10', reason: 'contractual retention',
    }, pmc(projectId));

    const claim = await claims.readClaim(projectId, billId, pmc(projectId));

    // Read separately AFTER the bundle, with nothing writing in between — so any difference is
    // drift in what the bundle derives, not a race. Nothing here is re-implemented: the bundle
    // calls the same `...In(tx, …)` helpers these routes call, and this probe is what would fail
    // if someone gave it its own copy of a fold.
    expect(claim.bill).toEqual(await bills.readOne(projectId, billId, pmc(projectId)));
    expect(claim.verification).toEqual(await verification.readVerification(projectId, billId, pmc(projectId)));
    expect(claim.certificate).toEqual(await certification.readCertificate(projectId, billId, pmc(projectId)));
    expect(claim.deductions).toEqual(await deductions.readLedger(projectId, billId, pmc(projectId)));
    expect(claim.payments).toEqual(await payments.ledger(projectId, billId, pmc(projectId)));
  });

  // ── 2 — one instant: the defect the bundle exists to remove ──────────────────────────────────

  it('2: a withholding between two narrow reads makes them disagree; the bundle cannot', async () => {
    const projectId = await freshProject();
    const billId = await certifiedClaim(projectId);

    // SEPARATE READS, with a withholding committed between them — the interleaving a user hits
    // when someone else is working the same claim. `approvable` is derived from `netPayable`, so
    // reading them at two instants puts two numbers on one page that were never true together.
    const beforeLedger = await deductions.readLedger(projectId, billId, pmc(projectId));
    await deductions.record(projectId, {
      billId, type: 'retention', amount: '10', reason: 'contractual retention',
    }, pmc(projectId));
    const afterPayments = await payments.ledger(projectId, billId, pmc(projectId));

    expect(beforeLedger.netPayable, 'fixture: the claim starts fully payable').toBe('100.00');
    expect(
      afterPayments.approvable,
      'the two reads straddled the withholding and agreed anyway — then this probe is not reproducing the defect',
    ).toBe('90.00');
    // …and that is the contradiction: a page built from these two shows net payable 100.00 beside
    // approvable 90.00. Both were true once. Neither pair is true now.

    // THE BUNDLE, over the same claim in the same state: one snapshot, so the two agree.
    const claim = await claims.readClaim(projectId, billId, pmc(projectId));
    expect(claim.deductions.netPayable).toBe('90.00');
    expect(claim.payments.approvable).toBe('90.00');
    expect(
      claim.payments.approvable,
      'approvable is derived from netPayable — in one snapshot they cannot disagree',
    ).toBe(claim.deductions.netPayable);
  });

  it('2b: the bundle stays internally consistent with a withholding racing it', async () => {
    const projectId = await freshProject();
    const billId = await certifiedClaim(projectId);

    // HONEST LABEL: this does not deterministically force the interleaving — the write may land
    // before the bundle's snapshot opens or after it closes, and both are legitimate outcomes. Its
    // value is one-sided and that is enough: a CORRECT implementation passes on every interleaving,
    // and an implementation that reads the two ledgers in separate transactions can only fail here.
    // Probe 2 above is the deterministic half; this one covers the ordering probe 2 cannot stage.
    const reading = claims.readClaim(projectId, billId, pmc(projectId));
    await deductions.record(projectId, {
      billId, type: 'retention', amount: '10', reason: 'contractual retention',
    }, pmc(projectId));
    const claim = await reading;

    // The property is INTERNAL CONSISTENCY, not a particular number: a page saying 100/100 and a
    // page saying 90/90 are both defensible readings of a claim someone is working on. 100/90 is
    // the defect, and it is the only outcome this rules out.
    expect(claim.payments.approvable).toBe(claim.deductions.netPayable);
    expect(['100.00', '90.00']).toContain(claim.deductions.netPayable);
  });

  // ── 3 — an uncertified claim is an ordinary state of this page ────────────────────────────────

  it('3: certificate is null before certification, where the narrow read 404s', async () => {
    const projectId = await freshProject();
    const billId = await verifiedOnly(projectId);

    await expect(
      certification.readCertificate(projectId, billId, pmc(projectId)),
      'the narrow route still 404s — a missing resource for a caller asking only for the certificate',
    ).rejects.toThrow();

    const claim = await claims.readClaim(projectId, billId, pmc(projectId));
    expect(claim.certificate, 'the lifecycle page must render a claim that is not yet certified').toBeNull();
    expect(claim.bill.id).toBe(billId);
    expect(claim.deductions.certificateId).toBeNull();
    expect(claim.payments.approvable, 'nothing is approvable before a certificate exists').toBeNull();
  });

  // ── 4 — measurements belong to labour lines only ─────────────────────────────────────────────

  it('4: a material-only claim carries an EMPTY measurement map, not empty registers', async () => {
    const projectId = await freshProject();
    const billId = await certifiedClaim(projectId);
    const claim = await claims.readClaim(projectId, billId, pmc(projectId));
    expect(
      claim.measurements,
      'a material line\'s evidence is accepted stock; an empty register would read as "measured nothing"',
    ).toEqual({});
    expect(claim.bill.versions.find((v) => v.live)!.lines.every((l) => l.type === 'material')).toBe(true);
  });

  it('4b: measurements come from the LIVE version, so a non-live claim reports none', async () => {
    const projectId = await freshProject();
    const billId = await verifiedOnly(projectId);
    // reject the claim: no version is live any more, so nothing it lists is in a fold
    await bills.reject(projectId, { billId, reason: 'withdrawn by the vendor' }, pmc(projectId));

    const claim = await claims.readClaim(projectId, billId, pmc(projectId));
    expect(claim.bill.versions.some((v) => v.live), 'fixture: a rejected claim has no live version').toBe(false);
    expect(
      claim.measurements,
      'a non-live version\'s registers are not "what this claim measures" — `live` exists because '
      + 'liveness is not derivable from version position, which `versions.at(-1)` assumed',
    ).toEqual({});
    // …and the history is still carried, so the rejection remains investigable.
    expect(claim.bill.versions.length).toBeGreaterThan(0);
  });

  // ── 5 — §D gating and tenancy ────────────────────────────────────────────────────────────────

  it('5: 404 off-pilot, 403 without commercial.read, 404 across projects', async () => {
    const projectId = await freshProject();
    const billId = await certifiedClaim(projectId);

    const contractor = { sub: f.memberUser.id, role: 'contractor', projectId } as AuthUser;
    await expect(
      claims.readClaim(projectId, billId, contractor),
      'the commercial register is a pmc/engineer surface',
    ).rejects.toMatchObject({ status: 403 });

    // another project in the SAME org, commercial ON — the claim must not be reachable from it
    const other = await freshProject();
    await expect(
      claims.readClaim(other, billId, pmc(other)),
      'a claim is project-contained; reading it from a sibling project must not resolve',
    ).rejects.toMatchObject({ status: 404 });

    // and a project without the capability behaves as if the feature does not exist
    const offPilot = `it-p57bii-off-${seq++}`;
    await t.prisma.project.create({
      data: { id: offPilot, orgId: f.orgA.id, name: offPilot, short: 'P', descriptor: '', stage: 'x', siteCode: 'P', projStart: 'a', projEnd: 'b', elapsedPct: 0, todayDay: 0, milestonePct: 0, timeZone: 'Asia/Kolkata', scheduleStartDate: new Date('2026-06-01T00:00:00.000Z') },
    });
    await t.prisma.membership.create({ data: { projectId: offPilot, userId: f.memberUser.id, role: 'pmc', status: 'active' } });
    await expect(
      claims.readClaim(offPilot, billId, pmc(offPilot)),
      '§D — an unenabled project must 404, not 403: the feature does not exist there',
    ).rejects.toMatchObject({ status: 404 });
  });

  // ── 6 (7B-iii-f) — the §I CERTIFY PREFLIGHT ──────────────────────────────────────────────────

  /**
   * The preflight exists because two of §I's outcomes are otherwise INVISIBLE. A certifier who has
   * just been authorised cannot tell whether the authorisation is live and version-matched, and
   * "granted against an earlier version, because the claim was amended since" is discoverable only
   * by being refused — after the write-ahead outbox has already reported the certification saved.
   *
   * What these probes must establish is not just that the field is populated, but that it is the
   * SAME rule the command enforces. That is what PROBE 6e is for: the resolver is shared, so a
   * divergence is unrepresentable rather than merely untested.
   */
  const grantTo = async (projectId: string, billId: string, actorId: string, approverId: string) =>
    certification.grantSodException(
      projectId, { billId, actorId, reason: 'two-person practice' }, asUser(projectId, approverId),
    );

  it('6a: no authorisation names this caller — `none`, and no id invented', async () => {
    const projectId = await freshProject();
    const billId = await verifiedOnly(projectId);
    const claim = await claims.readClaim(projectId, billId, pmc(projectId));
    expect(claim.certifyPreflight).toEqual({ grantState: 'none', grantId: null, callerActorId: f.memberUser.id });
  });

  it('6b: a live authorisation for THIS caller is reported with the id that would be consumed', async () => {
    const projectId = await freshProject();
    const approver = await secondPmc(projectId);
    const billId = await verifiedOnly(projectId);
    const grant = await grantTo(projectId, billId, f.memberUser.id, approver);
    const claim = await claims.readClaim(projectId, billId, pmc(projectId));
    expect(claim.certifyPreflight).toEqual({ grantState: 'live', grantId: grant.id, callerActorId: f.memberUser.id });
  });

  it('6c: it is the CALLER\'s state — an authorisation naming someone else is not theirs', async () => {
    const projectId = await freshProject();
    await secondPmc(projectId);   // give the owner pmc standing so they can be named
    const billId = await verifiedOnly(projectId);
    // granted to the OWNER by the MEMBER — an approver may never excuse themselves, so the two
    // identities have to be distinct for the grant to exist at all
    await grantTo(projectId, billId, f.ownerUser.id, f.memberUser.id);
    const asMember = await claims.readClaim(projectId, billId, pmc(projectId));
    expect(asMember.certifyPreflight.grantState).toBe('none');
    // …and the owner, reading the same claim, sees theirs
    const asOwner = await claims.readClaim(projectId, billId, asUser(projectId, f.ownerUser.id));
    expect(asOwner.certifyPreflight.grantState).toBe('live');
  });

  it('6d: an amendment strands the authorisation, and the read SAYS so rather than staying silent', async () => {
    const projectId = await freshProject();
    const approver = await secondPmc(projectId);
    const line = await issuedMaterialLine(projectId, { qty: '100' });
    await acceptOnLine(projectId, line, '100');
    const billId = await verifiedClaim(projectId, line.vendorId, line.poLineId, '100');
    await grantTo(projectId, billId, f.memberUser.id, approver);
    expect((await claims.readClaim(projectId, billId, pmc(projectId))).certifyPreflight.grantState).toBe('live');

    // the claim is amended: a NEW live version the approver never saw
    await bills.amend(projectId, {
      billId, reason: 'vendor re-issued the invoice at 90',
      lines: [{ poLineId: line.poLineId, quantity: '90', rate: '1' }],
    }, pmc(projectId));

    const after = await claims.readClaim(projectId, billId, pmc(projectId));
    expect(after.certifyPreflight).toEqual({ grantState: 'stale-version', grantId: null, callerActorId: f.memberUser.id });
  });

  /**
   * The agreement probe. The certifier here IS the evidence actor (the store user who recorded the
   * acceptance), so §I genuinely refuses without an authorisation — and the preflight named the
   * exact grant the command then consumed.
   */
  it('6e: the preflight names the grant the COMMAND consumes — one rule, not two', async () => {
    const projectId = await freshProject();
    const recorder = await secondPmc(projectId);            // the store user who accepts below
    const line = await issuedMaterialLine(projectId, { qty: '100' });
    await acceptOnLine(projectId, line, '100');             // recorded BY `recorder`
    const billId = await verifiedClaim(projectId, line.vendorId, line.poLineId, '100');

    // without an authorisation the recorder is refused, and their own read says `none`
    expect((await claims.readClaim(projectId, billId, asUser(projectId, recorder))).certifyPreflight)
      .toEqual({ grantState: 'none', grantId: null, callerActorId: recorder });
    await expect(certification.certify(projectId, { billId }, asUser(projectId, recorder)))
      .rejects.toThrow(/Segregation of duties/u);

    // authorised by the OTHER pmc, the read reports it…
    const grant = await grantTo(projectId, billId, recorder, f.memberUser.id);
    const pre = await claims.readClaim(projectId, billId, asUser(projectId, recorder));
    expect(pre.certifyPreflight).toEqual({ grantState: 'live', grantId: grant.id, callerActorId: recorder });

    // …and the command consumes exactly that one
    const cert = await certification.certify(projectId, { billId }, asUser(projectId, recorder));
    expect(cert.sodException?.grantId).toBe(grant.id);
  });


  // ── 7 (7B-iii-f correction) — the Codex findings on head 495718d ─────────────────────────────

  it('F3: the bundle carries the claim\'s LIVE grants, whoever they name', async () => {
    const projectId = await freshProject();
    await secondPmc(projectId);
    const billId = await verifiedOnly(projectId);
    // the MEMBER authorises the OWNER; the member then reloads the claim as themselves
    const grant = await grantTo(projectId, billId, f.ownerUser.id, f.memberUser.id);

    const asApprover = await claims.readClaim(projectId, billId, pmc(projectId));
    // their own preflight says nothing — the grant is not theirs — which is exactly why the
    // register below has to exist: without it this read cleared the pending key while showing no
    // trace of the act, and re-armed the form for a duplicate authorisation
    expect(asApprover.certifyPreflight.grantState).toBe('none');
    expect(asApprover.sodGrants).toEqual([
      expect.objectContaining({ id: grant.id, actorId: f.ownerUser.id, approverId: f.memberUser.id }),
    ]);
  });

  it('F3: a CONSUMED grant leaves the live register', async () => {
    const projectId = await freshProject();
    const recorder = await secondPmc(projectId);
    const line = await issuedMaterialLine(projectId, { qty: '100' });
    await acceptOnLine(projectId, line, '100');
    const billId = await verifiedClaim(projectId, line.vendorId, line.poLineId, '100');
    await grantTo(projectId, billId, recorder, f.memberUser.id);
    expect((await claims.readClaim(projectId, billId, pmc(projectId))).sodGrants).toHaveLength(1);

    await certification.certify(projectId, { billId }, asUser(projectId, recorder));
    // certification consumed it, so it is no longer an authorisation anyone holds
    expect((await claims.readClaim(projectId, billId, pmc(projectId))).sodGrants).toEqual([]);
  });

  it('F1: the read hands the caller their OWN actor id, and only theirs', async () => {
    const projectId = await freshProject();
    await secondPmc(projectId);
    const billId = await verifiedOnly(projectId);
    expect((await claims.readClaim(projectId, billId, pmc(projectId))).certifyPreflight.callerActorId)
      .toBe(f.memberUser.id);
    expect((await claims.readClaim(projectId, billId, asUser(projectId, f.ownerUser.id))).certifyPreflight.callerActorId)
      .toBe(f.ownerUser.id);
  });

  it('F4: a grant naming a version the claim has moved past is REFUSED, not re-pinned', async () => {
    const projectId = await freshProject();
    await secondPmc(projectId);
    const line = await issuedMaterialLine(projectId, { qty: '100' });
    await acceptOnLine(projectId, line, '100');
    const billId = await verifiedClaim(projectId, line.vendorId, line.poLineId, '100');
    const read = await claims.readClaim(projectId, billId, pmc(projectId));
    const viewed = read.bill.versions.find((v) => v.live)!.id;

    // the claim is amended AFTER the approver read it — the interleaving a queued command creates
    await bills.amend(projectId, {
      billId, reason: 'vendor re-issued at 90',
      lines: [{ poLineId: line.poLineId, quantity: '90', rate: '1' }],
    }, pmc(projectId));

    await expect(certification.grantSodException(
      projectId, { billId, actorId: f.ownerUser.id, reason: 'two-person practice', versionId: viewed },
      pmc(projectId),
    )).rejects.toThrow(/amended after you read it/u);

    // …and the CURRENT version is accepted, so the guard is precise rather than merely strict
    const now = await claims.readClaim(projectId, billId, pmc(projectId));
    const current = now.bill.versions.find((v) => v.live)!.id;
    const ok = await certification.grantSodException(
      projectId, { billId, actorId: f.ownerUser.id, reason: 'two-person practice', versionId: current },
      pmc(projectId),
    );
    expect(ok.versionId).toBe(current);
  });

});
