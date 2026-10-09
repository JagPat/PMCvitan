import { DOMAIN_EVENT_TYPES } from '@vitan/shared';
import { Prisma, type PrismaClient } from '@prisma/client';

/**
 * Phase 2 Task 6 — the outbox consumer registry.
 *
 * Consumers register at RUNTIME (app bootstrap), never statically. The registry decides WHO HANDLES
 * a delivery; from 4d-ii-a / A6d it no longer decides WHICH ROWS EXIST — the delivery rows are a
 * pure function of the event and the PERSISTED catalog ({@link deliveryRowsFor}), so a process that
 * booted no registry (a standalone CLI, a hand-run bundle) writes the same rows a booted API does,
 * and the database's `DomainEvent_t4d_deliveries` seal demands them at commit. The full app
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
  /** The Web Push intent — present only when the command attached a notification. Phase 6 task 4b
   *  (§A.3): `targetUserId` marks a TARGETED push — delivered only to currently-valid links of
   *  that user, with the family predicate re-judged at claim. */
  push?: {
    body: string;
    roles?: string[] | null;
    targetUserId?: string | null;
    /** 4d-ii-a / A6d — a SET of targets (the 4d plan's architect set); projected into the delivery
     *  payload as the canonical sorted, distinct array where present, absent where not. */
    targetUserIds?: string[] | null;
    /** Live bug 1c — the app path the notification opens; read by the push consumer from the intent. */
    url?: string;
  };
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

/**
 * Phase 6 task 4d-ii-a / A6c — a consumer's PERSISTED dispatch rule (the 4d plan, §A.3 obligation 7:
 * "`dispatchRule` (`all`: every event dispatches; `invalidate`: dispatch iff the intent's
 * `invalidate`; `push`: dispatch iff the intent carries a push; `types`: dispatch iff the event's
 * type is in the row's `subscribedEventTypes`)"). The rule is what the catalog row CARRIES — sealed
 * evidence a database trigger can judge an obligation against without reproducing consumer logic —
 * and a compiled consumer DECLARES it beside `kind`/`effect`/`catalogVersion` so the row's birth
 * takes it from the same source verification later compares against (#572's review round 24,
 * finding 2). From A6d the PERSISTED rule is what derives every delivery row ({@link deliveryRowsFor});
 * the consumer contract's `deliveryFor` is retired.
 */
export type DispatchRule =
  | { kind: 'all' }
  | { kind: 'invalidate' }
  | { kind: 'push' }
  | { kind: 'types'; eventTypes: readonly string[] };

/** The four persisted spellings, as the catalog's CHECK admits them. */
export const DISPATCH_RULE_KINDS = ['all', 'invalidate', 'push', 'types'] as const;

/** The closed event-type list's members under the given prefixes — a projection subscribing to a
 *  FAMILY spells its rule from the catalog the compiler closes, never from a hand-typed list. */
export function eventTypesUnder(...prefixes: readonly string[]): readonly string[] {
  return DOMAIN_EVENT_TYPES.filter((t) => prefixes.some((p) => t.startsWith(p)));
}

/** The action a persisted rule derives for one event — the mirror of the database's
 *  `platform_t4d_delivery_action`, which the three delivery seals judge by; the live suite holds the
 *  two equal over the closed event list and every intent shape. */
export function dispatchActionFor(rule: DispatchRule, meta: Pick<EmittedEventMeta, 'eventType' | 'dispatchIntent'>): 'dispatch' | 'noop' {
  switch (rule.kind) {
    case 'all': return 'dispatch';
    case 'invalidate': return meta.dispatchIntent?.invalidate === true ? 'dispatch' : 'noop';
    // a push WITH a body — an intent carrying `push: { body: '' }` (which `buildDispatchIntent`
    // admits) is a no-op (#661's review round 1, finding 2); the seal mirrors this exact predicate
    case 'push': return meta.dispatchIntent?.push?.body ? 'dispatch' : 'noop';
    case 'types': return rule.eventTypes.includes(meta.eventType) ? 'dispatch' : 'noop';
  }
}

/** A catalog row as {@link deliveryRowsFor} reads it: the persisted rule beside the activation mirror. */
export interface CatalogRuleRow {
  consumer: string;
  consumerKind: string;
  active: boolean;
  dispatchRule: string | null;
  subscribedEventTypes: readonly string[];
}

