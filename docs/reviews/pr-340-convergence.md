# PR #340 — convergence audit (the 4b–4d decision-workflow plan)

Owed at the second finding-bearing head. Docs-only diff, and — unlike PR #335 —
STATUS-FREE from round 1 on: the folded flip was reverted out at the first
correction and travelled as its own PR #341 (merged), so if this plan review
reaches the three-finding-head cap, the deferral trailer
`Review-Deferred-To-Probes: phase-6-task-4` is available to the answering head
with no two-step.

| head | role | findings | outcome |
|---|---|---|---|
| `3ba1688` | the plan + a folded STATUS flip | 7 (3 P1, 4 P2) | STATUS reverted, the flip split out as PR #341; corrected on `29eeeef` |
| `29eeeef` | round-1 batch | none of its own — superseded unreviewed by the conflict-shepherd merge before any verdict | counts once with `d387412` |
| `d387412` | `29eeeef` + `origin/main` merged (shepherd directive; the plan bytes unchanged by the merge) | 8 (4 P1, 4 P2) | corrected on `c5255c0` |
| `c5255c0` | round-2 batch + this packet opened | 6 (2 P1, 4 P2) | corrected on `bb28589` |
| `bb28589` | round-3 batch, carrying BOTH trailers (`Review-Convergence` + the deferral) | 9 (6 P1, 3 P2) | corrected on `a0f6d78`, which also stated the generative rule as the plan's §C.3 uniform seal contract |
| `a0f6d78` | round-4 batch + the §C.3 contract | 4 (2 P1, 2 P2) | corrected on `6a53aae`; the lifecycle advisory fired and the restructure pre-commitment became binding |
| `6a53aae` | round-5 batch | 8 (4 P1, 4 P2) | the SIXTH finding head — the pre-commitment is HONORED on `7d3c65a`: the unit NARROWS to the 4b plan (`2026-08-14-decision-workflow-4b.md`); the 4c/4d designs remain readable at `6a53aae` as the successors' starting material |
| `7d3c65a` | the NARROWED 4b plan's first reviewed head | 4 (2 P1, 2 P2) | corrected on `2228e2d` — the narrowed unit's first correction, carrying the stop rule |
| `2228e2d` | round-7 batch | 7 (3 P1, 4 P2) | the stop rule executed on `536b6da` (packet-only) — held for owner direction |
| `536b6da` | the stop record | 6 (4 P1, 2 P2) — one ON THE STOP ITSELF | the stop SUPERSEDED per AGENTS.md's non-blocking rule; rounds 8+9 folded on `af8d6be`; the owner escalation remains the asynchronous channel |
| `af8d6be` | rounds 8+9 folded | 7 (6 P1, 1 P2) — three on the round-8/9 fixes, one a packet bookkeeping error | corrected on `56d09c0`, MINIMALLY: full approval-column + child-evidence seals on recorded rows; targeted events never fan to unlinked devices; publish validates role-held deciders + the record identity tuple; the departed-approved-holder 409 names the TRUE state; this ledger reconciled |
| `56d09c0` | round-10 batch | 4 (2 P1, 2 P2) | corrected on `d93859d`, MINIMALLY: `Decision.id` joins the publication-entry + terminal freezes; the holder-orphan guard reaches the org-membership writes (`removeOrgMember`/`updateOrgMemberRole` demoting the last effective PMC refused, both layers); the portfolio caller passes the viewer into `countPending` for every decider-capable role; `recorded` terminality binds at PUBLICATION, admitting the one coherent unpublished kind+status draft edit the round-8 path requires |
| `d93859d` | round-11 batch | 3 (2 P1, 1 P2) | corrected on `1c9f2c7`, MINIMALLY: `OrgMembership.orgId` joins the identity freeze (an org-move is removal + addition under every affected project's readiness key, never one UPDATE); entry INTO `recorded` sealed for published rows (an approved decision cannot be laundered into a record while its approval evidence survives in the children); the AUTH-02 client-side selector mirrors (`selectLogDecisions`/`selectVisibleDecisions`) follow the decider |
| `1c9f2c7` | round-12 batch | 7 (4 P1, 3 P2) | corrected on `716b707`: the identity-freeze CLASS stated once over the whole standing-derivation chain (`Membership.userId/projectId` + `OrgMembership.userId/orgId` + `Project.orgId` — re-homing any link is removal+addition, closing the per-column enumeration); ascending-order multi-project lock acquisition; sign-out UNLINKS the push subscription; `photoSwatch` joins the terminal freeze; the decider tuple joins the create idempotency preimage; the converted draft re-judges the two-option floor at publish |
| `716b707` + `185879c`/`a32d592` (the shepherded main-merge + its protocol note) | round-13 batch | 3 (3 P1) | corrected on this head: `authorId`/`projectId` INSERT-frozen for every decision (the round-10 publish-time re-check accepts a forged-but-authorized identity; the freeze forecloses the launder — no product path ever edits identity); the `'client'` backfill is DIAGNOSTIC-FIRST (aborts on a pre-existing published open decision with no effective holder — never births the zero-holder state the guard refuses); the push link records `credentialVersion` at attribution and the claim re-checks it (a password reset severs targeted delivery without a browser sign-out) |

## Round 1 — two repeated loop lessons, five underspecified mechanisms

Two findings were about the autonomous loop's own bookkeeping, and both were
lessons ALREADY RECORDED from PR #335 that the opening head repeated: folding
the STATUS flip into a plan PR blocks the deferral trailer the cap will
eventually demand (answered by the revert + PR #341, this time before the cap
instead of at it), and `work_item` must keep the `none` sentinel while
`task_state` is an open state because `assessRunnerState` consults `work_item`
only in the `merged` branch (the named value I wrote was dead data that would
resolve the bare parent task; verified against the script, sentinel kept).

The five design findings share one class: the plan stated a sound invariant
and left its enforcing mechanism underspecified, so the stated form was
defeatable.

- "Cancel a targeted push when its target changed" was written holder-only;
  the class's normal targets are often NOT holders (consultee, requester,
  architect). Each event family now declares its own still-actionable
  predicate, at enqueue AND at claim (P38/P40).
