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
