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
  // Phase 3 Task 2 — the same-transaction allocation read: procurement locks a requirement
  // revision FOR UPDATE and reads its required qty/UOM for the §F bound-1 guard.
  'requirements.revisionForAllocation',
  'requirements.revisionSnapshotForOrder',
  // Phase 3 Task 7 — the pilot material-readiness view (per-requirement coverage + shortage
  // forecast). Activities-owned canonical read (§A/§G/§25); capability-gated (404 on non-pilot).
  'materialReadiness.get',
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

/**
 * Phase 3 Task 7 (`GET …/activities/material-readiness`) — the pilot MATERIAL-READINESS view.
 * Activities owns the §A readiness derivation; this is its canonical READ (capability-gated, 404 on
 * non-pilot). Per-requirement coverage comes from inventory's `coverageFor` (the SAME authority
 * `activities.start` reads); the shortage list adds FORECAST IMPACT — whether the earliest covering
 * delivery lands before the activity's planned start (§25: "shortages produce forecast impact and
 * Inbox actions"). A live canonical read (never a projection), so it can never be a stale conclusion.
 */
export type MaterialCoverageVerdict = 'ready' | 'at-risk' | 'blocked';
/** covered-in-time = at-risk but the covering delivery lands before the planned start; delays-start =
 *  the covering delivery is after the planned start; no-supply = blocked with no covering commitment. */
export type ShortageImpact = 'covered-in-time' | 'delays-start' | 'no-supply';

export interface RequirementReadinessRow {
  readonly requirementId: string;
  readonly revision: number;
  readonly activityId: string;
  readonly activityName: string;
  /** human label of the §B technical identity (category · make · grade) */
  readonly material: string;
  readonly baseUom: string;
  readonly requiredQty: string; // Decimal string, base UOM
  readonly coveredQty: string; // reserved-for-this-activity + issued custody, base UOM
  readonly shortfall: string; // max(required − covered, 0)
  readonly verdict: MaterialCoverageVerdict;
  /** the requirement's civil due date (YYYY-MM-DD) */
  readonly requiredBy: string | null;
  /** the activity's planned start (civil YYYY-MM-DD) */
  readonly plannedStartDate: string | null;
  /** the soonest covering commitment's civil promised date (at-risk only) */
  readonly commitmentPromisedDate: string | null;
  readonly reason: string;
}
export interface ShortageForecastRow extends RequirementReadinessRow {
  readonly verdict: 'at-risk' | 'blocked';
  readonly impact: ShortageImpact;
  readonly impactReason: string;
}
export interface MaterialReadinessResult {
  /** every open material requirement's coverage, activity- then requirement-ordered */
  readonly requirements: readonly RequirementReadinessRow[];
  /** the shortages only (verdict ≠ ready), worst-first (blocked before at-risk), soonest-needed first */
  readonly shortages: readonly ShortageForecastRow[];
  readonly summary: { readonly ready: number; readonly atRisk: number; readonly blocked: number; readonly total: number };
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