- The forward door accepted ANY same-tx `DecisionForward` row; a row naming
  unrelated designations would satisfy it. The seal now compares the
  transition to its evidence field-for-field (P34).
- The countersign seal covered only the `awaiting_countersign → approved`
  edge, leaving the direct `pending/change → approved` road open to hostile
  SQL. The seal now judges EVERY entry into `approved` (P37).
- `deciderKind='none'` with `status='pending'` was representable at the DB — a
  published decision no one can approve, still driving every pending surface.
  The kind–status pair is now CHECK-coherent in both directions (P18).
- A decision stranded in `awaiting_countersign` when the last architect
  leaves had no command that could move it. The PMC-only
  `decisions.resolveStrandedCountersign` now exists with two attributed
  outcomes (P29b).

## Round 2 — the seals the round-1 corrections added, held to their own standard

All eight findings land on round 1's OWN additions, and the class is uniform:
a seal was named but not yet attributable, serialized, or two-sided.

- **Attributable (F2, P1)**: "flipped by the countersign" was a boolean with
  no act behind it — hostile SQL could flip `finalized` and approve. The
  countersign is now a concrete append-only `DecisionCountersign` row, and
  the flip is trigger-PAIRED to it (P31).
- **Serialized (F1, P1)**: the approved-entry seal merely READ architect
  presence, so a first-architect activation could commit between the read and
  the hostile approval's commit. The seal (and the architect-standing
  `Membership` writes) now take the SAME per-project readiness advisory lock
  before the presence read — the row-`FOR UPDATE` alternative is explicitly
  rejected in the plan as phantom-prone: a FIRST activation has no architect
  row to lock (P37).
- **Two-sided (F4, P2)**: the forward door checked holder-change → evidence
  but not evidence → holder-change; an orphan `DecisionForward` insert
  fabricated history. A deferred reverse seal now refuses it (P34).
