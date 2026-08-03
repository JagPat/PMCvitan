import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { BILL_STATUSES_NOT_LIVE } from '@vitan/shared';

const ZERO = new Prisma.Decimal(0);

/** The statuses §0 counts as LIVE, as a Prisma filter. Stated once, referenced everywhere. */
const LIVE_VERSION: Prisma.VendorBillVersionWhereInput = {
  supersededAt: null,
  bill: { is: { status: { notIn: [...BILL_STATUSES_NOT_LIVE] } } },
};

/** One live claim, with the bill it belongs to — the unit the withdrawal disposition disputes. */
export interface LiveClaim {
  billId: string;
  versionId: string;
  createdAt: Date;
  /** this claim's contribution to `BILLED_QTY(poLine)` for the line being withdrawn from */
  quantity: Prisma.Decimal;
}

/**
 * Phase 5 Task 4 (§0) — the BILLED sets, folded in ONE owned place.
 *
 * §0's opening finding was that each fold described *where to look* and re-derived *which rows
 * count* locally, so each got it wrong in its own way. Every billed number in this module —
 * the §G bound checks, the withdrawal disposition, the read surface and the DB seal's SQL twin —
 * comes from here, so `BILLED_QTY` can never mean two things.
 *
 * `BILLED_QTY` and `BILLED_AMOUNT` are separate methods on purpose. One "billed" set used as
 * both would be compared against `qty + approvedOverage` in one bound and against a certificate
 * in another, and whichever unit the implementation picked, the other bound would silently
 * compare rupees to units. A set carries exactly one unit.
 */
@Injectable()
export class CommercialBillQuery {
  /**
   * `BILLED_QTY(poLine)` for a set of lines of one kind. Absent lines have claimed nothing —
   * a caller reading `?? undefined` and skipping the bound is the failure a zero avoids.
   */
  async billedQtyFor(
    tx: Prisma.TransactionClient,
    projectId: string,
    kind: 'material' | 'labour',
    poLineIds: readonly string[],
  ): Promise<Map<string, Prisma.Decimal>> {
    const out = new Map<string, Prisma.Decimal>();
    for (const id of poLineIds) out.set(id, ZERO);
    if (poLineIds.length === 0) return out;
    const rows = await tx.vendorBillLine.findMany({
      where: {
        projectId,
        ...(kind === 'material' ? { poLineId: { in: [...poLineIds] } } : { labourPoLineId: { in: [...poLineIds] } }),
        version: { is: LIVE_VERSION },
      },
      select: { poLineId: true, labourPoLineId: true, quantity: true },
    });
    for (const r of rows) {
      const key = kind === 'material' ? r.poLineId! : r.labourPoLineId!;
      out.set(key, (out.get(key) ?? ZERO).add(r.quantity));
    }
    return out;
  }

  /** `BILLED_AMOUNT(poLine)` — the same LIVE rule, in RUPEES. §J subtracts it from received value. */
  async billedAmountFor(
    tx: Prisma.TransactionClient,
    projectId: string,
    kind: 'material' | 'labour',
    poLineIds: readonly string[],
  ): Promise<Map<string, Prisma.Decimal>> {
    const out = new Map<string, Prisma.Decimal>();
    for (const id of poLineIds) out.set(id, ZERO);
    if (poLineIds.length === 0) return out;
    const rows = await tx.vendorBillLine.findMany({
      where: {
        projectId,
        ...(kind === 'material' ? { poLineId: { in: [...poLineIds] } } : { labourPoLineId: { in: [...poLineIds] } }),
        version: { is: LIVE_VERSION },
      },
      select: { poLineId: true, labourPoLineId: true, amount: true },
    });
    for (const r of rows) {
      const key = kind === 'material' ? r.poLineId! : r.labourPoLineId!;
      out.set(key, (out.get(key) ?? ZERO).add(r.amount));
    }
    return out;
  }

  /**
   * `BILLED_TAX(poLine)` and `BILLED_FREIGHT(poLine)` (§0) — the same LIVE rule, in the two money
   * components §E caps PRO-RATA rather than comparing whole.
   *
   * They are folded here beside `BILLED_QTY` and `BILLED_AMOUNT` for the reason §0 exists at all:
   * a caller that re-derived "which rows count" locally would get it wrong in its own way, and
   * these two are compared against a frozen LINE-level ordered amount, so a drifted filter shows
   * up as a vendor disputed for an honest partial bill.
   */
  async billedTaxAndFreightFor(
    tx: Prisma.TransactionClient,
    projectId: string,
    kind: 'material' | 'labour',
    poLineId: string,
  ): Promise<{ tax: Prisma.Decimal; freight: Prisma.Decimal }> {
    const rows = await tx.vendorBillLine.findMany({
      where: {
        projectId,
        ...(kind === 'material' ? { poLineId } : { labourPoLineId: poLineId }),
        version: { is: LIVE_VERSION },
      },
      select: { taxAmount: true, freightAmount: true },
    });
    return {
      tax: rows.reduce((a, r) => a.add(r.taxAmount), ZERO),
      freight: rows.reduce((a, r) => a.add(r.freightAmount), ZERO),
    };
  }

