import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { createTestApp, type TestApp } from './test-app';
import { createTwoProjectFixture, type TwoProjectFixture } from './fixtures';
import { RequirementsService } from '../../src/activities/requirements.service';
import { LabourService } from '../../src/labour/labour.service';
import { LabourProcurementService } from '../../src/labour/labour-procurement.service';
import { VendorsService } from '../../src/procurement/vendors.service';
import { CapabilitiesService, LABOUR_CAPABILITY } from '../../src/platform/capabilities.service';
import { lockProjectReadiness } from '../../src/common/readiness-lock';
import type { AuthUser } from '../../src/common/auth';

/**
 * Phase 4 Task 2 — the LABOUR COMMERCIAL chain (plan §F), proven live against PostgreSQL,
 * reproduce-first. The labour supplier IS the reused procurement `Vendor`/`ProjectVendor` (F7);
 * Phase 4 adds only `VendorLabourProfile` + separate labour commercial documents whose lines carry
 * the SAME explicit `(civilDate, shift, personShiftQty)` demand slices as the requirement.
 *
 * §F — VendorLabourProfile (org-admin); the requisition→RFQ→quote→comparison→PO(+version)→
 *   CapacityCommitment(+append-only promise) chain; CAS machines (deterministic 409); §F bound 1
 *   (requirement→requisition ≤ the slice's personShiftQty) — per slice AND proven under a barrier
 *   race; §F bound 2 (requisition→PO ≤ remaining per slice); frozen rate snapshots + append-only
 *   commercial evidence; complete-coverage + lowest-landed comparison; one commitment per PO line;
 *   the §F disposition guard; the labour event family; idempotency; capability-off inertness.
 */
