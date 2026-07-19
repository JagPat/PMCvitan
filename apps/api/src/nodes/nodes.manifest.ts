import type { ModuleManifest } from '@vitan/shared';

/**
 * The project location spine (zones → rooms → elements). Removing a node UNFILES the
 * records placed at it across five domains (edge 7) — each unfile is routed through the
 * OWNING module's workflow participant on the same transaction (an explicit update + an
 * owner-aligned signal event), with the `ON DELETE SET NULL (nodeId)` FK actions kept as
 * the database backstop; Media stays FK-only because no module projection serializes
 * Media.nodeId. Decisions are the one reference `remove` refuses to unfile (a guard,
 * backed by a NO ACTION FK).
 */
export const nodesManifest: ModuleManifest = {
  id: 'nodes',
  title: 'Location Spine',
  kind: 'domain',
  ownsModels: ['projectNode'],
  dependsOn: ['decisions'], // Task 8 — reads decisions via its query contract
  // Task 10 (Modules 3+4 + correction) — before deleting a subtree, `remove` unfiles the placed
  // inspections, filed activities, filed drawings AND staged site materials through each owning
  // module's participant in the same transaction, so every projection that serializes a nodeId
  // observes the location change (the ON DELETE SET NULL FKs stay as the database backstop). No
  // query read here, so nodes has no dependsOn edge to any of them — only workflow-participant edges.
  workflowParticipants: ['inspections', 'activities', 'drawings', 'daily-log'],
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
