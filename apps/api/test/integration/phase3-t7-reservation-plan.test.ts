import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { createTestApp, type TestApp } from './test-app';
import { createTwoProjectFixture, type TwoProjectFixture } from './fixtures';
import { RequirementsService } from '../../src/activities/requirements.service';
import { SubstitutionsService } from '../../src/activities/substitutions.service';
import { ActivitiesQueryService } from '../../src/activities/activities.query';
import { VendorsService } from '../../src/procurement/vendors.service';
import { ProcurementService } from '../../src/procurement/procurement.service';
import { PurchaseOrdersService } from '../../src/procurement/purchase-orders.service';
import { InventoryService } from '../../src/inventory/inventory.service';
import { CapabilitiesService, MATERIALS_CAPABILITY } from '../../src/platform/capabilities.service';
import { Prisma } from '@prisma/client';
import type { AuthUser } from '../../src/common/auth';
import type { CreateRequirementInput } from '../../src/contracts';

/** Exact decimal sum of qty strings (base UOM), so the conservation assertions never go lossy. */
const sumQty = (qtys: readonly string[]): Prisma.Decimal =>
  qtys.reduce((acc, q) => acc.add(new Prisma.Decimal(q)), new Prisma.Decimal(0));

/**
 * Phase 3 Task 7 (correction 2) — the CANONICAL reservation plan (`ActivitiesQueryService.reservationPlan`,
 * the surface behind `GET …/activities/:activityId/reservation-plan`). The SERVER resolves coverage
 * compatibility (current requirements + ACTIVE substitutions + base-UOM compatibility + lot location +
 * free qty) into EXACT single-command reserve candidates + the residual to requisition — the browser
 * never recreates compatibility from fingerprints. Reproduce-first probes 1–4 of the directive.
 */
