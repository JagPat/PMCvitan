import type { ModuleManifest } from '@vitan/shared';

/**
 * The project location spine (zones → rooms → elements). Removing a node UNFILES the
 * records placed at it across five domains — declared now as a database
 * `ON DELETE SET NULL (nodeId)` FK action (edge 7), not a service-owned cross-module
 * write, so `remove` writes only its own ProjectNode rows. Decisions are the one
 * reference `remove` refuses to unfile (a guard, backed by a NO ACTION FK).
 */
export const nodesManifest: ModuleManifest = {
  id: 'nodes',
  title: 'Location Spine',
  kind: 'domain',
  ownsModels: ['projectNode'],
  dependsOn: ['decisions'], // Task 8 — reads decisions via its query contract
  // Task 10 (Module 3) correction — before deleting a subtree, `remove` unfiles the placed inspections
  // through the inspections participant (unfileForDeletedNodes) in the same transaction, so the projection
  // observes the location change (the ON DELETE SET NULL FK stays as the database backstop). No inspection
  // query read here, so nodes has no dependsOn edge to inspections — only this workflow-participant edge.
  workflowParticipants: ['inspections'],
  producesEvents: ['node.created', 'node.published', 'node.renamed', 'node.moved', 'node.removed'],
  consumesEvents: [],
  commands: ['nodes.create', 'nodes.rename', 'nodes.move', 'nodes.publish', 'nodes.remove'],
  queries: [],
  routes: [
    'POST /projects/:projectId/nodes',
    'PATCH /projects/:projectId/nodes/:nodeId',
    'POST /projects/:projectId/nodes/:nodeId/move',
    'POST /projects/:projectId/nodes/:nodeId/publish',
    'DELETE /projects/:projectId/nodes/:nodeId',
  ],
  permissions: ['pmc'],
};
