import type { Decision, ProjectNode } from '@vitan/shared';

/** Direct children of a node (parentId=null → top-level zones), in display order. */
export function childrenOf(nodes: ProjectNode[], parentId: string | null): ProjectNode[] {
  return nodes.filter((n) => n.parentId === parentId).sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));
}

export function nodeById(nodes: ProjectNode[], id: string | undefined | null): ProjectNode | undefined {
  return id ? nodes.find((n) => n.id === id) : undefined;
}

/** Breadcrumb of names from root → node, e.g. ["Ground Floor","Master Bedroom","Main Door"]. */
export function pathOf(nodes: ProjectNode[], nodeId: string | undefined | null): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  let cur = nodeById(nodes, nodeId);
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    out.unshift(cur.name);
    cur = nodeById(nodes, cur.parentId ?? undefined);
  }
  return out;
}

/** The location segments a decision groups under; falls back to its free-text `room`. */
export function locationSegments(d: Decision, nodes: ProjectNode[]): string[] {
  const p = pathOf(nodes, d.nodeId);
  if (p.length) return p;
  return d.room ? [d.room] : ['Unfiled'];
}

export type GroupBy = 'location' | 'room' | 'element' | 'status' | 'flat';

export interface DecisionRow {
  decision: Decision;
  /** the finer location under this section's header, e.g. "Master Bedroom › Main Door" */
  subLabel: string;
}

export interface DecisionGroup {
  key: string;
  label: string;
  rows: DecisionRow[];
  counts: { total: number; pending: number; approved: number; change: number };
}

const STATUS_LABEL: Record<string, string> = { pending: 'Pending', approved: 'Approved', change: 'Change requested' };

/** Group + sort decisions for the register display by the chosen lens. Single-level
 *  sections (collapsible in the UI), with the finer location shown as a per-row caption. */
export function groupDecisions(decisions: Decision[], nodes: ProjectNode[], mode: GroupBy): DecisionGroup[] {
  const map = new Map<string, DecisionRow[]>();
  const labelOf = new Map<string, string>();

  for (const d of decisions) {
    const seg = locationSegments(d, nodes);
    let key: string;
    let label: string;
    let subLabel = '';
    if (mode === 'flat') {
      key = 'all';
      label = 'All decisions';
    } else if (mode === 'status') {
      key = d.status;
      label = STATUS_LABEL[d.status] ?? d.status;
    } else if (mode === 'room') {
      // the room is the 2nd segment when a zone exists, else the first
      const room = seg.length >= 2 ? seg[1] : seg[0];
      key = `room:${room}`;
      label = room;
      subLabel = seg.slice(seg.indexOf(room) + 1).join(' › ');
    } else if (mode === 'element') {
      const element = seg.length >= 1 ? seg[seg.length - 1] : 'Unfiled';
      key = `el:${element}`;
      label = element;
      subLabel = seg.slice(0, -1).join(' › ');
    } else {
      // location: top-level = first segment (zone, or room when unzoned)
      key = `loc:${seg[0]}`;
      label = seg[0];
      subLabel = seg.slice(1).join(' › ');
    }
    if (!map.has(key)) {
      map.set(key, []);
      labelOf.set(key, label);
    }
    map.get(key)!.push({ decision: d, subLabel });
  }

  const groups: DecisionGroup[] = [...map.entries()].map(([key, rows]) => {
    const counts = { total: rows.length, pending: 0, approved: 0, change: 0 };
    for (const r of rows) counts[r.decision.status] += 1;
    // rows sorted by their finer location, then id
    rows.sort((a, b) => a.subLabel.localeCompare(b.subLabel) || a.decision.id.localeCompare(b.decision.id));
    return { key, label: labelOf.get(key)!, rows, counts };
  });

  // section order: status uses a fixed priority; otherwise alphabetical by label
  if (mode === 'status') {
    const rank: Record<string, number> = { pending: 0, change: 1, approved: 2 };
    groups.sort((a, b) => (rank[a.key] ?? 9) - (rank[b.key] ?? 9));
  } else {
    groups.sort((a, b) => a.label.localeCompare(b.label));
  }
  return groups;
}
