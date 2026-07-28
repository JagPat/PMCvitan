import { LABOUR_COMMANDS, LABOUR_QUERIES, type ModuleManifest } from '@vitan/shared';

/**
 * Phase 4 Task 1 — the LABOUR module (plan §§B/G/H): trusted workforce identity + the labour
 * requirement detail. A LEAF, exactly like `inventory` (round-3 acyclicity correction):
 * `dependsOn: []` — Labour never synchronously reads Activities, Procurement or Decisions.
 *
 * It OWNS the labour catalog (`LabourTrade`/`LabourSkill`), the trusted `Worker`/`Crew`/
 * `CrewMembership` identity, and the labour requirement detail (`LabourRequirementSpec` +
 * `LabourDemandSlice`). The labour detail is written THROUGH `LabourRequirementParticipant`,
 * invoked by the Activities requirement command inside its transaction — the cycle-exempt
 * `activities → labour` workflow-participant edge (so `activities.workflowParticipants` includes
 * `labour`; Labour's own `workflowParticipants` stays empty in Task 1 — it invokes no other
 * module's participant here). Onboarding is `pmc` authority; the register read is pmc/engineer.
 *
 * Task 1 emits NO domain event: onboarding is a roster surface (attributable via `recordAudit`,
 * idempotent via the command ledger). Labour capacity facts (allocation/attendance/work) — and
 * their event family — arrive in Tasks 3–5. The `requirement.*` events that carry the labour
 * demand stay Activities-owned (a discriminated `type` payload); Labour's async
 * `consumesEvents` read-model + the coverage read edge land in Task 4, not here.
 */
