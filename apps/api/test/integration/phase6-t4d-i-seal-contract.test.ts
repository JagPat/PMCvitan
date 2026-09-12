import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestApp, type TestApp } from './test-app';

/**
 * Phase 6 unit 4d-i — THE CONTRACT-COVERAGE ORACLE.
 *
 * WHY THIS EXISTS, stated plainly, because it is the lesson of round 1 on this PR. The
 * seal-stripped harness proves, for one named seal at a time, that a hostile write which COMMITS
 * without it is REFUSED with it. That is a strong claim and it is the wrong claim: it says the
 * seal refuses THAT write, never that the seal implements the RULE. Twenty-one green arms sat
 * over fourteen seals that judged less than the contract states, and every one of those seals had
 * a paragraph of correct prose directly above SQL that did something narrower. Prose is not
 * checked by anything. The stripping harness is not checked against the plan. So a seal could be
 * described correctly, proven to refuse one thing, and still be an abbreviation of its rule —
 * which is exactly what shipped.
 *
 * WHAT THIS ARM ADDS. For every trigger function the unit installs, a REGISTER entry states:
 *
 *   · `rule`  — the obligation in the contract's own terms, and `plan` — where it says so;
 *   · `on`    — every trigger that installs the function, with the OPERATIONS and TIMING it must
 *               fire on, because "enumerate the OPERATIONS, not the columns" is the rule this
 *               family of defects keeps breaking: a freeze installed BEFORE UPDATE alone is not a
 *               freeze, and no amount of hostile-write evidence about UPDATE will say so;
 *   · `must`  — tokens the FUNCTION BODY has to contain for the rule to be implemented at all.
 *
 * The three arms then ask: is every installed seal declared (and every declaration installed), do
 * the operations match, and does each body carry its rule's load-bearing tokens. That is not a
 * proof of correctness — nothing mechanical is — but it is a check that RUNS AGAINST THE CODE
 * rather than against a description of it.
 *
 * MEASURED, not asserted. This register was run against a database built from every migration
 * plus the unit's migration AS CODEX REVIEWED IT (`cb9b1e23`). Twelve of the `must` tokens below
 * were ABSENT there, one per finding:
 *
 *     platform_t4d_notification_binding            no TG_OP = 'DELETE', no "decisionId"
 *     phase6_t4d_event_correspondence_weak         no platform_tx_event
 *     platform_t4d_stream_allocation               no OLD."nextPosition" + 1
 *     platform_t4d_event_envelope                  no txid_current
 *     phase6_t4d_membership_transition_bound       no "membershipId"
 *     phase6_t4d_provenance_bound                  no "commandType"
 *     phase6_t4d_forward_seal                      no platform_user_holds_role
 *     phase6_t4d_countersign_seal                  no phase6_t4d_provisional_head
 *     phase6_t4d_revision_flip_paired              no count(*)
 *     platform_t4d_effect_catalog_sealed           no "pairingRequired"
 *     phase6_t4d_membership_architect_paired       no txid_current
 *
 * the operations arm was RED too (`Notification_t4d_binding` fired on `U` alone), and the
 * coverage arm named `platform_t4d_release_lease_frozen`, which did not exist — its predecessor
 * sealed a table whose columns were `id, release, acquiredAt, acquiredBy, heartbeatAt,
 * releasedAt`. Every seal finding of round 1 is in that list. The stripping harness was green
 * throughout.
 *
 * ADDING A SEAL WITHOUT AN ENTRY FAILS. That is the point: the register cannot rot quietly.
 */

/** operations, as PostgreSQL spells them in `tgtype`, plus the timing. */
type Ops = { ops: string; when: 'BEFORE' | 'AFTER' | 'CONSTRAINT'; row: boolean };

type SealContract = {
  rule: string;
  plan: string;
  on: Record<string, Ops>;
  must: string[];
  /**
   * Tokens the body must NOT carry (#582's review round 8). `must` catches a rule that was never
   * implemented; it says nothing when a rule is REMOVED and later creeps back. Two of round 8's
   * corrections are removals — the membership seal's stepping-down bypass, and the
   * `OLD.<col> IS NOT NULL` guard on the change request's birth provenance — and for those the
   * register's claim is the absence. Without this, restoring either would leave the suite green.
   */
  forbid?: string[];
};

const B = (ops: string): Ops => ({ ops, when: 'BEFORE', row: true });
const A = (ops: string): Ops => ({ ops, when: 'AFTER', row: true });
const C = (ops: string): Ops => ({ ops, when: 'CONSTRAINT', row: true });
const S = (ops: string): Ops => ({ ops, when: 'BEFORE', row: false });

