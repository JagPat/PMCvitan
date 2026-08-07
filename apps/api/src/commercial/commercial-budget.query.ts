import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { LabourRequirementQuery } from '../labour/labour.query';
import { ProcurementQuery } from '../procurement/procurement.query';
import { InventoryQuery } from '../inventory/inventory.query';
import { CommercialMeasurementQuery } from './commercial-measurement.query';
import { CommercialBillQuery } from './commercial-bill.query';
import { CommercialDeductionQuery } from './commercial-deduction.query';
import { CommercialPaymentQuery } from './commercial-payment.query';

const ZERO = new Prisma.Decimal(0);

/**
 * MONEY SCALE (Codex round-2 P2). Every persisted money column is `Decimal(18,2)`, so the fold's
 * own arithmetic must land on that scale before anything DECIDES on it or STORES it.
 *
 * The prorations here divide — `committedAmountBase × ACCEPTED / qty` on a 3-unit line, a
 * close-short remainder — and a full-precision quotient can leave headroom at −0.003. Unrounded,
 * `isNegative()` is true, the §B exception is written with `headroom = -0.003`, PostgreSQL rounds
 * it to `0.00` on the way into `Decimal(18,2)`, and the `headroom < 0` CHECK then REJECTS the row —
 * aborting the budget revision or PO issue that was merely reporting a sub-cent rounding artefact.
 *
 * Rounding at the fold fixes it at the source: a third of a paisa is not a breach, and the read
 * surface and the exception register cannot disagree because both consume this one rounded result.
 */
const MONEY_DP = 2;
const money = (d: Prisma.Decimal): Prisma.Decimal => d.toDecimalPlaces(MONEY_DP, Prisma.Decimal.ROUND_HALF_UP);

/** One cost head's money picture, all amounts exact `Decimal(18,2)` (§A — never float64). */
export interface CostHeadPosition {
  costHeadCode: string;
  /** `BUDGET(costHead)` — the amount of the LIVE budget version only, or null if unbudgeted. */
  budget: Prisma.Decimal | null;
  /** `COMMITTED(costHead)` — the OUTSTANDING obligation (§0), clamped at zero. */
  committed: Prisma.Decimal;
  /** Received-but-unbilled value. At this task there is no bill, so this is the whole received
   *  side; Tasks 4–6 subtract `BILLED_AMOUNT` from it. */
  receivedNotBilled: Prisma.Decimal;
  /** §J `awaiting-certification` — live `BILLED_AMOUNT`, the money a vendor has CLAIMED against
   *  this head and nobody has certified. Phase 5 Task 4 (Codex round-2): the fold existed and had
   *  no caller, so a ₹40 claim against a ₹100 receipt still reported the whole ₹100 as unbilled —
   *  the surface saying billed work is unbilled. The two buckets PARTITION the received money.
 */
  awaitingCertification: Prisma.Decimal;
  /** §J `certified-payable` — money a certifier has turned into an obligation anyone may approve.
   *
   *  §J defines it as `NET_PAYABLE − APPROVED`. Both refinements are the identity at this tree and
   *  neither is stubbed out: `NET_PAYABLE` is the certificate less UNRELEASED deductions and the §H
   *  ledger is 5C's, `APPROVED` is Task 6's. The subtraction each performs lands with the fact that
   *  supplies it — the same way `MEASURED` and `BILLED_AMOUNT` arrived here — so this term is the
   *  full definition evaluated against the facts that exist, not a placeholder for it. */
  certifiedPayable: Prisma.Decimal;
  /** §J `approved` — `APPROVED − PAID`, the money authorised to leave that has not left yet.
   *  Task 7A. Naming it after `APPROVED(bill)` would double-count every partial payment: a ₹100
   *  approved bill with ₹40 paid would report ₹140 across this bucket and `paid` for one ₹100
   *  payable. Every §J bucket subtracts the one downstream of it, and this is no exception. */
  approved: Prisma.Decimal;
  /** §J `paid` — `PAID(bill)`, Σ payments less Σ payment reversals (§0). Task 7A, and §J calls it
   *  "the only raw fold, because paid cash is where the money stops": every other bucket subtracts
   *  its successor, and this one has no successor to subtract. */
  paid: Prisma.Decimal;
  /** `Σ exposure` — the buckets that measure against the budget, rounded to the money scale.
   *  Carried explicitly so the exception row's `headroom = budget - exposure` CHECK holds by
   *  construction rather than by a caller re-deriving the same subtraction. */
  exposure: Prisma.Decimal;
  /** `BUDGET − Σ exposure`. Deliberately allowed to go NEGATIVE — that is the over-commitment
   *  signal the §B exception fires on, not an error to clamp away. Null when unbudgeted. */
  headroom: Prisma.Decimal | null;
}

