import type { ModuleManifest } from '@vitan/shared';

/** Geo/time-stamped site media, filed to a location and linked to the work it evidences. */
export const mediaManifest: ModuleManifest = {
  id: 'media',
  title: 'Site Media',
  kind: 'domain',
  // #482 site photos (20280117) — the keys of deleted photos, written by a trigger on this module's own Media table and read only by the media upload
  // #1177 VT1a (20280126000000) — a voice note's words, as the speech provider heard them
  // #1177 VT1b (20280128000000) — people's corrections of those words, added and never changed
  ownsModels: ['media', 'mediaTombstone', 'voiceTranscript', 'voiceTranscriptCorrection'],
  // Task 8 reads decisions; Task 10 reads daily-log + validates an evidence target via the inspections
  // query (InspectionsQueryService.assertEvidenceTarget) — all through their query contracts.
  // #1177 VT2 — a voice note's words ask the nodes query contract whether the note's place is hidden from the viewer
  // (NodesQueryService.placeHiddenFrom); nodes never depends back on media (its media edge is a workflow participation).
  dependsOn: ['decisions', 'daily-log', 'inspections', 'nodes'],
  // Task 10 (Module 3) correction — item evidence is linked/unlinked through the inspections participant
  // (addEvidence/removeEvidence) in the media-create/remove transaction, so the inspection-owned
  // InspectionEvidence write + its signal event commit atomically with the media write.
  // Phase 3 Task 4 — the delete transaction also invokes the inventory participant
  // (assertMediaDisposable): photos cited by the immutable §C stock ledger are not deletable.
  // Phase 4 Task 5 (§I) adds `activities`: the delete transaction consults
  // ActivityParticipant.assertMediaDisposable so a photo cited as measured-output
  // evidence is never deletable (the same rule as inventory/labour evidence).
  // Phase 5 Task 3 (§D) adds `commercial` for the strictest case of that rule: a measurement is
  // fully immutable and becomes a payable quantity, so its evidence photo is delete-sealed too.
  // #792 SV2 adds `site-visits`: a file added on a site visit is linked to it by SiteVisitFilesParticipant in the
  // upload's transaction (cycle-exempt: site-visits reads the media module's place contract, `media_filed_node`).
  workflowParticipants: ['activities', 'commercial', 'inspections', 'inventory', 'labour', 'site-visits'],
  producesEvents: ['media.uploaded', 'media.refiled', 'media.removed'],
  consumesEvents: [],
  // #995 V1b — a video clip's still frame, added by the phone that recorded it
  // #1179 R2 — a file taken off its site visit, with the visit's removal line (written by the site-visits participant)
  // #1177 VT2-C1 — a voice note's words: try again, correct
  commands: ['media.create', 'media.setNode', 'media.remove', 'media.addPoster', 'media.removeFromVisit', 'media.retryTranscript', 'media.correctTranscript'],
  // U3a — the PMC brief's progress-photo count (MediaQueryService), so orgs never reads `Media` directly
  // #792 SV2 — a site visit's file list reads each file's type and taken time here (MediaQueryService.fileFacts)
  queries: ['media.progressPhotoCountSince', 'media.fileFacts'],
  routes: [
    'POST /projects/:projectId/media',
    'PATCH /projects/:projectId/media/:mediaId/node',
    'POST /projects/:projectId/media/:mediaId/poster',
    'POST /projects/:projectId/media/:mediaId/visit-removal',
    // #1177 VT2-C1 — a voice note's written-out words: try again, correct (reading them is a GET)
    'POST /projects/:projectId/media/:mediaId/transcript/retry',
    'POST /projects/:projectId/media/:mediaId/transcript/correction',
    'DELETE /media/:id',
  ],
  // #482 (Board, 14 Oct 2026) — every member uploads a plain site photo and deletes their own within the hour;
  // filing, and deleting any photo, stay PMC/engineer
  permissions: ['pmc', 'engineer', 'contractor', 'consultant', 'client'],
};
