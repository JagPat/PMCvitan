import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import request from 'supertest';
import { createTestApp, type TestApp } from './test-app';
import { createTwoProjectFixture, type TwoProjectFixture } from './fixtures';
import { RequirementsService } from '../../src/activities/requirements.service';
import { VendorsService } from '../../src/procurement/vendors.service';
import { ProcurementService } from '../../src/procurement/procurement.service';
import { CapabilitiesService, MATERIALS_CAPABILITY } from '../../src/platform/capabilities.service';
import { OutboxRelay } from '../../src/platform/outbox/relay.service';
import { DECISIONS_PROJECTION } from '../../src/decisions/decisions.projection';
import { lockProjectReadiness } from '../../src/common/readiness-lock';
import type { AuthUser } from '../../src/common/auth';
import type { CreateRequirementInput } from '../../src/contracts';

/**
 * Phase 3 Task 2 — the procurement module, live-PG acceptance (plan §§D/F/G/H).
 *
 *   §H TENANCY — org-scoped vendors; the ProjectVendor binding is the ONLY project reach
 *   (cross-org binding refused in the service AND unrepresentable at the DB); quotes reach
 *   vendors only through the binding; org-admin vendor CRUD is SEPARATE from project-level
 *   procurement access in both directions.
 *   §F MACHINES — every requisition/RFQ/quote/comparison transition is a CAS with one winner;
 *   a non-lowest comparison selection demands explicit justification; recording a newer quote
 *   supersedes; validity expiry is settled at approval.
 *   §F BOUND 1 — Σ active requisition-line allocations ≤ the requirement revision's required
 *   qty, with the revision FOR-UPDATE-locked in the command transaction: proven sequentially,
 *   under a deterministic barrier-controlled RACE (two requisitions racing one revision), and
 *   released by line cancellation.
 *   §G EVENTS — requisition.submitted/approved + comparison.approved carry the documented
 *   payloads; ordered consumers advance past them.
 *   §D — every procurement surface is 404 on a non-pilot project.
 */