export const labourManifest: ModuleManifest = {
  id: 'labour',
  title: 'Labour & Workforce',
  kind: 'domain',
  ownsModels: [
    'labourTrade', 'labourSkill', 'worker', 'workerSkill', 'crew', 'crewMembership',
    'labourRequirementSpec', 'labourDemandSlice',
    // Phase 4 Task 2 — the labour COMMERCIAL chain (§F): the labour supplier profile + the separate
    // labour commercial documents (requisition/RFQ/quote/comparison/PO/commitment) — all labour-owned.
    'vendorLabourProfile', 'labourRequisition', 'labourRequisitionLine', 'labourRfq',
    'supplierLabourQuote', 'supplierLabourQuoteLine', 'labourQuoteComparison',
    'labourPurchaseOrder', 'labourPurchaseOrderVersion', 'labourPurchaseOrderLine',
    'capacityCommitment', 'capacityPromise',
    // Phase 4 Task 3 — the §C time-capacity facts (distinct units, no bucket ledger).
    'workerAllocation', 'labourAttendance', 'labourWorkFact', 'approvedSkillSubstitution',
  ],
  readEncapsulated: [
    'labourTrade', 'labourSkill', 'worker', 'workerSkill', 'crew', 'crewMembership',
    'labourRequirementSpec', 'labourDemandSlice',
    'vendorLabourProfile', 'labourRequisition', 'labourRequisitionLine', 'labourRfq',
    'supplierLabourQuote', 'supplierLabourQuoteLine', 'labourQuoteComparison',
    'labourPurchaseOrder', 'labourPurchaseOrderVersion', 'labourPurchaseOrderLine',
    'capacityCommitment', 'capacityPromise',
    'workerAllocation', 'labourAttendance', 'labourWorkFact', 'approvedSkillSubstitution',
  ],
  // A LEAF (round-3): NO synchronous read edge to any module. The Activities requirement command
  // writes the labour detail INTO this module through LabourRequirementParticipant (a workflow edge
  // on the Activities side). Phase 4 Task 2: the labour commercial chain validates the reused
  // procurement-owned Vendor/ProjectVendor binding through `ProcurementParticipant.assertVendorBound`
  // — a CYCLE-EXEMPT workflow-participant edge (`labour → procurement`), never a `dependsOn` read.
  dependsOn: [],
  // Phase 4 Task 3 adds `activities`: an allocation names the activity it serves, validated through
  // `ActivityParticipant.labourTarget` — the CYCLE-EXEMPT `labour → activities` workflow-participant
  // edge (§G's READ edge runs activities → labour for the Task-4 coverage read, so a labour →
  // activities READ would close a cycle). `dependsOn` therefore stays empty and the graph is acyclic.
  // Task 3 correction 3 adds `orgs`: the t3c repair engine validates a revoker's PROJECT STANDING
  // through `OrgsParticipant.hasProjectRoleStanding` (Membership/Project/OrgMembership are orgs-owned;
  // the owner answers the question) — cycle-exempt for the same reason (`orgs.dependsOn` includes
  // `labour`, so a labour → orgs READ edge would close a cycle; the participant channel does not).
  workflowParticipants: ['procurement', 'activities', 'orgs'],
  // Phase 4 Task 2 — the labour commercial event family (signal-only, invalidate:true, push:null).
  producesEvents: [
    'labour.requisition.submitted', 'labour.requisition.approved', 'labour.comparison.approved',
    'labour.po.issued', 'labour.po.amended', 'labour.po.cancelled', 'labour.po.closed_short',
    'capacity.committed', 'capacity.revised', 'capacity.defaulted',
    // Phase 4 Task 3 — one signal-only event per §C fact row. Derived coverage/verdicts still get
    // NO event (a derived verdict is never a domain fact); the Team gate lands with Task 4.
    'allocation.made', 'allocation.released', 'attendance.recorded', 'attendance.revoked',
    'labour_work.recorded', 'skill_substitution.approved', 'skill_substitution.revoked',
  ],
  consumesEvents: [],
  commands: [...LABOUR_COMMANDS],
  queries: [...LABOUR_QUERIES],
  routes: [
    'POST /projects/:projectId/labour/trades',
    'POST /projects/:projectId/labour/skills',
    'POST /projects/:projectId/labour/workers',
    'POST /projects/:projectId/labour/workers/:workerId/revoke',
    'POST /projects/:projectId/labour/crews',
    'POST /projects/:projectId/labour/crews/:crewId/revoke',
    'POST /projects/:projectId/labour/crews/:crewId/members',
    'DELETE /projects/:projectId/labour/crews/:crewId/members/:workerId',
    // Phase 4 Task 2 — the labour COMMERCIAL chain (§F) mutating routes.
    'POST /orgs/:orgId/labour/vendor-profiles',
    'POST /projects/:projectId/labour/requisitions',
    'POST /projects/:projectId/labour/requisitions/:requisitionId/submit',
    'POST /projects/:projectId/labour/requisitions/:requisitionId/approve',
    'POST /projects/:projectId/labour/requisitions/:requisitionId/reject',
    'POST /projects/:projectId/labour/requisitions/:requisitionId/lines/:lineId/cancel',
    'POST /projects/:projectId/labour/requisitions/:requisitionId/close',
    'POST /projects/:projectId/labour/rfqs',
    'POST /projects/:projectId/labour/rfqs/:rfqId/close',
    'POST /projects/:projectId/labour/rfqs/:rfqId/quotes',
    'POST /projects/:projectId/labour/rfqs/:rfqId/comparison',
    'POST /projects/:projectId/labour/rfqs/:rfqId/comparison/approve',
    'POST /projects/:projectId/labour/pos',
    'POST /projects/:projectId/labour/pos/:poId/issue',
    'POST /projects/:projectId/labour/pos/:poId/amend',
    'POST /projects/:projectId/labour/pos/:poId/cancel',
    'POST /projects/:projectId/labour/pos/:poId/close-short',
    'POST /projects/:projectId/labour/commitments',
    'POST /projects/:projectId/labour/commitments/:commitmentId/revise',
    'POST /projects/:projectId/labour/commitments/:commitmentId/default',
    // Phase 4 Task 3 — the §C time-capacity fact routes.
    'POST /projects/:projectId/labour/allocations',
    'POST /projects/:projectId/labour/allocations/:allocationId/release',
    'POST /projects/:projectId/labour/attendance',
    'POST /projects/:projectId/labour/attendance/:attendanceId/revoke',
    'POST /projects/:projectId/labour/work',
    'POST /projects/:projectId/labour/skill-substitutions',
    'POST /projects/:projectId/labour/skill-substitutions/:substitutionId/revoke',
  ],
  permissions: ['pmc', 'engineer'],
};
