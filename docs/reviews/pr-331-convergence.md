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
| `64daa05` | round-1 corrections + this packet | 4 (P2) | corrected on `9edac50` |
| `9edac50` | round-2 corrections + the deferral | 5 (P2) | corrected on `0dd736f` |
| `0dd736f` | the pin + STATUS returns; probes closed on their doors | 2 (P2) | corrected on this head |

Round 4's two findings each sharpened a round-3 fix by one honest notch, and both were proven
red-first: **P11 must run through the PUBLIC create-project selector** — `moduleSelectionSchema`
carries only `underZone`, so a service-level graft probe proves a workflow no user can reach, and
the selection contract's room-target field is now named in scope; and **the phase_plan pin now
requires a regular file inside the repository** — a directory that exists (`docs/superpowers/plans`)
stalls the runner exactly like a missing file, and both refusals (directory; a path escaping the
repo) were seen to fail before being trusted.

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

Head 3's packet claimed that reversal was safe because "the drift rule guards the gap" — PR #329
staying open keeps the hourly cron posting drift shepherds instead of resuming the paused 6.1b.
**Round 3 rejected that reasoning, and the rejection is this unit's own rule applied to its own
packet: the safety depended on an EXTERNAL PR happening to stay open — luck, not code, a gate, or a
merged state.** Close or merge #329 and the runner resumes paused work through `next_task`.

### Round 4 dissolves the trap instead of managing the gap

The deferral was owed only because the diff was **docs-only** (`isDocsOnlyDiff` gates
`deferralRequired`). The mechanical closure round 3 demanded is *code* — and landing it in this PR
makes the diff code-bearing, the deferral not owed, and the STATUS-in-diff prohibition moot. So the
final head does all three at once:

- **STATUS returns to this PR** (head 2's arrangement, restored): `phase: 6 / task: 2 /
  task_state: in_progress`, `phase_plan` naming the plan in this same diff. No follow-up PR, no
  gap, no reliance on #329.
- **The new CI pin makes head 1's defect unrepresentable**:
  `autonomous-status-state.test.mjs` now asserts the live STATUS's `phase_plan` resolves to a file
  in the tree. Proven red-first against head 1's EXACT shape — pointing `phase_plan` back at the
  space-model path fails the pin with the stall explanation; restored, it passes. A rule learned
  twice on this PR (once as a promised follow-up, once as a sibling-branch file) is now enforced by
  CI on every future head of every future PR, which is what "discharge risk into a gate" means.
- **The `Review-Deferred-To-Probes` trailer is dropped** — with code in the diff no deferral is
  owed, and a trailer claiming a handoff that is not happening would be the bare marker wearing a
  task name. §D's sixteen probes remain the implementation's ledger on their own terms.

The circularity of heads 1–3 — STATUS-first dangles the plan; plan-first misdirects the runner;
together they void the deferral — was real, but only within the assumption that this PR stays
docs-only. The assumption was the trap.

## Finding head 4: probes must close the door they name, not a nearby one

Round 3's other four findings are each a probe that proved *adjacent* to its claim, and they close
the same way:

| probe | the gap round 3 named | now |
|---|---|---|
| P9 | "creates a nested location" — one child action passes while the dialog still cannot build both new shapes | both shapes named explicitly |
| P11 | zone-anchored acceptance only — a fix remapping every element module to zone anchors passes while breaking every saved door/fixture module | both anchors probed: the new zone-level shape works AND the existing room-level shape survives |
| P12 | presence cases only — a zone-filed decision still shows as a Room group, a room-filed one as an Object group | absence cases added for both groupings |
| P13 | select only — a seeded tree renders while inline-create still stops at three levels, blocking every filing flow from the new shapes | select AND create, both shapes |

The generalization, for the implementation rounds: **a probe is specified by the failure it must
make impossible, not by the feature it exercises.** Each of these four passed a plausible
implementation that still contained the failure.

## The cumulative rule set this unit now carries

From the parent audit (`pr-330-convergence.md`), still binding: interpret-before-accept;
migration-plus-write-path-rule; trace comparisons, not just writes; discharge risk into code, a
gate, or a merged state — never a person. From this PR's two rounds: a merged state is complete in
its own tree; enumerate readers; validate in both directions; plain before race.

## Status

Both finding heads are corrected in the plan. Nothing is dismissed or deferred; the finding-head
count stands at 2, below the docs-only deferral cap.

Review-Convergence: complete
