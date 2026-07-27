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
   Codex signal is required before squash auto-merge is queued.
7. Missing evidence, timeout, ineligible PRs, or an unavailable subscription
   service fail closed.
8. No `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, or AI GitHub Action is used.

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
  and success-before-auto-merge ordering. The final focused battery passed 28/28.
- `node --check` passed for both automation modules; the workflow parsed as YAML.
- Final `pnpm check` after protocol alignment passed: automation 28/28, web
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
5. Dispatch `Autonomous review and merge` with `pr_number=230`. From that point,
   GitHub drives the regular CI -> ready -> Codex -> Claude Auto-fix -> merge loop.

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
  `+1` reaction. The classifier pins the exact bot actor and review-cycle time;
  any integration behavior change fails closed and requires a classifier update.
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

The correction separates **review-start** from **review-result** behavior. Only CI
completion for a head without a terminal Codex status, or an explicit operator
dispatch, may initiate draft-to-ready. `pull_request_review: submitted` and
`pull_request_review_comment: created` remain as result-only listeners: they
accept only the Codex GitHub App and the exact current head, fail branch protection
before presentation mutations, and draft the PR. They cannot call `reviewAttempt`
or mark a PR ready. This preserves delayed-finding safety without creating another
review request. Every start and result event for a PR shares one non-cancelling
concurrency lane. The active poll reads Codex evidence directly; queued result
handlers therefore cannot cancel it or race its terminal status write. A pushed
head supersedes the active poll on its next bounded check, while a same-head CI
rerun waits and then consumes the terminal status instead of performing another
draft-to-ready transition.

The first correction still allowed a manual CI rerun on an unchanged head to emit
another completed `workflow_run` and overwrite the terminal review status with
`pending`. The follow-up guard reads the latest `codex-current-head` status before
any status or draft mutation. A review success or review failure is terminal for
ordinary CI events; CI failures remain retryable. New statuses use `review:` and
`ci:` prefixes, while the classifier recognizes all unprefixed terminal statuses
emitted by the earlier gate, including `Codex submitted a current-head review`.
Only `workflow_dispatch` can deliberately retry a terminal same-head review.

Review success is published while auto-merge remains disabled. The serialized
handler then waits through a bounded settlement window, re-reads exact-head Codex
evidence and the durable status, and converts the status back to failure plus draft
if a finding arrived. Auto-merge is enabled only after that settlement remains
clean. A CI rerun that observes terminal success idempotently enables auto-merge,
so a process failure between success publication and queueing is recoverable
without another review request. Terminal failures similarly restore draft state
before returning.

A failed CI rerun is handled before terminal-review recovery. When the durable
review verdict is success, the CI handoff preserves both that verdict and the PR's
ready state, so a later green rerun can resume auto-merge without another
draft-to-ready review request. Other CI failures draft the PR, and no CI outcome
overwrites an existing terminal review verdict. Regression tests cover event-role
and concurrency separation, the same-head CI-rerun guard, legacy terminal values,
late exact-head findings, terminal-state recovery/publication, and failed-CI
ordering.
