# PR #325 — convergence audit (the Phase 5 status closure)

Two finding-bearing heads, two findings, **and they are the same mistake twice.**

| # | Head | Finding |
|---|---|---|
| 1 | `a5accc4` | keep Phase 6 on planning until its plan exists |
| 2 | `ecaee18` | keep `phase_plan` pointed at a committed plan |

## The root: a status-only PR tried to carry a forward handoff it could not own

This PR exists because of a rule conflict on PR #324 (see
`docs/reviews/pr-324-convergence.md`, root G): past three finding-bearing heads a docs-only review
owes a `Review-Deferred-To-Probes` trailer, and that trailer is refused from a diff touching
`docs/STATUS.md`. So the STATUS change moved here, and #324's finding 28 required it to be a real
PR rather than a promise.

Having built it for that reason, I then made it do something it had no business doing: **advance the
phase pointer to a plan that only exists once #324 merges.**

- **Round 1** set `next_task: phase-6-task-1` and `phase_plan` to the Phase 6 path. Neither the plan
  nor the task exists in this tree. Finding 1.
- **Round 2** fixed `next_task` to `phase-6-planning` — and left `phase_plan` naming the same absent
  file. `docs/AUTONOMOUS_LOOP.md` reads STATUS *then* `phase_plan`, so the runner stalls on the
  missing file before it ever reads the corrected `next_task`. Finding 2.

Round 2 is the sharper of the two, because it is a **partial fix that reads as complete**: I
corrected the field the finding named and did not re-read the block the field lives in. That is the
same shape as PR #324's root A ("removing a dependency at the layer where you found it is not
removing the dependency"), in a two-line YAML block.

## What was actually true the whole time

`main`'s Now block **already was** the correct handoff for a world with no Phase 6 plan:

```yaml
phase: 5
phase_plan: docs/superpowers/plans/2026-07-29-phase-5-commercial-control.md   # exists
task_state: merged
work_item: none
next_task: phase-6-planning
```

`assessRunnerState` returns `next_task:phase-6-planning` from it unchanged, and STATUS's own runner
rule sanctions exactly that — *begin at the phase's planning item while its plan does not yet exist.*
There was nothing to advance. The Now block is now reverted to `main`'s verbatim and this PR does
only what its title says: closes Phase 5's record.

> **A status file must never name a plan that no commit in its own tree contains.** The phase pointer
> advances in the same change that lands the phase's plan file — not in the change that anticipates
> it.

That rule is the durable output of these two rounds, and it generalises past this PR: any forward
pointer written in advance of the artefact it points at is a stall waiting for a merge order to go
the other way.

## Scope discipline

The one thing this PR does NOT do is carry #324's finding 6 (the merged handoff shape). That finding
was a defect in the Now block *as #324 carried it*; with STATUS out of #324, `main`'s block is
already correct, so there is nothing to fix. Recorded rather than silently dropped, because a
finding that stops applying and a finding that gets ignored look identical in a diff.

## Verification

- `assessRunnerState` on the committed file returns `next_task:phase-6-planning`.
- `phase_plan` resolves to a file **present in this tree** — checked with `fs.existsSync`, which is
  the assertion round 2 was missing.
- `test:automation` 200/200 on every head.
