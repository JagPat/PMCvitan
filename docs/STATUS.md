# STATUS

Machine-readable state for the autonomous runner. The runner reads this file to
decide what to do next and updates it after each merge. It is also the one place
a human can glance at to see where the loop is.

This file is authoritative for task state. `docs/ROADMAP.md` is historical
narrative and may lag behind reality.

## Now

```yaml
phase: 5
phase_plan: docs/superpowers/plans/2026-07-29-phase-5-commercial-control.md
task: 6
task_state: in_review
work_item: phase-5-task-6b-i
reviewed_merge: 5b8186a
open_pr: 289
next_task: phase-5-task-6b-ii
blocking_directive: none
updated: 2026-08-07
```

**PHASE 5 IS THE ACTIVE PHASE.** Its plan is merged and independently cleared
(PR #266 at `main` `0af7f99`, clean Codex +1 on head `ede5a1a`). **Task 1 — the
`commercial` capability, `CostHead` and the §C `CommitmentAttribution` with its
XOR/uniqueness/append-only seals, the `CommercialParticipant`, the §L activation
backfill and all eight forward lifecycle hooks — is MERGED and INDEPENDENTLY
CLEARED** (PR #268 at `main` `3ae5591`, fresh clean Codex +1 on the exact head
`e08a6a1` through the `codex-current-head` gate, after FOUR correction rounds and
twelve findings all fixed forward with reproduce-first probes). Evidence:
`docs/reviews/phase-5-t1-commercial-packet.md`; convergence audit
`docs/reviews/pr-268-convergence.md`. It ships NO `BudgetLine`: §L is explicit
that authority is only meaningful against the obligation it measures, so the
budget, the `COMMITTED` fold and the over-budget exception land together in Task 2.

**Task 2 is MERGED and INDEPENDENTLY CLEARED** (PR #270 at `main` `b480e0e`, fresh clean Codex +1 on the exact head `0a6b6d7` through the `codex-current-head` gate). It ships §B's versioned
immutable `BudgetLine` (one live chain per head, `amount >= 0`), the §C/§0
`COMMITTED` fold read through each PO line's OWNING module (OUTSTANDING, not
gross — the buckets PARTITION the money), §J's received-not-billed and headroom,
the `BudgetException` lifecycle observation raised or cleared in the SAME
transaction as the write that moved headroom, `commercial.budget.set` (one
command for v1 and every revision), and the `GET …/commercial/budget` read. It
gates NOTHING: commercial stays a SINK and no readiness verdict consults a
budget. Two Codex rounds returned seven findings, all fixed forward; the
convergence audit `docs/reviews/pr-270-convergence.md` names the two roots and
leaves a mechanical closure for each in
`apps/api/src/commercial/commercial.contract.test.ts`. FOUR Codex rounds
returned thirteen findings, all fixed forward. TWICE a round-2 corrective was one
level too shallow, and the audit says so plainly: its closure for root B was a
hand-kept list of six SITES (round 3 found three more movers it did not contain,
so the mover set is now DERIVED from what the fold READS — `FOLD_INPUTS`, pinned
against the `MaterialCommittedLine` read contract), and its fix for the wrong
exception LABEL moved the decision to the caller (round 4 found the caller cannot
know either, since one amend can re-size some lines and reclassify others, so the
label is now derived per row from whether the head actually changed). Notably `acceptance` is §B's
FOURTH headroom mover (§G authorises accepting more than the ordered quantity and
no commitment is released against the overage, so a receipt can breach a budget
with no purchase-order write anywhere), a closed-short line's released remainder
is a function of `receivedQty`/`committedQty` so receipt reversals and labour
capacity defaults are movers too, an AMEND evaluates ONCE at the end (an
intermediate evaluate writes a permanent false clear into an append-only
register), and the budget READ runs at repeatable-read so it cannot report
healthy headroom beside the exception it just opened. Evidence:
`docs/reviews/phase-5-t2-budget-packet.md`.

**One decision is OPEN for the owner and is recorded rather than assumed.** Eight
of the twelve review findings were the §L activation path: `capability:enable` is
an operator CLI, so every guarantee `ProjectAccessService.authorize` plus the
command transaction give a request for free — project-not-archived, active
membership, role, a resolved actor, readiness serialization — had to be rebuilt
explicitly, and the review found them missing one at a time. Task 1 now closes
that list as a table (see the convergence audit). Whether activation should
instead become an ordinary authenticated command, inheriting all five by
construction, is a design change to a cleared mechanism (`capability:enable`
activated both `materials` and `labour`) and is the owner's call. **It does not
block Task 2**, whose scope is the versioned budget and the `COMMITTED` fold. **PHASE 4 IS COMPLETE.** Tasks 1–6 are all merged through the exact-head
`codex-current-head` gate with independent Codex clearance. Task 6 — the FINAL
Phase-4 review stop — merged as PR #246 at `main` `67e7a00` with a fresh clean
Codex +1 on the exact head `f098be7`, after fifteen exact-head correction
rounds (46 findings, every one fixed forward with a reproduce-first RED→GREEN
probe and a full gate battery) and the PR-#247-protocol convergence audit
`docs/reviews/pr-246-convergence.md`. Capability-enabled internal (pilot)
projects may use the Labour workflow end to end; non-pilot projects are
unaffected (§D). Phase 5 planning is the recorded `next_task` and begins
automatically on the first runner pass after this merge, per the runner
rules below — the project owner resolved the PR #248 review dispute by
explicitly instructing automatic next-phase progression (recorded in
`docs/reviews/pr-248-convergence.md`). The **Maintenance queue** below
remains the standing work source whenever no phase task, no correction, and
no open PR is active.

## Phase 5 — commercial control

Plan: `docs/superpowers/plans/2026-07-29-phase-5-commercial-control.md` — merged and
independently cleared as PR #266.

The plan is the owner-approved split of PR #252, which specified all seven tasks in one
1,661-line document and drew TWENTY rounds of correct findings that never fell. The plan
keeps only the settled cross-cutting parts (§0 canonical evidence sets, §0b, §A, §I, §J,
§K, §L, §M, the task table, §N and the probe list); §B–§H travel VERBATIM into the PR for
the task that implements them, pinned to `claude/phase5-planning` commit `a4d469b`. The
convergence packet `docs/reviews/pr-266-convergence.md` carries the question→probe→task
deferral ledger — a task PR must carry its section forward rather than re-derive it.

| Task | Summary | State |
|---|---|---|
| 1 | `commercial` capability + SINK module + `CostHead` + `CommitmentAttribution` + activation backfill (§C/§L) | merged — PR #268 at `main` `3ae5591` with a fresh clean Codex +1 on the exact head `e08a6a1` (four correction rounds, twelve findings, all reproduce-first); evidence `docs/reviews/phase-5-t1-commercial-packet.md` + `docs/reviews/pr-268-convergence.md` |
| 2 | Versioned immutable `BudgetLine` + `COMMITTED` fold + budget-vs-committed exception (§B) | merged — PR #270 at `main` `b480e0e` with a fresh clean Codex +1 on the exact head `0a6b6d7` (four correction rounds, thirteen findings, all reproduce-first); evidence `docs/reviews/phase-5-t2-budget-packet.md` + `docs/reviews/pr-270-convergence.md` |
| 3 | `Measurement` (§D) + the `revertSignOff` withdrawal guard | merged — PR #272 at `main` `8833744` with a fresh clean Codex +1 on the exact head `236e7c3` through the `codex-current-head` gate (FOUR correction rounds, fifteen findings, every one fixed forward with a reproduce-first RED→GREEN probe); evidence `docs/reviews/phase-5-t3-measurement-packet.md` + `docs/reviews/pr-272-convergence.md`. **The plan's post-Task-3 STOP — a narrow review before any bill can consume a measurement — is SATISFIED by that independent review.** The audit names four roots; round 4's headline is that round 3 stated closure C and applied it only where the reviewer pointed, so round 4 SWEEPS every reference on the table instead. Three probes in this PR passed while proving nothing (a vacuous timezone probe, three §D upgrade-proof rejections firing on the wrong FK, and two identity probes comparing across projects) — all caught by running the RED proof rather than assuming it, and closed once as a rule: a rejection is only evidence when an otherwise-identical case is ACCEPTED |
| 4 | `VendorBill` + immutable versions + lifecycle to `under-verification` + bounds 1–2 + both withdrawal guards | merged — PR #274 at `main` `fa372e2` with a fresh clean Codex +1 on the exact head `ce6b56d` through the `codex-current-head` gate (SIX correction rounds, twenty-three findings, every one fixed forward with a reproduce-first RED→GREEN probe). Ships the §F claim (root + immutable versions + XOR-sealed lines), the CAS lifecycle up to `under-verification` plus `disputed`/`resolved`/`rejected`, §G bounds 1–2 re-derived under the owning module's row lock AND sealed by a DEFERRABLE INITIALLY DEFERRED constraint trigger firing from seven sites, the §F vendor pinning on both PO-line snapshots with a diagnostic-first backfill, and BOTH withdrawal guards. §F/§G carried into the plan VERBATIM from `a4d469b`. Evidence: `docs/reviews/phase-5-t4-vendor-bill-packet.md` + `docs/reviews/pr-274-convergence.md`. **This unit reached SIX finding-bearing heads against a lifecycle limit of five, and the audit is blunt about why: for six rounds a correction fixed the instance the finding described while that finding's own siblings survived — the wrong LAYER (service, not database), the wrong SUBSET (live statuses, not every state), the wrong COLUMN (the newest evidence, not all of it). Round 6 is the first correction that REPLACES a rule instead of extending one, and the test it leaves behind is: if a finding names a status, a column, or a layer, the fix belongs to the SET that member came from, not the member.** |
| 5 | Three-way verification (§E) + `verified` + dispute + certification + bound 3 + §H + SoD | **SPLIT into 5A/5B/5C on external review.** The single task measured 15 files / 2,333 lines before its controller, tripwires or any probes — over the 1,500-line review budget, and PR #274 had just shown what an over-budget unit costs (six finding-bearing heads). Each increment is ONE architectural concern. **The plan's post-Task-5 STOP applies after 5C**, when payment authority is fully in place |
| 5A | §E three-way verification + the `verified` arrow | merged — PR #276 at `main` `2becae4` with a fresh clean Codex +1 on the exact head `5d78021` through the `codex-current-head` gate (FIVE correction rounds, nineteen findings, every one fixed forward with a reproduce-first RED→GREEN probe). Ships the derived triple (ordered · accepted/measured · billed), the pro-rata tax/freight cap with its load-bearing `min` clamp, the six exception kinds with `duplicate-claim` compared per `(bill, PO line)` AGGREGATE, and the ONE arrow the verdict makes safe — its provenance sealed in two halves split by when each is knowable (`commandType` at BEFORE, `resultRef = verification.id` + `succeeded` at COMMIT), fired from BOTH `VendorBill` and `VendorBillVersion` because the predicate names the LIVE VERSION. Evidence: `docs/reviews/phase-5-t5a-verification-packet.md` + `docs/reviews/pr-276-convergence.md`. **Round 5's P1 was the floor rather than the seal: §E's provenance rested on `CommandExecution`, which carried no triggers at all, so the receipt it trusts could simply be minted. That is fifteen `sourceCommandId` columns' problem, not §E's, so it shipped as its own platform PR (#277, `main` `5b0a54a`) and this branch rests on it.** The audit names four roots for 5B/5C to inherit: fix the SET not the member (sixteen instances, thirteen sets); a replay owes the caller what THAT CALL concluded, so a JUDGEMENT is persisted and replayed by command identity; presence is not provenance, and a provenance chain is exactly as strong as its floor — which is usually in someone else's module; and a workaround outlives its cause unless you go back and delete it |
| 5B | Certification + frozen consumption sets + §G bound 3 + §I SoD + the certificate-refusal arms | **SPLIT INTO THREE REVIEW UNITS.** PR #279 reached six finding-bearing heads and twenty-eight findings; round 6 produced four more, TWO OF THEM ON CODE ROUND 5 HAD JUST ADDED — the signal that a unit has stopped converging because each correction adds review surface faster than review retires it. JagPat's standing instruction was to split at that point rather than push a seventh head, so #279 is closed unmerged and the work lands as: **A (draft PR #280, in_progress)** — `BillCertificate` with the §E `(rowId, consumedQty)` freeze on BOTH sides, the total lock order implemented literally, §G bound 3 sealed at COMMIT from both the certificate and the claim side, §I's segregation RULE (the refusal, at the service and at PostgreSQL, over the single `phase5_t5_evidence_actors` authority), and the withdrawal-guard REFUSAL arms Tasks 3–4 could not write because `certified` was unreachable; **B** — §I's attributable OVERRIDE (`SodException`, approver standing, the biconditional), MERGED as PR #281 at `main` `b49403f` with a fresh clean Codex +1 on the exact head `f626808` after five finding-bearing heads and twelve findings, whose last round removed a commercial trigger that read orgs-owned membership and moved the standing decision to the ONE place that may make it — `commercial.sod.grant`, through `OrgsParticipant`, under `forUpdate`; **C** — §J's `certified-payable` bucket, OPEN as draft PR #282 from `b49403f`: the residual correction (`awaiting-certification` becomes `BILLED − CERTIFIED`), the `CERTIFIED` fold read from the CERTIFICATE rather than from a certified bill's claim lines (§G bound 3 is a bound, not an equality — proven by a legal partial certificate), §B's mover obligation discharged by `certify`/`supersede`, and the `FOLD_INPUTS` closure extended to the whole bill-side set rather than the member this change named. It ships NO `netPayable` and no `approved`/`paid` bucket; §J's `NET_PAYABLE − APPROVED` subtractions are the identity at this tree and 5C/Task 6 subtract into the same term. **Unit C MERGED as PR #282 at `main` `d402864` with a fresh clean Codex +1 on the exact head `b108f05` — FIRST head, ZERO findings, the only 5B unit to clear immediately, which is what the split was for. TASK 5B IS COMPLETE AND INDEPENDENTLY CLEARED** across all three units (#280 → #281 → #282). The evidence that the split worked is in the finding counts: the unsplit #279 took six heads and 28 findings without converging; A cleared with none after the split, B took five heads and twelve, C took none. A ships the refusal and B ships the override, so every intermediate state is STRICTER than the finished rule and none permits an act the finished rule would refuse. It ships NO `netPayable`: §G bound 4 defines it as certified less unreleased deductions and the §H ledger is 5C's, so reporting the gross under that name would be an answer rather than a question. Evidence: `docs/reviews/phase-5-t5b-certification-packet.md`; the audit that produced the split is `docs/reviews/pr-279-convergence.md` |
| 5C | §H deduction ledger + releases + the `NET_PAYABLE` floor | **MERGED and INDEPENDENTLY CLEARED** (PR #284, head `bccc458`, merge `main` `6ecf93a`, fresh clean Codex +1 on the exact head). The last increment of Task 5. Ten finding-bearing heads; the arc is recorded in `docs/reviews/pr-284-convergence.md`. **Re-statement was split out at round 5 on JagPat's explicit instruction and RESTORED at round 9 on JagPat's explicit decision** — the plan requires supersession to carry the retained balance (`2026-07-29-phase-5-commercial-control.md:746-771`), and the refusal that stood in between forced either blocking a valid correction or writing an append-only release asserting money came back when it had not, which is false evidence in an immutable ledger. The two defects that caused the split are FIXED, not re-inherited: the replacement seal requires the carried RELEASES as well as the deduction, and the terms check compares the COMPLETE field list under **CLOSURE 5**, now executable — a test enumerates both tables' real columns from `information_schema` so a column added later fails rather than escaping the copy. Round 10 named **root D — a seal that judges a copy as though it were an original**: carried rows contribute their NET as an opening balance and the running peak is folded only over events the certificate originated, so a carried ledger is a BALANCE brought forward rather than a history replayed, while the round-8 over-withholding attack (rows new here) still peaks and a carried balance above what the replacement certifies is still refused. Provenance admits a restatement chain by INDUCTION. Also carried: the §H two bounds, the first REAL subtraction into §J's `certified-payable`, ledger-actor binding, and the round-9 ordering seal (a release may not predate the withholding it discharges — an ordering that trusts caller-supplied columns is not an ordering). Gates: `pnpm check` EXIT 0; 5C suite 29/29; full integration **924/924** across 81 files; `upgrade-proof.sh` PASSED with **429 assertions, 0 failures**. **The plan's post-Task-5 STOP NOW APPLIES — payment authority is fully in place and Task 6 does not begin until that review stop is satisfied.** |
| 6 | Payment approval + payment records + reversals + §F derivation + bounds 4–5 + approval limits | **SPLIT into 6A/6B/6C BEFORE implementation.** Measured before any code was written, Task 6 is four architectural concerns — the §F derivation over three folds, payment authority, payment records and reversals, and `advance-recovery` with its paid-advance fact — and larger than Task 5C, which reached ten finding-bearing heads against a limit of five. JagPat approved the split ahead of the damage rather than after it |
| 6A | `PaymentApproval` + `Payment` + certifier-vs-approver SoD + cumulative approval limits + §G bounds 4–5 | merged — PR #286 at `main` `3a6d7be` with a fresh clean Codex +1 on the exact head `bb95f91` through the `codex-current-head` gate, after three finding-bearing heads and nineteen findings, every one fixed forward with a reproduce-first RED→GREEN probe. The trend is the evidence the pre-emptive split worked: findings 9 → 6 → 4 → **0**, P1s 3 → 4 → **0**. It ships NO §F derivation — §F reads three folds and 6A creates only two of them, so the stored status stays `certified`, an intermediate state that is strictly STRICTER than the finished rule. Evidence: `docs/reviews/pr-286-convergence.md` |
| 6B | §F status derivation over three folds + payment reversals | in_progress — **unit 1 (`CLOSURE 10`) is MERGED and INDEPENDENTLY CLEARED** (PR #287 at `main` `4704c57`, fresh clean Codex +1 on the exact head `fcfc4ad`), shipped AHEAD of the substance it polices because a closure that lands beside its own work cannot have caught anything in that work. Six finding-bearing heads, eighteen findings, every one correct and every one the SAME root reaching somewhere the previous fix had not: the closure asserted a PROXY for the invariant instead of the invariant. First migration text as a proxy for what PostgreSQL enforces — unanswerable in principle, since 41 of the 80 migrations wrap DDL in conditional `DO $$ BEGIN` blocks — so the database half moved to the live catalog (`pg_constraint`/`pg_trigger`/`pg_proc`, the cleared `labour/t3c` idiom) while the source half stayed at the desk. Then a NAME as a proxy for identity (`conname` without `conrelid`, `proname` without `tgfoid`); PRESENCE as a proxy for enforcement (a seal counted by name while every trigger that runs it was dropped); a MENTION as a proxy for a rule (a CHECK naming both targets while admitting both at once); and finally the probes themselves asserting CATALOG STATE rather than running the closure, so deleting a closure assertion left its "RED probe" green. Every predicate is now a collector the probes execute, XOR cases derive over the target family, and firing shape includes `tgattr`/`tgqual`. The audit `docs/reviews/pr-287-convergence.md` records the two lessons: a closure must be built on the substrate that OWNS the fact it asserts, and — the one that generalises — **fix the class, not the member**; every round that ended cleanly applied the correction to the whole set the finding was drawn from, and every round that recurred is one where the previous fix stopped at the instance named. **The SUBSTANCE is now split in two: unit 6B-i (the §F derivation, DELIVERED on draft PR #289) and unit 6B-ii (payment reversals, not started)** |
| 6B-i | §F derivation over the three folds, wired into every EXISTING fold-mover | **DELIVERED, in_review** on draft PR #289 from `main` `5b8186a` (branch `claude/phase5-task6b-i`), 13 files / ~1,040 changed lines. `commercial-status.ts` holds §F's first-match truth table as ONE pure function (`derivedBillStatus`) plus the derived FAMILY and `isDerivedBillStatus`; `CommercialStatusService.reDerive` reads the three folds and CASes the bill under the lock every mover already takes; all six writers of the three folds call it — `payment.approve`, `payment.record`, `deduction.record`, `deductions.release`, `certificate.certify`, `certificate.supersede`. **No new fact and no new table:** all three folds existed (`NET_PAYABLE` from 5C, `APPROVED`/`PAID` from 6A), and each now has ONE definition in `commercial-deduction.query.ts` — `CommercialPaymentService`'s private `approvedTotal`/`paidTotal` are deleted and routed there. Migration `20270610000000` adds no table and no column: three guards spelled "past certification" as `= 'certified'`, exact only while `certified` was terminal, and they are widened TOGETHER against one shared SQL predicate mirroring `isDerivedBillStatus` — so the DATABASE guards the FAMILY (nothing escapes forward except supersession, nothing enters except `verified → certified`) and the DERIVATION owns which member. **THE DERIVATION IS NOT MONOTONIC, AND `reDerive` HAS NO FORWARD-ONLY GUARD.** An earlier revision of this row justified the split by claiming no status can move backwards without reversals — FALSE, and contradicted by `commercial-status.ts` in the same branch: a release RAISES `NET_PAYABLE`, so `paid → certified` is required, and PROBE 6 pins exactly that round trip. Also corrected in-branch: this task first added a service-level refusal for superseding a paid certificate, claiming the case was "reachable before this task and unguarded" — 6A's PROBE 11 proves the §G bound-5 constraint trigger `BillCertificate_paid_bound_sealed` ALREADY refuses it at commit, so the second copy of the rule was removed and PROBE 13 asserts the existing seal's own message instead. **Reproduce-first:** the base tree at `5b8186a` with the pure specification and the fold reader copied in but the six movers and the migration ABSENT is RED on 13 probes across four suites (10/13 of the new suite, plus the pins 5C PROBE 4, 6A PROBE 9 and 5B R1-F2 that each said in their own comment that Task 6 would change them); all 13 GREEN here. **Codex round 1 returned FOUR findings on head `392b46f`, all correct, and two of them the SAME ROOT reaching opposite sides — the database guarded family MEMBERSHIP and left the MEMBER to the service.** One raw `UPDATE "VendorBill" SET status='paid'` on a bill with `APPROVED = PAID = 0` passed membership and committed (F1), and the gap's other mouth let a direct writer append a VALID `PaymentApproval` and simply not move the status (F4). The migration comment that justified the first head is REPLACED rather than patched: it argued that putting §F's arrows in SQL would create a second copy of the truth table free to disagree, but the choice was never one copy or two — `phase5_t6b_derived_bill_status` was ALREADY a second copy of the family. The choice was which question the database may answer, and answering only the coarse one left the fine one enforced nowhere. The correction puts the truth table in SQL (`phase5_t6b_derive_bill_status`, mirroring `derivedBillStatus` arm for arm) behind a coherence seal fired at COMMIT from FIVE tables — `VendorBill` and every table that can falsify the equation — plus an idempotent BACKFILL (F2: 6A legitimately stored `certified` on already-paid bills and its own PROBE 9 pinned that, so without the backfill the next honest write to such a bill would be refused for a state it did not create) and a repeatable-read snapshot on the payments ledger (F3), matching what the deduction ledger has done since 5C. **One probe was replaced for proving nothing:** R1-F3's first draft read the ledger 25× with no concurrent writer and asserted internal consistency, which passed at the reviewed head too — a serial read has no seam to straddle. It is now a deterministic two-session barrier (`ACCESS EXCLUSIVE` on `PaymentApproval`, the reader confirmed BLOCKED via `pg_stat_activity`, then the writer commits) that returns `billStatus=certified` beside `approved=40.00` at `392b46f`. The seal also broke SEVEN pre-existing upgrade-proof fixture writes, which is the seal working — those appended a fold without moving the status, and `UP6A-A-OK` now carries its status move in the same transaction. **JagPat added ONE adjacent P2 to the same batch, and it is fixed here:** `commercial-status.ts` shipped `DERIVED_BILL_STATUSES`/`isDerivedBillStatus` as a fresh listing of the same four members `packages/shared` already declares as `BILL_STATUSES_PAST_CERTIFICATION`/`isPastCertification` — while claiming one family definition, and while the shared declaration carried a note saying Task 6 would need it. The failure is silent in BOTH directions and is not a type error (a fifth member added to the shared set becomes supersedable and read-visible while `reDerive` skips it; one added only locally is derived while the shared guards reject it), so the two are now the SAME array, pinned by IDENTITY in `commercial.contract.test.ts` — `toBe`, not `toEqual`, so a same-members copy still fails, verified by mutation — with the predicates checked to agree across the whole `VENDOR_BILL_STATUSES` vocabulary. **A lock-order inversion was caught by 5C's own PROBE 14 within the hour:** the first draft of the coherence check took a plain `FOR UPDATE` on the bill, and because that check runs at COMMIT — after the statement-time locks other seals take — it acquired the bill LAST, inverting §0b's bill-first total order, and two concurrent releases deadlocked. It now takes the lock `NOWAIT`: every honest mover already holds the bill row (`lockBill` is the first thing each of the six does) so re-acquisition is free for them, and a writer that did not take it first is REFUSED rather than allowed to wait in the wrong order — serialization by refusal, which never admits an incoherent pair and never deadlocks. **The seal broke TEN pre-existing fixtures (seven `upgrade-proof.sh` assertions and three 5C probes) and that is the seal working:** every one is a raw write that moves a fold and leaves the status behind, which is exactly what F4 asked to be refused, and no rule under test changed (PROBE 14 certifies ₹200 so its ₹60 release never moves the derived status, leaving the RELEASE BOUND as the only thing that can refuse the second writer; PROBES 22/25 carry the status their fold move implies, 25 through the migration's own backfill expression so it stays correct for the legs it expects to be refused; `UP6A-A-OK` carries its status move in the same transaction). **JagPat then found ONE adjacent P1 in the correction's OWN mover sweep, and it is the third time in this unit that a fix stopped one member short of its set:** the F4 fix claimed to seal "every table that can falsify the equation" and then enumerated the four ledger tables plus the bill, leaving out `BillCertificate` — which is a fold INPUT twice over (`certifiedAmount` feeds `NET_PAYABLE`; `supersededAt IS NULL` decides which approvals are in `APPROVED` at all), and whose `certify`/`supersede` are TWO of the unit's six declared movers. The bypass is ONE otherwise-valid raw transaction: from `approved-for-payment` with a live C1 carrying an approval and no cash, supersede C1 and insert its coherent replacement C2 over the same version and evidence, touching nothing else — the approval leaves live `APPROVED`, the folds derive `certified`, the Task-5B projection seal is satisfied (still exactly one live certificate beside an in-family status), and no ledger row or bill row was written so none of the five triggers fired. `BillCertificate` now carries the same deferred constraint trigger through the same generic resolver, inheriting the `NOWAIT` bill-first behaviour unchanged, and the reproduce-first `R1-F5` probe is RED both at `392b46f` AND at the five-trigger head (the raw replacement simply commits) and GREEN only with the certificate sealed — paired with the same replacement carrying its derived status, which is ACCEPTED. **The lesson is worth naming rather than filing: enumerating the members is what keeps failing here; deriving them from what the fold READS is what works, and it is what `FOLD_INPUTS` already does for §B.** **JagPat then found a SECOND adjacent P1, in the UPGRADE PATH, and it makes this correction's own claim false as it stood — "the backfill is what makes the seal installable" treats the backfill and the seal as if they were one moment, and they are two.** `docs/DEPLOY.md` says the previous production container keeps serving until the new deploy succeeds, so between those two moments the OLD `commercial.payment.approve` can lock an already-coherent `certified` bill, append a valid `PaymentApproval` and commit with the status unmoved — which was CORRECT under 6A. A constraint trigger does not validate rows written before it existed, so that bill is left PERMANENTLY stored `certified` while its folds derive `approved-for-payment`, with no future write required to expose it and none able to repair it. The migration now opens with `LOCK TABLE "VendorBill" IN EXCLUSIVE MODE`, held through the backfill AND all six trigger installs AND the commit, so the whole upgrade is ONE serialized cutover: every §F mover begins at `lockBill` (§0b bill-first) which takes `ROW SHARE`, and `EXCLUSIVE` conflicts with it, so an old-version mover that has not started blocks and one in flight is waited for. It is deliberately NOT `ACCESS EXCLUSIVE` — plain reads keep working, which is the difference between a deploy and an outage — and the bill is taken FIRST so the `CREATE TRIGGER` statements on the other five tables cannot invert the order this correction already had to fix once. The dependency on Prisma running a migration in one transaction FAILS CLOSED: `LOCK TABLE` outside a transaction block is a PostgreSQL error, so a runner that stopped wrapping migrations would abort the deploy loudly rather than silently reopen the window. **The first draft of the barrier was the WRONG LOCK** — `SHARE ROW EXCLUSIVE`, which conflicts with `ROW EXCLUSIVE` but NOT with `ROW SHARE`, so it would have let every `SELECT … FOR UPDATE` straight through and closed nothing — and `R1-F6`'s behavioural half caught it, which is exactly why that half exists separately from the half that only reads the migration text: a barrier can be present, in the right place, and still be the wrong lock. `R1-F6` is two claims proven separately: the barrier is IN the migration and precedes both the backfill and the first trigger install (RED when the line is removed), and it actually excludes the old movers (a second session's `SELECT … FOR UPDATE` is confirmed BLOCKED via `pg_stat_activity`, condition-based and never a sleep, with the bill untouched while it waits). Gates: `pnpm check` EXIT 0 (web 543/543, API 747/747); 6B suite 19/19; full integration 84 files / 986 tests on a pristine migrated DB; `upgrade-proof.sh` PASSED with 470 assertions. Evidence: `docs/reviews/phase-5-t6b-i-status-derivation-packet.md` |
| 6B-ii | Payment reversals | **APPROVED SPLIT, not_started.** The append-only `PaymentReversal` fact (strictly positive, provenance-bound, append-only trigger), the bound `Σ reversals ≤ Σ payments`, `payments.reverse` under the bill lock RE-USING 6B-i's derivation as a CAS transition, and the concurrency the plan names (concurrent reversals over-release `PAID` by the same shape two concurrent payments break bound 5). **The reversal term of `PAID` ships HERE, with the table it reads** — an earlier revision of this row claimed 6B-i would write the subtraction at zero rows, which is incoherent: 6B-i has no `PaymentReversal` table, so the term would either reference schema that does not exist or force the fact into the unit whose whole premise is that it adds no new one. So 6B-i's `paidFor` is `Σ Payment` exactly, and 6B-ii widens it to `Σ Payment − Σ PaymentReversal` **together with** its own §F probes for a falling `PAID`. Estimated ~800–1,000 lines |
| 6C | `advance-recovery` shipped WITH the paid-advance row that caps it | not_started |
| 7 | Cash forecast (§J) + frontend (§M) + pilot chain + consolidated packet | not_started — **FINAL STOP** |

## Phase 4 — labour readiness

Task numbering and definitions come from the "Required Execution Order and
Review Stops" section of the phase plan.

| Task | Summary | State |
|---|---|---|
| 1 | Labour capability + type-routed demand + trusted workforce identity (§B/§D/§H) | merged |
| 2 | Supplier reuse + labour commitment documents (§F) | merged |
| 3 | Time-capacity conservation — commitment, allocation, attendance, actual-work facts (§C) | merged — correction round 3 merged as PR #230 (`main` `33d37a3`) through the exact-head `codex-current-head` gate; evidence `docs/reviews/phase-4-t3-correction3-packet.md` |
| 4 | Canonical labour coverage + Team gate + combined readiness + seventh projection + LEAF module graph (§A/§G) | merged — PR #242 merged at `main` `861b622` after two Codex correction rounds and a fresh clean +1 through the exact-head `codex-current-head` gate; evidence `docs/reviews/phase-4-t4-readiness-packet.md` |
| 5 | Daily-Log reconciliation (§E) + planned-vs-actual + productivity (§I) | merged — PR #245 merged at `main` `d8a9c50` with a fresh clean Codex +1 on the exact head `119816b` through the `codex-current-head` gate (twelve findings across three in-branch Codex rounds all fixed with reproduce-first probes); evidence `docs/reviews/phase-4-t5-reconciliation-packet.md` |
| 6 | Frontend surfaces + pilot acceptance chain + consolidated Phase-4 packet (§J) | merged — PR #246 merged at `main` `67e7a00` with a fresh clean Codex +1 on the exact head `f098be7` through the `codex-current-head` gate (fifteen correction rounds, 46 findings, all reproduce-first; convergence audit `docs/reviews/pr-246-convergence.md`); evidence `docs/reviews/phase-4-t6-frontend-packet.md` + `docs/reviews/phase-4-consolidated-review-packet.md`. **Phase 4 complete.** |

## State values

- `not_started` — no branch, no PR
- `correction_required` — a reviewed merge has a validated defect; launch the
  named `blocking_directive` before any later task
- `in_progress` — branch exists, PR open as a draft, still being built
- `in_review` — PR open as a draft, waiting on a Codex review or on a fix for
  review findings
- `ready` — PR marked ready for review; the merge is queued behind CI
- `merged` — squash-merged to `main` and deployed

## Maintenance queue

The standing work source whenever no phase task, no correction directive,
and no open PR is active — the runner is never without a machine-actionable
item. Queue items are already-authorized upkeep of delivered scope (never
new product scope), and each rides the same draft → CI → exact-head Codex
gate as feature work. Work them top-down, one focused PR per item:

1. `lifecycle-rule-unit-2` — the five-head restructure rule currently
   REPORTS a crossing (PR #265) but does not act on one. Unit 2 adds the
   apparatus that must exist before it may block without stalling the loop:
   an attributable declaration channel, a reply window, a durable request
   record, an expiry sweep, and a recovery path. PR #264 attempted this
   together with the wiring and took twelve review rounds without
   converging; its 34 findings are preserved as prior art in
   `docs/reviews/lifecycle-rule-split.md`, including the two unresolved P1s
   that must be designed in from the start. **Not scheduled ahead of Phase 5
   — the owner decides the order.**
2. `dependabot-security-updates` — GitHub reports open vulnerability alerts
   on the default branch (5 as of 2026-07-29: 3 high, 1 moderate, 1 low).
   Raise the affected dependencies with the full gate battery; one PR per
   coherent dependency group.
3. `upgrade-proof-evidence-audit` — PR #284 found that five of its own
   upgrade-proof "hostile insert rejected" assertions referenced a certificate
   the script never creates, so each was rejected by a FOREIGN KEY before
   reaching the CHECK it named: they would have passed with every constraint
   dropped. The owner asked for the same audit across ALL phases. The mechanical
   rule is that every hostile-insert group must ACCEPT a coherent row first, in
   the same fixture state — a rejection is evidence only when an
   otherwise-identical case is accepted. Sweep `apps/api/scripts/upgrade-proof.sh`
   back through Phases 1–4 for assertions whose fixture rows do not exist, or
   whose target is in a state that makes a different rule fire. One PR.
4. `e2e-flake-burndown` — the documented flake families the review packets
   record honestly (`daily-log-lost-response` visibility, the
   timing-sensitive `pillar-chain` inspection steps,
   `inspections-module-query`, `project-scope` browser history). Convert
   each to a deterministic wait — reproduce-first, one family per PR.

## Rules for the runner

- Work one task at a time. A correction keeps its parent task open. Do not open a
  PR for task N+1 while task N is not `merged`.
- **Open every PR as a draft with Claude Code web Auto-fix enabled.** The trusted
  GitHub workflow marks an exact CI-green head ready to trigger Codex. A finding
  returns it to draft; only the required exact-SHA `codex-current-head` status may
  queue auto-merge. A human ready/merge action is not review clearance.
- After a clean-reviewed merge: set that task to `merged`, set the next task to
  `in_progress`, update `open_pr` and `updated`. If post-merge review finds a
  defect, return the parent task to `in_progress` and name its blocking directive.
- When every task in a phase is `merged`, move to the next phase's plan and
  start at its task 1 — beginning with the phase's planning item
  (`next_task`) when that plan does not yet exist. Between work items the
  **Maintenance queue** keeps the loop live; it never idles.
- Update this file in the same PR as the work it describes, so state and code
  never disagree on `main`.
- The Now block must always leave the runner a move. That is enforced, not
  merely asked for: `scripts/autonomous-status-state.mjs` decides the next step
  from the Now block and `scripts/autonomous-status-state.test.mjs` runs it
  against this file on every CI run. These states fail the build:
  - nothing to start at all — no directive, no open PR, no task in flight, no
    `work_item`, no `next_task`, and an empty Maintenance queue;
  - a `blocking_directive` recorded from a state that does not schedule one.
    Exactly two do: `correction_required` (which launches it by definition) and
    `in_progress` (the post-merge fix-forward path in the rule above). From any
    other state a directive parks the loop behind work nothing scheduled;
  - `correction_required` with no directive naming the correction;
  - `in_review` or `ready` while `open_pr` is `none` — both states are defined
    above as PR-bearing, so there is no PR for the runner to shepherd.
