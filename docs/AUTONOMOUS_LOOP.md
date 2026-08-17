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
3. GitHub first runs the two dependency-free gates `review-scope` and `battery-plan`, then requires `web`, `api`, `e2e`, `api-e2e`, and `upgrade-proof`. An unjustified broad review unit stops before the expensive jobs. A first product-CI failure receives one GitHub-native failed-job retry; deterministic `review-scope` failures do not. A second product failure remains draft and blocked for a real correction. When all seven pass on the current head, the trusted default-branch workflow sets `codex-current-head` pending and marks the draft ready.
4. Marking the PR ready triggers Codex. The same exact-head workflow run polls that one invocation to its terminal result and accepts only evidence from `chatgpt-codex-connector[bot]` for the current SHA and review cycle. Review and review-comment webhooks never start or mutate the merge workflow.
5. A current-head finding fails `codex-current-head` and returns the PR to draft. Claude Auto-fix reproduces the complete first-round finding set and may push one coherent correction; that push invalidates every prior clearance. If the correction head also receives findings, the trusted owner stops that PR and requires a newly scoped replacement from current `main`.
6. A fresh current-head clean Codex signal succeeds `codex-current-head`. GitHub then squash-merges that exact reviewed SHA immediately when the PR is clean. If GitHub still reports a waiting state, the controller queues squash auto-merge with the same expected head OID; a clean-state race retries the exact-SHA merge once. Missing CI, stale evidence, timeout, or inactive authoring all fail closed.
7. The merge controller explicitly dispatches the trusted handoff workflow because GitHub suppresses ordinary workflow events produced by `GITHUB_TOKEN`. The dispatch is retried three times, and an hourly GitHub-side watchdog drains the durable cursor if the immediate dispatch is interrupted. The handoff waits for a queued merge when necessary, always drains merged work and conflict state before rescheduling an open wait target, and posts one marked `@claude` continuation. Coolify deploys `main`; the runner updates `docs/STATUS.md` and begins the next work item only after merge.

## Review Units And Round Reset

- A standard PR is one user workflow or one architectural concern, at most 20
  files and 1,500 changed lines. PR #247 and later are enforced; earlier PRs are
  grandfathered and retain the original five required checks — neither
  `review-scope` nor `battery-plan` is required of them — so an older branch
  cannot be stranded by a job it does not contain.
- A justified large PR uses the PR template's marker and completes all six risk
  rows: authorization/tenancy, civil time/lifecycle, concurrency/idempotency,
  data integrity/conservation, offline/reconciliation, and UI/server parity.
- For PR #346 and later, the pre-review checklist covers concurrency and
  serialization, old-release migration compatibility, triggers and alternate
  writers, authorization and tenancy, and reproduce-first CI. The gate reads the
  cumulative file list and fails closed if that evidence cannot be inspected.
- Migration changes use a separate review unit from service or UI work whenever
  there is a viable seam. The rare inseparable unit carries
  `<!-- migration-scope: inseparable -->` and explains the concrete compatibility
  boundary; a checked box or marker never replaces the underlying proof.
- The PR-side scope check is fast feedback. The trusted default-branch owner
  re-evaluates the PR metadata and every evidence cell before review promotion,
  so editing the PR's policy script cannot bypass the merge boundary.
- Product CI runs once per SHA, in ONE workflow. Every PR event (including
  `edited`) runs through `ci.yml`, so a completed CI run always wakes the
  trusted owner; the cheap `battery-plan` job gates the five product jobs — a
  metadata-only body/title edit whose head already has real product runs skips
  them, while a base retarget (`changes.base`) or a head whose product jobs
  never really ran (a large PR whose first run failed `review-scope`) gets the
  full battery. The required-check summary reads the newest REAL run per check
  name: a skipped run defers to the evidence it kept, and a stale failure
  never outlives a newer passing run. `scripts/autonomous-ci-battery.test.mjs`
  and the gate tests pin all of this.
- Claude self-audits those rows before the first review. Codex performs one
  comprehensive first pass and batches all findings. Correction reviews cover
  the delta, prior findings, and affected adjacent invariants.
- After two distinct Codex finding-bearing heads, the current PR is exhausted:
  no third correction head is accepted. Close it and open a smaller replacement
  from current `main`, limited to the unresolved review unit and carrying
  `Replaces: #<closed-pr>` in the body. Historical convergence packets and
  trailers cannot reset this count.
- The replacement receives a fresh comprehensive review and the full applicable
  CI battery. Resetting the PR bounds accumulated patch risk; it does not waive,
  dismiss, or downgrade any finding.

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
  --jq 'def active_pending: .state == "pending" and ((.description // "") | startswith("review: pending") or startswith("Waiting for required CI")); def retryable: .state == "failure" and ((.description // "") as $description | ($description | contains("Codex review timed out")) or ($description | contains("Codex evidence changed during final verification")) or $description == "review: Required CI changed during current-head Codex review" or $description == "review: bootstrap exact-head review requested"); def persistent: .state == "failure" and (((.description // "") | startswith("review:") or contains("current-head Codex finding") or contains("Codex submitted a current-head review")) and (retryable | not)); add | map(select(.context == "codex-current-head")) as $statuses | ($statuses[0] // {}) as $latest | if any($statuses[]; persistent) then empty elif ($latest | active_pending) then $latest.id else ($statuses | map(select(retryable)) | (.[0].id // empty)) end')
