import type {
  CashForecastReadDto,
  CommercialBudgetDto,
  CommitmentAttributionDto,
  CostHeadDto,
} from '@vitan/shared';

/**
 * Phase 5 Task 7B-i (§M) — the MONEY-POSITION bundle: what `loadCommercial()` fetches together
 * when the project carries the `commercial` capability.
 *
 * This is the commercial twin of `MaterialsView` and `LabourView`, and it is deliberately the
 * SMALLER half of §M. §M's seven tabs are two user workflows, not one:
 *
 *   - *where do we stand* — budget, committed obligation, the §J cash forecast. A PMC's question,
 *     answered by four reads over facts Tasks 1–2 and 7A already cleared. THIS bundle.
 *   - *process this vendor claim* — measurements, bills, certification, payments. A different
 *     actor with different authority, and 7B-ii's bundle.
 *
 * Every member is a greenfield module-query read: none of it has ever been in the legacy snapshot,
 * so there is no XOR read-ownership flag to carry and no cutover to stage. The reads are
 * capability-gated on the SERVER too (404 off-pilot), so a non-pilot project cannot serve them
 * even if a client asked.
 */
export interface CommercialView {
  /** §B/§J — per-head budget, outstanding committed, the §J buckets and headroom, plus the count
   *  of heads standing over budget. The LIVE fold: always current, never projection-backed. */
  budget: CommercialBudgetDto;
  /** §J (Task 7A) — the same seven buckets rolled up to the project, served from the eighth
   *  rebuildable projection with a live fallback. `refreshedAt` is null on the fallback path, and
   *  the hub reports that rather than implying a freshness it does not have. */
  cashForecast: CashForecastReadDto;
  /** §C — the head catalog. Carried because the position rows key by code and a head with no
   *  activity yet appears here before it appears anywhere else. */
  costHeads: readonly CostHeadDto[];
  /** §C — the live attribution register: which cost head carries which purchase-order line. This
   *  is what makes `committed` explicable rather than merely a number. */
  attributions: readonly CommitmentAttributionDto[];
}
