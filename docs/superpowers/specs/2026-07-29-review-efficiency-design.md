# Autonomous Review Efficiency Design

## Goal

Shorten the autonomous Claude-to-Codex loop without weakening exact-head CI,
independent review, migration safety, or fail-closed merge behavior.

## Problem

The existing loop is safe, but a broad PR can enter an unbounded sequence of
finding, correction, full CI, and full review. PR #246 demonstrated the failure
mode: one review unit combined frontend flows, server behavior, authorization,
time-zone handling, offline replay, idempotency, and concurrency. Each new head
correctly invalidated the previous clearance, but the process had no mechanism to
reject an unjustified review unit or force a consolidated audit after repeated
finding-bearing heads.

## Decisions

### 1. Keep the existing safety boundary

The five existing product checks remain mandatory. A new, cheap `review-scope`
check runs first. Codex still reviews only a CI-green exact head, and only the
exact-SHA `codex-current-head` success may merge it. No AI API key or human
approval is introduced.

### 2. Review-unit preflight

A standard review unit is at most 20 changed files and 1,500 changed lines
(`additions + deletions`). A larger PR is not automatically unsafe, but it must be
deliberate. It must carry `<!-- review-size: justified-large -->` and an invariant
matrix covering authorization/tenancy, civil time and lifecycle, concurrency and
idempotency, data integrity/conservation, offline/reconciliation, and UI/server
parity. Missing evidence fails before expensive CI jobs start.

The policy begins after PR #246 so the in-flight Phase-4 final task is not
retroactively stranded. PR #247 and later are enforced.

### 3. Batched review contract

Claude must self-audit the full review unit against the invariant matrix before
the first review. Codex's first pass is comprehensive. On correction heads, Codex
reviews the delta, every prior finding, and adjacent invariants affected by the
delta. Both agents must batch all current findings instead of deliberately
dripping one correction at a time.

### 4. Convergence after two finding heads

Review comments from `chatgpt-codex-connector[bot]` provide durable finding-head
history. Once two distinct heads have findings, the next CI-green head is accepted
for Codex review only when:

- its head commit carries `Review-Convergence: complete`; and
- the PR contains a changed `docs/reviews/*convergence*.md` packet.

That packet must map all prior findings, the complete invariant matrix, the
architectural cause, batched remedies, reproduce-first probes, and remaining
risks. This is an architecture reset, not another isolated patch. Any later
finding keeps the same convergence requirement; correctness still fails closed.

### 5. CI cost control

`review-scope` has no dependency installation and runs before the five expensive
jobs. Valid PRs still run every existing check. Invalid review units fail quickly,
so compute is not spent on code that is not yet reviewable.

## Rollout And Compatibility

- Existing PRs through #246 retain the original five required checks and are
  grandfathered from scope evidence because their branches cannot emit the new
  job. PR #247 onward requires all six checks.
- Exact-head review, recovery, auto-merge, and Claude handoff semantics remain
  unchanged.
- Branch protection should add `review-scope` only after legacy PR #246 reaches a
  terminal state. The internal gate requires it immediately for PR #247 onward,
  so new work fails closed without stranding the older branch.
- No product runtime, database schema, migration, or deployment behavior changes.

## Acceptance Criteria

1. Standard PRs pass scope preflight without extra ceremony.
2. An unjustified oversized PR fails before product CI starts.
3. A justified oversized PR passes only with all six invariant categories.
4. Two distinct Codex finding heads force convergence evidence on the next head.
5. A convergence head missing either the trailer or packet remains draft.
6. A compliant convergence head proceeds through all CI and exact-head Codex
   review normally.
7. Existing exact-head, stale-evidence, recovery, and auto-merge tests remain
   green.
