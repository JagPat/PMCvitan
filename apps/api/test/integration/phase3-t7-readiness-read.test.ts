import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { createTestApp, type TestApp } from './test-app';
import { createTwoProjectFixture, type TwoProjectFixture } from './fixtures';
import { RequirementsService } from '../../src/activities/requirements.service';
import { ActivitiesQueryService } from '../../src/activities/activities.query';
import { VendorsService } from '../../src/procurement/vendors.service';
import { ProcurementService } from '../../src/procurement/procurement.service';
import { PurchaseOrdersService } from '../../src/procurement/purchase-orders.service';
import { InventoryService } from '../../src/inventory/inventory.service';
import { CapabilitiesService, MATERIALS_CAPABILITY } from '../../src/platform/capabilities.service';
import type { AuthUser } from '../../src/common/auth';
import type { CreateRequirementInput } from '../../src/contracts';

/**
 * Phase 3 Task 7 — the pilot MATERIAL-READINESS read (`ActivitiesQueryService.materialReadiness`,
 * the surface behind `GET …/activities/material-readiness`). It is the SAME canonical coverage
 * `activities.start` reads, projected for the UI + the shortage Inbox: per-requirement verdict,
 * plus a shortage forecast (blocked → no-supply; at-risk → delays-start when the covering delivery
 * lands after the planned start, else covered-in-time). Capability-gated: 404 on a non-pilot project.
 */
