import type { Activity, Decision, Drawing, Material, Photo, PlacedInspection, ProjectNode } from '@vitan/shared';

/** Direct children of a node (parentId=null → top-level zones), in display order. */
export function childrenOf(nodes: ProjectNode[], parentId: string | null): ProjectNode[] {
  return nodes.filter((n) => n.parentId === parentId).sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));
}

export function nodeById(nodes: ProjectNode[], id: string | undefined | null): ProjectNode | undefined {
  return id ? nodes.find((n) => n.id === id) : undefined;
}

/** Ancestor ids of a node, nearest-first, EXCLUDING the node itself (cycle-safe). */
export function ancestorIds(nodes: ProjectNode[], id: string | undefined | null): Set<string> {
  const out = new Set<string>();
  let cur = nodeById(nodes, id)?.parentId ?? null;
  const guard = new Set<string>();
  while (cur && !guard.has(cur)) {
    guard.add(cur);
    out.add(cur);
    cur = nodeById(nodes, cur)?.parentId ?? null;
  }
  return out;
}

/** All node ids in the subtree rooted at `id`, INCLUDING `id` itself (cycle-safe). */
export function subtreeIds(nodes: ProjectNode[], id: string): Set<string> {
  const childrenBy = new Map<string, string[]>();
  for (const n of nodes) {
    if (n.parentId) childrenBy.set(n.parentId, [...(childrenBy.get(n.parentId) ?? []), n.id]);
  }
  const out = new Set<string>();
  const walk = (cur: string): void => {
    if (out.has(cur)) return;
    out.add(cur);
    for (const c of childrenBy.get(cur) ?? []) walk(c);
  };
  walk(id);
  return out;
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

/** Breadcrumb of {id,name} from root → node (cycle-safe). Empty when the node is missing. */
export function trailOf(nodes: ProjectNode[], nodeId: string | undefined | null): { id: string; name: string }[] {
  const out: { id: string; name: string }[] = [];
  const seen = new Set<string>();
  let cur = nodeById(nodes, nodeId);
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    out.unshift({ id: cur.id, name: cur.name });
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

// ── Place view: everything at one location ───────────────────────────────────

/** How a drawing relates to the selected place: filed on it, inherited from an
 *  ancestor (a floor plan applies to every room below), or a detail on a child. */
export type DrawingRelation = 'here' | 'inherited' | 'detail';

export interface PlacedDrawing {
  drawing: Drawing;
  relation: DrawingRelation;
}

export interface PlaceContents {
  /** decisions in this node's subtree (all decisions when `nodeId` is null = whole project) */
  decisions: Decision[];
  /** site photos in this node's subtree (all photos, incl. unplaced, when whole project) */
  photos: Photo[];
  /** drawings that apply here — filed on the node, inherited from above, or a child detail */
  drawings: PlacedDrawing[];
  /** activities (site work) in this node's subtree */
  activities: Activity[];
  /** material deliveries in this node's subtree */
  materials: Material[];
  /** inspections in this node's subtree (pmc/engineer only — callers pass [] for other roles) */
  inspections: PlacedInspection[];
  counts: { decisions: number; drawings: number; photos: number; activities: number; materials: number; inspections: number };
}

const RELATION_RANK: Record<DrawingRelation, number> = { here: 0, detail: 1, inherited: 2 };

/**
 * Gather everything at a place for the Site Map. Decisions, photos, activities and
 * materials use SUBTREE semantics (a room includes its objects' items); drawings use
 * INHERIT-DOWN semantics — a room shows drawings filed on it (`here`), on any ancestor
 * (`inherited`, e.g. the floor plan), or on a descendant object (`detail`, e.g. a door
 * detail). `nodeId === null` means the whole project: everything, unfiled items included.
 */
export function placeContents(
  nodeId: string | null,
  nodes: ProjectNode[],
  decisions: Decision[],
  drawings: Drawing[],
  photos: Photo[],
  activities: Activity[] = [],
  materials: Material[] = [],
  inspections: PlacedInspection[] = [],
): PlaceContents {
  if (!nodeId) {
    const placed: PlacedDrawing[] = [...drawings]
      .sort((a, b) => a.number.localeCompare(b.number))
      .map((drawing) => ({ drawing, relation: 'here' as const }));
    return {
      decisions: [...decisions],
      photos: [...photos],
      drawings: placed,
      activities: [...activities],
      materials: [...materials],
      inspections: [...inspections],
      counts: { decisions: decisions.length, drawings: drawings.length, photos: photos.length, activities: activities.length, materials: materials.length, inspections: inspections.length },
    };
  }

  const sub = subtreeIds(nodes, nodeId);
  const anc = ancestorIds(nodes, nodeId);
  const decisionsHere = decisions.filter((d) => d.nodeId && sub.has(d.nodeId));
  const photosHere = photos.filter((p) => p.nodeId && sub.has(p.nodeId));
  const activitiesHere = activities.filter((a) => a.nodeId && sub.has(a.nodeId));
  const materialsHere = materials.filter((m) => m.nodeId && sub.has(m.nodeId));
  const inspectionsHere = inspections.filter((i) => i.nodeId && sub.has(i.nodeId));

  const placedDrawings: PlacedDrawing[] = [];
  for (const drawing of drawings) {
    const nid = drawing.nodeId;
    if (!nid) continue;
    let relation: DrawingRelation | null = null;
    if (nid === nodeId) relation = 'here';
    else if (anc.has(nid)) relation = 'inherited';
    else if (sub.has(nid)) relation = 'detail';
    if (relation) placedDrawings.push({ drawing, relation });
  }
  placedDrawings.sort(
    (a, b) => RELATION_RANK[a.relation] - RELATION_RANK[b.relation] || a.drawing.number.localeCompare(b.drawing.number),
  );

  return {
    decisions: decisionsHere,
    photos: photosHere,
    drawings: placedDrawings,
    activities: activitiesHere,
    materials: materialsHere,
    inspections: inspectionsHere,
    counts: { decisions: decisionsHere.length, drawings: placedDrawings.length, photos: photosHere.length, activities: activitiesHere.length, materials: materialsHere.length, inspections: inspectionsHere.length },
  };
}
