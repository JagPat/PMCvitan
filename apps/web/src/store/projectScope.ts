import type {
  Activity,
  AppNotification,
  Checklist,
  DailyLog,
  Decision,
  Drawing,
  Material,
  Phase,
  Photo,
  PlacedInspection,
  ProjectCompany,
  ProjectMember,
  ProjectNode,
  Review,
  ReservationPlan,
} from '@vitan/shared';
import type { MaterialsView } from './materials';
import type { LabourView } from './labour';
import type { AllocateLabourInput } from '../data/apiGateway';

/**
 * The frontend project-scope lifecycle (Phase 0 Task 2).
 *
 * 'idle'      — no API scope in play (local demo, or before the first fetch)
 * 'switching' — an /auth/switch is in flight; project data is ALREADY empty
 * 'loading'   — authenticated for the active project; awaiting its snapshot
 * 'ready'     — the active project's snapshot is applied
 * 'error'     — the switch or snapshot failed; data stays empty, recoverable
 */
export type ProjectLoadState = 'idle' | 'switching' | 'loading' | 'ready' | 'error';

/** Captured at request time; a response only applies if the scope is unchanged. */
export interface ProjectScope {
  projectId: string;
  generation: number;
}

/** Every project-owned field. One project's records never render under another's. */
export interface ProjectDataState {
  decisions: Decision[];
  nodes: ProjectNode[];
  checklist: Checklist | null;
  reviews: Review[];
  activeReviewId: string | null;
  reinspectionCreated: boolean;
  drawings: Drawing[];
  photos: Photo[];
  materials: Material[];
  placedInspections: PlacedInspection[];
  phases: Phase[];
  members: ProjectMember[];
  activities: Activity[];
  dailyLog: DailyLog | null;
  notifications: AppNotification[];
  companies: ProjectCompany[];
  // Phase 3 Task 7 — the PER-PROJECT pilot capabilities (`['materials']` on a pilot project) + the
  // Materials bundle. Project-owned, so they tear down on every scope change: a non-pilot / freshly
  // switched project shows NO Materials nav until its shell reloads the capability (never stale).
  capabilities: string[];
  // Phase 4 Task 6 correction (Codex F-deeplink) — whether the shell has REPORTED the active
  // project's capabilities yet. Reset with `capabilities` on every scope change so RouteBridge
  // treats the next project's capability set as unknown (no premature deep-link bounce) until its
  // own shell lands.
  capabilitiesKnown: boolean;
  materialsView: MaterialsView | null;
  // Phase 3 Task 7 (correction 2) — the SERVER-computed reservation plan per activity whose cover UI is
  // open (canonical reserve candidates + the residual to requisition), and the in-flight materials
  // command keys (for coalescing + disable-while-pending). BOTH are project-owned: a scope change tears
  // them down so a stale plan/pending key never leaks into another project's Materials hub.
  reservationPlans: Record<string, ReservationPlan>;
  materialsPending: string[];
  // Phase 4 Task 6 (§J) — the pilot Labour bundle + the in-flight labour field-op coalesce keys.
  // Project-owned exactly like the materials pair: a scope change tears them down so a stale
  // labour bundle / pending key never leaks into another project's Labour hub.
  labourView: LabourView | null;
  labourPending: string[];
  /** Codex round 13 — the ORIGINAL allocate input per retained coalesce key. The key alone (round
   *  11's parser) loses `capacityCommitmentId`, so in the success→reload gap a resolved
   *  supplier-backed draw stopped reserving its commitment and a second same-slice worker was
   *  sent WITH the drawn commitment (a deterministic drawdown 409/drop) instead of own
   *  workforce. Lifecycle mirrors `labourPending` exactly: written at dispatch, pruned to the
   *  still-queued outbox ops whenever `labourPending` is rebuilt, torn down with the scope. */
  labourPendingInputs: Record<string, AllocateLabourInput>;
  /** Codex rounds 5+8 — the idempotency keys held for submitted roster onboarding forms, keyed
   *  BY FORM SIGNATURE (round 8: a single slot lost form A's key the moment form B was submitted
   *  while A was unresolved — A's retry then minted a fresh key and could duplicate the Worker).
   *  Each entry is reused verbatim on a retry of the SAME form and cleared only by that form's
   *  CONFIRMED success or a scope teardown. */
  labourOnboardPending: Record<string, string>;
  /** Codex rounds 6+8 — the same signature-keyed held-key discipline for the device-bind
   *  command: a committed-but-lost bind retried with a FRESH key is the server's "already bound
   *  to this worker" 409 (the CAS is on the still-unbound row), reported as failure for a
   *  binding that succeeded. Holding the key lets the command ledger replay the original
   *  success; keying by (device, worker) signature keeps concurrent forms independent. */
  labourBindPending: Record<string, string>;
}

