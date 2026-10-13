import { type ModuleManifest } from '@vitan/shared';

/**
 * Site Visits (#792) — a PMC's or consultant's walk of the site: who visited, when, from which
 * device's location, with whom, and the places walked.
 *
 * SV1-a is the record: the three tables, the rules PostgreSQL enforces on them, and the eight event
 * types each change is paired with. SV1-b's first unit adds the commands that start, end and close a
 * visit, and the members' read; adding and retiring places and attendees follow. The tables are
 * append-only and set-once (edits add or retire rows), so every change is attributed and timed in the
 * record itself.
 */
export const siteVisitsManifest: ModuleManifest = {
  id: 'site-visits',
  title: 'Site Visits',
  kind: 'domain',
  ownsModels: ['siteVisit', 'siteVisitAttendee', 'siteVisitPlace'],
  readEncapsulated: ['siteVisit', 'siteVisitAttendee', 'siteVisitPlace'],
  // A visit freezes the label of a published node through the nodes module's database contract
  // (`nodes_published_name_locked`), never by reading its table.
  dependsOn: ['nodes'],
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
  commands: ['site-visits.start', 'site-visits.end', 'site-visits.close'],
  queries: ['site-visits.list'],
  routes: [
    'POST /projects/:projectId/site-visits',
    'POST /projects/:projectId/site-visits/:visitId/end',
    'POST /projects/:projectId/site-visits/:visitId/close',
  ],
  permissions: ['pmc', 'consultant', 'architect'],
};
