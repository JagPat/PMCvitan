import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { CommercialDeductionQuery } from './commercial-deduction.query';

const ZERO = new Prisma.Decimal(0);

/**
 * Phase 5 Task 6A (§J) — the READ half of payment authority: the `APPROVED` term the budget fold
 * subtracts, per cost head.
 *
 * It lives here rather than on `CommercialPaymentService` for the same reason `WITHHELD` lives on
 * `CommercialDeductionQuery`: §B requires every writer of a fold input to re-evaluate headroom in
 * its own transaction, so the payment SERVICE has to depend on the evaluator — and the evaluator's
 * own budget query has to read this fold. Service and query in one class closes that loop into a
 * DI cycle. Splitting the read out is the same shape the deduction ledger already has, and it is
 * what lets both directions exist honestly: the fold reads a QUERY, the write path calls a SERVICE.
 */
@Injectable()
export class CommercialPaymentQuery {
  constructor(private readonly deductions: CommercialDeductionQuery) {}

  /**
   * §J — the APPROVED term, per PO line, so `certified-payable` can be what the shared contract
   * says it is: `NET_PAYABLE − APPROVED`.
   *
   * Codex round 1 (P2): without this a fully approved ₹100 bill still reported ₹100 awaiting
   * approval, because the budget fold subtracted only withholdings. Money that has been authorised
   * has left the "awaiting approval" bucket whether or not it has been paid, and a forecast that
   * says otherwise shows a practice money it has already committed.
   *
   * Attributed by the SAME rule as the withheld term and through the SAME function — an approval is
   * bill-scoped while the buckets are per cost head, and two copies of that attribution would
   * disagree the first time either changed. Live certificates only, for the same reason: a
   * superseded certificate's approvals are not in `APPROVED(bill)` either.
   */
  async approvedAmountFor(
    tx: Prisma.TransactionClient,
    projectId: string,
    kind: 'material' | 'labour',
    poLineIds: readonly string[],
  ): Promise<Map<string, Prisma.Decimal>> {
    return this.deductions.attributeCertificateScopedTotal(
      tx, projectId, kind, poLineIds,
      async (certificateIds) => {
        const rows = await tx.paymentApproval.groupBy({
          by: ['certificateId'],
          where: { projectId, certificateId: { in: certificateIds } },
          _sum: { amount: true },
        });
        return new Map(rows.map((r) => [r.certificateId, r._sum.amount ?? ZERO]));
      },
    );
  }
}
