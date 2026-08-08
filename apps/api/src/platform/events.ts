import { Prisma } from '@prisma/client';
import type { EventActor } from '../common/actor';
import type { DomainEventType } from '@vitan/shared';
import { materializeDeliveries, type DispatchIntent as PersistedDispatchIntent, type EmittedEventMeta } from './outbox/registry';
import { buildDispatchIntent, type ExternalEffectKey, type DispatchInput } from './external-effects';

/**
 * Phase 2 Task 4 — the platform event kernel.
 *
 * `emitEvent` is the ONE way a consequential state change appends a {@link DomainEvent}. It
 * runs INSIDE the caller's mutation transaction (a `tx` from `$transaction(async (tx) => …)`)
 * so the event, its gap-safe stream position and the canonical write all commit or roll back
 * together. Ordering is a per-project `streamPosition` assigned by locking + incrementing the
 * project's `ProjectEventStream` counter — never `occurredAt` (display/audit only). The tenant
 * `organizationId` is DERIVED from the project itself, so a caller can never forge it, and the
 * composite `(organizationId, projectId)` FK + the attribution CHECK + the append-only trigger
 * (all in `20261015000000_phase2_event_envelope`) enforce completeness at the database.
 */

/** The transaction handle `emitEvent` writes through — a `$transaction` callback client. */
export type EventDb = Prisma.TransactionClient;

/**
 * Phase 5 Task 7B-i-a — THE EMISSION REGISTRY: a command's external effects are what it EMITTED.
 *
 * Until now, "which events does this command dispatch after commit?" was answered by hand: `run`
 * returns an `events` array and the service passes it to {@link ExternalEffectDispatcher}. That
 * works while the emit and the return live in the same function, and silently fails the moment an
 * event is emitted BELOW the command body — in a participant, a shared evaluation seam, a helper.
 * The meta is dropped, the durable `OutboxDelivery` still commits, and the external effect the
 * catalog declares arrives only when the background relay's recovery claim gets to it (and under
 * `OUTBOX_RELAY_AUTOSTART=false`, never).
 *
 * `commercial.money_moved` is the case that forced this. Its single emit seam is
 * `CommercialBudgetService.evaluate`, which every money writer already calls — from commercial's
 * own commands AND, through `CommercialParticipant`, from procurement, labour and inventory
 * commands. Threading its meta up through all of those would be ~15 hand-edited call sites across
 * four modules, and would leave the trap armed for the next shared seam.
 *
 * So the set is DERIVED instead: `emitEvent` records each meta against the transaction handle it
 * wrote on, and {@link executeCommand} reads that registry back when `run` returns. A caller that
 * already returns its events is unaffected (the merge dedupes by `eventId` and preserves emit
 * order); a caller that emits through a seam it does not own now dispatches correctly without
 * knowing the seam exists.
 *
 * Two properties keep this honest:
 *   - It is OPT-IN PER TRANSACTION. Only a transaction someone called {@link beginEventCollection}
 *     on collects, and `executeCommand` is the only caller. A raw `prisma.$transaction` (the orgs
 *     project lifecycle, the §L activation CLI, a projection rebuild) is untouched.
 *   - It never creates an external effect. The `OutboxDelivery` rows were already materialized in
 *     the same transaction by `materializeDeliveries`; the registry only decides whether the
 *     command's own post-commit dispatcher sends them NOW or the relay sweeps them later.
 *
 * The map is weak on the transaction handle, so an entry dies with the transaction it belongs to —
 * including a rolled-back one, whose events were never committed and must never be dispatched.
 */
const emittedByTx = new WeakMap<object, EmittedEventMeta[]>();

/** Start collecting on this transaction handle. Idempotent per transaction; resets the buffer. */
export function beginEventCollection(tx: EventDb): void {
  emittedByTx.set(tx as object, []);
}

/** Every event emitted on this transaction handle since {@link beginEventCollection}, in emit
 *  order. Empty for a transaction nobody opted in — never a lie about what was emitted, because
 *  the alternative (collecting everywhere) would make a rebuild's transaction look like a command. */
export function collectedEvents(tx: EventDb): readonly EmittedEventMeta[] {
  return emittedByTx.get(tx as object) ?? [];
}

