/** API response shapes — aligned with the frontend domain model so the client
 *  hydrates its store directly from a snapshot. */
import type { Drawing, Checklist, Review, PlacedInspection } from '@vitan/shared';

/** Phase 2 Task 9 — the project-shell summary (identity + projection counts), the light payload the
 *  app loads first. `enabledModules` is added by the controller from the module registry. */
export interface ProjectShellCounts {
  id: string;
  name: string;
  descriptor: string;
  stage: string;
  siteCode: string;
  org: { id: string; name: string } | null;
  counts: { pendingDecisions: number; decisionsGeneration: number | null };
}
export interface ProjectShellDto extends ProjectShellCounts {
  /** the single enablement source (all compiled registry modules — finding 7) */
  enabledModules: string[];
  /** Phase 3 Task 7 (§D) — the PER-PROJECT pilot capabilities this project has enabled (e.g.
   *  `'materials'`); `[]` for a non-pilot project. The frontend gates the Materials surfaces on this,
   *  so a non-pilot project shows no Materials nav/screens — matching the server's 404 stance. */
  capabilities: string[];
}

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
  /** a private, unpublished DRAFT location — only ever present in its own author's snapshot */
  draft?: boolean;
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
  /** 'client' when someone other than the client locked the decision on their behalf (Phase 1 Task 2) */
  onBehalfOf?: string;
  /** the OPEN change request while status='change' — why the lock is being revisited (Phase 1 Task 2) */
  changeRequest?: { reason: string; costImpact: number; timeImpactDays: number; requestedById?: string };
  /** a private, unpublished DRAFT — only ever present in its own author's snapshot */
  draft?: boolean;
}

/** One derived gate value with its provenance (Phase 1 Task 6). */
export interface GateReadingDto {
  v: 'ok' | 'wait' | 'fail' | 'na';
  /** derived = concluded from explicit links; stored = legacy site flag
   *  (material/team until Phases 3/4); override = an unexpired manual exception */
  source: 'derived' | 'stored' | 'override';
  reason: string;
}

/** The five-gate readiness conclusion the schedule renders (Phase 1 Task 6). */
export interface ActivityReadinessDto {
  decision: GateReadingDto;
  material: GateReadingDto;
  team: GateReadingDto;
  inspection: GateReadingDto;
  drawing: GateReadingDto;
}

/** An ACTIVE manual readiness exception — attributable, reasoned, expiring. */
export interface GateOverrideDto {
  id: string;
  gate: 'decision' | 'material' | 'team' | 'inspection' | 'drawing';
  state: 'ok' | 'wait' | 'fail' | 'na';
  reason: string;
  actorName: string;
  expiresAt: string; // ISO instant
  evidenceMediaId?: string;
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
  /** Task 6: real civil dates (ISO YYYY-MM-DD); ints above are the legacy compat timeline */
  plannedStartDate: string | null;
  plannedEndDate: string | null;
  actualStartDate: string | null;
  actualEndDate: string | null;
  /** `awaiting-signoff` = a completion CLAIM parked until the PMC approves the
   *  linked closing inspection (Phase 1 Task 5) — counted as NOT done everywhere */
  status: 'not-started' | 'in-progress' | 'awaiting-signoff' | 'done' | 'blocked';
  /** DEPRECATED stored flags (display compat) — `readiness` is the truth (Task 6) */
  gm: 'ok' | 'wait' | 'fail' | 'na';
  gt: 'ok' | 'wait' | 'fail' | 'na';
  gi: 'ok' | 'wait' | 'fail' | 'na';
  block?: string;
  /** the five-gate derivation with named sources and reasons (Task 6) */
  readiness: ActivityReadinessDto;
  /** ACTIVE manual exceptions on this activity (revocable, expiring) */
  overrides: GateOverrideDto[];
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
  plannedStartDate: string | null;
  plannedEndDate: string | null;
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
  /** `id` links evidence uploads to the item; `evidence` = signed serve paths (Task 4).
   *  `photos` is a DEPRECATED display counter — linked evidence rows are the proof. */
  items: { id: string; name: string; state: string | null; photos: number; note: string; evidence: string[] }[];
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
  /** set when this review IS a reinspection — the predecessor it re-checks (Task 4) */
  reinspectionOfId?: string;
  /** set when this review is a CLOSING sign-off (Task 5): approving it completes
   *  the named activity; rejecting it returns that activity to execution */
  closing?: boolean;
  activityId?: string;
  activityName?: string;
  /** `evidence` = the item's linked photo proof as signed serve paths (Task 4) */
  items: { id: string; name: string; result: 'PASS' | 'FAIL'; swatch: string; note: string; rejected: boolean; evidence: string[] }[];
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

/** One name on a revision's FROZEN distribution — issued-to + whether they acked (Phase 1 Task 3). */
export interface DrawingRecipientDto {
  userName: string;
  role: string; // roleAtIssue: engineer | contractor
  acked: boolean;
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
  /** when the distribution was frozen (ISO); null = legacy revision, predates snapshots */
  recipientsFrozenAt: string | null;
  /** WHO this revision was issued to, frozen at issue time (empty = frozen empty OR legacy) */
  recipients: DrawingRecipientDto[];
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
  /** a private, unpublished DRAFT — only ever present in its own author's snapshot */
  draft?: boolean;
  /** the GOVERNING revision: latest non-superseded for_construction, or null — a
   *  drawing whose only revisions are review copies never governs (Phase 1 Task 3) */
  current: DrawingRevisionDto | null;
  ackedByMe: boolean; // has the caller acknowledged the current revision?
  /** is the CALLER on the governing revision's frozen distribution? (Phase 1 Task 3) */
  /** is the viewer on the governing revision's FROZEN distribution? ABSENT (not false)
   *  when the governing revision predates recipient snapshots (recipientsFrozenAt null)
   *  or there is no governing revision — the client falls back to everyone-builds. */
  recipientOfCurrent?: boolean;
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
  /** Task 6: the civil day the site work belongs to (ISO) */
  logDate: string | null;
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
  /** Task 6: the schedule anchor (the day offset 0 refers to) + real window end */
  scheduleStartDate: string | null;
  scheduleEndDate: string | null;
  timeZone: string;
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
  // Task 10 (Module 3) — the inspection slices are the shared `Checklist`/`Review`/`PlacedInspection`
  // types, served by the inspections module's query (`InspectionsQueryService.snapshotSlice`).
  // Byte-identical wire shape to the retired `*Dto`s (kept below for the characterization test's shape
  // descriptor).
  /** every inspection with its place, for the Site Map (pmc/engineer only; empty otherwise) */
  placedInspections: PlacedInspection[];
  checklist: Checklist | null;
  /** The PMC review queue: every submitted-but-undecided inspection (a submitted
   *  checklist, the seeded review, an auto-created closing inspection), oldest first. */
  reviews: Review[];
  /** @deprecated first pending review — kept for back-compat; use `reviews`. */
  review: Review | null;
  reinspectionCreated: boolean;
  // Task 10 — the drawings register is the shared `Drawing` type, served by the drawings module's
  // query (`DrawingsQueryService.snapshotSlice`). Byte-identical wire shape to the retired `DrawingDto`
  // (kept below for the characterization test's shape descriptor).
  drawings: Drawing[];
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
