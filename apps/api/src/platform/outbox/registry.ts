import { Prisma, type PrismaClient } from '@prisma/client';

/**
 * Phase 2 Task 6 — the outbox consumer registry.
 *
 * Consumers register at RUNTIME (app bootstrap), never statically, so a process that never boots
 * the app (unit tests constructing services directly) sees an EMPTY registry and `emitEvent`
 * materializes zero deliveries — the mocked-prisma unit tests need no outbox stubs. The full app
 * (integration / e2e / production) registers `socket.invalidation` + `webpush.notify` at
 * `onModuleInit`; a test may register an extra ordered consumer to exercise the ordering contract.
 */

export type ConsumerKind = 'ordered' | 'unordered';
/** `db` → the consumer writes a projection + its ProcessedEvent in one tx (effectively-once);
 *  `external` → socket/push, at-least-once, no ProcessedEvent. */
export type ConsumerEffect = 'db' | 'external';

/** The socket/push sender cutover (Task 6). `legacy` (default) keeps the OLD in-request
 *  `notifyChanged` as the sole sender; `shadow` records the outbox intent WITHOUT sending (old
 *  path still sends); `outbox` makes the outbox consumers the sole sender (old path goes silent).
 *  Exactly one path sends in every mode — that is the exactly-one-active-sender invariant. */
export type OutboxSenderMode = 'legacy' | 'shadow' | 'outbox';

export function outboxSenderMode(): OutboxSenderMode {
  const m = process.env.OUTBOX_SENDER_MODE;
  return m === 'shadow' || m === 'outbox' ? m : 'legacy';
}
/** The OLD in-request `notifyChanged` sends in every mode except `outbox`. */
export function legacyPathSends(): boolean {
  return outboxSenderMode() !== 'outbox';
}
/** The outbox external consumers send ONLY at cutover. */
export function outboxPathSends(): boolean {
  return outboxSenderMode() === 'outbox';
}

/** Immutable dispatch metadata persisted on the event at commit time (PR B): what external
 *  consequences the command requested. External consumers (socket/push) derive their delivery plan
 *  from THIS (the persisted intent), never from a transient in-memory argument, so a scanner can
 *  reproduce every plan long after the emitting request is gone. Until PR C supplies the final
 *  per-command catalog, `emitEvent` persists a compatibility intent (`effectKey 'compat.task6'`). */
export interface DispatchIntent {
  effectKey: string;
  coverageVersion: string;
  /** The socket-invalidation intent — today every event invalidates (compat), PR C narrows it. */
  invalidate: boolean;
  /** The Web Push intent — present only when the command attached a notification. */
  push?: { body: string; roles?: string[] | null };
}

/** The event facts a consumer needs at materialize + dispatch time. */
export interface EmittedEventMeta {
  eventId: string;
  eventType: string;
  projectId: string;
  organizationId: string;
  streamPosition: bigint;
  entityType: string;
  entityId: string;
  payload: unknown;
  /** The persisted dispatch intent (PR B) — null for a pre-intent legacy event. */
  dispatchIntent: DispatchIntent | null;
}

/** A human-facing notification a command attaches to its event (the push body + target roles). */
export interface NotificationIntent {
  body: string;
  roles?: string[];
}

/** A consumer's TOTAL decision for one event (PR B): every registered consumer produces a plan for
 *  every event — `dispatch` invokes it, `noop` records the event was deliberately irrelevant — so
 *  an ordered consumer's cursor never waits behind a stream position that produced no delivery row.
 *  There is no `null`: a missing row can no longer be silently "not relevant". */
export type DeliveryPlan = { action: 'dispatch'; payload?: Prisma.InputJsonValue } | { action: 'noop' };

/** What a consumer receives to dispatch one delivery. `tx` is present ONLY for `db` consumers —
 *  the relay's apply transaction, in which the consumer writes its projection so the side effect
 *  and its ProcessedEvent/cursor commit atomically. `external` consumers get no tx and send
 *  (socket/push) only when `senderMode === 'outbox'`. */
export interface DispatchContext {
  delivery: { id: string; consumer: string; projectId: string; streamPosition: bigint; payload: Prisma.JsonValue | null };
  meta: EmittedEventMeta;
  senderMode: OutboxSenderMode;
  tx?: Prisma.TransactionClient;
}

