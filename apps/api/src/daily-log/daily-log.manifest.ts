import type { ModuleManifest } from '@vitan/shared';

/**
 * The daily site log — attendance, crew, materials, progress. Flagging a material
 * mismatch is an ATOMIC WORKFLOW with the activity spine (edge 4): it invokes the
 * activities participant to block the linked activity under the readiness lock, in one
 * transaction with the SiteMaterial write.
 */
export const dailyLogManifest: ModuleManifest = {
  id: 'daily-log',
  title: 'Daily Site Log',
  kind: 'domain',
  // Task 10 — `dailyLogProjection` is the module's own rebuildable read-model table, written only by
  // its `daily-log.inbox` projection consumer and read only by its projection query.
  ownsModels: ['dailyLog', 'crewRow', 'siteMaterial', 'dailyLogProjection'],
  // Task 10 — the SECOND fully-extracted backend module: its models are read-encapsulated, so no
  // other module reads daily-log persistence directly (the boundary check enforces it); every
  // cross-module read goes through the queries below (DailyLogQueryService).
  readEncapsulated: ['dailyLog', 'crewRow', 'siteMaterial', 'dailyLogProjection'],
  dependsOn: ['decisions'], // Task 8 — reads decisions via its query contract
  workflowParticipants: ['activities'],
  producesEvents: ['dailylog.started', 'dailylog.submitted', 'material.added', 'material.mismatch_flagged'],
  consumesEvents: [],
  commands: ['daily-log.start', 'daily-log.addMaterial', 'daily-log.flagMismatch', 'daily-log.submit'],
  queries: ['daily-log.snapshotSlice', 'daily-log.projectionSlice', 'daily-log.existsInProject', 'daily-log.resolveRef'],
  routes: [
    'POST /projects/:projectId/daily-log/start',
    'POST /projects/:projectId/daily-log/materials',
    'POST /projects/:projectId/daily-log/flag-mismatch',
    'POST /projects/:projectId/daily-log/submit',
  ],
  permissions: ['pmc', 'engineer'],
};