- **Both verbs (F3, P1)**: `recorded` was sealed against UPDATE but not
  DELETE; the 4a no-delete seal extends to it (P18).
- **Both designations (F7, P2)**: `holdsOpenDecisions` took only a
  `membershipId`, missing role-designated holders; removing the last active
  member of a role named by an open decision is now refused too (P39).
- **Identity in the freeze (F5, P2)**: `decisionId` joined the
  `ChangeRequest` evidence freeze — an open request re-pointed at another
  decision stripped the change-state decision of its required request (P33).
- **The product path (F8, P2)**: the architect fan-out now includes the web
  Team-screen role pickers/labels — a role with no UI path to mint it
  activates only through direct API calls, which is not a shipped feature
  (P28).
- **The path my own widening broke (F6, P1)**: round 1's "seal EVERY entry
  into `approved`" — my correction — refused the ordinary standard
  `withdrawChange` restoration (`change → approved` on an already-finalized
  head). The seal now carves that exact arm: `origin='standard'` AND head
  already finalized; `countersign_rejection` restoration stays refused (P37).

## Round 3 — round 2's own corrections, held to their own standard again

Three of the six findings land directly on text I wrote in round 2, and the
packet names them plainly:

- **The lock protocol I chose could deadlock (F4, P2)**: binding the
  `Membership` seal trigger to BLOCK on the readiness advisory lock inverts
  the service's lock order — a direct write holds its row lock before its
  trigger runs, so it waits on the key while a service command holding the
  key waits on the row. Restated as TRY-ACQUIRE-OR-REFUSE: reentrant success
  on the service path, hold-to-commit when free, deterministic refusal when
  contended — a seal refuses, it never waits inside a trigger (P37).
- **"Same-or-prior-transaction" was the split act (F5, P1)**: my round-2
  arm (ii) accepted a PRIOR-transaction countersign row, which is exactly the
  hostile shape — row + flip planted first, status flipped later. The
  countersign is now ONE atomic transaction sealed from BOTH sides: a
  deferred reverse seal refuses a `DecisionCountersign` insert without its
  same-tx flip AND `awaiting_countersign → approved` transition (P31).
- **The inactive-chain arm I added opened the stranded bypass (F2, P1)**:
  round 2's arm (iii) legalized ANY direct approval under an inactive chain,
  including `awaiting_countersign → approved` — ending a countersign-required
  approval with no resolution evidence. The arm narrows to `pending`/`change`
  (approvals born under no chain), and the awaiting exit always demands
  paired evidence: the countersign row, or the stranded resolution — which
  becomes a concrete append-only `DecisionStrandedResolution` fact with its
  own reverse pairing (P29b/P37).

The other three are coverage gaps of the same class as rounds 1–2: the
forward TARGET's standing sealed at the DB, not only the service 409 (F1,
P2 → P34); the decider audience carried into the SERVABLE `decisions.inbox`
projection row/fold/filter, probed on the projected slice (F3, P2 → P22);
and the on-behalf approval evidence freezing the EXACT holder tuple so a
later forward cannot orphan the consent record (F6, P2 → P16).

## Round 4 — the generative rule named, and stated as the contract

Round 4's nine findings do not have nine root causes; they have ONE. Every
round of this review has walked instances of the same generative rule —
*each fact table needs the same INSERT-side pairing, actor-standing, and
subject-eligibility seals its siblings got* — one instance per finding: the
revision's BIRTH value (F1), the countersigner's architect standing (F2),
`origin` in the freeze list my own round-2 expansion omitted (F3), the
forward ACTOR's standing (F4), the decider membership's standing + the
`Membership.userId` re-key (F5), the door's status gate (F6), the member
decider's approval ROUTE (F7), the stranded reason's non-blank discipline
(F8), and the consultation row's eligibility (F9). The finding rate did not
decline (7 → 8 → 6 → 9) because enumerating instances cannot close a
generative class.

