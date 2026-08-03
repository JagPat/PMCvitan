import { COMMERCIAL_COMMANDS, COMMERCIAL_QUERIES, type ModuleManifest } from '@vitan/shared';

/**
 * Phase 5 Task 1 — the COMMERCIAL module (plan §K).
 *
 * `commercial` is a SINK: it READS procurement, inventory, labour and activities, and NOTHING
 * reads it (`any module's dependsOn gains nothing`). That is what makes money follow the site
 * rather than command it — no readiness gate consults commercial, and enabling the capability
 * changes no readiness verdict in either direction.
 *
 * The edge set below is generated from the plan's §K manifest edge table, which is the SINGLE
 * declaration of it — §0b's meta-rule ("a rule is stated at exactly ONE site") is why neither
 * this comment nor the Task-1 acceptance test repeats the list as prose. The acceptance test
 * asserts these fields against that table plus a successful topological sort.
 *
 * The four OUTBOUND `workflowParticipants` are declared here in Task 1 because a transaction-
 * bound call must be DECLARED or the manifest says the call cannot happen — and taking the
 * fallback plain read instead would reopen the very race the participant exists to close. The
 * calls themselves arrive with the sections that need them: `inventory.lockAcceptedEvidence`
 * and the `procurement`/`labour` PO-line locks at certification (§E, Task 5), the locked
 * activity status read at measurement (§D, Task 3). Declaring them up front is the plan's own
 * choice; the alternative is amending the manifest in four later tasks and re-litigating the
 * edge table each time.
 */
export const commercialManifest: ModuleManifest = {
  id: 'commercial',
  title: 'Commercial & Cost Control',
  kind: 'domain',
  // Phase 5 Task 2 (§B) — the versioned budget joins the owned set. Read-encapsulated with
  // the rest: `BUDGET(costHead)` is a commercial fold, and nothing outside commercial reads it.
  // Phase 5 Task 4 (§F) — the vendor CLAIM joins the owned set, read-encapsulated with the rest:
  // `BILLED_QTY`/`BILLED_AMOUNT` are commercial folds and nothing outside commercial reads them.
  ownsModels: [
    'costHead', 'commitmentAttribution', 'budgetLine', 'budgetException', 'measurement',
    'vendorBill', 'vendorBillVersion', 'vendorBillLine',
  ],
  readEncapsulated: [
    'costHead', 'commitmentAttribution', 'budgetLine', 'budgetException', 'measurement',
    'vendorBill', 'vendorBillVersion', 'vendorBillLine',
  ],
  dependsOn: ['procurement', 'inventory', 'labour', 'activities'],
  // `orgs` is the Codex round-1 P1 fix: §L activation has no request token, so it resolves the
  // operator's LIVE project standing through `OrgsParticipant.hasProjectRoleStanding` rather than
  // the legacy `User.role` column — the cleared Phase-4 T3 precedent (Membership/Project/
  // OrgMembership are orgs-owned, so the owner answers the membership question). Cycle-exempt.
  workflowParticipants: ['inventory', 'activities', 'procurement', 'labour', 'orgs'],
  // Task 1 emits NO domain event. An attribution is an internal accounting fact with no external
  // effect and no consumer — the budget-vs-committed exception that reacts to it is Task 2's
  // Inbox action, raised from the fold. Attributability is the actor FK + reason + the
  // append-only seal, and `recordAudit` carries it onto the project's audit trail.
  producesEvents: [],
  // Nothing to fold: commercial derives its truth from rows it owns plus the owning modules'
  // read contracts, never from a foreign event payload.
  consumesEvents: [],
  commands: [...COMMERCIAL_COMMANDS],
  queries: [...COMMERCIAL_QUERIES],
  routes: [
    'POST /projects/:projectId/commercial/cost-heads',
    'POST /projects/:projectId/commercial/attributions',
    'POST /projects/:projectId/commercial/budget',
    'POST /projects/:projectId/commercial/measurements',
    'POST /projects/:projectId/commercial/measurements/corrections',
    // Phase 5 Task 4 (§F) — the vendor claim lifecycle up to `under-verification`
    'POST /projects/:projectId/commercial/bills',
    'POST /projects/:projectId/commercial/bills/submit',
    'POST /projects/:projectId/commercial/bills/begin-verification',
    // Phase 5 Task 5A (§E) — the three-way verdict
    'POST /projects/:projectId/commercial/bills/verify',
    'POST /projects/:projectId/commercial/bills/amend',
    'POST /projects/:projectId/commercial/bills/reject',
  ],
  permissions: ['pmc'],
};
