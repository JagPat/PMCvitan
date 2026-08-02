/**
 * One shift is 12 hours.
 *
 * This lives in a LEAF file with no imports, deliberately. It was originally exported from
 * `labour-capacity.service.ts`, and Phase 5 Task 3 needed it in `labour.query.ts` for §0's
 * minutes→person-shift normalisation — which closed a module cycle at import time
 * (`labour.query → labour-capacity.service → activity.participant → commercial.participant →
 * commercial-budget.query → labour.query`) and left Nest unable to construct
 * `LabourCapacityService` at all.
 *
 * A constant that several layers need does not belong on a service. The per-row CHECK bounds a
 * single record; the CUMULATIVE bound per `(worker, civilDate, shift)` is re-derived under the
 * worker `FOR UPDATE` (Phase 4 round-3 guardrail 2 — a per-row CHECK alone cannot stop several
 * rows summing past the shift).
 */
export const SHIFT_MINUTES = 720;
