import type { CommitmentAttributionDto } from '@vitan/shared';

/**
 * Phase 5 §C — the attribution row → DTO mapper, and the reason it lives in a file of its own.
 *
 * It began in `commercial.service.ts`, which is where its only caller was. Task 7B-i's
 * money-position bundle made `CommercialBudgetService` a second caller, and importing it from there
 * closed a runtime cycle — budget service → commercial service → participant → budget service —
 * which Nest reports as an unresolvable dependency rather than as an import loop, several layers
 * from the edit that caused it.
 *
 * A pure row→DTO function has no business creating that edge. It is nobody's service; it belongs in
 * a leaf both callers can reach.
 */
export function serializeAttribution(r: {
  id: string; poLineId: string | null; labourPoLineId: string | null; costHeadCode: string; reason: string;
  createdAt: Date; createdById: string; supersededAt: Date | null; supersededById: string | null; supersedeReason: string | null;
}): CommitmentAttributionDto {
  return {
    id: r.id,
    poLineId: r.poLineId,
    labourPoLineId: r.labourPoLineId,
    costHeadCode: r.costHeadCode,
    reason: r.reason,
    createdAt: r.createdAt.toISOString(),
    createdById: r.createdById,
    supersededAt: r.supersededAt?.toISOString() ?? null,
    supersededById: r.supersededById,
    supersedeReason: r.supersedeReason,
  };
}
