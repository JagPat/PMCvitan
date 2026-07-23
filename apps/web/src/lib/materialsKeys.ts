/**
 * Phase 3 Task 7 (correction 3) — the DETERMINISTIC COALESCE keys for the pilot MATERIALS commands.
 *
 * These are NOT idempotency keys. Correction 2 conflated the two; the re-review (finding 1) showed why
 * that is wrong: a permanently-derived key identifies a RESOURCE, not a command ATTEMPT, so it blocks
 * legitimate future repetitions (reserve → release → reserve again; issuing the same quantity twice) and
 * collides when the planner offers two candidates from the same lot.
 *
 * The split (correction 3):
 *  • the IDEMPOTENCY key — a FRESH `newIdempotencyKey()` minted ONCE per deliberate user action, persisted
 *    on the outbox op and reused unchanged for every retry/reload (so a lost response replays exactly once),
 *    and DIFFERENT for the next legitimate action after this one resolves; and
 *  • the COALESCE key (here) — a deterministic identity used ONLY to dedupe an EQUIVALENT action while it
 *    is still PENDING (a double-click, or a reload that finds the op still queued). Once the action
 *    resolves it leaves `materialsPending`, so a later identical legitimate action dispatches afresh.
 *
 * A reserve coalesces by `(activityId, lotId, storeLocation)` — the planner now aggregates candidates per
 * `(lotId, storeLocation)` (finding 1), so this uniquely identifies one pending reserve. Issue/consume/
 * requisition include the quantity / residual content so distinct amounts are distinct pending actions.
 */
export const reserveCoalesceKey = (activityId: string, lotId: string, storeLocation: string): string =>
  `mat:res:${activityId}:${lotId}:${storeLocation}`;

export const issueCoalesceKey = (activityId: string, lotId: string, storeLocation: string, qty: string): string =>
  `mat:iss:${activityId}:${lotId}:${storeLocation}:${qty}`;

export const consumeCoalesceKey = (issueId: string, qty: string): string =>
  `mat:con:${issueId}:${qty}`;

export const requisitionCoalesceKey = (
  activityId: string,
  lines: ReadonlyArray<{ requirementId: string; revision: number; qty: string }>,
): string => {
  const sig = lines.map((l) => `${l.requirementId}@${l.revision}x${l.qty}`).sort().join(',');
  return `mat:req:${activityId}:${sig}`;
};
