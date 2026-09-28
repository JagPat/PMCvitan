import type { DecisionStatus } from '@vitan/shared';

/**
 * The statuses whose question is still OPEN to consultation: `pending` and `change` since 4c, and
 * `awaiting_countersign` (an approval the architect has yet to countersign is still open to advice;
 * 4d-ii-a / A4d, #652's review finding 4117700813). The database's consultation seals admit exactly
 * this set (`20271227000000_phase6_t4d_ii_consultation_finalized_cycle`), pinned by
 * `consultation-open.test.ts`. The request push's claim re-judges with the same set.
 */
export const CONSULTATION_OPEN_STATUSES: readonly DecisionStatus[] = ['pending', 'change', 'awaiting_countersign'];

/** Whether a decision in `status` is open to consultation. */
export function consultationOpen(status: string): boolean {
  return (CONSULTATION_OPEN_STATUSES as readonly string[]).includes(status);
}
