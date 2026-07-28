import type { Prisma } from '@prisma/client';
import type { LabourCoverageRequirement } from '../labour/coverage';
import type { LabourRequirementQuery } from '../labour/labour.query';
import { labourDetailKey } from '../labour/labour.query';

/**
 * Phase 4 Task 4 — the activities-owned loader that turns open LABOUR requirements into
 * `LabourCoverageService.coverageFor` inputs (§A/§B): Activities passes ITS OWN canonical
 * requirement snapshots INTO the labour coverage authority, so Labour never reads Activities
 * persistence (§G — Labour stays a LEAF). The material sibling is `coverage-requirements.ts`.
 *
 * Per requirement it keeps the HEAD revision (open + labour) from the Activities-owned
 * `ActivityRequirement` rows, then routes the Labour-owned detail through the
 * `LabourRequirementQuery` contract — `detailsFor` for the head spec + demand slices,
 * `activeSkillTargets` for the ACTIVE substitution edges — never a Prisma relation include
 * (the F1 read-encapsulation rule). `acceptableFingerprints` = the head's own fingerprint PLUS
 * every active substitution target WHOSE `fromFingerprint` still equals the head fingerprint
 * (the T6-F2 rule verbatim): an A→B approval stops widening the set once the requirement is
 * revised A→C.
 */
export async function loadLabourCoverageRequirements(
  tx: Prisma.TransactionClient,
  projectId: string,
  labourQuery: LabourRequirementQuery,
  activityIds?: readonly string[],
): Promise<LabourCoverageRequirement[]> {
  if (activityIds && activityIds.length === 0) return [];
  // Round-2: resolve the head revision PROJECT-WIDE before any activity scoping. A revision may
  // move a requirement onto a DIFFERENT activity; filtering by activity first would resurrect the
  // old activity's stale revision as an open head and gate that activity on demand it no longer
  // owns. The head is chosen across every revision, then scoped by the activity that owns it NOW.
  const rows = await tx.activityRequirement.findMany({
    where: { projectId, type: 'labour' },
    orderBy: [{ requirementId: 'asc' }, { revision: 'asc' }],
    select: { requirementId: true, revision: true, activityId: true, status: true },
  });
  const head = new Map<string, (typeof rows)[number]>();
  for (const r of rows) {
    const cur = head.get(r.requirementId);
    if (!cur || r.revision > cur.revision) head.set(r.requirementId, r);
  }
  const scope = activityIds ? new Set(activityIds) : null;
  const heads = [...head.values()].filter(
    (r) => r.status === 'open' && (!scope || scope.has(r.activityId)),
  );
  if (heads.length === 0) return [];
  const [details, targets] = await Promise.all([
    labourQuery.detailsFor(projectId, heads, tx),
    labourQuery.activeSkillTargets(projectId, heads.map((h) => h.requirementId), tx),
  ]);
  const out: LabourCoverageRequirement[] = [];
  for (const h of heads) {
    const spec = details.get(labourDetailKey(h.requirementId, h.revision));
    if (!spec) continue; // type↔detail correspondence is DB-sealed; defensive only
    const own = spec.labourSpecFingerprint;
    const substituteTargets = (targets.get(h.requirementId) ?? [])
      .filter((t) => t.fromFingerprint === own)
      .map((t) => t.toFingerprint);
    out.push({
      requirementId: h.requirementId,
      revision: h.revision,
      activityId: h.activityId,
      shift: spec.shift,
      headFingerprint: own,
      acceptableFingerprints: [own, ...substituteTargets],
      slices: spec.demandSlices.map((s) => ({ civilDate: s.civilDate, personShiftQty: s.personShiftQty })),
    });
  }
  return out;
}
