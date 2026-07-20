import type { ModuleManifest } from '@vitan/shared';

/** The Client Decision Log pillar: options recorded, chosen, locked, change-controlled. */
export const decisionsManifest: ModuleManifest = {
  id: 'decisions',
  title: 'Client Decision Log',
  kind: 'domain',
  // Task 9 — `decisionProjection` is the module's own rebuildable read-model table, written only by
  // its `decisions.inbox` projection consumer and read only by its projection query.
  ownsModels: ['decision', 'decisionOption', 'decisionEvent', 'changeRequest', 'decisionProjection'],
  // Task 8 — the FIRST fully-extracted backend module: its models are read-encapsulated, so no
  // other module reads decision persistence directly (the boundary check enforces it); every
  // cross-module read goes through the queries below (DecisionsQueryService).
  readEncapsulated: ['decision', 'decisionOption', 'decisionEvent', 'changeRequest', 'decisionProjection'],
  dependsOn: [],
  workflowParticipants: [],
  producesEvents: [
    'decision.drafted',
    'decision.published',
    'decision.approved',
    'decision.reapproved',
    'decision.change_requested',
    'decision.change_withdrawn',
  ],
  consumesEvents: [],
  commands: ['decisions.create', 'decisions.publish', 'decisions.approve', 'decisions.requestChange', 'decisions.withdrawChange'],
  queries: ['decisions.snapshotSlice', 'decisions.projectionSlice', 'decisions.existsInProject', 'decisions.resolveRef', 'decisions.countByNodeIds', 'decisions.countPending', 'decisions.approvedRef'],
  routes: [
    'POST /projects/:projectId/decisions',
    'POST /projects/:projectId/decisions/:decisionId/publish',
    'POST /projects/:projectId/decisions/:decisionId/approve',
    'POST /projects/:projectId/decisions/:decisionId/change',
    'POST /projects/:projectId/decisions/:decisionId/change/withdraw',
  ],
  permissions: ['pmc', 'client', 'contractor', 'engineer', 'consultant'],
};
