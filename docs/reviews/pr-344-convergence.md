# PR #344 — convergence audit (Phase 6 unit 4b-i, the per-decision decider and its seals)

Owed at the second finding-bearing head per the review-efficiency protocol.

| head | role | findings | outcome |
|---|---|---|---|
| `ed72636` | the 4b-i unit (staged RED shape → GREEN), split at the review budget into facts+seals with the surface deferred to 4b-ii | 12 (8 P1, 4 P2) | corrected on `067209bc` via `20270816000000`: the recorded seal's DELETE arm; approval EVENTS counted at conversion and sealed after it; a `decision.recorded` effect key so a record pushes nothing on either publish path; the act tuple actually frozen; a diagnostic-first audit in front of the option freeze; `FOR SHARE` on the head row under the option guard; the DB author predicate narrowed to `ROLE_POLICY['decision.create']`; `OrgsParticipant.describeMembership`; `requestChange` returning an actionable 409; the announcement naming the real holder; the membership id passed only when active standing ends; `DecisionsParticipant.holdsOpenDecisions` |
| `067209bc` | round-1 fold | 4 (3 P1, 1 P2) | corrected on this head via `20270817000000`: the act tuple's first write keyed to the TRANSITION rather than the destination status; the conversion door asking the author question the insert door asks; the ChangeRequest seal reading its parent `FOR UPDATE`; and the member guards computing surviving standing from `orgs_effective_role_standing` instead of asserting it, with `updateRole` taking the readiness lock so guard and seal read one snapshot |

## Root analysis — one generative class, three faces

All sixteen findings are instances of ONE rule: **an invariant has exactly one
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
- **A test-harness instance of Face A, found by this round.** F5's probe re-runs
  `20270816000000` on purpose, which replays its `CREATE OR REPLACE` and
  silently undoes every later migration redefining the same function — on a
  database every integration suite shares. `applyMigrationThroughHead` replays
  everything sorting after N and asserts the restoration from `pg_proc`, so the
  rule is stated once and round 3 inherits it.

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

Sixteen findings across two rounds — every one verified real, none disputed,
none refuted, and one of them (F4) a claim this PR's own body and invariant
matrix had asserted while nothing enforced it. That is the failure the matrix
exists to prevent and it is recorded rather than quietly fixed.

No finding is answered by an isolated patch in this head: Face B is removed as a
category, Face A gains a structural pin plus a harness rule that generalizes to
future rounds, and Face C's two mechanisms are each pinned by a probe that was
RED at `067209bc` with both the migration and the service half reverted. The
unit's scope is unchanged — the decider FACT model and its seals; the audience
and the surface remain 4b-ii, with three probe arms `it.skip`ped in place naming
what they will implement.

Gates at this head: `pnpm check` EXIT 0 (web 786/786, API 793/793); full
integration 95 files / 1208 passed / 3 skipped / 0 failed / 0 deadlocks on a
pristine migrated database; `upgrade-proof.sh` 599 assertions EXIT 0;
`test:e2e:api` 31 passed / 6 skipped; demo seed re-runnable.
