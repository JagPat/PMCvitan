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
