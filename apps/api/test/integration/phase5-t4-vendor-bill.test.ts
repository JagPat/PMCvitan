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
import { CommercialMeasurementService } from '../../src/commercial/commercial-measurement.service';
import { CapabilitiesService, LABOUR_CAPABILITY, MATERIALS_CAPABILITY } from '../../src/platform/capabilities.service';
import { lockProjectReadiness } from '../../src/common/readiness-lock';
import type { AuthUser } from '../../src/common/auth';
import type { CreateRequirementInput } from '../../src/contracts';

/**
 * Phase 5 Task 4 — the §F VENDOR BILL and the §G conservation bounds 1–2, proven live against
 * PostgreSQL, reproduce-first.
 *
 *   4    §G bound 2 + §E disposition — a 101-unit claim against 100 accepted is DISPUTED, not
 *        refused; an 80/20 receipt supports an honest 80-unit bill; reversing an acceptance
 *        under a live claim disputes it
 *   5    §G bound 2 RACE — two concurrent submissions with capacity for one, deterministic
 *        barrier, exactly one lands live
 *   5ac  §0 `disputed` leaves the live fold, so the honest corrected claim can be submitted, and
 *        the disputed version stays readable with its claimed quantity
 *   5av  §F a disputed version never returns to live — resolution issues a NEW version
 *   5d   §F an amended bill (v1 100 → v2 100) folds to 100, not 200
 *   5an  §E the reversal disposition is driven by the AGGREGATE and disputes the MINIMUM
 *   5bl  §D a reducing measurement correction DISPUTES uncertified claims (the labour twin)
 *   5bf  §F a bill line names EXACTLY ONE PO line at PostgreSQL — the seal is precise
 *   5bg  §F the duplicate-claim key is non-blank, frozen, and unique among live claims
 *   5bj  §F the duplicate index releases on the lifecycle's OWN terminal states
 *   5ag  §0b sign discipline is PER COLUMN
 *   5au  §E a labour claim line's tax and freight are refused at PG
 *   5f   §F vendor pinning is PG-enforced within ONE project
 *   5ax  §F the vendor-pinning migration BACKFILLS every existing line from its own chain
 *   5h   §0 unit discipline — bound 1 compares UNITS to units
 *   7    §F append-only — PG rejects an UPDATE/DELETE of a claim line and a superseded version
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

describe('Phase 5 Task 4 — §F vendor bill + §G bounds 1–2 (live PG)', () => {
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
  let budgetQuery: CommercialBudgetQuery;
  let measurement: CommercialMeasurementService;
  let capabilities: CapabilitiesService;
  let seq = 0;

  const TRUNCATE =
    'TRUNCATE TABLE "Payment", "PaymentApproval", "BillDeductionRelease", "BillDeduction", "SodException", "SodGrant", "CertifiedMeasurementConsumption", "CertifiedAcceptanceConsumption", "BillCertificate", "BillVerification", "VendorBillLine", "VendorBillVersion", "VendorBill", "DomainEvent", "OutboxDelivery", "ProcessedEvent", "ProjectionCursor", "ProjectionGeneration", "DecisionProjection", "DailyLogProjection", "DrawingsProjection", "InspectionsProjection", "ActivitiesProjection", "MaterialReadinessProjection", "LabourReadinessProjection", "Measurement", "BudgetException", "BudgetLine", "CommitmentAttribution", "CostHead", "LabourMismatchResolution", "LabourMismatch", "ActivityWorkOutput", "LabourWorkFact", "WorkerAllocation", "LabourAttendance", "ApprovedSkillSubstitution", "CapacityPromise", "CapacityCommitment", "LabourPurchaseOrderLine", "LabourPurchaseOrderVersion", "LabourPurchaseOrder", "LabourQuoteComparison", "SupplierLabourQuoteLine", "SupplierLabourQuote", "LabourRfq", "LabourRequisitionLine", "LabourRequisition", "VendorLabourProfile", "StockTransaction", "MaterialIssue", "StockLot", "DeliveryPromise", "DeliveryCommitment", "PurchaseOrderLine", "PurchaseOrderVersion", "PurchaseOrder", "VendorQuoteLine", "QuoteComparison", "VendorQuote", "Rfq", "RequisitionLine", "Requisition", "ProjectVendor", "CommandExecution", "CrewMembership", "Crew", "WorkerDevice", "WorkerSkill", "Worker", "ApprovedSubstitution", "LabourDemandSlice", "LabourRequirementSpec", "LabourTrade", "LabourSkill", "MaterialRequirementSpec", "ActivityRequirement", "ActivityRequirementRoot", "DecisionApprovalRevision", "ProjectCapability" CASCADE';

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
    budget = t.app.get(CommercialBudgetService);
    budgetQuery = t.app.get(CommercialBudgetQuery);
    measurement = t.app.get(CommercialMeasurementService);
    capabilities = t.app.get(CapabilitiesService);
  });
  afterAll(async () => {
    await t?.prisma.$executeRawUnsafe(TRUNCATE);
    await t?.prisma.vendor.deleteMany({ where: { orgId: f.orgA.id } });
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

  // ── PROBE 4 / 5ak — the bound-2 disposition is a DISPUTE, not a refusal ───────────────────────

  it('PROBE 4/5ak (§G/§E): an over-accepted claim is DISPUTED not refused, an 80/20 receipt bills 80 cleanly, and a later reversal disputes a live claim', async () => {
    const projectId = await freshProject();
    // ORDERED 120, ACCEPTED 100. The order matters: with 100 ordered as well, bound 1 fires first
    // and the probe would pass while proving nothing about bound 2 — the ordered authority would
    // be doing all the work and the accepted-evidence comparison would never run.
    const line = await issuedMaterialLine(projectId, { qty: '120', baseRate: '1' });
    await acceptOnLine(projectId, line, '100', '100');

    // 101 against 100 accepted. The claim is RECORDED — the vendor's actual claim stays readable,
    // which is the evidence the dispute is about — and it lands `disputed`, so §0's LIVE rule
    // keeps it out of the billed fold and nothing can certify against it.
    const over = await claim(projectId, line.vendorId, line.poLineId, '101');
    expect(over.status).toBe('disputed');
    expect(over.statusReason).toMatch(/qty-over-accepted/u);
    expect(over.versions[0]!.lines[0]!.quantity).toBe('101'); // the claim itself is not edited
    expect(await billedQty(projectId, line.poLineId)).toBe('0');

    // an 80-accepted / 20-REJECTED receipt supports an honest 80-unit bill with NO dispute.
    // `ACCEPTED` per §0 is the acceptance-EVENT fold, not `accepted − rejected`, which would
    // understate this line as 60 and dispute a perfectly good claim.
    const split = await issuedMaterialLine(projectId, { qty: '100', baseRate: '1' });
    await acceptOnLine(projectId, split, '100', '80', '20');
    const honest = await claim(projectId, split.vendorId, split.poLineId, '80');
    expect(honest.status).toBe('submitted');
    expect(await billedQty(projectId, split.poLineId)).toBe('80');

    // …and REVERSING that acceptance under the live claim disputes it rather than committing
    // silently. This is the withdrawal guard Task 4 ships because Task 4 is the first tree in
    // which a live claim exists at all.
    const acceptance = await t.prisma.stockTransaction.findFirstOrThrow({
      where: { projectId, type: 'acceptance', lot: { is: { poLineId: split.poLineId } } },
    });
    await inventory.reverse(projectId, { txId: acceptance.id, reason: 'quality re-test failed' }, pmc(projectId));
    expect(await statusOf(projectId, honest.id)).toBe('disputed');
    expect(await billedQty(projectId, split.poLineId)).toBe('0');
  });

  // ── PROBE 5ac / 5av — a disputed version leaves the fold and never returns ────────────────────

  it('PROBE 5ac/5av (§0/§F): a dispute frees the fold so the corrected claim can be submitted, and the disputed version stays terminal history', async () => {
    const projectId = await freshProject();
    const line = await issuedMaterialLine(projectId, { qty: '120', baseRate: '1' });
    await acceptOnLine(projectId, line, '100', '100');

    const over = await claim(projectId, line.vendorId, line.poLineId, '120', { number: 'V-1' });
    expect(over.status).toBe('disputed');

    // RESOLUTION is a NEW version. The disputed one does not move back to live: doing so would
    // make `BILLED_QTY` 120 again BEFORE the quantity changed, break bound 2, and block the very
    // correction the dispute exists to enable.
    const resolved = await bills.amend(projectId, {
      billId: over.id, reason: 'vendor corrected the claim to the delivered quantity',
      lines: [{ poLineId: line.poLineId, quantity: '100', rate: '1' }],
    }, pmc(projectId));
    expect(resolved.status).toBe('resolved');
    expect(resolved.versions).toHaveLength(2);
    expect(resolved.versions[0]).toMatchObject({ version: 1, live: false });
    // the record of what was CLAIMED is never edited — the disputed 120 is still readable
    expect(resolved.versions[0]!.lines[0]!.quantity).toBe('120');
    expect(resolved.versions[1]).toMatchObject({ version: 2, supersedesVersion: 1 });

    // `resolved` is terminal and NOT live, so the fold is free for the honest corrected claim
    expect(await billedQty(projectId, line.poLineId)).toBe('0');
    const corrected = await claim(projectId, line.vendorId, line.poLineId, '100', { number: 'V-1' });
    expect(corrected.status).toBe('submitted');
    expect(await billedQty(projectId, line.poLineId)).toBe('100');

    // and PostgreSQL itself refuses to revive the terminal one
    await expect(
      t.prisma.$executeRawUnsafe(`UPDATE "VendorBill" SET "status"='under-verification' WHERE "id"=$1`, over.id),
    ).rejects.toThrow(/cannot move from/u);
  });

  // ── PROBE 5d — an amended bill is ONE claim, not two ──────────────────────────────────────────

  it('PROBE 5d (§0/§F): v1 100 → v2 100 folds to 100, and the retained version is not a live claim', async () => {
    const projectId = await freshProject();
    const line = await issuedMaterialLine(projectId, { qty: '200', baseRate: '2' });
    await acceptOnLine(projectId, line, '100', '100');

    const bill = await claim(projectId, line.vendorId, line.poLineId, '100', { rate: '2' });
    expect(bill.versions[0]!.claimedAmount).toBe('200');
    expect(await billedQty(projectId, line.poLineId)).toBe('100');

    // the SAME quantity at a corrected rate. A retained version is history, not an outstanding
    // claim — folding both would read 200 units against 100 accepted and dispute an honest fix.
    const amended = await bills.amend(projectId, {
      billId: bill.id, reason: 'rate corrected to the ordered rate',
      lines: [{ poLineId: line.poLineId, quantity: '100', rate: '1' }],
    }, pmc(projectId));
    expect(amended.status).toBe('submitted');
    expect(amended.versions.map((v) => [v.version, v.claimedAmount, v.live])).toEqual([[1, '200', false], [2, '100', true]]);
    expect(await billedQty(projectId, line.poLineId)).toBe('100');
  });

  // ── PROBE 5an — the disposition disputes the MINIMUM, newest first ────────────────────────────

  it('PROBE 5an (§E): the reversal disposition is driven by the AGGREGATE fold and disputes only what it must', async () => {
    const projectId = await freshProject();

    // accept 100, bill 80, reverse 20 → the fold is 80 ≤ 80, so the claim stays LIVE
    const a = await issuedMaterialLine(projectId, { qty: '100', baseRate: '1' });
    const lotA = await inventory.recordReceipt(projectId, { poLineId: a.poLineId, commitmentId: a.commitmentId, storeLocation: 'main', purchaseQty: '100' }, pmc(projectId));
    await inventory.accept(projectId, { lotId: lotA.id, storeLocation: 'main', qty: '80', qualityResult: 'pass', evidenceMediaId: await freshMedia(projectId) }, pmc(projectId));
    const second = await inventory.accept(projectId, { lotId: lotA.id, storeLocation: 'main', qty: '20', qualityResult: 'pass', evidenceMediaId: await freshMedia(projectId) }, pmc(projectId));
    const bill80 = await claim(projectId, a.vendorId, a.poLineId, '80');
    expect(bill80.status).toBe('submitted');
    const twentyTx = await t.prisma.stockTransaction.findFirstOrThrow({
      where: { projectId, lotId: lotA.id, type: 'acceptance', qty: new Prisma.Decimal('20') },
    });
    void second;
    await inventory.reverse(projectId, { txId: twentyTx.id, reason: 'mis-counted pallet' }, pmc(projectId));
    expect(await statusOf(projectId, bill80.id)).toBe('submitted'); // 80 <= 80 — nothing to do

    // the case a PER-CLAIM rule gets wrong: accept 100, bill 60 AND 40, reverse 20. Neither claim
    // is individually over 80, the fold is 100, so the NEWEST (40) is disputed and the older (60)
    // is left live — ending at 60 <= 80.
    const b = await issuedMaterialLine(projectId, { qty: '100', baseRate: '1' });
    const lotB = await inventory.recordReceipt(projectId, { poLineId: b.poLineId, commitmentId: b.commitmentId, storeLocation: 'main', purchaseQty: '100' }, pmc(projectId));
    await inventory.accept(projectId, { lotId: lotB.id, storeLocation: 'main', qty: '80', qualityResult: 'pass', evidenceMediaId: await freshMedia(projectId) }, pmc(projectId));
    const twenty = await inventory.accept(projectId, { lotId: lotB.id, storeLocation: 'main', qty: '20', qualityResult: 'pass', evidenceMediaId: await freshMedia(projectId) }, pmc(projectId));
    const older = await claim(projectId, b.vendorId, b.poLineId, '60');
    const newer = await claim(projectId, b.vendorId, b.poLineId, '40');
    expect(await billedQty(projectId, b.poLineId)).toBe('100');
    const twentyB = await t.prisma.stockTransaction.findFirstOrThrow({
      where: { projectId, lotId: lotB.id, type: 'acceptance', qty: new Prisma.Decimal('20') },
    });
    void twenty;
    await inventory.reverse(projectId, { txId: twentyB.id, reason: 'mis-counted pallet' }, pmc(projectId));
    expect(await statusOf(projectId, newer.id)).toBe('disputed');
    expect(await statusOf(projectId, older.id)).toBe('submitted');
    expect(await billedQty(projectId, b.poLineId)).toBe('60');
  });

  // ── PROBE 5bl — the LABOUR twin: a reducing measurement correction disputes ───────────────────

  it('PROBE 5bl (§D): a reducing measurement correction DISPUTES uncertified claims and lands, instead of being blocked by them', async () => {
    const projectId = await freshProject();
    const line = await labourMeasurableLine(projectId, 2);
    const taken = await measurement.take(projectId, {
      labourPoLineId: line.poLineId, activityId: line.activityId, quantity: '2', citedOutputId: line.outputId,
    }, pmc(projectId));

    const recorded = await bills.record(projectId, {
      vendorId: line.vendorId, vendorBillNumber: 'L-1', documentDate: '2026-08-20',
      lines: [{ labourPoLineId: line.poLineId, quantity: '2', rate: '1000' }],
    }, pmc(projectId));
    const bill = await bills.submit(projectId, { billId: recorded.id }, pmc(projectId));
    expect(bill.status).toBe('submitted');
    expect(bill.versions[0]!.claimedAmount).toBe('2000');

    // the engineer discovers the real figure is 1 shift. An earlier plan revision refused this
    // whenever live `BILLED_QTY` would exceed the new total, which blocks the site from fixing
    // its own record on the strength of a bill NOBODY has verified. The correction LANDS and the
    // claim is disputed.
    await measurement.correct(projectId, { measurementId: taken.id, quantity: '-1', reason: 'one shift was a re-do' }, pmc(projectId));
    expect(await statusOf(projectId, bill.id)).toBe('disputed');
    expect((await measurement.read(projectId, line.poLineId, pmc(projectId))).measured).toBe('1');

    // …and the honest corrected claim then submits against the corrected evidence
    const fixed = await bills.record(projectId, {
      vendorId: line.vendorId, vendorBillNumber: 'L-2', documentDate: '2026-08-21',
      lines: [{ labourPoLineId: line.poLineId, quantity: '1', rate: '1000' }],
    }, pmc(projectId));
    expect((await bills.submit(projectId, { billId: fixed.id }, pmc(projectId))).status).toBe('submitted');
  });

  // ── PROBE 5 — the bound-2 RACE ────────────────────────────────────────────────────────────────

  const readinessWaiters = async (): Promise<number> => {
    const rows = await t.prisma.$queryRaw<Array<{ c: number }>>`
      SELECT COUNT(*)::int AS c FROM pg_stat_activity
      WHERE wait_event_type = 'Lock' AND wait_event = 'advisory'
        AND query LIKE '%pg_advisory_xact_lock%'`;
    return rows[0]!.c;
  };
  const waitForReadinessWaiters = async (n: number): Promise<void> => {
    for (let i = 0; i < 400; i++) {
      if ((await readinessWaiters()) >= n) return;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error(`barrier timeout: expected ${n} readiness-lock waiter(s)`);
  };

  /**
   * The DATABASE half of probe 5, and the one that actually proves the §G lesson.
   *
   * The service-path probe below is serialized by `lockProjectReadiness`, which every commercial
   * command takes — so it proves the BOUND holds under a race, but it does NOT prove the PO-line
   * lock is load-bearing: removing the `FOR UPDATE` from the participant leaves it green. This
   * probe removes the readiness lock from the picture entirely by driving two INDEPENDENT
   * PostgreSQL sessions straight at the rows, which is exactly the shape §G names: "a trigger
   * that counts without serializing is not an invariant" (the Phase-4 Task-3 F3 lesson).
   *
   * Both sessions flip a `draft` claim to `submitted` — the transition that makes a version's
   * lines LIVE — and both hold their transaction open until the other has written, so neither can
   * see the other's row when it makes its own change. The deferred bound trigger then runs at
   * COMMIT, takes `FOR UPDATE` on the purchase-order line before counting, and the second one to
   * arrive re-counts with the first's claim visible and is rejected. Without that lock both count
   * 100 against 100 accepted, both pass, and 200 units of live claim stand against 100 delivered.
   */
  it('PROBE 5 (§G, DATABASE): two independent sessions making one claim live each — the deferred trigger serializes and exactly one commits', async () => {
    const projectId = await freshProject();
    const line = await issuedMaterialLine(projectId, { qty: '200', baseRate: '1' });
    await acceptOnLine(projectId, line, '100', '100');

    // two DRAFT claims of 100 each. A draft's lines are not live, so nothing is bounded yet and
    // both can be recorded — the breach only becomes possible at the transition.
    const a = await bills.record(projectId, { vendorId: line.vendorId, vendorBillNumber: 'DB-A', documentDate: '2026-08-20', lines: [{ poLineId: line.poLineId, quantity: '100', rate: '1' }] }, pmc(projectId));
    const b = await bills.record(projectId, { vendorId: line.vendorId, vendorBillNumber: 'DB-B', documentDate: '2026-08-20', lines: [{ poLineId: line.poLineId, quantity: '100', rate: '1' }] }, pmc(projectId));

    const { PrismaClient } = await import('@prisma/client');
    const s1 = new PrismaClient();
    const s2 = new PrismaClient();
    try {
      let wroteA!: () => void;
      let wroteB!: () => void;
      const aWrote = new Promise<void>((r) => (wroteA = r));
      const bWrote = new Promise<void>((r) => (wroteB = r));
      const flip = (client: InstanceType<typeof PrismaClient>, billId: string, signal: () => void, other: Promise<void>) =>
        client.$transaction(async (tx) => {
          await tx.$executeRawUnsafe(`UPDATE "VendorBill" SET "status"='submitted', "statusChangedAt"=now() WHERE "id"=$1 AND "status"='draft'`, billId);
          signal();
          // hold the transaction open until the OTHER session has written too, so neither made
          // its decision with the other's row visible — the interleaving the lock must survive
          await other;
        }, { timeout: 20_000, maxWait: 10_000 });

      const settled = await Promise.allSettled([
        flip(s1, a.id, wroteA, bWrote),
        flip(s2, b.id, wroteB, aWrote),
      ]);
      expect(settled.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      const failure = settled.find((r) => r.status === 'rejected') as PromiseRejectedResult;
      expect(String(failure.reason)).toMatch(/Bound 2 breached/u);
    } finally {
      await s1.$disconnect();
      await s2.$disconnect();
    }

    // exactly 100 units of LIVE claim stand against the 100 accepted — never 200
    expect(await billedQty(projectId, line.poLineId)).toBe('100');
    const statuses = [await statusOf(projectId, a.id), await statusOf(projectId, b.id)].sort();
    expect(statuses).toEqual(['draft', 'submitted']);
  });

  it('PROBE 5 (§G, SERVICE): two concurrent submissions with capacity for ONE — exactly one lands live, deterministically', async () => {
    const projectId = await freshProject();
    const line = await issuedMaterialLine(projectId, { qty: '100', baseRate: '1' });
    await acceptOnLine(projectId, line, '100', '100');

    // both claims are RECORDED first (drafts hold no capacity), then submitted concurrently
    const a = await bills.record(projectId, { vendorId: line.vendorId, vendorBillNumber: 'R-A', documentDate: '2026-08-20', lines: [{ poLineId: line.poLineId, quantity: '100', rate: '1' }] }, pmc(projectId));
    const b = await bills.record(projectId, { vendorId: line.vendorId, vendorBillNumber: 'R-B', documentDate: '2026-08-20', lines: [{ poLineId: line.poLineId, quantity: '100', rate: '1' }] }, pmc(projectId));

    let release!: () => void;
    let acquired!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const held = new Promise<void>((r) => (acquired = r));
    const holder = t.prisma.$transaction(
      async (tx) => { await lockProjectReadiness(tx, projectId); acquired(); await gate; },
      { timeout: 20_000, maxWait: 10_000 },
    );
    await held;
    const raceA = bills.submit(projectId, { billId: a.id }, pmc(projectId));
    await waitForReadinessWaiters(1);
    const raceB = bills.submit(projectId, { billId: b.id }, pmc(projectId));
    await waitForReadinessWaiters(2);
    release();
    await holder;
    const [ra, rb] = await Promise.allSettled([raceA, raceB]);

    // Both COMMIT — neither is refused, because §G's disposition is a dispute — but exactly ONE
    // is live. The one enqueued second folds the first's 100 into `BILLED_QTY`, sees 200 against
    // 100 accepted, and is disputed. An unserialized check would let both read 0 and both pass.
    expect(ra.status).toBe('fulfilled');
    expect(rb.status).toBe('fulfilled');
    expect((ra as PromiseFulfilledResult<{ status: string }>).value.status).toBe('submitted');
    expect((rb as PromiseFulfilledResult<{ status: string }>).value.status).toBe('disputed');
    expect(await billedQty(projectId, line.poLineId)).toBe('100');
  });

  // ── PROBE 5bf / 5ag / 5au — the line seals are PRECISE, not merely strict ─────────────────────

  it('PROBE 5bf/5ag/5au (§F/§0b): a claim line names EXACTLY one PO line, signs are per column, and a labour line carries no tax', async () => {
    const projectId = await freshProject();
    const line = await issuedMaterialLine(projectId, { qty: '100', baseRate: '1' });
    await acceptOnLine(projectId, line, '100', '100');
    const labourLine = await labourMeasurableLine(projectId, 2);
    await measurement.take(projectId, { labourPoLineId: labourLine.poLineId, activityId: labourLine.activityId, quantity: '2', citedOutputId: labourLine.outputId }, pmc(projectId));

    // BOTH valid shapes are ACCEPTED — the seal is precise, not merely strict
    const material = await claim(projectId, line.vendorId, line.poLineId, '100', { tax: '0', freight: '0' });
    expect(material.status).toBe('submitted');
    const labourClaim = await bills.record(projectId, {
      vendorId: labourLine.vendorId, vendorBillNumber: 'L-OK', documentDate: '2026-08-20',
      lines: [{ labourPoLineId: labourLine.poLineId, quantity: '2', rate: '1000' }],
    }, pmc(projectId));
    expect((await bills.submit(projectId, { billId: labourClaim.id }, pmc(projectId))).status).toBe('submitted');

    // …and every degenerate shape is refused AT POSTGRESQL, not merely by the service
    const versionId = material.versions[0]!.id;
    const insert = (cols: string, vals: string) =>
      t.prisma.$executeRawUnsafe(
        `INSERT INTO "VendorBillLine" ("id","projectId","versionId","billId","vendorId",${cols}) VALUES ('hostile-${seq++}',$1,$2,$3,$4,${vals})`,
        projectId, versionId, material.id, line.vendorId,
      );
    // NEITHER reference: money would enter `BILLED_AMOUNT` with no PO line for any bound to fold
    await expect(insert(`"type","quantity","rate","taxAmount","freightAmount","amount"`, `'material',1,1,0,0,1`)).rejects.toThrow();
    // BOTH references: the fold owner is ambiguous, so one amount draws down two ordered lines
    await expect(insert(
      `"type","poLineId","labourPoLineId","quantity","rate","taxAmount","freightAmount","amount"`,
      `'material','${line.poLineId}','${labourLine.poLineId}',1,1,0,0,1`,
    )).rejects.toThrow();
    // a `type` disagreeing with the reference present
    await expect(insert(
      `"type","poLineId","quantity","rate","taxAmount","freightAmount","amount"`,
      `'labour','${line.poLineId}',1,1,0,0,1`,
    )).rejects.toThrow();
    // 5ag — a ZERO quantity claims nothing; a NEGATIVE one is a credit note, which Phase 5 has not
    await expect(insert(`"type","poLineId","quantity","rate","taxAmount","freightAmount","amount"`, `'material','${line.poLineId}',0,1,0,0,0`)).rejects.toThrow();
    await expect(insert(`"type","poLineId","quantity","rate","taxAmount","freightAmount","amount"`, `'material','${line.poLineId}',-1,1,0,0,-1`)).rejects.toThrow();
    await expect(insert(`"type","poLineId","quantity","rate","taxAmount","freightAmount","amount"`, `'material','${line.poLineId}',1,1,-1,0,0`)).rejects.toThrow();
    // 5au — a LABOUR line's tax and freight are pinned to zero: the labour PO snapshot freezes
    // no ordered tax or freight, so there would be nothing to verify such a claim against
    await expect(insert(
      `"type","labourPoLineId","quantity","rate","taxAmount","freightAmount","amount"`,
      `'labour','${labourLine.poLineId}',1,1000,5,0,1005`,
    )).rejects.toThrow();
    // …and the DERIVED amount cannot be hand-written
    await expect(insert(`"type","poLineId","quantity","rate","taxAmount","freightAmount","amount"`, `'material','${line.poLineId}',1,1,0,0,999`)).rejects.toThrow();
    // the service refuses the labour tax case too, as a readable 4xx rather than a raw violation
    await expect(bills.record(projectId, {
      vendorId: labourLine.vendorId, vendorBillNumber: 'L-TAX', documentDate: '2026-08-20',
      lines: [{ labourPoLineId: labourLine.poLineId, quantity: '1', rate: '1000', taxAmount: '5' }],
    }, pmc(projectId))).rejects.toMatchObject({ status: 409 });
  });

  // ── PROBE 5bg / 5bj — the duplicate-claim key ─────────────────────────────────────────────────

  it('PROBE 5bg/5bj (§F): the document key is non-blank and frozen, unique among LIVE claims, and released by the lifecycle\'s own terminal states', async () => {
    const projectId = await freshProject();
    const line = await issuedMaterialLine(projectId, { qty: '400', baseRate: '1' });
    await acceptOnLine(projectId, line, '400', '400');

    const first = await claim(projectId, line.vendorId, line.poLineId, '50', { number: 'V-1' });
    // a SECOND live `V-1` from the same vendor is a duplicate claim
    await expect(claim(projectId, line.vendorId, line.poLineId, '50', { number: 'V-1' })).rejects.toMatchObject({ status: 409 });
    // a DIFFERENT vendor may use the same number — the key is scoped to the counterparty
    const other = await issuedMaterialLine(projectId, { qty: '100', baseRate: '1' });
    await acceptOnLine(projectId, other, '100', '100');
    expect((await claim(projectId, other.vendorId, other.poLineId, '10', { number: 'V-1' })).status).toBe('submitted');

    // the number and date are FROZEN — an editable key lets a vendor re-submit the same claim
    // under a new number after the first is checked, and duplicate detection stops resting on
    // immutable vendor evidence
    await expect(
      t.prisma.$executeRawUnsafe(`UPDATE "VendorBill" SET "vendorBillNumber"='V-9' WHERE "id"=$1`, first.id),
    ).rejects.toThrow(/FROZEN/u);
    await expect(
      t.prisma.$executeRawUnsafe(`UPDATE "VendorBill" SET "documentDate"='2026-01-01' WHERE "id"=$1`, first.id),
    ).rejects.toThrow(/FROZEN/u);
    // a whitespace-only number is refused at PG as well as by the contract
    await expect(
      t.prisma.vendorBill.create({ data: { projectId, vendorId: line.vendorId, vendorBillNumber: ' \t ', documentDate: new Date('2026-08-20'), createdById: f.memberUser.id, sourceCommandId: 'x' } }),
    ).rejects.toThrow();

    // 5bj — REJECTING the first releases the key, and the corrected resubmission is ACCEPTED
    await bills.reject(projectId, { billId: first.id, reason: 'wrong purchase order' }, pmc(projectId));
    const resubmitted = await claim(projectId, line.vendorId, line.poLineId, '50', { number: 'V-1' });
    expect(resubmitted.status).toBe('submitted');
    // …and so does a RESOLVED dispute, the other terminal state §F defines
    await bills.reject(projectId, { billId: resubmitted.id, reason: 'superseded by a revised invoice' }, pmc(projectId));
    expect(await statusOf(projectId, resubmitted.id)).toBe('rejected');
  });

  it('PROBE 5bg (§F): two CONCURRENT first submissions of one document number admit exactly one', async () => {
    const projectId = await freshProject();
    const line = await issuedMaterialLine(projectId, { qty: '100', baseRate: '1' });
    await acceptOnLine(projectId, line, '100', '100');

    let release!: () => void;
    let acquired!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const held = new Promise<void>((r) => (acquired = r));
    const holder = t.prisma.$transaction(
      async (tx) => { await lockProjectReadiness(tx, projectId); acquired(); await gate; },
      { timeout: 20_000, maxWait: 10_000 },
    );
    await held;
    const one = bills.record(projectId, { vendorId: line.vendorId, vendorBillNumber: 'DUP', documentDate: '2026-08-20', lines: [{ poLineId: line.poLineId, quantity: '10', rate: '1' }] }, pmc(projectId));
    await waitForReadinessWaiters(1);
    const two = bills.record(projectId, { vendorId: line.vendorId, vendorBillNumber: 'DUP', documentDate: '2026-08-20', lines: [{ poLineId: line.poLineId, quantity: '10', rate: '1' }] }, pmc(projectId));
    await waitForReadinessWaiters(2);
    release();
    await holder;

    const settled = await Promise.allSettled([one, two]);
    expect(settled.filter((s) => s.status === 'fulfilled')).toHaveLength(1);
    expect(settled.filter((s) => s.status === 'rejected')).toHaveLength(1);
    expect(await t.prisma.vendorBill.count({ where: { projectId, vendorBillNumber: 'DUP' } })).toBe(1);
  });

  // ── PROBE 5f / 5ao / 5ax — vendor pinning ─────────────────────────────────────────────────────

  it('PROBE 5f/5ao/5ax (§F): vendor pinning is PG-enforced WITHIN one project, and every PO line carries its own order and vendor', async () => {
    const projectId = await freshProject();
    const a = await issuedMaterialLine(projectId, { qty: '100', baseRate: '1' });
    const b = await issuedMaterialLine(projectId, { qty: '100', baseRate: '1' });
    expect(a.vendorId).not.toBe(b.vendorId);
    await acceptOnLine(projectId, a, '100', '100');
    await acceptOnLine(projectId, b, '100', '100');

    // 5ax — the pinning is present on EVERY line and equals its own version→root chain. A
    // same-project FK alone would only stop a cross-PROJECT line.
    const lines = await t.prisma.purchaseOrderLine.findMany({
      where: { projectId }, select: { id: true, vendorId: true, purchaseOrderId: true, poVersion: { select: { poId: true, po: { select: { vendorId: true } } } } },
    });
    expect(lines.length).toBeGreaterThan(0);
    for (const l of lines) {
      expect(l.purchaseOrderId).toBe(l.poVersion.poId);
      expect(l.vendorId).toBe(l.poVersion.po.vendorId);
    }

    // 5f/5ao — Vendor A's bill naming Vendor B's PO line, in the SAME project, is refused
    await expect(claim(projectId, a.vendorId, b.poLineId, '10')).rejects.toMatchObject({ status: 409 });
    // …and directly at PostgreSQL, past the service check
    const good = await claim(projectId, a.vendorId, a.poLineId, '10');
    await expect(t.prisma.$executeRawUnsafe(
      `INSERT INTO "VendorBillLine" ("id","projectId","versionId","billId","vendorId","type","poLineId","quantity","rate","taxAmount","freightAmount","amount")
       VALUES ('hostile-vendor',$1,$2,$3,$4,'material',$5,1,1,0,0,1)`,
      projectId, good.versions[0]!.id, good.id, a.vendorId, b.poLineId,
    )).rejects.toThrow();

    // the pinned columns are FROZEN with the rest of the snapshot
    await expect(t.prisma.$executeRawUnsafe(
      `UPDATE "PurchaseOrderLine" SET "vendorId"=$1 WHERE "id"=$2`, b.vendorId, a.poLineId,
    )).rejects.toThrow(/FROZEN/u);
  });

  // ── PROBE 5h — unit discipline, and bound 1 against ordered authority ─────────────────────────

  it('PROBE 5h (§0/§G): bound 1 compares UNITS to units — a large-amount claim within the ordered quantity passes', async () => {
    const projectId = await freshProject();
    // 100 bags at ₹100 = a ₹10,000 claim. Bound 1 is about the 100 UNITS, never the rupees.
    const line = await issuedMaterialLine(projectId, { qty: '100', baseRate: '100' });
    await acceptOnLine(projectId, line, '100', '100');
    const bill = await claim(projectId, line.vendorId, line.poLineId, '100', { rate: '100' });
    expect(bill.status).toBe('submitted');
    expect(bill.versions[0]!.claimedAmount).toBe('10000');

    // …and a claim beyond the ORDERED quantity is disputed even where evidence would allow it.
    // Here bound 1 is what bites: nothing was ordered above 100.
    const over = await issuedMaterialLine(projectId, { qty: '100', baseRate: '1' });
    await acceptOnLine(projectId, over, '100', '100');
    const bad = await claim(projectId, over.vendorId, over.poLineId, '100');
    expect(bad.status).toBe('submitted');
    const second = await claim(projectId, over.vendorId, over.poLineId, '1');
    expect(second.status).toBe('disputed');
    expect(second.statusReason).toMatch(/qty-over-ordered/u);
  });

  // ── PROBE 7 — append-only ─────────────────────────────────────────────────────────────────────

  it('PROBE 7 (§F): PG rejects an UPDATE or DELETE of a claim line and of a superseded version', async () => {
    const projectId = await freshProject();
    const line = await issuedMaterialLine(projectId, { qty: '100', baseRate: '1' });
    await acceptOnLine(projectId, line, '100', '100');
    const bill = await claim(projectId, line.vendorId, line.poLineId, '50');
    const amended = await bills.amend(projectId, {
      billId: bill.id, reason: 'quantity corrected', lines: [{ poLineId: line.poLineId, quantity: '60', rate: '1' }],
    }, pmc(projectId));

    const v1 = amended.versions[0]!;
    const lineId = v1.lines[0]!.id;
    await expect(t.prisma.$executeRawUnsafe(`UPDATE "VendorBillLine" SET "quantity"=99 WHERE "id"=$1`, lineId)).rejects.toThrow(/immutable/u);
    await expect(t.prisma.$executeRawUnsafe(`DELETE FROM "VendorBillLine" WHERE "id"=$1`, lineId)).rejects.toThrow(/immutable/u);
    await expect(t.prisma.$executeRawUnsafe(`UPDATE "VendorBillVersion" SET "claimedAmount"=99 WHERE "id"=$1`, v1.id)).rejects.toThrow(/IMMUTABLE|already superseded/u);
    await expect(t.prisma.$executeRawUnsafe(`DELETE FROM "VendorBillVersion" WHERE "id"=$1`, v1.id)).rejects.toThrow(/never deleted/u);
    await expect(t.prisma.$executeRawUnsafe(`DELETE FROM "VendorBill" WHERE "id"=$1`, bill.id)).rejects.toThrow(/never deleted/u);
    // a second supersession stamp on a retained version is refused too
    await expect(t.prisma.$executeRawUnsafe(
      `UPDATE "VendorBillVersion" SET "supersededAt"=now() WHERE "id"=$1`, v1.id,
    )).rejects.toThrow(/already superseded/u);
  });

  // ── Codex round-1 findings, reproduce-first ───────────────────────────────────────────────────

  /**
   * F1 (P1) — ORDERED AUTHORITY and the §G seal.
   *
   * Codex's MECHANISM was right and is fixed: the bound check read the line's frozen quantity
   * without ever asking whether its version was still live, and no vendor-bill trigger fired when
   * one stopped being live. The seal now joins the version status and treats a non-live version as
   * ZERO authority, and both PO-version tables became firing sites — so withdrawing ordered
   * authority re-checks bound 1 exactly as an acceptance reversal re-checks bound 2.
   *
   * Codex's CONSEQUENCE — "a later `labour.po.amend`/cancel can move the old version to
   * `amended`/`cancelled` while the bill stays live" — turns out NOT to be reachable through any
   * service path in this tree, and this probe pins the three independent guards that close it,
   * because each belongs to a different task and any one of them relaxing would open the door:
   *
   *   1. Task 2 refuses labour cancel/amend while a LIVE capacity commitment stands.
   *   2. Task 3 refuses defaulting that commitment below MEASURED — and a labour claim needs
   *      `MEASURED > 0`, so the commitment can never be cleared out of the way.
   *   3. Phase 3 refuses a material cancel with accepted receipts and permits amend only from
   *      `issued` — and a material claim needs `ACCEPTED > 0`, which moves the version off it.
   *
   * The seal is still the right fix: §G asks the DATABASE to hold the bound independently of the
   * service, and "some other task's guard happens to block the only route" is not the database
   * holding anything. The second half of this probe drives the withdrawal directly at PostgreSQL,
   * where those three service guards do not apply, and the seal catches it.
   */
  it('F1 (§G): withdrawing ordered authority is refused by three existing guards, and the DB seal now catches it directly', async () => {
    const projectId = await freshProject();
    const line = await labourMeasurableLine(projectId, 2);
    await measurement.take(projectId, { labourPoLineId: line.poLineId, activityId: line.activityId, quantity: '2', citedOutputId: line.outputId }, pmc(projectId));
    const recorded = await bills.record(projectId, {
      vendorId: line.vendorId, vendorBillNumber: 'F1-1', documentDate: '2026-08-20',
      lines: [{ labourPoLineId: line.poLineId, quantity: '2', rate: '1000' }],
    }, pmc(projectId));
    const bill = await bills.submit(projectId, { billId: recorded.id }, pmc(projectId));
    expect(bill.status).toBe('submitted');

    const poLine = await t.prisma.labourPurchaseOrderLine.findFirstOrThrow({
      where: { projectId, id: line.poLineId }, select: { purchaseOrderId: true, poVersionId: true },
    });
    const commitment = await t.prisma.capacityCommitment.findFirstOrThrow({
      where: { projectId, poLineId: line.poLineId, status: { in: ['committed', 'revised'] } },
    });

    // guard 1 (Task 2) — a live commitment is never orphaned
    await expect(labourCommercial.cancelPo(projectId, poLine.purchaseOrderId, { reason: 'scope withdrawn' }, pmc(projectId)))
      .rejects.toMatchObject({ status: 409 });
    // guard 2 (Task 3) — and the commitment cannot be cleared out of the way under a measurement
    await expect(labourCommercial.defaultCapacity(projectId, commitment.id, pmc(projectId)))
      .rejects.toMatchObject({ status: 409 });
    expect(await statusOf(projectId, bill.id)).toBe('submitted');

    // …so the only way to reach the state is to go around all three, straight at the rows — which
    // is precisely where a database seal has to hold on its own. Cancelling the version under a
    // live 2-shift claim now aborts at COMMIT naming bound 1.
    await expect(t.prisma.$executeRawUnsafe(
      `UPDATE "LabourPurchaseOrderVersion" SET "status"='cancelled', "cancelledAt"=now(), "cancelReason"='forced past every service guard' WHERE "id"=$1`,
      poLine.poVersionId,
    )).rejects.toThrow(/Bound 1 breached/u);
    expect(await billedQty(projectId, line.poLineId, 'labour')).toBe('2');

    // and the paired DISPOSITION is what keeps a legitimate withdrawal possible rather than merely
    // impossible: disputing the claim first frees the order, and the same statement then commits.
    await t.prisma.$transaction(async (tx) => {
      await bills.disputeClaimsBeyondEvidence(
        tx, projectId, 'labour', line.poLineId, new Prisma.Decimal(0), 'order-not-live: supplier reneged',
        { actorId: f.memberUser.id, role: 'pmc' },
      );
      await tx.$executeRawUnsafe(
        `UPDATE "LabourPurchaseOrderVersion" SET "status"='cancelled', "cancelledAt"=now(), "cancelReason"='supplier reneged' WHERE "id"=$1`,
        poLine.poVersionId,
      );
    });
    expect(await statusOf(projectId, bill.id)).toBe('disputed');
    expect(await billedQty(projectId, line.poLineId, 'labour')).toBe('0');
  });

  /** F2 (P2) — the reason a claim LEFT the live fold is evidence, so it cannot be rewritten later. */
  it('F2 (§F): a claim\'s exit reason is FROZEN once it explains the exit', async () => {
    const projectId = await freshProject();
    const line = await issuedMaterialLine(projectId, { qty: '100', baseRate: '1' });
    await acceptOnLine(projectId, line, '100', '100');
    const bill = await claim(projectId, line.vendorId, line.poLineId, '10');
    await bills.reject(projectId, { billId: bill.id, reason: 'wrong purchase order' }, pmc(projectId));

    // the status is unchanged, so the first head's lifecycle trigger never looked — and the
    // justification for an append-only exit could be silently replaced afterwards
    await expect(t.prisma.$executeRawUnsafe(
      `UPDATE "VendorBill" SET "statusReason"='something else entirely' WHERE "id"=$1`, bill.id,
    )).rejects.toThrow(/FROZEN/u);
    expect((await t.prisma.vendorBill.findFirstOrThrow({ where: { id: bill.id } })).statusReason)
      .toBe('wrong purchase order');
  });

  /** F3 (P2) — the supersession stamp is the evidence for the ONE permitted amendment transition. */
  it('F3 (§F): supersession fields cannot be pre-filled, and a bill is never left with no current version', async () => {
    const projectId = await freshProject();
    const line = await issuedMaterialLine(projectId, { qty: '100', baseRate: '1' });
    await acceptOnLine(projectId, line, '100', '100');
    const bill = await claim(projectId, line.vendorId, line.poLineId, '10');
    const versionId = bill.versions[0]!.id;

    // pre-filling the reason while the version is still CURRENT leaves a rewritable justification
    // for a transition that has not happened
    await expect(t.prisma.$executeRawUnsafe(
      `UPDATE "VendorBillVersion" SET "supersedeReason"='pre-filled' WHERE "id"=$1`, versionId,
    )).rejects.toThrow(/supersession/u);

    // …and stamping the only version superseded with NO replacement would drop the whole claim out
    // of the billed fold while the bill is still live
    await expect(t.prisma.$executeRawUnsafe(
      `UPDATE "VendorBillVersion" SET "supersededAt"=now(), "supersededById"=$2, "supersedeReason"='no replacement' WHERE "id"=$1`,
      versionId, f.memberUser.id,
    )).rejects.toThrow(/current version/u);
    expect(await billedQty(projectId, line.poLineId)).toBe('10');
  });

  /** F4 (P2) — a recorded version's LINE SET is closed; a later append mutates immutable history. */
  it('F4 (§F): a claim line cannot be appended to a version that was already recorded', async () => {
    const projectId = await freshProject();
    const line = await issuedMaterialLine(projectId, { qty: '100', baseRate: '1' });
    const other = await issuedMaterialLine(projectId, { qty: '100', baseRate: '1', vendorId: line.vendorId });
    await acceptOnLine(projectId, line, '100', '100');
    await acceptOnLine(projectId, other, '100', '100');
    const bill = await claim(projectId, line.vendorId, line.poLineId, '10');
    const versionId = bill.versions[0]!.id;

    // the reviewer's exact exploit: a ZERO-money line keeps `claimedAmount` equal to the line total
    // (so the derived-amount check still passes) while adding quantity to `BILLED_QTY` — and on a
    // PO line the original claim never named
    await expect(t.prisma.$executeRawUnsafe(
      `INSERT INTO "VendorBillLine" ("id","projectId","versionId","billId","vendorId","type","poLineId","quantity","rate","taxAmount","freightAmount","amount")
       VALUES ('f4-late',$1,$2,$3,$4,'material',$5,50,0,0,0,0)`,
      projectId, versionId, bill.id, line.vendorId, other.poLineId,
    )).rejects.toThrow();
    expect(await billedQty(projectId, other.poLineId)).toBe('0');
  });

  // ── Codex round-2 findings, reproduce-first ───────────────────────────────────────────────────

  /**
   * R2-F1 — my own round-1 fix, one level short. `lineCount` closes the line set only if it is
   * itself frozen: bump it 1 → 2 and insert the extra zero-money line in the SAME transaction and
   * the deferred check sees a count that matches. A seal whose own evidence is editable is not a
   * seal — the same shape as round 1's F3, one table over.
   */
  it('R2-F1 (§F): the line-set seal is itself FROZEN — lineCount cannot be bumped to admit a late line', async () => {
    const projectId = await freshProject();
    const line = await issuedMaterialLine(projectId, { qty: '100', baseRate: '1' });
    const other = await issuedMaterialLine(projectId, { qty: '100', baseRate: '1', vendorId: line.vendorId });
    await acceptOnLine(projectId, line, '100', '100');
    await acceptOnLine(projectId, other, '100', '100');
    const bill = await claim(projectId, line.vendorId, line.poLineId, '10');
    const versionId = bill.versions[0]!.id;

    await expect(t.prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`UPDATE "VendorBillVersion" SET "lineCount"=2 WHERE "id"=$1`, versionId);
      await tx.$executeRawUnsafe(
        `INSERT INTO "VendorBillLine" ("id","projectId","versionId","billId","vendorId","type","poLineId","quantity","rate","taxAmount","freightAmount","amount")
         VALUES ('r2f1-late',$1,$2,$3,$4,'material',$5,50,0,0,0,0)`,
        projectId, versionId, bill.id, line.vendorId, other.poLineId,
      );
    })).rejects.toThrow(/IMMUTABLE/u);
    expect(await billedQty(projectId, other.poLineId)).toBe('0');
  });

  /**
   * R2-F2 — the dispute reason is the evidence for WHY a claim left the live fold, and resolving
   * the dispute overwrote it with an amendment note. The resolution has its own place to live: the
   * superseded version's `supersedeReason`.
   */
  it('R2-F2 (§F): resolving a dispute PRESERVES why it was disputed, and records the resolution separately', async () => {
    const projectId = await freshProject();
    const line = await issuedMaterialLine(projectId, { qty: '120', baseRate: '1' });
    await acceptOnLine(projectId, line, '100', '100');
    const over = await claim(projectId, line.vendorId, line.poLineId, '120');
    expect(over.status).toBe('disputed');
    expect(over.statusReason).toMatch(/qty-over-accepted/u);

    const resolved = await bills.amend(projectId, {
      billId: over.id, reason: 'vendor corrected the claim to the delivered quantity',
      lines: [{ poLineId: line.poLineId, quantity: '100', rate: '1' }],
    }, pmc(projectId));
    expect(resolved.status).toBe('resolved');
    // the breach that took it out of the fold is still on the record…
    expect(resolved.statusReason).toMatch(/qty-over-accepted/u);
    // …and the resolution is on the version it superseded, where an amendment's reason belongs
    expect(resolved.versions[0]!.supersedeReason).toBe('vendor corrected the claim to the delivered quantity');
  });

  /**
   * R2-F3 — Task 4 stops SHORT of `verified`, but PostgreSQL still accepted the arrow into it and
   * on to `certified`. The statuses stay in the vocabulary because §0's LIVE rule is defined over
   * the whole set; the ARROWS wait for the evidence that justifies them (§E, Task 5).
   */
  it('R2-F3 (§F): the arrows into verified and beyond are REFUSED until the task that produces their evidence', async () => {
    const projectId = await freshProject();
    const line = await issuedMaterialLine(projectId, { qty: '100', baseRate: '1' });
    await acceptOnLine(projectId, line, '100', '100');
    const bill = await claim(projectId, line.vendorId, line.poLineId, '10');
    await bills.beginVerification(projectId, { billId: bill.id }, pmc(projectId));
    expect(await statusOf(projectId, bill.id)).toBe('under-verification');

    // Task 5A INVERTED the first of these deliberately: `verified` is the state whose safety IS the
    // §E verdict, and that verdict now exists, so the arrow opens. This probe's Task-4 comment said
    // as much in advance — "Task 5 adds these arrows WITH the evidence that makes them safe" — and
    // a seal is only correct while the evidence behind it is absent. The rest stay closed.
    for (const status of ['certified', 'approved-for-payment', 'paid']) {
      await expect(t.prisma.$executeRawUnsafe(
        `UPDATE "VendorBill" SET "status"=$2 WHERE "id"=$1`, bill.id, status,
      )).rejects.toThrow(/cannot move from/u);
    }
    expect(await statusOf(projectId, bill.id)).toBe('under-verification');
    await bills.reject(projectId, { billId: bill.id, reason: 'duplicate of an earlier invoice' }, pmc(projectId));
    expect(await statusOf(projectId, bill.id)).toBe('rejected');
  });

  /**
   * R2-F4 — `BILLED_AMOUNT` was folded and never read. §J's buckets PARTITION the money, so a
   * ₹40 live claim against a ₹100 receipt has to move ₹40 out of `received-not-billed` and into
   * `awaiting-certification` — reporting the full ₹100 as unbilled says billed work is unbilled.
   * Task 2's own DTO comment promised this ("Tasks 4–6 subtract `BILLED_AMOUNT` from it").
   */
  it('R2-F4 (§J): a live claim moves money from received-not-billed into awaiting-certification, and the buckets still partition', async () => {
    const projectId = await freshProject();
    await budget.setBudget(projectId, { costHeadCode: 'CIVIL', amount: '100.00', reason: 'plan' }, pmc(projectId));
    const line = await issuedMaterialLine(projectId, { qty: '100', baseRate: '1' });
    await acceptOnLine(projectId, line, '100', '100');

    let position = await positionOf(projectId, 'CIVIL');
    expect(position.committed.toString()).toBe('0');
    expect(position.receivedNotBilled.toString()).toBe('100');
    expect(position.awaitingCertification.toString()).toBe('0');
    const headroomBefore = position.headroom!.toString();

    const bill = await claim(projectId, line.vendorId, line.poLineId, '40');
    expect(bill.status).toBe('submitted');

    position = await positionOf(projectId, 'CIVIL');
    expect(position.receivedNotBilled.toString()).toBe('60');
    expect(position.awaitingCertification.toString()).toBe('40');
    // the money moved BUCKET, so total exposure and headroom are unchanged — that is what
    // "the buckets partition the money" means, and it is the RED half of this probe
    expect(position.committed.add(position.receivedNotBilled).add(position.awaitingCertification).toString()).toBe('100');
    expect(position.headroom!.toString()).toBe(headroomBefore);

    // …and a claim that leaves the live fold gives the money back
    await bills.reject(projectId, { billId: bill.id, reason: 'wrong purchase order' }, pmc(projectId));
    position = await positionOf(projectId, 'CIVIL');
    expect(position.receivedNotBilled.toString()).toBe('100');
    expect(position.awaitingCertification.toString()).toBe('0');
  });

  // ── Codex round-3 findings, reproduce-first ───────────────────────────────────────────────────

  /**
   * R3-F1 — the other half of R2-F4, and my own fix one level short AGAIN. Wiring `BILLED_AMOUNT`
   * into the position made a live claim able to MOVE exposure — my own clamp comment said so ("an
   * unverified over-rate claim IS extra exposure") — and §B's rule is that every write which can
   * move headroom raises or clears the exception in the SAME transaction. The bill transitions
   * moved the money and evaluated nothing, so the budget READ could report negative headroom while
   * the exception register stayed empty: two surfaces built from the same folds disagreeing.
   */
  it('R3-F1 (§B): a claim that moves exposure raises the over-budget exception in its own transaction, and clears it when the claim leaves', async () => {
    const projectId = await freshProject();
    await budget.setBudget(projectId, { costHeadCode: 'CIVIL', amount: '100.00', reason: 'plan' }, pmc(projectId));
    const line = await issuedMaterialLine(projectId, { qty: '100', baseRate: '1' });
    await acceptOnLine(projectId, line, '100', '100');

    expect(await openExceptions(projectId)).toHaveLength(0);
    expect((await positionOf(projectId, 'CIVIL')).headroom!.toString()).toBe('0');

    // the §E RATE check is Task 5's, so a claim at TWICE the ordered rate passes the quantity
    // bounds and lands live — carrying ₹200 of exposure against a ₹100 budget
    const bill = await claim(projectId, line.vendorId, line.poLineId, '100', { rate: '2' });
    expect(bill.status).toBe('submitted');
    const breached = await positionOf(projectId, 'CIVIL');
    expect(breached.awaitingCertification.toString()).toBe('200');
    expect(breached.headroom!.toString()).toBe('-100');
    const open = await openExceptions(projectId);
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ costHeadCode: 'CIVIL', raisedBy: 'claim' });

    // …and rejecting the claim gives the exposure back and CLEARS it — an append-only register
    // left flagging a breach that no longer exists is the same defect in the other direction
    await bills.reject(projectId, { billId: bill.id, reason: 'rate does not match the order' }, pmc(projectId));
    expect((await positionOf(projectId, 'CIVIL')).headroom!.toString()).toBe('0');
    expect(await openExceptions(projectId)).toHaveLength(0);
  });

  /** R3-F2 — `statusChangedAt` records WHEN a claim left the live fold; same-status rewrites erase it. */
  it('R3-F2 (§F): statusChangedAt moves only WITH the transition that sets it', async () => {
    const projectId = await freshProject();
    const line = await issuedMaterialLine(projectId, { qty: '100', baseRate: '1' });
    await acceptOnLine(projectId, line, '100', '100');
    const bill = await claim(projectId, line.vendorId, line.poLineId, '10');
    await bills.reject(projectId, { billId: bill.id, reason: 'wrong purchase order' }, pmc(projectId));
    const stamped = (await t.prisma.vendorBill.findFirstOrThrow({ where: { id: bill.id } })).statusChangedAt;

    await expect(t.prisma.$executeRawUnsafe(
      `UPDATE "VendorBill" SET "statusChangedAt"='2020-01-01T00:00:00Z' WHERE "id"=$1`, bill.id,
    )).rejects.toThrow(/FROZEN/u);
    expect((await t.prisma.vendorBill.findFirstOrThrow({ where: { id: bill.id } })).statusChangedAt.toISOString())
      .toBe(stamped.toISOString());
  });

  /**
   * R3-F3 — round 2 sealed the ARROWS and left CREATION open: the lifecycle trigger was BEFORE
   * UPDATE OR DELETE only, so a direct insert could start a bill AT `certified` and skip every
   * arrow. The statuses have to stay in the CHECK vocabulary for §0's LIVE rule, which is exactly
   * why the entry point needs its own guard.
   */
  it('R3-F3 (§F): a claim can only be CREATED at draft — a bill cannot start life past its evidence', async () => {
    const projectId = await freshProject();
    const line = await issuedMaterialLine(projectId, { qty: '100', baseRate: '1' });
    await acceptOnLine(projectId, line, '100', '100');
    const commandId = (await t.prisma.commandExecution.findFirstOrThrow({ where: { projectId } })).id;

    for (const status of ['certified', 'verified', 'paid', 'submitted']) {
      await expect(t.prisma.$executeRawUnsafe(
        `INSERT INTO "VendorBill" ("id","projectId","vendorId","vendorBillNumber","documentDate","status","createdById","sourceCommandId")
         VALUES ($1,$2,$3,$4,'2026-08-20',$5,$6,$7)`,
        `r3f3-${status}`, projectId, line.vendorId, `R3-${status}`, status, f.memberUser.id, commandId,
      )).rejects.toThrow(/created at 'draft'/u);
    }
    // …and the legitimate creation still works, so the guard is precise rather than merely strict
    const ok = await bills.record(projectId, {
      vendorId: line.vendorId, vendorBillNumber: 'R3-OK', documentDate: '2026-08-20',
      lines: [{ poLineId: line.poLineId, quantity: '10', rate: '1' }],
    }, pmc(projectId));
    expect(ok.status).toBe('draft');
  });

  // ── §D/§I — capability gating and authority ───────────────────────────────────────────────────

  it('§D/§I: the claim surface is capability-gated and authority-bound', async () => {
    const projectId = await freshProject();
    const line = await issuedMaterialLine(projectId, { qty: '100', baseRate: '1' });
    await acceptOnLine(projectId, line, '100', '100');

    // an ENGINEER may record and submit a claim; a CONTRACTOR may not
    const recorded = await bills.record(projectId, {
      vendorId: line.vendorId, vendorBillNumber: 'AUTH-1', documentDate: '2026-08-20',
      lines: [{ poLineId: line.poLineId, quantity: '10', rate: '1' }],
    }, engineer(projectId));
    await expect(bills.submit(projectId, { billId: recorded.id }, contractor(projectId))).rejects.toMatchObject({ status: 403 });
    await bills.submit(projectId, { billId: recorded.id }, engineer(projectId));
    // …but opening VERIFICATION is pmc-only
    await expect(bills.beginVerification(projectId, { billId: recorded.id }, engineer(projectId))).rejects.toMatchObject({ status: 403 });
    const verifying = await bills.beginVerification(projectId, { billId: recorded.id }, pmc(projectId));
    expect(verifying.status).toBe('under-verification');

    // §D — a project WITHOUT the commercial capability has no claim surface at all
    const offPilot = `it-p5t4-off-${Date.now() % 1e6}-${seq++}`;
    await t.prisma.project.create({
      data: { id: offPilot, orgId: f.orgA.id, name: offPilot, short: 'P', descriptor: '', stage: 'x', siteCode: 'P', projStart: 'a', projEnd: 'b', elapsedPct: 0, todayDay: 0, milestonePct: 0, timeZone: 'Asia/Kolkata', scheduleStartDate: new Date('2026-06-01T00:00:00.000Z') },
    });
    await t.prisma.membership.create({ data: { projectId: offPilot, userId: f.memberUser.id, role: 'pmc', status: 'active' } });
    await expect(bills.list(offPilot, pmc(offPilot))).rejects.toMatchObject({ status: 404 });
    await expect(bills.record(offPilot, {
      vendorId: line.vendorId, vendorBillNumber: 'OFF-1', documentDate: '2026-08-20',
      lines: [{ poLineId: line.poLineId, quantity: '1', rate: '1' }],
    }, pmc(offPilot))).rejects.toMatchObject({ status: 404 });
    expect(await t.prisma.vendorBill.count({ where: { projectId: offPilot } })).toBe(0);
  });

  // ── §C rule ii / idempotency ──────────────────────────────────────────────────────────────────

  it('§C: a keyed replay of a claim appends NOTHING, and every row records the command that produced it', async () => {
    const projectId = await freshProject();
    const line = await issuedMaterialLine(projectId, { qty: '100', baseRate: '1' });
    await acceptOnLine(projectId, line, '100', '100');

    const body = {
      vendorId: line.vendorId, vendorBillNumber: 'IDEM-1', documentDate: '2026-08-20',
      lines: [{ poLineId: line.poLineId, quantity: '10', rate: '1' }],
    };
    const first = await bills.record(projectId, body, pmc(projectId), 'key-1');
    const replay = await bills.record(projectId, body, pmc(projectId), 'key-1');
    expect(replay.id).toBe(first.id);
    expect(await t.prisma.vendorBill.count({ where: { projectId } })).toBe(1);
    expect(await t.prisma.vendorBillVersion.count({ where: { projectId } })).toBe(1);
    expect(await t.prisma.vendorBillLine.count({ where: { projectId } })).toBe(1);

    const row = await t.prisma.vendorBill.findFirstOrThrow({ where: { projectId, id: first.id } });
    const command = await t.prisma.commandExecution.findFirstOrThrow({ where: { projectId, id: row.sourceCommandId } });
    expect(command.commandType).toBe('commercial.bill.record');

    // a submit replay is equally inert — the CAS would 409 a second real attempt
    await bills.submit(projectId, { billId: first.id }, pmc(projectId), 'key-2');
    await bills.submit(projectId, { billId: first.id }, pmc(projectId), 'key-2');
    expect(await statusOf(projectId, first.id)).toBe('submitted');
  });

  // ── Codex round-4 findings, reproduce-first ───────────────────────────────────────────────────

  /**
   * R4-F1 — an amendment REMOVES claims as well as adding them, and the removal was invisible.
   * The head evaluation read `claimTargets` AFTER the supersession, so it saw the replacement set
   * twice and never saw the lines the amendment dropped: the head carrying a dropped line kept an
   * open exception for exposure that had just left the fold.
   */
  it('R4-F1 (§B): an amendment re-evaluates the heads it DROPPED a claim from, not only the ones it kept', async () => {
    const projectId = await freshProject([{ code: 'FINISH', name: 'Finishes' }]);
    await budget.setBudget(projectId, { costHeadCode: 'CIVIL', amount: '100.00', reason: 'plan' }, pmc(projectId));
    await budget.setBudget(projectId, { costHeadCode: 'FINISH', amount: '100.00', reason: 'plan' }, pmc(projectId));
    const civil = await issuedMaterialLine(projectId, { qty: '100', baseRate: '1' });
    const finish = await issuedMaterialLine(projectId, { qty: '100', baseRate: '1', costHeadCode: 'FINISH', vendorId: civil.vendorId });
    await acceptOnLine(projectId, civil, '100', '100');
    await acceptOnLine(projectId, finish, '100', '100');

    // ONE claim across BOTH heads, each at twice the ordered rate, so each head is over budget
    const recorded = await bills.record(projectId, {
      vendorId: civil.vendorId, vendorBillNumber: 'R4-F1', documentDate: '2026-08-20',
      lines: [
        { poLineId: civil.poLineId, quantity: '100', rate: '2' },
        { poLineId: finish.poLineId, quantity: '100', rate: '2' },
      ],
    }, pmc(projectId));
    await bills.submit(projectId, { billId: recorded.id }, pmc(projectId));
    expect((await openExceptions(projectId)).map((e) => e.costHeadCode)).toEqual(['CIVIL', 'FINISH']);

    // amend DOWN to the civil line alone — the finishes claim is withdrawn
    await bills.amend(projectId, {
      billId: recorded.id, reason: 'the finishes line was billed against the wrong order',
      lines: [{ poLineId: civil.poLineId, quantity: '100', rate: '2' }],
    }, pmc(projectId));

    // the money left FINISH, so its exception must be cleared — CIVIL's is still real
    expect((await positionOf(projectId, 'FINISH')).awaitingCertification.toString()).toBe('0');
    expect((await positionOf(projectId, 'FINISH')).headroom!.toString()).toBe('0');
    expect((await openExceptions(projectId)).map((e) => e.costHeadCode)).toEqual(['CIVIL']);
  });

  /**
   * R4-F2 — the duplicate-document key was the RAW text, so ` V-9 ` and `v-9` were three different
   * live documents for one vendor invoice, each free to draw on the same accepted quantity.
   */
  it('R4-F2 (§F): the duplicate-claim key is NORMALIZED — padding and letter case do not make a second live document', async () => {
    const projectId = await freshProject();
    const line = await issuedMaterialLine(projectId, { qty: '100', baseRate: '1' });
    await acceptOnLine(projectId, line, '100', '100');
    const first = await bills.record(projectId, {
      vendorId: line.vendorId, vendorBillNumber: 'V-9', documentDate: '2026-08-20',
      lines: [{ poLineId: line.poLineId, quantity: '10', rate: '1' }],
    }, pmc(projectId));
    expect(first.vendorBillNumber).toBe('V-9');

    for (const variant of ['  V-9  ', 'v-9', 'V-9', '\tV-9\n']) {
      await expect(bills.record(projectId, {
        vendorId: line.vendorId, vendorBillNumber: variant, documentDate: '2026-08-20',
        lines: [{ poLineId: line.poLineId, quantity: '10', rate: '1' }],
      }, pmc(projectId))).rejects.toThrow(/already/u);
    }
    // a GENUINELY different number is still accepted, so the key is precise rather than merely strict
    const other = await bills.record(projectId, {
      vendorId: line.vendorId, vendorBillNumber: 'V-90', documentDate: '2026-08-20',
      lines: [{ poLineId: line.poLineId, quantity: '10', rate: '1' }],
    }, pmc(projectId));
    expect(other.vendorBillNumber).toBe('V-90');

    // internal spacing is transcription noise too, at ANY position — the key holds no whitespace
    await bills.record(projectId, {
      vendorId: line.vendorId, vendorBillNumber: 'W 1', documentDate: '2026-08-20',
      lines: [{ poLineId: line.poLineId, quantity: '10', rate: '1' }],
    }, pmc(projectId));
    for (const variant of ['W  1', 'W1', 'w 1', 'W\t1']) {
      await expect(bills.record(projectId, {
        vendorId: line.vendorId, vendorBillNumber: variant, documentDate: '2026-08-20',
        lines: [{ poLineId: line.poLineId, quantity: '10', rate: '1' }],
      }, pmc(projectId))).rejects.toThrow(/already/u);
    }

    // …and the stored text cannot carry padding at all: the read surface and the key agree
    const commandId = (await t.prisma.commandExecution.findFirstOrThrow({ where: { projectId } })).id;
    await expect(t.prisma.$executeRawUnsafe(
      `INSERT INTO "VendorBill" ("id","projectId","vendorId","vendorBillNumber","documentDate","status","createdById","sourceCommandId")
       VALUES ($1,$2,$3,'  V-77  ','2026-08-20','draft',$4,$5)`,
      'r4f2-padded', projectId, line.vendorId, f.memberUser.id, commandId,
    )).rejects.toThrow(/VendorBill_number_trimmed/u);
  });

  /**
   * R4-F3 — a disputed claim leaves the live fold WHOLE. Its lines on other purchase-order lines
   * stop counting too, so every head the bill touched moved — and only the withdrawal site's head
   * was re-evaluated, leaving the others flagging exposure the budget read had already released.
   */
  it('R4-F3 (§B): an automatic dispute re-evaluates EVERY head the claim touched, not just the withdrawal site', async () => {
    const projectId = await freshProject([{ code: 'FINISH', name: 'Finishes' }]);
    await budget.setBudget(projectId, { costHeadCode: 'CIVIL', amount: '100.00', reason: 'plan' }, pmc(projectId));
    await budget.setBudget(projectId, { costHeadCode: 'FINISH', amount: '100.00', reason: 'plan' }, pmc(projectId));
    const civil = await issuedMaterialLine(projectId, { qty: '100', baseRate: '1' });
    const finish = await issuedMaterialLine(projectId, { qty: '100', baseRate: '1', costHeadCode: 'FINISH', vendorId: civil.vendorId });
    const accepted = await acceptOnLine(projectId, civil, '100', '100');
    await acceptOnLine(projectId, finish, '100', '100');

    const recorded = await bills.record(projectId, {
      vendorId: civil.vendorId, vendorBillNumber: 'R4-F3', documentDate: '2026-08-20',
      lines: [
        { poLineId: civil.poLineId, quantity: '100', rate: '2' },
        { poLineId: finish.poLineId, quantity: '100', rate: '2' },
      ],
    }, pmc(projectId));
    await bills.submit(projectId, { billId: recorded.id }, pmc(projectId));
    expect((await openExceptions(projectId)).map((e) => e.costHeadCode)).toEqual(['CIVIL', 'FINISH']);

    // withdraw the CIVIL evidence — the whole claim is disputed, so BOTH heads' exposure went
    await inventory.reverse(projectId, {
      txId: accepted.acceptanceTxId, reason: 'the acceptance was recorded against the wrong lot',
    }, pmc(projectId));
    expect(await statusOf(projectId, recorded.id)).toBe('disputed');
    expect((await positionOf(projectId, 'FINISH')).awaitingCertification.toString()).toBe('0');
    expect(await openExceptions(projectId)).toHaveLength(0);
  });

  /**
   * R4-F4 — the disposition subtracted from a RUNNING TOTAL and treated a lost CAS as "skip this
   * one". A lost CAS means a concurrent transaction already took that claim out of the fold, so the
   * total was stale by exactly that claim, and the next claim was measured against a number that
   * counted it twice — disputing a claim the fold already had room for.
   *
   * The interleaving is produced deterministically rather than raced: the transaction client is
   * wrapped so the FIRST dispute update runs the concurrent rejection (on its own connection, to
   * commit) immediately before it. That is the exact ordering the defect needs — the fold and the
   * live set are read, then the world changes, then the CAS runs — with no timing to be flaky
   * about. Nothing here holds a lock the disposition would have waited on, which is precisely the
   * point: the service paths serialize on the readiness lock, so the guard is being asked to hold
   * on its own rather than on another lock happening to be there.
   */
  it('R4-F4 (§E): a LOST dispute CAS re-reads the fold instead of over-disputing the next claim', async () => {
    const projectId = await freshProject();
    const line = await issuedMaterialLine(projectId, { qty: '100', baseRate: '1' });
    await acceptOnLine(projectId, line, '100', '100');
    const older = await claim(projectId, line.vendorId, line.poLineId, '60', { number: 'R4-F4-OLD' });
    const newer = await claim(projectId, line.vendorId, line.poLineId, '40', { number: 'R4-F4-NEW' });
    expect(await billedQty(projectId, line.poLineId, 'material')).toBe('100');

    const { PrismaClient } = await import('@prisma/client');
    const outside = new PrismaClient();
    try {
      // ACCEPTED falls to 80. The honest disposition disputes the newest (40) and stops at 60 ≤ 80.
      const disputed = await t.prisma.$transaction(async (tx) => bills.disputeClaimsBeyondEvidence(
        wedgeFirstBillUpdate(tx, async () => {
          await outside.vendorBill.updateMany({
            where: { id: newer.id, projectId },
            data: { status: 'rejected', statusChangedAt: new Date(), statusReason: 'withdrawn by the vendor' },
          });
        }),
        projectId, 'material', line.poLineId, new Prisma.Decimal('80'),
        'qty-over-accepted: evidence withdrawn', { actorId: f.memberUser.id, role: 'pmc' },
      ));

      // the concurrent rejection already removed 40, so the fold is 60 and there is NOTHING left to
      // dispute. Carrying the stale 100 forward disputes the 60 the fold has room for.
      expect(disputed).toEqual([]);
      expect(await statusOf(projectId, older.id)).toBe('submitted');
      expect(await billedQty(projectId, line.poLineId, 'material')).toBe('60');
    } finally {
      await outside.$disconnect();
    }
  });

  /**
   * R4-F5 — `resolved` is TERMINAL and it RELEASES the duplicate-document key. Marking a disputed
   * claim resolved with no correction behind it therefore frees the vendor's invoice number while
   * the disputed claim is still the only version that ever existed, so the same invoice can be
   * filed again, live, against the evidence that failed it the first time.
   */
  it('R4-F5 (§F): a resolution must carry the amendment that corrected the disputed version', async () => {
    const projectId = await freshProject();
    const line = await issuedMaterialLine(projectId, { qty: '120', baseRate: '1' });
    await acceptOnLine(projectId, line, '100', '100');
    const over = await claim(projectId, line.vendorId, line.poLineId, '120', { number: 'R4-F5' });
    expect(over.status).toBe('disputed');

    await expect(t.prisma.$executeRawUnsafe(
      `UPDATE "VendorBill" SET "status"='resolved' WHERE "id"=$1`, over.id,
    )).rejects.toThrow(/resolved by AMENDING it/u);
    // the database captured WHICH version was disputed, and no writer can say otherwise
    expect((await t.prisma.vendorBill.findFirstOrThrow({ where: { id: over.id } })).disputedAtVersion).toBe(1);
    expect(await statusOf(projectId, over.id)).toBe('disputed');
    // …so the document number is still held: the same invoice cannot be re-filed alongside it
    await expect(bills.record(projectId, {
      vendorId: line.vendorId, vendorBillNumber: 'R4-F5', documentDate: '2026-08-20',
      lines: [{ poLineId: line.poLineId, quantity: '100', rate: '1' }],
    }, pmc(projectId))).rejects.toThrow(/already/u);

    // the REAL resolution — an amendment superseding the disputed version — still works, so the
    // seal is precise rather than merely strict
    const resolved = await bills.amend(projectId, {
      billId: over.id, reason: 'vendor corrected the claim to the delivered quantity',
      lines: [{ poLineId: line.poLineId, quantity: '100', rate: '1' }],
    }, pmc(projectId));
    expect(resolved.status).toBe('resolved');
    expect((await t.prisma.vendorBill.findFirstOrThrow({ where: { id: over.id } })).disputedAtVersion).toBe(1);
  });

  // ── Codex round-5 findings, reproduce-first ───────────────────────────────────────────────────

  /**
   * R5-F1 — a seal that inspects the MEMBERS of a set passes vacuously when the set is EMPTY. A
   * `draft` bill written with no version at all, then moved to `submitted`, iterated nothing: no
   * version check, no line check, no bound check. What stood was a LIVE claim with no immutable
   * version and no lines, holding the duplicate-document key against the vendor's real invoice.
   */
  it('R5-F1 (§F/§G): a bill cannot become LIVE with no current version or no lines', async () => {
    const projectId = await freshProject();
    const line = await issuedMaterialLine(projectId, { qty: '100', baseRate: '1' });
    await acceptOnLine(projectId, line, '100', '100');
    const commandId = (await t.prisma.commandExecution.findFirstOrThrow({ where: { projectId } })).id;

    // a bare bill root with nothing to claim. Round 5 sealed this for LIVE statuses only; round 6
    // showed `disputed` had the same hole, so the invariant now holds for EVERY state — a bill row
    // IS a claim, and a claim that states nothing is not a claim in any state. It is therefore
    // refused at the moment it is created, which is the strongest form of the same rule.
    await expect(t.prisma.$executeRawUnsafe(
      `INSERT INTO "VendorBill" ("id","projectId","vendorId","vendorBillNumber","documentDate","status","createdById","sourceCommandId")
       VALUES ('r5f1-empty',$1,$2,'R5-F1','2026-08-20','draft',$3,$4)`,
      projectId, line.vendorId, f.memberUser.id, commandId,
    )).rejects.toThrow(/current version|no claim line/u);
    expect(await t.prisma.vendorBill.findFirst({ where: { id: 'r5f1-empty' } })).toBeNull();

    // …and the ordinary claim still submits, so the seal is precise rather than merely strict
    const real = await claim(projectId, line.vendorId, line.poLineId, '10');
    expect(real.status).toBe('submitted');
  });

  /**
   * R5-F2 — round 2 stopped `disputed → resolved` overwriting the dispute reason. The same hole was
   * still open at `disputed → rejected`, which is a legal transition carrying its OWN required
   * reason. Both facts are real: the breach is the EVIDENCE that took the claim out of the live
   * fold, the rejection is a JUDGEMENT about the claim — so neither is discarded.
   */
  it('R5-F2 (§F): rejecting a DISPUTED claim keeps why it was disputed', async () => {
    const projectId = await freshProject();
    const line = await issuedMaterialLine(projectId, { qty: '120', baseRate: '1' });
    await acceptOnLine(projectId, line, '100', '100');
    const over = await claim(projectId, line.vendorId, line.poLineId, '120');
    expect(over.status).toBe('disputed');
    expect(over.statusReason).toMatch(/qty-over-accepted/u);

    const rejected = await bills.reject(projectId, {
      billId: over.id, reason: 'duplicate of invoice V-1 already on file',
    }, pmc(projectId));
    expect(rejected.status).toBe('rejected');
    // the JUDGEMENT is recorded…
    expect(rejected.statusReason).toBe('duplicate of invoice V-1 already on file');
    // …and the EVIDENCE for why it left the live fold survives it
    expect(rejected.disputeReason).toMatch(/qty-over-accepted/u);

    // the captured evidence is unwritable, like the version it was captured with
    await expect(t.prisma.$executeRawUnsafe(
      `UPDATE "VendorBill" SET "disputeReason"='a different story' WHERE "id"=$1`, over.id,
    )).resolves.toBeDefined();
    expect((await t.prisma.vendorBill.findFirstOrThrow({ where: { id: over.id } })).disputeReason)
      .toMatch(/qty-over-accepted/u);
  });

  /**
   * R5-F3 — the dispute CAS guarded the bill's STATUS, but the quantity being disputed was read off
   * its current VERSION. A concurrent amendment replaces the version without touching the status,
   * so the CAS succeeded and disputed a claim that had just become valid.
   *
   * Deterministic, not raced: the transaction client is wrapped so the concurrent amendment commits
   * between the disposition's read and its CAS — the exact ordering the defect needs.
   */
  it('R5-F3 (§E): the dispute CAS guards the VERSION its quantity came from', async () => {
    const projectId = await freshProject();
    const line = await issuedMaterialLine(projectId, { qty: '120', baseRate: '1' });
    await acceptOnLine(projectId, line, '100', '100');
    const bill = await claim(projectId, line.vendorId, line.poLineId, '100', { number: 'R5-F3' });
    expect(bill.status).toBe('submitted');

    const disputed = await t.prisma.$transaction(async (tx) => bills.disputeClaimsBeyondEvidence(
      wedgeFirstBillUpdate(tx, async () => {
        // the vendor corrects 100 → 70 while the disposition is mid-flight; the bill stays
        // `submitted`, so a status-only CAS cannot tell that the number it read is gone
        await bills.amend(projectId, {
          billId: bill.id, reason: 'vendor corrected the claimed quantity',
          lines: [{ poLineId: line.poLineId, quantity: '70', rate: '1' }],
        }, pmc(projectId));
      }),
      projectId, 'material', line.poLineId, new Prisma.Decimal('80'),
      'qty-over-accepted: evidence withdrawn', { actorId: f.memberUser.id, role: 'pmc' },
    ));

    // 70 ≤ 80 — the corrected claim is valid and must be left alone
    expect(disputed).toEqual([]);
    expect(await statusOf(projectId, bill.id)).toBe('submitted');
    expect(await billedQty(projectId, line.poLineId, 'material')).toBe('70');
  });

  /**
   * R5-F4 — round 4 required a resolution to CARRY an amendment; that only made the evidence EXIST.
   * Because §0 keeps a disputed bill out of every billed set, the replacement was measured as
   * claiming nothing, so a 120-unit claim against 100 accepted could be "corrected" to 150 and
   * resolve cleanly — releasing the duplicate-document key on a correction that corrects nothing.
   */
  it('R5-F4 (§G): a resolution whose replacement still breaches the evidence is REFUSED', async () => {
    const projectId = await freshProject();
    const line = await issuedMaterialLine(projectId, { qty: '200', baseRate: '1' });
    await acceptOnLine(projectId, line, '100', '100');
    const over = await claim(projectId, line.vendorId, line.poLineId, '120', { number: 'R5-F4' });
    expect(over.status).toBe('disputed');

    await expect(bills.amend(projectId, {
      billId: over.id, reason: 'vendor insists the figure is higher',
      lines: [{ poLineId: line.poLineId, quantity: '150', rate: '1' }],
    }, pmc(projectId))).rejects.toThrow(/does not resolve the dispute/u);

    // the claim is untouched — still disputed, still on v1, still holding its document number
    expect(await statusOf(projectId, over.id)).toBe('disputed');
    const reloaded = await bills.readOne(projectId, over.id, pmc(projectId));
    expect(reloaded.versions).toHaveLength(1);
    expect(reloaded.versions[0]!.supersededAt).toBeNull();
    await expect(bills.record(projectId, {
      vendorId: line.vendorId, vendorBillNumber: 'R5-F4', documentDate: '2026-08-20',
      lines: [{ poLineId: line.poLineId, quantity: '100', rate: '1' }],
    }, pmc(projectId))).rejects.toThrow(/already/u);

    // …and an HONEST correction resolves, so the guard is precise rather than merely strict
    const resolved = await bills.amend(projectId, {
      billId: over.id, reason: 'vendor corrected the claim to the delivered quantity',
      lines: [{ poLineId: line.poLineId, quantity: '100', rate: '1' }],
    }, pmc(projectId));
    expect(resolved.status).toBe('resolved');
  });

  /**
   * R6-F1 — round 5 put the resolution check in the SERVICE and left the database proving only that
   * a replacement version EXISTS. Existence was never the invariant; sufficiency is. A direct writer
   * can hold the bill at `disputed`, supersede v1, insert an over-bound v2 (the line and bound
   * triggers fold zero, because a disputed bill is not live) and then resolve — releasing the
   * duplicate-document key for a correction that still breaches the evidence.
   */
  it('R6-F1 (§G): the DATABASE runs a resolution\'s replacement through the bound check', async () => {
    const projectId = await freshProject();
    const line = await issuedMaterialLine(projectId, { qty: '200', baseRate: '1' });
    await acceptOnLine(projectId, line, '100', '100');
    const over = await claim(projectId, line.vendorId, line.poLineId, '120', { number: 'R6-F1' });
    expect(over.status).toBe('disputed');
    const v1 = await t.prisma.vendorBillVersion.findFirstOrThrow({ where: { projectId, billId: over.id, supersededAt: null } });

    // straight past the service: supersede v1 and enter a v2 that claims MORE, all while disputed.
    // ONE transaction, because the deferred seals are commit-scoped — a lone supersede would leave
    // the bill with no current version and be refused on its own.
    await t.prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(
        `UPDATE "VendorBillVersion" SET "supersededAt"=now(), "supersededById"=$2, "supersedeReason"='vendor insists' WHERE "id"=$1`,
        v1.id, f.memberUser.id,
      );
      await tx.$executeRawUnsafe(
        `INSERT INTO "VendorBillVersion" ("id","projectId","billId","vendorIdPin","version","supersedesVersion","claimedAmount","lineCount","createdById")
         VALUES ('r6f1-v2',$1,$2,$3,2,1,150.00,1,$4)`,
        projectId, over.id, line.vendorId, f.memberUser.id,
      );
      await tx.$executeRawUnsafe(
        `INSERT INTO "VendorBillLine" ("id","projectId","versionId","billId","vendorId","type","poLineId","quantity","rate","taxAmount","freightAmount","amount")
         VALUES ('r6f1-l2',$1,'r6f1-v2',$2,$3,'material',$4,150,1,0,0,150.00)`,
        projectId, over.id, line.vendorId, line.poLineId,
      );
    });

    await expect(t.prisma.$executeRawUnsafe(
      `UPDATE "VendorBill" SET "status"='resolved', "statusChangedAt"=now() WHERE "id"=$1`, over.id,
    )).rejects.toThrow(/Bound 2 breached/u);
    expect(await statusOf(projectId, over.id)).toBe('disputed');
  });

  /**
   * R6-F2 — `draft → disputed` was accepted while the evidence seal only covered LIVE statuses, so a
   * version-less bill could be disputed: out of every billed fold, yet still holding the vendor's
   * document number, with no lines saying what was claimed and no `disputedAtVersion`, so it could
   * never be resolved either. The invariant is now stated over the whole lifecycle.
   */
  it('R6-F2 (§F): a claim must state something in EVERY state, disputed included', async () => {
    const projectId = await freshProject();
    const line = await issuedMaterialLine(projectId, { qty: '100', baseRate: '1' });
    await acceptOnLine(projectId, line, '100', '100');
    const commandId = (await t.prisma.commandExecution.findFirstOrThrow({ where: { projectId } })).id;

    for (const status of ['draft', 'disputed', 'rejected']) {
      await expect(t.prisma.$executeRawUnsafe(
        `INSERT INTO "VendorBill" ("id","projectId","vendorId","vendorBillNumber","documentDate","status","statusReason","createdById","sourceCommandId")
         VALUES ($1,$2,$3,$4,'2026-08-20','draft','seeded',$5,$6)`,
        `r6f2-${status}`, projectId, line.vendorId, `R6-F2-${status}`, f.memberUser.id, commandId,
      )).rejects.toThrow(/current version|no claim line/u);
    }
    // …and a real claim is unaffected, so the invariant is precise rather than merely strict
    const real = await claim(projectId, line.vendorId, line.poLineId, '10');
    expect(real.status).toBe('submitted');
  });

  /**
   * R6-F3 — round 5 cleared the dispute evidence at creation and left `statusReason` itself
   * pre-loadable. A bill inserted with a reason already populated then moved `draft → rejected`
   * reads as reasoned, while the justification was written before anyone decided anything.
   */
  it('R6-F3 (§F): an exit reason cannot be pre-loaded at creation', async () => {
    const projectId = await freshProject();
    const line = await issuedMaterialLine(projectId, { qty: '100', baseRate: '1' });
    await acceptOnLine(projectId, line, '100', '100');
    const commandId = (await t.prisma.commandExecution.findFirstOrThrow({ where: { projectId } })).id;

    // a complete, legal claim — except that it arrives with its exit justification already written
    await t.prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(
        `INSERT INTO "VendorBill" ("id","projectId","vendorId","vendorBillNumber","documentDate","status","statusReason","createdById","sourceCommandId")
         VALUES ('r6f3',$1,$2,'R6-F3','2026-08-20','draft','pre-loaded justification',$3,$4)`,
        projectId, line.vendorId, f.memberUser.id, commandId,
      );
      await tx.$executeRawUnsafe(
        `INSERT INTO "VendorBillVersion" ("id","projectId","billId","vendorIdPin","version","claimedAmount","lineCount","createdById")
         VALUES ('r6f3-v1',$1,'r6f3',$2,1,10.00,1,$3)`,
        projectId, line.vendorId, f.memberUser.id,
      );
      await tx.$executeRawUnsafe(
        `INSERT INTO "VendorBillLine" ("id","projectId","versionId","billId","vendorId","type","poLineId","quantity","rate","taxAmount","freightAmount","amount")
         VALUES ('r6f3-l1',$1,'r6f3-v1','r6f3',$2,'material',$3,10,1,0,0,10.00)`,
        projectId, line.vendorId, line.poLineId,
      );
    });

    // the creation guard DISCARDS it: a claim that has just been created has left nothing
    expect((await t.prisma.vendorBill.findFirstOrThrow({ where: { id: 'r6f3' } })).statusReason).toBeNull();

    // …so an exit can no longer INHERIT a justification nobody wrote at the time it was decided
    await expect(t.prisma.$executeRawUnsafe(
      `UPDATE "VendorBill" SET "status"='rejected', "statusChangedAt"=now() WHERE "id"='r6f3'`,
    )).rejects.toThrow(/reason|nonblank|check/iu);
    expect(await statusOf(projectId, 'r6f3')).toBe('draft');
  });
});