# PR #344 — convergence audit (Phase 6 unit 4b-i, the per-decision decider and its seals)

Owed at the second finding-bearing head per the review-efficiency protocol.

| head | role | findings | outcome |
|---|---|---|---|
| `ed72636` | the 4b-i unit (staged RED shape → GREEN), split at the review budget into facts+seals with the surface deferred to 4b-ii | 12 (8 P1, 4 P2) | corrected on `067209bc` via `20270816000000`: the recorded seal's DELETE arm; approval EVENTS counted at conversion and sealed after it; a `decision.recorded` effect key so a record pushes nothing on either publish path; the act tuple actually frozen; a diagnostic-first audit in front of the option freeze; `FOR SHARE` on the head row under the option guard; the DB author predicate narrowed to `ROLE_POLICY['decision.create']`; `OrgsParticipant.describeMembership`; `requestChange` returning an actionable 409; the announcement naming the real holder; the membership id passed only when active standing ends; `DecisionsParticipant.holdsOpenDecisions` |
| `067209bc` | round-1 fold | 4 (3 P1, 1 P2) | corrected on `2ef9d68` via `20270817000000`: the act tuple's first write keyed to the TRANSITION rather than the destination status; the conversion door asking the author question the insert door asks; the ChangeRequest seal reading its parent `FOR UPDATE`; and the member guards computing surviving standing from `orgs_effective_role_standing` instead of asserting it, with `updateRole` taking the readiness lock so guard and seal read one snapshot |
| `2ef9d68` | round-2 fold + this audit's first edition | 7 (4 P1, 3 P2) | corrected on this head via `20270818000000`: the act tuple validated against the decision's own `deciderKind`/`deciderMembershipId`; the approve route ceiling widened to every role that may be NAMED, with the holder narrowing left in the service; the decision id frozen FROM BIRTH; the reopen seal restated over every transition INTO an open status; the departing role read from the LOCKED membership row; the org arm narrowed to the standing the written row actually supplies; and the publish side-effect bundle derived from the row the CAS locked |
| `87461e6` | round-3 fold + this audit's second edition | 5 (2 P1, 3 P2) | corrected on this head via `20270819000000` plus its service half: the approval REGISTER sealed against a record (the reverse of a count the conversion already made); the holder binding applied at BIRTH as well as at the transition; and the three remaining SPOKESMAN doors given their service-side question — publish holds the readiness key the seal try-acquires, publish and one-step issue refuse a departed holder with an actionable conflict, and the two org-membership commands ask the decisions participant before the write |
| `cc00c94` | round-4 fold + this audit's third edition | 6 (3 P1, 3 P2) | corrected on this head via `20270820000000` plus its service half, under the owner's **"gate the surface, keep the facts"** decision: `recorded` made unlinkable at every write path and both pickers; the `pmc`/`member` decider designation refused at the contract until 4b-ii ships its audience; the frozen approval LABEL required complete, non-blank and BOUND to the designated holder, with the service deriving it from the seal's own function; the org-membership guard and its write folded into one transaction holding each affected project's readiness key; `requestChange` validating ROLE-held deciders as well as named ones; and post-write standing ASKED of the primitive instead of computed as `standing - 1` |
| `ccaf2dd` | round-5 fold + this audit's third edition | 7 (4 P1, 3 P2; 8 comments) | corrected on this head via `20270821000000` plus its service and WEB halves: the attribution rule restated over the APPROVAL ACT rather than over the columns an act touches; `decisions_t4b_blank` giving "blank" one statement over the whole ASCII whitespace set; the `pmc`/`member` surface gate extended to BOTH publish doors; the ROLE arm of the publication holder check given its spokesman on both doors; the org guard's departing role read `FOR UPDATE` inside its transaction; the membership-ACTIVATION arm of the holder seal given its spokesman; and the register taught to render a `recorded` row as a record rather than as an approval |
| `39bfb39` | round-6 fold + this audit's fourth edition | 3 (1 P1, 2 P2) | corrected on this head via `20270822000000` plus its service half — **all three are round 6's OWN over-reach**: the approval-act rule exempted from a RESTORATION (`withdrawChange` returns an approval that already happened); the frozen tuple preserved by the service on a re-approval rather than re-derived; and the activation guard — in BOTH the service and the seal — asking whether the membership was already active rather than trusting `TG_OP`, which Prisma's `upsert` makes a lie |
| `90ec557` | round-7 fold + this audit's fifth edition | 3 (2 P1, 1 P2) | corrected on this head via `20270823000000` plus its service half: the restoration exemption NARROWED to a real withdrawal (from `change`, evidence unchanged, and an approval that actually happened); the decision row LOCKED before `publish` judges its holder and held through the update; and the holder's identity HELD (`FOR SHARE`, through its owner) across the first approval's derive → write → recompute |
| `92868d7` | round-8 fold + this audit's ninth/tenth editions | 3 (2 P1, 1 P2) | corrected on `a283568` via `20270826000000` plus its service half: the restoration proof required to PREDATE the open change request; user+membership provisioning folded into one transaction holding the readiness key; and `members.add` running the same departure guard `updateRole` runs |
| `a283568` | round-9 fold | 2 (2 P1) | corrected on `f113f94` via `20270827000000`: the restoration exemption's forgeable clause REPLACED by a set enumerated once at upgrade time (`DecisionLegacyApproval`, sealed against every later write), keeping round 7's two statement-shape conditions; and the draft → record conversion made to ask the OWNING modules whether anything already depends on the draft — the reverse of a link rule that was only enforced forwards |
| `f113f94` | round-10 fold + this audit's eleventh edition | 5 (2 P1, 3 P2) | corrected on `7988f26`, all inside the unmerged `20270827000000`: the stamp widened to legacy approvals already sitting in `change` (an ordinary pre-existing change request was otherwise unwithdrawable forever); the register declared in `schema.prisma` so drift cannot DROP it; R4-2's born-approved-tupleless INSERT door CLOSED, its justification having been dissolved by round 10 itself; the stamp made genuinely ONE-SHOT (guarded on the seal's own existence, not per row, so a later re-run cannot enlarge the set); and a statement-level `BEFORE TRUNCATE` seal for the verb a row trigger never sees |
| `7988f26` | round-11 fold + this audit's twelfth edition | 3 (3 P2) | corrected on `99cbada` via `20270828000000` plus a schema and a service edit: the evidence FK's UPDATE action DECLARED `NoAction` to match the database (a Prisma relation defaults to `Cascade`, and `migrate diff` was emitting `ON UPDATE CASCADE` for it); `addOrgMember`'s upsert routed through the SAME transactional holder guard — and the same last-owner rule — that `updateOrgMemberRole` runs; and publication revalidating a RECORD's author, the third of three doors that the migration's own header already claimed all asked |
| `99cbada` | round-12 fold + this audit's thirteenth edition | 2 (2 P2) | corrected on this head: the RECORD arm added to `assertPublishableHolder` through a new orgs-owned `userHasDecisionAuthority` participant method calling the SAME primitive the trigger calls (round 12 added the seal and left it without a spokesman, so an ordinary stale-draft publish 500'd); and the stamp + both its seals folded into ONE `DO` block, because round 11's one-shot GUARD is not atomicity — an interrupted non-transactional apply committed rows with no seal, and the retry then died on the primary key |

## Root analysis — one generative class, three faces

All twenty-eight findings across four rounds are instances of ONE rule: **an invariant has exactly one
statement, it lives at the thing that determines it, and it is asked at every
way in.** Each finding is a violation of one of those three clauses, and the
three are not separate mistakes — they are what goes wrong when a rule is
written where the code happened to be rather than where the truth lives.

**Face A — stated at SOME of the ways in.** The rule was right; the enumeration
of the doors was short.

- F1: the recorded seal named INSERT and UPDATE. A published record could be
  DELETED, because 4a's no-delete covers `withdrawn` only. A missing VERB.
- R2-2: the author predicate ran on INSERT-of-`recorded`. The draft → record
  CONVERSION — the lifecycle the plan explicitly supports — never asked. A
  missing DOOR within a verb.
- F2: approval evidence was counted in the revision register and not in
  `DecisionEvent`, and only on the way IN. A missing register, and a missing
  direction.
- F5: `20270815000000` applies diagnostic-first discipline to its orphan audit
  in Section 2 and ships an option freeze in Section 5 with no audit at all. A
  missing SECTION of the same file.
- F3: the record's side effects were branched nowhere, so a record-only issue
  pushed "awaiting your approval" on both publish paths.

