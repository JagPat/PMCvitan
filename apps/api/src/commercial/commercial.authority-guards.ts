/**
 * The money-path refusal → PostgreSQL seal classification (CLOSURE 9, Task 6A convergence audit,
 * root "sealed in one place only").
 *
 * This lives in its own module because it is read by TWO closures on DIFFERENT substrates, and
 * root A — a set enumerated in more than one place must agree across all of them — forbids
 * copying it into each:
 *
 *   - `commercial.contract.test.ts` proves every refusal the payment SERVICE raises is classified
 *     here, and that no row claims a refusal the service no longer makes. That is a source fact,
 *     so it is answered from source text at the desk.
 *   - `test/integration/commercial-catalog-closure.test.ts` proves every named seal is really
 *     installed in the LIVE database. That is a database fact, and the PR #287 convergence audit
 *     records why migration text cannot answer it.
 */
export interface AuthorityGuard {
  /** A distinctive slice of the refusal message as the service raises it. */
  match: string;
  /**
   * The PostgreSQL object that refuses the same thing to a writer that never called the service —
   * a constraint, a trigger, or a function — or `null` with a reason in `why`.
   */
  seal: string | null;
  why: string;
}

export const AUTHORITY_GUARDS: readonly AuthorityGuard[] = [
    {
      match: 'Approving a payment is a pmc surface',
      seal: null,
      why: 'a ROLE policy, not a property of a row: `ROLE_POLICY` is the single statement and `RolesFor` plus the route-policy tripwire are its enforcement. What a bypass writer defeats by skipping it is §I, and §I is sealed at `PaymentApproval_approver_not_certifier`',
    },
    {
      match: 'Recording a payment is a pmc surface',
      seal: null,
      why: 'same policy surface as approving; the money invariant a bypass writer would defeat is bound 5, sealed at `phase5_t6a_paid_bound_check`',
    },
    {
      match: 'The commercial register is a pmc/engineer surface',
      seal: null,
      why: 'a READ guard — it authorises no write, so there is no persisted state for a seal to protect',
    },
    {
      match: 'has no live certification',
      seal: 'PaymentApproval_authority_live',
      why: 'an approval draws on a LIVE certificate; the three-column FK proves the certificate is this bill’s and says nothing about it standing',
    },
    {
      match: 'no longer holds pmc standing',
      seal: 'phase5_t6a_approval_override_valid',
      why: 'the grant-backed override chain — a grant whose approver has lost standing cannot be spent, and the seal re-proves the grant’s own receipt',
    },
    {
      match: 'granted against an earlier claim version',
      seal: 'phase5_t6a_approval_override_valid',
      why: 'the seal pins the grant to the certificate’s own `versionId`, so a stale grant cannot excuse an approval on an amended claim',
    },
    {
      match: 'may not also approve its payment',
      seal: 'PaymentApproval_approver_not_certifier',
      why: '§I’s payment half, sealed at PG with the override path honoured rather than banned',
    },
    {
      match: 'would take the approved total past',
      seal: 'phase5_t6a_approved_bound_check',
      why: '§G bound 4, re-derived at COMMIT under the bill lock over whatever the transaction leaves behind',
    },
    {
      match: 'authorisation was consumed concurrently',
      seal: 'SodGrant_consumed_together',
      why: 'the grant is single-use; the CAS loses the race and the CHECK plus 5B’s one-way consume trigger make a second spend unrepresentable',
    },
    {
      match: 'no longer hold the standing on this project',
      seal: null,
      why: 'standing is ORGS-owned and orgs-enforced; the money row’s own §I seal is `PaymentApproval_approver_not_certifier`, and a PG copy of the role predicate here would be a second statement of a rule this module does not own',
    },
    {
      match: 'above your approval ceiling',
      seal: null,
      why: '§I ceilings are per-MEMBERSHIP authority, not a property of the money row: the ceiling can be raised or lowered after the fact, so a PG check on the approval would refuse a row that was legitimate when written. `Membership_approvalLimit_nonnegative` is the only invariant the column itself has',
    },
    {
      match: 'has since been superseded',
      seal: 'Payment_authority_live',
      why: 'money leaves against the authority that covered it — the row-level question the bill-scoped bound cannot ask',
    },
    {
      match: 'would take the paid total past',
      seal: 'phase5_t6a_paid_bound_check',
      why: '§G bound 5 at the BILL, re-derived at COMMIT and also fired when a certificate is SUPERSEDED, which moves the right-hand side with no `Payment` insert to notice',
    },
    {
      match: 'Reversing a payment is a pmc surface',
      seal: null,
      why: 'same policy surface as recording; the money invariant a bypass writer would defeat is the per-payment reversal bound, sealed at `phase5_t6b_ii_reversal_bound_check`',
    },
    {
      match: 'would return more than payment',
      seal: 'phase5_t6b_ii_reversal_bound_check',
      why: 'a reversal returns money that actually left, so it is capped by its OWN payment — cumulatively, re-derived at COMMIT under that payment’s row lock. §0’s bill-scoped `Σ reversals ≤ Σ payments` is this bound summed, not a second check',
    },
    {
      match: "raises the claim's ceiling",
      seal: 'phase5_t6a_approval_paid_check',
      why: '§G bound 5 at the APPROVAL — the bill fold is conserved while one authority is overdrawn, so the row-level question is asked where the row is (this closure caught the guard the moment it was written, which is the whole point of it)',
    },
];
