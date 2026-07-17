import { Prisma } from '@prisma/client';
import type { DeliveryPlan, EmittedEventMeta, OutboxConsumer } from '../platform/outbox/registry';
import { serializeDecision, type DecisionRow } from './decision-serialize';

/**
 * Phase 2 Task 9 — the DECISIONS read-model projection consumer (`decisions.inbox`).
 *
 * The first module's read path moves onto a rebuildable projection. This ordered `db` projection
 * consumer subscribes to the six `decision.*` events; on each it REFRESHES the affected decision's
 * generation-scoped `DecisionProjection` row from the CANONICAL Decision (a same-module read — the
 * decisions module owns `decision`), storing the exact `DecisionDto` `serializeDecision` produces. A
 * non-decision event is a `noop` delivery, so the projection's ordered cursor still advances through
 * every stream position contiguously.
 *
 * Because the handler derives each row from CURRENT canonical state (not from event payloads), the
 * projection is trivially equivalent to the live snapshot slice and a rebuild replay is idempotent:
 * re-applying any decision event just re-serializes the same canonical decision. The rebuild SEED
 * loads every canonical decision into the new generation and returns the stream position it reflects
 * (read BEFORE the decisions, so the seed reflects at least that far and the replay tail covers the
 * rest — never a gap).
 */

export const DECISIONS_PROJECTION = 'decisions.inbox';

/** Dispatch the six `decision.*` events; every other event is a no-op that still advances the cursor. */
function deliveryFor(meta: EmittedEventMeta): DeliveryPlan {
  return meta.eventType.startsWith('decision.') ? { action: 'dispatch' } : { action: 'noop' };
}

/** The include the serializer needs: ordered options + the single OPEN change request. */
const DECISION_INCLUDE = {
  options: { orderBy: { order: 'asc' } },
  changeRequests: { where: { status: 'open' }, take: 1 },
} satisfies Prisma.DecisionInclude;

/** Upsert one decision's generation-scoped projection row from its canonical record. */
async function upsertRow(tx: Prisma.TransactionClient, generationId: string, d: DecisionRow): Promise<void> {
  const dto = serializeDecision(d) as unknown as Prisma.InputJsonValue;
  const keys = { status: d.status, publishedAt: d.publishedAt, authorId: d.authorId, dto };
  await tx.decisionProjection.upsert({
    where: { generationId_decisionId: { generationId, decisionId: d.id } },
    create: { generationId, projectId: d.projectId, decisionId: d.id, ...keys },
    update: keys,
  });
}

/** Build the `decisions.inbox` projection consumer (reads canonical decisions to refresh its rows). */
export function makeDecisionsProjectionConsumer(): OutboxConsumer {
  return {
    name: DECISIONS_PROJECTION,
    kind: 'ordered',
    effect: 'db',
    catalogVersion: 1,
    deliveryFor,
    projection: {
      // Seed the replacement generation from the CONSISTENT canonical snapshot. Read the max committed
      // position FIRST, then the decisions (which therefore reflect AT LEAST that far), and return the
      // max — so the barrier's replay covers (max .. H] with no gap and the overlap re-applies
      // idempotently.
      rebuildSeed: async (tx, target) => {
        const max = await tx.domainEvent.aggregate({ where: { projectId: target.projectId }, _max: { streamPosition: true } });
        const seededThrough = max._max.streamPosition ?? null;
        const rows = await tx.decision.findMany({ where: { projectId: target.projectId }, include: DECISION_INCLUDE });
        for (const d of rows) await upsertRow(tx, target.generationId, d);
        return seededThrough;
      },
      dropGeneration: async (tx, target) => {
        await tx.decisionProjection.deleteMany({ where: { generationId: target.generationId } });
      },
    },
    handle: async (ctx) => {
      if (!ctx.tx) throw new Error('decisions projection needs a transaction');
      if (!ctx.projection) throw new Error('decisions projection needs a target generation');
      const decisionId = ctx.meta.entityId;
      const d = await ctx.tx.decision.findUnique({ where: { id: decisionId }, include: DECISION_INCLUDE });
      // Decisions are never deleted today; if one is ever absent, drop its stale projection row.
      if (!d) {
        await ctx.tx.decisionProjection.deleteMany({ where: { generationId: ctx.projection.generationId, decisionId } });
        return;
      }
      await upsertRow(ctx.tx, ctx.projection.generationId, d);
    },
  };
}
