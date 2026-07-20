import { ACTIVITIES_COMMANDS, ACTIVITIES_QUERIES, type ModuleManifest } from '@vitan/shared';

/**
 * The Site Activity spine (activities + phases + gate overrides). Completion is an
 * ATOMIC WORKFLOW with inspections (edge 1): `complete` invokes the inspections
 * participant to create the closing inspection in one transaction. The activity's OWN
 * sign-off writes are exposed as this module's `ActivityParticipant` for the inspections
 * decide workflow (edges 2–3), the daily-log material-mismatch block (edge 4), the
 * nodes-delete unfile, and project initialization (edge 8).
 *
 * The sign-off events (`activity.signed_off` / `activity.signoff_rejected`) are emitted by
 * INSPECTIONS (the cause is the inspection decision); this module's `activities.schedule`
 * projection consumes them by prefix. The participant signal events below
 * (`material_blocked`/`unfiled` + the init `created` events) are appended by foreign
 * commands THROUGH this module's participant, so every foreign mutation of an
 * activity-owned serialized fact reaches the ordered projection cursor.
 */
export const activitiesManifest: ModuleManifest = {
  id: 'activities',
  title: 'Site Activity Spine',
  kind: 'domain',
  // Task 10 (Module 4) — a fully-extracted module: it read-encapsulates every model it owns (incl. its
  // rebuildable projection), so no other module reads activity persistence directly — every cross-module
  // read routes through the ActivitiesQueryService contract (the boundary check enforces it).
  ownsModels: ['activity', 'gateOverride', 'phase', 'activitiesProjection', 'activityRequirement', 'activityRequirementRoot', 'materialRequirementSpec'],
  readEncapsulated: ['activity', 'gateOverride', 'phase', 'activitiesProjection', 'activityRequirement', 'activityRequirementRoot', 'materialRequirementSpec'],
  // Task 8/10 — reads decisions + the drawing gate + the inspection-gate readiness/next-id via their query
  // contracts (the readiness BAKE consumes all three at read time). The reverse inspections→activities
  // edge is a workflow participant (cycle-exempt), so this dependsOn graph stays acyclic — which is also
  // why the UPSTREAM modules that store an `activityId` (inspections, drawings) validate it via the
  // composite tenant FK instead of a query edge here.
  dependsOn: ['decisions', 'drawings', 'inspections'],
  // Module 4 correction — `remove` also routes the drawing unlink (Drawing.activityId, previously
  // ON DELETE SET NULL only) through the drawings participant on the same transaction.
  workflowParticipants: ['inspections', 'drawings'],
  producesEvents: [
    'activity.created',
    'activity.updated',
    'activity.deleted',
    'activity.started',
    'activity.completion_requested',
    'activity.override_granted',
    'activity.override_revoked',
    // Task 10 (Module 4) — the activity-owned signal events a FOREIGN command appends (through this
    // module's participant) so the ordered activities.schedule projection refreshes when a foreign
    // mutation touches an activity-owned serialized fact. Signal-only (no push).
    'activity.material_blocked',
    'activity.unfiled',
    'phase.created',
    'phase.removed',
    // Phase 3 Task 1 — the ActivityRequirement demand contract (§G: created/revised/cancelled
    // ONLY; derived satisfaction never becomes a domain event). Emitted only on pilot projects
    // (§D capability gate).
    'requirement.created',
    'requirement.revised',
    'requirement.cancelled',
  ],
  consumesEvents: [],
  commands: [...ACTIVITIES_COMMANDS],
  queries: [...ACTIVITIES_QUERIES],
  // routes lists the MUTATING command routes only (the boundary check derives them from the Nest
  // controllers); the module-owned `GET /projects/:projectId/activities` read is declared by
  // `queries` above, not here.
  routes: [
    'POST /projects/:projectId/activities',
    'PATCH /projects/:projectId/activities/:activityId',
    'DELETE /projects/:projectId/activities/:activityId',
    'POST /projects/:projectId/activities/:activityId/start',
    'POST /projects/:projectId/activities/:activityId/complete',
    'POST /projects/:projectId/activities/:activityId/override',
    'DELETE /projects/:projectId/activities/:activityId/override/:overrideId',
    // phases.controller (this module owns Phase too)
    'POST /projects/:projectId/phases',
    'DELETE /projects/:projectId/phases/:phaseId',
    // requirements.controller (Phase 3 Task 1 — capability-gated, pmc-only)
    'POST /projects/:projectId/requirements',
    'POST /projects/:projectId/requirements/:requirementId/revise',
    'POST /projects/:projectId/requirements/:requirementId/cancel',
  ],
  permissions: ['pmc', 'engineer'],
};
