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

  /**
   * Task 7A (§J) — the PAID term, per PO line, so the last two buckets can be what §J says they
   * are: `approved` is `APPROVED − PAID` and `paid` is `PAID`.
   *
   * §J calls `paid` "the only raw fold, because paid cash is where the money stops" — every other
   * bucket subtracts the one downstream of it, and this one has nothing downstream. That is why it
   * is the only term here with no subtraction of its own.
   *
   * **`PAID` is bill-scoped while `APPROVED` is live-certificate scoped** (§0), and the asymmetry
   * survives the attribution rather than being flattened by it. An approval dies with the
   * certificate that carried it; cash that left does not. So this walks the LIVE claim lines to
   * decide which cost heads a bill touches — the shared attribution — and then folds payments over
   * the BILL rather than over its live certificate.
   *
   * That distinction is load-bearing for the partition. Superseding a certificate takes its
   * approvals out of `APPROVED`, so a bill with ₹100 paid against a superseded certificate has
   * `APPROVED = 0` and `PAID = 100`. Scoping `paid` to the live certificate would drop that ₹100
   * out of every bucket — cash gone from the practice and absent from its own forecast — and §0's
   * rule that supersession never appends a payment reversal is exactly the statement that this
   * cannot be corrected by pretending the money came back.
   */
  async paidAmountFor(
    tx: Prisma.TransactionClient,
    projectId: string,
    kind: 'material' | 'labour',
    poLineIds: readonly string[],
  ): Promise<Map<string, Prisma.Decimal>> {
    return this.deductions.attributeBillScopedTotal(
      tx, projectId, kind, poLineIds,
      async (billIds) => {
        const [paid, reversed] = await Promise.all([
          tx.payment.groupBy({
            by: ['billId'], where: { projectId, billId: { in: billIds } }, _sum: { amount: true },
          }),
          // §0's `PAID` is Σ payments MINUS Σ payment reversals (Task 6B-ii), and the §J bucket is
          // that fold — not a second definition of it. A forecast that ignored reversals would
          // report recovered cash as still spent.
          tx.paymentReversal.groupBy({
            by: ['billId'], where: { projectId, billId: { in: billIds } }, _sum: { amount: true },
          }),
        ]);
        const out = new Map<string, Prisma.Decimal>();
        for (const r of paid) out.set(r.billId, r._sum.amount ?? ZERO);
        for (const r of reversed) out.set(r.billId, (out.get(r.billId) ?? ZERO).sub(r._sum.amount ?? ZERO));
        return out;
      },
    );
  }
}
