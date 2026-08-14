# PR #340 — convergence audit (the 4b–4d decision-workflow plan)

Owed at the second finding-bearing head. Docs-only diff, and — unlike PR #335 —
STATUS-FREE from round 1 on: the folded flip was reverted out at the first
correction and travelled as its own PR #341 (merged), so if this plan review
reaches the three-finding-head cap, the deferral trailer
`Review-Deferred-To-Probes: phase-6-task-4` is available to the answering head
with no two-step.

| head | role | findings | outcome |
|---|---|---|---|
| `3ba1688` | the plan + a folded STATUS flip | 7 (3 P1, 4 P2) | STATUS reverted, the flip split out as PR #341; corrected on `29eeeef` |
| `29eeeef` | round-1 batch | none of its own — superseded unreviewed by the conflict-shepherd merge before any verdict | counts once with `d387412` |
| `d387412` | `29eeeef` + `origin/main` merged (shepherd directive; the plan bytes unchanged by the merge) | 8 (4 P1, 4 P2) | corrected on this head |

## Round 1 — two repeated loop lessons, five underspecified mechanisms

Two findings were about the autonomous loop's own bookkeeping, and both were
lessons ALREADY RECORDED from PR #335 that the opening head repeated: folding
the STATUS flip into a plan PR blocks the deferral trailer the cap will
eventually demand (answered by the revert + PR #341, this time before the cap
instead of at it), and `work_item` must keep the `none` sentinel while
`task_state` is an open state because `assessRunnerState` consults `work_item`
only in the `merged` branch (the named value I wrote was dead data that would
resolve the bare parent task; verified against the script, sentinel kept).

The five design findings share one class: the plan stated a sound invariant
and left its enforcing mechanism underspecified, so the stated form was
defeatable.

- "Cancel a targeted push when its target changed" was written holder-only;
  the class's normal targets are often NOT holders (consultee, requester,
  architect). Each event family now declares its own still-actionable
  predicate, at enqueue AND at claim (P38/P40).
- The forward door accepted ANY same-tx `DecisionForward` row; a row naming
  unrelated designations would satisfy it. The seal now compares the
  transition to its evidence field-for-field (P34).
- The countersign seal covered only the `awaiting_countersign → approved`
  edge, leaving the direct `pending/change → approved` road open to hostile
  SQL. The seal now judges EVERY entry into `approved` (P37).
- `deciderKind='none'` with `status='pending'` was representable at the DB — a
  published decision no one can approve, still driving every pending surface.
  The kind–status pair is now CHECK-coherent in both directions (P18).
- A decision stranded in `awaiting_countersign` when the last architect
  leaves had no command that could move it. The PMC-only
  `decisions.resolveStrandedCountersign` now exists with two attributed
  outcomes (P29b).

## Round 2 — the seals the round-1 corrections added, held to their own standard

All eight findings land on round 1's OWN additions, and the class is uniform:
a seal was named but not yet attributable, serialized, or two-sided.

- **Attributable (F2, P1)**: "flipped by the countersign" was a boolean with
  no act behind it — hostile SQL could flip `finalized` and approve. The
  countersign is now a concrete append-only `DecisionCountersign` row, and
  the flip is trigger-PAIRED to it (P31).
- **Serialized (F1, P1)**: the approved-entry seal merely READ architect
  presence, so a first-architect activation could commit between the read and
  the hostile approval's commit. The seal (and the architect-standing
  `Membership` writes) now take the SAME per-project readiness advisory lock
  before the presence read — the row-`FOR UPDATE` alternative is explicitly
  rejected in the plan as phantom-prone: a FIRST activation has no architect
  row to lock (P37).
- **Two-sided (F4, P2)**: the forward door checked holder-change → evidence
  but not evidence → holder-change; an orphan `DecisionForward` insert
  fabricated history. A deferred reverse seal now refuses it (P34).
- **Both verbs (F3, P1)**: `recorded` was sealed against UPDATE but not
  DELETE; the 4a no-delete seal extends to it (P18).
- **Both designations (F7, P2)**: `holdsOpenDecisions` took only a
  `membershipId`, missing role-designated holders; removing the last active
  member of a role named by an open decision is now refused too (P39).
- **Identity in the freeze (F5, P2)**: `decisionId` joined the
  `ChangeRequest` evidence freeze — an open request re-pointed at another
  decision stripped the change-state decision of its required request (P33).
- **The product path (F8, P2)**: the architect fan-out now includes the web
  Team-screen role pickers/labels — a role with no UI path to mint it
  activates only through direct API calls, which is not a shipped feature
  (P28).
- **The path my own widening broke (F6, P1)**: round 1's "seal EVERY entry
  into `approved`" — my correction — refused the ordinary standard
  `withdrawChange` restoration (`change → approved` on an already-finalized
  head). The seal now carves that exact arm: `origin='standard'` AND head
  already finalized; `countersign_rejection` restoration stays refused (P37).

## Deferral ledger

Nothing is disputed: all fifteen findings were verified real and corrected;
no refutations were posted on this PR. Should a third finding round land, the
answering head owes `Review-Deferred-To-Probes: phase-6-task-4` beside this
packet's update — the probes P15–P42 are exactly the executable targets that
trailer names, and this diff (STATUS-free) can carry it.
