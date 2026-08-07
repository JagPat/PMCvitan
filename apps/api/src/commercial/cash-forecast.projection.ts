import { Prisma } from '@prisma/client';
import type { CashForecastDto, CostHeadPositionDto } from '@vitan/shared';
import type { DeliveryPlan, EmittedEventMeta, OutboxConsumer } from '../platform/outbox/registry';
import type { CommercialBudgetQuery } from './commercial-budget.query';

const ZERO = new Prisma.Decimal(0);

/**
 * Phase 5 Task 7A — the EIGHTH rebuildable projection: the per-project CASH FORECAST
 * (`commercial.cash-forecast`, plan §J).
 *
 * RECOMPUTE-ONLY, deriving NO domain events. A rebuild replay emits zero events and zero
 * notifications, exactly like the six projections before it.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * TWO REFRESH PATHS, ONE COMPUTE FUNCTION — and why that is not a compromise
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * Every other projection refreshes purely from the outbox, because every fact it derives from is
 * announced by a domain event. This one cannot, and the reason is a DECLARED architectural
 * decision rather than an oversight: `commercial.producesEvents` is `[]`, justified in the
 * manifest as "an internal accounting fact with no external effect and no consumer". Certifying,
 * approving, paying, withholding and recovering an advance are the biggest movers of the §J
 * buckets, and none of them emits anything.
 *
 * So the refresh has two paths and they are chosen by WHO OWNS the fact that moved:
 *
 *   - FOREIGN facts — acceptance, the PO lifecycle, measurement — already emit canonical events,
 *     and this ordered `db` consumer refreshes on them exactly as the other projections do.
 *   - COMMERCIAL facts refresh WRITE-THROUGH, inside the same transaction as the write, at a seam
 *     that already exists and is DERIVED rather than listed: `CommercialBudgetService.evaluate`.
 *     §B headroom is `BUDGET − Σ(the six §J exposure buckets)`, so "this write moved headroom" and
 *     "this write moved a §J bucket" are the SAME predicate. Every money writer already calls
 *     `evaluate` — the `FOLD_INPUTS` closure fails the build if one does not — so a writer cannot
 *     satisfy §B and forget §J. One further seam exists, `commercial.costHead.define`, because
 *     defining or renaming a head changes what the forecast SAYS while moving no money at all; it
 *     is the ONLY exception and CLOSURE C pins that there is no third.
 *
 * **What makes the two paths safe is that neither computes anything.** Both call
 * `computeCashForecastDto`, which is also what the operator rebuild diagnoses against and what the
 * read serves. `live == projection == rebuild` therefore holds BY CONSTRUCTION rather than by two
 * code paths agreeing — the same property the material and labour readiness projections have, and
 * the reason they were correct. A probe asserts it directly rather than leaving it to this comment.
 *
 * The alternative — giving commercial an event family — was considered and put to JagPat rather
 * than chosen silently: it reverses a declared manifest decision, adds ~8 events to the sealed
 * external-effect catalog, and grows this unit past its review budget on its own. The write-through
 * seam costs one call at each of the writers that already re-evaluate.
 *
 * The projection feeds UI and forecast ONLY. No command authority reads it, so a lagging generation
 * can never change a decision — §B's over-budget exception is raised from the LIVE fold in the
 * writer's own transaction, never from this row.
 */

export const CASH_FORECAST_PROJECTION = 'commercial.cash-forecast';

let boundDeps: { budget: CommercialBudgetQuery } | null = null;

/** Boot binds the budget query the recompute routes through (idempotent). */
export function bindCashForecastDeps(deps: { budget: CommercialBudgetQuery }): void {
  boundDeps = deps;
}
function deps(): { budget: CommercialBudgetQuery } {
  if (!boundDeps) throw new Error('cash-forecast projection deps not bound — call bindCashForecastDeps at boot');
  return boundDeps;
}

/**
 * The CANONICAL per-project cash forecast (§J), recomputed on the given transaction.
 *
 * The ONE source shared by the consumer refresh, the write-through refresh, the
 * `commercial.cash-forecast` read and the operator rebuild diagnostic.
 *
 * `budget` is reported ALONGSIDE headroom and is NEVER an addend: §J is explicit that it is the
 * CEILING the six exposure buckets are measured against, and two earlier revisions of that section
 * got it wrong in opposite directions.
 *
 * The per-head rows are NOT built here. They come from `CommercialBudgetQuery.serializedPositionsFor`
 * — the same call the LIVE `commercial.budget` read serves — so this function adds one thing and
 * one thing only: the project roll-up. There is therefore no second place a bucket definition can
 * drift to, and the projection cannot disagree with the live read about what a bucket MEANS,
 * because it does not know: it asks.
 */
