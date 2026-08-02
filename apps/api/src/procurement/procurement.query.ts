import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma.service';

/**
 * Phase 5 Task 1 (§C/§K) — the PROCUREMENT read CONTRACT.
 *
 * `PurchaseOrderVersion`/`PurchaseOrderLine` are procurement-owned and read-encapsulated, so a
 * foreign module must ask the OWNER rather than reach into the tables. §C states the rule this
 * class exists to make true: `COMMITTED` reads the frozen amount from the PO-line snapshot
 * THROUGH the owning module's query — `ProcurementQuery` for a `PurchaseOrderLine`,
 * `LabourQuery` for a `LabourPurchaseOrderLine`. One fold, two owners, each read through its own
 * contract. (An earlier revision of the plan said "through `ProcurementQuery`, always", which
 * would have left the labour half either omitted or read cross-module.)
 *
 * Task 1 needs exactly one question answered: which lines are LIVE, so activation can attribute
 * every one of them. The amount-bearing reads land with the `COMMITTED` fold in Task 2.
 */
/** The frozen commercial facts of one material PO line, as the commercial fold consumes them. */
export interface MaterialCommittedLine {
  committedAmountBase: Prisma.Decimal;
  qty: Prisma.Decimal;
  receivedQty: Prisma.Decimal;
  /** the three FROZEN components — §J prices the received side from these, not from the total */
  rate: Prisma.Decimal;
  taxAmount: Prisma.Decimal;
  freightAmount: Prisma.Decimal;
  live: boolean;
  closedShort: boolean;
}

@Injectable()
export class ProcurementQuery {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * The LIVE material PO lines of a project, for the commercial activation backfill.
   *
   * LIVE is the version-status set the attribution lifecycle maintains: `draft` is not live yet
   * (issue attributes it), `amended` has been superseded by the next version (amend replaces the
   * attribution), and `cancelled` released it. A `closed_short` version stays live because it
   * keeps its received portion — a real obligation someone still owes.
   */
  async liveOrderedLineIds(projectId: string, tx?: Prisma.TransactionClient): Promise<string[]> {
    const db = tx ?? this.prisma;
    const rows = await db.purchaseOrderLine.findMany({
      where: {
        projectId,
        poVersion: { is: { status: { in: ['issued', 'partially_received', 'completed', 'closed_short'] } } },
      },
      select: { id: true },
      orderBy: { id: 'asc' },
    });
    return rows.map((r) => r.id);
  }

  /**
   * Phase 5 Task 2 (§0 `COMMITTED`) — the frozen commercial facts of a set of MATERIAL PO lines,
   * so the commercial fold can compute OUTSTANDING obligation without ever reading a
   * procurement-owned table itself. §C states the rule this serves: the committed amount already
   * exists, frozen with provenance, and `COMMITTED` reads it THROUGH the owning module.
   *
   * `live` is the same version-status set the attribution lifecycle maintains. `closedShort` is
   * carried separately because §0 subtracts the RELEASED remainder of a version closed short:
   * a ₹100 PO closed short before any receipt has ₹0 outstanding, because the practice explicitly
   * cancelled that obligation.
   */
  async committedLinesFor(
    tx: Prisma.TransactionClient,
    projectId: string,
    poLineIds: readonly string[],
  ): Promise<Map<string, MaterialCommittedLine>> {
    const out = new Map<string, MaterialCommittedLine>();
    if (poLineIds.length === 0) return out;
    const rows = await tx.purchaseOrderLine.findMany({
      where: { projectId, id: { in: [...poLineIds] } },
      select: {
        id: true, committedAmountBase: true, qty: true, receivedQty: true,
        // §J received-not-billed prices the received side at rate with tax/freight CLAMPED to the
        // ordered quantity, so the fold needs the three frozen components, not just the total.
        rate: true, taxAmount: true, freightAmount: true,
        poVersion: { select: { status: true } },
      },
    });
    for (const r of rows) {
      const status = r.poVersion.status;
      out.set(r.id, {
        committedAmountBase: r.committedAmountBase,
        qty: r.qty,
        receivedQty: r.receivedQty,
        rate: r.rate,
        taxAmount: r.taxAmount,
        freightAmount: r.freightAmount,
        live: ['issued', 'partially_received', 'completed', 'closed_short'].includes(status),
        closedShort: status === 'closed_short',
      });
    }
    return out;
  }
}
