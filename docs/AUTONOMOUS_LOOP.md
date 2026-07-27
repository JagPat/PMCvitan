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
3. Codex reviews the current head. Every corrective push invalidates the prior head review and triggers another review.
4. Claude reproduces every blocking finding at the reviewed base, fixes it forward, and keeps the PR draft.
5. Once Codex reports no blocking finding on the current head, Claude marks the PR ready.
6. GitHub requires `web`, `api`, `e2e`, `api-e2e`, and `upgrade-proof`; auto-merge then queues a squash merge.
7. Coolify deploys `main`. The runner updates `docs/STATUS.md` and begins the next work item.

No human approval is required. The owner may interrupt or redirect the loop, but is not a technical gate.

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
