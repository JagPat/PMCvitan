import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';

/**
 * Phase 3 Tasks 2–3 — the requirements reads procurement is allowed against requirement
 * persistence (plan §G edge `procurement → activities`):
 *
 * `requirements.revisionForAllocation` validates that a pinned `(requirementId, revision)`
 * exists in THIS project, is the requirement's CURRENT head, is an open revision — and LOCKS
 * the revision row FOR UPDATE so the §F bound-1 guard (`Σ requisition-line allocations ≤
 * required qty`) serializes racing allocators on the row itself. Locking is safe against the
 * append-only trigger (a row lock fires no UPDATE/DELETE trigger). Must be called INSIDE the
 * allocating command's transaction.
 *
 * `requirements.revisionSnapshotForOrder` (Task 3) reads the identity facts a PO line
 * FREEZES (base UOM + material spec fingerprint) for a PINNED revision — deliberately
 * WITHOUT the head-currency check: a purchase order executes its requisition line's pinned
 * revision even after a later revision appended (§F disposition governs re-pointing).
 *
 * `requirements.materialSpecForRevision` (Task 4) reads the FULL §B MaterialSpecificationRef
 * (technical identity + decision provenance) of a pinned revision, so a receipt can freeze
 * it onto the StockLot ("every lot carries its MaterialSpecificationRef", §C). Same
 * pinned-revision semantics as the order snapshot — no head-currency check.
 */
@Injectable()
export class RequirementsQueryService {
  async revisionSnapshotForOrder(
    tx: Prisma.TransactionClient,
    projectId: string,
    requirementId: string,
    revision: number,
  ): Promise<{ baseUom: string; type: string; specFingerprint: string | null }> {
    const row = await tx.activityRequirement.findUnique({
      where: { projectId_requirementId_revision: { projectId, requirementId, revision } },
      select: { baseUom: true, type: true, materialSpec: { select: { specFingerprint: true } } },
    });
    if (!row) throw new NotFoundException('Requirement revision not found in this project');
    return { baseUom: row.baseUom, type: row.type, specFingerprint: row.materialSpec?.specFingerprint ?? null };
  }

  async materialSpecForRevision(
    tx: Prisma.TransactionClient,
    projectId: string,
    requirementId: string,
    revision: number,
  ): Promise<{
    materialCategory: string;
    make: string;
    grade: string;
    normalizedAttributes: string;
    baseUom: string;
    specFingerprint: string;
    decisionId: string | null;
    decisionVersion: number | null;
    optionKey: string | null;
  }> {
    const row = await tx.activityRequirement.findUnique({
      where: { projectId_requirementId_revision: { projectId, requirementId, revision } },
      select: { baseUom: true, materialSpec: true },
    });
    if (!row) throw new NotFoundException('Requirement revision not found in this project');
    const spec = row.materialSpec;
    if (!spec) throw new BadRequestException('Requirement revision carries no material specification (material-only pipeline)');
    return {
      materialCategory: spec.materialCategory,
      make: spec.make,
      grade: spec.grade,
      normalizedAttributes: spec.normalizedAttributes,
      baseUom: row.baseUom,
      specFingerprint: spec.specFingerprint,
      decisionId: spec.decisionId,
      decisionVersion: spec.decisionVersion,
      optionKey: spec.optionKey,
    };
  }

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
