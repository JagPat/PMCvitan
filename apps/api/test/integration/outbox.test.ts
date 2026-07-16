import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { createTestApp, type TestApp } from './test-app';
import { createTwoProjectFixture, type TwoProjectFixture } from './fixtures';
import { emitEvent } from '../../src/platform/events';
import { OutboxRelay } from '../../src/platform/outbox/relay.service';
import { OutboxOperationsService } from '../../src/platform/outbox/outbox-operations.service';
import { OutboxBootstrap } from '../../src/platform/outbox/outbox.bootstrap';
import { registerConsumer, unregisterConsumer, getConsumer, syncConsumerCatalog, type OutboxConsumer } from '../../src/platform/outbox/registry';
import { SOCKET_CONSUMER, PUSH_CONSUMER, makeSocketConsumer, makePushConsumer } from '../../src/platform/outbox/consumers';
import { effectCoverageVersion } from '../../src/platform/external-effects';
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
    t.prisma.$transaction((tx) => emitEvent(tx, { projectId, actor: human, eventType: 'decision.approved', entityType: 'Decision', entityId, effectKey: 'decision.approved', dispatch: {}, ...over }));

  const deliveryFor = (consumer: string, eventId: string) =>
    t.prisma.outboxDelivery.findFirstOrThrow({ where: { consumer, eventId } });
  const projectionEffects = (projectId: string) =>
    t.prisma.auditLog.count({ where: { action: 'test.projection', projectId } });

  it('materializes one delivery per registered consumer IN the event transaction; a rolled-back emit writes none', async () => {
    const p = await freshProject();
    // a published-decision event carries a push whose roles come from the catalog (['client'])
    const { eventId } = await emit(p, 'D-1', { eventType: 'decision.published', effectKey: 'decision.published', dispatch: { push: { body: 'hello' } } });
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
      await emitEvent(tx, { projectId: p, actor: human, eventType: 'decision.approved', entityType: 'Decision', entityId: 'D-rb', effectKey: 'decision.approved', dispatch: {} });
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

  // ── PR C fix-forward: lease-coordinated external senders (mixed-mode safe + legacy at-least-once) ──
  it('legacy mode: the relay LEAVES a fresh external delivery to the immediate dispatcher (does not claim a recent first attempt)', async () => {
    const p = await freshProject();
    const { eventId } = await emit(p, 'D-fresh'); // decision.approved invalidates → a pending socket delivery
    const socket = await deliveryFor(SOCKET_CONSUMER, eventId);
    expect(socket.status).toBe('pending');
    await relay.runOnce(); // legacy: the relay owns only retries/recovery — a fresh row is the dispatcher's
    expect((await t.prisma.outboxDelivery.findUniqueOrThrow({ where: { id: socket.id } })).status).toBe('pending');
  });

  it('legacy mode: the relay RETRIES a FAILED external delivery (at-least-once — a dropped provider attempt is re-sent)', async () => {
    const p = await freshProject();
    const { eventId } = await emit(p, 'D-extretry');
    const socket = await deliveryFor(SOCKET_CONSUMER, eventId);
    // simulate a failed immediate attempt: attempts=1, back to pending, now due
    await t.prisma.outboxDelivery.update({ where: { id: socket.id }, data: { attempts: 1, nextAttemptAt: new Date(Date.now() - 1000) } });
    await relay.runOnce(); // legacy: a due retry IS the relay's — it claims + re-sends → succeeded
    expect((await t.prisma.outboxDelivery.findUniqueOrThrow({ where: { id: socket.id } })).status).toBe('succeeded');
  });

  it('legacy mode: the relay RECOVERS a stranded fresh external delivery the dispatcher never reached (older than the lease window)', async () => {
    const p = await freshProject();
    const { eventId } = await emit(p, 'D-stranded');
    const socket = await deliveryFor(SOCKET_CONSUMER, eventId);
    // simulate a crash/DB-blip between commit and immediate dispatch: still pending, attempts=0, but stale
    await t.prisma.$executeRawUnsafe(`UPDATE "OutboxDelivery" SET "updatedAt" = now() - interval '5 minutes' WHERE "id" = $1`, socket.id);
    await relay.runOnce();
    expect((await t.prisma.outboxDelivery.findUniqueOrThrow({ where: { id: socket.id } })).status).toBe('succeeded');
  });

  it('claimOne is an atomic single-winner: the first caller wins the lease, a second loses (mixed-mode double-send guard)', async () => {
    const p = await freshProject();
    const { eventId } = await emit(p, 'D-claim');
    const socket = await deliveryFor(SOCKET_CONSUMER, eventId);
    expect(await relay.claimOne(socket.id)).toBe(true); // the dispatcher wins
    expect(await relay.claimOne(socket.id)).toBe(false); // a racing outbox-mode relay loses — no second sender
    expect((await t.prisma.outboxDelivery.findUniqueOrThrow({ where: { id: socket.id } })).status).toBe('leased');
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
 * PR C Task 2 — the external outbox consumers are now the SOLE senders: a consumer SENDS whenever
 * its `handle` is invoked, in EVERY mode. Exactly-one-sender is enforced BEFORE invocation — the
 * immediate {@link ExternalEffectDispatcher} invokes them in `legacy`/`shadow`, the background relay
 * in `outbox`, never both (see external-effect-dispatcher.test.ts + the relay's runOnce gate). The
 * old in-request `notifyChanged` is gone.
 */
describe('PR C Task 2 — the outbox consumers are the sole senders (unit)', () => {
  const modes = ['legacy', 'shadow', 'outbox'] as const;

  const meta = { eventId: 'e', eventType: 'decision.approved', projectId: 'p', organizationId: 'o', streamPosition: 0n, entityType: 'Decision', entityId: 'D', payload: null, dispatchIntent: { effectKey: 'decision.approved', coverageVersion: 'v', invalidate: true, push: { body: 'b', roles: ['client'] } } };

  it.each(modes)('the socket + push consumers SEND whenever handle() is invoked — mode-independent (mode=%s)', async (mode) => {
    process.env.OUTBOX_SENDER_MODE = mode;
    try {
      const emitChanged = vi.fn();
      const notifyProject = vi.fn(async () => {});
      const socket = makeSocketConsumer({ emitChanged } as never);
      const push = makePushConsumer({ notifyProject } as never);
      const dispatch = { delivery: { id: 'd', consumer: '', projectId: 'p', streamPosition: 0n, payload: { body: 'b', roles: ['client'] } }, meta, senderMode: mode };
      await socket.handle(dispatch as never);
      await push.handle(dispatch as never);
      // WHO invokes handle is gated by mode+lease elsewhere; the handle itself always sends once.
      expect(emitChanged).toHaveBeenCalledTimes(1);
      expect(notifyProject).toHaveBeenCalledTimes(1);
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

/**
 * PR C Task 3 — the audited external-effect cutover SEAL, proven against live PostgreSQL.
 *
 * The seal is a FORWARD gate: it pins the compiled coverage version, neutralizes the pre-cutover
 * external deliveries (never deleting a row or payload), and — once present — makes outbox-mode
 * startup require that exact coverage and the DB reject any future null-intent event. Step-1 probes.
 */
describe('PR C Task 3 — external-effect cutover seal (live PG)', () => {
  let t: TestApp;
  let f: TwoProjectFixture;
  let ops: OutboxOperationsService;
  let boot: OutboxBootstrap;
  let projSeq = 0;

  beforeAll(async () => {
    t = await createTestApp();
    f = await createTwoProjectFixture(t.prisma);
    ops = t.app.get(OutboxOperationsService);
    boot = t.app.get(OutboxBootstrap);
  });
  afterAll(async () => {
    await t?.prisma.$executeRawUnsafe('DELETE FROM "OutboxCutoverState"');
    await t?.prisma.$executeRawUnsafe('TRUNCATE TABLE "DomainEvent", "OutboxDelivery", "ProcessedEvent", "ProjectionCursor"');
    await f?.cleanup();
    await t?.close();
  });
  afterEach(async () => {
    delete process.env.OUTBOX_SENDER_MODE;
    // The seal is a singleton whose presence arms the null-intent trigger — always clear it so a
    // later test's raw legacy insert is not spuriously rejected.
    await t.prisma.$executeRawUnsafe('DELETE FROM "OutboxCutoverState"');
    await t.prisma.$executeRawUnsafe('TRUNCATE TABLE "DomainEvent", "OutboxDelivery", "ProcessedEvent", "ProjectionCursor"');
    await t.prisma.outboxOperatorAction.deleteMany({ where: { action: 'seal-external' } });
    await t.prisma.project.deleteMany({ where: { id: { startsWith: 'it-seal-' } } });
  });

  const freshProject = async (): Promise<string> => {
    const id = `it-seal-${Date.now() % 1e6}-${projSeq++}`;
    await t.prisma.project.create({
      data: { id, orgId: f.orgA.id, name: id, short: 'O', descriptor: '', stage: 'x', siteCode: 'O', projStart: 'a', projEnd: 'b', elapsedPct: 0, todayDay: 0, milestonePct: 0 },
    });
    return id;
  };

  /** Raw-insert a pre-cutover DomainEvent (null or a given coverage) with BOTH external deliveries —
   *  the socket delivery in the given `status` (the seal's target), and the push delivery as an
   *  already-`noop`/`succeeded` row (so the seal's gap check sees no missing consumer). Bypasses
   *  emitEvent so we can pin exactly the legacy shapes the seal must neutralize / leave alone. */
  const rawEventWithSocketDelivery = async (
    projectId: string, evId: string, delId: string, pos: number,
    coverage: string | null, status: 'pending' | 'leased' = 'pending', payload = '{"legacy":"body"}',
  ): Promise<void> => {
    const intent = coverage === null ? 'NULL' : `'${JSON.stringify({ effectKey: 'compat.task6', coverageVersion: coverage, invalidate: true })}'::jsonb`;
    await t.prisma.$executeRawUnsafe(
      `INSERT INTO "DomainEvent" ("eventId","eventType","payloadVersion","organizationId","projectId","streamPosition","actorKind","systemActor","entityType","entityId","dispatchIntent") ` +
      `VALUES ('${evId}','decision.approved',1,'${f.orgA.id}','${projectId}',${pos},'system','system:seed','Decision','D',${intent})`,
    );
    const leaseCols = status === 'leased' ? ',"leaseOwner","leaseExpiresAt"' : '';
    const leaseVals = status === 'leased' ? ", 'sender-x', now() + interval '30 seconds'" : '';
    await t.prisma.$executeRawUnsafe(
      `INSERT INTO "OutboxDelivery" ("id","eventId","projectId","consumer","consumerKind","deliveryAction","streamPosition","status","payload","updatedAt"${leaseCols}) ` +
      `VALUES ('${delId}','${evId}','${projectId}','socket.invalidation','unordered','dispatch',${pos},'${status}','${payload}'::jsonb, now()${leaseVals})`,
    );
    // the push delivery is a recorded no-op (a compat/legacy event carries no push) — present so the
    // seal's gap check sees every active external consumer covered for this event.
    await t.prisma.$executeRawUnsafe(
      `INSERT INTO "OutboxDelivery" ("id","eventId","projectId","consumer","consumerKind","deliveryAction","streamPosition","status","updatedAt") ` +
      `VALUES ('${delId}-push','${evId}','${projectId}','webpush.notify','unordered','noop',${pos},'succeeded', now())`,
    );
  };

  const seal = () => ops.sealExternal({ operatorIdentity: 'ops@vitan.in', reason: 'cutover' });

  it('the seal is REFUSED in outbox mode — outbox needs an existing seal to start, so it cannot mint the first one', async () => {
    process.env.OUTBOX_SENDER_MODE = 'outbox';
    await expect(seal()).rejects.toThrow(/legacy or shadow mode/);
    expect(await t.prisma.outboxCutoverState.findUnique({ where: { key: 'singleton' } })).toBeNull();
  });

  it('startup GATE: outbox mode is blocked when no seal exists', async () => {
    process.env.OUTBOX_SENDER_MODE = 'outbox';
    await expect(boot.onModuleInit()).rejects.toThrow(/requires an external-effect cutover seal/);
  });

  it('startup GATE: outbox mode is blocked when the seal coverage is STALE (≠ compiled catalog)', async () => {
    await t.prisma.outboxCutoverState.create({ data: { key: 'singleton', coverageVersion: 'stale-coverage', sealedBy: 'ops', reason: 'x' } });
    process.env.OUTBOX_SENDER_MODE = 'outbox';
    await expect(boot.onModuleInit()).rejects.toThrow(/!= compiled catalog/);
  });

  it('startup GATE: outbox mode STARTS when the seal coverage equals the compiled catalog', async () => {
    await seal(); // legacy mode (default) — pins the compiled coverage
    expect((await t.prisma.outboxCutoverState.findUniqueOrThrow({ where: { key: 'singleton' } })).coverageVersion).toBe(effectCoverageVersion());
    process.env.OUTBOX_SENDER_MODE = 'outbox';
    await expect(boot.onModuleInit()).resolves.toBeUndefined();
  });

  it('the seal NEUTRALIZES a non-current-coverage pending external delivery (noop/succeeded, payload preserved) and LEAVES a current-coverage one alone', async () => {
    const p = await freshProject();
    // a PR-B compat delivery (old coverage) — must be neutralized
    await rawEventWithSocketDelivery(p, 'seal-old-ev', 'seal-old-del', 100, 'compat-old', 'pending', '{"old":"push"}');
    // a current-coverage delivery — must be LEFT pending (the relay will send it in outbox mode)
    await rawEventWithSocketDelivery(p, 'seal-cur-ev', 'seal-cur-del', 101, effectCoverageVersion(), 'pending', '{"cur":"push"}');

    const res = await seal();
    expect(res.neutralized).toBe(1);
    expect(res.coverageVersion).toBe(effectCoverageVersion());

    const old = await t.prisma.outboxDelivery.findUniqueOrThrow({ where: { id: 'seal-old-del' } });
    expect(old.status).toBe('succeeded');
    expect(old.deliveryAction).toBe('noop');
    expect(old.payload, 'the historical push body is PRESERVED, never cleared').toEqual({ old: 'push' });
    // rows and events are never deleted
    expect(await t.prisma.domainEvent.count({ where: { projectId: p } })).toBe(2);

    const cur = await t.prisma.outboxDelivery.findUniqueOrThrow({ where: { id: 'seal-cur-del' } });
    expect(cur.status, 'a current-coverage delivery is not neutralized').toBe('pending');
    expect(cur.deliveryAction).toBe('dispatch');
  });

  it('the seal ABORTS (no state change) when a legacy target delivery is LEASED by a sender', async () => {
    const p = await freshProject();
    await rawEventWithSocketDelivery(p, 'seal-leased-ev', 'seal-leased-del', 200, 'compat-old', 'leased');
    await expect(seal()).rejects.toThrow(/leased by a sender/);
    // nothing changed — no seal row, the leased delivery is untouched
    expect(await t.prisma.outboxCutoverState.findUnique({ where: { key: 'singleton' } })).toBeNull();
    expect((await t.prisma.outboxDelivery.findUniqueOrThrow({ where: { id: 'seal-leased-del' } })).status).toBe('leased');
  });

  it('after the seal the DB trigger REJECTS a null-intent event, but ACCEPTS a valid current-intent event', async () => {
    const p = await freshProject();
    await seal();
    const intent = JSON.stringify({ effectKey: 'decision.approved', coverageVersion: effectCoverageVersion(), invalidate: true });
    // null intent → refused by the seal trigger
    await expect(
      t.prisma.$executeRawUnsafe(
        `INSERT INTO "DomainEvent" ("eventId","eventType","payloadVersion","organizationId","projectId","streamPosition","actorKind","systemActor","entityType","entityId") ` +
        `VALUES ('seal-null-after','decision.approved',1,'${f.orgA.id}','${p}',300,'system','system:seed','Decision','D')`,
      ),
    ).rejects.toThrow(/cutover is sealed/);
    // a valid current-intent event still commits
    await t.prisma.$executeRawUnsafe(
      `INSERT INTO "DomainEvent" ("eventId","eventType","payloadVersion","organizationId","projectId","streamPosition","actorKind","systemActor","entityType","entityId","dispatchIntent") ` +
      `VALUES ('seal-ok-after','decision.approved',1,'${f.orgA.id}','${p}',301,'system','system:seed','Decision','D','${intent}'::jsonb)`,
    );
    expect(await t.prisma.domainEvent.findUnique({ where: { eventId: 'seal-ok-after' } })).not.toBeNull();
  });

  it('the seal requires an operator identity and a reason (audited action)', async () => {
    await expect(ops.sealExternal({ operatorIdentity: '', reason: 'x' })).rejects.toThrow(/operator identity/);
    await expect(ops.sealExternal({ operatorIdentity: 'ops', reason: '' })).rejects.toThrow(/reason/);
  });
});
