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
5. A current-head finding fails `codex-current-head` and returns the PR to draft. Claude Auto-fix reproduces the finding, fixes forward, and pushes a new head; that push invalidates every prior clearance.
6. A fresh current-head clean Codex signal succeeds `codex-current-head`. GitHub then squash-merges that exact reviewed SHA immediately when the PR is clean. If GitHub still reports a waiting state, the controller queues squash auto-merge with the same expected head OID; a clean-state race retries the exact-SHA merge once. Missing CI, stale evidence, timeout, or inactive authoring all fail closed.
7. The merge controller explicitly dispatches the trusted handoff workflow because GitHub suppresses ordinary workflow events produced by `GITHUB_TOKEN`. The dispatch is retried three times, and an hourly GitHub-side watchdog drains the durable cursor if the immediate dispatch is interrupted. The handoff waits for a queued merge when necessary, always drains merged work and conflict state before rescheduling an open wait target, and posts one marked `@claude` continuation. Coolify deploys `main`; the runner updates `docs/STATUS.md` and begins the next work item only after merge.

## Review Units And Convergence

- A standard PR is one user workflow or one architectural concern, at most 20
  files and 1,500 changed lines. PR #247 and later are enforced; earlier PRs are
  grandfathered and retain the original five required checks — neither
  `review-scope` nor `battery-plan` is required of them — so an older branch
  cannot be stranded by a job it does not contain.
- A justified large PR uses the PR template's marker and completes all six risk
  rows: authorization/tenancy, civil time/lifecycle, concurrency/idempotency,
  data integrity/conservation, offline/reconciliation, and UI/server parity.
- The PR-side scope check is fast feedback. The trusted default-branch owner
  re-evaluates the PR metadata and every evidence cell before review promotion,
  so editing the PR's policy script cannot bypass the merge boundary.
- Product CI runs once per SHA, in ONE workflow. Docs-only PRs use a fast
  path: `review-scope`, `battery-plan`, and `automation` (`pnpm test:automation`)
  instead of web/api/e2e/api-e2e/upgrade-proof. Code PRs keep the full battery.
  Every PR event (including `edited`) runs through `ci.yml`, so a completed CI
  run always wakes the trusted owner; the cheap `battery-plan` job gates the
  five product jobs — a metadata-only body/title edit whose head already has
  real product runs skips them, while a base retarget (`changes.base`) or a head
  whose product jobs never really ran (a large PR whose first run failed
  `review-scope`) gets the full battery. The required-check summary reads the
  newest REAL run per check name: a skipped run defers to the evidence it kept,
  and a stale failure never outlives a newer passing run. `scripts/autonomous-ci-battery.test.mjs`
  and the gate tests pin all of this.
- Claude self-audits those rows before the first review. Codex performs one
  comprehensive first pass and batches all findings. Correction reviews cover
  the delta, prior findings, and affected adjacent invariants.
- After two distinct Codex finding heads, the next head must carry
  `Review-Convergence: complete` and include a changed
  `docs/reviews/*convergence*.md` packet. The trusted gate checks both before
  promoting the head. Missing evidence leaves the PR draft and fail-closed.
- Convergence does not waive a defect. CI and Codex still run in full, and any
  remaining correctness finding still blocks the exact head.

No human approval is required. The owner may interrupt or redirect the loop, but is not a technical gate.

## Loop speed

Three mechanisms keep the autonomous loop fast without weakening code review:

1. **Docs-only fast CI** — when the cumulative PR diff is documentation only,
   CI runs `review-scope`, `battery-plan`, and `automation` instead of the five
   product jobs. Exact-head Codex review is unchanged.
2. **Phase plan skeleton limit** — after PR #252, a single
   `docs/superpowers/plans/*.md` file may add at most 900 lines per PR. Larger
   plans must split: cross-cutting skeleton in planning, per-task detail in
   implementation PRs where probes adjudicate.
3. **Bounded plan review** — after three finding-bearing heads on a docs-only
   diff, remaining questions move to named probes (`Review-Deferred-To-Probes`).

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

Phase 4 Task 5 is merged and cleared (PR #245 at `main` `d8a9c50` — a fresh clean Codex +1 on the
exact head `119816b`; twelve findings across three in-branch Codex rounds all fixed with
reproduce-first probes; one gate recovery dispatch was needed after a transient double Codex
timeout, validated against the exact terminal `codex-current-head` status ID). Phase 4 Task 6
(§J frontend surfaces + the pilot acceptance chain + the consolidated Phase-4 packet) is
DELIVERED on draft PR #246 (branch `claude/phase4-task6` from `main` `d8a9c50`) riding the
exact-head `codex-current-head` gate — the FINAL Phase-4 review stop. The Labour hub, store
slice, field ops, extended surfaces, web suite and the real-browser labour-pilot acceptance
chain are frontend-only (no schema, no migration, no API change) over the cleared Tasks 1–5
facts. See `docs/STATUS.md`, `docs/reviews/phase-4-t6-frontend-packet.md` and
`docs/reviews/phase-4-consolidated-review-packet.md`.

