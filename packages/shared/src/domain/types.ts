/**
 * Domain types for Vitan PMC.
 *
 * These mirror the prototype's state shape exactly. Enum string unions match the
 * values the logic branches on (decision status, activity status, gate state),
 * so the ported selectors/reducers stay faithful.
 */

import type { SwatchKey } from '../tokens/swatches';

/**
 * Every role a bearer token can carry — including the account-less `worker` device
 * token the API issues for QR job-card onboarding. This is the canonical role set the
 * authorization policy (`domain/policy.ts`) and the API's tokens are keyed on.
 */
export type TokenRole = 'pmc' | 'client' | 'engineer' | 'contractor' | 'consultant' | 'worker';

/**
 * Disciplines a consultant can be responsible for. This is a LABEL on the membership,
 * not a permission set — every consultant shares the same (read-mostly) `consultant`
 * role; the discipline just records what they cover, so the practice can add a lighting
 * or plumbing consultant without a new role. Free-form 'other' catches anything unlisted.
 */
export type ConsultantDiscipline =
  | 'architect'
  | 'structural'
  | 'mep'
  | 'plumbing'
  | 'electrical'
  | 'hvac'
  | 'lighting'
  | 'landscape'
  | 'interior'
  | 'facade'
  | 'acoustics'
  | 'other';

export const CONSULTANT_DISCIPLINES: ConsultantDiscipline[] = [
  'architect', 'structural', 'mep', 'plumbing', 'electrical', 'hvac', 'lighting', 'landscape', 'interior', 'facade', 'acoustics', 'other',
];

/**
 * Map a consultant's (fine-grained) discipline to the drawing register's four buckets
 * (`architectural | structural | mep | other`), so a lighting/plumbing/HVAC consultant's
 * default drawing view is the MEP set, an architect's is architectural, and so on. Used to
 * scope what a consultant sees by default (they can still switch to "all disciplines").
 */
export function drawingDisciplineFor(discipline: string | undefined | null): 'architectural' | 'structural' | 'mep' | 'other' {
  switch (discipline) {
    case 'architect':
    case 'interior':
    case 'facade':
      return 'architectural';
    case 'structural':
      return 'structural';
    case 'mep':
    case 'plumbing':
    case 'electrical':
    case 'hvac':
    case 'lighting':
      return 'mep';
    default:
      return 'other';
  }
}

/**
 * The interactive session roles the web renders a full app shell for. `worker` is
 * excluded on purpose: workers use the job-card flow (never a role session), so the
 * screen/label maps stay a clean four-role set.
 */
export type Role = Exclude<TokenRole, 'worker'>;

export type ScreenKey =
  | 'inbox'
  | 'dashboard'
  | 'site-schedule'
  | 'drafts'
  | 'decision-log'
  | 'inspect-review'
  | 'client-decisions'
  | 'client-health'
  | 'daily-log'
  | 'engineer-check'
  | 'drawings'
  | 'places'
  | 'team'
  | 'portfolio'
  | 'team-access';

export type Lang = 'en' | 'hi' | 'gu';

export type DecisionStatus = 'pending' | 'approved' | 'change';
/** `awaiting-signoff` = a completion CLAIM parked until the PMC approves the
 *  linked closing inspection (Phase 1 Task 5) — counted as NOT done everywhere. */
export type ActivityStatus = 'not-started' | 'in-progress' | 'awaiting-signoff' | 'done' | 'blocked';
export type Gate = 'ok' | 'wait' | 'fail' | 'na';
export type ItemState = 'pass' | 'fail' | 'na' | null;
export type InspectionResult = 'PASS' | 'FAIL';
export type ModalType = 'approve' | 'change' | 'qr' | null;
export type AccessStep = 'who' | 'trade' | 'phone' | 'otp' | 'login' | 'emailentry' | 'emailcode' | 'badge' | 'jobcard' | 'tradehome';
export type AccessWho = 'team' | 'trade' | 'worker' | null;

