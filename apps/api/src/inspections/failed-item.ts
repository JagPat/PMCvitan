/**
 * #482 F-C4.1 — the ONE rule for "this checklist item failed". The engineer's submit records a fail as
 * `state = 'fail'` and never writes `result`, which only seeded data carries; the PMC's explicit Reject sets
 * `rejected`. Every check that asks whether an item failed (the send-back's implicit rejections, the
 * failed-item count) reads all three, so an engineer's fail is never missed. "A re-inspection exists" asks a
 * different question and reads `rejected` instead (inspections-serialize.ts).
 */
export function isFailedItem(it: { rejected: boolean; result: string | null; state?: string | null }): boolean {
  return it.rejected || it.result === 'FAIL' || it.state === 'fail';
}
