import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { createTestApp, type TestApp } from './test-app';
import { createTwoProjectFixture, type TwoProjectFixture } from './fixtures';
import { emitEvent } from '../../src/platform/events';
import { OutboxRelay } from '../../src/platform/outbox/relay.service';
import { RealtimeGateway } from '../../src/realtime/realtime.gateway';
import { registerConsumer, unregisterConsumer, getConsumer, syncConsumerCatalog, type OutboxConsumer } from '../../src/platform/outbox/registry';
import { SOCKET_CONSUMER, PUSH_CONSUMER, makeSocketConsumer, makePushConsumer } from '../../src/platform/outbox/consumers';
import type { Actor } from '../../src/common/actor';

/**
 * Phase 2 Task 6 — the per-consumer transactional outbox, proven against live PostgreSQL.
 *
 * Deliveries commit in the event's transaction; a lease relay dispatches with backoff and
 * dead-letters on exhaustion; a database consumer is effectively-once (ProcessedEvent) and its
 * ordered cursor advances CONTIGUOUSLY (N+1 waits for N; a dead earlier position blocks, never
 * skips); external senders are exactly-one across the legacy→cutover modes. Step-1 probes.
 */

const PROJECTION = 'test.projection';
const human: Actor = { actorId: '', actorName: 'Priya (PMC)', actorRole: 'pmc', actorKind: 'human' };

