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

  /** Drain all consumers until a full pass makes no further progress (bounded). */
  async runOnce(): Promise<void> {
    for (let guard = 0; guard < 1000; guard++) {
      let progressed = false;
      for (const consumer of listConsumers()) {
        const ids = await this.claim(consumer.name);
        for (const id of ids) {
          const outcome = await this.dispatchOne(id);
          if (outcome === 'succeeded' || outcome === 'duplicate' || outcome === 'dead' || outcome === 'retry') progressed = true;
        }
      }
      if (!progressed) return;
    }
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
    delivery: { id: string; attempts: number },
    consumer: OutboxConsumer,
    meta: EmittedEventMeta,
    ctxDelivery: DispatchDeliveryCtx,
  ): Promise<DispatchOutcome> {
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
    delivery: { id: string; attempts: number; projectId: string; streamPosition: bigint },
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

        // pos === nextExpected → apply the projection + its ProcessedEvent + advance the cursor
        await consumer.handle({ delivery: ctxDelivery, meta, senderMode: outboxSenderMode(), tx });
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
   * Pre-cutover backfill (PR B): every DomainEvent that lacks a registered consumer's delivery gets
   * one — a TOTAL row (`dispatch` or `noop`) derived from the event's FULL envelope (including its
   * persisted `dispatchIntent`), never a partial-envelope stub. A pre-intent legacy event
   * (`dispatchIntent = null`) yields an external no-op — the outbox never invents a historical push.
   * Idempotent — `@@unique(eventId, consumer)` makes a re-run a no-op. (PR B Task 3 makes this the
   * continuous scanner entry point; here it repairs a legacy database at boot.)
   */
  async backfillPreCutover(): Promise<number> {
    let created = 0;
    for (const consumer of listConsumers()) {
      const missing = await this.prisma.$queryRaw<{ eventId: string }[]>`
        SELECT e."eventId" FROM "DomainEvent" e
        WHERE NOT EXISTS (
          SELECT 1 FROM "OutboxDelivery" d WHERE d."eventId" = e."eventId" AND d."consumer" = ${consumer.name}
        )`;
      if (!missing.length) continue;
      const events = await this.prisma.domainEvent.findMany({ where: { eventId: { in: missing.map((m) => m.eventId) } } });
      for (const event of events) {
        const plan = consumer.deliveryFor(metaFromEvent(event));
        const status = plan.action === 'dispatch' ? 'pending' : consumer.kind === 'unordered' ? 'succeeded' : 'pending';
        try {
          await this.prisma.outboxDelivery.create({
            data: {
              eventId: event.eventId, projectId: event.projectId, consumer: consumer.name, consumerKind: consumer.kind,
              streamPosition: event.streamPosition, deliveryAction: plan.action, status,
              ...(plan.action === 'dispatch' && plan.payload !== undefined ? { payload: plan.payload } : {}),
            },
          });
          created++;
        } catch (err) {
          // a concurrent boot already created it (unique) — fine
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
