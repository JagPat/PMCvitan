import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import request from 'supertest';
import { createTestApp, type TestApp } from './test-app';
import { createTwoProjectFixture, type TwoProjectFixture } from './fixtures';
import { RequirementsService } from '../../src/activities/requirements.service';
import { VendorsService } from '../../src/procurement/vendors.service';
import { ProcurementService } from '../../src/procurement/procurement.service';
import { PurchaseOrdersService } from '../../src/procurement/purchase-orders.service';
import { CapabilitiesService, MATERIALS_CAPABILITY } from '../../src/platform/capabilities.service';
import { OutboxRelay } from '../../src/platform/outbox/relay.service';
import { DECISIONS_PROJECTION } from '../../src/decisions/decisions.projection';
import { lockProjectReadiness } from '../../src/common/readiness-lock';
import type { AuthUser } from '../../src/common/auth';
import type { CreateRequirementInput } from '../../src/contracts';

/**
 * Phase 3 Task 3 — purchase orders + delivery commitments, live-PG acceptance (plan §F).
 *
 *   FROZEN SNAPSHOT — PO creation copies each line's commercial facts from the
 *   comparison-approved SELECTED quote and the pinned requirement revision;
 *   `committedAmountBase` is computed once. PostgreSQL triggers make every commercial
 *   column immutable and every version/root/promise row undeletable.
 *   AMENDMENT — the current version is retained VERBATIM (byte-compared) as 'amended';
 *   a NEW version is issued referencing it (`supersedesVersion`).
 *   §F BOUND 2 — Σ live PO-line allocations ≤ the requisition line's qty, with the
 *   requisition line FOR-UPDATE-locked: proven sequentially, under the deterministic
 *   barrier-controlled RACE, and released by cancel; 'closed_short' keeps only its
 *   received portion. A fully-covered line flips to 'ordered' (and back), and an
 *   'ordered' line still holds its §F bound-1 allocation.
 *   approvedOverage — recorded ONLY at issuance/amendment, with a reason (schema +
 *   DB CHECK).
 *   PROMISES — every delivery revision APPENDS a dated promise row; nothing is
 *   overwritten (DB append-only trigger).
 *   §G EVENTS — po.issued/amended/cancelled + delivery.committed/revised/defaulted carry
 *   the documented payloads; ordered consumers advance past them. A never-issued draft
 *   cancels silently (audit only).
 */

