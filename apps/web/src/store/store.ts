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
import { emptyProjectData, isCurrentProjectScope, type ProjectLoadState, type ProjectScope } from './projectScope';
import { subtreeIds, ancestorIds } from '@/lib/locationTree';
import type { ApiGateway, ApiSnapshot, OutboxOp, IssueDrawingInput, AddMemberInput, AddOrgMemberInput, NewProjectInput, CompanyInput, ArchivedProject, NewActivityInput, NewDecisionInput, OrgTemplateModule, OrgProjectTemplate } from '@/data/apiGateway';
import { resolveMediaUrl, replayOutboxOp, isTerminalOutboxError, PROJECT_ID, API_BASE } from '@/data/apiGateway';
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

export interface AppState {
  role: Role;
  screen: ScreenKey;
  lang: Lang;
  notifOpen: boolean;
  toast: string | null;
  modal: ModalState;
  decisions: Decision[];
  nodes: ProjectNode[]; // the project location tree (zones → rooms → elements)
  checklist: Checklist | null; // null = no checklist issued for this project (never a ''-id sentinel)
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
  setChangeText: (v: string) => void;
  setChangeCost: (v: string) => void;
  setChangeTime: (v: string) => void;
  // inspection (engineer checklist)
  setItem: (idx: number, val: Exclude<ItemState, null>) => void;
  addPhoto: (idx: number) => void;
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
  flushOutbox: () => void;
  hydrateOutbox: () => void;
  // team access
  accWho: (who: Exclude<AccessWho, null>) => void;
  accTrade: (t: string) => void;
  accSetPhone: (v: string) => void;
  accGoLogin: () => void;
  login: (email: string, password: string) => void;
  accSetEmail: (v: string) => void;
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
  /** Apply a snapshot only if it belongs to the CURRENT scope (project id + generation
   *  captured when the request was issued). Returns true only when applied, so callers
   *  can't mark a stale response as ready. */
  applySnapshot: (snap: ApiSnapshot, capturedScope?: ProjectScope) => boolean;
}

export type Store = AppState & AppActions;

let toastTimer: ReturnType<typeof setTimeout> | undefined;

/** A pristine access-flow state (used to init and to reset after sign-out). */
function freshAccess(): AccessState {
  return { step: 'who', who: null, trade: null, phone: '', email: '', otp: '', worker: null, sending: false, error: null, devCode: null };
}

