/**
 * Pure tree arithmetic for the nested location tree (phase-6-task-2, §A).
 *
 * Every function operates on rows the caller has ALREADY loaded with a
 * project-scoped read — none of them touches the database. That split is
 * deliberate: the service loads the project's node set once per write (inside
 * the tree-lock transaction), and the walkers here are then provably scoped to
 * whatever the load was scoped to. All walks are cycle-safe, because their most
 * important call sites are the guards that decide whether a cycle can form.
 */

export interface TreeRow {
  id: string;
  parentId: string | null;
}

/** Locations nest to this many levels (a refusal with a stated reason, never a
 *  silent truncation). Five reaches a tower with wings and pour segments and
 *  still fits on a phone, which is where the Site Map is actually read. */
export const MAX_TREE_DEPTH = 5;

function childrenIndex(rows: readonly TreeRow[]): Map<string, string[]> {
  const index = new Map<string, string[]>();
  for (const row of rows) {
    if (!row.parentId) continue;
    const siblings = index.get(row.parentId);
    if (siblings) siblings.push(row.id);
    else index.set(row.parentId, [row.id]);
  }
  return index;
}

/** All node ids in the subtree rooted at `rootId` (inclusive), cycle-safe. */
export function subtreeIdsOf(rows: readonly TreeRow[], rootId: string): string[] {
  const index = childrenIndex(rows);
  const out: string[] = [];
  const seen = new Set<string>();
  const walk = (id: string): void => {
    if (seen.has(id)) return;
    seen.add(id);
    out.push(id);
    for (const child of index.get(id) ?? []) walk(child);
  };
  walk(rootId);
  return out;
}

/** Ancestor ids of a node (nearest-first), EXCLUDING the node itself, cycle-safe. */
export function ancestorIdsOf(rows: readonly TreeRow[], nodeId: string): string[] {
  const parentOf = new Map(rows.map((row) => [row.id, row.parentId]));
  const out: string[] = [];
  const seen = new Set<string>();
  let cur = parentOf.get(nodeId) ?? null;
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    out.push(cur);
    cur = parentOf.get(cur) ?? null;
  }
  return out;
}

/** 1-based depth of a node: a top-level zone is 1, its child 2, … */
export function depthOf(rows: readonly TreeRow[], nodeId: string): number {
  return ancestorIdsOf(rows, nodeId).length + 1;
}

/** Height of the subtree rooted at `rootId` in LEVELS (a leaf is 1). The depth
 *  cap must count this, not the moved node alone: `move (A > B > C) under
 *  (P1 > P2 > P3)` lands A legally at level 4 while C lands at 6. */
export function heightOf(rows: readonly TreeRow[], rootId: string): number {
  const index = childrenIndex(rows);
  const seen = new Set<string>();
  const walk = (id: string): number => {
    if (seen.has(id)) return 0;
    seen.add(id);
    let deepest = 0;
    for (const child of index.get(id) ?? []) deepest = Math.max(deepest, walk(child));
    return deepest + 1;
  };
  return walk(rootId);
}
