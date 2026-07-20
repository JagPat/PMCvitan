import { PROCUREMENT_COMMANDS, PROCUREMENT_QUERIES, type ModuleManifest } from '@vitan/shared';

/**
 * Phase 3 Tasks 2–3 — the PROCUREMENT module (plan §§F/G/H): vendors + project-vendor
 * bindings, requisitions with the §F bound-1 allocation guard, RFQs, vendor quotes
 * (normalization fields), quote comparisons, versioned purchase orders with frozen line
 * snapshots + the §F bound-2 allocation guard, and delivery commitments with append-only
 * promise history.
 *
 * Every project surface is capability-gated (§D). The §G edges: `procurement → activities`
 * (the same-transaction `requirements.revisionForAllocation` lock/read and the Task-3
 * `requirements.revisionSnapshotForOrder` freeze read) and — in reverse as a WORKFLOW
 * PARTICIPANT, not a read edge — the requirements cancel command invokes this module's
 * `ProcurementParticipant.assertRequirementDisposable` inside its transaction (the §F
 * explicit-disposition rule). Vendor CRUD is an ORG-ADMIN surface (org membership
 * authority), separate from project-level procurement access (§H probe).
 */
export const procurementManifest: ModuleManifest = {
  id: 'procurement',
  title: 'Procurement Pipeline',
  kind: 'domain',
  ownsModels: [
    'vendor', 'projectVendor', 'requisition', 'requisitionLine', 'rfq', 'vendorQuote', 'vendorQuoteLine', 'quoteComparison',
    'purchaseOrder', 'purchaseOrderVersion', 'purchaseOrderLine', 'deliveryCommitment', 'deliveryPromise',
  ],
  readEncapsulated: [
    'vendor', 'projectVendor', 'requisition', 'requisitionLine', 'rfq', 'vendorQuote', 'vendorQuoteLine', 'quoteComparison',
    'purchaseOrder', 'purchaseOrderVersion', 'purchaseOrderLine', 'deliveryCommitment', 'deliveryPromise',
  ],
  dependsOn: ['activities', 'decisions'],
  // procurement invokes no foreign participant; the REVERSE edge (requirements-cancel invoking
  // this module's ProcurementParticipant) is declared by the activities manifest
  workflowParticipants: [],
  producesEvents: [
    'requisition.submitted', 'requisition.approved', 'comparison.approved',
    'po.issued', 'po.amended', 'po.cancelled',
    'delivery.committed', 'delivery.revised', 'delivery.defaulted',
  ],
  consumesEvents: [],
  commands: [...PROCUREMENT_COMMANDS],
  queries: [...PROCUREMENT_QUERIES],
  routes: [
    // vendors.controller — the org-admin party registry + the project binding (§H)
    'POST /orgs/:orgId/vendors',
    'POST /projects/:projectId/vendors',
    // procurement.controller — the §F pipeline through comparison approval
    'POST /projects/:projectId/requisitions',
    'POST /projects/:projectId/requisitions/:requisitionId/submit',
    'POST /projects/:projectId/requisitions/:requisitionId/approve',
    'POST /projects/:projectId/requisitions/:requisitionId/reject',
    'POST /projects/:projectId/requisitions/:requisitionId/close',
    'POST /projects/:projectId/requisitions/:requisitionId/lines/:lineId/cancel',
    'POST /projects/:projectId/rfqs',
    'POST /projects/:projectId/rfqs/:rfqId/close',
    'POST /projects/:projectId/rfqs/:rfqId/quotes',
    'POST /projects/:projectId/rfqs/:rfqId/comparison',
    'POST /projects/:projectId/rfqs/:rfqId/comparison/approve',
    // Task 3 — versioned POs + delivery commitments (§F)
    'POST /projects/:projectId/pos',
    'POST /projects/:projectId/pos/:poId/issue',
    'POST /projects/:projectId/pos/:poId/amend',
    'POST /projects/:projectId/pos/:poId/cancel',
    'POST /projects/:projectId/pos/:poId/close-short',
    'POST /projects/:projectId/deliveries',
    'POST /projects/:projectId/deliveries/:commitmentId/revise',
    'POST /projects/:projectId/deliveries/:commitmentId/fulfill',
    'POST /projects/:projectId/deliveries/:commitmentId/default',
  ],
  permissions: ['pmc', 'engineer'],
};
