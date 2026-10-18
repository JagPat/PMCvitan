import type { Activity, Decision, Drawing, Material, Phase, Photo, PlacedInspection, ProjectNode, Review } from '@vitan/shared';

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

/** Breadcrumb of NODES from root → node (cycle-safe) — the kind-aware sibling of
 *  `trailOf`, for readers that must group by what a node IS rather than where it
 *  sits (nested locations: position no longer implies kind). */
function trailNodesOf(nodes: ProjectNode[], nodeId: string | undefined | null): ProjectNode[] {
  const out: ProjectNode[] = [];
  const seen = new Set<string>();
  let cur = nodeById(nodes, nodeId);
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    out.unshift(cur);
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
  counts: { total: number; pending: number; approved: number; change: number; withdrawn: number; recorded: number; awaiting_countersign: number };
}

// (Phase 6 task 4d-ii-b / B3 — `awaiting_countersign` answered: the label, and its place in the status order
// between the open states and the final approval; the API's status tripwire pins both as answered)
const STATUS_LABEL: Record<string, string> = { pending: 'Pending', approved: 'Approved', change: 'Change requested', awaiting_countersign: 'Awaiting countersign', withdrawn: 'Withdrawn', recorded: 'Recorded' };

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
      // KIND-true, not positional (nested locations): the decision's room is the DEEPEST
      // node of kind 'room' on its filed trail — a decision filed at Zone › Wing › Pour
      // groups under Pour (where it was FILED), and a zone-filed decision or a zone-level
      // element has NO room and is never presented as one. Free-text legacy decisions
      // keep their stored room name as the group.
      const trail = trailNodesOf(nodes, d.nodeId);
      const roomIndex = trail.map((n) => n.kind).lastIndexOf('room');
      if (trail.length && roomIndex >= 0) {
        const room = trail[roomIndex]!;
        key = `room:${room.name}`;
        label = room.name;
        subLabel = trail.slice(roomIndex + 1).map((n) => n.name).join(' › ');
      } else if (trail.length) {
        key = 'room:~none';
        label = 'No room';
        subLabel = trail.map((n) => n.name).join(' › ');
      } else {
        key = `room:${seg[0]}`;
        label = seg[0];
      }
    } else if (mode === 'element') {
      // KIND-true: only a decision FILED ON an element forms an object group — a room- or
      // zone-filed decision (or a free-text one) is honestly "No object", with its actual
      // location as the row caption, instead of its last path segment masquerading as one.
      const trail = trailNodesOf(nodes, d.nodeId);
      const filed = trail[trail.length - 1];
      if (filed?.kind === 'element') {
        key = `el:${filed.name}`;
        label = filed.name;
        subLabel = trail.slice(0, -1).map((n) => n.name).join(' › ');
      } else {
        key = 'el:~none';
        label = 'No object';
        subLabel = seg.join(' › ');
      }
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
    // (`awaiting_countersign`, Phase 6 task 4d, is counted so the counter answers for every status; its
    // label and its place in the status order landed with 4d-ii-b / B3, above and below)
    const counts = { total: rows.length, pending: 0, approved: 0, change: 0, withdrawn: 0, recorded: 0, awaiting_countersign: 0 };
    for (const r of rows) counts[r.decision.status] += 1;
    // rows sorted by their finer location, then id
    rows.sort((a, b) => a.subLabel.localeCompare(b.subLabel) || a.decision.id.localeCompare(b.decision.id));
    return { key, label: labelOf.get(key)!, rows, counts };
  });

  // section order: status uses a fixed priority; otherwise alphabetical by label
  if (mode === 'status') {
    const rank: Record<string, number> = { pending: 0, change: 1, awaiting_countersign: 2, approved: 3, recorded: 4, withdrawn: 5 };
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
  counts: {
    decisions: number; drawings: number; photos: number; activities: number; materials: number; inspections: number;
    /** #633 — open issues here (see {@link openIssueCount}); null when a server older than the field sent the inspections */
    openIssues: number | null;
  };
}

const RELATION_RANK: Record<DrawingRelation, number> = { here: 0, detail: 1, inherited: 2 };

/**
 * Gather everything at a place for the Site Map. Decisions, photos, activities and
 * materials use SUBTREE semantics (a room includes its objects' items); drawings use
 * INHERIT-DOWN semantics — a room shows drawings filed on it (`here`), on any ancestor
 * (`inherited`, e.g. the floor plan), or on a descendant object (`detail`, e.g. a door
 * detail). `nodeId === null` means the whole project: everything, unfiled items included.
 */
