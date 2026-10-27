import { DRAWINGS_COMMANDS, DRAWINGS_QUERIES, type ModuleManifest } from '@vitan/shared';

/** Governing drawing revisions with frozen recipients and acknowledgements (Phase 1). Task 10 — a
 *  fully-extracted module: it read-encapsulates every model it owns (incl. its rebuildable projection),
 *  so no other module reads drawing persistence directly — every cross-module read routes through the
 *  DrawingsQueryService contract (the boundary check enforces it). */
export const drawingsManifest: ModuleManifest = {
  id: 'drawings',
  title: 'Drawing Control',
  kind: 'domain',
  // #1118 U1a-2 (20280121100000) — the Hub link and its history
  ownsModels: ['drawing', 'drawingRevision', 'drawingRecipient', 'drawingAck', 'drawingsProjection', 'drawingHubLink', 'drawingHubLinkEvent'],
  readEncapsulated: ['drawing', 'drawingRevision', 'drawingRecipient', 'drawingAck', 'drawingsProjection', 'drawingHubLink', 'drawingHubLinkEvent'],
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
    // Module 4 correction — owner-aligned SET NULL signals, appended by DrawingParticipant on the
    // FOREIGN deleting transaction (activities.remove / nodes.remove) so the drawings.inbox cursor
    // observes base changes previously performed only by the ON DELETE SET NULL FK action.
    'drawing.activity_unlinked',
    'drawing.unfiled',
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