export interface EmitInput {
  /** The project (site) the event belongs to; also the ordering scope. */
  projectId: string;
  /** Who acted — the id + kind of the resolved `Actor` from the audit kernel (Task 3). A `human`
   *  carries a real `actorId`; a `system` actor's id becomes the named `systemActor`. Typed as the
   *  {@link EventActor} subset because those are the only two fields written here; a full `Actor`
   *  satisfies it structurally. */
  actor: EventActor;
  /** One of the shared catalog types (`decision.approved`, `activity.started`, …). */
  eventType: DomainEventType;
  entityType: string;
  entityId: string;
  /** Optional location (ProjectNode) — null this phase; the column exists for future consumers. */
  siteId?: string | null;
  payloadVersion?: number;
  correlationId?: string | null;
  /** The event that directly caused this one (e.g. a closing `inspection.approved` causes an
   *  `activity.signed_off`), so a multi-event command threads its causal chain. */
  causedByEventId?: string | null;
  payload?: Prisma.InputJsonValue;
  /** PR C — the external-effect catalog key this event is emitted under. There is NO default: every
   *  producer names an exact key, and the catalog decides whether the event invalidates the live
   *  snapshot and which roles a push may reach. Validated against the catalog at emit time. */
  effectKey: ExternalEffectKey;
  /** PR C — the command-supplied part of the dispatch: only the push BODY (roles come from the
   *  catalog). A key whose catalog `push` is null must not carry a push body. Omit `push` for a
   *  signal-only or weightless (draft/no-op) event. */
  dispatch: DispatchInput;
}

/**
 * Append one domain event inside the caller's transaction. Returns the full {@link EmittedEventMeta}
 * (a superset of `{ eventId, streamPosition }`) so a follow-on event in the same command can name it
 * as `causedByEventId` AND the post-commit {@link ExternalEffectDispatcher} (PR C Task 2) can send
 * this command's external effects from the committed metadata in causal order.
 *
 * Throws (P2025) if the project has no `ProjectEventStream` row — the invariant that a project
 * cannot exist without its counter (created in the project-creation transaction, backfilled for
 * legacy projects) means this only fires if that invariant was violated, never in normal flow.
 */
export async function emitEvent(tx: EventDb, input: EmitInput): Promise<EmittedEventMeta> {
  // Derive the tenant from the project itself — a forged organizationId is impossible.
  const { orgId } = await tx.project.findUniqueOrThrow({ where: { id: input.projectId }, select: { orgId: true } });
  // Lock + increment the per-project counter INSIDE this transaction: two concurrent commits on
  // one project serialize here, so positions are distinct, ordered and never skipped.
  const stream = await tx.projectEventStream.update({
    where: { projectId: input.projectId },
    data: { nextPosition: { increment: 1 } },
  });
  const streamPosition = stream.nextPosition - 1n;
  const actorKind = input.actor.actorKind;
  // PR C — the immutable dispatch intent recorded WITH the event, derived from the external-effect
  // catalog: the exact per-command invalidation + push audience the command requested at commit time.
  // Validated against the catalog (unknown key / eventType mismatch / illegal push → throw before any
  // write). The persisted `coverageVersion` is what the cutover seal pins.
  const builtIntent = buildDispatchIntent(input.effectKey, input.eventType, input.dispatch);
  const dispatchIntent = builtIntent as unknown as PersistedDispatchIntent;
  const event = await tx.domainEvent.create({
    data: {
      eventType: input.eventType,
      payloadVersion: input.payloadVersion ?? 1,
      organizationId: orgId,
      projectId: input.projectId,
      streamPosition,
      siteId: input.siteId ?? null,
      actorId: actorKind === 'human' ? input.actor.actorId : null,
      actorKind,
      systemActor: actorKind === 'system' ? input.actor.actorId : null,
      entityType: input.entityType,
      entityId: input.entityId,
      correlationId: input.correlationId ?? null,
      causedByEventId: input.causedByEventId ?? null,
      dispatchIntent: dispatchIntent as unknown as Prisma.InputJsonValue,
      ...(input.payload !== undefined ? { payload: input.payload } : {}),
    },
    select: { eventId: true },
  });
  const meta: EmittedEventMeta = {
    eventId: event.eventId,
    eventType: input.eventType,
    projectId: input.projectId,
    organizationId: orgId,
    streamPosition,
    entityType: input.entityType,
    entityId: input.entityId,
    payload: input.payload ?? null,
    dispatchIntent,
  };
  // Task 6 — materialize one OutboxDelivery per registered consumer IN THIS transaction, so a
  // committed event can never lack its durable delivery work. A no-op when no consumer is
  // registered (unit tests without an app boot), so mocked-prisma services need no outbox stub.
  await materializeDeliveries(tx, meta);
  // Task 7B-i-a — record the emission for this command's post-commit dispatch. AFTER
  // `materializeDeliveries`, so the registry only ever holds events whose durable delivery rows
  // exist: the dispatcher looks its work up BY those rows, and an entry without them would be a
  // dispatch that silently finds nothing. A no-op on a transaction nobody opted in.
  emittedByTx.get(tx as object)?.push(meta);
  return meta;
}
