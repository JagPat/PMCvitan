import type { ModuleManifest } from '@vitan/shared';

/** Geo/time-stamped site media, filed to a location and linked to the work it evidences. */
export const mediaManifest: ModuleManifest = {
  id: 'media',
  title: 'Site Media',
  kind: 'domain',
  ownsModels: ['media'],
  dependsOn: [],
  workflowParticipants: [],
  producesEvents: ['media.uploaded', 'media.refiled', 'media.removed'],
  consumesEvents: [],
  commands: ['media.create', 'media.setNode', 'media.remove'],
  queries: [],
  routes: ["Post('projects/:projectId/media')", "Patch('projects/:projectId/media/:mediaId/node')", "Delete('media/:id')"],
  permissions: ['pmc', 'engineer'],
};
