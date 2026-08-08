# PR #303 convergence audit — fixing the layer I was looking at

Two finding-bearing heads (`790f754`, `bc0d7ca`). **Two findings, both P1**, on a diff whose entire
product surface is one Markdown file. That ratio is the point: neither finding is about the value
in `docs/STATUS.md`. Both are about *where I applied the fix*.

## Every finding, in one table

| # | Head | P | Finding |
|---|---|---|---|
| K1 | `790f754` | P1 | The handoff recorded `open_pr: 303`/`task_state: in_review`, so the post-merge runner would consume that `open_pr` before reaching `next_task` and chase the status PR it had just merged |
| K2 | `bc0d7ca` | P1 | K1's fix pinned `assessRunnerState` — the resolver that CONSUMES the bad value — and left `buildDriftHandoff`, the shepherd that PRODUCED the advice, able to give it again |

## Root J (new) — I fixed the consumer, and the producer was still wrong

Both findings are one shape, one step apart.

**K1.** The hourly drift shepherd posted *"Update `open_pr` to `303`"*. I did. But the shepherd was
the defect: it cannot tell a work-item PR (which the runner must shepherd, and whose number belongs
in `open_pr`) from a STATUS-only handoff PR (which the runner reads only after it merges, at which
point no PR exists). I changed the file the advice pointed at instead of asking whether the advice
was right.

**K2.** Correcting K1, I pinned `assessRunnerState`: with no work item in progress it must resolve
`next_task`, never a `pr:` step. That invariant is true and worth having — and it is the wrong
layer. `assessRunnerState` *consumes* `open_pr`; `buildDriftHandoff` *produces* the instruction to
set it. My regression called the resolver directly, so it went green while the shepherd could
repeat the exact advice that caused K1. Codex's evidence was a demonstration, not an argument: with
this PR's own corrected head in `headStatuses`, `buildDriftHandoff` still emitted
`Update open_pr to 303`.

The mechanism is worth writing down because it is not obvious. `detectStatusDriftAcrossHeads`
already suppresses the shepherd when an open head carries the fix — but a handoff head correctly
records `open_pr: none` **while its own PR is open**, which `detectStatusDrift` cannot help but read
as drift. So the one head carrying the correction was the one head the suppression could not
recognise. The fix is a shared `isHandoffShape` predicate used at both layers: no work item, a
terminal state, `open_pr: none`, a named `next_task`.

**The closure is symmetric, and the symmetry is load-bearing.** Suppressing drift for a handoff head
must not suppress it for a work-item PR whose head still records `open_pr: none` — that is exactly
the defect which failed PR #302's first head, and a fix that silenced both would have traded one
broken loop for another. Both directions are probed.

## Root K (new) — an automated instruction is evidence, not authority

K1 deserves a second entry, because the file is not the whole story.

The commit that introduced it contains the correct analysis in its own message: *"once merged the
accurate value is `none`, and a merged commit's STATUS describes the state after the merge."* I
wrote that, and then set `303`, because the shepherd asked and CLAUDE.md has a rule that reads like
it applies. I let a bot's instruction outrank reasoning I had already done and written down.

The rule it seemed to invoke — *set `open_pr` to that PR number* — governs a **work-item** PR: the
thing the runner must find and shepherd. That scope was implicit, which is what made it easy to
over-apply. It is now explicit in `docs/STATUS.md` beside the `merged` state note, where the next
person meets it before they meet the shepherd.

The general form: **automation reports a symptom from a partial view.** The drift shepherd compares
`main` against live PRs and cannot see intent, diffs, or which PR is a handoff. Its report is a real
signal and its remedy is a guess. Taking the remedy without checking the reasoning is how a
correctly-reasoned change gets talked out of itself.

## What carries forward

1. **Fix the layer that PRODUCED the wrong value, not the one that consumed it.** A probe against
   the consumer goes green while the producer keeps producing. Ask: what emitted this, and would it
   emit it again tomorrow? (Root J.)
2. **A suppression must be probed in both directions.** The case you are silencing and the case you
   must not silence are the same code path; only the second one tells you the predicate is narrow
   enough.
3. **An automated instruction is evidence about state, not a decision about action.** Especially
   when it contradicts reasoning you have already written down — that contradiction is the signal
   to re-derive, not to defer. (Root K.)
4. **A rule with an implicit scope will be over-applied.** "Set `open_pr` to that PR number" was
   true for work-item PRs and silently false for handoff PRs; writing the scope down cost two lines
   and two P1s.