**Face B — RE-STATED where it is not determined.** The rule existed twice, and
the second copy drifted. Every drift was in the same direction: the copy was
*stricter or wider than the authority it fronted*, which is worse than useless
because the authority is the thing nobody can appeal to.

- F7: the DB author predicate admitted `engineer`; the shared
  `ROLE_POLICY['decision.create']` admits only `pmc`. SQL restating policy.
- F8: `approve` read the orgs-owned `Membership` table from the decisions
  service. A module restating another module's standing question.
- F11 / R2-4: the service guard was STRICTER than the seal — first displacing a
  named holder whose membership stays active, then asserting a departing role
  removed the last standing without ever counting the other holders. A service
  restating a seal's arithmetic.
- F9 / F12: where the service did NOT restate the seal, the seal's raw
  PostgreSQL exception reached the caller as a 500. The same defect from the
  other side: an authority with no spokesman.
- F10: the announcement said "Client approved" for every decider, restating as
  prose a fact the same transaction persists.

**Face C — keyed to the wrong quantity.** The rule was in the right place and
asked at every door, but discriminated on something that is not the truth.

- F4: the "frozen" holder tuple was frozen by nothing at all — the claim was in
  the packet, the body and the invariant matrix while no mechanism existed.
- R2-1: once frozen, the FIRST write was keyed to the DESTINATION status
  (`NEW.status = 'approved'`) rather than the TRANSITION. Every row approved
  before the migration sits at `approved` with a NULL tuple, so the guard
  admitted exactly the rows it existed to protect.
- F6 / R2-3: a cross-row truth read WITHOUT the lock that makes reading it a
  decision — publication status under the option guard, parent status under the
  ChangeRequest seal. A snapshot is not a decision.

## Round 3 — the same three faces, and what that tells us

Seven more findings arrived on `2ef9d68`. Every one of them is an instance of the
same class, which is the strongest evidence the class is real — and also the
sharpest criticism of the first edition of this audit, which named the class and
then fixed only the instances the reviewer had already pointed at.

- **Face A** — R3-3: the identity freeze covered PUBLICATION and not BIRTH, so a
  draft could be re-keyed and published in one statement while `DomainEvent`
  and the command receipt kept the old name. R3-4: the reopen seal covered the
  one named pair `approved → change`, so `approved → pending` reached the same
  open state through a door nobody had enumerated. R3-6 is the inverse — an arm
  that fires on MORE doors than it governs, judging every org deletion whatever
  standing the deleted row supplied.
- **Face B** — R3-2: the route ceiling `['client','pmc']` was a second, narrower
  statement of an authority rule the service states properly, and it won, because
  `RolesGuard` runs first. The service comment *and this PR's invariant matrix*
  asserted the ceiling already admitted every role that can hold a decision. It
  did not.
- **Face C** — R3-1: round 2 keyed the tuple's first write to the right MOMENT
  and left it free to name the wrong PARTY. R3-5: the departing role was still
  read from a pre-read taken outside the transaction. R3-7: the publish
  side-effect bundle was still derived from an unlocked pre-read.

**The honest reading.** Round 2 corrected each finding at the depth the finding
was reported and no deeper. R3-1 and R3-5 are literally the round-2 fixes with
their second dimension unexamined — the timing without the party, the arithmetic
without the snapshot it reads. A convergence audit that maps findings to a class
and then patches them one at a time has described the class rather than closed
it. What this head does differently is stated below.

## Round 4 — the class narrows to its two survivors

Five more findings on `87461e6`, and the distribution is itself the finding: **three of the five
are one face**, and it is the face this review has now raised four separate times.

- **Face A** — R4-1: the conversion counted `DecisionApprovalRevision` on the way IN and nothing
  sealed it on the way OUT. F2 fixed exactly this for `DecisionEvent` in round 1. Same shape, other
  register, three rounds later. R4-2: R3-1 bound the act tuple on the UPDATE that approves, and a
  row can also be BORN approved — the door the INSERT branch returned before reaching.
- **Face B, inverted (the SPOKESMAN)** — R4-3, R4-4, R4-5. A seal is correct and the service in
  front of it never asks, so an ordinary conflict reaches the caller as a 500. F9 named it for
  `requestChange`; F12 named it for `members.remove`; R4-3/4/5 name it for `publish`, for the
  one-step issue, and for both org-membership commands.

**What that says about the previous two editions of this audit.** Face B was declared "closed by
construction" at `2ef9d68` on the grounds that both service guards call the seal's own SQL. That
was true of the guards that EXISTED and said nothing about the doors that had no guard at all — the
audit had enumerated instances again while claiming to enumerate rules. The correct statement, and
the one this edition makes, is a rule about coverage: **every path that can trip a seal owes the
caller the seal's answer in the caller's language, and the set of those paths is enumerable from
the seals themselves.**

## Round 5 — the class is exhausted; what remains is scope

Six findings on `cc00c94`, and for the first time the distribution splits in two.

**Four are the same two faces, one layer further along, and each is now the LAST instance its
rule can generate.**

- **Face B (re-statement)** — R5-3: rounds 2/3/4 bound the act tuple's KIND and its MEMBERSHIP to
  the designated holder and never asked about the third column, so a null, blank or fabricated
  LABEL could be frozen forever by the same write-once arms that protect the true ones. R5-6: the
  seal computed post-write standing as `orgs_effective_role_standing(...) - 1`, which is arithmetic
  ABOUT the primitive rather than a question put to it — and it is wrong for exactly the shape the
  primitive is subtle about, because an active membership SUPPRESSES its holder's org-derived pmc
  standing.
- **Face B, inverted (the SPOKESMAN)** — R5-5: round 1's F9 gave `requestChange` a spokesman for
  the MEMBER arm of a seal that has two arms, so the ROLE arm still 500s. R5-4: round 4's R4-4 gave
  the org commands a spokesman and left it outside any transaction, so the answer could go stale
  before the write and the §B.1 try-acquire could refuse the write outright.

The cure in all four is the same move, and it is the move this audit has been converging on since
its first edition: **do not add a fifth guard beside the rule; move the rule to the thing that
determines it, and make every asker call that.** So `decisions_t4b_holder_label` is the ONE
statement of what a holder renders as — and `DecisionsService.approve` does not keep a TypeScript
copy of it, it calls the function the seal calls, inside the transaction that writes the row. There
is no second implementation to drift. `orgs_effective_role_standing_after` is the ONE statement of
standing, hypothetical or live; the live question is the same call with nothing hypothesised, so
`orgs_effective_role_standing` is now defined in terms of it and there is one body to keep correct
rather than two that must agree.

**Two are not the class at all, and that is the more important half.** R5-1 and R5-2 both say the
same thing about the 4b-i/4b-ii split itself: a facts half that ships the `recorded` status and the
`pmc`/`member` decider kinds WITHOUT the audience that routes them does not leave the product
incomplete, it leaves it WRONG. A `recorded` issue could be linked to an activity, where
`deriveDecisionReading` parks it at `wait / Awaiting the client's approval` — for a decision nobody
can ever approve. A `pmc`- or `member`-held decision could be published, notifying the client about
a decision the client does not hold and hiding it from the person who does.

That is not a defect in a seal; it is a defect in where the unit was cut. The owner's instruction
was **gate the surface, keep the facts** — so every fact, seal and lifecycle behaviour the previous
four rounds cleared stays exactly as reviewed, and the two surfaces that would misroute are CLOSED
at the contract and the write path until 4b-ii opens them honestly. A refusal that names its reason
is a smaller lie than a push sent to the wrong party.

**The review-lifecycle limit is also reached at this head** — five finding-bearing heads, 34
findings. The limit is a signal about UNIT SIZE, and this round supplies the evidence for what the
next cut should be: the four convergence findings are all in the seal network (which is finished),
and the two scope findings are all in the surface (which is 4b-ii). The unit was cut along the
wrong seam — facts and their surface are one user-visible behaviour, and splitting them produced a
head that had to gate its own facts to stay honest. 4b-ii should carry the audience, the visibility
and the two gates' removal together, and it should be reviewed as one workflow rather than as two
halves of one.

## Round 6 — the class is closed; the seam is not

Seven findings on `ccaf2dd`, and they split the same way round 5 did — which is itself the finding.

**Four are the class, and all four are its LAST possible instances.**

- **Face C (wrong discriminator)** — R6-1: rounds 2–5 each added a clause keyed to *"if a tuple
  column is being filled"*, and the invariant does not belong to the columns. It belongs to the
  ACT. An approval that filled nothing skipped every clause, and R2-1 then forbids repairing it —
  so the decision is permanently approved by nobody. The rule is now one sentence over the
  transition, and the two clauses that survive separately (the binding applies only when the act
  WRITES the tuple; a column filled outside an approval is still refused) are stated as the
  exceptions they are, with their reasons.
