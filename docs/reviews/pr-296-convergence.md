# PR #296 convergence audit — the STATUS handoff, and a field that answers two questions

Two finding-bearing heads (`445f760`, `c24dd7f`) trigger the convergence rule, and
the rule is explicit that the next head must be an architectural audit rather than
another isolated patch. This is that audit — and it is short, because both findings
are one fact.

## Every finding, in one table

| # | Source | Head | P | Finding |
|---|---|---|---|---|
| 1 | Codex | `445f760` | P2 | The merged handoff recorded `open_pr: 296`; `assessRunnerState` consults `open_pr` BEFORE `next_task`, so after the flip merged the runner would resolve to the docs PR that just finished |
| 2 | Codex | `c24dd7f` | P2 | The round-1 fix closed the resolver and never reached the path that actually runs: `buildPostMergeContinuation` drift-corrects `open_pr: none` BACK to that PR, prints `pr:296` as the next step, labels the correct `next_task` "STALE — do not act on it", and says to shepherd it |
| — | bot | `ef8eb8c` | — | The drift shepherd fired telling me to set `open_pr: 296` — the state finding 1 had just condemned |
| — | self | in-branch | — | The first spelling of finding 2's probe asserted `/Runner next step:\s*`pr:296`/`, which cannot match the rendered `**Runner next step:** …` — a "must not appear" assertion that could never have appeared |

## The root — one field answering two questions

`docs/STATUS.md`'s `open_pr` means **"which PR is this task's work item"**. Three
places in the automation read it as **"is there a live autonomous PR"**:

- `assessRunnerState` returns `pr:<n>` before it reaches `merged → work_item →
  next_task`;
- `detectStatusDrift` reports drift whenever `open_pr: none` and any autonomous PR
  is open;
- `shouldShepherdOpenPullRequests` says "shepherd it instead of opening a competing
  branch" whenever the open list is non-empty.

For a **task PR** the two readings coincide, which is why this held for the
repository's whole history. They come apart for exactly one shape: the
**STATUS-only handoff flip** — a PR whose entire content is recording that the
previous unit merged and naming the next one. It is open, and it is nobody's work
item.

All three manifestations follow. Recording `open_pr` points the runner at a merged
PR (finding 1); leaving it `none` makes the shepherd demand the state that causes
finding 1 (the bot comment); and the post-merge continuation drift-*corrects*
`none` back to the PR anyway, so fixing the resolver alone changes nothing that
runs (finding 2).

**The fix is to teach the automation the distinction, not to keep choosing a side.**
`isHandoffOnlyHead` is a SELF-DESCRIBING predicate: a PR head whose own Now block
says `task_state: merged`, names no `work_item`, and records `open_pr: none` is
announcing that it is a handoff. No new field and no new convention — all three
already have to be correct for the runner to function, so nothing new can drift.
`workItemPullRequests` drops those PRs, and the drift decision and the shepherd
instruction are both computed from that set.

Two deliberate asymmetries:

- **Unknown counts as a work item.** A head whose STATUS is unreadable
  (`now: null`) is NOT handoff-only, so a parse failure can never silence the
  shepherd. The conservative direction is the one that keeps a real open PR visible.
- **The displayed list is not filtered.** The continuation still prints every open
  PR, because a reader being told a PR exists is different from the runner being
  told to work it. Hiding it would be its own kind of lie.

## Where round 1 went wrong, and it is a repeat

Round 1 fixed `assessRunnerState` and added a mechanical guard for it — and both
were correct as far as they went. What they did not do is ask **which code actually
runs after a merge.** The resolver is a pure function the handoff *consults*; the
handoff then overrides its answer with a drift correction. Closing the pure function
and declaring the path closed is the same shape as this phase's earlier probe
failures: *asserting the mechanism you were thinking about rather than the one that
executes.*

`pr-295-convergence.md` recorded that shape three times (a barrier satisfied by a
foreign key, one satisfied by a service's own lock, one satisfied by a diagnosis
that ran first). This is its fourth appearance and its first outside a database
probe, which is the useful part: the rule is not about locks. **A guard is evidence
only when it is placed on the path that runs.**

The tests in this head are placed accordingly — on `buildPostMergeContinuation` and
`buildDriftHandoff`, the two real entry points — and every behavioural assertion was
run against the pre-fix module first:

```
RED post-merge  next_task present : false
RED post-merge  pr:296 present    : true
RED post-merge  shepherd present  : true
RED post-merge  STALE label       : true
RED drift shepherd is null        : false
```

## A probe that could not have failed

Finding 2's first probe asserted `doesNotMatch(/Runner next step:\s*`pr:296`/)`.
The continuation renders `**Runner next step:** \`pr:296\``, so that pattern never
matches anything — the assertion was green against the defect it was written to
forbid, and its sibling `match(...)` failing is the only reason it was caught.

This is `pr-295-convergence.md`'s **Root C** — an artefact that claims more than it
does — reappearing in a negative assertion, where it is harder to see: a
`doesNotMatch` that cannot match is indistinguishable from a `doesNotMatch` that
passes honestly. The rule this leaves: **a negative assertion needs a positive twin
over the same text**, so that a pattern which matches nothing is caught by the twin.
Both probes here have one.

## What carries forward

1. **A guard belongs on the path that runs.** A pure function the caller overrides
   is not the path. Fourth occurrence this phase; first one that is not a lock.
2. **A negative assertion is worthless without a positive twin over the same text.**
   `doesNotMatch` on an impossible pattern is green forever.
3. **When one field answers two questions, split the question, not the callers.**
   The three readings of `open_pr` were each locally reasonable; the repair is one
   derived predicate the three of them share.
