/**
 * The inspection lineage rule (#482 proof photos, "Your open items"; Redbracket ID A4b-2): an inspection's lineage is
 * APPROVED only when its latest inspection (following the one re-inspection a reject creates, `reinspectionOfId`) is
 * decided with no re-inspection of its own; anything else is still being worked. One statement, read by `openItems`
 * and by `InspectionParticipant.openWorkOf`.
 */
export function lineageApproval(lineage: ReadonlyArray<{ id: string; reinspectionOfId: string | null; decided: boolean }>): {
  childOf: Map<string, string>;
  approved: (id: string) => boolean;
} {
  const childOf = new Map<string, string>();
  for (const i of lineage) if (i.reinspectionOfId) childOf.set(i.reinspectionOfId, i.id);
  const decided = new Map(lineage.map((i) => [i.id, i.decided] as const));
  const approved = (id: string): boolean => {
    const seen = new Set<string>();
    let tip = id;
    // at most one child per inspection (a partial unique index); `seen` only guards a malformed cycle
    while (childOf.has(tip) && !seen.has(tip)) { seen.add(tip); tip = childOf.get(tip)!; }
    return decided.get(tip) === true && !childOf.has(tip);
  };
  return { childOf, approved };
}

/**
 * #482 "Who fixes this?" — the ROOT of each inspection's lineage: follow `reinspectionOfId` up to an inspection that
 * re-checks nothing. A naming is held on the root, so every picker of the lineage (the open re-inspection, its review)
 * reaches the one name in effect at any depth. Serves the id only; `openItems` is unchanged (a root naming lists the
 * root's own failed items, the original failures, with the lineage status).
 *
 * A parent id with no row here stops the walk AT that id (the answer `reinspectionOfId` itself would give); a malformed
 * cycle stops where it would repeat. Both are impossible on stored data (same-project foreign key, one child each).
 */
export function lineageRoots(lineage: ReadonlyArray<{ id: string; reinspectionOfId: string | null }>): (id: string) => string {
  const parentOf = new Map<string, string | null>(lineage.map((i) => [i.id, i.reinspectionOfId] as const));
  return (id: string): string => {
    const seen = new Set<string>([id]);
    let root = id;
    for (let parent = parentOf.get(root); parent && !seen.has(parent); parent = parentOf.get(root)) {
      seen.add(parent);
      root = parent;
    }
    return root;
  };
}