- **Face B (re-statement)** — R6-3: round 5 gave the LABEL RULE one statement and then wrote its
  emptiness test inline, three times, using `btrim` — which strips spaces and not tabs. The same
  defect one level down, in the same head that fixed it one level up. `decisions_t4b_blank` is now
  the one statement.
- **Face B inverted (the SPOKESMAN)** — R6-5 and R6-7: round 4 gave the publication seal a
  spokesman for its MEMBER arm and round 5 gave `requestChange` both arms, but the publication
  ROLE arm and the membership-ACTIVATION arm still had none. The enumeration this audit wrote down
  at round 4 — *the set of paths that can trip a seal is enumerable from the seals themselves* — was
  correct and was never actually run to exhaustion. It has been now: every arm of every seal in
  this unit has a spokesman, listed in the packet.
- **Face C again** — R6-6: the org guard's departing role came from a pre-transaction read, which
  is round 3's R3-5 in a second file. The cure is the same: read it `FOR UPDATE` inside the
  transaction that acts on it.

**Three are the seam, and this is the second consecutive round to say so.** R6-4 is round 5's gate
finishing its own job: a contract gate that guards `create` and not `publish` is not a gate, and
`publish()` takes no body, so the contract could not see that door at all. R6-2 is sharper, because
it cannot be gated away: `deciderKind: 'none'` was deliberately KEPT, so records are creatable,
permanent and served to the whole team — and the register had no branch for them, rendering every
one as an approval that never happened, priced at zero, stamped APPROVED, "awaiting client". The
status filter, the group label and the rollup omitted the value entirely.

That is the seam stating its own cost. Gating a surface is a coherent answer for a designation
whose audience has not shipped. It is NOT an answer for a status the unit deliberately keeps and
serves — there, the only honest options are to render it truthfully or not to ship it, and this
head renders it. **Finishing what was kept is not scope creep; it is the other half of keeping it.**

## Round 7 — the corrections have the same failure modes as the code

Three findings on `39bfb39`, and every one is a defect **round 6 introduced while fixing four
others**. All three are a single class, and it is a class this audit had already named twice:

> **a guard STRICTER than the rule it fronts** (R2-4, R3-6).

- **R7-1** — round 6 restated the attribution rule over "the ACT" and then keyed it to *a
  transition into `approved`*, which is not the same thing. `withdrawChange` reaches that
  transition to RESTORE an approval that already happened. Every decision approved before
  `20270815000000` carries a null tuple by design, so on those rows round 6 made a change request
  impossible to withdraw — a raw PostgreSQL error on an ordinary product path, produced by the very
  correction meant to remove those.
- **R7-2** — round 6's migration says in prose that a re-approval carries the frozen tuple forward
  *because* re-binding it to a changed name would refuse a valid act. The service then re-derived
  the label every time. The claim and the code disagreed inside one head; round 6's own probe could
  not see it because it used a client-held decision, whose label is the constant `Client`.
- **R7-3** — round 6 asked whether the ADDED ROLE was non-pmc where the seal asks whether an
  ACTIVATION occurs. Investigating it found the seal has the same defect from a different cause:
  Prisma's `upsert` compiles to `INSERT … ON CONFLICT DO UPDATE`, and PostgreSQL fires the BEFORE
  **INSERT** trigger with `TG_OP = 'INSERT'` even when the conflict path is taken. **Fixing only the
  service — which is what the finding asks for — would have converted a false 409 into a raw 500.**
  Both now ask the question `TG_OP` was standing in for.

**What this round says about the previous three editions of this audit.** Each one claimed to close
a face "by construction" and then produced fresh instances of the *neighbouring* face in the same
head. The honest generalisation is not another face: it is that **a correction is a change, and
changes fail the same ways the code they fix does.** The audit's value is not that it prevents the
class — it demonstrably does not — but that it makes each instance cheap to name and hard to
mistake for something new. Three findings on a head that fixed seven is the class working as
designed, not the class being defeated.

The one structural lesson worth extracting: **R7-2 was invisible to round 6's probe because the
probe chose the holder shape whose label is constant.** A probe that exercises the stable case
proves the stable case. The round-7 probe renames the person.

## Round 8 — the cadence, named

Three findings on `90ec557`. **None is a seam finding. Two are this PR's own corrections biting
back, and the third is a latent defect three corrections built on top of.**

- **R8-1** is round 7's over-reach. Round 7 fixed round 6's over-reach by WIDENING a rule, and the
  widening was itself too wide: "arriving at `approved` without changing the evidence" admits
  `pending → approved`, so a direct writer could publish a row with the approval columns planted,
  flip the status, and reach a permanently unattributed approval **through the exemption meant to
  protect legitimate history**. Narrow → break a real path → widen → open a forged one. That is
  the whole class in two rounds.
- **R8-3** is round 5's. Deriving the label, writing it, and recomputing it in the seal are three
  statements; nothing held the identity across them, so a rename committing in the middle killed a
  valid approval with a raw database error.
- **R8-2** is older and latent. Round 3's R3-7 established the rule — *a transaction must act on
  the row it LOCKED, never on an advisory pre-read* — and applied it to `isRecord`, leaving the
  HOLDER read on the unlocked path. Rounds 4, 6 and 7 then built three authority decisions on that
  read: the departed-member refusal, the role arm, and the surface gate.

**All three are one shape: a value read outside the lock that makes reading it a decision.** That
is Face C, and R8-2 shows what the audit's earlier editions were actually doing when they declared
a face closed — they closed the INSTANCE the reviewer had pointed at and left the read that would
later carry three more decisions.

### The count, since it is the thing worth acting on

| round | findings | seam | self-inflicted | original |
| --- | --- | --- | --- | --- |
| 6 | 7 | 2 | 2 | 3 |
| 7 | 3 | 0 | 3 | 0 |
| 8 | 3 | 0 | 2 | 1 |

Rounds 7 and 8 found **no seam defects at all** — the surface gating the owner directed is holding.
What they found instead is that **the correction cadence is now the dominant source of findings.**
Five of the last six are defects introduced by, or built upon, earlier corrections in this same PR.

That is not an argument for stopping: each one was real, each has a clean fix, and the exact-head
gate is doing precisely what it exists to do. It IS an argument for how the remaining work should
be shaped — the seal network has been rewritten seven times in eight heads, and every rewrite has a
one-in-three chance of needing another. The honest recommendation, recorded here rather than acted
on unilaterally: **4b-ii should not extend this seal network.** It should carry the audience and
visibility over the network as it stands, and any further narrowing of the attribution rules should
be its own unit with its own review budget.

### A probe defect worth more than the findings

R8-3 would not reproduce at first: the interposed rename never ran, because a Prisma raw promise is
**lazy** — assigning `raceDb.$executeRawUnsafe(...)` and walking away starts nothing. The
Phase-4 T1 correction-4 packet already records this exact trap, and this round walked into it
again. It was caught only because the probe asserts that **its own interposition actually
happened** (`expect(spyFired)`, `expect(renameLanded)`) rather than trusting that setting up a race
creates one. Every future race probe in this unit does the same. A probe that cannot prove it ran
its own experiment is not evidence.

## What changed structurally, rather than per symptom

- **Face B is closed by construction.** Both service guards now call the SQL the
  seal itself calls — `holdsOpenDecisions` → `decisions_open_decision_names_holder`,
  `standingAfterDeparture` → `orgs_effective_role_standing`. There is no second
  statement left to drift, and R2-4's probe is the behavioural pin: it
  constructs the case where a re-derived count diverges from the seal and
  asserts the service agrees with the database.
- **Face A gains a structural pin.** `phase6-t4b-correction2.test.ts` asserts
  from `information_schema.triggers` that the recorded seal is registered for
  DELETE, INSERT *and* UPDATE, and the ChangeRequest seal for INSERT and UPDATE.
  A seal that forgets a verb now fails a test instead of waiting for a reviewer.
  The door-level half of Face A is pinned behaviourally by R2-2.
- **Face C is pinned per mechanism** — R2-1 by the legacy-shaped row that can no
  longer be given a holder (proven again over the migrated legacy database in
  `upgrade-proof.sh`), R2-3 by a real two-session overlap in both orderings with
  the blocked backend confirmed through `pg_stat_activity` *and* the statement
  asserted unsettled at the barrier.
