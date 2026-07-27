# PMC Vitan Autonomous Build Loop

This repository is designed to progress without the owner's laptop or technical approval. GitHub is the durable control plane; conversations are not.

## Roles

| Role | Responsibility |
| --- | --- |
| Cloud runner | Read `docs/STATUS.md`, start the current work item, and never skip ahead |
| Claude Code | Author code, tests, migrations, packets, and corrections on `claude/**` |
| Codex Cloud | Independently review every PR head using `AGENTS.md`; never implement its own findings |
| GitHub | Hold draft PRs, run required CI, enforce current-head review presence, and merge |
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
2. Claude starts from latest `origin/main`, records the base SHA, and opens a draft PR.
3. A review of the current head is REQUESTED automatically (see "Review trigger chain" below), and Codex reviews it. Every corrective push invalidates the prior head review and requests another.
4. Claude reproduces every blocking finding at the reviewed base, fixes it forward, and keeps the PR draft.
5. Once the `codex-review-gate` check is green on the current head, Claude marks the PR ready.
6. GitHub requires `web`, `api`, `e2e`, `api-e2e`, `upgrade-proof`, and `codex-review-gate`; auto-merge then queues a squash merge.
7. Coolify deploys `main`. The runner updates `docs/STATUS.md` and begins the next work item.

No human approval is required. The owner may interrupt or redirect the loop, but is not a technical gate.

## Review Trigger Chain

Codex reviews on exactly three signals, which its own bot states on every review:

- a pull request is **opened for review** (not a draft),
- a **draft is marked ready**,
- someone comments **`@codex review`**.

A new push (`synchronize`) is *not* on that list. Neither is opening a draft. The loop above depends
on both, so nothing about it is automatic by default — and the failure is silent: the PR looks
healthy, CI is green, and the review simply never arrives. Step 3 therefore has two independent
request paths, and neither is a single point of failure:

| Path | Mechanism | Actor | Covers |
| --- | --- | --- | --- |
| A | `.github/workflows/codex-review.yml` | a Codex-connected user, via the `CODEX_REVIEW_TOKEN` secret | Every open/reopen/push/ready, within seconds, once per head SHA |
| B | The Claude review sweep | the repository owner's own credentials | Any head path A left unreviewed — the backstop when the secret is unset or expired |

Both paths are idempotent per head SHA: they skip if Codex has already reviewed that head, and skip
if a request for that head is already in the thread.

**`@codex review` is a per-user command, and the author matters.** Both identities were tried on real
pull requests:

| Comment author | Codex's response |
| --- | --- |
| `github-actions[bot]` (`GITHUB_TOKEN`) | *"To use Codex here, create a Codex account and connect to github."* — no review (PR #231) |
| `JagPat` (repository owner) | 👀 acknowledgement, then a review — **on a draft** (PR #230) |

So `GITHUB_TOKEN` cannot drive this, and path A requires `CODEX_REVIEW_TOKEN`. Without that secret
the workflow **skips and says so** rather than posting a request Codex will refuse — an unanswered
`@codex review` in the thread is worse than none, because it looks like the loop is working.

The PR #230 result also settles a question worth recording: Codex **does** review a draft when asked
by a connected user. Only its *automatic* triggers exclude drafts.

## Merge Gate

`codex-review-gate` (`.github/workflows/codex-review-gate.yml`) is the enforcement point, and it is a
required status check on `main` with bypass disabled. It is green only when Codex has reviewed the
**exact current head** and that review carries no blocking finding. Its verdict comes from, in order:

1. an explicit `VERDICT: CLEAN` / `VERDICT: CHANGES_REQUIRED` line (the contract in `AGENTS.md`);
2. failing that, whether the head's Codex review left inline findings — inferred, and labelled as
   inferred in the check output;
3. no review for this head at all → the gate fails as pending. Absence is never approval.

The draft flag remains the convention, but it is no longer what enforces the rule: a draft can be
marked ready by anyone, while a required check cannot be bypassed. If the two ever disagree, the
check is authoritative.

## Non-Negotiable Safety Rules

- Review happens before merge, especially for migrations.
- Deployed migration bytes are immutable; corrections use new forward migrations.
- A PR remains draft while any Codex finding is unresolved.
- Claude does not self-certify a Codex finding as closed; Codex re-reviews the new head.
- Task N+1 never starts while `docs/STATUS.md` keeps Task N open.
- Credentials and raw transcripts never enter Git. In particular, never commit Coolify tokens, SMTP credentials, database passwords, `.env` contents, or local attachments.

## Recovery

When an accidental merge or stale state occurs:

1. Stop the next task.
2. Review the exact merged tree.
3. Record validated findings in a focused directive.
4. Change `docs/STATUS.md` back to `in_progress` for the correction.
5. Fix forward from current `main`; never rewrite deployed history.

## Current Position

Phase 4 Task 3 requires correction round 3 after the post-merge review of PR #226. See `docs/STATUS.md` and `docs/reviews/phase-4-t3-correction3-directive.md`. Task 4 is blocked until that correction receives a clean current-head Codex review and merges.

## External Dependencies

The Codex Cloud GitHub review integration and GitHub Actions operate without the owner's computer. Starting and correcting work requires a separately configured cloud runner for Claude Code. Repository state is prepared for that runner; its provider credentials and schedules must remain in the provider's managed configuration, not this repository.

## Owner-Configured Settings (not in this repository)

These live in GitHub's UI and cannot be committed. Until the branch-protection ones are set, the gate
is advisory: it reports the right verdict, but nothing stops a merge past it.

**Settings → Secrets and variables → Actions → `CODEX_REVIEW_TOKEN`:** a fine-grained personal access
token belonging to a GitHub account **with Codex connected**, scoped to this repository with
`Pull requests: read & write`. This is what lets `codex-review.yml` request reviews automatically;
without it that workflow skips and the Claude review sweep is the only request path. Rotate it on the
same schedule as any other credential — the workflow degrades to "skipped", never to a false green.

**Settings → Branches → branch protection for `main`:**

- Require status checks to pass before merging, with these six required:
  `web`, `api`, `e2e`, `api-e2e`, `upgrade-proof`, `codex-review-gate`.
- Require branches to be up to date before merging.
- **Do not allow bypassing the above settings** — without this an admin (or an agent acting as one)
  can merge straight past the review gate, which is exactly what the gate exists to prevent.

**Settings → General → Pull Requests:** allow auto-merge, so `auto-merge.yml` can queue the squash
merge behind those checks.
