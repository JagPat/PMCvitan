import { INSPECTIONS_COMMANDS, INSPECTIONS_QUERIES, type ModuleManifest } from '@vitan/shared';

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
  // Task 10 (Module 3) — a fully-extracted module: it read-encapsulates every model it owns (incl. its
  // rebuildable projection AND the inspection-owned `inspectionEvidence` link — added by the correction so
  // item evidence is an inspection fact, not a live Media read), so no other module reads inspection
  // persistence directly — every cross-module read routes through the InspectionsQueryService contract
  // (the boundary check enforces it).
  ownsModels: ['inspection', 'inspectionItem', 'inspectionsProjection', 'inspectionEvidence'],
  readEncapsulated: ['inspection', 'inspectionItem', 'inspectionsProjection', 'inspectionEvidence'],
  dependsOn: [],
  workflowParticipants: ['activities'],
  producesEvents: [
    'inspection.created',
    'inspection.submitted',
    'inspection.approved',
    'inspection.rejected',
    'inspection.reinspection_created',
    // Task 10 (Module 3) correction — the five inspection-owned signal events a FOREIGN command appends
    // (through this module's participant) so the ordered inspections.inbox projection refreshes when a
    // foreign mutation touches an inspection-owned serialized field. Signal-only (no push).
    'inspection.closing_created',
    'inspection.evidence_added',
    'inspection.evidence_removed',
    'inspection.relabeled',
    'inspection.unfiled',
    'activity.signed_off',
    'activity.signoff_rejected',
  ],
  consumesEvents: [],
  commands: [...INSPECTIONS_COMMANDS],
  queries: [...INSPECTIONS_QUERIES],
  routes: [
    'POST /projects/:projectId/inspections',
    'POST /projects/:projectId/inspections/:inspectionId/submit',
    'POST /projects/:projectId/inspections/:inspectionId/decide',
  ],
  permissions: ['pmc', 'engineer', 'contractor'],
};
