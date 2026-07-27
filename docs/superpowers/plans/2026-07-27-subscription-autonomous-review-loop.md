# Subscription-Backed Autonomous Review Loop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a fail-closed GitHub state machine that uses Codex and Claude subscriptions to review, correct, and merge each exact PR head without AI API keys.

**Architecture:** A pure Node classifier converts GitHub reviews, inline comments, and reactions into a current-head Codex state. A trusted `workflow_run`/`workflow_dispatch` orchestrator waits for the five CI gates, toggles draft-to-ready to trigger Codex, publishes a required commit status, returns finding-bearing PRs to draft for Claude Auto-fix, and queues auto-merge only on a fresh clean result.

**Tech Stack:** GitHub Actions, GitHub CLI/REST API, Node.js 22 built-in test runner, existing Claude GitHub App Auto-fix, Codex GitHub automatic review.

## Global Constraints

- Do not add `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, AI actions, or AI credentials.
- Never check out pull-request code in a job with write permissions.
- Only open same-repository PRs may enter the autonomous state machine.
- Every push invalidates prior clearance because statuses are attached to the exact SHA.
- Missing CI, missing review, stale review, and author inactivity fail closed.
- Keep the five existing CI job names unchanged.

---

### Task 1: Current-Head Codex State Classifier

**Files:**
- Create: `scripts/autonomous-review-state.mjs`
- Create: `scripts/autonomous-review-state.test.mjs`
- Modify: `package.json`

**Interfaces:**
- Consumes: GitHub REST representations of pull-request reviews, inline review comments, and issue reactions.
- Produces: `classifyCodexState(input): { state, findingCount, detail }` and `isEligiblePullRequest(input): boolean`.

- [ ] **Step 1: Write fixture tests for clean, findings, stale evidence, timeout, and precedence**
- [ ] **Step 2: Run `node --test scripts/autonomous-review-state.test.mjs` and verify RED**
- [ ] **Step 3: Implement the minimal pure classifier and eligibility predicate**
- [ ] **Step 4: Run the focused tests and verify GREEN**
- [ ] **Step 5: Add `test:automation` and include it in root `pnpm check`**

### Task 2: Trusted GitHub Orchestrator

**Files:**
- Create: `scripts/autonomous-review-gate.mjs`
- Create: `scripts/autonomous-review-workflow.test.mjs`
- Replace: `.github/workflows/auto-merge.yml`
- Modify: `.github/workflows/ci.yml`

**Interfaces:**
- Consumes: `CI` workflow completion or a dispatched PR number, GitHub REST/GraphQL APIs, and `classifyCodexState`.
- Produces: exact-SHA `codex-current-head` commit status, sticky state comment, draft/ready transitions, and queued squash auto-merge.

- [ ] **Step 1: Write workflow/source contract tests that fail against the old existence-only merge gate**
- [ ] **Step 2: Run `node --test scripts/autonomous-review-workflow.test.mjs` and verify RED**
- [ ] **Step 3: Implement API helpers, CI aggregation, sticky comments, bounded polling, and draft/ready transitions**
- [ ] **Step 4: Replace the workflow with trusted `workflow_run` and `workflow_dispatch` orchestration**
- [ ] **Step 5: Add automation tests to the existing `web` CI job and run focused tests GREEN**

### Task 3: Repository Protocol Alignment

**Files:**
- Modify: `AGENTS.md`
- Modify: `CLAUDE.md`
- Modify: `docs/AUTONOMOUS_LOOP.md`
- Create: `docs/reviews/autonomous-review-loop-packet.md`

**Interfaces:**
- Consumes: the state machine and Claude Code web Auto-fix behavior.
- Produces: one unambiguous author/reviewer protocol and bootstrap evidence.

- [ ] **Step 1: Replace the impossible “Codex reviews drafts” rule with CI→ready→review**
- [ ] **Step 2: Require Claude cloud Auto-fix subscription until terminal PR state**
- [ ] **Step 3: Document fail-closed recovery and the exact branch-protection settings**
- [ ] **Step 4: Record base/head, tests, external setting changes, and PR #230 bootstrap steps**

### Task 4: Verification and Bootstrap

**Files:**
- Verify all files above.
- External: GitHub `main` branch protection after the automation PR merges.

**Interfaces:**
- Consumes: merged default-branch workflow.
- Produces: protected autonomous processing of PR #230.

- [ ] **Step 1: Run `pnpm test:automation`**
- [ ] **Step 2: Run `pnpm check`**
- [ ] **Step 3: Run workflow YAML and credential scans**
- [ ] **Step 4: Push the branch and open a draft bootstrap PR**
- [ ] **Step 5: Request Codex review while the bootstrap PR remains draft; fix any findings**
- [ ] **Step 6: After merge, require `codex-current-head`, enable strict/admin enforcement, and dispatch PR #230**