- **A test-harness instance of Face A, found by round 2.** F5's probe re-runs
  `20270816000000` on purpose, which replays its `CREATE OR REPLACE` and
  silently undoes every later migration redefining the same function — on a
  database every integration suite shares. `applyMigrationThroughHead` replays
  everything sorting after N and asserts the restoration from `pg_proc`, so the
  rule is stated once and round 3 inherited it.

### What round 3 closes that round 2 did not

Each of the three faces is now closed at the level of the RULE rather than the
reported instance:

- **Every act-recording column is checked for PARTY as well as timing** (R3-1).
  The tuple must equal the decision's own `deciderKind`, and a member-held
  approval must name that decision's own `deciderMembershipId`. The label is
  deliberately left unvalidated and the reason is written into the migration: it
  is the display identity as the register rendered it, and a person's name may
  legitimately change afterwards. What must not vary is WHO.
- **Every authority derivation in `MembersService` now reads under the lock**
  (R3-5). `lockMembership` returns role, status *and* discipline from a
  `FOR UPDATE` read inside the transaction, so the guard's inputs are the same
  row the seal will see as `OLD` — and the discipline-changed event, which had
  the same unlocked-input shape and had not been reported, moved with them.
- **Every side-effect selection in the publish path is derived post-CAS**
  (R3-7), from the row the compare-and-set locked.
- **Freezes are stated over the LIFETIME the fact has** (R3-3): identity binds at
  birth alongside `authorId` and `projectId`, which is what the surrounding
  comment already claimed and the code did not do.
- **Transition guards are stated over the STATE they protect, not over one named
  pair** (R3-4): any transition INTO an open status on a published row
  revalidates the holder.
- **Arms are stated over the standing they govern** (R3-6): the org seal asks the
  question `orgs_effective_role_standing` asks — did this row supply effective
  pmc standing here, and does it stop? — so a plain member and an owner↔admin
  move are no longer its business, and it no longer contends for every project's
  readiness key to reach that conclusion.
- **The route ceiling is no longer a second authority rule** (R3-2). It admits
  every role that may be NAMED; the holder narrowing lives in the service, where
  the holder is knowable. Two web tests pinned the old ceiling and both were
  updated rather than deleted: `discipline.test.ts` keeps its assertion and moves
  it to what it actually meant — a consultant cannot approve a decision that is
  not theirs — with the reason recorded in the test.

## Carried forward, with its measurement

**The boundary analyzer still cannot see F8's shape, and the obvious fix is the
wrong one.** The ratchet that keeps foreign modules out of `Membership` guards
RAW SQL; F8 went through the Prisma client and sailed past it. The mechanical
cure would be to add `membership` to `orgsManifest.readEncapsulated`, which is
exactly what Phase 4 T1 correction 4 did for `workerSkill`.

Measured before proposing it: seven foreign reads of `Membership` exist in the
runtime program — `auth/auth.service.ts` (3), `common/project-access.service.ts`
(1), `activities/activities.query.ts`, `activities/activities.service.ts`, and
`drawings/drawings.service.ts`. Four of those are the AUTHORIZATION SPINE
itself, and routing the spine through a participant that lives inside a domain
module inverts the dependency the spine exists to provide. Read-encapsulation is
all-or-nothing per model and, unlike writes, has no waiver mechanism, so
encapsulating `membership` today would either produce four false findings or
force a bad refactor of the authorization root.

The three remaining reads ARE the class — all three ask the same question ("who
is active on this project") and all three could route through one participant
method. Doing that plus adding a read-waiver mechanism is an architectural
change to the boundary system, not to this unit, and it belongs to the Phase 6
boundary plan (§B/§C/§D), which is already a named successor unit. It is
recorded here with its measurement so the next reviewer inherits the analysis
rather than the sentence.

## Disposition

Twenty-eight findings across four rounds — every one verified real, none
disputed, none refuted. **Two** of them are claims this PR's own body and
invariant matrix asserted while nothing enforced them: F4's frozen holder tuple,
and R3-2's route ceiling that supposedly "admits every role that can hold a
decision". That is twice the exact failure the matrix exists to prevent, in one
PR, and it is recorded here rather than quietly fixed. The lesson is narrower
than "check your claims": both sentences described a DESIGN that was correct and
a MECHANISM that did not exist yet, and in both cases the mechanism was one file
away from the sentence.

The unit's scope is unchanged — the decider FACT model and its seals; the
audience and the surface remain 4b-ii, with three probe arms `it.skip`ped in
place naming what they will implement. No product behaviour outside the decision
lifecycle and the membership guards is touched; R3-2 is the one deliberate
widening, and it widens a route ceiling to match an authority rule that already
existed in the service.

Every round-3 probe was RED at `2ef9d68` with `20270818000000` AND the service
half reverted, on a scratch database migrated only to `20270817000000`. The RED
pass also caught a fragility in the round-3 suite itself — R3-6 mutated shared
fixture state and restored it only on success, so its failure made R3-7 fail for
R3-6's reason. The restoration moved to `afterEach`, where a failure cannot skip
it. That is the same lesson as round 2's migration replay, in the same file, one
round later.

### What round 4 closes

- **The evidence registers are sealed in BOTH directions and BOTH tables** (R4-1). The conversion's
  forward count and the register's reverse refusal share the parent row lock the 4a seal already
  took, so neither ordering can commit a record holding approval evidence.
- **The act tuple is bound at every door a row can enter approved through** (R4-2) — the
  transition (R3-1) and birth. Completeness is required at birth and the reason is written into the
  migration: a row born approved with no tuple names nobody, R2-1 forbids repairing it, and the
  register could then never say who approved it. Rows that ALREADY existed are reached by UPDATE,
  never INSERT, so the legacy shape is untouched.
- **Every publication path holds the key its seal try-acquires** (R4-3). The §B.1 protocol's
  service half was documented and unimplemented on both publish doors; advisory locks are
  re-entrant, so holding it is what makes the seal's try-acquire succeed rather than fire.
- **Every seal that can refuse a product path now has a spokesman** (R4-3/4/5), asking the same
  predicate the seal asks. The enumeration is the point: `publish`, the one-step issue,
  `updateOrgMemberRole` and `removeOrgMember` were the paths with no service-side question left.

Gates at this head: `pnpm check` EXIT 0; full integration on a pristine migrated database;
`upgrade-proof.sh` with round 4's two new hostile statements rejected and its precision arm
ACCEPTED; `test:e2e:api` 31 passed / 6 skipped. Every round-4 probe was RED at `87461e6` with
`20270819000000` and the service half reverted.

### What round 5 closes

- **The frozen attribution is TRUE, not merely frozen** (R5-3). Freezing a label nobody checked
  meant the register could permanently render a name belonging to nobody. The label is now
  complete, non-blank and bound at both doors — and derived by the service from the seal's own
  function, so the two cannot disagree by construction rather than by discipline.
- **Post-write standing is asked, never computed** (R5-6). `orgs_effective_role_standing_after` is
  the single body; the live question is its no-hypothesis case. The precedence rule — an active
  membership suppresses org-derived pmc standing — is stated once and is therefore correct in both.
- **Both arms of the reopen seal have a spokesman** (R5-5), and the org spokesman now holds the
  keys its seal try-acquires across the guard AND the write it guards (R5-4). The spokesman rule's
  enumeration is complete: every seal arm, not every seal.
- **The unit is honest about what it does not ship** (R5-1, R5-2). The facts are all here and all
  reviewed; the two surfaces that cannot be routed correctly without 4b-ii are refused with a
  message that names the reason and the unit that opens them.

Gates at this head: `pnpm check` EXIT 0 (web 787/787, API 793/793); the full integration suite on a
pristine migrated database; `upgrade-proof.sh` with round 5's four new hostile statements rejected
and its three precision arms ACCEPTED; `test:e2e:api` unchanged. Every round-5 probe was RED at
`cc00c94` with `20270820000000` AND the service half of its finding reverted, on a scratch database
migrated only to `20270819000000` — six of six, each for its own reason. The RED pass also caught a
fragility in the round-5 suite itself: its decision ids and fixture emails were unique per PROBE but
not per RUN, so an interrupted run poisoned the next one with primary-key collisions that looked
like product failures. Both are now run-scoped. That is round 2's replay lesson and round 3's
fixture-restoration lesson in their third spelling: **a probe's failure must be its own.**

### What round 6 closes

- **The attribution rule turns on the act** (R6-1). Every transition into `approved` carries a
  complete, non-blank attribution; the binding applies to the act that WRITES the tuple, so a
  re-approval carries frozen history forward instead of being re-bound to a name that has since
  changed. Both exceptions are stated with their reasons rather than left as emergent behaviour.
- **"Blank" has one statement** (R6-3), over the whole ASCII whitespace set, asked by both seal
  arms and the diagnostic. Round 5 fixed the rule and re-stated its test; this closes the level
  below.
- **The spokesman enumeration is actually exhausted** (R6-5, R6-7). Round 4 wrote the rule and
  checked the paths it had noticed. Every arm of every seal in this unit is now listed in the
  packet with the service question that fronts it, so the next reader can check the list rather
  than re-derive it.
- **The gate covers every door it claims to** (R6-4), and **the register tells the truth about
  what the unit ships** (R6-2).

Gates at this head: `pnpm check` EXIT 0 (web 790/790, API 793/793); the full integration suite on a
pristine migrated database; `upgrade-proof.sh` with round 6's two new hostile statements rejected
and its four precision arms ACCEPTED; `test:e2e:api` unchanged. Every round-6 probe was RED at
`ccaf2dd` with `20270821000000` AND the service half of its finding reverted — six of six on the
API side, three of three on the web side, each for its own reason. R6-6's race is interposed
deterministically (the R3-7 pattern): the guard's pre-read is made to answer `member` while the row
says `owner`, and the probe asserts it actually served the stale value before asserting the outcome.

**Two of round 5's own assertions are OVERTURNED here, in place, saying so.** Round 5's R5-3 probe
asserted that a tupleless approval transition was permitted and called that precision; R6-1 is right
that it was a hole, and the arm now asserts the refusal with the reason recorded beside it. Round
4's R4-5 precision arm asserted that publishing a member-held draft succeeds once its holder is
active; R6-4 refuses it for a different and stated reason, and the arm now proves the holder
spokesman answered rather than the seal. A probe that is overturned by a later finding is evidence
the review is working, and it is worth more in the file than out of it.

### What round 7 closes

- **A restoration is not an act** (R7-1). `withdrawChange` returns a decision to the approval it
  already had; the attribution rule now recognises that from the row itself — prior approval
  evidence present, and this statement changing none of it — rather than from the transition, so a
  legacy change request can be withdrawn again.
- **The frozen tuple is written once and preserved thereafter** (R7-2), by the service as well as
  by the seal, and the announcement reads the same value the register renders — so a re-approval
  after a rename neither fails nor contradicts itself.
- **An activation is a state change, not a `TG_OP`** (R7-3), in the service AND in the seal. The
  finding named one of the two; fixing only that one would have made the symptom worse.

Gates at this head: `pnpm check` EXIT 0 (web 790/790, API 793/793); the full integration suite on a
pristine migrated database; `upgrade-proof.sh` with round 7's restoration and re-role statements
ACCEPTED and its precision refusal rejected; `test:e2e:api` unchanged. All three probes were RED at
`39bfb39` with `20270822000000` AND the service half reverted, each for its own reason.

### What round 8 closes

- **The restoration exemption fits the thing it exempts** (R8-1): from `change`, evidence
  unchanged, and an approval that actually happened. A planted `approvedById` on a never-approved
  row has no `DecisionEvent`, so the door the exemption opened is shut without shutting the
  legitimate legacy withdrawal round 7 added it for.
- **`publish` acts on the row it locked** (R8-2). Three authority decisions that were reading an
  advisory pre-read now read the row the CAS holds.
- **The frozen identity is held while it is being frozen** (R8-3), `FOR SHARE` through its owner,
  so the service's write and the seal's recompute cannot see different names.

Gates at this head: `pnpm check` EXIT 0 (web 790/790, API 793/793); the full integration suite on a
pristine migrated database; `upgrade-proof.sh` with round 8's two forgeries rejected and the genuine
legacy restoration ACCEPTED; `test:e2e:api` unchanged. All three probes RED at `90ec557` with
`20270823000000` AND the service half reverted, each for its own reason.

---

## Ninth edition — the merge-forward head `7b4fe63`, and what it settles

**This head carries no correction.** It is round 8 (`8c3f26b`, unchanged) plus a merge of
`origin/main` and one `docs/STATUS.md` alignment. It is recorded here because the convergence
protocol asks every head past the cap to say what it is, and because what it settles is worth
more than its diff.

### `api-e2e` passed, and that is the finding

For the first time in this PR's life, **every check is green — `api-e2e` included** (10/10 at
`7b4fe63`). Round 8 had been sitting behind a red gate since it was pushed, and the red was never
its doing:

