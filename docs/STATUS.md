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
task: 2
task_state: in_progress
work_item: phase-5-task-2
reviewed_merge: edb7f08
open_pr: 270
next_task: phase-5-task-3
blocking_directive: none
updated: 2026-08-01
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
| 2 | Versioned immutable `BudgetLine` + `COMMITTED` fold + budget-vs-committed exception (§B) | in_progress — draft PR #270 from `main` `edb7f08`; the budget table, its seals and the `COMMITTED` fold are in, the exception and its probes are not |
| 3 | `Measurement` (§D) + the `revertSignOff` withdrawal guard | not_started — **STOP** |
| 4 | `VendorBill` + immutable versions + lifecycle to `under-verification` + bounds 1–2 + both withdrawal guards | not_started |
| 5 | Three-way verification (§E) + `verified` + dispute + certification + bound 3 + §H + SoD | not_started — **STOP** |
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
