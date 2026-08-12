# PR #331 — convergence audit (nested locations)

Owed at the second finding-bearing head. The count is worth stating precisely, because the first
correction got it wrong: this PR began life as a STATUS-only handoff and was rebranded into the
nested-locations unit when the space work split, and **the finding-head count follows the PR, not
the rebrand**. The round-1 correction claimed "first finding-bearing head; no convergence packet is
owed yet" — that was false the moment it was written, and the gate said so.

| head | role | findings | outcome |
|---|---|---|---|
| `35d9532` | STATUS-only handoff | 1 (P1) | corrected on `5e4c766` |
| `5e4c766` | the split: plan + STATUS in one diff | 4 (P2) | corrected on `0222c8f` |
| `64daa05` | round-1 corrections + this packet | 4 (P2) | corrected on this head |

The parent unit's audit — five rounds, thirteen findings, and the three rules they produced — is
`docs/reviews/pr-330-convergence.md`, carried on this branch unchanged. This packet does not repeat
it; it audits what THIS PR's two rounds share.

## Finding head 1: a reference that resolved only in the future

`35d9532` set `phase_plan: docs/superpowers/plans/2026-08-12-space-model.md` — a file that existed
on the #330 branch but **not in the tree this PR would merge**. The runner's first act after reading
STATUS is opening the named plan; it would have opened nothing.

The instructive part is what this head was *correcting*. It existed because #330's round 4
established that "a STATUS PR will follow immediately" is a promise, not a state transition — so the
handoff was landed first, as its own merged state. And in fixing that, the sibling error was
committed: the merged state was landed, but **incomplete** — it referenced a file only a *different*
unmerged PR would provide. Same family, one level down:

> **A merged state must be complete. Every reference it makes must resolve within the same merged
> tree — not in a sibling PR, not in a branch, not in the future.**

The fix (`5e4c766`) was structural, not textual: the plan shipped in the same diff as the STATUS
that names it, which the split made possible again (a fresh unit owed no probe deferral, and the
deferral gate was what had forced STATUS and plan apart on #330). **That arrangement did not survive
head 3** — the deferral cap re-created the same incompatibility on this PR, and the extraction it
forces, with the reasoning that makes it safe this time, is recorded below.

## Finding head 2: the readers, and the missing half of validation

All four round-1 findings on `5e4c766` are one defect: **§A enumerated the fixed-depth WRITE paths
and never enumerated the fixed-depth READERS.** This is precisely the "one rule stated about one
place" failure the parent audit names — recommitted while carrying that very audit onto this branch.

| finding | the reader (or gap) it names | verified at |
|---|---|---|
| plain create at the cap | no probe existed for the non-race case; today's `create` has no depth logic at all | `nodes.service.ts` |
| element-module acceptance | init could refuse everything asked of it and still be unable to PRODUCE a legal shape | `orgs.service.ts:71,418,490,592` |
| register grouping | `groupBy` is positional — `seg[1]` is "the room", the last segment "the element" | `locationTree.ts:108-118` |
| filing picker | state for exactly `zone`/`room`; three fixed rows; the element row needs a room | `LocationPicker.tsx:43-61` |

Two generalizations, added to the working rules:

- **Enumerate the readers, not only the writers.** A tree the writers permit but the readers
  misrender or cannot navigate is half-shipped. §C now carries that enumeration by name.
- **A validator is proven in both directions.** Refusal probes (P4/P5) show illegal shapes cannot
  enter; only an acceptance probe (P11) shows the legal shapes CAN. The decision made
  element-under-zone legal while the module path made it unrepresentable — every refusal probe would
  have passed anyway.

And one ordering rule the plain-create finding forced: **the plain probe precedes the race probe**
(P10 before P2), because a green race probe over a missing plain check is a green light over a hole.

## Finding head 3: probe validity, and the shapes the probes still missed

Round 2's four findings extend round 1's theme one level deeper — from *which* probes exist to
*whether a probe can prove what it claims*:

- **A red must fail for the RIGHT reason.** P1/P2's fixtures (room under room) are refused by
  `requireParentForKind` at the base commit *before* the unserialized guard is ever reached — a
  base-commit red proves the fixture is illegal, not that the race exists. §D now stages the
  evidence: legalize the edges first, capture the red with serialization still absent, then add the
  serialization. The probes' honest baseline is that intermediate commit, and the plan says so
  instead of letting review discover it.
- **Enumerate the RACES the way §A enumerates the writers.** P2 covered create∥move; the same stale
  snapshot exists for move∥move (P14). A fix could serialize creates and cycles and still leave
  move-side depth checks unserialized.
- **Enumerate the ACCEPTANCES the way round 1 demanded.** P11 mirrored refusals for element-root
  modules only; nested-room modules (P16) are the other legal shape init must be proven to produce.
- **A unit that rewrites a file owns that file's invariants.** `create` refuses publish-under-draft;
  `move` checks nothing — an orphan-producing gap that predates this unit but belongs to it the
  moment it rewrites `move` (P15, and §A gains the rule: a node may not be more visible than its
  parent, on every write path that can change either side).

## The forced extraction: STATUS leaves this PR, and why that is now safe

Three finding-bearing heads on a docs-only diff trip the deferral cap: the next head must carry
`Review-Deferred-To-Probes`. But the deferral gate **unconditionally refuses to verify a phase
reference when the PR itself edits `docs/STATUS.md`** (`review-efficiency.mjs` — the gate runs from
the default branch and reads main's copy, which a STATUS-editing PR is about to replace). So at the
cap, "plan + STATUS in one diff" and "deferral" are mechanically incompatible, and STATUS is
reverted out of this PR — reversing head 2's own fix for head 1.

That reversal is safe now for a reason that was checked, not hoped: **the drift rule guards the
gap.** Main's STATUS has read `task_state: merged / open_pr: none / next_task: phase-6-task-1b` all
day, with live `claude/**` PRs open — and the hourly cron has responded by posting drift shepherds,
not by resuming the paused 6.1b, because live open PRs disagreeing with `open_pr: none` IS the drift
condition. PR #329 (held) stays open through any gap this PR's merge creates, so the same mechanical
guard covers the window until the follow-up STATUS PR lands. That follow-up satisfies head 1's rule
in turn: by the time it merges, the plan it names exists on main, so every reference resolves in the
tree that carries it. The order is forced end to end: **#331 (plan, deferring to `phase-6-task-2`) →
STATUS handoff PR → implementation.**

The deferral names `phase-6-task-2` — verifiable against main's STATUS, whose `next_task` keeps
phase 6 eligible — and §D's sixteen probes are the deferral's ledger: every question these three
rounds opened is either answered in the plan or named as a probe with the unit that must run it.

## The cumulative rule set this unit now carries

From the parent audit (`pr-330-convergence.md`), still binding: interpret-before-accept;
migration-plus-write-path-rule; trace comparisons, not just writes; discharge risk into code, a
gate, or a merged state — never a person. From this PR's two rounds: a merged state is complete in
its own tree; enumerate readers; validate in both directions; plain before race.

## Status

Both finding heads are corrected in the plan. Nothing is dismissed or deferred; the finding-head
count stands at 2, below the docs-only deferral cap.

Review-Convergence: complete
