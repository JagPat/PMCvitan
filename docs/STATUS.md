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
task: 5
task_state: in_progress
work_item: phase-5-task-5c
reviewed_merge: 0b87d85
open_pr: 283
next_task: phase-5-task-6
blocking_directive: none
updated: 2026-08-04
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
| 5C | §H deduction ledger + releases + the `NET_PAYABLE` floor | in_progress — the last increment of Task 5. §H travels VERBATIM from `claude/phase5-planning` `a4d469b`. It supplies the first REAL subtraction into the term unit C shipped: `certified-payable` is already defined as `NET_PAYABLE − APPROVED`, so deductions must subtract INTO that fold rather than add a parallel bucket. **The plan's post-Task-5 STOP applies when this merges**, with payment authority fully in place |
| 6 | Payment approval + payment records + reversals + bounds 4–5 + approval limits | not_started |
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
3. `e2e-flake-burndown` — the documented flake families the review packets
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