/** The persisted rule of a catalog row as a {@link DispatchRule}; `null` for a row carrying none. */
export function ruleOfRow(row: Pick<CatalogRuleRow, 'dispatchRule' | 'subscribedEventTypes'>): DispatchRule | null {
  switch (row.dispatchRule) {
    case 'all': return { kind: 'all' };
    case 'invalidate': return { kind: 'invalidate' };
    case 'push': return { kind: 'push' };
    case 'types': return { kind: 'types', eventTypes: row.subscribedEventTypes };
    default: return null;
  }
}

/** The push delivery's payload: the platform's PROJECTION of the immutable intent — the mirror of
 *  the database's `platform_t4d_push_payload`, which `OutboxDelivery_t4d_bound` binds the row to.
 *  `{body, roles, targetUserId}` null-coalesced (the shape the previous release wrote) and
 *  `targetUserIds` as the canonical sorted, distinct array where the intent carries one. `null` when
 *  the intent carries no push body. */
export function pushPayloadFor(intent: DispatchIntent | null): Prisma.InputJsonValue | null {
  const push = intent?.push;
  if (!push?.body) return null;
  return {
    body: push.body,
    roles: push.roles ?? null,
    targetUserId: push.targetUserId ?? null,
    ...(Array.isArray(push.targetUserIds) ? { targetUserIds: [...new Set(push.targetUserIds)].sort() } : {}),
  };
}

/**
 * Phase 6 task 4d-ii-a / A6d — THE delivery row set for one event: a pure function of the event and
 * the persisted catalog (4d plan §A.3 obligation 7, "The rows are a pure function of the event and
 * the persisted catalog, so EVERY emitter writes the same rows"). Called by {@link materializeDeliveries}
 * inside the emit transaction and by the relay's `expandMissingDeliveries` for the rows an event
 * lacks; a process that booted no registry writes the same rows, and the database's
 * `DomainEvent_t4d_deliveries` seal demands exactly these at commit.
 *
 * One row per catalog row that is ACTIVE and carries a rule: the action the rule derives; an
 * unordered no-op is already done (`succeeded`), an ordered no-op stays `pending` so the relay
 * advances that consumer's cursor through this position, a dispatch is `pending` until claimed; a
 * `push`-rule dispatch carries the intent's projection and `subject = entityId`. A row with no rule
 * (a consumer no migration knew) derives nothing and gets nothing — the seal owes it nothing either.
 */
export function deliveryRowsFor(meta: EmittedEventMeta, catalog: readonly CatalogRuleRow[]): Prisma.OutboxDeliveryCreateManyInput[] {
  const rows: Prisma.OutboxDeliveryCreateManyInput[] = [];
  for (const c of catalog) {
    if (c.active !== true) continue;
    const rule = ruleOfRow(c);
    if (rule === null) continue;
    const action = dispatchActionFor(rule, meta);
    const status = action === 'dispatch' ? 'pending' : c.consumerKind === 'unordered' ? 'succeeded' : 'pending';
    const payload = rule.kind === 'push' && action === 'dispatch' ? pushPayloadFor(meta.dispatchIntent) : null;
    rows.push({
      eventId: meta.eventId,
      projectId: meta.projectId,
      consumer: c.consumer,
      consumerKind: c.consumerKind,
      streamPosition: meta.streamPosition,
      deliveryAction: action,
      status,
      ...(payload !== null ? { payload, subject: meta.entityId } : {}),
    });
  }
  return rows;
}

/** The rule as the catalog row persists it: the kind, and the subscribed types SORTED and deduplicated
 *  (empty under every kind but `types`, as the catalog's CHECK requires). */
export function persistedRule(rule: DispatchRule): { dispatchRule: string; subscribedEventTypes: string[] } {
  return {
    dispatchRule: rule.kind,
    subscribedEventTypes: rule.kind === 'types' ? [...new Set(rule.eventTypes)].sort() : [],
  };
}

/** Render a persisted (or compiled) rule for a diagnostic. */
export function describeRule(r: { dispatchRule: string | null; subscribedEventTypes: readonly string[] }): string {
  if (r.dispatchRule === null) return 'NONE (no rule persisted)';
  return r.dispatchRule === 'types' ? `types[${[...r.subscribedEventTypes].sort().join(',')}]` : r.dispatchRule;
}

