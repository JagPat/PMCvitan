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
    'vendorBill', 'vendorBillVersion', 'vendorBillLine', 'billVerification',
    // Phase 5 Task 5B (§E/§I) — the certificate, the two frozen consumption sets and the SoD
    // exception. All four are read-encapsulated with the rest: a certificate is what the §G
    // bounds and the withdrawal guards read, and every one of those readers is commercial.
    'billCertificate', 'certifiedAcceptanceConsumption', 'certifiedMeasurementConsumption',
    'sodException', 'sodGrant',
    // Phase 5 Task 5C (§H) — the deduction ledger. Owned AND read-encapsulated together: a model
    // that is owned but not read-encapsulated produces no `cross-module-read` finding when a
    // foreign module reads it, which is the gap the Phase-4 correction-4 pin was added for.
    'billDeduction', 'billDeductionRelease',
    // Phase 5 Task 6A (§F/§G/§I) — the payment authority and the money that left against it
    'paymentApproval',
    'payment',
    // Phase 5 Task 6B unit ii (§0/§H) — the money that came BACK. `PAID(bill)` subtracts it, so it
    // is a fold input in the same sense the payment is.
    'paymentReversal',
    // Phase 5 Task 6C (§H) — the paid-advance pool an `advance-recovery` deduction draws down
    'vendorAdvance',
    // Phase 5 Task 7A (§J) — the EIGHTH rebuildable projection's store. Owned AND read-encapsulated
    // together, the rule the Phase-4 `workerSkill` correction established: a model that is owned but
    // not read-encapsulated produces no `cross-module-read` finding when a foreign module reads it.
    'cashForecastProjection',
  ],
  readEncapsulated: [
    'costHead', 'commitmentAttribution', 'budgetLine', 'budgetException', 'measurement',
    'vendorBill', 'vendorBillVersion', 'vendorBillLine', 'billVerification',
    'billCertificate', 'certifiedAcceptanceConsumption', 'certifiedMeasurementConsumption',
    'sodException', 'sodGrant',
    // Phase 5 Task 5C (§H) — the deduction ledger. Owned AND read-encapsulated together: a model
    // that is owned but not read-encapsulated produces no `cross-module-read` finding when a
    // foreign module reads it, which is the gap the Phase-4 correction-4 pin was added for.
    'billDeduction', 'billDeductionRelease',
    // Phase 5 Task 6A — append-only MONEY tables. Owned but not read-encapsulated left the boundary
    // analyzer unable to flag a foreign synchronous read of them, which is the same shape as the
    // Phase-4 T1 correction-4 finding on `workerSkill`.
    'paymentApproval',
    'payment',
    'paymentReversal',
    'vendorAdvance',
    // Phase 5 Task 7A (§J) — the EIGHTH rebuildable projection's store. Owned AND read-encapsulated
    // together, the rule the Phase-4 `workerSkill` correction established: a model that is owned but
    // not read-encapsulated produces no `cross-module-read` finding when a foreign module reads it.
    'cashForecastProjection',
  ],
  dependsOn: ['procurement', 'inventory', 'labour', 'activities'],
  // `orgs` is the Codex round-1 P1 fix: §L activation has no request token, so it resolves the
  // operator's LIVE project standing through `OrgsParticipant.hasProjectRoleStanding` rather than
  // the legacy `User.role` column — the cleared Phase-4 T3 precedent (Membership/Project/
  // OrgMembership are orgs-owned, so the owner answers the membership question). Cycle-exempt.
  workflowParticipants: ['inventory', 'activities', 'procurement', 'labour', 'orgs'],
  // Task 1 declared NO domain event, on two grounds: an accounting fact has no external effect,
  // and it has no consumer. Attributability was the actor FK + reason + the append-only seal, with
  // `recordAudit` carrying it onto the project's audit trail — all of which still holds.
  //
  // Phase 5 Task 7A (§J) makes the SECOND ground false, and this is the honest consequence rather
  // than machinery built to keep a stale declaration true. The stored cash forecast is a consumer
  // of every commercial money movement, and the platform's projection machinery assumes — in three
  // separate places — that a projection's inputs are announced by events: `diagnose` freezes the
  // window by locking `ProjectEventStream`, a rebuild's catch-up repairs the seed's blind spot by
  // REPLAYING EVENTS, and staleness is normally visible as an undelivered delivery. A projection
  // fed by silent write-through has none of those, which is what four review rounds of compensating
  // locks were paying for.
  //
  // The FIRST ground is preserved literally: `commercial.money_moved` is WEIGHTLESS in the
  // external-effect catalog (`invalidate: false, push: null`), so commercial still sends nothing to
  // any client. The event exists for its durable outbox delivery and nothing else.
  producesEvents: ['commercial.money_moved'],
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
    // Phase 5 Task 5B (§E/§F/§I) — certification, and the ONE correction path past it
    'POST /projects/:projectId/commercial/bills/certify',
    'POST /projects/:projectId/commercial/bills/sod-grant',
    'POST /projects/:projectId/commercial/certificates/supersede',
    // Phase 5 Task 5C (§H) — the deduction ledger's two writes
    'POST /projects/:projectId/commercial/deductions/record',
    'POST /projects/:projectId/commercial/deductions/release',
    'POST /projects/:projectId/commercial/bills/amend',
    'POST /projects/:projectId/commercial/bills/reject',
    'POST /projects/:projectId/commercial/payments/approve',
    'POST /projects/:projectId/commercial/payments/record',
    // Phase 5 Task 6B unit ii (§0/§H) — money coming back
    'POST /projects/:projectId/commercial/payments/reverse',
    // Phase 5 Task 6C (§H) — cash out ahead of a certified claim, and the pool a recovery draws on
    'POST /projects/:projectId/commercial/advances',
  ],
  permissions: ['pmc'],
};
