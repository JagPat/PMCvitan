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

The fix (`5e4c766`) is structural, not textual: the plan ships in the same diff as the STATUS that
names it, which the split made possible again (a fresh unit owes no probe deferral, and the deferral
gate was what had forced STATUS and plan apart on #330).

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

## The cumulative rule set this unit now carries

From the parent audit (`pr-330-convergence.md`), still binding: interpret-before-accept;
migration-plus-write-path-rule; trace comparisons, not just writes; discharge risk into code, a
gate, or a merged state — never a person. From this PR's two rounds: a merged state is complete in
its own tree; enumerate readers; validate in both directions; plain before race.

## Status

Both finding heads are corrected in the plan. Nothing is dismissed or deferred; the finding-head
count stands at 2, below the docs-only deferral cap.

Review-Convergence: complete
