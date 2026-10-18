/**
 * #482 F-C4.1 — the ONE rule for "this checklist item failed". The engineer's submit records a fail as
 * `state = 'fail'` and never writes `result`, which only seeded data carries; the PMC's explicit Reject sets
 * `rejected`. Every check that asks whether an item failed (the send-back's implicit rejections, the
 * failed-item count, "a re-inspection exists") reads all three, so an engineer's fail is never missed.
 */
export function isFailedItem(it: { rejected: boolean; result: string | null; state?: string | null }): boolean {
  return it.rejected || it.result === 'FAIL' || it.state === 'fail';
}
