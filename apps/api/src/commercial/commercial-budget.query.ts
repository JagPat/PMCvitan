import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { LabourRequirementQuery } from '../labour/labour.query';
import { ProcurementQuery } from '../procurement/procurement.query';
import { InventoryQuery } from '../inventory/inventory.query';

const ZERO = new Prisma.Decimal(0);

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
 * - consumed, LABOUR: measured person-shifts at the frozen rate. **`Measurement` does not exist
 *   until Task 3, so this term is ZERO here and a live labour PO reads its gross amount.** That
 *   is stated rather than hidden: Task 3 adds the term with the fact it measures.
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
    const [materialLines, labourLines, accepted] = await Promise.all([
      this.procurement.committedLinesFor(tx, projectId, materialIds),
      this.labour.committedLinesFor(tx, projectId, labourIds),
      this.inventory.acceptedFor(tx, projectId, materialIds),
    ]);

    for (const code of heads) {
      let committed = ZERO;
      let receivedNotBilled = ZERO;
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
          receivedNotBilled = receivedNotBilled.add(receivedValue);
        } else if (a.labourPoLineId) {
          const line = labourLines.get(a.labourPoLineId);
          if (!line || !line.live) continue;
          // Task 3 adds the MEASURED consumption term; there is no measurement to subtract yet.
          const released = line.closedShort && line.personShiftQty > 0
            ? line.committedAmountBase
                .mul(Math.max(line.personShiftQty - line.committedQty, 0))
                .div(line.personShiftQty)
            : ZERO;
          committed = committed.add(Prisma.Decimal.max(line.committedAmountBase.sub(released), ZERO));
        }
      }
      const budget = budgetOf.get(code) ?? null;
      // §J — budget is the CEILING the exposure buckets are measured against, never a bucket
      // itself. Headroom subtracts every exposure bucket that EXISTS at this task; Tasks 4–6 add
      // the billing buckets as their facts arrive.
      const exposure = committed.add(receivedNotBilled);
      out.set(code, {
        costHeadCode: code,
        budget,
        committed,
        receivedNotBilled,
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
