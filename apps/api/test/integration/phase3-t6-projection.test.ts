import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { createTestApp, type TestApp } from './test-app';
import { createTwoProjectFixture, type TwoProjectFixture } from './fixtures';
import { RequirementsService } from '../../src/activities/requirements.service';
import { ActivitiesService } from '../../src/activities/activities.service';
import { VendorsService } from '../../src/procurement/vendors.service';
import { ProcurementService } from '../../src/procurement/procurement.service';
import { PurchaseOrdersService } from '../../src/procurement/purchase-orders.service';
import { InventoryService } from '../../src/inventory/inventory.service';
import { CapabilitiesService, MATERIALS_CAPABILITY } from '../../src/platform/capabilities.service';
import { ProjectionRebuilder } from '../../src/platform/projections/rebuilder.service';
import { ProjectionRebuildOperations } from '../../src/platform/projections/rebuild-operations';
import { OutboxRelay } from '../../src/platform/outbox/relay.service';
import { MATERIAL_READINESS_PROJECTION, computeMaterialReadingsDto } from '../../src/activities/material-readiness.projection';
import { readServableGeneration } from '../../src/platform/projections/generation';
import type { AuthUser } from '../../src/common/auth';
import type { CreateRequirementInput } from '../../src/contracts';

/**
 * Phase 3 Task 6 — the SIXTH rebuildable projection: `activities.material-readiness` (plan §A/§G),
 * live PG. Proves the standing projection invariants for the material readiness read model:
 *   • live == projection == rebuild — the stored per-project verdict equals the CANONICAL §A
 *     recompute, on both the relay-applied generation and a fresh operator rebuild;
 *   • a rebuild emits ZERO domain events and ZERO notifications (recompute-only, §G);
 *   • projection lag NEVER changes a start verdict — with a STALE projection still reading `ready`,
 *     the start authority follows CANONICAL coverage (in-tx) and refuses once the stock is released.
 */