- The failure was a PostgreSQL deadlock between `phase5_t4_billed_bound_check`'s COMMIT-time
  `PurchaseOrderLine` lock and `OrgsParticipant`'s `Membership … FOR UPDATE`, raised out of
  `CommercialPaymentService.approve` — a path that touches no decision.
- It was proven pre-existing by **PR #342**, a CSS focus-ring change that hit the byte-identical
  deadlock and also failed two attempts before passing on a third.
- It is fixed in `main` by **PR #345** (`a4946b5`): `FOR NO KEY UPDATE` in place of `FOR UPDATE`,
  removing the one false conflict edge (`FOR KEY SHARE`, taken inline by an FK-referencing insert)
  while preserving every conflict the bound check actually needs.

So the eight-round finding history of this PR is now closed against a green gate, and the
attribution is settled: **none of it was CI's verdict on round 8.**

### The rule this PR and #345 jointly produced

PR #345 ran six findings across two rounds, **every one about the evidence and none about the
fix**, and its round 2 answered two of them by DELETING a probe after verifying the coverage lived
in its owning suite. That is the same shape this audit has been describing here from a different
angle:

> After repeated finding-bearing rounds, **reduce surface rather than patch again.**

On #345 the surface was a test suite growing faster than it was becoming true. On #344 it is the
seal network, rewritten seven times in eight heads with roughly a one-in-three chance each time of
needing another. The two PRs failed the same way in different materials.

### The standing recommendation, unchanged and now better evidenced

**4b-ii should carry the audience and visibility OVER this seal network as it stands, rather than
extending it.** Any further narrowing of the attribution rules belongs in its own unit with its own
review budget. Rounds 7 and 8 found **zero** seam defects — the 4b-i/4b-ii cut is holding; what has
not held is my own re-cutting inside it.

Per the owner's decision, round 8 stands and faces review as it is. **No voluntary refinement.**

### What this head does NOT claim

No finding is deferred. Round 8's three findings are answered in code at `8c3f26b`, unchanged by the
merge. This head adds no probe, no seal and no behaviour — the merge brought in only #345's
migration, its probe suite and its convergence audit, and the sole 4b-i-side edit is
`docs/STATUS.md` moving `task_state` from `in_progress` to `in_review`, which was simply untrue
before.

Gates at this head, run on the MERGED branch so the two units are proven to compose: `pnpm check`
EXIT 0 (web 790/790, API 793/793); integration **102 files / 1245 passed + 3 skipped** on a pristine
database with all 89 migrations applied in sequence; `upgrade-proof.sh` PASSED; `test:e2e:api` 31;
`:outbox` 31.

---

## Tenth edition — round 9, and the count that should decide 4b-ii

Three findings on `92868d7` (2×P1, 1×P2). **3 of 3 SELF-INFLICTED. 0 SEAM.**

| # | P | Which correction in THIS PR caused it |
| --- | --- | --- |
| R9-1 | P1 | **round 8's own fix** — it asked for an `approved` `DecisionEvent` as proof an approval happened, and nothing stopped that event being INSERTED while the parent sat in `change`. Right idea, forgeable proof. |
| R9-2 | P1 | **round 7's guard** — putting every active membership insert behind a NON-BLOCKING readiness check broke a path that never took the key. |
| R9-3 | P2 | **the round-6/8 `activates` narrowing** — correct for activation, but it left the role-CHANGE half of the same upsert with no check at all. |

### The count, which is now the actionable part

| round | findings | seam | self-inflicted |
| --- | --- | --- | --- |
| 7 | 3 | 0 | 3 |
| 8 | 3 | 0 | 2 (+1 latent) |
| 9 | 3 | 0 | 3 |

**Three consecutive rounds, nine findings, zero seam defects.** The 4b-i/4b-ii cut is not the
problem and has not been the problem since round 6. Every finding since is a defect *a correction
introduced*, which is the definition of a change set that has stopped converging on its own terms.

### R9-2 deserves separate emphasis: this PR broke production

Round 7's guard is correct in isolation and was correct for the path it was written for. Applied to
`AuthService.signInOrProvision` — two top-level calls, no readiness key — it produced this:

1. self-signup creates the `User`; it commits.
2. the membership insert meets the non-blocking guard under contention and REFUSES.
3. the retry FINDS that identity, so it skips provisioning entirely.
4. `signInAccess` rejects the account for having no active membership. **Permanently.**

