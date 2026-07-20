/**
 * Phase 2 Task 10 (Module 4) — the ACTIVITIES module contract (shared, runtime-importable on both sides).
 *
 * The Site Activity spine (activities + phases + gate overrides) is reached ONLY through this contract
 * (its commands + queries) and the published `activity.*`/`phase.*` events. This module defines the SHAPE
 * of that contract — the command names, the query names, and the module-owned HTTP read result — as plain
 * data both the API and the web import. The API validates the command inputs at its request boundary (the
 * Zod schemas in `apps/api/src/contracts.ts`); the module's `ActivitiesService`/`PhasesService`/
 * `ActivitiesQueryService` implement the command/query behavior; the boundary check proves no other module
 * reads its persistence directly.
 *
 * NOTE the atomic workflow edges stay workflow contracts, not events, and are NOT loosened by this
 * read/idempotency extraction:
 *  • edge 1 — `activities.complete` creates the linked closing inspection THROUGH the inspections
 *    participant in the SAME transaction;
 *  • edges 2/3 — a closing inspection's decide writes the activity sign-off/revert THROUGH this module's
 *    `ActivityParticipant`;
 *  • edge 4 — the daily-log material mismatch blocks the activity THROUGH the same participant;
 *  • edge 8 — project initialization instantiates activities/phases THROUGH the participant.
 */

import type { Activity, Phase } from '../domain/types';

/** The activities module's state-changing commands (must equal the manifest `commands`). */
export const ACTIVITIES_COMMANDS = [
  'activities.create',
  'activities.update',
  'activities.remove',
  'activities.start',
  'activities.complete',
  'activities.override',
  'activities.revokeOverride',
  'phases.create',
  'phases.remove',
  // Phase 3 Task 1 — the ActivityRequirement demand contract (append-only revisions; pmc authority).
  'requirements.create',
  'requirements.revise',
  'requirements.cancel',
] as const;
export type ActivitiesCommand = (typeof ACTIVITIES_COMMANDS)[number];

/** The activities module's read queries (must equal the manifest `queries`). */
export const ACTIVITIES_QUERIES = [
  'activities.snapshotSlice',
  // Task 10 — the same slices served from the module's rebuildable projection.
  'activities.projectionSlice',
  'activities.existsInProject',
  'activities.resolveRef',
  // Phase 3 Task 1 — the module-owned requirements read (capability-gated; 404 on non-pilot projects).
  'requirements.list',
] as const;
export type ActivitiesQuery = (typeof ACTIVITIES_QUERIES)[number];

/**
 * `GET …/activities` — the MODULE-OWNED read the frontend fetches under XOR read-ownership (Task 10).
 * The COMPLETE HTTP result, defined ONCE here so the API's `ActivitiesQueryService.moduleActivities` and
 * the web gateway model the SAME shape (no drifting duplicate). It carries the SAME two snapshot keys the
 * activity spine owns:
 *  • `activities` — every activity with its own facts (dates, status, stored flags, ACTIVE overrides) AND
 *    its DERIVED five-gate `readiness`. Readiness is baked FRESH at read time from the decisions/
 *    inspections/drawings query contracts — it is never stored in the projection (a stored conclusion
 *    would go stale under foreign events the activities projection does not consume).
 *  • `phases` — the phase rollup (counts + donePct) computed from those activities.
 * PLUS two observability fields:
 *  • `source` — which path served the ACTIVITY-OWNED base: the rebuildable projection, or the live
 *    canonical fallback.
 *  • `generation` — the served projection generation, non-null ONLY when served from a safe, caught-up
 *    projection (finding 1); `null` on the live-fallback path.
 */
export interface ActivitiesModuleResult {
  readonly activities: readonly Activity[];
  readonly phases: readonly Phase[];
  readonly source: 'projection' | 'live';
  readonly generation: number | null;
}

/** `activities.existsInProject` — validate an activity reference belongs to a project. NOTE the modules
 *  that STORE an `activityId` (inspections, drawings) sit UPSTREAM of activities in the dependsOn graph
 *  (activities depends on them), so they cannot take this query without a cycle — their references are
 *  validated by the composite `(projectId, activityId) → Activity(projectId, id)` tenant FKs at the
 *  database, with the violation translated to the same readable 400 at the app layer. */
export interface ActivityRefQuery {
  readonly projectId: string;
  readonly activityId: string;
}
