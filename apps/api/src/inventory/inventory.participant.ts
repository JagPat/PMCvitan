import { ConflictException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

/**
 * Phase 3 Task 4 — the inventory WORKFLOW PARTICIPANT.
 *
 * The §C stock ledger is database-immutable, so a quality decision's evidence photo can
 * never be unlinked from its ledger row. The media delete command therefore invokes this
 * inventory-owned guard INSIDE its transaction (the Module-3/4 owner-aligned pattern —
 * inventory code reads inventory tables): media cited by any stock transaction is not
 * deletable. Without this guard the delete would still be refused — the ledger's composite
 * (projectId, mediaId) FK blocks it — but as a raw constraint error instead of a clear 409.
 */
@Injectable()
export class InventoryParticipant {
  async assertMediaDisposable(tx: Prisma.TransactionClient, projectId: string, mediaId: string): Promise<void> {
    const cited = await tx.stockTransaction.count({ where: { projectId, evidenceMediaId: mediaId } });
    if (cited > 0) {
      throw new ConflictException(
        `This photo is quality evidence on ${cited} stock ledger row(s) — the ledger is immutable, so its evidence cannot be deleted (plan §C)`,
      );
    }
  }

  /**
   * Phase 5 Task 5 (§E) — LOCK the accepted evidence a certification is about to consume, and
   * return the surviving acceptance rows NEWEST-LAST so the caller can draw on them deterministically.
   *
   * §E is explicit that locking the PO line is not enough: the accepted side lives in the inventory
   * ledger, and `stock.reverse` locks the stock LOT — it never takes the PO-line lock. So a
   * certification that locked only the PO line reads 100 accepted, a concurrent reversal commits
   * the acceptance to 0, and the certification commits on the stale 100: a bill payable with no
   * accepted material behind it.
   *
   * The LOT is what is locked, in ascending id order, and that order is not a free choice — every
   * inventory write today runs `lockProjectReadiness → lockLot → applyReceiptProgress`, and
   * `applyReceiptProgress` is what takes the PO line. Locking the PO line first would invert it and
   * deadlock against a concurrent rejection. Commercial adopts the established order rather than
   * asking four cleared modules to migrate to a new one.
   *
   * Each row carries what is STILL available on it: its own quantity less any reversals already
   * pointed at it, so a caller never draws on evidence that has been withdrawn.
   */
  async lockAcceptedEvidence(
    tx: Prisma.TransactionClient,
    projectId: string,
    poLineId: string,
  ): Promise<Array<{ id: string; available: Prisma.Decimal }>> {
    // lots first, ascending — the established order, and the one that keeps this deadlock-free
    await tx.$queryRaw`
      SELECT lot."id" FROM "StockLot" lot
       WHERE lot."projectId" = ${projectId} AND lot."poLineId" = ${poLineId}
       ORDER BY lot."id" ASC FOR UPDATE`;
    const rows = await tx.$queryRaw<Array<{ id: string; available: Prisma.Decimal | string }>>`
      SELECT t."id" AS "id",
             t."qty" - COALESCE((
               SELECT SUM(r."qty") FROM "StockTransaction" r
                WHERE r."projectId" = t."projectId" AND r."reversedTxId" = t."id"
             ), 0) AS "available"
        FROM "StockTransaction" t
        JOIN "StockLot" lot ON lot."projectId" = t."projectId" AND lot."id" = t."lotId"
       WHERE t."projectId" = ${projectId} AND lot."poLineId" = ${poLineId} AND t."type" = 'acceptance'
       ORDER BY t."recordedAt" ASC, t."id" ASC`;
    return rows
      .map((r) => ({ id: r.id, available: new Prisma.Decimal(r.available) }))
      .filter((r) => r.available.greaterThan(0));
  }

  /**
   * Phase 5 Task 5 (§E) — how much of ONE acceptance row live certificates have already consumed.
   * The withdrawal guard needs this to permit exactly the unconsumed remainder: row identity alone
   * refuses a legitimate reversal of the unused part, and the aggregate alone lets the evidence be
   * swapped after the fact.
   */
  async certifiedConsumptionOf(
    tx: Prisma.TransactionClient,
    projectId: string,
    stockTransactionIds: readonly string[],
  ): Promise<Map<string, Prisma.Decimal>> {
    const out = new Map<string, Prisma.Decimal>();
    if (stockTransactionIds.length === 0) return out;
    const rows = await tx.certifiedAcceptanceConsumption.findMany({
      where: {
        projectId,
        stockTransactionId: { in: [...stockTransactionIds] },
        certificate: { is: { supersededAt: null } },
      },
      select: { stockTransactionId: true, consumedQty: true },
    });
    for (const r of rows) {
      out.set(r.stockTransactionId, (out.get(r.stockTransactionId) ?? new Prisma.Decimal(0)).add(r.consumedQty));
    }
    return out;
  }
}
