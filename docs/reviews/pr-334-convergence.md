# PR #334 — convergence audit (the phase-6-task-2 handoff)

Owed at the second finding-bearing head.

| head | role | findings | outcome |
|---|---|---|---|
| `de83801` | the flip: merged + the owner-gated interregnum (`next_task: none`) | 3 (P2) | corrected on `e8d4406`/`9fad0cc` |
| `9fad0cc` | the owner schedules the decision-workflow rework; interregnum → real handoff | 3 (P2) | corrected on `784a113` |
| `784a113` | round-2 corrections + this packet | 3 (P2) | corrected on `b276e0c` |
| `b276e0c` | round-3 corrections (`editsStatus` on the none-flip only) | 1 (P2) | corrected on this head |

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

## Round 3 — the sentinel's readers, enumerated at last

Round 1 fixed the sentinel's readers ONE AT A TIME, and round 3 is the bill for that:

- **The drift suppressor's OTHER direction.** Round 1 stopped calling the none-state a
  handoff so a maintenance PR could not suppress its own drift — which un-recognized the
  none-FLIP itself as a correction in flight, and the shepherd would then advise pointing
  `open_pr` at the flip's own number: the exact #303 stale-open_pr trap, planted into the
  merged record. The Now block CANNOT distinguish the two (a flip proposes the state; a
  maintenance PR inherits it), so the distinguisher is now data: `editsStatus` — whether
  the PR's diff touches `docs/STATUS.md`, fetched from the files API, `null` when unknown
  and failing toward suppression because the #303 trap is the unrecoverable side. Both
  directions pinned (maintenance `false` → reported; flip `true` → suppressed; unknown →
  suppressed).
- **Case-exactness.** Two of my sentinel checks lowercased; the runner's `isNone` is
  exact. `next_task: NONE` would have passed the pin's deliberate branch while
  `assessRunnerState` treated it as a NAMED task — one state, two readers, two meanings.
  The predicate is now EXPORTED once (`isNoneValue`) and shared by `isHandoffShape` and
  the pin's strict routing; `NONE` falls to the allowlist and fails loudly, which is the
  correct outcome for a typo.
- **The file's remaining prose.** The narrative still explained why `next_task` is
  `phase-6-task-1b` — the previous handoff's truth contradicting the current Now block.
  Historicalized: the convention paragraph now anchors to the CURRENT value and records
  the 6.1b spelling as the slug for when its turn returns.

## Round 4 — the distinguisher belonged to the class, not the instance

Round 3 introduced the right distinction (a head PROPOSES a terminal state only when its
diff edits STATUS; otherwise it merely CARRIES it) and then applied it to exactly the shape
that had just bitten — the none-flip — leaving the NAMED handoff ungated. With a named
handoff merged on the default branch (`next_task: phase-6-task-4`, precisely the state this
PR lands), every fresh maintenance PR's head carries that exact shape, qualifies as "the
correction in flight", and self-exclusion then leaves no drift to report — the shepherd
never corrects `open_pr: none` for the live PR. The fix moves `editsStatus !== false`
OUTSIDE the shape disjunction so it gates both shapes; both directions pinned red-first
(carried named handoff → reported; a genuine STATUS-editing handoff PR → suppressed, as
always). This is the packet's own round-3 sentence — "fixed the sentinel's readers one at a
time" — recommitted one abstraction level up: the fix itself was applied one SHAPE at a
time. A guard on a classification belongs on the classification, not on its most recent
counterexample.

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
