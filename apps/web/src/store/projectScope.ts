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
  MeasurementRegisterDto,
} from '@vitan/shared';
import type { MaterialsView } from './materials';
import type { LabourView } from './labour';
import type { CommercialBillRow, CommercialClaimView, CommercialView } from './commercial';
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
  /** Phase 5 Task 7B-iii-a (§M) — the COALESCE keys of commercial commands still in flight.
   *  Project-owned like every other pending set: a switch tears it down, so a disabled button
   *  can never survive into a project whose outbox does not contain that op. */
  commercialPending: string[];
  labourPending: string[];
  // Phase 5 Task 7B-i (§M) — the pilot COMMERCIAL money-position bundle. Project-owned like the
  // other two hubs, so switching project cannot leave one project's money on another's screen.
  // 7B-i was READ ONLY and said so here; 7B-iii-a lands the first write commands, so
  // `commercialPending` now sits above with the other pending sets.
  commercialView: CommercialView | null;
  commercialBills: CommercialBillRow[] | null;
  commercialClaims: Record<string, CommercialClaimView>;
  /** §D — one labour PO line's measurement register, keyed by line id. The claim bundle reports
   *  registers only for a LIVE version's lines, and a lodged claim is `draft`, so this is the read
   *  a measurement becomes VISIBLE in. Project-owned: a line id is project-contained. */
  commercialLineRegisters: Record<string, MeasurementRegisterDto>;
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
    commercialPending: [],
    labourPending: [],
    commercialView: null,
    // Task 7B-ii — the claim list and every opened claim's lifecycle are PROJECT data: a claim id
    // is project-contained, so carrying either across a switch would render another site's money.
    commercialBills: null,
    commercialClaims: {},
    commercialLineRegisters: {},
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
  commercialLoad: 'idle' | 'loading' | 'ready' | 'error';
  // Task 7B-ii — the claim-list status, and the PER-CLAIM lifecycle status keyed by bill id. The
  // per-claim map is torn down wholesale rather than pruned: every key in it names a claim in the
  // scope being left, so nothing in it can be valid in the next one.
  commercialBillsLoad: 'idle' | 'loading' | 'ready' | 'error';
  commercialClaimLoad: Record<string, 'loading' | 'ready' | 'error'>;
  /** §D — the per-LINE register read's status, keyed by labour PO line id. */
  commercialLineRegisterLoad: Record<string, 'loading' | 'ready' | 'error'>;
  /**
   * Codex I2 — WHEN each of these two reads last SUCCEEDED, on one monotonic counter.
   *
   * The claim list and the claim bundle both carry a bill's `status`, and three rounds of this PR
   * have now guessed which of the two is fresher from a proxy: "has a claim" (F4), then "has a
   * claim that did not error" (H4). A proxy for freshness goes wrong the moment the two reads move
   * independently — which is the normal case, since they have separate tokens and separate
   * failures. Recording the ordering makes the question decidable instead of heuristic, so the
   * screen compares two facts rather than standing something else in for them.
   *
   * A counter, not a clock: it needs to order two events in one tab, which is exactly what a
   * monotonic integer does, without a wall clock's determinism problems in tests.
   */
  commercialBillsStamp: number;
  commercialClaimStamp: Record<string, number>;
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
    commercialLoad: 'idle',
    commercialBillsLoad: 'idle',
    commercialClaimLoad: {},
    commercialLineRegisterLoad: {},
    commercialBillsStamp: 0,
    commercialClaimStamp: {},
  };
}

export function isCurrentProjectScope(
  currentProjectId: string,
  currentGeneration: number,
  captured: ProjectScope,
): boolean {
  return currentProjectId === captured.projectId && currentGeneration === captured.generation;
}
