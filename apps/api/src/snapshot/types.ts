/** API response shapes — aligned with the frontend domain model so the client
 *  hydrates its store directly from a snapshot. */

export interface OptionDto {
  label: string;
  key: string;
  material: string;
  delta: number;
  swatch: string;
  photoUrl?: string;
  recommended: boolean;
}

export interface NodeDto {
  id: string;
  parentId: string | null;
  name: string;
  kind: 'zone' | 'room' | 'element';
  order: number;
}

export interface DecisionDto {
  id: string;
  title: string;
  room: string;
  /** the location-tree node this decision attaches to (null/absent = ungrouped, legacy `room`) */
  nodeId?: string;
  status: 'pending' | 'approved' | 'change';
  ageDays?: number;
  photoSwatch: string;
  options: OptionDto[];
  approvedOption?: string;
  material?: string;
  approver?: string;
  date?: string;
  cost?: number;
  /** a private, unpublished DRAFT — only ever present in its own author's snapshot */
  draft?: boolean;
}

export interface ActivityDto {
  id: string;
  name: string;
  zone: string;
  decisionId: string | null;
  phaseId: string | null;
  /** location-tree node where this work happens */
  nodeId?: string;
  ps: number;
  pe: number;
  as: number | null;
  ae: number | null;
  status: 'not-started' | 'in-progress' | 'done' | 'blocked';
  gm: 'ok' | 'wait' | 'fail' | 'na';
  gt: 'ok' | 'wait' | 'fail' | 'na';
  gi: 'ok' | 'wait' | 'fail' | 'na';
  block?: string;
}

/** An inspection placed on the location tree — the Site Map's "inspections here".
 *  Serialized ONLY for pmc/engineer (AUTH-02); empty for everyone else. */
export interface PlacedInspectionDto {
  id: string;
  title: string;
  zone: string;
  nodeId?: string;
  kind: string; // 'checklist' | 'review'
  submitted: boolean;
  decided: boolean;
  /** count of failed/rejected items — a passed inspection has 0 */
  failedItems: number;
}

/** A project phase with a live rollup of its activities — the unit of phase-level
 *  monitoring. `donePct` is done/total (0 when the phase has no activities yet). */
export interface PhaseDto {
  id: string;
  name: string;
  order: number;
  plannedStart: number;
  plannedEnd: number;
  activityTotal: number;
  done: number;
  inProgress: number;
  blocked: number;
  notStarted: number;
  donePct: number;
}

export interface ChecklistDto {
  id: string;
  title: string;
  zone: string;
  /** location-tree node where this check happens */
  nodeId?: string;
  date: string;
  submitted: boolean;
  items: { name: string; state: string | null; photos: number; note: string }[];
}

export interface ReviewDto {
  id: string;
  title: string;
  zone: string;
  /** location-tree node where this check happens */
  nodeId?: string;
  by: string;
  date: string;
  decided: boolean;
  items: { name: string; result: 'PASS' | 'FAIL'; swatch: string; note: string; rejected: boolean }[];
}

/** A material delivery placed on the location spine — the Site Map's "materials here". */
export interface MaterialDto {
  id: string;
  name: string;
  qty: string;
  zone: string;
  matched: boolean;
  swatch: string;
  decisionId?: string;
  /** location-tree node where it was delivered (undefined = unplaced) */
  nodeId?: string;
}

export interface DrawingAckDto {
  userName: string;
  role: string;
  at: string; // display date, e.g. "08 Jul 2026"
}

export interface DrawingRevisionDto {
  id: string;
  rev: string;
  status: string; // for_review | for_construction | superseded
  mime: string;
  url: string; // resolvable: /drawings/rev/:id (dev stub) or an absolute bucket URL
  sizeBytes: number;
  note: string;
  issuedBy: string;
  issuedAt: string;
  acks: DrawingAckDto[]; // who has acknowledged building to this revision
}

export interface DrawingDto {
  id: string;
  number: string;
  title: string;
  discipline: string;
  zone: string | null;
  activityId: string | null;
  decisionId: string | null;
  /** location-tree node this drawing governs (inherited down to rooms/objects beneath it) */
  nodeId?: string;
  current: DrawingRevisionDto | null; // the latest non-superseded revision
  ackedByMe: boolean; // has the caller acknowledged the current revision?
  revisions: DrawingRevisionDto[]; // full history, newest first
}

/** A site photo placed on the location spine — the "reality" layer of the Place view. */
export interface PhotoDto {
  id: string;
  url: string; // resolvable signed serve path
  takenAt?: string;
  /** location-tree node this photo shows (undefined = unplaced) */
  nodeId?: string;
  kind: string; // progress | inspection | material
}

export interface DailyLogDto {
  date: string;
  checkedIn: boolean;
  checkinTime: string | null;
  submitted: boolean;
  crew: { trade: string; count: number }[];
  materials: { name: string; decisionId: string; qty: string; zone: string; matched: boolean; swatch: string; photo: boolean }[];
  progress: number;
  photos: { id: string; url: string; takenAt?: string }[];
}

export interface ProjectMetaDto {
  id: string;
  name: string;
  short: string;
  descriptor: string;
  stage: string;
  siteCode: string;
  location: string;
  projStart: string;
  projEnd: string;
  elapsedPct: number;
  todayDay: number;
  milestonePct: number;
}

export interface CompanyDto {
  id: string;
  name: string;
  kind: string;
  contactName: string;
  contactEmail: string;
  contactPhone: string;
  notes: string;
}

export interface SnapshotDto {
  project: ProjectMetaDto;
  decisions: DecisionDto[];
  activities: ActivityDto[];
  /** every inspection with its place, for the Site Map (pmc/engineer only; empty otherwise) */
  placedInspections: PlacedInspectionDto[];
  checklist: ChecklistDto | null;
  /** The PMC review queue: every submitted-but-undecided inspection (a submitted
   *  checklist, the seeded review, an auto-created closing inspection), oldest first. */
  reviews: ReviewDto[];
  /** @deprecated first pending review — kept for back-compat; use `reviews`. */
  review: ReviewDto | null;
  reinspectionCreated: boolean;
  drawings: DrawingDto[];
  /** Project phases with per-phase activity rollups (empty when none are defined —
   *  the schedule then renders a flat list, unchanged). */
  phases: PhaseDto[];
  dailyLog: DailyLogDto | null;
  notifications: { text: string; time: string; color: string }[];
  /** Firms & consultants attached to the project (client company, contractor, MEP/structural consultants, …). */
  companies: CompanyDto[];
  /** The project location tree (zones → rooms → elements) the decision register groups by. */
  nodes: NodeDto[];
  /** Site photos placed on the location tree — the reality layer for the Place view. */
  photos: PhotoDto[];
  /** All material deliveries across the project, with their place — the Site Map's "materials here". */
  materials: MaterialDto[];
}