/**
 * Phase 5 Task 2 — `BUDGET` and `COMMITTED`, folded from canonical facts (§0/§B/§C).
 *
 * **The attribution is the ONLY new fact; the amount is not copied.** This fold reads the frozen
 * committed amount from each PO-line snapshot THROUGH the owning module — `ProcurementQuery` for a
 * `PurchaseOrderLine`, `LabourQuery` for a `LabourPurchaseOrderLine`, `InventoryQuery` for
 * `ACCEPTED`. One fold, three owners, no cross-module read.
 *
 * `COMMITTED` is OUTSTANDING, not gross. §0 is explicit about why: a ₹100 PO accepted but not
 * billed would otherwise sit in `committed` AND in `received-not-billed` at once, forecasting a
 * ₹200 obligation from a ₹100 order. The buckets must PARTITION the money, not overlap it.
 *
 *   COMMITTED = Σ committedAmountBase over attributions whose PO version is LIVE
 *               − the CONSUMED portion − the RELEASED portion, CLAMPED AT ZERO
 *
 * - consumed, MATERIAL: the PRORATED LANDED amount for `ACCEPTED`
 *   (`committedAmountBase × ACCEPTED / qty`) — never `rate × ACCEPTED`, which leaves the frozen
 *   tax and freight stranded.
 * - consumed, LABOUR: measured person-shifts at the frozen rate — `committedAmountBase ×
 *   MEASURED / personShiftQty`. Task 2 shipped this term as ZERO and said so in the code; Task 3
 *   adds `Measurement` (§D) and the term lands with the fact that supplies it.
 * - released: the unreceived remainder of a version CLOSED SHORT. Closing short to zero is the
 *   deliberate way to end an obligation and the fold honours it — the released part is subtracted
 *   once and never added back.
 * - CLAMPED AT ZERO because `ACCEPTED` may legitimately exceed `qty` (§G permits overage against a
 *   snapshot frozen for `qty` alone). A negative commitment is not a discount; it would silently
 *   offset other cost heads' real obligations.
 */
@Injectable()
export class CommercialBudgetQuery {
  constructor(
    private readonly procurement: ProcurementQuery,
    private readonly labour: LabourRequirementQuery,
    private readonly inventory: InventoryQuery,
    private readonly measurement: CommercialMeasurementQuery,
    private readonly bills: CommercialBillQuery,
    private readonly deductions: CommercialDeductionQuery,
    // §J — the APPROVED term of `certified-payable`. Same module, and the attribution walk is
    // shared with the withheld term rather than copied.
    private readonly payments: CommercialPaymentQuery,
  ) {}

