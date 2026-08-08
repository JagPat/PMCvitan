import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { createTestApp, type TestApp } from './test-app';
import { createTwoProjectFixture, type TwoProjectFixture } from './fixtures';
import { RequirementsService } from '../../src/activities/requirements.service';
import { ProcurementService } from '../../src/procurement/procurement.service';
import { PurchaseOrdersService } from '../../src/procurement/purchase-orders.service';
import { VendorsService } from '../../src/procurement/vendors.service';
import { CommercialActivationService } from '../../src/commercial/commercial-activation.service';
import { CommercialBudgetService } from '../../src/commercial/commercial-budget.service';
import { CommercialService } from '../../src/commercial/commercial.service';
import { CapabilitiesService, MATERIALS_CAPABILITY } from '../../src/platform/capabilities.service';
import { RealtimeGateway } from '../../src/realtime/realtime.gateway';
import { SOCKET_CONSUMER } from '../../src/platform/outbox/consumers';
import { COMMERCIAL_MONEY_EVENT } from '../../src/commercial/cash-forecast.projection';
import { emitEvent } from '../../src/platform/events';
import { executeCommand, hashRequest } from '../../src/platform/commands';
import type { AuthUser } from '../../src/common/auth';
import type { Actor } from '../../src/common/actor';
import type { CreateRequirementInput } from '../../src/contracts';

/**
 * Phase 5 Task 7B-i-a — A COMMAND'S EXTERNAL EFFECTS ARE WHAT IT EMITTED. Live PG, reproduce-first.
 *
 * 7B-i shipped the Commercial hub, whose refresh rides the socket `changed` ping. 7A had shipped
 * `commercial.money_moved` WEIGHTLESS (`invalidate: false`) because at the time nothing external
 * consumed it — true when written, false once the hub existed. Flipping the flag alone would have
 * been worse than leaving it: commercial's single emit seam (`CommercialBudgetService.evaluate`)
 * sits several frames below every command body, so no commercial service could return the meta its
 * post-commit dispatcher needs, and in the default `legacy` sender mode the relay deliberately
 * holds fresh external deliveries for the lease window. The invalidation would have arrived late,
 * and under `OUTBOX_RELAY_AUTOSTART=false` never.
 *
 * So the fix is not to thread that meta through ~15 call sites in four modules. It is to stop
 * asking callers what they emitted: `emitEvent` records each emission against its transaction and
 * `executeCommand` reads it back.
 *
 *   1  the DRAIN — an event emitted BELOW `run`, whose meta no caller returns, reaches
 *      `outcome.events` (RED before: the array is empty and the effect is never sent)
 *   2  the drain is OPT-IN — a raw `prisma.$transaction` is NOT collected, so a rebuild or an
 *      operator sweep does not start looking like a command
 *   3  a COMMERCIAL-ONLY write invalidates: `commercial.budget.set` sends the socket ping, and its
 *      delivery is `dispatch`+`succeeded` rather than a recorded no-op
 *   4  a FOREIGN command carries the money event in the SAME batch — one ping, not two, and the
 *      money delivery is not left `pending` for the relay to sweep later
 *   5  a REPLAY sends nothing — the second call under one key re-emits nothing and pings nobody
 */
