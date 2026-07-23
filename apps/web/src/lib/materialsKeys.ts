/**
 * Phase 3 Task 7 (correction 2) — the STABLE idempotency keys for the pilot MATERIALS single commands.
 *
 * Every operational materials command carries a DETERMINISTIC key derived from its target (never a random
 * UUID), so:
 *  • a double-click / lost-response replay reaches the server under the SAME key ⇒ the command-ledger
 *    applies the effect exactly once (the reliability requirement), and
 *  • the store can COALESCE a duplicate dispatch, and the screen can DISABLE the button while the same key
 *    is pending — both re-derive the key from the same builder, so they never drift.
 *
 * A reservation is keyed by (lotId, storeLocation, activityId) per the directive (the offered qty is the
 * value, not the key). Issue/consume include the qty and requisition includes the residual content, so a
 * genuinely different amount is a distinct command while an identical repeat coalesces.
 */
export const reserveKey = (activityId: string, lotId: string, storeLocation: string): string =>
  `mat:res:${activityId}:${lotId}:${storeLocation}`;

export const issueKey = (activityId: string, lotId: string, storeLocation: string, qty: string): string =>
  `mat:iss:${activityId}:${lotId}:${storeLocation}:${qty}`;

export const consumeKey = (issueId: string, qty: string): string =>
  `mat:con:${issueId}:${qty}`;

export const requisitionKey = (
  activityId: string,
  lines: ReadonlyArray<{ requirementId: string; revision: number; qty: string }>,
): string => {
  const sig = lines.map((l) => `${l.requirementId}@${l.revision}x${l.qty}`).sort().join(',');
  return `mat:req:${activityId}:${sig}`;
};
