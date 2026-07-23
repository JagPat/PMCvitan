import type { Prisma } from '@prisma/client';
import type { CoverageRequirement } from '../inventory/coverage';
import type { SubstitutionsService } from './substitutions.service';

/**
 * Phase 3 Task 6 — the activities-owned loader that turns open MATERIAL requirements into
 * inventory `coverageFor` inputs (§A/§B). Shared by `activities.start` (authority), the
 * read-path bake and the readiness projection consumer, so all three derive coverage from the
 * SAME demand + substitution facts.
 *
 * Per requirement it keeps the HEAD revision (open + material) and resolves
 * `acceptableFingerprints` = the requirement's own spec fingerprint PLUS every ACTIVE substitution
 * target WHOSE `fromFingerprint` still equals the head fingerprint — so the substitution table
 * stays activities-owned (inventory never reads it). F2 correction: an A→B approval stops widening
 * the acceptable set once the requirement is revised A→C, because the edge's `fromFingerprint` (A)
 * no longer matches the current head fingerprint (C). Pass `activityIds` to scope to specific
 * activities; omit for every material requirement in the project (the whole-project read path).
 */
export async function loadCoverageRequirements(
  tx: Prisma.TransactionClient,
  projectId: string,
  substitutions: SubstitutionsService,
  activityIds?: readonly string[],
): Promise<CoverageRequirement[]> {
  if (activityIds && activityIds.length === 0) return [];
  const rows = await tx.activityRequirement.findMany({
    where: { projectId, type: 'material', ...(activityIds ? { activityId: { in: [...activityIds] } } : {}) },
    orderBy: [{ requirementId: 'asc' }, { revision: 'asc' }],
    select: {
      requirementId: true, revision: true, activityId: true, requiredQty: true, baseUom: true, status: true,
      materialSpec: { select: { specFingerprint: true } },
    },
  });
  const head = new Map<string, (typeof rows)[number]>();
  for (const r of rows) {
    const cur = head.get(r.requirementId);
    if (!cur || r.revision > cur.revision) head.set(r.requirementId, r);
  }
  const heads = [...head.values()].filter((r) => r.status === 'open' && r.materialSpec);
  const targets = await substitutions.activeTargets(tx, projectId, heads.map((h) => h.requirementId));
  return heads.map((h) => {
    const own = h.materialSpec!.specFingerprint;
    // F2: apply a substitution edge ONLY while its approved `fromFingerprint` still equals the
    // CURRENT head fingerprint — a revision that changes the spec silently drops stale edges.
    const substituteTargets = (targets.get(h.requirementId) ?? [])
      .filter((t) => t.fromFingerprint === own)
      .map((t) => t.toFingerprint);
    return {
      requirementId: h.requirementId,
      revision: h.revision,
      activityId: h.activityId,
      requiredQty: h.requiredQty,
      baseUom: h.baseUom,
      acceptableFingerprints: [own, ...substituteTargets],
    };
  });
}