describe('Phase 3 Task 6 — the material-readiness projection (live == projection == rebuild) (live PG)', () => {
  let t: TestApp;
  let f: TwoProjectFixture;
  let requirements: RequirementsService;
  let activities: ActivitiesService;
  let vendors: VendorsService;
  let procurement: ProcurementService;
  let pos: PurchaseOrdersService;
  let inventory: InventoryService;
  let capabilities: CapabilitiesService;
  let relay: OutboxRelay;
  let ops: ProjectionRebuildOperations;
  let seq = 0;

  const TRUNCATE =
    'TRUNCATE TABLE "DomainEvent", "OutboxDelivery", "ProcessedEvent", "ProjectionCursor", "ProjectionGeneration", "MaterialReadinessProjection", "DecisionProjection", "DailyLogProjection", "DrawingsProjection", "InspectionsProjection", "ActivitiesProjection", "StockTransaction", "MaterialIssue", "StockLot", "CommandExecution", "DeliveryPromise", "DeliveryCommitment", "PurchaseOrderLine", "PurchaseOrderVersion", "PurchaseOrder", "VendorQuoteLine", "QuoteComparison", "VendorQuote", "Rfq", "RequisitionLine", "Requisition", "ProjectVendor", "ApprovedSubstitution", "MaterialRequirementSpec", "ActivityRequirement", "ActivityRequirementRoot", "DecisionApprovalRevision", "ProjectCapability"';

  const pmc = (projectId: string): AuthUser => ({ sub: f.memberUser.id, role: 'pmc', projectId }) as AuthUser;
  const orgAdmin = (): AuthUser => ({ sub: f.ownerUser.id, role: 'pmc' }) as AuthUser;

  beforeAll(async () => {
    t = await createTestApp();
    f = await createTwoProjectFixture(t.prisma);
    requirements = t.app.get(RequirementsService);
    activities = t.app.get(ActivitiesService);
    vendors = t.app.get(VendorsService);
    procurement = t.app.get(ProcurementService);
    pos = t.app.get(PurchaseOrdersService);
    inventory = t.app.get(InventoryService);
    capabilities = t.app.get(CapabilitiesService);
    relay = t.app.get(OutboxRelay);
    ops = new ProjectionRebuildOperations(t.prisma, t.app.get(ProjectionRebuilder));
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
      ['media', { projectId: { startsWith: 'it-p3tp-' } }],
      ['notification', { projectId: { startsWith: 'it-p3tp-' } }],
      ['activity', { projectId: { startsWith: 'it-p3tp-' } }],
      ['auditLog', { projectId: { startsWith: 'it-p3tp-' } }],
      ['membership', { projectId: { startsWith: 'it-p3tp-' } }],
      ['project', { id: { startsWith: 'it-p3tp-' } }],
    ] as const) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (t.prisma as any)[model].deleteMany({ where });
    }
  });

  const freshProject = async (): Promise<string> => {
    const id = `it-p3tp-${Date.now() % 1e6}-${seq++}`;
    await t.prisma.project.create({
      data: { id, orgId: f.orgA.id, name: id, short: 'P', descriptor: '', stage: 'x', siteCode: 'P', projStart: 'a', projEnd: 'b', elapsedPct: 0, todayDay: 0, milestonePct: 0, timeZone: 'Asia/Kolkata', scheduleStartDate: new Date('2026-06-01T00:00:00.000Z') },
    });
    await t.prisma.membership.create({ data: { projectId: id, userId: f.memberUser.id, role: 'pmc', status: 'active' } });
    await capabilities.enable(id, MATERIALS_CAPABILITY, f.memberUser.id);
    return id;
  };
  const freshActivity = async (projectId: string): Promise<string> => {
    const id = `IT-P3TP-ACT-${Date.now() % 1e6}-${seq++}`;
    await t.prisma.activity.create({ data: { id, projectId, name: `Act ${seq}`, zone: 'Z', plannedStart: 0, plannedEnd: 10 } });
    return id;
  };
  const freshMedia = async (projectId: string): Promise<string> =>
    (await t.prisma.media.create({ data: { projectId, kind: 'material', mime: 'image/jpeg', uploadedBy: f.memberUser.id, sizeBytes: 3 } })).id;

  /** A ready activity: requirement 100 bags → issued PO + commitment → receive+accept+reserve 100. */
  const readyActivity = async (projectId: string): Promise<{ activityId: string; lotId: string }> => {
    const activityId = await freshActivity(projectId);
    const input: CreateRequirementInput = {
      activityId, materialCategory: 'Cement', make: 'UltraTech', grade: 'OPC 53', attributes: 'grey',
      baseUom: 'bag', qty: '100', requiredBy: '2026-08-15', criticality: 'normal', decisionId: null, responsibleId: null, tolerance: null,
    };
    const req = await requirements.create(projectId, input, pmc(projectId));
    const created = await procurement.createRequisition(projectId, { title: `Req ${seq++}`, lines: [{ requirementId: req.requirementId, revision: req.revision, qty: '100' }] }, pmc(projectId));
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
    const approved = await procurement.approveComparison(projectId, rfq.id, { selectedQuoteId: quoteId, reason: 'ok' }, pmc(projectId));
    const po = await pos.create(projectId, { comparisonId: approved.comparison!.id, lines: [{ requisitionLineId: lineId, purchaseQty: '100' }] }, pmc(projectId));
    await pos.issue(projectId, po.id, {}, pmc(projectId));
    const line = await t.prisma.purchaseOrderLine.findFirstOrThrow({ where: { projectId, requisitionLineId: lineId } });
    const commitment = await pos.commitDelivery(projectId, { poLineId: line.id, promisedDate: '2026-09-01' }, pmc(projectId));
    const lot = await inventory.recordReceipt(projectId, { poLineId: line.id, commitmentId: commitment.id, purchaseQty: '100' }, pmc(projectId));
    await inventory.accept(projectId, { lotId: lot.id, qty: '100', qualityResult: 'passed', evidenceMediaId: await freshMedia(projectId) }, pmc(projectId));
    await inventory.reserve(projectId, { lotId: lot.id, activityId, qty: '100' }, pmc(projectId));
    return { activityId, lotId: lot.id };
  };

  const drainRelay = async (): Promise<void> => { for (let i = 0; i < 8; i++) await relay.runOnce(); };
  const liveDto = (projectId: string) => t.prisma.$transaction((tx) => computeMaterialReadingsDto(tx, projectId));
  const storedDto = async (projectId: string) => {
    const gen = await readServableGeneration(t.prisma, MATERIAL_READINESS_PROJECTION, projectId);
    if (!gen) return null;
    const row = await t.prisma.materialReadinessProjection.findUnique({ where: { generationId_projectId: { generationId: gen.id, projectId } }, select: { dto: true } });
    return row?.dto ?? null;
  };
  const rebuildReadiness = () => ops.run({ operatorIdentity: 'op', reason: 'test rebuild', consumers: [MATERIAL_READINESS_PROJECTION] });
  /** The active generation's STORED row REGARDLESS of servability — used to prove a LAGGING
   *  generation still physically holds its stale verdict (the servable read has already fallen
   *  back to live). */
  const storedRowAnyGen = async (projectId: string) => {
    const gen = await t.prisma.projectionGeneration.findFirst({ where: { consumer: MATERIAL_READINESS_PROJECTION, projectId, status: 'active' }, select: { id: true } });
    if (!gen) return null;
    const row = await t.prisma.materialReadinessProjection.findUnique({ where: { generationId_projectId: { generationId: gen.id, projectId } }, select: { dto: true } });
    return row?.dto ?? null;
  };

  it('live == projection: the relay-applied projection equals the canonical §A recompute (ready)', async () => {
    const projectId = await freshProject();
    const { activityId } = await readyActivity(projectId);
    await drainRelay();

    const live = await liveDto(projectId);
    expect(live.readings[activityId]?.v).toBe('ok'); // reserved 100 ≥ required 100
    const stored = await storedDto(projectId);
    expect(stored).toEqual(live);
  });

  it('live == projection == rebuild, and a rebuild emits ZERO domain events + ZERO notifications', async () => {
    const projectId = await freshProject();
    const { activityId } = await readyActivity(projectId);
    await drainRelay();

    const eventsBefore = await t.prisma.domainEvent.count({ where: { projectId } });
    const notifsBefore = await t.prisma.notification.count({ where: { projectId } });
    const report = await rebuildReadiness();
    expect(report.ok).toBe(true);
    expect(report.corruptAfter).toBe(0);
    expect(report.failures).toBe(0);
    // recompute-only: a rebuild replay produces NO new canonical events and NO notifications (§G)
    expect(await t.prisma.domainEvent.count({ where: { projectId } })).toBe(eventsBefore);
    expect(await t.prisma.notification.count({ where: { projectId } })).toBe(notifsBefore);

    const live = await liveDto(projectId);
    const rebuilt = await storedDto(projectId);
    expect(rebuilt).toEqual(live);
    expect((rebuilt as { readings: Record<string, { v: string }> }).readings[activityId]?.v).toBe('ok');
  });

  it('projection lag NEVER changes a start verdict: a stale ready projection cannot start a now-blocked activity', async () => {
    const projectId = await freshProject();
    const { activityId, lotId } = await readyActivity(projectId);
    await drainRelay();
    expect((await storedDto(projectId) as { readings: Record<string, { v: string }> }).readings[activityId]?.v).toBe('ok');

    // Release the reservation — canonical coverage is now blocked — but DO NOT drain the relay,
    // so the stored projection STILL reads 'ok' (stale).
    await inventory.release(projectId, { lotId, activityId, qty: '100' }, pmc(projectId));
    // the servable read has fallen back to live (the generation now lags); the stored row itself
    // still physically holds the pre-release 'ok' verdict
    expect(await storedDto(projectId)).toBeNull();
    const stale = await storedRowAnyGen(projectId);
    expect((stale as { readings: Record<string, { v: string }> }).readings[activityId]?.v).toBe('ok'); // projection has NOT caught up
    // the start authority reads CANONICAL coverage in-tx (never the stale 'ok' projection) → refuses
    await expect(activities.start(projectId, activityId, pmc(projectId))).rejects.toMatchObject({ status: 409 });
    // and the live recompute already reflects the release — the reserved 100 is gone; the delivery
    // commitment was FULLY received (F3: zero outstanding, no longer inbound), so nothing covers the
    // shortfall → 'fail'. Either way it is never 'ok': lag cannot make a released activity startable.
    expect((await liveDto(projectId)).readings[activityId]?.v).toBe('fail');
  });
});