A guard added to protect decision holders locked people out of the product. That is the cost of
extending a seal network across paths that were never part of its design, stated plainly because
the recommendation below is otherwise easy to read as mere tidiness.

### What round 9 does

- **R9-1** — the restoration exemption now requires an approval event that **PREDATES the open
  `ChangeRequest`**. A genuine restoration's approval happened before the change was requested;
  a planted event, written while the row sits in `change`, necessarily comes after. Ordering is the
  part of the evidence a forger cannot manufacture through the ordinary write paths.

  **The first attempt at R9-1 was itself an over-reach, and that is this round's most useful
  finding.** It forbade recording an approval event unless the parent was already `approved` —
  and the battery refuted it before it reached the gate: `phase6-t4a-withdraw` (4 tests),
  `phase3-requirements` R2-1, `phase6-t4b-correction` F2, and `upgrade-proof.sh` all failed.
  The reason is exact: **a non-approved decision carrying an approval event is the very shape 4a's
  seals exist to refuse**, so making it unrepresentable stopped 4a from constructing the scenarios
  it defends against, and broke the legacy upgrade path. Narrowing a rule until it breaks a real
  path is precisely what round 7 did and round 8 had to undo — committed again, one round later,
  inside the head that names the pattern. It is recorded rather than quietly replaced because a
  convergence audit that shows only the corrected view is the thing this audit exists to argue
  against.

  Constraining the PROOF rather than the EVENT leaves every legacy shape representable, keeps 4a's
  fixtures and defences intact, and still denies the forgery its exemption.

- **R9-2** — user and membership provision in ONE transaction holding `lockProjectReadiness`.
  Contention WAITS instead of failing, and a failure leaves nothing behind to poison the retry.
- **R9-3** — `members.add` runs the SAME departure guard `updateRole` runs when an already-active
  member's role changes, reading id and role under the same `FOR UPDATE`. Two doors onto one write
  now give one answer.

All three RED at `92868d7`: the planted event was ACCEPTED, signup FAILED instead of waiting, and
the stranding role change went through. `20270815000000` … `20270825000000` are byte-for-byte
unchanged; `20270826000000` is one `CREATE OR REPLACE`, writes no row, and makes nothing illegal
that was legal before.

### The recommendation, now stated as a decision the count has already made

**4b-ii must carry the audience and visibility OVER this seal network as it stands. It must not
extend it.** Any further narrowing of the attribution rules is its own unit with its own review
budget. Nine findings across three rounds, none of them at the seam and all of them from re-cutting
inside it, is not a case for a tenth round of the same — and R9-2 shows the blast radius is no
longer confined to this unit.

---

## Eleventh edition — round 10, where a five-round lineage ends

Two findings on `a283568` (2×P1). **2 of 2 SELF-INFLICTED. 0 SEAM.**

| # | P | Which correction in THIS PR caused it |
| --- | --- | --- |
| R10-1 | P1 | **round 9's own fix**, which was **round 8's own fix**, which was **round 7's**, which was **round 6's**. One rule, re-cut four times, forgeable every time. |
| R10-2 | P1 | **round 4's fix** — `recorded` was made unlinkable at every write path and both pickers. The rule was enforced in one direction only: link first, convert second, same dead gate. |

### R10-1: the lineage, stated in full, because the lineage IS the finding

| round | what it demanded | how it lost |
| --- | --- | --- |
| 6 | attribution on every approval TRANSITION | broke `withdrawChange` on every pre-`20270815000000` row |
| 7 | exempt "arrives at approved without changing the evidence" | admitted `pending → approved` — a forgery door |
| 8 | …and an `approved` `DecisionEvent` must exist | the event is plantable |
| 9 | …and it must predate the open `ChangeRequest` | close the request (bound reads `infinity`), or backdate the caller-supplied `at` |

Four attempts, four losses, and the losses are not four separate oversights. **Every one of them
asked a question about rows a caller can write, and a caller wins that argument every time.** A
fifth predicate would have lost for the fifth version of the same reason.

So round 10 does not write a fifth predicate. It removes the thing four predicates were trying to
approximate. `20270827000000` stamps `DecisionLegacyApproval` for every approval standing when it
runs, then makes the table refuse every INSERT and UPDATE. The exemption is no longer a claim to be
proven per row; it is **membership of a set that was fixed before any caller could act on it and
cannot be added to since**. A one-time migration write is the one piece of evidence a later caller
cannot manufacture, which is precisely what was missing.

**Two things were deliberately NOT changed, and both matter.**

*Round 7's other two conditions are kept.* Only the "an approval actually happened" clause was ever
the problem. That a restoration comes FROM `change`, and that it alters no approval evidence, are
facts about the statement in front of the trigger — not questions about rows someone else wrote — so
no caller can lie to them. **The first draft of this round dropped them along with the forgeable
clause, and the upgrade proof caught it**: round 7's precision arm (arriving at `approved` while
changing the approved option is a new ACT and must name its actor) went from rejected to accepted.
Removing a rule's forgeable half is correct; removing its sound half in the same motion is the
over-reach this audit has now recorded in rounds 7, 9 and 10. It is written down rather than quietly
fixed, for the same reason as the others.

*No attribution was invented.* The first draft also BACKFILLED the holder tuple wherever it looked
derivable, stamping only the remainder. That was wrong twice. Mechanically it wrote a person's name
into `approvedDeciderLabel` for `client`-held rows, where `decisions_t4b_holder_label` renders the
constant `'Client'` — so the "recovered" attribution would not have matched what a real approval
writes. Substantively it was rounds 6-9 in a new costume: `deciderKind` on a pre-Phase-6 row was
itself DEFAULTED by `20270815000000`, so materialising it as "who held this approval" asserts a fact
the historical record never captured. **A pre-Phase-6 approval has no attribution. Saying so is the
truth; deriving one is fabrication, however plausible the derivation looks.** The register therefore
still shows no holder tuple for a legacy row — and the safety property is not that those rows are
attributed, but that the set of unattributed ones is finite, frozen and enumerable.

One consequence worth naming because it runs the right way: R4-2's documented narrowing still lets a
decision be BORN `approved` with no tuple at the INSERT door. Round 10 does not widen that — it
**tightens** it. Such a row is not in the stamp set, so unlike before it can never afterwards be
restored through the exemption. `upgrade-proof.sh` pins exactly this with `UP4B4-BARE`.

### R10-2: a rule enforced in one direction

`decisions.linkableInProject` refuses to LINK a `recorded` decision, because a record is approvable
by nobody and the dependent's gate would wait forever. Both consumers — `activities.service` and
`daily-log.service` — call it, at a pre-check and again in-transaction under `FOR SHARE`.

Nothing asked the reverse. Link an ordinary draft (legal), then convert that draft to a record
(legal), and the identical dead gate exists — reached by walking the two legal steps in the other
order. The conversion now asks the OWNING modules, through `activities_decision_has_dependents` and
`daily_log_decision_has_dependents`, and reads no peer table itself — the channel
`orgs_user_decision_authority` already uses.

The two directions serialize on a lock that already existed: the link path's in-tx authority takes
`FOR SHARE` on the decision row and the conversion UPDATEs that same row. Both orderings are proven
under a `pg_stat_activity` barrier, and each loses **for the right reason** — the late conversion is
refused by the new guard; the late link reads the committed `recorded` and is refused by the rule
that was already there. No new machinery, and no new lock order to reason about.

### Where the precision half of R10-1 is proven, and why not in the probe suite

A genuine legacy row is one that was already approved BEFORE the migration ran. That state is
**unreachable from an integration suite** whose database is migrated from empty — the stamp set is
empty there — and unfakeable afterwards, because minting a member of it is the one thing the seal
exists to prevent. Faking it would mean disabling the seal: proving the exemption works by removing
the property that makes it safe.

So the split is deliberate and stated in both files. `phase6-t4b-correction10.test.ts` proves what is
provable there — both round-9 forgeries refused, the evidence unmintable, the verb enumeration
pinned, and all of R10-2. `scripts/upgrade-proof.sh` owns the rest, because it plants legacy shapes
and THEN migrates: `UP4B2-D1` moved from a post-ledger fixture to a **pre-`20270827000000`** plant
(round 10 made *when* a row was approved the substance of the rule, so a fixture planted after the
ledger can no longer stand in for a legacy one), and the new assertions pin the stamp set by name,
prove the genuine legacy withdrawal still commits, refuse a direct DELETE of the evidence, and show
the FK cascade still carries it away with its subject.

### The count