/**
 * #633 — the ONE "open issue" count for a place: the items on its re-inspections not yet decided, as the
 * server counts them per inspection (`openIssues`, the same rule as the Dashboard's "failed items awaiting
 * re-inspection"). A row without the key comes from a server older than the field: the count is then
 * unknown (null) and is never shown as a number.
 */
export function openIssueCount(inspections: PlacedInspection[]): number | null {
  let n = 0;
  for (const i of inspections) {
    if (typeof i.openIssues !== 'number') return null;
    n += i.openIssues;
  }
  return n;
}

/**
 * #847 — a demo review's failed items still open: its FAIL items while it awaits the PMC's decision; none
 * once the PMC approved it; once the PMC sent its re-inspection, the FAIL items plus those the PMC rejected.
 * The Dashboard's demo count (`selectFailedCount`) and the Site Map both read this one rule.
 */
export function demoReviewOpenIssues(r: Review): number {
  if (r.decided && !r.reinspectionSent) return 0;
  return r.items.filter((it) => it.result === 'FAIL' || (r.reinspectionSent && it.rejected)).length;
}

/**
 * #847 — the API-less demo's inspections for the Site Map, for the PMC (the one demo role whose record link
 * opens a review). The demo has no server to count open issues per inspection, so each review stands on the
 * map as its own row carrying `demoReviewOpenIssues`, and the map's total equals the Dashboard's. Placed rows
 * with no review keep what the seed says.
 */
export function demoSiteMapInspections(placed: PlacedInspection[], reviews: Review[]): PlacedInspection[] {
  // failedItems as the server serializes it (FAIL or rejected, decided or not); openIssues by the demo rule
  const row = (r: Review) => ({ submitted: true, decided: r.decided, failedItems: r.items.filter((it) => it.result === 'FAIL' || it.rejected).length, openIssues: demoReviewOpenIssues(r) });
  const byId = new Map(reviews.map((r) => [r.id, r]));
  const rows = placed.map((p) => {
    const r = byId.get(p.id);
    return r ? { ...p, ...row(r) } : p;
  });
  for (const r of reviews) {
    if (placed.some((p) => p.id === r.id)) continue;
    rows.push({ id: r.id, title: r.title, zone: r.zone, nodeId: r.nodeId, reinspectionOfId: r.reinspectionOfId ?? null, kind: 'review', ...row(r) });
  }
  return rows;
}

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
      counts: { decisions: decisions.length, drawings: drawings.length, photos: photos.length, activities: activities.length, materials: materials.length, inspections: inspections.length, openIssues: openIssueCount(inspections) },
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
    counts: { decisions: decisionsHere.length, drawings: placedDrawings.length, photos: photosHere.length, activities: activitiesHere.length, materials: materialsHere.length, inspections: inspectionsHere.length, openIssues: openIssueCount(inspectionsHere) },
  };
}

/** B8 — where a space stands, DERIVED from the activities placed in its subtree (no stored field). */
export interface SpaceStatus {
  total: number;
  done: number;
  blocked: number;
  /** none = no work placed here yet */
  state: 'none' | 'not-started' | 'in-progress' | 'blocked' | 'done';
  /** the phase the space is in: the earliest phase (by order) with unfinished work here, else the
   *  last phase its work belongs to; null when no placed activity has a phase */
  phase: string | null;
}

export function spaceStatus(nodes: ProjectNode[], activities: Activity[], phases: Phase[], nodeId: string): SpaceStatus {
  const sub = subtreeIds(nodes, nodeId);
  const here = activities.filter((a) => a.nodeId && sub.has(a.nodeId));
  const total = here.length;
  const done = here.filter((a) => a.status === 'done').length;
  const blocked = here.filter((a) => a.status === 'blocked').length;
  const started = here.some((a) => a.status !== 'not-started');
  const state: SpaceStatus['state'] = total === 0 ? 'none'
    : blocked > 0 ? 'blocked'
    : done === total ? 'done'
    : started ? 'in-progress'
    : 'not-started';
  const orderOf = new Map(phases.map((p) => [p.id, p.order]));
  const phased = here.filter((a) => a.phaseId && orderOf.has(a.phaseId))
    .sort((x, y) => orderOf.get(x.phaseId!)! - orderOf.get(y.phaseId!)!);
  const current = phased.find((a) => a.status !== 'done') ?? phased[phased.length - 1];
  const phase = current ? phases.find((p) => p.id === current.phaseId)?.name ?? null : null;
  return { total, done, blocked, state, phase };
}
