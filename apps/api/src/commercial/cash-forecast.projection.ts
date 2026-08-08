import { Prisma } from '@prisma/client';
import type { CashForecastDto, CostHeadPositionDto, DomainEventType } from '@vitan/shared';
import type { DeliveryPlan, EmittedEventMeta, OutboxConsumer } from '../platform/outbox/registry';
import type { EventActor } from '../common/actor';
import { emitEvent } from '../platform/events';
import type { CommercialBudgetQuery } from './commercial-budget.query';

const ZERO = new Prisma.Decimal(0);

/**
 * Phase 5 Task 7A — the EIGHTH rebuildable projection: the per-project CASH FORECAST
 * (`commercial.cash-forecast`, plan §J).
 *
 * RECOMPUTE-ONLY, deriving NO domain events. A rebuild replay emits zero events and zero
 * notifications, exactly like the seven projections before it.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * AN ORDINARY PROJECTION — and how it stopped being an extraordinary one
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * The first four heads of this unit refreshed the forecast WRITE-THROUGH: commercial declared
 * `producesEvents: []`, so its own money movements announced nothing, and the projection was
 * updated inside the writer's transaction instead. That produced six review findings from one
 * place — an overwrite race, a discovery race, a false `corrupt` verdict, an unlocked repair
 * sweep, a refresh obligation hung on the wrong predicate, and finally a genuine lock-order
 * inversion between the rebuild's activation barrier and a live purchase order.
 *
 * They were not six defects. They were one, and the convergence audit names it:
 *
 *   > The platform's projection machinery assumes EVERY INPUT TO A PROJECTION IS ANNOUNCED BY A
 *   > DOMAIN EVENT. Seven projections satisfied it, so it was never written down.
 *
 * Three mechanisms rest on that assumption, and each breaks silently without it: `diagnose` freezes
 * its comparison window by locking `ProjectEventStream`, which only stops writers that emit; a
 * rebuild's catch-up repairs whatever the seed missed by REPLAYING EVENTS, which repairs nothing
 * when there are none; and a stale projection is normally visible as an undelivered delivery.
 *
 * So the repair is not a fifth lock. Commercial now emits ONE weightless event — `money_moved` —
 * and this file is an ordinary consumer-only projection: the refresh has ONE path, takes NO lock of
 * its own, and writes exactly the generation the relay or the rebuilder hands it. Every mechanism
 * above works for the reason it works for the other seven.
 *
 * `computeCashForecastDto` is what the consumer refreshes with, what the operator rebuild diagnoses
 * against, and what the live read falls back to, so `live == projection == rebuild` holds BY
 * CONSTRUCTION rather than by two code paths agreeing. A probe asserts it directly.
 *
 * The projection feeds UI and forecast ONLY. No command authority reads it, so a lagging generation
 * can never change a decision — §B's over-budget exception is raised from the LIVE fold in the
 * writer's own transaction, never from this row.
 */

export const CASH_FORECAST_PROJECTION = 'commercial.cash-forecast';

/**
 * Commercial's ONE domain event, and the whole of `commercialManifest.producesEvents`.
 *
 * It lives HERE, beside `FORECAST_EVENT_TYPES` and the consumer that recognises it, because the
 * emitter and the listener agreeing on a string is precisely the kind of agreement this phase has
 * watched fail — Codex F1 was the labour PO family spelled `labour_po.*` against a catalog that
 * declares `labour.po.*`, and the whole generation stayed servable while silently dropping every
 * labour commitment. One constant, read by both sides, cannot drift from itself.
 */
export const COMMERCIAL_MONEY_EVENT = 'commercial.money_moved' as const;

/**
 * Announce that commercial money moved on this project, inside the writer's own transaction.
 *
 * This is the SINGLE emit seam, and it is DERIVED rather than listed. §B headroom is
 * `BUDGET − Σ(the six §J exposure buckets)`, so "this write moved headroom" and "this write moved a
 * §J bucket" are the SAME predicate — which is why the seam is `CommercialBudgetService.evaluate`,
 * a call every money writer already makes (`FOLD_INPUTS` fails the build if one does not). Three
 * further callers exist and each is there for a stated reason rather than by enumeration:
 * `commercial.costHead.define` and §L activation write `CostHead` rows without moving money, and
 * the two partition-only payment writes move a bucket without moving the total.
 *
 * What the event is FOR, first: the durable `OutboxDelivery` that `emitEvent` materializes in this
 * same transaction — the announcement the §J projection folds, the operator diagnostic freezes
 * against, and a rebuild's catch-up replays. Committing the money and the announcement together is
 * the property that makes all three work; a write-through refresh looked equivalent and was not.
 *
 * INVALIDATES (Task 7B-i-a): the catalog entry declares `invalidate: true, push: null`, so every
 * open tab on this project re-reads and none of them is notified. 7A shipped it weightless on the
 * grounds that nothing external consumed it, which was true until 7B-i built the Commercial hub —
 * whose refresh rides exactly that socket `changed` ping. Money moving is a state change, not news.
 *
 * The returned meta is still DISCARDED by every caller, and now that is a property rather than an
 * omission: `executeCommand` collects what a command emitted (see `platform/events.ts`), so the
 * announcement reaches the post-commit dispatcher without any of the call frames between here and
 * the command body having to know it exists. That matters because those frames belong to
 * procurement, labour and inventory as often as to commercial.
 */
