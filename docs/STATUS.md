# STATUS

Machine-readable state for the autonomous runner. The runner reads this file to
decide what to do next and updates it after each merge. It is also the one place
a human can glance at to see where the loop is.

This file is authoritative for task state. `docs/ROADMAP.md` is historical
narrative and may lag behind reality.

## Now

```yaml
phase: 4
phase_plan: docs/superpowers/plans/2026-07-23-phase-4-labour-readiness.md
task: 3
task_state: in_review
work_item: correction_round_3
reviewed_merge: 2a6112b
open_pr: 230
next_task: 4
blocking_directive: docs/reviews/phase-4-t3-correction3-directive.md
updated: 2026-07-27
```

## Phase 4 — labour readiness

Task numbering and definitions come from the "Required Execution Order and
Review Stops" section of the phase plan.

| Task | Summary | State |
|---|---|---|
| 1 | Labour capability + type-routed demand + trusted workforce identity (§B/§D/§H) | merged |
| 2 | Supplier reuse + labour commitment documents (§F) | merged |
| 3 | Time-capacity conservation — commitment, allocation, attendance, actual-work facts (§C) | in_review — round-3 correction (`docs/reviews/phase-4-t3-correction3-directive.md`) on a held draft PR, fixing forward from the current-head Codex review; evidence in `docs/reviews/phase-4-t3-correction3-packet.md` |
| 4 | Canonical labour coverage + Team gate + combined readiness + seventh projection + LEAF module graph (§A/§G) | not_started |
| 5 | Daily-Log reconciliation (§E) + planned-vs-actual + productivity (§I) | not_started |
| 6 | Frontend surfaces + pilot acceptance chain + consolidated Phase-4 packet (§J) | not_started |

## State values

- `not_started` — no branch, no PR
- `correction_required` — a reviewed merge has a validated defect; launch the
  named `blocking_directive` before any later task
- `in_progress` — branch exists, PR open as a draft, still being built
- `in_review` — PR open as a draft, waiting on a Codex review or on a fix for
  review findings
- `ready` — PR marked ready for review; the merge is queued behind CI
- `merged` — squash-merged to `main` and deployed

## Rules for the runner

- Work one task at a time. A correction keeps its parent task open. Do not open a
  PR for task N+1 while task N is not `merged`.
- **Open every PR as a draft.** Mark it ready only after Codex has reviewed the
  latest commit and no unaddressed findings remain. This is load-bearing: branch
  protection gates on CI only, and Codex publishes no status check and cannot
  approve, so a non-draft PR can merge before Codex has finished reading it. The
  draft flag is the only thing keeping review ahead of merge.
- After a clean-reviewed merge: set that task to `merged`, set the next task to
  `in_progress`, update `open_pr` and `updated`. If post-merge review finds a
  defect, return the parent task to `in_progress` and name its blocking directive.
- When every task in a phase is `merged`, move to the next phase's plan and start
  at its task 1.
- Update this file in the same PR as the work it describes, so state and code
  never disagree on `main`.
