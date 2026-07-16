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
  ownsModels: ['dailyLog', 'crewRow', 'siteMaterial'],
  dependsOn: [],
  workflowParticipants: ['activities'],
  producesEvents: ['dailylog.started', 'dailylog.submitted', 'material.added', 'material.mismatch_flagged'],
  consumesEvents: [],
  commands: ['daily-log.start', 'daily-log.addMaterial', 'daily-log.flagMismatch', 'daily-log.submit'],
  queries: [],
  routes: [
    'POST /projects/:projectId/daily-log/start',
    'POST /projects/:projectId/daily-log/materials',
    'POST /projects/:projectId/daily-log/flag-mismatch',
    'POST /projects/:projectId/daily-log/submit',
  ],
  permissions: ['pmc', 'engineer'],
};
