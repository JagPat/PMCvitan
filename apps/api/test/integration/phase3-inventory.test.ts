import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { createTestApp, type TestApp } from './test-app';
import { createTwoProjectFixture, type TwoProjectFixture } from './fixtures';
import { RequirementsService } from '../../src/activities/requirements.service';
import { VendorsService } from '../../src/procurement/vendors.service';
import { ProcurementService } from '../../src/procurement/procurement.service';
import { PurchaseOrdersService } from '../../src/procurement/purchase-orders.service';
import { InventoryService } from '../../src/inventory/inventory.service';
import { MediaService } from '../../src/media/media.service';
import { CapabilitiesService, MATERIALS_CAPABILITY } from '../../src/platform/capabilities.service';
import { OutboxRelay } from '../../src/platform/outbox/relay.service';
import { DECISIONS_PROJECTION } from '../../src/decisions/decisions.projection';
import { lockProjectReadiness } from '../../src/common/readiness-lock';
import type { AuthUser } from '../../src/common/auth';
import type { CreateRequirementInput } from '../../src/contracts';

/**
 * Phase 3 Task 4 — inventory receipts + acceptance + the immutable §C ledger, live-PG
 * acceptance (plan §§C/F/G).
 *
 *   RECEIPT — creates ONE immutable StockLot carrying the pinned revision's FULL §B
 *   MaterialSpecificationRef + PO/commitment provenance; the receipt row fills quarantine
 *   in base UOM via the PO's FROZEN conversion (exact-6dp refusal).
 *   §F BOUND 3 — Σ (accepted + quarantined) per PO line ≤ ordered + approvedOverage, with
 *   the PO line FOR-UPDATE-locked through the procurement PARTICIPANT (the §G edge), which
 *   also appends the procurement-owned received-progress fact + version status: proven
 *   sequentially (overage headroom; a rejection FREES headroom) and under the
 *   deterministic barrier-controlled RACE in both shapes (60/60 → exactly one; 50/50 →
 *   both, exactly 100).
 *   §C CONSERVATION — buckets are DERIVED by one fold over the ledger (no quantity column
 *   anywhere); every command re-derives under the lot FOR UPDATE and REFUSES any negative
 *   bucket; acceptance-vs-adjustment is proven in BOTH orders; the DB CHECKs make
 *   mis-shaped rows (wrong movement, missing evidence/reason, qty ≤ 0) unrepresentable
 *   and the append-only triggers make every row immutable.
 *   REVERSAL (§C rule iii) — appends the DB-trigger-verified exact inverse; at most once
 *   per row; a reversal is not reversible; receipt/rejection reversals restore the §F
 *   bound-3 side under the PO-line lock (a rejection-reversal that would overrun the
 *   bound REFUSES).
 *   IDEMPOTENCY (§C rule ii) — a keyed replay appends NOTHING; every ledger row records
 *   its source CommandExecution id.
 *   EVIDENCE — quality decisions demand a project-scoped photo; media cited by the
 *   immutable ledger is not deletable (the inventory participant refuses the delete).
 */

