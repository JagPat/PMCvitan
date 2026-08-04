import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { Prisma } from '@prisma/client';
import { createTestApp, type TestApp } from './test-app';
import { createTwoProjectFixture, type TwoProjectFixture } from './fixtures';
import { RequirementsService } from '../../src/activities/requirements.service';
import { ProcurementService } from '../../src/procurement/procurement.service';
import { PurchaseOrdersService } from '../../src/procurement/purchase-orders.service';
import { VendorsService } from '../../src/procurement/vendors.service';
import { InventoryService } from '../../src/inventory/inventory.service';
import { CommercialService } from '../../src/commercial/commercial.service';
import { CommercialActivationService } from '../../src/commercial/commercial-activation.service';
import { CommercialBudgetService } from '../../src/commercial/commercial-budget.service';
import { CommercialBudgetQuery } from '../../src/commercial/commercial-budget.query';
import { CapabilitiesService, COMMERCIAL_CAPABILITY, MATERIALS_CAPABILITY } from '../../src/platform/capabilities.service';
import type { AuthUser } from '../../src/common/auth';
import type { CreateRequirementInput } from '../../src/contracts';

/**
 * Phase 5 Task 2 — §B budget, the §C `COMMITTED` fold, and the over-budget exception, proven live
 * against PostgreSQL, reproduce-first.
 *
 *   5af  §B the cost-head key is immutable, and the legitimate reclassification path works
 *   5am  §B `(projectId, code)` is unique per project; two projects may each hold `CIVIL`
 *   5aq  §B budget scope is single-valued at PG — a second live chain and a negative amount
 *        are both unrepresentable, so `BUDGET(costHead)` is never ambiguous or nonsensical
 *   5bu  §C `COMMITTED` reads the real obligation for BACKFILLED rows — the Task-1 activation
 *        backfill is not merely present, it is READ
 *   5bw  §C each PO line is read through its OWNING module — ₹100 material + ₹40 labour on one
 *        head folds to ₹140, and neither read crosses a module boundary
 *   5bm  §J budget is AUTHORITY, not exposure — RED against `BUDGET − COMMITTED`, which reports
 *        full headroom for a fully-accepted order because `COMMITTED` is already zero
 *   5bq  §B the exception fires from EVERY input that moves headroom — a commitment, a budget
 *        revision with no commitment write at all, and a re-attribution that raises on the
 *        target while clearing the source
 */
