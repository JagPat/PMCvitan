import type { ModuleManifest } from '@vitan/shared';

/**
 * Stage-wise Quality Inspections. A CLOSING inspection's decide is the sign-off half of
 * the activity-completion workflow (edges 2–3): `decide` invokes the activities
 * participant to write the activity `done`/revert in the SAME transaction as the
 * inspection decision. The closing-inspection CREATE half (edge 1) is exposed as this
 * module's `InspectionParticipant` for the activities `complete` workflow.
 *
 * The sign-off events (`activity.signed_off` / `activity.signoff_rejected`) are emitted
 * here because the CAUSE is the inspection decision — the append to the shared DomainEvent
 * store is a platform write, not a cross-module persistence edge.
 */
export const inspectionsManifest: ModuleManifest = {
  id: 'inspections',
  title: 'Quality Inspections',
  kind: 'domain',
  ownsModels: ['inspection', 'inspectionItem'],
  dependsOn: [],
  workflowParticipants: ['activities'],
  producesEvents: [
    'inspection.created',
    'inspection.submitted',
    'inspection.approved',
    'inspection.rejected',
    'inspection.reinspection_created',
    'activity.signed_off',
    'activity.signoff_rejected',
  ],
  consumesEvents: [],
  commands: ['inspections.create', 'inspections.submit', 'inspections.decide'],
  queries: [],
  routes: ['Post()', "Post(':inspectionId/submit')", "Post(':inspectionId/decide')"],
  permissions: ['pmc', 'engineer', 'contractor'],
};
