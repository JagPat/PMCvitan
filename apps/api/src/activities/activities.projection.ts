import { Prisma } from '@prisma/client';
import type { DeliveryPlan, EmittedEventMeta, OutboxConsumer } from '../platform/outbox/registry';
import { computeActivitiesBase } from './activities-serialize';

/**
 * Phase 2 Task 10 (Module 4) — the ACTIVITIES read-model projection consumer (`activities.schedule`).
 *
 * The activity spine's read path moves onto a rebuildable projection. This ordered `db` projection
 * consumer subscribes to the activity + phase lifecycle events (`activity.*` + `phase.*`); on each it
 * REFRESHES the project's single generation-scoped `ActivitiesProjection` row from CANONICAL state (a
 * same-module read — the activities module owns `activity`/`gateOverride`/`phase`), storing the exact
 * ACTIVITY-OWNED base `computeActivitiesBase` produces. Any other event is a `noop` delivery, so the
 * ordered cursor still advances through every stream position contiguously.
 *
 * TRUTHFULNESS (the Module-3 owner-aligned invariant, applied up front):
 *  • the base stores ONLY activity-owned facts. Derived readiness — which depends on decisions,
 *    inspections, drawings and memberships, whose events this consumer treats as no-ops — is NEVER
 *    stored; it is baked fresh at read time from those modules' query contracts, so a foreign mutation
 *    can never leave a "current" projection serving a stale conclusion.
 *  • every FOREIGN command that mutates an activity-owned serialized fact appends an activity-owned
 *    event on its own transaction through `ActivityParticipant`: the closing-inspection decide emits
 *    `activity.signed_off`/`signoff_rejected` (pre-existing), the daily-log material mismatch emits
 *    `activity.material_blocked`, a node deletion emits `activity.unfiled`, and project initialization
 *    emits `activity.created`/`phase.created` — so the ordered cursor observes every base change.
 *  • gate-override EXPIRY is time-based, not event-based — the base stores ALL overrides with their
 *    expiry and the bake filters against the read's `now`, so expiry needs no event to stay truthful.
 */

export const ACTIVITIES_PROJECTION = 'activities.schedule';

/** Dispatch the activity + phase lifecycle events; every other event is a no-op that still advances the
 *  ordered cursor. (`activity.signed_off`/`signoff_rejected` — emitted by the inspections decide — and the
 *  participant signal events `activity.material_blocked`/`activity.unfiled` all match the prefix.) */
function deliveryFor(meta: EmittedEventMeta): DeliveryPlan {
  return meta.eventType.startsWith('activity.') || meta.eventType.startsWith('phase.')
    ? { action: 'dispatch' }
    : { action: 'noop' };
}

/** Refresh the project's single generation-scoped activities base from CANONICAL activity state. */
async function refreshRow(tx: Prisma.TransactionClient, generationId: string, projectId: string): Promise<void> {
  const base = await computeActivitiesBase(tx, projectId);
  const dto = base as unknown as Prisma.InputJsonValue;
  await tx.activitiesProjection.upsert({
    where: { generationId_projectId: { generationId, projectId } },
    create: { generationId, projectId, dto },
    update: { dto },
  });
}

/** Build the `activities.schedule` projection consumer (reads canonical activity state to refresh its row). */
export function makeActivitiesProjectionConsumer(): OutboxConsumer {
  return {
    name: ACTIVITIES_PROJECTION,
    kind: 'ordered',
    effect: 'db',
    catalogVersion: 1,
    deliveryFor,
    projection: {
      rebuildSeed: async (tx, target) => {
        const max = await tx.domainEvent.aggregate({ where: { projectId: target.projectId }, _max: { streamPosition: true } });
        const seededThrough = max._max.streamPosition ?? null;
        await refreshRow(tx, target.generationId, target.projectId);
        return seededThrough;
      },
      dropGeneration: async (tx, target) => {
        await tx.activitiesProjection.deleteMany({ where: { generationId: target.generationId } });
      },
    },
    handle: async (ctx) => {
      if (!ctx.tx) throw new Error('activities projection needs a transaction');
      if (!ctx.projection) throw new Error('activities projection needs a target generation');
      // The slices are per-project (not per-entity), so any activity/phase event refreshes the whole
      // project row from canonical state — the event's projectId is the key.
      await refreshRow(ctx.tx, ctx.projection.generationId, ctx.meta.projectId);
    },
  };
}
