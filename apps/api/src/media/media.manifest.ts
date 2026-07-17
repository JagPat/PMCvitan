import type { ModuleManifest } from '@vitan/shared';

/** Geo/time-stamped site media, filed to a location and linked to the work it evidences. */
export const mediaManifest: ModuleManifest = {
  id: 'media',
  title: 'Site Media',
  kind: 'domain',
  ownsModels: ['media'],
  dependsOn: ['decisions', 'daily-log'], // Task 8 reads decisions; Task 10 reads daily-log — both via their query contracts
  workflowParticipants: [],
  producesEvents: ['media.uploaded', 'media.refiled', 'media.removed'],
  consumesEvents: [],
  commands: ['media.create', 'media.setNode', 'media.remove'],
  queries: [],
  routes: [
    'POST /projects/:projectId/media',
    'PATCH /projects/:projectId/media/:mediaId/node',
    'DELETE /media/:id',
  ],
  permissions: ['pmc', 'engineer'],
};
