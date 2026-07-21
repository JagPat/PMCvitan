import { DAILY_LOG_COMMANDS, type ModuleManifest } from '@vitan/shared';

/**
 * The daily site log — attendance, crew, materials, progress. Flagging a material
 * mismatch is an ATOMIC WORKFLOW with the activity spine (edge 4): it invokes the
 * activities participant to block the linked activity under the readiness lock, in one
 * transaction with the SiteMaterial write.
 *
 * Phase 3 Task 5 (§E) — the INVERSE workflow: `daily-log.resolveMismatch` closes ONE
 * mismatch observation with an explicit resolution (`mismatchResolution`, append-only,
 * UNIQUE per observation — the observation row is never edited) and, when no unresolved
 * mismatch remains for the decision, clears the activity block through the same
 * activities participant. Pilot-gated (§D); pmc authority.
 */
export const dailyLogManifest: ModuleManifest = {
  id: 'daily-log',
  title: 'Daily Site Log',
  kind: 'domain',
  // Task 10 — `dailyLogProjection` is the module's own rebuildable read-model table, written only by
  // its `daily-log.inbox` projection consumer and read only by its projection query.
  ownsModels: ['dailyLog', 'crewRow', 'siteMaterial', 'mismatchResolution', 'dailyLogProjection'],
  // Task 10 — the SECOND fully-extracted backend module: its models are read-encapsulated, so no
  // other module reads daily-log persistence directly (the boundary check enforces it); every
  // cross-module read goes through the queries below (DailyLogQueryService).
  readEncapsulated: ['dailyLog', 'crewRow', 'siteMaterial', 'mismatchResolution', 'dailyLogProjection'],
  dependsOn: ['decisions'], // Task 8 — reads decisions via its query contract
  workflowParticipants: ['activities'],
  // `material.unfiled` is the Module-4-correction owner-aligned SET NULL signal, appended by
  // DailyLogParticipant on the FOREIGN nodes.remove transaction so the daily-log.inbox cursor
  // observes the SiteMaterial.nodeId change previously performed only by the FK action.
  producesEvents: ['dailylog.started', 'dailylog.submitted', 'material.added', 'material.mismatch_flagged', 'material.unfiled', 'mismatch.resolved'],
  consumesEvents: [],
  commands: [...DAILY_LOG_COMMANDS],
  queries: ['daily-log.snapshotSlice', 'daily-log.projectionSlice', 'daily-log.existsInProject', 'daily-log.resolveRef'],
  routes: [
    'POST /projects/:projectId/daily-log/start',
    'POST /projects/:projectId/daily-log/materials',
    'POST /projects/:projectId/daily-log/flag-mismatch',
    'POST /projects/:projectId/daily-log/resolve-mismatch',
    'POST /projects/:projectId/daily-log/submit',
  ],
  permissions: ['pmc', 'engineer'],
};
