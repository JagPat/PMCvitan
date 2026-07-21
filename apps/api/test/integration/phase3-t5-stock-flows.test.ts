import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { createTestApp, type TestApp } from './test-app';
import { createTwoProjectFixture, type TwoProjectFixture } from './fixtures';
import { RequirementsService } from '../../src/activities/requirements.service';
import { VendorsService } from '../../src/procurement/vendors.service';
import { ProcurementService } from '../../src/procurement/procurement.service';
import { PurchaseOrdersService } from '../../src/procurement/purchase-orders.service';
import { InventoryService } from '../../src/inventory/inventory.service';
import { DailyLogService } from '../../src/daily-log/daily-log.service';
import { CapabilitiesService, MATERIALS_CAPABILITY } from '../../src/platform/capabilities.service';
import { lockProjectReadiness } from '../../src/common/readiness-lock';
import type { AuthUser } from '../../src/common/auth';
import type { CreateRequirementInput } from '../../src/contracts';

/**
 * Phase 3 Task 5 — store-to-site flows + the §E mismatch resolution, live-PG acceptance
 * (plan §§A/C/E).
 *
 *   RESERVATION — (outside) ↔ `reserved` for a NAMED activity; the §C guard
 *   `freeAvailable ≥ qty` IS the fold refusal; a release is guarded by the ACTIVITY's
 *   scoped fold (one activity can never release another's claim).
 *   ISSUE (§E: "an issue is NOT a delivery") — ONE command creates the §E-canonical
 *   `MaterialIssue`, consumes the activity's reserved portion FIRST through an explicit
 *   `reservation_release` row, then appends the `issue` row — so the §C guard
 *   `qty ≤ freeAvailable + reservedForThisActivity` holds exactly, and another activity's
 *   reservation is untouchable.
 *   CONSUMPTION / SITE-RETURN / WASTAGE — recorded AGAINST the referenced issue; they move
 *   `issuedToActivity` ONLY (the CHECK arms cannot name a store bucket — the §C
 *   double-count guard is structural); custody derives per issue by the same fold.
 *   TRANSFER — ONE row spans two store keys; the source-key `freeAvailable ≥ 0` refusal is
 *   the §C "reservations do not travel" guard; its reversal swaps the locations back.
 *   MISMATCH RESOLUTION (§E) — closes exactly ONE observation (never edits it); the block
 *   clears ONLY when no unresolved mismatch remains for the decision; the stored gate falls
 *   back to `wait` (never a fabricated 'ok') and status derives from the recorded work
 *   state; one `activity.material_unblocked` signal.
 *   RACE — two issues racing one pool serialize on the readiness lock (deterministic
 *   barrier): exactly one wins.
 */