describe('Phase 3 Task 7 — material-readiness read (live PG)', () => {
  let t: TestApp;
  let f: TwoProjectFixture;
  let requirements: RequirementsService;
  let query: ActivitiesQueryService;
  let vendors: VendorsService;
  let procurement: ProcurementService;
  let pos: PurchaseOrdersService;
  let inventory: InventoryService;
  let capabilities: CapabilitiesService;
  let seq = 0;

  const TRUNCATE =
    'TRUNCATE TABLE "DomainEvent", "OutboxDelivery", "ProcessedEvent", "ProjectionCursor", "ProjectionGeneration", "MaterialReadinessProjection", "DecisionProjection", "DailyLogProjection", "DrawingsProjection", "InspectionsProjection", "ActivitiesProjection", "StockTransaction", "MaterialIssue", "StockLot", "CommandExecution", "DeliveryPromise", "DeliveryCommitment", "PurchaseOrderLine", "PurchaseOrderVersion", "PurchaseOrder", "VendorQuoteLine", "QuoteComparison", "VendorQuote", "Rfq", "RequisitionLine", "Requisition", "ProjectVendor", "ApprovedSubstitution", "MaterialRequirementSpec", "ActivityRequirement", "ActivityRequirementRoot", "DecisionApprovalRevision", "ProjectCapability"';

  const pmc = (projectId: string): AuthUser => ({ sub: f.memberUser.id, role: 'pmc', projectId }) as AuthUser;
  const orgAdmin = (): AuthUser => ({ sub: f.ownerUser.id, role: 'pmc' }) as AuthUser;

  beforeAll(async () => {
    t = await createTestApp();
    f = await createTwoProjectFixture(t.prisma);
    requirements = t.app.get(RequirementsService);
    query = t.app.get(ActivitiesQueryService);
    vendors = t.app.get(VendorsService);
    procurement = t.app.get(ProcurementService);
    pos = t.app.get(PurchaseOrdersService);
    inventory = t.app.get(InventoryService);
    capabilities = t.app.get(CapabilitiesService);
  });
  afterAll(async () => {
    await t?.prisma.$executeRawUnsafe(TRUNCATE);
    await t?.prisma.vendor.deleteMany({ where: { orgId: { in: [f.orgA.id, f.orgB.id] } } });
    await f?.cleanup();
    await t?.close();
  });
  afterEach(async () => {
    await t.prisma.$executeRawUnsafe(TRUNCATE);
    await t.prisma.vendor.deleteMany({ where: { orgId: { in: [f.orgA.id, f.orgB.id] } } });
    for (const [model, where] of [
      ['media', { projectId: { startsWith: 'it-p3t7-' } }],
      ['activity', { projectId: { startsWith: 'it-p3t7-' } }],
      ['auditLog', { projectId: { startsWith: 'it-p3t7-' } }],
      ['membership', { projectId: { startsWith: 'it-p3t7-' } }],
      ['project', { id: { startsWith: 'it-p3t7-' } }],
    ] as const) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (t.prisma as any)[model].deleteMany({ where });
    }
  });

  const SPEC_A = { materialCategory: 'Cement', make: 'UltraTech', grade: 'OPC 53' };

  const freshProject = async (enablePilot = true): Promise<string> => {
    const id = `it-p3t7-${Date.now() % 1e6}-${seq++}`;
    await t.prisma.project.create({
      data: { id, orgId: f.orgA.id, name: id, short: 'P', descriptor: '', stage: 'x', siteCode: 'P', projStart: 'a', projEnd: 'b', elapsedPct: 0, todayDay: 0, milestonePct: 0, timeZone: 'Asia/Kolkata', scheduleStartDate: new Date('2026-06-01T00:00:00.000Z') },
    });
    await t.prisma.membership.create({ data: { projectId: id, userId: f.memberUser.id, role: 'pmc', status: 'active' } });
    if (enablePilot) await capabilities.enable(id, MATERIALS_CAPABILITY, f.memberUser.id);
    return id;
  };
  const freshActivity = async (projectId: string, plannedStartDate = new Date('2026-08-10T00:00:00.000Z')): Promise<string> => {
    const id = `IT-P3T7-ACT-${Date.now() % 1e6}-${seq++}`;
    await t.prisma.activity.create({ data: { id, projectId, name: `Act ${seq}`, zone: 'Z', plannedStart: 0, plannedEnd: 10, plannedStartDate } });
    return id;
  };
  const freshMedia = async (projectId: string): Promise<string> =>
    (await t.prisma.media.create({ data: { projectId, kind: 'material', mime: 'image/jpeg', uploadedBy: f.memberUser.id, sizeBytes: 3 } })).id;

  const addRequirement = async (projectId: string, activityId: string, qty = '100', requiredBy = '2026-08-15') => {
    const input: CreateRequirementInput = {
      activityId, ...SPEC_A, attributes: 'grey', baseUom: 'bag', qty, requiredBy,
      criticality: 'normal', decisionId: null, responsibleId: null, tolerance: null,
    };
    const r = await requirements.create(projectId, input, pmc(projectId));
    return { requirementId: r.requirementId, revision: r.revision };
  };

  const receivablePoLine = async (projectId: string, req: { requirementId: string; revision: number }, lineQty = '100') => {
    const created = await procurement.createRequisition(projectId, { title: `Req ${seq++}`, lines: [{ requirementId: req.requirementId, revision: req.revision, qty: lineQty }] }, pmc(projectId));
    await procurement.submit(projectId, created.id, pmc(projectId));
    const requisition = await procurement.approve(projectId, created.id, pmc(projectId));
    const lineId = requisition.lines[0]!.id;
    const rfq = await procurement.createRfq(projectId, { requisitionId: requisition.id }, pmc(projectId));
    const vendor = await vendors.create(f.orgA.id, { name: `Vendor ${seq++}` }, orgAdmin());
    await vendors.bind(projectId, { vendorId: vendor.id }, pmc(projectId));
    const withQuote = await procurement.recordQuote(projectId, rfq.id, {
      vendorId: vendor.id, validUntil: '2027-01-01',
      lines: [{ requisitionLineId: lineId, baseRate: '100.00', taxAmount: '50.00', freightAmount: '25.00', landedCost: '999.99', quotedMake: 'make', matchesSpecification: true }],
    }, pmc(projectId));
    const quoteId = withQuote.quotes.find((q) => q.status === 'recorded')!.id;
    await procurement.createComparison(projectId, rfq.id, pmc(projectId));
    const approved = await procurement.approveComparison(projectId, rfq.id, { selectedQuoteId: quoteId, reason: 'single quote, in spec' }, pmc(projectId));
    const po = await pos.create(projectId, { comparisonId: approved.comparison!.id, lines: [{ requisitionLineId: lineId, purchaseQty: lineQty }] }, pmc(projectId));
    await pos.issue(projectId, po.id, {}, pmc(projectId));
    const line = await t.prisma.purchaseOrderLine.findFirstOrThrow({ where: { projectId, requisitionLineId: lineId } });
    return { poId: po.id, poLineId: line.id };
  };
  const commit = async (projectId: string, poLineId: string, promisedDate: string) =>
    (await pos.commitDelivery(projectId, { poLineId, promisedDate }, pmc(projectId))).id;
  /** Procure the GIVEN requirement, receive+accept the full qty, and reserve it to `activityId` — the
   *  natural pilot flow (the stock traces to the SAME requirement it satisfies; no spurious demand). */
  const procureAndStock = async (projectId: string, activityId: string, req: { requirementId: string; revision: number }, qty = '100'): Promise<void> => {
    const { poLineId } = await receivablePoLine(projectId, req, qty);
    const commitmentId = await commit(projectId, poLineId, '2026-07-01');
    const lot = await inventory.recordReceipt(projectId, { poLineId, commitmentId, purchaseQty: qty }, pmc(projectId));
    await inventory.accept(projectId, { lotId: lot.id, qty, qualityResult: 'passed', evidenceMediaId: await freshMedia(projectId) }, pmc(projectId));
    await inventory.reserve(projectId, { lotId: lot.id, activityId, qty }, pmc(projectId));
  };

  it('READY: reserved stock ≥ requirement → ready; no shortages; summary counts', async () => {
    const projectId = await freshProject();
    const activityId = await freshActivity(projectId);
    const req = await addRequirement(projectId, activityId, '100');
    await procureAndStock(projectId, activityId, req, '100');

    const view = await query.materialReadiness(projectId);
    expect(view.requirements).toHaveLength(1);
    expect(view.requirements[0]!).toMatchObject({ activityId, verdict: 'ready', coveredQty: '100', shortfall: '0', material: 'cement · ultratech · opc 53', baseUom: 'bag' });
    expect(view.shortages).toHaveLength(0);
    expect(view.summary).toEqual({ ready: 1, atRisk: 0, blocked: 0, total: 1 });
  });

  it('BLOCKED: no stock, no commitment → blocked + no-supply forecast', async () => {
    const projectId = await freshProject();
    const activityId = await freshActivity(projectId);
    await addRequirement(projectId, activityId, '100');

    const view = await query.materialReadiness(projectId);
    expect(view.requirements[0]!.verdict).toBe('blocked');
    expect(view.shortages).toHaveLength(1);
    expect(view.shortages[0]!).toMatchObject({ verdict: 'blocked', impact: 'no-supply' });
    expect(view.shortages[0]!.impactReason).toContain('No covering delivery');
    expect(view.summary).toMatchObject({ blocked: 1, total: 1 });
  });

  it('AT-RISK / covered-in-time: a full covering commitment BEFORE the planned start', async () => {
    const projectId = await freshProject();
    const activityId = await freshActivity(projectId, new Date('2026-09-30T00:00:00.000Z'));
    const req = await addRequirement(projectId, activityId, '100');
    const { poLineId } = await receivablePoLine(projectId, req, '100');
    await commit(projectId, poLineId, '2026-09-15'); // before planned start 2026-09-30

    const view = await query.materialReadiness(projectId);
    expect(view.requirements[0]!.verdict).toBe('at-risk');
    expect(view.shortages[0]!).toMatchObject({ verdict: 'at-risk', impact: 'covered-in-time', commitmentPromisedDate: '2026-09-15' });
    expect(view.summary).toMatchObject({ atRisk: 1, total: 1 });
  });

  it('AT-RISK / delays-start: the covering commitment lands AFTER the planned start', async () => {
    const projectId = await freshProject();
    const activityId = await freshActivity(projectId, new Date('2026-08-10T00:00:00.000Z'));
    const req = await addRequirement(projectId, activityId, '100');
    const { poLineId } = await receivablePoLine(projectId, req, '100');
    await commit(projectId, poLineId, '2026-09-15'); // AFTER planned start 2026-08-10

    const view = await query.materialReadiness(projectId);
    expect(view.shortages[0]!).toMatchObject({ verdict: 'at-risk', impact: 'delays-start', commitmentPromisedDate: '2026-09-15', plannedStartDate: '2026-08-10' });
    expect(view.shortages[0]!.impactReason).toContain('will slip');
  });

  it('INERT: a non-pilot project 404s (the read does not exist off-pilot)', async () => {
    const projectId = await freshProject(false);
    await expect(query.materialReadiness(projectId)).rejects.toMatchObject({ status: 404 });
  });
});