| round | findings | seam | self-inflicted |
| --- | --- | --- | --- |
| 7 | 3 | 0 | 3 |
| 8 | 3 | 0 | 2 (+1 latent) |
| 9 | 3 | 0 | 3 |
| 10 | 2 | 0 | 2 |

**Four consecutive rounds, eleven findings, zero seam defects.** The 4b-i/4b-ii cut has not been the
problem since round 6. The tenth edition's recommendation therefore stands unchanged and is now
overdue: **4b-ii carries the audience and visibility OVER this seal network as it stands, and does
not extend it.** Any further narrowing of the attribution rules is its own unit with its own budget.

### The rule this round contributes

> When the same rule has been re-cut and lost more than twice, the next move is not a better
> predicate. **Find the clause that keeps losing, and ask what would make the question unnecessary.**

Rounds 6-9 kept improving the *answer* to "did an approval really happen?". Round 10 noticed that
the question only exists because pre-migration rows are indistinguishable from forged ones at read
time — and that a migration, which runs exactly once and before any caller, is the one writer whose
output settles it. Sibling formulation of PR #345's rule (*reduce surface rather than patch again*),
arrived at from the opposite direction: there the answer was to delete a probe, here to delete a
predicate and enumerate its subject instead.

### Nothing is deferred

Both findings are answered in code on this head. `20270815000000` … `20270826000000` are
byte-for-byte unchanged. `20270827000000` writes rows only where a legacy approval already stood, and
makes nothing illegal that was legal before except the two states the findings name.

---

## Twelfth edition — round 11, and the finding that came from round 10 being right

Five findings on `f113f94` (2×P1, 3×P2). **5 of 5 SELF-INFLICTED. 0 SEAM.**

Round 10 replaced a forgeable predicate with an enumerated set. Four of these five are about that
set's EDGES — who is in it, how it survives, and what its existence now implies about a door that
only ever made sense while "legacy" was a shape rather than a list.

| # | P | Which correction in THIS PR caused it |
| --- | --- | --- |
| R11-1 | P1 | **round 10's own stamp predicate** — it read `approved` only, and a legacy approval can be sitting in `change` on the day of the deploy |
| R11-2 | P2 | **round 10's new table** — declared in hand-written SQL only, so schema drift could DROP the register |
| R11-3 | P1 | **round 4's R4-2 narrowing**, invalidated by round 10 — the born-approved-tupleless door outlived its own justification |
| R11-4 | P2 | **round 10's stamp INSERT** — a BEFORE INSERT seal fires before `ON CONFLICT` resolves, so the required retry aborted |
| R11-5 | P2 | **round 10's seal** — a row-level trigger never fires for `TRUNCATE` |

### R11-1 is the one that would have hurt a real customer

Not a forgery, not a hypothetical: someone raises an ordinary change request on Tuesday, the upgrade
runs on Wednesday, and on Thursday that change request **cannot be withdrawn — ever.** The stamp
predicate read `approved`, the row was in `change`, so it fell outside the exemption set, and
`withdrawChange`'s evidence-preserving `change → approved` hit the unconditional demand.

`requestChange` is the only way the product reaches `change`, so such a row is exactly as much a
legacy approval as an `approved` one. Both statuses are now stamped, and they are the only two that
can matter — `v_restores` requires `OLD.status = 'change'`, so a tupleless `pending` row could never
use the exemption and is deliberately left out.

This is also the second time this PR has shipped a rule that was right about the case in front of it
and silent about the case beside it. R9-2 locked real users out of the product; R11-1 would have
frozen a real change request. Both were found by a reviewer rather than by the change's own author,
and both came from a correction written for the state it was staring at.

### R11-3: round 10 made an accepted narrowing indefensible, and did not notice

R4-2 permitted a decision to be BORN `approved` with no tuple, and the round-4 argument was sound at
the time: an absent tuple was the shape every pre-`20270815000000` approval is in; those rows persist
in production; and the UPDATE door admitted the same transition — so requiring the tuple at birth
would have made being BORN approved **stricter than BECOMING approved**. Measured rather than
assumed, closing it then failed 18 tests across 10 suites.

Round 10 removed both halves of that argument and left the door open anyway. "Legacy" stopped being
a shape any row can wear and became the finite set the migration stamped — every member of which
already exists — and `change → approved` without a tuple started requiring membership of that set.
The doors were no longer symmetric; the lax one was simply lax. **The eleventh edition recorded R4-2
as a "documented narrowing, out of scope". That was wrong, and Codex was right to reopen it: a
narrowing survives only as long as its justification does, and this PR had just dissolved it.**

Closing it cost the sweep round 4 measured: 20 tests across 13 suites, every one a fixture minting an
approved decision the product itself cannot produce (`decisions.create` only ever inserts `pending`
or `recorded`; every real approval is the UPDATE `approve()` performs). No production path changed.

### R11-4 is where a "small" fix turned out to be the wrong shape twice

The first attempt was `NOT EXISTS (… WHERE l."decisionId" = d."id")` — skip rows already stamped.
It makes the migration re-runnable and it is **wrong**, because `change` is now in the predicate: a
second run days later would stamp every row that entered `change` SINCE the upgrade, handing the
exemption to precisely the rows the seals exist to refuse.

That is not a worry, it is an observation — with the per-row guard, `upgrade-proof.sh`'s re-run tried
to stamp the round-10 forgery target, which a probe had put into `change` after the upgrade, and the
seal refused the insert. **The gate that caught it was the one built to prove a different property.**

So the question the guard asks changed from *"is this row already stamped?"* to *"has this migration
already run?"*, and the answer is the seal's own existence: absent on the first run, present ever
after. The set is fixed at upgrade time — which is what round 10 claimed all along, and what the
per-row guard would have quietly made false.

### Where the evidence lives

| finding | proven in | why there |
| --- | --- | --- |
| R11-1 | `upgrade-proof.sh` | needs a legacy approval ALREADY in `change` before the migration — `UP4BR11-CHANGE` is planted, published, approved and reopened at the `20270827000000` stop |
| R11-2 | `schema-migration-drift.test.ts` | the drift check IS the finding's subject |
| R11-3 | `phase6-t4b-correction11.test.ts` + `upgrade-proof.sh` | a post-migration door, so it is testable anywhere; asserted at both, with R4-2's own probe inverted in place rather than deleted |
| R11-4 | `upgrade-proof.sh` | re-runs the real migration file over an already-upgraded database |
| R11-5 | `phase6-t4b-correction11.test.ts` | `TRUNCATE` needs no legacy state |

`information_schema.triggers` is SQL-standard and reports INSERT/UPDATE/DELETE only, so the verb pin
reads `pg_trigger.tgtype` instead — a neat echo of R11-5 itself: the catalogue that omits the verb is
the one that would have let the omission pass unnoticed.

### The count

| round | findings | seam | self-inflicted |
| --- | --- | --- | --- |
| 7 | 3 | 0 | 3 |
| 8 | 3 | 0 | 2 (+1 latent) |
| 9 | 3 | 0 | 3 |
| 10 | 2 | 0 | 2 |
| 11 | 5 | 0 | 5 |

**Five consecutive rounds, sixteen findings, zero seam defects.** The recommendation is unchanged
and now overdue twice over: **4b-ii carries the audience and visibility OVER this seal network as it
stands, and does not extend it.**

### The rule this round contributes

> A narrowing survives only as long as its justification does. **When a correction dissolves the
> argument for an accepted exception, that exception is part of the correction — not out of scope.**

Round 10 was right, and being right is what created R11-3: the moment "legacy" became a list, every
rule that had been reasoning about "legacy" as a *shape* was owed a re-read. This audit had the
material to find that itself — the eleventh edition names R4-2's door in as many words and argues
that round 10 "tightens rather than widens" it — and stopped one step short, at *this does not make
things worse*, instead of asking *does this still make sense at all*.

### Nothing is deferred

All five findings are answered in code on this head. `20270815000000` … `20270826000000` remain
byte-for-byte unchanged; every round-11 change is inside the unmerged `20270827000000`, its Prisma
declaration, the probes, and the fixtures the closed door touched.

---

## Thirteenth edition — round 12, and a claim this audit made too confidently

Three findings on `7988f26` (3×P2). **3 of 3 SELF-INFLICTED. 0 SEAM.**

| # | P | Which correction in THIS PR caused it |
| --- | --- | --- |
| R12-1 | P2 | **round 11's own R11-2 fix** — declaring the register in `schema.prisma` fixed the drift it named and introduced a quieter one, because a Prisma relation defaults to `onUpdate: Cascade` and the migration installs `NO ACTION` |
| R12-2 | P2 | **round 4's org holder guard** — written for `updateOrgMemberRole`, never applied to the other door onto the same write |
| R12-3 | P2 | **`20270815000000`'s own publish-time revalidation claim** — the header states it, and two of the three doors did it |

