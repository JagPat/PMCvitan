# Phase 6 unit 4b-i — the per-decision decider and its database seals (implementation packet)

- **Plan:** `docs/superpowers/plans/2026-08-14-decision-workflow-4b.md` (merged PR #340 at `main`
  `caff53f`, after nineteen finding-bearing heads and 101 findings)
- **Base:** `8175c3e` · **Branch:** `claude/phase6-task4b-impl` · **PR:** #344
- **Staged-red commit (the probes' honest baseline):** the SHAPE — the `recorded` enum value, the
  `DeciderKind` enum, the decider columns, the widened contracts and the probe skeletons — with
  every behaviour deliberately absent, per the `2026-08-12-nested-locations.md` §D discipline. Every
  probe that went green below was RED against a schema that already carried its symbols, so each
  failure was a BEHAVIOUR failure and never a missing-symbol failure.

## Vision alignment

One user workflow: **a decision that is not the client's to make**. The owner's second Decision Log
gap (task #62) is that a decision could only ever await the CLIENT — a contractor's own choice, or a
consultant's, had nowhere to live, so teams either mislabelled it as a client demand or kept it out
of the register entirely. Every decision now carries a per-decision DECIDER: the client (the default,
byte-for-byte unchanged), the PMC, or a NAMED ACTIVE member. One fact, one owner: the decision row
carries its holder, the `Membership` row carries the identity that holder resolves to, and the
approval act freezes the holder tuple it was made under — because a designation stops being
attributable the moment the holder later changes. (Round 1, Codex P1: that sentence was true of
the DESIGN and false of the code — nothing froze those three columns until `20270816000000`. It is
recorded here as a claim that ran ahead of its evidence, which is the failure mode the invariant
matrix exists to prevent.)

This unit ships the FACT model and its seals. The audience and the surface are 4b-ii.

## Review unit

<!-- review-size: justified-large -->

**I split before claiming this.** The `review-scope` gate fired at 1,516 changed lines against the
1,500 budget, and the unit narrowed the same way the 4b *plan* narrowed from 4b–4d when it hit the
review-lifecycle limit — at the 7B-iii-h/g seam, **server facts first, surface after**:

- **4b-i — this PR:** the decider FACT model and its DATABASE SEALS.
- **4b-ii — next PR:** the AUDIENCE and the SURFACE (`decisions.updateDraft`, the gate reader's
  `recorded` arm, viewer-scoped counts + projection slice + approval route, the targeted push, the
  create-modal decider picker). Three probe arms are `it.skip`ped in place, each naming 4b-ii and the
  behaviour it will implement — nothing deleted, nothing left red for behaviour this unit does not
  ship.

**Why the residual cannot be split again.** The migration is ONE artifact of 745 lines and its probe
suite is 464 — the majority of the diff is one sealed change and the evidence that proves it.
Splitting the seal network itself would merge a state where the decider FACTS exist without the seals
that make them true, which is the exact condition the plan refuses. The remainder is the schema,
contract and service edits those seals require, plus the fixture sweep accounted for honestly in
"The fixture sweep" below.

## Invariant matrix

| Invariant | Risk in this change | Verification |
| --- | --- | --- |
| authorization-tenancy | a decider designation that widens who may approve, or names a holder from another tenant | the approve ceiling admits every role that CAN hold a decision while the SERVICE narrows to the actual holder (P16 green); the composite FK to the new `Membership(projectId, id)` candidate key makes a cross-project holder unrepresentable (P17 green — hostile insert refused at PG); the named membership must be ACTIVE at publication, read through the orgs-owned primitive `orgs_membership_is_active` |
| civil-time-lifecycle | none — no scheduling or civil-date semantics change in this unit | n/a: the diff touches no date derivation, no project timezone and no gate window; `ddMmmYyyy` display formatting is unchanged |
| concurrency-idempotency | a holder edit racing a publish; a reused key silently replaying a changed holder; a seal deadlocking against the service lock order | the §B.1 try-acquire-or-refuse protocol takes the SAME key `readiness-lock.ts` derives — reentrant on the service path, refusing outright when contended, so no seal ever WAITS inside a trigger; the migration takes NO advisory key (the AB-BA inversion round 18 named), only a four-table `SHARE ROW EXCLUSIVE` lock; the create idempotency preimage now covers `deciderKind` + `deciderMembershipId`, so a reused key with a changed holder conflicts instead of replaying the wrong authority |
| data-integrity-conservation | a published decision left holderless, an unapprovable published decision, or a record carrying approval evidence | holder columns are write-once FROM publication (P17 green — hostile post-publish UPDATE refused at PG); the option floor is re-counted at BOTH publication doors AND survives publication on every published parent; kind ⟺ status is sealed both directions (P18 green); the orphan guard refuses removing the holder of a published OPEN decision (P39 green end-to-end) while a private draft does not block (P39 green) |
| offline-reconciliation | a queued targeted push delivering a displaced demand after the holder changed | not exercised in this unit: 4b-i ships no push-targeting change, so the 4a cancellation spine is untouched and byte-identical. The decider-family pre-send/claim predicate is 4b-ii's (P21), and its removal-between-enqueue-and-claim arm ships with it |
| ui-server-parity | a reader silently missing the new status, or a fact no surface can express | every `DecisionStatus` reader map answers for `recorded` by COMPILE FORCE (chip, label, rail, location counts, snapshot and transitions unions — `tsc` clean on both sides); the record serializes through the real query path (P19 green). The create-modal decider picker is 4b-ii's, so this unit deliberately ships no new UI |

## The seals, and what they caught

The migration installs 5 owned primitives, 8 triggers and 4 CHECKs, all verified present live in
`pg_proc` / `pg_trigger` / `pg_constraint`, and it re-applies cleanly over an already-migrated
database — so its retry-safety is demonstrated rather than asserted.

The seals caught real defects during the build, most of them mine:

1. **The create ordering the plan predicted at round 18.** `create(publish: true)` inserted the
   published head BEFORE its options, so the INSERT-door option floor counted zero. The head is now
   born unpublished, gets its options, and only then publishes through the guarded UPDATE.
2. **A primitive declared `STABLE` while taking a row lock.** `orgs_user_decision_authority` takes
   `SELECT ... FOR SHARE`, which PostgreSQL permits only in a VOLATILE function. The lock is the
   point — an operability check must not race an archive — so the function is VOLATILE.
3. **The stricter child seal needing a named bypass in destructive resets.** See the sweep below.
4. **A probe calling a positional query with an object** (`snapshotSlice`).

## The fixture sweep — the 4b seals against the existing suites

Two of 4b's seals are strictly stronger than what the suites were written against, and the sweep is
where that shows. Neither seal was relaxed to make a fixture pass.

Three fixture families, across ~20 suites, each modelling a state the product now forbids:

1. **A project with no client.** `createTwoProjectFixture` built two projects with a pmc and nobody
   to decide anything, and 18 files published decisions into it. That is not a smaller world, it is
   an impossible one — which is exactly why the default decider is the client and why the removal
   guard exists. The client moved into the shared fixture; ad-hoc projects use `seedProjectClient`,
   which adds a MEMBERSHIP only (standing is what the seal reads, and a new `User` would carry a
   project FK every caller's teardown would have to order around).
2. **A published decision with fewer than two options** — approvable by nobody. Present in test
   seeds, inline seeds, `upgrade-proof.sh`, `prisma/seed.ts`, and the demo data itself (`DL-003`
   shipped REOPENED with zero options, waiting on a re-approval nobody could give). The subtlest
   form was a nested `options: { create: [...] }` behind a published parent: Prisma writes the
   parent first, so the INSERT-door floor counts zero children however many the block declares.
3. **Destructive resets predating the seals.** Consolidated into `wipeDecisions`, which disables
   exactly the four named triggers for exactly the wipe.

**Teardown ORDER is load-bearing, and 4b tightened it twice.** Decisions must go BEFORE memberships
(a membership holding a published open decision cannot be removed) and AFTER the activities that
reference them. The shared fixture's wipe is also CONDITIONAL: `ALTER TABLE` takes an ACCESS
EXCLUSIVE lock on all three decision tables, and an unconditional one in every teardown deadlocks
against suites that keep concurrent clients open for race probes. That was found the hard way — an
unconditional version produced 102 deadlocks and 28 cascading FK failures across a full run.

## Verification

| Gate | Result |
| --- | --- |
| `phase6-t4b-decider.test.ts` | 12 passed / 3 scoped to 4b-ii (from 12-of-15 RED at the staged shape) |
| Full integration suite, pristine DB | **93 files, 1194 passed / 3 skipped / 0 failed, 0 deadlocks** |
| `pnpm check` (repo root) | **EXIT 0** — web 786/786, API 793/793 |
| `upgrade-proof.sh` | **594 assertions, EXIT 0** over the migrated legacy DB |
| `test:e2e:api` | 31 passed / 6 skipped, against a MIGRATED database with the seals live |
| Demo seed re-runnability | two consecutive seeds, first 0, second 0 |
| Migration retry-safety | re-applies cleanly over an already-migrated database |

Two notes on what counts as evidence here. The e2e figure is from a database with the 4b migration
APPLIED — an earlier local run passed against an unmigrated `pmcvitan_e2e` and proved nothing. And
the seed figure is the RE-SEED: the first seed of an empty database deletes nothing and would pass
with or without the fix.

## Round 1 — the twelve Codex findings on `ed72636`

Eight P1 and four P2, answered in ONE batched head. Seven of the eight probes in
`phase6-t4b-correction.test.ts` are RED at `ed72636` and green after; the eighth (F6) is a race
whose first draft was not deterministic — it is now condition-based, and the honest note is that
its RED was observed only after that rewrite, not in the first reproduction pass.

| # | Finding | Fix |
| --- | --- | --- |
| F1 | a published `recorded` issue could be DELETED — the seal fired on INSERT/UPDATE only, and 4a's no-delete covers `withdrawn` | the seal gains its DELETE arm; an unpublished record draft stays deletable |
| F2 | approval EVENTS were not counted at conversion, and none was sealed after it | the conversion counts `DecisionEvent` as well as the revision register, and a new reverse trigger refuses approval evidence against a record |
| F3 | a record-only issue still pushed "awaiting your approval", on BOTH publish paths | the whole side-effect bundle branches: a new `decision.recorded` effect key, same event type, same invalidation, no push |
| F4 | the "frozen" approval-holder tuple was frozen by nothing | write-once from the moment the act records it, and unplantable on a row that carries no approval |
| F5 | no audit for ALREADY-published decisions holding fewer than two options — the freeze made them unrepairable | a diagnostic-first audit that ABORTS naming the rows, with the repair proven in the probe |
| F6 | the option guard read publication status unlocked, so a delete could slip past an in-flight publish | `FOR SHARE` on the head row serializes the two |
| F7 | the DB author predicate admitted `engineer`; `ROLE_POLICY['decision.create']` admits only `pmc` | the predicate matches the shared policy |
| F8 | `approve` read the orgs-owned `Membership` table directly, twice | `OrgsParticipant.describeMembership` — one question, one owner. The existing ratchet never saw it because it guards raw `Membership` SQL, and this read went through the Prisma client |
| F9 | a reopen after the holder left raised a raw PG error → 500 | `requestChange` validates standing under the lock and returns the actionable 409; the seal stays the backstop |
| F10 | announcements said "Client approved" for every decider | the announcement names the actual holder, so it cannot contradict the `onBehalfOf` the same act persists |
| F11 | an ACTIVE role change was refused for a named holder that keeps its standing | the membership id is passed only when the write ends that membership's active standing |
| F12 | a blocked member removal surfaced as a 500 | a new `DecisionsParticipant.holdsOpenDecisions` — calling the SAME SQL predicate the seal calls, so the two cannot drift — asked before the write |

## Round 2 — the four Codex findings on `067209bc`

Three P1 and one P2, answered in ONE batched head. All five probes in
`phase6-t4b-correction2.test.ts` are RED at `067209bc` — with `20270817000000` **and** the service
half reverted, so each failure is behaviour and never a missing symbol — and green after.

Three of the four are follow-ons to round 1, and each landed exactly where a round-1 fix had stopped
at its surface.

| # | Finding | Fix | RED at `067209bc` |
| --- | --- | --- | --- |
| R2-1 (P1) | the act tuple's first write checked the DESTINATION status (`NEW.status = 'approved'`), not the TRANSITION — so every row approved BEFORE `20270815000000` carries a NULL tuple on an `approved` row, and any direct writer could fill all three columns with anything, which round 1's write-once rules then made permanent | the first write requires `OLD.status <> 'approved' AND NEW.status = 'approved'` — a tuple that records an act may only be written BY that act | the forged UPDATE was ACCEPTED (returned 1) |
| R2-2 (P1) | the narrowed author predicate ran only on an INSERT that was already `recorded`; the draft → record CONVERSION door — the round-13 lifecycle the plan supports — never asked at all, so a draft authored by a client could become a permanent record attributed to someone the application would refuse | the ENTRY-into-`recorded` branch calls `t4b_require_readiness_key` + `orgs_user_decision_authority`, the same two questions the INSERT door asks | the unauthorized conversion was ACCEPTED (returned 1) |
| R2-3 (P1) | `change_request_t4b_seal` read the parent's status with a bare `SELECT`; a conversion and a change-request insert each passed and both committed (the FK takes only KEY SHARE, which a status-only UPDATE does not conflict with), leaving a record holding the unclosable claim the seal exists to forbid | the seal reads the parent `FOR UPDATE`, so the two serialize and exactly one is rejected | BOTH orderings: no backend ever blocked — the barrier timed out, which is the finding itself |
| R2-4 (P2) | `MembersService` passed `existing.role` as the departing role unconditionally, asserting the write removed the role's LAST standing without ever counting the other active holders — so with two active clients, changing or removing EITHER was refused with a 409 the seal would never have raised | the surviving standing is computed from `orgs_effective_role_standing` — the same primitive the seal's own arithmetic calls — and the departing role is passed only when it reaches zero; `updateRole` also takes the readiness lock, so the guard and the seal read one snapshot rather than two | removing the second of two clients threw the 409 |

The round-1 exception wording is preserved verbatim ahead of R2-1's new clause. F4 pins that
sentence, and a narrowed guard is not a reason to move an existing probe's goalposts.

### One defect this round found in the test suite itself

F5 re-runs `20270816000000` on purpose (its diagnostic-first ABORT and clean re-apply are the
probe). Re-running an earlier migration replays its `CREATE OR REPLACE`, which silently UNDOES every
later migration that redefines the same function — for the rest of the process, on a database every
integration suite shares. It surfaced as two round-2 probes failing, and only when F5's suite
happened to run first.

`applyMigrationThroughHead` is the fix and the rule that generalizes: after re-running migration N,
replay every migration that sorts AFTER N. Prisma's directory names are the ordering, so round 3 gets
this for free, and the restoration is ASSERTED from `pg_proc` rather than assumed. A future
migration that is not re-runnable fails there loudly, which is the outcome to want.

Convergence audit (owed at the second finding-bearing head):
`docs/reviews/pr-344-convergence.md` — the one generative class behind all sixteen findings, the
structural closures this head makes, and the boundary-analyzer gap carried forward with its
measurement.

## Round 3 — the seven Codex findings on `2ef9d68`

Four P1 and three P2, answered in ONE batched head. All seven probes in
`phase6-t4b-correction3.test.ts` are RED at `2ef9d68` — with `20270818000000` **and** the service
half reverted, on a scratch database migrated only to `20270817000000` — and green after.
`20270815000000`, `20270816000000` and `20270817000000` are all left byte-for-byte unchanged.

| # | Finding | Fix |
| --- | --- | --- |
| R3-1 (P1) | round 2 keyed the act tuple's first write to the right MOMENT and left it free to name the wrong PARTY: a client-held decision flipped to `approved` could carry `approvedDeciderKind='pmc'` and any label, and write-once then made it permanent | the tuple must equal the decision's own `deciderKind`, and a member-held approval must name its own `deciderMembershipId`. The LABEL is deliberately not machine-validated — it is the display identity as the register rendered it, and a name may legitimately change; what must not vary is WHO |
| R3-2 (P1) | `ROLE_POLICY['decision.approve']` was `['client','pmc']`, so a NAMED contractor/engineer/consultant was refused by `RolesGuard` before the service's holder check could run — the primary member-decider flow could not work through the API, while this PR's invariant matrix claimed the ceiling already admitted them | the ceiling admits every role that may be named; the holder narrowing stays in the service. Two web tests pinned the old ceiling and were updated rather than deleted — `discipline.test.ts` keeps its assertion and moves it to what it meant |
| R3-3 (P1) | the identity freeze read `OLD."publishedAt" IS NOT NULL`, so a DRAFT could be re-keyed AND published in one statement; FK cascades carry options and events, but `DomainEvent.entityId` and the command receipt's `resultRef` keep the old id | the id is frozen FROM BIRTH, beside `authorId` and `projectId` — which is what the surrounding comment already claimed |
| R3-4 (P1) | the reopen seal covered `approved → change` only; a member holder may legally be soft-removed while the decision is CLOSED, so `approved → pending` re-opened a published decision whose named holder was already inactive | the guard is stated over the STATE it protects: any transition INTO an open status on a published row revalidates the holder |
| R3-5 (P2) | `role`/`status` still came from a pre-read taken before the transaction and the readiness lock, so a concurrent role change made the subtraction stale and produced a false 409 | `lockMembership` reads role, status and discipline `FOR UPDATE` inside the transaction — the same row the seal sees as `OLD`. The discipline-changed event had the same unlocked-input shape and moved with them |
| R3-6 (P2) | the org arm judged EVERY `OrgMembership` deletion whatever the row's role, and every owner↔admin change; on a project with one explicit pmc and an open pmc-held decision, deleting an unrelated plain `member` was refused | the arm asks what `orgs_effective_role_standing` asks — did this row supply effective pmc standing here, and does it stop? It also no longer contends for every project's readiness key to reach that conclusion |
| R3-7 (P2) | `isRecord` was derived from an unlocked pre-read, so a conversion committing before the CAS emitted the wrong side-effect bundle in either direction | the bundle is derived from the row the CAS locked. The probe makes the interleaving DETERMINISTIC by interposing the command's pre-read from the test and committing the conversion from a second connection — the service is untouched |

Convergence audit (owed at the second finding-bearing head, extended at the third):
`docs/reviews/pr-344-convergence.md`.

## Round 4 — the five Codex findings on `87461e6`

Two P1 and three P2, answered in ONE batched head. All five probes in
`phase6-t4b-correction4.test.ts` are RED at `87461e6` — with `20270819000000` **and** the service
half reverted — and green after. `20270815000000` … `20270818000000` are all byte-for-byte
unchanged.

**Three of the five are one shape**, and it is the shape this review has now raised four separate
times: a seal is correct, the service in front of it never asks, and an ordinary conflict reaches
the caller as a 500. F9 named it for `requestChange`, F12 for `members.remove`; R4-3/4/5 name the
remaining doors. The convergence audit records what that says about its own earlier claim to have
closed that face.

| # | Finding | Fix |
| --- | --- | --- |
| R4-1 (P1) | the conversion counts `DecisionApprovalRevision` on the way IN and nothing sealed it on the way OUT — the register's own trigger refuses a `withdrawn` parent only, and round 1's reverse trigger covers `DecisionEvent` only. A draft converted while the count was zero could be given a revision afterwards, and append-only then made the contradiction permanent | the register's insertion seal refuses a `recorded` parent too, keeping the parent-row `FOR UPDATE` the 4a seal already took — so a conversion and an insertion serialize in either order. The `withdrawn` message is preserved verbatim; 4a's probes pin it |
| R4-2 (P1) | the INSERT branch RETURNS before the holder binding R3-1 added, so a row could be BORN approved with a tuple naming a different holder — or no tuple at all, which R2-1 then forbids repairing | a row born `approved` carries a COMPLETE tuple recording its own decider. Rows that already existed are reached by UPDATE, never INSERT, so the legacy shape is untouched — and a coherent approved insert is still accepted, proven in the probe and over the migrated legacy DB |
| R4-3 (P2) | neither publish door took `lockProjectReadiness`, so the seal's §B.1 try-acquire — which REFUSES rather than waits — turned a valid publication into a raw PostgreSQL error whenever a membership command held the key | both doors hold the key. Advisory locks are re-entrant, so the seal's try-acquire succeeds; the probe holds the key from a second session and asserts publish WAITS rather than being refused |
| R4-4 (P2) | `OrgsService.updateOrgMemberRole`/`removeOrgMember` had no precheck, so demoting or removing a project's sole effective pmc 500s | both ask `DecisionsParticipant.holdsOpenDecisions` first, with the standing arithmetic mirroring the seal's exactly (R3-6): an org row supplies pmc standing only where the user holds no active membership, and only a write removing that supply can strand anything |
| R4-5 (P2) | publishing a member-held draft whose named member has left — explicitly allowed, because a draft never blocked their removal — surfaced a raw database failure instead of telling the caller to re-point the draft | the holder is validated through `OrgsParticipant` inside the publication transaction, on `publish` and on the one-step issue alike |

## Round 5 — the six Codex findings on `cc00c94`

Three P1 and three P2, answered in ONE batched head. All six probes in
`phase6-t4b-correction5.test.ts` are RED at `cc00c94` — with `20270820000000` **and** the service
half of each finding reverted, on a scratch database migrated only to `20270819000000` — and green
after, each failing for its own reason. `20270815000000` … `20270819000000` are all byte-for-byte
unchanged.

This head is also where the **review-lifecycle limit** (five finding-bearing heads, 34 findings)
is reached, and the round says what the limit is for. Two of the three P1s are not seal defects at
all: they are consequences of where 4b was cut. Shipping the `recorded` status and the
`pmc`/`member` decider kinds WITHOUT the audience that routes them leaves the product actively
wrong — a record linkable as work that is "awaiting the client's approval" nobody can give, and a
push telling the client to approve a decision they do not hold. The owner's decision was
**gate the surface, keep the facts**: every fact and seal the previous four rounds cleared stays
exactly as reviewed, and the two surfaces that cannot be routed correctly until 4b-ii are CLOSED
with a message naming the reason.

| # | Finding | Fix |
| --- | --- | --- |
| R5-1 (P1) | `recorded` was exposed as a terminal status but treated as linkable: `linkableInProject` returned `linkable`, both activity write paths and the daily-log path accepted it, and the Schedule picker excluded only `withdrawn`. `deriveDecisionReading` then parks the activity at `wait / Awaiting the client's approval` — for a decision approvable by nobody, forever | `linkableInProject` returns `'recorded'` as its own verdict; the two activity write paths (pre-tx and the in-tx authority) and the daily-log path refuse it with "A recorded issue has no approval to wait for"; the shared `UNLINKABLE_DECISION_STATUSES` set drives BOTH pickers, so the client rule and the server rule are one list |
| R5-2 (P1) | every non-record publication still used the legacy CLIENT audience, so a `pmc`- or `member`-held decision notified the client and hid the pending row from its actual holder — the member approval route R3-2 opened was unreachable through normal reads | the SURFACE is gated, not the facts: `createDecisionSchema` refuses `deciderKind: 'pmc' \| 'member'` with a message naming unit 4b-ii, while `client` and `none` are untouched and the default stays `client` (so every existing caller is byte-identical). The column, enum, seals and the widened approval route all remain — 4b-ii removes the gate together with the audience that makes them honest |
| R5-3 (P1) | rounds 2/3/4 bound the act tuple's KIND and MEMBERSHIP and never asked about the LABEL, so an approval transition carrying the right kind and a null, whitespace-only or fabricated label passed — and the write-once arms froze it forever | the label is required complete and non-blank, and BOUND to the designated holder, at both doors. The rule has ONE statement — `decisions_t4b_holder_label` — and `DecisionsService.approve` calls it inside its own locked transaction rather than keeping a TypeScript copy, so the value written and the value the seal recomputes are the same read |
| R5-4 (P2) | round 4's org spokesman ran OUTSIDE any transaction: a competing demotion could commit between the answer and the write (the DB then correctly refuses, and its raw exception escapes as the 500 the spokesman existed to replace), and the seal's own §B.1 try-acquire could refuse the write outright | the guard and its write are ONE transaction holding each affected project's readiness key, taken in the ASCENDING project id order the trigger's own loop uses. The probe holds the key from a second session and asserts the org write WAITS — and that the row is still unchanged while it waits |
| R5-5 (P2) | `requestChange`'s round-1 spokesman covered the `member` arm of a seal with TWO arms. A client- or pmc-held decision's last role holder may legally leave while it is closed; the later reopen then took the ROLE arm and 500s | the ROLE arm has its spokesman too — `OrgsParticipant.roleHasEffectiveStanding`, which calls `orgs_effective_role_standing`, the primitive the seal's arm calls. The probe asserts the exception TYPE, because the message alone does not distinguish a translated conflict from the raw one |
| R5-6 (P2) | post-write standing was `orgs_effective_role_standing(...) - 1`. That subtraction models a write that only REMOVES standing — but an ACTIVE membership SUPPRESSES its holder's org-derived pmc standing, so removing the sole project pmc who is also an org owner/admin leaves standing at 1. Both the service guard and the seal refused a removal that stranded nobody | the hypothetical is stated INSIDE the primitive: `orgs_effective_role_standing_after(project, role, membership, afterRole, afterActive)` computes standing over the membership set as the write will leave it, precedence arm included. `orgs_effective_role_standing` is redefined as its no-hypothesis case, so there is one body rather than two that must agree — and both the service and the seal ask it |

Convergence audit (third edition): `docs/reviews/pr-344-convergence.md`.

## Round 6 — the seven Codex findings on `ccaf2dd` (eight comments; one P2 duplicated)

Four P1 and three P2, answered in ONE batched head. Every probe in
`phase6-t4b-correction6.test.ts` (6) and `decision-recorded-register.test.tsx` (3) is RED at
`ccaf2dd` — with `20270821000000` **and** the service half of its finding reverted, on a scratch
database migrated only to `20270820000000` — and green after, each failing for its own reason.
`20270815000000` … `20270820000000` are all byte-for-byte unchanged.

| # | Finding | Fix |
| --- | --- | --- |
| R6-1 (P1) | the completeness and binding checks were keyed to *a tuple column becoming non-null*, so a direct `pending → approved` update writing nothing skipped all of them — and R2-1 forbids filling the tuple afterwards, leaving the decision permanently approved by nobody. Round 5's own probe accepted that shape | the rule is restated over the ACT: every transition into `approved` carries a complete, non-blank attribution. The BINDING still applies only when the act WRITES the tuple, because a re-approval carries the frozen one forward (R2-1 requires `NEW = OLD`) and re-binding it to the holder's CURRENT name would refuse an ordinary re-approval after a rename — history renders as it stood. A column filled outside an approval stays refused |
| R6-2 (P1) | `DecisionRowCard` had no branch for `recorded`: `neverLocked` covered only `pending`/`withdrawn`, so a published record fell through to the approved shape — `undefined — undefined` as its outcome, a zero approved cost, an `APPROVED` photo stamp and "awaiting client" for a decision approvable by nobody. The status filter, the group label and the rollup omitted the value | the card gets its record branch (a `RECORD` stamp, "Recorded issue — no options, no approval", an em-dash cost, a "no approval required" attribution), and the three enumerating surfaces gain the value: the filter chip, `STATUS_LABEL`, the status-lens rank, the `counts` type and the rollup chip. **This one cannot be gated away** — `deciderKind: 'none'` was deliberately kept, so records are creatable and served to the whole team |
| R6-3 (P1) | PostgreSQL's one-argument `btrim` strips SPACES only, and `addMemberSchema` admits a tab- or newline-only user name; that name becomes a member-held decision's expected label, satisfying both the non-blank check and the equality check and freezing an attribution that renders as nothing | `decisions_t4b_blank` is the ONE statement of blankness, over the full ASCII whitespace set (the `ExternalParty_name_not_blank` discipline), asked by both seal arms and the diagnostic |
| R6-4 (P1) | round 5's `pmc`/`member` gate lived only in `createDecisionSchema`, and `publish()` takes no body — so a draft saved before the gate, or written directly, published straight through it, after which the unchanged client audience demanded an approval from the wrong party | the gate moves to where a decision acquires weight: `assertPublishableHolder` refuses both kinds on BOTH publish doors. The HOLDER question is asked first, so "the member you named has left" — round 4's proven behaviour — is not swallowed by a generic refusal |
| R6-5 (P2) | round 4 gave the publication seal a spokesman for its MEMBER arm only; a default client-held draft published after the last client left reached the seal with zero standing and surfaced a raw PostgreSQL exception, on both the saved-draft door and the one-step issue | the ROLE arm joins it through `roleHasEffectiveStanding`, which calls the same `orgs_effective_role_standing` the seal's arm calls, inside the readiness-locked transaction |
| R6-6 (P2) | `assertOrgWriteKeepsDecisionHolders` took its departing role from a pre-transaction read: A reads `member`, B promotes that target to admin and removes the previous sole admin, A then skips every readiness lock and holder check on a role that is no longer true, and its delete reaches the seal as the removal of the sole PMC | the departing role is read `FOR UPDATE` inside the transaction. The probe interposes the race deterministically (the R3-7 pattern) — the pre-read is made to answer `member` while the row says `owner`, and the probe asserts it actually served the stale value |
| R6-7 (P2) | the holder seal's ACTIVATION arm had no spokesman: adding a membership-less org owner/admin to the team in any non-pmc role displaces the pmc standing they supplied through the org, and the seal correctly refuses while a pmc-held decision is open — as a 500 | `MembersService.add` asks the seal's own condition in the seal's own order (non-pmc activation → does the org make them an effective pmc → are they the last one) and refuses with a message naming the remedy the seal implies |

### The spokesman enumeration, now run to exhaustion

Round 4 wrote the coverage rule and checked the paths it had noticed. This is the list:

| Seal arm | Service spokesman |
| --- | --- |
| publication — named member gone | `assertPublishableHolder` (both publish doors) |
| publication — role emptied | `assertPublishableHolder` → `roleHasEffectiveStanding` |
| reopen — named member gone | `requestChange` → `describeMembership` |
| reopen — role emptied | `requestChange` → `roleHasEffectiveStanding` |
| membership removal / re-role | `MembersService.remove` / `updateRole` → `holdsOpenDecisions` |
| membership ACTIVATION (displacement) | `MembersService.add` → `holdsOpenDecisions` |
| org membership removal / demotion | `OrgsService.assertOrgWriteKeepsDecisionHolders` |
| readiness-key try-acquire (every arm) | every command holds `lockProjectReadiness` first |

Convergence audit (fourth edition): `docs/reviews/pr-344-convergence.md`.

## Round 7 — the three Codex findings on `39bfb39`

One P1 and two P2, answered in ONE batched head. All three probes in
`phase6-t4b-correction7.test.ts` are RED at `39bfb39` — with `20270822000000` **and** the service
half of the finding reverted, on a scratch database migrated only to `20270821000000` — and green
after. `20270815000000` … `20270821000000` are byte-for-byte unchanged.

**All three are round 6's own over-reach**, and all three are one class the audit had already named
twice (R2-4, R3-6): a guard stricter than the rule it fronts.

| # | Finding | Fix |
| --- | --- | --- |
| R7-1 (P1) | round 6 keyed the approval-act rule to *a transition into `approved`*, but `withdrawChange` reaches that transition to RESTORE an approval that already happened. Every pre-`20270815000000` row carries a null tuple by design, so a change request on one could be raised and never withdrawn — a raw PostgreSQL error on an ordinary path | a RESTORATION is identified from the row: it already carries approval evidence (`approvedById`) and this statement changes none of it — not the approver, not the option, not the tuple. Nothing is recorded, so there is no act to attribute. Everything else answers for itself, proven by the precision arm (arriving at `approved` while changing the option IS an act and is refused) |
| R7-2 (P2) | round 6's migration says a re-approval carries the frozen tuple forward *because* re-binding it to a changed name would refuse a valid act — and the service re-derived the label every time, so a re-approval after a rename offered the write-once arm a different value and it correctly refused | the tuple is written by the FIRST approval only; a later one preserves it, and the announcement reads the same frozen value the register renders. Round 6's probe used a client-held decision (label `Client`, constant) and could not see this; the round-7 probe renames the person |
| R7-3 (P2) | round 6's activation guard asked about the ROLE where the seal asks about an ACTIVATION, so re-roling an already-active org owner/admin was a false 409 | **both** the guard and the seal now ask whether the membership was already active. The seal had to move too: Prisma's `upsert` compiles to `INSERT … ON CONFLICT DO UPDATE`, and PostgreSQL fires the BEFORE INSERT trigger with `TG_OP = 'INSERT'` even when the conflict path is taken — so fixing only the service, which is what the finding asks, would have turned the false 409 into a raw 500 |

Convergence audit (fifth edition): `docs/reviews/pr-344-convergence.md`.

## Round 8 — the three Codex findings on `90ec557`

Two P1 and one P2, answered in ONE batched head. All three probes in
`phase6-t4b-correction8.test.ts` are RED at `90ec557` — with `20270823000000` **and** the service
half of the finding reverted, on a scratch database migrated only to `20270822000000` — and green
after. `20270815000000` … `20270822000000` are byte-for-byte unchanged.

**Classification: no seam findings. Two are this PR's own corrections biting back; the third is a
latent read that three corrections built on top of.** All three are one shape — *a value read
outside the lock that makes reading it a decision.*

| # | Finding | Fix |
| --- | --- | --- |
| R8-1 (P1) | round 7's restoration exemption keys on `OLD.status <> 'approved'`, which admits `pending → approved`: a direct writer can publish a pending row with `approvedById`/`approvedOption` planted and the tuple null, flip only the status, satisfy every equality, and record a permanently unattributed approval **through the exemption** | a restoration is narrowed on three axes: it comes from `change` (the only status a withdrawal restores from), it changes no approval evidence, and **an approval actually happened** — `approve()` has written an `approved`/`reapproved` `DecisionEvent` since Phase 1, so every genuine approval carries that proof and a planted column does not |
| R8-2 (P1) | `publish` applied the holder check, the role arm and the `pmc`/`member` surface gate to an UNLOCKED pre-read, so a concurrent draft edit could change the holder before the CAS — publishing a kind the gate exists to refuse, and then emitting the legacy client push for it | the decision row is `FOR UPDATE`-locked before its holder is read and the lock is held through the update. Round 3's R3-7 stated this rule and applied it to `isRecord`; rounds 4/6/7 then built three authority decisions on the read it left behind |
| R8-3 (P2) | the first approval's label is derived, written, and RECOMPUTED by the seal in three statements; under READ COMMITTED a rename committing between them gives the service the old name and the trigger the new one, killing a valid approval with a raw database error | the holder's identity is HELD — `FOR SHARE` on the `User` row, through `OrgsParticipant.lockMembershipIdentity`, because how identity is locked is a statement about identity — so all three statements see one value |

### The probe defect that mattered more than the findings

R8-3 would not reproduce at first: the interposed rename never ran, because **a Prisma raw promise
is lazy** — assigning `raceDb.$executeRawUnsafe(...)` and walking away starts nothing. The Phase-4
T1 correction-4 packet already records this exact trap, and this round walked into it again. It was
caught only because the probe asserts that *its own interposition actually happened*
(`expect(spyFired)`, `expect(renameLanded)`) rather than trusting that setting up a race creates
one. **A probe that cannot prove it ran its own experiment is not evidence.**

Convergence audit (sixth edition), including the round-by-round seam / self-inflicted / original
count and what it recommends for 4b-ii: `docs/reviews/pr-344-convergence.md`.


## Round 9 — the three Codex findings on `92868d7`

Answered on `a283568` via `20270826000000` plus its service half. **Classification: no seam
findings; all three are this PR's own corrections biting back.**

| # | Finding | Fix |
| --- | --- | --- |
| R9-1 (P1) | round 8's proof that "an approval actually happened" is a `DecisionEvent`, and nothing stopped that event being INSERTED while the parent sat in `change` — so the forger writes one and borrows the exemption | the event was required to PREDATE the earliest open `ChangeRequest`: a genuine restoration's approval happened before the change was requested, a planted one necessarily after |
| R9-2 (P1) | round 7's non-blocking readiness guard was applied to `AuthService.signInOrProvision`, which holds no readiness key — under contention the membership insert REFUSED after the `User` had committed, and the retry then found the identity, skipped provisioning, and left the account permanently unable to sign in | user and membership provision in ONE transaction holding `lockProjectReadiness`: contention WAITS, and a failure leaves nothing behind to poison the retry |
| R9-3 (P2) | the round-6/8 `activates` narrowing left the role-CHANGE half of the same upsert with no departure check at all | `members.add` runs the SAME guard `updateRole` runs, reading id and role under one `FOR UPDATE` |

**R9-1's first attempt was itself an over-reach and the battery refuted it before the gate**: it
forbade recording an approval event unless the parent was already `approved`, which is precisely the
shape 4a's seals exist to refuse — `phase6-t4a-withdraw` (4 tests), `phase3-requirements` R2-1,
`phase6-t4b-correction` F2 and `upgrade-proof.sh` all failed. Recorded rather than quietly replaced.

## Round 10 — the two Codex findings on `a283568`

Answered on this head via `20270827000000`. **Classification: no seam findings; both are this PR's
own corrections biting back — R10-1 for the fourth consecutive round.**

| # | Finding | Fix |
| --- | --- | --- |
| R10-1 (P1) | round 9's ordering predicate is forgeable BOTH ways: close the `ChangeRequest` and the missing open request makes the `COALESCE` bound read `infinity`, so any later event qualifies; or simply rewrite the caller-supplied `DecisionEvent."at"` | **the clause is replaced, not narrowed a fifth time.** `DecisionLegacyApproval` stamps every approval standing when the migration runs and then refuses every subsequent INSERT/UPDATE, so the exemption is membership of a set fixed before any caller could act on it. Round 7's other two conditions — from `change`, evidence unchanged — are KEPT: they are facts about the statement in front of the trigger, not questions about rows someone else wrote |
| R10-2 (P1) | `linkableInProject` refuses to LINK a `recorded` decision, but nothing asked the reverse — link an ordinary draft, then convert it, and the same permanently-unopenable gate exists | the conversion asks the OWNING modules through `activities_decision_has_dependents` and `daily_log_decision_has_dependents` (the `orgs_user_decision_authority` channel; no peer-table read). Both orderings serialize on the decision row lock the link path already takes, and each loses for the right reason |

### What the round removed rather than added

Four predicates over caller-writable rows (rounds 6→9) collapse into one question about an
enumerated set. Nothing is fabricated: the migration writes no attribution, because a pre-Phase-6
approval has none — the safety property is that the set of unattributed rows is finite, frozen and
enumerable. An earlier draft of this migration DID backfill the tuple where it looked derivable;
it was withdrawn for writing the wrong label for `client` holders **and** for asserting a fact the
historical record never captured.

### Where the precision evidence lives, and why it moved

A genuine legacy row is one approved BEFORE the migration — unreachable from a suite whose database
is migrated from empty, and unfakeable afterwards by design. Three fixtures that had been
*simulating* one were therefore re-homed to `scripts/upgrade-proof.sh`, which plants legacy shapes
and THEN migrates:

- `UP4B2-D1` moved from a post-ledger plant to a **pre-`20270827000000`** plant, so the round-7 and
  round-8 restoration assertions now hold for a reason a forger cannot reproduce;
- `phase6-t4b-correction7.test.ts` R7-1 keeps its claim on an ORDINARY approval (the path the
  product walks) — the tuple is carried forward verbatim, not re-derived;
- `phase6-t4b-correction8.test.ts` R8-1's precision arm is replaced. Its old shape **disabled
  `Decision_t4b_recorded_seal`** to strip a tuple and manufacture a "legacy" row — switching off the
  seal to demonstrate the seal. It now proves the stronger fact this round makes true: a tupleless
  arrival on a row minted after the migration is refused whatever evidence accompanies it.

### Verification at this head

| Gate | Result |
| --- | --- |
| `phase6-t4b-correction10.test.ts` | **9 passed**, 8 of 9 RED at `a283568` (the ninth — a link racing a committed conversion — is the direction that already worked, kept as the counterpart proving the fix did not break it) |
| Full integration suite, pristine DB | **104 files, 1260 passed / 3 skipped / 0 failed** |
| `pnpm check` (repo root) | **EXIT 0** — web 790/790, API 793/793 |
| `upgrade-proof.sh` | **647 assertions, EXIT 0** over the migrated legacy DB |
| `test:e2e:api:allmodules` / `:allmodules:outbox` | 37 / 37 |

`20270815000000` … `20270826000000` are byte-for-byte unchanged.
