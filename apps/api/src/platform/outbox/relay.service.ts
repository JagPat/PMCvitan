import { Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma.service';
import { getConsumer, listConsumers, outboxSenderMode, type EmittedEventMeta, type OutboxConsumer } from './registry';

/**
 * Phase 2 Task 6 — the outbox relay.
 *
 * A lease-based dispatcher. Each pass CLAIMS due `pending` (or lease-expired `leased`) deliveries
 * for a consumer in a SHORT transaction (`FOR UPDATE SKIP LOCKED`, never a lock held across the
 * dispatch), then dispatches each OUTSIDE that lock:
 *   - an `external` consumer (socket/push) sends (only when `senderMode === 'outbox'`), then the
 *     row → `succeeded`; a throw backs off (`attempts++`, `nextAttemptAt`) or, when exhausted,
 *     dead-letters (`dead`). At-least-once.
 *   - an `ordered` `db` consumer applies its projection + its `ProcessedEvent` + its
 *     `ProjectionCursor` advance in ONE transaction (effectively-once). It advances the cursor
 *     CONTIGUOUSLY: position N+1 waits until N is applied; a `dead` earlier position sets the
 *     cursor `blocked` — visibly degraded, never a silent skip.
 *
 * The interval auto-runs only outside tests; tests drive `runOnce()` / `dispatchOne()` directly.
 */

const LEASE_SECONDS = 30;
const MAX_ATTEMPTS = 5;
/** Retry backoff by attempt count (seconds); a transient blip retries after 1s, then grows. */
const BACKOFF_SECONDS = [1, 5, 30, 120];
const CLAIM_BATCH = 50;

export type DispatchOutcome = 'succeeded' | 'duplicate' | 'wait' | 'blocked' | 'retry' | 'dead' | 'skip';

@Injectable()
export class OutboxRelay implements OnModuleDestroy {
  private readonly log = new Logger('OutboxRelay');
  private readonly owner = `relay-${process.pid}`;
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(private readonly prisma: PrismaService) {}

  /** Production: tick on an interval. Never in unit/integration tests (they drive runOnce/
   *  dispatchOne), and never when explicitly disabled (`OUTBOX_RELAY_AUTOSTART=false`, e.g. the
   *  browser acceptance suite, where the legacy path is the sole sender and a background relay is
   *  pure churn + timing variance). */
  start(intervalMs = 2000): void {
    if (this.timer || process.env.NODE_ENV === 'test' || process.env.OUTBOX_RELAY_AUTOSTART === 'false') return;
    this.timer = setInterval(() => {
      if (this.running) return;
      this.running = true;
      void this.runOnce()
        .catch((e) => this.log.warn(`relay pass failed: ${(e as Error).message}`))
        .finally(() => { this.running = false; });
    }, intervalMs);
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Drain all ACTIVE consumers until a full pass makes no further progress (bounded). */
  async runOnce(): Promise<void> {
    // Repair a bounded batch of missing delivery obligations FIRST (a newly-registered consumer, a
    // rolling-deploy gap where an old instance emitted an event, or a crash between event commit and
    // delivery creation) so the claim loop never misses a durable delivery. Idempotent +
    // concurrent-safe. Bounded per pass — a large backlog closes over successive ticks, never in one.
    await this.expandMissingDeliveries();
    // catalog.active is authoritative: a deactivated contract is never claimed (its pending rows stay
    // recoverable for reactivation). Read once per pass; the dispatch guard covers a mid-pass change.
    const active = await this.activeConsumerNames();
    // PR C Task 2 — the background relay owns EXTERNAL dispatch only in `outbox` mode. In
    // legacy/shadow the immediate ExternalEffectDispatcher is the sole external sender, so the relay
    // must not also claim external deliveries (that would be a second active sender). Ordered `db`
    // projection consumers are always the relay's to advance.
    const relayOwnsExternal = outboxSenderMode() === 'outbox';
    for (let guard = 0; guard < 1000; guard++) {
      let progressed = false;
      for (const consumer of listConsumers()) {
        if (!active.has(consumer.name)) continue; // deactivated contract — do not claim
        if (consumer.effect === 'external' && !relayOwnsExternal) continue; // dispatcher owns it
        const ids = await this.claim(consumer.name);
        for (const id of ids) {
          const outcome = await this.dispatchOne(id);
          if (outcome === 'succeeded' || outcome === 'duplicate' || outcome === 'dead' || outcome === 'retry') progressed = true;
        }
      }
      if (!progressed) return;
    }
  }

  /** The set of consumer names whose durable catalog contract is currently active. */
  private async activeConsumerNames(): Promise<Set<string>> {
    const rows = await this.prisma.outboxConsumerCatalog.findMany({ where: { active: true }, select: { consumer: true } });
    return new Set(rows.map((r) => r.consumer));
  }

  /** Atomically lease up to CLAIM_BATCH due deliveries for a consumer, in stream order. */
  private async claim(consumer: string): Promise<string[]> {
    const rows = await this.prisma.$queryRaw<{ id: string }[]>`
      UPDATE "OutboxDelivery" SET "status" = 'leased', "leaseOwner" = ${this.owner},
        "leaseExpiresAt" = now() + make_interval(secs => ${LEASE_SECONDS}), "updatedAt" = now()
      WHERE "id" IN (
        SELECT "id" FROM "OutboxDelivery"
        WHERE "consumer" = ${consumer}
          AND ("status" = 'pending' OR ("status" = 'leased' AND "leaseExpiresAt" < now()))
          AND "nextAttemptAt" <= now()
        ORDER BY "streamPosition" ASC
        LIMIT ${CLAIM_BATCH}
        FOR UPDATE SKIP LOCKED
      )
      RETURNING "id"`;
    return rows.map((r) => r.id);
  }

  /** Process ONE delivery row by id (respecting no lease/backoff gate — the relay's unit of work,
   *  and the deterministic entry point tests drive). Returns the outcome. */
  async dispatchOne(deliveryId: string): Promise<DispatchOutcome> {
    const delivery = await this.prisma.outboxDelivery.findUnique({ where: { id: deliveryId } });
    if (!delivery || delivery.status === 'succeeded' || delivery.status === 'dead') return 'skip';
    // catalog.active is authoritative and guards the claim→handle race: a contract deactivated after
    // this row was claimed is NOT processed — release the lease so the row stays `pending` and
    // recoverable on reactivation. Never dead-lettered (a deactivation is not a delivery failure).
    const cat = await this.prisma.outboxConsumerCatalog.findUnique({ where: { consumer: delivery.consumer }, select: { active: true } });
    if (!cat || !cat.active) {
      if (delivery.status === 'leased') {
        await this.prisma.outboxDelivery.update({ where: { id: delivery.id }, data: { status: 'pending', leaseOwner: null, leaseExpiresAt: null } });
      }
      return 'skip';
    }
    const consumer = getConsumer(delivery.consumer);
    if (!consumer) return this.deadLetter(delivery.id, delivery.attempts, `no consumer registered: ${delivery.consumer}`);
    const event = await this.prisma.domainEvent.findUnique({ where: { eventId: delivery.eventId } });
    if (!event) return this.deadLetter(delivery.id, delivery.attempts, 'event row missing');
    const meta = metaFromEvent(event);
    const ctxDelivery = { id: delivery.id, consumer: delivery.consumer, projectId: delivery.projectId, streamPosition: delivery.streamPosition, payload: delivery.payload };
    return consumer.effect === 'db'
      ? this.dispatchOrdered(delivery, consumer, meta, ctxDelivery)
      : this.dispatchExternal(delivery, consumer, meta, ctxDelivery);
  }

  /** An external (socket/push) consumer: at-least-once. Sends only at cutover; a throw retries. */
  private async dispatchExternal(
    delivery: { id: string; attempts: number; deliveryAction: string },
    consumer: OutboxConsumer,
    meta: EmittedEventMeta,
    ctxDelivery: DispatchDeliveryCtx,
  ): Promise<DispatchOutcome> {
    // A no-op delivery, or a PRE-INTENT legacy event (null dispatchIntent) whose row still says
    // 'dispatch' from the migration default: neutralize — record it as noop/succeeded and never
    // send. The outbox never replays a historical push from an old row. This is the one explained
    // legacy conversion (null intent ⇒ external no-op), never a silent rewrite of a live event.
    if (delivery.deliveryAction === 'noop' || meta.dispatchIntent === null) {
      await this.prisma.outboxDelivery.update({ where: { id: delivery.id }, data: { status: 'succeeded', deliveryAction: 'noop', leaseOwner: null, leaseExpiresAt: null, lastError: null } });
      return 'succeeded';
    }
    try {
      await consumer.handle({ delivery: ctxDelivery, meta, senderMode: outboxSenderMode() });
      await this.prisma.outboxDelivery.update({ where: { id: delivery.id }, data: { status: 'succeeded', leaseOwner: null, leaseExpiresAt: null, lastError: null } });
      return 'succeeded';
    } catch (e) {
      return this.onFailure(delivery.id, delivery.attempts, e);
    }
  }

  /** An ordered database consumer: contiguous cursor + effectively-once, all in one transaction. */
  private async dispatchOrdered(
    delivery: { id: string; attempts: number; projectId: string; streamPosition: bigint; deliveryAction: string },
    consumer: OutboxConsumer,
    meta: EmittedEventMeta,
    ctxDelivery: DispatchDeliveryCtx,
  ): Promise<DispatchOutcome> {
    let outcome: 'applied' | 'duplicate' | 'wait' | 'blocked';
    try {
      outcome = await this.prisma.$transaction(async (tx) => {
        const cursor = await tx.projectionCursor.findUnique({ where: { consumer_projectId: { consumer: consumer.name, projectId: delivery.projectId } } });
        const applied = cursor?.appliedPosition ?? null;
        const nextExpected = applied === null ? 0n : applied + 1n;
        const pos = delivery.streamPosition;

        // already applied (cursor past it) OR already processed → effectively-once, no re-effect
        if (pos < nextExpected) return 'duplicate';
        if (await tx.processedEvent.findUnique({ where: { consumer_eventId: { consumer: consumer.name, eventId: meta.eventId } } })) return 'duplicate';

        if (pos > nextExpected) {
          // not contiguous: is the position we're waiting on dead-lettered? then the cursor blocks.
          const blocker = await tx.outboxDelivery.findFirst({ where: { consumer: consumer.name, projectId: delivery.projectId, streamPosition: nextExpected, status: 'dead' } });
          if (blocker) {
            await tx.projectionCursor.upsert({
              where: { consumer_projectId: { consumer: consumer.name, projectId: delivery.projectId } },
              create: { consumer: consumer.name, projectId: delivery.projectId, appliedPosition: applied, status: 'blocked' },
              update: { status: 'blocked' },
            });
            return 'blocked';
          }
          return 'wait';
        }

        // pos === nextExpected → advance the cursor + ProcessedEvent. A `dispatch` row applies the
        // projection; an ordered `noop` row advances the cursor through this position WITHOUT
        // invoking the business handler — so a filtered position is accounted for, never skipped.
        if (delivery.deliveryAction === 'dispatch') {
          await consumer.handle({ delivery: ctxDelivery, meta, senderMode: outboxSenderMode(), tx });
        }
        await tx.processedEvent.create({ data: { consumer: consumer.name, eventId: meta.eventId } });
        await tx.projectionCursor.upsert({
          where: { consumer_projectId: { consumer: consumer.name, projectId: delivery.projectId } },
          create: { consumer: consumer.name, projectId: delivery.projectId, appliedPosition: pos, status: 'live' },
          update: { appliedPosition: pos, status: 'live' },
        });
        return 'applied';
      });
    } catch (e) {
      return this.onFailure(delivery.id, delivery.attempts, e);
    }

    if (outcome === 'applied' || outcome === 'duplicate') {
      await this.prisma.outboxDelivery.update({ where: { id: delivery.id }, data: { status: 'succeeded', leaseOwner: null, leaseExpiresAt: null, lastError: null } });
      return outcome === 'applied' ? 'succeeded' : 'duplicate';
    }
    // 'wait' / 'blocked': the delivery cannot proceed yet — release the lease, stay pending
    await this.prisma.outboxDelivery.update({ where: { id: delivery.id }, data: { status: 'pending', leaseOwner: null, leaseExpiresAt: null } });
    return outcome;
  }

  private async onFailure(id: string, attempts: number, err: unknown): Promise<DispatchOutcome> {
    const next = attempts + 1;
    const msg = (err as Error)?.message ?? String(err);
    if (next >= MAX_ATTEMPTS) return this.deadLetter(id, next, msg);
    const backoff = BACKOFF_SECONDS[Math.min(next - 1, BACKOFF_SECONDS.length - 1)];
    await this.prisma.outboxDelivery.update({
      where: { id },
      data: { status: 'pending', attempts: next, nextAttemptAt: new Date(Date.now() + backoff * 1000), lastError: msg, leaseOwner: null, leaseExpiresAt: null },
    });
    return 'retry';
  }

  private async deadLetter(id: string, attempts: number, msg: string): Promise<DispatchOutcome> {
    await this.prisma.outboxDelivery.update({ where: { id }, data: { status: 'dead', attempts, lastError: msg, leaseOwner: null, leaseExpiresAt: null } });
    return 'dead';
  }

  /**
   * The continuous gap-expansion scanner (PR B Task 3). For every ACTIVE catalog consumer, it finds
   * DomainEvents that lack that consumer's delivery — the earliest first, by `(projectId,
   * streamPosition)` — and creates a TOTAL row (`dispatch` or `noop`) derived from the event's FULL
   * envelope (including its persisted `dispatchIntent`). This is the durable obligation: every
   * active-consumer × event pair gets exactly one delivery. It closes every timing window a boot-only
   * backfill missed — a new consumer registered after events exist, an old instance emitting during a
   * rolling deploy, a crash after catalog upsert but before delivery creation — because it runs on
   * every relay pass (via `runOnce`), not once. It is BOUNDED: one invocation processes at most
   * `batchSize` missing events PER active consumer — a fair, deterministic budget — so a huge upgraded
   * database can never make bootstrap (or any single tick) drain the whole backlog before serving
   * traffic. Successive relay ticks continue closing the gap until `NOT EXISTS` returns nothing.
   * Concurrent scanners are idempotent: each pass re-evaluates `NOT EXISTS`, the `@@unique(eventId,
   * consumer)` is the backstop, and a lost create race (`P2002`) is ignored. A pre-intent legacy event
   * (`dispatchIntent = null`) yields an external no-op — the outbox never invents a historical push.
   * The catalog is the source of truth, so a deactivated consumer stops accruing new obligations
   * without deleting existing deliveries.
   */
  async expandMissingDeliveries(batchSize = 200): Promise<number> {
    let created = 0;
    const catalog = await this.prisma.outboxConsumerCatalog.findMany({ where: { active: true } });
    for (const cat of catalog) {
      const consumer = getConsumer(cat.consumer);
      if (!consumer) continue; // an active contract whose code is absent in THIS instance — skip
      // ONE bounded batch per consumer per invocation: the earliest missing pairs first (ordered).
      // Later relay ticks pick up where this left off; no unbounded inner drain.
      const missing = await this.prisma.$queryRaw<{ eventId: string }[]>`
        SELECT e."eventId" FROM "DomainEvent" e
        WHERE NOT EXISTS (
          SELECT 1 FROM "OutboxDelivery" d WHERE d."eventId" = e."eventId" AND d."consumer" = ${cat.consumer}
        )
        ORDER BY e."projectId", e."streamPosition"
        LIMIT ${batchSize}`;
      if (!missing.length) continue;
      const events = await this.prisma.domainEvent.findMany({ where: { eventId: { in: missing.map((m) => m.eventId) } } });
      for (const event of events) {
        const plan = consumer.deliveryFor(metaFromEvent(event));
        const status = plan.action === 'dispatch' ? 'pending' : consumer.kind === 'unordered' ? 'succeeded' : 'pending';
        try {
          await this.prisma.outboxDelivery.create({
            data: {
              eventId: event.eventId, projectId: event.projectId, consumer: cat.consumer, consumerKind: consumer.kind,
              streamPosition: event.streamPosition, deliveryAction: plan.action, status,
              ...(plan.action === 'dispatch' && plan.payload !== undefined ? { payload: plan.payload } : {}),
            },
          });
          created++;
        } catch (err) {
          // a concurrent scanner already created it (unique) — fine
          if (!(err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002')) throw err;
        }
      }
    }
    return created;
  }
}

/** Build the consumer-facing event meta from a DomainEvent row, including the persisted dispatch
 *  intent (null for a pre-intent legacy event). The single place the relay/scanner reconstruct the
 *  envelope, so external consumers always derive their plan from durable state. */
function metaFromEvent(event: {
  eventId: string; eventType: string; projectId: string; organizationId: string;
  streamPosition: bigint; entityType: string; entityId: string;
  payload: Prisma.JsonValue | null; dispatchIntent: Prisma.JsonValue | null;
}): EmittedEventMeta {
  return {
    eventId: event.eventId, eventType: event.eventType, projectId: event.projectId,
    organizationId: event.organizationId, streamPosition: event.streamPosition,
    entityType: event.entityType, entityId: event.entityId, payload: event.payload,
    dispatchIntent: (event.dispatchIntent ?? null) as EmittedEventMeta['dispatchIntent'],
  };
}

interface DispatchDeliveryCtx {
  id: string;
  consumer: string;
  projectId: string;
  streamPosition: bigint;
  payload: Prisma.JsonValue | null;
}
