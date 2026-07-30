# CURSOR.md

Guidance for Cursor Cloud Agents working in the PMC Vitan repository.

Cursor complements the autonomous loop; it does not replace Claude Code (implementation)
or Codex (independent review). Read this file after `docs/STATUS.md` and
`docs/AUTONOMOUS_LOOP.md`.

## Role in the loop

| Role | Agent | Branch prefix | Merge gate |
| --- | --- | --- | --- |
| Phase implementation + corrections | Claude Code web | `claude/` | CI + `codex-current-head` |
| Independent review | Codex Cloud | — | never implements |
| Planning scout, maintenance, repro, advisory | Cursor Cloud | `cursor/` | same gate when PR'd |

Cursor is strongest **upstream** (planning research), **aside** (maintenance queue,
ops health), and **between** (RED repro probes, convergence synthesis drafts). It
must not compete with Claude on an open phase PR or self-certify Codex findings.

## Authoritative read order

1. `docs/STATUS.md` — current task, maintenance queue, `blocking_directive`
2. `docs/AUTONOMOUS_LOOP.md` — cycle, gates, recovery
3. `AGENTS.md` — integrity rules (apply when reviewing or reproducing findings)
4. Active `phase_plan` named by STATUS
5. `CLAUDE.md` and architecture docs for broader context

`docs/ROADMAP.md` and review packets are historical evidence.

## When to use Cursor

**Do use Cursor for:**

- Maintenance queue items (`dependabot-security-updates`, `e2e-flake-burndown`)
- Phase N planning research and draft sections (commit on `claude/phase*-plan-*` for
  autonomous handoff, or open a `cursor/` PR for owner review)
- Reproducing Codex findings RED before Claude fixes (local probes only; no PR unless asked)
- Convergence packet drafts after two finding-bearing heads
- Owner-directed architecture advisory and loop health audits
- Investigating flakes, CI failures, and upgrade-path proofs

**Do not use Cursor for:**

- Replacing Codex as reviewer
- Implementing on an open `claude/**` PR head
- Bypassing `codex-current-head`, convergence trailer, or review-scope limits
- Adding AI API keys to GitHub Actions
- Editing deployed migration bytes

## Branch and PR conventions

- Cursor feature branches: `cursor/<descriptive-name>-9d2e`
- One focused concern per PR; standard budget 20 files / 1,500 lines unless justified
- Open as draft; enable Claude Code web Auto-fix if the PR will ride the autonomous gate
- Every PR through the gate needs the PR template invariant matrix and a review packet
  when the active plan requires one

`claude/**` branches receive automatic `@claude` handoff after merge. `cursor/**`
maintenance PRs merge through the same CI + Codex gate but do not trigger the
phase-task handoff unless explicitly wired in `scripts/autonomous-handoff.mjs`.

## Maintenance queue (standing work)

When STATUS shows `open_pr: none` and no `blocking_directive`, work the maintenance
queue top-down:

1. `dependabot-security-updates` — raise vulnerable dependencies; one coherent group per PR
2. `e2e-flake-burndown` — one flake family per PR; reproduce-first deterministic waits

These are already-authorized upkeep, not new product scope.

## Codex finding handoff

When supporting an open review:

1. Read the finding on the exact PR head (`refs/pull/<n>/head`, never the synthetic merge SHA)
2. Reproduce RED at the stated base with a focused probe
3. Record inputs, interleaving, and expected invariant in a comment or packet section
4. Leave implementation to Claude Auto-fix on the `claude/**` branch

Never assert a commit SHA you did not read from the diff or PR head.

## Phase planning support

Phase plans follow the Phase 3/4 shape: §A–§H design decisions, task order, review stops,
explicit reuse of prior-phase facts. Cursor may draft sections; the plan PR that clears
architecture review should land on `claude/phase*-plan-*` so the runner can continue.

As of setup, Phase 5 planning is in flight on PR #252 (`claude/phase5-planning`).

## Verification before push

- `pnpm check` for any code change
- `pnpm test:automation` when touching `scripts/autonomous-*` or review policy
- Full gate battery (`upgrade-proof`, e2e) for dependency, schema, or migration changes
- Update `docs/STATUS.md` in the same PR when the work changes runner-visible state
