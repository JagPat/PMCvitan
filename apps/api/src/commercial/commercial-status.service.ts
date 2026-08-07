import { ConflictException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { VendorBillStatus } from '@vitan/shared';
import { CommercialDeductionQuery } from './commercial-deduction.query';
import { derivedBillStatus, isDerivedBillStatus } from './commercial-status';

/**
 * §F — ONE re-derivation, called by EVERY writer that can move any of the three folds.
 *
 * The plan states the obligation and the reason in one line: *"One derivation, every writer that
 * can move ANY of the three folds. A status column that can disagree with its own fold is the same
 * defect in a third phase."* The two prior instances it means are Phase 4 Task 2 — a defaulted
 * commitment left a requisition line STALE, and a post-closure default left a closed parent with an
 * open child. Both were a stored status that stopped tracking the fold beneath it.
 *
 * **THE DERIVATION IS NOT MONOTONIC, AND THIS IS WHERE THAT IS ENFORCED.** `deductions.release`
 * RAISES `NET_PAYABLE`, so a bill that legitimately derived `paid` must be able to go BACKWARD:
 * certify ₹100, withhold ₹10, approve and pay ₹90 — `NET_PAYABLE = PAID = ₹90`, so `paid`. Release
 * ₹5 and the truth is `certified`, because `APPROVED = PAID = ₹90 < NET_PAYABLE = ₹95`. A CAS that
 * refused to leave a terminal state would strand the bill at `paid` while §J still reports ₹5 owed
 * — precisely the stored-status-versus-fold defect this function exists to prevent. So there is no
 * forward-only guard here, deliberately, and the probe for that case is part of this unit.
 *
 * What DOES bound the transition is the status FAMILY, not its direction — see below.
 */
@Injectable()
export class CommercialStatusService {
  constructor(private readonly deductions: CommercialDeductionQuery) {}

  /**
   * Re-derive one bill's payment status from its three folds and store the result under CAS.
   *
   * **The caller must already hold the bill's row lock.** Every mover takes it (§0b: the bill is
   * taken FIRST, before any foreign row, so the lock order stays total), and the folds are only
   * trustworthy under it — this is bound 5's own serialization argument applied to the status.
   * The CAS is therefore belt-and-braces rather than the primary defence, and it is kept because a
   * silent no-op is how a stored status starts disagreeing with its fold.
   *
   * Returns the status now stored, so a caller can report it without a second read.
   */
  async reDerive(
    tx: Prisma.TransactionClient,
    projectId: string,
    billId: string,
    current: VendorBillStatus,
  ): Promise<VendorBillStatus> {
    // A bill before certification is not derived at all: its status is §F's FORWARD lifecycle
    // (`draft`…`verified`, `disputed`, `rejected`), which no fold can move. Guarding on the FAMILY
    // rather than on the direction is what lets the backward `paid → certified` move above through
    // while still refusing to drag a `verified` bill into the payment lifecycle.
    if (!isDerivedBillStatus(current)) return current;

    const folds = await this.deductions.foldsFor(tx, projectId, billId);
    const next = derivedBillStatus(folds);
    if (next === current) return current;

    const { count } = await tx.vendorBill.updateMany({
      where: { id: billId, projectId, status: current },
      data: { status: next, statusChangedAt: new Date() },
    });
    if (count === 0) {
      throw new ConflictException('This claim moved concurrently — reload and retry');
    }
    return next;
  }
}
