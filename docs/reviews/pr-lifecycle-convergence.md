# Review lifecycle: `restructure_required`

## Why this exists

The convergence protocol stops ordinary patching after two finding-bearing heads
and demands one batched architectural audit. That is the right move once. It is
not a fixed point, and PR #257 proved it:

| Head | Findings | What the correction did |
| --- | --- | --- |
| `c7913a9` | 4 | patched the coverage watermarks |
| `596fa99` | 4 | patched them again, plus the plan-stat path |
| `e9feaf7` | 2 | scoped battery inference to the current attempt |
| `bd58504` | 2 | keyed the classification cache by base; positive-evidence inference |
| `d5e8f61` | 2 | *(both findings were caused by the previous correction)* |

Five heads, and the last three corrections each introduced the next finding. The
cause was not that the patches were too small. One concept — *evidence must
belong to the current merge result and the current attempt* — lives in six places
(the classification cache, the wait loop, final verification, `gateWatermarks`,
`inferRequiredChecksFromRuns`, `summarizeRequiredChecks`), and each round
corrected two of them. Repeating "batch and audit" cannot converge that, because
the audit keeps being scoped to the sites the last review happened to name.

PR #256 showed the same shape independently: F6 → F8 → F9 → F10, four rounds, each
correction touching one site of a multi-site concept.

The remedy for a unit like that is to re-cut it, not to patch it again.

## What this adds

`scripts/review-lifecycle.mjs` answers one question — has this review unit spent
enough rounds to prove that another correction head is the wrong instrument? Its
only outcomes are "keep reviewing" and "stop; restructure". It never dismisses a
finding and never clears a head.

| State | Enters when | Effect |
| --- | --- | --- |
| `reviewing` | default | ordinary correction heads |
| `convergence_audit` | 2 finding heads | the existing batched-audit obligation, unchanged |
| `restructure_required` | 3 finding heads (docs) / 5 (code) | no further correction head; never publishes success; findings stay open |
| `replacement_reviewing` | body declares `Replaces: #<n>` | fresh history, declared lineage, same limits on its own findings |

The two thresholds differ because the costs differ. A docs-only unit is cheap to
re-cut, and prose that has drawn findings three times is arguing rather than
converging. Ordinary code carries real structural cost, so it gets the longer
leash — but not an unlimited one.

## Design decisions worth stating

**The count is a floor, not a reading.** Findings live on the pull request, so
rewriting the branch does not erase them — but a paginated read, a deleted
comment, or a transient API result can all make the live count look smaller than
it has been. `mergeFindingHeadCount` takes the max of the recorded floor and the
live reading, so neither an accident nor a deliberate history rewrite walks a unit
back below a limit it has crossed. A genuinely fresh unit gets a fresh count by
being a DECLARED replacement — a different pull request, with its own comment and
its own floor.

**An unreadable diff never picks a threshold.** This repository has repeatedly
been bitten by a degraded path silently resolving toward one answer. Two of the
three cases here are decidable without the file list: below the docs limit neither
threshold is crossed, and at or above the code limit both are. Only the band
between them genuinely depends on it, and there the check reports `undecided` and
BLOCKS so the next event re-reads. That is a stop, never a clearance — an
undecided unit cannot merge either.

**Elapsed time is telemetry.** It is recorded beside the count so the cost of a
long review is visible in the same place, and nothing reads it to decide whether a
head may merge. `L11` pins that: thirty days in review, still `allowed: true`,
because only the head count gates. A time-based gate would be a deadline, and a
deadline is exactly the pressure that produces a rushed correction head.

**Restructuring is not dismissal.** `restructure_required` has no branch that
publishes success and no path that resolves a review thread. The instruction it
writes says every open finding stays open and moves with the work.

## Reproduce-first evidence

Every probe fails without `scripts/review-lifecycle.mjs`: the module is new, so
the reproduction of each case is that the repository could not answer the question
at all before it. That is stated plainly rather than dressed up as a behavioural
RED — the same honesty the PR #256 packet applied to its absent-surface findings.

The five cases the directive named, each pinned:

| Case | Probes |
| --- | --- |
| docs threshold | `L1` (2 heads reviews), `L2` (3 heads restructures) |
| code threshold | `L3` (4 heads reviews), `L4` (5 heads restructures), `L4b` (#257's real head SHAs) |
| state persistence across reruns | `L6` (floor survives a smaller live read), `L6c` (max, and malformed records) |
| superseding heads | `L7` (a clean current head does not clear a crossed unit), `L6b` (branch reset) |
| a finding-bearing restructured PR cannot merge | `L9` (never `allowed` at any count past the limit) |

Plus the undecided band (`L5`, `L5b`, `L5c`), replacement lineage (`L8`, `L8b`,
`L8c`), and metrics round-tripping and telemetry (`L10`, `L10b`, `L11`, `L11b`).

`node --test scripts/review-lifecycle.test.mjs` → 20/20.

## Scope

Deliberately narrow, per the directive: this PR does **not** reorder CI relative
to Codex, and does not touch the battery-selection code that #257 is still
correcting. It adds one module, its suite, two call sites in the gate, a metrics
line on the sticky comment, and the two documents.

`docs/STATUS.md` is corrected in the same commit — it recorded `open_pr: none`
while #252 and #257 were open, which the merged runner-continuation shepherd
detected on live state. Riding it along avoids opening a third PR for two lines.

## Validation

| Gate | Result |
| --- | --- |
| `node --test scripts/review-lifecycle.test.mjs` | 20/20 |
| `pnpm test:automation` | 171/171 (the new suite joins the glob) |
| `pnpm check` | EXIT 0 |
| Migrations | none |

## What this does not claim

It does not claim to detect an UNDECLARED replacement — a PR opened with the same
work and no `Replaces:` line starts at zero, and nothing here can prove intent.
What it does is make the declared path the easy one and keep the lineage visible
when it is taken. Detecting laundering by content similarity was considered and
rejected: it would guess, and a gate that guesses is the defect this module exists
to stop.
