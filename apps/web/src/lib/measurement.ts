import { decAdd, decGt, decSub, decMin } from '@/lib/decimal';
import type { MeasurementRegisterDto } from '@vitan/shared';

/**
 * §D — what the measurement register ALREADY PROVES about the next write.
 *
 * These are not a second opinion on the server's rules. They are arithmetic on numbers the server
 * itself computed and put on screen: `measured` is its fold, `effort` its worked-minutes cap, and
 * `liveAuthorityPersonShiftQty` what the purchase-order line authorises NOW. When the register in
 * front of the user is enough to know a command will be refused, offering it anyway puts a write
 * into a durable outbox that tells them it was saved and then drops it on reconnect.
 *
 * The direction of the guarantee matters: the client refuses only what the register PROVES is
 * refused, and the server stays the authority. It re-derives everything under lock, sees facts this
 * screen cannot (another measurer's concurrent row), and may refuse things allowed here. What must
 * never happen is the reverse — this screen allowing something the data in its own hands rules out.
 *
 * Exact decimal arithmetic throughout: person-shifts carry up to 6dp, and float would put the
 * boundary case (`measured + qty === authority`) on the wrong side of its own comparison.
 */

/** The most that may still be measured on this line: the tighter of the effort and order caps. */
export function remainingMeasurable(register: MeasurementRegisterDto): string {
  const authority = String(register.liveAuthorityPersonShiftQty);
  const byOrder = decSub(authority, register.measured);
  const byEffort = decSub(register.effort, register.measured);
  const remaining = decMin(byOrder, byEffort);
  // a defaulted commitment authorises nothing, and an over-measured line has a negative remainder;
  // both mean "no more", which is `0` rather than a negative allowance
  return decGt('0', remaining) ? '0' : remaining;
}

/** Whether this quantity is one the register on screen already rules out. */
export function exceedsMeasurableCap(register: MeasurementRegisterDto, quantity: string): boolean {
  return decGt(quantity, remainingMeasurable(register));
}

/**
 * How much of ONE measurement row is still withdrawable — its own quantity net of the corrections
 * already addressed to it.
 *
 * Row-level rather than line-level because that is the server's floor: a correction is bounded by
 * the row it adjusts, so the line's aggregate being positive does not make a −2 against a 1-shift
 * row legal. (The aggregate rule would let one row's correction eat another row's evidence.)
 */
export function remainingWithdrawable(register: MeasurementRegisterDto, measurementId: string): string {
  const row = register.rows.find((r) => r.id === measurementId);
  if (!row) return '0';
  return register.rows
    .filter((r) => r.correctsId === measurementId)
    .reduce((net, r) => decAdd(net, r.quantity), row.quantity);
}

/** Whether this signed delta would take the row it names below zero. */
export function overWithdraws(register: MeasurementRegisterDto, measurementId: string, delta: string): boolean {
  if (!delta.startsWith('-')) return false;
  return decGt(delta.slice(1), remainingWithdrawable(register, measurementId));
}
