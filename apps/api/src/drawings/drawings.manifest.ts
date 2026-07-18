import { DRAWINGS_COMMANDS, DRAWINGS_QUERIES, type ModuleManifest } from '@vitan/shared';

/** Governing drawing revisions with frozen recipients and acknowledgements (Phase 1). Task 10 — a
 *  fully-extracted module: it read-encapsulates every model it owns (incl. its rebuildable projection),
 *  so no other module reads drawing persistence directly — every cross-module read routes through the
 *  DrawingsQueryService contract (the boundary check enforces it). */
export const drawingsManifest: ModuleManifest = {
  id: 'drawings',
  title: 'Drawing Control',
  kind: 'domain',
  ownsModels: ['drawing', 'drawingRevision', 'drawingRecipient', 'drawingAck', 'drawingsProjection'],
  readEncapsulated: ['drawing', 'drawingRevision', 'drawingRecipient', 'drawingAck', 'drawingsProjection'],
  dependsOn: ['decisions'], // Task 8 — reads decisions via its query contract
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
  commands: [...DRAWINGS_COMMANDS],
  queries: [...DRAWINGS_QUERIES],
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