describe('Phase 3 Task 4 — inventory: receipts, acceptance, the §C stock ledger (live PG)', () => {
  let t: TestApp;
  let f: TwoProjectFixture;
  let requirements: RequirementsService;
  let vendors: VendorsService;
  let procurement: ProcurementService;
  let pos: PurchaseOrdersService;
  let inventory: InventoryService;
  let media: MediaService;
  let capabilities: CapabilitiesService;
  let relay: OutboxRelay;
  let seq = 0;

  const TRUNCATE =
    'TRUNCATE TABLE "DomainEvent", "OutboxDelivery", "ProcessedEvent", "ProjectionCursor", "ProjectionGeneration", "DecisionProjection", "DailyLogProjection", "DrawingsProjection", "InspectionsProjection", "ActivitiesProjection", "StockTransaction", "StockLot", "CommandExecution", "DeliveryPromise", "DeliveryCommitment", "PurchaseOrderLine", "PurchaseOrderVersion", "PurchaseOrder", "VendorQuoteLine", "QuoteComparison", "VendorQuote", "Rfq", "RequisitionLine", "Requisition", "ProjectVendor", "MaterialRequirementSpec", "ActivityRequirement", "ActivityRequirementRoot", "DecisionApprovalRevision", "ProjectCapability"';

  const pmc = (projectId: string): AuthUser => ({ sub: f.memberUser.id, role: 'pmc', projectId }) as AuthUser;
  const orgAdmin = (): AuthUser => ({ sub: f.ownerUser.id, role: 'pmc' }) as AuthUser;

  beforeAll(async () => {
    t = await createTestApp();
    f = await createTwoProjectFixture(t.prisma);
    requirements = t.app.get(RequirementsService);
    vendors = t.app.get(VendorsService);
    procurement = t.app.get(ProcurementService);
    pos = t.app.get(PurchaseOrdersService);
    inventory = t.app.get(InventoryService);
    media = t.app.get(MediaService);
    capabilities = t.app.get(CapabilitiesService);
    relay = t.app.get(OutboxRelay);
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
      ['media', { projectId: { startsWith: 'it-p3s-' } }],
      ['notification', { projectId: { startsWith: 'it-p3s-' } }],
      ['activity', { projectId: { startsWith: 'it-p3s-' } }],
      ['auditLog', { projectId: { startsWith: 'it-p3s-' } }],
      ['membership', { projectId: { startsWith: 'it-p3s-' } }],
      ['project', { id: { startsWith: 'it-p3s-' } }],
    ] as const) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (t.prisma as any)[model].deleteMany({ where });
    }
  });

  const freshProject = async (orgId = f.orgA.id): Promise<string> => {
    const id = `it-p3s-${Date.now() % 1e6}-${seq++}`;
    await t.prisma.project.create({
      data: { id, orgId, name: id, short: 'P', descriptor: '', stage: 'x', siteCode: 'P', projStart: 'a', projEnd: 'b', elapsedPct: 0, todayDay: 0, milestonePct: 0, timeZone: 'Asia/Kolkata', scheduleStartDate: new Date('2026-06-01T00:00:00.000Z') },
    });
    await t.prisma.membership.create({ data: { projectId: id, userId: f.memberUser.id, role: 'pmc', status: 'active' } });
    await capabilities.enable(id, MATERIALS_CAPABILITY, f.memberUser.id);
    return id;
  };

  const freshActivity = async (projectId: string): Promise<string> => {
    const id = `IT-P3S-ACT-${Date.now() % 1e6}-${seq++}`;
    await t.prisma.activity.create({ data: { id, projectId, name: `Act ${seq}`, zone: 'Zone 1', plannedStart: 0, plannedEnd: 10 } });
    return id;
  };

  const freshRequirement = async (projectId: string, qty = '100'): Promise<{ requirementId: string; revision: number }> => {
    const activityId = await freshActivity(projectId);
    const input: CreateRequirementInput = {
      activityId, materialCategory: 'Cement', make: 'UltraTech', grade: 'OPC 53', attributes: 'grey',
      baseUom: 'bag', qty, requiredBy: '2026-08-15', criticality: 'normal',
      decisionId: null, responsibleId: null, tolerance: null,
    };
    const r = await requirements.create(projectId, input, pmc(projectId));
    return { requirementId: r.requirementId, revision: r.revision };
  };

  const freshMedia = async (projectId: string): Promise<string> => {
    const row = await t.prisma.media.create({
      data: { projectId, kind: 'material', mime: 'image/jpeg', uploadedBy: f.memberUser.id, sizeBytes: 3 },
    });
    return row.id;
  };

  /** The full §F pipeline: requirement → approved requisition → quote → approved comparison. */
  const approvedChain = async (
    projectId: string,
    { reqQty = '100', lineQty = '100', rate = '100.00', tax = '50.00', freight = '25.00' } = {},
  ) => {
    const req = await freshRequirement(projectId, reqQty);
    const created = await procurement.createRequisition(
      projectId, { title: `Req ${seq++}`, lines: [{ requirementId: req.requirementId, revision: req.revision, qty: lineQty }] }, pmc(projectId),
    );
    await procurement.submit(projectId, created.id, pmc(projectId));
    const requisition = await procurement.approve(projectId, created.id, pmc(projectId));
    const lineId = requisition.lines[0]!.id;
    const rfq = await procurement.createRfq(projectId, { requisitionId: requisition.id }, pmc(projectId));
    const vendor = await vendors.create(f.orgA.id, { name: `Vendor ${seq++}` }, orgAdmin());
    await vendors.bind(projectId, { vendorId: vendor.id }, pmc(projectId));
    const withQuote = await procurement.recordQuote(projectId, rfq.id, {
      vendorId: vendor.id, validUntil: '2027-01-01',
      lines: [{ requisitionLineId: lineId, baseRate: rate, taxAmount: tax, freightAmount: freight, landedCost: '999.99', quotedMake: 'UltraTech OPC', matchesSpecification: true }],
    }, pmc(projectId));
    const quoteId = withQuote.quotes.find((q) => q.status === 'recorded')!.id;
    await procurement.createComparison(projectId, rfq.id, pmc(projectId));
    const approved = await procurement.approveComparison(projectId, rfq.id, { selectedQuoteId: quoteId, reason: 'single quote, in spec' }, pmc(projectId));
    return { req, requisition, lineId, rfq, vendorId: vendor.id, quoteId, comparisonId: approved.comparison!.id };
  };

  /** …then an ISSUED PO on that line (+ optional overage + purchase triple) + its delivery commitment. */
  const receivablePoLine = async (
    projectId: string,
    {
      reqQty = '100', lineQty = '100', purchaseQty = lineQty, conversionToBase = undefined as string | undefined,
      purchaseUom = undefined as string | undefined, overage = undefined as string | undefined, overageReason = 'vendor pack rounding',
    } = {},
  ) => {
    const chain = await approvedChain(projectId, { reqQty, lineQty });
    const po = await pos.create(projectId, {
      comparisonId: chain.comparisonId,
      lines: [{ requisitionLineId: chain.lineId, purchaseQty, ...(conversionToBase ? { conversionToBase } : {}), ...(purchaseUom ? { purchaseUom } : {}) }],
    }, pmc(projectId));
    await pos.issue(projectId, po.id, overage ? { overages: [{ requisitionLineId: chain.lineId, approvedOverage: overage, reason: overageReason }] } : {}, pmc(projectId));
    const line = await t.prisma.purchaseOrderLine.findFirstOrThrow({ where: { projectId, requisitionLineId: chain.lineId } });
    const commitment = await pos.commitDelivery(projectId, { poLineId: line.id, promisedDate: '2026-09-01' }, pmc(projectId));
    return { chain, poId: po.id, poLineId: line.id, commitmentId: commitment.id };
  };

  const buckets = async (projectId: string, lotId: string, storeLocation = 'main') => {
    const store = await inventory.store(projectId, pmc(projectId));
    const lot = store.lots.find((l) => l.id === lotId);
    return lot?.locations.find((loc) => loc.storeLocation === storeLocation);
  };

  const receivedQty = async (projectId: string, poLineId: string): Promise<string> => {
    const row = await t.prisma.purchaseOrderLine.findFirstOrThrow({ where: { projectId, id: poLineId } });
    return row.receivedQty.toString();
  };

  const versionStatus = async (projectId: string, poLineId: string): Promise<string> => {
    const row = await t.prisma.purchaseOrderLine.findFirstOrThrow({ where: { projectId, id: poLineId }, select: { poVersionId: true } });
    const v = await t.prisma.purchaseOrderVersion.findFirstOrThrow({ where: { projectId, id: row.poVersionId }, select: { status: true } });
    return v.status;
  };

  it('§D INERTNESS: the stock surface is 404 on a non-pilot project', async () => {
    const id = `it-p3s-off-${Date.now() % 1e6}-${seq++}`;
    await t.prisma.project.create({
      data: { id, orgId: f.orgA.id, name: id, short: 'P', descriptor: '', stage: 'x', siteCode: 'P', projStart: 'a', projEnd: 'b', elapsedPct: 0, todayDay: 0, milestonePct: 0, timeZone: 'Asia/Kolkata', scheduleStartDate: new Date('2026-06-01T00:00:00.000Z') },
    });
    await t.prisma.membership.create({ data: { projectId: id, userId: f.memberUser.id, role: 'pmc', status: 'active' } });
    await expect(inventory.recordReceipt(id, { poLineId: 'x', commitmentId: 'y', purchaseQty: '1' }, pmc(id))).rejects.toMatchObject({ status: 404 });
    await expect(inventory.accept(id, { lotId: 'x', qty: '1', qualityResult: 'passed', evidenceMediaId: 'm' }, pmc(id))).rejects.toMatchObject({ status: 404 });
    await expect(inventory.store(id, pmc(id))).rejects.toMatchObject({ status: 404 });
  });

  it('RECEIPT: a new immutable lot freezes the full §B spec ref; base qty runs through the FROZEN conversion; the participant appends received progress', async () => {
    const projectId = await freshProject();
    // pallet packs: 1 pallet = 5 bags; the line orders 20 pallets = 100 bags (base)
    const { chain, poLineId, commitmentId } = await receivablePoLine(projectId, { purchaseQty: '20', conversionToBase: '5', purchaseUom: 'pallet' });

    const key = `it-p3s-rc-${Date.now() % 1e6}-${seq++}`;
    // 4 pallets arrive = 20 bags into quarantine
    const lot = await inventory.recordReceipt(projectId, { poLineId, commitmentId, purchaseQty: '4' }, pmc(projectId), key);

    // the lot carries the FULL §B MaterialSpecificationRef, verbatim from the pinned revision
    const spec = await t.prisma.materialRequirementSpec.findFirstOrThrow({
      where: { projectId, requirementId: chain.req.requirementId, revision: chain.req.revision },
    });
    expect(lot).toMatchObject({
      poLineId, commitmentId, requirementId: chain.req.requirementId, revision: chain.req.revision,
      // the NORMALIZED technical identity, verbatim from the revision's spec row
      materialCategory: spec.materialCategory, make: spec.make, grade: spec.grade,
      normalizedAttributes: spec.normalizedAttributes, baseUom: 'bag', specFingerprint: spec.specFingerprint,
      decisionId: null, decisionVersion: null, optionKey: null,
      receivedById: f.memberUser.id,
    });
    expect(spec.materialCategory).toBe('cement'); // normalization really applied (§B)
    // ONE receipt row: (outside) → quarantine, 20 base units, full provenance + §C rule ii source
    expect(lot.transactions).toHaveLength(1);
    const rc = lot.transactions[0]!;
    expect(rc).toMatchObject({ type: 'receipt', qty: '20', fromBucket: null, toBucket: 'quarantine', poLineId, commitmentId, storeLocation: 'main' });
    const exec = await t.prisma.commandExecution.findFirstOrThrow({ where: { projectId, commandType: 'receipts.record', idempotencyKey: key } });
    expect(rc.sourceCommandId).toBe(exec.id);
    // buckets derive from the ledger — no quantity column anywhere
    expect(await buckets(projectId, lot.id)).toMatchObject({ quarantine: '20', acceptedOnHand: '0', rejected: '0', freeAvailable: '0' });
    // the procurement-owned received-progress fact + version status advanced in the SAME tx
    expect(await receivedQty(projectId, poLineId)).toBe('20');
    expect(await versionStatus(projectId, poLineId)).toBe('partially_received');

    // exact-6dp discipline: 1.5 pallets × conversion 0.333333 cannot land on numeric(18,6)
    const { poLineId: pl2, commitmentId: cm2 } = await receivablePoLine(projectId, { purchaseQty: '300', conversionToBase: '0.333333', purchaseUom: 'box' });
    await expect(
      inventory.recordReceipt(projectId, { poLineId: pl2, commitmentId: cm2, purchaseQty: '1.5' }, pmc(projectId)),
    ).rejects.toMatchObject({ status: 400 });
    // a commitment of a DIFFERENT line is refused (receipt provenance must pair)
    await expect(
      inventory.recordReceipt(projectId, { poLineId, commitmentId: cm2, purchaseQty: '1' }, pmc(projectId)),
    ).rejects.toMatchObject({ status: 409 });
  });

  it('§F BOUND 3 (SEQUENTIAL): ordered + approvedOverage caps accepted+quarantined; a rejection FREES headroom', async () => {
    const projectId = await freshProject();
    // ordered 100 with overage 5 → bound 105
    const { poLineId, commitmentId } = await receivablePoLine(projectId, { overage: '5' });
    const lot = await inventory.recordReceipt(projectId, { poLineId, commitmentId, purchaseQty: '60' }, pmc(projectId));
    await expect(
      inventory.recordReceipt(projectId, { poLineId, commitmentId, purchaseQty: '50' }, pmc(projectId)),
    ).rejects.toMatchObject({ status: 409 }); // 60+50 = 110 > 105
    await inventory.recordReceipt(projectId, { poLineId, commitmentId, purchaseQty: '45' }, pmc(projectId)); // 105 = bound
    expect(await receivedQty(projectId, poLineId)).toBe('105');
    expect(await versionStatus(projectId, poLineId)).toBe('completed'); // ≥ ordered
    await expect(
      inventory.recordReceipt(projectId, { poLineId, commitmentId, purchaseQty: '1' }, pmc(projectId)),
    ).rejects.toMatchObject({ status: 409 });

    // a REJECTION frees bound-3 headroom (the vendor replaces rejected material)
    const evidence = await freshMedia(projectId);
    await inventory.reject(projectId, { lotId: lot.id, qty: '20', evidenceMediaId: evidence, reason: 'broken bags' }, pmc(projectId));
    expect(await receivedQty(projectId, poLineId)).toBe('85');
    expect(await versionStatus(projectId, poLineId)).toBe('partially_received');
    const lot2 = await inventory.recordReceipt(projectId, { poLineId, commitmentId, purchaseQty: '20' }, pmc(projectId));
    expect(await receivedQty(projectId, poLineId)).toBe('105');
    expect(lot2.id).not.toBe(lot.id); // each delivery batch is its own lot
  });

  // The deterministic RACE barrier (Task-1 round-3 pattern): every balance-affecting command
  // takes lockProjectReadiness first, so the test holds that advisory lock, parks both
  // commands in its wait queue (verified via pg_stat_activity), and releases — grant order =
  // enqueue order.
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

  const race = async (projectId: string, first: () => Promise<unknown>, second: () => Promise<unknown>) => {
    let release!: () => void;
    let acquired!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const held = new Promise<void>((r) => (acquired = r));
    const holder = t.prisma.$transaction(
      async (tx) => { await lockProjectReadiness(tx, projectId); acquired(); await gate; },
      { timeout: 20_000, maxWait: 10_000 },
    );
    await held;
    const a = first();
    await waitForReadinessWaiters(1);
    const b = second();
    await waitForReadinessWaiters(2);
    release();
    await holder;
    return Promise.allSettled([a, b]);
  };

  it('§F BOUND 3 (RACE): two 60-bag receipts racing a 100-bag line admit EXACTLY one', async () => {
    const projectId = await freshProject();
    const { poLineId, commitmentId } = await receivablePoLine(projectId);
    const [a, b] = await race(
      projectId,
      () => inventory.recordReceipt(projectId, { poLineId, commitmentId, purchaseQty: '60' }, pmc(projectId)),
      () => inventory.recordReceipt(projectId, { poLineId, commitmentId, purchaseQty: '60' }, pmc(projectId)),
    );
    // deterministic: the first enqueued wins, the second overruns the bound
    expect(a!.status).toBe('fulfilled');
    expect(b!.status).toBe('rejected');
    expect((b as PromiseRejectedResult).reason).toMatchObject({ status: 409 });
    expect(await receivedQty(projectId, poLineId)).toBe('60');
    expect(await t.prisma.stockTransaction.count({ where: { projectId, type: 'receipt' } })).toBe(1);
  });

  it('CONCURRENT RECEIPTS (RACE): 50 + 50 on a 100-bag line both land — serialized, no lost update, exactly 100', async () => {
    const projectId = await freshProject();
    const { poLineId, commitmentId } = await receivablePoLine(projectId);
    const [a, b] = await race(
      projectId,
      () => inventory.recordReceipt(projectId, { poLineId, commitmentId, purchaseQty: '50' }, pmc(projectId)),
      () => inventory.recordReceipt(projectId, { poLineId, commitmentId, purchaseQty: '50' }, pmc(projectId)),
    );
    expect(a!.status).toBe('fulfilled');
    expect(b!.status).toBe('fulfilled');
    expect(await receivedQty(projectId, poLineId)).toBe('100');
    expect(await versionStatus(projectId, poLineId)).toBe('completed');
    expect(await t.prisma.stockTransaction.count({ where: { projectId, type: 'receipt' } })).toBe(2);
  });

  it('§C BOTH ORDERS (RACE): acceptance vs adjustment on one 50-bag quarantine — whichever runs second REFUSES', async () => {
    const projectId = await freshProject();
    const evidence = await freshMedia(projectId);

    // order 1: acceptance(40) first, write-off adjustment(20) second → the adjustment refuses
    {
      const { poLineId, commitmentId } = await receivablePoLine(projectId);
      const lot = await inventory.recordReceipt(projectId, { poLineId, commitmentId, purchaseQty: '50' }, pmc(projectId));
      const [a, b] = await race(
        projectId,
        () => inventory.accept(projectId, { lotId: lot.id, qty: '40', qualityResult: 'passed', evidenceMediaId: evidence }, pmc(projectId)),
        () => inventory.adjust(projectId, { lotId: lot.id, qty: '20', fromBucket: 'quarantine', reason: 'damaged in unloading' }, pmc(projectId)),
      );
      expect(a!.status).toBe('fulfilled');
      expect(b!.status).toBe('rejected'); // quarantine is 10 after accepting 40 — 20 would go negative
      expect((b as PromiseRejectedResult).reason).toMatchObject({ status: 409 });
      expect(await buckets(projectId, lot.id)).toMatchObject({ quarantine: '10', acceptedOnHand: '40', rejected: '0' });
    }

    // order 2: adjustment(20) first, acceptance(40) second → the acceptance refuses
    {
      const { poLineId, commitmentId } = await receivablePoLine(projectId);
      const lot = await inventory.recordReceipt(projectId, { poLineId, commitmentId, purchaseQty: '50' }, pmc(projectId));
      const [a, b] = await race(
        projectId,
        () => inventory.adjust(projectId, { lotId: lot.id, qty: '20', fromBucket: 'quarantine', reason: 'damaged in unloading' }, pmc(projectId)),
        () => inventory.accept(projectId, { lotId: lot.id, qty: '40', qualityResult: 'passed', evidenceMediaId: evidence }, pmc(projectId)),
      );
      expect(a!.status).toBe('fulfilled');
      expect(b!.status).toBe('rejected'); // quarantine is 30 after writing off 20 — 40 would go negative
      expect((b as PromiseRejectedResult).reason).toMatchObject({ status: 409 });
      expect(await buckets(projectId, lot.id)).toMatchObject({ quarantine: '30', acceptedOnHand: '0', rejected: '0' });
    }
  });

  it('§C CONSERVATION: accept/reject/vendor-return move exactly their buckets; EVERY negative-balance attempt REFUSES', async () => {
    const projectId = await freshProject();
    const evidence = await freshMedia(projectId);
    const { poLineId, commitmentId } = await receivablePoLine(projectId);
    const lot = await inventory.recordReceipt(projectId, { poLineId, commitmentId, purchaseQty: '100' }, pmc(projectId));

    // partial acceptance + rejection split quarantine
    await inventory.accept(projectId, { lotId: lot.id, qty: '70', qualityResult: 'passed', evidenceMediaId: evidence }, pmc(projectId));
    await inventory.reject(projectId, { lotId: lot.id, qty: '25', evidenceMediaId: evidence, reason: 'wrong grade markings' }, pmc(projectId));
    expect(await buckets(projectId, lot.id)).toMatchObject({ quarantine: '5', acceptedOnHand: '70', rejected: '25', freeAvailable: '70' });

    // negative refusals across every Task-4 movement (§C rule i)
    await expect(inventory.accept(projectId, { lotId: lot.id, qty: '6', qualityResult: 'passed', evidenceMediaId: evidence }, pmc(projectId)))
      .rejects.toMatchObject({ status: 409 }); // quarantine 5 < 6
    await expect(inventory.reject(projectId, { lotId: lot.id, qty: '6', evidenceMediaId: evidence }, pmc(projectId)))
      .rejects.toMatchObject({ status: 409 });
    await expect(inventory.vendorReturn(projectId, { lotId: lot.id, qty: '26' }, pmc(projectId)))
      .rejects.toMatchObject({ status: 409 }); // rejected 25 < 26
    await expect(inventory.adjust(projectId, { lotId: lot.id, qty: '71', fromBucket: 'acceptedOnHand', reason: 'recount' }, pmc(projectId)))
      .rejects.toMatchObject({ status: 409 });
    // a movement at a DIFFERENT store location sees ITS OWN (empty) buckets — the §C stock key
    await expect(inventory.accept(projectId, { lotId: lot.id, storeLocation: 'staging', qty: '1', qualityResult: 'passed', evidenceMediaId: evidence }, pmc(projectId)))
      .rejects.toMatchObject({ status: 409 });

    // vendor return closes the rejection
    await inventory.vendorReturn(projectId, { lotId: lot.id, qty: '25', note: 'returned on truck 7' }, pmc(projectId));
    expect(await buckets(projectId, lot.id)).toMatchObject({ quarantine: '5', acceptedOnHand: '70', rejected: '0' });

    // evidence discipline: a photo from ANOTHER project (or none at all) never validates
    const evidenceB = await freshMedia(await freshProject(f.orgB.id));
    await expect(inventory.accept(projectId, { lotId: lot.id, qty: '1', qualityResult: 'passed', evidenceMediaId: evidenceB }, pmc(projectId)))
      .rejects.toMatchObject({ status: 400 });
  });

  it('IDEMPOTENCY (§C rule ii): keyed replays of receipt and acceptance append NOTHING', async () => {
    const projectId = await freshProject();
    const evidence = await freshMedia(projectId);
    const { poLineId, commitmentId } = await receivablePoLine(projectId);
    const key = `it-p3s-key-${Date.now() % 1e6}-${seq++}`;
    const first = await inventory.recordReceipt(projectId, { poLineId, commitmentId, purchaseQty: '40' }, pmc(projectId), key);
    const replay = await inventory.recordReceipt(projectId, { poLineId, commitmentId, purchaseQty: '40' }, pmc(projectId), key);
    expect(replay.id).toBe(first.id);
    expect(await t.prisma.stockLot.count({ where: { projectId } })).toBe(1);
    expect(await t.prisma.stockTransaction.count({ where: { projectId } })).toBe(1);
    expect(await receivedQty(projectId, poLineId)).toBe('40'); // NOT 80
    expect(await t.prisma.domainEvent.count({ where: { projectId, eventType: 'stock.transacted' } })).toBe(1);

    const acceptKey = `${key}-accept`;
    await inventory.accept(projectId, { lotId: first.id, qty: '10', qualityResult: 'passed', evidenceMediaId: evidence }, pmc(projectId), acceptKey);
    await inventory.accept(projectId, { lotId: first.id, qty: '10', qualityResult: 'passed', evidenceMediaId: evidence }, pmc(projectId), acceptKey);
    expect(await t.prisma.stockTransaction.count({ where: { projectId } })).toBe(2);
    expect(await buckets(projectId, first.id)).toMatchObject({ quarantine: '30', acceptedOnHand: '10' });
    // same key + different payload is the documented 409
    await expect(
      inventory.accept(projectId, { lotId: first.id, qty: '11', qualityResult: 'passed', evidenceMediaId: evidence }, pmc(projectId), acceptKey),
    ).rejects.toMatchObject({ status: 409 });
  });

  it('REVERSAL (§C rule iii): the exact inverse appends; bounds restore under the PO-line lock; at most once; never a reversal of a reversal', async () => {
    const projectId = await freshProject();
    const evidence = await freshMedia(projectId);
    const { poLineId, commitmentId } = await receivablePoLine(projectId);
    const lot = await inventory.recordReceipt(projectId, { poLineId, commitmentId, purchaseQty: '60' }, pmc(projectId));
    const receiptTx = lot.transactions[0]!;
    expect(await versionStatus(projectId, poLineId)).toBe('partially_received');

    // reverse the receipt: quarantine empties, received progress returns, status falls back
    await inventory.reverse(projectId, { txId: receiptTx.id, reason: 'clerical duplicate entry' }, pmc(projectId));
    expect(await buckets(projectId, lot.id)).toMatchObject({ quarantine: '0', acceptedOnHand: '0', rejected: '0' });
    expect(await receivedQty(projectId, poLineId)).toBe('0');
    expect(await versionStatus(projectId, poLineId)).toBe('issued');
    // …and the freed bound admits a full re-receipt
    const lot2 = await inventory.recordReceipt(projectId, { poLineId, commitmentId, purchaseQty: '100' }, pmc(projectId));

    // at most once per row; a reversal itself is not reversible
    await expect(inventory.reverse(projectId, { txId: receiptTx.id, reason: 'again' }, pmc(projectId))).rejects.toMatchObject({ status: 409 });
    const reversalRow = await t.prisma.stockTransaction.findFirstOrThrow({ where: { projectId, type: 'reversal' } });
    await expect(inventory.reverse(projectId, { txId: reversalRow.id, reason: 'undo the undo' }, pmc(projectId))).rejects.toMatchObject({ status: 409 });

    // a receipt-reversal AFTER acceptance consumed quarantine refuses (§C rule i)
    const receipt2 = (await t.prisma.stockTransaction.findFirstOrThrow({ where: { projectId, lotId: lot2.id, type: 'receipt' } }));
    await inventory.accept(projectId, { lotId: lot2.id, qty: '80', qualityResult: 'passed', evidenceMediaId: evidence }, pmc(projectId));
    await expect(inventory.reverse(projectId, { txId: receipt2.id, reason: 'too late' }, pmc(projectId))).rejects.toMatchObject({ status: 409 });

    // a rejection-reversal that would OVERRUN §F bound 3 refuses: reject 30 (→70), refill 30 (→100 = bound)…
    await inventory.reject(projectId, { lotId: lot2.id, qty: '20', evidenceMediaId: evidence, reason: 'moisture damage' }, pmc(projectId));
    const rejectionRow = await t.prisma.stockTransaction.findFirstOrThrow({ where: { projectId, lotId: lot2.id, type: 'rejection' } });
    await inventory.recordReceipt(projectId, { poLineId, commitmentId, purchaseQty: '20' }, pmc(projectId));
    expect(await receivedQty(projectId, poLineId)).toBe('100');
    // …so un-rejecting the 20 would make accepted+quarantined 120 > 100
    await expect(inventory.reverse(projectId, { txId: rejectionRow.id, reason: 'was fine after all' }, pmc(projectId))).rejects.toMatchObject({ status: 409 });
  });

  it('DB SEAL: rows are immutable, mis-shaped rows are unrepresentable, the reversal trigger proves the inverse', async () => {
    const projectId = await freshProject();
    const evidence = await freshMedia(projectId);
    const { poLineId, commitmentId } = await receivablePoLine(projectId);
    const lot = await inventory.recordReceipt(projectId, { poLineId, commitmentId, purchaseQty: '50' }, pmc(projectId));
    const receiptTx = lot.transactions[0]!;

    // append-only: no update, no delete — lot AND ledger
    await expect(t.prisma.stockTransaction.update({ where: { id: receiptTx.id }, data: { qty: '999' } })).rejects.toThrow(/append-only/);
    await expect(t.prisma.stockTransaction.delete({ where: { id: receiptTx.id } })).rejects.toThrow(/append-only/);
    await expect(t.prisma.stockLot.update({ where: { id: lot.id }, data: { specFingerprint: 'forged' } })).rejects.toThrow(/append-only/);
    await expect(t.prisma.stockLot.delete({ where: { id: lot.id } })).rejects.toThrow(/append-only/);

    const base = {
      projectId, lotId: lot.id, storeLocation: 'main', recordedById: f.memberUser.id,
    };
    // §C equations are CHECK-pinned: a receipt that fills anything but quarantine is unrepresentable
    await expect(t.prisma.stockTransaction.create({
      data: { ...base, type: 'receipt', qty: '1', fromBucket: null, toBucket: 'acceptedOnHand', poLineId, commitmentId },
    })).rejects.toThrow();
    // an acceptance without quality result + evidence is unrepresentable
    await expect(t.prisma.stockTransaction.create({
      data: { ...base, type: 'acceptance', qty: '1', fromBucket: 'quarantine', toBucket: 'acceptedOnHand' },
    })).rejects.toThrow();
    // an unreasoned adjustment is unrepresentable
    await expect(t.prisma.stockTransaction.create({
      data: { ...base, type: 'adjustment', qty: '1', fromBucket: 'quarantine', toBucket: 'acceptedOnHand' },
    })).rejects.toThrow();
    // a non-positive movement is unrepresentable
    await expect(t.prisma.stockTransaction.create({
      data: { ...base, type: 'adjustment', qty: '0', fromBucket: 'quarantine', toBucket: null, reason: 'zero' },
    })).rejects.toThrow();
    // the reversal trigger: wrong qty / wrong buckets are rejected as not-the-inverse
    await expect(t.prisma.stockTransaction.create({
      data: { ...base, type: 'reversal', qty: '49', fromBucket: 'quarantine', toBucket: null, reversedTxId: receiptTx.id, reason: 'partial undo' },
    })).rejects.toThrow(/in full/);
    await expect(t.prisma.stockTransaction.create({
      data: { ...base, type: 'reversal', qty: '50', fromBucket: 'acceptedOnHand', toBucket: null, reversedTxId: receiptTx.id, reason: 'wrong side' },
    })).rejects.toThrow(/exact inverse/);
    // the partial unique: a second reversal of the SAME row is unrepresentable
    await inventory.reverse(projectId, { txId: receiptTx.id, reason: 'entered twice' }, pmc(projectId));
    await expect(t.prisma.stockTransaction.create({
      data: { ...base, type: 'reversal', qty: '50', fromBucket: 'quarantine', toBucket: null, reversedTxId: receiptTx.id, reason: 'again' },
    })).rejects.toThrow();

    // media cited by the immutable ledger is not deletable — the participant refuses first
    const lotB = await inventory.recordReceipt(projectId, { poLineId, commitmentId, purchaseQty: '10' }, pmc(projectId));
    await inventory.accept(projectId, { lotId: lotB.id, qty: '5', qualityResult: 'passed', evidenceMediaId: evidence }, pmc(projectId));
    await expect(media.remove(evidence, pmc(projectId))).rejects.toMatchObject({ status: 409 });
    const freeMedia = await freshMedia(projectId);
    expect(await media.remove(freeMedia, pmc(projectId))).toBe(true);
  });

  it('§G EVENTS: every appended ledger row announces stock.transacted with the documented payload; consumers advance', async () => {
    const projectId = await freshProject();
    const evidence = await freshMedia(projectId);
    const { poLineId, commitmentId } = await receivablePoLine(projectId);
    const lot = await inventory.recordReceipt(projectId, { poLineId, commitmentId, purchaseQty: '30' }, pmc(projectId));
    await inventory.accept(projectId, { lotId: lot.id, qty: '20', qualityResult: 'passed', evidenceMediaId: evidence }, pmc(projectId));
    await inventory.reject(projectId, { lotId: lot.id, qty: '10', evidenceMediaId: evidence }, pmc(projectId));
    await inventory.vendorReturn(projectId, { lotId: lot.id, qty: '10' }, pmc(projectId));
    await inventory.adjust(projectId, { lotId: lot.id, qty: '1', fromBucket: 'acceptedOnHand', reason: 'stocktake variance' }, pmc(projectId));

    const evs = await t.prisma.domainEvent.findMany({
      where: { projectId, eventType: 'stock.transacted' },
      orderBy: { streamPosition: 'asc' },
    });
    const payloads = evs.map((e) => e.payload as { txId: string; type: string; stockKey: Record<string, string>; qty: string; sourceCommandId: string | null });
    expect(payloads.map((p) => p.type)).toEqual(['receipt', 'acceptance', 'rejection', 'vendor_return', 'adjustment']);
    for (const p of payloads) {
      expect(p.stockKey).toEqual({ projectId, storeLocation: 'main', stockLotId: lot.id });
      const row = await t.prisma.stockTransaction.findFirstOrThrow({ where: { projectId, id: p.txId } });
      expect(p.qty).toBe(row.qty.toString());
      expect(p.sourceCommandId).toBe(row.sourceCommandId);
    }

    // ordered consumers no-op PAST the stock events (nothing stalls, nothing corrupts)
    const ds = await t.prisma.outboxDelivery.findMany({ where: { consumer: DECISIONS_PROJECTION, projectId }, orderBy: { streamPosition: 'asc' } });
    for (const d of ds) expect(await relay.dispatchOne(d.id)).toBe('succeeded');
    const gen = await t.prisma.projectionGeneration.findFirst({ where: { consumer: DECISIONS_PROJECTION, projectId, status: 'active' } });
    expect(gen?.appliedPosition).toBe(evs[evs.length - 1]!.streamPosition);
  });

  it('§H TENANCY: stock is invisible and unreachable across projects; store derives per-location buckets', async () => {
    const projectId = await freshProject();
    const other = await freshProject(f.orgB.id);
    const evidence = await freshMedia(projectId);
    const { poLineId, commitmentId } = await receivablePoLine(projectId);
    const lot = await inventory.recordReceipt(projectId, { poLineId, commitmentId, purchaseQty: '40', storeLocation: 'yard' }, pmc(projectId));

    // cross-project reach: the OTHER project cannot see, accept or receive against this stock
    await expect(inventory.accept(other, { lotId: lot.id, qty: '1', qualityResult: 'passed', evidenceMediaId: evidence }, pmc(other)))
      .rejects.toMatchObject({ status: 404 });
    await expect(inventory.recordReceipt(other, { poLineId, commitmentId, purchaseQty: '1' }, pmc(other)))
      .rejects.toMatchObject({ status: 404 });
    expect((await inventory.store(other, pmc(other))).lots).toEqual([]);

    // the store read: per-location §C buckets + the ordered ledger
    await inventory.accept(projectId, { lotId: lot.id, storeLocation: 'yard', qty: '15', qualityResult: 'passed', evidenceMediaId: evidence }, pmc(projectId));
    const store = await inventory.store(projectId, pmc(projectId));
    const read = store.lots.find((l) => l.id === lot.id)!;
    expect(read.locations).toEqual([
      { storeLocation: 'yard', quarantine: '25', acceptedOnHand: '15', reserved: '0', freeAvailable: '15', rejected: '0', issuedToActivity: '0' },
    ]);
    expect(read.transactions.map((x) => x.type)).toEqual(['receipt', 'acceptance']);
  });
});