  /**
   * The LIVE claims drawing on ONE purchase-order line, NEWEST FIRST.
   *
   * Newest-first is the order the withdrawal disposition disputes in (§E, probe 5an), and it is
   * not arbitrary: an older claim has usually already been checked, so withdrawing evidence
   * should invalidate the most recent claim on it rather than the one furthest through the
   * lifecycle. The tie-break on id keeps two claims recorded in the same millisecond
   * deterministic — without it the disposition could dispute a different bill on a re-run and
   * the probe asserting "the older (60) is left live" would be flaky rather than wrong.
   */
  async liveClaimsOn(
    tx: Prisma.TransactionClient,
    projectId: string,
    kind: 'material' | 'labour',
    poLineId: string,
  ): Promise<LiveClaim[]> {
    const rows = await tx.vendorBillLine.findMany({
      where: {
        projectId,
        ...(kind === 'material' ? { poLineId } : { labourPoLineId: poLineId }),
        version: { is: LIVE_VERSION },
      },
      select: { quantity: true, versionId: true, version: { select: { billId: true, createdAt: true } } },
    });
    // fold to ONE row per BILL: a bill is disputed as a whole, so two lines of one claim on the
    // same PO line must not be disputed twice — and the second dispute would be a CAS no-op that
    // silently stopped the loop before the bound held.
    const byBill = new Map<string, LiveClaim>();
    for (const r of rows) {
      const existing = byBill.get(r.version.billId);
      if (existing) existing.quantity = existing.quantity.add(r.quantity);
      else {
        byBill.set(r.version.billId, {
          billId: r.version.billId, versionId: r.versionId,
          createdAt: r.version.createdAt, quantity: r.quantity,
        });
      }
    }
    return [...byBill.values()].sort((a, b) => {
      const t = b.createdAt.getTime() - a.createdAt.getTime();
      return t !== 0 ? t : b.billId.localeCompare(a.billId);
    });
  }

  /**
   * `BILLED_QTY` over live CERTIFIED claims — the floor a measurement correction may NOT cross.
   *
   * §D: withdrawing measured work a live CERTIFICATE rests on requires superseding that
   * certificate first, while an UNCERTIFIED claim is disputed rather than blocking. An earlier
   * plan revision refused the correction whenever live `BILLED_QTY` would exceed the new total,
   * which blocks evidence repair on the strength of a bill nobody has verified: measure 100, a
   * vendor submits a 100-unit claim, the engineer discovers the real figure is 50 — and the site
   * cannot fix its own record until the vendor's unverified claim is dealt with.
   *
   * **At the Task-4 tree this set is always EMPTY, and that is a property of the tree, not a
   * stub.** `certified` is unreachable: the transition into it is Task 5's, guarded by the §E
   * verdict and the review stop before it. The fold is written over the status set rather than
   * hardcoded to zero so that Task 5 adds the certificate and its transition WITHOUT having to
   * re-derive this floor — which is exactly the re-derivation §N says produced twenty rounds of
   * findings. What Task 5 must still add is the ROW-level half §D also requires: a correction
   * may not reduce a measurement row a live certificate has FROZEN as its consumed evidence
   * (`(measurementId, consumedQty)`), which is strictly stronger than this aggregate and cannot
   * be written before the consumption set exists.
   */
  async certifiedBilledQtyFor(
    tx: Prisma.TransactionClient,
    projectId: string,
    labourPoLineId: string,
  ): Promise<Prisma.Decimal> {
    const rows = await tx.vendorBillLine.findMany({
      where: {
        projectId,
        labourPoLineId,
        version: {
          is: {
            supersededAt: null,
            bill: { is: { status: { in: ['certified', 'approved-for-payment', 'part-paid', 'paid'] } } },
          },
        },
      },
      select: { quantity: true },
    });
    return rows.reduce((acc, r) => acc.add(r.quantity), ZERO);
  }
}