### R12-1 is the correction of a correction, and of a sentence in this audit

Round 11's R11-2 was right: a table living only in hand-written SQL is drift a generated migration
can DROP. The fix — declare it — closed that and opened a narrower one. The migration writes
`REFERENCES "Decision"("id") ON DELETE CASCADE`, whose unstated update action is `NO ACTION`;
a Prisma relation that says nothing means `onUpdate: Cascade`. So the model described a database the
migration does not install, and `prisma migrate diff` emitted
`ON DELETE CASCADE ON UPDATE CASCADE` for exactly this constraint — a later generated migration
would have made a `Decision.id` re-key cascade into the one-time evidence.

**And the twelfth edition claimed `schema-migration-drift.test.ts` proved R11-2. It does not.** That
suite is deliberately scoped to the party models and says so in its own header — a blanket
`migrate diff` assertion was tried there and abandoned. The claim was made because the suite is
*named* for drift, not because its scope was read. Corrected here rather than quietly restated: the
evidence for R12-1 is the `migrate diff` comparison (the constraint appears without the fix, and is
absent with it), plus a new probe that pins the database's ACTUAL referential actions so the two
sides cannot diverge silently again.

That probe passes at `7988f26` as well, and is labelled as such in the file. The database was always
`NO ACTION`; the disagreement was schema-side, so no runtime behaviour differed and no behavioural
probe could have caught it. Calling it a reproduction would be the same overstatement one paragraph
later.

### R12-2 is the same shape for the third time in this PR

| round | the rule | the door that asked | the door that did not |
| --- | --- | --- | --- |
| 9 | the departure guard | `updateRole` | `members.add` |
| 11 | the attribution demand | `change → approved` | INSERT-of-`approved` |
| 12 | the holder guard | `updateOrgMemberRole` | `addOrgMember`'s upsert |

Each time: one write, two ways in, the rule stated at one of them. This is Face A of the root
analysis at the top of this audit, and it has now generated a finding in three of the last four
rounds. The mechanism is not carelessness about any single rule — it is that a rule gets written
where the change happened to be, and the OTHER door is discovered by a reviewer.

The last-owner rule is fixed at the same door in the same head, though the finding does not name it.
`updateOrgMemberRole` refuses to strip the org's last owner and `addOrgMember` could do it silently:
the identical sentence at the identical write. Splitting them would leave the pair disagreeing again
by the next round, which is precisely the failure this table describes.

### R12-3: the third of three doors

`20270815000000`'s header says a record's author is revalidated when the record becomes visible.
The INSERT-of-`recorded` door asked; the draft → record CONVERSION door asked (that was R2-2, round
2); PUBLICATION never did — for a record it checked only that the option count was zero.

The gap needs no forgery. A user with decision authority saves a record DRAFT, then loses that
authority; the draft stays legal, and anyone can publish it into a permanent, team-visible,
undeletable register entry attributed to someone with no standing on the project. A record is the
one status with no transition out, so there is nothing to do about it afterwards.

**Composing that arm broke the branch it joined, and the precision probe caught it before the
battery did.** Carrying `20270818000000`'s body forward, the extracted range stopped one line short
and dropped the option floor — so a record could have published *with* options. The probe that
asserts "the floor is unchanged" failed on the first run. It exists because every arm added to a
shared branch owes proof that it did not displace its neighbours; this round is the case that
justifies the habit.

### The count

| round | findings | seam | self-inflicted |
| --- | --- | --- | --- |
| 7 | 3 | 0 | 3 |
| 8 | 3 | 0 | 2 (+1 latent) |
| 9 | 3 | 0 | 3 |
| 10 | 2 | 0 | 2 |
| 11 | 5 | 0 | 5 |
| 12 | 3 | 0 | 3 |

**Six consecutive rounds, nineteen findings, zero seam defects.**

### The rule this round contributes

> A test suite's NAME is not its SCOPE. Before citing one as evidence, read what it actually covers.

R11-2 was answered correctly and then credited to a suite that never looked at the model in
question. The citation was plausible, the suite was green, and the claim was still false. This audit
exists to make the reasoning inspectable; a wrong citation inside it is worse than no citation,
because it invites the next reader to stop checking.

### Nothing is deferred

All three findings are answered in code on this head. `20270815000000` … `20270827000000` are
byte-for-byte unchanged; the publication seal is replaced by a new `20270828000000` carrying
`20270818000000`'s body forward with one arm added.

---

## Fourteenth edition — round 13, where two corrections each grew their own tail

Two findings on `99cbada` (2×P2). **2 of 2 SELF-INFLICTED. 0 SEAM.**

| # | P | Which correction in THIS PR caused it |
| --- | --- | --- |
| R13-1 | P2 | **round 12's own R12-3 fix** — it added the seal arm and left the service without the matching spokesman |
| R13-2 | P2 | **round 11's own R11-4 fix** — it made the stamp one-shot with a guard, and a guard is not atomicity |

Both are the same story one level down: a correction that answered its finding correctly, and stopped
at the edge of what the finding named.

### R13-1: the spokesman rule, at the fifth door

This PR has a standing rule, established in round 3 and applied repeatedly since: **the database is
the authority, and the service says the same thing first, in words a caller can act on.** Round 12
added the publish-time author check to the seal and did not add its spokesman, so the ordinary case
the arm exists to catch — a record draft saved while its author held authority, published after they
lost it — arrived as a raw `PrismaClientKnownRequestError` and a 500.

The answer is the shape every other spokesman in this PR has: the question is asked of the module
that owns the tables it depends on (`orgs`), through a participant method that calls the SAME SQL
primitive the trigger calls, so the two cannot drift into different answers. `assertPublishableHolder`
gains a `none` arm and returns early; the member/client/pmc arms are untouched and a probe asserts
their specific refusals survive, because a spokesman that is *stricter* than its seal is the failure
round 5 already recorded here.

### R13-2: a guard is not atomicity

Round 11 made the stamp one-shot by asking "has this migration already run?", answered by the seal
trigger's existence. That is the right question and it does not survive an interrupted apply: the
INSERT and the `CREATE TRIGGER` were separate statements, so a non-transactional application that
dies between them commits the rows with no seal. The retry then re-selects the same legacy rows and
dies on the primary key — **a state that can be neither resumed nor re-run.**

And "non-transactional application" is not hypothetical here: `upgrade-proof.sh` applies migration
files with `psql -f`, which autocommits every statement. The repository's own proof harness is the
case Codex described.

The fix removes the window instead of making it recoverable. A per-row "skip what is already
stamped" guard would make the retry succeed and would reintroduce exactly the widening round 11
removed — with no seal present it cannot tell a resumed apply from a dropped seal. Putting the
INSERT and both `CREATE TRIGGER`s inside one `DO` block makes them a single statement, so the
partial state cannot exist at all.

**Two mistakes on the way there, both mine, both caught by running it.** The `DO` block first landed
*before* the functions it references, so the migration failed outright on a fresh database. Then the
forced-interruption proof used "rename the function away" — which the migration file repairs itself,
because it defines that function. The working proof installs a decoy `AFTER INSERT` statement trigger
the file does not know about: the stamp runs, the decoy raises, and the assertion is that the rows
went back with the seals they never reached.

### The count

| round | findings | seam | self-inflicted |
| --- | --- | --- | --- |
| 7 | 3 | 0 | 3 |
| 8 | 3 | 0 | 2 (+1 latent) |
| 9 | 3 | 0 | 3 |
| 10 | 2 | 0 | 2 |
| 11 | 5 | 0 | 5 |
| 12 | 3 | 0 | 3 |
| 13 | 2 | 0 | 2 |

**Seven consecutive rounds, twenty-one findings, zero seam defects.**

### The rule this round contributes

> A correction is not finished at the boundary of the finding. **Ask what the fix now implies —
> which spokesman it owes, which window it opens, which neighbouring rule it just invalidated.**

Rounds 11, 12 and 13 are one chain: R11-4 fixed re-runnability and left an atomicity window; R12-3
fixed the seal and left the spokesman; R11-2 fixed the drift and left the referential action. Each
was a correct answer to the question asked. The findings that followed were the questions the answer
raised, and every one of them was visible from inside the change.

### Nothing is deferred

Both findings are answered in code on this head. `20270827000000` changes this round (the stamp and
its seals become one `DO` block); `20270815000000` … `20270826000000` and `20270828000000` are
byte-for-byte unchanged.