/** A fresh copy of the seeded initial state (deep-cloned so resets never share references). */
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
    nodes: structuredClone(SEED_NODES), // the demo location tree (server snapshot replaces it)
    checklist: structuredClone(SEED_CHECKLIST),
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

    const applySnapshot = (snap: ApiSnapshot, capturedScope?: ProjectScope): boolean => {
      // Default to the CURRENT scope for direct/local callers; network callers pass
      // the scope captured when their request was issued.
      const scope = capturedScope ?? currentScope();
      const st = get();
      // Reject a snapshot for a project we've since left, or one whose request
      // predates a scope change (generation bumped by a switch/sign-in) — applying
      // it would show the wrong project's records under the active selection.
      if (snap.project.id !== st.activeProjectId) return false;
      if (!isCurrentProjectScope(st.activeProjectId, st.projectScopeGeneration, scope)) return false;
      set((s) => {
        s.projectLoadState = 'ready'; // the active project's data has landed
        s.projectLoadError = null;
        s.pendingProjectId = null;
        s.decisions = snap.decisions;
        s.activities = snap.activities;
        // The snapshot is the whole truth for its project. checklist/dailyLog are
        // assigned DIRECTLY, including null — absence means "this project has none",
        // never "keep the previous project's".
        s.checklist = snap.checklist ?? null;
        s.reviews = snap.reviews ?? (snap.review ? [snap.review] : []);
        if (s.activeReviewId && !s.reviews.some((r) => r.id === s.activeReviewId)) s.activeReviewId = null;
        s.reinspectionCreated = snap.reinspectionCreated;
        s.drawings = snap.drawings ?? [];
        // Placed site photos come back as signed API-relative serve paths — resolve
        // them against the API base so the Place view's <img src> hits the API.
        s.photos = (snap.photos ?? []).map((p) => ({ ...p, url: resolveMediaUrl(p.url) }));
        s.materials = snap.materials ?? [];
        // pmc/engineer get the placed inspections; other roles get [] from the server
        s.placedInspections = snap.placedInspections ?? [];
        s.phases = snap.phases ?? [];
        // Progress photos come back as signed, API-relative serve paths
        // (/media/:id?t=…); resolve them against the API base so the <img src>
        // hits the API, not the SPA origin. Drawings resolve at render time.
        s.dailyLog = snap.dailyLog
          ? { ...snap.dailyLog, photos: snap.dailyLog.photos.map((p) => ({ ...p, url: resolveMediaUrl(p.url) })) }
          : null;
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
      return true;
    };

    const runRemote = (call: () => Promise<ApiSnapshot>, okMsg: string): void => {
      const scope = currentScope(); // the project this mutation belongs to
      call()
        .then((snap) => {
          applySnapshot(snap, scope);
          get().flash(okMsg);
        })
        .catch(() => get().flash('Could not reach the server — please try again.'));
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
        s.access = freshAccess();
        if (res.projectId && changedProject) {
          s.activeProjectId = res.projectId; // the SERVER-returned scope, verbatim
          // If a switch already emptied the data for THIS project, don't clear twice.
          // Otherwise (sign-in adoption, or the server re-scoped us elsewhere): new
          // scope generation + empty data + blank identity until the snapshot lands.
          if (s.pendingProjectId !== res.projectId) {
            s.projectScopeGeneration += 1;
            s.name = '';
            s.short = '';
            s.descriptor = '';
            s.stage = '';
            s.siteCode = '';
            Object.assign(s, emptyProjectData());
          }
        }
        if (changedProject || wasPending) {
          s.projectLoadState = 'loading'; // authenticated; awaiting this project's snapshot
          s.projectLoadError = null;
        }
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
        s.access = freshAccess();
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
      const scope = currentScope();
      set((s) => {
        s.projectLoadState = 'loading';
        s.projectLoadError = null;
      });
      gateway
        .snapshot()
        .then((snap) => { applySnapshot(snap, scope); })
        .catch(() => set((s) => {
          if (!isCurrentProjectScope(s.activeProjectId, s.projectScopeGeneration, scope)) return;
          s.projectLoadState = 'error';
          s.projectLoadError = 'Could not load this project — check your connection and access, then retry.';
        }));
    },
    _setGateway: (g) => {
      gateway = g;
    },
    applySnapshot,

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
        s.access = freshAccess();
        s.role = 'client';
        s.screen = screensFor('client')[0].key;
        s.notifOpen = false;
        s.modal = { type: null };
        // WEB-02: quarantine this user's queued work — it stays persisted under THEIR
        // scope key and resumes on their next sign-in; the next user never replays it.
        s.outbox = [];
        s.syncQueue = [];
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
      if (runRemoteOrQueue({ t: 'approve', decisionId: decId, optionIndex: optIdx }, 'Approve ' + decId, () => gateway!.approveDecision(decId, optIdx), 'Approved & locked — saved to the server.')) return;
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
      if (runRemoteOrQueue({ t: 'change', decisionId: decId, reason, costImpact, timeImpactDays }, 'Change ' + decId, () => gateway!.requestChange(decId, reason, costImpact, timeImpactDays), 'Change Request submitted for client re-approval.')) return;
      set((s) => {
        const d = s.decisions.find((x) => x.id === decId);
        if (d) d.status = 'change';
        s.modal = { type: null };
      });
      get().flash('Change Request submitted for client re-approval.');
    },
    setChangeText: (v) => set((s) => { s.modal.changeText = v; }),
    setChangeCost: (v) => set((s) => { s.modal.changeCost = v; }),
    setChangeTime: (v) => set((s) => { s.modal.changeTime = v; }),

    // ---- engineer checklist (a null checklist = none issued; every action no-ops) ----
    setItem: (idx, val) =>
      set((s) => {
        const it = s.checklist?.items[idx];
        if (!it) return;
        it.state = it.state === val ? null : val;
      }),
    addPhoto: (idx) => set((s) => { const it = s.checklist?.items[idx]; if (it) it.photos += 1; }),
    setNote: (idx, txt) => set((s) => { const it = s.checklist?.items[idx]; if (it) it.note = txt; }),
    submitInspection: () => {
      const c = get().checklist;
      if (!c || !c.items.length) {
        get().flash('No checklist has been issued for today yet.');
        return;
      }
      const undone = c.items.filter((it) => !it.state).length;
      const failNoPhoto = c.items.filter((it) => it.state === 'fail' && it.photos === 0).length;
      if (undone > 0) {
        get().flash('Please mark all ' + c.items.length + ' items before submitting.');
        return;
      }
      if (failNoPhoto > 0) {
        get().flash('A failed item needs a photo before you can submit.');
        return;
      }
      if (runRemoteOrQueue({ t: 'submitInspection', inspectionId: c.id, items: c.items }, 'Submit inspection', () => gateway!.submitInspection(c.id, c.items), 'Inspection submitted to the architect for review.')) return;
      set((s) => {
        if (!s.checklist) return;
        s.checklist.submitted = true;
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
      if (runRemoteOrQueue({ t: 'decideReview', inspectionId: review.id, approve: true, rejectedItemNames: [] }, 'Approve inspection', () => gateway!.decideReview(review.id, true, []), 'Inspection approved. Contractor and client notified.')) return;
      set((s) => {
        const j = s.reviews.findIndex((r) => r.id === review.id);
        if (j >= 0) s.reviews[j].decided = true;
        s.activeReviewId = review.id; // keep the just-decided review on screen (REVIEWED)
      });
      get().flash('Inspection approved. Contractor and client notified.');
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
      const rejectedNames = review.items.filter((it) => it.rejected).map((it) => it.name);
      if (runRemoteOrQueue({ t: 'decideReview', inspectionId: review.id, approve: false, rejectedItemNames: rejectedNames }, 'Send re-inspection', () => gateway!.decideReview(review.id, false, rejectedNames), n + ' re-inspection task(s) created with due dates.')) return;
      set((s) => {
        s.reinspectionCreated = true;
        const j = s.reviews.findIndex((r) => r.id === review.id);
        if (j >= 0) s.reviews[j].decided = true;
        s.activeReviewId = review.id;
      });
      get().flash(n + ' re-inspection task(s) created with due dates.');
    },

    // ---- drawings register ----
    issueDrawing: (input) => {
      if (gateway) {
        gateway
          .issueDrawing(input)
          .then(() => {
            get().flash(`Drawing issued: ${input.number} Rev ${input.rev} — team notified.`);
            ((scope) => gateway!.snapshot().then((snap) => applySnapshot(snap, scope)).catch(() => {}))(currentScope());
          })
          .catch(() => get().flash('Could not issue the drawing — please try again.'));
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
            for (const id of decIds) await gw.publishDecision(id);
            for (const id of dwgIds) await gw.publishDrawing(id);
            applySnapshot(await gw.snapshot(), scope);
            done();
          } catch {
            get().flash('Could not publish every draft — some may still be drafts. Please try again.');
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
        gateway
          .acknowledgeDrawing(rev.id)
          .then(() => {
            get().flash(`Acknowledged — building to ${drawing.number} Rev ${rev.rev}.`);
            ((scope) => gateway!.snapshot().then((snap) => applySnapshot(snap, scope)).catch(() => {}))(currentScope());
          })
          .catch(() => get().flash('Could not record the acknowledgement — please try again.'));
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
      gateway.listArchivedProjects(orgId).then((rows: ArchivedProject[]) => set((s) => { s.archivedProjects = rows; })).catch(() => {});
    },
    addCompany: (input) => {
      if (!gateway) {
        get().flash('Managing companies needs the server.');
        return;
      }
      gateway
        .addCompany(input)
        .then((c) => {
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
      gateway
        .updateCompany(companyId, input)
        .then((c) => {
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
      gateway
        .removeCompany(companyId)
        .then(() => {
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
          const snap = await gw.createDecision({ title: input.title, nodeId: input.nodeId, room: input.room, options, publish: input.publish });
          applySnapshot(snap, scope);
          get().flash(
            input.publish
              ? `Decision issued: ${input.title} — the client has been asked to choose.`
              : `Draft saved: ${input.title} — visible only to you until you publish it.`,
          );
        } catch {
          get().flash(input.publish ? 'Could not issue the decision — check your access and try again.' : 'Could not save the draft — check your access and try again.');
        }
      })();
    },
    publishDecision: (decisionId) => {
      const d = get().decisions.find((x) => x.id === decisionId);
      if (!d) return;
      // API mode: the server flips publishedAt, notifies the client, and returns a fresh snapshot.
      if (gateway) {
        runRemote(() => gateway!.publishDecision(decisionId), `Published: ${d.title} — the client has been asked to choose.`);
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
        const snap = await gateway.createNode(input);
        applySnapshot(snap, scope);
        get().flash(`Added ${input.kind}: ${input.name}.`);
        // the newly-created node is the one whose id wasn't present before
        const created = get().nodes.find((n) => !before.has(n.id) && n.name === input.name && n.kind === input.kind);
        return created?.id ?? null;
      } catch {
        get().flash('Could not add the location — check your access and try again.');
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
      runRemote(() => gateway!.startDailyLog(), 'New daily log started — crew carried over at zero.');
    },
    addSiteMaterial: (input) => {
      if (!gateway) {
        get().flash('Recording materials needs the server.');
        return;
      }
      runRemote(() => gateway!.addSiteMaterial(input), `Material recorded: ${input.name}.`);
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
      if (runRemoteOrQueue({ t: 'completeActivity', activityId: id }, 'Complete ' + id, () => gateway!.completeActivity(id), 'Marked complete — a closing inspection was auto-created for sign-off.')) return;
      const act = get().activities.find((a) => a.id === id);
      set((s) => {
        const a = s.activities.find((x) => x.id === id);
        if (a) {
          a.status = 'done';
          a.ae = s.todayDay;
        }
        s.notifications.unshift({ text: 'Closing inspection auto-created: ' + (act ? act.name : ''), time: 'just now', color: '#C08A2D' });
      });
      get().flash('Marked complete — a closing inspection was auto-created for sign-off.');
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
        gateway
          .uploadMedia(input)
          .then((res) => {
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
      if (runRemoteOrQueue({ t: 'submitDailyLog', log: logPayload }, 'Submit daily log', () => gateway!.submitDailyLog(logPayload), 'Daily site log sent to PMC — attendance, materials & photos attached.')) return;
      set((s) => { if (s.dailyLog) s.dailyLog.submitted = true; });
      get().record('Daily log submit');
      get().flash(get().online ? 'Daily site log sent to PMC — attendance, materials & photos attached.' : 'Saved offline — log will upload to PMC when signal returns.');
    },
    flagMismatch: (idx) => {
      const mat = get().dailyLog?.materials[idx];
      if (!mat) return; // no log, or a stale index against a replaced materials list
      if (runRemoteOrQueue({ t: 'flagMismatch', decisionId: mat.decisionId }, 'Flag ' + mat.decisionId, () => gateway!.flagMismatch(mat.decisionId), 'Mismatch flagged — PMC alerted and the linked activity is now blocked.')) return;
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
    flushOutbox: async () => {
      if (!gateway) return;
      const ops = get().outbox.slice();
      if (ops.length === 0) return;
      // the scope this flush replays FOR — a project switch mid-flush must not let
      // the reconcile snapshot land under the new project
      const flushScope = currentScope();

      // Replay in order, one at a time, committing progress as we go so a later failure
      // never re-runs an op that already succeeded. A permanently-rejected op (terminal
      // 4xx) is dropped instead of wedging the queue forever; a transient failure stops
      // the flush and keeps that op (and everything after it) for the next reconnect.
      let lastSnap: ApiSnapshot | null = null;
      let synced = 0;
      let dropped = 0;
      let stoppedAt = -1;
      for (let i = 0; i < ops.length; i++) {
        try {
          lastSnap = await replayOutboxOp(gateway, ops[i]);
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

      const remaining = stoppedAt >= 0 ? ops.slice(stoppedAt) : [];
      // Preserve anything queued while we were awaiting (shouldn't happen once online, but
      // never drop a write): the original ops were the outbox prefix, so slice past them.
      const appended = get().outbox.slice(ops.length);
      set((s) => {
        s.outbox = [...remaining, ...appended];
        s.syncQueue = []; // local-only labels (check-in, QR) are considered synced on reconnect
      });
      persistOutbox();
      if (lastSnap) applySnapshot(lastSnap, flushScope);

      const parts: string[] = [];
      if (synced > 0) parts.push(`${synced} offline update${synced > 1 ? 's' : ''} synced`);
      if (dropped > 0) parts.push(`${dropped} could not be applied and ${dropped > 1 ? 'were' : 'was'} discarded`);
      if (remaining.length > 0) parts.push(`${remaining.length} still pending — will retry when you reconnect`);
      if (parts.length) get().flash(parts.join('; ') + '.');
    },
    hydrateOutbox: () => {
      try {
        const storage = globalThis.localStorage;
        if (!storage) return;
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
        set((s) => { s.outbox = Array.isArray(ops) ? ops : []; });
      } catch {
        /* ignore malformed storage */
      }
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
        s.access.step = 'login';
        s.access.error = null;
        s.access.sending = false;
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
        s.access = freshAccess();
      });
      get().flash('Signed in as ' + role + ' (demo).');
    },
    accSetEmail: (v) =>
      set((s) => { s.access.email = v; s.access.error = null; }),
    accGoEmailOtp: () =>
      set((s) => {
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
            s.access = freshAccess();
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
    accReset: () => set((s) => { s.access = freshAccess(); }),
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
