import { Prisma } from '@prisma/client';
import type { DeliveryPlan, EmittedEventMeta, OutboxConsumer } from '../platform/outbox/registry';
import { computeInspectionsBase } from './inspections-serialize';

/**
 * Phase 2 Task 10 (Module 3) — the INSPECTIONS read-model projection consumer (`inspections.inbox`).
 *
 * The inspections module's read path moves onto a rebuildable projection. This ordered `db` projection
 * consumer subscribes to the inspection lifecycle events (`inspection.*`); on each it REFRESHES the
 * project's single generation-scoped `InspectionsProjection` row from CANONICAL state (a same-module read
 * — the inspections module owns `inspection`/`inspectionItem`), storing the exact viewer-INDEPENDENT base
 * `computeInspectionsBase` produces. A non-inspection event is a `noop` delivery, so the ordered cursor
 * still advances through every stream position contiguously.
 *
 * Like the daily-log/drawings projections (per-PROJECT composite, not per-entity), a generation holds ONE
 * row per project storing the whole inspection base. Because the handler derives that row from CURRENT
 * canonical state (not from event payloads), the projection is trivially equivalent to the live slices and
 * a rebuild replay is idempotent: re-applying any inspection event just re-serializes the same base. The
 * per-viewer/role gating and the signed evidence paths are baked at READ time (the base carries neither),
 * so the stored row is neither per-viewer nor time-limited. The rebuild SEED reads the max committed
 * position FIRST, then the base (which therefore reflects at least that far), and returns the max — so the
 * barrier's replay covers `(max .. H]` with idempotent overlap and no gap.
 *
 * The atomic activity↔inspection sign-off events (`activity.signed_off`/`activity.signoff_rejected`) are
 * ACTIVITY events, not inspection persistence changes — the inspection's `decided` flip that CAUSES them
 * rides the paired `inspection.approved`/`inspection.rejected` event, so refreshing on `inspection.*`
 * already captures every inspection change.
 */

export const INSPECTIONS_PROJECTION = 'inspections.inbox';

/** Dispatch the inspection lifecycle events (`inspection.*`); every other event is a no-op that still
 *  advances the ordered cursor. */
function deliveryFor(meta: EmittedEventMeta): DeliveryPlan {
  return meta.eventType.startsWith('inspection.') ? { action: 'dispatch' } : { action: 'noop' };
}

/** Refresh the project's single generation-scoped inspection base from CANONICAL inspection state. */
async function refreshRow(tx: Prisma.TransactionClient, generationId: string, projectId: string): Promise<void> {
  const base = await computeInspectionsBase(tx, projectId);
  const dto = base as unknown as Prisma.InputJsonValue;
  await tx.inspectionsProjection.upsert({
    where: { generationId_projectId: { generationId, projectId } },
    create: { generationId, projectId, dto },
    update: { dto },
  });
}

/** Build the `inspections.inbox` projection consumer (reads canonical inspection state to refresh its row). */
export function makeInspectionsProjectionConsumer(): OutboxConsumer {
  return {
    name: INSPECTIONS_PROJECTION,
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
        await tx.inspectionsProjection.deleteMany({ where: { generationId: target.generationId } });
      },
    },
    handle: async (ctx) => {
      if (!ctx.tx) throw new Error('inspections projection needs a transaction');
      if (!ctx.projection) throw new Error('inspections projection needs a target generation');
      // The slices are per-project (not per-entity), so any inspection event refreshes the whole project
      // row from canonical state — the event's projectId is the key.
      await refreshRow(ctx.tx, ctx.projection.generationId, ctx.meta.projectId);
    },
  };
}