export interface DecisionOption {
  label: string;
  key: string;
  material: string;
  delta: number;
  swatch: SwatchKey;
  /** uploaded sample photo (media url); the swatch is the fallback rendering */
  photoUrl?: string;
  recommended: boolean;
}

export type NodeKind = 'zone' | 'room' | 'element';

/** A node in a project's location tree: zone → room → element (the object). */
export interface ProjectNode {
  id: string;
  parentId: string | null;
  name: string;
  kind: NodeKind;
  order: number;
  /** a private, unpublished DRAFT location — only its author sees it; published to the team on publish */
  draft?: boolean;
}

export interface Decision {
  id: string;
  title: string;
  room: string;
  /** location-tree node this decision attaches to (undefined = ungrouped, legacy `room`) */
  nodeId?: string;
  status: DecisionStatus;
  /** a private, unpublished DRAFT — only its author sees it, and the app ignores it until published */
  draft?: boolean;
  ageDays?: number;
  photoSwatch: SwatchKey;
  options: DecisionOption[];
  approvedOption?: string;
  material?: string;
  approver?: string;
  date?: string;
  cost?: number;
  /** 'client' when someone other than the client locked the decision on their behalf (Phase 1 Task 2) */
  onBehalfOf?: string;
  /** the OPEN change request while status='change' — why the lock is being revisited (Phase 1 Task 2) */
  changeRequest?: { reason: string; costImpact: number; timeImpactDays: number; requestedById?: string };
}

export interface Activity {
  id: string;
  name: string;
  zone: string;
  decisionId: string | null;
  /** the phase this activity belongs to (null = unphased) */
  phaseId: string | null;
  /** location-tree node where this work happens (undefined = unplaced) */
  nodeId?: string;
  /** planned start / end — LEGACY day-offsets from the schedule anchor (compat) */
  ps: number;
  pe: number;
  /** actual start / end — null until started / finished (legacy offsets) */
  as: number | null;
  ae: number | null;
  /** real civil dates (ISO YYYY-MM-DD) — canonical when present (Phase 0 Task 6) */
  plannedStartDate?: string | null;
  plannedEndDate?: string | null;
  actualStartDate?: string | null;
  actualEndDate?: string | null;
  status: ActivityStatus;
  /** DEPRECATED stored flags (demo/display compat) — `readiness` is the truth (Task 6) */
  gm: Gate;
  gt: Gate;
  gi: Gate;
  block?: string;
  /** the five-gate derivation with named sources + reasons (Task 6) — present in
   *  API mode; the demo derives an equivalent locally via the shared truth tables */
  readiness?: ActivityReadinessShape;
  /** ACTIVE manual readiness exceptions — attributable, reasoned, expiring (Task 6) */
  overrides?: ActivityOverride[];
}

/** structural mirror of readiness.ts's ActivityReadiness (kept here so the type
 *  graph stays acyclic; the derivation module is the behavioral owner) */
export interface GateReadingShape {
  v: Gate;
  source: 'derived' | 'stored' | 'override';
  reason: string;
}
export interface ActivityReadinessShape {
  decision: GateReadingShape;
  material: GateReadingShape;
  team: GateReadingShape;
  inspection: GateReadingShape;
  drawing: GateReadingShape;
}

/** An ACTIVE manual readiness exception on an activity (Task 6). */
export interface ActivityOverride {
  id: string;
  gate: 'decision' | 'material' | 'team' | 'inspection' | 'drawing';
  state: Gate;
  reason: string;
  actorName: string;
  expiresAt: string; // ISO instant
  evidenceMediaId?: string;
}

/** A project phase with a live rollup of its activities (phase-level monitoring). */
export interface Phase {
  id: string;
  name: string;
  order: number;
  /** planned window — day-offsets from 1 Jun 2026 */
  plannedStart: number;
  /** real civil dates (ISO) — canonical when present */
  plannedStartDate?: string | null;
  plannedEnd: number;
  plannedEndDate?: string | null;
  activityTotal: number;
  done: number;
  inProgress: number;
  blocked: number;
  notStarted: number;
  donePct: number;
}

