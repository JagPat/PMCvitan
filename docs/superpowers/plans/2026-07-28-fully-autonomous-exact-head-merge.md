# Fully Autonomous Exact-Head Merge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete a clean, exactly reviewed pull request without a human merge while preserving branch protection and exact-head safety.

**Architecture:** The existing single-owner controller remains authoritative. After required CI and `codex-current-head` succeed, it first asks GitHub to squash-merge the reviewed SHA directly. If GitHub still reports a waiting state, it enables auto-merge; if that mutation races with the PR becoming clean, it retries the exact-SHA direct merge once.

**Tech Stack:** Node.js 22, GitHub REST and GraphQL APIs, GitHub Actions, Node test runner.

## Global Constraints

- No Anthropic or OpenAI API key enters GitHub Actions.
- Only the trusted default-branch workflow may mutate review or merge state.
- Every merge request includes the exact reviewed head SHA and uses `SQUASH`.
- GitHub branch protection remains the final authority; an unready direct merge must fail closed.
- The existing two-attempt Codex bound and recovery protocol remain unchanged.

---

### Task 1: Exact-head completion policy

**Files:**
- Modify: `scripts/autonomous-review-workflow.test.mjs`
- Modify: `scripts/autonomous-review-gate.mjs`

**Interfaces:**
- Consumes: current live pull request and exact reviewed head SHA.
- Produces: `completeReviewedPullRequest(client, pullRequest, expectedHead)` returning `merged` or `queued`.

- [ ] **Step 1: Write failing tests**

Cover clean direct merge, blocked auto-merge fallback, and the clean-state race after an initially blocked direct attempt.

- [ ] **Step 2: Verify RED**

Run `pnpm test:automation`; expect failure because `completeReviewedPullRequest` and `mergeExactHead` do not exist.

- [ ] **Step 3: Implement the minimal completion policy**

Add the exact-SHA REST merge method and route both recovered-clean and newly-clean review paths through the exported helper.

- [ ] **Step 4: Verify GREEN**

Run `pnpm test:automation`; expect every automation test to pass.

### Task 2: Protocol truth and full verification

**Files:**
- Modify: `docs/AUTONOMOUS_LOOP.md`
- Modify: `docs/superpowers/specs/2026-07-27-subscription-autonomous-review-loop-design.md`
- Modify: `docs/reviews/autonomous-review-loop-packet.md`

**Interfaces:**
- Consumes: Task 1 completion policy.
- Produces: operator-facing documentation that matches hosted behavior.

- [ ] **Step 1: Update protocol documentation**

Document direct exact-SHA merge for clean PRs, auto-merge only for waiting states, and the bounded race fallback.

- [ ] **Step 2: Run focused and full gates**

Run `pnpm test:automation` and `pnpm check`; both must exit 0.

- [ ] **Step 3: Push and open a draft PR**

Publish the branch for exact-head Codex review. Bootstrap-merge this workflow correction after the exact reviewed head is clean because the old default-branch controller still contains the defect.

- [ ] **Step 4: Prove the hosted path**

Observe the next autonomous PR reach required CI success, exact-head Codex success, and a GitHub-authored squash merge without a human merge action.