describe('Phase 3 Task 5 — reservations, issues, site flows, mismatch resolution (live PG)', () => {
  let t: TestApp;
  let f: TwoProjectFixture;
  let requirements: RequirementsService;
  let vendors: VendorsService;
  let procurement: ProcurementService;
  let pos: PurchaseOrdersService;
  let inventory: InventoryService;
  let dailyLog: DailyLogService;
  let capabilities: CapabilitiesService;
  let seq = 0;

  const TRUNCATE =
    'TRUNCATE TABLE "DomainEvent", "OutboxDelivery", "ProcessedEvent", "ProjectionCursor", "ProjectionGeneration", "DecisionProjection", "DailyLogProjection", "DrawingsProjection", "InspectionsProjection", "ActivitiesProjection", "StockTransaction", "MaterialIssue", "StockLot", "MismatchResolution", "CommandExecution", "DeliveryPromise", "DeliveryCommitment", "PurchaseOrderLine", "PurchaseOrderVersion", "PurchaseOrder", "VendorQuoteLine", "QuoteComparison", "VendorQuote", "Rfq", "RequisitionLine", "Requisition", "ProjectVendor", "MaterialRequirementSpec", "ActivityRequirement", "ActivityRequirementRoot", "DecisionApprovalRevision", "ProjectCapability"';

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
    dailyLog = t.app.get(DailyLogService);
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
      ['siteMaterial', { projectId: { startsWith: 'it-p3t5-' } }],
      ['dailyLog', { projectId: { startsWith: 'it-p3t5-' } }],
      ['media', { projectId: { startsWith: 'it-p3t5-' } }],
      ['notification', { projectId: { startsWith: 'it-p3t5-' } }],
      ['activity', { projectId: { startsWith: 'it-p3t5-' } }],
      ['decision', { projectId: { startsWith: 'it-p3t5-' } }],
      ['auditLog', { projectId: { startsWith: 'it-p3t5-' } }],
      ['membership', { projectId: { startsWith: 'it-p3t5-' } }],
      ['project', { id: { startsWith: 'it-p3t5-' } }],
    ] as const) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (t.prisma as any)[model].deleteMany({ where });
    }
  });

  const freshProject = async (orgId = f.orgA.id, pilot = true): Promise<string> => {
    const id = `it-p3t5-${Date.now() % 1e6}-${seq++}`;
    await t.prisma.project.create({
      data: { id, orgId, name: id, short: 'P', descriptor: '', stage: 'x', siteCode: 'P', projStart: 'a', projEnd: 'b', elapsedPct: 0, todayDay: 0, milestonePct: 0, timeZone: 'Asia/Kolkata', scheduleStartDate: new Date('2026-06-01T00:00:00.000Z') },
    });
    await t.prisma.membership.create({ data: { projectId: id, userId: f.memberUser.id, role: 'pmc', status: 'active' } });
    if (pilot) await capabilities.enable(id, MATERIALS_CAPABILITY, f.memberUser.id);
    return id;
  };

  const freshActivity = async (projectId: string, extra: { decisionId?: string; actualStartDate?: Date } = {}): Promise<string> => {
    const id = `IT-P3T5-ACT-${Date.now() % 1e6}-${seq++}`;
    await t.prisma.activity.create({ data: { id, projectId, name: `Act ${seq}`, zone: 'Zone 1', plannedStart: 0, plannedEnd: 10, ...extra } });
    return id;
  };

  const freshMedia = async (projectId: string): Promise<string> => {
    const row = await t.prisma.media.create({
      data: { projectId, kind: 'material', mime: 'image/jpeg', uploadedBy: f.memberUser.id, sizeBytes: 3 },
    });
    return row.id;
  };

  /** The full Tasks 1–4 chain up to an ACCEPTED on-hand quantity at `storeLocation`. */
  const acceptedStock = async (projectId: string, { qty = '100', storeLocation = 'main' } = {}) => {
    const activityId = await freshActivity(projectId);
    const input: CreateRequirementInput = {
      activityId, materialCategory: 'Cement', make: 'UltraTech', grade: 'OPC 53', attributes: 'grey',
      baseUom: 'bag', qty, requiredBy: '2026-08-15', criticality: 'normal',
      decisionId: null, responsibleId: null, tolerance: null,
    };
    const req = await requirements.create(projectId, input, pmc(projectId));
    const created = await procurement.createRequisition(
      projectId, { title: `Req ${seq++}`, lines: [{ requirementId: req.requirementId, revision: req.revision, qty }] }, pmc(projectId),
    );
    await procurement.submit(projectId, created.id, pmc(projectId));
    const requisition = await procurement.approve(projectId, created.id, pmc(projectId));
    const lineId = requisition.lines[0]!.id;
    const rfq = await procurement.createRfq(projectId, { requisitionId: requisition.id }, pmc(projectId));
    const vendor = await vendors.create(f.orgA.id, { name: `Vendor ${seq++}` }, orgAdmin());
    await vendors.bind(projectId, { vendorId: vendor.id }, pmc(projectId));
    const withQuote = await procurement.recordQuote(projectId, rfq.id, {
      vendorId: vendor.id, validUntil: '2027-01-01',
      lines: [{ requisitionLineId: lineId, baseRate: '100.00', taxAmount: '50.00', freightAmount: '25.00', landedCost: '999.99', quotedMake: 'UltraTech OPC', matchesSpecification: true }],
    }, pmc(projectId));
    const quoteId = withQuote.quotes.find((q) => q.status === 'recorded')!.id;
    await procurement.createComparison(projectId, rfq.id, pmc(projectId));
    const approved = await procurement.approveComparison(projectId, rfq.id, { selectedQuoteId: quoteId, reason: 'single quote, in spec' }, pmc(projectId));
    const po = await pos.create(projectId, { comparisonId: approved.comparison!.id, lines: [{ requisitionLineId: lineId, purchaseQty: qty }] }, pmc(projectId));
    await pos.issue(projectId, po.id, {}, pmc(projectId));
    const line = await t.prisma.purchaseOrderLine.findFirstOrThrow({ where: { projectId, requisitionLineId: lineId } });
    const commitment = await pos.commitDelivery(projectId, { poLineId: line.id, promisedDate: '2026-09-01' }, pmc(projectId));
    const lot = await inventory.recordReceipt(projectId, { poLineId: line.id, commitmentId: commitment.id, purchaseQty: qty, storeLocation }, pmc(projectId));
    const evidence = await freshMedia(projectId);
    await inventory.accept(projectId, { lotId: lot.id, storeLocation, qty, qualityResult: 'passed', evidenceMediaId: evidence }, pmc(projectId));
    return { lotId: lot.id, storeLocation };
  };

  const buckets = async (projectId: string, lotId: string, storeLocation = 'main') => {
    const store = await inventory.store(projectId, pmc(projectId));
    const lot = store.lots.find((l) => l.id === lotId);
    return lot?.locations.find((loc) => loc.storeLocation === storeLocation);
  };

  /** One decision + two mismatch observations on the latest log + N linked activities. */
  const mismatchScene = async (projectId: string) => {
    const decisionId = `IT-P3T5-DL-${Date.now() % 1e6}-${seq++}`;
    await t.prisma.decision.create({ data: { id: decisionId, projectId, title: 'Bath tiles', room: 'Bath', photoSwatch: 'tile', status: 'approved' } });
    const coldActivity = await freshActivity(projectId, { decisionId });
    const startedActivity = await freshActivity(projectId, { decisionId, actualStartDate: new Date('2026-06-10T00:00:00.000Z') });
    const log = await t.prisma.dailyLog.create({ data: { projectId, date: '01 Jun 2026', logDate: new Date('2026-06-01'), submitted: false, checkedIn: true, progress: 10 } });
    const matA = await t.prisma.siteMaterial.create({ data: { projectId, dailyLogId: log.id, decisionId, name: 'Tile lot A', qty: '20 boxes', zone: 'Bath', matched: false, swatch: 'tile', order: 0 } });
    const matB = await t.prisma.siteMaterial.create({ data: { projectId, dailyLogId: log.id, decisionId, name: 'Tile lot B', qty: '10 boxes', zone: 'Bath', matched: false, swatch: 'tile', order: 1 } });
    // the flag command blocks every linked activity (edge 4) under the readiness lock
    await dailyLog.flagMismatch(projectId, { decisionId }, pmc(projectId));
    return { decisionId, coldActivity, startedActivity, matA: matA.id, matB: matB.id };
  };

  const activityState = async (id: string) =>
    t.prisma.activity.findUniqueOrThrow({ where: { id }, select: { gateMaterial: true, status: true, block: true } });

  // ── deterministic barrier race (the established Phase-3 protocol) ─────────────────────────
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

  it('§D INERTNESS: every Task-5 surface is 404 on a non-pilot project', async () => {
    const id = await freshProject(f.orgA.id, false);
    const u = pmc(id);
    await expect(inventory.reserve(id, { lotId: 'x', activityId: 'a', qty: '1' }, u)).rejects.toMatchObject({ status: 404 });
    await expect(inventory.release(id, { lotId: 'x', activityId: 'a', qty: '1' }, u)).rejects.toMatchObject({ status: 404 });
    await expect(inventory.issue(id, { lotId: 'x', activityId: 'a', qty: '1' }, u)).rejects.toMatchObject({ status: 404 });
    await expect(inventory.consume(id, { issueId: 'i', qty: '1' }, u)).rejects.toMatchObject({ status: 404 });
    await expect(inventory.siteReturn(id, { issueId: 'i', qty: '1' }, u)).rejects.toMatchObject({ status: 404 });
    await expect(inventory.wastage(id, { issueId: 'i', qty: '1', reason: 'r', evidenceMediaId: 'm' }, u)).rejects.toMatchObject({ status: 404 });
    await expect(inventory.transfer(id, { lotId: 'x', toStoreLocation: 'yard', qty: '1' }, u)).rejects.toMatchObject({ status: 404 });
    await expect(inventory.issues(id, u)).rejects.toMatchObject({ status: 404 });
    await expect(dailyLog.resolveMismatch(id, { siteMaterialId: 's', resolution: 'x', reason: 'y' }, u)).rejects.toMatchObject({ status: 404 });
    expect(await t.prisma.stockTransaction.count({ where: { projectId: id } })).toBe(0);
  });

  it('RESERVATION (§C): freeAvailable ≥ qty guards the claim; a release is guarded by the ACTIVITY\'s own scoped fold', async () => {
    const projectId = await freshProject();
    const { lotId } = await acceptedStock(projectId, { qty: '100' });
    const actA = await freshActivity(projectId);
    const actB = await freshActivity(projectId);

    // an unknown activity target is refused up front (validated through the participant)
    await expect(inventory.reserve(projectId, { lotId, activityId: 'NOPE', qty: '1' }, pmc(projectId))).rejects.toMatchObject({ status: 404 });

    await inventory.reserve(projectId, { lotId, activityId: actA, qty: '60' }, pmc(projectId));
    expect(await buckets(projectId, lotId)).toMatchObject({ acceptedOnHand: '100', reserved: '60', freeAvailable: '40' });
    // beyond the free pool → the fold refusal (freeAvailable would go negative)
    await expect(inventory.reserve(projectId, { lotId, activityId: actB, qty: '41' }, pmc(projectId))).rejects.toMatchObject({ status: 409 });

    // activity B holds nothing — it can release NOTHING of A's claim
    await expect(inventory.release(projectId, { lotId, activityId: actB, qty: '1' }, pmc(projectId))).rejects.toMatchObject({ status: 409 });
    // A cannot release more than it holds
    await expect(inventory.release(projectId, { lotId, activityId: actA, qty: '61' }, pmc(projectId))).rejects.toMatchObject({ status: 409 });
    await inventory.release(projectId, { lotId, activityId: actA, qty: '25', note: 'scope revised' }, pmc(projectId));
    expect(await buckets(projectId, lotId)).toMatchObject({ reserved: '35', freeAvailable: '65' });
  });

  it('ISSUE (§C/§E): consumes the activity\'s OWN reservation first (explicit release row); another activity\'s claim is untouchable; issue.recorded announces the §E record', async () => {
    const projectId = await freshProject();
    const { lotId } = await acceptedStock(projectId, { qty: '100' });
    const actA = await freshActivity(projectId);
    const actB = await freshActivity(projectId);
    await inventory.reserve(projectId, { lotId, activityId: actA, qty: '60' }, pmc(projectId));
    await inventory.reserve(projectId, { lotId, activityId: actB, qty: '30' }, pmc(projectId));
    // free 10; A may take up to 10 + 60 = 70; 71 refuses
    await expect(inventory.issue(projectId, { lotId, activityId: actA, qty: '71' }, pmc(projectId))).rejects.toMatchObject({ status: 409 });

    const issue = await inventory.issue(projectId, { lotId, activityId: actA, qty: '65' }, pmc(projectId));
    expect(issue.activityId).toBe(actA);
    expect(issue.qty).toBe('65');
    expect(issue.remainingCustody).toBe('65');
    // the reservation consumption is an EXPLICIT, attributable ledger row of min(reserved, qty) = 60
    const release = await t.prisma.stockTransaction.findFirstOrThrow({ where: { projectId, lotId, type: 'reservation_release' } });
    expect(release.qty.toString()).toBe('60');
    expect(release.activityId).toBe(actA);
    const issueRow = await t.prisma.stockTransaction.findFirstOrThrow({ where: { projectId, lotId, type: 'issue' } });
    expect(issueRow).toMatchObject({ fromBucket: 'acceptedOnHand', toBucket: 'issuedToActivity', activityId: actA, issueId: issue.id });
    expect(issueRow.sourceCommandId).toBe(release.sourceCommandId); // ONE command, one source action
    // buckets: 100 − 65 on hand; B's 30 reserved stands untouched; A's is fully consumed
    expect(await buckets(projectId, lotId)).toMatchObject({ acceptedOnHand: '35', reserved: '30', freeAvailable: '5', issuedToActivity: '65' });

    // B may take at most 5 + 30 = 35
    await expect(inventory.issue(projectId, { lotId, activityId: actB, qty: '36' }, pmc(projectId))).rejects.toMatchObject({ status: 409 });

    // §G: the issue announces itself + one stock.transacted per appended row
    const ev = await t.prisma.domainEvent.findFirstOrThrow({ where: { projectId, eventType: 'issue.recorded' } });
    expect(ev.payload).toEqual({ issueId: issue.id, activityId: actA, locationId: 'main', qty: '65' });
    expect(await t.prisma.domainEvent.count({ where: { projectId, eventType: 'stock.transacted' } }))
      .toBe(await t.prisma.stockTransaction.count({ where: { projectId } }));
  });

  it('CONSUMPTION / SITE-RETURN / WASTAGE (§C/§E): recorded against the issue, they move issuedToActivity ONLY — the store buckets cannot double-count', async () => {
    const projectId = await freshProject();
    const { lotId } = await acceptedStock(projectId, { qty: '100' });
    const actA = await freshActivity(projectId);
    const issue = await inventory.issue(projectId, { lotId, activityId: actA, qty: '65' }, pmc(projectId));
    const before = await buckets(projectId, lotId);

    // consumption: issuedToActivity ↓ ONLY — acceptedOnHand and reserved are UNTOUCHED (§C double-count guard)
    const afterConsume = await inventory.consume(projectId, { issueId: issue.id, qty: '20', note: 'poured footing F2' }, pmc(projectId));
    expect(afterConsume.remainingCustody).toBe('45');
    expect(await buckets(projectId, lotId)).toMatchObject({
      acceptedOnHand: before!.acceptedOnHand, reserved: before!.reserved, issuedToActivity: '45',
    });

    // site-return: back to the store
    const afterReturn = await inventory.siteReturn(projectId, { issueId: issue.id, qty: '10' }, pmc(projectId));
    expect(afterReturn.remainingCustody).toBe('35');
    expect(await buckets(projectId, lotId)).toMatchObject({ acceptedOnHand: '45', issuedToActivity: '35' });

    // wastage: reasoned + photographic evidence (both DB-required)
    const evidence = await freshMedia(projectId);
    const afterWaste = await inventory.wastage(projectId, { issueId: issue.id, qty: '5', reason: 'bags torn in handling', evidenceMediaId: evidence }, pmc(projectId));
    expect(afterWaste.remainingCustody).toBe('30');
    expect(await buckets(projectId, lotId)).toMatchObject({ acceptedOnHand: '45', issuedToActivity: '30' });

    // beyond the issue's remaining custody → refused (§E: recorded against THE issue)
    await expect(inventory.consume(projectId, { issueId: issue.id, qty: '31' }, pmc(projectId))).rejects.toMatchObject({ status: 409 });
    await expect(inventory.siteReturn(projectId, { issueId: issue.id, qty: '31' }, pmc(projectId))).rejects.toMatchObject({ status: 409 });
  });

  it('TRANSFER (§C): one row spans two store keys; reservations DO NOT travel; the reversal swaps the locations back', async () => {
    const projectId = await freshProject();
    const { lotId } = await acceptedStock(projectId, { qty: '100' });
    const actA = await freshActivity(projectId);
    await inventory.reserve(projectId, { lotId, activityId: actA, qty: '30' }, pmc(projectId));

    await expect(inventory.transfer(projectId, { lotId, toStoreLocation: 'main', qty: '1' }, pmc(projectId))).rejects.toMatchObject({ status: 400 });
    // free is 70 — moving 80 would strand the reservation (freeAvailable@main < 0)
    await expect(inventory.transfer(projectId, { lotId, toStoreLocation: 'yard', qty: '80' }, pmc(projectId))).rejects.toMatchObject({ status: 409 });

    await inventory.transfer(projectId, { lotId, toStoreLocation: 'yard', qty: '60' }, pmc(projectId));
    expect(await buckets(projectId, lotId, 'main')).toMatchObject({ acceptedOnHand: '40', reserved: '30', freeAvailable: '10' });
    expect(await buckets(projectId, lotId, 'yard')).toMatchObject({ acceptedOnHand: '60', reserved: '0', freeAvailable: '60' });
    const row = await t.prisma.stockTransaction.findFirstOrThrow({ where: { projectId, lotId, type: 'transfer' } });
    expect(row).toMatchObject({ storeLocation: 'main', toStoreLocation: 'yard', fromBucket: 'acceptedOnHand', toBucket: 'acceptedOnHand' });

    // the reversal is the location swap with buckets unchanged (trigger-verified)
    await inventory.reverse(projectId, { txId: row.id, reason: 'moved back — yard flooded' }, pmc(projectId));
    expect(await buckets(projectId, lotId, 'main')).toMatchObject({ acceptedOnHand: '100', reserved: '30' });
    expect(await buckets(projectId, lotId, 'yard')).toMatchObject({ acceptedOnHand: '0' });
    const rev = await t.prisma.stockTransaction.findFirstOrThrow({ where: { projectId, lotId, type: 'reversal' } });
    expect(rev).toMatchObject({ storeLocation: 'yard', toStoreLocation: 'main' });
  });

  it('REVERSALS of the Task-5 types re-check the SCOPED truths: consumed custody blocks an issue reversal; a consumed reservation blocks a release reversal', async () => {
    const projectId = await freshProject();
    const { lotId } = await acceptedStock(projectId, { qty: '100' });
    const actA = await freshActivity(projectId);

    // issue 50, consume 40 → custody 10; reversing the ISSUE would pull back 50 → custody −40 → refuse
    const issue = await inventory.issue(projectId, { lotId, activityId: actA, qty: '50' }, pmc(projectId));
    await inventory.consume(projectId, { issueId: issue.id, qty: '40' }, pmc(projectId));
    const issueRow = await t.prisma.stockTransaction.findFirstOrThrow({ where: { projectId, lotId, type: 'issue' } });
    await expect(inventory.reverse(projectId, { txId: issueRow.id, reason: 'not actually issued' }, pmc(projectId))).rejects.toMatchObject({ status: 409 });

    // reversing the CONSUMPTION restores custody (the row copies the activity/issue scope verbatim)
    const consumeRow = await t.prisma.stockTransaction.findFirstOrThrow({ where: { projectId, lotId, type: 'consumption' } });
    await inventory.reverse(projectId, { txId: consumeRow.id, reason: 'logged against the wrong footing' }, pmc(projectId));
    const read = (await inventory.issues(projectId, pmc(projectId))).issues.find((i) => i.id === issue.id)!;
    expect(read.remainingCustody).toBe('50');
    const rev = await t.prisma.stockTransaction.findFirstOrThrow({ where: { projectId, lotId, type: 'reversal' } });
    expect(rev).toMatchObject({ activityId: actA, issueId: issue.id, fromBucket: null, toBucket: 'issuedToActivity' });

    // release-reversal freeAvailable re-check: reserve 40 → release 40 → issue the full 50 free…
    await inventory.reserve(projectId, { lotId, activityId: actA, qty: '40' }, pmc(projectId));
    await inventory.release(projectId, { lotId, activityId: actA, qty: '40' }, pmc(projectId));
    await inventory.issue(projectId, { lotId, activityId: actA, qty: '50' }, pmc(projectId));
    // …then re-instating the released 40 would need freeAvailable −40 → refuse
    const releaseRow = await t.prisma.stockTransaction.findFirstOrThrow({ where: { projectId, lotId, type: 'reservation_release' } });
    await expect(inventory.reverse(projectId, { txId: releaseRow.id, reason: 'released by mistake' }, pmc(projectId))).rejects.toMatchObject({ status: 409 });
  });

  it('IDEMPOTENCY (§C rule ii): a keyed issue replay appends NOTHING — no second MaterialIssue, no rows, no events', async () => {
    const projectId = await freshProject();
    const { lotId } = await acceptedStock(projectId, { qty: '100' });
    const actA = await freshActivity(projectId);
    await inventory.reserve(projectId, { lotId, activityId: actA, qty: '30' }, pmc(projectId));
    const key = `it-p3t5-key-${Date.now() % 1e6}-${seq++}`;

    const first = await inventory.issue(projectId, { lotId, activityId: actA, qty: '50' }, pmc(projectId), key);
    const replay = await inventory.issue(projectId, { lotId, activityId: actA, qty: '50' }, pmc(projectId), key);
    expect(replay.id).toBe(first.id);
    expect(await t.prisma.materialIssue.count({ where: { projectId } })).toBe(1);
    // reservation(1) + release(1) + issue(1) — the replay appended nothing
    expect(await t.prisma.stockTransaction.count({ where: { projectId, lotId } })).toBe(5); // receipt, acceptance, reservation, release, issue
    expect(await t.prisma.domainEvent.count({ where: { projectId, eventType: 'issue.recorded' } })).toBe(1);
    expect(await buckets(projectId, lotId)).toMatchObject({ acceptedOnHand: '50', reserved: '0', issuedToActivity: '50' });
    // same key + different payload is the documented 409
    await expect(inventory.issue(projectId, { lotId, activityId: actA, qty: '51' }, pmc(projectId), key)).rejects.toMatchObject({ status: 409 });
  });

  it('DB SEAL: the Task-5 CHECK arms and the v2 reversal trigger make mis-shaped rows unrepresentable; both §E records are append-only', async () => {
    const projectId = await freshProject();
    const { lotId } = await acceptedStock(projectId, { qty: '100' });
    const actA = await freshActivity(projectId);
    const issue = await inventory.issue(projectId, { lotId, activityId: actA, qty: '10' }, pmc(projectId));
    const base = { projectId, lotId, storeLocation: 'main', recordedById: f.memberUser.id };

    // an issue row without its MaterialIssue reference is unrepresentable
    await expect(t.prisma.stockTransaction.create({
      data: { ...base, type: 'issue', qty: '1', fromBucket: 'acceptedOnHand', toBucket: 'issuedToActivity', activityId: actA },
    })).rejects.toThrow();
    // a consumption that names a STORE bucket is unrepresentable (the §C double-count guard)
    await expect(t.prisma.stockTransaction.create({
      data: { ...base, type: 'consumption', qty: '1', fromBucket: 'acceptedOnHand', toBucket: null, activityId: actA, issueId: issue.id },
    })).rejects.toThrow();
    // a reservation without an activity is unrepresentable
    await expect(t.prisma.stockTransaction.create({
      data: { ...base, type: 'reservation', qty: '1', fromBucket: null, toBucket: 'reserved' },
    })).rejects.toThrow();
    // wastage without reason + evidence is unrepresentable
    await expect(t.prisma.stockTransaction.create({
      data: { ...base, type: 'wastage', qty: '1', fromBucket: 'issuedToActivity', toBucket: null, activityId: actA, issueId: issue.id },
    })).rejects.toThrow();
    // a self-transfer is unrepresentable; so is an adjustment naming an activity-scoped bucket
    await expect(t.prisma.stockTransaction.create({
      data: { ...base, type: 'transfer', qty: '1', fromBucket: 'acceptedOnHand', toBucket: 'acceptedOnHand', toStoreLocation: 'main' },
    })).rejects.toThrow();
    await expect(t.prisma.stockTransaction.create({
      data: { ...base, type: 'adjustment', qty: '1', fromBucket: 'reserved', toBucket: null, reason: 'nope' },
    })).rejects.toThrow();

    // the v2 reversal trigger: dropping the activity/issue scope is NOT the inverse
    const issueRow = await t.prisma.stockTransaction.findFirstOrThrow({ where: { projectId, lotId, type: 'issue' } });
    await expect(t.prisma.stockTransaction.create({
      data: { ...base, type: 'reversal', qty: '10', fromBucket: 'issuedToActivity', toBucket: 'acceptedOnHand', reversedTxId: issueRow.id, reason: 'scope dropped' },
    })).rejects.toThrow();
    // …and a transfer reversal MUST swap the two locations
    await inventory.transfer(projectId, { lotId, toStoreLocation: 'yard', qty: '5' }, pmc(projectId));
    const transferRow = await t.prisma.stockTransaction.findFirstOrThrow({ where: { projectId, lotId, type: 'transfer' } });
    await expect(t.prisma.stockTransaction.create({
      data: { ...base, type: 'reversal', qty: '5', fromBucket: 'acceptedOnHand', toBucket: 'acceptedOnHand', reversedTxId: transferRow.id, reason: 'unswapped' },
    })).rejects.toThrow();

    // both §E records are database-immutable
    await expect(t.prisma.materialIssue.update({ where: { id: issue.id }, data: { qty: '999' } })).rejects.toThrow(/append-only/);
    await expect(t.prisma.materialIssue.delete({ where: { id: issue.id } })).rejects.toThrow(/append-only/);
  });

  it('MISMATCH RESOLUTION (§E): one observation closes at a time; the block clears ONLY when none remains; the gate falls back to WAIT and status derives from work state', async () => {
    const projectId = await freshProject();
    const { decisionId, coldActivity, startedActivity, matA, matB } = await mismatchScene(projectId);
    expect(await activityState(coldActivity)).toEqual({ gateMaterial: 'fail', status: 'blocked', block: 'Material ≠ approved' });
    expect(await activityState(startedActivity)).toEqual({ gateMaterial: 'fail', status: 'blocked', block: 'Material ≠ approved' });

    // resolving observation A: the register row exists, but B is still open → STILL blocked
    await dailyLog.resolveMismatch(projectId, { siteMaterialId: matA, resolution: 'returned-and-replaced', reason: 'wrong batch shade' }, pmc(projectId));
    expect(await activityState(coldActivity)).toMatchObject({ status: 'blocked', gateMaterial: 'fail' });
    expect(await t.prisma.domainEvent.count({ where: { projectId, eventType: 'activity.material_unblocked' } })).toBe(0);

    // the observation row is NEVER edited — matched stays false, the resolution is a separate record
    const obsA = await t.prisma.siteMaterial.findUniqueOrThrow({ where: { id: matA } });
    expect(obsA.matched).toBe(false);
    // one resolution per observation — a second is refused
    await expect(dailyLog.resolveMismatch(projectId, { siteMaterialId: matA, resolution: 'again', reason: 'again' }, pmc(projectId))).rejects.toMatchObject({ status: 409 });
    // a MATCHED observation has nothing to resolve
    const log = await t.prisma.dailyLog.findFirstOrThrow({ where: { projectId } });
    const okMat = await t.prisma.siteMaterial.create({ data: { projectId, dailyLogId: log.id, name: 'Fine tiles', qty: '5 boxes', zone: 'Bath', matched: true, swatch: 'tile', order: 2 } });
    await expect(dailyLog.resolveMismatch(projectId, { siteMaterialId: okMat.id, resolution: 'x', reason: 'y' }, pmc(projectId))).rejects.toMatchObject({ status: 400 });

    // resolving observation B — the LAST unresolved one — clears the block for BOTH activities
    await dailyLog.resolveMismatch(projectId, { siteMaterialId: matB, resolution: 'accepted-by-client', reason: 'client approved the substitute in writing' }, pmc(projectId));
    // the gate falls back to WAIT (never a fabricated ok); status derives from recorded work state
    expect(await activityState(coldActivity)).toEqual({ gateMaterial: 'wait', status: 'not_started', block: null });
    expect(await activityState(startedActivity)).toEqual({ gateMaterial: 'wait', status: 'in_progress', block: null });
    const unblocked = await t.prisma.domainEvent.findFirstOrThrow({ where: { projectId, eventType: 'activity.material_unblocked' } });
    expect(unblocked.payload).toEqual({ decisionId, unblocked: 2 });
    const resolved = await t.prisma.domainEvent.findMany({ where: { projectId, eventType: 'mismatch.resolved' }, orderBy: { streamPosition: 'asc' } });
    expect(resolved.map((e) => (e.payload as { siteMaterialId: string }).siteMaterialId)).toEqual([matA, matB]);
    expect(resolved.map((e) => (e.payload as { authority: string }).authority)).toEqual([f.memberUser.id, f.memberUser.id]);

    // both observations still say what was OBSERVED; the resolution register is immutable
    expect((await t.prisma.siteMaterial.findUniqueOrThrow({ where: { id: matB } })).matched).toBe(false);
    const reg = await t.prisma.mismatchResolution.findFirstOrThrow({ where: { projectId, siteMaterialId: matA } });
    await expect(t.prisma.mismatchResolution.update({ where: { id: reg.id }, data: { resolution: 'rewritten' } })).rejects.toThrow(/append-only/);
    await expect(t.prisma.mismatchResolution.delete({ where: { id: reg.id } })).rejects.toThrow(/append-only/);
  });

  it('§E READ: stock.issues serves the canonical issue records (lot identity joined, custody derived) — NOTHING is copied into daily-log rows', async () => {
    const projectId = await freshProject();
    const { lotId } = await acceptedStock(projectId, { qty: '100' });
    const actA = await freshActivity(projectId);
    const materialsBefore = await t.prisma.siteMaterial.count({ where: { projectId } });

    const issue = await inventory.issue(projectId, { lotId, activityId: actA, qty: '40', note: 'slab pour' }, pmc(projectId));
    await inventory.consume(projectId, { issueId: issue.id, qty: '15' }, pmc(projectId));

    const lotRow = await t.prisma.stockLot.findFirstOrThrow({ where: { projectId, id: lotId } });
    const read = await inventory.issues(projectId, pmc(projectId));
    expect(read.issues).toHaveLength(1);
    expect(read.issues[0]).toMatchObject({
      id: issue.id, lotId, storeLocation: 'main', activityId: actA, qty: '40',
      issuedById: f.memberUser.id,
      materialCategory: lotRow.materialCategory, make: lotRow.make,
      baseUom: lotRow.baseUom, specFingerprint: lotRow.specFingerprint,
      remainingCustody: '25',
    });
    // an issue is NOT a delivery: the daily-log observation table gained NOTHING
    expect(await t.prisma.siteMaterial.count({ where: { projectId } })).toBe(materialsBefore);
  });

  it('§H TENANCY: issues and lots are unreachable across projects', async () => {
    const projectId = await freshProject();
    const other = await freshProject(f.orgB.id);
    const { lotId } = await acceptedStock(projectId, { qty: '10' });
    const actA = await freshActivity(projectId);
    const issue = await inventory.issue(projectId, { lotId, activityId: actA, qty: '5' }, pmc(projectId));

    await expect(inventory.consume(other, { issueId: issue.id, qty: '1' }, pmc(other))).rejects.toMatchObject({ status: 404 });
    await expect(inventory.reserve(other, { lotId, activityId: actA, qty: '1' }, pmc(other))).rejects.toMatchObject({ status: 404 });
    expect((await inventory.issues(other, pmc(other))).issues).toEqual([]);
  });

  it('RACE (deterministic barrier): two 60-bag issues racing one 100-bag pool — exactly one wins, the pool never goes negative', async () => {
    const projectId = await freshProject();
    const { lotId } = await acceptedStock(projectId, { qty: '100' });
    const actA = await freshActivity(projectId);
    const actB = await freshActivity(projectId);
    const [a, b] = await race(
      projectId,
      () => inventory.issue(projectId, { lotId, activityId: actA, qty: '60' }, pmc(projectId)),
      () => inventory.issue(projectId, { lotId, activityId: actB, qty: '60' }, pmc(projectId)),
    );
    expect(a!.status).toBe('fulfilled');
    expect(b!.status).toBe('rejected');
    expect((b as PromiseRejectedResult).reason).toMatchObject({ status: 409 });
    expect(await t.prisma.materialIssue.count({ where: { projectId } })).toBe(1);
    expect(await buckets(projectId, lotId)).toMatchObject({ acceptedOnHand: '40', issuedToActivity: '60' });
  });
});
