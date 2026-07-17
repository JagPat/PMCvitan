/**
 * The Vitan PMC application store.
 *
 * A faithful port of the prototype's single `DCLogic` class: one shared state
 * object plus actions that mirror its methods. Cross-slice flows (approve→lock,
 * material-mismatch→block, offline queue→flush) are expressed directly, exactly
 * as the prototype does. This store is the current "local gateway"; when the API
 * lands (Phase 7) these actions move behind the `DataGateway` and TanStack Query.
 *
 * Derived values (counts, filtered lists, timeline geometry) are NOT stored here
 * — they live in ./selectors and are recomputed from this state, so the
 * interconnected flows stay consistent by construction.
 */

import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import {
  SEED_ACTIVITIES,
  SEED_CHECKLIST,
  SEED_DAILY_LOG,
  SEED_DECISIONS,
  SEED_NOTIFICATIONS,
  SEED_REVIEW,
  SEED_DRAWINGS,
  SEED_PHASES,
  SEED_NODES,
  SEED_PHOTOS,
  SEED_MATERIALS,
  SEED_PLACED_INSPECTIONS,
  PROJECT,
  type AccessState,
  type AccessWho,
  type Activity,
  type AppNotification,
  type Checklist,
  type DailyLog,
  type Decision,
  type Drawing,
  type MembershipSummary,
  type OrgMember,
  type OrgRole,
  type OrgSummary,
  type Phase,
  type PortfolioProject,
  type ProjectMember,
  type ProjectCompany,
  type ProjectNode,
  type Photo,
  type Material,
  type SwatchKey,
  type PlacedInspection,
  type ItemState,
  type Lang,
  type ModalState,
  type Review,
  type Role,
  type ScreenKey,
  type Worker,
} from '@vitan/shared';
import { screensFor } from '@/lib/screens';
import { emptyProjectData, emptyModuleReadState, isCurrentProjectScope, type ProjectLoadState, type ProjectScope } from './projectScope';
import { subtreeIds, ancestorIds } from '@/lib/locationTree';
import type { ApiGateway, ApiSnapshot, OutboxOp, IssueDrawingInput, AddMemberInput, AddOrgMemberInput, NewProjectInput, CompanyInput, ArchivedProject, NewActivityInput, NewDecisionInput, OrgTemplateModule, OrgProjectTemplate, OverrideGateInput } from '@/data/apiGateway';
import { resolveMediaUrl, replayOutboxOp, isTerminalOutboxError, newIdempotencyKey, PROJECT_ID, API_BASE, decisionsReadMode, dailyLogReadMode, type ModuleDecisions, type ModuleDailyLog } from '@/data/apiGateway';
import { deleteEvidence, evidenceAvailable, listEvidence, putEvidence, retryEvidence } from '@/data/evidenceStore';
import { parseLocation } from '@/lib/screens';

/**
 * The project to open on a cold load: from the URL (`/projects/:id/…`) so a refresh or a
 * shared deep-link restores it, else the default. Only honoured in API mode — the local demo
 * has a single seeded project, so an arbitrary URL id would mislabel the seeded data.
 */
function initialProjectId(): string {
  if (!API_BASE) return PROJECT_ID;
  const fromUrl = typeof window !== 'undefined' ? parseLocation(window.location.pathname).projectId : null;
  return fromUrl ?? PROJECT_ID;
}

/**
 * The screen to open on a cold load: from the URL so a refresh or deep link restores where you
 * were, before the router effects run (otherwise the store→URL sync clobbers the deep link with
 * the default). Role-gating still happens in RouteBridge; falls back to the universal home.
 */
function initialScreen(): ScreenKey {
  const fromUrl = typeof window !== 'undefined' ? parseLocation(window.location.pathname).screen : null;
  return fromUrl ?? 'inbox';
}

/** Issue-decision payload from the UI: an option may carry a captured photo (base64),
 *  uploaded first so it becomes the created option's photoUrl. */
export interface IssueDecisionPayload extends Omit<NewDecisionInput, 'options'> {
  options: (NewDecisionInput['options'][number] & { photo?: { mime: string; data: string } })[];
}

/** A single unsubmitted local field edit: the value the engineer set and the
 *  monotonic revision at which they set it (gate round 6). */
export interface FieldMark<T> { rev: number; value: T; }
/** Unsubmitted per-field checklist edits, keyed by inspection-item id, scoped to
 *  ONE (inspection, scope-generation). `rev` is a monotonic counter shared across
 *  all fields so a later edit always outranks an earlier one. */
export interface ChecklistMarks {
  inspectionId: string | null; // the inspection these edits belong to (null = none)
  generation: number;          // the projectScopeGeneration they were made under
  rev: number;                 // monotonic edit counter
  byItem: Record<string, { state?: FieldMark<ItemState>; note?: FieldMark<string> }>;
}

/** The submission lifecycle of the checklist (gate round 8). Once the engineer
 *  dispatches a submit the payload is FROZEN — no further edits until the outcome:
 *  - `submitting`  an online submit is in flight (in-memory; a reload resolves it
 *                  from the server's next snapshot);
 *  - `queued`      an offline submit is queued (durable in the outbox, so the
 *                  freeze is rebuilt after a reload);
 *  - `idle`        nothing pending — editable, unless the SERVER already confirms
 *                  the checklist `submitted` (that is read-only on its own).
 *  Scoped to one (inspection, generation): a re-auth / project switch strands it. */
export type ChecklistSubmissionStatus = 'idle' | 'submitting' | 'queued';
export interface ChecklistSubmission {
  inspectionId: string | null;
  generation: number;
  status: ChecklistSubmissionStatus;
  // A unique, monotonic id for the ONLINE submit dispatch that owns this state
  // (gate round 10). The (project, generation) scope guard (round 9) cannot tell
  // two dispatches apart WITHIN one session — a delayed response from a superseded
  // submit shares the live generation. Each online dispatch stamps a fresh attempt
  // here; its continuation ignores itself once `attempt` no longer matches (a newer
  // submit, or a socket-delivered checklist swap that retired it). 0 = no in-flight
  // online attempt owns this state.
  attempt: number;
}

/** Gate round 11 — central snapshot ordering. A full project snapshot has SCOPE
 *  identity (project + generation) but, before this, no freshness/ownership
 *  ordering: any producer whose (project, generation) still matched could apply
 *  its snapshot last-response-wins — so a slow offline replay could overwrite a
 *  newer socket refresh or online submit. A `SnapshotLease` stamps every producer
 *  with a monotonic sequence captured when its request STARTS; only the newest
 *  eligible lease may apply. Applying returns one of these outcomes; a caller must
 *  consume the result and never announce success unless it is `applied`. */
export type SnapshotApplyResult = 'applied' | 'superseded' | 'scope-moved' | 'invalid-project';
export interface SnapshotLease {
  scope: ProjectScope;
  sequence: number;
}

export interface AppState {
  role: Role;
  screen: ScreenKey;
  lang: Lang;
  notifOpen: boolean;
  toast: string | null;
  modal: ModalState;
  decisions: Decision[];
  // Phase 2 Task 9 — when decisionsReadMode() === 'moduleQuery', `decisions` is owned by the
  // module-owned read (XOR), and these track its explicit load state for the decision surfaces:
  // 'idle' (snapshot-owned, the default mode), 'loading', 'ready', or 'error' (fetch failed — the
  // last-good decisions are kept and a Retry boundary is exposed). `decisionsSource` records whether
  // the projection or its live fallback served the current data.
  decisionsLoad: 'idle' | 'loading' | 'ready' | 'error';
  decisionsSource: 'projection' | 'live' | null;
  // Phase 2 Task 10 — the daily-log XOR read-ownership state, mirroring decisions. When
  // dailyLogReadMode() === 'moduleQuery', `dailyLog` + `materials` are owned by the module-owned read;
  // these track its explicit load state for the daily-log surfaces ('idle' in snapshot mode).
  dailyLogLoad: 'idle' | 'loading' | 'ready' | 'error';
  dailyLogSource: 'projection' | 'live' | null;
  // Phase 2 Task 9 — the enabled module ids from the project-shell summary (the single enablement
  // source). Drives manifest-driven nav: a screen whose module is disabled is hidden. Empty = not yet
  // loaded → the nav shows every role screen (no flash), matching today's behaviour.
  enabledModules: string[];
  nodes: ProjectNode[]; // the project location tree (zones → rooms → elements)
  checklist: Checklist | null; // null = no checklist issued for this project (never a ''-id sentinel)
  // Unsubmitted per-field checklist edits (gate round 6). The engineer's marks
  // live only in this client until they submit; any snapshot refresh — this
  // upload's own OR a concurrent useApiSync `changed` refresh — would otherwise
  // discard them. Each field records the value the engineer set AND a monotonic
  // revision, keyed by inspection-item id, so applySnapshot restores the LATEST
  // per-field intent (including an intentional clear — state→null / note→'') by
  // an explicit edit record, never by value comparison (which cannot tell an
  // intentional clear from a background wipe). Scoped to one (inspection,
  // generation); reset when the checklist changes, the scope moves, or on submit.
  checklistMarks: ChecklistMarks;
  // The checklist's submission lifecycle (gate round 8). While a submit is pending
  // (submitting / queued) — or the server already confirms `submitted` — the
  // checklist is FROZEN: no edit may change the payload. A failure unlocks it
  // without losing the marks; an offline-queued submit's freeze survives a reload
  // (rebuilt from the durable outbox by `reconcileSubmission`).
  submission: ChecklistSubmission;
  reviews: Review[]; // the PMC review queue (submitted, undecided inspections)
  activeReviewId: string | null; // which queued review the PMC is looking at (null ⇒ first pending)
  reinspectionCreated: boolean;
  drawings: Drawing[]; // the drawings register (Slice 1)
  photos: Photo[]; // site photos placed on the location tree (the Place view's reality layer)
  materials: Material[]; // all deliveries across the project, with their place (Site Map)
  placedInspections: PlacedInspection[]; // inspections on the tree for the Site Map (pmc/engineer only)
  phases: Phase[]; // project phases with rollups (Orgs Slice 3)
  // multi-project (Orgs Slice 2)
  activeProjectId: string; // the project the session is scoped to
  memberships: MembershipSummary[]; // projects the user can switch between
  myOrgs: OrgSummary[]; // orgs the user administers/belongs to
  orgMembers: OrgMember[]; // the active org's admin roster (owner/admin/member)
  orgModules: OrgTemplateModule[]; // the org's reusable structure modules (Templates Slice 2)
  orgTemplates: OrgProjectTemplate[]; // the org's named presets (Templates Slice 3)
  members: ProjectMember[]; // the active project's team (Team screen)
  portfolio: PortfolioProject[]; // cross-project monitoring rollup (Orgs Slice 3)
  online: boolean;
  syncQueue: string[];
  outbox: OutboxOp[];
  /** FAILED evidence (terminal non-dedupe rejection) awaiting the user's Retry/Delete (Task 4) */
  failedEvidence: { clientKey: string; reason: string; mime: string }[];
  /** evidence photos durably saved offline, awaiting upload (Task 4) */
  pendingEvidenceCount: number;
  access: AccessState;
  activities: Activity[];
  dailyLog: DailyLog | null; // null = no daily log started for this project
  notifications: AppNotification[];
  // real session (set by a phone-OTP sign-in; null = passwordless dev auth)
  sessionToken: string | null;
  userName: string | null;
  // live project identity — seeded from PROJECT, replaced wholesale by each snapshot
  // (so switching projects re-labels every screen; never read the PROJECT seed in a screen)
  name: string;
  short: string;
  descriptor: string;
  stage: string;
  siteCode: string;
  location: string;
  projStart: string;
  projEnd: string;
  /** Task 6: the schedule anchor (the civil day offset 0 refers to) + real window end */
  scheduleStartDate: string | null;
  scheduleEndDate: string | null;
  elapsedPct: number;
  todayDay: number;
  milestonePct: number;
  /** The project-scope lifecycle (Phase 0 Task 2). A switch empties project data
   *  in the same set() that marks it 'switching', so old records can never render
   *  or arrive under the next project's identity. */
  pendingProjectId: string | null; // the project a switch is negotiating for (null = none)
  projectScopeGeneration: number; // bumped on every scope change; stale responses are dropped
  projectLoadState: ProjectLoadState;
  projectLoadError: string | null; // user-readable, recoverable (set with loadState 'error')
  // firms & consultants on the active project (client company, contractor, MEP/structural, …)
  companies: ProjectCompany[];
  // archived projects (owner/admin restore UI, lazy-loaded)
  archivedProjects: ArchivedProject[];
}

export interface AppActions {
  // shell
  setRole: (role: Role) => void;
  signOut: () => void;
  setScreen: (k: ScreenKey) => void;
  setLang: (l: Lang) => void;
  toggleNotif: () => void;
  flash: (msg: string) => void;
  openQr: () => void;
  closeModal: () => void;
  // decisions
  openApprove: (decId: string, optIdx: number) => void;
  confirmApprove: () => void;
  openChange: (decId: string) => void;
  submitChange: () => void;
  /** Withdraw the open change request — the decision re-locks (requester or PMC only). */
  withdrawChange: (decId: string) => void;
  setChangeText: (v: string) => void;
  setChangeCost: (v: string) => void;
  setChangeTime: (v: string) => void;
  // inspection (engineer checklist)
  setItem: (idx: number, val: Exclude<ItemState, null>) => void;
  addPhoto: (idx: number) => void;
  /** Capture REAL evidence for a checklist item (Task 4): durably stored (IndexedDB)
   *  BEFORE any success message, uploaded now or on reconnect, exactly once. */
  addChecklistEvidence: (idx: number, dataUrl: string) => Promise<void>;
  /** The user's Retry on a failed evidence photo — re-queues with the SAME clientKey. */
  retryFailedEvidence: (clientKey: string) => Promise<void>;
  /** The user's explicit Delete of a failed evidence photo — the ONLY non-server path that drops bytes. */
  deleteFailedEvidence: (clientKey: string) => Promise<void>;
  /** Refresh the pending/failed evidence mirrors from IndexedDB (reload/scope change). */
  hydrateEvidence: () => Promise<void>;
  setNote: (idx: number, txt: string) => void;
  submitInspection: () => void;
  // inspection (pmc review)
  setActiveReview: (id: string) => void;
  toggleReject: (idx: number) => void;
  approveInspection: () => void;
  sendReinspection: () => void;
  // drawings register
  issueDrawing: (input: IssueDrawingInput) => void;
  /** Publish a private draft drawing → issue it to the build team (works offline in the demo). */
  publishDrawing: (drawingId: string) => void;
  acknowledgeDrawing: (drawingId: string) => void;
  // location spine: re-file a drawing / photo onto a location node (null = unfile)
  fileDrawing: (drawingId: string, nodeId: string | null) => void;
  filePhoto: (photoId: string, nodeId: string | null) => void;
  // multi-project + team
  loadOrgData: () => void;
  loadPortfolio: () => void;
  loadShell: () => void;
  /** Atomically re-scope to another project. Empties project data BEFORE the auth
   *  request; adopts the SERVER-returned project on success. Resolves true only when
   *  the switch was authenticated. `targetScreen` survives the switch when the new
   *  role is allowed to see it (deep links). */
  switchProject: (projectId: string, targetScreen?: ScreenKey) => Promise<boolean>;
  createProject: (orgId: string, input: NewProjectInput) => void;
  updateProjectDetails: (orgId: string, projectId: string, input: Partial<NewProjectInput>) => void;
  deleteProject: (orgId: string, projectId: string) => void;
  restoreProject: (orgId: string, projectId: string) => void;
  loadArchivedProjects: (orgId: string) => void;
  // companies & consultants
  addCompany: (input: CompanyInput) => void;
  updateCompany: (companyId: string, input: Partial<CompanyInput>) => void;
  removeCompany: (companyId: string) => void;
  // authoring: decisions + planning/scheduling (PMC)
  issueDecision: (input: IssueDecisionPayload) => void;
  /** Publish a private draft decision → issue it to the client (works offline in the demo). */
  publishDecision: (decisionId: string) => void;
  /** Publish EVERY draft (decisions + drawings) in one action — the Drafts workspace "Publish all". */
  publishAllDrafts: () => void;
  /** Create a zone/room/element and resolve to its new id (for the inline location picker).
   *  `publish: false` keeps it a private draft only its author sees until published. */
  addLocationNode: (input: { name: string; kind: 'zone' | 'room' | 'element'; parentId?: string | null; publish?: boolean }) => Promise<string | null>;
  renameNode: (nodeId: string, name: string) => void;
  /** Publish a private draft location (and its draft branch) — reveals it to everyone (works offline in the demo). */
  publishNode: (nodeId: string) => void;
  deleteNode: (nodeId: string) => void;
  createActivity: (input: NewActivityInput) => void;
  updateActivity: (activityId: string, input: Partial<NewActivityInput>) => void;
  /** Task 6: record / revoke a manual readiness exception (PMC, server-recorded) */
  overrideGate: (activityId: string, input: OverrideGateInput) => void;
  revokeOverride: (activityId: string, overrideId: string) => void;
  deleteActivity: (activityId: string) => void;
  createPhase: (name: string) => void;
  deletePhase: (phaseId: string) => void;
  issueChecklist: (input: { title: string; zone: string; items: string[]; nodeId?: string }) => void;
  startDailyLog: () => void;
  addSiteMaterial: (input: { name: string; qty: string; zone?: string; decisionId?: string; swatch?: string; nodeId?: string }) => void;
  loadTeam: () => Promise<void>;
  addMember: (input: AddMemberInput) => void;
  updateMemberRole: (userId: string, role: Role, discipline?: string) => void;
  removeMember: (userId: string) => void;
  // org roster (owner/admin/member)
  loadOrgMembers: (orgId: string) => void;
  /** Load the org's reusable structure modules — the template menu (Templates Slice 2). */
  loadOrgModules: (orgId: string) => void;
  /** Save a zone's subtree (rooms/objects + its checklists) as a reusable org module. */
  saveZoneAsModule: (zoneId: string, zoneName: string) => void;
  /** Load the org's named presets (Templates Slice 3). */
  loadOrgTemplates: (orgId: string) => void;
  /** Save the ACTIVE project's whole structure as a named preset ("G+2 Residence"). */
  saveProjectAsTemplate: (name: string) => void;
  addOrgMember: (orgId: string, input: AddOrgMemberInput) => void;
  updateOrgMemberRole: (orgId: string, userId: string, role: OrgRole) => void;
  correctInvitationEmail: (orgId: string, userId: string, email: string) => void;
  removeOrgMember: (orgId: string, userId: string) => void;
  // schedule
  startActivity: (id: string) => void;
  completeActivity: (id: string) => void;
  // daily log
  checkIn: () => void;
  checkOut: () => void;
  scanWorker: () => void;
  crewStep: (idx: number, delta: number) => void;
  addProgress: () => void;
  addProgressPhoto: (dataUrl: string, nodeId?: string | null) => void;
  submitDailyLog: () => void;
  flagMismatch: (idx: number) => void;
  record: (label: string) => void;
  toggleOnline: () => void;
  /** Replay the durable outbox in order. `okMsg` (write-ahead command path) announces the command's
   *  success on a clean flush instead of the batch "N synced" summary. */
  flushOutbox: (opts?: { okMsg?: string }) => void;
  hydrateOutbox: () => void;
  // team access
  accWho: (who: Exclude<AccessWho, null>) => void;
  accTrade: (t: string) => void;
  accSetPhone: (v: string) => void;
  accGoLogin: () => void;
  login: (email: string, password: string) => void;
  accSetEmail: (v: string) => void;
  accGoPasswordSetup: () => void;
  requestPasswordSetup: () => void;
  verifyPasswordSetup: () => void;
  completePasswordSetup: (password: string, confirmation: string) => void;
  accGoEmailOtp: () => void;
  requestEmailOtp: () => void;
  accSetCode: (v: string) => void;
  emailOtpVerify: () => void;
  googleSignIn: (idToken: string) => void;
  requestOtp: () => void;
  otpPress: (d: string) => void;
  otpVerify: () => void;
  pickWorker: (w: Worker) => void;
  accReset: () => void;
  speakJob: () => void;
  workerDone: () => void;
  // API bridge (Phase 7b) — injected by useApiSync when VITE_API_URL is set
  /** The scope a project-scoped request is issued FOR (Task 3): capture before
   *  awaiting, apply the response only while the scope is still current. */
  captureProjectScope: () => ProjectScope;
  /** Refetch the active project's snapshot after a load error (the boundary's Retry). */
  retryProjectLoad: () => void;
  _setGateway: (g: ApiGateway | null) => void;
  /** Apply a delivered snapshot as the newest snapshot intent for the current scope
   *  (gate round 11 — begins a fresh lease, then routes through the coordinator).
   *  Models a pushed/socket-delivered snapshot; returns true only when `applied`, so
   *  callers can't mark a stale/rejected response as ready. Prefer `requestFreshSnapshot`
   *  for a pull; the internal command paths use the coordinator's `acceptSnapshot`. */
  applySnapshot: (snap: ApiSnapshot, capturedScope?: ProjectScope) => boolean;
  /** Pull one coalesced fresh snapshot through the coordinator (socket refresh,
   *  initial load, retry, invalid-project recovery). At most one in flight per scope. */
  requestFreshSnapshot: () => void;
}

