# Autonomous Review Loop Handoff Implementation Plan

> **Historical plan:** PR #229 completed this repository handoff. Review and
> merge orchestration is superseded by
> `2026-07-27-subscription-autonomous-review-loop.md`.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Codex Cloud review and Claude Code correction work from GitHub alone while accurately blocking Phase 4 Task 4 on the validated Task 3 correction.

**Architecture:** Repository files form the control plane: `docs/STATUS.md` stores current state, `AGENTS.md` stores reviewer rules, `CLAUDE.md` points the author at state, and a focused directive defines the correction. The raw conversation and all credentials stay outside Git.

**Tech Stack:** Markdown, GitHub pull requests, Codex Cloud auto-review, Claude Code, GitHub Actions.

## Global Constraints

- Documentation and agent-state only; no runtime code or migration changes.
- Never commit credentials, chat transcripts, local attachments, or untracked local files.
- Preserve deployed migration history.
- Codex reviews; Claude implements.

---

### Task 1: Durable Cloud Handoff

**Files:**
- Create: `docs/AUTONOMOUS_LOOP.md`
- Modify: `CLAUDE.md`

**Interfaces:**
- Consumes: GitHub repository state and the active phase plan.
- Produces: A laptop-independent entry point for Claude and Codex.

- [ ] **Step 1:** Document the role split, pre-merge lifecycle, source-of-truth order, secret boundary, and recovery behavior.
- [ ] **Step 2:** Add a short control-plane preamble to `CLAUDE.md` without rewriting its historical record.
- [ ] **Step 3:** Verify every referenced repository path exists.

### Task 2: Correct Review Rules And State

**Files:**
- Modify: `AGENTS.md`
- Modify: `docs/STATUS.md`

**Interfaces:**
- Consumes: Codex auto-review on every PR push and the PR #226 merge state.
- Produces: Accurate reviewer instructions and a machine-readable Task 3 block.

- [ ] **Step 1:** Correct the non-blank rule to the complete ASCII whitespace set.
- [x] **Step 2:** State that trusted GitHub automation marks a CI-green head ready,
  then requires a fresh exact-head Codex result before merge.
- [ ] **Step 3:** Record Task 3 correction round 3 as current and keep Task 4 `not_started`.

### Task 3: Correction Round 3 Directive

**Files:**
- Create: `docs/reviews/phase-4-t3-correction3-directive.md`

**Interfaces:**
- Consumes: Reviewed merge `2a6112b` and the three validated findings.
- Produces: Exact implementation boundaries, reproduce-first probes, and acceptance gates for Claude.

- [ ] **Step 1:** Specify evidence-preserving attendance repair without deletion or fabricated justification.
- [ ] **Step 2:** Specify an Activities-owned participant operation that locks and returns the head in one transaction.
- [ ] **Step 3:** Specify acquisition of the existing project-readiness advisory lock before raw-allocation row locks.
- [ ] **Step 4:** Require RED-at-base probes, full gates, an additive migration, and a held draft PR.

### Task 4: Verification And Delivery

**Files:**
- Verify: all files above

**Interfaces:**
- Consumes: Completed documentation changes.
- Produces: A focused reviewable PR with no runtime effect.

- [ ] **Step 1:** Run path, stale-state, placeholder, and secret-pattern scans.
- [ ] **Step 2:** Inspect `git diff --check` and confirm only intended documentation files changed.
- [ ] **Step 3:** Commit, push `codex/cloud-review-handoff`, and open a draft PR.
