import { Prisma } from '@prisma/client';
import type { VendorBillStatus } from '@vitan/shared';

/**
 * §F — THE PAYMENT STATUS IS DERIVED, NEVER STORED-AND-TRUSTED.
 *
 * Carried forward from the plan's §F table verbatim, in the order the plan fixes:
 *
 * | Condition                      | Status                                                     |
 * |--------------------------------|------------------------------------------------------------|
 * | `NET_PAYABLE = PAID`           | `paid` — nothing remains payable. FIRST ARM, only terminal  |
 * | `APPROVED = 0`                 | `certified` — payable, not yet approved                     |
 * | `PAID = APPROVED < NET_PAYABLE`| `certified` — approved portion settled; rest is UNAPPROVED  |
 * | `PAID = 0 < APPROVED`          | `approved-for-payment`                                      |
 * | `0 < PAID < APPROVED`          | `part-paid`                                                 |
 *
 * FIRST MATCH WINS, and the order is load-bearing in both directions:
 *
 *   - `NET_PAYABLE = PAID` must be asked FIRST. Certify ₹100 and offset it entirely with a ₹100
 *     advance-recovery: `NET_PAYABLE = APPROVED = PAID = 0`. If `APPROVED = 0` came first the bill
 *     would sit at `certified` forever, because approval and payment rows are STRICTLY POSITIVE
 *     (§H) — there exists no legal row anyone could write to advance it. A bill with nothing left
 *     to pay is settled, and the status has to be able to say so.
 *   - The derivation must never INVENT an approval. Making any `NET_PAYABLE > APPROVED` derive
 *     `approved-for-payment` manufactures the opposite error: release ₹5 against a ₹100/₹10
 *     certificate before anyone approves anything, and the bill enters the POST-approval lifecycle
 *     with `APPROVED = 0`. A status that overstates authority is worse than one that understates
 *     cash — the first invites a payment, the second only delays one.
 *
 * The `PAID = APPROVED < NET_PAYABLE` arm is why a retention RELEASE re-derives too: a release
 * raises `NET_PAYABLE`, which makes money payable that no approval covers. Certify ₹100 with ₹10
 * retention, approve and pay ₹90, then release ₹5 — `APPROVED = PAID = ₹90`, and without this arm
 * every clause says `paid` while §J correctly reports ₹5 still sitting in `certified-payable`. A
 * stored status contradicting the forecast built from the same folds is exactly the defect this
 * function exists to prevent.
 */
export interface BillFolds {
  /** §H — the live certificate's certified amount less its unreleased withholdings. */
  netPayable: Prisma.Decimal;
  /** §0 — Σ approvals against the bill's LIVE certificate. */
  approved: Prisma.Decimal;
  /** §0 — Σ payments MINUS Σ payment reversals. Reversals arrive in 6B-ii; the fold is the same. */
  paid: Prisma.Decimal;
}

export const derivedBillStatus = ({ netPayable, approved, paid }: BillFolds): VendorBillStatus => {
  if (netPayable.equals(paid)) return 'paid';
  if (approved.isZero()) return 'certified';
  if (paid.equals(approved) && approved.lessThan(netPayable)) return 'certified';
  if (paid.isZero()) return 'approved-for-payment';
  return 'part-paid';
};

/**
 * The statuses this derivation OWNS. A bill before certification is not derived at all — its status
 * is the §F forward lifecycle (`draft`…`verified`, `disputed`, `rejected`), which no fold can move.
 *
 * This set is what makes re-derivation safe to call from any fold-mover: a mover that runs while
 * the bill is still `verified` (a deduction cannot be, but the list is defensive) must not drag it
 * into the payment lifecycle.
 */
export const DERIVED_BILL_STATUSES: readonly VendorBillStatus[] = [
  'certified',
  'approved-for-payment',
  'part-paid',
  'paid',
];

export const isDerivedBillStatus = (status: VendorBillStatus): boolean =>
  DERIVED_BILL_STATUSES.includes(status);
