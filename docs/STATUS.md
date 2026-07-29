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
task: 6
task_state: merged
work_item: none
reviewed_merge: 67e7a00
open_pr: none
next_task: phase-5-planning
blocking_directive: phase-5-planning-approval
updated: 2026-07-29
```

**PHASE 4 IS COMPLETE.** Tasks 1–6 are all merged through the exact-head
`codex-current-head` gate with independent Codex clearance. Task 6 — the FINAL
Phase-4 review stop — merged as PR #246 at `main` `67e7a00` with a fresh clean
Codex +1 on the exact head `f098be7`, after fifteen exact-head correction
rounds (46 findings, every one fixed forward with a reproduce-first RED→GREEN
probe and a full gate battery) and the PR-#247-protocol convergence audit
`docs/reviews/pr-246-convergence.md`. Capability-enabled internal (pilot)
projects may use the Labour workflow end to end; non-pilot projects are
unaffected (§D). Phase 5 has NOT begun. Its planning is the recorded
`next_task`, gated by the named `blocking_directive:
phase-5-planning-approval` (defined under **Blocking directives** below) —
the machine-actionable form of the project owner's standing phase gate. The
runner does not idle on it: the standing duties continue and the directive
clears only on the owner's explicit approval.

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

## Blocking directives

A `blocking_directive` names the one thing that gates `next_task`. It is
machine-actionable by definition: the runner never idles or polls on a
directive — it continues the standing duties (shepherd every open PR through
the exact-head `codex-current-head` gate, answer post-merge review findings
with focused fix-forward corrections, keep CI and the gate battery green) and
starts `next_task` the moment the directive clears.

- `phase-5-planning-approval` — the project owner's standing phase gate:
  Phase-5 planning starts only on JagPat's explicit GO, the same gate every
  prior phase rode (Phase-4 planning began only after the explicit Phase-4
  approval, and Task-1 implementation only after the explicit implementation
  GO). This is a **scope-authorization** gate, not a review gate: no open PR
  waits on it, and it never substitutes for — or adds to — the exact-head
  review evidence (`AGENTS.md` §Autonomy still holds for every PR). It gates
  only which NEW work the runner may begin. Cleared by: an explicit Phase-5
  approval from the project owner recorded in the session or repository.

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
- When every task in a phase is `merged`, set `next_task` to the next phase's
  planning item and record that phase's approval gate as the named
  `blocking_directive` (see **Blocking directives**). Move to the next phase's
  plan and start at its task 1 only once that directive is cleared; until then
  the loop stays live on the standing duties — it never idles, and it never
  starts unapproved phase work.
- Update this file in the same PR as the work it describes, so state and code
  never disagree on `main`.
