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
import { CommercialDeductionService } from '../../src/commercial/commercial-deduction.service';
import { CapabilitiesService, LABOUR_CAPABILITY, MATERIALS_CAPABILITY } from '../../src/platform/capabilities.service';
import type { AuthUser } from '../../src/common/auth';
import type { CostHeadPositionDto } from '@vitan/shared';
import type { CreateRequirementInput } from '../../src/contracts';

/**
 * Phase 5 Task 5C — §H's DEDUCTION LEDGER, proven live against PostgreSQL, reproduce-first.
 *
 * §H's two bounds are the centre of this file, and each is probed as a PAIR — the write that must
 * be REFUSED and the neighbouring one that must still be ALLOWED. A refusal on its own proves only
 * that something is strict; it does not prove it is right, and Task 3's audit closed that once as a
 * rule: a rejection is evidence only when an otherwise-identical case is accepted.
 *
 * The probe that carries the most weight is PROBE 4. Withholding the whole of a certificate leaves
 * nothing payable, which §F's derivation calls `paid` — and reaching it required WIDENING two seals
 * unit A wrote when `certified` was a claim's terminal status. If those widenings are wrong, this
 * probe is where it shows.
 */
describe('Phase 5 Task 5C — §H the deduction ledger (live PG)', () => {
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
  let capabilities: CapabilitiesService;
  let seq = 0;

  const TRUNCATE =
    'TRUNCATE TABLE "BillDeductionRelease", "BillDeduction", "SodException", "SodGrant", "CertifiedMeasurementConsumption", "CertifiedAcceptanceConsumption", "BillCertificate", "BillVerification", "VendorBillLine", "VendorBillVersion", "VendorBill", "DomainEvent", "OutboxDelivery", "ProcessedEvent", "ProjectionCursor", "ProjectionGeneration", "DecisionProjection", "DailyLogProjection", "DrawingsProjection", "InspectionsProjection", "ActivitiesProjection", "MaterialReadinessProjection", "LabourReadinessProjection", "Measurement", "BudgetException", "BudgetLine", "CommitmentAttribution", "CostHead", "LabourMismatchResolution", "LabourMismatch", "ActivityWorkOutput", "LabourWorkFact", "WorkerAllocation", "LabourAttendance", "ApprovedSkillSubstitution", "CapacityPromise", "CapacityCommitment", "LabourPurchaseOrderLine", "LabourPurchaseOrderVersion", "LabourPurchaseOrder", "LabourQuoteComparison", "SupplierLabourQuoteLine", "SupplierLabourQuote", "LabourRfq", "LabourRequisitionLine", "LabourRequisition", "VendorLabourProfile", "StockTransaction", "MaterialIssue", "StockLot", "DeliveryPromise", "DeliveryCommitment", "PurchaseOrderLine", "PurchaseOrderVersion", "PurchaseOrder", "VendorQuoteLine", "QuoteComparison", "VendorQuote", "Rfq", "RequisitionLine", "Requisition", "ProjectVendor", "CommandExecution", "CrewMembership", "Crew", "WorkerDevice", "WorkerSkill", "Worker", "ApprovedSubstitution", "LabourDemandSlice", "LabourRequirementSpec", "LabourTrade", "LabourSkill", "MaterialRequirementSpec", "ActivityRequirement", "ActivityRequirementRoot", "DecisionApprovalRevision", "ProjectCapability" CASCADE';

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

  const statusOf = async (projectId: string, billId: string): Promise<string> =>
    (await t.prisma.vendorBill.findFirstOrThrow({ where: { projectId, id: billId } })).status;

  const positionOf = async (projectId: string, code = 'CIVIL') => {
    const { positions } = await budget.readBudget(projectId, pmc(projectId));
    return positions.find((p) => p.costHeadCode === code)!;
  };

  // ── §H bound 1 — the NET_PAYABLE floor, on the DEDUCTION ─────────────────────────────────────

  it('PROBE 1 (§H): withholding is bounded by the certificate, and the refusal NAMES the balance', async () => {
    const projectId = await freshProject();
    const billId = await certifiedClaim(projectId);

    await deductions.record(projectId, { billId, type: 'retention', amount: '60.00' }, pmc(projectId));

    // the pair: ₹50 more would take ₹110 from a ₹100 certificate, and there is nothing beyond the
    // certificate to withhold FROM — Phase 5 models a deduction as a withholding against a payable,
    // never a receivable
    await expect(deductions.record(projectId, { billId, type: 'penalty', amount: '50.00', reason: 'late' }, pmc(projectId)))
      .rejects.toThrow(/can carry 40\.00 more of withholding/u);
    // …and the neighbouring write that exactly exhausts it is ALLOWED, so the bound is precise
    // rather than merely strict
    await deductions.record(projectId, { billId, type: 'penalty', amount: '40.00', reason: 'late' }, pmc(projectId));

    const ledger = await deductions.readLedger(projectId, billId, pmc(projectId));
    expect(ledger.withheld).toBe('100.00');
    expect(ledger.netPayable).toBe('0.00');
  });

  it('PROBE 2 (§H): the DATABASE holds the floor too — the service is not the only thing between a forger and a negative payable', async () => {
    const projectId = await freshProject();
    const billId = await certifiedClaim(projectId);
    const cert = await t.prisma.billCertificate.findFirstOrThrow({ where: { projectId, billId, supersededAt: null } });
    const command = await t.prisma.commandExecution.findFirstOrThrow({ where: { projectId }, select: { id: true } });

    const insert = (id: string, amount: string) => t.prisma.$executeRawUnsafe(
      `INSERT INTO "BillDeduction" ("id","projectId","certificateId","billId","type","amount","reason","recordedById","sourceCommandId")
       VALUES ($1,$2,$3,$4,'retention',${amount},NULL,$5,$6)`,
      id, projectId, cert.id, billId, f.memberUser.id, command.id,
    );

    // a coherent withholding is ACCEPTED — the seal is precise, not merely strict
    await insert(`${cert.id}-ok`, '30.00');
    // …and one that breaches the floor is REJECTED at COMMIT
    await expect(insert(`${cert.id}-over`, '80.00')).rejects.toThrow(/exceed the .* this certificate certified/u);
    // …as is a non-positive amount: the row TYPE carries direction, so a negative would encode it
    // twice and RAISE the payable above what was certified
    await expect(insert(`${cert.id}-neg`, '-10.00')).rejects.toThrow(/amount_positive/u);
    await expect(insert(`${cert.id}-zero`, '0.00')).rejects.toThrow(/amount_positive/u);
  });

  it('PROBE 3 (§H): a judgement carries a reason, and whitespace is not one', async () => {
    const projectId = await freshProject();
    const billId = await certifiedClaim(projectId);

    // a retention is a CONTRACT TERM and needs no argument
    await deductions.record(projectId, { billId, type: 'retention', amount: '10.00' }, pmc(projectId));
    // a penalty and an `other` are JUDGEMENTS
    await expect(deductions.record(projectId, { billId, type: 'penalty', amount: '10.00' }, pmc(projectId)))
      .rejects.toThrow(/must carry a reason/u);
    // …and presence is not justification — the complete ASCII whitespace set, the Phase-4 Task-5
    // finding after `btrim` alone let whitespace through
    const whitespaceOnly = ' \t\f\r\n ';
    await expect(deductions.record(projectId, { billId, type: 'other', amount: '10.00', reason: whitespaceOnly }, pmc(projectId)))
      .rejects.toThrow(/must carry a reason/u);
    await deductions.record(projectId, { billId, type: 'other', amount: '10.00', reason: 'scaffold hire' }, pmc(projectId));
  });

  // ── §F — the status is DERIVED from the folds, and withholding everything settles the bill ────

  it('PROBE 4 (§F/§H): withholding the WHOLE certificate settles the claim, and releasing part re-opens it', async () => {
    // This is the probe the two seal widenings exist for. §F evaluates `NET_PAYABLE = PAID` FIRST,
    // so a fully-withheld certificate has nothing left to pay. Unit A sealed "a live certificate
    // stands iff the bill is `certified`" while `certified` was terminal; without widening that to
    // the post-certification SET, this transition is refused by the database and no legal row
    // exists that could ever advance the claim — approval and payment rows are strictly positive.
    const projectId = await freshProject();
    const billId = await certifiedClaim(projectId);
    expect(await statusOf(projectId, billId)).toBe('certified');

    const deduction = await deductions.record(projectId, { billId, type: 'retention', amount: '100.00' }, pmc(projectId));
    expect(await statusOf(projectId, billId)).toBe('paid');
    expect((await deductions.readLedger(projectId, billId, pmc(projectId))).netPayable).toBe('0.00');

    // …and a release makes money payable again, so the derivation returns it to `certified` —
    // `APPROVED = 0`, the second arm. It never derives `approved-for-payment` here: that would
    // claim an approval nobody recorded, and a status that overstates authority invites a payment.
    await deductions.release(projectId, { deductionId: deduction.id, amount: '40.00', reason: 'first milestone released' }, pmc(projectId));
    expect(await statusOf(projectId, billId)).toBe('certified');
    const ledger = await deductions.readLedger(projectId, billId, pmc(projectId));
    expect(ledger.withheld).toBe('60.00');
    expect(ledger.netPayable).toBe('40.00');
    expect(ledger.derivedStatus).toBe('certified');
  });

  // ── §H bound 2 — a release is bounded by its OWN deduction ───────────────────────────────────

  it('PROBE 5 (§H): a release cannot give back more than its deduction withheld', async () => {
    const projectId = await freshProject();
    const billId = await certifiedClaim(projectId);
    const a = await deductions.record(projectId, { billId, type: 'retention', amount: '50.00' }, pmc(projectId));
    const b = await deductions.record(projectId, { billId, type: 'penalty', amount: '30.00', reason: 'delay' }, pmc(projectId));

    await deductions.release(projectId, { deductionId: a.id, amount: '20.00', reason: 'part released' }, pmc(projectId));
    // bounded by ITS OWN deduction, not by the ledger total: ₹60 remains withheld overall, but this
    // deduction has only ₹30 left
    await expect(deductions.release(projectId, { deductionId: a.id, amount: '40.00', reason: 'too much' }, pmc(projectId)))
      .rejects.toThrow(/has 30\.00 left to release/u);
    await deductions.release(projectId, { deductionId: a.id, amount: '30.00', reason: 'remainder' }, pmc(projectId));

    const ledger = await deductions.readLedger(projectId, billId, pmc(projectId));
    expect(ledger.withheld).toBe('30.00');
    expect(ledger.deductions.find((d) => d.id === a.id)!.unreleased).toBe('0.00');
    expect(ledger.deductions.find((d) => d.id === b.id)!.unreleased).toBe('30.00');
  });

  // ── append-only ──────────────────────────────────────────────────────────────────────────────

  it('PROBE 6 (§H): both ledger tables are APPEND-ONLY — a withholding that can be edited never withheld anything', async () => {
    const projectId = await freshProject();
    const billId = await certifiedClaim(projectId);
    const d = await deductions.record(projectId, { billId, type: 'retention', amount: '10.00' }, pmc(projectId));
    await deductions.release(projectId, { deductionId: d.id, amount: '4.00', reason: 'part' }, pmc(projectId));

    await expect(t.prisma.$executeRawUnsafe(`UPDATE "BillDeduction" SET "amount"=1 WHERE "id"=$1`, d.id))
      .rejects.toThrow(/APPEND-ONLY/u);
    await expect(t.prisma.$executeRawUnsafe(`DELETE FROM "BillDeduction" WHERE "id"=$1`, d.id))
      .rejects.toThrow(/APPEND-ONLY/u);
    await expect(t.prisma.$executeRawUnsafe(`UPDATE "BillDeductionRelease" SET "amount"=9 WHERE "deductionId"=$1`, d.id))
      .rejects.toThrow(/APPEND-ONLY/u);
    await expect(t.prisma.$executeRawUnsafe(`DELETE FROM "BillDeductionRelease" WHERE "deductionId"=$1`, d.id))
      .rejects.toThrow(/APPEND-ONLY/u);
  });

  // ── §J — the first real subtraction into unit C's term ───────────────────────────────────────

  it('PROBE 7 (§J/§H): a withholding LOWERS certified-payable and RAISES headroom — it is not payable money', async () => {
    const projectId = await freshProject();
    await budget.setBudget(projectId, { costHeadCode: 'CIVIL', amount: '500.00', reason: 'civil plan' }, pmc(projectId));
    const billId = await certifiedClaim(projectId);

    const certified = await positionOf(projectId);
    expect(certified.certifiedPayable).toBe('100.00');
    expect(certified.headroom).toBe('400.00');

    // §J defines `certified-payable` as `NET_PAYABLE − APPROVED`, and unit C shipped it with both
    // subtractions as the identity. This is the first of them arriving for real: withheld money is
    // money that will not be paid, so it leaves the bucket AND leaves the exposure.
    await deductions.record(projectId, { billId, type: 'retention', amount: '30.00' }, pmc(projectId));
    const withheld = await positionOf(projectId);
    expect(withheld.certifiedPayable).toBe('70.00');
    expect(withheld.awaitingCertification).toBe('0.00');
    expect(withheld.headroom).toBe('430.00');

    // …and releasing it puts the money back, in both places
    const ledger = await deductions.readLedger(projectId, billId, pmc(projectId));
    await deductions.release(projectId, { deductionId: ledger.deductions[0]!.id, amount: '30.00', reason: 'released' }, pmc(projectId));
    const released = await positionOf(projectId);
    expect(released.certifiedPayable).toBe('100.00');
    expect(released.headroom).toBe('400.00');
  });

  it('PROBE 8 (§H/§F): superseding a certificate takes its deductions out of every fold with it', async () => {
    const projectId = await freshProject();
    await budget.setBudget(projectId, { costHeadCode: 'CIVIL', amount: '500.00', reason: 'civil plan' }, pmc(projectId));
    const billId = await certifiedClaim(projectId);
    await deductions.record(projectId, { billId, type: 'retention', amount: '30.00' }, pmc(projectId));

    await certification.supersede(projectId, { billId, reason: 'restated' }, pmc(projectId));

    // the rows are still there — they are append-only history — but they stop counting, which is
    // what makes supersession the correction path §F says it is: the corrected certificate starts
    // from a clean ledger rather than inheriting withholdings against an amount nobody certifies
    expect(await t.prisma.billDeduction.count({ where: { projectId, billId } })).toBe(1);
    const ledger = await deductions.readLedger(projectId, billId, pmc(projectId));
    expect(ledger.certificateId).toBeNull();
    expect(ledger.withheld).toBe('0.00');
    expect(ledger.netPayable).toBeNull();

    const position = await positionOf(projectId);
    expect(position.certifiedPayable).toBe('0.00');
    expect(position.awaitingCertification).toBe('100.00');
    expect(position.headroom).toBe('400.00');
  });

  // ── §B — the mover obligation ────────────────────────────────────────────────────────────────

  it('PROBE 9 (§B): a withholding CLEARS an over-budget exception it recovered the headroom for', async () => {
    // unlike certification, which is exposure-neutral, a deduction genuinely LOWERS exposure — so
    // it is a headroom mover in the strong sense and owes raise-or-clear in its own transaction
    const projectId = await freshProject();
    await budget.setBudget(projectId, { costHeadCode: 'CIVIL', amount: '80.00', reason: 'tight' }, pmc(projectId));
    const billId = await certifiedClaim(projectId);
    expect((await positionOf(projectId)).exception, 'the ₹100 claim must breach an ₹80 budget, or this probe asserts nothing').not.toBeNull();

    await deductions.record(projectId, { billId, type: 'penalty', amount: '25.00', reason: 'defects' }, pmc(projectId));
    const recovered = await positionOf(projectId);
    expect(recovered.certifiedPayable).toBe('75.00');
    expect(recovered.headroom).toBe('5.00');
    expect(recovered.exception).toBeNull();
  });

  // ── §C rule ii — a keyed replay appends NOTHING ──────────────────────────────────────────────

  it('PROBE 10 (§C): a keyed replay of either write appends nothing', async () => {
    const projectId = await freshProject();
    const billId = await certifiedClaim(projectId);

    const first = await deductions.record(projectId, { billId, type: 'retention', amount: '20.00' }, pmc(projectId), 'ded-key-1');
    const replay = await deductions.record(projectId, { billId, type: 'retention', amount: '20.00' }, pmc(projectId), 'ded-key-1');
    expect(replay.id).toBe(first.id);
    expect(await t.prisma.billDeduction.count({ where: { projectId, billId } })).toBe(1);

    await deductions.release(projectId, { deductionId: first.id, amount: '5.00', reason: 'part' }, pmc(projectId), 'rel-key-1');
    await deductions.release(projectId, { deductionId: first.id, amount: '5.00', reason: 'part' }, pmc(projectId), 'rel-key-1');
    expect(await t.prisma.billDeductionRelease.count({ where: { projectId, deductionId: first.id } })).toBe(1);
    expect((await deductions.readLedger(projectId, billId, pmc(projectId))).withheld).toBe('15.00');
  });

  it('PROBE 11 (§H): an UNCERTIFIED claim has nothing to withhold from', async () => {
    const projectId = await freshProject();
    const line = await issuedMaterialLine(projectId, { qty: '100' });
    await acceptOnLine(projectId, line, '100');
    const billId = await verifiedClaim(projectId, line.vendorId, [{ poLineId: line.poLineId, quantity: '100' }]);

    await expect(deductions.record(projectId, { billId, type: 'retention', amount: '10.00' }, pmc(projectId)))
      .rejects.toThrow(/no live certification/u);
  });
});
