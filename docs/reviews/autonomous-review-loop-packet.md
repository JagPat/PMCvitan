# Subscription-Backed Autonomous Review Loop Packet

## Objective

Make the Claude Code web authoring and Codex GitHub review loop continue while the
owner's laptop is offline, without storing an Anthropic or OpenAI API key in
GitHub. GitHub is the fail-closed state machine and durable audit trail.

## Reviewed Lineage

| Item | Commit |
| --- | --- |
| Base (`main`, PR #229 merge) | `f6af800c47a5383060bd4bfc1766fdde6f750b42` |
| Architecture and implementation plan | `a265c03` |
| Current-head classifier | `66438be` |
| Trusted orchestrator and CI contracts | `05b2c77` |

The bootstrap PR head is the authoritative final documentation revision; this
packet does not embed a self-referential final SHA.

## Safety Properties

1. Only open same-repository pull requests are eligible.
2. The write-capable workflow checks out the trusted default branch, never PR code.
3. The five existing CI jobs must succeed on the exact PR head.
4. Every head receives its own `codex-current-head` commit status; a push cannot
   inherit clearance from an older SHA.
5. Current-head inline findings and review findings take precedence over a clean
   reaction. Stale-head and pre-cycle evidence are ignored.
6. Findings return the PR to draft for Claude Code web Auto-fix. A fresh clean
   Codex signal is required before the exact reviewed SHA is squash-merged or
   queued through the waiting-state auto-merge fallback.
7. Missing evidence, timeout, ineligible PRs, or an unavailable subscription
   service fail closed.
8. No `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, or AI GitHub Action is used.
9. Codex's GraphQL alias (`chatgpt-codex-connector`) is accepted only while
   resolving historical review threads. REST review evidence still requires
   `chatgpt-codex-connector[bot]`, so a bare account cannot satisfy the gate.

## Reproduce-First Evidence

- Classifier tests were RED because `scripts/autonomous-review-state.mjs` did not
  exist, then GREEN with clean, finding, stale, precedence, timeout, and
  eligibility fixtures.
- Workflow contract tests were RED because the trusted gate did not exist and the
  old workflow merged on review existence alone, then GREEN after replacement.
- Baseline before implementation: `pnpm check` passed (web 432/432, API 659/659,
  both builds clean).
- Reproduce-first same-head contracts failed before each correction: review/comment
  re-entry, CI-rerun terminal-state loss, legacy review-only failure, late evidence,
  head-scoped/paginated failure-latch recovery, durable retry authorization,
  buried terminal-result recovery, executable exact-head recovery, an explicit
  paused-owner/newer-request barrier, stale-dispatch failure semantics, and ready-
  state restoration before auto-merging a recovered clean verdict. The documented
  recovery jq expression is also executed against a retryable-status fixture.
  Recovery accepts an exact active pending marker for abandoned-owner takeover,
  inherits a retryable timeout that lands while that takeover is queued, and still
  lets a same-cycle non-retryable finding veto recovery.
  The final architectural regression proves that review-result webhooks cannot
  enter the merge orchestrator or publish its status. The focused battery passed
  45/45.
- `node --check` passed for both automation modules; the workflow parsed as YAML.
- Final `pnpm check` after protocol alignment passed: automation 45/45, web
  432/432 plus production build, and API 659/659 plus production build.

## Bootstrap Procedure

1. Open this automation change as a draft PR from `codex/**`.
2. While it remains draft, request the one bootstrap review with `@codex review`.
   The legacy workflow cannot merge a draft, so findings remain safe.
3. Fix findings forward and repeat the explicit review request until the bootstrap
   head is clean; merge this one PR manually because the new orchestrator is not
   available on the default branch yet.
4. Add `codex-current-head` to the existing five required checks, set strict mode,
   and enforce protection for administrators.
5. Publish the one explicit failed bootstrap `codex-current-head` status with the
   exact description `review: bootstrap exact-head review requested` on PR #230's
   current SHA, then dispatch `Autonomous review and merge` with
   `pr_number=230`, the exact current `head_sha`, and that status's ID as
   `terminal_status_id`. From that point, GitHub drives the regular CI -> ready ->
   Codex -> Claude Auto-fix -> merge loop.

## External Verification To Record After Merge

- Bootstrap PR head and merge SHA.
- The branch-protection response showing six required contexts, strict mode, and
  administrator enforcement.
- The workflow-dispatch run for PR #230 and its exact-head
  `codex-current-head` status.
- Confirmation that Claude Code web Auto-fix remains subscribed to PR #230 until
  merge or close.

## Residual Limitations

- GitHub cannot manufacture a Claude Code web session. Auto-fix must be enabled
  from the Claude subscription before unattended operation begins.
- Codex's clean result is represented by the installed GitHub integration's fresh
  `+1` reaction. For one review invocation, finding-bearing review evidence and
  that clean reaction are mutually exclusive terminal outcomes. The classifier
  pins the exact bot actor and review-cycle time; an integration contract change
  requires a classifier and protocol review.
- The workflow retries a timed-out review once. Continued provider unavailability
  leaves the PR draft and blocked for a later manual dispatch; it never bypasses
  independent review.

## Same-Head Re-Review Incident

After bootstrap, PR #234 added `pull_request_review` and
`pull_request_review_comment` as orchestrator triggers. Those events entered the
same path as CI completion, which converts the PR draft-to-ready to request a
review. A Codex finding therefore triggered another review of the unchanged SHA;
that review triggered another workflow run, producing a live same-head loop on
PR #230.

The final correction gives **one exact-head run sole ownership of review and
merge**. Only CI completion for a head without a terminal Codex status, or an
explicit operator dispatch carrying that exact head, may initiate draft-to-ready.
`pull_request_review` and `pull_request_review_comment` are not orchestrator
triggers and `contextForEvent` rejects them. The owning run polls reviews, inline
comments, and reactions until the one invocation emits a terminal outcome. A
finding-bearing review fails the gate and drafts the PR; the mutually exclusive
clean reaction succeeds the gate and completes the exact-head merge. Codex review
comments still reach Claude Code web Auto-fix through the installed
subscription-backed GitHub App, without creating a second merge-state writer.

Review runs remain serialized by PR number plus exact head SHA. A pushed head
supersedes the old poll on its next bounded check. A same-head CI rerun recovers a
terminal review result from the complete paginated status history instead of
performing another draft-to-ready transition, even when newer legacy `pending` or
`ci:` statuses obscure that result. A manual recovery dispatch requires both the
live head SHA and the exact latest retryable terminal status ID. Timeouts, changed
CI, changed provider evidence, and the documented bootstrap marker are retryable;
finding-bearing reviews require a new head. Pending, successful, persistent-
finding, and superseded IDs are rejected before any draft or review mutation. The
dispatch job records only a durable `codex-recovery-request/<terminal-id>` commit
status. It does not invoke Codex or write the authoritative review status.

Normal CI and recovery feed one job-level concurrency group keyed by PR and exact
head. That serialized owner is the only job allowed to change draft state, invoke
and poll Codex, publish `codex-current-head`, or queue auto-merge. GitHub may replace
an older queued job when another owner is queued, but it cannot erase the durable
request marker; the next owner consumes it. Per-terminal contexts prevent an old
owner from consuming a newer request. Duplicate dispatches refresh the same request,
including after an interrupted owner, and queue behind the same owner instead of
creating another review lane.
A request remains pending across CI failure and is consumed only after a terminal
review outcome. The owner also rechecks required CI before review success. This
removes same-second and lease-boundary ambiguity by eliminating the second owner,
instead of attempting to coordinate two independently mutable lanes. Deterministic
regressions pin durable request recovery, single-owner workflow structure, final CI
revalidation, and the absence of timestamp- or run-ID-based admission.

The first correction still allowed a manual CI rerun on an unchanged head to emit
another completed `workflow_run` and overwrite the terminal review status with
`pending`. The follow-up guard reads the latest `codex-current-head` status before
any status or draft mutation. A review success or review failure is terminal for
ordinary CI events; CI failures remain retryable. New statuses use `review:` and
`ci:` prefixes, while the classifier recognizes all unprefixed terminal statuses
emitted by the earlier gate, including `Codex submitted a current-head review`.
Only `workflow_dispatch` can deliberately retry a terminal same-head review. It
requires the exact head SHA and latest failed terminal status ID. An active cycle
has a newer pending marker and therefore cannot authorize a duplicate retry.

The earlier settlement-and-admission design was removed because no finite series
of reads can atomically exclude a future webhook writer. Eliminating that writer
closes the race at its source. After the polled invocation reports clean, the run
reclassifies exact-head evidence, publishes success, refreshes the live head, and
completes the exact-head merge. A process failure between success publication and
merge completion is recoverable: a same-head CI rerun observes the terminal status
and idempotently retries completion without requesting another review. Historical
paginated status latching remains only to fail closed when recovering heads touched
by the retired multi-writer implementation. Terminal failures restore draft state
before return.

A failed CI rerun is handled before terminal-review recovery. When the durable
review verdict is success, the CI handoff preserves both that verdict and the PR's
ready state, so a later green rerun can resume merge completion without another
draft-to-ready review request. Other CI failures draft the PR, and no CI outcome
overwrites an existing terminal review verdict. Regression tests cover exclusive
event ownership, exact-head serialization, the same-head CI-rerun guard, legacy
terminal values, terminal-state recovery/publication, durable recovery tokens,
single-owner retry admission, and failed-CI ordering.

## Clean-State Merge Correction

The first hosted clean-head proof exposed a final control-plane mismatch. The
controller published the required `codex-current-head=success` status and then
called `enablePullRequestAutoMerge`. At that instant all branch-protection gates
were already satisfied, so GitHub classified the PR as clean and rejected the
GraphQL mutation with `Pull request is in clean status`. PR #230 was reviewed and
safe but still needed a human merge.

The corrected completion policy first sends `PUT /pulls/{number}/merge` with
`merge_method=squash` and the exact reviewed head in the `sha` field. GitHub
therefore rejects a stale head and continues to enforce branch protection. A 405
waiting-state response falls back to auto-merge. If the fallback races with the
PR becoming clean and returns the observed clean-status error, the controller
retries the same exact-SHA merge once. The fallback mutation includes
`expectedHeadOid`, binding it to the reviewed SHA even if a push lands after the
first direct attempt. Any other error fails closed. Regression tests pin immediate
merge, waiting-state fallback, the expected-head mutation, and the clean-state race.
