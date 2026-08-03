import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { Prisma } from '@prisma/client';
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
import { CommercialBudgetService } from '../../src/commercial/commercial-budget.service';
import { CommercialBudgetQuery } from '../../src/commercial/commercial-budget.query';
import { CommercialBillService } from '../../src/commercial/commercial-bill.service';
import { CommercialVerificationService } from '../../src/commercial/commercial-verification.service';
import { CommercialMeasurementService } from '../../src/commercial/commercial-measurement.service';
import { VERIFICATION_EXCEPTION_KINDS } from '@vitan/shared';
import { CapabilitiesService, LABOUR_CAPABILITY, MATERIALS_CAPABILITY } from '../../src/platform/capabilities.service';
import { lockProjectReadiness } from '../../src/common/readiness-lock';
import type { AuthUser } from '../../src/common/auth';
import type { CreateRequirementInput } from '../../src/contracts';

/**
 * Phase 5 Task 5A — §E THREE-WAY VERIFICATION, proven live against PostgreSQL, reproduce-first.
 *
 * The triple is DERIVED, never stored, so every probe here asserts a verdict computed at the moment
 * it is asked — and one of them proves exactly that by moving the evidence after a verdict and
 * showing the next read disagrees with the last.
 */
/**
 * Run `once` immediately before the FIRST `vendorBill.updateMany` this transaction client issues.
 *
 * The dispute disposition reads the billed fold and the live claim set, then CASes. Two round-4/5
 * findings live in the gap between the read and the CAS, and both need the world to change exactly
 * there. Wrapping the client produces that ordering deterministically — no sleeps, no polling, no
 * flake — and nothing here holds a lock the disposition would have waited on, which is the point:
 * the guard is being asked to hold on its own rather than on another lock happening to be there.
 */
