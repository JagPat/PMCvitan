import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { createTestApp, type TestApp } from './test-app';
import { createTwoProjectFixture, type TwoProjectFixture } from './fixtures';
import { RequirementsService } from '../../src/activities/requirements.service';
import { SubstitutionsService } from '../../src/activities/substitutions.service';
import { ActivitiesService } from '../../src/activities/activities.service';
import { VendorsService } from '../../src/procurement/vendors.service';
import { ProcurementService } from '../../src/procurement/procurement.service';
import { PurchaseOrdersService } from '../../src/procurement/purchase-orders.service';
import { InventoryService } from '../../src/inventory/inventory.service';
import { CapabilitiesService, MATERIALS_CAPABILITY } from '../../src/platform/capabilities.service';
import { ProjectionRebuilder } from '../../src/platform/projections/rebuilder.service';
import { ProjectionRebuildOperations } from '../../src/platform/projections/rebuild-operations';
import { OutboxRelay } from '../../src/platform/outbox/relay.service';
import { MATERIAL_READINESS_PROJECTION } from '../../src/activities/material-readiness.projection';
import { readServableGeneration } from '../../src/platform/projections/generation';
import { loadCoverageRequirements } from '../../src/activities/coverage-requirements';
import { deriveMaterialReading } from '../../src/activities/material-readiness';
import type { RequirementCoverage } from '../../src/inventory/coverage';
import type { AuthUser } from '../../src/common/auth';
import type { CreateRequirementInput } from '../../src/contracts';

/**
 * Phase 3 Task 6 — the four correction findings, reproduce-first (RED at merged `main` ec595d1).
 *
 *  F1  Conservation — the same physical reserved/issued stock may satisfy AT MOST ONE requirement.
 *      Two same-spec 100-unit requirements + 100 reserved bags cannot both be ready (start refuses);
 *      200 bags cover both. Exact fingerprints and overlapping substitution edges are conserved.
 *  F2  Substitutions are bound to the requirement's CURRENT spec: an A→B approval stops applying
 *      once the requirement is revised A→C; a partial unique index makes a duplicate ACTIVE approval
 *      unrepresentable, so a concurrent duplicate has one winner and revoking it removes the
 *      authorization.
 *  F3  Inbound coverage is QUANTITATIVE: a 10-bag commitment does not cover a 100-bag shortfall
 *      (blocked, not at-risk); at-risk only when cumulative inbound ≥ shortfall, dated at the point
 *      it does.
 *  F4  `deliveries.fulfill` (readiness-locked, refuses an unreceived commitment) and `pos.closeShort`
 *      both remove inbound coverage and now emit owner events the readiness projection consumes, so
 *      live == projection == rebuild after either transition. Both serialize against `activities.start`.
 */