## External Dependencies

The Codex GitHub review integration, GitHub Actions, and Claude Code web Auto-fix
operate without the owner's computer. Codex and Claude use the owner's product
subscriptions; GitHub stores no AI API key. Claude Auto-fix must be enabled on the
PR before the laptop is unavailable. If that subscription-backed session stops,
the GitHub gate deliberately leaves the PR unmerged rather than silently falling
back to an unreviewed path.

## Bounded plan review (`Review-Deferred-To-Probes`)

The convergence protocol terminates on code because every finding is answered by a
RED→GREEN probe. A plan has no executable surface, so a finding on it can only be
answered with more prose — and a plan can always be specified further. PR #252 ran
four finding-bearing heads (8, 8, 7, 7; every finding correct, no declining rate)
before this was written down.

So: after **3 finding-bearing heads on a docs-only diff**, the next head must
convert each still-open question into a named probe in the plan and carry
`Review-Deferred-To-Probes: <task>`, naming the task whose review stop will settle
them. `assessConvergence` enforces it.

**What the gate verifies, and what it deliberately does not.** The gate checks ONE thing about
the deferral: the trailer value names a TASK — `phase-<n>-task-<m>` or `phase-<n>-planning`, this
repository's own vocabulary. An allowlist, not a list of rejected placeholders, so a value like
`later` names no task and is refused. The PHASE is also checked against `docs/STATUS.md` — the
phase `next_task` names, plus the current phase WHILE IT STILL HAS OPEN WORK — so
`phase-999-task-999` is refused, and so is a deferral to a phase whose last task has merged: a
deferral hands work to a review stop that is still ahead, and one that is closed or in a later
phase settles nothing. That is a structured-field read of a machine-readable state file, which is
the class of check a gate can make. The task INDEX inside a valid phase is not checked; it lives
in the plan's markdown task table, and reading that is the prose parsing described below.

**The phase check fails closed when it cannot be made.** Two ways it cannot: STATUS did not parse,
or the PR ITSELF edits `docs/STATUS.md`, in which case the default-branch copy the gate reads is
not that PR's phase truth (a head closing phase 5 while deferring into `phase-5-task-1` would
otherwise pass on the pre-merge state). Both block with their own reason, because an unprovable
phase is not a proven one. The second is detected from the PR's FILE LIST, which the gate already
fetches — it does NOT read the head's STATUS content, since a write-capable workflow checks out
only the trusted default branch.

The **deferral ledger** — each still-open question with the probe that adjudicates it, and each
probe named in the plan — is an author obligation stated in `AGENTS.md` and judged by the
REVIEWER. It is not machine-checked, and PR #253 tried four times before concluding it should not
be. Telling a question from a bare probe list, or a probe declaration from an ordinary numbered
heading like `5. **Task 5 — frontend surfaces**`, requires reading for meaning; that is the
reviewer's side of the line this project drew after PR #250, where a mechanism that scored
substance would have suppressed a correct finding on its first real case. Two further facts
settled it: nothing about the check is load-bearing, because `codex-current-head` fails closed on
every current-head finding whether a deferral is claimed or not — so a forged ledger buys an
author nothing — and each added clause produced a new false pass or a new false block.

**"Docs-only" is a narrow, deliberately strict test.** It is judged on the PR's
CUMULATIVE diff, not on the current head's commit — a code PR's convergence head is
usually the packet alone, and reading that one commit would classify a provable review
as a plan review. Within that diff every file must be documentation by BOTH extension
(an allowlist: `.md`, `.mdx`, `.txt`, `.rst`, and image/PDF assets) and location
(`docs/`, `.github/`, or the repository root). A directory name alone decides nothing:
`docs/probes/x.test.mjs`, `docs/schema.prisma` and `docs/ci/deploy.yml` run, so a diff
carrying them is provable and stays under the ordinary code protocol. Deletions count
too — removing a script changes what runs. An empty diff or an unrecognised extension
fails toward the code path. A cumulative list the gate could not READ is different: past
the cap it blocks on the unreadability itself, because resolving it either way would guess
(toward code drops a real deferral obligation; toward docs demands a meaningless trailer).
The next event re-runs the read; below the cap nothing is owed, so nothing changes.

This is not a dismissal mechanism. A finding-dismissal engine was built in PR #250
and withdrawn because it would have suppressed a correct finding on its first real
case. Every finding is kept, `codex-current-head` still fails closed on every
current-head finding, and the only thing that moves is WHERE the remaining
questions get verified — from prose, where they cannot be, to probes, where they
can.
