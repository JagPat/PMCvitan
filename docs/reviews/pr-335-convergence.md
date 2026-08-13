# PR #335 — convergence audit (the phase-6-task-4 decision-workflow plan)

Owed at the second finding-bearing head. Docs-only diff: the 3-finding-head plan
review cap applies, and this PR touches `docs/STATUS.md`, so a
`Review-Deferred-To-Probes` head would first have to revert the STATUS edit (the
escape the plan's §F pre-declares). This head is **finding head 2 of 3**.

| head | role | findings | outcome |
|---|---|---|---|
| `45cecf2` | the plan + the flip to `task: 4 / in_progress` | 13 (6 P1, 7 P2) | corrected on `6229248` |
| `6229248` | round-1 batch + a 3-site same-class sweep | 10 (2 P1, 8 P2) | corrected on this head |

## Round 1 — the design was checked against itself, not against the code it lands in

Thirteen findings, and the pattern is uniform: each one is a place where the
plan stated a sound invariant and the EXISTING code's concrete mechanics defeat
it as stated.

- The withdrawal notice leaked because the snapshot's stripping recognizes ONE
  text shape (`isPendingDecisionNotice`) — the design said "append the truth",
  the code delivers appended text to everyone.
- "Options min(0)" was legal at the contract while `create` still derives
  `photoSwatch` from `options[0]` — schema green, product path throws.
- "Push only the decider" was impossible on a push spine that persists ROLE
  audiences and links no user.
- The architect DECIDER value was schedulable two units before the architect
  ROLE could authenticate.
- "The switch is architect presence" ignored that `Membership` soft-removes.
- The composite membership FK had no candidate key to land on.
- The `pending`-proves-never-approved proof collided with a countersign flow
  that had no state to live in.
- The forward-vs-approve interleaving, the `recorded` terminal seal, the exact
  `btrim` whitespace set, the orgs participant edge left conditional, and an
  API/web split that the SHARED enum makes impossible — same class throughout.

The correction batched all thirteen, and the self-review then swept the CLASS
the staging findings exemplified (an authority named before its role exists)
rather than only the two named instances — two further sites (§C's requester
set, §B.3's decider aside) carried it and were fixed unprompted, which is the
pr-334 round-4 lesson (gate the class, not the instance) applied at authoring
time.

## Round 2 — the machinery the plan BORROWS has contracts of its own

Ten findings on the corrected head, and the class shifts one level: round 1 was
"the new value versus the existing readers"; round 2 is "the reused machinery
versus its own obligations".

- **`change` is not just a status — it is a status backed by exactly one open
  `ChangeRequest`** (`approve()` rolls back otherwise; the serializer renders
  the reason from that row). Reject-back landing in `change` without creating
  the request would render nothing and make re-approval impossible. Both
  disagreement outcomes now create the open request in-tx, and P33 drives both
  paths end-to-end through re-approval and countersign.
- **Forward-on had no defined completion.** `awaiting_countersign` is the
  architect's action item; re-pointing the holder while keeping that status
  hands the new decider a decision they cannot act on. Both disagreement
  outcomes now share one shape (`change` + open request + the holder rule).
- **The presence switch has WRITERS.** `MembersService.updateRole` mutates the
  role lock-free, so the switch could flip between an approve's read and its
  commit. The switch's writers now take the same readiness lock, with a
  both-directions barrier probe (P36).
- **A terminal status is not frozen evidence.** The seal refused transitions
  out of `withdrawn` while leaving `withdrawnById`/`withdrawReason` rewritable
  under it. Write-once now means the columns (P8).
- **A record's publish still ran the pending machinery** — the "awaiting
  approval" notice and the pending push fired for a decision nobody can
  approve; the none-decider branch now suppresses both (P18).
- **A draft record would have UNBLOCKED an activity gate** (`statusOf` is blind
  to draftness; `recorded → na` would satisfy the gate with evidence the team
  cannot see) — the recorded arm now consults the draft flag (P20).
- **A recommendation by INDEX binds to nothing** — now a same-decision option
  FK (P27). **A membership-keyed push target drops the org-admin requester** —
  now a user-level target (P26). **The forward reason and target** joined the
  non-blank and active-member disciplines their siblings already carry (P30,
  P34).

## The rule this audit adds

Round 1's failure: enumerating the readers of a NEW value while checking the
design only against itself. Round 2's failure, one level up: **reusing an
existing state, filter, spine or table borrows its ENTIRE contract — the rows
it implies, the writers it has, the blindness it carries — and a plan that
names the reuse must name the inherited obligations with it.** `change` implies
an open request; a role switch implies its role-writers; a terminal status
implies frozen evidence; a push spine implies its addressing model. The §A.3
reader-table discipline extends to borrowed machinery: for every reused
mechanism, enumerate what it assumes, who writes it, and what it cannot see.

## Status

All twenty-three findings across both rounds are corrected in the plan text
with their probes named and their red sites stated. Nothing is dismissed or
deferred. If the next review still finds, this is the LAST finding head before
the docs-only cap: the following head owes `Review-Deferred-To-Probes`, which
this diff can only carry by first reverting the STATUS edit and landing the
flip as the immediate tiny follow-up PR — the #324-proven two-step the plan's
§F pre-declares.

Review-Convergence: complete
