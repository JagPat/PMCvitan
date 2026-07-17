import { Prisma } from '@prisma/client';
import type { DeliveryPlan, EmittedEventMeta, OutboxConsumer } from '../platform/outbox/registry';
import { computeDailyLogSlice } from './daily-log-serialize';

/**
 * Phase 2 Task 10 — the DAILY-LOG read-model projection consumer (`daily-log.inbox`).
 *
 * The daily-log module's read path moves onto a rebuildable projection. This ordered `db` projection
 * consumer subscribes to the daily-log lifecycle events (`dailylog.*` + `material.*`); on each it
 * REFRESHES the project's single generation-scoped `DailyLogProjection` row from CANONICAL state (a
 * same-module read — the daily-log module owns `dailyLog`/`crewRow`/`siteMaterial`), storing the exact
 * slice `computeDailyLogSlice` produces. A non-daily-log event is a `noop` delivery, so the ordered
 * cursor still advances through every stream position contiguously.
 *
 * Unlike the decisions projection (one row per decision), the daily-log slice is a per-PROJECT
 * composite (the latest log core + every project material), so a generation holds ONE row per project.
 * Because the handler derives that row from CURRENT canonical state (not from event payloads), the
 * projection is trivially equivalent to the live snapshot slice and a rebuild replay is idempotent:
 * re-applying any daily-log event just re-serializes the same canonical slice. The rebuild SEED loads
 * the slice into the new generation and returns the stream position it reflects (read BEFORE the
 * slice, so the seed reflects at least that far and the replay tail covers the rest — never a gap).
 */

export const DAILY_LOG_PROJECTION = 'daily-log.inbox';

/** Dispatch the daily-log lifecycle events (`dailylog.*` + `material.*`); every other event is a
 *  no-op that still advances the ordered cursor. */
function deliveryFor(meta: EmittedEventMeta): DeliveryPlan {
  return meta.eventType.startsWith('dailylog.') || meta.eventType.startsWith('material.')
    ? { action: 'dispatch' }
    : { action: 'noop' };
}

/** Refresh the project's single generation-scoped slice row from CANONICAL daily-log state. */
async function refreshRow(tx: Prisma.TransactionClient, generationId: string, projectId: string): Promise<void> {
  const slice = await computeDailyLogSlice(tx, projectId);
  const dto = slice as unknown as Prisma.InputJsonValue;
  await tx.dailyLogProjection.upsert({
    where: { generationId_projectId: { generationId, projectId } },
    create: { generationId, projectId, dto },
    update: { dto },
  });
}

/** Build the `daily-log.inbox` projection consumer (reads canonical daily-log state to refresh its row). */
export function makeDailyLogProjectionConsumer(): OutboxConsumer {
  return {
    name: DAILY_LOG_PROJECTION,
    kind: 'ordered',
    effect: 'db',
    catalogVersion: 1,
    deliveryFor,
    projection: {
      // Seed the replacement generation from the CONSISTENT canonical snapshot. Read the max committed
      // position FIRST, then the slice (which therefore reflects AT LEAST that far), and return the
      // max — so the barrier's replay covers (max .. H] with no gap and the overlap re-applies
      // idempotently.
      rebuildSeed: async (tx, target) => {
        const max = await tx.domainEvent.aggregate({ where: { projectId: target.projectId }, _max: { streamPosition: true } });
        const seededThrough = max._max.streamPosition ?? null;
        await refreshRow(tx, target.generationId, target.projectId);
        return seededThrough;
      },
      dropGeneration: async (tx, target) => {
        await tx.dailyLogProjection.deleteMany({ where: { generationId: target.generationId } });
      },
    },
    handle: async (ctx) => {
      if (!ctx.tx) throw new Error('daily-log projection needs a transaction');
      if (!ctx.projection) throw new Error('daily-log projection needs a target generation');
      // The slice is per-project (not per-entity), so any daily-log/material event refreshes the whole
      // project row from canonical state — the event's projectId is the key.
      await refreshRow(ctx.tx, ctx.projection.generationId, ctx.meta.projectId);
    },
  };
}
