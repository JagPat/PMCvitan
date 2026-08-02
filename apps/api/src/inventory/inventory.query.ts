import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma.service';

/**
 * Phase 5 Task 2 (§0 `ACCEPTED`) — the INVENTORY read CONTRACT.
 *
 * `StockTransaction` and `StockLot` are inventory-owned and read-encapsulated, so a foreign module
 * must ask the OWNER rather than reach into the ledger. §0 defines `ACCEPTED(poLine)` precisely,
 * and stating it in one owned place is the point: every caller that needs "how much of this order
 * was accepted" gets the same answer, and the definition's two traps are handled here rather than
 * re-derived per caller.
 *
 *   ACCEPTED = Σ qty of `acceptance` movements on that line's lots
 *              MINUS Σ qty of `reversal` movements whose TARGET is an acceptance row
 *
 * NOT `accepted − rejected`: the arms are disjoint, so an 80/20 split would read as 60.
 * NOT the `acceptedOnHand` bucket balance: issuing moves stock out of that bucket, so
 * accept-100-then-issue-100 would read 0, while a cycle-count adjustment INTO the bucket would
 * read as billable delivery with no receipt behind it. **Acceptance is an EVENT, not a balance.**
 */
@Injectable()
export class InventoryQuery {
  constructor(private readonly prisma: PrismaService) {}

  /** `ACCEPTED(poLine)` for a set of material PO lines; absent lines have accepted nothing. */
  async acceptedFor(
    tx: Prisma.TransactionClient,
    projectId: string,
    poLineIds: readonly string[],
  ): Promise<Map<string, Prisma.Decimal>> {
    const out = new Map<string, Prisma.Decimal>();
    if (poLineIds.length === 0) return out;
    const rows = await tx.$queryRaw<Array<{ poLineId: string; accepted: Prisma.Decimal | string }>>(Prisma.sql`
      SELECT lot."poLineId" AS "poLineId",
             COALESCE(SUM(
               CASE
                 WHEN t."type" = 'acceptance' THEN t."qty"
                 -- a reversal SUBTRACTS, but only when the row it reverses is an acceptance
                 WHEN t."type" = 'reversal' AND target."type" = 'acceptance' THEN -t."qty"
                 ELSE 0
               END
             ), 0) AS "accepted"
        FROM "StockTransaction" t
        JOIN "StockLot" lot
          ON lot."projectId" = t."projectId" AND lot."id" = t."lotId"
        LEFT JOIN "StockTransaction" target
          ON target."projectId" = t."projectId" AND target."id" = t."reversedTxId"
       WHERE t."projectId" = ${projectId}
         AND lot."poLineId" IN (${Prisma.join([...poLineIds])})
       GROUP BY lot."poLineId"`);
    for (const r of rows) out.set(r.poLineId, new Prisma.Decimal(r.accepted));
    return out;
  }
}
