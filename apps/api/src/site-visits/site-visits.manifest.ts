import { type ModuleManifest } from '@vitan/shared';

/**
 * Site Visits (#792) — a PMC's or consultant's walk of the site: who visited, when, from which
 * device's location, with whom, and the places walked.
 *
 * SV1-a is the record: the three tables, the rules PostgreSQL enforces on them, and the eight event
 * types each change is paired with. SV1-b adds the commands that start, end and close a visit, the
 * visitor's adding and retiring of places and attendees, and the members' read. The tables are
 * append-only and set-once (edits add or retire rows), so every change is attributed and timed in the
 * record itself.
 *
 * SV2 adds `siteVisitMedia`: a file the visitor added on a visit, pointing at a stored Media row. Like an inspection's
 * evidence, the link is written by this module (as the media module's participant, in the upload's own transaction),
 * so the media module never writes a site-visit table.
 *
 * #1179 R1 adds `siteVisitFileRemoval`: the frozen line a visit keeps for a file taken off it (who added it, who removed
 * it, when, and the reason), required by the database whenever a file's delete takes its link.
 *
 * Guided site inspections, step 3b adds `siteVisitInspection`: an inspection walked during a visit. Like a visit's file,
 * the link is this module's row, written (step 3c, `SiteVisitInspectionsParticipant`) as the inspection submit's
 * participant, so the inspections module never writes a site-visit table. The visit's read serves each line by the
 * inspection's id only; the checklist itself is read from the inspections read.
 *
 * Video V2g-0 adds `siteVisitMediaLink`: a clip's share link to its full-quality video in Drive or Zoho, current and
 * past. V2g-1 writes it (`site-visits.set-file-link`, `site-visits.end-file-link`) and serves a video file's current
 * link on the visit read. Those two commands emit no event: the frozen link rows are their record, and other viewers see
 * a change on their next read (Stage 1, 6 Nov 2026).
 */
export const siteVisitsManifest: ModuleManifest = {
  id: 'site-visits',
  title: 'Site Visits',
  kind: 'domain',
  ownsModels: ['siteVisit', 'siteVisitAttendee', 'siteVisitPlace', 'siteVisitMedia', 'siteVisitFileRemoval', 'siteVisitInspection', 'siteVisitMediaLink'],
  readEncapsulated: ['siteVisit', 'siteVisitAttendee', 'siteVisitPlace', 'siteVisitMedia', 'siteVisitFileRemoval', 'siteVisitInspection', 'siteVisitMediaLink'],
  // A visit freezes the label of a published node through the nodes module's database contract
  // (`nodes_published_name_locked`, and SV2's `nodes_published_name_or_null_locked`), and a visit file's place
  // through the media module's (`media_filed_node`, and R1's `media_mime_of` for a removed file's kind), never by reading either table; a visit file's type and taken
  // time are read through the media module's query contract (`media.fileFacts`).
  dependsOn: ['nodes', 'media'],
  workflowParticipants: [],
  producesEvents: [
    'sitevisit.started',
    'sitevisit.ended',
    'sitevisit.closed',
    'sitevisit.late_end_recorded',
    'sitevisit.place_added',
    'sitevisit.place_retired',
    'sitevisit.attendee_added',
    'sitevisit.attendee_retired',
  ],
  consumesEvents: [],
  commands: [
    'site-visits.start', 'site-visits.end', 'site-visits.close',
    'site-visits.add-place', 'site-visits.retire-place', 'site-visits.add-attendee', 'site-visits.retire-attendee',
    'site-visits.set-file-link', 'site-visits.end-file-link',
  ],
  queries: ['site-visits.list'],
  routes: [
    'POST /projects/:projectId/site-visits',
    'POST /projects/:projectId/site-visits/:visitId/end',
    'POST /projects/:projectId/site-visits/:visitId/close',
    'POST /projects/:projectId/site-visits/:visitId/places',
    'POST /projects/:projectId/site-visits/:visitId/places/:placeId/retire',
    'POST /projects/:projectId/site-visits/:visitId/attendees',
    'POST /projects/:projectId/site-visits/:visitId/attendees/:attendeeId/retire',
    'PUT /projects/:projectId/site-visits/:visitId/files/:mediaId/link',
    'DELETE /projects/:projectId/site-visits/:visitId/files/:mediaId/link',
  ],
  permissions: ['pmc', 'consultant', 'architect'],
};
