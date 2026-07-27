# Autonomous Review Loop Design

## Objective

PMC Vitan must continue its phase plan without requiring the owner's laptop or technical approval. Claude Code authors and corrects changes; Codex Cloud remains the independent reviewer. GitHub is the durable control plane and Coolify deploys only merged `main`.

## Source Of Truth

- `docs/STATUS.md` is the machine-readable current state.
- The active phase plan defines task scope and review stops.
- `AGENTS.md` defines Codex review rules.
- `CLAUDE.md` tells Claude which state and directive files to read first.
- Review packets provide evidence but never override `docs/STATUS.md`.
- Chat transcripts are not project memory: they are large, stale quickly, and may contain credentials.

## Roles And Flow

1. A cloud runner reads `docs/STATUS.md` and starts only the current work item.
2. Claude Code implements on `claude/**` and opens a draft PR.
3. Codex Cloud reviews every pushed head while the PR remains draft.
4. Claude fixes blocking findings reproduce-first and pushes a new head.
5. Claude marks the PR ready only after Codex reports no blocking finding on that exact head.
6. Required CI passes, GitHub queues the squash merge, and Coolify deploys `main`.
7. The runner advances `docs/STATUS.md` and starts the next task.

No human approval is required. Review still happens before merge. Codex never implements its own findings, preserving author/reviewer independence.

## Cloud Boundary

Codex Cloud obtains code, rules, plans, and state from a fresh GitHub clone. Local Codex skills, attachments, uncommitted files, and this conversation are unavailable and must not be required. Project-specific judgment therefore belongs in `AGENTS.md`; current work belongs in `docs/STATUS.md` and a checked-in directive.

No Coolify token, SMTP password, database password, chat transcript, or local attachment may be committed. Cloud secrets belong only in the relevant managed environment.

## Failure Handling

- A draft PR cannot merge.
- Auto-merge must find a Codex review tied to the current head SHA.
- Claude must not mark a PR ready when that review contains a blocking finding.
- Migration corrections are additive; deployed migration bytes never change.
- If CI, review, or deployment fails, the current task remains current and the runner must not start the next task.
- If `docs/STATUS.md` conflicts with narrative history, `docs/STATUS.md` wins and the conflict is corrected in the active PR.

## Current Recovery Point

PR #226 merged before its head was reviewed. Post-merge review found three valid issues, so Phase 4 Task 3 remains open as correction round 3. The required correction is specified in `docs/reviews/phase-4-t3-correction3-directive.md`; Task 4 remains blocked.

## Acceptance

- A new cloud session can determine the exact current task from the repository alone.
- Codex can review without this conversation or the owner's laptop.
- Claude can implement a finding without asking the owner to translate it.
- No secret from prior chats appears in the repository.
- The next task cannot begin while `docs/STATUS.md` identifies a blocking correction.
