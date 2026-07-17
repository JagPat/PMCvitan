import type { ModuleManifest } from '@vitan/shared';

/**
 * The Site Activity spine (activities + phases + gate overrides). Completion is an
 * ATOMIC WORKFLOW with inspections (edge 1): `complete` invokes the inspections
 * participant to create the closing inspection in one transaction. The activity's OWN
 * sign-off writes are exposed as this module's `ActivityParticipant` for the inspections
 * decide workflow (edges 2–3) and the daily-log material-mismatch block (edge 4).
 */
export const activitiesManifest: ModuleManifest = {
  id: 'activities',
  title: 'Site Activity Spine',
  kind: 'domain',
  ownsModels: ['activity', 'gateOverride', 'phase'],
  dependsOn: ['decisions'], // Task 8 — reads decisions via its query contract
  workflowParticipants: ['inspections'],
  producesEvents: [
    'activity.created',
    'activity.updated',
    'activity.deleted',
    'activity.started',
    'activity.completion_requested',
    'activity.override_granted',
    'activity.override_revoked',
    'phase.created',
    'phase.removed',
  ],
  consumesEvents: [],
  commands: [
    'activities.create',
    'activities.update',
    'activities.remove',
    'activities.start',
    'activities.complete',
    'activities.override',
    'activities.revokeOverride',
    'phases.create',
    'phases.remove',
  ],
  queries: [],
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
  ],
  permissions: ['pmc', 'engineer'],
};