describe('Phase 3 Task 6 — canonical readiness correction (F1–F4, live PG)', () => {
  let t: TestApp;
  let f: TwoProjectFixture;
  let requirements: RequirementsService;
  let substitutions: SubstitutionsService;
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
    substitutions = t.app.get(SubstitutionsService);
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
      ['media', { projectId: { startsWith: 'it-p3tc-' } }],
      ['notification', { projectId: { startsWith: 'it-p3tc-' } }],
      ['activity', { projectId: { startsWith: 'it-p3tc-' } }],
      ['auditLog', { projectId: { startsWith: 'it-p3tc-' } }],
      ['membership', { projectId: { startsWith: 'it-p3tc-' } }],
      ['project', { id: { startsWith: 'it-p3tc-' } }],
    ] as const) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (t.prisma as any)[model].deleteMany({ where });
    }
  });

  const SPEC_A = { materialCategory: 'Cement', make: 'UltraTech', grade: 'OPC 53' };
  const SPEC_B = { materialCategory: 'Cement', make: 'ACC', grade: 'OPC 53' };
  const SPEC_C = { materialCategory: 'Cement', make: 'Ambuja', grade: 'OPC 53' };

  const freshProject = async (): Promise<string> => {
    const id = `it-p3tc-${Date.now() % 1e6}-${seq++}`;
    await t.prisma.project.create({
      data: { id, orgId: f.orgA.id, name: id, short: 'P', descriptor: '', stage: 'x', siteCode: 'P', projStart: 'a', projEnd: 'b', elapsedPct: 0, todayDay: 0, milestonePct: 0, timeZone: 'Asia/Kolkata', scheduleStartDate: new Date('2026-06-01T00:00:00.000Z') },
    });
    await t.prisma.membership.create({ data: { projectId: id, userId: f.memberUser.id, role: 'pmc', status: 'active' } });
    await capabilities.enable(id, MATERIALS_CAPABILITY, f.memberUser.id);
    return id;
  };
  const freshActivity = async (projectId: string): Promise<string> => {
    const id = `IT-P3TC-ACT-${Date.now() % 1e6}-${seq++}`;
    await t.prisma.activity.create({ data: { id, projectId, name: `Act ${seq}`, zone: 'Z', plannedStart: 0, plannedEnd: 10 } });
    return id;
  };
  const freshMedia = async (projectId: string): Promise<string> =>
    (await t.prisma.media.create({ data: { projectId, kind: 'material', mime: 'image/jpeg', uploadedBy: f.memberUser.id, sizeBytes: 3 } })).id;

  const addRequirement = async (projectId: string, activityId: string, qty = '100', spec = SPEC_A) => {
    const input: CreateRequirementInput = {
      activityId, ...spec, attributes: 'grey', baseUom: 'bag', qty, requiredBy: '2026-08-15',
      criticality: 'normal', decisionId: null, responsibleId: null, tolerance: null,
    };
    const r = await requirements.create(projectId, input, pmc(projectId));
    return { requirementId: r.requirementId, revision: r.revision };
  };
  const reviseRequirement = async (projectId: string, activityId: string, requirementId: string, expectedRevision: number, qty = '100', spec = SPEC_C) => {
    const r = await requirements.revise(projectId, requirementId, {
      activityId, ...spec, attributes: 'grey', baseUom: 'bag', qty, requiredBy: '2026-08-15',
      criticality: 'normal', decisionId: null, responsibleId: null, tolerance: null, expectedRevision,
    }, pmc(projectId));
    return { requirementId: r.requirementId, revision: r.revision };
  };

  /** requirement → approved requisition → quote → approved comparison → issued PO + delivery commitment. */
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
  const commit = async (projectId: string, poLineId: string, promisedDate = '2026-09-01') =>
    (await pos.commitDelivery(projectId, { poLineId, promisedDate }, pmc(projectId))).id;
  const receiveAndAccept = async (projectId: string, poLineId: string, commitmentId: string, qty = '100'): Promise<string> => {
    const lot = await inventory.recordReceipt(projectId, { poLineId, commitmentId, purchaseQty: qty }, pmc(projectId));
    await inventory.accept(projectId, { lotId: lot.id, qty, qualityResult: 'passed', evidenceMediaId: await freshMedia(projectId) }, pmc(projectId));
    return lot.id;
  };
  /** A lot of `spec`, `qty` accepted, reserved to `activityId` — physical coverage stock. */
  const reservedStockFor = async (projectId: string, activityId: string, qty = '100', spec = SPEC_A): Promise<string> => {
    const holderActivity = await freshActivity(projectId);
    const req = await addRequirement(projectId, holderActivity, qty, spec);
    const { poLineId } = await receivablePoLine(projectId, req, qty);
    const commitmentId = await commit(projectId, poLineId);
    const lotId = await receiveAndAccept(projectId, poLineId, commitmentId, qty);
    await inventory.reserve(projectId, { lotId, activityId, qty }, pmc(projectId));
    return lotId;
  };

  const status = async (activityId: string): Promise<string> =>
    (await t.prisma.activity.findUniqueOrThrow({ where: { id: activityId }, select: { status: true } })).status;
  const coverageOf = (projectId: string, activityId: string): Promise<RequirementCoverage[]> =>
    t.prisma.$transaction(async (tx) => {
      const reqs = await loadCoverageRequirements(tx, projectId, substitutions, [activityId]);
      return inventory.coverageFor(tx, projectId, reqs);
    });
  const sum = (cs: RequirementCoverage[], field: 'coveredQty' | 'requiredQty') =>
    cs.reduce((s, c) => s + Number(c[field]), 0);

  const drainRelay = async (): Promise<void> => { for (let i = 0; i < 8; i++) await relay.runOnce(); };
  const storedReadings = async (projectId: string): Promise<Record<string, { v: string }> | null> => {
    const gen = await readServableGeneration(t.prisma, MATERIAL_READINESS_PROJECTION, projectId);
    if (!gen) return null;
    const row = await t.prisma.materialReadinessProjection.findUnique({ where: { generationId_projectId: { generationId: gen.id, projectId } }, select: { dto: true } });
    return (row?.dto as { readings: Record<string, { v: string }> } | undefined)?.readings ?? null;
  };
  const rebuildReadiness = () => ops.run({ operatorIdentity: 'op', reason: 'test rebuild', consumers: [MATERIAL_READINESS_PROJECTION] });

  // ── F1 ────────────────────────────────────────────────────────────────────────────────────
  it('F1 CONSERVATION: two same-spec 100-bag requirements share 100 reserved bags — cannot both be ready', async () => {
    const projectId = await freshProject();
    const activityId = await freshActivity(projectId);
    // TWO material requirements on the SAME activity, both spec-A, each needing 100
    await addRequirement(projectId, activityId, '100', SPEC_A);
    await addRequirement(projectId, activityId, '100', SPEC_A);
    // only 100 bags of spec-A reserved to the activity
    await reservedStockFor(projectId, activityId, '100', SPEC_A);

    const cov = await coverageOf(projectId, activityId);
    expect(cov).toHaveLength(2);
    // the 100 physical bags are allocated at most once → total covered is exactly 100, never 200
    expect(sum(cov, 'coveredQty')).toBe(100);
    expect(sum(cov, 'requiredQty')).toBe(200);
    // at least one requirement is short → worst-wins → start refuses
    expect(cov.some((c) => c.verdict !== 'ready')).toBe(true);
    await expect(activities.start(projectId, activityId, pmc(projectId))).rejects.toMatchObject({ status: 409 });
    expect(await status(activityId)).toBe('not_started');
  });

  it('F1 CONSERVATION: 200 reserved bags cover both same-spec 100-bag requirements — start succeeds', async () => {
    const projectId = await freshProject();
    const activityId = await freshActivity(projectId);
    await addRequirement(projectId, activityId, '100', SPEC_A);
    await addRequirement(projectId, activityId, '100', SPEC_A);
    await reservedStockFor(projectId, activityId, '200', SPEC_A);

    const cov = await coverageOf(projectId, activityId);
    expect(sum(cov, 'coveredQty')).toBe(200);
    expect(cov.every((c) => c.verdict === 'ready')).toBe(true);
    await activities.start(projectId, activityId, pmc(projectId));
    expect(await status(activityId)).toBe('in_progress');
  });

  // ── F2 ────────────────────────────────────────────────────────────────────────────────────
  it('F2 SPEC-BOUND: an A→B substitution stops applying once the requirement is revised A→C', async () => {
    const projectId = await freshProject();
    const activityId = await freshActivity(projectId);
    const reqA = await addRequirement(projectId, activityId, '100', SPEC_A); // revision 1, spec A
    // spec-B stock reserved to the activity, and an A→B substitution → covered while spec is A
    await reservedStockFor(projectId, activityId, '100', SPEC_B);
    await substitutions.approve(projectId, reqA.requirementId, { ...SPEC_B, attributes: 'grey', baseUom: 'bag', reason: 'B ≈ A' }, pmc(projectId));
    expect((await coverageOf(projectId, activityId))[0]!.verdict).toBe('ready');

    // revise the requirement A→C: the substitution's fromFingerprint (A) no longer matches the
    // current spec (C), so spec-B stock must STOP satisfying it → blocked → start refuses
    await reviseRequirement(projectId, activityId, reqA.requirementId, reqA.revision, '100', SPEC_C);
    const cov = await coverageOf(projectId, activityId);
    expect(cov[0]!.verdict).toBe('blocked');
    expect(cov[0]!.coveredQty).toBe('0');
    await expect(activities.start(projectId, activityId, pmc(projectId))).rejects.toMatchObject({ status: 409 });
  });

  it('F2 UNIQUE: a concurrent duplicate active approval has exactly one winner; revoking it removes the authorization', async () => {
    const projectId = await freshProject();
    const activityId = await freshActivity(projectId);
    const reqA = await addRequirement(projectId, activityId, '100', SPEC_A);
    const approveB = () => substitutions.approve(projectId, reqA.requirementId, { ...SPEC_B, attributes: 'grey', baseUom: 'bag', reason: 'B ≈ A' }, pmc(projectId));

    const settled = await Promise.allSettled([approveB(), approveB()]);
    const winners = settled.filter((r) => r.status === 'fulfilled');
    const losers = settled.filter((r) => r.status === 'rejected');
    expect(winners).toHaveLength(1); // the partial unique index makes a second ACTIVE row unrepresentable
    expect(losers).toHaveLength(1);
    const active = await t.prisma.approvedSubstitution.count({ where: { projectId, requirementId: reqA.requirementId, revokedAt: null } });
    expect(active).toBe(1);

    // revoking the one active authorization leaves NONE active — no identical duplicate survives
    const winner = (winners[0] as PromiseFulfilledResult<{ id: string }>).value;
    await substitutions.revoke(projectId, winner.id, { reason: 'withdrawn' }, pmc(projectId));
    expect(await t.prisma.approvedSubstitution.count({ where: { projectId, requirementId: reqA.requirementId, revokedAt: null } })).toBe(0);
    // a fresh approval of the same pair is allowed again (revoked rows are history, not a block)
    await approveB();
    expect(await t.prisma.approvedSubstitution.count({ where: { projectId, requirementId: reqA.requirementId, revokedAt: null } })).toBe(1);
  });

  // ── F3 ────────────────────────────────────────────────────────────────────────────────────
  it('F3 QUANTITATIVE: a 10-bag commitment does not cover a 100-bag shortfall (blocked, not at-risk)', async () => {
    const projectId = await freshProject();
    const activityId = await freshActivity(projectId);
    const req = await addRequirement(projectId, activityId, '100', SPEC_A);
    // an issued PO + commitment for only 10 bags; nothing reserved/received → shortfall 100
    const { poLineId } = await receivablePoLine(projectId, req, '10');
    await commit(projectId, poLineId, '2026-09-01');

    const cov = await coverageOf(projectId, activityId);
    expect(cov[0]!.coveredQty).toBe('0');
    expect(cov[0]!.shortfall).toBe('100');
    expect(cov[0]!.verdict).toBe('blocked'); // 10 inbound < 100 shortfall — NOT at-risk
    expect(cov[0]!.commitmentPromisedDate).toBeNull();
  });

  it('F3 QUANTITATIVE: a commitment that covers the full shortfall is at-risk, dated at the covering promise', async () => {
    const projectId = await freshProject();
    const activityId = await freshActivity(projectId);
    const req = await addRequirement(projectId, activityId, '100', SPEC_A);
    const { poLineId } = await receivablePoLine(projectId, req, '100');
    await commit(projectId, poLineId, '2026-09-15');

    const cov = await coverageOf(projectId, activityId);
    expect(cov[0]!.verdict).toBe('at-risk'); // 100 inbound ≥ 100 shortfall
    expect(cov[0]!.commitmentPromisedDate).toBe('2026-09-15');
  });

  // ── F4 ────────────────────────────────────────────────────────────────────────────────────
  it('F4 FULFILL GUARD: an unreceived delivery commitment cannot be fulfilled', async () => {
    const projectId = await freshProject();
    const activityId = await freshActivity(projectId);
    const req = await addRequirement(projectId, activityId, '100', SPEC_A);
    const { poLineId } = await receivablePoLine(projectId, req, '100');
    const commitmentId = await commit(projectId, poLineId);
    // nothing received → fulfilling is a lie about physical delivery → refused
    await expect(pos.fulfillDelivery(projectId, commitmentId, pmc(projectId))).rejects.toMatchObject({ status: 409 });
  });

  it('F4 PROJECTION: closing a PO short removes inbound coverage and the projection follows (live == projection == rebuild)', async () => {
    const projectId = await freshProject();
    const activityId = await freshActivity(projectId);
    const req = await addRequirement(projectId, activityId, '100', SPEC_A);
    const { poId, poLineId } = await receivablePoLine(projectId, req, '100');
    await commit(projectId, poLineId, '2026-09-15');
    await drainRelay();
    expect((await storedReadings(projectId))?.[activityId]?.v).toBe('wait'); // at-risk on the commitment

    await pos.closeShort(projectId, poId, { reason: 'vendor pulled out' }, pmc(projectId));
    await drainRelay();
    const stored = await storedReadings(projectId);
    const live = (await coverageOf(projectId, activityId))[0]!;
    expect(live.verdict).toBe('blocked'); // the commitment's version is closed short — no inbound
    expect(stored?.[activityId]?.v).toBe('fail'); // the projection LEARNED via po.closed_short

    const before = await t.prisma.domainEvent.count({ where: { projectId } });
    const report = await rebuildReadiness();
    expect(report.ok).toBe(true);
    expect(await t.prisma.domainEvent.count({ where: { projectId } })).toBe(before); // rebuild emits nothing
    expect((await storedReadings(projectId))?.[activityId]?.v).toBe('fail');
  });

  it('F4 PROJECTION: a fully-received commitment can be fulfilled and the projection stays consistent (live == projection == rebuild)', async () => {
    const projectId = await freshProject();
    const activityId = await freshActivity(projectId);
    const req = await addRequirement(projectId, activityId, '100', SPEC_A);
    // order 100, receive+accept the FULL 100 and RESERVE it to the activity → ready on physical
    // stock (the commitment's outstanding is already 0). Fulfilment is then legal (finding 1) and
    // must NOT change the verdict — the projection follows the `delivery.fulfilled` event to the
    // same reading, so live == projection == rebuild.
    const { poLineId } = await receivablePoLine(projectId, req, '100');
    const commitmentId = await commit(projectId, poLineId, '2026-09-15');
    const lotId = await receiveAndAccept(projectId, poLineId, commitmentId, '100');
    await inventory.reserve(projectId, { lotId, activityId, qty: '100' }, pmc(projectId));
    await drainRelay();
    expect((await coverageOf(projectId, activityId))[0]!.verdict).toBe('ready'); // covered 100 by reserved stock
    expect((await storedReadings(projectId))?.[activityId]?.v).toBe('ok');

    const done = await pos.fulfillDelivery(projectId, commitmentId, pmc(projectId)); // 100/100 received → legal
    expect(done.status).toBe('fulfilled');
    await drainRelay();
    const live = (await coverageOf(projectId, activityId))[0]!;
    expect(live.verdict).toBe('ready'); // fulfilment terminalizes the commitment; reserved stock still covers
    expect((await storedReadings(projectId))?.[activityId]?.v).toBe('ok'); // projection consumed delivery.fulfilled

    const before = await t.prisma.domainEvent.count({ where: { projectId } });
    const report = await rebuildReadiness();
    expect(report.ok).toBe(true);
    expect(await t.prisma.domainEvent.count({ where: { projectId } })).toBe(before); // rebuild emits nothing
    expect((await storedReadings(projectId))?.[activityId]?.v).toBe('ok'); // live == projection == rebuild
  });

  it('F4 SERIALIZED: fulfill and activities.start race against the readiness lock without corruption (both orderings)', async () => {
    for (const startFirst of [false, true]) {
      const projectId = await freshProject();
      const activityId = await freshActivity(projectId);
      const req = await addRequirement(projectId, activityId, '100', SPEC_A);
      const { poLineId } = await receivablePoLine(projectId, req, '100');
      const commitmentId = await commit(projectId, poLineId, '2026-09-15');
      await receiveAndAccept(projectId, poLineId, commitmentId, '100'); // received (so fulfill is legal), but NOT reserved

      const startCall = () => activities.start(projectId, activityId, pmc(projectId));
      const fulfillCall = () => pos.fulfillDelivery(projectId, commitmentId, pmc(projectId));
      const [a, b] = startFirst ? [startCall, fulfillCall] : [fulfillCall, startCall];
      const settled = await Promise.allSettled([a(), b()]);
      // no interleaving corruption: the commitment is either live or terminal, never both; and the
      // start attempt is consistently refused (coverage was at-risk/blocked, never ready — nothing reserved)
      expect(settled.some((r) => r.status === 'rejected')).toBe(true); // start always refuses here
      const commitment = await t.prisma.deliveryCommitment.findUniqueOrThrow({ where: { id: commitmentId }, select: { status: true } });
      expect(['committed', 'fulfilled']).toContain(commitment.status);
      expect(await status(activityId)).toBe('not_started');
    }
  });

  // ── C2 composition defects (RED at c910320) ─────────────────────────────────────────────────
  //  F5  COMBINED-FLOW: physical stock and inbound commitments are decided in ONE conserved network,
  //      not two stages. A shared physical pool + a per-requirement commitment is at-risk regardless
  //      of which requirement (smaller/larger requirementId) holds the commitment.
  //  F6  FULFIL GUARD: a partial receipt cannot fulfil a whole commitment — fulfilment needs the full
  //      ordered quantity received (`receivedQty >= qty`), or the explicit close-short workflow.

  it('F5 COMBINED-FLOW: shared physical + a per-requirement commitment is at-risk, invariant to which requirement holds the commitment', async () => {
    // Two same-spec 100-bag requirements on ONE activity; 100 reserved bags form a SHARED physical
    // pool; ONE requirement carries a 100-bag confirmed commitment. A feasible plan exists —
    // physical covers the UNCOMMITTED requirement, the commitment covers the OTHER — so the activity
    // is AT-RISK (wait), never blocked. This must hold no matter WHICH requirement (smaller or larger
    // requirementId) holds the commitment; the two-stage 'allocate physical, then inspect inbound'
    // calculation allocated physical to the committed requirement first and left the other blocked.
    for (const commitSmaller of [true, false]) {
      const projectId = await freshProject();
      const activityId = await freshActivity(projectId);
      const r1 = await addRequirement(projectId, activityId, '100', SPEC_A);
      const r2 = await addRequirement(projectId, activityId, '100', SPEC_A);
      const [smaller, larger] = [r1, r2].sort((a, b) => (a.requirementId < b.requirementId ? -1 : 1));
      const committed = commitSmaller ? smaller : larger;
      // 100 shared physical bags reserved to the activity
      await reservedStockFor(projectId, activityId, '100', SPEC_A);
      // a 100-bag confirmed commitment on exactly ONE of the two requirements
      const { poLineId } = await receivablePoLine(projectId, committed, '100');
      await commit(projectId, poLineId, '2026-09-20');

      const cov = await coverageOf(projectId, activityId);
      // combined-flow: physical → the uncommitted requirement, inbound → the committed one ⇒ every
      // demand meets ⇒ at-risk, dated at the covering promise. Order-INVARIANT.
      expect(deriveMaterialReading(cov, false).v).toBe('wait');
      expect(cov.every((c) => c.verdict === 'at-risk')).toBe(true);
      expect(cov.some((c) => c.commitmentPromisedDate === '2026-09-20')).toBe(true);
      // the 100 physical bags are still counted at most once (conserved)
      expect(sum(cov, 'coveredQty')).toBe(100);
    }
  });

  it('F6 FULFIL GUARD: a partially-received commitment cannot be fulfilled until the full ordered quantity is received', async () => {
    const projectId = await freshProject();
    const activityId = await freshActivity(projectId);
    const req = await addRequirement(projectId, activityId, '100', SPEC_A);
    const { poLineId } = await receivablePoLine(projectId, req, '100');
    const commitmentId = await commit(projectId, poLineId, '2026-09-20');

    // 1 of 100 received — outstanding 99. Fulfilling would terminalize the commitment and silently
    // drop 99 units from inbound coverage. Refused.
    await receiveAndAccept(projectId, poLineId, commitmentId, '1');
    await expect(pos.fulfillDelivery(projectId, commitmentId, pmc(projectId))).rejects.toMatchObject({ status: 409 });

    // up to 99 of 100 — outstanding 1. Still refused.
    await receiveAndAccept(projectId, poLineId, commitmentId, '98');
    await expect(pos.fulfillDelivery(projectId, commitmentId, pmc(projectId))).rejects.toMatchObject({ status: 409 });

    // the last unit — fully received (100/100), no outstanding committed quantity. Fulfil succeeds.
    await receiveAndAccept(projectId, poLineId, commitmentId, '1');
    const done = await pos.fulfillDelivery(projectId, commitmentId, pmc(projectId));
    expect(done.status).toBe('fulfilled');
  });
});
