import type { ModuleManifest } from '@vitan/shared';

/** Geo/time-stamped site media, filed to a location and linked to the work it evidences. */
export const mediaManifest: ModuleManifest = {
  id: 'media',
  title: 'Site Media',
  kind: 'domain',
  ownsModels: ['media'],
  // Task 8 reads decisions; Task 10 reads daily-log + validates an evidence target via the inspections
  // query (InspectionsQueryService.assertEvidenceTarget) — all through their query contracts.
  dependsOn: ['decisions', 'daily-log', 'inspections'],
  // Task 10 (Module 3) correction — item evidence is linked/unlinked through the inspections participant
  // (addEvidence/removeEvidence) in the media-create/remove transaction, so the inspection-owned
  // InspectionEvidence write + its signal event commit atomically with the media write.
  workflowParticipants: ['inspections'],
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