describe('Phase 5 Task 7B-i-a — commercial money invalidation + the emission registry (live PG)', () => {
  let t: TestApp;
  let f: TwoProjectFixture;
  let requirements: RequirementsService;
  let procurement: ProcurementService;
  let pos: PurchaseOrdersService;
  let vendors: VendorsService;
  let activation: CommercialActivationService;
  let budget: CommercialBudgetService;
  let commercial: CommercialService;
  let capabilities: CapabilitiesService;
  let realtime: RealtimeGateway;
  let seq = 0;

  const TRUNCATE =
    'TRUNCATE TABLE "BudgetException", "BudgetLine", "CommitmentAttribution", "CostHead", "DomainEvent", "OutboxDelivery", "ProcessedEvent", "ProjectionCursor", "ProjectionGeneration", "CashForecastProjection", "DeliveryPromise", "DeliveryCommitment", "PurchaseOrderLine", "PurchaseOrderVersion", "PurchaseOrder", "VendorQuoteLine", "VendorQuote", "QuoteComparison", "Rfq", "RequisitionLine", "Requisition", "ProjectVendor", "CommandExecution", "MaterialRequirementSpec", "ActivityRequirement", "ActivityRequirementRoot", "ProjectCapability" CASCADE';

  const pmc = (projectId: string): AuthUser => ({ sub: f.memberUser.id, role: 'pmc', projectId }) as AuthUser;
  const orgAdmin = (): AuthUser => ({ sub: f.ownerUser.id, role: 'pmc', orgId: f.orgA.id }) as AuthUser;

  beforeAll(async () => {
    t = await createTestApp();
    f = await createTwoProjectFixture(t.prisma);
    requirements = t.app.get(RequirementsService);
    procurement = t.app.get(ProcurementService);
    pos = t.app.get(PurchaseOrdersService);
    vendors = t.app.get(VendorsService);
    activation = t.app.get(CommercialActivationService);
    budget = t.app.get(CommercialBudgetService);
    commercial = t.app.get(CommercialService);
    capabilities = t.app.get(CapabilitiesService);
    realtime = t.app.get(RealtimeGateway);
  });
  afterAll(async () => {
    await t?.prisma.$executeRawUnsafe(TRUNCATE);
    await t?.prisma.vendor.deleteMany({ where: { orgId: f.orgA.id } });
    await f?.cleanup();
    await t?.close();
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await t.prisma.$executeRawUnsafe(TRUNCATE);
    await t.prisma.vendor.deleteMany({ where: { orgId: f.orgA.id } });
    for (const [model, where] of [
      ['auditLog', { projectId: { startsWith: 'it-p57bia-' } }],
      ['activity', { projectId: { startsWith: 'it-p57bia-' } }],
      ['membership', { projectId: { startsWith: 'it-p57bia-' } }],
      ['project', { id: { startsWith: 'it-p57bia-' } }],
    ] as const) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (t.prisma as any)[model].deleteMany({ where });
    }
  });

  // ── fixtures ──────────────────────────────────────────────────────────────────────────────────

  const freshProject = async (): Promise<string> => {
    const id = `it-p57bia-${Date.now() % 1e6}-${seq++}`;
    await t.prisma.project.create({
      data: { id, orgId: f.orgA.id, name: id, short: 'P', descriptor: '', stage: 'x', siteCode: 'P', projStart: 'a', projEnd: 'b', elapsedPct: 0, todayDay: 0, milestonePct: 0, timeZone: 'Asia/Kolkata', scheduleStartDate: new Date('2026-06-01T00:00:00.000Z') },
    });
    await t.prisma.membership.create({ data: { projectId: id, userId: f.memberUser.id, role: 'pmc', status: 'active' } });
    return id;
  };
  const freshActivity = async (projectId: string): Promise<string> => {
    const id = `IT-P57BIA-ACT-${Date.now() % 1e6}-${seq++}`;
    await t.prisma.activity.create({ data: { id, projectId, name: `Act ${seq}`, zone: 'Zone 1', plannedStart: 0, plannedEnd: 10 } });
    return id;
  };
  const enableCommercial = (projectId: string) =>
    activation.activate(projectId, f.memberUser.id, {
      costHeads: [{ code: 'CIVIL', name: 'Civil works' }], materialLines: [], labourLines: [], reason: 'pilot activation',
    });

  /** requirement → approved comparison → DRAFT material PO. The shortest path to a command that
   *  attributes a commitment, which is what makes the participant announce money on a FOREIGN
   *  command's transaction. */
  const draftPo = async (projectId: string, activityId: string): Promise<{ poId: string; poLineId: string }> => {
    const input: CreateRequirementInput = {
      activityId, materialCategory: 'Cement', make: 'UltraTech', grade: 'OPC 53', attributes: 'grey',
      baseUom: 'bag', qty: '100', requiredBy: '2026-08-15', criticality: 'normal', decisionId: null,
      responsibleId: null, tolerance: null,
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
      lines: [{ requisitionLineId: lineId, baseRate: '1', taxAmount: '0', freightAmount: '0', landedCost: '999.99', quotedMake: 'make', matchesSpecification: true }],
    }, pmc(projectId));
    const quoteId = withQuote.quotes.find((q) => q.status === 'recorded')!.id;
    await procurement.createComparison(projectId, rfq.id, pmc(projectId));
    const approved = await procurement.approveComparison(projectId, rfq.id, { selectedQuoteId: quoteId, reason: 'single quote, in spec' }, pmc(projectId));
    const po = await pos.create(projectId, { comparisonId: approved.comparison!.id, lines: [{ requisitionLineId: lineId, purchaseQty: '100' }] }, pmc(projectId));
    const poLine = await t.prisma.purchaseOrderLine.findFirstOrThrow({ where: { projectId, requisitionLineId: lineId } });
    return { poId: po.id, poLineId: poLine.id };
  };

  /**
   * The socket delivery rows for the project's `commercial.money_moved` event(s), optionally
   * narrowed to one announcement `reason`.
   *
   * The narrowing matters: §L activation announces too, on a raw operator transaction that
   * deliberately leaves its delivery to the relay (probe 2). Asserting over every money delivery
   * on the project would mix the operator path into a probe about the command path.
   */
  const moneyDeliveries = async (projectId: string, reason?: string) => {
    const events = await t.prisma.domainEvent.findMany({
      where: {
        projectId, eventType: COMMERCIAL_MONEY_EVENT,
        ...(reason ? { payload: { path: ['reason'], equals: reason } } : {}),
      },
      select: { eventId: true }, orderBy: { streamPosition: 'asc' },
    });
    return t.prisma.outboxDelivery.findMany({
      where: { eventId: { in: events.map((e) => e.eventId) }, consumer: SOCKET_CONSUMER },
      select: { deliveryAction: true, status: true },
    });
  };

  // ── 1 — the drain: an event emitted BELOW `run` reaches the command's events ──────────────────

  it('1: an event a HELPER emits, whose meta no caller returns, still reaches outcome.events', async () => {
    const projectId = await freshProject();
    const actor: Actor = { actorId: f.memberUser.id, actorName: 'Priya (PMC)', actorRole: 'pmc', actorKind: 'human' };

    // The exact shape the commercial services have: the emit happens in a callee, the meta is
    // discarded there, and `run` returns `events: []` because it has nothing to return.
    const announceFromAHelper = async (tx: Parameters<typeof emitEvent>[0]) => {
      await emitEvent(tx, {
        projectId, actor, eventType: COMMERCIAL_MONEY_EVENT, entityType: 'Project', entityId: projectId,
        payload: { costHeadCodes: ['CIVIL'], reason: 'probe' }, effectKey: COMMERCIAL_MONEY_EVENT, dispatch: {},
      });
    };

    const outcome = await executeCommand(t.prisma, {
      scope: { scopeKind: 'project', projectId }, actor, commandType: 'probe.drain',
      idempotencyKey: `drain-${seq++}`, requestHash: hashRequest({ projectId }),
      run: async (tx) => {
        await announceFromAHelper(tx);
        return { resultRef: projectId, events: [] };
      },
    });

    // RED before 7B-i-a: `events` is [] — `run` returned nothing and nobody asked the transaction.
    expect(
      outcome.events.map((e) => e.eventType),
      'the command emitted an event and reported none — a caller cannot dispatch what it was not told about',
    ).toEqual([COMMERCIAL_MONEY_EVENT]);
    expect(outcome.events[0]!.projectId).toBe(projectId);
  });

  // ── 2 — the drain is OPT-IN, so a non-command transaction is untouched ────────────────────────

  it('2: a raw prisma.$transaction is NOT collected — a rebuild does not become a command', async () => {
    const projectId = await freshProject();
    const actor: Actor = { actorId: f.memberUser.id, actorName: 'Priya (PMC)', actorRole: 'pmc', actorKind: 'human' };

    await t.prisma.$transaction(async (tx) => {
      await emitEvent(tx, {
        projectId, actor, eventType: COMMERCIAL_MONEY_EVENT, entityType: 'Project', entityId: projectId,
        payload: { costHeadCodes: ['CIVIL'], reason: 'operator_sweep' }, effectKey: COMMERCIAL_MONEY_EVENT, dispatch: {},
      });
    });

    // The durable delivery exists (that never depended on the registry) and nothing dispatched it —
    // the relay is the sender for a process with no request and no socket audience. If the drain
    // had been made global rather than opt-in, this would read `succeeded`.
    const rows = await moneyDeliveries(projectId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.deliveryAction, 'the flag is what makes this a real delivery').toBe('dispatch');
    expect(rows[0]!.status, 'a raw transaction is not a command — nothing should have dispatched it').toBe('pending');
  });

  // ── 3 — a commercial-only write invalidates every open tab ────────────────────────────────────

  it('3: commercial.budget.set sends the socket ping and leaves no un-sent money delivery', async () => {
    const projectId = await freshProject();
    await enableCommercial(projectId);
    const changed = vi.spyOn(realtime, 'emitChanged').mockImplementation(() => {});

    await budget.setBudget(projectId, { costHeadCode: 'CIVIL', amount: '500', reason: 'sanctioned' }, pmc(projectId), `bud-${seq++}`);

    // RED before 7B-i-a on BOTH halves: with `invalidate: false` the delivery is a recorded `noop`
    // and nothing pings; with the flag flipped but no drain it is `dispatch` + `pending` — the
    // relay's recovery claim holds it for the lease window, and under
    // OUTBOX_RELAY_AUTOSTART=false it is never sent at all.
    const rows = await moneyDeliveries(projectId, 'budget_revision');
    expect(rows.length, 'the budget revision announced money').toBeGreaterThan(0);
    for (const r of rows) {
      expect(r.deliveryAction, 'commercial.money_moved must be a real external effect').toBe('dispatch');
      expect(r.status, 'the command committed and did not send its own invalidation').toBe('succeeded');
    }
    expect(changed, 'an open Commercial tab was never told the money moved').toHaveBeenCalledWith(projectId);
  });

  // ── 4 — a foreign command carries it in the SAME batch: one ping, not two ─────────────────────

  it('4: a procurement command dispatches the money event in its own batch — exactly one ping', async () => {
    const projectId = await freshProject();
    const activityId = await freshActivity(projectId);
    await capabilities.enable(projectId, MATERIALS_CAPABILITY, f.memberUser.id);
    await enableCommercial(projectId);
    const { poId, poLineId } = await draftPo(projectId, activityId);

    const changed = vi.spyOn(realtime, 'emitChanged').mockImplementation(() => {});
    // §C — issuance is where a PO version becomes live, so the head is an input to it and the
    // participant attributes the line inside THIS command's transaction. That is the frame the
    // money announcement is made in, several levels below anything `pos.issue` returns.
    await pos.issue(projectId, poId, { costHeads: [{ poLineId, costHeadCode: 'CIVIL' }] }, pmc(projectId), `iss-${seq++}`);

    // The money announcement rode the procurement command's transaction, so it must ride its
    // dispatch too. RED with the flag flipped but no drain: `pending`, swept minutes later.
    const rows = await moneyDeliveries(projectId, 'commitment');
    expect(rows.length, 'issuing an attributed PO moved headroom').toBeGreaterThan(0);
    for (const r of rows) expect(r.status, 'the money delivery was left for the relay').toBe('succeeded');

    // …and ONE ping for the project, not one per invalidating event. That dedup only works because
    // both events are in the same `dispatchCommitted` batch, which is the drain's doing.
    const forProject = changed.mock.calls.filter(([p]) => p === projectId);
    expect(forProject.length, 'two invalidating events in one command produced two socket pings').toBe(1);
  });

  // ── 5 — a replay is not a second effect ──────────────────────────────────────────────────────

  it('5: replaying a commercial command under the same key pings nobody a second time', async () => {
    const projectId = await freshProject();
    await enableCommercial(projectId);
    const key = `replay-${seq++}`;

    await commercial.defineCostHead(projectId, { code: 'MEP', name: 'MEP' }, pmc(projectId), key);
    const before = await moneyDeliveries(projectId);

    const changed = vi.spyOn(realtime, 'emitChanged').mockImplementation(() => {});
    await commercial.defineCostHead(projectId, { code: 'MEP', name: 'MEP' }, pmc(projectId), key);

    expect(changed, 'a replay re-emitted nothing, so it had nothing to send').not.toHaveBeenCalled();
    expect(await moneyDeliveries(projectId), 'a replay appended no delivery').toHaveLength(before.length);
  });
});