export interface OutboxConsumer {
  name: string;
  kind: ConsumerKind;
  effect: ConsumerEffect;
  /** The consumer CONTRACT version (not an app release). A change to kind/effect/version is a
   *  startup error requiring an explicit migration — `syncConsumerCatalog` never silently
   *  reinterprets a persisted contract. */
  catalogVersion: number;
  /** Phase 6 task 4d-ii-a / A6c — the PERSISTED dispatch rule this consumer's catalog row carries
   *  ({@link DispatchRule}). Written at the row's birth by `syncConsumerCatalog` from this
   *  declaration, VERIFIED against the persisted row at every startup (drift refuses the process,
   *  exactly as `catalogVersion` drift does), and frozen in the database against every other writer:
   *  a CHANGED rule is a contract change and ships in its versioned catalog-data migration. */
  dispatchRule: DispatchRule;
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
 * Write the event's delivery rows INSIDE the caller's emit transaction — so a crash can never leave
 * a committed event with no durable delivery work, and an ordered consumer never waits behind a
 * stream position for which no row exists. From 4d-ii-a / A6d the rows come from
 * {@link deliveryRowsFor} over the PERSISTED catalog, read here under the SHARE half of the
 * registration barrier and with EVERY catalog row locked `FOR SHARE` — active and inactive alike,
 * before the active filter (#567's review round 1, finding 3) — so an activation's `FOR UPDATE`
 * either committed before this read or waits for this transaction's commit, and a registration's
 * INSERT (which takes the key EXCLUSIVE) is serialized against this event. The seal takes both
 * again at commit; the lock is reentrant, so this early acquisition is lock-ordering hygiene
 * (key -> catalog rows, the one order) at no cost. The registry is not consulted: a process that
 * booted none writes the same rows.
 */
export async function materializeDeliveries(
  tx: Prisma.TransactionClient,
  meta: EmittedEventMeta,
): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock_shared(hashtext('OutboxConsumerCatalog:registration'))`;
  const catalog = await tx.$queryRaw<CatalogRuleRow[]>`
    SELECT "consumer", "consumerKind", "active", "dispatchRule", "subscribedEventTypes"
      FROM "OutboxConsumerCatalog" ORDER BY "consumer" FOR SHARE`;
  const rows = deliveryRowsFor(meta, Array.isArray(catalog) ? catalog : []);
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
  type Persisted = { consumerKind: string; consumerEffect: string; catalogVersion: number; dispatchRule: string | null; subscribedEventTypes: string[] };
  const assertMatches = (existing: Persisted, c: OutboxConsumer): void => {
    if (existing.consumerKind !== c.kind || existing.consumerEffect !== c.effect || existing.catalogVersion !== c.catalogVersion) {
      throw new Error(
        `OutboxConsumerCatalog contract drift for '${c.name}': persisted ${existing.consumerKind}/${existing.consumerEffect} v${existing.catalogVersion} != compiled ${c.kind}/${c.effect} v${c.catalogVersion}. An explicit migration is required — the catalog is never silently reinterpreted.`,
      );
    }
    // Phase 6 task 4d-ii-a / A6c — the persisted RULE is verified exactly as the version is, and never
    // rewritten here (#558's review round 2, finding 7; #560's review round 1, finding 7): a row that
    // exists owns its rule, and a changed rule ships in its versioned catalog-data migration under the
    // gate. A row with NO rule is a row this release's migration did not know — the same refusal.
    const compiled = persistedRule(c.dispatchRule);
    const persisted = { dispatchRule: existing.dispatchRule, subscribedEventTypes: [...existing.subscribedEventTypes].sort() };
    if (persisted.dispatchRule !== compiled.dispatchRule
      || persisted.subscribedEventTypes.length !== compiled.subscribedEventTypes.length
      || persisted.subscribedEventTypes.some((t, i) => t !== compiled.subscribedEventTypes[i])) {
      throw new Error(
        `OutboxConsumerCatalog contract drift for '${c.name}': persisted dispatch rule ${describeRule(persisted)} != compiled ${describeRule(compiled)}. `
        + 'A changed rule is a contract change: its versioned catalog-data migration rewrites the row under the rule gate — startup never writes a rule that already exists.',
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
      // A6c — a row's BIRTH carries its rule, from the same compiled source verification compares
      // against (#572's review round 24, finding 2), so no drift can be introduced by this write.
      await prisma.outboxConsumerCatalog.create({
        data: { consumer: c.name, consumerKind: c.kind, consumerEffect: c.effect, catalogVersion: c.catalogVersion, ...persistedRule(c.dispatchRule) },
      });
    } catch (e) {
      // Lost a concurrent create race (rolling deploy) — the winner must match our compiled contract.
      if (!(e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002')) throw e;
      const won = await prisma.outboxConsumerCatalog.findUnique({ where: { consumer: c.name } });
      if (won) assertMatches(won, c);
    }
  }
}

