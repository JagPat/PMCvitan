// Kept out of ResponsiblePicker.tsx (#1406) so that file exports components only (react/only-export-components).
/**
 * The inspection a picker names (Stage 1, 6 Nov; Codex #1365 4490108387): ONE name per inspection lineage, held on its
 * ROOT, the first inspection of the check (`lineageRootId`, served on every checklist and review row). The server refuses
 * a naming anywhere else (400), and its open items list the root's own failures (the original failed work) with the
 * lineage's status. So every picker of the lineage (the open re-inspection's row, the engineer's screen, the review card)
 * reaches the one name in effect, at any depth.
 *
 * An API older than the field omits it: `reinspectionOfId` (the direct parent) is the root up to depth 2, which a lineage
 * passes only after two rejects. Depth 3 or more on an older API happens only during a rollout; the API serving the field
 * is deployed before this web change merges.
 */
export function responsibleTargetOf(c: { id: string; reinspectionOfId?: string | null; lineageRootId?: string }): string {
  return c.lineageRootId ?? c.reinspectionOfId ?? c.id;
}
