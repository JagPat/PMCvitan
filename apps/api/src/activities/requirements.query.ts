import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';

/**
 * Phase 3 Task 2 — the requirements ALLOCATION read (`requirements.revisionForAllocation`).
 *
 * The one same-transaction query procurement is allowed against requirement persistence
 * (plan §G edge `procurement → activities`): it validates that a pinned
 * `(requirementId, revision)` exists in THIS project, is the requirement's CURRENT head,
 * is an open material revision — and LOCKS the revision row FOR UPDATE so the §F bound-1
 * guard (`Σ requisition-line allocations ≤ required qty`) serializes racing allocators on
 * the row itself. Locking is safe against the append-only trigger (a row lock fires no
 * UPDATE/DELETE trigger). Must be called INSIDE the allocating command's transaction.
 */
@Injectable()
export class RequirementsQueryService {
  async revisionForAllocation(
    tx: Prisma.TransactionClient,
    projectId: string,
    requirementId: string,
    revision: number,
  ): Promise<{ requiredQty: Prisma.Decimal; baseUom: string; type: string }> {
    const rows = await tx.$queryRaw<
      Array<{ id: string; requiredQty: Prisma.Decimal; baseUom: string; type: string; status: string; revision: number }>
    >`
      SELECT "id", "requiredQty", "baseUom", "type", "status", "revision"
      FROM "ActivityRequirement"
      WHERE "projectId" = ${projectId} AND "requirementId" = ${requirementId} AND "revision" = ${revision}
      FOR UPDATE`;
    const row = rows[0];
    if (!row) throw new NotFoundException('Requirement revision not found in this project');
    const head = await tx.activityRequirement.findFirst({
      where: { projectId, requirementId },
      orderBy: { revision: 'desc' },
      select: { revision: true, status: true },
    });
    if (!head || head.revision !== revision) {
      throw new BadRequestException(`Requirement is at revision ${head?.revision ?? '?'} — allocate against its current revision`);
    }
    if (row.status !== 'open') throw new BadRequestException('A cancelled requirement revision cannot be allocated');
    return { requiredQty: row.requiredQty, baseUom: row.baseUom, type: row.type };
  }
}
