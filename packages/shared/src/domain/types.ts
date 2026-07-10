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
export type TokenRole = 'pmc' | 'client' | 'engineer' | 'contractor' | 'worker';

/**
 * The interactive session roles the web renders a full app shell for. `worker` is
 * excluded on purpose: workers use the job-card flow (never a role session), so the
 * screen/label maps stay a clean four-role set.
 */
export type Role = Exclude<TokenRole, 'worker'>;

export type ScreenKey =
  | 'dashboard'
  | 'site-schedule'
  | 'decision-log'
  | 'inspect-review'
  | 'client-decisions'
  | 'client-health'
  | 'daily-log'
  | 'engineer-check'
  | 'drawings'
  | 'team'
  | 'portfolio'
  | 'team-access';

export type Lang = 'en' | 'hi' | 'gu';

export type DecisionStatus = 'pending' | 'approved' | 'change';
export type ActivityStatus = 'not-started' | 'in-progress' | 'done' | 'blocked';
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

export interface Decision {
  id: string;
  title: string;
  room: string;
  status: DecisionStatus;
  ageDays?: number;
  photoSwatch: SwatchKey;
  options: DecisionOption[];
  approvedOption?: string;
  material?: string;
  approver?: string;
  date?: string;
  cost?: number;
}

export interface Activity {
  id: string;
  name: string;
  zone: string;
  decisionId: string | null;
  /** the phase this activity belongs to (null = unphased) */
  phaseId: string | null;
  /** planned start / end — day-offsets from 1 Jun 2026 */
  ps: number;
  pe: number;
  /** actual start / end — null until started / finished */
  as: number | null;
  ae: number | null;
  status: ActivityStatus;
  /** gate states: material / team / inspection (decision gate is derived live) */
  gm: Gate;
  gt: Gate;
  gi: Gate;
  block?: string;
}

/** A project phase with a live rollup of its activities (phase-level monitoring). */
export interface Phase {
  id: string;
  name: string;
  order: number;
  /** planned window — day-offsets from 1 Jun 2026 */
  plannedStart: number;
  plannedEnd: number;
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
  name: string;
  state: ItemState;
  photos: number;
  note: string;
}

export interface Checklist {
  id: string;
  title: string;
  zone: string;
  date: string;
  submitted: boolean;
  items: ChecklistItem[];
}

export interface ReviewItem {
  name: string;
  result: InspectionResult;
  swatch: SwatchKey;
  note: string;
  rejected: boolean;
}

export interface Review {
  id: string;
  title: string;
  zone: string;
  by: string;
  date: string;
  decided: boolean;
  items: ReviewItem[];
}

// ── Orgs, memberships & team (multi-tenant) ──────────────────────────────────
export interface MembershipSummary {
  projectId: string;
  name: string;
  short: string;
  role: Role;
  orgId: string | null;
  orgName: string | null;
}

export interface ProjectMember {
  userId: string;
  name: string;
  email: string | null;
  phone: string | null;
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
}

export interface Drawing {
  id: string;
  number: string;
  title: string;
  discipline: Discipline;
  zone: string | null;
  activityId: string | null;
  decisionId: string | null;
  current: DrawingRevision | null; // latest non-superseded
  ackedByMe: boolean; // has the current user acknowledged the current revision?
  revisions: DrawingRevision[]; // newest first
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

/** A reference to an uploaded photo. `url` is absolute (S3/R2) or a data URL (local demo). */
export interface MediaRef {
  id?: string;
  url: string;
  takenAt?: string;
}

export interface DailyLog {
  date: string;
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
