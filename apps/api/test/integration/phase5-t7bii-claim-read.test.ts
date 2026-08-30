import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { BILL_CERTIFY_FROM, BILL_STATUSES_PAST_CERTIFICATION } from '@vitan/shared';
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
import { sanctionedReset } from '../../prisma/sanctioned-reset';

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

  const RESET_TABLES = ['VendorAdvance', 'PaymentReversal', 'Payment', 'PaymentApproval',
    'BillDeductionRelease', 'BillDeduction', 'SodException', 'SodGrant',
    'CertifiedMeasurementConsumption', 'CertifiedAcceptanceConsumption', 'BillCertificate',
    'BillVerification', 'VendorBillLine', 'VendorBillVersion', 'VendorBillRevision',
    'VendorBill', 'DomainEvent', 'OutboxDelivery', 'ProcessedEvent', 'ProjectionCursor',
    'ProjectionGeneration', 'DecisionProjection', 'DailyLogProjection', 'DrawingsProjection',
    'InspectionsProjection', 'ActivitiesProjection', 'MaterialReadinessProjection',
    'CashForecastProjection', 'LabourReadinessProjection', 'Measurement', 'BudgetException',
    'BudgetLine', 'CommitmentAttribution', 'CostHead', 'LabourMismatchResolution',
    'LabourMismatch', 'ActivityWorkOutput', 'LabourWorkFact', 'WorkerAllocation',
    'LabourAttendance', 'ApprovedSkillSubstitution', 'CapacityPromise', 'CapacityCommitment',
    'LabourPurchaseOrderLine', 'LabourPurchaseOrderVersion', 'LabourPurchaseOrder',
    'LabourQuoteComparison', 'SupplierLabourQuoteLine', 'SupplierLabourQuote', 'LabourRfq',
    'LabourRequisitionLine', 'LabourRequisition', 'VendorLabourProfile', 'StockTransaction',
    'MaterialIssue', 'StockLot', 'DeliveryPromise', 'DeliveryCommitment', 'PurchaseOrderLine',
    'PurchaseOrderVersion', 'PurchaseOrder', 'VendorQuoteLine', 'QuoteComparison', 'VendorQuote',
    'Rfq', 'RequisitionLine', 'Requisition', 'ProjectPartyVendorSource',
    'ProjectPartyCompanySource', 'ProjectParty', 'ProjectVendor', 'CommandExecution',
    'CrewMembership', 'Crew', 'WorkerDevice', 'WorkerSkill', 'Worker', 'ApprovedSubstitution',
    'LabourDemandSlice', 'LabourRequirementSpec', 'LabourTrade', 'LabourSkill',
    'MaterialRequirementSpec', 'ActivityRequirement', 'ActivityRequirementRoot',
    'DecisionApprovalRevision', 'ProjectCapability'
  ] as const;

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
    await sanctionedReset(t?.prisma, RESET_TABLES, { cascade: true });
    await t?.prisma.vendor.deleteMany({ where: { orgId: f.orgA.id } });
    await t?.prisma.membership.deleteMany({ where: { projectId: { startsWith: 'it-p57bii-' } } });
    await t?.prisma.project.deleteMany({ where: { id: { startsWith: 'it-p57bii-' } } });
    await f?.cleanup();
    await t?.close();
  });
  afterEach(async () => {
    await sanctionedReset(t.prisma, RESET_TABLES, { cascade: true });
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


  // ── 7B-iv — the three facts the §M payer surface could not otherwise ask for ─────────────────

  /**
   * F4. The bill LIST must carry the revision an approval pins.
   *
   * A withholding moves `NET_PAYABLE` and advances the claim's revision WITHOUT moving the §F
   * status label. A client comparing its open bundle against the list on `status`/`statusChangedAt`
   * therefore sees two reads that agree while the pin it is about to send is already dead — the
   * server refuses the approval after the write-ahead outbox reported it saved. Comparing the
   * revision itself is the only comparison that answers the question the server asks.
   */
  it('7B-iv-1: a withholding advances the LIST revision without moving the status label', async () => {
    const projectId = await freshProject();
    const billId = await certifiedClaim(projectId);
    const before = (await bills.list(projectId, pmc(projectId))).bills.find((b) => b.id === billId)!;

    await deductions.record(projectId, {
      billId, type: 'retention', amount: '10', reason: 'contractual retention',
    }, pmc(projectId));

    const after = (await bills.list(projectId, pmc(projectId))).bills.find((b) => b.id === billId)!;
    expect(after.status, 'the label is the same, which is exactly the trap').toBe(before.status);
    expect(after.statusChangedAt).toBe(before.statusChangedAt);
    expect(after.lifecycleVersion, 'and the revision is NOT').toBeGreaterThan(before.lifecycleVersion);
    // …and the list agrees with the bundle, so a client may compare the two directly
    const claim = await claims.readClaim(projectId, billId, pmc(projectId));
    expect(after.lifecycleVersion).toBe(claim.certifyPreflight.lifecycleVersion);
  });

  /**
   * F2. §I has TWO rules, and a grant for one is not a grant for the other.
   *
   * `certifyPreflight` resolves `evidence-recorder-may-not-certify`. The payment service consumes
   * only `certifier-may-not-approve`. A client that gated APPROVAL on the certification answer was
   * wrong in both directions, and no field in the contract carried the right one.
   */
  it('7B-iv-2: a CERTIFY authorisation does not show up as permission to APPROVE', async () => {
    const projectId = await freshProject();
    const approver = await secondPmc(projectId);
    const billId = await verifiedOnly(projectId);
    await grantTo(projectId, billId, f.memberUser.id, approver);

    const claim = await claims.readClaim(projectId, billId, pmc(projectId));
    expect(claim.certifyPreflight.grantState, 'the certification rule IS authorised').toBe('live');
    expect(claim.approvePreflight.grantState,
      'and the payment rule is a different question with a different answer').toBe('none');
    expect(claim.approvePreflight.grantId).toBeNull();
  });

  /**
   * …and the pairing §I actually forbids is reported, because the session carries a role and a
   * name but never an actor id — so the client cannot tell the certifier from anyone else.
   */
  it('7B-iv-3: the caller who certified this claim is told that they did', async () => {
    const projectId = await freshProject();
    const billId = await certifiedClaim(projectId);   // certified BY the pmc caller
    const mine = await claims.readClaim(projectId, billId, pmc(projectId));
    expect(mine.approvePreflight.callerIsCertifier).toBe(true);

    // …and another reader of the same claim is not the certifier
    await secondPmc(projectId);
    const theirs = await claims.readClaim(projectId, billId, asUser(projectId, f.ownerUser.id));
    expect(theirs.approvePreflight.callerIsCertifier).toBe(false);
  });

  /**
   * 7B-v (§I) — the read says WHO this caller may authorise under the payment rule, and the answer
   * is the same predicate the command enforces.
   *
   * This is the field that lets the browser stop modelling the rule. Three parked findings on the
   * client half — the window it may be offered in, whether any amount remains approvable, and who
   * the rule can actually excuse — were three attempts to derive server facts in a form. They are
   * one question here, and a form that offers the rule exactly when this list is non-empty cannot
   * get any of them wrong.
   */
  it('7B-v-1: the payment-rule authorisation names at most the certifier, and only when spendable', async () => {
    const projectId = await freshProject();
    const grantor = await secondPmc(projectId);
    const billId = await certifiedClaim(projectId);   // certified BY `pmc(projectId)`

    // the authorising pmc is offered exactly one name — the person the rule blocks
    const asGrantor = await claims.readClaim(projectId, billId, asUser(projectId, grantor));
    expect(asGrantor.approvePreflight.grantCandidates.map((c) => c.userId)).toEqual([f.memberUser.id]);

    // the CERTIFIER is offered nobody: the only person the rule blocks on this claim is them, and
    // §I forbids authorising yourself. Empty rather than a name the command would refuse.
    const asCertifier = await claims.readClaim(projectId, billId, pmc(projectId));
    expect(asCertifier.approvePreflight.grantCandidates).toEqual([]);

    // BEFORE certification there is no approval to excuse, so there is nobody to name
    const uncertified = await verifiedOnly(projectId);
    expect((await claims.readClaim(projectId, uncertified, asUser(projectId, grantor)))
      .approvePreflight.grantCandidates).toEqual([]);

    // …an authorisation that ALREADY STANDS removes the candidate, because a second could never
    // be the one an approval selects (Codex round 2, P2). Round 1 taught the COMMAND to refuse
    // that and left the READ offering it, so the form enabled an action the server had just
    // started rejecting — the drift a shared predicate exists to prevent, introduced by one of
    // this unit's own corrections. Both now ask `payableGrantOffer`.
    await certification.grantSodException(projectId, {
      billId, actorId: f.memberUser.id, reason: 'stands already', rule: 'certifier-may-not-approve',
    }, asUser(projectId, grantor));
    expect((await claims.readClaim(projectId, billId, asUser(projectId, grantor)))
      .approvePreflight.grantCandidates,
    'an authorisation stands, so there is nobody left to authorise').toEqual([]);
    // …and once it is SPENT the candidate returns, so the read is precise rather than merely strict
    await payments.approve(projectId, { billId, amount: '10.00' }, pmc(projectId));
    expect((await claims.readClaim(projectId, billId, asUser(projectId, grantor)))
      .approvePreflight.grantCandidates.map((c) => c.userId)).toEqual([f.memberUser.id]);

    // …a certifier at or above their APPROVAL CEILING can have no positive amount accepted
    // either, so the read offers nobody (Codex round 1, P1 — the ceiling is one of `approve()`'s
    // money bounds, and the predicate folds it into the same headroom as §G bound 4)
    await t.prisma.membership.update({
      where: { projectId_userId: { projectId, userId: f.memberUser.id } },
      data: { approvalLimit: '0' },
    });
    expect((await claims.readClaim(projectId, billId, asUser(projectId, grantor)))
      .approvePreflight.grantCandidates).toEqual([]);
    await t.prisma.membership.update({
      where: { projectId_userId: { projectId, userId: f.memberUser.id } },
      data: { approvalLimit: null },
    });

    // …and once the whole payable is approved, §G bound 4 admits no positive amount, so an
    // authorisation to approve would be an authority over nothing
    await certification.grantSodException(projectId, {
      billId, actorId: f.memberUser.id, reason: 'only pmc on site', rule: 'certifier-may-not-approve',
    }, asUser(projectId, grantor));
    // 90, not 100: the already-stands step above spent 10 of this claim's payable
    await payments.approve(projectId, { billId, amount: '90.00' }, pmc(projectId));
    expect((await claims.readClaim(projectId, billId, asUser(projectId, grantor)))
      .approvePreflight.grantCandidates).toEqual([]);
  });


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
    expect(claim.certifyPreflight).toMatchObject({ grantState: 'none', grantId: null, callerActorId: f.memberUser.id });
  });

  it('6b: a live authorisation for THIS caller is reported with the id that would be consumed', async () => {
    const projectId = await freshProject();
    const approver = await secondPmc(projectId);
    const billId = await verifiedOnly(projectId);
    const grant = await grantTo(projectId, billId, f.memberUser.id, approver);
    const claim = await claims.readClaim(projectId, billId, pmc(projectId));
    expect(claim.certifyPreflight).toMatchObject({ grantState: 'live', grantId: grant.id, callerActorId: f.memberUser.id });
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
    expect(after.certifyPreflight).toMatchObject({ grantState: 'stale-version', grantId: null, callerActorId: f.memberUser.id });
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
      .toMatchObject({ grantState: 'none', grantId: null, callerActorId: recorder });
    await expect(certification.certify(projectId, { billId }, asUser(projectId, recorder)))
      .rejects.toThrow(/Segregation of duties/u);

    // authorised by the OTHER pmc, the read reports it…
    const grant = await grantTo(projectId, billId, recorder, f.memberUser.id);
    const pre = await claims.readClaim(projectId, billId, asUser(projectId, recorder));
    expect(pre.certifyPreflight).toMatchObject({ grantState: 'live', grantId: grant.id, callerActorId: recorder });

    // …and the command consumes exactly that one
    const cert = await certification.certify(projectId, { billId }, asUser(projectId, recorder));
    expect(cert.sodException?.grantId).toBe(grant.id);
  });


  // ── 7 (7B-iii-f correction) — the Codex findings on head 495718d ─────────────────────────────



  it('F1: the read hands the caller their OWN actor id, and only theirs', async () => {
    const projectId = await freshProject();
    await secondPmc(projectId);
    const billId = await verifiedOnly(projectId);
    expect((await claims.readClaim(projectId, billId, pmc(projectId))).certifyPreflight.callerActorId)
      .toBe(f.memberUser.id);
    expect((await claims.readClaim(projectId, billId, asUser(projectId, f.ownerUser.id))).certifyPreflight.callerActorId)
      .toBe(f.ownerUser.id);
  });



  it('round-2: CERTIFY naming a version the claim moved past is refused, not re-pinned', async () => {
    const projectId = await freshProject();
    const line = await issuedMaterialLine(projectId, { qty: '100' });
    await acceptOnLine(projectId, line, '100');
    const billId = await verifiedClaim(projectId, line.vendorId, line.poLineId, '100');
    const viewed = (await claims.readClaim(projectId, billId, pmc(projectId)))
      .bill.versions.find((v) => v.live)!.id;

    // amended and re-verified while the certifier's command sat in a queue
    await bills.amend(projectId, {
      billId, reason: 'vendor re-issued at 90',
      lines: [{ poLineId: line.poLineId, quantity: '90', rate: '1' }],
    }, pmc(projectId));
    await bills.beginVerification(projectId, { billId }, pmc(projectId));
    await verification.verify(projectId, { billId }, pmc(projectId));

    await expect(certification.certify(projectId, { billId, versionId: viewed }, pmc(projectId)))
      .rejects.toThrow(/amended after you read it/u);

    // the CURRENT version certifies, so the guard is precise rather than merely strict
    const current = (await claims.readClaim(projectId, billId, pmc(projectId)))
      .bill.versions.find((v) => v.live)!.id;
    const cert = await certification.certify(projectId, { billId, versionId: current }, pmc(projectId));
    expect(cert.id).toBeTruthy();
  });

  it('round-2: SUPERSEDE naming a certificate already replaced is refused', async () => {
    const projectId = await freshProject();
    const billId = await certifiedClaim(projectId);
    const first = (await claims.readClaim(projectId, billId, pmc(projectId))).certificate!.id;

    // someone else corrects it first. Superseding returns the claim to `verified` — there is no
    // live certificate until it is certified again — so the replacement c2 only exists after a
    // re-certification, and THAT is the state where a queued correction for c1 would land on c2.
    await certification.supersede(projectId, { billId, reason: 'first correction' }, pmc(projectId));
    // re-certified naming the CURRENT version. The version is load-bearing here beyond the guard
    // it was added for: `certify` synthesizes an idempotency key from the request hash, so a
    // second `{ billId }` alone REPLAYS the first certification and returns the same row.
    const liveVersion = (await claims.readClaim(projectId, billId, pmc(projectId)))
      .bill.versions.find((v) => v.live)!.id;
    const second = await certification.certify(projectId, { billId, versionId: liveVersion }, pmc(projectId));
    expect(second.id).not.toBe(first);

    await expect(certification.supersede(
      projectId, { billId, reason: 'my correction', certificateId: first }, pmc(projectId),
    )).rejects.toThrow(/already superseded/u);

    // …and naming the CURRENT one succeeds, superseding exactly the document it names
    const now = (await claims.readClaim(projectId, billId, pmc(projectId))).certificate!.id;
    expect(now).toBe(second.id);
    const ok = await certification.supersede(
      projectId, { billId, reason: 'my correction', certificateId: now }, pmc(projectId),
    );
    expect(ok.id).toBe(now);
  });








  // ── 7B-iii-h — the §I grant records the STATE it was justified against ───────────────────────

  const grantAt = async (
    projectId: string, billId: string, actorId: string, approverId: string,
    pins: { versionId?: string; status?: string; lifecycleVersion?: number } = {},
  ) => certification.grantSodException(
    projectId, { billId, actorId, reason: 'two-person practice', ...pins }, asUser(projectId, approverId),
  );

  it('h1: a grant RECORDS the reviewed state, and it still holds when the authority is spent', async () => {
    const projectId = await freshProject();
    const recorder = await secondPmc(projectId);
    const line = await issuedMaterialLine(projectId, { qty: '100' });
    await acceptOnLine(projectId, line, '100');            // recorded BY `recorder`
    const billId = await verifiedClaim(projectId, line.vendorId, line.poLineId, '100');

    const grant = await grantAt(projectId, billId, recorder, f.memberUser.id);
    const row = await t.prisma.sodGrant.findFirstOrThrow({ where: { projectId, id: grant.id } });
    expect(row.reviewedStatus, 'the state the approver reviewed is RECORDED, not merely checked').toBe('verified');

    // THE LEGAL PATH (the round-4 lesson): a guard that only ever refuses is indistinguishable
    // from one that never permits, so the ordinary case is asserted first.
    expect((await claims.readClaim(projectId, billId, asUser(projectId, recorder))).certifyPreflight)
      .toMatchObject({ grantState: 'live', grantId: grant.id });
    const cert = await certification.certify(projectId, { billId }, asUser(projectId, recorder));
    expect(cert.sodException?.grantId).toBe(grant.id);
  });

  it('h2: an authorisation given BEFORE the §E verdict cannot be spent after it', async () => {
    const projectId = await freshProject();
    const recorder = await secondPmc(projectId);
    const line = await issuedMaterialLine(projectId, { qty: '100' });
    await acceptOnLine(projectId, line, '100');
    const recorded = await bills.record(projectId, {
      vendorId: line.vendorId, vendorBillNumber: `V-H2-${seq++}`, documentDate: '2026-08-20',
      lines: [{ poLineId: line.poLineId, quantity: '100', rate: '1' }],
    }, pmc(projectId));
    await bills.submit(projectId, { billId: recorded.id }, pmc(projectId));

    // authorised while the claim is SUBMITTED — the verdict does not exist yet. The pins are sent
    // exactly as the client sends them; they are also what makes a later re-authorisation a
    // DIFFERENT command rather than an idempotent replay of this one.
    const submittedVersion = (await claims.readClaim(projectId, recorded.id, pmc(projectId)))
      .bill.versions.find((v) => v.live)!.id;
    const grant = await grantAt(projectId, recorded.id, recorder, f.memberUser.id,
      { versionId: submittedVersion, status: 'submitted' });
    expect((await t.prisma.sodGrant.findFirstOrThrow({ where: { projectId, id: grant.id } })).reviewedStatus)
      .toBe('submitted');

    // the claim verifies — SAME version, different state
    await bills.beginVerification(projectId, { billId: recorded.id }, pmc(projectId));
    await verification.verify(projectId, { billId: recorded.id }, pmc(projectId));
    const versions = (await claims.readClaim(projectId, recorded.id, pmc(projectId))).bill.versions;
    expect(versions.find((v) => v.live)!.id, 'the version must NOT have moved, or this probe is about the wrong thing')
      .toBe(grant.versionId);

    // the authority is not spendable on a verdict its approver never reviewed
    expect((await claims.readClaim(projectId, recorded.id, asUser(projectId, recorder))).certifyPreflight.grantState)
      .toBe('stale-review');
    await expect(certification.certify(projectId, { billId: recorded.id }, asUser(projectId, recorder)))
      .rejects.toThrow(/Segregation of duties/u);

    // …and re-authorising against what is true NOW restores it — the guard is precise, not merely
    // strict. A different reviewed state is a different command, not a replay of the first.
    await grantAt(projectId, recorded.id, recorder, f.memberUser.id,
      { versionId: submittedVersion, status: 'verified' });
    expect((await claims.readClaim(projectId, recorded.id, asUser(projectId, recorder))).certifyPreflight.grantState)
      .toBe('live');
  });

  it('h3: a grant naming someone who cannot CERTIFY is refused at the command', async () => {
    const projectId = await freshProject();
    const approver = await secondPmc(projectId);
    const billId = await verifiedOnly(projectId);
    await t.prisma.membership.upsert({
      where: { projectId_userId: { projectId, userId: f.strangerUser.id } },
      create: { projectId, userId: f.strangerUser.id, role: 'engineer', status: 'active' },
      update: { role: 'engineer', status: 'active' },
    });
    // an engineer holds no certify path, so the authority could never be exercised
    await expect(grantAt(projectId, billId, f.strangerUser.id, approver))
      .rejects.toThrow(/cannot certify on this project/u);
    // the legal path: a certifier is granted normally
    const ok = await grantAt(projectId, billId, f.memberUser.id, approver);
    expect(ok.actorId).toBe(f.memberUser.id);
  });

  it('h4: the pins are REQUIRED at the boundary and optional in-process', async () => {
    const { grantSodExceptionSchema } = await import('../../src/contracts');
    expect(grantSodExceptionSchema.safeParse({ billId: 'b', actorId: 'a', reason: 'r' }).success,
      'an authorisation without the reviewed facts must be refused at the boundary').toBe(false);
    // …and round 3 adds the third pin: the claim REVISION. The version and the status are both
    // re-enterable, so neither says WHICH passage of the claim the approver was looking at.
    expect(grantSodExceptionSchema.safeParse({
      billId: 'b', actorId: 'a', reason: 'r', versionId: 'v', status: 'verified',
    }).success, 'version + status alone no longer identify what was reviewed').toBe(false);
    expect(grantSodExceptionSchema.safeParse({
      billId: 'b', actorId: 'a', reason: 'r', versionId: 'v', status: 'verified', lifecycleVersion: 3,
    }).success).toBe(true);
  });


  it('h5: a legacy grant is RETIRED, attributably, and a well-formed live one is untouched', async () => {
    const projectId = await freshProject();
    const approver = await secondPmc(projectId);
    const billId = await verifiedOnly(projectId);

    // Round 4 changed the instrument, and the probe changes with it. The migration used to ABORT on
    // a legacy unconsumed grant. Codex round 4: once the guards above are installed such a row can
    // be neither filled, consumed nor deleted, so the abort's own remedy ("re-issue and redeploy")
    // never clears it and the migration is not rerunnable at all. A fact this release cannot judge
    // is RETIRED with a reason — retained, marked, and named in the runbook.
    const retirement = readFileSync(
      join(__dirname, '../../prisma/migrations/20270705000000_phase5_t7biiih_sod_reviewed_status/migration.sql'),
      'utf8',
    ).match(/UPDATE "SodGrant"\n\s+SET "retiredAt"[\s\S]*?reviewedLifecycleVersion" IS NULL\);/u)?.[0];
    expect(retirement, 'the migration must still carry its legacy retirement').toBeDefined();

    // a well-formed live authorisation is NOT touched — the retirement names legacy rows only
    const live = await grantAt(projectId, billId, f.memberUser.id, approver);
    await t.prisma.$executeRawUnsafe(retirement!);
    const untouched = await t.prisma.sodGrant.findFirstOrThrow({ where: { projectId, id: live.id } });
    expect(untouched.retiredAt, 'a grant carrying its reviewed evidence is not legacy').toBeNull();

    // …and a row that predates the columns IS retired, with a reason a human can act on. Reaching
    // that state needs the append-only bypass, which is the point: this release cannot create one.
    await t.prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('ALTER TABLE "SodGrant" DISABLE TRIGGER "SodGrant_append_only"');
      await tx.$executeRawUnsafe(
        'UPDATE "SodGrant" SET "reviewedStatus"=NULL, "reviewedLifecycleVersion"=NULL WHERE "projectId"=$1 AND "id"=$2',
        projectId, live.id,
      );
      await tx.$executeRawUnsafe('SET CONSTRAINTS ALL IMMEDIATE');
      await tx.$executeRawUnsafe('ALTER TABLE "SodGrant" ENABLE TRIGGER "SodGrant_append_only"');
    });
    await t.prisma.$executeRawUnsafe(retirement!);
    const retired = await t.prisma.sodGrant.findFirstOrThrow({ where: { projectId, id: live.id } });
    expect(retired.retiredAt, 'a grant with no reviewed evidence is retired').not.toBeNull();
    expect(retired.retiredReason).toMatch(/predates the reviewed-state record/u);

    // RERUNNABLE, which is the finding: a second pass finds nothing left to retire and the
    // retired row does not block the replacement a pmc now issues
    await expect(t.prisma.$executeRawUnsafe(retirement!)).resolves.toBeDefined();
    await expect(grantAt(projectId, billId, f.memberUser.id, approver)).resolves.toBeDefined();
  });

  it('h11: the guards are installed BEFORE the legacy retirement acts', async () => {
    // Codex round 3 (P1). The abort is deliberate and it is not a rollback: this file is written
    // for retry, so on the legacy path the new columns stay committed while the widened index and
    // the replacement append-only trigger — both BELOW the abort — never run.
    //
    // What that leaves is worse than the hole it guards: an operator "fixing" the legacy grants by
    // hand can populate `reviewedStatus`/`reviewedLifecycleVersion` with values nobody reviewed,
    // rerun, pass the now-quiet diagnostic, and have the trigger installed on the next pass FREEZE
    // the fabrication as immutable evidence. Meanwhile the OLD scope key is still live, so a
    // legitimate replacement from the same approver collides with the row it is replacing.
    //
    // A migration that can stop must install everything that makes stopping SAFE before it stops.
    const sql = readFileSync(
      join(__dirname, '../../prisma/migrations/20270705000000_phase5_t7biiih_sod_reviewed_status/migration.sql'),
      'utf8',
    );
    const abortAt = sql.indexOf('UPDATE "SodGrant"\n   SET "retiredAt"');
    expect(abortAt, 'the legacy retirement must still be in this migration').toBeGreaterThan(-1);
    for (const guard of [
      'CREATE UNIQUE INDEX "SodGrant_live_scope_key"',
      'CREATE OR REPLACE FUNCTION phase5_t5_grant_append_only()',
      'CREATE TRIGGER "VendorBill_lifecycle_version"',
    ]) {
      const at = sql.indexOf(guard);
      expect(at, `${guard} must be in this migration`).toBeGreaterThan(-1);
      expect(at, `${guard} must be installed BEFORE legacy authority is retired`).toBeLessThan(abortAt);
    }
  });

  it('h12: the approver pins the lifecycle they REVIEWED, and a queued grant cannot adopt a newer one', async () => {
    // Codex round 3 (P1). The command compared the caller's version and status pins and then wrote
    // the DATABASE'S CURRENT lifecycle version onto the grant — recording, as the thing the
    // approver reviewed, a number the approver never saw. A pin the server fills in for you is not
    // a pin; it is the server agreeing with itself.
    const { grantSodExceptionSchema } = await import('../../src/contracts');
    expect(
      grantSodExceptionSchema.safeParse({ billId: 'b', actorId: 'a', reason: 'r', versionId: 'v', status: 'verified' }).success,
      'the reviewed lifecycle is REQUIRED at the boundary, exactly as the version and status pins are',
    ).toBe(false);

    const projectId = await freshProject();
    const approver = await secondPmc(projectId);
    const billId = await verifiedOnly(projectId);
    const read = await claims.readClaim(projectId, billId, pmc(projectId));
    const viewed = read.certifyPreflight.lifecycleVersion;
    expect(viewed, 'the claim read must publish it, or no client can pin it').toBeGreaterThanOrEqual(0);

    // a stale pin — what a queued authorisation carries after the claim has moved — is refused
    // even though the version and the status still match
    await expect(grantAt(projectId, billId, f.memberUser.id, approver,
      { versionId: read.bill.versions.find((v) => v.live)!.id, status: 'verified', lifecycleVersion: viewed - 1 }))
      .rejects.toThrow(/moved on since you read it/u);

    // …and the pin the reader actually saw is accepted, and is what gets RECORDED
    const ok = await grantAt(projectId, billId, f.memberUser.id, approver,
      { versionId: read.bill.versions.find((v) => v.live)!.id, status: 'verified', lifecycleVersion: viewed });
    expect((await t.prisma.sodGrant.findFirstOrThrow({ where: { projectId, id: ok.id } })).reviewedLifecycleVersion)
      .toBe(viewed);
  });


  it('h13: the authorisation candidates are the STANDING RULE\'s answer, not the roster\'s', async () => {
    // 7B-iii-g round 1, finding 6. The first draft derived the picker in the browser by filtering
    // the team roster on `role === 'pmc' && status === 'active'` — which I had defended as
    // "narrowing, not enumerating authority". It WAS enumerating authority, and wrongly: the
    // server admits an org owner/admin as pmc where they hold NO active membership on the project,
    // so exactly those people were excluded from a form that exists to name them.
    //
    // The list now comes from the module that owns the predicate, and this probe is about the two
    // places a roster filter and the real rule disagree.
    const projectId = await freshProject();
    const billId = await verifiedOnly(projectId);
    const cands = async (): Promise<string[]> =>
      (await claims.readClaim(projectId, billId, pmc(projectId)))
        .certifyPreflight.sodCandidates.map((c) => c.userId);

    // THE ORG ARM: `ownerUser` owns the org and holds no membership on this fresh project. A
    // roster filter cannot see them; the standing rule says yes.
    expect(await cands(), 'an org owner with no membership here still holds pmc standing')
      .toContain(f.ownerUser.id);
    // …and never the caller: §I forbids a self-grant, so offering it would queue the one command
    // the server is certain to refuse
    expect(await cands(), 'a self-grant is not a candidate').not.toContain(f.memberUser.id);

    // PRECEDENCE: an ACTIVE membership decides, and is never silently upgraded through the org.
    // Give the same org owner a non-certifying role here and they must drop out — this is the
    // clause `hasProjectRoleStanding` states, mirrored rather than re-invented.
    await t.prisma.membership.upsert({
      where: { projectId_userId: { projectId, userId: f.ownerUser.id } },
      create: { projectId, userId: f.ownerUser.id, role: 'engineer', status: 'active' },
      update: { role: 'engineer', status: 'active' },
    });
    expect(await cands(), 'an active membership decides, so an org owner working here as an engineer is an engineer')
      .not.toContain(f.ownerUser.id);

    // …and the same person promoted on THIS project is a candidate again, by the membership arm
    await t.prisma.membership.update({
      where: { projectId_userId: { projectId, userId: f.ownerUser.id } },
      data: { role: 'pmc', status: 'active' },
    });
    expect(await cands()).toContain(f.ownerUser.id);
  });

  it('h9: the column addition is RERUNNABLE, so the diagnostic abort does not poison the retry', async () => {
    // The closing `DO` block aborts the deploy on a legacy unconsumed grant — AFTER `ADD COLUMN`
    // has already succeeded. The operator clears the grants and redeploys, and the retry replays
    // the whole file: without `IF NOT EXISTS` that second run dies on duplicate-column, and the
    // remedy the diagnostic instructs is unreachable.
    const sql = readFileSync(
      join(__dirname, '../../prisma/migrations/20270705000000_phase5_t7biiih_sod_reviewed_status/migration.sql'),
      'utf8',
    );
    const add = sql.split('\n').find((l) => l.startsWith('ALTER TABLE "SodGrant" ADD COLUMN'));
    expect(add, 'the migration must still be the thing that adds the column').toBeDefined();
    // this database is migrated, so re-running the statement IS the retry
    await expect(t.prisma.$executeRawUnsafe(add!)).resolves.toBeDefined();
  });

});
