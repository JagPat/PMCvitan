import { ConflictException, Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';

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
}
