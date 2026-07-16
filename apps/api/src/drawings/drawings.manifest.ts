import type { ModuleManifest } from '@vitan/shared';

/** Governing drawing revisions with frozen recipients and acknowledgements (Phase 1). */
export const drawingsManifest: ModuleManifest = {
  id: 'drawings',
  title: 'Drawing Control',
  kind: 'domain',
  ownsModels: ['drawing', 'drawingRevision', 'drawingRecipient', 'drawingAck'],
  dependsOn: [],
  workflowParticipants: [],
  producesEvents: [
    'drawing.issued',
    'drawing.revised',
    'drawing.recipients_frozen',
    'drawing.published',
    'drawing.acknowledged',
    'drawing.refiled',
    'drawing.removed',
  ],
  consumesEvents: [],
  commands: ['drawings.issue', 'drawings.publish', 'drawings.presign', 'drawings.acknowledge', 'drawings.setNode', 'drawings.remove'],
  queries: [],
  routes: [
    'POST /projects/:projectId/drawings',
    'POST /projects/:projectId/drawings/:drawingId/publish',
    'POST /projects/:projectId/drawings/presign',
    'POST /projects/:projectId/drawings/rev/:revId/ack',
    'PATCH /projects/:projectId/drawings/:drawingId/node',
    'DELETE /drawings/:id',
  ],
  permissions: ['pmc', 'engineer', 'contractor'],
};