/** A cross-project monitoring rollup (one row per project the user can access). */
export interface PortfolioProject {
  projectId: string;
  name: string;
  short: string;
  stage: string;
  role: Role;
  orgName: string | null;
  activityTotal: number;
  done: number;
  inProgress: number;
  blocked: number;
  notStarted: number;
  donePct: number;
  openReviews: number;
  pendingDecisions: number;
  phaseCount: number;
  milestonePct: number;
}

export interface ChecklistItem {
  /** server row id — the capture flow links evidence uploads to THIS item (Task 4) */
  id?: string;
  name: string;
  state: ItemState;
  /** DEPRECATED display counter — linked evidence rows are the proof (Task 4) */
  photos: number;
  note: string;
  /** the item's linked photo evidence as resolvable URLs (Task 4) */
  evidence?: string[];
}

export interface Checklist {
  id: string;
  title: string;
  zone: string;
  /** location-tree node where this check happens (undefined = unplaced) */
  nodeId?: string;
  date: string;
  submitted: boolean;
  items: ChecklistItem[];
}

export interface ReviewItem {
  /** server row id — rejection addresses THIS row (labels are not unique, Task 4/gate finding 3) */
  id?: string;
  name: string;
  result: InspectionResult;
  /** the item's linked photo evidence as resolvable URLs (Task 4) */
  evidence?: string[];
  swatch: SwatchKey;
  note: string;
  rejected: boolean;
}

export interface Review {
  id: string;
  title: string;
  zone: string;
  /** location-tree node where this check happens (undefined = unplaced) */
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
  items: ReviewItem[];
}

// ── Orgs, memberships & team (multi-tenant) ──────────────────────────────────
export interface MembershipSummary {
  projectId: string;
  name: string;
  short: string;
  role: Role;
  /** for a `consultant`: the discipline they cover (scopes their default views) */
  discipline?: string;
  orgId: string | null;
  orgName: string | null;
}

export interface ProjectMember {
  userId: string;
  name: string;
  email: string | null;
  phone: string | null;
  /** for a `consultant` member: the discipline they cover (undefined for other roles) */
  discipline?: string;
  role: Role;
  status: string;
}

/** Kind of firm/consultant attached to a project. */
export type CompanyKind = 'client' | 'contractor' | 'architect' | 'structural' | 'mep' | 'pmc' | 'consultant' | 'other';

/** A firm/consultant on a project — an organisation + a contact (distinct from a member/person). */
export interface ProjectCompany {
  id: string;
  name: string;
  kind: CompanyKind;
  contactName: string;
  contactEmail: string;
  contactPhone: string;
  notes: string;
}

export interface OrgSummary {
  id: string;
  name: string;
  slug: string;
  role: string;
}

/** Administrative role within an org (distinct from a project role). */
export type OrgRole = 'owner' | 'admin' | 'member';

/** A member of an org's admin roster (owner/admin/member). */
export interface OrgMember {
  userId: string;
  name: string;
  email: string | null;
  phone: string | null;
  orgRole: OrgRole;
}

// ── Drawings register (Slice 1) ──────────────────────────────────────────────
export type Discipline = 'architectural' | 'structural' | 'mep' | 'other';
export type DrawingStatus = 'for_review' | 'for_construction' | 'superseded';

export interface DrawingAck {
  userName: string;
  role: string;
  at: string; // display date
}

/** One name on a revision's FROZEN distribution — issued-to + ack state (Phase 1 Task 3). */
export interface DrawingRecipient {
  userName: string;
  role: string; // roleAtIssue: engineer | contractor
  acked: boolean;
}

export interface DrawingRevision {
  id: string;
  rev: string;
  status: DrawingStatus;
  mime: string;
  url: string; // resolvable: /drawings/rev/:id (dev stub) or an absolute bucket URL
  sizeBytes: number;
  note: string;
  issuedBy: string;
  issuedAt: string;
  acks: DrawingAck[]; // who has acknowledged building to this revision
  /** when the distribution was frozen (ISO); null/absent = legacy, predates snapshots */
  recipientsFrozenAt?: string | null;
  /** WHO this revision was issued to, frozen at issue time (Phase 1 Task 3) */
  recipients?: DrawingRecipient[];
}

