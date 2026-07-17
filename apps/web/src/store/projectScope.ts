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
} from '@vitan/shared';

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
}
export function emptyModuleReadState(): ModuleReadState {
  return { decisionsLoad: 'idle', decisionsSource: null, dailyLogLoad: 'idle', dailyLogSource: null };
}

export function isCurrentProjectScope(
  currentProjectId: string,
  currentGeneration: number,
  captured: ProjectScope,
): boolean {
  return currentProjectId === captured.projectId && currentGeneration === captured.generation;
}
