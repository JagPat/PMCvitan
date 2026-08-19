import type { ModuleManifest } from '@vitan/shared';

/** The Client Decision Log pillar: options recorded, chosen, locked, change-controlled. */
export const decisionsManifest: ModuleManifest = {
  id: 'decisions',
  title: 'Client Decision Log',
  kind: 'domain',
  // Task 9 — `decisionProjection` is the module's own rebuildable read-model table, written only by
  // its `decisions.inbox` projection consumer and read only by its projection query.
  // Phase 6 task 4a round 13 — `decisionOptionTouch` is the per-transaction option touch note
  // behind the withdrawal entry seal: written ONLY by the `DecisionOption_t4a_touch` DB trigger
  // (no application writer), owned and read-encapsulated here like every decision fact.
  ownsModels: ['decision', 'decisionOption', 'decisionOptionKind', 'decisionOptionKindSelection', 'decisionOptionTouch', 'decisionEvent', 'decisionApprovalRevision', 'changeRequest', 'decisionProjection'],
  // Task 8 — the FIRST fully-extracted backend module: its models are read-encapsulated, so no
  // other module reads decision persistence directly (the boundary check enforces it); every
  // cross-module read goes through the queries below (DecisionsQueryService).
  readEncapsulated: ['decision', 'decisionOption', 'decisionOptionKind', 'decisionOptionKindSelection', 'decisionOptionTouch', 'decisionEvent', 'decisionApprovalRevision', 'changeRequest', 'decisionProjection'],
  dependsOn: [],
  // Phase 6 task 4a round 3 — the withdraw ATTRIBUTION question (does the actor hold an ACTIVE
  // membership here — the `withdrawnById` FK's target?) is answered by its owner through
  // `OrgsParticipant.lockActiveMembership` inside the decisions transaction. Cycle-exempt like
  // every participant edge: `orgs.dependsOn` includes `decisions`, so a decisions → orgs READ
  // dependency would close a cycle — the declared participant channel does not.
  workflowParticipants: ['orgs'],
  producesEvents: [
    'decision.drafted',
    'decision.published',
    'decision.approved',
    'decision.reapproved',
    'decision.change_requested',
    'decision.change_withdrawn',
    'decision.withdrawn',
  ],
  consumesEvents: [],
  commands: ['decisions.create', 'decisions.publish', 'decisions.approve', 'decisions.requestChange', 'decisions.withdrawChange', 'decisions.withdraw'],
  queries: ['decisions.snapshotSlice', 'decisions.projectionSlice', 'decisions.existsInProject', 'decisions.linkableInProject', 'decisions.resolveRef', 'decisions.countByNodeIds', 'decisions.countPending', 'decisions.approvedRef'],
  routes: [
    'POST /projects/:projectId/decisions',
    'POST /projects/:projectId/decisions/:decisionId/publish',
    'POST /projects/:projectId/decisions/:decisionId/approve',
    'POST /projects/:projectId/decisions/:decisionId/change',
    'POST /projects/:projectId/decisions/:decisionId/change/withdraw',
    'POST /projects/:projectId/decisions/:decisionId/withdraw',
  ],
  permissions: ['pmc', 'client', 'contractor', 'engineer', 'consultant'],
};