export interface OutboxConsumer {
  name: string;
  kind: ConsumerKind;
  effect: ConsumerEffect;
  /** The consumer CONTRACT version (not an app release). A change to kind/effect/version is a
   *  startup error requiring an explicit migration — `syncConsumerCatalog` never silently
   *  reinterprets a persisted contract. */
  catalogVersion: number;
  /** The TOTAL plan for this event: `{ action: 'dispatch', payload? }` to invoke the consumer, or
   *  `{ action: 'noop' }` to record the event as deliberately irrelevant. Never null. Derives from
   *  the PERSISTED `meta.dispatchIntent`, so the scanner reproduces the same plan. Runs INSIDE the
   *  emit transaction and in the expansion scanner. */
  deliveryFor(meta: EmittedEventMeta): DeliveryPlan;
  /** Dispatch one delivery. Throw to signal a retryable failure (the relay backs off / dead-letters). */
  handle(ctx: DispatchContext): Promise<void>;
}

const registry = new Map<string, OutboxConsumer>();

/** Register (idempotently, by name) a consumer. Called at app bootstrap; re-registering the same
 *  name replaces it (so a second app boot in the serial integration process never duplicates). */
export function registerConsumer(consumer: OutboxConsumer): void {
  registry.set(consumer.name, consumer);
}

export function listConsumers(): OutboxConsumer[] {
  return [...registry.values()];
}

export function getConsumer(name: string): OutboxConsumer | undefined {
  return registry.get(name);
}

/** Test isolation — drop a specific consumer (or all) from the registry. */
export function unregisterConsumer(name: string): void {
  registry.delete(name);
}

/**
 * Write one OutboxDelivery row per registered consumer FOR EVERY event, INSIDE the caller's emit
 * transaction — so a crash can never leave a committed event with no durable delivery work, and an
 * ordered consumer never waits behind a stream position for which no row exists. Totality (PR B):
 * a consumer returns `dispatch` or `noop`, never null. A no-op when the registry is empty (unit
 * tests without an app boot).
 */
export async function materializeDeliveries(
  tx: Prisma.TransactionClient,
  meta: EmittedEventMeta,
): Promise<void> {
  const rows: Prisma.OutboxDeliveryCreateManyInput[] = [];
  for (const c of listConsumers()) {
    const plan = c.deliveryFor(meta);
    // An unordered no-op is already done (nothing to send). An ordered no-op stays `pending` so the
    // relay advances that consumer's cursor through this position in the same transaction as real
    // projection work (Task 3), never skipping it. A dispatch is always `pending` until claimed.
    const status = plan.action === 'dispatch' ? 'pending' : c.kind === 'unordered' ? 'succeeded' : 'pending';
    rows.push({
      eventId: meta.eventId,
      projectId: meta.projectId,
      consumer: c.name,
      consumerKind: c.kind,
      streamPosition: meta.streamPosition,
      deliveryAction: plan.action,
      status,
      ...(plan.action === 'dispatch' && plan.payload !== undefined ? { payload: plan.payload } : {}),
    });
  }
  if (rows.length) await tx.outboxDelivery.createMany({ data: rows });
}

/**
 * Persist every registered consumer's contract into `OutboxConsumerCatalog` (PR B) — the durable
 * source of "which consumers owe a delivery for which events". Missing rows are created; an existing
 * row whose kind/effect/version DIFFERS from the compiled consumer is a HARD ERROR (a changed
 * contract requires an explicit migration, never a silent overwrite). Runs at bootstrap BEFORE the
 * relay starts, so the `(consumer, consumerKind)` delivery FK always resolves. Idempotent and
 * rolling-deploy-safe: a concurrent create that loses the PK race re-reads and verifies the winner.
 */
export async function syncConsumerCatalog(prisma: PrismaClient): Promise<void> {
  const assertMatches = (existing: { consumerKind: string; consumerEffect: string; catalogVersion: number }, c: OutboxConsumer): void => {
    if (existing.consumerKind !== c.kind || existing.consumerEffect !== c.effect || existing.catalogVersion !== c.catalogVersion) {
      throw new Error(
        `OutboxConsumerCatalog contract drift for '${c.name}': persisted ${existing.consumerKind}/${existing.consumerEffect} v${existing.catalogVersion} != compiled ${c.kind}/${c.effect} v${c.catalogVersion}. An explicit migration is required — the catalog is never silently reinterpreted.`,
      );
    }
  };
  for (const c of listConsumers()) {
    const existing = await prisma.outboxConsumerCatalog.findUnique({ where: { consumer: c.name } });
    if (existing) {
      assertMatches(existing, c);
      continue;
    }
    try {
      await prisma.outboxConsumerCatalog.create({
        data: { consumer: c.name, consumerKind: c.kind, consumerEffect: c.effect, catalogVersion: c.catalogVersion },
      });
    } catch (e) {
      // Lost a concurrent create race (rolling deploy) — the winner must match our compiled contract.
      if (!(e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002')) throw e;
      const won = await prisma.outboxConsumerCatalog.findUnique({ where: { consumer: c.name } });
      if (won) assertMatches(won, c);
    }
  }
}

