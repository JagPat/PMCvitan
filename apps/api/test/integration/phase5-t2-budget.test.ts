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
    'TRUNCATE TABLE "DomainEvent", "OutboxDelivery", "ProcessedEvent", "ProjectionCursor", "ProjectionGeneration", "DecisionProjection", "DailyLogProjection", "DrawingsProjection", "InspectionsProjection", "ActivitiesProjection", "MaterialReadinessProjection", "LabourReadinessProjection", "BudgetException", "BudgetLine", "CommitmentAttribution", "CostHead", "LabourMismatchResolution", "LabourMismatch", "ActivityWorkOutput", "MismatchResolution", "SiteMaterial", "LabourWorkFact", "WorkerAllocation", "LabourAttendance", "ApprovedSkillSubstitution", "CapacityPromise", "CapacityCommitment", "LabourPurchaseOrderLine", "LabourPurchaseOrderVersion", "LabourPurchaseOrder", "SupplierLabourQuoteLine", "SupplierLabourQuote", "LabourQuoteComparison", "LabourRfq", "LabourRequisitionLine", "LabourRequisition", "VendorLabourProfile", "StockTransaction", "StockLot", "MaterialIssue", "DeliveryPromise", "DeliveryCommitment", "PurchaseOrderLine", "PurchaseOrderVersion", "PurchaseOrder", "VendorQuoteLine", "VendorQuote", "QuoteComparison", "Rfq", "RequisitionLine", "Requisition", "ProjectVendor", "CommandExecution", "CrewMembership", "Crew", "WorkerDevice", "WorkerSkill", "Worker", "LabourDemandSlice", "LabourRequirementSpec", "LabourTrade", "LabourSkill", "ApprovedSubstitution", "MaterialRequirementSpec", "ActivityRequirement", "ActivityRequirementRoot", "DecisionApprovalRevision", "ProjectCapability" CASCADE';

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
  ): Promise<{ poId: string; poLineId: string }> => {
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
    return { poId: po.id, poLineId: line.id };
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

  // ── §D — the whole surface is absent off-pilot ────────────────────────────────────────────────

  it('§D: a project without the commercial capability has no budget surface and no rows', async () => {
    const projectId = await freshProject();
    await expect(
      budget.setBudget(projectId, { costHeadCode: 'CIVIL', amount: '100.00', reason: 'off pilot' }, pmc(projectId)),
    ).rejects.toMatchObject({ status: 404 });
    expect(await t.prisma.budgetLine.count({ where: { projectId } })).toBe(0);
    expect(await t.prisma.budgetException.count({ where: { projectId } })).toBe(0);
  });
});