const REGISTER: Record<string, SealContract> = {
  // ── the reservation doors ───────────────────────────────────────────────────────────────────
  phase6_t4d_reserved: {
    rule: 'no row may enter a reserved architect-chain state between 4d-i and 4d-iii, and the '
      + 'door judges INSERT and UPDATE alike — an existing row moved into the state is the same '
      + 'arrival as a new one. The reserved set is every SHAPE whose first sanctioned writer is '
      + '4d-ii: the two chain states, the two architect roles, the forward FACT, and the audit '
      + 'register KINDS that record the acts (#582 round 15, finding 2 — the kinds were the one '
      + 'member the reservation had never covered)',
    plan: '§A.2 the reservation; §D 4d-i',
    on: {
      'Decision.Decision_t4d_architect_reserved': B('I U'),
      'Decision.Decision_t4d_awaiting_reserved': B('I U'),
      'Membership.Membership_t4d_architect_reserved': B('I U'),
      'User.User_t4d_architect_reserved': B('I U'),
      'DecisionForward.DecisionForward_t4d_reserved': B('I'),
      // INSERT only: the register is append-only, so there is no UPDATE arm to reserve.
      'DecisionEvent.DecisionEvent_t4d_kind_reserved': B('I'),
    },
    must: ['is not writable yet', 'TG_ARGV[0]', 'TG_TABLE_NAME'],
  },

  // ── the fact tables' seven obligations ──────────────────────────────────────────────────────
  phase6_t4d_fact_append_only: {
    rule: 'a fact row is immutable and undeletable — the register exists to be permanent evidence',
    plan: '§A.3 obligation 1',
    on: {
      'DecisionCountersign.DecisionCountersign_t4d_append_only': B('D U'),
      'DecisionForward.DecisionForward_t4d_append_only': B('D U'),
      'DecisionStrandedResolution.DecisionStrandedResolution_t4d_append_only': B('D U'),
    },
    must: ['append-only'],
  },
  phase6_t4d_fact_no_truncate: {
    rule: 'a row seal never fires for TRUNCATE, so each fact register carries a statement-level '
      + 'seal too; the sanctioned reset disables it BY NAME',
    plan: '§A.2 TRUNCATE_SEALS; §D 4d-i',
    on: {
      'ChangeRequest.ChangeRequest_t4d_no_truncate': S('T'),
      'DecisionCountersign.DecisionCountersign_t4d_no_truncate': S('T'),
      'DecisionForward.DecisionForward_t4d_no_truncate': S('T'),
      'DecisionStrandedResolution.DecisionStrandedResolution_t4d_no_truncate': S('T'),
      'MembershipTransition.MembershipTransition_t4d_no_truncate': S('T'),
    },
    must: ['TRUNCATE'],
  },
  // ── #582's review round 22 ──────────────────────────────────────────────────────────────────
  phase6_t4d_decision_approved_here: {
    rule: 'a MOVE into `approved` or `awaiting_countersign` RECORDS ITSELF as it happens, so a '
      + 'deferred birth seal can tell the ACT from the STATE — no predicate over the decision\'s '
      + 'final row can, because the row is identical whether this transaction moved it or found '
      + 'it that way. WHICH moves are legal stays `Decision_t4d_entry_seal`\'s question',
    plan: '§B.4 both revision births (#582 round 19, finding 2; round 22, finding 3 and its sweep)',
    on: { 'Decision.Decision_t4d_approval_transition': B('U') },
    must: [
      // a MOVE, not a state: the status must have CHANGED, and into one of the two parked/final
      // entries the birth seals are about
      'IS DISTINCT FROM', "'approved'", "'awaiting_countersign'",
      // transaction-local, and a jsonb ARRAY rather than a delimited string — round 20, finding 2
      'set_config', 'phase6.t4d_decision_approved', 'phase6.t4d_decision_awaiting', 'to_jsonb',
    ],
  },
  phase6_t4d_change_request_closure_bound: {
    rule: 'the CLOSURE receipt is judged, not merely frozen: a COMPLETED same-transaction receipt '
      + 'of a command that CLOSES a request, run by the recorded resolver, whose result is the '
      + 'request (withdrawal) or the decision it moved (re-approval)',
    plan: '§A.3 obligation 6, the resolver column set (#572 rounds 5 and 6; #582 round 22, finding 2)',
    on: { 'ChangeRequest.ChangeRequest_t4d_closure_bound': C('U') },
    must: [
      'succeeded', 'commandType', 'actorId', 'resolvedById',
      // BOTH writers of `resolvedById`, derived from the column they qualify — naming one would
      // refuse an ordinary re-approval the moment 4d-ii populates the column
      'decisions.withdrawChange', 'decisions.approve',
      // the result differs by command, which is why this is not a branch of the birth binding
      'decisionId',
      // the receipt is THIS transaction's, under the alias no other clause here uses
      'receiptThisTx',
    ],
  },
  phase6_t4d_provenance_bound: {
    rule: 'the fact cites a COMPLETED receipt whose result names the row or its bundle PRIMARY, '
      + 'AND the receipt is IDENTIFIED first — the right KIND of command, run by the SAME actor',
    plan: '§A.3 obligation 6 (as amended by #582 round 1, finding 12)',
    on: {
      'DecisionCountersign.DecisionCountersign_t4d_provenance_bound': C('I'),
      'DecisionForward.DecisionForward_t4d_provenance_bound': C('I'),
      'DecisionStrandedResolution.DecisionStrandedResolution_t4d_provenance_bound': C('I'),
      // #582 round 20, finding 1 — the change request's BIRTH receipt was frozen by round 8 and
      // judged by nothing, so a standard request could cite any unused historical receipt. It
      // joins the same binding, conditionally: the trigger's WHEN clause keeps the previous
      // release's all-null shape out of it entirely.
      'ChangeRequest.ChangeRequest_t4d_source_bound': C('I'),
    },
    must: [
      'succeeded', 'commandType', 'actorId',
      'decisions.forward', 'decisions.countersign', 'decisions.resolveStrandedCountersign',
      'forwardedById', 'countersignedById', 'resolvedById',
      // and the request's two origins take DIFFERENT kinds — a disagreement receipt may not back
      // a standard request, or `origin` would be a label with nothing behind it.
      'decisions.requestChange', 'decisions.disagree', 'requestedById', 'countersign_rejection',
      // #582 round 4, finding 3 — the receipt must be THIS transaction's. `txid_current` would
      // not witness it: this body has no other use of it today, but the membership binding
      // learned in round 3 that a token a second clause can satisfy witnesses neither, so the
      // alias is the evidence and it exists nowhere else here.
      'receiptThisTx',
    ],
  },
  phase6_t4d_forward_seal: {
    rule: 'published + forwardable status, the DISPLACED designation compared field-for-field, an '
      + 'actable TARGET, and the owner\'s 2026-08-13 authority amendment: holder + PMC + architect',
    plan: '§A.2 forwarding; plan line 1930',
    on: { 'DecisionForward.DecisionForward_t4d_seal': B('I') },
    must: [
      'publishedAt', 'fromDesignationKind', 'platform_membership_active_user',
      'platform_role_has_holder', 'platform_user_holds_role', "'pmc'", "'architect'",
    ],
  },
  phase6_t4d_countersign_seal: {
    rule: 'the countersigner IS an architect, the subject is exactly `awaiting_countersign`, and '
      + 'the revision cited is the decision\'s CURRENT PROVISIONAL head',
    plan: '§A.2 the chain; #582 round 1, finding 15',
    on: { 'DecisionCountersign.DecisionCountersign_t4d_seal': B('I') },
    must: ['architect', 'awaiting_countersign', 'phase6_t4d_provisional_head'],
  },
  phase6_t4d_stranded_seal: {
    rule: 'PMC only, `awaiting_countersign`, NO active architect, and the same provisional-head '
      + 'subject rule the countersign takes — on BOTH outcomes',
    plan: '§A.2 the stranded decision; #582 round 1, finding 15',
    on: { 'DecisionStrandedResolution.DecisionStrandedResolution_t4d_seal': B('I') },
    must: ["'pmc'", 'awaiting_countersign', 'platform_role_standing', 'phase6_t4d_provisional_head'],
  },
  phase6_t4d_provisional_head: {
    rule: 'a finalizer ends the approval that is OPEN: the highest-version revision of the '
      + 'decision, and one that is still unfinalized',
    plan: '#582 round 1, finding 15',
    on: {},
    must: ['version', 'finalized', 'ORDER BY'],
  },
  phase6_t4d_forward_paired: {
    rule: 'a forward fact and its holder mutation commit together, in both directions — and ONE '
      + 'mutation carries EXACTLY ONE fact',
    plan: '§A.3 obligation 2; #582 round 10, finding 1',
    on: { 'DecisionForward.DecisionForward_t4d_paired': C('I') },
    must: ['Decision', 'count(*)', "v_facts <> 1"],
    // Round 8 answered the disagreement question here, keyed on the status the decision ENDED
    // at, and so aborted the generic forward of an already-`change` decision (#582 round 10,
    // finding 2). The question moved to `phase6_t4d_disagreement_paired`, where OLD is in hand;
    // the tokens must not come back.
    forbid: ['countersign_rejection', "d.status = 'change'"],
  },
  phase6_t4d_awaiting_paired: {
    rule: 'the ENTRY into `awaiting_countersign` owes exactly one provisional revision born in '
      + 'the same transaction — the converse of the birth pairing',
    plan: '§B.4; #582 round 12, finding 6',
    on: { 'Decision.Decision_t4d_awaiting_paired': C('U') },
    must: ['awaiting_countersign', 'OLD."status"', "r.\"finalized\" = FALSE", 'v_born <> 1'],
  },
  phase6_t4d_project_is_deleting: {
    rule: 'the project-cascade exception is bound to the FACT\'s own project — the flag is the '
      + 'SET of projects this transaction is deleting, not a boolean',
    plan: '§A.2 the cascade exception; #582 round 12, finding 5',
    on: {},
    // #582 round 20, finding 2 — the witness MOVED with the rule. `position(` pinned a
    // DELIMITED-STRING encoding, and that encoding was the defect: `Project.id` is
    // unconstrained TEXT, so an id containing the delimiter made a SURVIVING project read
    // as deleting. The set is a `jsonb` array now and membership is structural, so the
    // token is the operator that asks it. Leaving the old token would have failed this arm
    // for a correction — which is the register doing its job, and the reason it is edited
    // here rather than loosened.
    must: ['current_setting', '? p_project'],
  },
  phase6_t4d_disagreement_paired: {
    rule: 'the `awaiting_countersign → change` TRANSITION owes its open `countersign_rejection` '
      + 'request — every shape of it: reject-back, forward-on and the `returned` resolution',
    plan: 'plan lines 3349 and 5759; #582 round 10, finding 2',
    on: { 'Decision.Decision_t4d_disagreement_paired': C('U') },
    must: ['awaiting_countersign', "'change'", 'countersign_rejection', 'OLD."status"'],
  },
  phase6_t4d_countersign_paired: {
    rule: 'a countersign fact and its decision transition commit together',
    plan: '§A.3 obligation 2',
    on: { 'DecisionCountersign.DecisionCountersign_t4d_paired': C('I') },
    must: ['Decision'],
  },
  phase6_t4d_stranded_paired: {
    rule: 'a stranded resolution and the transition its outcome names commit together',
    plan: '§A.3 obligation 2',
    on: { 'DecisionStrandedResolution.DecisionStrandedResolution_t4d_paired': C('I') },
    must: ['Decision', 'outcome'],
  },
  // #582 round 17 — the correspondence is ONE rule with TWO callers whose preconditions differ,
  // so it is factored: the fact side keeps the readiness fence and the operability arm, and the
  // kernel envelope — which records the archival of a project and is emitted outside the fence —
  // calls the correspondence alone. Registered as two entries because they are two rules.
  phase6_t4d_actor_pair_true: {
    rule: 'the frozen role/name pair is TRUE of the actor: the role held on the project, the name '
      + 'the account carries, read under the identity row lock',
    plan: '§A.3 obligation 3',
    on: {},
    must: ['UserIdentity', 'FOR UPDATE', 'displayName', 'platform_user_holds_role'],
  },
  phase6_t4d_actor_bound: {
    rule: 'a FACT\'s frozen pair carries the correspondence AND the two preconditions of recording '
      + 'a fact — the readiness fence and an operable project',
    plan: '§A.3 obligation 3; §B.1',
    on: {},
    must: ['phase6_try_readiness', 'phase6_project_operable', 'phase6_t4d_actor_pair_true'],
  },

  // ── the decision-side doors and seals ───────────────────────────────────────────────────────
  phase6_t4d_approved_entry_seal: {
    rule: 'entry into the approved family is gated on the chain state the transition asserts',
    plan: '§A.2 the entry seal',
    on: { 'Decision.Decision_t4d_entry_seal': B('I U') },
    // #582 round 11, finding 4 — the standing read is FENCED. Without the key the count is read
    // outside the lock that serialises standing changes against decision writes, and the losing
    // interleaving commits a decision awaiting a countersigner who has just been removed.
    must: ['status', 'phase6_try_readiness'],
  },
  phase6_t4d_holder_standing_seal: {
    rule: 'a decision designated to the ARCHITECT ROLE may not be born, published or reopened '
      + 'into `change` while the project has no active architect — it would be undecidable',
    plan: '§A.2 the holder',
    on: { 'Decision.Decision_t4d_holder_standing': B('I U') },
    must: ["deciderKind", 'platform_role_standing', 'publishedAt'],
  },
  phase6_t4d_revision_birth: {
    rule: 'a revision born PROVISIONAL records the act its finalizer will emit from, and a '
      + 'revision born final under an ACTIVE chain is refused',
    plan: '§B.4',
    on: { 'DecisionApprovalRevision.DecisionApprovalRevision_t4d_birth': B('I') },
    // #582 round 12, finding 2 — a frozen pair is coherent, nonblank AND true of its actor; the
    // third part is what every other pair in this unit gets from `phase6_t4d_actor_bound`.
    must: ['finalized', 'approvedFrom', 'approvedByName', 'approvedByRole', 'BLANK approval pair',
      'half an approval pair', 'phase6_t4d_actor_bound'],
  },
  phase6_t4d_revision_birth_paired: {
    rule: 'ONE approval births ONE revision, and a PROVISIONAL birth rides the transition that '
      + 'put its decision into `awaiting_countersign`',
    plan: '§B.4; P31c; #582 round 10, finding 5',
    on: { 'DecisionApprovalRevision.DecisionApprovalRevision_t4d_birth_paired': C('I') },
    // round 11, finding 3: `xmin` alone is satisfied by a no-op UPDATE, so the birth is bound to
    // the STATE a provisional approval produces and to the one-open-approval invariant.
    must: ['count(*)', 'v_births <> 1', 'txid_current()', "NEW.\"finalized\" = FALSE",
      'awaiting_countersign', 'v_open > 1'],
  },
  phase6_t4d_revision_one_flip: {
    rule: 'finality is ONE-WAY and a finalized revision is undeletable',
    plan: '§B.4',
    on: { 'DecisionApprovalRevision.DecisionApprovalRevision_t4d_one_flip': B('D U') },
    must: ['finalized'],
  },
  phase6_t4d_revision_flip_paired: {
    rule: 'a flip carries EXACTLY ONE finalizer — a countersign or a `completed` stranded '
      + 'resolution — counted ACROSS both tables',
    plan: '§B.4; #582 round 1, finding 16',
    on: { 'DecisionApprovalRevision.DecisionApprovalRevision_t4d_flip_paired': C('U') },
    must: ['count(*)', 'DecisionCountersign', 'DecisionStrandedResolution', "'completed'"],
  },
  phase6_t4d_decision_event_append_only: {
    rule: 'the attributable audit register is append-only; the sanctioned reset disables it by name',
    plan: '§A.3 obligation 1',
    on: { 'DecisionEvent.DecisionEvent_t4d_append_only': B('D U') },
    must: ['append-only'],
  },
  phase6_t4d_event_correspondence_weak: {
    rule: 'an audit row corresponds to an event emitted IN THE SAME TRANSACTION — a historical '
      + 'event of the same type does not satisfy a later audit insert — and both name the actor '
      + 'the branch\'s OWN act row recorded',
    plan: '§A.3 obligation 4; #582 round 1, finding 3; round 7, finding 4; round 19, finding 4; '
      + 'round 23, finding 3',
    on: { 'DecisionEvent.DecisionEvent_t4d_correspondence': C('I') },
    // #582 round 7, finding 4 — `platform_tx_event` alone is satisfied by the WEAKER question.
    // §A.3 says exactly ONE, and `platform_tx_event_count` was written for it (its own doc
    // comment says "two events for one act are as wrong as none") and never called. The token is
    // the COUNT function's name, not the singular one's, because that is the only string that
    // distinguishes an existence check from an exactness check.
    // #582 round 9, finding 5 — round 7's count was ONE-SIDED: each audit row demanded one
    // event and nothing demanded one audit row. `v_audits` witnesses the converse.
    // #582 round 23, finding 3 — round 19's ACTOR binding had no token at all, so the oracle was
    // silent while that rule covered one branch of nine and mis-bound two more. `v_row` is the
    // per-branch authority's name and exists nowhere else; the two column names witness the
    // branches whose authority is NOT the approval revision, which is the whole of the finding.
    must: ['platform_tx_event_count', 'v_events > 1', 'v_audits > 1',
      'v_row', 'countersignedById', 'requestedById'],
  },
  phase6_t4d_consultation_attribution_frozen: {
    rule: 'the 4c consultation attribution columns are frozen once written',
    plan: '§A.3 obligation 3 (the 4c tables)',
    on: {
      'DecisionConsultation.DecisionConsultation_t4d_attribution': B('U'),
      'DecisionConsultationResponse.DecisionConsultationResponse_t4d_attribution': B('U'),
    },
    // #582 round 17 — one-way keyed on `OLD IS NOT NULL` governs the SECOND write and says
    // nothing about the first, so an all-null legacy row could be handed a pair by UPDATE with
    // neither the nonblank rule nor the correspondence, both of which are BEFORE INSERT.
    must: ['frozen', 'was not born with'],
  },
  // #582 round 17 — the BIRTH pair had a shape CHECK and a total freeze and nothing that asked
  // whether it was true; round 16 had given the resolver pair three arms below it exactly that.
  phase6_t4d_change_request_birth_pair: {
    rule: 'a change request\'s requester pair is judged against `requestedById` at the INSERT that '
      + 'settles it — the only moment it can be judged, because it is frozen from then on',
    plan: '§A.3 obligation 3; #582 round 17',
    on: { 'ChangeRequest.ChangeRequest_t4d_birth_pair': B('I') },
    must: ['requestedByRole', 'requestedById', 'phase6_t4d_actor_bound'],
  },
  phase6_t4d_change_request_project: {
    rule: 'the previous release\'s `requestChange` names no project, so the shim fills it from the '
      + 'row\'s own decision — which is what keeps that writer working through the drain',
    plan: '§A.3 obligation 6 (the ChangeRequest column)',
    on: { 'ChangeRequest.ChangeRequest_t4d_project': B('I') },
    must: ['projectId', 'Decision'],
  },

  // ── the membership side ─────────────────────────────────────────────────────────────────────
  phase6_t4d_renotified_claims_event: {
    rule: 'the `countersign_renotified` audit row CLAIMS its own same-transaction '
      + '`decision.awaiting_countersign` event — the one sealed branch with no fact table to '
      + 'claim from, so without this the kernel\'s pairing seal aborts the legitimate act',
    plan: '§A.3 obligation 7; #572 round 19; #582 round 5, finding 7',
    on: { 'DecisionEvent.DecisionEvent_t4d_renotified_claim': A('I') },
    must: ['platform_claim_event_pairing', 'platform_tx_event',
      'decision.awaiting_countersign', 'DecisionEvent'],
  },
  phase6_t4d_membership_transition_seal: {
    rule: 'team management is an AUTHORIZED act (owner/admin authority, or `pmc` — with NO '
      + 'stepping-down exception) and the pair is true, and the fact precedes its membership write',
    plan: '§A.2 the membership paragraph; plan lines 560 and 2860; #582 round 8, findings 6 and 7',
    on: { 'MembershipTransition.MembershipTransition_t4d_seal': B('I') },
    // `platform_role_standing` was in this list until #582 round 4, finding 1, and its presence
    // here is what made the misplacement look correct: the register comparison genuinely was in
    // this body, so the oracle was green while the seal asked its question one statement too
    // early. The clause moved to the DEFERRED binding, and the token moved with it — a register
    // that names a clause by where it USED to live is a register that will accept it back.
    // `m."xmin" = txid_current()` witnesses the ORDERING check that round 8's finding 6 made
    // this side's job: the membership must not already have been written by this transaction.
    // It is spelled with the alias so it cannot be satisfied by any other `txid_current()` a
    // later edit might add — the "a token two rules can satisfy witnesses neither" weakness this
    // register has already been corrected for three times.
    //
    // There is deliberately NO token for a self/stepping-down arm: round 8's finding 7 REMOVED
    // it, and a register that still named it would accept its return.
    must: [
      'platform_user_orchestration_authority', 'platform_user_holds_role',
      'phase6_t4d_actor_bound',
      'm."xmin" = txid_current()',
    ],
    forbid: ['v_self_demotion'],
  },
  phase6_t4d_membership_transition_bound: {
    rule: 'the cited command SUCCEEDED in THIS transaction naming `NEW."membershipId"` as its '
      + 'result, and a same-transaction `Membership` write left that membership at exactly the '
      + '`(toRole, toStatus)` the fact records (an orphan fact refused)',
    plan: 'plan lines 2851 and 2951-2956; #582 round 1, finding 11; round 4, finding 2; round 5, finding 3',
    on: { 'MembershipTransition.MembershipTransition_t4d_provenance_bound': C('I') },
    // #582 round 2, finding 5 — `commandType` and `actorId` were ABSENT from this list, and
    // that is the register's own failure, not just the seal's. Round 1 established the
    // identify-the-receipt clause, its correction reached the three decision facts, and I wrote
    // BOTH this entry and that code from the same wrong belief that the membership binding had
    // been included. An oracle authored alongside the code it checks inherits the author's
    // blind spot exactly where the author has one; it caught twelve tokens across the seals I
    // understood and was silent on the one I had wrong. That is a real limit on this file, and
    // the answer is an outside reader — which is what Codex was here.
    must: ['succeeded', 'membershipId', 'txid_current', 'commandType', 'actorId',
      // #582 round 7, finding 3 — `commandType` alone witnesses only that the receipt is ONE OF
      // the three member commands, which makes the three interchangeable: a `members.remove`
      // receipt could back a transition INTO active. These three tokens are the per-command
      // shape rules, each unique to its arm, so the register cannot be satisfied by the set test.
      // #582 round 12, finding 1 — and each arm is the command's WHOLE shape now, not the
      // standing edge it owns. The tokens moved with the rules: an add's SOURCE and a removal's
      // DESTINATION are what round 7's fix left unbound, so they are what the register pins.
      "'members.remove' AND NEW.\"toStatus\" IS DISTINCT FROM 'removed'",
      "NEW.\"fromStatus\" IS NOT NULL AND NEW.\"fromStatus\" <> 'removed'",
      // NOT the bare `'members.updateRole'` string: that already appears in the three-command
      // ARRAY above, so it is satisfied by the very body this token exists to reject — the
      // "a token two rules can satisfy witnesses neither" weakness rounds 3 and 5 corrected
      // elsewhere in this register and I reintroduced here on the first draft. This clause is
      // the only place the two roles are compared.
      'NEW."fromRole" = NEW."toRole"',
      // #582 round 4, finding 2 as restated by round 5's column correction. `roleNow`/`statusNow`
      // are the aliases of the POST-state comparison that makes the orphan clause name THIS
      // transition rather than any write that touched the row. `platform_role_standing` left this
      // list with the `activeCount` column it read: the count is an EVENT payload field, compared
      // against the register by 4d-ii's event seal, and a fact column duplicating a register is a
      // second copy of a truth that already has one.
      'roleNow', 'statusNow', 'toRole', 'toStatus',
      // #582 round 3, finding 3 — `txid_current` alone does NOT witness this rule: the
      // ORPHAN clause already used it on `Membership`, so the register was green while the
      // RECEIPT lookup carried no transaction predicate at all. `thisTx` is the alias of
      // that predicate and exists nowhere else in the body, which is what makes it evidence.
      'thisTx',
           'members.add', 'members.updateRole', 'members.remove'],
  },
  phase6_t4d_membership_transition_immutable: {
    rule: 'the transition fact is immutable and undeletable, EXCEPT as the cascade of its own '
      + 'project\'s deletion',
    plan: '§A.3 obligation 1; #572 round 12, finding 5',
    on: { 'MembershipTransition.MembershipTransition_t4d_append_only': B('D U') },
    // #582 round 12, finding 5 — the readers no longer test the flag's VALUE; they ask
    // `phase6_t4d_project_is_deleting` whether THIS row's project is one of the going ones.
    must: ['phase6_t4d_project_is_deleting'],
  },
  phase6_t4d_membership_fact_first: {
    rule: 'a member command writes its FACT before the membership — so the fact\'s live authority '
      + 'and frozen-role reads see the PRE-state, never the standing the write itself grants',
    plan: 'plan line 2860; #566 round 1, finding 2; #582 round 6, finding 2',
    on: { 'Membership.Membership_t4d_fact_first': A('I D U') },
    // IMMEDIATE by necessity: the deferred pairing cannot tell which row arrived first, which is
    // exactly the property this seal exists for. `members.` witnesses the command-scoped guard
    // that keeps an ordinary membership write untouched.
    must: ['txid_current', 'MembershipTransition', 'members.updateRole', 'CommandExecution'],
  },
  phase6_t4d_consultation_attribution_present: {
    rule: 'a consultation attribution pair is written as a PAIR and neither half is blank — the '
      + 'freeze makes whatever lands permanent, so INSERT is the only moment it can be judged',
    plan: '§A.3 obligation 3; #582 round 6, finding 5',
    on: {
      'DecisionConsultation.DecisionConsultation_t4d_attribution_present': B('I'),
      'DecisionConsultationResponse.DecisionConsultationResponse_t4d_attribution_present': B('I'),
    },
    must: ['btrim', 'requestedByRole', 'respondedByRole'],
  },
  phase6_t4d_membership_architect_paired: {
    rule: 'every arrival and departure of architect standing carries a transition written IN THE '
      + 'SAME TRANSACTION, for THIS membership\'s user and this exact OLD→NEW change',
    plan: '§A.3 obligation 2 and plan line 2915; #582 round 1, findings 9 and 13; round 5, finding 5',
    on: { 'Membership.Membership_t4d_architect_provenance': C('I D U') },
    // #582 round 5, finding 5 — `toStanding` was the token here, and it could only ever witness
    // the DIRECTION of the move. The pre-state went unbound, so a same-value update on an
    // already-active membership let a fabricated arrival through. All four transition columns are
    // the rule now, so all four are the tokens.
    // #582 round 10, finding 4 — and one existence test could not say "exactly one". The
    // per-receipt index bounds facts per RECEIPT, so the count is the only thing that bounds them
    // per WRITE.
    // #582 round 12, finding 4 — and the crossing is counted per PROJECT, because that is the
    // scope the contract states and the scope the re-notification reads.
    must: ['txid_current', '"userId" = v_user', "'architect'",
      'v_from_role', 'v_from_stat', 'v_to_role', 'v_to_stat',
      'count(*)', 'v_match > 1', 'v_flips > 1'],
  },
  phase6_t4d_membership_guard: {
    rule: 'a membership change may not orphan the named holder of an open decision',
    plan: '§A.2 the holder guards (4b, widened)',
    on: { 'Membership.Membership_t4d_holder_guard': A('D U') },
    must: ['Decision'],
  },
  phase6_t4d_membership_role_standing: {
    rule: 'the counted register is PROJECTED by the orgs-owned trigger through the generic '
      + 'platform primitive — never written by a statement',
    plan: '§A.2 the registers',
    on: { 'Membership.Membership_t4d_role_standing': B('I D U') },
    must: ['platform_role_standing_apply'],
  },
  phase6_t4d_org_authority: {
    rule: 'org owner/admin authority is projected into the platform register by its owner',
    plan: '§A.2 the registers',
    on: { 'OrgMembership.OrgMembership_t4d_org_authority': A('I D U') },
    must: ['platform_org_authority_apply', "'owner'", "'admin'"],
  },
  phase6_t4d_org_user_standing: {
    rule: 'an org owner/admin gain or loss fans out over every project of the org',
    plan: '§A.2 the registers',
    on: { 'OrgMembership.OrgMembership_t4d_user_standing': A('I D U') },
    must: ['platform_user_standing_apply', '"Project"', "'pmc'", '"Membership"'],
  },
  phase6_t4d_project_user_standing: {
    rule: 'a new project is seeded with its org\'s owners and admins',
    plan: '§A.2 the registers',
    on: { 'Project.Project_t4d_user_standing': A('I') },
    must: ['platform_user_standing_apply', '"OrgMembership"', "'pmc'"],
  },
  phase6_t4d_project_registered: {
    rule: 'every project registers its tenancy in the platform-owned ProjectOrg register',
    plan: '§A.2 the ProjectOrg register',
    on: { 'Project.Project_t4d_project_org': A('I') },
    must: ['platform_project_org_apply'],
  },
  phase6_t4d_project_deleting: {
    rule: 'the project-deletion flag is set by the project\'s OWN delete, which is what the '
      + 'cascade exceptions read',
    plan: '§A.2; #572 round 12, finding 5',
    on: { 'Project.Project_t4d_deleting': B('D') },
    must: ['phase6.t4d_project_delete', 'set_config'],
  },
  phase6_t4d_user_identity: {
    rule: 'the display name every frozen pair is judged against is projected from `User` by its '
      + 'owner, on creation and on rename',
    plan: '§A.2 the registers; #572 round 4, finding 4',
    on: { 'User.User_t4d_identity': A('I U') },
    must: ['platform_user_identity_apply'],
  },

  // ── the rollout marker ──────────────────────────────────────────────────────────────────────
  phase6_t4d_rollout_retirement_gate: {
    rule: 'the retirement marker is written ONLY by the retiring migration, under its gate',
    plan: '§A.2 the marker',
    on: { 'RolloutRetirement.RolloutRetirement_t4d_gate': B('I') },
    must: ['written only by the retiring migration', 'current_setting'],
  },
  phase6_t4d_rollout_retirement_frozen: {
    rule: 'the marker is permanent — the doors do not come back',
    plan: '§A.2 the marker',
    on: { 'RolloutRetirement.RolloutRetirement_t4d_frozen': B('D U') },
    must: ['RolloutRetirement'],
  },
  phase6_t4d_rollout_retirement_no_truncate: {
    rule: 'and it cannot be truncated away either',
    plan: '§A.2 TRUNCATE_SEALS',
    on: { 'RolloutRetirement.RolloutRetirement_t4d_no_truncate': S('T') },
    must: ['never truncated'],
  },

  // ── the kernel ──────────────────────────────────────────────────────────────────────────────
  platform_t4d_event_envelope: {
    rule: 'every event carries a truthful actor pair, sits at a position allocated by a stream '
      + 'row updated in THIS transaction, AND names a live catalog entry whose event type, '
      + 'invalidation flag and push shape it reproduces',
    plan: '§A.2 the envelope, arms (a) and (b); #582 round 1, finding 1; #582 round 2, finding 1',
    on: { 'DomainEvent.DomainEvent_t4d_envelope': B('I U') },
    // The intent half is the arm this register did NOT ask for in round 1, and its absence is
    // exactly what round 2's finding 1 found: the seal judged the allocation and the actor pair
    // and never resolved the intent the whole catalog exists to make askable. `FOR SHARE` is in
    // the list because the plan states the LOCK, not merely the read — an unlocked read races
    // the gated retirement stamp.
    must: [
      'ProjectEventStream', 'nextPosition', 'txid_current', 'streamPosition',
      'ExternalEffectCatalog', 'FOR SHARE', 'coverageVersion', 'effectKey',
      // #582 round 9, finding 4 — `->>` reads a blank string as PRESENT, so a targeted
      // family was satisfiable by a target the consumer then drops as non-actionable.
      "jsonb_typeof(v_push -> 'targetUserId')",
      'retiredAt', 'invalidate', 'requiresPush', 'pushRoles', 'audience', 'targetUserIds',
      // #582 round 11, finding 2 — coherence is not presence: a pair of blanks satisfies the
      // null-pair arm on both halves and records nobody, permanently.
      'BLANK actor envelope',
      // #582 round 17 — and nonblank is not CORRESPONDENCE. §A.3 obligation 7 makes this
      // envelope the thing every fact's own pair is compared against, so an unjudged one
      // is not merely a false byline: it is the standard a judged pair is measured by.
      'phase6_t4d_actor_pair_true',
    ],
  },
  phase6_t4d_change_request_evidence_frozen: {
    rule: 'the change request\'s identity, discriminator and SUBSTANCE are frozen, and its two '
      + 'receipts, two frozen actor pairs, closing moment and outcome are written ONCE — never '
      + 'replaced, never cleared',
    plan: '§A.3 obligation 1 (the fact class evidence freeze); P33; #582 round 3, finding 4',
    on: { 'ChangeRequest.ChangeRequest_t4d_evidence_frozen': B('U') },
    // The delivered `ChangeRequest_t4b2_seal` freezes `decisionId` alone and is a MERGED
    // migration, so every column this unit adds arrived unfrozen. `decisionId` is deliberately
    // absent from this list for that reason — it is the delivered seal's, not this one's.
    // #582 round 8, finding 5 — the BIRTH set and the RESOLVER set are different rules and the
    // register now says so. `OLD."resolvedByCommandId" IS NOT NULL` witnesses the resolver's
    // close-once shape; the birth columns must NOT carry that guard, which `forbid` pins, because
    // an `OLD ... IS NOT NULL` guard on them is exactly the NULL -> value hole the finding names.
    // #582 round 26, finding 1 — the rule was stated over "the receipts and the actor pairs" and
    // implemented over exactly those. What the request SAID (`reason`, `costImpact`,
    // `timeImpactDays`), WHEN it was raised (`createdAt`), and WHEN and AS WHAT it closed
    // (`resolvedAt`, `resolution`) are the same evidence and were all rewritable. The birth four
    // are frozen against ANY update; the closure two take the one-way guard the rest of the
    // resolver set already carries, which is also what keeps the serving release's closure —
    // which writes them NULL -> value in the same statement as `resolvedById` — admitted.
    must: [
      'projectId', 'origin', 'revisionId',
      'sourceCommandId', 'requestedByRole', 'requestedByName',
      'resolvedByCommandId', 'resolvedByRole', 'resolvedByName',
      'OLD."resolvedByCommandId" IS NOT NULL',
      'reason', 'costImpact', 'timeImpactDays', 'createdAt',
      'OLD."resolvedAt" IS NOT NULL', 'OLD."resolution" IS NOT NULL',
    ],
    forbid: ['OLD."sourceCommandId" IS NOT NULL', 'OLD."requestedByRole" IS NOT NULL',
      'OLD."requestedByName" IS NOT NULL'],
  },
  phase6_t4d_identity_frozen: {
    rule: 'a recorded row\'s IDENTITY is frozen from birth — on every table that has one, not on '
      + 'the one table the rule was first written for',
    plan: '§A.3 obligation 1 (the fact class evidence freeze); #582 round 26, finding 3',
    on: {
      'ChangeRequest.ChangeRequest_t4d_identity': B('U'),
      'Membership.Membership_t4d_identity': B('U'),
      'Notification.Notification_t4d_identity': B('U'),
      'OrgMembership.OrgMembership_t4d_identity': B('U'),
    },
    // ONE function across the whole inventory, so the rule cannot be applied to three of its four
    // members the way it already was: `Decision` refuses this by name through the DELIVERED 4b
    // seal and these three did not refuse it at all. `TG_TABLE_NAME` is the token that witnesses
    // the seal is generic rather than four copies drifting apart.
    must: ['TG_TABLE_NAME', 'NEW."id" IS DISTINCT FROM OLD."id"'],
  },
  platform_t4d_event_pairing_claimed: {
    rule: 'an event of a pairing-required family is CLAIMED by exactly one fact',
    plan: '§A.3 obligation 7',
    on: { 'DomainEvent.DomainEvent_t4d_pairing_claimed': C('I') },
    must: ['DomainEventPairingClaim', 'pairingRequired'],
  },
  platform_t4d_stream_allocation: {
    rule: 'the counter moves by EXACTLY ONE — every increase is not an allocation',
    plan: '§A.2 the allocator; #582 round 1, finding 2',
    on: { 'ProjectEventStream.ProjectEventStream_t4d_allocation': B('U') },
    must: ['OLD."nextPosition" + 1'],
  },
  platform_t4d_stream_allocation_bound: {
    rule: 'each increment is PAIRED with the event written at the position it allocated, in this '
      + 'transaction',
    plan: '§A.2 the allocator; #582 round 1, finding 2',
    on: { 'ProjectEventStream.ProjectEventStream_t4d_allocation_bound': C('U') },
    must: ['DomainEvent', 'OLD."nextPosition"', 'txid_current'],
  },
  platform_t4d_stream_init: {
    rule: 'a stream is born at 0 for a project with no events — never introduced further along',
    plan: '§A.2 the allocator',
    on: { 'ProjectEventStream.ProjectEventStream_t4d_init': B('I') },
    must: ['nextPosition'],
  },
  platform_t4d_stream_no_delete: {
    rule: 'the counter is not deletable except as the project\'s own cascade — and "cascade" is '
      + 'the RI trigger DEPTH as well as the transaction flag',
    plan: '§A.2 the allocator; plan lines 421 and 5079; #582 rounds 6 and 8',
    on: { 'ProjectEventStream.ProjectEventStream_t4d_no_delete': B('D') },
    // The flag alone stands `on` for the rest of a transaction that deleted ANY project, so a
    // direct depth-1 delete of a second project's allocator rode it. Both halves or neither.
    must: ['phase6_t4d_project_is_deleting', 'pg_trigger_depth'],
  },
  platform_t4d_notification_binding: {
    rule: 'a notice bound to an event freezes `eventId`, `kind`, `decisionId` and `projectId`, and '
      + 'refuses its DELETE — a notice about a withdrawn decision is HIDDEN, never erased; and a '
      + 'KINDED notice\'s derived cache is frozen in BOTH axes, what it says and WHEN it said it',
    plan: '§A.2; #556 round 2, finding 5; #582 round 1, finding 6; round 6, finding 6; '
      + 'round 26, finding 2',
    on: { 'Notification.Notification_t4d_binding': B('D U') },
    // #582 round 26, finding 2 — round 6 froze the rendered STRINGS (`text`, `color`) and stopped
    // at the strings. `at` and `time` are the same derived cache in the other axis: the moment
    // every client sorts and groups by, and the clock the user reads. Moving them re-places a
    // notice among the acts either side of it while every word of it still reads true.
    must: ["TG_OP = 'DELETE'", 'eventId', 'kind', 'decisionId', 'projectId',
      'text', 'color', 'at', 'time'],
  },
  platform_t4d_notification_binding_bound: {
    rule: 'the INSERT arm is DEFERRED, because a notice may be written before its event — and it '
      + 'binds the notice to that event in BOTH directions: a Decision event owes a `decisionId` '
      + 'stamp, and a KINDED notice\'s `kind` equals the event\'s own `eventType`',
    plan: '§A.2; §A.3 obligation 7 (plan line 4507, "whose `kind` equals that event\'s `eventType`"); '
      + '#572 round 5, finding 1; #582 round 6, finding 4; round 7, finding 5',
    on: { 'Notification.Notification_t4d_binding_bound': C('I') },
    // `eventType` is the round-7 token: the binding selected the event's project, entity type and
    // entity id and never its TYPE, so a kinded notice could name an event that says something
    // else and the freeze made the false kind permanent.
    must: ['DomainEvent', 'eventType'],
  },
  platform_t4d_notification_no_truncate: {
    rule: 'the notice register is never truncated — its row seal would not fire',
    plan: '§A.2 TRUNCATE_SEALS',
    on: { 'Notification.Notification_t4d_no_truncate': S('T') },
    must: ['TRUNCATE'],
  },
  phase6_t4d_decision_event_no_truncate: {
    rule: 'the attributable audit register is never truncated, whatever it holds — the delivered '
      + 'seal beside it refuses only while an approval row is present, and 4d fills the register '
      + 'with change, forward, countersign and stranded kinds that are evidence just as much',
    plan: '§A.2 TRUNCATE_SEALS; §A.3 obligation 1; #582 round 24, finding 2',
    on: { 'DecisionEvent.DecisionEvent_t4d_no_truncate': S('T') },
    // the token is the phrase that distinguishes it from the DELIVERED t4a seal's conditional
    // message, which also contains 'TRUNCATE' and also names this table.
    must: ['attributable audit register and is never truncated'],
  },
  platform_t4d_domain_event_no_truncate: {
    rule: 'the delivery stream is never truncated — every 4d correspondence, claim and actor '
      + 'binding is judged against a row in it once, at write time, and never again',
    plan: '§A.2 TRUNCATE_SEALS; #582 round 24, the sweep behind finding 2',
    on: { 'DomainEvent.DomainEvent_t4d_no_truncate': S('T') },
    must: ['delivery stream every 4d correspondence'],
  },
  platform_t4d_effect_catalog_sealed: {
    rule: 'a catalog definition changes by a NEW coverage version, never in place: INSERT, UPDATE '
      + 'and DELETE all pass the migration gate, and retirement is a ONE-WAY stamp',
    plan: '§A.3 obligation 7 (the catalog); #582 round 1, findings 4 and 5',
    on: { 'ExternalEffectCatalog.ExternalEffectCatalog_t4d_sealed': B('I D U') },
    must: ['vitan.phase6_4d_catalog', 'retiredAt', 'pairingRequired', "TG_OP = 'DELETE'"],
  },
  platform_t4d_release_lease_frozen: {
    rule: 'the lease identity is FROZEN after insert, the only admitted update a NON-DECREASING '
      + '`leaseUntil`, DELETE refused',
    plan: 'plan lines 401 and 6712; P38; #582 round 1, finding 10',
    on: { 'ReleaseLease.ReleaseLease_t4d_frozen': B('D U') },
    must: ['instanceId', 'catalogVersion', 'startedAt', '"leaseUntil" < OLD."leaseUntil"'],
  },
  platform_t4d_project_org_frozen: {
    rule: 'a project\'s tenancy never moves once registered',
    plan: '§A.2 the ProjectOrg register',
    on: { 'ProjectOrg.ProjectOrg_t4d_frozen': B('U') },
    must: ['orgId'],
  },
  platform_t4d_register_writer: {
    rule: 'a projected register is written only by a trigger calling the platform primitive — a '
      + 'statement someone typed sits at depth 1 and is refused',
    plan: '§A.2 the registers; #561 round 1, finding 1',
    on: {
      'DomainEventPairingClaim.DomainEventPairingClaim_t4d_writer': B('I D U'),
      'OrgUserAuthority.OrgUserAuthority_t4d_writer': B('I D U'),
      'ProjectOrg.ProjectOrg_t4d_writer': B('I D U'),
      'ProjectRoleStanding.ProjectRoleStanding_t4d_writer': B('I D U'),
      'ProjectUserStanding.ProjectUserStanding_t4d_writer': B('I D U'),
      'UserIdentity.UserIdentity_t4d_writer': B('I D U'),
    },
    must: ['pg_trigger_depth'],
  },
  platform_t4d_register_no_truncate: {
    rule: 'every platform register carries the statement-level seal its row seal cannot supply',
    plan: '§A.2 TRUNCATE_SEALS',
    on: {
      'DomainEventPairingClaim.DomainEventPairingClaim_t4d_no_truncate': S('T'),
      'ExternalEffectCatalog.ExternalEffectCatalog_t4d_no_truncate': S('T'),
      'Membership.Membership_t4d_no_truncate': S('T'),
      'OrgUserAuthority.OrgUserAuthority_t4d_no_truncate': S('T'),
      'ProjectEventStream.ProjectEventStream_t4d_no_truncate': S('T'),
      'ProjectOrg.ProjectOrg_t4d_no_truncate': S('T'),
      'ProjectRoleStanding.ProjectRoleStanding_t4d_no_truncate': S('T'),
      'ProjectUserStanding.ProjectUserStanding_t4d_no_truncate': S('T'),
      'ReleaseLease.ReleaseLease_t4d_no_truncate': S('T'),
      'UserIdentity.UserIdentity_t4d_no_truncate': S('T'),
    },
    must: ['TRUNCATE'],
  },
};

