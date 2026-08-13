# PR #334 — convergence audit (the phase-6-task-2 handoff)

Owed at the second finding-bearing head.

| head | role | findings | outcome |
|---|---|---|---|
| `de83801` | the flip: merged + the owner-gated interregnum (`next_task: none`) | 3 (P2) | corrected on `e8d4406`/`9fad0cc` |
| `9fad0cc` | the owner schedules the decision-workflow rework; interregnum → real handoff | 3 (P2) | corrected on this head |

Six findings on a STATUS flip. The root is ONE mistake made three ways, and it is this
loop's oldest rule pointed at its own operator: **a state value has READERS, and I shipped
values without enumerating them.**

## Round 1 — the `none` sentinel had readers I never checked

The interregnum introduced `next_task: none` as a new live value. Three readers consumed it,
and I had verified none of them:

- `isHandoffShape` read any non-empty string as "a next task named" — the interregnum
  classified as a HANDOFF, and a live maintenance PR carrying it would have suppressed its
  own `open_pr` drift (the hourly shepherd's whole purpose). Fixed: the sentinel is the
  ABSENCE of a next task, proven red-first with a pin covering both the misclassification
  and the drift-suppression scenario.
- My own pin refinement accepted a BLANK as deliberate-none — handing the accident class the
  pin was built for a free pass. Fixed: only the SPELLED `none` takes the deliberate branch.
- The narrative read as waiting-on-a-person. Reworked into machine-actionable state (the
  queue as the standing work source; the gated successors as data with opening events), and
  then made moot when the owner's scheduling decision arrived and dissolved the interregnum.

## Round 2 — the replacement state had readers I never checked, again

The owner scheduled the decision-workflow rework, and the re-flip introduced
`next_task: phase-6-task-3` plus a rewritten narrative. Three more unchecked readers:

- **The file itself.** My marker-based string surgery replaced text between two markers that
  sit in the opposite order in the file — duplicating the block instead of replacing it, so
  the stale "deliberately NONE" prose SURVIVED beside the new handoff. I verified only the
  Now block line, not the region I had edited. The rule this violates is not subtle:
  **re-read what you wrote, in full, before shipping it.** The fix deletes the duplicate; the
  repair used exact-match edits, not marker surgery.
- **The deferral register.** `phase-6-task-3` is already the stop named by
  `Review-Deferred-To-Probes` in `docs/reviews/pr-324-convergence.md` — the
  external-collaboration plan's deferred probes are BOUND to it, and a stop must stay bound
  to the questions it owes. The decision-workflow unit takes `phase-6-task-4`, the first
  slug reserved nowhere (verified by enumeration, not by eye).
- **The runner's read order.** The prose said task 4's plan "ships in the same PR as the
  STATUS that names it" while THIS PR shipped no plan — a promise about a different PR
  written as if about this one. The narrative now states the actual contract: task 4's FIRST
  PR carries the plan + the `in_progress` STATUS in one diff (the #331-proven pattern the
  phase_plan CI pin enforces at that moment), and until then `phase_plan` here names the
  COMPLETED task-2 plan as history — which is the pin's own documented semantics for a
  merged task.

## The rule this unit adds to the working set

The parent units taught "enumerate the readers" about product state (write paths, stores,
deploy units, client generations). This PR recommits the same failure about CONTROL-PLANE
state, twice: `none` had `isHandoffShape`, the pin, and the shepherd as readers;
`phase-6-task-3` had the deferral register; the narrative had the runner's documented read
order; the file had its own future reader — me. **A STATUS value is an interface. Before
shipping a new value, enumerate every consumer of that field (predicates, pins, gates,
registers, the read-order prose) and verify each — and re-read the artifact end to end after
editing it, because the editor is a reader too.**

## Status

All six findings are corrected: the sentinel predicates are fixed and pinned red-first, the
blank stays on the strict path, the stale block is gone, the slug collision is resolved by
enumeration (`phase-6-task-4`), and the plan-shipping contract is stated as it actually
works. Nothing is dismissed or deferred; the diff is code-bearing (scripts guards), so no
docs-only deferral applies.

Review-Convergence: complete