export type Store = AppState & AppActions;

let toastTimer: ReturnType<typeof setTimeout> | undefined;

/** A pristine access-flow state (used to init and to reset after sign-out). */
function freshAccess(generation = 0): AccessState {
  return {
    generation,
    step: 'who',
    who: null,
    trade: null,
    phone: '',
    email: '',
    otp: '',
    worker: null,
    sending: false,
    error: null,
    devCode: null,
    passwordRequestId: null,
    passwordSetupToken: null,
  };
}

/** A fresh copy of the seeded initial state (deep-cloned so resets never share references). */
/** Record an unsubmitted per-field checklist edit (gate round 6) so any later
 *  snapshot refresh restores the engineer's latest intent for that field —
 *  including an intentional clear. Resets the edit set when the checklist or the
 *  scope generation changed; no-ops for items without a server id (demo rows). */
function recordChecklistMark(
  s: AppState,
  inspectionId: string,
  itemId: string | undefined,
  field: 'state' | 'note',
  value: ItemState | string,
): void {
  if (!itemId) return;
  const m = s.checklistMarks;
  if (m.inspectionId !== inspectionId || m.generation !== s.projectScopeGeneration) {
    m.inspectionId = inspectionId;
    m.generation = s.projectScopeGeneration;
    m.byItem = {};
  }
  const entry = (m.byItem[itemId] ??= {});
  const rev = ++m.rev;
  if (field === 'state') entry.state = { rev, value: value as ItemState };
  else entry.note = { rev, value: value as string };
}

/** Is the current checklist FROZEN against edits (gate round 8)? True once the
 *  SERVER confirms it submitted (read-only), OR while a submit for THIS inspection
 *  is pending in the current scope (submitting / queued). Every checklist mutation
 *  (state, note, photo, evidence) consults this so nothing changes the payload once
 *  it has been dispatched. */
export function checklistFrozen(
  s: Pick<AppState, 'checklist' | 'submission' | 'projectScopeGeneration'>,
): boolean {
  const c = s.checklist;
  if (!c) return false;
  if (c.submitted) return true;
  const sub = s.submission;
  return (
    sub.inspectionId === c.id &&
    sub.generation === s.projectScopeGeneration &&
    (sub.status === 'submitting' || sub.status === 'queued')
  );
}

/** Derive the submission freeze from server truth + the durable outbox (gate round
 *  8) so a snapshot refresh or a reload never loses OR forges it. Called wherever
 *  the checklist or the outbox changes. A server-`submitted` checklist is read-only
 *  (status idles — the freeze comes from `submitted`); a still-unsubmitted checklist
 *  with a queued submit op stays FROZEN as `queued` (this rebuilds the freeze after a
 *  reload); an in-flight `submitting` freeze is preserved until its promise resolves;
 *  anything else (a different checklist, a re-auth/switch, a dropped submit) idles. */
function reconcileSubmission(s: AppState): void {
  const sub = s.submission;
  const c = s.checklist;
  const gen = s.projectScopeGeneration;
  // gate round 10: any branch that CHANGES ownership (a different checklist, a
  // server-confirmed submit, a reload of a queued submit, an idle reset) RETIRES
  // whatever online attempt held this state — reset `attempt` to 0 so that attempt's
  // in-flight continuation is ignored when it lands. The ONE branch that keeps an
  // in-flight online submit alive preserves its `attempt`.
  if (!c) {
    sub.inspectionId = null;
    sub.generation = gen;
    sub.status = 'idle';
    sub.attempt = 0;
    return;
  }
  if (c.submitted) {
    sub.inspectionId = c.id;
    sub.generation = gen;
    sub.status = 'idle';
    sub.attempt = 0;
    return;
  }
  const queued = s.outbox.some((op) => op.t === 'submitInspection' && op.inspectionId === c.id);
  if (queued) {
    sub.inspectionId = c.id;
    sub.generation = gen;
    sub.status = 'queued';
    sub.attempt = 0;
  } else if (sub.inspectionId === c.id && sub.generation === gen && sub.status === 'submitting') {
    // an online submit is still in flight for THIS inspection — keep the freeze AND
    // its owning attempt until that submit's own continuation resolves it
  } else {
    sub.inspectionId = c.id;
    sub.generation = gen;
    sub.status = 'idle';
    sub.attempt = 0;
  }
}

export function getInitialState(): AppState {
  return {
    // land on the admin (PMC) view by default — create/manage projects, teams,
    // portfolio. The persona switcher graduates to team/individual views.
    role: 'pmc',
    // 'inbox' ("For You") is every role's home — the live cross-cutting action queue.
    // Seeded from the URL on a cold load so a refresh / deep link restores the screen.
    screen: initialScreen(),
    lang: 'en',
    notifOpen: false,
    toast: null,
    modal: { type: null },
    decisions: structuredClone(SEED_DECISIONS),
    decisionsLoad: 'idle',
    decisionsSource: null,
    dailyLogLoad: 'idle',
    dailyLogSource: null,
    enabledModules: [],
    nodes: structuredClone(SEED_NODES), // the demo location tree (server snapshot replaces it)
    checklist: structuredClone(SEED_CHECKLIST),
    checklistMarks: { inspectionId: null, generation: 0, rev: 0, byItem: {} },
    submission: { inspectionId: null, generation: 0, status: 'idle', attempt: 0 },
    reviews: [structuredClone(SEED_REVIEW)],
    activeReviewId: null,
    reinspectionCreated: false,
    drawings: structuredClone(SEED_DRAWINGS),
    photos: structuredClone(SEED_PHOTOS), // placed site photos for the demo Site Map
    materials: structuredClone(SEED_MATERIALS), // placed deliveries for the demo Site Map
    placedInspections: structuredClone(SEED_PLACED_INSPECTIONS), // placed inspections for the demo Site Map
    phases: structuredClone(SEED_PHASES),
    activeProjectId: initialProjectId(),
    memberships: [],
    myOrgs: [],
    orgMembers: [],
    orgModules: [],
    orgTemplates: [],
    members: [],
    portfolio: [],
    online: true,
    syncQueue: [],
    outbox: [],
    failedEvidence: [],
    pendingEvidenceCount: 0,
    access: freshAccess(),
    activities: structuredClone(SEED_ACTIVITIES),
    dailyLog: structuredClone(SEED_DAILY_LOG),
    notifications: structuredClone(SEED_NOTIFICATIONS),
    sessionToken: null,
    userName: null,
    name: PROJECT.name,
    short: PROJECT.short,
    descriptor: PROJECT.descriptor,
    stage: PROJECT.stage,
    siteCode: PROJECT.siteCode,
    location: '',
    projStart: PROJECT.projStart,
    projEnd: PROJECT.projEnd,
    scheduleStartDate: PROJECT.scheduleStartDate,
    scheduleEndDate: PROJECT.scheduleEndDate,
    elapsedPct: PROJECT.elapsedPct,
    todayDay: PROJECT.todayDay,
    milestonePct: PROJECT.milestonePct,
    pendingProjectId: null,
    projectScopeGeneration: 0,
    projectLoadState: 'idle',
    projectLoadError: null,
    companies: [],
    archivedProjects: [],
  };
}

