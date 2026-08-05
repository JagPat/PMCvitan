import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { PrismaClient } from '@prisma/client';
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
    // R5-F3 — each row gets its OWN command, bound to it, because a succeeded receipt now backs
    // exactly one ledger row. Sharing one command across these inserts would make them fail on
    // provenance rather than on the floor this probe is about.
    const insert = async (id: string, amount: string) => t.prisma.$executeRawUnsafe(
      `INSERT INTO "BillDeduction" ("id","projectId","certificateId","billId","type","amount","reason","recordedById","sourceCommandId")
       VALUES ($1,$2,$3,$4,'retention',${amount},NULL,$5,$6)`,
      id, projectId, cert.id, billId, f.memberUser.id,
      await mintCommand(projectId, 'commercial.deduction.record', id),
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

  it('PROBE 4 (§H): withholding the WHOLE certificate leaves nothing payable, and the STATUS deliberately does not move', async () => {
    // §H says the insertion re-derives the §F payment status. It does not do that here, and the
    // packet says so: §F reads three folds and two of them are Task 6's, so the derivation lands
    // beside the rows that supply them. What 5C guarantees is the MONEY — and this probe pins the
    // deliberate half-step so Task 6 changes it knowingly rather than discovering it.
    const projectId = await freshProject();
    const billId = await certifiedClaim(projectId);
    expect(await statusOf(projectId, billId)).toBe('certified');

    const deduction = await deductions.record(projectId, { billId, type: 'retention', amount: '100.00' }, pmc(projectId));
    expect((await deductions.readLedger(projectId, billId, pmc(projectId))).netPayable).toBe('0.00');
    expect(await statusOf(projectId, billId), 'Task 5C moves the money, not the status').toBe('certified');
    expect((await positionOf(projectId)).certifiedPayable).toBe('0.00');

    // …and a release makes money payable again, in the ledger and in §J
    await deductions.release(projectId, { deductionId: deduction.id, amount: '40.00', reason: 'first milestone released' }, pmc(projectId));
    const ledger = await deductions.readLedger(projectId, billId, pmc(projectId));
    expect(ledger.withheld).toBe('60.00');
    expect(ledger.netPayable).toBe('40.00');
    expect(ledger.billStatus).toBe('certified');
    expect((await positionOf(projectId)).certifiedPayable).toBe('40.00');
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

  it('PROBE 8 (§H): a certificate carrying an unreleased withholding is NOT correctable in place — and releasing makes it so', async () => {
    // §H's rule is that a retained balance never vanishes without an attributable release. There
    // are two ways to honour it — CARRY the ledger onto the replacement, or REFUSE the correction
    // until the money is given back — and this task takes the second. The refusal is the STRICTER
    // of the two: every state it permits, re-statement permits too.
    //
    // Both halves are asserted here, because a refusal proved alone is indistinguishable from a
    // rule that simply bans the workflow. The practice's path stays open: release, then correct.
    const projectId = await freshProject();
    await budget.setBudget(projectId, { costHeadCode: 'CIVIL', amount: '500.00', reason: 'civil plan' }, pmc(projectId));
    const billId = await certifiedClaim(projectId);
    const d = await deductions.record(projectId, { billId, type: 'retention', amount: '10.00' }, pmc(projectId));
    await deductions.release(projectId, { deductionId: d.id, amount: '4.00', reason: 'first milestone' }, pmc(projectId));

    // ₹6 still held → the correction is refused, and the refusal NAMES the row and the balance so
    // a PMC is not left hunting for which withholding is in the way
    await expect(certification.supersede(projectId, { billId, reason: 'corrected' }, pmc(projectId)))
      .rejects.toThrow(/still carries 6\.00 of unreleased withholding/u);
    expect((await deductions.readLedger(projectId, billId, pmc(projectId))).netPayable).toBe('94.00');

    // release the remainder attributably — the act §H wanted either way — and the same correction
    // now succeeds, so the refusal is PRECISE rather than merely strict
    await deductions.release(projectId, { deductionId: d.id, amount: '6.00', reason: 'defects period closed' }, pmc(projectId));
    await certification.supersede(projectId, { billId, reason: 'corrected' }, pmc(projectId));

    const between = await deductions.readLedger(projectId, billId, pmc(projectId));
    expect(between.certificateId).toBeNull();
    expect(between.netPayable).toBeNull();

    // the ledger survives as HISTORY on the certificate it was taken against — append-only, so
    // nothing was deleted to make the correction legal
    expect(await t.prisma.billDeduction.count({ where: { projectId, billId } })).toBe(1);
    expect(await t.prisma.billDeductionRelease.count({ where: { projectId, deductionId: d.id } })).toBe(2);

    // re-certifying starts the payable clean: the money was returned, not carried
    await certification.certify(projectId, { billId }, pmc(projectId));
    const after = await deductions.readLedger(projectId, billId, pmc(projectId));
    expect(after.withheld).toBe('0.00');
    expect(after.netPayable).toBe('100.00');
    expect(after.deductions).toHaveLength(0);
    expect(after.billStatus).toBe('certified');
    expect((await positionOf(projectId)).certifiedPayable).toBe('100.00');
  });

  it('PROBE 8b (§H): a FULLY RELEASED withholding does not block the correction — the rule is about money still held', async () => {
    // the boundary of the refusal, stated on its own so it cannot silently widen into "any
    // withholding ever recorded blocks a correction". What §H protects is a retained BALANCE; a
    // deduction that has already been given back in full retains nothing.
    const projectId = await freshProject();
    const billId = await certifiedClaim(projectId);
    const d = await deductions.record(projectId, { billId, type: 'retention', amount: '10.00' }, pmc(projectId));
    await deductions.release(projectId, { deductionId: d.id, amount: '10.00', reason: 'fully returned' }, pmc(projectId));

    await certification.supersede(projectId, { billId, reason: 'corrected' }, pmc(projectId));
    expect(await t.prisma.billCertificate.count({ where: { projectId, billId, supersededAt: { not: null } } })).toBe(1);
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

  it('PROBE 9b (§B): the exception NAMES the act that moved it — a release is not a claim', async () => {
    // Codex P2. `raisedBy` is the durable explanation, and the shared helper hard-coded `claim`.
    const projectId = await freshProject();
    await budget.setBudget(projectId, { costHeadCode: 'CIVIL', amount: '80.00', reason: 'tight' }, pmc(projectId));
    const billId = await certifiedClaim(projectId);
    const d = await deductions.record(projectId, { billId, type: 'retention', amount: '25.00' }, pmc(projectId));
    expect((await positionOf(projectId)).exception).toBeNull();

    await deductions.release(projectId, { deductionId: d.id, amount: '10.00', reason: 'released' }, pmc(projectId));
    const reopened = await positionOf(projectId);
    expect(reopened.exception).not.toBeNull();
    expect(reopened.exception!.raisedBy).toBe('deduction_release');
  });

  // ── the DATABASE seals, against a hostile writer ─────────────────────────────────────────────

  /**
   * A REAL two-transaction barrier: both writers insert, then both are released to commit.
   *
   * Codex round 2 was right that `Promise.allSettled` over two independent transactions proves
   * nothing here — whichever commits first makes its row visible, and the second rejects
   * SEQUENTIALLY, which the lock-free trigger also does. The probe passed against the very defect
   * it claimed to guard. So the writers are held open until both have inserted, and only then
   * allowed to commit: that is the interleaving the certificate lock exists for.
   */
  /**
   * A succeeded command of a GIVEN type, reserved-then-completed the way the receipt protocol
   * requires. Codex round 3 sealed a ledger row's provenance to the command that produced it, so a
   * hostile-insert probe can no longer cite whatever command happens to be lying around: it would
   * be rejected by the provenance trigger instead of the bound it names, and the probe would go on
   * "passing" while proving nothing. That is exactly the shape round 2 found in the upgrade proof.
   */
  const mintCommand = async (projectId: string, commandType: string, resultRef?: string): Promise<string> =>
    t.prisma.$transaction(async (tx) => {
      const c = await tx.commandExecution.create({
        data: {
          scopeKind: 'project', organizationId: f.orgA.id, projectId, actorId: f.memberUser.id,
          commandType, idempotencyKey: `probe-${seq++}`, requestHash: 'x', status: 'reserved',
        },
        select: { id: true },
      });
      await tx.commandExecution.update({
        where: { id: c.id },
        // `resultRef` is not optional: the receipt protocol refuses a succeeded command that
        // recorded no result, because a replay would report success and hand back nothing.
        //
        // R5-F3 — and it now names the ROW the command produced, so a probe minting a command must
        // say which row it is about to insert. Defaulting to the command's own id would make every
        // hostile insert below fail on PROVENANCE rather than on the rule it is aimed at, and the
        // probe would go on "passing" while proving nothing — the exact shape round 2 found in the
        // upgrade proof, arriving from the other direction.
        data: { status: 'succeeded', resultRef: resultRef ?? c.id, completedAt: new Date() },
      });
      return c.id;
    });

  /**
   * Wait until SOME session is actually blocked on a lock while running a statement matching
   * `needle`. Condition-based, never a sleep — and it THROWS if the block never happens, so a probe
   * that stops proving what it claims cannot go on quietly passing.
   */
  const waitUntilBlocked = async (needle: string): Promise<void> => {
    for (let i = 0; i < 400; i += 1) {
      const rows = await t.prisma.$queryRawUnsafe<Array<{ n: bigint }>>(
        `SELECT COUNT(*)::bigint AS n FROM pg_stat_activity
          WHERE cardinality(pg_blocking_pids(pid)) > 0 AND query LIKE $1`,
        `%${needle}%`,
      );
      if (Number(rows[0]!.n) > 0) return;
      await new Promise((r) => { setTimeout(r, 25); });
    }
    throw new Error(`no session ever blocked on a lock while running ${needle} — this probe proves nothing`);
  };

  const bothInsertThenCommit = async (
    insert: (client: PrismaClient) => Promise<unknown>,
  ): Promise<Array<PromiseSettledResult<unknown>>> => {
    const a = new PrismaClient();
    const b = new PrismaClient();
    try {
      let readyA!: () => void; let readyB!: () => void;
      const insertedA = new Promise<void>((r) => { readyA = r; });
      const insertedB = new Promise<void>((r) => { readyB = r; });
      const run = (client: PrismaClient, signal: () => void, other: Promise<void>) =>
        client.$transaction(async (tx) => {
          await insert(tx as unknown as PrismaClient);
          signal();
          // hold the transaction OPEN until the other side has also inserted, so neither deferred
          // commit check can see the other's committed row
          await other;
        }, { timeout: 20_000 });
      return await Promise.allSettled([run(a, readyA, insertedB), run(b, readyB, insertedA)]);
    } finally {
      await a.$disconnect();
      await b.$disconnect();
    }
  };

  it('PROBE 13 (§H): the withholding bound SERIALIZES — the second writer BLOCKS, then is refused', async () => {
    // Round 3 moved the certificate lock EARLIER than this probe originally assumed: the liveness
    // trigger takes `FOR UPDATE` at BEFORE INSERT, so the second writer no longer reaches its own
    // deferred check — it waits on the row. That is stronger than what the probe used to assert,
    // and the honest shape is to prove the wait itself rather than to hold both writers open, which
    // now simply deadlocks against the lock the fix installed.
    const projectId = await freshProject();
    const billId = await certifiedClaim(projectId);
    const cert = await t.prisma.billCertificate.findFirstOrThrow({ where: { projectId, billId, supersededAt: null } });
    // R5-F3 — one command per row, each bound to the row it backs, so the loser below is refused by
    // the BOUND this probe is about rather than by provenance
    const commands: Record<string, string> = {
      [`${cert.id}-0`]: await mintCommand(projectId, 'commercial.deduction.record', `${cert.id}-0`),
      [`${cert.id}-1`]: await mintCommand(projectId, 'commercial.deduction.record', `${cert.id}-1`),
    };

    const a = new PrismaClient();
    const b = new PrismaClient();
    let letACommit!: () => void;
    let aInserted!: () => void;
    const mayCommit = new Promise<void>((r) => { letACommit = r; });
    const hasInserted = new Promise<void>((r) => { aInserted = r; });
    const insert = (client: PrismaClient, id: string) => client.$executeRawUnsafe(
      `INSERT INTO "BillDeduction" ("id","projectId","certificateId","billId","type","amount","recordedById","sourceCommandId")
       VALUES ($1,$2,$3,$4,'retention',60.00,$5,$6)`,
      id, projectId, cert.id, billId, f.memberUser.id, commands[id]!,
    );
    try {
      const first = a.$transaction(async (tx) => {
        await insert(tx as unknown as PrismaClient, `${cert.id}-0`);
        aInserted();
        await mayCommit;
      }, { timeout: 30_000 });
      await hasInserted;

      const second = b.$transaction(async (tx) => insert(tx as unknown as PrismaClient, `${cert.id}-1`), { timeout: 30_000 });
      const settled = Promise.allSettled([second]);
      await waitUntilBlocked('BillDeduction');   // throws if the second writer never waits
      letACommit();
      await first;
      expect((await settled)[0]!.status, 'the second ₹60 must be refused against a ₹100 certificate').toBe('rejected');
    } finally {
      letACommit();
      await a.$disconnect();
      await b.$disconnect();
    }

    const total = await t.prisma.billDeduction.aggregate({ where: { projectId, billId }, _sum: { amount: true } });
    expect(total._sum.amount!.toFixed(2)).toBe('60.00');
  });

  it('PROBE 14 (§H): the RELEASE bound serializes too — the sibling round 1 fixed on one side only', async () => {
    const projectId = await freshProject();
    const billId = await certifiedClaim(projectId);
    const d = await deductions.record(projectId, { billId, type: 'retention', amount: '100.00' }, pmc(projectId));
    // R5-F3 — one command per row, each bound to the row it backs, so both racers pass provenance
    // and the BOUND is what decides between them, which is what this probe is about
    const commands = [
      await mintCommand(projectId, 'commercial.deduction.release', `${d.id}-r0`),
      await mintCommand(projectId, 'commercial.deduction.release', `${d.id}-r1`),
    ];

    let n = 0;
    const results = await bothInsertThenCommit((client) => {
      const i = n++;
      return client.$executeRawUnsafe(
        `INSERT INTO "BillDeductionRelease" ("id","projectId","deductionId","amount","reason","releasedById","sourceCommandId")
         VALUES ($1,$2,$3,60.00,'concurrent',$4,$5)`,
        `${d.id}-r${i}`, projectId, d.id, f.memberUser.id, commands[i]!,
      );
    });

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const total = await t.prisma.billDeductionRelease.aggregate({ where: { projectId, deductionId: d.id }, _sum: { amount: true } });
    expect(total._sum.amount!.toFixed(2)).toBe('60.00');
  });

  it('PROBE 15 (§H): a SUPERSEDED certificate accepts no new withholding', async () => {
    // the bound function returns early for a superseded certificate — correctly, since its rows
    // have left every fold — but "no bound to check" is not "anything goes": such a row is a
    // withholding taken from a payable that no longer exists, and so withheld from nobody.
    const projectId = await freshProject();
    const billId = await certifiedClaim(projectId);
    const cert = await t.prisma.billCertificate.findFirstOrThrow({ where: { projectId, billId, supersededAt: null } });
    const command = { id: await mintCommand(projectId, 'commercial.deduction.record', `${cert.id}-late`) };
    await certification.supersede(projectId, { billId, reason: 'corrected' }, pmc(projectId));

    await expect(t.prisma.$executeRawUnsafe(
      `INSERT INTO "BillDeduction" ("id","projectId","certificateId","billId","type","amount","recordedById","sourceCommandId")
       VALUES ($1,$2,$3,$4,'retention',10.00,$5,$6)`,
      `${cert.id}-late`, projectId, cert.id, billId, f.memberUser.id, command.id,
    )).rejects.toThrow(/was superseded/u);
  });

  it('PROBE 16 (§C): a ledger row records the command that PRODUCED it, and cannot borrow another', async () => {
    // Codex round 3. Split by WHEN each half is knowable: the TYPE at BEFORE INSERT, the STATUS at
    // COMMIT — a command is still `reserved` while its own transaction runs, so checking status
    // early would reject every legitimate write. This is §E's verified-provenance seal, one task on.
    const projectId = await freshProject();
    const billId = await certifiedClaim(projectId);
    const cert = await t.prisma.billCertificate.findFirstOrThrow({ where: { projectId, billId, supersededAt: null } });
    const insert = (id: string, commandId: string) => t.prisma.$executeRawUnsafe(
      `INSERT INTO "BillDeduction" ("id","projectId","certificateId","billId","type","amount","recordedById","sourceCommandId")
       VALUES ($1,$2,$3,$4,'retention',10.00,$5,$6)`,
      id, projectId, cert.id, billId, f.memberUser.id, commandId,
    );

    // the correct command is ACCEPTED, so the refusals below are the provenance rule and not the bound
    const okCommand = await mintCommand(projectId, 'commercial.deduction.record', `${cert.id}-prov-ok`);
    await insert(`${cert.id}-prov-ok`, okCommand);
    await expect(insert(`${cert.id}-prov-type`, await mintCommand(projectId, 'commercial.bill.certify', `${cert.id}-prov-type`)))
      .rejects.toThrow(/records the command that PRODUCED it/u);
    await expect(insert(`${cert.id}-prov-rel`, await mintCommand(projectId, 'commercial.deduction.release', `${cert.id}-prov-rel`)))
      .rejects.toThrow(/records the command that PRODUCED it/u);

    // R5-F3 — the type check alone is satisfied by EVERY prior command of that type, so a direct
    // writer could reuse the succeeded receipt above to append a second, third, fourth withholding
    // and the append-only ledger would permanently attribute money movement to an act that produced
    // none of it. The command must have PRODUCED this row.
    await expect(insert(`${cert.id}-prov-reuse`, okCommand))
      .rejects.toThrow(/reusing a succeeded receipt attributes money to an act that did not move it/u);

    // …and the release side obeys the SAME sentence — `resultRef` IS the row — so a second release
    // citing the receipt that produced the first is refused too
    const d = await deductions.record(projectId, { billId, type: 'retention', amount: '20.00' }, pmc(projectId));
    const insertRelease = (id: string, commandId: string) => t.prisma.$executeRawUnsafe(
      `INSERT INTO "BillDeductionRelease" ("id","projectId","deductionId","amount","reason","releasedById","sourceCommandId")
       VALUES ($1,$2,$3,1.00,'provenance probe',$4,$5)`,
      id, projectId, d.id, f.memberUser.id, commandId,
    );
    const relCommand = await mintCommand(projectId, 'commercial.deduction.release', `${d.id}-rel-ok`);
    await insertRelease(`${d.id}-rel-ok`, relCommand);
    await expect(insertRelease(`${d.id}-rel-reuse`, relCommand))
      .rejects.toThrow(/reusing a succeeded receipt attributes money to an act that did not move it/u);

    // …and a command that never succeeded is caught at COMMIT rather than at insert
    const reserved = await t.prisma.commandExecution.create({
      data: {
        scopeKind: 'project', organizationId: f.orgA.id, projectId, actorId: f.memberUser.id,
        commandType: 'commercial.deduction.record', idempotencyKey: `probe-${seq++}`, requestHash: 'x',
        status: 'reserved',
      },
      select: { id: true },
    });
    await expect(insert(`${cert.id}-prov-pending`, reserved.id))
      .rejects.toThrow(/a withholding nobody made/u);
  });

  it('PROBE 17 (§H): a withholding racing a SUPERSESSION blocks, then is refused — money is never taken from a dead payable', async () => {
    // The race that can actually lose money, and the reason the deduction path locks the CERTIFICATE
    // rather than merely reading it. Without that lock a withholding is recorded against a payable
    // another transaction is in the middle of retiring: the deduction commits against a certificate
    // that no longer stands, `positionFor` reads only the live one, and the money is withheld from
    // nobody while the ledger says a vendor was charged.
    //
    // A genuine barrier: the supersession holds its row lock, the withholding is CONFIRMED blocked
    // on it (via `pg_blocking_pids`, never a sleep), and only then is the supersession allowed to
    // commit.
    const projectId = await freshProject();
    const billId = await certifiedClaim(projectId);
    const cert = await t.prisma.billCertificate.findFirstOrThrow({ where: { projectId, billId, supersededAt: null } });

    const holder = new PrismaClient();
    let letCommit!: () => void;
    let superseded!: () => void;
    const mayCommit = new Promise<void>((r) => { letCommit = r; });
    const hasSuperseded = new Promise<void>((r) => { superseded = r; });
    const supersession = holder.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(
        `UPDATE "BillCertificate" SET "supersededAt"=now(), "supersededById"=$2, "supersedeReason"='racing' WHERE "id"=$1`,
        cert.id, f.memberUser.id,
      );
      await tx.$executeRawUnsafe(`UPDATE "VendorBill" SET "status"='verified', "statusChangedAt"=now() WHERE "id"=$1`, billId);
      superseded();
      await mayCommit;
    }, { timeout: 20_000 });

    let outcome!: PromiseSettledResult<unknown>;
    try {
      await hasSuperseded;
      const settled = Promise.allSettled([
        deductions.record(projectId, { billId, type: 'retention', amount: '10.00' }, pmc(projectId)),
      ]);
      // §0b's lock order takes the BILL first, so that is where the wait shows — the certificate
      // lock inside the liveness trigger is never even reached while the bill is held
      await waitUntilBlocked('VendorBill');   // throws if the withholding never waits
      letCommit();
      await supersession;
      outcome = (await settled)[0]!;
    } finally {
      letCommit();
      await supersession.catch(() => undefined);
      await holder.$disconnect();
    }

    // the supersession won, so the withholding is refused rather than recorded against nothing
    expect(outcome.status, 'a withholding against a certificate retired underneath it must be refused').toBe('rejected');
    expect(await t.prisma.billDeduction.count({ where: { projectId, billId } })).toBe(0);
    expect(await t.prisma.billCertificate.count({ where: { projectId, billId, supersededAt: null } })).toBe(0);
  });

  it('PROBE 18 (§H): insert-then-supersede in ONE transaction is refused at COMMIT', async () => {
    // Codex round 4 F1. The liveness trigger is BEFORE INSERT, so it sees the world mid-transaction.
    // A bypass writer inserts against a live certificate, supersedes it before committing, and every
    // insert-time check has already passed — the deferred bound then returns early for a superseded
    // certificate, and the commit leaves a withholding that never stood on a live payable.
    const projectId = await freshProject();
    const billId = await certifiedClaim(projectId);
    const cert = await t.prisma.billCertificate.findFirstOrThrow({ where: { projectId, billId, supersededAt: null } });

    const attempt = async (supersedeToo: boolean) => {
      const rowId = `${cert.id}-${supersedeToo ? 'gone' : 'stays'}`;
      // R5-F3 — one command per row, bound to it
      const command = await mintCommand(projectId, 'commercial.deduction.record', rowId);
      return t.prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(
          `INSERT INTO "BillDeduction" ("id","projectId","certificateId","billId","type","amount","recordedById","sourceCommandId")
           VALUES ($1,$2,$3,$4,'retention',10.00,$5,$6)`,
          rowId, projectId, cert.id, billId, f.memberUser.id, command,
        );
        if (supersedeToo) {
          await tx.$executeRawUnsafe(
            `UPDATE "BillCertificate" SET "supersededAt"=now(), "supersededById"=$2, "supersedeReason"='bypass' WHERE "id"=$1`,
            cert.id, f.memberUser.id,
          );
          await tx.$executeRawUnsafe(`UPDATE "VendorBill" SET "status"='verified', "statusChangedAt"=now() WHERE "id"=$1`, billId);
        }
      });
    };

    // the same insert WITHOUT the supersession is accepted, so the refusal is the timing rule
    await attempt(false);
    // TWO deferred seals now describe this state — `BillDeduction_coherent` (the certificate this
    // row targets did not survive the transaction) and `BillCertificate_supersede_needs_release`
    // (the certificate being corrected still holds money). PostgreSQL does not order deferred
    // constraint triggers across tables, so the probe accepts either voice rather than pinning an
    // ordering the database does not promise — what matters is that the commit does not happen.
    await expect(attempt(true))
      .rejects.toThrow(/superseded in this transaction|still carries an unreleased withholding/u);

    // …and nothing is left behind: the accepted row from the first attempt stands, the refused
    // one does not, and the certificate is still live
    expect(await t.prisma.billDeduction.count({ where: { projectId, billId } })).toBe(1);
    expect(await t.prisma.billCertificate.count({ where: { projectId, billId, supersededAt: null } })).toBe(1);
  });

  it('PROBE 19 (§H): the DATABASE refuses the correction too — the service is not the only way in', async () => {
    // The split rests on ONE property: a retained balance cannot vanish. The service refusal in
    // `supersede` is the friendly half; this is the half that holds when something writes directly.
    // Without it the whole argument for splitting re-statement out collapses, because a bypass
    // supersession would drop the money exactly as round 1's F2 described.
    const projectId = await freshProject();
    const billId = await certifiedClaim(projectId);
    const d = await deductions.record(projectId, { billId, type: 'retention', amount: '40.00' }, pmc(projectId));
    const cert = await t.prisma.billCertificate.findFirstOrThrow({ where: { projectId, billId, supersededAt: null } });

    const bypassSupersede = () => t.prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(
        `UPDATE "BillCertificate" SET "supersededAt"=now(), "supersededById"=$2, "supersedeReason"='bypass' WHERE "id"=$1`,
        cert.id, f.memberUser.id,
      );
      await tx.$executeRawUnsafe(`UPDATE "VendorBill" SET "status"='verified', "statusChangedAt"=now() WHERE "id"=$1`, billId);
    });

    await expect(bypassSupersede()).rejects.toThrow(/still carries an unreleased withholding/u);
    expect(await t.prisma.billCertificate.count({ where: { projectId, billId, supersededAt: null } }))
      .toBe(1);

    // …and once the money is given back the SAME bypass is accepted, so the seal is precise rather
    // than merely strict — it is about a retained balance, not about supersession
    await deductions.release(projectId, { deductionId: d.id, amount: '40.00', reason: 'returned' }, pmc(projectId));
    await bypassSupersede();
    expect(await t.prisma.billCertificate.count({ where: { projectId, billId, supersededAt: null } }))
      .toBe(0);
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
