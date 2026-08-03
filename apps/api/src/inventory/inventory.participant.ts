import { ConflictException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { InventoryQuery } from './inventory.query';

/** One `acceptance` ledger row, with how much of it a reversal has already taken back. */
export interface AcceptedEvidenceRow {
  /** the `acceptance` `StockTransaction` id — the row a certificate freezes by IDENTITY */
  id: string;
  /** the accepted quantity STILL standing on this row: its own qty less any reversals of it */
  available: Prisma.Decimal;
  /**
   * WHO recorded this acceptance. §I's segregation rule asks exactly this about exactly these
   * rows — the ones the certificate is about to freeze — so it travels with the evidence rather
   * than sending commercial back into the inventory ledger for a second, unencapsulated read.
   */
  recordedById: string;
}

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
  constructor(private readonly query: InventoryQuery) {}

  async assertMediaDisposable(tx: Prisma.TransactionClient, projectId: string, mediaId: string): Promise<void> {
    const cited = await tx.stockTransaction.count({ where: { projectId, evidenceMediaId: mediaId } });
    if (cited > 0) {
      throw new ConflictException(
        `This photo is quality evidence on ${cited} stock ledger row(s) — the ledger is immutable, so its evidence cannot be deleted (plan §C)`,
      );
    }
  }

  /**
   * Phase 5 Task 5B (§E) — LOCK the accepted evidence behind one purchase-order line and return
   * the rows with how much of each still stands.
   *
   * §E step 2: certification reads the ACCEPTED side, and `stock.reverse` locks the stock LOT —
   * it never takes the PO-line lock. Locking only the PO line therefore admits certification
   * reading 100 accepted, a concurrent reversal committing it to 0, and certification committing
   * on the stale 100: a payable bill with no accepted material behind it. The LOTS are what both
   * sides contend on, so the lots are what this takes.
   *
   * **Ascending by lot id, and BEFORE any PO line** — the order every inventory write already
   * uses (`lockProjectReadiness → lockLot → applyReceiptProgress`, and `applyReceiptProgress` is
   * what takes the PO line). Inverting it would let certification hold a PO line waiting for a
   * lot while a concurrent rejection holds that lot waiting for the PO line. Commercial adopts
   * the established order rather than asking four cleared modules to migrate to a new one.
   *
   * It is an inventory-owned read of inventory tables, invoked inside the CALLER's transaction —
   * the participant pattern, declared on `inventory.workflowParticipants` and cycle-exempt. The
   * `available` figure restates nothing: it is `InventoryQuery.acceptedPerRow`, which is
   * `ACCEPTED`'s own arithmetic resolved per row. This method adds the LOCK and nothing else.
   */
  async lockAcceptedEvidence(
    tx: Prisma.TransactionClient,
    projectId: string,
    poLineId: string,
  ): Promise<AcceptedEvidenceRow[]> {
    // the LOTS first, ascending, so two certifications on overlapping lines cannot deadlock
    await tx.$queryRaw(Prisma.sql`
      SELECT lot."id" FROM "StockLot" lot
       WHERE lot."projectId" = ${projectId} AND lot."poLineId" = ${poLineId}
       ORDER BY lot."id" ASC
         FOR UPDATE`);
    // a fully reversed row is not evidence to DRAW on — it is excluded here rather than returned
    // as zero so a consumption row can never be written against it (`consumedQty > 0` CHECK). The
    // GUARD path keeps those rows, which is why the filter lives at the caller and not in the fold.
    const rows = await this.query.acceptedPerRow(tx, projectId, poLineId);
    return rows.filter((r) => r.available.greaterThan(0));
  }
}