function wedgeFirstBillUpdate(
  tx: Prisma.TransactionClient, once: () => Promise<void>,
): Prisma.TransactionClient {
  let fired = false;
  return new Proxy(tx, {
    get(target, prop) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const value = (target as any)[prop];
      if (prop !== 'vendorBill') return typeof value === 'function' ? value.bind(target) : value;
      return new Proxy(value, {
        get(delegate, method) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const fn = (delegate as any)[method];
          if (method !== 'updateMany') return typeof fn === 'function' ? fn.bind(delegate) : fn;
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          return async (args: any) => {
            if (!fired) { fired = true; await once(); }
            return fn.call(delegate, args);
          };
        },
      });
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any;
}

describe('Phase 5 Task 5A — §E three-way verification (live PG)', () => {
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
  let verification: CommercialVerificationService;
  let budget: CommercialBudgetService;
  let budgetQuery: CommercialBudgetQuery;
  let measurement: CommercialMeasurementService;
  let capabilities: CapabilitiesService;
  let seq = 0;

  const TRUNCATE =
    'TRUNCATE TABLE "BillVerification", "VendorBillLine", "VendorBillVersion", "VendorBill", "DomainEvent", "OutboxDelivery", "ProcessedEvent", "ProjectionCursor", "ProjectionGeneration", "DecisionProjection", "DailyLogProjection", "DrawingsProjection", "InspectionsProjection", "ActivitiesProjection", "MaterialReadinessProjection", "LabourReadinessProjection", "Measurement", "BudgetException", "BudgetLine", "CommitmentAttribution", "CostHead", "LabourMismatchResolution", "LabourMismatch", "ActivityWorkOutput", "LabourWorkFact", "WorkerAllocation", "LabourAttendance", "ApprovedSkillSubstitution", "CapacityPromise", "CapacityCommitment", "LabourPurchaseOrderLine", "LabourPurchaseOrderVersion", "LabourPurchaseOrder", "LabourQuoteComparison", "SupplierLabourQuoteLine", "SupplierLabourQuote", "LabourRfq", "LabourRequisitionLine", "LabourRequisition", "VendorLabourProfile", "StockTransaction", "MaterialIssue", "StockLot", "DeliveryPromise", "DeliveryCommitment", "PurchaseOrderLine", "PurchaseOrderVersion", "PurchaseOrder", "VendorQuoteLine", "QuoteComparison", "VendorQuote", "Rfq", "RequisitionLine", "Requisition", "ProjectVendor", "CommandExecution", "CrewMembership", "Crew", "WorkerDevice", "WorkerSkill", "Worker", "ApprovedSubstitution", "LabourDemandSlice", "LabourRequirementSpec", "LabourTrade", "LabourSkill", "MaterialRequirementSpec", "ActivityRequirement", "ActivityRequirementRoot", "DecisionApprovalRevision", "ProjectCapability" CASCADE';

  const pmc = (projectId: string): AuthUser => ({ sub: f.memberUser.id, role: 'pmc', projectId }) as AuthUser;
  const engineer = (projectId: string): AuthUser => ({ sub: f.memberUser.id, role: 'engineer', projectId }) as AuthUser;
  const contractor = (projectId: string): AuthUser => ({ sub: f.memberUser.id, role: 'contractor', projectId }) as AuthUser;
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
    verification = t.app.get(CommercialVerificationService);
    budget = t.app.get(CommercialBudgetService);
    budgetQuery = t.app.get(CommercialBudgetQuery);
    measurement = t.app.get(CommercialMeasurementService);
    capabilities = t.app.get(CapabilitiesService);
  });
  afterAll(async () => {
    await t?.prisma.$executeRawUnsafe(TRUNCATE);
    await t?.prisma.vendor.deleteMany({ where: { orgId: f.orgA.id } });
    // This suite creates its OWN projects (`freshProject`, plus the never-activated one the §D
    // probe needs), and the shared fixture cleanup deletes the ORG. A project left behind holds an
    // FK to that org, so the org delete fails — and because the database is shared, it fails in
    // whichever suite happens to tear down last rather than in the one that leaked. Cleaning up
    // what this file created keeps the failure attributable to its author.
    await t?.prisma.membership.deleteMany({ where: { projectId: { startsWith: 'it-p5t5a-' } } });
    await t?.prisma.project.deleteMany({ where: { id: { startsWith: 'it-p5t5a-' } } });
    await f?.cleanup();
    await t?.close();
  });
  afterEach(async () => {
    await t.prisma.$executeRawUnsafe(TRUNCATE);
    await t.prisma.vendor.deleteMany({ where: { orgId: f.orgA.id } });
    for (const [model, where] of [
      ['auditLog', { projectId: { startsWith: 'it-p5t4-' } }],
      ['media', { projectId: { startsWith: 'it-p5t4-' } }],
      ['activity', { projectId: { startsWith: 'it-p5t4-' } }],
      ['membership', { projectId: { startsWith: 'it-p5t4-' } }],
      ['project', { id: { startsWith: 'it-p5t4-' } }],
    ] as const) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (t.prisma as any)[model].deleteMany({ where });
    }
  });

  // ── fixtures ─────────────────────────────────────────────────────────────────────────────────

  const freshProject = async (extraHeads: ReadonlyArray<{ code: string; name: string }> = []): Promise<string> => {
    const id = `it-p5t4-${Date.now() % 1e6}-${seq++}`;
    await t.prisma.project.create({
      data: { id, orgId: f.orgA.id, name: id, short: 'P', descriptor: '', stage: 'x', siteCode: 'P', projStart: 'a', projEnd: 'b', elapsedPct: 0, todayDay: 0, milestonePct: 0, timeZone: 'Asia/Kolkata', scheduleStartDate: new Date('2026-06-01T00:00:00.000Z') },
    });
    await t.prisma.membership.create({ data: { projectId: id, userId: f.memberUser.id, role: 'pmc', status: 'active' } });
    await capabilities.enable(id, MATERIALS_CAPABILITY, f.memberUser.id);
    await activation.activate(id, f.memberUser.id, {
      costHeads: [{ code: 'CIVIL', name: 'Civil works' }, ...extraHeads], materialLines: [], labourLines: [], reason: 'pilot activation',
    });
    return id;
  };

  const freshActivity = async (projectId: string): Promise<string> => {
    const id = `IT-P5T4-ACT-${Date.now() % 1e6}-${seq++}`;
    await t.prisma.activity.create({ data: { id, projectId, name: `Act ${seq}`, zone: 'Zone 1', plannedStart: 0, plannedEnd: 10 } });
    return id;
  };

  const freshMedia = async (projectId: string): Promise<string> => {
    const row = await t.prisma.media.create({ data: { projectId, kind: 'material', mime: 'image/jpeg', uploadedBy: f.memberUser.id, sizeBytes: 3 } });
    return row.id;
  };

  /** requirement → approved comparison → ISSUED material PO line, with its vendor. */
  const issuedMaterialLine = async (
    projectId: string,
    opts: { qty?: string; baseRate?: string; taxAmount?: string; freightAmount?: string; vendorId?: string; costHeadCode?: string } = {},
  ): Promise<{ poId: string; poLineId: string; vendorId: string; commitmentId: string }> => {
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
    const vendorId = opts.vendorId ?? (await (async () => {
      const v = await vendors.create(f.orgA.id, { name: `Vendor ${seq++}` }, orgAdmin());
      await vendors.bind(projectId, { vendorId: v.id }, pmc(projectId));
      return v.id;
    })());
    const withQuote = await procurement.recordQuote(projectId, rfq.id, {
      vendorId, validUntil: '2027-01-01',
      lines: [{ requisitionLineId: lineId, baseRate: opts.baseRate ?? '1', taxAmount: opts.taxAmount ?? '0', freightAmount: opts.freightAmount ?? '0', landedCost: '999.99', quotedMake: 'make', matchesSpecification: true }],
    }, pmc(projectId));
    const quoteId = withQuote.quotes.find((q) => q.status === 'recorded')!.id;
    await procurement.createComparison(projectId, rfq.id, pmc(projectId));
    const approved = await procurement.approveComparison(projectId, rfq.id, { selectedQuoteId: quoteId, reason: 'single quote, in spec' }, pmc(projectId));
    const po = await pos.create(projectId, { comparisonId: approved.comparison!.id, lines: [{ requisitionLineId: lineId, purchaseQty: qty }] }, pmc(projectId));
    const line = await t.prisma.purchaseOrderLine.findFirstOrThrow({ where: { projectId, requisitionLineId: lineId } });
    await pos.issue(projectId, po.id, { costHeads: [{ poLineId: line.id, costHeadCode: opts.costHeadCode ?? 'CIVIL' }] }, pmc(projectId));
    const commitment = await pos.commitDelivery(projectId, { poLineId: line.id, promisedDate: '2026-09-01' }, pmc(projectId));
    return { poId: po.id, poLineId: line.id, vendorId, commitmentId: commitment.id };
  };

  /** receive `qty` and ACCEPT `acceptQty` of it — `ACCEPTED(poLine)` is an EVENT fold, not a balance. */
  const acceptOnLine = async (
    projectId: string, line: { poLineId: string; commitmentId: string },
    receiveQty: string, acceptQty: string, rejectQty?: string,
  ): Promise<{ lotId: string; acceptanceTxId: string }> => {
    const lot = await inventory.recordReceipt(projectId, {
      poLineId: line.poLineId, commitmentId: line.commitmentId, storeLocation: 'main', purchaseQty: receiveQty,
    }, pmc(projectId));
    await inventory.accept(projectId, { lotId: lot.id, storeLocation: 'main', qty: acceptQty, qualityResult: 'pass', evidenceMediaId: await freshMedia(projectId) }, pmc(projectId));
    if (rejectQty) {
      await inventory.reject(projectId, { lotId: lot.id, storeLocation: 'main', qty: rejectQty, qualityResult: 'fail', reason: 'off spec', evidenceMediaId: await freshMedia(projectId) }, pmc(projectId));
    }
    const acceptance = await t.prisma.stockTransaction.findFirstOrThrow({
      where: { projectId, lotId: lot.id, type: 'acceptance' }, orderBy: { recordedAt: 'desc' },
    });
    return { lotId: lot.id, acceptanceTxId: acceptance.id };
  };

  /** record + submit ONE material claim in a single step, returning the bill. */
  const claim = async (
    projectId: string, vendorId: string, poLineId: string, quantity: string,
    opts: { number?: string; rate?: string; tax?: string; freight?: string } = {},
  ) => {
    const recorded = await bills.record(projectId, {
      vendorId, vendorBillNumber: opts.number ?? `V-${seq++}`, documentDate: '2026-08-20',
      lines: [{ poLineId, quantity, rate: opts.rate ?? '1', taxAmount: opts.tax, freightAmount: opts.freight }],
    }, pmc(projectId));
    return bills.submit(projectId, { billId: recorded.id }, pmc(projectId));
  };

  const openExceptions = (projectId: string) =>
    t.prisma.budgetException.findMany({ where: { projectId, clearedAt: null }, orderBy: { costHeadCode: 'asc' } });

  const positionOf = (projectId: string, code: string) =>
    t.prisma.$transaction(async (tx) => (await budgetQuery.positionsFor(tx, projectId, [code])).get(code)!);

  const statusOf = async (projectId: string, billId: string): Promise<string> =>
    (await t.prisma.vendorBill.findFirstOrThrow({ where: { projectId, id: billId } })).status;

  /**
   * The LIVE `BILLED_QTY(poLine)` fold, read straight from the rows so the probe is independent of
   * the service's own query. `kind` is REQUIRED rather than defaulted: an earlier revision of this
   * helper was material-only, so passing it a labour line silently folded zero rows and the F1
   * probe read `0` for a claim that was very much live — a probe passing while proving nothing,
   * for the third time in this phase.
   */
  const billedQty = async (projectId: string, poLineId: string, kind: 'material' | 'labour' = 'material'): Promise<string> => {
    const rows = await t.prisma.vendorBillLine.findMany({
      where: {
        projectId,
        ...(kind === 'material' ? { poLineId } : { labourPoLineId: poLineId }),
        version: { is: { supersededAt: null, bill: { is: { status: { notIn: ['draft', 'rejected', 'disputed', 'resolved'] } } } } },
      },
      select: { quantity: true },
    });
    return rows.reduce((s, r) => s.add(r.quantity), new Prisma.Decimal(0)).toString();
  };

  // ── the LABOUR chain, for the bound-2 `MEASURED` side ─────────────────────────────────────────

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

  // ── §E — the verdict, and the ONE arrow it makes safe ────────────────────────────────────────

  /** Move a submitted claim to `under-verification`, which is where the verdict is asked. */
  const underVerification = async (projectId: string, billId: string) => {
    await bills.beginVerification(projectId, { billId }, pmc(projectId));
    return billId;
  };

  it('PROBE A (§E/§F): a MATCHED claim verifies, and that is the only arrow this increment opens', async () => {
    const projectId = await freshProject();
    const line = await issuedMaterialLine(projectId, { qty: '100', baseRate: '1' });
    await acceptOnLine(projectId, line, '100', '100');
    const bill = await claim(projectId, line.vendorId, line.poLineId, '100');
    await underVerification(projectId, bill.id);

    const verdict = await verification.verify(projectId, { billId: bill.id }, pmc(projectId));
    expect(verdict.verdict).toBe('matched');
    expect(verdict.exceptions).toEqual([]);
    expect(await statusOf(projectId, bill.id)).toBe('verified');

    // …and NOT one step further. `certified` is 5B's, with the certificate that is its evidence.
    await expect(t.prisma.$executeRawUnsafe(
      `UPDATE "VendorBill" SET "status"='certified', "statusChangedAt"=now() WHERE "id"=$1`, bill.id,
    )).rejects.toThrow(/cannot move from/u);
    expect(await statusOf(projectId, bill.id)).toBe('verified');
  });

  /**
   * PROBE B — recorded HONESTLY, because it does not prove what a naive reading of §E expects.
   *
   * §E's verdict has quantity arms (`qty-over-ordered`, `qty-over-accepted`), and I wrote a probe
   * expecting to observe one. It cannot be observed through any service path in this tree, and the
   * reason is that the invariant already holds: Task 4's bounds dispute an over-accepted claim AT
   * SUBMISSION, and its withdrawal guard disputes a live claim the moment evidence moves under it.
   * A disputed claim leaves every billed fold (§0), so by the time verification could see an excess
   * there is nothing left in the fold to exceed anything.
   *
   * So the quantity arms are a BACKSTOP, not a path — and this probe asserts the invariant that
   * makes them one, rather than asserting a `qty-over-accepted` that only appears if the invariant
   * is already broken. The arms stay in the implementation because §E requires the verdict to be
   * complete and because a backstop that is deleted when it looks unreachable is how the
   * unreachable becomes reachable.
   */
  it('PROBE B (§E): a live claim can never exceed its evidence, which is why the quantity arms are a backstop', async () => {
    const projectId = await freshProject();
    const line = await issuedMaterialLine(projectId, { qty: '120', baseRate: '1' });
    await acceptOnLine(projectId, line, '60', '60');
    const second = await acceptOnLine(projectId, line, '40', '40');
    const bill = await claim(projectId, line.vendorId, line.poLineId, '100');
    expect(bill.status).toBe('submitted');
    await underVerification(projectId, bill.id);

    // withdraw 40 of the 100 accepted, under a live 100-unit claim
    await inventory.reverse(projectId, { txId: second.acceptanceTxId, reason: 'mis-counted pallet' }, pmc(projectId));

    // the guard disputed it in the reversal's OWN transaction, naming the breach…
    expect(await statusOf(projectId, bill.id)).toBe('disputed');
    const row = await t.prisma.vendorBill.findFirstOrThrow({ where: { id: bill.id } });
    expect(row.statusReason).toMatch(/qty-over-accepted/u);
    // …so the fold now holds nothing that could exceed the 60 that survived
    expect(await billedQty(projectId, line.poLineId, 'material')).toBe('0');
  });

  it('PROBE C (§E): the claimed RATE is compared against the frozen ordered rate', async () => {
    const projectId = await freshProject();
    const line = await issuedMaterialLine(projectId, { qty: '100', baseRate: '1' });
    await acceptOnLine(projectId, line, '100', '100');
    // quantity and evidence agree; only the money is wrong, which no Task-4 bound looks at
    const bill = await claim(projectId, line.vendorId, line.poLineId, '100', { rate: '2' });
    await underVerification(projectId, bill.id);

    const verdict = await verification.verify(projectId, { billId: bill.id }, pmc(projectId));
    expect(verdict.exceptions).toEqual(['rate-mismatch']);
    expect(await statusOf(projectId, bill.id)).toBe('disputed');
  });

  it('PROBE D (§E): tax and freight are PRORATED — an honest partial bill is not disputed', async () => {
    const projectId = await freshProject();
    // 100 ordered carrying ₹1,800 tax and ₹500 freight for the WHOLE line
    const line = await issuedMaterialLine(projectId, { qty: '100', baseRate: '1', taxAmount: '1800', freightAmount: '500' });
    await acceptOnLine(projectId, line, '100', '100');

    // a 50-unit bill legitimately claims half of each — comparing against the whole frozen figure
    // would dispute an honest vendor
    const honest = await claim(projectId, line.vendorId, line.poLineId, '50', { tax: '900', freight: '250' });
    await underVerification(projectId, honest.id);
    const ok = await verification.verify(projectId, { billId: honest.id }, pmc(projectId));
    expect(ok.exceptions).toEqual([]);
    expect(ok.verdict).toBe('matched');
    expect(ok.lines[0]!.taxCap).toBe('900');
    expect(ok.lines[0]!.freightCap).toBe('250');
  });

  it('PROBE E (§E): claiming the WHOLE frozen tax on a partial bill is a tax-mismatch', async () => {
    const projectId = await freshProject();
    const line = await issuedMaterialLine(projectId, { qty: '100', baseRate: '1', taxAmount: '1800', freightAmount: '500' });
    await acceptOnLine(projectId, line, '100', '100');
    const greedy = await claim(projectId, line.vendorId, line.poLineId, '50', { tax: '1800', freight: '250' });
    await underVerification(projectId, greedy.id);

    const verdict = await verification.verify(projectId, { billId: greedy.id }, pmc(projectId));
    expect(verdict.exceptions).toContain('tax-mismatch');
    expect(verdict.exceptions).not.toContain('freight-mismatch');
  });

  it('PROBE F (§E): FREIGHT is compared too — a claim clean on quantity, rate and tax is still caught', async () => {
    const projectId = await freshProject();
    const line = await issuedMaterialLine(projectId, { qty: '100', baseRate: '1', taxAmount: '1800', freightAmount: '500' });
    await acceptOnLine(projectId, line, '100', '100');
    const inflated = await claim(projectId, line.vendorId, line.poLineId, '50', { tax: '900', freight: '500' });
    await underVerification(projectId, inflated.id);

    const verdict = await verification.verify(projectId, { billId: inflated.id }, pmc(projectId));
    expect(verdict.exceptions).toEqual(['freight-mismatch']);
  });

  it('PROBE G (§E): the pro-rata cap STOPS at the frozen amount — it never scales above 1', async () => {
    const projectId = await freshProject();
    const line = await issuedMaterialLine(projectId, { qty: '100', baseRate: '1', taxAmount: '1800', freightAmount: '0' });
    await acceptOnLine(projectId, line, '100', '100');
    const full = await claim(projectId, line.vendorId, line.poLineId, '100', { tax: '1800' });
    await underVerification(projectId, full.id);

    const verdict = await verification.verify(projectId, { billId: full.id }, pmc(projectId));
    expect(verdict.lines[0]!.taxCap).toBe('1800');
    expect(verdict.exceptions).toEqual([]);

    // HONESTLY SCOPED. The `min(BILLED_QTY, qty)` clamp only DIFFERS from a raw ratio once billing
    // exceeds the ordered quantity, which needs `approvedOverage` — and that column is frozen at
    // PostgreSQL and set only at issuance or amendment (Phase-3 machinery). So the arm where the
    // clamp bites is not reachable from this fixture, and this probe does not pretend to reach it:
    // what it proves is that the cap is the frozen amount and not a scaled-up one. The packet
    // records the gap rather than leaving a probe that passes while proving nothing.
  });

  it('PROBE H (§E): the same units under a DIFFERENT document number is a duplicate-claim', async () => {
    const projectId = await freshProject();
    const line = await issuedMaterialLine(projectId, { qty: '200', baseRate: '1' });
    await acceptOnLine(projectId, line, '200', '200');
    // the live-document index makes a second claim under ONE number unrepresentable; what it
    // PERMITS is the same units re-filed under another number, which the accepted bound only
    // catches once the second claim exceeds what arrived.
    await claim(projectId, line.vendorId, line.poLineId, '100', { number: 'INV-A' });
    const twin = await claim(projectId, line.vendorId, line.poLineId, '100', { number: 'INV-B' });
    await underVerification(projectId, twin.id);

    const verdict = await verification.verify(projectId, { billId: twin.id }, pmc(projectId));
    expect(verdict.exceptions).toContain('duplicate-claim');
  });

  it('PROBE I (§E): the triple is DERIVED — withdrawing evidence changes the next read', async () => {
    const projectId = await freshProject();
    const line = await issuedMaterialLine(projectId, { qty: '100', baseRate: '1' });
    const accepted = await acceptOnLine(projectId, line, '100', '100');
    const bill = await claim(projectId, line.vendorId, line.poLineId, '100');
    await underVerification(projectId, bill.id);

    const first = await verification.verify(projectId, { billId: bill.id }, pmc(projectId));
    expect(first.verdict).toBe('matched');

    // The acceptance is reversed AFTER the verdict. §E's "derived, never stored" is what makes the
    // next question answerable at all — and the answer is that a VERIFIED claim does not stay
    // verified when the evidence under it goes: Task 4's withdrawal guard disputes it in the
    // reversal's own transaction, so `verified` is never a resting place for a claim whose
    // evidence has moved.
    await inventory.reverse(projectId, {
      txId: accepted.acceptanceTxId, reason: 'quality re-test failed',
    }, pmc(projectId));
    expect(await statusOf(projectId, bill.id)).toBe('disputed');
    const row = await t.prisma.vendorBill.findFirstOrThrow({ where: { id: bill.id } });
    expect(row.statusReason).toMatch(/qty-over-accepted/u);
    // and the claim is out of every billed fold, so nothing downstream can rest on it
    expect(await billedQty(projectId, line.poLineId, 'material')).toBe('0');
  });

  it('PROBE J (§E): a LABOUR claim verifies against the COMBINED frozen rate', async () => {
    const projectId = await freshProject();
    const line = await labourMeasurableLine(projectId, 2);
    await measurement.take(projectId, {
      labourPoLineId: line.poLineId, activityId: line.activityId, quantity: '2',
      citedOutputId: line.outputId, measuredOn: '2026-08-10', evidenceMediaId: null, reason: null,
    }, pmc(projectId));
    const recorded = await bills.record(projectId, {
      vendorId: line.vendorId, vendorBillNumber: 'LAB-V1', documentDate: '2026-08-20',
      lines: [{ labourPoLineId: line.poLineId, quantity: '2', rate: '1000' }],
    }, pmc(projectId));
    await bills.submit(projectId, { billId: recorded.id }, pmc(projectId));
    await underVerification(projectId, recorded.id);

    const verdict = await verification.verify(projectId, { billId: recorded.id }, pmc(projectId));
    // the ordered side freezes ONE combined figure (`ratePerPersonShift + shiftPremium`), which is
    // what a labour claim is compared against — and it carries no tax or freight to compare at all
    expect(verdict.lines[0]!.orderedRate).toBe('1000');
    expect(verdict.lines[0]!.orderedTax).toBe('0');
    expect(verdict.exceptions).toEqual([]);
    expect(await statusOf(projectId, recorded.id)).toBe('verified');
  });

  it('§D/§I: the verdict is capability-gated and pmc-only', async () => {
    const projectId = await freshProject();
    const line = await issuedMaterialLine(projectId, { qty: '100', baseRate: '1' });
    await acceptOnLine(projectId, line, '100', '100');
    const bill = await claim(projectId, line.vendorId, line.poLineId, '10');
    await underVerification(projectId, bill.id);

    // an ENGINEER may record and submit a claim, but not rule on whether it is true
    await expect(verification.verify(projectId, { billId: bill.id }, engineer(projectId)))
      .rejects.toThrow(/pmc/u);
    await expect(verification.verify(projectId, { billId: bill.id }, contractor(projectId)))
      .rejects.toThrow(/pmc/u);

    // …and on a project that was never activated, the surface does not exist at all (§D)
    const offPilot = `it-p5t5a-off-${Date.now() % 1e6}`;
    await t.prisma.project.create({
      data: { id: offPilot, orgId: f.orgA.id, name: offPilot, short: 'O', descriptor: '', stage: 'x', siteCode: 'O', projStart: 'a', projEnd: 'b', elapsedPct: 0, todayDay: 0, milestonePct: 0, timeZone: 'Asia/Kolkata', scheduleStartDate: new Date('2026-06-01T00:00:00.000Z') },
    });
    await t.prisma.membership.create({ data: { projectId: offPilot, userId: f.memberUser.id, role: 'pmc', status: 'active' } });
    await expect(verification.readVerification(offPilot, bill.id, pmc(offPilot))).rejects.toThrow();
  });

  // ── Codex round-1 findings, reproduce-first ───────────────────────────────────────────────────

  /**
   * R1-F1 — a §E verdict MOVES the claim between the live and non-live billed sets, so it is a
   * headroom mover like every other bill transition. Disputing removed the exposure and left the
   * exception register open: the budget READ and the register, built from the same fold, disagreeing.
   *
   * The `evaluateClaimHeads` docblock enumerates every writer of `BILLED_AMOUNT` precisely so a new
   * one is visible where it is written. The writer that went missing was the very next one added.
   */
  it('R1-F1 (§B): a verdict that disputes a claim CLEARS the exception its exposure raised', async () => {
    const projectId = await freshProject();
    await budget.setBudget(projectId, { costHeadCode: 'CIVIL', amount: '100.00', reason: 'plan' }, pmc(projectId));
    const line = await issuedMaterialLine(projectId, { qty: '100', baseRate: '1' });
    await acceptOnLine(projectId, line, '100', '100');

    // twice the ordered rate: passes the quantity bounds, carries ₹200 against a ₹100 budget
    const bill = await claim(projectId, line.vendorId, line.poLineId, '100', { rate: '2' });
    await bills.beginVerification(projectId, { billId: bill.id }, pmc(projectId));
    expect((await openExceptions(projectId))).toHaveLength(1);

    // the §E verdict finds `rate-mismatch` and disputes — the exposure leaves the live fold…
    const verdict = await verification.verify(projectId, { billId: bill.id }, pmc(projectId));
    expect(verdict.verdict).toBe('exception');
    expect(verdict.exceptions).toContain('rate-mismatch');
    expect(await statusOf(projectId, bill.id)).toBe('disputed');
    // …so the register must not still be flagging it
    expect((await positionOf(projectId, 'CIVIL')).headroom!.toString()).toBe('0');
    expect(await openExceptions(projectId)).toHaveLength(0);
  });

  /**
   * R1-F2 — `verified` was reachable by direct SQL with nothing re-derived, so a 2× over-rate claim
   * could be walked straight past the §E check. A status is the SHADOW OF A FACT.
   */
  it('R1-F2 (§E): `verified` requires a MATCHED verdict over the CURRENT claim version', async () => {
    const projectId = await freshProject();
    const line = await issuedMaterialLine(projectId, { qty: '100', baseRate: '1' });
    await acceptOnLine(projectId, line, '100', '100');
    const bad = await claim(projectId, line.vendorId, line.poLineId, '100', { rate: '2' });
    await bills.beginVerification(projectId, { billId: bad.id }, pmc(projectId));

    // no verdict recorded at all
    await expect(t.prisma.$executeRawUnsafe(
      `UPDATE "VendorBill" SET "status"='verified', "statusChangedAt"=now() WHERE "id"=$1`, bad.id,
    )).rejects.toThrow(/MATCHED §E verdict/u);

    // an EXCEPTION verdict is not a licence either
    await verification.verify(projectId, { billId: bad.id }, pmc(projectId));
    expect(await statusOf(projectId, bad.id)).toBe('disputed');
    const recorded = await t.prisma.billVerification.findFirstOrThrow({ where: { projectId, billId: bad.id } });
    expect(recorded.verdict).toBe('exception');

    // …and the honest claim verifies, so the seal is precise rather than merely strict
    const good = await claim(projectId, line.vendorId, line.poLineId, '100', { rate: '1', number: 'R1-F2-OK' });
    await bills.beginVerification(projectId, { billId: good.id }, pmc(projectId));
    const ok = await verification.verify(projectId, { billId: good.id }, pmc(projectId));
    expect(ok.verdict).toBe('matched');
    expect(await statusOf(projectId, good.id)).toBe('verified');
  });

  /**
   * R1-F3 — `CommercialBillService.amend` has ALWAYS admitted `verified` and CASes
   * `verified → submitted` so the replacement is re-checked. That path was unreachable while
   * `verified` was; opening the state without opening the arrow the existing service already takes
   * from it would fail every amendment of a verified claim at the trigger.
   */
  it('R1-F3 (§F): a VERIFIED claim can still be amended, and the replacement is re-checked', async () => {
    const projectId = await freshProject();
    const line = await issuedMaterialLine(projectId, { qty: '100', baseRate: '1' });
    await acceptOnLine(projectId, line, '100', '100');
    const bill = await claim(projectId, line.vendorId, line.poLineId, '60', { number: 'R1-F3' });
    await bills.beginVerification(projectId, { billId: bill.id }, pmc(projectId));
    expect((await verification.verify(projectId, { billId: bill.id }, pmc(projectId))).verdict).toBe('matched');
    expect(await statusOf(projectId, bill.id)).toBe('verified');

    const amended = await bills.amend(projectId, {
      billId: bill.id, reason: 'vendor corrected the delivered quantity',
      lines: [{ poLineId: line.poLineId, quantity: '50', rate: '1' }],
    }, pmc(projectId));
    // back to `submitted`: a new claim has not been verified, and must be again before it advances
    expect(amended.status).toBe('submitted');
  });

  /**
   * R1-F4 — a rejected bill is out of the live-document index, out of every live billed fold and —
   * as first written — out of the duplicate scan too, so a vendor could bypass a rejection by
   * replaying the identical claim instead of correcting it, and the replay verified as `matched`.
   */
  it('R1-F4 (§E): an unchanged resubmission after REJECTION is a duplicate-claim', async () => {
    const projectId = await freshProject();
    const line = await issuedMaterialLine(projectId, { qty: '100', baseRate: '1' });
    await acceptOnLine(projectId, line, '100', '100');
    const first = await claim(projectId, line.vendorId, line.poLineId, '40', { number: 'R1-F4-A' });
    await bills.reject(projectId, { billId: first.id, reason: 'billed against the wrong order' }, pmc(projectId));

    // the SAME quantity and rate, re-filed under a new document number
    const replay = await claim(projectId, line.vendorId, line.poLineId, '40', { number: 'R1-F4-B' });
    await bills.beginVerification(projectId, { billId: replay.id }, pmc(projectId));
    const verdict = await verification.verify(projectId, { billId: replay.id }, pmc(projectId));
    expect(verdict.exceptions).toContain('duplicate-claim');
    expect(await statusOf(projectId, replay.id)).toBe('disputed');
  });

  /**
   * R1-F5 — on an idempotency replay `executeCommand` skips the closure, and recomputing afterwards
   * folds WITHOUT the bill (§0 excludes a disputed claim), so the retry answered `matched` and
   * contradicted the dispute that actually happened. A replay returns what the call CONCLUDED.
   */
  it('R1-F5 (§C): a keyed replay returns the ORIGINAL verdict, not a fresh fold', async () => {
    const projectId = await freshProject();
    const line = await issuedMaterialLine(projectId, { qty: '100', baseRate: '1' });
    await acceptOnLine(projectId, line, '100', '100');
    const bill = await claim(projectId, line.vendorId, line.poLineId, '100', { rate: '2', number: 'R1-F5' });
    await bills.beginVerification(projectId, { billId: bill.id }, pmc(projectId));

    const first = await verification.verify(projectId, { billId: bill.id }, pmc(projectId), 'verify-key-1');
    expect(first.verdict).toBe('exception');
    expect(first.exceptions).toContain('rate-mismatch');

    const replayed = await verification.verify(projectId, { billId: bill.id }, pmc(projectId), 'verify-key-1');
    expect(replayed.verdict).toBe('exception');
    expect(replayed.exceptions).toEqual(first.exceptions);
    // and it appended nothing: one verdict, one command
    expect(await t.prisma.billVerification.count({ where: { projectId, billId: bill.id } })).toBe(1);
  });

  // ── Codex round-2 findings, reproduce-first ───────────────────────────────────────────────────

  /**
   * R2-F2 — round 1's replay fix, one level short. It looked the verdict up by the bill's CURRENT
   * version, so verifying v1, losing the response, amending to v2 and retrying the same key would
   * 404 (v2 has no verdict) or return a LATER v2 verdict as the answer to a call made about v1.
   * A replay owes the caller what THAT call concluded, so it is keyed to the original command.
   */
  it('R2-F2 (§C): a replay after an AMENDMENT still returns the original call\'s verdict', async () => {
    const projectId = await freshProject();
    const line = await issuedMaterialLine(projectId, { qty: '100', baseRate: '1' });
    await acceptOnLine(projectId, line, '100', '100');
    const bill = await claim(projectId, line.vendorId, line.poLineId, '60', { number: 'R2-F2' });
    await bills.beginVerification(projectId, { billId: bill.id }, pmc(projectId));

    const first = await verification.verify(projectId, { billId: bill.id }, pmc(projectId), 'r2f2-key');
    expect(first.verdict).toBe('matched');
    const v1 = first.versionId;

    // the claim is amended before the client retries — v1 is superseded and v2 has no verdict
    await bills.amend(projectId, {
      billId: bill.id, reason: 'vendor corrected the delivered quantity',
      lines: [{ poLineId: line.poLineId, quantity: '50', rate: '1' }],
    }, pmc(projectId));

    const replayed = await verification.verify(projectId, { billId: bill.id }, pmc(projectId), 'r2f2-key');
    expect(replayed.verdict).toBe('matched');
    // …and it is the verdict about v1, not a fresh one about v2
    expect(replayed.versionId).toBe(v1);
    expect(await t.prisma.billVerification.count({ where: { projectId, billId: bill.id } })).toBe(1);
  });

  /**
   * R2-F3 — round 1's duplicate fix, one level short. Comparing only quantity and rate made a
   * CORRECTED resubmission indistinguishable from an unchanged one, so a vendor could never fix a
   * rejection whose only defect was tax: the corrected claim was disputed as `duplicate-claim`.
   */
  it('R2-F3 (§E): a resubmission that CORRECTS tax is not a duplicate', async () => {
    const projectId = await freshProject();
    // 100 ordered carrying ₹1,800 tax, all 100 accepted. A 50-unit claim's pro-rata tax cap is
    // ₹900 — and the FULL 100 is accepted deliberately, so the third claim below is judged by the
    // duplicate rule rather than being disputed by §G bound 2 before verification ever runs.
    const line = await issuedMaterialLine(projectId, { qty: '100', baseRate: '1', taxAmount: '1800' });
    await acceptOnLine(projectId, line, '100', '100');

    const over = await claim(projectId, line.vendorId, line.poLineId, '50', { number: 'R2-F3-A', tax: '1800' });
    await bills.beginVerification(projectId, { billId: over.id }, pmc(projectId));
    expect((await verification.verify(projectId, { billId: over.id }, pmc(projectId))).exceptions)
      .toContain('tax-mismatch');
    await bills.reject(projectId, { billId: over.id, reason: 'tax claimed for the full order' }, pmc(projectId));

    // the vendor does exactly what the rejection asked: same quantity and rate, CORRECTED tax
    const fixed = await claim(projectId, line.vendorId, line.poLineId, '50', { number: 'R2-F3-B', tax: '900' });
    await bills.beginVerification(projectId, { billId: fixed.id }, pmc(projectId));
    const verdict = await verification.verify(projectId, { billId: fixed.id }, pmc(projectId));
    expect(verdict.exceptions).not.toContain('duplicate-claim');
    expect(verdict.verdict).toBe('matched');
    expect(await statusOf(projectId, fixed.id)).toBe('verified');

    // …while an UNCHANGED replay of a rejected claim still is a duplicate, so R1-F4 still holds
    const unchanged = await claim(projectId, line.vendorId, line.poLineId, '50', { number: 'R2-F3-C', tax: '900' });
    await bills.beginVerification(projectId, { billId: unchanged.id }, pmc(projectId));
    expect((await verification.verify(projectId, { billId: unchanged.id }, pmc(projectId))).exceptions)
      .toContain('duplicate-claim');
  });

  // ── Codex round-3 findings, reproduce-first ───────────────────────────────────────────────────

  /**
   * R3-F1 — the READ was the THIRD member of "places that report a verdict", and took the same
   * refold-after-dispute failure the verify and replay paths were already fixed for. A claim
   * disputed for over-claiming tax is, by §0's LIVE rule, out of the billed folds — so recomputing
   * reads its own tax as ₹0 against a ₹0 cap and answers `matched`, contradicting both the status
   * and the stored verdict.
   */
  it('R3-F1 (§E): the verification READ reports the recorded verdict, not a refold without the claim', async () => {
    const projectId = await freshProject();
    const line = await issuedMaterialLine(projectId, { qty: '100', baseRate: '1', taxAmount: '1800' });
    await acceptOnLine(projectId, line, '100', '100');
    const over = await claim(projectId, line.vendorId, line.poLineId, '50', { number: 'R3-F1', tax: '1800' });
    await bills.beginVerification(projectId, { billId: over.id }, pmc(projectId));
    const verdict = await verification.verify(projectId, { billId: over.id }, pmc(projectId));
    expect(verdict.exceptions).toContain('tax-mismatch');
    expect(await statusOf(projectId, over.id)).toBe('disputed');

    // the read must agree with the status and the record, not with a fold the claim just left
    const read = await verification.readVerification(projectId, over.id, pmc(projectId));
    expect(read.verdict).toBe('exception');
    expect(read.exceptions).toContain('tax-mismatch');
  });

  /**
   * R3-F2 — the trigger checked that SOME matched verdict existed, which a maintenance path could
   * satisfy by inserting one: fake the verdict, flip the status, and the §E check the arrow exists
   * to enforce is bypassed in two statements. The seal is PROVENANCE — the row must have been
   * produced by `commercial.bill.verify` — rather than a re-derivation of §E in a second language.
   */
  it('R3-F2 (§E): a hand-inserted verdict cannot license `verified`', async () => {
    const projectId = await freshProject();
    const line = await issuedMaterialLine(projectId, { qty: '100', baseRate: '1' });
    await acceptOnLine(projectId, line, '100', '100');
    const bad = await claim(projectId, line.vendorId, line.poLineId, '100', { rate: '2', number: 'R3-F2' });
    await bills.beginVerification(projectId, { billId: bad.id }, pmc(projectId));
    const version = await t.prisma.vendorBillVersion.findFirstOrThrow({
      where: { projectId, billId: bad.id, supersededAt: null },
    });
    // a command that is REAL but is not the verify command
    const other = await t.prisma.commandExecution.findFirstOrThrow({ where: { projectId } });

    await t.prisma.$executeRawUnsafe(
      `INSERT INTO "BillVerification" ("id","projectId","billId","versionId","verdict","verifiedById","sourceCommandId")
       VALUES ('r3f2-forged',$1,$2,$3,'matched',$4,$5)`,
      projectId, bad.id, version.id, f.memberUser.id, other.id,
    );
    await expect(t.prisma.$executeRawUnsafe(
      `UPDATE "VendorBill" SET "status"='verified', "statusChangedAt"=now() WHERE "id"=$1`, bad.id,
    )).rejects.toThrow(/produced by `commercial.bill.verify`/u);
    expect(await statusOf(projectId, bad.id)).toBe('under-verification');
  });

  /**
   * R3-F3 — comparing lines individually let a duplicate hide behind nothing more than a different
   * partitioning: `INV-A` split 60 + 40 and `INV-B` as a single 100 have no exact per-line twin, so
   * the same 100 units verified twice under two document numbers.
   */
  it('R3-F3 (§E): a duplicate cannot hide behind a different line partitioning', async () => {
    const projectId = await freshProject();
    const line = await issuedMaterialLine(projectId, { qty: '200', baseRate: '1' });
    await acceptOnLine(projectId, line, '200', '200');

    // INV-A: 100 units, split across two lines
    const split = await bills.record(projectId, {
      vendorId: line.vendorId, vendorBillNumber: 'R3-F3-A', documentDate: '2026-08-20',
      lines: [
        { poLineId: line.poLineId, quantity: '60', rate: '1' },
        { poLineId: line.poLineId, quantity: '40', rate: '1' },
      ],
    }, pmc(projectId));
    await bills.submit(projectId, { billId: split.id }, pmc(projectId));
    await bills.beginVerification(projectId, { billId: split.id }, pmc(projectId));
    expect((await verification.verify(projectId, { billId: split.id }, pmc(projectId))).verdict).toBe('matched');

    // INV-B: the SAME 100 units as one line — no per-line twin, identical aggregate
    const whole = await claim(projectId, line.vendorId, line.poLineId, '100', { number: 'R3-F3-B' });
    await bills.beginVerification(projectId, { billId: whole.id }, pmc(projectId));
    const verdict = await verification.verify(projectId, { billId: whole.id }, pmc(projectId));
    expect(verdict.exceptions).toContain('duplicate-claim');
    expect(await statusOf(projectId, whole.id)).toBe('disputed');
  });

  // ── Codex round-4 findings, reproduce-first ───────────────────────────────────────────────────

  /**
   * R4-F1 and R4-F2 are the SAME set for the fourth and fifth time — "places that report a
   * verdict" — arriving from the two directions round 3 left open, so they are fixed as one rule
   * and proven as one pair.
   *
   * R4-F1 is the fallback: with no verdict recorded, the read recomputed over §0's LIVE folds, and
   * §0 excludes a `draft`/`disputed`/`rejected`/`resolved` bill from all of them. So the triple was
   * computed against everything EXCEPT the claim being judged, and a claim disputed at SUBMISSION
   * for exceeding its evidence read back as `matched` — a statement about nothing.
   */
  it('R4-F1 (§E): a claim disputed at SUBMISSION does not read as matched', async () => {
    const projectId = await freshProject();
    const line = await issuedMaterialLine(projectId, { qty: '100', baseRate: '1' });
    await acceptOnLine(projectId, line, '100', '50');
    // 100 claimed against 50 accepted — Task 4's §G bound 2 disputes it at submission, and no §E
    // verdict is ever recorded because the claim never reaches verification
    const over = await claim(projectId, line.vendorId, line.poLineId, '100', { number: 'R4-F1' });
    expect(await statusOf(projectId, over.id)).toBe('disputed');
    expect(await t.prisma.billVerification.count({ where: { projectId, billId: over.id } })).toBe(0);

    const read = await verification.readVerification(projectId, over.id, pmc(projectId));
    expect(read.verdict).toBe('exception');
    expect(read.exceptions).toContain('qty-over-accepted');
    // the claim's own 100 is counted back in, which is the whole of the fix
    expect(read.lines[0]!.billedQty).toBe('100');
    expect(read.lines[0]!.evidenceQty).toBe('50');
    expect(read.billStatus).toBe('disputed');
  });

  /**
   * R4-F2 is the recorded half: a withdrawal guard disputes a VERIFIED claim in the reversal's own
   * transaction and appends no verdict, so the last one recorded — `matched` — went on standing and
   * the read reported a match over a dispute. A record answers only while the claim has not moved
   * to a state that contradicts it; otherwise the answer is recomputed, which R4-F1's fix makes
   * honest for a claim §0 has excluded.
   */
  it('R4-F2 (§E): a verdict contradicted by a later dispute is not reported', async () => {
    const projectId = await freshProject();
    const line = await issuedMaterialLine(projectId, { qty: '100', baseRate: '1' });
    const accepted = await acceptOnLine(projectId, line, '100', '100');
    const bill = await claim(projectId, line.vendorId, line.poLineId, '100', { number: 'R4-F2' });
    await underVerification(projectId, bill.id);
    expect((await verification.verify(projectId, { billId: bill.id }, pmc(projectId))).verdict).toBe('matched');

    // …and while that `matched` verdict stands unopposed it IS the answer, so the probe proves a
    // rule rather than a blanket refusal to report records
    expect((await verification.readVerification(projectId, bill.id, pmc(projectId))).verdict).toBe('matched');

    await inventory.reverse(projectId, { txId: accepted.acceptanceTxId, reason: 'quality re-test failed' }, pmc(projectId));
    expect(await statusOf(projectId, bill.id)).toBe('disputed');
    // the stored verdict is untouched — it is history, and history is not rewritten
    const stored = await t.prisma.billVerification.findFirstOrThrow({ where: { projectId, billId: bill.id } });
    expect(stored.verdict).toBe('matched');

    const read = await verification.readVerification(projectId, bill.id, pmc(projectId));
    expect(read.verdict).toBe('exception');
    expect(read.exceptions).toContain('qty-over-accepted');
    expect(read.billStatus).toBe('disputed');
  });

  /**
   * R4-F3 — round 3's provenance seal, one level short. It asked whether a `commercial.bill.verify`
   * command existed behind the verdict, not whether THAT command produced THIS verdict, so an
   * already-spent verify command id copied onto a forged `matched` row walked the status past §E
   * exactly as before. The type was provenance-shaped without being provenance.
   *
   * Two arms, because the reuse and the forgery fail in different places: `(projectId,
   * sourceCommandId)` is UNIQUE, so a spent command cannot produce a second verdict at all; and the
   * `resultRef` binding is checked at COMMIT, where the ledger row is finally complete.
   */
  it('R4-F3 (§E): a verdict must be the one its own verify command PRODUCED', async () => {
    const projectId = await freshProject();
    const line = await issuedMaterialLine(projectId, { qty: '200', baseRate: '1' });
    await acceptOnLine(projectId, line, '200', '200');

    // an honest verification, whose command is now SPENT
    const honest = await claim(projectId, line.vendorId, line.poLineId, '100', { number: 'R4-F3-OK' });
    await underVerification(projectId, honest.id);
    expect((await verification.verify(projectId, { billId: honest.id }, pmc(projectId))).verdict).toBe('matched');
    const spent = await t.prisma.billVerification.findFirstOrThrow({ where: { projectId, billId: honest.id } });
    const command = await t.prisma.commandExecution.findFirstOrThrow({ where: { projectId, id: spent.sourceCommandId } });
    // the ledger row states, in its own column, which verdict it produced
    expect(command.resultRef).toBe(spent.id);
    expect(command.status).toBe('succeeded');

    const bad = await claim(projectId, line.vendorId, line.poLineId, '100', { rate: '2', number: 'R4-F3-BAD' });
    await underVerification(projectId, bad.id);
    const version = await t.prisma.vendorBillVersion.findFirstOrThrow({
      where: { projectId, billId: bad.id, supersededAt: null },
    });

    // ARM 1 — reuse the spent command. One command produces one verdict.
    await expect(t.prisma.$executeRawUnsafe(
      `INSERT INTO "BillVerification" ("id","projectId","billId","versionId","verdict","verifiedById","sourceCommandId")
       VALUES ('r4f3-reuse',$1,$2,$3,'matched',$4,$5)`,
      projectId, bad.id, version.id, f.memberUser.id, spent.sourceCommandId,
    )).rejects.toThrow(/"projectId", "sourceCommandId"|already exists/u);

    // ARM 2a — the platform FLOOR, merged as PR #277 after this finding exposed it. Minting the
    // receipt this forgery needs is now refused one level below §E: a receipt is INSERTED
    // `reserved` and becomes terminal only by completing.
    await expect(t.prisma.commandExecution.create({
      data: {
        scopeKind: 'project', organizationId: f.orgA.id, projectId, actorId: f.memberUser.id,
        commandType: 'commercial.bill.verify', idempotencyKey: `r4f3-mint-${seq++}`,
        requestHash: 'forged', status: 'succeeded', resultRef: 'some-other-entity',
      },
    })).rejects.toThrow(/INSERTED as `reserved`/u);

    // ARM 2b — …and §E's OWN seal still holds against a receipt built through the protocol. This
    // is the arm that matters now: the receipt below is perfectly well formed — reserved and
    // completed in one transaction, carrying a real result — it simply produced something that is
    // not this verdict. `resultRef` is the binding, and the status flip fails at COMMIT.
    const forged = await t.prisma.$transaction(async (tx) => {
      const row = await tx.commandExecution.create({
        data: {
          scopeKind: 'project', organizationId: f.orgA.id, projectId, actorId: f.memberUser.id,
          commandType: 'commercial.bill.verify', idempotencyKey: `r4f3-forged-${seq++}`,
          requestHash: 'forged', status: 'reserved',
        },
        select: { id: true },
      });
      await tx.commandExecution.update({
        where: { id: row.id },
        data: { status: 'succeeded', resultRef: 'some-other-entity', completedAt: new Date() },
      });
      return row;
    });
    await t.prisma.$executeRawUnsafe(
      `INSERT INTO "BillVerification" ("id","projectId","billId","versionId","verdict","verifiedById","sourceCommandId")
       VALUES ('r4f3-forged',$1,$2,$3,'matched',$4,$5)`,
      projectId, bad.id, version.id, f.memberUser.id, forged.id,
    );
    await expect(t.prisma.$executeRawUnsafe(
      `UPDATE "VendorBill" SET "status"='verified', "statusChangedAt"=now() WHERE "id"=$1`, bad.id,
    )).rejects.toThrow(/PRODUCED|resultRef|result/u);
    expect(await statusOf(projectId, bad.id)).toBe('under-verification');
  });

  /**
   * R4-F4 — round 1 opened `verified -> submitted` because `amend` has always taken it, and opened
   * it without requiring the amendment. A bare status flip then re-opened a verified claim for
   * re-verification with no new claim behind it: the same "a status is not a fact" defect the
   * `verified` arrow itself was found for, one arrow along.
   */
  it('R4-F4 (§F): `verified -> submitted` requires the amendment that justifies it', async () => {
    const projectId = await freshProject();
    const line = await issuedMaterialLine(projectId, { qty: '100', baseRate: '1' });
    await acceptOnLine(projectId, line, '100', '100');
    const bill = await claim(projectId, line.vendorId, line.poLineId, '60', { number: 'R4-F4' });
    await underVerification(projectId, bill.id);
    expect((await verification.verify(projectId, { billId: bill.id }, pmc(projectId))).verdict).toBe('matched');

    await expect(t.prisma.$executeRawUnsafe(
      `UPDATE "VendorBill" SET "status"='submitted', "statusChangedAt"=now() WHERE "id"=$1`, bill.id,
    )).rejects.toThrow(/AMENDED/u);
    expect(await statusOf(projectId, bill.id)).toBe('verified');

    // …and the honest path is UNCHANGED, which is what makes the refusal above evidence rather
    // than a seal that refuses everything
    const amended = await bills.amend(projectId, {
      billId: bill.id, reason: 'vendor corrected the delivered quantity',
      lines: [{ poLineId: line.poLineId, quantity: '50', rate: '1' }],
    }, pmc(projectId));
    expect(amended.status).toBe('submitted');
  });

  /**
   * R4-F5 — `verdict` has carried a CHECK since the first head while `exceptions` accepted any text
   * at all, so an `exception` verdict could be recorded as `['looks wrong']` or a typo of a real
   * kind and satisfy every constraint on the table. §E names six kinds and each names its own
   * check; a seventh string is a defect that reads as a verdict.
   */
  it('R4-F5 (§E): an exception names a KIND §E defines, and nothing else', async () => {
    const projectId = await freshProject();
    const line = await issuedMaterialLine(projectId, { qty: '100', baseRate: '1' });
    await acceptOnLine(projectId, line, '100', '100');
    const bill = await claim(projectId, line.vendorId, line.poLineId, '60', { number: 'R4-F5' });
    await underVerification(projectId, bill.id);
    const version = await t.prisma.vendorBillVersion.findFirstOrThrow({
      where: { projectId, billId: bill.id, supersededAt: null },
    });
    const command = await t.prisma.commandExecution.findFirstOrThrow({ where: { projectId } });
    const insert = (id: string, kinds: string) => t.prisma.$executeRawUnsafe(
      `INSERT INTO "BillVerification" ("id","projectId","billId","versionId","verdict","exceptions","verifiedById","sourceCommandId")
       VALUES ($1,$2,$3,$4,'exception',${kinds},$5,$6)`,
      id, projectId, bill.id, version.id, f.memberUser.id, command.id,
    );

    await expect(insert('r4f5-prose', `ARRAY['looks wrong']::TEXT[]`))
      .rejects.toThrow(/BillVerification_exception_kinds/u);
    await expect(insert('r4f5-typo', `ARRAY['qty-over-acceptedd']::TEXT[]`))
      .rejects.toThrow(/BillVerification_exception_kinds/u);
    // a NULL element passes `<@` on its own — containment involving NULL is NULL, and a CHECK
    // passes on NULL — which is why the constraint tests for it separately
    await expect(insert('r4f5-null', `ARRAY[NULL]::TEXT[]`))
      .rejects.toThrow(/BillVerification_exception_kinds/u);
    // …and a real kind is ACCEPTED, so the constraint is precise rather than merely strict
    await insert('r4f5-real', `ARRAY['rate-mismatch']::TEXT[]`);
    expect((await t.prisma.billVerification.findFirstOrThrow({ where: { id: 'r4f5-real' } })).exceptions)
      .toEqual(['rate-mismatch']);
  });

  /**
   * The DERIVED closure for R4-F5's set. The exception vocabulary now lives in two places — the
   * `@vitan/shared` const the service builds verdicts from, and the CHECK PostgreSQL enforces —
   * and two hand-kept copies of one set is the root this PR's convergence audit names. So the
   * copies are not left to memory: the CHECK is read back out of `pg_constraint` and compared, in
   * BOTH directions, against the shared const.
   */
  it('R4-F5 (closure): the CHECK vocabulary and `VERIFICATION_EXCEPTION_KINDS` are the SAME set', async () => {
    const [row] = await t.prisma.$queryRawUnsafe<Array<{ def: string }>>(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'BillVerification_exception_kinds'`,
    );
    expect(row, 'the exception-kind CHECK must exist').toBeTruthy();
    const inSql = [...row!.def.matchAll(/'([^']+)'/gu)].map((m) => m[1]!).sort();
    expect(inSql).toEqual([...VERIFICATION_EXCEPTION_KINDS].sort());
  });

  // ── Codex round-5 findings, reproduce-first ───────────────────────────────────────────────────

  /**
   * R5-F2 — the round-4 provenance seal hung on `VendorBill` alone, so it asked its question only
   * when the STATUS moved. But the predicate names the LIVE VERSION, and the live version moves
   * from the other side: supersede the matched v1 and insert a v2 at twice the rate, leave the bill
   * untouched at `verified`, and nothing re-asked. The claim stayed verified against a verdict about
   * a version that no longer existed.
   *
   * Two triggers now fire ONE predicate. The three statements run in a SINGLE transaction, because
   * that is the shape the attack has and because the seal is deferred to COMMIT — a statement at a
   * time would trip the Task-4 "a bill always has a live version" seal first and prove nothing.
   */
  it('R5-F2 (§E/§F): superseding a VERIFIED claim\'s version cannot leave it verified', async () => {
    const projectId = await freshProject();
    const line = await issuedMaterialLine(projectId, { qty: '100', baseRate: '1' });
    await acceptOnLine(projectId, line, '100', '100');
    const bill = await claim(projectId, line.vendorId, line.poLineId, '60', { number: 'R5-F2' });
    await underVerification(projectId, bill.id);
    expect((await verification.verify(projectId, { billId: bill.id }, pmc(projectId))).verdict).toBe('matched');
    const v1 = await t.prisma.vendorBillVersion.findFirstOrThrow({
      where: { projectId, billId: bill.id, supersededAt: null },
    });

    // the amendment done at the VERSION layer, bypassing the service that would move the status
    await expect(t.prisma.$transaction([
      t.prisma.$executeRawUnsafe(
        // a Task-4 CHECK requires the reason, so the forgery supplies one — otherwise this probe
        // would be rejected by a DIFFERENT seal and prove nothing about the one under test
        `UPDATE "VendorBillVersion" SET "supersededAt"=now(), "supersededById"=$1, "supersedeReason"='hand amendment' WHERE "id"=$2`,
        f.memberUser.id, v1.id,
      ),
      t.prisma.$executeRawUnsafe(
        `INSERT INTO "VendorBillVersion"("id","projectId","billId","vendorIdPin","version","supersedesVersion","claimedAmount","lineCount","createdById")
         VALUES ('r5f2-v2',$1,$2,$3,2,1,120.00,1,$4)`,
        projectId, bill.id, line.vendorId, f.memberUser.id,
      ),
      t.prisma.$executeRawUnsafe(
        `INSERT INTO "VendorBillLine"("id","projectId","versionId","billId","vendorId","type","poLineId","quantity","rate","taxAmount","freightAmount","amount")
         VALUES ('r5f2-l2',$1,'r5f2-v2',$2,$3,'material',$4,60,2,0,0,120.00)`,
        projectId, bill.id, line.vendorId, line.poLineId,
      ),
    ])).rejects.toThrow(/live AT COMMIT|PRODUCED/u);

    // nothing moved: v1 is still the live claim and the bill is still verified BECAUSE of its verdict
    expect(await statusOf(projectId, bill.id)).toBe('verified');
    const live = await t.prisma.vendorBillVersion.findFirstOrThrow({
      where: { projectId, billId: bill.id, supersededAt: null },
    });
    expect(live.id).toBe(v1.id);

    // …and the honest amendment through the service — which moves the bill to `submitted` in the
    // SAME transaction — is unaffected, so the seal is precise rather than merely strict
    const amended = await bills.amend(projectId, {
      billId: bill.id, reason: 'vendor corrected the delivered quantity',
      lines: [{ poLineId: line.poLineId, quantity: '50', rate: '1' }],
    }, pmc(projectId));
    expect(amended.status).toBe('submitted');
  });

  /**
   * R5-F3 — the read preferred the RECORDED verdict for every non-contradicted status, so a
   * recorded exception could never be neutralised by later live evidence even though §E is an
   * AGGREGATE fold. That branch existed only to work around the broken recomputation round 3
   * found and round 4 repaired, so it is removed rather than made two-sided: the read derives, per
   * §E's own opening sentence, and the record stays what the replay returns and what history holds.
   */
  it('R5-F3 (§E): a recorded exception does not outlive the fold that produced it', async () => {
    const projectId = await freshProject();
    const line = await issuedMaterialLine(projectId, { qty: '100', baseRate: '1', taxAmount: '1800' });
    await acceptOnLine(projectId, line, '100', '100');

    // 50 units claiming the WHOLE Rs.1,800 against a Rs.900 pro-rata cap — disputed at verification
    const over = await claim(projectId, line.vendorId, line.poLineId, '50', { number: 'R5-F3-A', tax: '1800' });
    await underVerification(projectId, over.id);
    const verdict = await verification.verify(projectId, { billId: over.id }, pmc(projectId));
    expect(verdict.exceptions).toContain('tax-mismatch');
    expect(await statusOf(projectId, over.id)).toBe('disputed');

    // a SECOND live claim for the other 50 units, claiming no tax: the aggregate is now 1800 of a
    // 1800 cap, so §E's fold no longer has the exception it had
    await claim(projectId, line.vendorId, line.poLineId, '50', { number: 'R5-F3-B', tax: '0' });

    const read = await verification.readVerification(projectId, over.id, pmc(projectId));
    expect(read.verdict).toBe('matched');
    expect(read.exceptions).toEqual([]);
    // …and the claim is still DISPUTED, which is the point of carrying both: §E is explicit that an
    // exception "does not auto-reject", so it takes an attributable amendment to move the claim —
    // a recomputation that now agrees does not undo the dispute
    expect(read.billStatus).toBe('disputed');

    // the recorded verdict is untouched history, and still what a REPLAY of that call returns
    const stored = await t.prisma.billVerification.findFirstOrThrow({ where: { projectId, billId: over.id } });
    expect(stored.verdict).toBe('exception');
    expect(stored.exceptions).toContain('tax-mismatch');
  });
});