describe('phase 6 unit 4d-i — every seal is checked against its CONTRACT, not only against a hostile write (live PG)', () => {
  let t: TestApp;
  let installed: Array<{ table: string; trigger: string; fn: string; ops: string; when: string; row: boolean }>;
  let bodies: Map<string, string>;

  beforeAll(async () => {
    t = await createTestApp();
    installed = (await t.prisma.$queryRaw<Array<{
      table: string; trigger: string; fn: string; ops: string; when: string; row: boolean;
    }>>`
      SELECT c.relname AS table, t.tgname AS trigger, p.proname AS fn,
             btrim(
               CASE WHEN t.tgtype &  4 <> 0 THEN 'I ' ELSE '' END ||
               CASE WHEN t.tgtype &  8 <> 0 THEN 'D ' ELSE '' END ||
               CASE WHEN t.tgtype & 16 <> 0 THEN 'U ' ELSE '' END ||
               CASE WHEN t.tgtype & 32 <> 0 THEN 'T ' ELSE '' END) AS ops,
             CASE WHEN t.tgtype & 2 <> 0 THEN 'BEFORE'
                  WHEN t.tgconstraint <> 0 THEN 'CONSTRAINT' ELSE 'AFTER' END AS when,
             (t.tgtype & 1) <> 0 AS row
        FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_proc p ON p.oid = t.tgfoid
       WHERE t.tgname LIKE '%\\_t4d\\_%' AND NOT t.tgisinternal
       ORDER BY 1, 2`);

    const defs = await t.prisma.$queryRaw<Array<{ name: string; def: string }>>`
      SELECT p.proname AS name, pg_get_functiondef(p.oid) AS def
        FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND (p.proname LIKE '%t4d%' OR p.proname LIKE 'platform_tx_%')`;
    bodies = new Map(defs.map((d) => [d.name, d.def]));
  });

  afterAll(async () => { await t?.close(); });

  it('the read is not vacuous — the unit installs a substantial inventory and its bodies are readable', () => {
    expect(installed.length).toBeGreaterThan(60);
    expect(bodies.size).toBeGreaterThan(30);
    expect(bodies.get('platform_t4d_event_envelope')).toContain('RAISE EXCEPTION');
  });

  it('every installed seal is DECLARED, and every declaration is INSTALLED', () => {
    const declared = new Set(
      Object.values(REGISTER).flatMap((c) => Object.keys(c.on)));
    const live = new Set(installed.map((i) => `${i.table}.${i.trigger}`));

    expect(
      [...live].filter((n) => !declared.has(n)).sort(),
      'these seals are installed by 4d-i and no REGISTER entry states the rule they implement. A '
      + 'seal nobody wrote a rule for is a seal nothing can check: add it here with its `on` '
      + 'operations and the `must` tokens its rule turns on.',
    ).toEqual([]);
    expect(
      [...declared].filter((n) => !live.has(n)).sort(),
      'the REGISTER names these seals and the database does not carry them — a declaration that '
      + 'matches nothing passes every arm below vacuously.',
    ).toEqual([]);

    // and every declared FUNCTION exists, including the two that back no trigger of their own
    for (const fn of Object.keys(REGISTER)) {
      expect(bodies.has(fn), `the REGISTER declares ${fn}, which the database does not define`).toBe(true);
    }
  });

  it('each seal fires on exactly the OPERATIONS its rule requires', () => {
    const wrong: string[] = [];
    for (const [fn, contract] of Object.entries(REGISTER)) {
      for (const [name, want] of Object.entries(contract.on)) {
        const live = installed.find((i) => `${i.table}.${i.trigger}` === name);
        if (live === undefined) continue;   // reported by the arm above
        if (live.fn !== fn) wrong.push(`${name}: runs ${live.fn}, declared under ${fn}`);
        if (live.ops !== want.ops) wrong.push(`${name}: fires on [${live.ops}], the rule needs [${want.ops}] — ${contract.rule}`);
        if (live.when !== want.when) wrong.push(`${name}: is ${live.when}, the rule needs ${want.when}`);
        if (live.row !== want.row) wrong.push(`${name}: is ${live.row ? 'FOR EACH ROW' : 'FOR EACH STATEMENT'}, the rule needs the other`);
      }
    }
    expect(
      wrong.sort(),
      'ENUMERATE THE OPERATIONS, NOT THE COLUMNS. A freeze installed BEFORE UPDATE alone is not a '
      + 'freeze, and a hostile-write probe about UPDATE will never say so — which is how the '
      + 'notice binding shipped without its DELETE arm.',
    ).toEqual([]);
  });

  it('each seal\'s BODY carries the tokens its rule turns on', () => {
    const missing: string[] = [];
    for (const [fn, contract] of Object.entries(REGISTER)) {
      const def = bodies.get(fn);
      if (def === undefined) continue;     // reported by the coverage arm
      for (const token of contract.must) {
        if (!def.includes(token)) missing.push(`${fn}: no \`${token}\` — the rule is: ${contract.rule} (${contract.plan})`);
      }
      for (const token of contract.forbid ?? []) {
        if (def.includes(token)) {
          missing.push(`${fn}: carries \`${token}\`, which the rule REMOVED — the rule is: ${contract.rule} (${contract.plan})`);
        }
      }
    }
    expect(
      missing.sort(),
      'the seal\'s prose may be right while the SQL under it is an abbreviation — that is exactly '
      + 'what round 1 on this PR found, fourteen times. Each token above is load-bearing for the '
      + 'rule beside it: either the implementation lost it, or the rule moved and this REGISTER '
      + 'entry (and the plan line it cites) has to move with it.',
    ).toEqual([]);
  });
});
