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

/** The socket/push sender mode (Task 6 → PR C). The in-request `notifyChanged` is GONE; the outbox
 *  consumers are the only senders in every mode. WHO invokes them is chosen before invocation:
 *  `legacy` (default) and `shadow` → the immediate {@link ExternalEffectDispatcher} sends each
 *  committed delivery post-commit (claiming its lease first), while the background relay owns only
 *  retries/recovery; `outbox` → the background relay is the sole sender (the immediate path returns
 *  early). `shadow` additionally logs a plan-vs-catalog comparison but still sends exactly once. The
 *  delivery lease guarantees exactly one active sender per delivery — even across a mixed-mode fleet. */
export type OutboxSenderMode = 'legacy' | 'shadow' | 'outbox';

export function outboxSenderMode(): OutboxSenderMode {
  const m = process.env.OUTBOX_SENDER_MODE;
  return m === 'shadow' || m === 'outbox' ? m : 'legacy';
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

/** Where a PROJECTION consumer must write (Task 9): the specific rebuildable generation instance its
 *  rows belong to. The live relay passes the ACTIVE generation; a rebuild passes the BUILDING one.
 *  A projection tags every row it writes with `generationId`, so a building generation is invisible
 *  to serving until it is activated and a retired one can be dropped wholesale. */
export interface ProjectionTarget {
  generationId: string;
  generation: number;
  projectId: string;
}

/** Task 9 — the rebuild hooks that make an ordered `db` consumer a rebuildable PROJECTION. A consumer
 *  whose `projection` field is set is applied by the relay into its ACTIVE generation (contiguously,
 *  effectively-once) and rebuilt by the {@link ProjectionRebuilder} into a fresh generation swapped
 *  in behind a final activation barrier. Both hooks are OPTIONAL: a projection with no `rebuildSeed`
 *  rebuilds purely by replaying events from position 0. */
export interface ProjectionSpec {
  /** Seed a rebuild's replacement generation from the module's CONSISTENT CANONICAL snapshot, tagging
   *  every row with `target.generationId`, and return the `streamPosition` that snapshot reflects (so
   *  replay resumes at the next position). Return `null` to replay purely from events (position 0).
   *  Runs in its own transaction before the event replay. */
  rebuildSeed?(tx: Prisma.TransactionClient, target: ProjectionTarget): Promise<bigint | null>;
  /** Drop a RETIRED generation's rows after a successful activation swap (best-effort cleanup). */
  dropGeneration?(tx: Prisma.TransactionClient, target: ProjectionTarget): Promise<void>;
}

/** What a consumer receives to dispatch one delivery. `tx` is present ONLY for `db` consumers —
 *  the relay's apply transaction, in which the consumer writes its projection so the side effect
 *  and its ProcessedEvent/cursor commit atomically. `external` consumers get no tx and send
 *  (socket/push) only when `senderMode === 'outbox'`. `projection` is present ONLY for a PROJECTION
 *  consumer — the generation its rows must be tagged with (the active generation for a live delivery,
 *  the building generation for a rebuild replay). */
export interface DispatchContext {
  delivery: { id: string; consumer: string; projectId: string; streamPosition: bigint; payload: Prisma.JsonValue | null };
  meta: EmittedEventMeta;
  senderMode: OutboxSenderMode;
  tx?: Prisma.TransactionClient;
  projection?: ProjectionTarget;
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
  /** Task 9 — set on an ordered `db` consumer to make it a rebuildable PROJECTION: the relay applies
   *  its deliveries into the ACTIVE generation (advancing that generation's checkpoint contiguously)
   *  and the {@link ProjectionRebuilder} rebuilds it behind a final activation barrier. Absent → the
   *  consumer stays a plain ordered `db` consumer on a single `ProjectionCursor` (unchanged). */
  projection?: ProjectionSpec;
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
 *
 * `OutboxConsumerCatalog.active` is authoritative: a deactivated (or not-yet-synced) contract accrues
 * NO new delivery. The active set is read inside the SAME transaction as the event, so a consumer
 * disabled concurrently either sees the event or not, atomically — a deactivated consumer never
 * silently starts receiving work. (Consistent with the `(consumer,consumerKind)` FK, which requires
 * an existing catalog row anyway.)
 */
export async function materializeDeliveries(
  tx: Prisma.TransactionClient,
  meta: EmittedEventMeta,
): Promise<void> {
  const consumers = listConsumers();
  if (!consumers.length) return; // no app boot (unit tests) — nothing to materialize, no catalog read
  const activeRows = await tx.outboxConsumerCatalog.findMany({ where: { active: true }, select: { consumer: true } });
  const active = new Set(activeRows.map((r) => r.consumer));
  const rows: Prisma.OutboxDeliveryCreateManyInput[] = [];
  for (const c of consumers) {
    if (!active.has(c.name)) continue; // deactivated / unsynced contract — no new obligation
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

