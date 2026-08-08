# PR #296 convergence audit — a PR that the state machine has no word for

Two finding-bearing heads triggered the convergence rule; a third head then drew
two more. This is the audit, and it ends with the previous three heads' code being
**deleted** rather than corrected again.

## Every finding, in one table

| # | Source | Head | P | Finding |
|---|---|---|---|---|
| 1 | Codex | `445f760` | P2 | The merged handoff recorded `open_pr: 296`; `assessRunnerState` consults `open_pr` BEFORE `next_task`, so after the flip merged the runner would resolve to the docs PR that just finished |
| 2 | Codex | `c24dd7f` | P2 | The round-1 fix closed the resolver and never reached the path that runs: `buildPostMergeContinuation` drift-corrects `open_pr: none` BACK to that PR, prints `pr:296`, labels the correct `next_task` "STALE — do not act on it", and says to shepherd it |
| 3 | Codex | `948513a` | P2 | `handOffStatusDrift` still picked its comment target from the UNFILTERED open list, so with a handoff PR open beside a real task PR the body says "set `open_pr` to 300" and posts it on 301 |
| 4 | Codex | `948513a` | P2 | `isHandoffOnlyHead` is not evidence that a PR IS the handoff flip — a fresh task branch that has not yet updated its own STATUS carries the identical Now block, so the filter would drop a real work item and tell the runner to open a competing branch |
| — | bot | `ef8eb8c` | — | The drift shepherd fired instructing me to set `open_pr: 296` — the state finding 1 had just condemned |
| — | self | in-branch | — | A `doesNotMatch(/Runner next step:\s*`pr:296`/)` assertion that could never match the rendered `**Runner next step:** …` — green forever against the defect it forbade |
| — | self | in-branch | — | `git stash push <path>` on an already-committed file stashes nothing, so the following `git stash pop` popped an unrelated Task-5 stash into the tree |

## The root — a PR that is open and is nobody's work item

`docs/STATUS.md`'s `open_pr` means **"which PR is this task's work item"**. Three
places read it as **"is there a live autonomous PR"** — `assessRunnerState`,
`detectStatusDrift`, and `shouldShepherdOpenPullRequests`. For a task PR the two
readings coincide, which is why this held for the repository's whole history.

I created a shape where they diverge: a **STATUS-only handoff PR**, whose entire
content is recording that the previous unit merged and naming the next one. It is
open, and it is nobody's work item. Findings 1–4 and the shepherd's contradictory
advice are all that one fact.

Heads 1–3 kept choosing a side of the divergence, then teaching the automation to
tolerate it. Finding 4 is what ends that: **the category cannot be reliably
detected.** A head whose Now block reads `merged` / `work_item: none` /
`open_pr: none` is either a handoff flip *or a fresh task branch that has not yet
updated its own STATUS* — identical evidence, opposite meanings, and getting it
wrong sends the runner to duplicate an open work item.

### The loop never needed this PR shape

Run against `main` exactly as PR #295 left it, with no handoff PR in existence:

```
**Runner next step:** `task:7` — task 7 is in_progress, so it is still the work item
**Open autonomous PRs:** none
**Recorded in STATUS (STALE — do not act on it):** `pr:295`
**STATUS drift:** … Update `open_pr` to `none` … 
Create the next same-repository `claude/**` branch and draft PR with Auto-fix enabled.
**Note:** clear stale `open_pr: 295` in STATUS before starting new work.
```

That is correct in every line. The model the loop already uses is: **a task PR
names itself in `open_pr`, and the NEXT task's PR flips the previous one to
`merged` and names itself.** Between them `main` transiently names a merged PR,
and `assessDriftCorrected` exists precisely to correct that — which is what the
output above is doing.

So the repair is not a fifth mechanism. It is to stop creating the category:

- `scripts/runner-continuation.mjs` and its tests are **reverted to `main`** —
  `isHandoffOnlyHead` and `workItemPullRequests` are deleted. Findings 3 and 4 are
  defects in compensating machinery, and the machinery is gone.
- This PR **no longer touches the Now block at all.** It carries the 7A row's
  truth-correction, the 7B split decision, and one guard. The flip rides the 7B-i
  PR, which names itself, the way every task PR in this loop does.
- The guard from head 1 is **kept**: a live-STATUS assertion that `merged` +
  `work_item: none` + a named `open_pr` cannot land. It is independent of whether
  anyone creates a handoff PR, and it is the durable half of finding 1.

## What went wrong in my reasoning, three times

Each head fixed the thing in front of it and did not ask what shape had produced it.

- **Head 1** fixed the resolver — a pure function the caller *overrides*. A guard
  is evidence only when it is on the path that RUNS. This is the fourth time this
  phase a check has been satisfied by a different mechanism than the one under
  test, and the first outside a database probe, which is the useful part: the rule
  is not about locks.
- **Head 2** queued the shepherd's contradictory advice as a documentation chore.
  It was a live loop-stalling defect wearing a documentation costume.
- **Head 3** taught the automation a new category rather than asking whether the
  category should exist. `pr-295-convergence.md` had just recorded the general
  form of this — *when successive repairs are all of one kind, the declaration
  underneath them is the defect* — and I wrote that sentence two heads before
  needing it.

## A probe that could not have failed

Head 3's first probe asserted `doesNotMatch(/Runner next step:\s*`pr:296`/)`
against text rendering `**Runner next step:** \`pr:296\``. That pattern matches
nothing, so the assertion was green against the exact defect it forbade; only its
sibling `match(...)` failing exposed it.

This is `pr-295-convergence.md`'s **Root C** — an artefact claiming more than it
does — in its most invisible form, because a `doesNotMatch` that *cannot* match is
indistinguishable from one that passes honestly. The rule: **a negative assertion
needs a positive twin over the same text.**

## One process note, recorded because it corrupted a working tree

`git stash push <path>` creates NO stash when the path has no uncommitted changes,
and the following `git stash pop` then pops whatever is at `stash@{0}` — here, an
unrelated Task-5 stash, which landed as seven merge conflicts. The RED verification
it was serving had already produced its evidence, and `git reset --hard HEAD`
restored the tree with the ancient stash intact. **Verify a stash was created
before popping one**, or compare against a committed ref instead.

## What carries forward

1. **A guard belongs on the path that runs.** A pure function the caller overrides
   is not that path.
2. **A negative assertion needs a positive twin over the same text.**
3. **When one field answers two questions, do not teach the readers to cope —
   remove the case that splits them.** Three heads of machinery were protecting a
   PR shape the state machine has no honest vocabulary for, and deleting the shape
   deleted all four findings.
