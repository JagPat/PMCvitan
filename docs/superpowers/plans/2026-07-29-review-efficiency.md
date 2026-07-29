# Autonomous Review Efficiency Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enforce smaller review units and batched architectural convergence while preserving the repository's exact-head CI and Codex merge gate.

**Architecture:** A pure `review-efficiency` policy module owns scope and convergence decisions. A dependency-free CI entrypoint applies scope policy before expensive jobs, while the trusted default-branch orchestrator applies convergence policy before promoting a head to Codex. Agent documents and the PR template expose the same contract to Claude and Codex.

**Tech Stack:** Node.js 22 ESM, GitHub Actions, GitHub REST API, Node test runner, Markdown agent instructions.

## Global Constraints

- Keep `web`, `api`, `e2e`, `api-e2e`, and `upgrade-proof` mandatory.
- Keep `codex-current-head` exact-SHA and fail closed.
- Add no AI API key, third-party action, runtime dependency, product code, schema, or migration.
- Enforce scope beginning with PR #247; do not strand in-flight PR #246.

---

### Task 1: Pure Review-Efficiency Policy

**Files:**
- Create: `scripts/review-efficiency.mjs`
- Create: `scripts/review-efficiency.test.mjs`

**Interfaces:**
- Produces: `assessReviewScope(pullRequest, options)`, `codexFindingHeads(comments)`, and `assessConvergence({ comments, headMessage, changedFiles })`.

- [x] Write failing tests for standard, grandfathered, unjustified-large, incomplete-matrix, and justified-large PRs.
- [x] Verify the tests fail because the policy module does not exist.
- [x] Implement the minimum pure scope policy and verify those tests pass.
- [x] Write failing tests for distinct finding-head counting and the two-head trailer/packet convergence requirement.
- [x] Implement the minimum convergence policy and verify all policy tests pass.

### Task 2: Scope Preflight In CI

**Files:**
- Create: `scripts/review-scope.mjs`
- Modify: `.github/workflows/ci.yml`
- Modify: `scripts/autonomous-review-workflow.test.mjs`

**Interfaces:**
- Consumes: `assessReviewScope` and `GITHUB_EVENT_PATH`.
- Produces: required `review-scope` check that gates the five existing jobs.

- [x] Add failing workflow tests requiring a dependency-free `review-scope` job and `needs: review-scope` on all expensive jobs.
- [x] Add the CLI and workflow job.
- [x] Verify an oversized synthetic event fails and a standard event passes.
- [x] Verify the automation suite passes.

### Task 3: Convergence Enforcement In The Trusted Gate

**Files:**
- Modify: `scripts/autonomous-review-gate.mjs`
- Modify: `scripts/autonomous-review-workflow.test.mjs`

**Interfaces:**
- Consumes: historical Codex inline comments, exact-head commit message, and cumulative PR file list.
- Produces: fail-closed `convergence_required` state before Codex promotion.

- [x] Add failing tests for two prior finding heads with missing trailer, missing packet, and complete evidence.
- [x] Add exact-head commit and paginated PR-file reads to `GitHubClient`, then enforce convergence after CI but before ready transition.
- [x] Include finding-head count and actionable next step in the sticky state comment.
- [x] Verify all exact-head recovery and merge tests remain green.

### Task 4: Shared Author And Reviewer Contract

**Files:**
- Create: `.github/pull_request_template.md`
- Modify: `AGENTS.md`
- Modify: `docs/AUTONOMOUS_LOOP.md`
- Modify: `CLAUDE.md`

**Interfaces:**
- Produces: one documented invariant vocabulary used by the PR author, Codex reviewer, and convergence packet.

- [x] Add the review-unit markers and six-row invariant matrix to the PR template.
- [x] Require comprehensive first review, delta-plus-regression correction review, and batched findings in `AGENTS.md`.
- [x] Require Claude self-audit and convergence evidence after two finding heads.
- [x] Document rollout, branch protection, and operator-visible states.

### Task 5: Verification And Publication

**Files:**
- Modify only files listed above if verification exposes a defect.

**Interfaces:**
- Produces: one focused review-ready PR from `codex/review-efficiency`.

- [x] Run `pnpm test:automation`.
- [x] Run `pnpm check`.
- [x] Scan the diff for credentials, unrelated product changes, placeholders, and contradictory thresholds.
- [x] Commit, push, and open a draft PR with the invariant matrix completed.