describe('Phase 3 Task 7 (correction 2) — reservation plan candidates (live PG)', () => {
  let t: TestApp;
  let f: TwoProjectFixture;
  let requirements: RequirementsService;
  let substitutions: SubstitutionsService;
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
    substitutions = t.app.get(SubstitutionsService);
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
      ['media', { projectId: { startsWith: 'it-p3t7r-' } }],
      ['activity', { projectId: { startsWith: 'it-p3t7r-' } }],
      ['auditLog', { projectId: { startsWith: 'it-p3t7r-' } }],
      ['membership', { projectId: { startsWith: 'it-p3t7r-' } }],
      ['project', { id: { startsWith: 'it-p3t7r-' } }],
    ] as const) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (t.prisma as any)[model].deleteMany({ where });
    }
  });

  const SPEC_A = { materialCategory: 'Cement', make: 'UltraTech', grade: 'OPC 53' };
  const SPEC_B = { materialCategory: 'Cement', make: 'ACC', grade: 'OPC 53' };

  const freshProject = async (enablePilot = true): Promise<string> => {
    const id = `it-p3t7r-${Date.now() % 1e6}-${seq++}`;
    await t.prisma.project.create({
      data: { id, orgId: f.orgA.id, name: id, short: 'P', descriptor: '', stage: 'x', siteCode: 'P', projStart: 'a', projEnd: 'b', elapsedPct: 0, todayDay: 0, milestonePct: 0, timeZone: 'Asia/Kolkata', scheduleStartDate: new Date('2026-06-01T00:00:00.000Z') },
    });
    await t.prisma.membership.create({ data: { projectId: id, userId: f.memberUser.id, role: 'pmc', status: 'active' } });
    if (enablePilot) await capabilities.enable(id, MATERIALS_CAPABILITY, f.memberUser.id);
    return id;
  };
  const freshActivity = async (projectId: string): Promise<string> => {
    const id = `IT-P3T7R-ACT-${Date.now() % 1e6}-${seq++}`;
    await t.prisma.activity.create({ data: { id, projectId, name: `Act ${seq}`, zone: 'Z', plannedStart: 0, plannedEnd: 10, plannedStartDate: new Date('2026-08-10T00:00:00.000Z') } });
    return id;
  };
  const freshMedia = async (projectId: string): Promise<string> =>
    (await t.prisma.media.create({ data: { projectId, kind: 'material', mime: 'image/jpeg', uploadedBy: f.memberUser.id, sizeBytes: 3 } })).id;

  const addRequirement = async (
    projectId: string,
    activityId: string,
    qty = '100',
    spec: { materialCategory: string; make: string; grade: string } = SPEC_A,
    baseUom = 'bag',
  ) => {
    const input: CreateRequirementInput = {
      activityId, ...spec, attributes: 'grey', baseUom, qty, requiredBy: '2026-08-15',
      criticality: 'normal', decisionId: null, responsibleId: null, tolerance: null,
    };
    const r = await requirements.create(projectId, input, pmc(projectId));
    return { requirementId: r.requirementId, revision: r.revision };
  };

  /** Procure the requirement, receive+accept `stockQty` (ordering `orderQty`) at `storeLocation`, and
   *  DO NOT reserve — so it sits as FREE on-hand stock the plan can offer. */
  const stockFree = async (
    projectId: string,
    req: { requirementId: string; revision: number },
    stockQty: string,
    orderQty = '100',
    storeLocation?: string,
  ): Promise<void> => {
    const created = await procurement.createRequisition(projectId, { title: `Req ${seq++}`, lines: [{ requirementId: req.requirementId, revision: req.revision, qty: orderQty }] }, pmc(projectId));
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
    const po = await pos.create(projectId, { comparisonId: approved.comparison!.id, lines: [{ requisitionLineId: lineId, purchaseQty: orderQty }] }, pmc(projectId));
    await pos.issue(projectId, po.id, {}, pmc(projectId));
    const line = await t.prisma.purchaseOrderLine.findFirstOrThrow({ where: { projectId, requisitionLineId: lineId } });
    const commitmentId = (await pos.commitDelivery(projectId, { poLineId: line.id, promisedDate: '2026-07-01' }, pmc(projectId))).id;
    const lot = await inventory.recordReceipt(projectId, { poLineId: line.id, commitmentId, purchaseQty: stockQty, ...(storeLocation ? { storeLocation } : {}) }, pmc(projectId));
    await inventory.accept(projectId, { lotId: lot.id, qty: stockQty, qualityResult: 'passed', evidenceMediaId: await freshMedia(projectId), ...(storeLocation ? { storeLocation } : {}) }, pmc(projectId));
  };

  // ── PROBE 1 — 100 shortage + 10 free ⇒ reserve 10 and requisition the residual 90. ──
  it('PROBE 1: a 100 shortage with 10 free stock offers a 10 reserve candidate and a 90 residual', async () => {
    const projectId = await freshProject();
    const activityId = await freshActivity(projectId);
    const req = await addRequirement(projectId, activityId, '100');
    await stockFree(projectId, req, '10'); // 10 free on hand, requirement 100

    const plan = await query.reservationPlan(projectId, activityId);
    expect(plan.activityId).toBe(activityId);
    expect(plan.candidates).toHaveLength(1);
    expect(plan.candidates[0]!).toMatchObject({ requirementId: req.requirementId, qty: '10', baseUom: 'bag' });
    expect(plan.residuals).toHaveLength(1);
    expect(plan.residuals[0]!).toMatchObject({ requirementId: req.requirementId, qty: '90', baseUom: 'bag' });
  });

  // ── PROBE 2 — two 80 shortages sharing 100 stock ⇒ the offered reservations NEVER exceed 100. ──
  it('PROBE 2: two 80 requirements sharing 100 free stock never offer more than 100 total', async () => {
    const projectId = await freshProject();
    const activityId = await freshActivity(projectId);
    await addRequirement(projectId, activityId, '80');
    await addRequirement(projectId, activityId, '80'); // second, same activity + spec
    // 100 free of the shared fingerprint (procured against a dedicated qty-100 requirement on another
    // activity so the §F bound-1 allocation fits, then left UNRESERVED so both 80s compete for it)
    const stockActivity = await freshActivity(projectId);
    const reqStock = await addRequirement(projectId, stockActivity, '100');
    await stockFree(projectId, reqStock, '100', '100');

    const plan = await query.reservationPlan(projectId, activityId);
    const offered = sumQty(plan.candidates.map((c) => c.qty));
    expect(offered.toString()).toBe('100'); // the conserved offer saturates the free pool, no double-count
    expect(Number(offered.toString())).toBeLessThanOrEqual(100);
    // the residual is the uncovered remainder: 160 demand − 100 stock = 60
    const residual = sumQty(plan.residuals.map((r) => r.qty));
    expect(residual.toString()).toBe('60');
  });

  // ── PROBE 3 — stock only in "yard-store" ⇒ the candidate reserves (and later issues) from yard-store. ──
  it('PROBE 3: stock in a non-default store location offers a candidate AT that location', async () => {
    const projectId = await freshProject();
    const activityId = await freshActivity(projectId);
    const req = await addRequirement(projectId, activityId, '100');
    await stockFree(projectId, req, '40', '100', 'yard-store');

    const plan = await query.reservationPlan(projectId, activityId);
    expect(plan.candidates).toHaveLength(1);
    expect(plan.candidates[0]!).toMatchObject({ storeLocation: 'yard-store', qty: '40' });
  });

  // ── PROBE 4 — an ACTIVE approved substitute is eligible; the same fingerprint with the WRONG base UOM
  //    is NOT (dimensionally incompatible stock can never be offered). ──
  it('PROBE 4a: an active approved substitute (A→B) is offered as a reserve candidate', async () => {
    const projectId = await freshProject();
    const activityId = await freshActivity(projectId);
    const reqA = await addRequirement(projectId, activityId, '100', SPEC_A); // requirement is spec A
    await substitutions.approve(projectId, reqA.requirementId, { ...SPEC_B, attributes: 'grey', baseUom: 'bag', reason: 'B ≈ A' }, pmc(projectId));
    // free spec-B stock (bag) on hand, procured via a separate spec-B requirement on another activity
    const otherActivity = await freshActivity(projectId);
    const reqB = await addRequirement(projectId, otherActivity, '100', SPEC_B);
    await stockFree(projectId, reqB, '60', '100');

    const plan = await query.reservationPlan(projectId, activityId);
    expect(plan.candidates).toHaveLength(1);
    expect(plan.candidates[0]!).toMatchObject({ requirementId: reqA.requirementId, qty: '60', baseUom: 'bag' });
  });

  it('PROBE 4b: the same fingerprint at the WRONG base UOM is NOT eligible (no candidate, full residual)', async () => {
    const projectId = await freshProject();
    const activityId = await freshActivity(projectId);
    const reqBag = await addRequirement(projectId, activityId, '100', SPEC_A, 'bag'); // needs bags
    // free spec-A stock but measured in KG (a distinct requirement on another activity) — dimensionally
    // incompatible with the bag requirement, so it must never be offered.
    const otherActivity = await freshActivity(projectId);
    const reqKg = await addRequirement(projectId, otherActivity, '100', SPEC_A, 'kg');
    await stockFree(projectId, reqKg, '100', '100');

    const plan = await query.reservationPlan(projectId, activityId);
    expect(plan.candidates).toHaveLength(0); // the ton pool is excluded
    expect(plan.residuals).toHaveLength(1);
    expect(plan.residuals[0]!).toMatchObject({ requirementId: reqBag.requirementId, qty: '100', baseUom: 'bag' });
  });

  it('INERT: the reservation plan 404s on a non-pilot project', async () => {
    const projectId = await freshProject(false);
    const activityId = await freshActivity(projectId);
    await expect(query.reservationPlan(projectId, activityId)).rejects.toMatchObject({ status: 404 });
  });
});
