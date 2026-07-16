import type { ModuleManifest } from '@vitan/shared';

/** The Client Decision Log pillar: options recorded, chosen, locked, change-controlled. */
export const decisionsManifest: ModuleManifest = {
  id: 'decisions',
  title: 'Client Decision Log',
  kind: 'domain',
  ownsModels: ['decision', 'decisionOption', 'decisionEvent', 'changeRequest'],
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
  queries: [],
  routes: [
    'POST /projects/:projectId/decisions',
    'POST /projects/:projectId/decisions/:decisionId/publish',
    'POST /projects/:projectId/decisions/:decisionId/approve',
    'POST /projects/:projectId/decisions/:decisionId/change',
    'POST /projects/:projectId/decisions/:decisionId/change/withdraw',
  ],
  permissions: ['pmc', 'client', 'contractor', 'engineer', 'consultant'],
};