  /**
   * The full position for every cost head in the project (or a named subset — the exception path
   * recomputes only the heads a write touched).
   */
  async positionsFor(
    tx: Prisma.TransactionClient,
    projectId: string,
    costHeadCodes?: readonly string[],
  ): Promise<Map<string, CostHeadPosition>> {
    const heads = costHeadCodes
      ? [...new Set(costHeadCodes)]
      : (await tx.costHead.findMany({ where: { projectId }, select: { code: true }, orderBy: { code: 'asc' } })).map((h) => h.code);
    const out = new Map<string, CostHeadPosition>();
    if (heads.length === 0) return out;

    const [budgets, attributions] = await Promise.all([
      tx.budgetLine.findMany({
        where: { projectId, costHeadCode: { in: heads }, supersededAt: null },
        select: { costHeadCode: true, amount: true },
      }),
      tx.commitmentAttribution.findMany({
        where: { projectId, costHeadCode: { in: heads }, supersededAt: null },
        select: { costHeadCode: true, poLineId: true, labourPoLineId: true },
      }),
    ]);
    const budgetOf = new Map(budgets.map((b) => [b.costHeadCode, b.amount]));

    const materialIds = attributions.map((a) => a.poLineId).filter((v): v is string => v !== null);
    const labourIds = attributions.map((a) => a.labourPoLineId).filter((v): v is string => v !== null);
    const [
      materialLines, labourLines, accepted, measured,
      billedMaterial, billedLabour, certifiedMaterial, certifiedLabour,
      withheldMaterial, withheldLabour,
      approvedMaterial, approvedLabour,
      paidMaterial, paidLabour,
    ] = await Promise.all([
      this.procurement.committedLinesFor(tx, projectId, materialIds),
      this.labour.committedLinesFor(tx, projectId, labourIds),
      this.inventory.acceptedFor(tx, projectId, materialIds),
      // Phase 5 Task 3 (§D) — MEASURED person-shifts, the labour CONSUMPTION term. Task 2 left
      // this at zero and said so in the code rather than hiding it; the fact that supplies it
      // ships in Task 3, so the term ships with it.
      this.measurement.measuredForPoLines(tx, projectId, labourIds),
      // Phase 5 Task 4 (§J) — live `BILLED_AMOUNT` per line, the term Task 2's own DTO comment
      // promised ("Tasks 4–6 subtract `BILLED_AMOUNT` from it").
      this.bills.billedAmountFor(tx, projectId, 'material', materialIds),
      this.bills.billedAmountFor(tx, projectId, 'labour', labourIds),
      // Phase 5 Task 5B unit C (§J) — `CERTIFIED`, the term that turns `awaiting-certification`
      // into a residual instead of a raw set.
      this.bills.certifiedAmountFor(tx, projectId, 'material', materialIds),
      this.bills.certifiedAmountFor(tx, projectId, 'labour', labourIds),
      // Phase 5 Task 5C (§H/§J) — the WITHHELD term. §J defines `certified-payable` as
      // `NET_PAYABLE − APPROVED`, and unit C shipped it with both subtractions as the identity
      // because neither fact existed. This is the first of them arriving: a withholding is money
      // that is NOT payable, so it leaves the bucket. It is read here rather than folded into
      // `certifiedAmountFor` deliberately — hiding it inside a fold this query already reads would
      // leave `FOLD_INPUTS` blind to a new input, which is the exact closure failure that pin
      // exists to prevent.
      this.deductions.withheldAmountFor(tx, projectId, 'material', materialIds),
      this.deductions.withheldAmountFor(tx, projectId, 'labour', labourIds),
      // §J — APPROVED money has left `certified-payable` whether or not it has been paid: the
      // contract defines the bucket as `NET_PAYABLE − APPROVED`, and a forecast that omits the
      // subtraction shows a practice money it has already authorised.
      this.payments.approvedAmountFor(tx, projectId, 'material', materialIds),
      this.payments.approvedAmountFor(tx, projectId, 'labour', labourIds),
      // §J unit 7A — the last term. `approved` is `APPROVED − PAID` and `paid` is `PAID`, so both
      // final buckets need this one fold and neither is a raw set.
      this.payments.paidAmountFor(tx, projectId, 'material', materialIds),
      this.payments.paidAmountFor(tx, projectId, 'labour', labourIds),
    ]);

    for (const code of heads) {
      let committed = ZERO;
      let receivedNotBilled = ZERO;
      let awaitingCertification = ZERO;
      let certifiedPayable = ZERO;
      let approvedNotPaid = ZERO;
      let paidBucket = ZERO;
      for (const a of attributions) {
        if (a.costHeadCode !== code) continue;
        if (a.poLineId) {
          const line = materialLines.get(a.poLineId);
          if (!line || !line.live) continue;
          const acceptedQty = accepted.get(a.poLineId) ?? ZERO;
          // CONSUMED (the COMMITTED subtraction) — the PRORATED LANDED amount per §0, so the
          // frozen tax and freight travel with it. Overage is handled by the clamp below: §0 is
          // explicit that on a ₹100/100-unit line with 10 overage units accepted the raw consumed
          // part is ₹110, outstanding goes to ZERO, and the overage value shows up only on the
          // received side.
          const consumed = line.qty.isZero()
            ? ZERO
            : line.committedAmountBase.mul(acceptedQty).div(line.qty);
          // released — the un-received remainder of a version closed short
          const released = line.closedShort && !line.qty.isZero()
            ? line.committedAmountBase.mul(Prisma.Decimal.max(line.qty.sub(line.receivedQty), ZERO)).div(line.qty)
            : ZERO;
          committed = committed.add(Prisma.Decimal.max(line.committedAmountBase.sub(consumed).sub(released), ZERO));
          // RECEIVED-NOT-BILLED is a DIFFERENT calculation, not a reuse of `consumed`, and §J says
          // why: the PO froze tax and freight for `qty` ALONE, so scaling the whole landed amount
          // past `qty` over-values overage. §J states it exactly —
          //   rate × ACCEPTED  +  (tax + freight) × min(ACCEPTED, qty) / qty
          // On a 100-unit / ₹1,000 line with ₹100 tax and ₹50 freight, accepting 110 units gives
          // ₹1,250 here, not the ₹1,265 an unclamped reuse produces. That phantom ₹15 would lower
          // headroom and could raise a FALSE over-budget exception — and no downstream row could
          // ever move it, because §E caps the live bill at ₹1,250 too.
          //
          // Overage is authorised as QUANTITY, so it is valued at rate only unless a PO amendment
          // freezes more tax and freight; then the amended figures are the authority and this
          // clamp follows them, because `qty`/`taxAmount`/`freightAmount` come from the CURRENT
          // live version's frozen line.
          const clampedQty = Prisma.Decimal.min(acceptedQty, line.qty);
          const receivedValue = line.qty.isZero()
            ? ZERO
            : line.rate.mul(acceptedQty)
                .add(line.taxAmount.add(line.freightAmount).mul(clampedQty).div(line.qty));
          // §J — the live claim moves money OUT of received-not-billed and INTO
          // awaiting-certification. The two are clamped so the pair never goes negative: a claim
          // may legitimately exceed the received value here, because the §E RATE check is Task 5's
          // and a vendor can claim a rate the order never froze. Carrying the excess in
          // awaiting-certification is the honest reading — an unverified over-rate claim IS extra
          // exposure until §E disputes it — and it is conservative for the budget rather than
          // flattering.
          //
          // §J unit C — and CERTIFICATION moves it on again, by the same residual rule: every
          // bucket in §J's table subtracts the one downstream of it, so `awaiting-certification`
          // is `BILLED − CERTIFIED`, exactly as `received-not-billed` is received − billed and
          // `approved` is `APPROVED − PAID`. Certifying therefore settles WHO OWES WHAT and not
          // HOW MUCH: the total exposure is unchanged and only the bucket holding it changes.
          const billed = billedMaterial.get(a.poLineId) ?? ZERO;
          const certified = certifiedMaterial.get(a.poLineId) ?? ZERO;
          const withheld = withheldMaterial.get(a.poLineId) ?? ZERO;
          const approved = approvedMaterial.get(a.poLineId) ?? ZERO;
          const paid = paidMaterial.get(a.poLineId) ?? ZERO;
          receivedNotBilled = receivedNotBilled.add(Prisma.Decimal.max(receivedValue.sub(billed), ZERO));
          awaitingCertification = awaitingCertification.add(Prisma.Decimal.max(billed.sub(certified), ZERO));
          // §H — withheld money is NOT payable, so it leaves this bucket. The clamp is belt-and-
          // braces rather than load-bearing: §H's floor is enforced on the deduction WRITE, at the
          // service and at PostgreSQL, so a withholding can never exceed the certificate it is
          // taken from and this subtraction cannot go negative through any legal path.
          certifiedPayable = certifiedPayable.add(Prisma.Decimal.max(certified.sub(withheld).sub(approved), ZERO));
          // §J unit 7A — the last two residuals. §G bound 5 caps `PAID` at `APPROVED`, so the
          // subtraction cannot go negative through any legal path; the clamp is belt-and-braces of
          // the same kind as the one above it.
          approvedNotPaid = approvedNotPaid.add(Prisma.Decimal.max(approved.sub(paid), ZERO));
          paidBucket = paidBucket.add(paid);
        } else if (a.labourPoLineId) {
          const line = labourLines.get(a.labourPoLineId);
          if (!line || !line.live) continue;
          // CONSUMED (§0) — measured person-shifts at the line's FROZEN rate. A labour PO whose
          // work has been measured is no longer an outstanding obligation for that part: the
          // money has moved to the received side exactly as an accepted material receipt does,
          // and leaving it in `committed` would forecast a ₹200 exposure from a ₹100 order.
          const measuredQty = measured.get(a.labourPoLineId) ?? ZERO;
          const consumed = line.personShiftQty > 0
            ? line.committedAmountBase.mul(measuredQty).div(line.personShiftQty)
            : ZERO;
          const released = line.closedShort && line.personShiftQty > 0
            ? line.committedAmountBase
                .mul(Math.max(line.personShiftQty - line.committedQty, 0))
                .div(line.personShiftQty)
            : ZERO;
          committed = committed.add(Prisma.Decimal.max(line.committedAmountBase.sub(consumed).sub(released), ZERO));
          // the measured value moves to received-not-billed, less whatever has been CLAIMED
          // against it — the labour twin of the material split above
          const billed = billedLabour.get(a.labourPoLineId) ?? ZERO;
          const certified = certifiedLabour.get(a.labourPoLineId) ?? ZERO;
          const withheld = withheldLabour.get(a.labourPoLineId) ?? ZERO;
          const approved = approvedLabour.get(a.labourPoLineId) ?? ZERO;
          const paid = paidLabour.get(a.labourPoLineId) ?? ZERO;
          receivedNotBilled = receivedNotBilled.add(Prisma.Decimal.max(consumed.sub(billed), ZERO));
          awaitingCertification = awaitingCertification.add(Prisma.Decimal.max(billed.sub(certified), ZERO));
          certifiedPayable = certifiedPayable.add(Prisma.Decimal.max(certified.sub(withheld).sub(approved), ZERO));
          approvedNotPaid = approvedNotPaid.add(Prisma.Decimal.max(approved.sub(paid), ZERO));
          paidBucket = paidBucket.add(paid);
        }
      }
      const budget = budgetOf.get(code) ?? null;
      // §J — budget is the CEILING the exposure buckets are measured against, never a bucket
      // itself. Task 7A completes the set: all SIX exposure buckets now exist, so headroom is
      // `BUDGET − Σ(the six)` in full rather than over whichever subset had shipped.
      //
      // Note that adding `awaitingCertification` does NOT move headroom on its own: the money it
      // holds came OUT of received-not-billed. That is the point — §J's buckets partition, so a
      // claim arriving changes WHERE the exposure sits, not how much there is. `certifiedPayable`
      // is the same story one step along: certification moves money out of awaiting-certification
      // and into it, and the sum is untouched.
      //
      // Exposure is rounded ONCE, from the full-precision sum, and headroom is derived from that
      // rounded figure — not from separately rounded buckets, whose two half-paisa errors could
      // add to a phantom cent of breach. The displayed buckets are rounded for reporting; the
      // DECISION is made on `exposure`.
      const exposure = money(
        committed.add(receivedNotBilled).add(awaitingCertification).add(certifiedPayable)
          .add(approvedNotPaid).add(paidBucket),
      );
      out.set(code, {
        costHeadCode: code,
        budget,
        committed: money(committed),
        receivedNotBilled: money(receivedNotBilled),
        awaitingCertification: money(awaitingCertification),
        certifiedPayable: money(certifiedPayable),
        approved: money(approvedNotPaid),
        paid: money(paidBucket),
        exposure,
        headroom: budget === null ? null : budget.sub(exposure),
      });
    }
    return out;
  }

  /** `BUDGET(costHead)` — the LIVE version's amount, or null when the head is unbudgeted. */
  async budgetFor(tx: Prisma.TransactionClient, projectId: string, costHeadCode: string): Promise<Prisma.Decimal | null> {
    const row = await tx.budgetLine.findFirst({
      where: { projectId, costHeadCode, supersededAt: null },
      select: { amount: true },
    });
    return row?.amount ?? null;
  }
}
