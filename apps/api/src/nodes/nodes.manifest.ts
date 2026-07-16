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
  dependsOn: [],
  workflowParticipants: [],
  producesEvents: ['node.created', 'node.published', 'node.renamed', 'node.moved', 'node.removed'],
  consumesEvents: [],
  commands: ['nodes.create', 'nodes.rename', 'nodes.move', 'nodes.publish', 'nodes.remove'],
  queries: [],
  routes: ['Post()', "Patch(':nodeId')", "Post(':nodeId/move')", "Post(':nodeId/publish')", "Delete(':nodeId')"],
  permissions: ['pmc'],
};