describe('Phase 2 Task 6 — transactional outbox (live PG)', () => {
  let t: TestApp;
  let f: TwoProjectFixture;
  let relay: OutboxRelay;
  let projSeq = 0;

  // A deterministic failure control (NOT vi.spyOn — spying the shared consumer object leaks a
  // throwing handle into later serial tests). Each test sets it; afterEach resets it.
  const control = { failMode: 'none' as 'none' | 'once' | 'always' };

  /** An ordered database consumer whose side effect is one AuditLog row per event, so
   *  "applied exactly once" is a row count and its ordered cursor can be observed directly. */
  const orderedConsumer: OutboxConsumer = {
    name: PROJECTION, kind: 'ordered', effect: 'db', catalogVersion: 1,
    deliveryFor: () => ({ action: 'dispatch' }),
    handle: async (ctx) => {
      if (control.failMode !== 'none') {
        if (control.failMode === 'once') control.failMode = 'none';
        throw new Error('projection apply failed');
      }
      if (!ctx.tx) throw new Error('ordered consumer needs a tx');
      await ctx.tx.auditLog.create({ data: { projectId: ctx.meta.projectId, actor: 'proj', actorId: 'proj', actorRole: 'system', action: 'test.projection', entity: 'Ev', entityId: ctx.meta.eventId } });
    },
  };

  beforeAll(async () => {
    t = await createTestApp();
    f = await createTwoProjectFixture(t.prisma);
    relay = t.app.get(OutboxRelay);
    human.actorId = f.memberUser.id;
    registerConsumer(orderedConsumer);
    // The ad-hoc ordered projection consumer needs its catalog contract row before it can own
    // deliveries (the (consumer, consumerKind) FK) — bootstrap synced only socket/push.
    await syncConsumerCatalog(t.prisma);
  });
  afterAll(async () => {
    unregisterConsumer(PROJECTION);
    await t?.prisma.$executeRawUnsafe('TRUNCATE TABLE "DomainEvent", "OutboxDelivery", "ProcessedEvent", "ProjectionCursor"');
    await f?.cleanup();
    await t?.close();
  });
  afterEach(async () => {
    control.failMode = 'none';
    // truncate the event store too, so the fresh per-test projects can then be deleted (their
    // DomainEvents' RESTRICT tenant FK would otherwise block it), keeping orgA deletable in afterAll
    await t.prisma.$executeRawUnsafe('TRUNCATE TABLE "DomainEvent", "OutboxDelivery", "ProcessedEvent", "ProjectionCursor"');
    await t.prisma.auditLog.deleteMany({ where: { action: 'test.projection' } });
    await t.prisma.project.deleteMany({ where: { id: { startsWith: 'it-obx-' } } });
  });

  /** A fresh project in orgA whose event stream starts at position 0 (so ordered positions are 0,1,2…). */
  const freshProject = async (): Promise<string> => {
    const id = `it-obx-${Date.now() % 1e6}-${projSeq++}`;
    await t.prisma.project.create({
      data: { id, orgId: f.orgA.id, name: id, short: 'O', descriptor: '', stage: 'x', siteCode: 'O', projStart: 'a', projEnd: 'b', elapsedPct: 0, todayDay: 0, milestonePct: 0 },
    });
    return id;
  };

  const emit = (projectId: string, entityId: string, over: Record<string, unknown> = {}) =>
    t.prisma.$transaction((tx) => emitEvent(tx, { projectId, actor: human, eventType: 'decision.approved', entityType: 'Decision', entityId, ...over }));

  const deliveryFor = (consumer: string, eventId: string) =>
    t.prisma.outboxDelivery.findFirstOrThrow({ where: { consumer, eventId } });
  const projectionEffects = (projectId: string) =>
    t.prisma.auditLog.count({ where: { action: 'test.projection', projectId } });

  it('materializes one delivery per registered consumer IN the event transaction; a rolled-back emit writes none', async () => {
    const p = await freshProject();
    const { eventId } = await emit(p, 'D-1', { notification: { body: 'hello', roles: ['client'] } });
    // socket (always), push (notification present) and the ordered projection each got a row
    const socket = await deliveryFor(SOCKET_CONSUMER, eventId);
    const push = await deliveryFor(PUSH_CONSUMER, eventId);
    const proj = await deliveryFor(PROJECTION, eventId);
    expect(socket.status).toBe('pending');
    expect(socket.consumerKind).toBe('unordered');
    expect(proj.consumerKind).toBe('ordered');
    expect(push.payload).toEqual({ body: 'hello', roles: ['client'] });
    expect(proj.streamPosition).toBe(0n);

    // a rolled-back mutation writes NO event AND NO deliveries — they share the transaction
    await expect(t.prisma.$transaction(async (tx) => {
      await emitEvent(tx, { projectId: p, actor: human, eventType: 'decision.approved', entityType: 'Decision', entityId: 'D-rb' });
      throw new Error('boom');
    })).rejects.toThrow('boom');
    expect(await t.prisma.outboxDelivery.count({ where: { projectId: p, eventId: { not: eventId } } })).toBe(0);
  });

  it('a plain unordered external delivery dispatches to succeeded (no send in legacy mode) and is idempotent under a duplicate', async () => {
    const p = await freshProject();
    const { eventId } = await emit(p, 'D-sock');
    const socket = await deliveryFor(SOCKET_CONSUMER, eventId);
    expect(await relay.dispatchOne(socket.id)).toBe('succeeded');
    expect((await t.prisma.outboxDelivery.findUniqueOrThrow({ where: { id: socket.id } })).status).toBe('succeeded');
    // a duplicate invalidation is harmless — dispatching an already-succeeded row is a no-op skip
    expect(await relay.dispatchOne(socket.id)).toBe('skip');
  });

  it('an ordered database consumer applies its projection + ProcessedEvent atomically; a duplicate dispatch is effectively-once', async () => {
    const p = await freshProject();
    const { eventId } = await emit(p, 'D-once');
    const d = await deliveryFor(PROJECTION, eventId);
    expect(await relay.dispatchOne(d.id)).toBe('succeeded');
    expect(await projectionEffects(p)).toBe(1);
    expect(await t.prisma.processedEvent.count({ where: { consumer: PROJECTION, eventId } })).toBe(1);
    const cursor = await t.prisma.projectionCursor.findUniqueOrThrow({ where: { consumer_projectId: { consumer: PROJECTION, projectId: p } } });
    expect(cursor.appliedPosition).toBe(0n);
    // simulate a crash AFTER the apply committed but BEFORE the row was marked succeeded: the row
    // is reclaimed as pending and re-dispatched → the ProcessedEvent/cursor guard makes it a
    // duplicate, so NO second effect (effectively-once).
    await t.prisma.outboxDelivery.update({ where: { id: d.id }, data: { status: 'pending' } });
    expect(await relay.dispatchOne(d.id)).toBe('duplicate');
    expect(await projectionEffects(p)).toBe(1);
  });

  it('a retryable failure returns the row to pending with backoff (attempts++); the next dispatch applies it — one effect', async () => {
    const p = await freshProject();
    const { eventId } = await emit(p, 'D-retry');
    const d = await deliveryFor(PROJECTION, eventId);
    // make the FIRST apply throw, then succeed
    control.failMode = 'once';
    expect(await relay.dispatchOne(d.id)).toBe('retry');
    const afterFail = await t.prisma.outboxDelivery.findUniqueOrThrow({ where: { id: d.id } });
    expect(afterFail.status).toBe('pending');
    expect(afterFail.attempts).toBe(1);
    expect(afterFail.lastError).toContain('projection apply failed');
    expect(await projectionEffects(p)).toBe(0); // the failed apply rolled back — no effect, no ProcessedEvent
    expect(await t.prisma.processedEvent.count({ where: { consumer: PROJECTION, eventId } })).toBe(0);
    expect(await relay.dispatchOne(d.id)).toBe('succeeded'); // control auto-reset after the one failure
    expect(await projectionEffects(p)).toBe(1);
  });

  it('a delivery that keeps failing exhausts its retries and DEAD-letters, without touching another consumer', async () => {
    const p = await freshProject();
    const { eventId } = await emit(p, 'D-dead');
    const proj = await deliveryFor(PROJECTION, eventId);
    const socket = await deliveryFor(SOCKET_CONSUMER, eventId);
    control.failMode = 'always';
    let last = '';
    for (let i = 0; i < 6 && last !== 'dead'; i++) last = await relay.dispatchOne(proj.id);
    expect(last).toBe('dead');
    const dead = await t.prisma.outboxDelivery.findUniqueOrThrow({ where: { id: proj.id } });
    expect(dead.status).toBe('dead');
    expect(dead.attempts).toBe(5);
    control.failMode = 'none';
    // the OTHER consumer on the SAME event is unaffected — its failure/exhaustion never masked it
    expect(await relay.dispatchOne(socket.id)).toBe('succeeded');
  });

  it('the claim reclaims a stale lease (an expired `leased` row is due again)', async () => {
    const p = await freshProject();
    const { eventId } = await emit(p, 'D-lease');
    const proj = await deliveryFor(PROJECTION, eventId);
    // simulate a worker that leased then died: leased, but the lease already expired
    await t.prisma.outboxDelivery.update({ where: { id: proj.id }, data: { status: 'leased', leaseOwner: 'dead-worker', leaseExpiresAt: new Date(Date.now() - 60_000) } });
    await relay.runOnce(); // a full pass reclaims + applies it
    expect((await t.prisma.outboxDelivery.findUniqueOrThrow({ where: { id: proj.id } })).status).toBe('succeeded');
    expect(await projectionEffects(p)).toBe(1);
  });

  it('an ordered consumer cannot apply position N+1 before N — it waits, and only advances contiguously', async () => {
    const p = await freshProject();
    const e0 = await emit(p, 'D-p0'); // streamPosition 0
    const e1 = await emit(p, 'D-p1'); // streamPosition 1
    const d0 = await deliveryFor(PROJECTION, e0.eventId);
    const d1 = await deliveryFor(PROJECTION, e1.eventId);

    // dispatch N+1 FIRST (as a racing worker would): it must WAIT, not skip
    expect(await relay.dispatchOne(d1.id)).toBe('wait');
    expect(await projectionEffects(p)).toBe(0);
    let cursor = await t.prisma.projectionCursor.findUnique({ where: { consumer_projectId: { consumer: PROJECTION, projectId: p } } });
    expect(cursor?.appliedPosition ?? null).toBeNull();

    // apply N, then N+1 can advance — contiguous
    expect(await relay.dispatchOne(d0.id)).toBe('succeeded');
    expect(await relay.dispatchOne(d1.id)).toBe('succeeded');
    cursor = await t.prisma.projectionCursor.findUniqueOrThrow({ where: { consumer_projectId: { consumer: PROJECTION, projectId: p } } });
    expect(cursor.appliedPosition).toBe(1n);
    expect(await projectionEffects(p)).toBe(2);
  });

  it('a DEAD earlier position BLOCKS the ordered cursor (visible degradation), never a silent skip past it', async () => {
    const p = await freshProject();
    const e0 = await emit(p, 'D-b0');
    const e1 = await emit(p, 'D-b1');
    const d0 = await deliveryFor(PROJECTION, e0.eventId);
    const d1 = await deliveryFor(PROJECTION, e1.eventId);
    // position 0 dead-lettered (operator-resolvable), position 1 still pending
    await t.prisma.outboxDelivery.update({ where: { id: d0.id }, data: { status: 'dead', attempts: 5, lastError: 'poison' } });

    expect(await relay.dispatchOne(d1.id)).toBe('blocked');
    const cursor = await t.prisma.projectionCursor.findUniqueOrThrow({ where: { consumer_projectId: { consumer: PROJECTION, projectId: p } } });
    expect(cursor.status).toBe('blocked');
    expect(await projectionEffects(p)).toBe(0); // position 1 was NOT applied over the dead 0
  });

  it('the pre-cutover backfill derives the missing delivery for an event that predates a consumer', async () => {
    const p = await freshProject();
    // an event whose PROJECTION delivery was never written (simulate a pre-consumer / crash-gap event)
    const { eventId } = await emit(p, 'D-backfill');
    await t.prisma.outboxDelivery.deleteMany({ where: { consumer: PROJECTION, eventId } });
    expect(await t.prisma.outboxDelivery.count({ where: { consumer: PROJECTION, eventId } })).toBe(0);

    const created = await relay.expandMissingDeliveries();
    expect(created).toBeGreaterThanOrEqual(1);
    const repaired = await deliveryFor(PROJECTION, eventId);
    expect(repaired.status).toBe('pending');
    expect(repaired.streamPosition).toBe(0n);
    // idempotent — a second backfill creates no duplicate (the unique (eventId, consumer) holds)
    await relay.expandMissingDeliveries();
    expect(await t.prisma.outboxDelivery.count({ where: { consumer: PROJECTION, eventId } })).toBe(1);
  });
});

