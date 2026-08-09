import { decAdd, decGt, decSub, decSum } from '@/lib/decimal';
import type { MeasurementRegisterDto } from '@vitan/shared';

/**
 * §D — what the data ON SCREEN already proves about the next write.
 *
 * These are not a second opinion on the server's rules, and — the correction this round turns on —
 * they are not an approximation of them either. Every predicate here is computed from a fact the
 * server itself put on screen, and a rule that cannot be computed soundly from those facts is
 * absent rather than approximated. The write-ahead outbox is why the distinction matters: an op is
 * persisted and reported "saved" before it is sent, so a control that guesses generously promises
 * a write reconnect will drop.
 *
 * Two things are deliberately NOT here. (A third and fourth — whether the line's order is still
 * LIVE, and what live certificates have frozen against each row — WERE missing and are now carried
 * by the register itself: round 5's lesson is that three rounds of approximating around a contract
 * gap cost more than closing the gap did.)
 *
 *  - **The EFFORT cap.** The server bounds a measurement by worked effort SCOPED TO THE ACTIVITY
 *    being measured. `MeasurementRegisterDto.effort` is `EFFORT(poLine)` — the line aggregate — so
 *    using it would enable a quantity the server refuses whenever the effort sits on a different
 *    activity. An aggregate is not a conservative stand-in for a per-activity cap, so the term is
 *    gone rather than approximated; the order authority below is exact and does the work it can.
 *  - **Concurrency.** Another measurer can consume the remainder between this render and the
 *    commit. The server re-derives under lock and stays the authority.
 *
 * The direction of the guarantee: this refuses only what the register PROVES is refused. The server
 * may still refuse more. What must never happen is the reverse — this screen enabling something the
 * data in its own hands rules out.
 *
 * Exact decimal arithmetic throughout: person-shifts carry up to 6dp, and float would put the
 * boundary case (`measured + qty === authority`) on the wrong side of its own comparison.
 */

/**
 * The most that may still be measured on this line, net of anything already queued for it.
 *
 * `pending` is the quantities of measurements sitting in the durable outbox for this line. Without
 * them, an engineer could measure the whole remainder against one activity, retarget the form to a
 * second activity before the reconcile lands, and queue the remainder twice — the exact-key pending
 * check does not see it, because the constrained resource is the LINE and the key names a pair.
 */
export function remainingMeasurable(
  register: MeasurementRegisterDto,
  pending: readonly string[] = [],
): string {
  const authority = String(register.liveAuthorityPersonShiftQty);
  const claimed = decAdd(register.measured, pending.length > 0 ? decSum(pending) : '0');
  const remaining = decSub(authority, claimed);
  // a defaulted commitment authorises nothing, and an over-claimed line has a negative remainder;
  // both mean "no more", which is `0` rather than a negative allowance
  return decGt('0', remaining) ? '0' : remaining;
}

/** Whether this quantity is one the register on screen already rules out. */
export function exceedsMeasurableCap(
  register: MeasurementRegisterDto,
  quantity: string,
  pending: readonly string[] = [],
): boolean {
  return decGt(quantity, remainingMeasurable(register, pending));
}

/** Whether a POSITIVE write is refused outright because the order behind the line is dead. */
export function lineOrdersNothing(register: MeasurementRegisterDto): boolean {
  return !register.lineLive;
}

/**
 * How much of ONE measurement row is still withdrawable: its own quantity, net of the corrections
 * already addressed to it AND of any live certificate consuming it.
 *
 * Row-level rather than line-level because that is the server's floor — a correction is bounded by
 * the row it adjusts, so a positive line total does not make a −2 against a 1-shift row legal.
 * The certificate term is the second floor §D names: withdrawing evidence a live certificate rests
 * on requires superseding that certificate first, so those person-shifts are not available here.
 */
export function remainingWithdrawable(
  register: MeasurementRegisterDto,
  measurementId: string,
): string {
  const row = register.rows.find((r) => r.id === measurementId);
  if (!row) return '0';
  const net = register.rows
    .filter((r) => r.correctsId === measurementId)
    .reduce((acc, r) => decAdd(acc, r.quantity), row.quantity);
  const consumed = register.certifiedConsumption
    .filter((c) => c.rowId === measurementId)
    .reduce((acc, c) => decAdd(acc, c.consumedQty), '0');
  const free = decSub(net, consumed);
  return decGt('0', free) ? '0' : free;
}

/**
 * Whether this signed delta is one the data on screen rules out.
 *
 * A POSITIVE correction is another measurement as far as the server is concerned — it re-checks the
 * same caps — so it is bounded by the line's remaining authority, not by the row. A NEGATIVE one is
 * bounded by what its row still has to give.
 */
export function correctionRefused(
  register: MeasurementRegisterDto,
  measurementId: string,
  delta: string,
  pending: readonly string[] = [],
): boolean {
  if (delta.startsWith('-')) {
    return decGt(delta.slice(1), remainingWithdrawable(register, measurementId));
  }
  // a positive correction is measured work: the line must still be LIVE and within its authority
  return !register.lineLive || exceedsMeasurableCap(register, delta, pending);
}
