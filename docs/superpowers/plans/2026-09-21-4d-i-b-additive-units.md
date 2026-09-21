# 4d-i-b — the additive redesign (U1 · U2 · U3) and the obligation-to-unit map

Owner disposition of 2026-09-21 (issue #482, comment 5757145200) under the user's
"proceed as per your recomendation" approval: resume #590's product obligation now,
superseding the earlier hold-until-process-reforms sequencing, and deliver the pairing
switch-on as the additive `U1 / U2 / U3` design proposed in #590 comment 5680116372 —
not an ordinary NULL-only fourth point patch on the third-P1-stopped migration.

`#590`'s single migration (`20271222000000_phase6_t4d_i_b_pairing_switch_on`, 1244
lines, 24 files) combined all three pieces of §D's inventory — (a) the change-request
pairing seals, (b) the per-branch claimants, (c) the flip — and stopped at its third
distinct P1-bearing reviewed head (`2ff21dc1`, `40c896f0`, `ae6263ce`) with the
accepted NULL/system-actor defect open. This record splits that one unit into three,
each independently safe, each under the ordinary size cap, each with its own exact-head
review, **with the catalog flip and every claimant kept together in U3**.

The heads `#590 ae6263ce` and its four correction rounds stay as the record; nothing
here waives a finding or marks #590 merged. #615 (`f88d45d0`) and #614 (`43ad7ad3`)
stay deferred with their findings intact; the deferred `lockOrderProbe` helper is **not**
a dependency of this work (verified: #590's branch imports none of `lock-lifecycle` /
`lock-order-probe`, and main's `probes.ts` / `REVIEW_RUBRIC.md` defer it to `reform-1b`).

## Why three units are each safe

The mechanism is dark until a *coverage generation* carries `pairingRequired = true`.
That flip is a **new coverage generation** (an INSERT, never an in-place UPDATE — the
`ExternalEffectCatalog_t4d_sealed` seal admits only the retirement stamp). So any seal,
recorder or primitive installed **without** a flagged generation refuses nothing that a
release produces: every live event still resolves through 4d-i's two generations, whose
rows are all `pairingRequired = false`.

- **U1** installs the bound-event/actor primitive and one dormant `DomainEvent` rule.
  No flagged generation exists, so the rule never fires in production.
- **U2** installs the change-request bundle seals and the transition recorders. They
  *judge* bundles (both write orders) but *claim* nothing, and with no flag no bundle is
  demanded, so nothing is refused.
- **U3** performs the flip **with all claimants together**. Flipping a type without its
  claimant would refuse legitimate events at commit; installing a claimant for a type
  still `false` claims into a register nothing reads. These two are the pair §D calls
  inseparable, and they ship as one unit; every claimant's lookup goes through U1's
  primitive, and every bundle it opens is judged by U2's seals.

Sequence: U1 → U2 → U3. A unit is independently safe before the next starts; the flag
cannot activate (U3) until its primitive (U1) and its bundle seals (U2) are on main.

## The seven-branch actor obligation (§A.3 obligation 7)

Each row is one act with one actor. The event's `actorId` must name the same user the
fact records. Four branches carry a `DecisionEvent` audit row (bound by 4d-i's
`DecisionEvent_t4d_correspondence` when the event names an actor, made mandatory here);
three carry none by the delivered contract and are bound only through the primitive.

| # | event type | writer | fact (actor column) | audit row? | actor identity |
|---|------------|--------|---------------------|-----------|----------------|
| 1 | `decision.approved` | `decisions.approve` (from pending) | `DecisionApprovalRevision` finalized birth (`approvedById`) | yes | the approver |
| 2 | `decision.reapproved` | `decisions.approve` (no-chain reapproval) | `DecisionApprovalRevision` (`approvedById`) | yes | the approver |
| 3 | `decision.change_requested` (standard opening) | change-request open | `ChangeRequest` (`requestedById`) | yes | the requester |
| 4 | `decision.change_requested` (countersign_rejection) | 4d-ii reject-back | `ChangeRequest` (`requestedById`) | **no** | the disagreeing requester |
| 5 | `decision.change_withdrawn` | withdrawal/closure | `ChangeRequest` closure (`resolvedById`) | yes | the resolver |
| 6 | `decision.consultation_requested` | `consultations.request` | `DecisionConsultation` (`requestedById`) | **no** | the requester |
| 7 | `decision.consultation_responded` | `consultations.respond` | `DecisionConsultationResponse` (`respondedById`) | **no** | the responder |

**The accepted defect (round 4).** A current-generation `system` event (`actorKind =
'system'`, `actorId = NULL`) beside a fact approved by user A was claimed and committed:
4d-i's correspondence binds the actor only when the event *names* one (`actorId IS NOT
NULL`), and the three no-audit-row branches are judged by nobody there. U1's dormant
`DomainEvent` rule closes this at the event boundary — a `pairingRequired`-type event at a
flagged generation must be `human` with a non-null `actorId` — and the primitive binds
the three audit-less branches to their fact's actor at claim time.

**Both write orders.** Delivered writers write the *fact* then `emitEvent` several
statements later (fact-first); the harness also drives event-first. Each unconditional
claimant is therefore installed twice — an immediate `AFTER INSERT` trigger and a
`DEFERRED` constraint trigger — through `platform_claim_event_pairing_once`, so the pair
is order-independent. (A claimant property → U3.)

**Prior-generation compatibility.** The two 4d-i generations stay; nothing is retired
here (retirement is 4d-iii's act). A still-serving 4d-i writer keeps committing through
the version its intents carry. Every unit must leave prior-generation events untouched.

## Obligation → unit

### U1 — the bound event/actor primitive, before any flip (this unit)

- `phase6_t4d_tx_actor_event(project, decision, types, actor)` and
  `phase6_t4d_tx_actor_event_count(...)` — the same-transaction (`xmin =
  txid_current()`) `DomainEvent` lookup narrowed to one actor. The kernel-side
  `platform_tx_bound_event` the §A.3 correspondence names. Called by U2's seals and
  U3's audit-less claimants; installed first so both witness it.
- `DomainEvent_t4d_pairing_actor` — one **dormant** constraint rule: a `DomainEvent`
  whose `eventType` is `pairingRequired = true` at the event's own coverage generation
  must be `actorKind = 'human'` with `actorId IS NOT NULL`. No generation carries the
  flag until U3, so it refuses nothing in production. Its seed bypass is named `DL-003`;
  the test harness's bypasses are declared by name.
- **Matrix subset (reproduce-first):** the actor dimension on all seven branches,
  NULL/system actor included, exercised against a **test-flagged** generation so the
  dormant rule fires; the primitive returns the fact's-actor event and excludes a
  wrong-actor event. No claimant, no flip: the production catalog is untouched.

### U2 — the change-request bundle seals and recorders (deferred)

- Recorders: `phase6_t4d_decision_change_here` / `Decision_t4d_change_transition`,
  `phase6_t4d_change_request_here` / `ChangeRequest_t4d_lifecycle_transition`, and the
  `phase6_t4d_*_moved_in_tx` readers — a transition is not a state, and only the UPDATE
  holds OLD.
- `phase6_t4d_tx_audit_count` — the audit register counted in this transaction.
- The two deferred bundle seals `ChangeRequest_t4d_paired` and
  `Decision_t4d_change_paired` — the opening/closure/reapproval bundles in both
  directions, judging without claiming. Still no flip.

### U3 — the flip with its claimants, together (deferred)

- The flip: the new `ExternalEffectCatalog` coverage generation with `pairingRequired`
  true on exactly the six decision types, its `canonicalCatalog()` preimage change in
  `apps/api/src/platform/external-effects.ts`, and the catalog-successor audit proving
  the seed is the one shape 4d-i admits against the deployed prior generation.
- `platform_claim_event_pairing_once` and every claimant: `ChangeRequest_t4d_claim`,
  `DecisionApprovalRevision_t4d_claim` (+ `_deferred`),
  `DecisionConsultation_t4d_claim` (+ `_deferred`),
  `DecisionConsultationResponse_t4d_claim` (+ `_deferred`), and the one conditional
  `countersign_rejection` claim decided at commit. Each lookup goes through U1's
  primitive; each bundle it opens is judged by U2's seals.
- **Full 51-case matrix** at the flipped (CURRENT) generation, plus the prior-generation
  positives, plus the inherited seal-stripped and catalog-generation harnesses.

## The 51-case acceptance battery, carried forward unchanged

Per branch the matrix derives: the complete bundle commits **fact-first** and
**event-first** at CURRENT and the fact claims its event (2); the complete bundle commits
at the **PRIOR** generation (1, 4d-i compatibility); and each missing half / reused
evidence / **wrong actor** / NULL-actor is **refused at commit** (the negatives). U1
carries the actor-dimension rows; U2 carries the bundle-completeness rows against a
test-flagged generation; U3 carries the whole matrix at the real flip. The four
correction rounds' reproductions and the seal-stripped arms stay the acceptance battery,
mapped to the unit that installs the seal each names.

## Deployment window, per unit

Each unit's migration derives its own all-or-nothing `NOWAIT` lock set from its own DDL
(the tables it adds a trigger to), inside a bounded subtransaction that fails closed —
the round-36/37 census oracle. U1 locks `DomainEvent`; U2 locks `ChangeRequest` and
`Decision`; U3 locks `ChangeRequest`, `DecisionApprovalRevision`, `DecisionConsultation`
and `DecisionConsultationResponse`. The catalog is INSERT-only (RowExclusive) and
contends with nothing.