test -n "$TERMINAL_STATUS_ID"
gh workflow run auto-merge.yml --repo JagPat/PMCvitan \
  -f pr_number="$PR" -f head_sha="$HEAD_SHA" \
  -f terminal_status_id="$TERMINAL_STATUS_ID"
```

All three inputs are required. The workflow refuses a stale SHA and authorizes a
retry only when `terminal_status_id` identifies either the exact active review-
pending status or the exact latest retryable terminal failure on that head. The
input name is retained for workflow-dispatch compatibility. Pending recovery
replaces the abandoned owner through the same concurrency lane; it cannot create a
second owner. Timeout, changed-CI, changed provider evidence, and the documented
bootstrap marker are retryable. A current-head Codex finding or review is not:
Claude must fix it and push a new SHA. Successful, finding-bearing, superseded, or
non-current pending status IDs fail closed.
The dispatch job only writes a durable `codex-recovery-request/<terminal-id>`
marker; it never
changes draft state, invokes Codex, publishes `codex-current-head`, or queues a
merge. Both normal CI and recovery then enter the same job-level concurrency group
for that PR and exact head. That one serialized owner performs every review and
merge mutation. If GitHub replaces a queued owner job, the durable request remains
pending and the next owner consumes it. Duplicate dispatches may refresh the same
request, including after an interrupted owner, but cannot create a concurrent
reviewer. Per-terminal contexts prevent an older owner from consuming a newer
request. A request is consumed only after a terminal review outcome; CI failure
leaves it pending for the next green owner.
Before publishing a new pending status or changing readiness, the owner checks live
current-head Codex reviews and inline comments. A finding that arrived after a
timeout is republished as the required failure and requires a new SHA; recovery
cannot trigger another review of that finding-bearing head.
The owner rechecks required CI immediately before publishing review success.
Ordinary CI recovery searches the complete paginated status history, including
terminal review results hidden below legacy `pending` or `ci:` statuses. Review
success can be reused without another trigger only while the PR is already ready.
If legacy CI left the PR draft, the owner enters the normal ready-and-poll path and
requires a fresh exact-head result before completing the merge. Review
and review-comment webhooks are intentionally not orchestrator triggers. The Codex
App's finding comments still wake the subscription-backed Claude Auto-fix session
directly; GitHub Actions does not need an AI key or a second result writer.

## GitHub Enforcement

After the autonomous workflow is merged **and PR #246 has merged or closed**, add
the new check to `main` protection. Waiting for that terminal state prevents
GitHub branch protection from requiring a job the legacy branch cannot emit.
**That precondition is met as of 2026-07-29 — PR #246 merged at `main`
`67e7a00` — so the settings below should be applied now.** Branch protection is
a repository admin setting (Settings → Branches → `main`); the autonomous
tooling has no admin credential and cannot apply it, so this step is the
owner's. The resulting exact settings are:

- Require status checks: `review-scope`, `battery-plan`, `web`, `api`, `e2e`, `api-e2e`,
  `upgrade-proof`, and `codex-current-head`. `battery-plan` decides whether the five product
  jobs run, so requiring it is what makes a failed planner visible instead of leaving five
  silently skipped products beneath a green summary.
- Require branches to be up to date before merging (`strict: true`).
- Enforce the protection for administrators.
- Keep squash auto-merge enabled for the waiting-state fallback.

Do not add `codex-current-head` before the workflow is present on the default
branch; doing so would intentionally block every PR, including the bootstrap PR.

## Current Position

Phase 4 is complete (PR #246 merged at `main` `67e7a00`). Phase 5 planning is the
recorded `next_task` in `docs/STATUS.md` and is in progress on draft PR #252
(branch `claude/phase5-planning`). The autonomous handoff workflow posts
`@claude` continuation comments after each exact-head merge and, on the hourly
cron, a drift shepherd when `open_pr: none` disagrees with live open `claude/**`
PRs. See `docs/STATUS.md` and `scripts/runner-continuation.mjs`.

## External Dependencies

The Codex GitHub review integration, GitHub Actions, and Claude Code web Auto-fix
operate without the owner's computer. Codex and Claude use the owner's product
subscriptions; GitHub stores no AI API key. Claude Auto-fix must be enabled on the
PR before the laptop is unavailable. If that subscription-backed session stops,
the GitHub gate deliberately leaves the PR unmerged rather than silently falling
back to an unreviewed path.

## Review-round reset

The round limit applies uniformly to code, migrations, UI work, and documentation.
After the first finding-bearing head, the author may make one batched correction
that reproduces and addresses the complete set. If that correction head also has a
finding, the trusted owner publishes `replacement_required`, returns the PR to
draft, and does not invoke Codex again for another head on that PR.

The author closes the exhausted PR and starts from current `main`. The replacement
body declares `Replaces: #<closed-pr>`, carries forward every unresolved finding
and its reproduction, and narrows the diff to one reviewable unit. Work already
merged to `main` is not replayed. Unrelated service, UI, refactor, or migration work
moves to separate PRs; migration and service/UI code remain together only when the
template records why no safe compatibility seam exists.

This is a review-unit reset, not a finding reset. The replacement runs the full
applicable CI battery, receives a fresh comprehensive Codex review, and still fails
closed on any current-head finding. A convergence packet, commit trailer, extra
commit, or body edit on the exhausted PR cannot create another review round.