export const useStore = create<Store>()(
  immer((set, get) => {
    // API bridge (Phase 7b): injected by useApiSync when VITE_API_URL is set.
    // When present, mutating actions persist through the API and reconcile from
    // the returned snapshot; when null, they mutate the seeded local store.
    let gateway: ApiGateway | null = null;

    /** The scope a network request is issued FOR — pass to applySnapshot so a reply
     *  that lands after the scope changed (switch, sign-in) is dropped, not applied. */
    const currentScope = (): ProjectScope => ({
      projectId: get().activeProjectId,
      generation: get().projectScopeGeneration,
    });

    /** Is a scope captured at request time still the live one? Guards EVERY
     *  post-await project mutation — including raw-DTO paths that don't go
     *  through applySnapshot (companies, photo upload). Codex gate finding 3. */
    const scopeStillCurrent = (scope: ProjectScope): boolean =>
      isCurrentProjectScope(get().activeProjectId, get().projectScopeGeneration, scope);

    // ---- gate round 11/12/13: central snapshot-ordering coordinator ----
    // Ownership and refresh coalescing are keyed by FULL scope (project + generation),
    // not one store-global slot (gate round 12, finding 1). A monotonic sequence
    // (never timestamps) is global only as an id source; a lease is the newest snapshot
    // intent for ITS OWN scope. So a stale old-scope lease can never change another
    // scope's owner, and a new scope's pull runs independently of an old scope's
    // in-flight pull.
    //
    // Gate round 13/14: a superseded command/submit records a durable RECONCILIATION
    // OBLIGATION on its scope — preserved until CONFIRMED, not a fire-and-forget flag.
    // `createdAfterSequence` pins each obligation so a refresh that began BEFORE it can
    // neither satisfy nor clear it (a stale `submitted:false` snapshot can't disarm a
    // submit recovery). Gate round 14: command and submit obligations are held
    // SEPARATELY and COMPOSE — a later command can never overwrite an unconfirmed
    // submit (and vice-versa). A command clears when a post-threshold reconcile
    // APPLIES; a submit clears only when a post-threshold snapshot retires that exact
    // attempt. If the mandatory reconcile fails — or a submit reconcile applies
    // still-unconfirmed while its command sibling is satisfied — the recoverable
    // error/Retry boundary is exposed rather than a silent stuck state.
    interface SubmitObligation { inspectionId: string; attempt: number; createdAfterSequence: number; }
    interface ScopeCoordinator {
      newestLeaseSeq: number;
      refreshInFlight: boolean;
      refreshQueued: boolean;
      commandAfterSequence: number | null; // a committed generic command owed confirmed truth
      submit: SubmitObligation | null;      // a frozen submit owed confirmation
    }
    type ReconcileObligation =
      | { kind: 'command'; createdAfterSequence: number }
      | { kind: 'submit'; inspectionId: string; attempt: number; createdAfterSequence: number };
    let snapshotSeq = 0;
    // Serialize outbox flushes (finding 1 — write-ahead commands can fire a flush per command while one
    // is already in flight). At most one flush runs; a request made during a flush re-runs once after it
    // settles, so a command persisted mid-flush is still sent. Idempotency keys make an overlap harmless,
    // but serializing keeps ordering and avoids redundant sends.
    let outboxFlushing = false;
    let outboxFlushQueued = false;
    const scopeCoordinators = new Map<string, ScopeCoordinator>();
    const scopeKey = (scope: ProjectScope): string => `${scope.projectId}::${scope.generation}`;
    /** Drop coordinators for scopes we've LEFT that have no pull in flight — a scope
     *  we moved away from owns nothing anymore, so its pending obligations are
     *  cancelled with it (gate round 13, semantic 6); the current scope is always kept,
     *  and a coordinator with an in-flight pull self-prunes when that pull settles. */
    const pruneScopeCoordinators = (): void => {
      const liveKey = scopeKey(currentScope());
      for (const [key, c] of scopeCoordinators) {
        if (key !== liveKey && !c.refreshInFlight) scopeCoordinators.delete(key);
      }
    };
    const coordinatorFor = (scope: ProjectScope): ScopeCoordinator => {
      const key = scopeKey(scope);
      let c = scopeCoordinators.get(key);
      if (!c) {
        c = { newestLeaseSeq: 0, refreshInFlight: false, refreshQueued: false, commandAfterSequence: null, submit: null };
        scopeCoordinators.set(key, c);
        pruneScopeCoordinators(); // a new scope appeared — sweep the ones we've left
      }
      return c;
    };
    const beginSnapshotLease = (scope: ProjectScope): SnapshotLease => {
      const sequence = ++snapshotSeq;
      coordinatorFor(scope).newestLeaseSeq = sequence; // advance ONLY this scope's owner
      return { scope, sequence };
    };

    /** The pure state-copy for a snapshot. PRODUCTION CODE MUST NOT CALL THIS
     *  DIRECTLY — only `acceptSnapshot` may, after the ordering checks. A source-scan
     *  test (`snapshot-ordering.test.ts`) enforces the single call site so an
     *  unsequenced apply cannot be reintroduced. */
    const applySnapshotCore = (snap: ApiSnapshot, decisionsResult?: ModuleDecisions | null, dailyLogResult?: ModuleDailyLog | null): void => {
      set((s) => {
        s.projectLoadState = 'ready'; // the active project's data has landed
        s.projectLoadError = null;
        s.pendingProjectId = null;
        // Phase 2 Task 9 — XOR read-ownership for decisions. In 'snapshot' mode (default) the snapshot
        // slice OWNS `s.decisions` (unchanged). In 'moduleQuery' mode the module-owned read owns it and
        // the snapshot's slice is IGNORED: a `decisionsResult` (fetched under THIS same scope lease)
        // sets it (ready); a `null` result means the module fetch FAILED — keep the last-good decisions
        // and expose an error boundary; `undefined` means no fetch accompanied this apply (a command's
        // own snapshot response) — leave `s.decisions` untouched until the follow-up module refresh.
        if (decisionsReadMode() === 'snapshot') {
          s.decisions = snap.decisions;
        } else if (decisionsResult) {
          s.decisions = decisionsResult.decisions;
          s.decisionsLoad = 'ready';
          s.decisionsSource = decisionsResult.source;
        } else if (decisionsResult === null) {
          s.decisionsLoad = 'error';
        }
        s.activities = snap.activities;
        // The snapshot is the whole truth for its project. checklist/dailyLog are
        // assigned DIRECTLY, including null — absence means "this project has none",
        // never "keep the previous project's".
        s.checklist = snap.checklist ?? null;
        // gate round 6: overlay the engineer's UNSUBMITTED per-field edits back
        // onto the fresh server checklist. This is the ONE place marks survive a
        // refresh — the upload's own snapshot AND every background useApiSync
        // `changed` refresh flow through here, so preservation is uniform. Only
        // edits for THIS inspection made under the CURRENT scope generation apply
        // (a re-auth or project switch bumps the generation, stranding the old
        // session's edits — gate round-4 finding 3). Each field carries the value
        // the engineer set, so an intentional clear (state→null, note→'') is
        // restored as faithfully as a set — no value-guessing (gate round 6).
        const marks = s.checklistMarks;
        if (s.checklist && marks.inspectionId === s.checklist.id && marks.generation === s.projectScopeGeneration) {
          if (s.checklist.submitted) {
            // gate round 7: the SERVER confirms this inspection is submitted — the
            // marks are now server-owned. Drop the records and take server truth.
            // Until this ack lands (a pending or REJECTED submit leaves the server
            // checklist `submitted: false`), the records are retained and overlaid
            // below, so unconfirmed work survives a failed submit + a refresh.
            marks.inspectionId = null;
            marks.byItem = {};
          } else {
            for (const it of s.checklist.items) {
              if (!it.id) continue;
              const edit = marks.byItem[it.id];
              if (edit?.state) it.state = edit.state.value;
              if (edit?.note) it.note = edit.note.value;
            }
          }
        }
        // gate round 8: re-derive the submission freeze from this fresh server
        // truth + the durable outbox. A background `changed` refresh mid-submit
        // must keep the checklist frozen; a reload rebuilds a queued submit's
        // freeze; a server-confirmed submit idles the pending status.
        reconcileSubmission(s);
        s.reviews = snap.reviews ?? (snap.review ? [snap.review] : []);
        if (s.activeReviewId && !s.reviews.some((r) => r.id === s.activeReviewId)) s.activeReviewId = null;
        s.reinspectionCreated = snap.reinspectionCreated;
        s.drawings = snap.drawings ?? [];
        // Placed site photos come back as signed API-relative serve paths — resolve
        // them against the API base so the Place view's <img src> hits the API.
        s.photos = (snap.photos ?? []).map((p) => ({ ...p, url: resolveMediaUrl(p.url) }));
        // (s.materials + s.dailyLog are set together under the daily-log XOR below)
        // pmc/engineer get the placed inspections; other roles get [] from the server
        s.placedInspections = snap.placedInspections ?? [];
        s.phases = snap.phases ?? [];
        // Phase 2 Task 10 — XOR read-ownership for the daily-log slice (log core + crew + materials),
        // mirroring decisions. The media progress PHOTOS are ALWAYS composed from the snapshot (media,
        // not daily-log, owns them) — they come back as signed API-relative serve paths (/media/:id?t=…)
        // resolved against the API base — so both modes attach the identical `progressPhotos`; only the
        // log CORE + materials switch ownership. 'snapshot' mode (default): the snapshot slice owns them
        // (unchanged). 'moduleQuery' mode: a `dailyLogResult` (fetched under THIS same scope lease) owns
        // them (ready); `null` = the module fetch FAILED (keep last-good, expose an error boundary);
        // `undefined` = no fetch accompanied this apply (a command's own snapshot) — leave untouched.
        const progressPhotos = (snap.dailyLog?.photos ?? []).map((p) => ({ ...p, url: resolveMediaUrl(p.url) }));
        if (dailyLogReadMode() === 'snapshot') {
          s.dailyLog = snap.dailyLog ? { ...snap.dailyLog, photos: progressPhotos } : null;
          s.materials = snap.materials ?? [];
        } else if (dailyLogResult) {
          // The module read is the shared wire contract (DailyLogModuleResult, finding 5): its `swatch`
          // fields are open strings and its arrays readonly. Narrow them to the store's DTO (SwatchKey,
          // mutable) at this ONE boundary — the values are always valid swatch keys (a closed set).
          const core = dailyLogResult.dailyLog;
          s.dailyLog = core
            ? {
                date: core.date, logDate: core.logDate, checkedIn: core.checkedIn, checkinTime: core.checkinTime,
                submitted: core.submitted, progress: core.progress,
                crew: core.crew.map((c) => ({ trade: c.trade, count: c.count })),
                materials: core.materials.map((m) => ({ name: m.name, decisionId: m.decisionId, qty: m.qty, zone: m.zone, matched: m.matched, swatch: m.swatch as SwatchKey, photo: m.photo })),
                photos: progressPhotos,
              }
            : null;
          s.materials = dailyLogResult.materials.map((m) => ({ id: m.id, name: m.name, qty: m.qty, zone: m.zone, matched: m.matched, swatch: m.swatch as SwatchKey, decisionId: m.decisionId, nodeId: m.nodeId }));
          s.dailyLogLoad = 'ready';
          s.dailyLogSource = dailyLogResult.source;
        } else if (dailyLogResult === null) {
          s.dailyLogLoad = 'error';
        }
        s.notifications = snap.notifications;
        s.companies = snap.companies ?? [];
        s.name = snap.project.name;
        s.short = snap.project.short;
        s.descriptor = snap.project.descriptor;
        s.stage = snap.project.stage;
        s.siteCode = snap.project.siteCode;
        s.location = snap.project.location ?? '';
        s.projStart = snap.project.projStart;
        s.projEnd = snap.project.projEnd;
        s.scheduleStartDate = snap.project.scheduleStartDate ?? null;
        s.scheduleEndDate = snap.project.scheduleEndDate ?? null;
        s.elapsedPct = snap.project.elapsedPct;
        s.todayDay = snap.project.todayDay;
        s.milestonePct = snap.project.milestonePct;
        s.nodes = snap.nodes ?? [];
      });
    };

    /** The ONE ordered entry point for applying a snapshot. Checks, in order:
     *  (1) current-scope — a project switch / re-auth since the request started;
     *  (2) newest-sequence — a newer lease (socket refresh, mutation or submit) has
     *      taken ownership, so this response is stale even in the same scope;
     *  (3) snapshot-project — the payload is for a different project (wrong-project);
     *  then applies. The result MUST be consumed; success is announced only for
     *  `applied`. `superseded` / `scope-moved` are silent no-ops; `invalid-project`
     *  never reports success and the caller requests a fresh snapshot to recover. */
    const acceptSnapshot = (snap: ApiSnapshot, lease: SnapshotLease, decisionsResult?: ModuleDecisions | null, dailyLogResult?: ModuleDailyLog | null): SnapshotApplyResult => {
      const st = get();
      if (!isCurrentProjectScope(st.activeProjectId, st.projectScopeGeneration, lease.scope)) return 'scope-moved';
      // newest-owner is checked against THIS lease's own scope, so a stale lease in a
      // scope we've left can never mark a live scope's response superseded (round 12).
      if (lease.sequence !== coordinatorFor(lease.scope).newestLeaseSeq) return 'superseded';
      if (snap.project.id !== lease.scope.projectId) return 'invalid-project';
      // Task 9/10 — the module decisions + daily-log reads (if any) rode the SAME lease as the snapshot,
      // so they pass the identical scope/newest-owner ordering checks: a stale module response is dropped
      // with its snapshot, never applied over a newer scope's data.
      applySnapshotCore(snap, decisionsResult, dailyLogResult);
      return 'applied';
    };

    const RECOVERABLE_LOAD_ERROR = 'Could not load this project — check your connection and access, then retry.';
    /** Coalesced fresh-snapshot pull for ONE scope — the ONE way to fetch current
     *  truth (socket refresh, initial load, retry, invalid-project recovery, and the
     *  reconcile a superseded command/submit schedules). At most one is in flight PER
     *  SCOPE (round 12); a request made while its scope's pull runs schedules exactly
     *  one more after it settles — even when that pull FAILED, so a superseded command
     *  still gets a recovery attempt. A pull only ever mutates its OWN scope; a scope
     *  we've left neither reruns nor surfaces errors. Never a loop: the rerun fires at
     *  most once per settle and only while nothing new re-queues it. */
    /** Is the pending submit named by an obligation STILL in flight (not yet confirmed
     *  by server truth)? Confirmed = its freeze has retired — a different inspection,
     *  a newer attempt, or an idle/read-only submission all count as "no longer owed". */
    const submitStillPending = (ob: SubmitObligation): boolean => {
      const sub = get().submission;
      return sub.status === 'submitting' && sub.inspectionId === ob.inspectionId && sub.attempt === ob.attempt;
    };
    const requestFreshSnapshot = async (scope: ProjectScope = currentScope()): Promise<void> => {
      if (!gateway) return;
      const c = coordinatorFor(scope);
      if (c.refreshInFlight) { c.refreshQueued = true; return; }
      c.refreshInFlight = true;
      const g = gateway;
      const lease = beginSnapshotLease(scope);
      // initial load / retry surfaces 'loading'; a background refresh (already
      // 'ready') stays ready — stale-while-revalidate, no flash on every socket ping.
      if (scopeStillCurrent(scope) && get().projectLoadState !== 'ready') set((s) => { s.projectLoadState = 'loading'; });
      // Task 9 — in 'moduleQuery' mode surface the decisions module's own loading state for its
      // surfaces (guarded by scope, like the project load state), while snapshot mode leaves it idle.
      if (decisionsReadMode() === 'moduleQuery' && scopeStillCurrent(scope) && get().decisionsLoad !== 'ready') {
        set((s) => { s.decisionsLoad = 'loading'; });
      }
      // Task 10 — same for the daily-log module read.
      if (dailyLogReadMode() === 'moduleQuery' && scopeStillCurrent(scope) && get().dailyLogLoad !== 'ready') {
        set((s) => { s.dailyLogLoad = 'loading'; });
      }
      try {
        // Task 9/10 — in 'moduleQuery' mode fetch the module-owned decisions and/or daily-log ALONGSIDE
        // the snapshot, under the SAME lease. Each module fetch is resilient: a failure yields `null` (an
        // explicit error state that keeps the last-good data) rather than failing the whole pull, so the
        // rest of the project still loads. In 'snapshot' mode no extra fetch happens (undefined → unchanged).
        const [snap, decisionsResult, dailyLogResult] = await Promise.all([
          g.snapshot(),
          decisionsReadMode() === 'moduleQuery'
            ? g.decisions().then((d): ModuleDecisions | null => d).catch((): ModuleDecisions | null => null)
            : Promise.resolve(undefined as ModuleDecisions | undefined),
          dailyLogReadMode() === 'moduleQuery'
            ? g.dailyLog().then((d): ModuleDailyLog | null => d).catch((): ModuleDailyLog | null => null)
            : Promise.resolve(undefined as ModuleDailyLog | undefined),
        ]);
        // Round 2 finding 2: a command reconcile is CONFIRMED only when the snapshot applied AND every
        // REQUIRED module-owned read (Task 9 decisions / Task 10 daily-log, when in 'moduleQuery' mode)
        // actually succeeded. A module read that failed came back `null` — its committed change is NOT
        // reflected in `s.decisions` / `s.dailyLog`, so clearing the obligation here would strand the
        // user on stale data with no recovery. In 'snapshot' mode the result is `undefined` (not
        // required). `!= null` is true only for a real, non-failed module payload.
        const moduleReadsOk =
          (decisionsReadMode() !== 'moduleQuery' || decisionsResult != null) &&
          (dailyLogReadMode() !== 'moduleQuery' || dailyLogResult != null);
        const result = acceptSnapshot(snap, lease, decisionsResult, dailyLogResult);
        if (result === 'applied') {
          // COMMAND and SUBMIT obligations clear INDEPENDENTLY (gate round 14). Only a
          // pull that BEGAN AFTER an obligation's threshold can satisfy it (round 13,
          // semantic 2) — a stale in-flight refresh can't disarm it.
          if (c.commandAfterSequence !== null && lease.sequence > c.commandAfterSequence && moduleReadsOk) {
            c.commandAfterSequence = null; // the committed command's change is now in this applied snapshot AND its module reads
          }
          // If the snapshot applied but a required module read FAILED, the obligation is RETAINED (not
          // cleared): the module read's own error state (dailyLogLoad/decisionsLoad='error', last-good
          // kept) exposes a Retry that re-runs this pull. Bounded — no auto-loop re-queues it, and the
          // project itself is fresh, so no project-level error boundary is raised.
          if (c.submit && lease.sequence > c.submit.createdAfterSequence) {
            if (!submitStillPending(c.submit)) {
              c.submit = null; // the EXACT submit is confirmed; its freeze has retired
            } else if (scopeStillCurrent(scope)) {
              // applied, but the submit is STILL unconfirmed — keep the submit obligation +
              // freeze/marks and expose Retry EVEN THOUGH the same snapshot may have
              // satisfied the command obligation (gate round 14: obligations compose).
              set((s) => { s.projectLoadState = 'error'; s.projectLoadError = RECOVERABLE_LOAD_ERROR; });
            }
          }
        } else if (result === 'invalid-project' && scopeStillCurrent(scope)) {
          set((s) => { s.projectLoadState = 'error'; s.projectLoadError = RECOVERABLE_LOAD_ERROR; });
        }
        // superseded / scope-moved: a newer owner or the queued rerun supplies truth.
      } catch {
        // The pull failed. Surface the recoverable error/Retry boundary when the user is
        // waiting on THIS scope's data — an initial load / switch, or the MANDATORY
        // reconcile for ANY outstanding obligation (a pull that began after its threshold).
        // A pre-obligation refresh failing does NOT surface it — its own reconcile follows.
        if (scopeStillCurrent(scope)) set((s) => {
          const failedMandatory =
            (c.commandAfterSequence !== null && lease.sequence > c.commandAfterSequence) ||
            (c.submit !== null && lease.sequence > c.submit.createdAfterSequence);
          if (s.projectLoadState === 'switching' || s.projectLoadState === 'loading' || failedMandatory) {
            s.projectLoadState = 'error';
            s.projectLoadError = RECOVERABLE_LOAD_ERROR;
          }
        });
      } finally {
        c.refreshInFlight = false;
        // Rerun once if something queued a follow-up (a coalesced refresh OR a superseded
        // command/submit's reconcile) AND this scope is still current — this fires even
        // after a FAILED pull, so the mandatory reconcile always follows the settling
        // refresh. Bounded (semantic 7): the rerun fires at most once per settle; after a
        // failed / unconfirmed mandatory reconcile nothing re-queues, so we wait for Retry.
        const rerun = c.refreshQueued && scopeStillCurrent(scope);
        c.refreshQueued = false;
        if (rerun) void requestFreshSnapshot(scope);
        else pruneScopeCoordinators();
      }
    };

    /** MERGE a reconciliation obligation onto a CURRENT-scope command/submit whose own
     *  snapshot was `superseded`, then queue/start the recovery pull (gate round 13/14).
     *  `superseded` proves a newer lease exists, NOT that it will land — the newer
     *  refresh may fail. Command and submit obligations are held SEPARATELY and NEVER
     *  overwrite each other (gate round 14). Each is pinned with `createdAfterSequence`
     *  so a refresh already in flight can't satisfy it. A moved scope owns its own truth,
     *  so a stale-scope reconcile is dropped. */
    const scheduleReconcile = (scope: ProjectScope, obligation: ReconcileObligation): void => {
      if (!scopeStillCurrent(scope)) return;
      const c = coordinatorFor(scope);
      if (obligation.kind === 'command') {
        // keep the LATEST command threshold: a snapshot crossing it necessarily reflects
        // every earlier committed command too, so no command obligation is ever dropped.
        c.commandAfterSequence = c.commandAfterSequence === null
          ? obligation.createdAfterSequence
          : Math.max(c.commandAfterSequence, obligation.createdAfterSequence);
      } else {
        // the newest submit attempt owns the freeze (round 10 retired any older one)
        c.submit = { inspectionId: obligation.inspectionId, attempt: obligation.attempt, createdAfterSequence: obligation.createdAfterSequence };
      }
      if (c.refreshInFlight) c.refreshQueued = true; // runs after the in-flight pull settles (even on failure)
      else void requestFreshSnapshot(scope);
    };

    /** Is ANY read surface module-owned right now (Task 9 decisions / Task 10 daily-log
     *  in 'moduleQuery' mode)? Under module ownership a command's OWN snapshot response
     *  deliberately does NOT carry the module slice (applySnapshotCore leaves it
     *  untouched to preserve the XOR), so a committed command needs a follow-up module
     *  refresh to become visible — see the reconcile in `consumeSnapshotResult`. */
    const anyModuleOwnedRead = (): boolean =>
      decisionsReadMode() === 'moduleQuery' || dailyLogReadMode() === 'moduleQuery';

    /** Consume an `acceptSnapshot` result on a COMMAND path (a user-initiated
     *  mutation: approve, publish, issue, evidence upload…). The command's success
     *  is independent of the snapshot ORDERING race: the mutation committed on the
     *  server the moment its call resolved. So announce success whenever the reply
     *  landed in the CAPTURED scope — `applied` (this snapshot is freshest) OR
     *  `superseded` (a newer same-scope refresh, almost always the mutation's OWN
     *  `changed` broadcast, already carries the committed truth).
     *
     *  A committed command must then be reflected in the reads the user actually sees:
     *   • `superseded` NEVER ran applySnapshotCore — the store is stale in EVERY mode —
     *     so a reconcile is always required (round 13): the newer refresh may fail, and
     *     the committed change must land or a Retry be exposed — never silently absent.
     *   • `applied` ran applySnapshotCore, which refreshes the snapshot-owned reads. But
     *     under MODULE ownership (Task 9/10 correction, finding 2) the command's own
     *     snapshot carries no module slice, so applySnapshotCore left `decisions` /
     *     `dailyLog` untouched — the module read is now stale. Schedule the same
     *     scope-guarded reconcile so `requestFreshSnapshot` refetches the module-owned
     *     read under the SAME captured scope; finding-1's servability gate falls a
     *     lagging/blocked projection back to canonical, so the committed change is never
     *     hidden. In pure 'snapshot' mode an `applied` command already carried its slice,
     *     so no extra reconcile is scheduled.
     *
     *  The reconcile is pinned to the command's CAPTURED scope, and `scheduleReconcile`
     *  drops it if that scope has since MOVED — a stale continuation never mutates data,
     *  load state or toast in the new scope. Suppress the toast only when the scope moved
     *  (a switch / re-auth) or the payload was `invalid-project` (never claim success;
     *  recover under the captured scope). */
    const consumeSnapshotResult = (result: SnapshotApplyResult, okMsg?: string, scope: ProjectScope = currentScope()): void => {
      if (result === 'applied' || result === 'superseded') {
        if (okMsg) get().flash(okMsg);
        if (result === 'superseded' || anyModuleOwnedRead()) {
          scheduleReconcile(scope, { kind: 'command', createdAfterSequence: snapshotSeq });
        }
      } else if (result === 'invalid-project') {
        void requestFreshSnapshot(scope);
      }
    };

    const runRemote = (call: () => Promise<ApiSnapshot>, okMsg: string): void => {
      const lease = beginSnapshotLease(currentScope()); // capture BEFORE the request
      call()
        .then((snap) => consumeSnapshotResult(acceptSnapshot(snap, lease), okMsg, lease.scope))
        .catch(() => { if (scopeStillCurrent(lease.scope)) get().flash('Could not reach the server — please try again.'); });
    };

    // WEB-02: queued offline writes are scoped to WHO queued them and WHERE — the
    // storage key carries the signed-in user (JWT sub) + the active project, so work
    // queued in one project (or by one user on a shared device) is never replayed
    // into another. `hydrateOutbox` swaps the in-memory queue whenever that scope
    // changes (useApiSync re-runs it on every token / project change).
    const LEGACY_OUTBOX_KEY = 'vitan.outbox';
    const outboxKey = (): string => {
      let sub = 'anon';
      const token = get().sessionToken;
      if (token) {
        try {
          sub = (JSON.parse(atob(token.split('.')[1])) as { sub?: string }).sub ?? 'anon';
        } catch {
          /* malformed token — treat as the anonymous scope */
        }
      }
      return `vitan.outbox.${sub}.${get().activeProjectId}`;
    };
    const persistOutbox = (): void => {
      try {
        globalThis.localStorage?.setItem(outboxKey(), JSON.stringify(get().outbox));
      } catch {
        /* storage unavailable — the in-session outbox still works */
      }
    };

    // Evidence bytes share the outbox's user scope (WEB-02): the IndexedDB entries are
    // keyed (sub, projectId, clientKey), so a user/project switch neither loses nor leaks.
    const evidenceScope = (): string => {
      let sub = 'anon';
      const token = get().sessionToken;
      if (token) {
        try {
          sub = (JSON.parse(atob(token.split('.')[1])) as { sub?: string }).sub ?? 'anon';
        } catch { /* anonymous scope */ }
      }
      return sub;
    };
    /** Reconcile the store with the durable evidence rows: refresh the UI mirrors
     *  (pending count, the FAILED Retry/Delete surface) AND — gate finding 2 —
     *  treat IndexedDB as the CANONICAL evidence queue: every PENDING row must
     *  have a replay op. An op lost to a failed localStorage persistence (quota,
     *  private mode, wiped storage) is reconstructed here, idempotently per
     *  clientKey — the server dedupes on (projectId, clientKey), so even a
     *  duplicate replay is harmless.
     *
     *  Gate round-2 finding 2: a reconciliation is a READ followed by a write —
     *  the read can go stale while it is in flight (a project switch, a flush
     *  that confirmed uploads, a dead-letter). EVERYTHING the write depends on
     *  is captured BEFORE the await and re-validated after it, and an epoch
     *  makes reconciliations single-winner: any flush / retry / delete / newer
     *  reconciliation invalidates the ones already in flight, so only the
     *  NEWEST truth may mutate the store. */
    let evidenceEpoch = 0;
    const invalidateEvidenceReconciles = (): number => ++evidenceEpoch;
    // gate round 10: a monotonic id stamped on every ONLINE submit dispatch, so a
    // continuation can tell whether it still owns the submission (see submitInspection).
    let submitAttemptSeq = 0;
    const reconcileEvidence = async (): Promise<void> => {
      const epoch = invalidateEvidenceReconciles(); // this reconciliation supersedes older ones
      const scope = evidenceScope();
      const projectId = get().activeProjectId;
      const projScope = currentScope();
      const storageKey = outboxKey();
      try {
        const entries = await listEvidence(scope, projectId);
        // REJECT a stale result: every captured coordinate must still be live
        if (epoch !== evidenceEpoch) return; // a newer reconciliation / flush / retry / delete owns the truth now
        if (!scopeStillCurrent(projScope)) return; // the project switched mid-read
        if (evidenceScope() !== scope || get().activeProjectId !== projectId || outboxKey() !== storageKey) return;

        const failed = entries.filter((e) => e.status === 'failed').map((e) => ({ clientKey: e.clientKey, reason: e.failReason ?? 'upload rejected', mime: e.mime }));
        const pending = entries.filter((e) => e.status === 'pending'); // only pending rows earn a replay op
        let reconstructed = false;
        set((s) => {
          s.failedEvidence = failed;
          s.pendingEvidenceCount = pending.length;
          const queued = new Set(s.outbox.filter((o) => o.t === 'uploadEvidence').map((o) => o.clientKey));
          for (const e of pending) {
            if (queued.has(e.clientKey)) continue;
            s.outbox.push({ t: 'uploadEvidence', scope, clientKey: e.clientKey });
            reconstructed = true;
          }
        });
        if (reconstructed) persistOutbox();
      } catch {
        /* evidence store unavailable — the mirrors stay empty */
      }
    };
    /** Gate round-3: an evidence COMMAND (offline capture / Retry / Delete)
     *  crosses an IndexedDB await too. Its durable operation must run under the
     *  coordinates captured BEFORE the await, and every post-await store /
     *  toast / persistence mutation must be refused unless that context is
     *  still current — otherwise a project or session switch landing mid-await
     *  writes the OLD scope's operation into the NEW scope's outbox, pending
     *  count and storage key. When the context has moved, the durable row is
     *  left alone: its own scope's reconciliation reconstructs it. */
    const captureEvidenceContext = () => ({
      scope: evidenceScope(),
      projectId: get().activeProjectId,
      projScope: currentScope(),
      storageKey: outboxKey(),
    });
    const evidenceContextStillCurrent = (ctx: ReturnType<typeof captureEvidenceContext>): boolean =>
      scopeStillCurrent(ctx.projScope)
      && evidenceScope() === ctx.scope
      && get().activeProjectId === ctx.projectId
      && outboxKey() === ctx.storageKey;

    /**
     * Route a mutation through the gateway when online, or queue it (Phase 8
     * offline outbox) when offline. Returns true when the action was handled
     * here (remote or queued); false means "no gateway — do the local mutation".
     */
    const runRemoteOrQueue = (
      op: OutboxOp,
      label: string,
      call: () => Promise<ApiSnapshot>,
      okMsg: string,
    ): boolean => {
      if (!gateway) return false;
      if (get().online) {
        runRemote(call, okMsg);
        return true;
      }
      set((s) => {
        s.outbox.push(op);
        s.syncQueue.push(label);
      });
      persistOutbox();
      get().flash(label + ' — saved offline, will sync when you reconnect.');
      return true;
    };

    /**
     * WRITE-AHEAD command path (Task 10 correction round 2, finding 1). Unlike `runRemoteOrQueue`
     * (which only persists when OFFLINE and fires a bare network call when online), this ALWAYS
     * persists the op — with its stable idempotency key — to the durable outbox BEFORE any network
     * request, online or offline. Then:
     *   • online  → flush immediately; `flushOutbox` reuses the persisted op's key, removes it only on
     *     confirmed success/replay, KEEPS it (and its key) on a transient failure (network / timeout /
     *     5xx) so a retry or a reload replays the SAME op, and drops it on a terminal 4xx — all
     *     scope-guarded. The command's success toast fires via the reconcile's `okMsg`.
     *   • offline → the op waits in the outbox and syncs on reconnect.
     * So a lost/uncertain online response never strands a command without its key: the ledger applies
     * it exactly once however many times it is retried. Returns true when handled (gateway present).
     */
    const runWriteAhead = (op: OutboxOp, label: string, okMsg: string): boolean => {
      if (!gateway) return false;
      set((s) => { s.outbox.push(op); if (!s.online) s.syncQueue.push(label); });
      persistOutbox();
      if (get().online) {
        get().flushOutbox({ okMsg });
      } else {
        get().flash(label + ' — saved offline, will sync when you reconnect.');
      }
      return true;
    };

    /** Adopt a server auth result as the real session — the ONE adoption path for
     *  every API sign-in (password, email-OTP, Google, phone-OTP) AND the project
     *  switch. The token is scoped to exactly the project the SERVER returns
     *  (never the caller's requested/URL project): leaving `activeProjectId`
     *  elsewhere would send this token to another project's routes and 403 every
     *  call, stranding stale data on screen under the wrong identity. */
    const applyAuthResult = (
      res: { role: Role; token: string; name?: string; projectId?: string },
      opts?: { msg?: string; targetScreen?: ScreenKey },
    ): void => {
      set((s) => {
        const changedProject = !!res.projectId && res.projectId !== s.activeProjectId;
        const wasPending = s.pendingProjectId !== null;
        s.role = res.role;
        const allowed = screensFor(res.role).map((m) => m.key);
        // a role-allowed target screen survives the transition (deep links); anything
        // else lands on the role's home
        s.screen = opts?.targetScreen && allowed.includes(opts.targetScreen) ? opts.targetScreen : allowed[0];
        s.sessionToken = res.token;
        s.userName = res.name ?? null;
        s.access = freshAccess(s.access.generation + 1);
        // EVERY auth result is a new session identity, so it always starts a new
        // scope generation — a reply issued FOR the previous identity (even on the
        // SAME project: a different user/role sees different records) can never
        // satisfy the current scope guard. Codex gate finding 6.
        s.projectScopeGeneration += 1;
        if (res.projectId && changedProject) {
          s.activeProjectId = res.projectId; // the SERVER-returned scope, verbatim
          // If a switch already emptied the data for THIS project, don't clear twice.
          // Otherwise (sign-in adoption, or the server re-scoped us elsewhere):
          // empty data + blank identity until the snapshot lands.
          if (s.pendingProjectId !== res.projectId) {
            s.name = '';
            s.short = '';
            s.descriptor = '';
            s.stage = '';
            s.siteCode = '';
            Object.assign(s, emptyProjectData());
            Object.assign(s, emptyModuleReadState()); // finding 4: a new project's reads start fresh, not stale-'ready'
          }
        } else if (!wasPending) {
          // same-project re-authentication: the previous identity's records are not
          // this identity's truth — clear and let the post-auth refresh refetch them
          Object.assign(s, emptyProjectData());
          Object.assign(s, emptyModuleReadState()); // finding 4: the new identity's module reads are not yet loaded
        }
        // in every branch the project data is now empty — awaiting this identity's snapshot
        s.projectLoadState = 'loading';
        s.projectLoadError = null;
        s.pendingProjectId = null;
      });
      get().flash(opts?.msg ?? 'Signed in as ' + (res.name ?? res.role) + '.');
    };

    /** Local-demo passwordless sign-in: map an email to a role (else engineer). */
    const localEmailSignIn = (em: string): void => {
      const role: Role = em.startsWith('pmc@') ? 'pmc' : em.startsWith('client@') ? 'client' : em.startsWith('contractor@') ? 'contractor' : 'engineer';
      set((s) => {
        s.role = role;
        s.screen = screensFor(role)[0].key;
        s.access = freshAccess(s.access.generation + 1);
      });
      get().flash('Signed in as ' + role + ' (demo).');
    };

    /** Index in `reviews` of the review the PMC is acting on: the explicitly
     *  selected one, else the first pending, else the first. -1 when the queue is empty. */
    const activeReviewIdx = (): number => {
      const st = get();
      if (!st.reviews.length) return -1;
      const byId = st.activeReviewId ? st.reviews.findIndex((r) => r.id === st.activeReviewId) : -1;
      if (byId >= 0) return byId;
      const pending = st.reviews.findIndex((r) => !r.decided);
      return pending >= 0 ? pending : 0;
    };

    return {
    ...getInitialState(),
    captureProjectScope: currentScope,
    retryProjectLoad: () => {
      if (!gateway) return;
      set((s) => { s.projectLoadError = null; });
      // gate round 11: the boundary's Retry is a coalesced fresh pull through the
      // coordinator — it surfaces loading, applies only if it's still the newest,
      // and re-exposes the recoverable error on failure / wrong-project.
      void requestFreshSnapshot();
    },
    _setGateway: (g) => {
      gateway = g;
    },
    // gate round 11: the PUBLIC apply is a coordinator entry — it begins a FRESH
    // lease (a delivered snapshot is the newest intent) and routes through
    // acceptSnapshot, returning true only for `applied`. Internal command paths do
    // NOT use this; they capture their lease before their request and call the
    // coordinator's acceptSnapshot directly.
    applySnapshot: (snap, capturedScope) =>
      acceptSnapshot(snap, beginSnapshotLease(capturedScope ?? currentScope())) === 'applied',
    requestFreshSnapshot: () => { void requestFreshSnapshot(); },

    // ---- shell ----
    setRole: (role) => {
      const first = screensFor(role)[0].key;
      set((s) => {
        s.role = role;
        s.screen = first;
        s.notifOpen = false;
        s.modal = { type: null };
        // an explicit persona switch is dev auth — drop any real OTP session
        s.sessionToken = null;
        s.userName = null;
      });
    },
    /**
     * End the real session and return to the sign-in screen. Clears the token,
     * resets the access flow to 'who', and drops back to a neutral role/screen.
     * With dev auth off, the AppShell auth-gate then shows the sign-in screen.
     */
    signOut: () =>
      set((s) => {
        s.sessionToken = null;
        s.userName = null;
        s.access = freshAccess(s.access.generation + 1);
        s.role = 'client';
        s.screen = screensFor('client')[0].key;
        s.notifOpen = false;
        s.modal = { type: null };
        // WEB-02: quarantine this user's queued work — it stays persisted under THEIR
        // scope key and resumes on their next sign-in; the next user never replays it.
        s.outbox = [];
        s.syncQueue = [];
        // Ending the session ends the scope (Codex gate finding 6): the signed-out
        // user's records leave memory, and the generation bump refuses any of their
        // replies still in flight — nothing survives for the next identity to see.
        s.projectScopeGeneration += 1;
        Object.assign(s, emptyProjectData());
        Object.assign(s, emptyModuleReadState()); // finding 4: sign-out tears down the module read state too
        s.projectLoadState = 'idle';
        s.projectLoadError = null;
        s.pendingProjectId = null;
      }),
    setScreen: (k) =>
      set((s) => {
        s.screen = k;
        s.notifOpen = false;
      }),
    setLang: (l) => set((s) => { s.lang = l; }),
    toggleNotif: () => set((s) => { s.notifOpen = !s.notifOpen; }),
    flash: (msg) => {
      set((s) => { s.toast = msg; });
      if (toastTimer) clearTimeout(toastTimer);
      toastTimer = setTimeout(() => set((s) => { s.toast = null; }), 3200);
    },
    openQr: () => set((s) => { s.modal = { type: 'qr' }; }),
    closeModal: () => set((s) => { s.modal = { type: null }; }),

    // ---- decisions ----
    openApprove: (decId, optIdx) => {
      const d = get().decisions.find((x) => x.id === decId);
      if (!d) return;
      const o = d.options[optIdx];
      set((s) => {
        s.modal = {
          type: 'approve',
          decId,
          optIdx,
          title: d.title,
          optionLabel: o.label,
          material: o.material,
          delta: o.delta,
          swatch: o.swatch,
        };
      });
    },
    confirmApprove: () => {
      const { decId, optIdx } = get().modal;
      if (decId == null || optIdx == null) return;
      set((s) => { s.modal = { type: null }; });
      // one stable idempotency key for this approval — the online send and any offline replay
      // reach the server under it, so a lost-response retry re-locks once (Phase 2 Task 5).
      const approveKey = newIdempotencyKey();
      if (runRemoteOrQueue({ t: 'approve', decisionId: decId, optionIndex: optIdx, idempotencyKey: approveKey }, 'Approve ' + decId, () => gateway!.approveDecision(decId, optIdx, approveKey), 'Approved & locked — saved to the server.')) return;
      const src = get().decisions.find((x) => x.id === decId);
      const material = src ? src.options[optIdx].material : '';
      const title = src ? src.title : '';
      set((s) => {
        const d = s.decisions.find((x) => x.id === decId);
        if (d) {
          const o = d.options[optIdx];
          d.status = 'approved';
          d.approvedOption = o.label;
          d.material = o.material;
          d.cost = o.delta;
          d.approver = 'Mr. Shah';
          d.date = '03 Jul 2026';
          d.photoSwatch = o.swatch;
          delete d.changeRequest; // a re-approval RESOLVES the open change request
        }
        s.notifications.unshift({ text: 'Client approved ' + title + ' — ' + material, time: 'just now', color: '#3F7A54' });
        s.modal = { type: null };
      });
      get().flash('Approved & locked — the Decision Log and PMC dashboard are updated.');
    },
    openChange: (decId) => {
      const d = get().decisions.find((x) => x.id === decId);
      if (!d) return;
      set((s) => {
        s.modal = { type: 'change', decId, title: d.title, changeText: '', changeCost: '', changeTime: '' };
      });
    },
    submitChange: () => {
      const { decId, changeText, changeCost, changeTime } = get().modal;
      if (decId == null) return;
      const reason = changeText?.trim() || 'Change requested';
      const costImpact = parseInt(String(changeCost ?? '').replace(/[^\d-]/g, ''), 10) || 0;
      const timeImpactDays = parseInt(String(changeTime ?? '').replace(/[^\d-]/g, ''), 10) || 0;
      set((s) => { s.modal = { type: null }; });
      const changeKey = newIdempotencyKey();
      if (runRemoteOrQueue({ t: 'change', decisionId: decId, reason, costImpact, timeImpactDays, idempotencyKey: changeKey }, 'Change ' + decId, () => gateway!.requestChange(decId, reason, costImpact, timeImpactDays, changeKey), 'Change Request submitted for client re-approval.')) return;
      set((s) => {
        const d = s.decisions.find((x) => x.id === decId);
        if (d) {
          d.status = 'change';
          d.changeRequest = { reason, costImpact, timeImpactDays };
        }
        s.modal = { type: null };
      });
      get().flash('Change Request submitted for client re-approval.');
    },
    withdrawChange: (decId) => {
      const withdrawKey = newIdempotencyKey();
      if (runRemoteOrQueue({ t: 'changeWithdraw', decisionId: decId, idempotencyKey: withdrawKey }, 'Withdraw change ' + decId, () => gateway!.withdrawChange(decId, withdrawKey), 'Change request withdrawn — the decision is locked again.')) return;
      set((s) => {
        const d = s.decisions.find((x) => x.id === decId);
        if (d && d.status === 'change') {
          d.status = 'approved';
          delete d.changeRequest;
        }
      });
      get().flash('Change request withdrawn — the decision is locked again.');
    },
    setChangeText: (v) => set((s) => { s.modal.changeText = v; }),
    setChangeCost: (v) => set((s) => { s.modal.changeCost = v; }),
    setChangeTime: (v) => set((s) => { s.modal.changeTime = v; }),

    // ---- engineer checklist (a null checklist = none issued; every action no-ops) ----
    setItem: (idx, val) =>
      set((s) => {
        const c = s.checklist;
        const it = c?.items[idx];
        if (!c || !it) return;
        if (checklistFrozen(s)) return; // gate round 8: no edits once the payload is frozen
        it.state = it.state === val ? null : val;
        recordChecklistMark(s, c.id, it.id, 'state', it.state);
      }),
    addPhoto: (idx) => set((s) => { if (checklistFrozen(s)) return; const it = s.checklist?.items[idx]; if (it) it.photos += 1; }),
    addChecklistEvidence: async (idx, dataUrl) => {
      const c = get().checklist;
      const item = c?.items[idx];
      if (!c || !item) return;
      if (checklistFrozen(get())) { get().flash('This inspection is submitted — no more changes.'); return; } // gate round 8
      const m = /^data:([^;]+);base64,(.*)$/.exec(dataUrl);
      if (!m) {
        get().flash('Could not read that photo — please try again.');
        return;
      }
      const [, mime, base64] = m;
      // hard size cap (the capture flow should downscale before calling this;
      // an oversize photo is REFUSED explicitly, never silently truncated)
      if (base64.length > 5_600_000) { // ~4 MB decoded
        get().flash('That photo is too large (over 4 MB) — retake at a lower resolution.');
        return;
      }
      // demo (no gateway): the counter + a local thumbnail are the whole story
      if (!gateway) {
        set((s) => {
          const it = s.checklist?.items[idx];
          if (it) { it.photos += 1; it.evidence = [...(it.evidence ?? []), dataUrl]; }
        });
        get().flash('Photo attached (demo).');
        return;
      }
      if (!item.id) {
        get().flash('This checklist predates evidence capture — reload the project and retry.');
        return;
      }
      const clientKey = (globalThis.crypto?.randomUUID?.() ?? `ev-${Math.random().toString(36).slice(2)}`);
      const meta = { inspectionId: c.id, inspectionItemId: item.id };

      if (!get().online) {
        // OFFLINE: durability is part of the command result — "saved offline" is
        // shown ONLY after the IndexedDB write commits; a quota/write failure (or
        // no IndexedDB at all) surfaces as an explicit failure and queues NOTHING.
        if (!evidenceAvailable()) {
          get().flash('Could not save this photo on the device (offline storage unavailable) — retake when you have signal.');
          return;
        }
        // gate round-3: the durable row belongs to the scope the user captured
        // it in — pin that scope BEFORE the write and never mutate another one
        const ctx = captureEvidenceContext();
        try {
          await putEvidence({ userScope: ctx.scope, projectId: ctx.projectId, clientKey, mime, data: base64, ...meta });
        } catch {
          if (evidenceContextStillCurrent(ctx)) get().flash('Could not save this photo on the device — free space and retake.');
          return;
        }
        // gate round-4 finding 1: the context check comes FIRST — only a
        // completion still belonging to the ACTIVE context may invalidate that
        // context's in-flight reconciliation. A capture whose scope moved
        // mid-write returns untouched (its row's own scope reconstructs it);
        // bumping the shared epoch here would cancel the NEW scope's own
        // hydration and hide its pending/failed evidence.
        if (!evidenceContextStillCurrent(ctx)) return;
        // a NEW pending row exists in THIS scope — reconciliations already in
        // flight read a world without it and must not overwrite its mirrors
        invalidateEvidenceReconciles();
        set((s) => {
          s.outbox.push({ t: 'uploadEvidence', scope: ctx.scope, clientKey });
          s.syncQueue.push('Evidence photo');
          const it = s.checklist?.items[idx];
          if (it) { it.photos += 1; it.evidence = [...(it.evidence ?? []), dataUrl]; }
          s.pendingEvidenceCount += 1;
        });
        persistOutbox();
        get().flash('Photo saved offline — will upload when signal returns.');
        return;
      }
      // ONLINE: upload now with the idempotency key; reconcile from the snapshot.
      // The engineer's UNSUBMITTED field marks are preserved across the refresh by
      // applySnapshot itself (gate round 6 — the ONE preservation path, keyed by
      // row id + scope generation), so this path just uploads and reconciles.
      const scope = currentScope();
      try {
        await gateway.uploadMedia({ kind: 'inspection', mime, data: base64, clientKey, ...meta });
        if (!scopeStillCurrent(scope)) return;
        // gate round 11: capture the snapshot lease BEFORE the refetch, then route
        // through the coordinator — a newer socket refresh / submit that began
        // meanwhile supersedes this reconcile, and the success toast fires only when
        // the snapshot is actually `applied` (never on a superseded / wrong-project one).
        const lease = beginSnapshotLease(scope);
        const snap = await gateway.snapshot();
        consumeSnapshotResult(acceptSnapshot(snap, lease), 'Evidence photo uploaded and linked to the item.', lease.scope);
      } catch {
        // the failure belongs to the scope the capture was made in — a moved
        // scope (gate round-4 finding 3) hears nothing
        if (scopeStillCurrent(scope)) get().flash('Could not upload the photo — check your signal and try again.');
      }
    },
    retryFailedEvidence: async (clientKey) => {
      invalidateEvidenceReconciles(); // the row is about to change state under any in-flight read
      const ctx = captureEvidenceContext(); // the row being revived belongs to THIS scope
      const revived = await retryEvidence(ctx.scope, ctx.projectId, clientKey).catch(() => null);
      if (!revived) return;
      // gate round-3: moved mid-revive — the now-pending row reconstructs in its own scope
      if (!evidenceContextStillCurrent(ctx)) return;
      set((s) => {
        s.failedEvidence = s.failedEvidence.filter((f) => f.clientKey !== clientKey);
        s.outbox.push({ t: 'uploadEvidence', scope: ctx.scope, clientKey }); // SAME key — the server dedupes
        s.syncQueue.push('Evidence photo (retry)');
        s.pendingEvidenceCount += 1;
      });
      persistOutbox();
      if (get().online) get().flushOutbox();
    },
    deleteFailedEvidence: async (clientKey) => {
      invalidateEvidenceReconciles(); // the row is about to vanish under any in-flight read
      const ctx = captureEvidenceContext();
      // the user's explicit decision — the only non-server path that drops bytes
      try {
        await deleteEvidence(ctx.scope, ctx.projectId, clientKey);
      } catch {
        // gate round-4 finding 2: the deletion did NOT happen — the bytes are
        // still on the device, so the Retry/Delete surface must stay and the
        // UI must never claim success. Surface the failure only to the scope
        // the user acted in; a moved scope hears nothing.
        if (!evidenceContextStillCurrent(ctx)) return;
        get().flash('Could not delete the photo — it is still saved on this device; try again.');
        return;
      }
      // gate round-3: the delete honored the user's decision in ITS scope; a
      // switch that landed mid-await leaves the NEW scope's UI untouched
      if (!evidenceContextStillCurrent(ctx)) return;
      set((s) => { s.failedEvidence = s.failedEvidence.filter((f) => f.clientKey !== clientKey); });
      get().flash('Photo deleted.');
    },
    hydrateEvidence: async () => reconcileEvidence(),
    setNote: (idx, txt) => set((s) => { const c = s.checklist; const it = c?.items[idx]; if (c && it) { if (checklistFrozen(s)) return; it.note = txt; recordChecklistMark(s, c.id, it.id, 'note', txt); } }),
    submitInspection: () => {
      const c = get().checklist;
      if (!c || !c.items.length) {
        get().flash('No checklist has been issued for today yet.');
        return;
      }
      // gate round 8: once the payload is frozen (submitting / queued / already
      // server-submitted) a repeat submit is a no-op — no double submission, and
      // no edit can slip in between the click and the outcome.
      if (checklistFrozen(get())) {
        get().flash('This inspection has already been submitted.');
        return;
      }
      const undone = c.items.filter((it) => !it.state).length;
      // a fail needs EVIDENCE: a linked photo (the server's proof, Task 4) or the
      // legacy counter (demo). The deprecated counter alone must not block a fail
      // whose photo is a real linked Media row (Task 7 acceptance finding).
      const failNoPhoto = c.items.filter((it) => it.state === 'fail' && it.photos === 0 && (it.evidence?.length ?? 0) === 0).length;
      if (undone > 0) {
        get().flash('Please mark all ' + c.items.length + ' items before submitting.');
        return;
      }
      if (failNoPhoto > 0) {
        get().flash('A failed item needs a photo before you can submit.');
        return;
      }
      if (gateway) {
        if (get().online) {
          // gate round 8: FREEZE the checklist the instant we dispatch — no edit may
          // change the payload while the submit is in flight (the round-7 finding:
          // an edit made during the pending window was silently reverted when the
          // ack arrived). On success the server's submitted checklist lands and
          // applySnapshot drops the marks (gate round 7). On FAILURE we UNLOCK the
          // checklist WITHOUT losing the marks so the engineer can fix and resubmit.
          // gate round 10: stamp this dispatch with a unique attempt id. The
          // (project, generation) scope guard (round 9) cannot separate two submits
          // WITHIN one session — a socket-delivered checklist swap can retire this
          // submit and start another under the SAME generation. `attempt` makes each
          // dispatch identifiable; `isThisAttempt()` is true only while THIS dispatch
          // still owns the submission (no newer submit, and no reconcile has retired it).
          const attempt = ++submitAttemptSeq;
          set((s) => { s.submission = { inspectionId: c.id, generation: s.projectScopeGeneration, status: 'submitting', attempt }; });
          const scope = currentScope();
          // gate round 11: the submit needs BOTH guards — the attempt id owns the
          // COMMAND lifecycle (round 10), and a snapshot lease captured at dispatch
          // owns snapshot FRESHNESS (so a newer socket refresh / submit that began
          // while this was in flight supersedes this response even in the same scope).
          const lease = beginSnapshotLease(scope);
          const isThisAttempt = (): boolean => scopeStillCurrent(scope) && get().submission.attempt === attempt;
          gateway
            .submitInspection(c.id, c.items)
            .then((snap) => {
              if (!isThisAttempt()) return; // a newer submit/socket/session retired this command
              const result = acceptSnapshot(snap, lease);
              if (result === 'applied') {
                get().flash('Inspection submitted to the architect for review.');
              } else if (result === 'superseded') {
                // gate round 12/13: the submit committed, but a newer refresh owns the
                // view. Keep the checklist FROZEN (don't unlock — the submit succeeded)
                // and record a SUBMIT reconcile requirement naming THIS attempt, so the
                // requirement clears only when this exact submit is confirmed by server
                // truth (not by a stale unsubmitted snapshot); if the mandatory reconcile
                // fails or lands still-unconfirmed, a recoverable error/Retry is exposed
                // instead of freezing forever.
                scheduleReconcile(scope, { kind: 'submit', inspectionId: c.id, attempt, createdAfterSequence: snapshotSeq });
              } else if (result === 'invalid-project') {
                // manifestation 2: a rejected (wrong-project) payload must NOT report
                // success and must NOT leave the checklist frozen forever — unlock the
                // attempt and pull a fresh snapshot to recover current truth.
                set((s) => { if (s.submission.attempt === attempt && s.submission.status === 'submitting') s.submission.status = 'idle'; });
                void requestFreshSnapshot();
              }
              // scope-moved: silent — the new scope owns its own truth.
            })
            .catch(() => {
              // A retired attempt (round 9/10) or a superseded session must not unlock
              // the live submit or toast — a socket refresh may already have confirmed.
              if (!isThisAttempt()) return;
              set((s) => {
                if (s.submission.attempt === attempt && s.submission.status === 'submitting') {
                  s.submission.status = 'idle';
                }
              });
              get().flash('Could not submit — your marks are kept. Please try again.');
            });
          return;
        }
        // offline: QUEUE the submit (persisted) and freeze as 'queued'. The freeze
        // survives a reload because reconcileSubmission rebuilds it from the outbox.
        set((s) => {
          s.outbox.push({ t: 'submitInspection', inspectionId: c.id, items: c.items });
          s.syncQueue.push('Submit inspection');
          s.submission = { inspectionId: c.id, generation: s.projectScopeGeneration, status: 'queued', attempt: 0 };
        });
        persistOutbox();
        get().flash('Submit inspection — saved offline, will sync when you reconnect.');
        return;
      }
      // demo (no gateway): the submit succeeds locally and synchronously — the
      // marks are now recorded on the (local) submitted checklist, so drop them.
      set((s) => {
        if (!s.checklist) return;
        s.checklist.submitted = true;
        s.submission = { inspectionId: null, generation: s.projectScopeGeneration, status: 'idle', attempt: 0 };
        s.checklistMarks.inspectionId = null;
        s.checklistMarks.byItem = {};
        // demo (no API): the submitted checklist enters the PMC review queue,
        // mapping each item's pass/fail state to a PASS/FAIL result.
        if (!s.reviews.some((r) => r.id === s.checklist!.id)) {
          s.reviews.push({
            id: s.checklist.id,
            title: s.checklist.title,
            zone: s.checklist.zone,
            by: 'Site Engineer',
            date: s.checklist.date,
            decided: false,
            items: s.checklist.items.map((it) => ({
              name: it.name,
              result: it.state === 'fail' ? 'FAIL' : 'PASS',
              swatch: 'concrete',
              note: it.note,
              rejected: false,
            })),
          });
        }
      });
      get().flash('Inspection submitted to the architect for review.');
    },

    // ---- pmc review (queue) ----
    setActiveReview: (id) => set((s) => { s.activeReviewId = id; }),
    toggleReject: (idx) =>
      set((s) => {
        const i = activeReviewIdx();
        if (i < 0) return;
        s.reviews[i].items[idx].rejected = !s.reviews[i].items[idx].rejected;
      }),
    approveInspection: () => {
      const i = activeReviewIdx();
      if (i < 0) return;
      const review = get().reviews[i];
      // Task 5: approving a CLOSING review is the sign-off that completes its activity
      const msg = review.closing
        ? `Signed off: ${review.activityName ?? review.title} is complete.`
        : 'Inspection approved. Contractor and client notified.';
      if (runRemoteOrQueue({ t: 'decideReview', inspectionId: review.id, approve: true, rejectedItemIds: [] }, 'Approve inspection', () => gateway!.decideReview(review.id, true, []), msg)) return;
      set((s) => {
        const j = s.reviews.findIndex((r) => r.id === review.id);
        if (j >= 0) s.reviews[j].decided = true;
        if (review.closing && review.activityId) {
          const a = s.activities.find((x) => x.id === review.activityId);
          if (a) a.status = 'done'; // the PMC's acceptance IS the completion
        }
        s.activeReviewId = review.id; // keep the just-decided review on screen (REVIEWED)
      });
      get().flash(msg);
    },
    sendReinspection: () => {
      const i = activeReviewIdx();
      if (i < 0) return;
      const review = get().reviews[i];
      const n = review.items.filter((it) => it.rejected || it.result === 'FAIL').length;
      if (n === 0) {
        get().flash('No items rejected. Use Approve Inspection instead.');
        return;
      }
      // gate finding 3: rejection names exact ROWS by server id (labels are not unique)
      const rejectedIds = review.items.filter((it) => it.rejected && it.id).map((it) => it.id!);
      if (runRemoteOrQueue({ t: 'decideReview', inspectionId: review.id, approve: false, rejectedItemIds: rejectedIds }, 'Send re-inspection', () => gateway!.decideReview(review.id, false, rejectedIds), n + ' re-inspection task(s) created with due dates.')) return;
      set((s) => {
        s.reinspectionCreated = true;
        const j = s.reviews.findIndex((r) => r.id === review.id);
        if (j >= 0) s.reviews[j].decided = true;
        if (review.closing && review.activityId) {
          // Task 5: rejecting the closing sign-off returns the activity to execution
          const a = s.activities.find((x) => x.id === review.activityId);
          if (a) a.status = 'in-progress';
        }
        s.activeReviewId = review.id;
      });
      get().flash(n + ' re-inspection task(s) created with due dates.');
    },

    // ---- drawings register ----
    issueDrawing: (input) => {
      if (gateway) {
        // gate round 12: capture the scope BEFORE the request and guard EVERY
        // continuation on it — success toast, refresh AND the failure toast. Without
        // this, an issue that resolves after a project switch flashed "Drawing issued"
        // into project B and refreshed B through its gateway (finding 3).
        const scope = currentScope();
        gateway
          .issueDrawing(input)
          .then(() => {
            if (!scopeStillCurrent(scope)) return; // resolved after a switch — B is not ours to touch
            get().flash(`Drawing issued: ${input.number} Rev ${input.rev} — team notified.`);
            requestFreshSnapshot(scope); // one coalesced, coordinator-ordered refresh for THIS scope
          })
          .catch(() => { if (scopeStillCurrent(scope)) get().flash('Could not issue the drawing — please try again.'); });
        return;
      }
      // local demo: add to the register (or add a rev + supersede the prior)
      set((s) => {
        const newRev = {
          id: `${input.number}-${input.rev}`,
          rev: input.rev,
          status: input.status ?? 'for_construction',
          mime: input.mime,
          url: `data:${input.mime};base64,${input.data}`,
          sizeBytes: Math.floor((input.data.length * 3) / 4),
          note: input.note ?? '',
          issuedBy: 'You (demo)',
          issuedAt: 'just now',
          acks: [],
        };
        const existing = s.drawings.find((d) => d.number === input.number);
        if (existing) {
          existing.revisions.forEach((r) => { if (r.status !== 'superseded') r.status = 'superseded'; });
          existing.revisions.unshift(newRev);
          existing.current = newRev;
          existing.title = input.title;
          existing.discipline = input.discipline;
          existing.nodeId = input.nodeId ?? existing.nodeId;
          existing.ackedByMe = false; // a fresh rev needs re-acknowledgement
          if (input.publish) existing.draft = false;
        } else {
          s.drawings.unshift({
            id: `DWG-${s.drawings.length + 1}`,
            number: input.number,
            title: input.title,
            discipline: input.discipline,
            zone: input.zone ?? null,
            activityId: input.activityId ?? null,
            decisionId: input.decisionId ?? null,
            nodeId: input.nodeId,
            draft: !input.publish, // a new drawing is a private draft unless issued now
            ackedByMe: false,
            current: newRev,
            revisions: [newRev],
          });
        }
      });
      get().flash(
        input.publish
          ? `Drawing issued: ${input.number} Rev ${input.rev} (demo).`
          : `Draft saved: ${input.number} — visible only to you until you publish it (demo).`,
      );
    },
    publishDrawing: (drawingId) => {
      const d = get().drawings.find((x) => x.id === drawingId);
      if (!d) return;
      // API mode: the server flips publishedAt, notifies the build team, returns a snapshot.
      if (gateway) {
        runRemote(() => gateway!.publishDrawing(drawingId), `Published: ${d.number} — the build team has been notified.`);
        return;
      }
      // Demo (no server): flip the draft live locally + raise the build-team notification.
      set((s) => {
        const row = s.drawings.find((x) => x.id === drawingId);
        if (!row || !row.draft) return;
        row.draft = false;
        s.notifications.unshift({ text: `Drawing issued: ${row.number} — ${row.title}`, time: 'just now', color: '#C08A2D' });
      });
      get().flash(`Published: ${d.number} — the build team has been notified.`);
    },
    publishAllDrafts: () => {
      const decIds = get().decisions.filter((d) => d.draft).map((d) => d.id);
      const dwgIds = get().drawings.filter((d) => d.draft).map((d) => d.id);
      const total = decIds.length + dwgIds.length;
      if (total === 0) return;
      const done = () => get().flash(`Published ${total} draft${total === 1 ? '' : 's'} — the team has been notified.`);
      // API mode: publish each in turn, then reconcile once from a fresh snapshot.
      if (gateway) {
        const gw = gateway;
        const scope = currentScope();
        void (async () => {
          try {
            for (const id of decIds) await gw.publishDecision(id, newIdempotencyKey());
            for (const id of dwgIds) await gw.publishDrawing(id);
            // gate round 11: capture the lease before the reconcile fetch. The
            // publishes committed on the server, so announce success once the reply
            // lands in the current scope — `applied` OR `superseded` (a newer
            // same-scope refresh already carries the published state). Suppress on a
            // wrong-project payload (recover) or a scope move (no stale toast leak).
            const lease = beginSnapshotLease(scope);
            const result = acceptSnapshot(await gw.snapshot(), lease);
            // gate round 12: the publishes committed; announce on applied/superseded
            // (the mutation landed in the current scope), reconcile a superseded reply
            // since the newer refresh may fail, recover a wrong-project one. Silent if
            // the scope moved (no stale toast into another project).
            if (result === 'applied' || result === 'superseded') done();
            if (result === 'superseded') scheduleReconcile(scope, { kind: 'command', createdAfterSequence: snapshotSeq });
            else if (result === 'invalid-project') void requestFreshSnapshot();
          } catch {
            if (scopeStillCurrent(scope)) get().flash('Could not publish every draft — some may still be drafts. Please try again.');
          }
        })();
        return;
      }
      // Demo (no server): flip them all live in one pass + raise each item's notification.
      set((s) => {
        for (const row of s.decisions) {
          if (row.draft && decIds.includes(row.id)) {
            row.draft = false;
            s.notifications.unshift({ text: `Decision awaiting approval: ${row.title}`, time: 'just now', color: '#C08A2D' });
          }
        }
        for (const row of s.drawings) {
          if (row.draft && dwgIds.includes(row.id)) {
            row.draft = false;
            s.notifications.unshift({ text: `Drawing issued: ${row.number} — ${row.title}`, time: 'just now', color: '#C08A2D' });
          }
        }
      });
      done();
    },
    acknowledgeDrawing: (drawingId) => {
      const drawing = get().drawings.find((d) => d.id === drawingId);
      if (!drawing?.current || drawing.ackedByMe) return;
      const rev = drawing.current;
      if (gateway) {
        // Offline-queueable (Phase 1 Task 3): the server ack is an idempotent upsert
        // on (revisionId, userId), so replaying the queued op is safe. Mark ackedByMe
        // optimistically so the register reflects the field's intent immediately.
        if (!get().online) {
          set((s) => {
            s.outbox.push({ t: 'ackDrawing', revisionId: rev.id });
            s.syncQueue.push('Acknowledge ' + drawing.number);
            const d = s.drawings.find((x) => x.id === drawingId);
            if (d) d.ackedByMe = true;
          });
          persistOutbox();
          get().flash(`Acknowledge ${drawing.number} — saved offline, will sync when you reconnect.`);
          return;
        }
        // gate round 12: capture + guard the scope on every continuation, so an ack
        // that resolves after a project switch neither toasts nor refreshes project B.
        const scope = currentScope();
        gateway
          .acknowledgeDrawing(rev.id)
          .then(() => {
            if (!scopeStillCurrent(scope)) return;
            get().flash(`Acknowledged — building to ${drawing.number} Rev ${rev.rev}.`);
            requestFreshSnapshot(scope); // one coalesced, coordinator-ordered refresh for THIS scope
          })
          .catch(() => { if (scopeStillCurrent(scope)) get().flash('Could not record the acknowledgement — please try again.'); });
        return;
      }
      // local demo: mark building-to on the current rev
      const label = get().userName ?? { pmc: 'PMC', client: 'Client', engineer: 'Site Engineer', contractor: 'Contractor', consultant: 'Consultant' }[get().role] ?? 'You';
      set((s) => {
        const d = s.drawings.find((x) => x.id === drawingId);
        if (!d?.current) return;
        d.ackedByMe = true;
        const ack = { userName: label, role: s.role, at: 'just now' };
        d.current.acks.push(ack);
        const inHistory = d.revisions.find((r) => r.id === d.current!.id);
        if (inHistory) inHistory.acks.push(ack);
      });
      get().flash(`Acknowledged — building to ${drawing.number} Rev ${rev.rev} (demo).`);
    },
    fileDrawing: (drawingId, nodeId) => {
      if (gateway) {
        runRemote(() => gateway!.setDrawingNode(drawingId, nodeId), nodeId ? 'Drawing filed to location.' : 'Drawing unfiled.');
        return;
      }
      set((s) => {
        const d = s.drawings.find((x) => x.id === drawingId);
        if (d) d.nodeId = nodeId ?? undefined;
      });
      get().flash(nodeId ? 'Drawing filed to location (demo).' : 'Drawing unfiled (demo).');
    },
    filePhoto: (photoId, nodeId) => {
      if (gateway) {
        runRemote(() => gateway!.setMediaNode(photoId, nodeId), nodeId ? 'Photo filed to location.' : 'Photo unfiled.');
        return;
      }
      set((s) => {
        const p = s.photos.find((x) => x.id === photoId);
        if (p) p.nodeId = nodeId ?? undefined;
      });
      get().flash(nodeId ? 'Photo filed to location (demo).' : 'Photo unfiled (demo).');
    },

    // ---- multi-project + team (Orgs Slice 2) ----
    loadOrgData: () => {
      if (!gateway) return;
      // session-scoped (not project-scoped): ignore replies after sign-out / re-auth
      const tok = get().sessionToken;
      gateway.listMemberships().then((ms) => set((s) => { if (s.sessionToken === tok) s.memberships = ms; })).catch(() => {});
      gateway.myOrgs().then((os) => set((s) => { if (s.sessionToken === tok) s.myOrgs = os; })).catch(() => {});
    },
    loadPortfolio: () => {
      if (!gateway) return;
      const tok = get().sessionToken; // session-scoped: drop replies after sign-out / re-auth
      gateway.getPortfolio().then((p) => set((s) => { if (s.sessionToken === tok) s.portfolio = p; })).catch(() => {});
    },
    // Phase 2 Task 9 — the project-shell summary: populate `enabledModules` for the manifest-driven
    // nav. Project-scoped — a reply that lands after a switch / re-auth is dropped (guarded by scope).
    loadShell: () => {
      if (!gateway) return;
      const scope = { projectId: get().activeProjectId, generation: get().projectScopeGeneration };
      gateway.shell().then((shell) => set((s) => {
        if (isCurrentProjectScope(s.activeProjectId, s.projectScopeGeneration, scope)) s.enabledModules = shell.enabledModules;
      })).catch(() => {});
    },
    switchProject: (projectId, targetScreen) => {
      if (!gateway || projectId === get().activeProjectId) return Promise.resolve(false);
      const membership = get().memberships.find((m) => m.projectId === projectId);
      const short = membership?.short ?? 'project';
      // the OLD project's identity, restored if the switch fails (we keep its auth scope)
      const prev = (({ name, short: sh, descriptor, stage, siteCode }) => ({ name, short: sh, descriptor, stage, siteCode }))(get());
      // ATOMIC ENTRY — before the auth request goes out: bump the scope generation
      // (in-flight replies for the old scope will be dropped), mark the transition,
      // and EMPTY every project-owned field. Old records can neither render nor
      // arrive while authorization is pending.
      set((s) => {
        s.projectScopeGeneration += 1;
        s.pendingProjectId = projectId;
        s.projectLoadState = 'switching';
        s.projectLoadError = null;
        // optimistic label from the membership; the snapshot supplies the rest
        s.name = membership?.name ?? short;
        s.short = short;
        s.descriptor = '';
        s.stage = '';
        s.siteCode = '';
        Object.assign(s, emptyProjectData());
        Object.assign(s, emptyModuleReadState()); // finding 4: the target project's reads are not loaded yet
      });
      return gateway
        .switchProject(projectId)
        .then((res) => {
          // adopt the SERVER-returned project/role/token (never the requested id);
          // useApiSync re-inits the gateway for the new scope and refetches.
          applyAuthResult(res, { msg: 'Switched to ' + short + '.', targetScreen });
          return true;
        })
        .catch(() => {
          // authorization failed: keep the OLD authenticated identity (token/project
          // unchanged), keep project data empty (never resurface half-cleared records),
          // and surface a recoverable error.
          set((s) => {
            s.pendingProjectId = null;
            s.projectLoadState = 'error';
            s.projectLoadError = 'Could not switch to ' + short + ' — check your access and try again.';
            s.name = prev.name;
            s.short = prev.short;
            s.descriptor = prev.descriptor;
            s.stage = prev.stage;
            s.siteCode = prev.siteCode;
          });
          get().flash('Could not switch project — please try again.');
          return false;
        });
    },
    createProject: (orgId, input) => {
      if (!gateway) {
        get().flash('Creating projects needs the server.');
        return;
      }
      gateway
        .createProject(orgId, input)
        .then((p) => {
          get().flash('Project created: ' + p.short + '.');
          get().loadOrgData();
          void get().switchProject(p.id);
        })
        .catch(() => get().flash('Could not create the project — check your access.'));
    },
    updateProjectDetails: (orgId, projectId, input) => {
      if (!gateway) {
        get().flash('Editing projects needs the server.');
        return;
      }
      gateway
        .updateProject(orgId, projectId, input)
        .then((p) => {
          get().flash('Project updated: ' + p.short + '.');
          get().loadOrgData();
          get().loadPortfolio();
        })
        .catch(() => get().flash('Could not update the project — check your access.'));
    },
    deleteProject: (orgId, projectId) => {
      if (!gateway) {
        get().flash('Deleting projects needs the server.');
        return;
      }
      gateway
        .deleteProject(orgId, projectId)
        .then(() => {
          get().flash('Project archived — it’s hidden from everyone. Ask to restore it if needed.');
          // if we archived the project we're in, switch to another we can access
          if (projectId === get().activeProjectId) {
            const next = get().memberships.find((m) => m.projectId !== projectId);
            if (next) get().switchProject(next.projectId);
          }
          get().loadOrgData();
          get().loadPortfolio();
        })
        .catch(() => get().flash('Could not archive the project — check your access.'));
    },
    restoreProject: (orgId, projectId) => {
      if (!gateway) {
        get().flash('Restoring projects needs the server.');
        return;
      }
      gateway
        .restoreProject(orgId, projectId)
        .then(() => {
          get().flash('Project restored — it’s visible again.');
          get().loadArchivedProjects(orgId);
          get().loadOrgData();
          get().loadPortfolio();
        })
        .catch(() => get().flash('Could not restore the project — check your access.'));
    },
    loadArchivedProjects: (orgId) => {
      if (!gateway) return;
      // session-scoped: a reply from a previous sign-in never lands in this one
      const tok = get().sessionToken;
      gateway.listArchivedProjects(orgId).then((rows: ArchivedProject[]) => set((s) => { if (s.sessionToken === tok) s.archivedProjects = rows; })).catch(() => {});
    },
    // Company mutations reconcile from raw DTOs (no snapshot), so each captures the
    // scope its request was issued FOR and drops the reply if the scope moved on —
    // a late reply from project A must never surface under project B (finding 3).
    addCompany: (input) => {
      if (!gateway) {
        get().flash('Managing companies needs the server.');
        return;
      }
      const scope = currentScope();
      gateway
        .addCompany(input)
        .then((c) => {
          if (!scopeStillCurrent(scope)) return;
          set((s) => { s.companies.push(c); });
          get().flash(`Added ${c.name}.`);
        })
        .catch(() => get().flash('Could not add the company — check your access.'));
    },
    updateCompany: (companyId, input) => {
      if (!gateway) {
        get().flash('Managing companies needs the server.');
        return;
      }
      const scope = currentScope();
      gateway
        .updateCompany(companyId, input)
        .then((c) => {
          if (!scopeStillCurrent(scope)) return;
          set((s) => { const i = s.companies.findIndex((x) => x.id === companyId); if (i >= 0) s.companies[i] = c; });
          get().flash(`Updated ${c.name}.`);
        })
        .catch(() => get().flash('Could not update the company — check your access.'));
    },
    removeCompany: (companyId) => {
      if (!gateway) {
        get().flash('Managing companies needs the server.');
        return;
      }
      const scope = currentScope();
      gateway
        .removeCompany(companyId)
        .then(() => {
          if (!scopeStillCurrent(scope)) return;
          set((s) => { s.companies = s.companies.filter((x) => x.id !== companyId); });
          get().flash('Company removed.');
        })
        .catch(() => get().flash('Could not remove the company — check your access.'));
    },
    issueDecision: (input) => {
      if (!gateway) {
        get().flash('Issuing decisions needs the server.');
        return;
      }
      const gw = gateway;
      const scope = currentScope();
      // Upload any captured option photos first, then create with their urls.
      void (async () => {
        try {
          const options = await Promise.all(
            input.options.map(async ({ photo, ...o }) => {
              if (!photo) return o;
              const up = await gw.uploadMedia({ kind: 'decision', mime: photo.mime, data: photo.data });
              return { ...o, photoUrl: up.url };
            }),
          );
          const lease = beginSnapshotLease(scope); // gate round 11: before the create request
          const snap = await gw.createDecision({ title: input.title, nodeId: input.nodeId, room: input.room, options, publish: input.publish }, newIdempotencyKey());
          consumeSnapshotResult(
            acceptSnapshot(snap, lease),
            input.publish
              ? `Decision issued: ${input.title} — the client has been asked to choose.`
              : `Draft saved: ${input.title} — visible only to you until you publish it.`,
            lease.scope,
          );
        } catch {
          // gate round 12: a failure that lands after a project switch must not toast
          // into the new project (the same stale-toast rule as the success path).
          if (scopeStillCurrent(scope)) get().flash(input.publish ? 'Could not issue the decision — check your access and try again.' : 'Could not save the draft — check your access and try again.');
        }
      })();
    },
    publishDecision: (decisionId) => {
      const d = get().decisions.find((x) => x.id === decisionId);
      if (!d) return;
      // API mode: the server flips publishedAt, notifies the client, and returns a fresh snapshot.
      if (gateway) {
        runRemote(() => gateway!.publishDecision(decisionId, newIdempotencyKey()), `Published: ${d.title} — the client has been asked to choose.`);
        return;
      }
      // Demo (no server): flip the draft live locally and raise the client's notification,
      // so the whole "hold then publish" flow is demoable offline.
      set((s) => {
        const row = s.decisions.find((x) => x.id === decisionId);
        if (!row || !row.draft) return;
        row.draft = false;
        s.notifications.unshift({ text: `Decision awaiting approval: ${row.title}`, time: 'just now', color: '#C08A2D' });
      });
      get().flash(`Published: ${d.title} — the client has been asked to choose.`);
    },
    addLocationNode: async (input) => {
      if (!gateway) {
        get().flash('Managing locations needs the server.');
        return null;
      }
      const before = new Set(get().nodes.map((n) => n.id));
      const scope = currentScope();
      try {
        const lease = beginSnapshotLease(scope); // gate round 11: before the create request
        const snap = await gateway.createNode(input);
        const result = acceptSnapshot(snap, lease);
        if (result !== 'applied') {
          // a newer refresh owns the tree (superseded) or the payload was wrong-project;
          // don't claim success or return a node id the current tree may not reflect.
          // gate round 12/13: on superseded the node WAS created — record a command
          // reconcile requirement so it lands (or exposes Retry) even if the newer
          // refresh fails; on wrong-project, recover.
          if (result === 'superseded') scheduleReconcile(scope, { kind: 'command', createdAfterSequence: snapshotSeq });
          else if (result === 'invalid-project') void requestFreshSnapshot();
          return null;
        }
        get().flash(`Added ${input.kind}: ${input.name}.`);
        // the newly-created node is the one whose id wasn't present before
        const created = get().nodes.find((n) => !before.has(n.id) && n.name === input.name && n.kind === input.kind);
        return created?.id ?? null;
      } catch {
        // gate round 12: a failure landing after a switch must not toast into project B.
        if (scopeStillCurrent(scope)) get().flash('Could not add the location — check your access and try again.');
        return null;
      }
    },
    renameNode: (nodeId, name) => {
      if (!gateway) {
        get().flash('Managing locations needs the server.');
        return;
      }
      runRemote(() => gateway!.renameNode(nodeId, name), `Renamed to ${name}.`);
    },
    publishNode: (nodeId) => {
      const node = get().nodes.find((n) => n.id === nodeId);
      if (!node || !node.draft) return;
      // API mode: the server flips the whole branch (subtree + draft ancestors) live and
      // returns a fresh snapshot — the location becomes visible to every role at once.
      if (gateway) {
        runRemote(() => gateway!.publishNode(nodeId), `Published location: ${node.name} — now visible to the team.`);
        return;
      }
      // Demo (no server): flip the branch live locally so the draft→publish flow is demoable.
      // Matches the server's cascade — the node, everything below it, and any draft ancestor
      // (so no published child is ever left hanging off a still-hidden parent).
      set((s) => {
        const branch = new Set<string>([...subtreeIds(s.nodes, nodeId), ...ancestorIds(s.nodes, nodeId)]);
        for (const n of s.nodes) if (branch.has(n.id) && n.draft) n.draft = false;
        s.notifications.unshift({ text: `New location added: ${node.name}`, time: 'just now', color: '#C08A2D' });
      });
      get().flash(`Published location: ${node.name} — now visible to the team.`);
    },
    deleteNode: (nodeId) => {
      if (!gateway) {
        get().flash('Managing locations needs the server.');
        return;
      }
      runRemote(() => gateway!.deleteNode(nodeId), 'Location removed.');
    },
    createActivity: (input) => {
      if (!gateway) {
        get().flash('Planning needs the server.');
        return;
      }
      runRemote(() => gateway!.createActivity(input), `Planned: ${input.name}.`);
    },
    updateActivity: (activityId, input) => {
      if (!gateway) {
        get().flash('Planning needs the server.');
        return;
      }
      runRemote(() => gateway!.updateActivity(activityId, input), 'Schedule updated.');
    },
    deleteActivity: (activityId) => {
      if (!gateway) {
        get().flash('Planning needs the server.');
        return;
      }
      runRemote(() => gateway!.deleteActivity(activityId), 'Activity removed from the plan.');
    },
    // Task 6: a manual readiness exception — attributable, reasoned, expiring (server records it)
    overrideGate: (activityId, input) => {
      if (!gateway) {
        get().flash('Gate overrides need the server.');
        return;
      }
      runRemote(() => gateway!.overrideGate(activityId, input), 'Override recorded — it expires automatically.');
    },
    revokeOverride: (activityId, overrideId) => {
      if (!gateway) {
        get().flash('Gate overrides need the server.');
        return;
      }
      runRemote(() => gateway!.revokeOverride(activityId, overrideId), 'Override revoked — derived readiness applies again.');
    },
    createPhase: (name) => {
      if (!gateway) {
        get().flash('Planning needs the server.');
        return;
      }
      runRemote(() => gateway!.createPhase({ name }), `Phase added: ${name}.`);
    },
    deletePhase: (phaseId) => {
      if (!gateway) {
        get().flash('Planning needs the server.');
        return;
      }
      runRemote(() => gateway!.deletePhase(phaseId), 'Phase removed — its activities stay in the flat list.');
    },
    issueChecklist: (input) => {
      if (!gateway) {
        get().flash('Issuing checklists needs the server.');
        return;
      }
      runRemote(() => gateway!.createInspection(input), `Checklist issued: ${input.title} — the engineer has been notified.`);
    },
    startDailyLog: () => {
      if (!gateway) {
        get().flash('Starting a new log needs the server.');
        return;
      }
      // Task 10 correction round 2 (finding 1): WRITE-AHEAD — the op + its key are persisted to the
      // durable outbox before the network call (online or offline), so a lost/uncertain response never
      // strands the command without its key; a retry or reload replays the SAME op under the SAME key.
      const key = newIdempotencyKey();
      runWriteAhead({ t: 'startDailyLog', idempotencyKey: key }, 'New daily log', 'New daily log started — crew carried over at zero.');
    },
    addSiteMaterial: (input) => {
      if (!gateway) {
        get().flash('Recording materials needs the server.');
        return;
      }
      const key = newIdempotencyKey();
      runWriteAhead({ t: 'addSiteMaterial', input, idempotencyKey: key }, 'Record material', `Material recorded: ${input.name}.`);
    },
    loadTeam: () => {
      if (!gateway) return Promise.resolve();
      // capture the SCOPE this request is FOR — an id-only pin would wrongly apply
      // an A-scoped reply after switching A→B→A; the generation catches that too
      const scope = currentScope();
      return gateway
        .listMembers()
        .then((m) => set((s) => {
          if (!isCurrentProjectScope(s.activeProjectId, s.projectScopeGeneration, scope)) return;
          s.members = m;
        }))
        .catch(() => {});
    },
    addMember: (input) => {
      if (!gateway) {
        get().flash('Managing the team needs the server.');
        return;
      }
      gateway
        .addMember(input)
        .then(() => { get().loadTeam(); get().flash(input.name + ' added to the team.'); })
        .catch(() => get().flash('Could not add the member — check the details / your access.'));
    },
    updateMemberRole: (userId, role, discipline) => {
      if (!gateway) return;
      gateway.updateMemberRole(userId, role, discipline).then(() => get().loadTeam()).catch(() => get().flash('Could not change the role.'));
    },
    removeMember: (userId) => {
      if (!gateway) return;
      gateway.removeMember(userId).then(() => { get().loadTeam(); get().flash('Member removed.'); }).catch(() => get().flash('Could not remove the member.'));
    },
    loadOrgMembers: (orgId) => {
      if (!gateway) return;
      const tok = get().sessionToken; // session-scoped: drop replies after sign-out / re-auth
      gateway.listOrgMembers(orgId).then((m) => set((s) => { if (s.sessionToken === tok) s.orgMembers = m; })).catch(() => set((s) => { s.orgMembers = []; }));
    },
    loadOrgModules: (orgId) => {
      if (!gateway) return;
      const tok = get().sessionToken;
      gateway.listModules(orgId).then((m) => set((s) => { if (s.sessionToken === tok) s.orgModules = m; })).catch(() => set((s) => { s.orgModules = []; }));
    },
    loadOrgTemplates: (orgId) => {
      if (!gateway) return;
      const tok = get().sessionToken;
      gateway.listTemplates(orgId).then((t) => set((s) => { if (s.sessionToken === tok) s.orgTemplates = t; })).catch(() => set((s) => { s.orgTemplates = []; }));
    },
    saveProjectAsTemplate: (name) => {
      const orgId = get().memberships.find((m) => m.projectId === get().activeProjectId)?.orgId ?? get().myOrgs[0]?.id;
      if (!gateway || !orgId) {
        get().flash('Saving templates needs the server.');
        return;
      }
      gateway
        .createTemplate(orgId, { name, fromProject: get().activeProjectId })
        .then((t) => {
          set((s) => { s.orgTemplates = [...s.orgTemplates.filter((x) => x.id !== t.id), t]; });
          get().flash(`Saved template "${name}" — pick it under Start from when creating your next project.`);
        })
        .catch(() => get().flash('Could not save the template — check your access and try again.'));
    },
    saveZoneAsModule: (zoneId, zoneName) => {
      // the module lands in the org library — resolve the active project's org
      const orgId = get().memberships.find((m) => m.projectId === get().activeProjectId)?.orgId ?? get().myOrgs[0]?.id;
      if (!gateway || !orgId) {
        get().flash('Saving modules needs the server.');
        return;
      }
      gateway
        .createModule(orgId, { name: zoneName, category: 'space', fromProject: get().activeProjectId, fromNodeId: zoneId })
        .then((m) => {
          set((s) => { s.orgModules = [...s.orgModules.filter((x) => x.id !== m.id), m]; });
          get().flash(`Saved "${zoneName}" as a module — pick it when creating your next project.`);
        })
        .catch(() => get().flash('Could not save the module — check your access and try again.'));
    },
    addOrgMember: (orgId, input) => {
      if (!gateway) {
        get().flash('Managing the org roster needs the server.');
        return;
      }
      gateway
        .addOrgMember(orgId, input)
        .then(() => { get().loadOrgMembers(orgId); get().flash(input.name + ' added as org ' + input.role + '.'); })
        .catch(() => get().flash('Could not add to the roster — check the details / your access.'));
    },
    updateOrgMemberRole: (orgId, userId, role) => {
      if (!gateway) return;
      gateway
        .updateOrgMemberRole(orgId, userId, role)
        .then(() => { get().loadOrgMembers(orgId); get().flash('Org role changed to ' + role + '.'); })
        .catch(() => get().flash('Could not change the role — the org must keep at least one owner.'));
    },
    correctInvitationEmail: (orgId, userId, email) => {
      if (!gateway) return;
      const normalized = email.trim().toLowerCase();
      gateway
        .correctInvitationEmail(orgId, userId, normalized)
        .then(() => { get().loadOrgMembers(orgId); get().flash('Invitation email corrected.'); })
        .catch(() => get().flash('Could not correct the email — it may already be active or in use.'));
    },
    removeOrgMember: (orgId, userId) => {
      if (!gateway) return;
      gateway
        .removeOrgMember(orgId, userId)
        .then(() => { get().loadOrgMembers(orgId); get().flash('Removed from the org roster.'); })
        .catch(() => get().flash('Could not remove — you can’t remove yourself or the last owner.'));
    },

    // ---- schedule ----
    startActivity: (id) => {
      if (runRemoteOrQueue({ t: 'startActivity', activityId: id }, 'Start ' + id, () => gateway!.startActivity(id), 'Activity started — planned dates now tracking against actual.')) return;
      set((s) => {
        const a = s.activities.find((x) => x.id === id);
        if (a) {
          a.status = 'in-progress';
          a.as = s.todayDay;
        }
      });
      get().flash('Activity started — planned dates now tracking against actual.');
    },
    completeActivity: (id) => {
      // Task 5: completion is a CLAIM — the activity parks in awaiting-signoff and
      // only the PMC's approval of the linked closing inspection makes it done
      if (runRemoteOrQueue({ t: 'completeActivity', activityId: id }, 'Complete ' + id, () => gateway!.completeActivity(id), 'Completion claimed — the PMC’s closing sign-off will mark it done.')) return;
      const act = get().activities.find((a) => a.id === id);
      set((s) => {
        const a = s.activities.find((x) => x.id === id);
        if (a) {
          a.status = 'awaiting-signoff';
          a.ae = s.todayDay;
        }
        // demo parity with the server: a LINKED, item-bearing closing review appears
        // in the PMC queue; approving it (below) is what completes the activity
        const nums = s.reviews.map((r) => Number(/^INSP-(\d+)$/.exec(r.id)?.[1] ?? NaN)).filter((n) => !Number.isNaN(n));
        const closingId = `INSP-${(nums.length ? Math.max(...nums) : 21) + 1}`;
        s.reviews.push({
          id: closingId,
          title: 'Closing inspection: ' + (act ? act.name : id),
          zone: act?.zone ?? '',
          by: 'You (demo)',
          date: 'today',
          decided: false,
          closing: true,
          activityId: id,
          activityName: act?.name,
          items: [{ name: 'Work complete and acceptable', result: 'PASS', swatch: 'concrete', note: '', rejected: false }],
        });
        s.notifications.unshift({ text: 'Sign-off requested: ' + (act ? act.name : id), time: 'just now', color: '#C08A2D' });
      });
      get().flash('Completion claimed — the PMC’s closing sign-off will mark it done.');
    },

    // ---- daily log (phone = attendance device) ----
    checkIn: () => {
      if (!get().dailyLog) {
        get().flash('No daily log yet — start today\u2019s log first.');
        return;
      }
      set((s) => {
        if (!s.dailyLog) return;
        s.dailyLog.checkedIn = true;
        s.dailyLog.checkinTime = '8:12 AM';
      });
      get().record('Check-in 8:12 AM');
      // the site named in the toast is the LIVE project's, never seeded copy (Phase 0 Task 7)
      get().flash(get().online ? `Checked in at ${get().location || get().short} · within 60 m · selfie + time stamped.` : 'Checked in offline — will sync when signal returns.');
    },
    checkOut: () => {
      set((s) => {
        if (!s.dailyLog) return;
        s.dailyLog.checkedIn = false;
        s.dailyLog.checkinTime = null;
      });
      get().flash('Checked out. Shift hours logged.');
    },
    scanWorker: () => {
      // demo action tied to the seeded Helper row — a project with an empty crew has no row 4
      const helper = get().dailyLog?.crew[4];
      if (!helper) {
        get().flash('No crew rows on this log yet — add trades on the daily log first.');
        return;
      }
      set((s) => { const c = s.dailyLog?.crew[4]; if (c) c.count += 1; });
      get().record('QR check-in · Helper');
      get().flash('Worker checked in via QR · Helper · 9:03 AM · face verified.');
    },
    crewStep: (idx, delta) =>
      set((s) => {
        const c = s.dailyLog?.crew[idx];
        if (!c) return; // no log, or a stale index against a replaced crew list
        c.count = Math.max(0, c.count + delta);
      }),
    addProgress: () => {
      set((s) => { if (s.dailyLog) s.dailyLog.progress += 1; });
      get().record('Progress photo');
    },
    addProgressPhoto: (dataUrl, nodeId) => {
      const m = /^data:([^;]+);base64,(.*)$/.exec(dataUrl);
      if (!m) {
        get().flash('Could not read that photo — please try again.');
        return;
      }
      const [, mime, base64] = m;
      if (gateway) {
        // Location spine: tag the photo with the place it shows, if one was chosen.
        const input = { kind: 'progress' as const, mime, data: base64, ...(nodeId ? { nodeId } : {}) };
        // Phase 8 media offline queue: when offline, show the photo optimistically
        // (local data URL) and queue the upload for replay on reconnect — instead
        // of losing it. Mirrors runRemoteOrQueue for the JSON mutations.
        if (!get().online) {
          set((s) => {
            s.outbox.push({ t: 'uploadMedia', input });
            s.syncQueue.push('Progress photo');
            if (s.dailyLog) {
              s.dailyLog.photos.unshift({ url: dataUrl });
              s.dailyLog.progress += 1;
            }
          });
          persistOutbox();
          get().flash('Photo saved offline — will upload when signal returns.');
          return;
        }
        // raw-DTO reconcile: pin the reply to the scope that uploaded it — a late
        // reply must never land on ANOTHER project's daily log (finding 3)
        const scope = currentScope();
        gateway
          .uploadMedia(input)
          .then((res) => {
            if (!scopeStillCurrent(scope)) return;
            set((s) => {
              if (!s.dailyLog) return;
              s.dailyLog.photos.unshift({ id: res.id, url: resolveMediaUrl(res.url) });
              s.dailyLog.progress += 1;
            });
            get().flash('Progress photo uploaded — geo + time stamped, visible to PMC.');
          })
          .catch(() => get().flash('Could not upload the photo — please try again.'));
        return;
      }
      // local demo: keep the data URL as the image source; also place it on the tree
      // (with the chosen node) so the Place view reflects it without a server.
      set((s) => {
        if (s.dailyLog) {
          s.dailyLog.photos.unshift({ url: dataUrl });
          s.dailyLog.progress += 1;
        }
        s.photos.unshift({ id: `demo-photo-${s.photos.length + 1}`, url: dataUrl, nodeId: nodeId ?? undefined, kind: 'progress' });
      });
      get().record('Progress photo');
      get().flash(get().online ? 'Progress photo added — geo + time stamped.' : 'Photo saved offline — will upload when signal returns.');
    },
    submitDailyLog: () => {
      const dl = get().dailyLog;
      if (!dl) {
        get().flash('No daily log yet — start today\u2019s log first.');
        return;
      }
      if (!dl.checkedIn) {
        get().flash('Please check in at site before submitting the daily log.');
        return;
      }
      const logPayload = { checkedIn: dl.checkedIn, checkinTime: dl.checkinTime, progress: dl.progress, crew: dl.crew };
      // Task 10 correction round 2 (finding 1): WRITE-AHEAD — the op + its key are persisted before the
      // network call (online too), so a lost response is retried under the SAME key, submitting once.
      const submitKey = newIdempotencyKey();
      if (runWriteAhead({ t: 'submitDailyLog', log: logPayload, idempotencyKey: submitKey }, 'Submit daily log', 'Daily site log sent to PMC — attendance, materials & photos attached.')) return;
      set((s) => { if (s.dailyLog) s.dailyLog.submitted = true; });
      get().record('Daily log submit');
      get().flash(get().online ? 'Daily site log sent to PMC — attendance, materials & photos attached.' : 'Saved offline — log will upload to PMC when signal returns.');
    },
    flagMismatch: (idx) => {
      const mat = get().dailyLog?.materials[idx];
      if (!mat) return; // no log, or a stale index against a replaced materials list
      const flagKey = newIdempotencyKey();
      // finding 1: WRITE-AHEAD — persist the op + key before the call; a lost response replays the SAME
      // key, flagging exactly once.
      if (runWriteAhead({ t: 'flagMismatch', decisionId: mat.decisionId, idempotencyKey: flagKey }, 'Flag ' + mat.decisionId, 'Mismatch flagged — PMC alerted and the linked activity is now blocked.')) return;
      set((s) => {
        const m = s.dailyLog?.materials[idx];
        if (m) m.matched = false;
        s.activities.forEach((a) => {
          if (a.decisionId === mat.decisionId) {
            a.gm = 'fail';
            a.status = a.status === 'done' ? a.status : 'blocked';
            a.block = 'Material ≠ approved';
          }
        });
        s.notifications.unshift({ text: 'Material mismatch: ' + mat.name + ' ≠ approved ' + mat.decisionId, time: 'just now', color: '#B23A34' });
      });
      get().record('Material mismatch flag');
      get().flash('Mismatch flagged — PMC alerted and the linked activity is now blocked.');
    },
    record: (label) => {
      if (!get().online) set((s) => { s.syncQueue.push(label); });
    },
    toggleOnline: () => {
      const goingOnline = !get().online;
      set((s) => { s.online = goingOnline; });
      if (!goingOnline) {
        get().flash('Signal lost — the app keeps working, updates will queue.');
        return;
      }
      // back online: replay queued API mutations (Phase 8 outbox); else clear demo labels
      if (get().outbox.length) {
        get().flushOutbox();
        return;
      }
      if (get().syncQueue.length) {
        const n = get().syncQueue.length;
        set((s) => { s.syncQueue = []; });
        get().flash(n + ' offline update' + (n > 1 ? 's' : '') + ' synced to server.');
      }
    },
    flushOutbox: async (opts) => {
      if (!gateway) return;
      // finding 1 — serialize flushes: a write-ahead command fires a flush per command, so one may be
      // in flight already. Coalesce (mark + return); the in-flight flush re-runs once after it settles,
      // so a command persisted mid-flush is still sent. Idempotency keys make an overlap harmless.
      if (outboxFlushing) { outboxFlushQueued = true; return; }
      outboxFlushing = true;
      try {
      const ops = get().outbox.slice();
      if (ops.length === 0) return;
      // gate round-2 finding 2: the flush is about to change the durable truth
      // (confirmed uploads delete rows, terminal failures dead-letter them) — any
      // reconciliation already in flight read the PRE-flush world and must not apply
      invalidateEvidenceReconciles();
      // Pin EVERYTHING this flush uses to the moment it started (Codex gate
      // finding 1): the gateway instance, the (project, generation) scope, the
      // session, and the storage key the queue belongs to. The module-level
      // `gateway` is swapped on a project switch — reading it live mid-loop
      // would replay project A's remaining operations INTO project B.
      const flushGateway = gateway;
      const flushScope = currentScope();
      const flushToken = get().sessionToken;
      const flushKey = outboxKey();
      // gate round 11: take the ordering lease NOW, before replaying the first op.
      // The reconcile snapshot below is applied through the coordinator against this
      // lease, so if a newer socket/mutation lease begins while a replay is in flight
      // the flush's (older) snapshot is `superseded` and discarded instead of stomping
      // the newer checklist. This is the reviewer's manifestation #1 — the core bug.
      const flushLease = beginSnapshotLease(flushScope);

      // Replay in order, one at a time, committing progress as we go so a later failure
      // never re-runs an op that already succeeded. A permanently-rejected op (terminal
      // 4xx) is dropped instead of wedging the queue forever; a transient failure stops
      // the flush and keeps that op (and everything after it) for the next reconnect.
      let lastSnap: ApiSnapshot | null = null;
      let synced = 0;
      let dropped = 0;
      let stoppedAt = -1;
      let scopeMoved = false;
      for (let i = 0; i < ops.length; i++) {
        // live check BEFORE each replay: if the project or session changed while a
        // previous op was in flight, the rest of this queue belongs to the OLD
        // scope — stop, and leave it persisted there for that scope's next flush.
        if (!scopeStillCurrent(flushScope) || get().sessionToken !== flushToken) {
          stoppedAt = i;
          scopeMoved = true;
          break;
        }
        try {
          lastSnap = await replayOutboxOp(flushGateway, ops[i]);
          synced += 1;
        } catch (err) {
          if (isTerminalOutboxError(err)) {
            dropped += 1; // server will never accept this one — discard and keep going
            continue;
          }
          stoppedAt = i; // transient — retry this op and the rest on the next reconnect
          break;
        }
      }

      // Re-check AFTER the loop too (round 2): a switch that lands while the FINAL
      // op is in flight never hits the pre-iteration guard — without this, the
      // normal reconcile below would replace and persist the NEW scope's queue
      // with this flush's (empty) result, silently dropping that scope's work.
      if (!scopeMoved && (!scopeStillCurrent(flushScope) || get().sessionToken !== flushToken)) {
        scopeMoved = true;
      }

      const remaining = stoppedAt >= 0 ? ops.slice(stoppedAt) : [];
      if (scopeMoved) {
        // The in-memory outbox now belongs to the NEW scope (hydrateOutbox swapped
        // it) — don't touch it. Persist the un-replayed remainder (plus anything the
        // old scope queued during the flush) under the ORIGINAL key so it replays
        // there on that scope's next reconnect, and skip the reconcile snapshot.
        try {
          const storage = globalThis.localStorage;
          if (storage) {
            const stored: unknown = JSON.parse(storage.getItem(flushKey) ?? '[]');
            // the flushed ops were the stored queue's prefix — drop the replayed part
            const leftover = Array.isArray(stored) && stored.length >= ops.length
              ? [...remaining, ...stored.slice(ops.length)]
              : remaining;
            storage.setItem(flushKey, JSON.stringify(leftover));
          }
        } catch {
          /* storage unavailable — the persisted queue simply keeps its pre-flush state */
        }
        return;
      }

      // Preserve anything queued while we were awaiting (shouldn't happen once online, but
      // never drop a write): the original ops were the outbox prefix, so slice past them.
      const appended = get().outbox.slice(ops.length);
      set((s) => {
        s.outbox = [...remaining, ...appended];
        s.syncQueue = []; // local-only labels (check-in, QR) are considered synced on reconnect
        // gate round 8: the queue changed — a queued submit may have replayed or
        // been dropped (terminal 4xx). Re-derive the freeze so a dropped submit
        // UNLOCKS the checklist (a successful replay lands `submitted` via the
        // snapshot below, which reconciles it to read-only).
        reconcileSubmission(s);
      });
      persistOutbox();
      // finding 1 — a write-ahead command passes its own success toast (`okMsg`); the reconcile
      // announces it on `applied`. In that case suppress the batch "N synced" line below (the okMsg
      // already reported success), but still surface the error parts (dropped / still-pending).
      if (lastSnap) consumeSnapshotResult(acceptSnapshot(lastSnap, flushLease), opts?.okMsg, flushLease.scope);

      const parts: string[] = [];
      if (synced > 0 && !opts?.okMsg) parts.push(`${synced} offline update${synced > 1 ? 's' : ''} synced`);
      if (dropped > 0) parts.push(`${dropped} could not be applied and ${dropped > 1 ? 'were' : 'was'} discarded`);
      if (remaining.length > 0) parts.push(`${remaining.length} still pending — will retry when you reconnect`);
      if (parts.length) get().flash(parts.join('; ') + '.');
      // evidence reconcile: uploaded bytes were cleaned up; terminal rejections moved
      // to FAILED; an op kept alive by a failed dead-letter write stays covered
      void reconcileEvidence();
      } finally {
        outboxFlushing = false;
        // a command persisted DURING this flush was not replayed here — flush it now (plain, no okMsg,
        // so its success shows via the batch summary). Bounded: the rerun fires at most once per settle.
        if (outboxFlushQueued) {
          outboxFlushQueued = false;
          if (get().online && get().outbox.length > 0) void get().flushOutbox();
        }
      }
    },
    hydrateOutbox: () => {
      try {
        const storage = globalThis.localStorage;
        if (storage) {
          // one-time migration: adopt the old unscoped queue into the current scope
          const legacy = storage.getItem(LEGACY_OUTBOX_KEY);
          if (legacy) {
            storage.removeItem(LEGACY_OUTBOX_KEY);
            if (!storage.getItem(outboxKey())) storage.setItem(outboxKey(), legacy);
          }
          // REPLACE the in-memory queue with this scope's persisted one (WEB-02) —
          // called again on every sign-in / project switch, so ops queued under a
          // different user or project never leak into the current context.
          const raw = storage.getItem(outboxKey());
          const ops = raw ? (JSON.parse(raw) as OutboxOp[]) : [];
          set((s) => {
            s.outbox = Array.isArray(ops) ? ops : [];
            // gate round 8: rebuild an offline submit's freeze from the durable
            // outbox, so a reload keeps the checklist frozen until the queued
            // submit replays (also covered from the snapshot side by applySnapshot).
            reconcileSubmission(s);
          });
        }
      } catch {
        /* ignore malformed storage */
      }
      // gate finding 2: localStorage is only a CACHE of the queue — the durable
      // evidence rows are canonical. Merge every pending row back into replay
      // (reconstructing ops a failed/absent setItem lost) and refresh the UI
      // mirrors — this runs even when localStorage is unavailable entirely.
      void reconcileEvidence();
    },

    // ---- team access / login ----
    accWho: (who) =>
      set((s) => {
        s.access.who = who;
        // team → phone+OTP; trade → pick trade first; worker → tap-photo badge
        s.access.step = who === 'worker' ? 'badge' : who === 'trade' ? 'trade' : 'phone';
        s.access.otp = '';
        s.access.error = null;
        s.access.devCode = null;
      }),
    accTrade: (t) =>
      set((s) => {
        s.access.trade = t;
        s.access.step = 'phone';
        s.access.otp = '';
        s.access.error = null;
        s.access.devCode = null;
      }),
    accSetPhone: (v) =>
      set((s) => {
        s.access.phone = v.replace(/\D/g, '').slice(0, 10);
        s.access.error = null;
      }),
    accGoLogin: () =>
      set((s) => {
        s.access.generation += 1;
        s.access.step = 'login';
        s.access.error = null;
        s.access.sending = false;
        s.access.passwordRequestId = null;
        s.access.passwordSetupToken = null;
      }),
    login: (email, password) => {
      const em = email.trim().toLowerCase();
      if (!em || !password) {
        set((s) => { s.access.error = 'Enter your email and password.'; });
        return;
      }
      if (gateway) {
        set((s) => { s.access.sending = true; s.access.error = null; });
        gateway
          .login(em, password)
          .then((res) => applyAuthResult(res))
          .catch(() => set((s) => { s.access.sending = false; s.access.error = 'Wrong email or password.'; }));
        return;
      }
      // local demo: map the seeded demo emails to their role (any password)
      const role = em.startsWith('pmc@') ? 'pmc' : em.startsWith('client@') ? 'client' : em.startsWith('contractor@') ? 'contractor' : null;
      if (!role) {
        set((s) => { s.access.error = 'Demo: use pmc@ / client@ / contractor@vitan.in.'; });
        return;
      }
      set((s) => {
        s.role = role;
        s.screen = screensFor(role)[0].key;
        s.access = freshAccess(s.access.generation + 1);
      });
      get().flash('Signed in as ' + role + ' (demo).');
    },
    accSetEmail: (v) =>
      set((s) => { s.access.email = v; s.access.error = null; }),
    accGoPasswordSetup: () =>
      set((s) => {
        s.access.generation += 1;
        s.access.step = 'password-email';
        s.access.otp = '';
        s.access.error = null;
        s.access.sending = false;
        s.access.passwordRequestId = null;
        s.access.passwordSetupToken = null;
      }),
    requestPasswordSetup: () => {
      const email = get().access.email.trim().toLowerCase();
      if (get().access.sending) return;
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
        set((s) => { s.access.error = 'Enter a valid invited email address.'; });
        return;
      }
      if (!gateway) {
        set((s) => { s.access.error = 'Password setup needs the live server.'; });
        return;
      }
      let generation = 0;
      set((s) => {
        s.access.generation += 1;
        generation = s.access.generation;
        s.access.sending = true;
        s.access.error = null;
        s.access.passwordRequestId = null;
        s.access.passwordSetupToken = null;
      });
      gateway.passwordCredentialRequest(email)
        .then((result) => {
          if (get().access.generation !== generation) return;
          set((s) => {
            s.access.sending = false;
            s.access.step = 'password-code';
            s.access.otp = '';
            s.access.passwordRequestId = result.requestId;
          });
        })
        .catch(() => {
          if (get().access.generation !== generation) return;
          set((s) => { s.access.sending = false; s.access.error = 'Could not send the code. Please try again.'; });
        });
    },
    verifyPasswordSetup: () => {
      const access = get().access;
      if (!gateway || !access.passwordRequestId || access.otp.length !== 6 || access.sending) return;
      let generation = 0;
      const requestId = access.passwordRequestId;
      const code = access.otp;
      set((s) => {
        s.access.generation += 1;
        generation = s.access.generation;
        s.access.sending = true;
        s.access.error = null;
      });
      gateway.passwordCredentialVerify(requestId, code)
        .then((result) => {
          if (get().access.generation !== generation) return;
          set((s) => {
            s.access.sending = false;
            s.access.step = 'password-create';
            s.access.otp = '';
            s.access.passwordSetupToken = result.setupToken;
          });
        })
        .catch(() => {
          if (get().access.generation !== generation) return;
          set((s) => { s.access.sending = false; s.access.otp = ''; s.access.error = 'Wrong or expired code. Request a new code and try again.'; });
        });
    },
    completePasswordSetup: (password, confirmation) => {
      const access = get().access;
      if (access.sending) return;
      if (password !== confirmation) {
        set((s) => { s.access.error = 'Passwords do not match.'; });
        return;
      }
      if (password.length < 12 || password.length > 128) {
        set((s) => { s.access.error = 'Use a password between 12 and 128 characters.'; });
        return;
      }
      if (!gateway || !access.passwordSetupToken) {
        set((s) => { s.access.error = 'This setup link expired. Request a new code.'; });
        return;
      }
      const setupToken = access.passwordSetupToken;
      let generation = 0;
      set((s) => {
        s.access.generation += 1;
        generation = s.access.generation;
        s.access.sending = true;
        s.access.error = null;
      });
      gateway.passwordCredentialComplete(setupToken, password)
        .then((result) => {
          if (get().access.generation !== generation) return;
          applyAuthResult(result, { msg: 'Password saved. You are signed in.' });
        })
        .catch(() => {
          if (get().access.generation !== generation) return;
          set((s) => { s.access.sending = false; s.access.error = 'Could not save the password. Request a new code and try again.'; });
        });
    },
    accGoEmailOtp: () =>
      set((s) => {
        s.access.generation += 1;
        s.access.step = 'emailentry';
        s.access.otp = '';
        s.access.error = null;
        s.access.devCode = null;
        s.access.sending = false;
      }),
    requestEmailOtp: () => {
      const email = get().access.email.trim().toLowerCase();
      if (get().access.sending) return;
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
        set((s) => { s.access.error = 'Enter a valid email address.'; });
        return;
      }
      if (!gateway) {
        set((s) => { s.access.step = 'emailcode'; s.access.otp = ''; s.access.error = null; s.access.devCode = null; });
        return;
      }
      set((s) => { s.access.sending = true; s.access.error = null; });
      gateway
        .emailOtpRequest(email)
        .then((r) => {
          set((s) => {
            s.access.sending = false;
            s.access.step = 'emailcode';
            s.access.otp = '';
            s.access.devCode = r.devCode ?? null;
          });
        })
        .catch(() => set((s) => { s.access.sending = false; s.access.error = 'Could not send the code — please try again.'; }));
    },
    accSetCode: (v) =>
      set((s) => { s.access.otp = v.replace(/\D/g, '').slice(0, 6); s.access.error = null; }),
    emailOtpVerify: () => {
      const { email, otp, sending } = get().access;
      if (otp.length < 4 || sending) return;
      if (!gateway) {
        localEmailSignIn(email.trim().toLowerCase());
        return;
      }
      set((s) => { s.access.sending = true; s.access.error = null; });
      gateway
        .emailOtpVerify(email.trim().toLowerCase(), otp)
        .then((res) => applyAuthResult(res))
        .catch(() => set((s) => { s.access.sending = false; s.access.otp = ''; s.access.error = 'Wrong or expired code — try again.'; }));
    },
    googleSignIn: (idToken) => {
      if (!gateway) {
        get().flash('Google sign-in needs the server — not available in the local demo.');
        return;
      }
      set((s) => { s.access.sending = true; s.access.error = null; });
      gateway
        .googleSignIn(idToken)
        .then((res) => applyAuthResult(res))
        .catch(() => set((s) => { s.access.sending = false; s.access.error = 'Google sign-in failed — please try again.'; }));
    },
    requestOtp: () => {
      const { phone, sending } = get().access;
      if (sending) return;
      if (phone.length < 10) {
        set((s) => { s.access.error = 'Enter a 10-digit mobile number.'; });
        return;
      }
      // local demo (no API): skip straight to the code screen
      if (!gateway) {
        set((s) => {
          s.access.step = 'otp';
          s.access.otp = '';
          s.access.error = null;
          s.access.devCode = null;
        });
        return;
      }
      set((s) => { s.access.sending = true; s.access.error = null; });
      gateway
        .requestOtp(phone)
        .then((r) => {
          set((s) => {
            s.access.sending = false;
            s.access.step = 'otp';
            s.access.otp = '';
            s.access.devCode = r.devCode ?? null;
          });
        })
        .catch((e: unknown) => {
          const status = (e as { status?: number } | null)?.status;
          set((s) => {
            s.access.sending = false;
            // 429 = throttled; anything else = the code couldn't be delivered to this
            // number (e.g. no Telegram / SMS not provisioned) — steer office roles to email.
            s.access.error =
              status === 429
                ? 'Too many attempts — wait a minute, then try again.'
                : 'Couldn’t text a code to this number. Architect, client or contractor? Use “Sign in with email” below.';
          });
        });
    },
    otpPress: (d) => {
      const cur = get().access.otp;
      if (get().access.sending) return;
      if (d === 'del') {
        set((s) => { s.access.otp = cur.slice(0, -1); s.access.error = null; });
        return;
      }
      if (cur.length >= 4) return;
      const otp = cur + d;
      set((s) => { s.access.otp = otp; s.access.error = null; });
      if (otp.length === 4) setTimeout(() => get().otpVerify(), 250);
    },
    otpVerify: () => {
      const a = get().access;
      if (a.otp.length < 4 || a.sending) return;

      // team → sign in with the REAL role the server returns (a phone can belong to
      // any provisioned member — client / contractor / pmc / engineer), not always
      // engineer; trade → local scoped mistri view. The demo (no server) defaults to
      // engineer, the on-site onboarding persona.
      const signIn = (name: string | null, token: string | null, role: Role, projectId?: string): void => {
        if (a.who === 'team') {
          if (token) {
            // real session: adopt token + role + the token's project identity
            applyAuthResult({ role, token, name: name ?? undefined, projectId }, { msg: 'Verified ✓ — signed in as ' + (name ?? role) + '.' });
            return;
          }
          // local demo: persona sign-in, no token/project change
          set((s) => {
            s.role = role;
            s.screen = screensFor(role)[0].key;
            s.sessionToken = null;
            s.userName = name;
            s.access = freshAccess(s.access.generation + 1);
          });
          get().flash('Verified ✓ — signed in as ' + (name ?? role) + '.');
        } else {
          set((s) => { s.access.step = 'tradehome'; s.access.sending = false; });
          get().flash('Verified ✓ — ' + (a.trade ?? '') + ' in-charge signed in.');
        }
      };

      // local demo (no API): any 4-digit code signs in as the demo engineer
      if (!gateway) {
        signIn(null, null, 'engineer');
        return;
      }

      set((s) => { s.access.sending = true; s.access.error = null; });
      gateway
        .verifyOtp(a.phone, a.otp)
        .then((res) => signIn(res.name ?? null, res.token, res.role, res.projectId))
        .catch(() => {
          set((s) => {
            s.access.sending = false;
            s.access.otp = '';
            s.access.error = 'Wrong or expired code — try again.';
          });
        });
    },
    pickWorker: (w) => {
      // best-effort: register the device server-side (proves the endpoint); the
      // job card is a self-contained local view either way.
      if (gateway) gateway.workerToken(w.name, w.trade).catch(() => {});
      set((s) => {
        s.access.worker = w;
        s.access.step = 'jobcard';
      });
    },
    accReset: () => set((s) => { s.access = freshAccess(s.access.generation + 1); }),
    speakJob: () => {
      const langName = { en: 'English', hi: 'Hindi', gu: 'Gujarati' }[get().lang];
      get().flash('🔊 Reading the job aloud in ' + langName + '…');
    },
    workerDone: () => {
      const w = get().access.worker;
      get().flash('✓ ' + (w ? w.name : 'Worker') + ' marked today’s work done — sent to engineer.');
      get().accReset();
    },
    };
  }),
);
