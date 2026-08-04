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
    const command = { id: await mintCommand(projectId, 'commercial.deduction.record') };

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

  it('PROBE 8 (§H/§F): supersession RE-STATES the withholdings onto the replacement — a retained balance never vanishes', async () => {
    // Codex P1, and the plan is explicit: "supersession RE-STATES the deductions on the new
    // certificate in the same transaction … and NET_PAYABLE reads only the live certificate's
    // rows". The first spelling of this task DROPPED them and asserted that as correct, which
    // makes a retained balance vanish with no attributable release — exactly what §H forbids.
    //
    // Both halves move together: re-stating the ₹10 deduction without its ₹5 release would read
    // ₹10 retained and ₹0 released, clawing back money the vendor was already told it could have.
    const projectId = await freshProject();
    await budget.setBudget(projectId, { costHeadCode: 'CIVIL', amount: '500.00', reason: 'civil plan' }, pmc(projectId));
    const billId = await certifiedClaim(projectId);
    const d = await deductions.record(projectId, { billId, type: 'retention', amount: '10.00' }, pmc(projectId));
    await deductions.release(projectId, { deductionId: d.id, amount: '5.00', reason: 'first milestone' }, pmc(projectId));

    await certification.supersede(projectId, { billId, reason: 'restated' }, pmc(projectId));
    // with NO certificate standing there is nothing to withhold from, and that is not zero
    const between = await deductions.readLedger(projectId, billId, pmc(projectId));
    expect(between.certificateId).toBeNull();
    expect(between.netPayable).toBeNull();

    // re-certify the SAME claim: the ledger comes with it
    await certification.certify(projectId, { billId }, pmc(projectId));
    const after = await deductions.readLedger(projectId, billId, pmc(projectId));
    expect(after.withheld).toBe('5.00');
    expect(after.netPayable).toBe('95.00');
    expect(after.deductions).toHaveLength(1);
    expect(after.deductions[0]!.unreleased).toBe('5.00');
    expect(after.deductions[0]!.releases).toHaveLength(1);
    expect(after.billStatus).toBe('certified');

    // the superseded rows survive as HISTORY on the certificate they were taken against — they are
    // append-only, so re-statement is a copy with an audit chain, never a move
    expect(await t.prisma.billDeduction.count({ where: { projectId, billId } })).toBe(2);
    const restated = await t.prisma.billDeduction.findFirstOrThrow({ where: { projectId, restatedFromId: d.id } });
    expect(restated.id).toBe(after.deductions[0]!.id);

    // …and §J agrees: ₹100 certified less ₹5 still withheld
    expect((await positionOf(projectId)).certifiedPayable).toBe('95.00');
  });

  it('PROBE 8b (§H): a replacement certified BELOW its outstanding withholdings is REFUSED, not silently dropped', async () => {
    // the edge the carry-forward creates. Certifying ₹100 with ₹60 retained and then correcting to
    // ₹50 cannot hold the ₹60 — and the honest answer is to refuse and name it, because the
    // alternative is a certificate quietly giving ₹10 back with nobody's signature on it.
    const projectId = await freshProject();
    const billId = await certifiedClaim(projectId);
    const d = await deductions.record(projectId, { billId, type: 'retention', amount: '60.00' }, pmc(projectId));
    await certification.supersede(projectId, { billId, reason: 'restated lower' }, pmc(projectId));

    // amend the claim down to ₹50 so re-certification produces a smaller certificate
    await bills.amend(projectId, {
      billId, reason: 'corrected quantity',
      lines: [{ poLineId: (await t.prisma.vendorBillLine.findFirstOrThrow({ where: { projectId }, orderBy: { id: 'asc' } })).poLineId!, quantity: '50', rate: '1' }],
    }, pmc(projectId));
    await bills.beginVerification(projectId, { billId }, pmc(projectId));
    await verification.verify(projectId, { billId }, pmc(projectId));

    await expect(certification.certify(projectId, { billId }, pmc(projectId)))
      .rejects.toThrow(/carries 60\.00 of unreleased withholding/u);

    // …and releasing first makes the same correction legal, so the refusal is precise, not merely
    // strict — the money is given back attributably instead of by a certificate dropping a row
    await deductions.release(projectId, { deductionId: d.id, amount: '20.00', reason: 'released before restating' }, pmc(projectId));
    await certification.certify(projectId, { billId }, pmc(projectId));
    expect((await deductions.readLedger(projectId, billId, pmc(projectId))).netPayable).toBe('10.00');
  });

  it('PROBE 8c (§H): a RE-STATED withholding is closed history — releasing it would strand the money', async () => {
    // the other side of the re-statement rule. Once a deduction is carried forward, the live
    // withholding is the copy; a release against the source would sit on a superseded certificate
    // as evidence of money given back that the live payable does not reflect.
    const projectId = await freshProject();
    const billId = await certifiedClaim(projectId);
    const source = await deductions.record(projectId, { billId, type: 'retention', amount: '10.00' }, pmc(projectId));
    await certification.supersede(projectId, { billId, reason: 'restated' }, pmc(projectId));
    await certification.certify(projectId, { billId }, pmc(projectId));

    await expect(deductions.release(projectId, { deductionId: source.id, amount: '4.00', reason: 'wrong row' }, pmc(projectId)))
      .rejects.toThrow(/re-stated onto a later certificate/u);

    // …and the LIVE row releases normally, so the refusal points somewhere real
    const live = (await deductions.readLedger(projectId, billId, pmc(projectId))).deductions[0]!;
    await deductions.release(projectId, { deductionId: live.id, amount: '4.00', reason: 'correct row' }, pmc(projectId));
    expect((await deductions.readLedger(projectId, billId, pmc(projectId))).netPayable).toBe('94.00');
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
  const mintCommand = async (projectId: string, commandType: string): Promise<string> =>
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
        // recorded no result, because a replay would report success and hand back nothing
        data: { status: 'succeeded', resultRef: c.id, completedAt: new Date() },
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
    const command = await mintCommand(projectId, 'commercial.deduction.record');

    const a = new PrismaClient();
    const b = new PrismaClient();
    let letACommit!: () => void;
    let aInserted!: () => void;
    const mayCommit = new Promise<void>((r) => { letACommit = r; });
    const hasInserted = new Promise<void>((r) => { aInserted = r; });
    const insert = (client: PrismaClient, id: string) => client.$executeRawUnsafe(
      `INSERT INTO "BillDeduction" ("id","projectId","certificateId","billId","type","amount","recordedById","sourceCommandId")
       VALUES ($1,$2,$3,$4,'retention',60.00,$5,$6)`,
      id, projectId, cert.id, billId, f.memberUser.id, command,
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
    const command = { id: await mintCommand(projectId, 'commercial.deduction.release') };

    let n = 0;
    const results = await bothInsertThenCommit((client) => client.$executeRawUnsafe(
      `INSERT INTO "BillDeductionRelease" ("id","projectId","deductionId","amount","reason","releasedById","sourceCommandId")
       VALUES ($1,$2,$3,60.00,'concurrent',$4,$5)`,
      `${d.id}-r${n++}`, projectId, d.id, f.memberUser.id, command.id,
    ));

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const total = await t.prisma.billDeductionRelease.aggregate({ where: { projectId, deductionId: d.id }, _sum: { amount: true } });
    expect(total._sum.amount!.toFixed(2)).toBe('60.00');
  });

  it('PROBE 15 (§H): a SUPERSEDED certificate accepts no new withholding', async () => {
    // the bound function returns early for a superseded certificate — correctly, since its rows
    // have left every fold — but "no bound to check" is not "anything goes": such a row would then
    // be CARRIED onto the replacement by re-statement, a withholding taken from nothing.
    const projectId = await freshProject();
    const billId = await certifiedClaim(projectId);
    const cert = await t.prisma.billCertificate.findFirstOrThrow({ where: { projectId, billId, supersededAt: null } });
    const command = { id: await mintCommand(projectId, 'commercial.deduction.record') };
    await certification.supersede(projectId, { billId, reason: 'restated' }, pmc(projectId));

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
    await insert(`${cert.id}-prov-ok`, await mintCommand(projectId, 'commercial.deduction.record'));
    await expect(insert(`${cert.id}-prov-type`, await mintCommand(projectId, 'commercial.bill.certify')))
      .rejects.toThrow(/records the command that PRODUCED it/u);
    await expect(insert(`${cert.id}-prov-rel`, await mintCommand(projectId, 'commercial.deduction.release')))
      .rejects.toThrow(/records the command that PRODUCED it/u);

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

  it('PROBE 17 (§H): a release racing a RE-STATEMENT cannot give the same money back twice', async () => {
    // Codex round 3. `restateDeductions` reads the superseded certificate's live ledger and copies
    // it forward. Without a lock on the rows it reads, a release committing in that window is
    // invisible to the copy — the restated row carries the FULL amount while the release says part
    // of it was given back, so the same money is both withheld and released.
    //
    // A genuine barrier, not two independent transactions: the release inserts and HOLDS, the
    // re-statement runs to completion, and only then is the release allowed to commit.
    const projectId = await freshProject();
    const billId = await certifiedClaim(projectId);
    const source = await deductions.record(projectId, { billId, type: 'retention', amount: '40.00' }, pmc(projectId));
    const releaseCommand = await mintCommand(projectId, 'commercial.deduction.release');

    const racer = new PrismaClient();
    let letCommit!: () => void;
    let inserted!: () => void;
    const mayCommit = new Promise<void>((r) => { letCommit = r; });
    const hasInserted = new Promise<void>((r) => { inserted = r; });
    const release = racer.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(
        `INSERT INTO "BillDeductionRelease" ("id","projectId","deductionId","amount","reason","releasedById","sourceCommandId")
         VALUES ($1,$2,$3,15.00,'racing the restatement',$4,$5)`,
        `${source.id}-race`, projectId, source.id, f.memberUser.id, releaseCommand,
      );
      inserted();
      await mayCommit;
    }, { timeout: 20_000 });

    try {
      await hasInserted;
      await certification.supersede(projectId, { billId, reason: 'restated' }, pmc(projectId));

      // the re-statement must WAIT for the open release rather than copy a stale ledger: the
      // release's foreign key holds a KEY SHARE lock on the deduction, and round 3's `FOR UPDATE`
      // conflicts with it. Without that lock this read would sail past and carry ₹40 with no
      // release behind it, while the source ledger says ₹15 was given back.
      const certified = certification.certify(projectId, { billId }, pmc(projectId));
      const settled = Promise.allSettled([certified]);
      await waitUntilBlocked('BillDeduction');   // throws if the re-statement never waits
      letCommit();
      await release;
      expect((await settled)[0]!.status, 'the re-statement must succeed once the release commits').toBe('fulfilled');
    } finally {
      letCommit();
      await release.catch(() => undefined);
      await racer.$disconnect();
    }

    // conservation: the carried ledger reflects the release that committed in the window — ₹40
    // withheld, ₹15 given back, ₹25 retained. The money was not given back twice, and not lost.
    const ledger = await deductions.readLedger(projectId, billId, pmc(projectId));
    expect(ledger.deductions).toHaveLength(1);
    expect(ledger.deductions[0]!.amount).toBe('40.00');
    expect(ledger.netPayable).toBe('75.00');
  });

  it('PROBE 18 (§H): insert-then-supersede in ONE transaction is refused at COMMIT', async () => {
    // Codex round 4 F1. The liveness trigger is BEFORE INSERT, so it sees the world mid-transaction.
    // A bypass writer inserts against a live certificate, supersedes it before committing, and every
    // insert-time check has already passed — the deferred bound then returns early for a superseded
    // certificate, and the commit leaves a withholding that never stood on a live payable.
    const projectId = await freshProject();
    const billId = await certifiedClaim(projectId);
    const cert = await t.prisma.billCertificate.findFirstOrThrow({ where: { projectId, billId, supersededAt: null } });
    const command = await mintCommand(projectId, 'commercial.deduction.record');

    const attempt = (supersedeToo: boolean) => t.prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(
        `INSERT INTO "BillDeduction" ("id","projectId","certificateId","billId","type","amount","recordedById","sourceCommandId")
         VALUES ($1,$2,$3,$4,'retention',10.00,$5,$6)`,
        `${cert.id}-${supersedeToo ? 'gone' : 'stays'}`, projectId, cert.id, billId, f.memberUser.id, command,
      );
      if (supersedeToo) {
        await tx.$executeRawUnsafe(
          `UPDATE "BillCertificate" SET "supersededAt"=now(), "supersededById"=$2, "supersedeReason"='bypass' WHERE "id"=$1`,
          cert.id, f.memberUser.id,
        );
        await tx.$executeRawUnsafe(`UPDATE "VendorBill" SET "status"='verified', "statusChangedAt"=now() WHERE "id"=$1`, billId);
      }
    });

    // the same insert WITHOUT the supersession is accepted, so the refusal is the timing rule
    await attempt(false);
    await expect(attempt(true)).rejects.toThrow(/superseded in this transaction/u);
  });

  it('PROBE 19 (§H): a forged re-statement cannot lock a live withholding out of release', async () => {
    // Codex round 4 F3. The FK proves only that `restatedFromId` names SOME deduction. Since
    // `release()` refuses any deduction that has been re-stated, a forged row naming an unrelated
    // still-live withholding as its source freezes that withholding forever — a denial of service
    // against money somebody is owed.
    const projectId = await freshProject();
    const billId = await certifiedClaim(projectId);
    const victim = await deductions.record(projectId, { billId, type: 'retention', amount: '10.00' }, pmc(projectId));
    const cert = await t.prisma.billCertificate.findFirstOrThrow({ where: { projectId, billId, supersededAt: null } });
    const command = await mintCommand(projectId, 'commercial.deduction.record');

    const forge = (id: string, source: string, amount: string, type = 'retention') => t.prisma.$executeRawUnsafe(
      `INSERT INTO "BillDeduction" ("id","projectId","certificateId","billId","type","amount","recordedById","sourceCommandId","restatedFromId")
       VALUES ($1,$2,$3,$4,$7,${amount},$5,$6,$8)`,
      id, projectId, cert.id, billId, f.memberUser.id, command, type, source,
    );

    await expect(forge(`${cert.id}-f1`, victim.id, '10.00')).rejects.toThrow(/still stands on a LIVE certificate/u);

    // …and once the source IS superseded, the terms must still match: a re-statement carries the
    // same withholding forward, it does not quietly restate it as a different judgement
    await certification.supersede(projectId, { billId, reason: 'restated' }, pmc(projectId));
    await certification.certify(projectId, { billId }, pmc(projectId));
    const live = await t.prisma.billCertificate.findFirstOrThrow({ where: { projectId, billId, supersededAt: null } });
    const carried = await t.prisma.billDeduction.findFirstOrThrow({ where: { projectId, restatedFromId: victim.id } });
    expect(carried.amount.toFixed(2), 'the legitimate re-statement must have carried the terms verbatim').toBe('10.00');

    const forgeOn = (id: string, source: string, amount: string, type = 'retention') => t.prisma.$executeRawUnsafe(
      `INSERT INTO "BillDeduction" ("id","projectId","certificateId","billId","type","amount","recordedById","sourceCommandId","restatedFromId")
       VALUES ($1,$2,$3,$4,$7,${amount},$5,$6,$8)`,
      id, projectId, live.id, billId, f.memberUser.id, command, type, source,
    );
    // the source is already carried, so a second claim on it collides on the unique index
    await expect(forgeOn(`${live.id}-f2`, victim.id, '10.00')).rejects.toThrow();
    // …and the carried row is itself live, so naming IT as a source is the freeze all over again
    await expect(forgeOn(`${live.id}-f3`, carried.id, '10.00')).rejects.toThrow(/still stands on a LIVE certificate/u);
    // the terms must match too: re-stating is carrying the same withholding forward, not revising it
    await certification.supersede(projectId, { billId, reason: 'again' }, pmc(projectId));
    const next = await t.prisma.$queryRawUnsafe<Array<{ id: string }>>(
      `SELECT "id" FROM "BillCertificate" WHERE "projectId"=$1 AND "billId"=$2 AND "supersededAt" IS NULL`,
      projectId, billId,
    );
    expect(next, 'supersession must leave no live certificate, or the next assertion means nothing').toHaveLength(0);
  });

  it('PROBE 20 (§H): a replacement certificate MUST carry the retained balance forward', async () => {
    // Codex round 4 F2. `restateDeductions` is service code. A bypass replacement certification can
    // supersede a certificate carrying a ₹40 retention and create the new live certificate with no
    // carried rows — the old deduction stays as history, `positionFor` reads only the live
    // certificate, and the retained balance vanishes with nobody's release behind it. That is round
    // 1's F2 arriving from the database side, and only a commit-time seal sees it.
    const projectId = await freshProject();
    const billId = await certifiedClaim(projectId);
    const source = await deductions.record(projectId, { billId, type: 'retention', amount: '40.00' }, pmc(projectId));
    const prior = await t.prisma.billCertificate.findFirstOrThrow({ where: { projectId, billId, supersededAt: null } });
    await certification.supersede(projectId, { billId, reason: 'restated' }, pmc(projectId));

    const certCommand = await mintCommand(projectId, 'commercial.bill.certify');
    const dedCommand = await mintCommand(projectId, 'commercial.deduction.record');
    const replace = (certId: string, restate: boolean) => t.prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(
        `INSERT INTO "BillCertificate" ("id","projectId","billId","versionId","certifiedAmount","certifiedById","sourceCommandId")
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        certId, projectId, billId, prior.versionId, prior.certifiedAmount, f.memberUser.id, certCommand,
      );
      await tx.$executeRawUnsafe(
        `INSERT INTO "CertifiedAcceptanceConsumption" ("id","projectId","certificateId","stockTransactionId","consumedQty")
         SELECT $1 || '-' || "id", $2, $3, "stockTransactionId", "consumedQty"
           FROM "CertifiedAcceptanceConsumption" WHERE "projectId"=$2 AND "certificateId"=$4`,
        certId, projectId, certId, prior.id,
      );
      if (restate) {
        await tx.$executeRawUnsafe(
          `INSERT INTO "BillDeduction" ("id","projectId","certificateId","billId","type","amount","recordedById","sourceCommandId","restatedFromId")
           VALUES ($1,$2,$3,$4,'retention',40.00,$5,$6,$7)`,
          `${certId}-d`, projectId, certId, billId, f.memberUser.id, dedCommand, source.id,
        );
      }
      await tx.$executeRawUnsafe(`UPDATE "VendorBill" SET "status"='certified', "statusChangedAt"=now() WHERE "id"=$1`, billId);
    });

    await expect(replace('bypass-1', false)).rejects.toThrow(/does not re-state/u);
    // …and the SAME transaction with the carried row is accepted, so the seal is precise
    await replace('bypass-2', true);
    const ledger = await deductions.readLedger(projectId, billId, pmc(projectId));
    expect(ledger.deductions).toHaveLength(1);
    expect(ledger.netPayable).toBe('60.00');
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
