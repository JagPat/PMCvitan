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
attributable the moment the holder later changes.

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

*(section completed after the sweep — see the Verification block)*

## Verification

*(completed at the end of the sweep)*
