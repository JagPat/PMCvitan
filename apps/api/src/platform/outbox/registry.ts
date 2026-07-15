import { Prisma } from '@prisma/client';

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
}

/** A human-facing notification a command attaches to its event (the push body + target roles). */
export interface NotificationIntent {
  body: string;
  roles?: string[];
}

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
  /** Does this consumer want a delivery for this event? Return the dispatch payload (or `{}` for
   *  none) to create a delivery row, or `null` to skip. Runs INSIDE the emit transaction. */
  deliveryFor(meta: EmittedEventMeta, notification?: NotificationIntent): { payload?: Prisma.InputJsonValue } | null;
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
 * Write one OutboxDelivery row per registered consumer that wants this event, INSIDE the caller's
 * emit transaction — so a crash can never leave a committed event with no durable delivery work.
 * A no-op when the registry is empty (unit tests without an app boot).
 */
export async function materializeDeliveries(
  tx: Prisma.TransactionClient,
  meta: EmittedEventMeta,
  notification?: NotificationIntent,
): Promise<void> {
  const rows: Prisma.OutboxDeliveryCreateManyInput[] = [];
  for (const c of listConsumers()) {
    const d = c.deliveryFor(meta, notification);
    if (!d) continue;
    rows.push({
      eventId: meta.eventId,
      projectId: meta.projectId,
      consumer: c.name,
      consumerKind: c.kind,
      streamPosition: meta.streamPosition,
      status: 'pending',
      ...(d.payload !== undefined ? { payload: d.payload } : {}),
    });
  }
  if (rows.length) await tx.outboxDelivery.createMany({ data: rows });
}

