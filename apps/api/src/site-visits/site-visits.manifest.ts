import { type ModuleManifest } from '@vitan/shared';

/**
 * Site Visits (#792) — a PMC's or consultant's walk of the site: who visited, when, from which
 * device's location, with whom, and the places walked.
 *
 * SV1-a is the record only: the three tables, the rules PostgreSQL enforces on them, and the eight
 * event types each change is paired with. The commands, routes and read arrive with SV1-b, so this
 * manifest declares none yet. The tables are append-only and set-once (edits add or retire rows), so
 * every change is attributed and timed in the record itself.
 */
export const siteVisitsManifest: ModuleManifest = {
  id: 'site-visits',
  title: 'Site Visits',
  kind: 'domain',
  ownsModels: ['siteVisit', 'siteVisitAttendee', 'siteVisitPlace'],
  readEncapsulated: ['siteVisit', 'siteVisitAttendee', 'siteVisitPlace'],
  dependsOn: [],
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
  commands: [],
  queries: [],
  routes: [],
  permissions: ['pmc', 'consultant', 'architect'],
};