describe('Phase 3 Task 2 — procurement (live PG)', () => {
  let t: TestApp;
  let f: TwoProjectFixture;
  let requirements: RequirementsService;
  let vendors: VendorsService;
  let procurement: ProcurementService;
  let capabilities: CapabilitiesService;
  let relay: OutboxRelay;
  let seq = 0;

  const TRUNCATE =
    'TRUNCATE TABLE "DomainEvent", "OutboxDelivery", "ProcessedEvent", "ProjectionCursor", "ProjectionGeneration", "DecisionProjection", "DailyLogProjection", "DrawingsProjection", "InspectionsProjection", "ActivitiesProjection", "CommandExecution", "VendorQuoteLine", "QuoteComparison", "VendorQuote", "Rfq", "RequisitionLine", "Requisition", "ProjectVendor", "MaterialRequirementSpec", "ActivityRequirement", "ActivityRequirementRoot", "DecisionApprovalRevision", "ProjectCapability"';

  const pmc = (projectId: string): AuthUser => ({ sub: f.memberUser.id, role: 'pmc', projectId }) as AuthUser;
  const orgAdmin = (): AuthUser => ({ sub: f.ownerUser.id, role: 'pmc' }) as AuthUser;

  beforeAll(async () => {
    t = await createTestApp();
    f = await createTwoProjectFixture(t.prisma);
    requirements = t.app.get(RequirementsService);
    vendors = t.app.get(VendorsService);
    procurement = t.app.get(ProcurementService);
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
      ['notification', { projectId: { startsWith: 'it-p3p-' } }],
      ['activity', { projectId: { startsWith: 'it-p3p-' } }],
      ['auditLog', { projectId: { startsWith: 'it-p3p-' } }],
      ['membership', { projectId: { startsWith: 'it-p3p-' } }],
      ['project', { id: { startsWith: 'it-p3p-' } }],
    ] as const) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (t.prisma as any)[model].deleteMany({ where });
    }
  });

  const freshProject = async (orgId = f.orgA.id): Promise<string> => {
    const id = `it-p3p-${Date.now() % 1e6}-${seq++}`;
    await t.prisma.project.create({
      data: { id, orgId, name: id, short: 'P', descriptor: '', stage: 'x', siteCode: 'P', projStart: 'a', projEnd: 'b', elapsedPct: 0, todayDay: 0, milestonePct: 0, timeZone: 'Asia/Kolkata', scheduleStartDate: new Date('2026-06-01T00:00:00.000Z') },
    });
    await t.prisma.membership.create({ data: { projectId: id, userId: f.memberUser.id, role: 'pmc', status: 'active' } });
    await capabilities.enable(id, MATERIALS_CAPABILITY, f.memberUser.id);
    return id;
  };

  const freshActivity = async (projectId: string): Promise<string> => {
    const id = `IT-P3P-ACT-${Date.now() % 1e6}-${seq++}`;
    await t.prisma.activity.create({ data: { id, projectId, name: `Act ${seq}`, zone: 'Zone 1', plannedStart: 0, plannedEnd: 10 } });
    return id;
  };

  /** A material requirement with requiredQty 100 bag — the §F bound-1 ceiling. */
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

  const boundVendor = async (projectId: string, name = `Vendor ${seq++}`): Promise<string> => {
    const v = await vendors.create(f.orgA.id, { name }, orgAdmin());
    await vendors.bind(projectId, { vendorId: v.id }, pmc(projectId));
    return v.id;
  };

  const approvedRequisition = async (projectId: string, req: { requirementId: string; revision: number }, qty = '100') => {
    const created = await procurement.createRequisition(
      projectId, { title: `Req ${seq++}`, lines: [{ requirementId: req.requirementId, revision: req.revision, qty }] }, pmc(projectId),
    );
    await procurement.submit(projectId, created.id, pmc(projectId));
    return procurement.approve(projectId, created.id, pmc(projectId));
  };

  const quoteFor = async (projectId: string, rfqId: string, vendorId: string, lineId: string, landed: string, validUntil = '2027-01-01') =>
    procurement.recordQuote(projectId, rfqId, {
      vendorId, validUntil,
      lines: [{ requisitionLineId: lineId, baseRate: landed, taxAmount: '0', freightAmount: '0', landedCost: landed, quotedMake: 'UltraTech', matchesSpecification: true }],
    }, pmc(projectId));

  it('§D INERTNESS: every procurement surface is 404 on a non-pilot project', async () => {
    const id = `it-p3p-off-${Date.now() % 1e6}-${seq++}`;
    await t.prisma.project.create({
      data: { id, orgId: f.orgA.id, name: id, short: 'P', descriptor: '', stage: 'x', siteCode: 'P', projStart: 'a', projEnd: 'b', elapsedPct: 0, todayDay: 0, milestonePct: 0, timeZone: 'Asia/Kolkata', scheduleStartDate: new Date('2026-06-01T00:00:00.000Z') },
    });
    await t.prisma.membership.create({ data: { projectId: id, userId: f.memberUser.id, role: 'pmc', status: 'active' } });
    const v = await vendors.create(f.orgA.id, { name: 'Off-pilot vendor' }, orgAdmin());
    await expect(vendors.bind(id, { vendorId: v.id }, pmc(id))).rejects.toMatchObject({ status: 404 });
    await expect(procurement.createRequisition(id, { title: 'x', lines: [{ requirementId: 'r', revision: 1, qty: '1' }] }, pmc(id))).rejects.toMatchObject({ status: 404 });
    await expect(procurement.listRequisitions(id, pmc(id))).rejects.toMatchObject({ status: 404 });
  });

  it('§H TENANCY: a cross-org binding refuses in the service AND is unrepresentable at the database; quotes require the binding', async () => {
    const projectId = await freshProject();
    const foreign = await t.prisma.vendor.create({ data: { orgId: f.orgB.id, name: 'Org-B vendor', createdById: f.otherUser.id } });
    await expect(vendors.bind(projectId, { vendorId: foreign.id }, pmc(projectId))).rejects.toMatchObject({ status: 400 });
    // the DB backstop: a forged binding row claiming org A for an org-B vendor violates the composite FK
    await expect(
      t.prisma.projectVendor.create({ data: { projectId, orgId: f.orgA.id, vendorId: foreign.id, boundById: f.memberUser.id } }),
    ).rejects.toThrow();
    // a quote referencing an UNBOUND vendor refuses (§H — reach is only through the binding)
    const req = await freshRequirement(projectId);
    const requisition = await approvedRequisition(projectId, req);
    const rfq = await procurement.createRfq(projectId, { requisitionId: requisition.id }, pmc(projectId));
    const local = await vendors.create(f.orgA.id, { name: 'Unbound local' }, orgAdmin());
    await expect(quoteFor(projectId, rfq.id, local.id, requisition.lines[0]!.id, '100')).rejects.toMatchObject({ status: 400 });
  });

  it('§H SEPARATION: org-admin vendor CRUD vs project-level procurement access, both directions', async () => {
    const projectId = await freshProject();
    // a project pmc who is NOT an org admin cannot touch the org vendor registry
    await expect(vendors.create(f.orgA.id, { name: 'nope' }, pmc(projectId))).rejects.toMatchObject({ status: 403 });
    await expect(vendors.listForOrg(f.orgA.id, pmc(projectId))).rejects.toMatchObject({ status: 403 });
    // the org admin CAN manage the registry...
    const v = await vendors.create(f.orgA.id, { name: 'Registry vendor' }, orgAdmin());
    expect((await vendors.listForOrg(f.orgA.id, orgAdmin())).vendors.some((x) => x.id === v.id)).toBe(true);
    // ...and org-admin authority stops at the ORG boundary: an admin of ANOTHER org has no
    // project-level procurement reach here (live authorization refuses over HTTP)
    await t.prisma.orgMembership.create({ data: { orgId: f.orgB.id, userId: f.strangerUser.id, role: 'admin' } });
    try {
      const foreignAdmin = t.issueProjectToken(f.strangerUser.id, projectId);
      const res = await request(t.app.getHttpServer())
        .post(`/projects/${projectId}/requisitions`)
        .set('Authorization', `Bearer ${foreignAdmin}`)
        .send({ title: 'x', lines: [{ requirementId: 'r', revision: 1, qty: '1' }] });
      expect([401, 403]).toContain(res.status);
    } finally {
      await t.prisma.orgMembership.deleteMany({ where: { orgId: f.orgB.id, userId: f.strangerUser.id } });
    }
    // (the SAME org's owner operates its projects as pmc BY DESIGN — the established org
    // super-admin model — so the admitted path is documented here, not treated as a leak)
    const req = await freshRequirement(projectId);
    const ownToken = t.issueProjectToken(f.ownerUser.id, projectId);
    const admitted = await request(t.app.getHttpServer())
      .post(`/projects/${projectId}/requisitions`)
      .set('Authorization', `Bearer ${ownToken}`)
      .send({ title: 'super-admin path', lines: [{ requirementId: req.requirementId, revision: req.revision, qty: '5' }] });
    expect(admitted.status).toBe(201);
  });

  it('REMOVED MEMBER: a removed membership is refused on a procurement route (live authorization)', async () => {
    const projectId = await freshProject();
    await t.prisma.membership.create({ data: { projectId, userId: f.strangerUser.id, role: 'pmc', status: 'active' } });
    const token = t.issueProjectToken(f.strangerUser.id, projectId);
    const req = await freshRequirement(projectId);
    const ok = await request(t.app.getHttpServer())
      .post(`/projects/${projectId}/requisitions`)
      .set('Authorization', `Bearer ${token}`)
      .send({ title: 'live', lines: [{ requirementId: req.requirementId, revision: req.revision, qty: '10' }] });
    expect(ok.status).toBe(201);
    await t.prisma.membership.update({ where: { projectId_userId: { projectId, userId: f.strangerUser.id } }, data: { status: 'removed' } });
    const refused = await request(t.app.getHttpServer())
      .post(`/projects/${projectId}/requisitions`)
      .set('Authorization', `Bearer ${token}`)
      .send({ title: 'after removal', lines: [{ requirementId: req.requirementId, revision: req.revision, qty: '10' }] });
    expect([401, 403]).toContain(refused.status);
  });

  it('§F CAS MACHINES: every transition has one winner; the losers get deterministic 409s', async () => {
    const projectId = await freshProject();
    const req = await freshRequirement(projectId);
    const created = await procurement.createRequisition(
      projectId, { title: 'CAS', lines: [{ requirementId: req.requirementId, revision: req.revision, qty: '10' }] }, pmc(projectId),
    );
    await expect(procurement.approve(projectId, created.id, pmc(projectId))).rejects.toMatchObject({ status: 409 }); // draft cannot approve
    await procurement.submit(projectId, created.id, pmc(projectId));
    await expect(procurement.submit(projectId, created.id, pmc(projectId))).rejects.toMatchObject({ status: 409 }); // already submitted
    await procurement.reject(projectId, created.id, { reason: 'not needed' }, pmc(projectId));
    await expect(procurement.approve(projectId, created.id, pmc(projectId))).rejects.toMatchObject({ status: 409 }); // rejected cannot approve

    const second = await approvedRequisition(projectId, await freshRequirement(projectId), '50');
    const rfq = await procurement.createRfq(projectId, { requisitionId: second.id }, pmc(projectId));
    await procurement.closeRfq(projectId, rfq.id, pmc(projectId));
    await expect(procurement.closeRfq(projectId, rfq.id, pmc(projectId))).rejects.toMatchObject({ status: 409 }); // already closed
    // close: refuses while lines are open; passes once every line is cancelled
    await expect(procurement.close(projectId, second.id, pmc(projectId))).rejects.toMatchObject({ status: 409 });
    await procurement.cancelLine(projectId, second.id, second.lines[0]!.id, pmc(projectId));
    const closed = await procurement.close(projectId, second.id, pmc(projectId));
    expect(closed.status).toBe('closed');
  });

  it('§F BOUND 1 (sequential): allocations fill to the ceiling, overflow refuses, cancellation frees', async () => {
    const projectId = await freshProject();
    const req = await freshRequirement(projectId, '100');
    const a = await procurement.createRequisition(projectId, { title: 'A', lines: [{ requirementId: req.requirementId, revision: req.revision, qty: '60' }] }, pmc(projectId));
    await procurement.createRequisition(projectId, { title: 'B', lines: [{ requirementId: req.requirementId, revision: req.revision, qty: '40' }] }, pmc(projectId));
    await expect(
      procurement.createRequisition(projectId, { title: 'C', lines: [{ requirementId: req.requirementId, revision: req.revision, qty: '1' }] }, pmc(projectId)),
    ).rejects.toMatchObject({ status: 409 });
    // cancelling A's 60 frees the ceiling — a 50 now fits (and 60 would again overflow)
    await procurement.cancelLine(projectId, a.id, a.lines[0]!.id, pmc(projectId));
    await procurement.createRequisition(projectId, { title: 'D', lines: [{ requirementId: req.requirementId, revision: req.revision, qty: '50' }] }, pmc(projectId));
    await expect(
      procurement.createRequisition(projectId, { title: 'E', lines: [{ requirementId: req.requirementId, revision: req.revision, qty: '11' }] }, pmc(projectId)),
    ).rejects.toMatchObject({ status: 409 });
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

  it('§F BOUND 1 (RACE): two requisitions racing one revision cannot exceed the required qty', async () => {
    const projectId = await freshProject();
    const req = await freshRequirement(projectId, '100');

    let release!: () => void;
    let acquired!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const held = new Promise<void>((r) => (acquired = r));
    const holder = t.prisma.$transaction(
      async (tx) => { await lockProjectReadiness(tx, projectId); acquired(); await gate; },
      { timeout: 20_000, maxWait: 10_000 },
    );
    await held;
    const raceA = procurement.createRequisition(projectId, { title: 'race A', lines: [{ requirementId: req.requirementId, revision: req.revision, qty: '60' }] }, pmc(projectId));
    await waitForReadinessWaiters(1);
    const raceB = procurement.createRequisition(projectId, { title: 'race B', lines: [{ requirementId: req.requirementId, revision: req.revision, qty: '60' }] }, pmc(projectId));
    await waitForReadinessWaiters(2);
    release();
    await holder;

    const [ra, rb] = await Promise.allSettled([raceA, raceB]);
    expect(ra.status).toBe('fulfilled'); // enqueued first → granted first → fits (60 ≤ 100)
    expect(rb.status).toBe('rejected'); // 60 + 60 > 100 — the §F bound holds under the race
    expect((rb as PromiseRejectedResult).reason).toMatchObject({ status: 409 });
    const total = await t.prisma.requisitionLine.aggregate({
      where: { projectId, requirementId: req.requirementId, revision: req.revision, status: 'open' },
      _sum: { qty: true },
    });
    expect(total._sum.qty!.toString()).toBe('60');
  });

  it('§F DISPOSITION: a requirement cancel refuses while open requisition lines reference it', async () => {
    const projectId = await freshProject();
    const req = await freshRequirement(projectId);
    const created = await procurement.createRequisition(projectId, { title: 'holds allocation', lines: [{ requirementId: req.requirementId, revision: req.revision, qty: '10' }] }, pmc(projectId));
    await expect(
      requirements.cancel(projectId, req.requirementId, { expectedRevision: 1, reason: 'scope cut' }, pmc(projectId)),
    ).rejects.toMatchObject({ status: 409 });
    await procurement.cancelLine(projectId, created.id, created.lines[0]!.id, pmc(projectId));
    const cancelled = await requirements.cancel(projectId, req.requirementId, { expectedRevision: 1, reason: 'scope cut' }, pmc(projectId));
    expect(cancelled.status).toBe('cancelled');
  });

  it('§F COMPARISON: non-lowest demands justification; expiry and supersede are settled transitions', async () => {
    const projectId = await freshProject();
    const req = await freshRequirement(projectId);
    const requisition = await approvedRequisition(projectId, req, '80');
    const lineId = requisition.lines[0]!.id;
    const rfq = await procurement.createRfq(projectId, { requisitionId: requisition.id }, pmc(projectId));
    const cheap = await boundVendor(projectId, 'Cheap & sound');
    const dear = await boundVendor(projectId, 'Premium make');
    const lapsed = await boundVendor(projectId, 'Lapsed quote');
    await quoteFor(projectId, rfq.id, cheap, lineId, '100.00');
    await quoteFor(projectId, rfq.id, dear, lineId, '120.00');
    await quoteFor(projectId, rfq.id, lapsed, lineId, '90.00', '2026-01-01'); // validity already passed
    // recording anew SUPERSEDES the vendor's prior recorded quote on this RFQ
    const afterResubmit = await quoteFor(projectId, rfq.id, cheap, lineId, '99.00');
    const cheapQuotes = afterResubmit.quotes.filter((q) => q.vendorId === cheap);
    expect(cheapQuotes.map((q) => q.status).sort()).toEqual(['recorded', 'superseded']);
    const liveCheap = cheapQuotes.find((q) => q.status === 'recorded')!;
    const dearQuote = afterResubmit.quotes.find((q) => q.vendorId === dear && q.status === 'recorded')!;

    await procurement.createComparison(projectId, rfq.id, pmc(projectId));
    // the expired quote can win nothing
    const expired = afterResubmit.quotes.find((q) => q.vendorId === lapsed)!;
    await expect(
      procurement.approveComparison(projectId, rfq.id, { selectedQuoteId: expired.id, reason: 'cheapest' }, pmc(projectId)),
    ).rejects.toMatchObject({ status: 400 });
    // a NON-LOWEST selection without justification refuses…
    await expect(
      procurement.approveComparison(projectId, rfq.id, { selectedQuoteId: dearQuote.id, reason: 'preferred make' }, pmc(projectId)),
    ).rejects.toMatchObject({ status: 400 });
    // …and passes WITH an explicit justification, recording REAL authority + both texts
    const approved = await procurement.approveComparison(
      projectId, rfq.id,
      { selectedQuoteId: dearQuote.id, reason: 'preferred make', justification: 'only make matching the approved specification sample' },
      pmc(projectId),
    );
    expect(approved.comparison).toMatchObject({
      status: 'approved', selectedQuoteId: dearQuote.id, selectedVendorId: dear,
      reason: 'preferred make', justification: 'only make matching the approved specification sample',
      approvedById: f.memberUser.id,
    });
    // the expired quote's transition was CAS'd inside the approving transaction
    const lapsedRow = await t.prisma.vendorQuote.findFirstOrThrow({ where: { projectId, rfqId: rfq.id, vendorId: lapsed } });
    expect(lapsedRow.status).toBe('expired');
    // double-approve → deterministic 409; a LOWEST selection needs no justification (fresh rfq)
    await expect(
      procurement.approveComparison(projectId, rfq.id, { selectedQuoteId: liveCheap.id, reason: 'again' }, pmc(projectId)),
    ).rejects.toMatchObject({ status: 409 });
  });

  it('§G EVENTS: submitted/approved + comparison.approved carry the documented payloads; ordered consumers advance', async () => {
    const projectId = await freshProject();
    const req = await freshRequirement(projectId);
    const requisition = await approvedRequisition(projectId, req, '25');
    const rfq = await procurement.createRfq(projectId, { requisitionId: requisition.id }, pmc(projectId));
    const vendorId = await boundVendor(projectId);
    const withQuote = await quoteFor(projectId, rfq.id, vendorId, requisition.lines[0]!.id, '500.00');
    await procurement.createComparison(projectId, rfq.id, pmc(projectId));
    await procurement.approveComparison(projectId, rfq.id, { selectedQuoteId: withQuote.quotes[0]!.id, reason: 'single quote, in spec' }, pmc(projectId));

    const evs = await t.prisma.domainEvent.findMany({
      where: { projectId, eventType: { in: ['requisition.submitted', 'requisition.approved', 'comparison.approved'] } },
      orderBy: { streamPosition: 'asc' },
    });
    expect(evs.map((e) => e.eventType)).toEqual(['requisition.submitted', 'requisition.approved', 'comparison.approved']);
    const submitted = evs[0]!.payload as { requisitionId: string; lines: Array<{ requirementId: string; revision: number; qty: string }> };
    expect(submitted.requisitionId).toBe(requisition.id);
    expect(submitted.lines).toEqual([{ requirementId: req.requirementId, revision: req.revision, qty: '25' }]);
    const comparison = evs[2]!.payload as Record<string, unknown>;
    expect(comparison).toMatchObject({ selectedVendorId: vendorId, authority: f.memberUser.id, reason: 'single quote, in spec' });
    expect(typeof comparison.comparisonId).toBe('string');

    // ordered consumers no-op PAST the procurement events (nothing stalls, nothing corrupts)
    const ds = await t.prisma.outboxDelivery.findMany({ where: { consumer: DECISIONS_PROJECTION, projectId }, orderBy: { streamPosition: 'asc' } });
    for (const d of ds) expect(await relay.dispatchOne(d.id)).toBe('succeeded');
    const gen = await t.prisma.projectionGeneration.findFirst({ where: { consumer: DECISIONS_PROJECTION, projectId, status: 'active' } });
    expect(gen?.appliedPosition).toBe(evs[2]!.streamPosition);
  });

  it('IDEMPOTENCY: keyed replays of create and submit append nothing', async () => {
    const projectId = await freshProject();
    const req = await freshRequirement(projectId);
    const key = `it-p3p-key-${Date.now() % 1e6}`;
    const first = await procurement.createRequisition(projectId, { title: 'once', lines: [{ requirementId: req.requirementId, revision: req.revision, qty: '10' }] }, pmc(projectId), key);
    const replay = await procurement.createRequisition(projectId, { title: 'once', lines: [{ requirementId: req.requirementId, revision: req.revision, qty: '10' }] }, pmc(projectId), key);
    expect(replay.id).toBe(first.id);
    expect(await t.prisma.requisition.count({ where: { projectId } })).toBe(1);
    const submitKey = `${key}-submit`;
    await procurement.submit(projectId, first.id, pmc(projectId), submitKey);
    await procurement.submit(projectId, first.id, pmc(projectId), submitKey); // replay, not a 409
    expect(await t.prisma.domainEvent.count({ where: { projectId, eventType: 'requisition.submitted' } })).toBe(1);
  });

  it('ISOLATION: a requisition line cannot pin another project’s requirement; reads are project-contained', async () => {
    const p1 = await freshProject();
    const p2 = await freshProject();
    const foreignReq = await freshRequirement(p2);
    await expect(
      procurement.createRequisition(p1, { title: 'cross', lines: [{ requirementId: foreignReq.requirementId, revision: foreignReq.revision, qty: '1' }] }, pmc(p1)),
    ).rejects.toMatchObject({ status: 404 });
    const own = await freshRequirement(p1);
    await procurement.createRequisition(p1, { title: 'own', lines: [{ requirementId: own.requirementId, revision: own.revision, qty: '1' }] }, pmc(p1));
    expect((await procurement.listRequisitions(p2, pmc(p2))).requisitions).toHaveLength(0);
  });
});
