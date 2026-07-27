# Subscription-Backed Autonomous Review Loop Design

## Objective

Make the Claude-author, Codex-review, GitHub-merge loop run without the owner's
laptop and without Anthropic or OpenAI API keys in GitHub Actions.

## Product Boundaries

- Codex GitHub automatic review uses the owner's Codex subscription.
- Claude Code on the web Auto-fix uses the owner's Claude subscription.
- GitHub Actions coordinates CI, review state, branch protection, and merge.
- Repository workflows never receive AI credentials and never run PR code with a
  write-capable token.
- A missing reviewer response or missing Claude correction fails closed.

## Existing Defects

1. `docs/AUTONOMOUS_LOOP.md` says Codex reviews draft PRs, while Codex automatic
   review starts when a PR is opened for review or a draft becomes ready.
2. `.github/workflows/auto-merge.yml` treats any Codex review on the current head
   as clearance, including a review with blocking inline findings.
3. A clean Codex result is a `+1` reaction, while a finding-bearing result is a
   review plus inline comments. The current workflow models neither distinction.
4. Branch protection requires only the five CI jobs. It has no current-head Codex
   gate and administrators can bypass it.
5. The repository cannot observe Claude Auto-fix subscription state. It must
   therefore make author inactivity visible while keeping the PR unmergeable.

## State Machine

| State | Entry condition | Machine action | Exit condition |
| --- | --- | --- | --- |
| `draft` | Claude opens or updates a PR | CI runs; `codex-current-head` is absent or pending | all required CI checks succeed |
| `review_pending` | trusted orchestrator promotes the exact head to ready | set `codex-current-head=pending`; poll Codex | fresh clean reaction, current-head findings, or timeout |
| `changes_required` | Codex posts any current-head inline finding or review | set gate failure; return PR to draft | Claude Auto-fix pushes a new head |
| `clear` | Codex posts a fresh `+1` after this head's ready transition and no current-head finding exists | set gate success; queue squash auto-merge | GitHub merges after every required check is green |
| `blocked` | CI fails or Codex misses two bounded review attempts | set gate failure; return PR to draft; explain recovery in sticky comment | Claude or an operator pushes a correction or dispatches recovery |

Every push creates a new SHA with no successful `codex-current-head` status.
Clearance on an older SHA is therefore unusable by branch protection.

## Codex Result Contract

The Codex actor is `chatgpt-codex-connector[bot]`.

- Any inline review comment whose `commit_id` equals the expected head is
  `changes_required`.
- Any submitted Codex review whose `commit_id` equals the expected head is also
  `changes_required`, unless the same classification already counted its inline
  comments. This is deliberately conservative.
- A `+1` issue reaction from Codex is `clear` only when its `created_at` is at or
  after the ready-transition timestamp for the current review attempt and there
  is no current-head finding.
- Old-head reviews and old reactions are ignored.
- No response remains `pending` until the bounded timeout, then becomes
  `timed_out`.

## GitHub Orchestrator

The trusted workflow runs from default-branch code on:

- completion of the `CI` workflow for a pull-request event; and
- `workflow_dispatch` with a PR number for recovery and bootstrap.

It accepts only open, same-repository PRs. Fork PRs are never given write-capable
automation. It verifies that the event SHA still equals the live PR head and that
`web`, `api`, `e2e`, `api-e2e`, and `upgrade-proof` all completed successfully.

The workflow records one sticky `<!-- autonomous-review-state -->` comment. The
comment names the current SHA, CI state, Codex state, attempt count, and next
machine action. It is evidence only; commit status and branch protection remain
authoritative.

The orchestrator retries a missing Codex trigger once by returning the PR to
draft and promoting it again. It does not retry finding-bearing reviews. Claude
Auto-fix receives those review comments through the Claude GitHub App and pushes
the correction.

## Merge Safety

`main` branch protection must require:

- `web`
- `api`
- `e2e`
- `api-e2e`
- `upgrade-proof`
- `codex-current-head`

Strict up-to-date checks and administrator enforcement are enabled. No review
approval count is used because Codex reports through comments/reactions rather
than GitHub's approval state.

The orchestrator is the only repository automation that queues auto-merge. The
old existence-only Codex review check is removed.

## Claude Subscription Contract

Claude authors every implementation PR from a cloud session with Auto-fix
enabled. `CLAUDE.md` and `docs/AUTONOMOUS_LOOP.md` require the session to remain
subscribed until merge or close. Codex findings and CI failures wake that cloud
session even while the owner's laptop is unavailable.

If the session does not respond, the PR remains draft with a failed gate and a
specific sticky status. GitHub does not attempt to create a replacement Claude
worker because doing that from Actions would require Anthropic API credentials.

## Verification

- Pure state-classifier fixtures cover clean, finding, stale review, stale
  reaction, pending, timeout, and finding-wins-over-reaction cases.
- A workflow contract test pins trusted triggers, permissions, required CI names,
  current-head status, two-attempt bound, draft/ready transitions, and the absence
  of AI secret names or AI actions.
- `pnpm check` includes the automation tests.
- Bootstrap is proven on PR #230 through `workflow_dispatch` after the workflow is
  merged and branch protection is updated.