The round-4 correction therefore does BOTH things: it fixes all nine
instances, and it states the rule itself as the plan's §C.3 **uniform seal
contract** — five obligations (append-only+freeze, bidirectional transition
pairing, actor standing, subject eligibility, same-project FKs) with a
CLOSED table mapping every 4b–4d fact to each obligation and its probe.
Omitting an obligation on a future fact is now a defect by construction,
not a per-round discovery, and each unit's review packet walks the table
for every fact it ships.

## Round 5 — the contract doing its job, and the lifecycle advisory

The rate finally fell (7 → 8 → 6 → 9 → **4**), and the shape of the four
findings is exactly what the §C.3 contract was built to produce: two are
CELL corrections to the contract's own table (the consultation fact's
actor-standing cell validated the consultee but not the RECORDED actor
`requestedById` — F4; the stranded pairing cell named the transition but
not the `countersign_rejection` request the `'returned'` bundle must carry
— F2), one is a structural uniqueness the response fact was missing (one
response per consultation — F3), and one closes the last content gap in the
§C.2(i) membership seal (timing was serialized but the holder-orphaning
predicate was not re-judged, so a direct write could still strand an open
decision's holder — F1). All four fixed in one head; the table and probe
rows updated in place.

**The lifecycle advisory fired on this head**: "This unit has 5
finding-bearing heads (limit 5), with findings up to critical. Consider
splitting it into a smaller review unit." Recorded here verbatim, not
argued with. The observation is advisory by design (it decides nothing and
blocks nothing — `review-lifecycle.mjs` states why), and this round's
declining, contract-shaped findings justify ONE more correction head. The
pre-commitment, binding on the next round: **if the round-6 review of this
head returns further findings, this unit is RESTRUCTURED, not corrected
again** — split along the unit seam the plan itself defines (§A/4b, §B/4c,
§C/4d each becoming its own docs-only review unit, the cleared sections
carried verbatim), the PR #335 narrowing precedent applied at the same
limit that forced it there.

## Round 6 — the pre-commitment honored: the unit narrows

Round 6 returned eight findings (4 P1, 4 P2), all verified real — the rate
went back UP (4 → 8), and the round-5 pre-commitment therefore binds: **no
seventh correction head.** The unit narrows in place, the PR #335 precedent
applied literally: the document becomes the 4b-ONLY plan
(`docs/superpowers/plans/2026-08-14-decision-workflow-4b.md`, replacing the
joint `…-4b-4d.md`), carrying the seal architecture every later unit cites
(the try-acquire protocol, the cross-module DB primitive rule, the uniform
contract), while the 4c and 4d designs remain readable at head `6a53aae` as
the pre-declared STARTING MATERIAL of their own follow-up plan units. The
staging is per-unit and plan-first: 4b plan → 4b impl → 4c plan → 4c impl →
4d plan → 4d impl.

Disposition of the eight round-6 findings — three FOLDED into the narrowed
plan, five CARRIED by name in its §D (nothing dismissed):

- FOLDED — the published `recorded` decision's question/option evidence
  freeze (P1 → the 4b plan §A.2, probed in P18, draft edits retained).
- FOLDED — membership seals behind the orgs boundary (P1): a decisions-owned
  trigger must not SELECT the orgs-owned table, so the plan defines OWNED,
  DECLARED SQL primitives per module — the DB analogue of the participant
  channels (§B.2) — with the orgs-owned membership seal calling the
  decisions-owned open-holder predicate and vice versa. This is
  ARCHITECTURAL and correct: the joint plan's trigger reads would have
  crossed the module boundary at the database layer.
- FOLDED — target standing joins the push-predicate CLASS (P2 → §A.3 as a
  class rule; the consultation instance carried to 4c).
- CARRIED to the 4c plan (§D 1–3): the consultation audience in the
  servable projection (P2); the response-side hostile eligibility probes
  (P2); the consultation families' standing predicates (P2 instance).
- CARRIED to the 4d plan (§D 4–6): revision INSERTs paired with their
  approval act under BOTH chain states (P1); exactly-ONE fact per paired
  transition, duplicate-row probes (P2 — also absorbed into the contract's
  obligation 2 for every future fact); the `countersign_rejection` request
  sealed bidirectionally to its transition with an active-architect
  requester (P1).

## Round 7 — the narrowed unit's first review

Four findings on the narrowed head `7d3c65a` (2 P1, 2 P2), all verified
real, all corrected in one head:

- **The deferral must name probes, not prose (F1, P1)**: §D listed the five
  carried obligations without probe names, and the ledger pointed at
  successor tables that do not exist yet — deferring open questions to
  probes that are not in the plan. §D now binds each carried question to a
  NAMED probe (P25c/P25d, P38c/P40c, P31b/P42b, P31c/P34b, P33b — the
  P23–P42 numbering held RESERVED to the successor units) with a one-line
  PROVES statement each; the successor plans elaborate the full rows those
  named probes execute.
- **The recorded author needs a standing primitive (F3, P1)**: nothing at
  the DB validated `authorId` on a terminal `recorded` insert — a row born
  permanent, attributed to nobody. The orgs primitives gain
  user-decision-authority (active decision-creating membership OR the
  membership-less org-admin case), consumed by the recorded-insert seal
  (P18's author arm).
- **The decider needs a shipped creation UI (F2, P2)**: the create modal
  gains the decider picker (client default byte-identical, pmc, named
  ACTIVE member via the participant-loaded candidates, record-only) — a
  contract field no screen can set is not a product path (P16's UI arm).
- **A private draft must not block a removal (F4, P2)**: the holder freeze
  now binds AT PUBLICATION (draft holder edits legal, publish atomically
  re-validates standing, the stranded draft is fixed by editing), and the
  holder-removal guard — both layers — scopes to PUBLISHED open decisions
  (P17/P39 arms).

**The stop rule, stated plainly**: this was the narrowed unit's first
correction. If the next review round returns further findings, no further
correction is pushed — the run stops and the full seven-round history goes
to the owner for direction.

## Round 8 — STOPPED, awaiting owner direction

Round 8 returned seven findings on `2228e2d` (3 P1, 4 P2). All seven are
verified REAL and are recorded here honestly, but per the stop rule NO
correction is pushed:

- (P1) `Membership.projectId` is absent from the identity-freeze
  enumeration — a direct project-move of the last holder membership strands
  a published decision with `status`/`role` untouched.
- (P1) the `approved → change` reopen path (`requestChange`) does not
  revalidate the holder — a member removed while the decision was
  `approved` (legal: the guard scopes to OPEN decisions) leaves the
  reopened decision with no valid decider and no 4b repair command.
- (P1) `authorId` is absent from the published-record evidence freeze — a
  permanent `recorded` row can be reattributed after publication.
- (P2) the `active-member-count` primitive does not model membership-less
  org-admin-as-PMC effective standing — a false 409 can block removing the
  last PMC membership indefinitely.
- (P2) the round-7 "edit the draft's holder" recovery has no shipped draft
  UPDATE command/UI.
- (P2) `DraftsScreen` readiness (`options.length >= 2`) makes a zero-option
  record draft unpublishable through the UI.
- (P2) the concurrency probes do not mandate deterministic barriers.

**Why the stop seemed right**: eight rounds (53 findings, every one real)
showed a stream that did not converge even after the narrowing — the "a
plan can always be specified further" pathology. The stop escalated the
how-to-proceed decision to the owner in the PR thread.

## Round 9 — the stop superseded: the loop resumes

The round-9 review of the stop-record head returned six findings — five
more real plan findings, and one P1 on the STOP ITSELF: halting the run to
await an owner contradicts AGENTS.md's explicit non-blocking rule ("do not
block on human sign-off — no one is standing by to give it"), the same
principle `scripts/review-lifecycle.mjs` states as its own design
rationale. The reviewer is right about the constitution: the stop rule was
SELF-imposed at round 7, and the repository's design is that the loop
continues autonomously while the owner intervenes ASYNCHRONOUSLY if they
choose. So the stop is superseded, recorded honestly: the loop resumes with
one batched head folding the seven held round-8 findings and the five
round-9 plan findings (Membership.projectId in the identity freeze; the
requestChange reopen revalidation; authorId + projectId in the recorded
freeze + the approval-columns-NULL coherence; effective-role-standing
covering the membership-less org-admin PMC; the shipped decisions.updateDraft
path; zero-option record drafts publishable; deterministic barriers
mandated; publishedAt write-once for every decision — killing the
unpublish-repoint-republish bypass; project operability in the authority
primitive under the Project row lock; the staged push-subscription user
attribution with no regression for unlinked devices). The owner escalation
comment REMAINS POSTED as the standing asynchronous channel — any direction
given there overrides the loop's course. Nothing in this resumption merges
anything: the exact-head gate still fails closed on any current-head
finding.

## Shepherded main-merges

The orchestrator's behind-main shepherd directed merging `origin/main`
into this branch after PR #343 (the deterministic pillar-chain e2e waits)
merged; the merge head carries main's test-infrastructure change verbatim
and alters NO plan or packet content. This note exists because the
convergence protocol requires every pushed head past the third finding
head to touch this packet and carry both trailers — a shepherded merge
commit is a pushed head like any other.

## Rounds 10–14 — instances of settled classes, folded minimally

Round 10 (seven findings on `af8d6be`, folded on `56d09c0`), round 11
(four findings on `56d09c0`, folded on `d93859d`), and round 12 (three
findings on `d93859d` — the lowest count of the review — folded on the
`d93859d`: the org-identity freeze arm, the recorded ENTRY seal, the
client-side selector mirrors), and round 13 (seven findings on `1c9f2c7`,
folded on the current head — four more identity-chain instances answered
by stating the freeze CLASS once, plus session-unlink, the swatch freeze,
the idempotency preimage, lock ordering, and the converted-draft option
floor), and round 14 (three P1s on the post-round-13 head, folded on the
current one — the birth-freeze superseding publish-time revalidation, the
diagnostic-first backfill preflight, the credential-version claim check)
all land on the
rounds-8/9 corrections' own text, and every finding is an enumerable-class
instance of a rule the plan already states: a freeze list missing a column
(the approval-written `material`/`cost`/`date`; then `Decision.id` itself),
a guard bound to one table while the standing it protects spans two (the
org-membership writes that flip membership-less effective-PMC standing), a
caller not yet passing what its callee gained (the portfolio viewer into
`countPending`), a fallback that traded correctness for delivery (the
unlinked-device role fan-out, replaced by suppression), a named escape that
did not cover the state it was named for (withdraw on approved rows), and
one internal contradiction between two of the plan's own corrections
(unconditional `recorded` terminality vs the round-8 draft-edit path —
resolved at the publication boundary every other 4b freeze binds at, with
the one coherent unpublished kind+status transition admitted explicitly).
All twenty-four verified real, none disputed, none refuted. The correction
pattern stays minimal-edit; the lifecycle observation stands recorded —
fourteen finding-bearing heads against an advisory limit of five — and the
owner escalation thread on this PR remains the standing asynchronous
channel that can override the loop's course at any time.

## Deferral ledger

Nothing is disputed: all eighty-three findings across fourteen rounds were
verified real; thirty-eight were corrected in place (rounds 1–5 and 7),
three were folded into the narrowed 4b plan, five are carried as NAMED
PROBES (§D of the 4b plan: P25c, P25d, P38c/P40c, P31b/P42b, P31c/P34b,
P33b — numbering reserved to the pre-declared 4c/4d plan units whose own
exact-head reviews adjudicate them), and the rounds 8–14 findings were FOLDED by the resumed corrections
(heads `af8d6be`, `56d09c0`, `d93859d`, `1c9f2c7`, `716b707`, and the
current one) — every disposition lives
in the head table above, none held, none dismissed. No refutations were posted on this PR. Every head past the
third finding head carries `Review-Deferred-To-Probes: phase-6-task-4`
beside `Review-Convergence: complete`; the probes are the executable
deferral targets, and the exact-head gate still fails closed on any
current-head finding.