describe('Phase 5 Task 2 — §B budget + §C COMMITTED + the over-budget exception (live PG)', () => {
  let t: TestApp;
  let f: TwoProjectFixture;
  let requirements: RequirementsService;
  let procurement: ProcurementService;
  let pos: PurchaseOrdersService;
  let vendors: VendorsService;
  let inventory: InventoryService;
  let commercial: CommercialService;
  let activation: CommercialActivationService;
  let budget: CommercialBudgetService;
  let budgetQuery: CommercialBudgetQuery;
  let capabilities: CapabilitiesService;
  let seq = 0;

  const TRUNCATE =
    'TRUNCATE TABLE "SodException", "SodGrant", "CertifiedMeasurementConsumption", "CertifiedAcceptanceConsumption", "BillCertificate", "BillVerification", "VendorBillLine", "VendorBillVersion", "VendorBill", "DomainEvent", "OutboxDelivery", "ProcessedEvent", "ProjectionCursor", "ProjectionGeneration", "DecisionProjection", "DailyLogProjection", "DrawingsProjection", "InspectionsProjection", "ActivitiesProjection", "MaterialReadinessProjection", "LabourReadinessProjection", "BudgetException", "BudgetLine", "CommitmentAttribution", "CostHead", "LabourMismatchResolution", "LabourMismatch", "ActivityWorkOutput", "MismatchResolution", "SiteMaterial", "LabourWorkFact", "WorkerAllocation", "LabourAttendance", "ApprovedSkillSubstitution", "CapacityPromise", "CapacityCommitment", "LabourPurchaseOrderLine", "LabourPurchaseOrderVersion", "LabourPurchaseOrder", "SupplierLabourQuoteLine", "SupplierLabourQuote", "LabourQuoteComparison", "LabourRfq", "LabourRequisitionLine", "LabourRequisition", "VendorLabourProfile", "StockTransaction", "StockLot", "MaterialIssue", "DeliveryPromise", "DeliveryCommitment", "PurchaseOrderLine", "PurchaseOrderVersion", "PurchaseOrder", "VendorQuoteLine", "VendorQuote", "QuoteComparison", "Rfq", "RequisitionLine", "Requisition", "ProjectVendor", "CommandExecution", "CrewMembership", "Crew", "WorkerDevice", "WorkerSkill", "Worker", "LabourDemandSlice", "LabourRequirementSpec", "LabourTrade", "LabourSkill", "ApprovedSubstitution", "MaterialRequirementSpec", "ActivityRequirement", "ActivityRequirementRoot", "DecisionApprovalRevision", "ProjectCapability" CASCADE';

  const pmc = (projectId: string): AuthUser => ({ sub: f.memberUser.id, role: 'pmc', projectId }) as AuthUser;
  const engineer = (projectId: string): AuthUser => ({ sub: f.memberUser.id, role: 'engineer', projectId }) as AuthUser;
  const orgAdmin = (): AuthUser => ({ sub: f.ownerUser.id, role: 'pmc', orgId: f.orgA.id }) as AuthUser;

  beforeAll(async () => {
    t = await createTestApp();
    f = await createTwoProjectFixture(t.prisma);
    requirements = t.app.get(RequirementsService);
    procurement = t.app.get(ProcurementService);
    pos = t.app.get(PurchaseOrdersService);
    vendors = t.app.get(VendorsService);
    inventory = t.app.get(InventoryService);
    commercial = t.app.get(CommercialService);
    activation = t.app.get(CommercialActivationService);
    budget = t.app.get(CommercialBudgetService);
    budgetQuery = t.app.get(CommercialBudgetQuery);
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
      ['auditLog', { projectId: { startsWith: 'it-p5t2-' } }],
      // the acceptance-evidence photos this suite creates hold an FK to the project
      ['media', { projectId: { startsWith: 'it-p5t2-' } }],
      ['activity', { projectId: { startsWith: 'it-p5t2-' } }],
      ['membership', { projectId: { startsWith: 'it-p5t2-' } }],
      ['project', { id: { startsWith: 'it-p5t2-' } }],
    ] as const) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (t.prisma as any)[model].deleteMany({ where });
    }
  });

  // ── fixtures ──────────────────────────────────────────────────────────────────────────────────

  const freshProject = async (): Promise<string> => {
    const id = `it-p5t2-${Date.now() % 1e6}-${seq++}`;
    await t.prisma.project.create({
      data: { id, orgId: f.orgA.id, name: id, short: 'P', descriptor: '', stage: 'x', siteCode: 'P', projStart: 'a', projEnd: 'b', elapsedPct: 0, todayDay: 0, milestonePct: 0, timeZone: 'Asia/Kolkata', scheduleStartDate: new Date('2026-06-01T00:00:00.000Z') },
    });
    await t.prisma.membership.create({ data: { projectId: id, userId: f.memberUser.id, role: 'pmc', status: 'active' } });
    return id;
  };
  const freshActivity = async (projectId: string): Promise<string> => {
    const id = `IT-P5T2-ACT-${Date.now() % 1e6}-${seq++}`;
    await t.prisma.activity.create({ data: { id, projectId, name: `Act ${seq}`, zone: 'Zone 1', plannedStart: 0, plannedEnd: 10 } });
    return id;
  };
  const enableCommercial = (projectId: string, heads: Array<{ code: string; name: string }> = [{ code: 'CIVIL', name: 'Civil works' }, { code: 'MEP', name: 'MEP' }]) =>
    activation.activate(projectId, f.memberUser.id, { costHeads: heads, materialLines: [], labourLines: [], reason: 'pilot activation' });

  /** requirement → approved comparison → DRAFT material PO with the given frozen commercials. */
  const draftPo = async (
    projectId: string, activityId: string,
    money: { qty?: string; baseRate?: string; taxAmount?: string; freightAmount?: string } = {},
  ): Promise<{ poId: string; poLineId: string; requisitionLineId: string }> => {
    const qty = money.qty ?? '100';
    const input: CreateRequirementInput = {
      activityId, materialCategory: 'Cement', make: 'UltraTech', grade: 'OPC 53', attributes: 'grey',
      baseUom: 'bag', qty, requiredBy: '2026-08-15', criticality: 'normal', decisionId: null,
      responsibleId: null, tolerance: null,
    };
    const req = await requirements.create(projectId, input, pmc(projectId));
    const created = await procurement.createRequisition(projectId, { title: `Req ${seq++}`, lines: [{ requirementId: req.requirementId, revision: req.revision, qty }] }, pmc(projectId));
    await procurement.submit(projectId, created.id, pmc(projectId));
    const requisition = await procurement.approve(projectId, created.id, pmc(projectId));
    const lineId = requisition.lines[0]!.id;
    const rfq = await procurement.createRfq(projectId, { requisitionId: requisition.id }, pmc(projectId));
    const vendor = await vendors.create(f.orgA.id, { name: `Vendor ${seq++}` }, orgAdmin());
    await vendors.bind(projectId, { vendorId: vendor.id }, pmc(projectId));
    const withQuote = await procurement.recordQuote(projectId, rfq.id, {
      vendorId: vendor.id, validUntil: '2027-01-01',
      lines: [{ requisitionLineId: lineId, baseRate: money.baseRate ?? '1', taxAmount: money.taxAmount ?? '0', freightAmount: money.freightAmount ?? '0', landedCost: '999.99', quotedMake: 'make', matchesSpecification: true }],
    }, pmc(projectId));
    const quoteId = withQuote.quotes.find((q) => q.status === 'recorded')!.id;
    await procurement.createComparison(projectId, rfq.id, pmc(projectId));
    const approved = await procurement.approveComparison(projectId, rfq.id, { selectedQuoteId: quoteId, reason: 'single quote, in spec' }, pmc(projectId));
    const po = await pos.create(projectId, { comparisonId: approved.comparison!.id, lines: [{ requisitionLineId: lineId, purchaseQty: qty }] }, pmc(projectId));
    const line = await t.prisma.purchaseOrderLine.findFirstOrThrow({ where: { projectId, requisitionLineId: lineId } });
    return { poId: po.id, poLineId: line.id, requisitionLineId: lineId };
  };

  const freshMedia = async (projectId: string): Promise<string> => {
    const row = await t.prisma.media.create({ data: { projectId, kind: 'material', mime: 'image/jpeg', uploadedBy: f.memberUser.id, sizeBytes: 3 } });
    return row.id;
  };

  const positionOf = (projectId: string, code: string) =>
    t.prisma.$transaction(async (tx) => (await budgetQuery.positionsFor(tx, projectId, [code])).get(code)!);
  const openExceptions = (projectId: string) =>
    t.prisma.budgetException.findMany({ where: { projectId, clearedAt: null }, orderBy: { costHeadCode: 'asc' } });

  // ── PROBE 5am / 5af — the cost head is a KEY: unique, and frozen ──────────────────────────────

  it('PROBE 5am/5af (§B): the cost-head key is unique per project and FROZEN, and the legitimate reclassification path still works', async () => {
    const a = await freshProject();
    const b = await freshProject();
    await enableCommercial(a);
    await enableCommercial(b);

    // 5am — a SECOND `CIVIL` in one project is refused; two PROJECTS may each hold one, and a
    // budget and an attribution under one project's CIVIL always meet in the same head.
    await expect(
      t.prisma.costHead.create({ data: { projectId: a, code: 'CIVIL', name: 'Duplicate', definedById: f.memberUser.id } }),
    ).rejects.toThrow();
    expect(await t.prisma.costHead.count({ where: { code: 'CIVIL' } })).toBe(2); // one per project

    // 5af — the freeze is on the COLUMN, not on usage: a bare head is just as unrenameable
    await commercial.defineCostHead(a, { code: 'BARE', name: 'Never used' }, pmc(a));
    await expect(
      t.prisma.$executeRawUnsafe(`UPDATE "CostHead" SET "code"='RENAMED' WHERE "projectId"=$1 AND "code"='BARE'`, a),
    ).rejects.toThrow(/frozen after write/u);
    // …and a head carrying a budget is equally frozen
    await budget.setBudget(a, { costHeadCode: 'CIVIL', amount: '100.00', reason: 'initial plan' }, pmc(a));
    await expect(
      t.prisma.$executeRawUnsafe(`UPDATE "CostHead" SET "code"='CIVIL2' WHERE "projectId"=$1 AND "code"='CIVIL'`, a),
    ).rejects.toThrow(/frozen after write/u);
    // the display name is a label, not a key — it stays editable
    await expect(
      t.prisma.costHead.update({ where: { projectId_code: { projectId: a, code: 'CIVIL' } }, data: { name: 'Civil (revised label)' } }),
    ).resolves.toMatchObject({ name: 'Civil (revised label)' });
  });

  // ── PROBE 5aq — budget scope is single-valued ─────────────────────────────────────────────────

  it('PROBE 5aq (§B): a second LIVE budget chain and a negative amount are both unrepresentable', async () => {
    const projectId = await freshProject();
    await enableCommercial(projectId);
    await budget.setBudget(projectId, { costHeadCode: 'CIVIL', amount: '100.00', reason: 'v1' }, pmc(projectId));

    // a second LIVE row for the same head — `BUDGET(costHead)` would be ambiguous
    await expect(
      t.prisma.budgetLine.create({ data: { projectId, costHeadCode: 'CIVIL', amount: new Prisma.Decimal(50), version: 99, reason: 'second live chain', createdById: f.memberUser.id } }),
    ).rejects.toThrow();
    // a NEGATIVE amount would feed nonsensical capacity into the exception before any PO exists
    await expect(
      t.prisma.budgetLine.create({ data: { projectId, costHeadCode: 'MEP', amount: new Prisma.Decimal(-1), version: 1, reason: 'negative', createdById: f.memberUser.id } }),
    ).rejects.toThrow();

    // a revision supersedes and appends — the chain is immutable and monotonic
    await budget.setBudget(projectId, { costHeadCode: 'CIVIL', amount: '150.00', reason: 'scope grew' }, pmc(projectId));
    const rows = await t.prisma.budgetLine.findMany({ where: { projectId, costHeadCode: 'CIVIL' }, orderBy: { version: 'asc' } });
    expect(rows.map((r) => [r.version, r.amount.toString(), r.supersededAt === null])).toEqual([[1, '100', false], [2, '150', true]]);
    expect((await positionOf(projectId, 'CIVIL')).budget!.toString()).toBe('150');
    // the superseded row is history: it cannot be edited or deleted
    await expect(
      t.prisma.$executeRawUnsafe(`UPDATE "BudgetLine" SET "amount"=999 WHERE "id"=$1`, rows[0]!.id),
    ).rejects.toThrow(/already superseded|frozen after write/u);
    await expect(
      t.prisma.$executeRawUnsafe(`DELETE FROM "BudgetLine" WHERE "id"=$1`, rows[0]!.id),
    ).rejects.toThrow(/append-only/u);
  });

  // ── PROBE 5bu — the Task-1 backfill is READ, not merely present ───────────────────────────────

  it('PROBE 5bu (§C): COMMITTED reads the real obligation for BACKFILLED rows, with no commercial command since activation', async () => {
    const projectId = await freshProject();
    await capabilities.enable(projectId, MATERIALS_CAPABILITY, f.memberUser.id);
    const activityId = await freshActivity(projectId);
    // a live ₹100 PO exists BEFORE commercial is enabled — the §L state the backfill exists for
    const { poId, poLineId } = await draftPo(projectId, activityId, { qty: '100', baseRate: '1.00' });
    await pos.issue(projectId, poId, {}, pmc(projectId));

    await activation.activate(projectId, f.memberUser.id, {
      costHeads: [{ code: 'CIVIL', name: 'Civil works' }],
      materialLines: [{ poLineId, costHeadCode: 'CIVIL' }],
      labourLines: [], reason: 'activation attributes the existing order',
    });

    // NO commercial command has run since activation. The fold reads the backfilled row.
    expect((await positionOf(projectId, 'CIVIL')).committed.toString()).toBe('100');
  });

  // ── PROBE 5bm — budget is AUTHORITY, not exposure ─────────────────────────────────────────────

  it('PROBE 5bm (§J): a fully-accepted unbilled order still consumes headroom — RED against BUDGET − COMMITTED', async () => {
    const projectId = await freshProject();
    await capabilities.enable(projectId, MATERIALS_CAPABILITY, f.memberUser.id);
    await enableCommercial(projectId, [{ code: 'CIVIL', name: 'Civil works' }]);
    await budget.setBudget(projectId, { costHeadCode: 'CIVIL', amount: '100.00', reason: 'plan' }, pmc(projectId));
    const activityId = await freshActivity(projectId);

    const { poId, poLineId } = await draftPo(projectId, activityId, { qty: '100', baseRate: '1.00' });
    await pos.issue(projectId, poId, { costHeads: [{ poLineId, costHeadCode: 'CIVIL' }] }, pmc(projectId));
    const commitment = await pos.commitDelivery(projectId, { poLineId, promisedDate: '2026-09-01' }, pmc(projectId));

    // before receipt: the whole ₹100 is committed, headroom exactly zero
    let position = await positionOf(projectId, 'CIVIL');
    expect(position.committed.toString()).toBe('100');
    expect(position.headroom!.toString()).toBe('0');

    // receive and ACCEPT the whole order
    const lot = await inventory.recordReceipt(projectId, {
      poLineId, commitmentId: commitment.id, storeLocation: 'main', purchaseQty: '100',
    }, pmc(projectId));
    await inventory.accept(projectId, { lotId: lot.id, storeLocation: 'main', qty: '100', qualityResult: 'pass', evidenceMediaId: await freshMedia(projectId) }, pmc(projectId));

    // COMMITTED is now ZERO — the order is fully delivered. `BUDGET − COMMITTED` would report the
    // full ₹100 of headroom, which is the exact spelling this probe is RED against. The money is
    // still exposed: it moved to `received-not-billed`, and the buckets PARTITION the ₹100.
    position = await positionOf(projectId, 'CIVIL');
    expect(position.committed.toString()).toBe('0');
    expect(position.receivedNotBilled.toString()).toBe('100');
    expect(position.headroom!.toString()).toBe('0');
    expect(position.committed.add(position.receivedNotBilled).toString()).toBe('100');
  });

  // ── PROBE 5bq — the exception fires from EVERY input that moves headroom ──────────────────────

  it('PROBE 5bq (§B): a commitment, a budget revision with NO commitment write, and a re-attribution each raise it — the re-attribution clearing the source', async () => {
    const projectId = await freshProject();
    await capabilities.enable(projectId, MATERIALS_CAPABILITY, f.memberUser.id);
    await enableCommercial(projectId, [{ code: 'CIVIL', name: 'Civil works' }, { code: 'MEP', name: 'MEP' }]);
    await budget.setBudget(projectId, { costHeadCode: 'CIVIL', amount: '100.00', reason: 'civil plan' }, pmc(projectId));
    await budget.setBudget(projectId, { costHeadCode: 'MEP', amount: '50.00', reason: 'mep plan' }, pmc(projectId));
    const activityId = await freshActivity(projectId);

    // (a) a COMMITMENT raises it — ₹90 fits under ₹100, a further ₹20 does not
    const first = await draftPo(projectId, activityId, { qty: '90', baseRate: '1.00' });
    await pos.issue(projectId, first.poId, { costHeads: [{ poLineId: first.poLineId, costHeadCode: 'CIVIL' }] }, pmc(projectId));
    expect(await openExceptions(projectId)).toHaveLength(0);

    const second = await draftPo(projectId, activityId, { qty: '20', baseRate: '1.00' });
    await pos.issue(projectId, second.poId, { costHeads: [{ poLineId: second.poLineId, costHeadCode: 'CIVIL' }] }, pmc(projectId));
    let open = await openExceptions(projectId);
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ costHeadCode: 'CIVIL', raisedBy: 'commitment' });
    expect(open[0]!.headroom.toString()).toBe('-10');

    // cancelling the ₹20 order CLEARS it — the Inbox must not keep an action for a breach that no
    // longer exists
    await pos.cancel(projectId, second.poId, { reason: 'ordered in error' }, pmc(projectId));
    expect(await openExceptions(projectId)).toHaveLength(0);

    // (b) a BUDGET REVISION raises it with NO commitment write anywhere — §B calls this the most
    // ordinary case, and a commitment-only trigger is silent here
    await budget.setBudget(projectId, { costHeadCode: 'CIVIL', amount: '50.00', reason: 'budget cut' }, pmc(projectId));
    open = await openExceptions(projectId);
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ costHeadCode: 'CIVIL', raisedBy: 'budget_revision' });
    expect(open[0]!.headroom.toString()).toBe('-40');

    // (c) a RE-ATTRIBUTION raises on the TARGET and clears on the SOURCE. Moving the ₹90 onto the
    // ₹50 MEP head breaches MEP; CIVIL, now carrying nothing, is back within its ₹50.
    await commercial.reattribute(projectId, { poLineId: first.poLineId, costHeadCode: 'MEP', reason: 'miscoded at issuance' }, pmc(projectId));
    open = await openExceptions(projectId);
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ costHeadCode: 'MEP', raisedBy: 'reattribution' });
    expect(open[0]!.headroom.toString()).toBe('-40');
    // Every CIVIL breach survives as history — a breach is never deleted, and the head has had
    // TWO in this probe: one raised by the ₹20 commitment (cleared by the cancel) and one raised
    // by the budget cut (cleared by this re-attribution). Both are closed; neither is erased.
    const civil = await t.prisma.budgetException.findMany({ where: { projectId, costHeadCode: 'CIVIL' }, orderBy: { raisedAt: 'asc' } });
    expect(civil.map((e) => e.raisedBy)).toEqual(['commitment', 'budget_revision']);
    expect(civil.every((e) => e.clearedAt !== null)).toBe(true);
    await expect(
      t.prisma.$executeRawUnsafe(`DELETE FROM "BudgetException" WHERE "id"=$1`, civil[0]!.id),
    ).rejects.toThrow(/append-only/u);
  });

  // ── §B: ACCEPTANCE is the fourth headroom-moving write ────────────────────────────────────────

  it('§B: accepted OVERAGE raises the exception in the accepting transaction, and reversing it clears', async () => {
    const projectId = await freshProject();
    await capabilities.enable(projectId, MATERIALS_CAPABILITY, f.memberUser.id);
    await enableCommercial(projectId, [{ code: 'CIVIL', name: 'Civil works' }]);
    await budget.setBudget(projectId, { costHeadCode: 'CIVIL', amount: '100.00', reason: 'plan' }, pmc(projectId));
    const activityId = await freshActivity(projectId);

    // a ₹100 order against a ₹100 budget: headroom is exactly zero and nothing is flagged
    const { poId, poLineId, requisitionLineId } = await draftPo(projectId, activityId, { qty: '100', baseRate: '1.00' });
    // §G authorises 10 units of overage at ISSUANCE — the only path that may set it
    await pos.issue(projectId, poId, {
      costHeads: [{ poLineId, costHeadCode: 'CIVIL' }],
      overages: [{ requisitionLineId, approvedOverage: '10', reason: 'bagged cement tolerance' }],
    }, pmc(projectId));
    const commitment = await pos.commitDelivery(projectId, { poLineId, promisedDate: '2026-09-01' }, pmc(projectId));
    expect(await openExceptions(projectId)).toHaveLength(0);

    // accepting UP TO the ordered quantity is exposure-NEUTRAL: `committedAmountBase = rate × qty
    // + tax + freight`, so the commitment consumed equals the value received. The money changes
    // bucket; the total does not move, and no exception is raised.
    const lot = await inventory.recordReceipt(projectId, {
      poLineId, commitmentId: commitment.id, storeLocation: 'main', purchaseQty: '110',
    }, pmc(projectId));
    await inventory.accept(projectId, { lotId: lot.id, storeLocation: 'main', qty: '100', qualityResult: 'pass', evidenceMediaId: await freshMedia(projectId) }, pmc(projectId));
    let position = await positionOf(projectId, 'CIVIL');
    expect(position.committed.toString()).toBe('0');
    expect(position.receivedNotBilled.toString()).toBe('100');
    expect(position.headroom!.toString()).toBe('0');
    expect(await openExceptions(projectId)).toHaveLength(0);

    // OVERAGE breaks the symmetry: §G authorises the extra 10 units, §J values them at the frozen
    // rate, and NO commitment is released against them. Exposure goes to ₹110 against a ₹100
    // budget with no PO write anywhere — a commitment-only trigger is silent here, which is the
    // spelling this probe is RED against.
    const overage = await inventory.accept(projectId, { lotId: lot.id, storeLocation: 'main', qty: '10', qualityResult: 'pass', evidenceMediaId: await freshMedia(projectId) }, pmc(projectId));
    expect(overage).toBeDefined();
    position = await positionOf(projectId, 'CIVIL');
    expect(position.receivedNotBilled.toString()).toBe('110');
    expect(position.headroom!.toString()).toBe('-10');
    const open = await openExceptions(projectId);
    expect(open).toHaveLength(1);
    // the label names the DELIVERY, not an order — a PMC sent looking for a purchase order finds
    // nothing, because no purchase order moved
    expect(open[0]).toMatchObject({ costHeadCode: 'CIVIL', raisedBy: 'acceptance' });
    expect(open[0]!.headroom.toString()).toBe('-10');

    // reversing the overage acceptance is the same write in the other direction and CLEARS it
    const overageRow = await t.prisma.stockTransaction.findFirstOrThrow({
      where: { projectId, lotId: lot.id, type: 'acceptance', qty: new Prisma.Decimal('10') },
    });
    await inventory.reverse(projectId, { txId: overageRow.id, reason: 'miscounted at the gate' }, pmc(projectId));
    position = await positionOf(projectId, 'CIVIL');
    expect(position.receivedNotBilled.toString()).toBe('100');
    expect(position.headroom!.toString()).toBe('0');
    expect(await openExceptions(projectId)).toHaveLength(0);
  });

  // ── §B round 3: the movers the FOLD's inputs imply, not the ones a list remembered ────────────

  it('§B: reversing a receipt on a CLOSED-SHORT order re-prices the release and CLEARS the exception', async () => {
    const projectId = await freshProject();
    await capabilities.enable(projectId, MATERIALS_CAPABILITY, f.memberUser.id);
    await enableCommercial(projectId, [{ code: 'CIVIL', name: 'Civil works' }]);
    await budget.setBudget(projectId, { costHeadCode: 'CIVIL', amount: '40.00', reason: 'thin plan' }, pmc(projectId));
    const activityId = await freshActivity(projectId);

    const { poId, poLineId } = await draftPo(projectId, activityId, { qty: '100', baseRate: '1.00' });
    await pos.issue(projectId, poId, { costHeads: [{ poLineId, costHeadCode: 'CIVIL' }] }, pmc(projectId));
    const commitment = await pos.commitDelivery(projectId, { poLineId, promisedDate: '2026-09-01' }, pmc(projectId));
    // ₹100 against ₹40 breaches by ₹60
    expect((await openExceptions(projectId))[0]!.headroom.toString()).toBe('-60');

    // receive 50, then close short: the released remainder is `qty - receivedQty` = 50, so the
    // true outstanding exposure is ₹50 and the breach narrows but STANDS
    const lot = await inventory.recordReceipt(projectId, {
      poLineId, commitmentId: commitment.id, storeLocation: 'main', purchaseQty: '50',
    }, pmc(projectId));
    await pos.closeShort(projectId, poId, { reason: 'vendor could not supply the balance' }, pmc(projectId));
    let position = await positionOf(projectId, 'CIVIL');
    expect(position.committed.toString()).toBe('50');
    expect(position.headroom!.toString()).toBe('-10');
    // the breach NARROWED but still stands, so the open row is neither cleared nor replaced. Its
    // stored figures are the state AT RAISE — an exception is an observation of a moment, and the
    // register is append-only, so it is never rewritten. Current truth is the fold above.
    const stillOpen = await openExceptions(projectId);
    expect(stillOpen).toHaveLength(1);
    expect(stillOpen[0]!.headroom.toString()).toBe('-60');

    // NOW reverse the receipt. `receivedQty` returns to 0, so the closed-short line releases the
    // FULL ₹100 and exposure is zero — headroom +₹40. Nothing in the attribution register moved,
    // and no PO command ran: a mover list that named only the attribution lifecycle and acceptance
    // leaves this breach standing forever, which is the spelling this probe is RED against.
    const receipt = await t.prisma.stockTransaction.findFirstOrThrow({ where: { projectId, lotId: lot.id, type: 'receipt' } });
    await inventory.reverse(projectId, { txId: receipt.id, reason: 'goods never actually arrived' }, pmc(projectId));
    position = await positionOf(projectId, 'CIVIL');
    expect(position.committed.toString()).toBe('0');
    expect(position.headroom!.toString()).toBe('40');
    expect(await openExceptions(projectId)).toHaveLength(0);
  });

  it('§B: an AMEND evaluates ONCE at the end — no false clear/re-raise pair in the append-only register', async () => {
    const projectId = await freshProject();
    await capabilities.enable(projectId, MATERIALS_CAPABILITY, f.memberUser.id);
    await enableCommercial(projectId, [{ code: 'CIVIL', name: 'Civil works' }]);
    await budget.setBudget(projectId, { costHeadCode: 'CIVIL', amount: '100.00', reason: 'plan' }, pmc(projectId));
    const activityId = await freshActivity(projectId);

    const { poId, poLineId, requisitionLineId } = await draftPo(projectId, activityId, { qty: '120', baseRate: '1.00' });
    await pos.issue(projectId, poId, { costHeads: [{ poLineId, costHeadCode: 'CIVIL' }] }, pmc(projectId));
    const before = await t.prisma.budgetException.findMany({ where: { projectId, costHeadCode: 'CIVIL' } });
    expect(before).toHaveLength(1);
    expect(before[0]!.clearedAt).toBeNull();

    // amend to a DIFFERENT ₹120 order. Mid-amend the carried line is momentarily the only
    // attributed one, so an evaluate between the three mutations would see less exposure than
    // exists, CLEAR this exception and then re-raise a second one. The register is APPEND-ONLY, so
    // that pair would be permanent evidence of a headroom recovery that never happened.
    await pos.amend(projectId, poId, {
      reason: 'vendor re-quoted the same scope',
      lines: [{ requisitionLineId, purchaseQty: '120' }],
      costHeads: [{ requisitionLineId, costHeadCode: 'CIVIL' }],
    }, pmc(projectId));

    const after = await t.prisma.budgetException.findMany({ where: { projectId, costHeadCode: 'CIVIL' }, orderBy: { raisedAt: 'asc' } });
    // STILL exactly one exception, still open, never cleared — the breach never went away
    expect(after).toHaveLength(1);
    expect(after[0]!.id).toBe(before[0]!.id);
    expect(after[0]!.clearedAt).toBeNull();
    const position = await positionOf(projectId, 'CIVIL');
    expect(position.committed.toString()).toBe('120');
    expect(position.headroom!.toString()).toBe('-20');
  });

  // ── §B round 4: the label describes what MOVED, not which path noticed ────────────────────────

  it('§B: reclassifying THROUGH an amend records `reattribution`, while re-sizing records `commitment`', async () => {
    const projectId = await freshProject();
    await capabilities.enable(projectId, MATERIALS_CAPABILITY, f.memberUser.id);
    await enableCommercial(projectId, [{ code: 'CIVIL', name: 'Civil works' }, { code: 'MEP', name: 'MEP' }]);
    await budget.setBudget(projectId, { costHeadCode: 'CIVIL', amount: '200.00', reason: 'civil plan' }, pmc(projectId));
    await budget.setBudget(projectId, { costHeadCode: 'MEP', amount: '50.00', reason: 'mep plan' }, pmc(projectId));
    const activityId = await freshActivity(projectId);

    const { poId, poLineId, requisitionLineId } = await draftPo(projectId, activityId, { qty: '90', baseRate: '1.00' });
    await pos.issue(projectId, poId, { costHeads: [{ poLineId, costHeadCode: 'CIVIL' }] }, pmc(projectId));
    expect(await openExceptions(projectId)).toHaveLength(0);

    // amend with the SAME quantity but a DIFFERENT head. Nothing about the obligation changed size;
    // the money was RECLASSIFIED onto a head that cannot absorb it. Labelling the resulting breach
    // `commitment` tells the PMC an order moved, which is exactly what did not happen — and the
    // register is append-only, so that wrong explanation is permanent.
    await pos.amend(projectId, poId, {
      reason: 'miscoded at issuance',
      lines: [{ requisitionLineId, purchaseQty: '90' }],
      costHeads: [{ requisitionLineId, costHeadCode: 'MEP' }],
    }, pmc(projectId));

    const open = await openExceptions(projectId);
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ costHeadCode: 'MEP', raisedBy: 'reattribution' });
    expect(open[0]!.headroom.toString()).toBe('-40');
    // and CIVIL, which now carries nothing, is back within its budget
    expect((await positionOf(projectId, 'CIVIL')).committed.toString()).toBe('0');
  });

  it('§B: a receipt-progress breach records `receipt_progress`, never `acceptance`', async () => {
    const projectId = await freshProject();
    await capabilities.enable(projectId, MATERIALS_CAPABILITY, f.memberUser.id);
    await enableCommercial(projectId, [{ code: 'CIVIL', name: 'Civil works' }]);
    await budget.setBudget(projectId, { costHeadCode: 'CIVIL', amount: '40.00', reason: 'plan' }, pmc(projectId));
    const activityId = await freshActivity(projectId);

    const { poId, poLineId } = await draftPo(projectId, activityId, { qty: '100', baseRate: '1.00' });
    await pos.issue(projectId, poId, { costHeads: [{ poLineId, costHeadCode: 'CIVIL' }] }, pmc(projectId));
    const commitment = await pos.commitDelivery(projectId, { poLineId, promisedDate: '2026-09-01' }, pmc(projectId));
    // ₹100 against ₹40 breaches by ₹60, raised by the COMMITMENT
    expect((await openExceptions(projectId))[0]).toMatchObject({ raisedBy: 'commitment' });

    // receive 50 then REJECT all 50, so `receivedQty` nets back to zero; closing short then releases
    // the whole ₹100 and the breach CLEARS on its own — no exposure left to flag
    const lot = await inventory.recordReceipt(projectId, {
      poLineId, commitmentId: commitment.id, storeLocation: 'main', purchaseQty: '50',
    }, pmc(projectId));
    await inventory.reject(projectId, {
      lotId: lot.id, storeLocation: 'main', qty: '50', reason: 'wrong grade', evidenceMediaId: await freshMedia(projectId),
    }, pmc(projectId));
    await pos.closeShort(projectId, poId, { reason: 'vendor withdrew' }, pmc(projectId));
    expect((await positionOf(projectId, 'CIVIL')).committed.toString()).toBe('0');
    expect(await openExceptions(projectId)).toHaveLength(0);

    // NOW reverse the rejection. `receivedQty` goes back to 50, the closed-short release shrinks to
    // ₹50, and exposure of ₹50 against ₹40 breaches AGAIN — through the COMMITTED bucket, with
    // nothing accepted anywhere. Recording that as `acceptance` would send a PMC looking for a
    // delivery that never happened.
    const rejection = await t.prisma.stockTransaction.findFirstOrThrow({ where: { projectId, lotId: lot.id, type: 'rejection' } });
    await inventory.reverse(projectId, { txId: rejection.id, reason: 'rejected the wrong pallet' }, pmc(projectId));

    const open = await openExceptions(projectId);
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ costHeadCode: 'CIVIL', raisedBy: 'receipt_progress' });
    expect(open[0]!.headroom.toString()).toBe('-10');
    // nothing was ever accepted on this lot, which is exactly why the label must not say so
    expect(await t.prisma.stockTransaction.count({ where: { projectId, lotId: lot.id, type: 'acceptance' } })).toBe(0);
  });

  // ── §A/§B: a sub-cent artefact is not a breach ────────────────────────────────────────────────

  it('§A: a sub-cent negative headroom does NOT raise an exception the Decimal(18,2) CHECK would then reject', async () => {
    const projectId = await freshProject();
    await capabilities.enable(projectId, MATERIALS_CAPABILITY, f.memberUser.id);
    await enableCommercial(projectId, [{ code: 'CIVIL', name: 'Civil works' }]);
    const activityId = await freshActivity(projectId);

    // a 3-unit order at ₹10 = ₹30 committed. Accepting ONE unit prorates ₹30 × 1/3 = ₹10 exactly,
    // but the intermediate quotient 1/3 is where a full-precision fold leaves fractional paisa.
    const { poId, poLineId } = await draftPo(projectId, activityId, { qty: '3', baseRate: '10.00' });
    await pos.issue(projectId, poId, { costHeads: [{ poLineId, costHeadCode: 'CIVIL' }] }, pmc(projectId));
    const commitment = await pos.commitDelivery(projectId, { poLineId, promisedDate: '2026-09-01' }, pmc(projectId));
    const lot = await inventory.recordReceipt(projectId, {
      poLineId, commitmentId: commitment.id, storeLocation: 'main', purchaseQty: '3',
    }, pmc(projectId));
    await inventory.accept(projectId, { lotId: lot.id, storeLocation: 'main', qty: '1', qualityResult: 'pass', evidenceMediaId: await freshMedia(projectId) }, pmc(projectId));

    // budgeting EXACTLY the exposure must leave headroom at a clean zero and raise nothing. A fold
    // that decided on unrounded arithmetic would see −0.000…1, write `headroom = -0.000…1`, and
    // PostgreSQL would round it to 0.00 — failing the `headroom < 0` CHECK and ABORTING this very
    // budget write with a 500. The command succeeding IS the assertion.
    const position = await positionOf(projectId, 'CIVIL');
    const exposure = position.committed.add(position.receivedNotBilled);
    expect(exposure.toString()).toBe('30');
    await budget.setBudget(projectId, { costHeadCode: 'CIVIL', amount: exposure.toFixed(2), reason: 'budgeted to the penny' }, pmc(projectId));

    const after = await positionOf(projectId, 'CIVIL');
    expect(after.headroom!.toString()).toBe('0');
    expect(after.headroom!.isNegative()).toBe(false);
    expect(await openExceptions(projectId)).toHaveLength(0);
    // and every persisted figure is at the money scale, so nothing can be re-rounded into a
    // CHECK violation on the way into PostgreSQL
    expect(after.exposure.toFixed(2)).toBe('30.00');
  });

  // ── an UNBUDGETED head has no authority to breach ─────────────────────────────────────────────

  it('§B: an UNBUDGETED cost head raises nothing — no budget is not the same as zero budget', async () => {
    const projectId = await freshProject();
    await capabilities.enable(projectId, MATERIALS_CAPABILITY, f.memberUser.id);
    await enableCommercial(projectId, [{ code: 'CIVIL', name: 'Civil works' }]);
    const activityId = await freshActivity(projectId);
    const { poId, poLineId } = await draftPo(projectId, activityId, { qty: '100', baseRate: '1.00' });
    await pos.issue(projectId, poId, { costHeads: [{ poLineId, costHeadCode: 'CIVIL' }] }, pmc(projectId));

    const position = await positionOf(projectId, 'CIVIL');
    expect(position.budget).toBeNull();
    expect(position.headroom).toBeNull();
    expect(position.committed.toString()).toBe('100');
    expect(await openExceptions(projectId)).toHaveLength(0);
  });

  // ── authority + idempotency on the budget write ───────────────────────────────────────────────

  it('§B/§I: setting a budget is pmc authority, keyed replays append nothing, and a no-op revision is a no-op', async () => {
    const projectId = await freshProject();
    await enableCommercial(projectId, [{ code: 'CIVIL', name: 'Civil works' }]);

    await expect(
      budget.setBudget(projectId, { costHeadCode: 'CIVIL', amount: '100.00', reason: 'not allowed' }, engineer(projectId)),
    ).rejects.toMatchObject({ status: 403 });
    expect(await t.prisma.budgetLine.count({ where: { projectId } })).toBe(0);

    const key = `budget-${seq++}`;
    await budget.setBudget(projectId, { costHeadCode: 'CIVIL', amount: '100.00', reason: 'plan' }, pmc(projectId), key);
    await budget.setBudget(projectId, { costHeadCode: 'CIVIL', amount: '100.00', reason: 'plan' }, pmc(projectId), key);
    expect(await t.prisma.budgetLine.count({ where: { projectId } })).toBe(1);

    // an identical amount under a NEW key is still a no-op: a revision that changes nothing would
    // append a row saying nothing happened, which every later reader has to skip
    await budget.setBudget(projectId, { costHeadCode: 'CIVIL', amount: '100.00', reason: 'reaffirmed' }, pmc(projectId));
    expect(await t.prisma.budgetLine.count({ where: { projectId } })).toBe(1);

    // budgeting to a head that does not exist is refused — the scope key must be real
    await expect(
      budget.setBudget(projectId, { costHeadCode: 'NOPE', amount: '10.00', reason: 'invented head' }, pmc(projectId)),
    ).rejects.toMatchObject({ status: 403 });
  });

  // ── the read surface reports the same fold the exception is raised from ───────────────────────

  it('§B/§J: the budget read is worst-first, carries the OPEN exception, and reports exact decimals', async () => {
    const projectId = await freshProject();
    await capabilities.enable(projectId, MATERIALS_CAPABILITY, f.memberUser.id);
    await enableCommercial(projectId, [
      { code: 'CIVIL', name: 'Civil works' },
      { code: 'MEP', name: 'MEP' },
      { code: 'PRELIM', name: 'Preliminaries' },
    ]);
    await budget.setBudget(projectId, { costHeadCode: 'CIVIL', amount: '100.00', reason: 'civil plan' }, pmc(projectId));
    await budget.setBudget(projectId, { costHeadCode: 'MEP', amount: '50.00', reason: 'mep plan' }, pmc(projectId));
    // PRELIM is deliberately left UNBUDGETED — it must rank last and report null, not zero
    const activityId = await freshActivity(projectId);

    const civil = await draftPo(projectId, activityId, { qty: '120', baseRate: '1.00' });
    await pos.issue(projectId, civil.poId, { costHeads: [{ poLineId: civil.poLineId, costHeadCode: 'CIVIL' }] }, pmc(projectId));
    const mep = await draftPo(projectId, activityId, { qty: '10', baseRate: '1.00' });
    await pos.issue(projectId, mep.poId, { costHeads: [{ poLineId: mep.poLineId, costHeadCode: 'MEP' }] }, pmc(projectId));

    const read = await budget.readBudget(projectId, engineer(projectId));
    // WORST FIRST: the breach, then thinning headroom, then the unbudgeted head
    expect(read.positions.map((p) => p.costHeadCode)).toEqual(['CIVIL', 'MEP', 'PRELIM']);
    expect(read.openExceptions).toBe(1);

    const [breached, healthy, unbudgeted] = read.positions;
    // exact `Decimal(18,2)` strings end to end — §A forbids a float64 round trip
    expect(breached).toMatchObject({
      costHeadName: 'Civil works', budget: '100.00', budgetVersion: 1,
      committed: '120.00', receivedNotBilled: '0.00', headroom: '-20.00',
    });
    expect(breached!.exception).toMatchObject({
      costHeadCode: 'CIVIL', headroom: '-20.00', budget: '100.00', exposure: '120.00',
      raisedBy: 'commitment', clearedAt: null,
    });
    expect(healthy).toMatchObject({ costHeadCode: 'MEP', headroom: '40.00', exception: null });
    // an unbudgeted head reports NULL, not zero — it has no authority to breach, and its real
    // committed exposure is still reported so the omission is visible rather than silent
    expect(unbudgeted).toMatchObject({
      costHeadCode: 'PRELIM', budget: null, budgetVersion: null, headroom: null,
      committed: '0.00', exception: null,
    });

    // clearing the breach removes it from the read as well as the register — the two cannot drift,
    // because the read serves the SAME fold `evaluate` raises from
    await pos.cancel(projectId, civil.poId, { reason: 'ordered in error' }, pmc(projectId));
    const cleared = await budget.readBudget(projectId, pmc(projectId));
    expect(cleared.openExceptions).toBe(0);
    expect(cleared.positions.find((p) => p.costHeadCode === 'CIVIL')).toMatchObject({
      committed: '0.00', headroom: '100.00', exception: null,
    });

    // the register read is pmc/engineer — a site role never sees the project's money
    await expect(
      budget.readBudget(projectId, { ...pmc(projectId), role: 'contractor' } as AuthUser),
    ).rejects.toMatchObject({ status: 403 });
  });

  // ── §D — the whole surface is absent off-pilot ────────────────────────────────────────────────

  it('§D: a project without the commercial capability has no budget surface and no rows', async () => {
    const projectId = await freshProject();
    await expect(
      budget.setBudget(projectId, { costHeadCode: 'CIVIL', amount: '100.00', reason: 'off pilot' }, pmc(projectId)),
    ).rejects.toMatchObject({ status: 404 });
    // the READ is gated by the same capability assertion, and 404 (not 403) is the honest answer:
    // off-pilot the surface does not exist, and a 403 would confirm that it might
    await expect(budget.readBudget(projectId, pmc(projectId))).rejects.toMatchObject({ status: 404 });
    expect(await t.prisma.budgetLine.count({ where: { projectId } })).toBe(0);
    expect(await t.prisma.budgetException.count({ where: { projectId } })).toBe(0);
  });
});