/** Explicit absence — null, never a fabricated ''-id record actions could mutate. */
export function emptyProjectData(): ProjectDataState {
  return {
    decisions: [],
    nodes: [],
    checklist: null,
    reviews: [],
    activeReviewId: null,
    reinspectionCreated: false,
    drawings: [],
    photos: [],
    materials: [],
    placedInspections: [],
    phases: [],
    members: [],
    activities: [],
    dailyLog: null,
    notifications: [],
    companies: [],
    capabilities: [],
    capabilitiesKnown: false,
    materialsView: null,
    reservationPlans: {},
    materialsPending: [],
    labourView: null,
    labourPending: [],
    labourPendingInputs: {},
    labourOnboardPending: {},
    labourBindPending: {},
  };
}

/**
 * The module-owned READ metadata (Phase 2 Task 9/10 XOR reads): the per-module load
 * status and the source that served the current data. These are NOT project data —
 * they describe the in-flight read — but they must be TORN DOWN alongside
 * `emptyProjectData()` on every scope teardown (a project switch, a re-auth, or a
 * sign-out). Left stale, a fresh/blank scope inherits the previous project's `ready`
 * status over its now-empty data, so the screen renders "loaded and empty" ("No daily
 * log started") instead of "loading" — the dishonest state finding 4 fixes. Reset to
 * 'idle'; the scope's first `requestFreshSnapshot` re-derives 'loading' from there.
 */
export interface ModuleReadState {
  decisionsLoad: 'idle' | 'loading' | 'ready' | 'error';
  decisionsSource: 'projection' | 'live' | null;
  dailyLogLoad: 'idle' | 'loading' | 'ready' | 'error';
  dailyLogSource: 'projection' | 'live' | null;
  drawingsLoad: 'idle' | 'loading' | 'ready' | 'error';
  drawingsSource: 'projection' | 'live' | null;
  inspectionsLoad: 'idle' | 'loading' | 'ready' | 'error';
  inspectionsSource: 'projection' | 'live' | null;
  activitiesLoad: 'idle' | 'loading' | 'ready' | 'error';
  activitiesSource: 'projection' | 'live' | null;
  // Phase 3 Task 7 — the pilot Materials bundle load status (module-query-only, greenfield; no snapshot
  // fallback, so no `source`). 'idle' on a non-pilot project; the pilot's shell load triggers 'loading'.
  materialsLoad: 'idle' | 'loading' | 'ready' | 'error';
  // Phase 4 Task 6 (§J) — the pilot Labour bundle load status (module-query-only, greenfield; no
  // snapshot fallback, so no `source`). 'idle' on a non-pilot project; the shell load triggers it.
  labourLoad: 'idle' | 'loading' | 'ready' | 'error';
}
export function emptyModuleReadState(): ModuleReadState {
  return {
    decisionsLoad: 'idle',
    decisionsSource: null,
    dailyLogLoad: 'idle',
    dailyLogSource: null,
    drawingsLoad: 'idle',
    drawingsSource: null,
    inspectionsLoad: 'idle',
    inspectionsSource: null,
    activitiesLoad: 'idle',
    activitiesSource: null,
    materialsLoad: 'idle',
    labourLoad: 'idle',
  };
}

export function isCurrentProjectScope(
  currentProjectId: string,
  currentGeneration: number,
  captured: ProjectScope,
): boolean {
  return currentProjectId === captured.projectId && currentGeneration === captured.generation;
}