describe('Phase 4 Task 2 — labour commercial chain (live PG)', () => {
  let t: TestApp;
  let f: TwoProjectFixture;
  let requirements: RequirementsService;
  let labour: LabourService;
  let commercial: LabourProcurementService;
  let vendors: VendorsService;
  let capabilities: CapabilitiesService;
  let seq = 0;

  const TRUNCATE =
    'TRUNCATE TABLE "DomainEvent", "OutboxDelivery", "ProcessedEvent", "ProjectionCursor", "ProjectionGeneration", "DecisionProjection", "DailyLogProjection", "DrawingsProjection", "InspectionsProjection", "ActivitiesProjection", "MaterialReadinessProjection", "LabourReadinessProjection", "CapacityPromise", "CapacityCommitment", "LabourPurchaseOrderLine", "LabourPurchaseOrderVersion", "LabourPurchaseOrder", "SupplierLabourQuoteLine", "SupplierLabourQuote", "LabourQuoteComparison", "LabourRfq", "LabourRequisitionLine", "LabourRequisition", "VendorLabourProfile", "ProjectVendor", "CommandExecution", "CrewMembership", "Crew", "WorkerDevice", "WorkerSkill", "Worker", "LabourDemandSlice", "LabourRequirementSpec", "LabourTrade", "LabourSkill", "MaterialRequirementSpec", "ActivityRequirement", "ActivityRequirementRoot", "DecisionApprovalRevision", "ProjectCapability" CASCADE';

  const pmc = (projectId: string): AuthUser => ({ sub: f.memberUser.id, role: 'pmc', projectId }) as AuthUser;
  const orgAdmin = (): AuthUser => ({ sub: f.ownerUser.id, role: 'pmc', projectId: '' }) as AuthUser;

  beforeAll(async () => {
    t = await createTestApp();
    f = await createTwoProjectFixture(t.prisma);
    requirements = t.app.get(RequirementsService);
    labour = t.app.get(LabourService);
    commercial = t.app.get(LabourProcurementService);
    vendors = t.app.get(VendorsService);
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
      ['auditLog', { projectId: { startsWith: 'it-p4l-' } }],
      ['activity', { projectId: { startsWith: 'it-p4l-' } }],
      ['membership', { projectId: { startsWith: 'it-p4l-' } }],
      ['project', { id: { startsWith: 'it-p4l-' } }],
    ] as const) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (t.prisma as any)[model].deleteMany({ where });
    }
  });

  // ── fixtures ──────────────────────────────────────────────────────────────────────────────────

  const freshProject = async (): Promise<string> => {
    const id = `it-p4l-${Date.now() % 1e6}-${seq++}`;
    await t.prisma.project.create({
      data: { id, orgId: f.orgA.id, name: id, short: 'P', descriptor: '', stage: 'x', siteCode: 'P', projStart: 'a', projEnd: 'b', elapsedPct: 0, todayDay: 0, milestonePct: 0, timeZone: 'Asia/Kolkata', scheduleStartDate: new Date('2026-06-01T00:00:00.000Z') },
    });
    await t.prisma.membership.create({ data: { projectId: id, userId: f.memberUser.id, role: 'pmc', status: 'active' } });
    return id;
  };
  const freshActivity = async (projectId: string): Promise<string> => {
    const id = `IT-P4L-ACT-${Date.now() % 1e6}-${seq++}`;
    await t.prisma.activity.create({ data: { id, projectId, name: `Act ${seq}`, zone: 'Zone 1', plannedStart: 0, plannedEnd: 10 } });
    return id;
  };
  const enableLabour = async (projectId: string): Promise<void> => {
    await capabilities.enable(projectId, LABOUR_CAPABILITY, f.memberUser.id);
    await labour.upsertTrade(projectId, { code: 'mason', name: 'Mason' }, pmc(projectId));
    await labour.upsertSkill(projectId, { code: 'bar-bending', name: 'Bar Bending' }, pmc(projectId));
  };
  // a single-slice labour requirement of `qty` person-shifts on `civilDate`
  const labourRequirement = async (projectId: string, activityId: string, civilDate: string, qty: number): Promise<{ requirementId: string; revision: number }> => {
    const r = await requirements.create(
      projectId,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { type: 'labour', activityId, tradeCode: 'mason', skillCode: 'bar-bending', shift: 'day', demandSlices: [{ civilDate, personShiftQty: qty }], decisionId: null, responsibleId: null, criticality: 'normal', tolerance: null } as any,
      pmc(projectId),
    );
    return { requirementId: r.requirementId, revision: r.revision };
  };
  const boundVendor = async (projectId: string, name = `Vendor ${seq++}`): Promise<string> => {
    const v = await vendors.create(f.orgA.id, { name }, orgAdmin());
    await vendors.bind(projectId, { vendorId: v.id }, pmc(projectId));
    return v.id;
  };

  // an approved labour requisition (one line for the whole slice) ready for RFQ
  const approvedRequisition = async (projectId: string, req: { requirementId: string; revision: number }, civilDate: string, qty: number) => {
    const created = await commercial.createRequisition(projectId, { title: `req ${seq++}`, lines: [{ requirementId: req.requirementId, revision: req.revision, civilDate, personShiftQty: qty }] }, pmc(projectId));
    await commercial.submitRequisition(projectId, created.id, pmc(projectId));
    await commercial.approveRequisition(projectId, created.id, pmc(projectId));
    return created;
  };
  // an approved comparison (single vendor, in-spec) with its selected quote
  const approvedComparison = async (projectId: string, requisitionId: string, lineId: string, vendorId: string, rate = '1000', premium = '0', landed = '1000') => {
    const rfq = await commercial.createRfq(projectId, { requisitionId }, pmc(projectId));
    await commercial.recordQuote(projectId, rfq.id, { vendorId, validUntil: '2026-12-31', lines: [{ requisitionLineId: lineId, ratePerPersonShift: rate, shiftPremium: premium, landedPerPersonShift: landed, matchesSpecification: true }] }, pmc(projectId));
    await commercial.createComparison(projectId, rfq.id, pmc(projectId));
    const full = await commercial.readRfq(projectId, rfq.id, pmc(projectId));
    const quoteId = full.quotes[0]!.id;
    await commercial.approveComparison(projectId, rfq.id, { selectedQuoteId: quoteId, reason: 'single in-spec quote' }, pmc(projectId));
    const comparison = (await commercial.readRfq(projectId, rfq.id, pmc(projectId))).comparison!;
    return { rfqId: rfq.id, comparisonId: comparison.id };
  };

  // ── §F VendorLabourProfile (org-admin) ─────────────────────────────────────────────────────────

  it('§F VendorLabourProfile: org-admin sets it (idempotent upsert); a project role cannot', async () => {
    const projectId = await freshProject();
    await enableLabour(projectId);
    const vendorId = await boundVendor(projectId, 'Labour supplier');
    const p1 = await commercial.setVendorProfile(f.orgA.id, { vendorId, trades: ['mason'], skills: ['bar-bending'] }, orgAdmin());
    expect(p1).toMatchObject({ vendorId, vendorName: 'Labour supplier', trades: ['mason'], skills: ['bar-bending'] });
    // idempotent upsert (one row per (org, vendor))
    const p2 = await commercial.setVendorProfile(f.orgA.id, { vendorId, trades: ['mason', 'carpenter'], skills: [] }, orgAdmin());
    expect(p2.trades).toEqual(['mason', 'carpenter']);
    expect(await t.prisma.vendorLabourProfile.count({ where: { orgId: f.orgA.id, vendorId } })).toBe(1);
    // a mere project pmc (not org owner/admin) is refused
    await expect(commercial.setVendorProfile(f.orgA.id, { vendorId, trades: [], skills: [] }, pmc(projectId))).rejects.toMatchObject({ status: 403 });
    expect((await commercial.listVendorProfiles(f.orgA.id, orgAdmin())).profiles).toHaveLength(1);
  });

  // ── §F requisition chain + events + CAS ─────────────────────────────────────────────────────────

  it('§F CHAIN: requisition → submit → approve → RFQ → quote → comparison → PO → issue → commitment (events + states)', async () => {
    const projectId = await freshProject();
    await enableLabour(projectId);
    const act = await freshActivity(projectId);
    const req = await labourRequirement(projectId, act, '2026-08-10', 10);
    const vendorId = await boundVendor(projectId);

    const requisition = await commercial.createRequisition(projectId, { title: 'crew for pour', lines: [{ requirementId: req.requirementId, revision: req.revision, civilDate: '2026-08-10', personShiftQty: 10 }] }, pmc(projectId));
    expect(requisition.status).toBe('draft');
    const line = requisition.lines[0]!;
    // the line's shift + fingerprint are DERIVED from the labour spec (never caller-authored)
    expect(line.shift).toBe('day');
    expect(line.personShiftQty).toBe(10);
    expect(line.labourSpecFingerprint).toMatch(/^[a-f0-9]{64}$/);

    await commercial.submitRequisition(projectId, requisition.id, pmc(projectId));
    await commercial.approveRequisition(projectId, requisition.id, pmc(projectId));
    // the requisition lifecycle emits submitted + approved (signal-only)
    const reqEvents = await t.prisma.domainEvent.findMany({ where: { projectId, eventType: { startsWith: 'labour.requisition.' } }, orderBy: { streamPosition: 'asc' } });
    expect(reqEvents.map((e) => e.eventType)).toEqual(['labour.requisition.submitted', 'labour.requisition.approved']);

    const { comparisonId } = await approvedComparison(projectId, requisition.id, line.id, vendorId, '1200', '100', '1300');
    const compEvents = await t.prisma.domainEvent.count({ where: { projectId, eventType: 'labour.comparison.approved' } });
    expect(compEvents).toBe(1);

    // PO freezes the rate snapshot: committedAmountBase = round((rate + premium) × qty, 2)
    const po = await commercial.createPo(projectId, { comparisonId, lines: [{ requisitionLineId: line.id, personShiftQty: 10 }] }, pmc(projectId));
    const poLine = po.currentVersion.lines[0]!;
    expect(poLine.ratePerPersonShift).toBe('1200');
    expect(poLine.shiftPremium).toBe('100');
    expect(poLine.committedAmountBase).toBe('13000'); // (1200 + 100) × 10
    expect(poLine.civilDate).toBe('2026-08-10');
    expect(po.currentVersion.status).toBe('draft');
    // ordering the line flips the requisition line 'open' → 'ordered'
    expect((await commercial.listRequisitions(projectId, pmc(projectId))).requisitions[0]!.lines[0]!.status).toBe('ordered');

    const issued = await commercial.issuePo(projectId, po.id, {}, pmc(projectId));
    expect(issued.currentVersion.status).toBe('issued');
    expect(await t.prisma.domainEvent.count({ where: { projectId, eventType: 'labour.po.issued' } })).toBe(1);

    // one CapacityCommitment per PO line — its slice is COPIED from the line
    const commitment = await commercial.commitCapacity(projectId, { poLineId: poLine.id, promisedDate: '2026-08-09' }, pmc(projectId));
    expect(commitment).toMatchObject({ poLineId: poLine.id, civilDate: '2026-08-10', shift: 'day', personShiftQty: 10, status: 'committed' });
    expect(commitment.latestPromise).toMatchObject({ seq: 1, promisedDate: '2026-08-09' });
    expect(await t.prisma.domainEvent.count({ where: { projectId, eventType: 'capacity.committed' } })).toBe(1);
    // a second commitment on the same PO line is refused (one per line)
    await expect(commercial.commitCapacity(projectId, { poLineId: poLine.id, promisedDate: '2026-08-08' }, pmc(projectId))).rejects.toMatchObject({ status: 409 });
  });

  it('§F CAS: only a draft submits, only a submitted approves — the loser gets a deterministic 409', async () => {
    const projectId = await freshProject();
    await enableLabour(projectId);
    const act = await freshActivity(projectId);
    const req = await labourRequirement(projectId, act, '2026-08-10', 5);
    const requisition = await commercial.createRequisition(projectId, { title: 'cas', lines: [{ requirementId: req.requirementId, revision: req.revision, civilDate: '2026-08-10', personShiftQty: 5 }] }, pmc(projectId));
    await commercial.submitRequisition(projectId, requisition.id, pmc(projectId));
    // a second submit of the now-submitted requisition is a 409
    await expect(commercial.submitRequisition(projectId, requisition.id, pmc(projectId))).rejects.toMatchObject({ status: 409 });
    await commercial.approveRequisition(projectId, requisition.id, pmc(projectId));
    await expect(commercial.approveRequisition(projectId, requisition.id, pmc(projectId))).rejects.toMatchObject({ status: 409 });
  });

  // ── §F bound 1 (requirement → requisition, per slice + head + race) ─────────────────────────────

  it('§F BOUND 1: allocations may not exceed the slice qty; a stale revision is refused', async () => {
    const projectId = await freshProject();
    await enableLabour(projectId);
    const act = await freshActivity(projectId);
    const req = await labourRequirement(projectId, act, '2026-08-10', 10);
    // a single line for the whole slice is fine
    await commercial.createRequisition(projectId, { title: 'ok', lines: [{ requirementId: req.requirementId, revision: req.revision, civilDate: '2026-08-10', personShiftQty: 6 }] }, pmc(projectId));
    // a second requisition allocating 5 more overflows the 10-person-shift slice (6 + 5 > 10)
    await expect(commercial.createRequisition(projectId, { title: 'over', lines: [{ requirementId: req.requirementId, revision: req.revision, civilDate: '2026-08-10', personShiftQty: 5 }] }, pmc(projectId))).rejects.toMatchObject({ status: 409 });
    // a demand slice that does not exist on the revision is refused
    await expect(commercial.createRequisition(projectId, { title: 'no-slice', lines: [{ requirementId: req.requirementId, revision: req.revision, civilDate: '2026-08-11', personShiftQty: 1 }] }, pmc(projectId))).rejects.toMatchObject({ status: 400 });
    // revise the requirement → the pinned revision 1 is no longer the labour head → refused
    await requirements.revise(
      projectId, req.requirementId,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { expectedRevision: 1, type: 'labour', activityId: act, tradeCode: 'mason', skillCode: 'bar-bending', shift: 'day', demandSlices: [{ civilDate: '2026-08-10', personShiftQty: 20 }], decisionId: null, responsibleId: null, criticality: 'normal', tolerance: null } as any,
      pmc(projectId),
    );
    await expect(commercial.createRequisition(projectId, { title: 'stale', lines: [{ requirementId: req.requirementId, revision: 1, civilDate: '2026-08-10', personShiftQty: 1 }] }, pmc(projectId))).rejects.toMatchObject({ status: 400 });
  });

  // The deterministic RACE barrier (Task-1 round-3 pattern): both allocating commands take
  // lockProjectReadiness first, so the test holds that advisory lock, parks both commands in the
  // wait queue (verified via pg_stat_activity), and releases — grant order = enqueue order.
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

  it('§F BOUND 1 (RACE): two requisitions racing one slice cannot exceed the required qty', async () => {
    const projectId = await freshProject();
    await enableLabour(projectId);
    const act = await freshActivity(projectId);
    const req = await labourRequirement(projectId, act, '2026-08-10', 100);

    let release!: () => void;
    let acquired!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const held = new Promise<void>((r) => (acquired = r));
    const holder = t.prisma.$transaction(
      async (tx) => { await lockProjectReadiness(tx, projectId); acquired(); await gate; },
      { timeout: 20_000, maxWait: 10_000 },
    );
    await held;
    const raceA = commercial.createRequisition(projectId, { title: 'race A', lines: [{ requirementId: req.requirementId, revision: req.revision, civilDate: '2026-08-10', personShiftQty: 60 }] }, pmc(projectId));
    await waitForReadinessWaiters(1);
    const raceB = commercial.createRequisition(projectId, { title: 'race B', lines: [{ requirementId: req.requirementId, revision: req.revision, civilDate: '2026-08-10', personShiftQty: 60 }] }, pmc(projectId));
    await waitForReadinessWaiters(2);
    release();
    await holder;

    const [ra, rb] = await Promise.allSettled([raceA, raceB]);
    expect(ra.status).toBe('fulfilled'); // enqueued first → granted first → fits (60 ≤ 100)
    expect(rb.status).toBe('rejected'); // 60 + 60 > 100 — the §F bound holds under the race
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((rb as PromiseRejectedResult).reason).toMatchObject({ status: 409 });
    const total = await t.prisma.labourRequisitionLine.aggregate({ where: { projectId, requirementId: req.requirementId, revision: req.revision, status: 'open' }, _sum: { personShiftQty: true } });
    expect(total._sum.personShiftQty).toBe(60);
  });

  it('§F DISPOSITION: a labour requirement cancel refuses while an open labour requisition line references it', async () => {
    const projectId = await freshProject();
    await enableLabour(projectId);
    const act = await freshActivity(projectId);
    const req = await labourRequirement(projectId, act, '2026-08-10', 10);
    const created = await commercial.createRequisition(projectId, { title: 'holds', lines: [{ requirementId: req.requirementId, revision: req.revision, civilDate: '2026-08-10', personShiftQty: 10 }] }, pmc(projectId));
    await expect(requirements.cancel(projectId, req.requirementId, { expectedRevision: 1, reason: 'scope cut' }, pmc(projectId))).rejects.toMatchObject({ status: 409 });
    // cancelling the line frees the allocation → the requirement cancel now succeeds
    await commercial.cancelRequisitionLine(projectId, created.id, created.lines[0]!.id, pmc(projectId));
    await expect(requirements.cancel(projectId, req.requirementId, { expectedRevision: 1, reason: 'scope cut' }, pmc(projectId))).resolves.toBeTruthy();
  });

  // ── §F bound 2 (requisition → PO, per slice) + frozen snapshot + append-only ────────────────────

  it('§F BOUND 2: a PO may not order more than the requisition line; the frozen snapshot + append-only evidence are DB-sealed', async () => {
    const projectId = await freshProject();
    await enableLabour(projectId);
    const act = await freshActivity(projectId);
    const req = await labourRequirement(projectId, act, '2026-08-10', 10);
    const vendorId = await boundVendor(projectId);
    const requisition = await approvedRequisition(projectId, req, '2026-08-10', 10);
    const line = requisition.lines[0]!;
    const { comparisonId } = await approvedComparison(projectId, requisition.id, line.id, vendorId);

    // bound 2: ordering 11 of a 10-person-shift line is refused
    await expect(commercial.createPo(projectId, { comparisonId, lines: [{ requisitionLineId: line.id, personShiftQty: 11 }] }, pmc(projectId))).rejects.toMatchObject({ status: 409 });
    const po = await commercial.createPo(projectId, { comparisonId, lines: [{ requisitionLineId: line.id, personShiftQty: 10 }] }, pmc(projectId));
    const poLine = po.currentVersion.lines[0]!;

    // the frozen commercial snapshot cannot be mutated (only committedQty may change)
    await expect(t.prisma.$executeRawUnsafe(`UPDATE "LabourPurchaseOrderLine" SET "ratePerPersonShift" = 1 WHERE "id" = '${poLine.id}'`)).rejects.toThrow();
    // the labour PO root is append-only
    await expect(t.prisma.$executeRawUnsafe(`UPDATE "LabourPurchaseOrder" SET "vendorId" = 'x' WHERE "id" = '${po.id}'`)).rejects.toThrow();
    // a recorded quote LINE is append-only
    const quoteLine = await t.prisma.supplierLabourQuoteLine.findFirstOrThrow({ where: { projectId } });
    await expect(t.prisma.$executeRawUnsafe(`UPDATE "SupplierLabourQuoteLine" SET "ratePerPersonShift" = 1 WHERE "id" = '${quoteLine.id}'`)).rejects.toThrow();
  });

  it('§F PO LIFECYCLE: amend issues a NEW version retaining the prior verbatim; close-short releases the remainder', async () => {
    const projectId = await freshProject();
    await enableLabour(projectId);
    const act = await freshActivity(projectId);
    const req = await labourRequirement(projectId, act, '2026-08-10', 10);
    const vendorId = await boundVendor(projectId);
    const requisition = await approvedRequisition(projectId, req, '2026-08-10', 10);
    const line = requisition.lines[0]!;
    const { comparisonId } = await approvedComparison(projectId, requisition.id, line.id, vendorId);
    const po = await commercial.createPo(projectId, { comparisonId, lines: [{ requisitionLineId: line.id, personShiftQty: 8 }] }, pmc(projectId));
    await commercial.issuePo(projectId, po.id, {}, pmc(projectId));

    const amended = await commercial.amendPo(projectId, po.id, { reason: 'reduce to 6', lines: [{ requisitionLineId: line.id, personShiftQty: 6 }] }, pmc(projectId));
    expect(amended.currentVersion.version).toBe(2);
    expect(amended.currentVersion.supersedesVersion).toBe(1);
    expect(amended.currentVersion.lines[0]!.personShiftQty).toBe(6);
    // the prior version is retained VERBATIM (still 8) with status 'amended'
    const v1 = amended.versions.find((v) => v.version === 1)!;
    expect(v1.status).toBe('amended');
    expect(v1.lines[0]!.personShiftQty).toBe(8);
    expect(await t.prisma.domainEvent.count({ where: { projectId, eventType: 'labour.po.amended' } })).toBe(1);

    const closed = await commercial.closeShortPo(projectId, po.id, { reason: 'crew unavailable' }, pmc(projectId));
    expect(closed.currentVersion.status).toBe('closed_short');
    expect(await t.prisma.domainEvent.count({ where: { projectId, eventType: 'labour.po.closed_short' } })).toBe(1);
  });

  it('§F COMPARISON: only a complete, in-spec quote wins; a non-lowest landed selection demands justification', async () => {
    const projectId = await freshProject();
    await enableLabour(projectId);
    const act = await freshActivity(projectId);
    const req = await labourRequirement(projectId, act, '2026-08-10', 10);
    const cheap = await boundVendor(projectId, 'Cheap');
    const dear = await boundVendor(projectId, 'Dear');
    const requisition = await approvedRequisition(projectId, req, '2026-08-10', 10);
    const line = requisition.lines[0]!;
    const rfq = await commercial.createRfq(projectId, { requisitionId: requisition.id }, pmc(projectId));
    await commercial.recordQuote(projectId, rfq.id, { vendorId: cheap, validUntil: '2026-12-31', lines: [{ requisitionLineId: line.id, ratePerPersonShift: '900', shiftPremium: '0', landedPerPersonShift: '900', matchesSpecification: true }] }, pmc(projectId));
    await commercial.recordQuote(projectId, rfq.id, { vendorId: dear, validUntil: '2026-12-31', lines: [{ requisitionLineId: line.id, ratePerPersonShift: '1200', shiftPremium: '0', landedPerPersonShift: '1200', matchesSpecification: true }] }, pmc(projectId));
    await commercial.createComparison(projectId, rfq.id, pmc(projectId));
    const full = await commercial.readRfq(projectId, rfq.id, pmc(projectId));
    const dearQuote = full.quotes.find((q) => q.vendorId === dear)!;
    // selecting the dearer quote with NO justification is refused (900 < 1200 landed)
    await expect(commercial.approveComparison(projectId, rfq.id, { selectedQuoteId: dearQuote.id, reason: 'prefer' }, pmc(projectId))).rejects.toMatchObject({ status: 400 });
    // with a justification it is accepted
    const ok = await commercial.approveComparison(projectId, rfq.id, { selectedQuoteId: dearQuote.id, reason: 'prefer', justification: 'proven crew' }, pmc(projectId));
    expect(ok.comparison).toMatchObject({ status: 'approved', selectedVendorId: dear });
  });

  // ── idempotency + tenancy ───────────────────────────────────────────────────────────────────────

  it('IDEMPOTENCY: a keyed submit replay appends no second event', async () => {
    const projectId = await freshProject();
    await enableLabour(projectId);
    const act = await freshActivity(projectId);
    const req = await labourRequirement(projectId, act, '2026-08-10', 5);
    const requisition = await commercial.createRequisition(projectId, { title: 'idem', lines: [{ requirementId: req.requirementId, revision: req.revision, civilDate: '2026-08-10', personShiftQty: 5 }] }, pmc(projectId));
    await commercial.submitRequisition(projectId, requisition.id, pmc(projectId), 'submit-key-1');
    await commercial.submitRequisition(projectId, requisition.id, pmc(projectId), 'submit-key-1'); // exact replay
    expect(await t.prisma.domainEvent.count({ where: { projectId, eventType: 'labour.requisition.submitted' } })).toBe(1);
  });

  it('§D INERTNESS: the labour commercial chain 404s on a non-pilot project', async () => {
    const nonPilot = await freshProject(); // labour capability NOT enabled
    await expect(commercial.createRequisition(nonPilot, { title: 'x', lines: [{ requirementId: 'r', revision: 1, civilDate: '2026-08-10', personShiftQty: 1 }] }, pmc(nonPilot))).rejects.toMatchObject({ status: 404 });
    await expect(commercial.listRequisitions(nonPilot, pmc(nonPilot))).rejects.toMatchObject({ status: 404 });
    await expect(commercial.listPos(nonPilot, pmc(nonPilot))).rejects.toMatchObject({ status: 404 });
    await expect(commercial.listCommitments(nonPilot, pmc(nonPilot))).rejects.toMatchObject({ status: 404 });
    expect(await t.prisma.labourRequisition.count({ where: { projectId: nonPilot } })).toBe(0);
  });
});
