import { Prisma } from '@prisma/client';
import type { Actor } from '../common/actor';
import type { DomainEventType } from '@vitan/shared';
import { materializeDeliveries, type NotificationIntent } from './outbox/registry';

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
  /** A human-facing notification this event should drive (Task 6): the Web Push body + target
   *  roles. When present, the emit transaction ALSO materializes a `webpush.notify` delivery
   *  carrying it, so the outbox can fan it out post-commit. The canonical Notification DB row is
   *  still written by the command itself; this is only the push intent for the outbox path. */
  notification?: NotificationIntent;
}

/**
 * Append one domain event inside the caller's transaction. Returns the new `eventId` +
 * `streamPosition` so a follow-on event in the same command can name it as `causedByEventId`.
 *
 * Throws (P2025) if the project has no `ProjectEventStream` row — the invariant that a project
 * cannot exist without its counter (created in the project-creation transaction, backfilled for
 * legacy projects) means this only fires if that invariant was violated, never in normal flow.
 */
export async function emitEvent(tx: EventDb, input: EmitInput): Promise<{ eventId: string; streamPosition: number }> {
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
      ...(input.payload !== undefined ? { payload: input.payload } : {}),
    },
    select: { eventId: true },
  });
  // Task 6 — materialize one OutboxDelivery per registered consumer IN THIS transaction, so a
  // committed event can never lack its durable delivery work. A no-op when no consumer is
  // registered (unit tests without an app boot), so mocked-prisma services need no outbox stub.
  await materializeDeliveries(
    tx,
    {
      eventId: event.eventId,
      eventType: input.eventType,
      projectId: input.projectId,
      organizationId: orgId,
      streamPosition,
      entityType: input.entityType,
      entityId: input.entityId,
      payload: input.payload ?? null,
    },
    input.notification,
  );
  return { eventId: event.eventId, streamPosition: Number(streamPosition) };
}