export async function computeCashForecastDto(
  tx: Prisma.TransactionClient,
  projectId: string,
): Promise<CashForecastDto> {
  const { heads } = await deps().budget.serializedPositionsFor(tx, projectId);

  // Project totals — the six exposure buckets summed, with `budget` summed SEPARATELY as authority.
  // A head with no budget contributes nothing to the authority total and its exposure still counts.
  // That is the honest reading rather than a convenience: unbudgeted spend is exposure nobody
  // authorised, not exposure that does not exist, and netting it away would make a project that has
  // budgeted nothing report perfect headroom.
  const sum = (pick: (r: CostHeadPositionDto) => string | null): Prisma.Decimal =>
    heads.reduce((t, r) => { const v = pick(r); return v === null ? t : t.add(new Prisma.Decimal(v)); }, ZERO);
  const exposure = sum((r) => r.exposure);
  const budget = sum((r) => r.budget);
  return {
    heads,
    totals: {
      budget: budget.toFixed(2),
      committed: sum((r) => r.committed).toFixed(2),
      receivedNotBilled: sum((r) => r.receivedNotBilled).toFixed(2),
      awaitingCertification: sum((r) => r.awaitingCertification).toFixed(2),
      certifiedPayable: sum((r) => r.certifiedPayable).toFixed(2),
      approved: sum((r) => r.approved).toFixed(2),
      paid: sum((r) => r.paid).toFixed(2),
      exposure: exposure.toFixed(2),
      // §J — headroom is the CEILING less the six, one visible subtraction. Summing per-head
      // headroom instead would silently DROP unbudgeted heads' exposure, because their headroom is
      // null: a project with one ₹100 budgeted head at ₹0 spend and one unbudgeted head carrying
      // ₹500 of commitments would report +₹100 of room while owing ₹500.
      headroom: budget.sub(exposure).toFixed(2),
    },
  };
}

/**
 * Store the project's forecast row. Exported because BOTH refresh paths call it — the ordered
 * consumer below for foreign events, and the commercial writers write-through for their own facts.
 *
 * WITHOUT a `generationId` (the write-through path) this refreshes every LIVE generation of THIS
 * project, and both halves of that are load-bearing:
 *
 *   - every LIVE generation, not just the serving one, because a rebuild runs a `building`
 *     generation alongside the `active` one. A commercial write lands in the window between the
 *     rebuild's canonical seed and its activation barrier, emits NOTHING for the catch-up phase to
 *     apply, and would therefore activate a generation holding a pre-write money picture — the
 *     rebuild making the projection WORSE, which is the one thing a repair must never do.
 *     `retired` generations are excluded: nothing serves them and nothing will.
 *   - this project's, because generations are per (consumer, project). An unscoped query would
 *     write this project's money into every other project's generation row for this consumer.
 *
 * A project with no generation yet stores nothing and that is correct: the read falls back to the
 * live compute until the relay establishes one, which is the same warm-up every projection has.
 */
export async function refreshCashForecast(
  tx: Prisma.TransactionClient, projectId: string, generationId?: string,
): Promise<void> {
  const dto = (await computeCashForecastDto(tx, projectId)) as unknown as Prisma.InputJsonValue;
  const targets = generationId
    ? [generationId]
    : (await tx.projectionGeneration.findMany({
        where: { consumer: CASH_FORECAST_PROJECTION, projectId, status: { in: ['active', 'building'] } },
        select: { id: true },
      })).map((g) => g.id);
  for (const id of targets) {
    await tx.cashForecastProjection.upsert({
      where: { generationId_projectId: { generationId: id, projectId } },
      create: { generationId: id, projectId, dto },
      update: { dto },
    });
  }
}

/**
 * The FOREIGN events that move a §J bucket. Commercial's own writes are absent by construction —
 * it emits nothing — and they refresh write-through instead.
 *
 * Each of these changes a term the fold reads: a PO's lifecycle moves `COMMITTED`, an acceptance
 * or a measurement moves the received side, and a stock reversal moves it back.
 */
const FORECAST_EVENTS = new Set([
  'po.issued', 'po.amended', 'po.cancelled', 'po.closed_short',
  'labour_po.issued', 'labour_po.amended', 'labour_po.cancelled', 'labour_po.closed_short',
  'delivery.committed', 'delivery.revised', 'delivery.fulfilled', 'delivery.defaulted',
  'capacity.committed', 'capacity.revised', 'capacity.defaulted',
  'stock.transacted',
]);

function deliveryFor(meta: EmittedEventMeta): DeliveryPlan {
  return FORECAST_EVENTS.has(meta.eventType) ? { action: 'dispatch' } : { action: 'noop' };
}

/** Build the `commercial.cash-forecast` projection consumer. */
export function makeCashForecastProjectionConsumer(): OutboxConsumer {
  return {
    name: CASH_FORECAST_PROJECTION,
    kind: 'ordered',
    effect: 'db',
    catalogVersion: 1,
    deliveryFor,
    projection: {
      rebuildSeed: async (tx, target) => {
        const max = await tx.domainEvent.aggregate({
          where: { projectId: target.projectId }, _max: { streamPosition: true },
        });
        const seededThrough = max._max.streamPosition ?? null;
        await refreshCashForecast(tx, target.projectId, target.generationId);
        return seededThrough;
      },
      dropGeneration: async (tx, target) => {
        await tx.cashForecastProjection.deleteMany({ where: { generationId: target.generationId } });
      },
    },
    handle: async (ctx) => {
      if (!ctx.tx) throw new Error('cash-forecast projection needs a transaction');
      if (!ctx.projection) throw new Error('cash-forecast projection needs a target generation');
      await refreshCashForecast(ctx.tx, ctx.meta.projectId, ctx.projection.generationId);
    },
  };
}