export interface Drawing {
  id: string;
  number: string;
  title: string;
  discipline: Discipline;
  zone: string | null;
  activityId: string | null;
  decisionId: string | null;
  /** location-tree node this drawing governs; inherited down to rooms/objects beneath it */
  nodeId?: string;
  /** a private, unpublished DRAFT — only its author sees it; issued to the team on publish */
  draft?: boolean;
  /** the GOVERNING revision: latest non-superseded for_construction, or null — a
   *  drawing with only review copies never governs the field (Phase 1 Task 3) */
  current: DrawingRevision | null;
  ackedByMe: boolean; // has the current user acknowledged the current revision?
  /** is the current user on the governing revision's frozen distribution?
   *  (absent = legacy/demo data — treat as "everyone builds from it") */
  recipientOfCurrent?: boolean;
  revisions: DrawingRevision[]; // newest first
}

/** A site photo placed on the location tree — the "reality" layer the Place view reads.
 *  `url` is a resolvable signed serve path (or a data URL in the local demo). */
export interface Photo {
  id: string;
  url: string;
  takenAt?: string;
  /** location-tree node this photo shows (undefined = unplaced) */
  nodeId?: string;
  kind: string; // progress | inspection | material
}

export interface CrewRow {
  trade: string;
  count: number;
}

export interface SiteMaterial {
  name: string;
  decisionId: string;
  qty: string;
  zone: string;
  matched: boolean;
  swatch: SwatchKey;
  photo: boolean;
}

/** A material delivery placed on the location tree — the Site Map's "materials here"
 *  (the whole project's deliveries, not just the current day's daily-log rows). */
export interface Material {
  id: string;
  name: string;
  qty: string;
  zone: string;
  matched: boolean;
  swatch: SwatchKey;
  decisionId?: string;
  /** location-tree node where it was delivered (undefined = unplaced) */
  nodeId?: string;
}

/** An inspection placed on the location tree — the Site Map's "inspections here".
 *  Delivered only to pmc/engineer (AUTH-02: the review queue is an internal sign-off
 *  surface), so it never reaches the client/contractor/consultant Place view. */
export interface PlacedInspection {
  id: string;
  title: string;
  zone: string;
  /** location-tree node where this check happens (undefined = unplaced) */
  nodeId?: string;
  kind: string; // 'checklist' | 'review'
  submitted: boolean;
  decided: boolean;
  /** count of failed/rejected items — a passed inspection has 0 */
  failedItems: number;
}

/** A reference to an uploaded photo. `url` is absolute (S3/R2) or a data URL (local demo). */
export interface MediaRef {
  id?: string;
  url: string;
  takenAt?: string;
}

export interface DailyLog {
  date: string;
  /** the civil day the site work belongs to (ISO YYYY-MM-DD) — Phase 0 Task 6 */
  logDate?: string | null;
  checkedIn: boolean;
  checkinTime: string | null;
  submitted: boolean;
  crew: CrewRow[];
  materials: SiteMaterial[];
  progress: number;
  photos: MediaRef[];
}

export interface Worker {
  name: string;
  trade: string;
  color: string;
  job: string;
}

export interface AccessState {
  step: AccessStep;
  who: AccessWho;
  trade: string | null;
  phone: string;
  email: string;
  otp: string;
  worker: Worker | null;
  /** true while an OTP request/verify is in flight (disables the buttons). */
  sending: boolean;
  /** last auth error to surface on the OTP screen, or null. */
  error: string | null;
  /** dev-stub OTP hint returned by the server when no SMS provider is configured. */
  devCode: string | null;
}

export interface AppNotification {
  text: string;
  time: string;
  color: string;
}

export interface ModalState {
  type: ModalType;
  decId?: string;
  optIdx?: number;
  title?: string;
  optionLabel?: string;
  material?: string;
  delta?: number;
  swatch?: string;
  changeText?: string;
  changeCost?: string;
  changeTime?: string;
}