/**
 * Exactly one external SENDER at all times across the cutover modes: the legacy in-request path
 * sends in `legacy`/`shadow` and the outbox consumers send only in `outbox` — never both.
 */
describe('Phase 2 Task 6 — exactly one external sender across the cutover (unit)', () => {
  const modes = ['legacy', 'shadow', 'outbox'] as const;

  const meta = { eventId: 'e', eventType: 'decision.approved', projectId: 'p', organizationId: 'o', streamPosition: 0n, entityType: 'Decision', entityId: 'D', payload: null };

  it.each(modes)('the in-request notifyChanged sends iff NOT outbox (mode=%s)', (mode) => {
    process.env.OUTBOX_SENDER_MODE = mode;
    try {
      const emit = vi.fn();
      const server = { to: vi.fn(() => ({ emit })) };
      const push = { notifyProject: vi.fn(async () => {}) };
      const gw = new RealtimeGateway(push as never);
      (gw as unknown as { server: unknown }).server = server;
      gw.notifyChanged('p', 'body', ['client']);
      const shouldSend = mode !== 'outbox';
      expect(emit).toHaveBeenCalledTimes(shouldSend ? 1 : 0);
      expect(push.notifyProject).toHaveBeenCalledTimes(shouldSend ? 1 : 0);
    } finally {
      delete process.env.OUTBOX_SENDER_MODE;
    }
  });

  it.each(modes)('the outbox socket + push consumers send iff outbox (mode=%s)', async (mode) => {
    process.env.OUTBOX_SENDER_MODE = mode;
    try {
      const emitChanged = vi.fn();
      const notifyProject = vi.fn(async () => {});
      const socket = makeSocketConsumer({ emitChanged, recordShadowIntent: vi.fn() } as never);
      const push = makePushConsumer({ notifyProject } as never);
      const dispatch = { delivery: { id: 'd', consumer: '', projectId: 'p', streamPosition: 0n, payload: { body: 'b', roles: ['client'] } }, meta, senderMode: mode };
      await socket.handle(dispatch as never);
      await push.handle(dispatch as never);
      const shouldSend = mode === 'outbox';
      expect(emitChanged).toHaveBeenCalledTimes(shouldSend ? 1 : 0);
      expect(notifyProject).toHaveBeenCalledTimes(shouldSend ? 1 : 0);
    } finally {
      delete process.env.OUTBOX_SENDER_MODE;
    }
  });

  it('the registered consumers are the socket + push externals (unordered)', () => {
    // registered by the app boot in the live-PG describe above (same process); assert their shape
    const socket = getConsumer(SOCKET_CONSUMER);
    const push = getConsumer(PUSH_CONSUMER);
    expect(socket?.kind).toBe('unordered');
    expect(socket?.effect).toBe('external');
    expect(push?.effect).toBe('external');
  });
});
