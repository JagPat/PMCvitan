import { Prisma } from '@prisma/client';
import type { Actor } from '../common/actor';
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

export interface EmitInput {
  /** The project (site) the event belongs to; also the ordering scope. */
  projectId: string;
  /** Who acted — the resolved {@link Actor} from the audit kernel (Task 3). A `human` carries a
   *  real `actorId`; a `system` actor's id becomes the named `systemActor`. */
  actor: Actor;
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
  return meta;
}
