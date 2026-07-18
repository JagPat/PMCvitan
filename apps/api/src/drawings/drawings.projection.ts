import { Prisma } from '@prisma/client';
import type { DeliveryPlan, EmittedEventMeta, OutboxConsumer } from '../platform/outbox/registry';
import { computeDrawingsBase } from './drawings-serialize';

/**
 * Phase 2 Task 10 — the DRAWINGS read-model projection consumer (`drawings.inbox`).
 *
 * The drawings module's read path moves onto a rebuildable projection. This ordered `db` projection
 * consumer subscribes to the controlled-drawing lifecycle events (`drawing.*`); on each it REFRESHES the
 * project's single generation-scoped `DrawingsProjection` row from CANONICAL state (a same-module read —
 * the drawings module owns `drawing`/`drawingRevision`/`drawingRecipient`/`drawingAck`), storing the
 * exact viewer-INDEPENDENT base `computeDrawingsBase` produces. A non-drawing event is a `noop`
 * delivery, so the ordered cursor still advances through every stream position contiguously.
 *
 * Like the daily-log projection (per-PROJECT composite, not per-entity), a generation holds ONE row per
 * project storing the whole register base. Because the handler derives that row from CURRENT canonical
 * state (not from event payloads), the projection is trivially equivalent to the live register and a
 * rebuild replay is idempotent: re-applying any drawing event just re-serializes the same base. The
 * per-viewer fields and the signed `url` are baked at READ time (the base carries neither), so the
 * stored row is neither per-viewer nor time-limited. The rebuild SEED reads the max committed position
 * FIRST, then the base (which therefore reflects at least that far), and returns the max — so the
 * barrier's replay covers `(max .. H]` with idempotent overlap and no gap.
 */

export const DRAWINGS_PROJECTION = 'drawings.inbox';

/** Dispatch the controlled-drawing lifecycle events (`drawing.*`); every other event is a no-op that
 *  still advances the ordered cursor. */
function deliveryFor(meta: EmittedEventMeta): DeliveryPlan {
  return meta.eventType.startsWith('drawing.') ? { action: 'dispatch' } : { action: 'noop' };
}

/** Refresh the project's single generation-scoped register base from CANONICAL drawing state. */
async function refreshRow(tx: Prisma.TransactionClient, generationId: string, projectId: string): Promise<void> {
  const base = await computeDrawingsBase(tx, projectId);
  const dto = base as unknown as Prisma.InputJsonValue;
  await tx.drawingsProjection.upsert({
    where: { generationId_projectId: { generationId, projectId } },
    create: { generationId, projectId, dto },
    update: { dto },
  });
}

/** Build the `drawings.inbox` projection consumer (reads canonical drawing state to refresh its row). */
export function makeDrawingsProjectionConsumer(): OutboxConsumer {
  return {
    name: DRAWINGS_PROJECTION,
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
        await tx.drawingsProjection.deleteMany({ where: { generationId: target.generationId } });
      },
    },
    handle: async (ctx) => {
      if (!ctx.tx) throw new Error('drawings projection needs a transaction');
      if (!ctx.projection) throw new Error('drawings projection needs a target generation');
      // The register is per-project (not per-entity), so any drawing event refreshes the whole project
      // row from canonical state — the event's projectId is the key.
      await refreshRow(ctx.tx, ctx.projection.generationId, ctx.meta.projectId);
    },
  };
}