export async function announceMoneyMoved(
  tx: Prisma.TransactionClient,
  projectId: string,
  actor: EventActor,
  moved: { readonly costHeadCodes: readonly string[]; readonly reason: string },
): Promise<EmittedEventMeta> {
  return emitEvent(tx, {
    projectId,
    actor,
    eventType: COMMERCIAL_MONEY_EVENT,
    entityType: 'Project',
    entityId: projectId,
    // WHICH heads and WHY — the same two facts §B stamps on a `BudgetException`. A replayed event
    // is recomputed from canonical state rather than from this payload, so it is explanation for a
    // person reading the stream, never an input to the fold.
    payload: { costHeadCodes: [...moved.costHeadCodes], reason: moved.reason },
    effectKey: COMMERCIAL_MONEY_EVENT,
    dispatch: {},
  });
}

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
 * The ONE source shared by the consumer refresh, the rebuild seed, the `commercial.cash-forecast`
 * read and the operator rebuild diagnostic.
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
 * Store the project's forecast row into ONE generation — the one the caller is responsible for.
 *
 * There is exactly one refresh path now, and `generationId` is REQUIRED rather than discovered.
 * That is the whole of what the event repair bought, so it is worth naming what disappeared:
 *
 *   - no generation DISCOVERY, so no race with a `building` generation appearing mid-write. The
 *     rebuilder seeds its own generation and hands the id in; the relay locks the ACTIVE generation
 *     and hands that id in. Nothing else writes here.
 *   - no LOCK of any kind. The relay already holds the target generation row `FOR UPDATE`; the
 *     rebuilder is the single writer of a `building` generation and holds it too. A projection that
 *     takes no lock cannot invert one.
 *   - no window between a seed and an activation for a silent commercial write to slip through: a
 *     commercial write now allocates a stream position, so it is either before the seed (visible to
 *     it) or after it (replayed by catch-up, which is what catch-up is for).
 */
export async function refreshCashForecast(
  tx: Prisma.TransactionClient, projectId: string, generationId: string,
): Promise<void> {
  const dto = (await computeCashForecastDto(tx, projectId)) as unknown as Prisma.InputJsonValue;
  await tx.cashForecastProjection.upsert({
    where: { generationId_projectId: { generationId, projectId } },
    create: { generationId, projectId, dto },
    update: { dto },
  });
}

/**
 * Every event that moves a §J bucket — commercial's own and the foreign ones alike.
 *
 * Each changes a term the fold reads: a PO's lifecycle moves `COMMITTED`, an acceptance or a
 * measurement moves the received side, a stock reversal moves it back, and `commercial.money_moved`
 * announces certification, approval, payment, reversal, withholding, advance recovery, a budget
 * revision, a re-attribution and a cost-head definition — every act that changes what commercial's
 * own tables say.
 */
export const FORECAST_EVENT_TYPES: readonly DomainEventType[] = [
  // Phase 5 Task 7A — commercial's ONE event, by CONSTANT rather than by a second spelling of the
  // string. Before it existed these buckets were refreshed write-through from inside each writer's
  // transaction; see the header for why that was wrong.
  COMMERCIAL_MONEY_EVENT,
  'po.issued', 'po.amended', 'po.cancelled', 'po.closed_short',
  // Codex F1 (P1). These four were written `labour_po.*` — a plausible name that does not exist.
  // The canonical family is `labour.po.*`, and the consequence of the typo was worse than a missed
  // refresh: an unrecognised type is a NO-OP delivery, and a no-op still advances the ordered
  // cursor to the stream head. So the generation stayed SERVABLE while omitting every labour
  // commitment, and `readCashForecast` served it as authoritative rather than falling back live.
  //
  // The fix is the TYPE, not the four strings: `readonly DomainEventType[]` makes the compiler the
  // closure, so a name the catalog does not declare cannot be written here at all. Root A once
  // more — a hand-typed list standing in for the canonical set — and this is the only form of the
  // fix that survives the next person adding an event.
  'labour.po.issued', 'labour.po.amended', 'labour.po.cancelled', 'labour.po.closed_short',
  'delivery.committed', 'delivery.revised', 'delivery.fulfilled', 'delivery.defaulted',
  'capacity.committed', 'capacity.revised', 'capacity.defaulted',
  'stock.transacted',
];
const FORECAST_EVENTS = new Set<string>(FORECAST_EVENT_TYPES);

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
        // The head is read BEFORE the compute, and the order is the correctness argument. Under
        // READ COMMITTED each statement takes a fresh snapshot, so the compute reflects at least
        // everything the aggregate saw: `seededThrough` can only UNDER-state what the seeded row
        // contains, never over-state it. Under-stating costs one idempotent replay in catch-up;
        // over-stating would silently skip a real event, which is the direction that loses money.
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
