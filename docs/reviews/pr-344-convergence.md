# PR #344 — convergence audit (Phase 6 unit 4b-i, the per-decision decider and its seals)

Owed at the second finding-bearing head per the review-efficiency protocol.

| head | role | findings | outcome |
|---|---|---|---|
| `ed72636` | the 4b-i unit (staged RED shape → GREEN), split at the review budget into facts+seals with the surface deferred to 4b-ii | 12 (8 P1, 4 P2) | corrected on `067209bc` via `20270816000000`: the recorded seal's DELETE arm; approval EVENTS counted at conversion and sealed after it; a `decision.recorded` effect key so a record pushes nothing on either publish path; the act tuple actually frozen; a diagnostic-first audit in front of the option freeze; `FOR SHARE` on the head row under the option guard; the DB author predicate narrowed to `ROLE_POLICY['decision.create']`; `OrgsParticipant.describeMembership`; `requestChange` returning an actionable 409; the announcement naming the real holder; the membership id passed only when active standing ends; `DecisionsParticipant.holdsOpenDecisions` |
| `067209bc` | round-1 fold | 4 (3 P1, 1 P2) | corrected on `2ef9d68` via `20270817000000`: the act tuple's first write keyed to the TRANSITION rather than the destination status; the conversion door asking the author question the insert door asks; the ChangeRequest seal reading its parent `FOR UPDATE`; and the member guards computing surviving standing from `orgs_effective_role_standing` instead of asserting it, with `updateRole` taking the readiness lock so guard and seal read one snapshot |
| `2ef9d68` | round-2 fold + this audit's first edition | 7 (4 P1, 3 P2) | corrected on this head via `20270818000000`: the act tuple validated against the decision's own `deciderKind`/`deciderMembershipId`; the approve route ceiling widened to every role that may be NAMED, with the holder narrowing left in the service; the decision id frozen FROM BIRTH; the reopen seal restated over every transition INTO an open status; the departing role read from the LOCKED membership row; the org arm narrowed to the standing the written row actually supplies; and the publish side-effect bundle derived from the row the CAS locked |
| `87461e6` | round-3 fold + this audit's second edition | 5 (2 P1, 3 P2) | corrected on this head via `20270819000000` plus its service half: the approval REGISTER sealed against a record (the reverse of a count the conversion already made); the holder binding applied at BIRTH as well as at the transition; and the three remaining SPOKESMAN doors given their service-side question — publish holds the readiness key the seal try-acquires, publish and one-step issue refuse a departed holder with an actionable conflict, and the two org-membership commands ask the decisions participant before the write |

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
