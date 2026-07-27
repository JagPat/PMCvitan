# PMC Vitan Autonomous Build Loop

This repository is designed to progress without the owner's laptop or technical approval. GitHub is the durable control plane; conversations are not.

## Roles

| Role | Responsibility |
| --- | --- |
| Cloud runner | Read `docs/STATUS.md`, start the current work item, and never skip ahead |
| Claude Code web | Author code, tests, migrations, packets, and corrections on `claude/**`; keep Auto-fix subscribed until the PR reaches a terminal state |
| Codex Cloud | Independently review every PR head using `AGENTS.md`; never implement its own findings |
| GitHub | Hold drafts, run required CI, trigger Codex by moving CI-green drafts to ready, enforce an exact-head review status, and merge |
| Coolify | Deploy merged `main` |

## Authoritative Read Order

1. `docs/STATUS.md`
2. The `phase_plan` named by that file
3. Any `blocking_directive` named by that file
4. `AGENTS.md` for review and integrity rules
5. `CLAUDE.md` and architecture documentation for broader context

`docs/ROADMAP.md` and review packets are historical evidence. They may explain the lineage, but they do not override `docs/STATUS.md`.

## One Cycle

1. The runner selects only the work item in `docs/STATUS.md`.
2. Claude starts from latest `origin/main`, records the base SHA, opens a draft PR, enables web Auto-fix, and remains subscribed.
3. GitHub requires `web`, `api`, `e2e`, `api-e2e`, and `upgrade-proof`. When all five pass on the current head, the trusted default-branch workflow sets `codex-current-head` pending and marks the draft ready.
4. Marking the PR ready triggers Codex. The same exact-head workflow run polls that one invocation to its terminal result and accepts only evidence from `chatgpt-codex-connector[bot]` for the current SHA and review cycle. Review and review-comment webhooks never start or mutate the merge workflow.
5. A current-head finding fails `codex-current-head` and returns the PR to draft. Claude Auto-fix reproduces the finding, fixes forward, and pushes a new head; that push invalidates every prior clearance.
6. A fresh current-head clean Codex signal succeeds `codex-current-head` and queues squash auto-merge. Missing CI, stale evidence, timeout, or inactive authoring all fail closed.
7. Coolify deploys `main`. The runner updates `docs/STATUS.md` and begins the next work item only after merge.

No human approval is required. The owner may interrupt or redirect the loop, but is not a technical gate.

## Non-Negotiable Safety Rules

- Review happens before merge, especially for migrations.
- Deployed migration bytes are immutable; corrections use new forward migrations.
- A PR remains draft while any Codex finding is unresolved. Its temporary ready
  state exists only to invoke Codex after CI passes.
- Claude does not self-certify a Codex finding as closed; Codex re-reviews the new head.
- Task N+1 never starts while `docs/STATUS.md` keeps Task N open.
- Never add `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, or an AI action. Codex GitHub
  review and Claude Code web Auto-fix use the owner's product subscriptions.
- A write-capable workflow checks out only the trusted default branch, never PR
  code. Only open same-repository PRs are eligible.
- Credentials and raw transcripts never enter Git. In particular, never commit Coolify tokens, SMTP credentials, database passwords, `.env` contents, or local attachments.

## Recovery

When an accidental merge or stale state occurs:

1. Stop the next task.
2. Review the exact merged tree.
3. Record validated findings in a focused directive.
4. Change `docs/STATUS.md` back to `in_progress` for the correction.
5. Fix forward from current `main`; never rewrite deployed history.

If Codex or Claude web is unavailable, do not bypass the gate. The exact-head
status remains pending or fails after the bounded retry, and the PR stays draft.
After the subscription service is healthy, recover only the PR's current head:

```bash
PR=230
HEAD_SHA=$(gh pr view "$PR" --repo JagPat/PMCvitan --json headRefOid --jq .headRefOid)
TERMINAL_STATUS_ID=$(gh api --paginate --slurp \
  "repos/JagPat/PMCvitan/commits/$HEAD_SHA/statuses?per_page=100" \
  --jq '(add | map(select(.context == "codex-current-head" and .state == "failure") | select((.description // "") as $description | ($description | startswith("review:")) or ($description | contains("current-head Codex finding")) or ($description | contains("Codex submitted a current-head review")) or ($description | contains("Codex review timed out")) or ($description | contains("Codex evidence changed")))) | .[0].id) // empty')
test -n "$TERMINAL_STATUS_ID"
gh workflow run auto-merge.yml --repo JagPat/PMCvitan \
  -f pr_number="$PR" -f head_sha="$HEAD_SHA" \
  -f terminal_status_id="$TERMINAL_STATUS_ID"
```

All three inputs are required. The workflow refuses a stale SHA and authorizes a
retry only when `terminal_status_id` is the exact latest failed terminal review
status on that head. Pending, successful, or superseded status IDs fail closed.
Recovery uses a CI-independent concurrency lane, so a later same-head CI run cannot
replace an explicit retry. Its pending status carries the owning Actions run ID;
parallel CI observes that live owner and stands down. If the owner ends without a
terminal result, statuses are refreshed before the next CI run fails the review
state explicitly, while a new exact-token dispatch may take over the completed
lease. Failed CI is processed before stand-down, and the owner rechecks required
CI before publishing review success. The run ID is ownership, not timestamp-based
admission. Ordinary CI recovery searches the complete paginated status history,
including terminal review results hidden below legacy `pending` or `ci:` statuses.
Ordinary review-result webhooks are intentionally not orchestrator triggers. The
Codex App's finding comments still wake the subscription-backed Claude Auto-fix
session directly; GitHub Actions does not need an AI key or a second result writer.

## GitHub Enforcement

After the autonomous workflow itself is merged, protect `main` with these exact
settings:

- Require status checks: `web`, `api`, `e2e`, `api-e2e`, `upgrade-proof`, and
  `codex-current-head`.
- Require branches to be up to date before merging (`strict: true`).
- Enforce the protection for administrators.
- Keep squash auto-merge enabled.

Do not add `codex-current-head` before the workflow is present on the default
branch; doing so would intentionally block every PR, including the bootstrap PR.

## Current Position

Phase 4 Task 3 requires correction round 3 after the post-merge review of PR #226. See `docs/STATUS.md` and `docs/reviews/phase-4-t3-correction3-directive.md`. Task 4 is blocked until that correction receives a clean current-head Codex review and merges.

## External Dependencies

The Codex GitHub review integration, GitHub Actions, and Claude Code web Auto-fix
operate without the owner's computer. Codex and Claude use the owner's product
subscriptions; GitHub stores no AI API key. Claude Auto-fix must be enabled on the
PR before the laptop is unavailable. If that subscription-backed session stops,
the GitHub gate deliberately leaves the PR unmerged rather than silently falling
back to an unreviewed path.