describe('Phase 3 Task 3 — purchase orders + deliveries (live PG)', () => {
  let t: TestApp;
  let f: TwoProjectFixture;
  let requirements: RequirementsService;
  let vendors: VendorsService;
  let procurement: ProcurementService;
  let pos: PurchaseOrdersService;
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
      ['notification', { projectId: { startsWith: 'it-p3q-' } }],
      ['activity', { projectId: { startsWith: 'it-p3q-' } }],
      ['auditLog', { projectId: { startsWith: 'it-p3q-' } }],
      ['membership', { projectId: { startsWith: 'it-p3q-' } }],
      ['project', { id: { startsWith: 'it-p3q-' } }],
    ] as const) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (t.prisma as any)[model].deleteMany({ where });
    }
  });

  const freshProject = async (orgId = f.orgA.id): Promise<string> => {
    const id = `it-p3q-${Date.now() % 1e6}-${seq++}`;
    await t.prisma.project.create({
      data: { id, orgId, name: id, short: 'P', descriptor: '', stage: 'x', siteCode: 'P', projStart: 'a', projEnd: 'b', elapsedPct: 0, todayDay: 0, milestonePct: 0, timeZone: 'Asia/Kolkata', scheduleStartDate: new Date('2026-06-01T00:00:00.000Z') },
    });
    await t.prisma.membership.create({ data: { projectId: id, userId: f.memberUser.id, role: 'pmc', status: 'active' } });
    await capabilities.enable(id, MATERIALS_CAPABILITY, f.memberUser.id);
    return id;
  };

  const freshActivity = async (projectId: string): Promise<string> => {
    const id = `IT-P3Q-ACT-${Date.now() % 1e6}-${seq++}`;
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

  /**
   * The full pipeline up to an APPROVED comparison: requirement (reqQty) → approved
   * requisition (lineQty) → RFQ → bound vendor → quote (rate/tax/freight) → comparison
   * approved. Returns everything a PO needs.
   */
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

  it('§D INERTNESS: the PO surface is 404 on a non-pilot project', async () => {
    const id = `it-p3q-off-${Date.now() % 1e6}-${seq++}`;
    await t.prisma.project.create({
      data: { id, orgId: f.orgA.id, name: id, short: 'P', descriptor: '', stage: 'x', siteCode: 'P', projStart: 'a', projEnd: 'b', elapsedPct: 0, todayDay: 0, milestonePct: 0, timeZone: 'Asia/Kolkata', scheduleStartDate: new Date('2026-06-01T00:00:00.000Z') },
    });
    await t.prisma.membership.create({ data: { projectId: id, userId: f.memberUser.id, role: 'pmc', status: 'active' } });
    await expect(pos.create(id, { comparisonId: 'c', lines: [{ requisitionLineId: 'l', purchaseQty: '1' }] }, pmc(id))).rejects.toMatchObject({ status: 404 });
    await expect(pos.listPos(id, pmc(id))).rejects.toMatchObject({ status: 404 });
    await expect(pos.commitDelivery(id, { poLineId: 'x', promisedDate: '2026-09-01' }, pmc(id))).rejects.toMatchObject({ status: 404 });
  });

  it('FROZEN SNAPSHOT: the PO line copies the SELECTED quote + revision identity and computes committedAmountBase once', async () => {
    const projectId = await freshProject();
    const chain = await approvedChain(projectId, { lineQty: '60' });
    const draft = await pos.create(projectId, { comparisonId: chain.comparisonId, lines: [{ requisitionLineId: chain.lineId, purchaseQty: '60' }] }, pmc(projectId));
    expect(draft.vendorId).toBe(chain.vendorId);
    expect(draft.requisitionId).toBe(chain.requisition.id);
    expect(draft.versions).toHaveLength(1);
    const v1 = draft.versions[0]!;
    expect(v1).toMatchObject({ version: 1, status: 'draft', supersedesVersion: null });
    const line = v1.lines[0]!;
    // the commercial snapshot came from the quote line — never the caller
    expect(line).toMatchObject({
      requisitionLineId: chain.lineId, requirementId: chain.req.requirementId, revision: chain.req.revision,
      quotedMake: 'UltraTech OPC', uom: 'bag', purchaseUom: 'bag', purchaseQty: '60', conversionToBase: '1',
      rate: '100', taxAmount: '50', freightAmount: '25', landedAmount: '999.99',
      approvedOverage: '0', overageReason: null, receivedQty: '0',
    });
    // the spec fingerprint froze from the pinned revision's material spec
    const spec = await t.prisma.materialRequirementSpec.findFirstOrThrow({
      where: { projectId, requirementId: chain.req.requirementId, revision: chain.req.revision },
    });
    expect(line.specFingerprint).toBe(spec.specFingerprint);
    // committedAmountBase = rate × purchaseQty × conversionToBase + prorated tax/freight
    // = 100×60×1 + 50 + 25 (a FULL order of the 60-qty line carries the whole amounts)
    expect(line.committedAmountBase).toBe('6075');

    // issuance: draft → issued with attribution + the po.issued event; a second issue 409s
    const issued = await pos.issue(projectId, draft.id, {}, pmc(projectId));
    expect(issued.versions[0]).toMatchObject({ status: 'issued', issuedById: f.memberUser.id });
    await expect(pos.issue(projectId, draft.id, {}, pmc(projectId))).rejects.toMatchObject({ status: 409 });
  });

  it('DB FREEZE: commercial columns, versions, the root and promises are PostgreSQL-immutable', async () => {
    const projectId = await freshProject();
    const chain = await approvedChain(projectId);
    const po = await pos.create(projectId, { comparisonId: chain.comparisonId, lines: [{ requisitionLineId: chain.lineId, purchaseQty: '10' }] }, pmc(projectId));
    await pos.issue(projectId, po.id, {}, pmc(projectId));
    const lineRow = await t.prisma.purchaseOrderLine.findFirstOrThrow({ where: { projectId } });
    // any commercial change is rejected by the frozen-snapshot trigger…
    await expect(t.prisma.purchaseOrderLine.update({ where: { id: lineRow.id }, data: { rate: '1.00' } })).rejects.toThrow(/FROZEN/);
    await expect(t.prisma.purchaseOrderLine.update({ where: { id: lineRow.id }, data: { qty: '999' } })).rejects.toThrow(/FROZEN/);
    await expect(t.prisma.purchaseOrderLine.delete({ where: { id: lineRow.id } })).rejects.toThrow(/never deleted/);
    // …while the received-progress fact stays writable (the Task-4 participant's column)
    await t.prisma.purchaseOrderLine.update({ where: { id: lineRow.id }, data: { receivedQty: '2' } });
    // versions: lifecycle-only — identity/lineage frozen, deletes rejected
    const versionRow = await t.prisma.purchaseOrderVersion.findFirstOrThrow({ where: { projectId } });
    await expect(t.prisma.purchaseOrderVersion.update({ where: { id: versionRow.id }, data: { version: 9 } })).rejects.toThrow(/frozen/);
    await expect(t.prisma.purchaseOrderVersion.delete({ where: { id: versionRow.id } })).rejects.toThrow(/never deleted/);
    // the root is fully immutable
    await expect(t.prisma.purchaseOrder.update({ where: { id: po.id }, data: { comparisonId: 'forged' } })).rejects.toThrow(/append-only/);
    await expect(t.prisma.purchaseOrder.delete({ where: { id: po.id } })).rejects.toThrow(/append-only/);
    // promises are append-only
    const commitment = await pos.commitDelivery(projectId, { poLineId: lineRow.id, promisedDate: '2026-09-01' }, pmc(projectId));
    const promise = await t.prisma.deliveryPromise.findFirstOrThrow({ where: { projectId, commitmentId: commitment.id } });
    await expect(t.prisma.deliveryPromise.update({ where: { id: promise.id }, data: { promisedDate: new Date('2026-12-01') } })).rejects.toThrow(/append-only/);
    await expect(t.prisma.deliveryPromise.delete({ where: { id: promise.id } })).rejects.toThrow(/append-only/);
    // the DB CHECK backstop for §F: a positive overage without a reason is unrepresentable
    await expect(
      t.prisma.purchaseOrderLine.update({ where: { id: lineRow.id }, data: { approvedOverage: '5' } }),
    ).rejects.toThrow();
  });

  it('AMENDMENT: the prior frozen snapshot is retained VERBATIM; the reissue references it and re-validates §F bound 2', async () => {
    const projectId = await freshProject();
    const chain = await approvedChain(projectId); // requisition line qty 100
    const po = await pos.create(projectId, { comparisonId: chain.comparisonId, lines: [{ requisitionLineId: chain.lineId, purchaseQty: '60' }] }, pmc(projectId));
    await pos.issue(projectId, po.id, {}, pmc(projectId));
    const before = await t.prisma.purchaseOrderLine.findFirstOrThrow({ where: { projectId } });

    // a SECOND PO takes 40 of the same line — the ceiling is now fully allocated
    const po2 = await pos.create(projectId, { comparisonId: chain.comparisonId, lines: [{ requisitionLineId: chain.lineId, purchaseQty: '40' }] }, pmc(projectId));
    void po2;
    // amending the first PO to 80 would need 80+40=120 > 100 — §F bound 2 refuses IN the amend
    await expect(
      pos.amend(projectId, po.id, { reason: 'quantity correction', lines: [{ requisitionLineId: chain.lineId, purchaseQty: '80' }] }, pmc(projectId)),
    ).rejects.toMatchObject({ status: 409 });
    // amend to 55 fits (55+40 ≤ 100): prior version → 'amended', new version ISSUED referencing it
    const amended = await pos.amend(projectId, po.id, { reason: 'short supply', lines: [{ requisitionLineId: chain.lineId, purchaseQty: '55' }] }, pmc(projectId));
    expect(amended.versions).toHaveLength(2);
    expect(amended.versions[0]).toMatchObject({ version: 1, status: 'amended', amendReason: 'short supply' });
    expect(amended.versions[1]).toMatchObject({ version: 2, status: 'issued', supersedesVersion: 1 });
    expect(amended.versions[1]!.lines[0]!.qty).toBe('55');
    // the amended version's line row is byte-for-byte what it was before the amendment
    const after = await t.prisma.purchaseOrderLine.findFirstOrThrow({ where: { id: before.id } });
    expect(JSON.stringify(after)).toBe(JSON.stringify(before));
    // only ISSUED versions amend — the amended v1 cannot amend again (the current version is v2)
    const again = await pos.amend(projectId, po.id, { reason: 'again', lines: [{ requisitionLineId: chain.lineId, purchaseQty: '50' }] }, pmc(projectId));
    expect(again.versions).toHaveLength(3); // v2 (issued) amended into v3 — the machine walks the CURRENT version
  });

  it('§F BOUND 2 (sequential): fills to the line ceiling, overflow refuses, cancel frees, ordered↔open flips, bound 1 keeps holding', async () => {
    const projectId = await freshProject();
    // requirement 100; requisition line 100 (fully allocated under bound 1)
    const chain = await approvedChain(projectId);
    const a = await pos.create(projectId, { comparisonId: chain.comparisonId, lines: [{ requisitionLineId: chain.lineId, purchaseQty: '60' }] }, pmc(projectId));
    await pos.create(projectId, { comparisonId: chain.comparisonId, lines: [{ requisitionLineId: chain.lineId, purchaseQty: '40' }] }, pmc(projectId));
    await expect(
      pos.create(projectId, { comparisonId: chain.comparisonId, lines: [{ requisitionLineId: chain.lineId, purchaseQty: '1' }] }, pmc(projectId)),
    ).rejects.toMatchObject({ status: 409 });
    // fully covered → the requisition line flipped to 'ordered'
    const ordered = await t.prisma.requisitionLine.findFirstOrThrow({ where: { projectId, id: chain.lineId } });
    expect(ordered.status).toBe('ordered');
    // …and an ORDERED line still holds its §F bound-1 allocation on the requirement
    await expect(
      procurement.createRequisition(projectId, { title: 'over the requirement', lines: [{ requirementId: chain.req.requirementId, revision: chain.req.revision, qty: '1' }] }, pmc(projectId)),
    ).rejects.toMatchObject({ status: 409 });
    // …and the requirement cancel still demands disposition for an ordered line
    await expect(
      requirements.cancel(projectId, chain.req.requirementId, { expectedRevision: chain.req.revision, reason: 'cut' }, pmc(projectId)),
    ).rejects.toMatchObject({ status: 409 });
    // cancelling the 60 draft frees the ceiling and the line reverts to 'open'
    await pos.cancel(projectId, a.id, { reason: 'not needed' }, pmc(projectId));
    const reopened = await t.prisma.requisitionLine.findFirstOrThrow({ where: { projectId, id: chain.lineId } });
    expect(reopened.status).toBe('open');
    const c = await pos.create(projectId, { comparisonId: chain.comparisonId, lines: [{ requisitionLineId: chain.lineId, purchaseQty: '50' }] }, pmc(projectId));
    void c;
    await expect(
      pos.create(projectId, { comparisonId: chain.comparisonId, lines: [{ requisitionLineId: chain.lineId, purchaseQty: '11' }] }, pmc(projectId)),
    ).rejects.toMatchObject({ status: 409 });
    // refill exactly (50 + 40 + 10 = 100) — the line flips back to 'ordered' and the
    // approved requisition, with NO open line left, CAN close (§F: all ordered or cancelled)
    await pos.create(projectId, { comparisonId: chain.comparisonId, lines: [{ requisitionLineId: chain.lineId, purchaseQty: '10' }] }, pmc(projectId));
    expect((await t.prisma.requisitionLine.findFirstOrThrow({ where: { projectId, id: chain.lineId } })).status).toBe('ordered');
    const closed = await procurement.close(projectId, chain.requisition.id, pmc(projectId));
    expect(closed.status).toBe('closed');
  });

  // The deterministic RACE barrier (Task-1 round-3 pattern): both allocating commands take
  // lockProjectReadiness first, so the test holds that advisory lock, parks both commands in
  // its wait queue (verified via pg_stat_activity), and releases — grant order = enqueue order.
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

  it('§F BOUND 2 (RACE): two POs racing one requisition line cannot exceed its qty', async () => {
    const projectId = await freshProject();
    const chain = await approvedChain(projectId); // requisition line qty 100

    let release!: () => void;
    let acquired!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const held = new Promise<void>((r) => (acquired = r));
    const holder = t.prisma.$transaction(
      async (tx) => { await lockProjectReadiness(tx, projectId); acquired(); await gate; },
      { timeout: 20_000, maxWait: 10_000 },
    );
    await held;
    const raceA = pos.create(projectId, { comparisonId: chain.comparisonId, lines: [{ requisitionLineId: chain.lineId, purchaseQty: '60' }] }, pmc(projectId));
    await waitForReadinessWaiters(1);
    const raceB = pos.create(projectId, { comparisonId: chain.comparisonId, lines: [{ requisitionLineId: chain.lineId, purchaseQty: '60' }] }, pmc(projectId));
    await waitForReadinessWaiters(2);
    release();
    await holder;

    const [ra, rb] = await Promise.allSettled([raceA, raceB]);
    expect(ra.status).toBe('fulfilled'); // enqueued first → granted first → fits (60 ≤ 100)
    expect(rb.status).toBe('rejected'); // 60 + 60 > 100 — the §F bound holds under the race
    expect((rb as PromiseRejectedResult).reason).toMatchObject({ status: 409 });
    const lines = await t.prisma.purchaseOrderLine.findMany({ where: { projectId, requisitionLineId: chain.lineId } });
    expect(lines.reduce((s, l) => s + Number(l.qty), 0)).toBe(60);
  });

  it('approvedOverage: recorded ONLY at issuance/amendment, with a reason', async () => {
    const projectId = await freshProject();
    const chain = await approvedChain(projectId);
    const po = await pos.create(projectId, { comparisonId: chain.comparisonId, lines: [{ requisitionLineId: chain.lineId, purchaseQty: '50' }] }, pmc(projectId));
    // creation NEVER carries overage (no schema field); issuance records it with its reason
    const issued = await pos.issue(projectId, po.id, {
      overages: [{ requisitionLineId: chain.lineId, approvedOverage: '2.5', reason: 'vendor supplies 50kg bags — rounding headroom' }],
    }, pmc(projectId));
    expect(issued.versions[0]!.lines[0]).toMatchObject({ approvedOverage: '2.5', overageReason: 'vendor supplies 50kg bags — rounding headroom' });
    // an overage naming a line the version does not order refuses
    const other = await approvedChain(projectId);
    const po2 = await pos.create(projectId, { comparisonId: other.comparisonId, lines: [{ requisitionLineId: other.lineId, purchaseQty: '10' }] }, pmc(projectId));
    await expect(
      pos.issue(projectId, po2.id, { overages: [{ requisitionLineId: chain.lineId, approvedOverage: '1', reason: 'wrong line' }] }, pmc(projectId)),
    ).rejects.toMatchObject({ status: 400 });
    // after issuance the command surface is CLOSED: issue cannot run again (409), so the
    // only overage path left is an AMENDMENT (which re-records it on the new version)
    await expect(pos.issue(projectId, po.id, { overages: [{ requisitionLineId: chain.lineId, approvedOverage: '9', reason: 'late' }] }, pmc(projectId))).rejects.toMatchObject({ status: 409 });
    const amended = await pos.amend(projectId, po.id, {
      reason: 'renegotiated pack size',
      lines: [{ requisitionLineId: chain.lineId, purchaseQty: '50' }],
      overages: [{ requisitionLineId: chain.lineId, approvedOverage: '5', reason: 'pack-size overage re-approved' }],
    }, pmc(projectId));
    expect(amended.versions[1]!.lines[0]).toMatchObject({ approvedOverage: '5', overageReason: 'pack-size overage re-approved' });
  });

  it('CANCEL vs CLOSE-SHORT: receipts force close-short; close-short releases the un-received remainder', async () => {
    const projectId = await freshProject();
    const chain = await approvedChain(projectId);
    const po = await pos.create(projectId, { comparisonId: chain.comparisonId, lines: [{ requisitionLineId: chain.lineId, purchaseQty: '60' }] }, pmc(projectId));
    await pos.issue(projectId, po.id, {}, pmc(projectId));
    // simulate the Task-4 received-progress fact (the ONE mutable line column)
    const lineRow = await t.prisma.purchaseOrderLine.findFirstOrThrow({ where: { projectId } });
    await t.prisma.purchaseOrderLine.update({ where: { id: lineRow.id }, data: { receivedQty: '5' } });
    // with accepted receipts, cancel REFUSES and points at close-short (§F)
    await expect(pos.cancel(projectId, po.id, { reason: 'changed mind' }, pmc(projectId))).rejects.toMatchObject({ status: 409 });
    const closed = await pos.closeShort(projectId, po.id, { reason: 'vendor cannot deliver the balance' }, pmc(projectId));
    expect(closed.versions[0]).toMatchObject({ status: 'closed_short', closeShortReason: 'vendor cannot deliver the balance' });
    // closed_short keeps ONLY its received 5 — 95 of the 100-qty line is free again
    await pos.create(projectId, { comparisonId: chain.comparisonId, lines: [{ requisitionLineId: chain.lineId, purchaseQty: '95' }] }, pmc(projectId));
    await expect(
      pos.create(projectId, { comparisonId: chain.comparisonId, lines: [{ requisitionLineId: chain.lineId, purchaseQty: '1' }] }, pmc(projectId)),
    ).rejects.toMatchObject({ status: 409 });
  });

  it('PROMISES: every revision APPENDS a dated promise; the §G delivery events carry the history tail', async () => {
    const projectId = await freshProject();
    const chain = await approvedChain(projectId);
    const po = await pos.create(projectId, { comparisonId: chain.comparisonId, lines: [{ requisitionLineId: chain.lineId, purchaseQty: '20' }] }, pmc(projectId));
    // deliveries commit only against an ISSUED version's line
    const draftLine = await t.prisma.purchaseOrderLine.findFirstOrThrow({ where: { projectId } });
    await expect(pos.commitDelivery(projectId, { poLineId: draftLine.id, promisedDate: '2026-09-01' }, pmc(projectId))).rejects.toMatchObject({ status: 409 });
    await pos.issue(projectId, po.id, {}, pmc(projectId));
    const commitment = await pos.commitDelivery(projectId, { poLineId: draftLine.id, promisedDate: '2026-09-01' }, pmc(projectId));
    expect(commitment).toMatchObject({ status: 'committed' });
    expect(commitment.promises).toEqual([expect.objectContaining({ seq: 1, promisedDate: '2026-09-01', reason: null })]);
    const r1 = await pos.reviseDelivery(projectId, commitment.id, { promisedDate: '2026-09-10', reason: 'transport strike' }, pmc(projectId));
    const r2 = await pos.reviseDelivery(projectId, commitment.id, { promisedDate: '2026-09-15', reason: 'factory backlog' }, pmc(projectId));
    void r1;
    expect(r2.status).toBe('revised');
    expect(r2.promises.map((p) => [p.seq, p.promisedDate, p.reason])).toEqual([
      [1, '2026-09-01', null],
      [2, '2026-09-10', 'transport strike'],
      [3, '2026-09-15', 'factory backlog'],
    ]);
    // default: terminal + event; a further revision refuses
    const defaulted = await pos.defaultDelivery(projectId, commitment.id, pmc(projectId));
    expect(defaulted.status).toBe('defaulted');
    await expect(pos.reviseDelivery(projectId, commitment.id, { promisedDate: '2026-10-01', reason: 'too late' }, pmc(projectId))).rejects.toMatchObject({ status: 409 });
    // F6 correction: a SECOND commitment on the same line refuses — one commitment per PO
    // line; a fulfilment probe runs on a fresh PO's line instead
    await expect(pos.commitDelivery(projectId, { poLineId: draftLine.id, promisedDate: '2026-09-20' }, pmc(projectId))).rejects.toMatchObject({ status: 409 });
    const chain2 = await approvedChain(projectId);
    const po2 = await pos.create(projectId, { comparisonId: chain2.comparisonId, lines: [{ requisitionLineId: chain2.lineId, purchaseQty: '5' }] }, pmc(projectId));
    await pos.issue(projectId, po2.id, {}, pmc(projectId));
    const line2 = await t.prisma.purchaseOrderLine.findFirstOrThrow({ where: { projectId, requisitionLineId: chain2.lineId } });
    const c2 = await pos.commitDelivery(projectId, { poLineId: line2.id, promisedDate: '2026-09-20' }, pmc(projectId));
    const fulfilled = await pos.fulfillDelivery(projectId, c2.id, pmc(projectId));
    expect(fulfilled.status).toBe('fulfilled');

    const evs = await t.prisma.domainEvent.findMany({
      where: { projectId, eventType: { startsWith: 'delivery.' } },
      orderBy: { streamPosition: 'asc' },
    });
    expect(evs.map((e) => e.eventType)).toEqual([
      'delivery.committed', 'delivery.revised', 'delivery.revised', 'delivery.defaulted', 'delivery.committed',
    ]);
    const lastRevised = evs[2]!.payload as { commitmentId: string; poLineId: string; promisedDate: string; history: unknown[] };
    expect(lastRevised).toMatchObject({ commitmentId: commitment.id, poLineId: draftLine.id, promisedDate: '2026-09-15' });
    expect(lastRevised.history).toHaveLength(3);
  });

  it('§G EVENTS: po.issued/amended/cancelled carry the frozen refs; a never-issued draft cancels silently; consumers advance', async () => {
    const projectId = await freshProject();
    const chain = await approvedChain(projectId);
    // a never-issued draft cancels with NO event (§G announces only what the world saw)
    const draft = await pos.create(projectId, { comparisonId: chain.comparisonId, lines: [{ requisitionLineId: chain.lineId, purchaseQty: '10' }] }, pmc(projectId));
    await pos.cancel(projectId, draft.id, { reason: 'never issued' }, pmc(projectId));
    expect(await t.prisma.domainEvent.count({ where: { projectId, eventType: 'po.cancelled' } })).toBe(0);

    const po = await pos.create(projectId, { comparisonId: chain.comparisonId, lines: [{ requisitionLineId: chain.lineId, purchaseQty: '30' }] }, pmc(projectId));
    await pos.issue(projectId, po.id, {}, pmc(projectId));
    await pos.amend(projectId, po.id, { reason: 'rate hold expired', lines: [{ requisitionLineId: chain.lineId, purchaseQty: '25' }] }, pmc(projectId));
    await pos.cancel(projectId, po.id, { reason: 'project descoped' }, pmc(projectId));

    const evs = await t.prisma.domainEvent.findMany({
      where: { projectId, eventType: { startsWith: 'po.' } },
      orderBy: { streamPosition: 'asc' },
    });
    expect(evs.map((e) => e.eventType)).toEqual(['po.issued', 'po.amended', 'po.cancelled']);
    const issuedPayload = evs[0]!.payload as { poId: string; version: number; lines: Array<Record<string, unknown>> };
    expect(issuedPayload.poId).toBe(po.id);
    expect(issuedPayload.version).toBe(1);
    // 30 of the 100-qty line: committed = 100×30 + tax 50×0.3 + freight 25×0.3 = 3022.5
    expect(issuedPayload.lines[0]).toMatchObject({
      requisitionLineId: chain.lineId, requirementId: chain.req.requirementId, revision: chain.req.revision,
      qty: '30', committedAmountBase: '3022.5',
    });
    const amendedPayload = evs[1]!.payload as { version: number; lines: Array<Record<string, unknown>> };
    expect(amendedPayload.version).toBe(2);
    expect(amendedPayload.lines[0]).toMatchObject({ qty: '25' });

    // ordered consumers no-op PAST the po events (nothing stalls, nothing corrupts)
    const ds = await t.prisma.outboxDelivery.findMany({ where: { consumer: DECISIONS_PROJECTION, projectId }, orderBy: { streamPosition: 'asc' } });
    for (const d of ds) expect(await relay.dispatchOne(d.id)).toBe('succeeded');
    const gen = await t.prisma.projectionGeneration.findFirst({ where: { consumer: DECISIONS_PROJECTION, projectId, status: 'active' } });
    expect(gen?.appliedPosition).toBe(evs[2]!.streamPosition);
  });

  it('IDEMPOTENCY: keyed replays of create and issue append nothing', async () => {
    const projectId = await freshProject();
    const chain = await approvedChain(projectId);
    const key = `it-p3q-key-${Date.now() % 1e6}`;
    const first = await pos.create(projectId, { comparisonId: chain.comparisonId, lines: [{ requisitionLineId: chain.lineId, purchaseQty: '10' }] }, pmc(projectId), key);
    const replay = await pos.create(projectId, { comparisonId: chain.comparisonId, lines: [{ requisitionLineId: chain.lineId, purchaseQty: '10' }] }, pmc(projectId), key);
    expect(replay.id).toBe(first.id);
    expect(await t.prisma.purchaseOrder.count({ where: { projectId } })).toBe(1);
    const issueKey = `${key}-issue`;
    await pos.issue(projectId, first.id, {}, pmc(projectId), issueKey);
    await pos.issue(projectId, first.id, {}, pmc(projectId), issueKey); // replay, not a 409
    expect(await t.prisma.domainEvent.count({ where: { projectId, eventType: 'po.issued' } })).toBe(1);
  });

  it('ISOLATION + AUTHZ: cross-project refs refuse; engineer cannot issue POs (pmc-only §H row) over HTTP', async () => {
    const p1 = await freshProject();
    const p2 = await freshProject();
    const chain2 = await approvedChain(p2);
    // a PO in p1 cannot execute p2's comparison, nor commit deliveries on p2's lines
    await expect(
      pos.create(p1, { comparisonId: chain2.comparisonId, lines: [{ requisitionLineId: chain2.lineId, purchaseQty: '1' }] }, pmc(p1)),
    ).rejects.toMatchObject({ status: 400 });
    const foreignLine = await t.prisma.purchaseOrderLine.findFirst({ where: { projectId: p2 } });
    void foreignLine; // (no PO exists yet in p2 — the delivery probe uses a bogus id)
    await expect(pos.commitDelivery(p1, { poLineId: 'nonexistent', promisedDate: '2026-09-01' }, pmc(p1))).rejects.toMatchObject({ status: 404 });
    // §H matrix: engineer reads the pipeline but cannot issue POs (procurement.manage = pmc)
    await t.prisma.membership.create({ data: { projectId: p1, userId: f.strangerUser.id, role: 'engineer', status: 'active' } });
    const engToken = t.issueProjectToken(f.strangerUser.id, p1, 'engineer');
    const refused = await request(t.app.getHttpServer())
      .post(`/projects/${p1}/pos`)
      .set('Authorization', `Bearer ${engToken}`)
      .send({ comparisonId: 'c', lines: [{ requisitionLineId: 'l', purchaseQty: '1' }] });
    expect(refused.status).toBe(403);
    const reads = await request(t.app.getHttpServer())
      .get(`/projects/${p1}/pos`)
      .set('Authorization', `Bearer ${engToken}`);
    expect(reads.status).toBe(200);
  });
});
