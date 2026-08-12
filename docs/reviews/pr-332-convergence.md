# PR #332 — convergence audit (CI same-sha serialization)

Owed at the second finding-bearing head.

| head | change | finding | outcome |
|---|---|---|---|
| `41d29c5` | `ci-<sha>` group for everything | a queued base-retarget can be REPLACED by a later body edit; the survivor has no `changes.base`, battery-plan reads the old base's products as coverage, and the gate publishes stale green against the new base — silently | corrected on `b89275b` |
| `b89275b` | per-sha group for metadata edits ONLY | code events moved to unique groups — and runs only queue against members of the SAME group, so the edited run raced the synchronize run again and the false red the PR exists to fix returned | corrected on this head |

## The shared defect: carving semantics out of a primitive that does not express them

GitHub's `concurrency` gives exactly one mechanism: a group with one running slot and **one pending
slot, where a newer pending run replaces the queued one**. Both rounds tried to get richer semantics
than that primitive offers, and each patch optimized for the finding in front of it while silently
giving back the property the previous head had secured:

- Round 0 wanted *serialization* and got it — at the cost of putting **unrecoverable payloads into a
  lossy slot**.
- Round 1 wanted *payload safety* and got it — by moving code events out of the group, **which is
  the only place waiting happens**.

The invariant neither head stated, now pinned as the FULL expression (ordering included) in
`autonomous-ci-battery.test.mjs`:

> **Everything that must wait has to share the group with what it waits for. The only runs exempted
> from the shared queue are those whose payload cannot be recovered if the pending slot swallows
> them.**

Applied: exactly one exemption exists — the base retarget, whose `changes.base` exists nowhere but
its own event payload. Everything else with a PR payload shares `ci-<sha>`.

## Why a swallowed code event is acceptable and a swallowed retarget is not

The asymmetry is the whole design, so it is stated rather than implied:

- **A swallowed queued synchronize** (new sha `S` queued behind a ~30s metadata run, replaced by a
  newer edit): the surviving edited run's battery-plan finds **no product coverage for `S`** and
  fails toward running the full battery — the *"an edit on a head whose product jobs never really
  ran finally launches them"* rule that already exists and is already pinned. Recovered.
- **A swallowed queued reopened**: the survivor skips on the pre-close coverage — exactly the
  staleness the metadata-edit design already accepts for any old green head (products are re-run on
  `changes.base`, not on base *drift*). No worse than the accepted design.
- **A swallowed retarget**: nothing downstream can reconstruct `changes.base`. Battery-plan sees a
  plain edit with existing coverage and skips; the gate accepts the deliberate skips; stale evidence
  ships. **Unrecoverable — hence the exemption.**

Withdrawal was weighed against a third head — this file's own workflow header records a precedent
(`pr-263-convergence.md`, the withdrawn risk classifier), and the disease here is a transient,
self-healing false red. It lands anyway because the residual risks are now bounded by mechanisms
that already exist and are already pinned, and the alternative — behavioural discipline about when
PR bodies may be edited — is exactly the kind of instruction-to-a-person the parent audits ruled
out.

## What this predicts

Any future change to this concurrency block must answer two questions before it merges, in this
order: *who waits for whom* (they must share a group), and *whose payload dies in the pending slot*
(they must be exempt). A change that answers only one will reproduce one of these two rounds.

## Round 3, and the withdrawal

| head | change | finding |
|---|---|---|
| `c439556` | retargets exempt via `changes.base` | two exempted retargets can interleave: retarget A→B delayed, B→C fast — the delayed B run's gates finish LAST, so its base-B products carry the newest gate stamp and outrank the base-C attempt, and the gate can go green for the current base on stale evidence |

The finding is verified and honest about one thing worth stating precisely: **racing retargets are
main's behaviour today** — before this PR, every run raced, including retargets. The round-3
interleaving is not a regression of this diff; it is a pre-existing hazard this PR's own packet
*claimed* was handled ("unrecoverable — hence the exemption") when the exemption merely preserved
it. The claim was wrong even though the code was no worse.

**This PR is withdrawn rather than corrected a third time.** The arithmetic, stated for the next
person who reaches for this idea:

- The disease is a **transient, self-healing false red** that occurs only when a PR body is edited
  during its own CI run — already avoided by writing bodies right the first time and refreshing
  after settle, and it has never blocked a merge (the orchestrator re-evaluates when the long job
  lands).
- The cure has produced **three consecutive correctness findings in the trusted merge gate**, each
  round's fix surviving exactly until review found the next interleaving GitHub's one-pending-slot
  primitive permits. A fourth round (a dedicated retarget lane) was designed and is sketched below,
  and there is no proof it is the last — the primitive cannot express "serialize everything, lose
  nothing," so every scoping choice trades one race for another.

The precedent is `docs/reviews/pr-263-convergence.md` — the path-based risk classifier, attempted
and withdrawn, with the workflow header pointing at the reasoning. This packet is that record for
per-sha concurrency. If it is ever revived, the fourth-round sketch is: retargets serialize among
THEMSELVES in a per-sha retarget lane (`ci-<sha>-retarget`) where replacement is safe because every
retarget event is self-contained, while the main lane keeps the round-2 shape — and the burden of
proof is enumerating the CROSS-lane interleavings before merge, not after review finds them.

The durable, zero-risk yield of the three rounds stands regardless: `edited` must stay in the one
workflow (pinned, with the retarget and stuck-PR reasons), and the false red's task-#56 playbook —
confirm the named job is still running, wait, never push a no-op head — costs nothing and works.

Review-Convergence: complete
