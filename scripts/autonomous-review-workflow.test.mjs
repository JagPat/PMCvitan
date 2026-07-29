import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';

import * as reviewGate from './autonomous-review-gate.mjs';

const {
  hasTerminalReviewFailureAfterPending,
  MAX_REVIEW_ATTEMPTS,
  REQUIRED_CHECKS,
  requiredChecksForPullRequest,
  summarizeRequiredChecks,
} = reviewGate;

const workflowPath = new URL('../.github/workflows/auto-merge.yml', import.meta.url);
const ciPath = new URL('../.github/workflows/ci.yml', import.meta.url);
const autonomousLoopPath = new URL('../docs/AUTONOMOUS_LOOP.md', import.meta.url);
const packagePath = new URL('../package.json', import.meta.url);

function checkRun(name, conclusion = 'success', status = 'completed') {
  return { name, conclusion, status };
}

function deferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function statusClient(statuses) {
  let nextId = 1_000;
  return {
    async setStatus(head, state, description, targetUrl, context) {
      const status = {
        id: nextId,
        context,
        state,
        description,
        target_url: targetUrl,
        sha: head,
      };
      nextId += 1;
      statuses.unshift(status);
      return status;
    },
  };
}

test('requires every named CI check to have a successful latest run', () => {
  const success = REQUIRED_CHECKS.map((name) => checkRun(name));
  assert.deepEqual(summarizeRequiredChecks(success), {
    state: 'success',
    missing: [],
    pending: [],
    failed: [],
  });

  assert.deepEqual(
    summarizeRequiredChecks(success.filter((run) => run.name !== 'web')),
    {
    state: 'pending',
    missing: ['web'],
    pending: [],
    failed: [],
    },
  );

  assert.deepEqual(
    summarizeRequiredChecks([
      ...success.filter((run) => run.name !== 'api'),
      checkRun('api', 'failure'),
    ]),
    {
      state: 'failure',
      missing: [],
      pending: [],
      failed: ['api'],
    },
  );
});

const PRODUCTS = ['web', 'api', 'e2e', 'api-e2e', 'upgrade-proof'];

test('duplicate check runs resolve by the newest real evidence per name', () => {
  const others = REQUIRED_CHECKS
    .filter((name) => name !== 'review-scope' && name !== 'battery-plan')
    .map((name) => checkRun(name))
    .concat(checkRun('battery-plan'));
  const at = (name, conclusion, startedAt, status = 'completed') => ({
    name,
    conclusion,
    status,
    started_at: startedAt,
  });

  // An edit that fixes a failing PR body: the newer passing scope run decides;
  // the stale failure from the first workflow run must not block forever.
  assert.deepEqual(
    summarizeRequiredChecks([
      ...others,
      at('review-scope', 'failure', '2026-07-29T07:00:00Z'),
      at('review-scope', 'success', '2026-07-29T07:10:00Z'),
    ]),
    { state: 'success', missing: [], pending: [], failed: [] },
  );

  // A newer failure is never masked by an older success.
  assert.deepEqual(
    summarizeRequiredChecks([
      ...others,
      at('review-scope', 'success', '2026-07-29T07:00:00Z'),
      at('review-scope', 'failure', '2026-07-29T07:10:00Z'),
    ]).failed,
    ['review-scope'],
  );

  // A metadata-only edit skips the product jobs; those skips defer to the older
  // real executions instead of erasing them — but only because the skipping
  // attempt COMPLETED (scope + plan both green), which is what makes the skip
  // the plan's deliberate decision. A skip with no attributable workflow run
  // cannot be shown to be deliberate and fails closed instead.
  const job = (name, conclusion, runId, stamp) => ({
    name,
    status: 'completed',
    conclusion,
    completed_at: stamp,
    html_url: `https://github.com/o/r/actions/runs/${runId}/job/1`,
  });
  assert.deepEqual(
    summarizeRequiredChecks([
      job('review-scope', 'success', '700', '2026-07-29T07:10:00Z'),
      job('battery-plan', 'success', '700', '2026-07-29T07:10:00Z'),
      ...PRODUCTS.flatMap(
        (name) => [
          job(name, 'success', '600', '2026-07-29T07:00:00Z'),
          job(name, 'skipped', '700', '2026-07-29T07:10:00Z'),
        ],
      ),
    ]),
    { state: 'success', missing: [], pending: [], failed: [] },
  );

  // A skip caused by an ABORTED attempt (its battery-plan failed, so the five
  // product jobs never ran) must NOT defer to the older evidence: that evidence
  // may predate the change the aborted attempt was testing.
  const inRun = (name, conclusion, runId, startedAt) => ({
    name,
    status: 'completed',
    conclusion,
    completed_at: startedAt,
    html_url: `https://github.com/o/r/actions/runs/${runId}/job/1`,
  });
  assert.deepEqual(
    summarizeRequiredChecks([
      inRun('review-scope', 'success', '900', '2026-07-29T10:30:00Z'),
      inRun('battery-plan', 'failure', '900', '2026-07-29T10:30:00Z'),
      ...PRODUCTS.map((n) =>
        inRun(n, 'success', '800', '2026-07-29T10:00:00Z')),
      ...PRODUCTS.map((n) =>
        inRun(n, 'skipped', '900', '2026-07-29T10:30:00Z')),
    ]).failed.sort(),
    // battery-plan is itself a required check, so its own failure is reported
    // alongside the five products whose skips can no longer be shown deliberate.
    ['api', 'api-e2e', 'battery-plan', 'e2e', 'upgrade-proof', 'web'],
  );

  // …but a skip from a COMPLETE attempt (scope + plan both green, so the plan
  // chose run_products=false) is the intentional one and defers as designed.
  assert.deepEqual(
    summarizeRequiredChecks([
      inRun('review-scope', 'success', '901', '2026-07-29T10:30:00Z'),
      inRun('battery-plan', 'success', '901', '2026-07-29T10:30:00Z'),
      ...PRODUCTS.map((n) =>
        inRun(n, 'success', '800', '2026-07-29T10:00:00Z')),
      ...PRODUCTS.map((n) =>
        inRun(n, 'skipped', '901', '2026-07-29T10:30:00Z')),
    ]),
    { state: 'success', missing: [], pending: [], failed: [] },
  );

  // Only skipped runs, and the skip cannot be attributed to a completed
  // attempt: fail closed. The skip becomes the decider and reads as a real
  // non-success rather than deferring to evidence that does not exist.
  assert.deepEqual(
    summarizeRequiredChecks([
      ...others,
      at('review-scope', 'skipped', '2026-07-29T07:10:00Z'),
    ]).failed,
    ['review-scope'],
  );

  // Recency is completion time, matching GitHub's own `latest` filter: a run
  // that started FIRST but finished LAST decides. Ordering by started_at would
  // let the 10:05→10:20 success mask the 10:00→10:30 failure and publish a
  // clean review status over a red latest check.
  assert.deepEqual(
    summarizeRequiredChecks([
      ...others,
      {
        name: 'review-scope',
        status: 'completed',
        conclusion: 'failure',
        started_at: '2026-07-29T10:00:00Z',
        completed_at: '2026-07-29T10:30:00Z',
      },
      {
        name: 'review-scope',
        status: 'completed',
        conclusion: 'success',
        started_at: '2026-07-29T10:05:00Z',
        completed_at: '2026-07-29T10:20:00Z',
      },
    ]).failed,
    ['review-scope'],
  );

  // Any in-progress run keeps the name pending regardless of older evidence.
  assert.equal(
    summarizeRequiredChecks([
      ...others,
      at('review-scope', 'success', '2026-07-29T07:00:00Z'),
      at('review-scope', null, '2026-07-29T07:10:00Z', 'in_progress'),
    ]).state,
    'pending',
  );
});

test('rollout cannot require the new scope check from pre-policy PR branches', () => {
  const legacyChecks = requiredChecksForPullRequest(246);
  assert.deepEqual(
    legacyChecks,
    REQUIRED_CHECKS.filter(
      (name) => name !== 'review-scope' && name !== 'battery-plan',
    ),
  );
  assert.equal(
    summarizeRequiredChecks(
      legacyChecks.map((name) => checkRun(name)),
      legacyChecks,
    ).state,
    'success',
  );
  assert.deepEqual(requiredChecksForPullRequest(247), REQUIRED_CHECKS);
});

test('review scope runs before every expensive product gate', async () => {
  assert.deepEqual(REQUIRED_CHECKS, [
    'review-scope',
    'battery-plan',
    'web',
    'api',
    'e2e',
    'api-e2e',
    'upgrade-proof',
  ]);

  const workflow = await readFile(ciPath, 'utf8');
  assert.match(
    workflow,
    /pull_request:\s*\n\s+types:\s*\[opened, synchronize, reopened, edited\]/u,
  );
  const scopeStart = workflow.indexOf('  review-scope:');
  const webStart = workflow.indexOf('  web:');
  assert.ok(scopeStart >= 0);
  assert.ok(webStart > scopeStart);
  const scopeJob = workflow.slice(scopeStart, webStart);
  assert.match(scopeJob, /node scripts\/review-scope\.mjs/u);
  assert.doesNotMatch(scopeJob, /pnpm install|setup-node|postgres/u);

  for (const job of ['web', 'api', 'e2e', 'api-e2e', 'upgrade-proof']) {
    const pattern = new RegExp(
      `  ${job}:[\\s\\S]*?needs: \\[review-scope, battery-plan\\]`,
      'u',
    );
    assert.match(workflow, pattern);
  }
});

test('keeps the Codex trigger retry bounded', () => {
  assert.equal(MAX_REVIEW_ATTEMPTS, 2);
});

test('only CI completion or exact-head dispatch can own a review cycle', () => {
  assert.equal(typeof reviewGate.contextForEvent, 'function');
  const head = 'a'.repeat(40);
  const pullRequest = { number: 230, head: { sha: head } };
  const codex = { login: 'chatgpt-codex-connector[bot]' };

  assert.equal(
    reviewGate.contextForEvent('pull_request_review', {
      action: 'submitted',
      pull_request: pullRequest,
      review: { user: codex, commit_id: head },
    }),
    null,
  );
  assert.equal(
    reviewGate.contextForEvent('pull_request_review_comment', {
      action: 'created',
      pull_request: pullRequest,
      comment: {
        user: codex,
        commit_id: head,
        original_commit_id: head,
      },
    }),
    null,
  );
  assert.equal(
    reviewGate.contextForEvent('pull_request_review', {
      action: 'submitted',
      pull_request: pullRequest,
      review: { user: codex, commit_id: 'b'.repeat(40) },
    }),
    null,
  );
  assert.equal(
    reviewGate.contextForEvent('pull_request_review_comment', {
      action: 'created',
      pull_request: pullRequest,
      comment: {
        user: { login: 'human-reviewer' },
        original_commit_id: head,
      },
    }),
    null,
  );
  assert.deepEqual(
    reviewGate.contextForEvent('workflow_dispatch', {
      inputs: {
        pr_number: '230',
        head_sha: head,
        terminal_status_id: '987654321',
      },
    }),
    {
      number: 230,
      expectedHead: head,
      terminalStatusId: '987654321',
      ciConclusion: null,
      trigger: 'dispatch',
    },
  );
  assert.deepEqual(
    reviewGate.contextForEvent('workflow_run', {
      workflow_run: {
        id: 30329510227,
        run_attempt: 1,
        event: 'pull_request',
        pull_requests: [{ number: 230 }],
        head_sha: head,
        conclusion: 'success',
      },
    }),
    {
      number: 230,
      expectedHead: head,
      ciConclusion: 'success',
      ciRunId: 30329510227,
      ciRunAttempt: 1,
      trigger: 'ci',
    },
  );
});

test('a first pre-review CI failure gets one GitHub-native retry', () => {
  assert.equal(typeof reviewGate.shouldRetryCiFailure, 'function');
  assert.equal(
    reviewGate.shouldRetryCiFailure({
      trigger: 'ci',
      ciConclusion: 'failure',
      ciRunId: 30329510227,
      ciRunAttempt: 1,
    }, null),
    true,
  );
  assert.equal(
    reviewGate.shouldRetryCiFailure({
      trigger: 'ci',
      ciConclusion: 'failure',
      ciRunId: 30329510227,
      ciRunAttempt: 2,
    }, null),
    false,
  );
  assert.equal(
    reviewGate.shouldRetryCiFailure({
      trigger: 'ci',
      ciConclusion: 'failure',
      ciRunId: 30329510227,
      ciRunAttempt: 1,
    }, {
      state: 'success',
      description: 'review: Codex found no blocking issue',
    }),
    false,
  );
  assert.equal(
    reviewGate.shouldRetryCiFailure({
      trigger: 'ci',
      ciConclusion: 'failure',
      ciRunId: 30329510227,
      ciRunAttempt: 1,
    }, null, ['review-scope']),
    false,
  );
});

test('the bounded CI retry has only the permission and endpoint it needs', async () => {
  const workflow = await readFile(workflowPath, 'utf8');
  const gate = await readFile(
    new URL('./autonomous-review-gate.mjs', import.meta.url),
    'utf8',
  );
  assert.match(workflow, /permissions:[\s\S]*actions:\s*write/);
  assert.match(gate, /actions\/runs\/\$\{runId\}\/rerun-failed-jobs/);
  // the skipped-run fallback can only see older real runs with filter=all
  assert.match(gate, /check-runs\?filter=all&per_page=100&page=\$\{page\}/u);
  assert.doesNotMatch(gate, /check-runs\?filter=latest/u);
  assert.match(gate, /context\.ciRunAttempt === 1/);
  assert.match(gate, /!isTerminalReviewStatus\(existingStatus\)/);
});

test('a CI rerun cannot reopen a terminal review cycle on the same head', () => {
  assert.equal(typeof reviewGate.isTerminalReviewStatus, 'function');
  assert.equal(
    reviewGate.isTerminalReviewStatus({
      state: 'failure',
      description: 'review: 3 current-head Codex findings',
    }),
    true,
  );
  assert.equal(
    reviewGate.isTerminalReviewStatus({
      state: 'failure',
      description: '11 current-head Codex findings',
    }),
    true,
  );
  assert.equal(
    reviewGate.isTerminalReviewStatus({
      state: 'failure',
      description: 'Codex submitted a current-head review',
    }),
    true,
  );
  assert.equal(
    reviewGate.isTerminalReviewStatus({
      state: 'success',
      description: 'review: Codex found no blocking issue',
    }),
    true,
  );
  assert.equal(
    reviewGate.isTerminalReviewStatus({
      state: 'failure',
      description: 'ci: api-e2e failed',
    }),
    false,
  );
  assert.equal(
    reviewGate.isTerminalReviewStatus({
      state: 'pending',
      description: 'Waiting for Codex',
    }),
    false,
  );
});

test('a failed CI rerun preserves readiness after a terminal review success', () => {
  assert.equal(typeof reviewGate.shouldDraftForCiFailure, 'function');
  assert.equal(
    reviewGate.shouldDraftForCiFailure({
      state: 'success',
      description: 'review: Codex found no blocking issue',
    }),
    false,
  );
  assert.equal(
    reviewGate.shouldDraftForCiFailure({
      state: 'failure',
      description: 'review: 1 current-head Codex finding',
    }),
    true,
  );
  assert.equal(
    reviewGate.shouldDraftForCiFailure({
      state: 'failure',
      description: 'ci: api failed',
    }),
    true,
  );
});

test('a buried clean verdict cannot promote a draft without a fresh polled review', async () => {
  const expectedHead = 'a'.repeat(40);
  const cleanStatus = {
    id: 301,
    context: 'codex-current-head',
    state: 'success',
    description: 'review: Codex found no blocking issue on this exact head',
  };
  const statuses = [
    {
      id: 303,
      context: 'codex-current-head',
      state: 'failure',
      description: 'ci: api-e2e failed',
    },
    {
      id: 302,
      context: 'codex-current-head',
      state: 'pending',
      description: 'Waiting for required CI before Codex review',
    },
    cleanStatus,
  ];
  const pullRequest = {
    number: 230,
    state: 'open',
    draft: true,
    head: { sha: expectedHead },
    base: { ref: 'main' },
    html_url: 'https://github.com/JagPat/PMCvitan/pull/230',
  };
  const draftTransitions = [];
  const statusWrites = [];
  let autoMergeDraft = null;
  let reviewComments = [];
  const client = {
    async pullRequest() {
      return pullRequest;
    },
    async setDraft(current, draft) {
      draftTransitions.push(draft);
      current.draft = draft;
      return current;
    },
    async setStatus(head, state, description) {
      statusWrites.push({ head, state, description });
    },
    async reviewComments() { return reviewComments; },
    async reviews() { return []; },
    async commit() {
      return { commit: { message: 'fix: ordinary head' }, files: [] };
    },
    async updateStickyComment() {},
    async mergeExactHead() {
      return { merged: false, message: 'Not ready to merge' };
    },
    async enableAutoMerge(current) {
      autoMergeDraft = current.draft;
    },
    async dispatchHandoff(ref, number) {
      assert.equal(ref, 'main');
      assert.equal(number, 230);
    },
  };

  assert.equal(
    await reviewGate.ensureTerminalReviewState(
      client,
      pullRequest,
      expectedHead,
      cleanStatus,
      statuses,
    ),
    false,
  );
  assert.deepEqual(draftTransitions, []);
  assert.equal(autoMergeDraft, null);
  assert.deepEqual(statusWrites, []);

  pullRequest.draft = false;
  assert.equal(
    await reviewGate.ensureTerminalReviewState(
      client,
      pullRequest,
      expectedHead,
      cleanStatus,
      statuses,
    ),
    true,
  );
  assert.deepEqual(draftTransitions, []);
  assert.equal(autoMergeDraft, false);
  assert.equal(statusWrites[0].state, 'success');
  assert.match(statusWrites[0].description, /recovered prior clean/u);

  pullRequest.draft = false;
  autoMergeDraft = null;
  reviewComments = [
    { user: { login: 'chatgpt-codex-connector[bot]' }, commit_id: 'b'.repeat(40) },
    { user: { login: 'chatgpt-codex-connector[bot]' }, commit_id: 'c'.repeat(40) },
  ];
  assert.equal(
    await reviewGate.ensureTerminalReviewState(
      client,
      pullRequest,
      expectedHead,
      cleanStatus,
      statuses,
    ),
    true,
  );
  assert.equal(autoMergeDraft, null);
  assert.equal(pullRequest.draft, true);
  assert.match(statusWrites.at(-1).description, /convergence evidence/u);
});

test('a review failure remains latched after a later success write', () => {
  assert.equal(
    hasTerminalReviewFailureAfterPending(
      [
        {
          context: 'codex-current-head',
          state: 'success',
          description: 'review: Codex found no blocking issue',
          created_at: '2026-07-27T18:00:03Z',
        },
        {
          context: 'codex-current-head',
          state: 'failure',
          description: 'review: current-head Codex finding',
          created_at: '2026-07-27T18:00:03Z',
        },
        {
          context: 'codex-current-head',
          state: 'pending',
          description: 'review: pending required CI and current-head Codex review',
          created_at: '2026-07-27T18:00:03Z',
        },
      ],
    ),
    true,
  );
  assert.equal(
    hasTerminalReviewFailureAfterPending(
      [
        {
          context: 'codex-current-head',
          state: 'success',
          description: 'review: Codex found no blocking issue',
          created_at: '2026-07-27T18:00:03Z',
        },
        {
          context: 'codex-current-head',
          state: 'pending',
          description: 'review: pending required CI and current-head Codex review',
          created_at: '2026-07-27T18:00:03Z',
        },
        {
          context: 'codex-current-head',
          state: 'failure',
          description: 'review: stale finding',
          created_at: '2026-07-27T18:00:03Z',
        },
      ],
    ),
    false,
  );
});

test('terminal recovery scopes its failure latch to the latest review cycle', () => {
  const statuses = [
    {
      context: 'codex-current-head',
      state: 'success',
      description: 'review: Codex found no blocking issue',
      created_at: '2026-07-27T18:10:05Z',
    },
    {
      context: 'codex-current-head',
      state: 'failure',
      description: 'review: current-head Codex finding',
      created_at: '2026-07-27T18:10:04Z',
    },
    {
      context: 'codex-current-head',
      state: 'pending',
      description: 'review: pending required CI and current-head Codex review',
      created_at: '2026-07-27T18:10:00Z',
    },
    {
      context: 'codex-current-head',
      state: 'failure',
      description: 'review: prior-cycle timeout',
      created_at: '2026-07-27T18:00:05Z',
    },
    {
      context: 'codex-current-head',
      state: 'pending',
      description: 'review: pending required CI and current-head Codex review',
      created_at: '2026-07-27T18:00:00Z',
    },
  ];
  assert.equal(
    hasTerminalReviewFailureAfterPending(statuses),
    true,
  );
});

test('recovery requires an exact retryable failure or active pending status', () => {
  assert.equal(typeof reviewGate.authorizeRecoveryDispatch, 'function');
  const terminal = {
    id: 987654321,
    context: 'codex-current-head',
    state: 'success',
    description: 'review: Codex found no blocking issue',
    created_at: '2026-07-27T19:10:00Z',
  };
  const failed = {
    ...terminal,
    id: 987654322,
    state: 'failure',
    description: 'review: Codex review timed out after 2 attempts',
  };
  const olderFailedInSameSecond = {
    ...failed,
    id: 987654320,
  };
  const persistentFinding = {
    ...failed,
    id: 987654323,
    description: 'review: 1 current-head Codex finding',
  };
  const bootstrap = {
    ...failed,
    id: 987654324,
    description: 'review: bootstrap exact-head review requested',
  };
  const stuckPending = {
    ...failed,
    id: 987654325,
    state: 'pending',
    description: 'review: pending required CI and current-head Codex review',
  };
  const findingBeforeTimeout = {
    ...persistentFinding,
    id: 987654326,
  };
  const timeoutAfterFinding = {
    ...failed,
    id: 987654327,
  };
  const pendingAfterFinding = {
    ...stuckPending,
    id: 987654328,
  };
  const pendingBeforeFinding = {
    ...stuckPending,
    id: 987654329,
  };

  assert.equal(
    reviewGate.authorizeRecoveryDispatch(
      [failed, olderFailedInSameSecond, terminal],
      '987654322',
    ),
    failed,
  );
  assert.equal(
    reviewGate.authorizeRecoveryDispatch(
      [failed, olderFailedInSameSecond, terminal],
      '987654320',
    ),
    null,
  );
  assert.equal(
    reviewGate.authorizeRecoveryDispatch([terminal], '987654321'),
    null,
  );
  assert.equal(
    reviewGate.authorizeRecoveryDispatch([persistentFinding], '987654323'),
    null,
  );
  assert.equal(
    reviewGate.authorizeRecoveryDispatch([bootstrap], '987654324'),
    bootstrap,
  );
  assert.equal(
    reviewGate.authorizeRecoveryDispatch([stuckPending], '987654325'),
    stuckPending,
  );
  assert.equal(
    reviewGate.authorizeRecoveryDispatch([stuckPending], '987654324'),
    null,
  );
  assert.equal(
    reviewGate.authorizeRecoveryDispatch(
      [timeoutAfterFinding, findingBeforeTimeout, stuckPending],
      '987654327',
    ),
    null,
  );
  assert.equal(
    reviewGate.authorizeRecoveryDispatch(
      [pendingAfterFinding, findingBeforeTimeout, pendingBeforeFinding],
      '987654328',
    ),
    null,
  );
});

test('legacy CI statuses cannot bury a terminal review result', () => {
  assert.equal(typeof reviewGate.recoverableTerminalReviewStatus, 'function');
  const terminal = {
    id: 101,
    context: 'codex-current-head',
    state: 'success',
    description: 'review: Codex found no blocking issue',
    created_at: '2026-07-27T19:10:00Z',
  };
  const pending = {
    id: 102,
    context: 'codex-current-head',
    state: 'pending',
    description: 'review: pending required CI and current-head Codex review',
    created_at: '2026-07-27T19:11:00Z',
  };
  const ciFailure = {
    id: 103,
    context: 'codex-current-head',
    state: 'failure',
    description: 'ci: api-e2e failed',
    created_at: '2026-07-27T19:12:00Z',
  };

  assert.equal(
    reviewGate.recoverableTerminalReviewStatus([ciFailure, pending, terminal]),
    terminal,
  );
  assert.equal(
    reviewGate.recoverableTerminalReviewStatus([pending, terminal]),
    null,
  );
  assert.equal(
    reviewGate.recoverableTerminalReviewStatus([terminal]),
    terminal,
  );
});

test('a buried current-head finding vetoes recovered clean state', async () => {
  const expectedHead = 'b'.repeat(40);
  const cleanStatus = {
    id: 401,
    context: 'codex-current-head',
    state: 'success',
    description: 'review: Codex found no blocking issue',
  };
  const statuses = [
    {
      id: 404,
      context: 'codex-current-head',
      state: 'failure',
      description: 'ci: api-e2e failed',
    },
    {
      id: 403,
      context: 'codex-current-head',
      state: 'pending',
      description: 'review: pending required CI and current-head Codex review',
    },
    cleanStatus,
    {
      id: 400,
      context: 'codex-current-head',
      state: 'failure',
      description: 'review: 1 current-head Codex finding',
    },
    {
      id: 399,
      context: 'codex-current-head',
      state: 'pending',
      description: 'review: pending required CI and current-head Codex review',
    },
  ];
  const pullRequest = {
    number: 230,
    state: 'open',
    draft: false,
    head: { sha: expectedHead },
    html_url: 'https://github.com/JagPat/PMCvitan/pull/230',
  };
  const draftTransitions = [];
  const statusWrites = [];
  let autoMergeCalls = 0;
  const client = {
    async pullRequest() {
      return pullRequest;
    },
    async setDraft(current, draft) {
      draftTransitions.push(draft);
      current.draft = draft;
      return current;
    },
    async setStatus(head, state, description) {
      statusWrites.push({ head, state, description });
    },
    async enableAutoMerge() {
      autoMergeCalls += 1;
    },
  };

  const recoveredFailure = reviewGate.recoverableTerminalReviewStatus(statuses);
  assert.equal(recoveredFailure, statuses[3]);
  await reviewGate.ensureTerminalReviewState(
    client,
    pullRequest,
    expectedHead,
    recoveredFailure,
    statuses,
  );
  assert.deepEqual(draftTransitions, [true]);
  assert.equal(autoMergeCalls, 0);
  assert.equal(statusWrites[0].state, 'failure');
  assert.match(statusWrites[0].description, /current-head Codex finding/u);
});

test('live current-head findings stop recovery before another ready transition', async () => {
  const expectedHead = 'c'.repeat(40);
  const pullRequest = {
    number: 230,
    state: 'open',
    draft: true,
    head: { sha: expectedHead },
    html_url: 'https://github.com/JagPat/PMCvitan/pull/230',
  };
  const draftTransitions = [];
  const statusWrites = [];
  const client = {
    async reviews() {
      return [];
    },
    async reviewComments() {
      return [{
        user: { login: 'chatgpt-codex-connector[bot]' },
        original_commit_id: expectedHead,
        body: '**P2** finding arrived after timeout',
      }];
    },
    async pullRequest() {
      return pullRequest;
    },
    async setDraft(current, draft) {
      draftTransitions.push(draft);
      current.draft = draft;
      return current;
    },
    async setStatus(head, state, description) {
      statusWrites.push({ head, state, description });
    },
    async updateStickyComment() {},
  };

  const result = await reviewGate.guardAgainstCurrentHeadFinding(
    client,
    pullRequest,
    expectedHead,
    null,
  );
  assert.equal(result, '1 current-head Codex finding');
  assert.deepEqual(draftTransitions, [true]);
  assert.equal(statusWrites[0].state, 'failure');
  assert.match(statusWrites[0].description, /1 current-head Codex finding/u);
});

test('a durable recovery request survives owner-job replacement', () => {
  assert.equal(typeof reviewGate.pendingRecoveryRequest, 'function');
  assert.equal(typeof reviewGate.recoveryRequestTerminal, 'function');
  const requestStatus = {
    id: 104,
    context: 'codex-recovery-request/103',
    state: 'pending',
    description: 'recovery: requested terminal status 103',
    created_at: '2026-07-27T19:13:00Z',
  };
  const priorFailure = {
    id: 103,
    context: 'codex-current-head',
    state: 'failure',
    description: 'review: Codex review timed out after two attempts',
    created_at: '2026-07-27T19:12:00Z',
  };
  const abandonedOwnerPending = {
    id: 105,
    context: 'codex-current-head',
    state: 'pending',
    description: 'review: pending required CI and current-head Codex review',
    created_at: '2026-07-27T19:14:00Z',
  };

  const request = reviewGate.pendingRecoveryRequest([
    abandonedOwnerPending,
    requestStatus,
    priorFailure,
  ]);
  assert.deepEqual(request, {
    status: requestStatus,
    terminalStatusId: '103',
  });
  assert.equal(
    reviewGate.recoveryRequestTerminal(
      [abandonedOwnerPending, requestStatus, priorFailure],
      request,
    ),
    priorFailure,
  );
  assert.equal(
    reviewGate.authorizeRecoveryDispatch(
      [abandonedOwnerPending, requestStatus, priorFailure],
      '103',
    ),
    priorFailure,
  );
  assert.equal(
    reviewGate.recoveryRequestTerminal(
      [
        { ...priorFailure, id: 106, created_at: '2026-07-27T19:15:00Z' },
        requestStatus,
        priorFailure,
      ],
      request,
    ),
    null,
  );

  const newerRequest = {
    id: 107,
    context: 'codex-recovery-request/106',
    state: 'pending',
    description: 'recovery: requested terminal status 106',
    created_at: '2026-07-27T19:16:00Z',
  };
  assert.equal(
    reviewGate.pendingRecoveryRequest([
      newerRequest,
      requestStatus,
      priorFailure,
    ]).status,
    newerRequest,
  );
  assert.notEqual(
    reviewGate.recoveryRequestContext('103'),
    reviewGate.recoveryRequestContext('106'),
  );

  const stuckPending = {
    id: 108,
    context: 'codex-current-head',
    state: 'pending',
    description: 'review: pending required CI and current-head Codex review',
  };
  const pendingSourceRequestStatus = {
    id: 109,
    context: 'codex-recovery-request/108',
    state: 'pending',
    description: 'recovery: requested terminal status 108',
  };
  const pendingSourceRequest = reviewGate.pendingRecoveryRequest([
    pendingSourceRequestStatus,
    stuckPending,
  ]);
  assert.equal(
    reviewGate.recoveryRequestTerminal(
      [pendingSourceRequestStatus, stuckPending],
      pendingSourceRequest,
    ),
    stuckPending,
  );
  const laterTimeout = {
    id: 110,
    context: 'codex-current-head',
    state: 'failure',
    description: 'review: Codex review timed out after two attempts',
  };
  assert.equal(
    reviewGate.recoveryRequestTerminal(
      [laterTimeout, pendingSourceRequestStatus, stuckPending],
      pendingSourceRequest,
    ),
    laterTimeout,
  );
  const laterFinding = {
    ...laterTimeout,
    id: 111,
    description: 'review: 1 current-head Codex finding',
  };
  assert.equal(
    reviewGate.recoveryRequestTerminal(
      [laterFinding, pendingSourceRequestStatus, stuckPending],
      pendingSourceRequest,
    ),
    null,
  );
});

test('manual recovery records intent before entering the single owner lane', async () => {
  const [workflow, gate] = await Promise.all([
    readFile(workflowPath, 'utf8'),
    readFile(new URL('./autonomous-review-gate.mjs', import.meta.url), 'utf8'),
  ]);

  assert.match(workflow, /terminal_status_id:/);
  assert.match(workflow, /request-recovery:/);
  assert.match(workflow, /AUTONOMOUS_REVIEW_MODE: request-recovery/);
  assert.match(workflow, /needs:\s*\[request-recovery\]/);
  assert.match(workflow, /autonomous-review-owner-/);
  assert.doesNotMatch(workflow, /&& 'recovery' \|\| 'ci'/);
  assert.match(gate, /authorizeRecoveryDispatch\(/);
  assert.match(gate, /RECOVERY_CONTEXT_PREFIX/);
  assert.match(gate, /pendingRecoveryRequest\(/);
  assert.match(gate, /recoveryRequestTerminal\(/);
  assert.match(gate, /recoveryRequest\.status\.context/);
  assert.doesNotMatch(gate, /client\.workflowRun\(/);
  assert.doesNotMatch(gate, /triggerQueuedAt|queuedAt|statusAt/);
  assert.match(gate, /finalCheckSummary/);
});

test('an older owner cannot consume a newer request persisted while it is paused', async () => {
  const oldTerminal = {
    id: 103,
    context: 'codex-current-head',
    state: 'failure',
    description: 'review: bootstrap exact-head review requested',
  };
  const newerTerminal = {
    id: 106,
    context: 'codex-current-head',
    state: 'failure',
    description: 'review: Codex review timed out after two attempts',
  };
  const statuses = [oldTerminal];
  const client = statusClient(statuses);
  const pullRequest = {
    number: 230,
    html_url: 'https://github.com/JagPat/PMCvitan/pull/230',
  };
  const expectedHead = 'a'.repeat(40);

  await reviewGate.persistRecoveryRequest(
    client,
    expectedHead,
    pullRequest,
    oldTerminal,
  );
  const oldRequest = reviewGate.pendingRecoveryRequest(statuses);
  const ownerPaused = deferred();
  const resumeOwner = deferred();
  const oldOwner = (async () => {
    ownerPaused.resolve();
    await resumeOwner.promise;
    await reviewGate.settleRecoveryRequest(
      client,
      expectedHead,
      pullRequest,
      oldRequest,
      'review timeout',
    );
  })();

  await ownerPaused.promise;
  statuses.unshift(newerTerminal);
  await reviewGate.persistRecoveryRequest(
    client,
    expectedHead,
    pullRequest,
    newerTerminal,
  );
  resumeOwner.resolve();
  await oldOwner;

  assert.equal(statuses[0].context, 'codex-recovery-request/103');
  assert.equal(statuses[0].state, 'success');
  assert.equal(
    reviewGate.pendingRecoveryRequest(statuses).terminalStatusId,
    '106',
  );
});

test('stale manual recovery heads fail instead of reporting a green no-op', () => {
  const context = {
    expectedHead: 'a'.repeat(40),
    trigger: 'dispatch',
  };

  assert.throws(
    () => reviewGate.assertCurrentHeadForContext(
      context,
      'b'.repeat(40),
      'request-recovery',
    ),
    /Recovery dispatch head .* no longer matches current head/u,
  );
  assert.equal(
    reviewGate.assertCurrentHeadForContext(
      { ...context, trigger: 'ci' },
      'b'.repeat(40),
      'orchestrate',
    ),
    false,
  );
});

test('workflow gives one exact-head run sole ownership of review and merge', async () => {
  const [workflow, gate] = await Promise.all([
    readFile(workflowPath, 'utf8'),
    readFile(new URL('./autonomous-review-gate.mjs', import.meta.url), 'utf8'),
  ]);

  assert.match(workflow, /workflow_run:/);
  assert.match(workflow, /workflows:\s*\[CI\]/);
  assert.match(workflow, /workflow_dispatch:/);
  assert.doesNotMatch(workflow, /pull_request_review:/);
  assert.doesNotMatch(workflow, /pull_request_review_comment:/);
  assert.doesNotMatch(gate, /eventName === 'pull_request_review'/);
  assert.doesNotMatch(gate, /eventName === 'pull_request_review_comment'/);
  assert.doesNotMatch(gate, /trigger:\s*'evidence'/);
  assert.doesNotMatch(gate, /handleCodexEvidence/);
  assert.doesNotMatch(gate, /admitAutoMerge/);
  assert.match(gate, /reviewAttempt\(/);
  assert.match(workflow, /request-recovery:/);
  assert.match(workflow, /autonomous-review-owner-/);
  assert.match(gate, /mode === 'request-recovery'/);
  assert.match(gate, /pendingRecoveryRequest\(/);
  assert.match(gate, /ensureTerminalReviewState\(/);
  assert.match(workflow, /statuses:\s*write/);
  assert.match(workflow, /pull-requests:\s*write/);
  assert.match(workflow, /issues:\s*write/);
  assert.match(workflow, /ref:\s*\$\{\{ github\.event\.repository\.default_branch \}\}/);
  assert.match(workflow, /persist-credentials:\s*false/);
  assert.match(workflow, /actions\/checkout@[0-9a-f]{40}/);
  assert.match(workflow, /actions\/setup-node@[0-9a-f]{40}/);
  assert.doesNotMatch(workflow, /pull_request_target:/);
});

test('the trusted owner enforces convergence after CI and before Codex promotion', async () => {
  const gate = await readFile(
    new URL('./autonomous-review-gate.mjs', import.meta.url),
    'utf8',
  );
  const checks = gate.indexOf('await waitForRequiredChecks');
  const convergence = gate.indexOf('await enforceReviewConvergence', checks);
  const review = gate.indexOf('await reviewAttempt', convergence);

  assert.ok(checks >= 0);
  assert.ok(convergence > checks);
  assert.ok(review > convergence);
  assert.match(gate, /client\.commit\(expectedHead\)/u);
  assert.match(gate, /changedFiles: commit\.files/u);
  assert.doesNotMatch(gate, /client\.pullRequestFiles\(pullRequest\.number\)/u);
  assert.match(gate, /state: 'convergence_required'/u);
  assert.match(gate, /Review-Convergence: complete/u);
  assert.match(gate, /assessReviewScope\(pullRequest\)/u);
  assert.match(gate, /state: 'scope_required'/u);
  assert.match(
    gate,
    /async paginated\(path\)[\s\S]*?page \+= 1/u,
  );
  assert.match(gate, /reviewComments\(number\)[\s\S]*?this\.paginated/u);
});

test('trusted scope enforcement rejects a spoofed green preflight', async () => {
  const head = 'd'.repeat(40);
  const pullRequest = {
    number: 247,
    additions: 2_000,
    deletions: 0,
    changed_files: 24,
    body: '<!-- review-size: justified-large -->',
    state: 'open',
    draft: false,
    html_url: 'https://github.com/JagPat/PMCvitan/pull/247',
    head: { sha: head },
  };
  const statuses = [];
  const sticky = [];
  const client = {
    async pullRequest() { return pullRequest; },
    async setDraft(live, draft) { return { ...live, draft }; },
    async setStatus(...args) { statuses.push(args); },
    async updateStickyComment(...args) { sticky.push(args); },
  };

  const result = await reviewGate.enforceReviewScope(
    client,
    pullRequest,
    head,
  );
  assert.equal(result.allowed, false);
  assert.equal(statuses[0][1], 'failure');
  assert.match(sticky[0][1], /scope_required/u);
});

test('final admission revalidates live scope and late convergence evidence', async () => {
  const head = 'e'.repeat(40);
  const pullRequest = {
    number: 247,
    additions: 2_000,
    deletions: 0,
    changed_files: 24,
    body: '<!-- review-size: standard -->',
    state: 'open',
    draft: false,
    html_url: 'https://github.com/JagPat/PMCvitan/pull/247',
    head: { sha: head },
  };
  const statuses = [];
  const sticky = [];
  const client = {
    async pullRequest() { return pullRequest; },
    async setDraft(live, draft) { return { ...live, draft }; },
    async setStatus(...args) { statuses.push(args); },
    async updateStickyComment(...args) { sticky.push(args); },
    async reviewComments() { return []; },
    async reviews() { return []; },
    async commit() { return { commit: { message: 'fix: no convergence' }, files: [] }; },
  };

  const invalidScope = await reviewGate.revalidateFinalReviewPolicy(
    client,
    pullRequest.number,
    head,
  );
  assert.equal(invalidScope.allowed, false);
  assert.equal(invalidScope.state, 'scope_required');

  pullRequest.additions = 1;
  pullRequest.changed_files = 1;
  pullRequest.body = '<!-- review-size: standard -->';
  client.reviewComments = async () => ([
    { user: { login: 'chatgpt-codex-connector[bot]' }, commit_id: 'a'.repeat(40) },
    { user: { login: 'chatgpt-codex-connector[bot]' }, commit_id: 'b'.repeat(40) },
  ]);
  statuses.length = 0;
  sticky.length = 0;
  const lateConvergence = await reviewGate.revalidateFinalReviewPolicy(
    client,
    pullRequest.number,
    head,
  );
  assert.equal(lateConvergence.allowed, false);
  assert.equal(lateConvergence.state, 'convergence_required');

  let commentCalls = 0;
  client.commit = async () => ({
    commit: { message: 'fix: final admission\n\nReview-Convergence: complete' },
    files: [{ filename: 'docs/reviews/pr-247-convergence.md', status: 'modified' }],
  });
  client.reviewComments = async () => ([
    { user: { login: 'chatgpt-codex-connector[bot]' }, commit_id: 'a'.repeat(40) },
    { user: { login: 'chatgpt-codex-connector[bot]' }, commit_id: commentCalls++ === 0 ? 'b'.repeat(40) : head },
  ]);
  const lateFinding = await reviewGate.revalidateFinalReviewPolicy(
    client, pullRequest.number, head,
  );
  assert.equal(lateFinding.allowed, false);
  assert.equal(lateFinding.state, 'changes_required');
});

test('Codex review records and inline comments are fully paginated', async () => {
  const originalFetch = globalThis.fetch;
  const urls = [];
  let transientFailure = 2;
  globalThis.fetch = async (url) => {
    urls.push(String(url));
    if (transientFailure === 2) {
      transientFailure -= 1;
      throw new TypeError('temporary network failure');
    }
    if (transientFailure === 1) {
      transientFailure -= 1;
      return new Response('', { status: 500 });
    }
    const parsed = new URL(url);
    const page = parsed.searchParams.get('page');
    const count = page === '1' ? 100 : 1;
    if (/\/commits\//u.test(parsed.pathname)) {
      return new Response(JSON.stringify({
        commit: { message: 'fix: paginated head' },
        files: Array.from({ length: count }, (_, index) => ({
          filename: `file-${page}-${index}.txt`,
          status: 'modified',
        })),
      }));
    }
    return new Response(JSON.stringify(Array.from({ length: count }, (_, index) => ({ index }))));
  };
  try {
    const client = new reviewGate.GitHubClient({
      repository: 'JagPat/PMCvitan',
      token: 'test-token',
    });
    assert.equal((await client.reviewComments(247)).length, 101);
    assert.equal((await client.reviews(247)).length, 101);
    assert.equal((await client.commit('a'.repeat(40))).files.length, 101);
    assert.ok(urls.some((url) => url.includes('/comments?per_page=100&page=2')));
    assert.ok(urls.some((url) => url.includes('/reviews?per_page=100&page=2')));
    assert.ok(urls.some((url) => url.includes(`/commits/${'a'.repeat(40)}?per_page=100&page=2`)));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('convergence enforcement fails closed until the batched packet and trailer exist', async () => {
  const head = 'c'.repeat(40);
  const pullRequest = {
    number: 247,
    state: 'open',
    draft: false,
    html_url: 'https://github.com/JagPat/PMCvitan/pull/247',
    head: { sha: head },
  };
  const comments = [
    { user: { login: 'chatgpt-codex-connector[bot]' }, commit_id: 'a'.repeat(40) },
    { user: { login: 'chatgpt-codex-connector[bot]' }, commit_id: 'b'.repeat(40) },
  ];
  const statuses = [];
  const sticky = [];
  const client = {
    async reviewComments() { return comments; },
    async reviews() { return []; },
    async commit() {
      return {
        commit: { message: 'fix: isolated patch' },
        files: [{ filename: 'apps/web/src/store/store.ts' }],
      };
    },
    async pullRequestFiles() { return [{ filename: 'apps/web/src/store/store.ts' }]; },
    async pullRequest() { return pullRequest; },
    async setDraft(live, draft) { return { ...live, draft }; },
    async setStatus(...args) { statuses.push(args); },
    async updateStickyComment(...args) { sticky.push(args); },
  };

  const blocked = await reviewGate.enforceReviewConvergence(
    client,
    pullRequest,
    head,
  );
  assert.equal(blocked.allowed, false);
  assert.deepEqual(blocked.missing, ['trailer', 'packet']);
  assert.equal(statuses[0][1], 'failure');
  assert.match(statuses[0][2], /convergence evidence/u);
  assert.match(sticky[0][1], /convergence_required/u);

  client.commit = async () => ({
    commit: { message: 'fix: trailer only\n\nReview-Convergence: complete' },
    files: [{ filename: 'apps/web/src/store/store.ts' }],
  });
  client.pullRequestFiles = async () => ([
    { filename: 'docs/reviews/pr-247-convergence.md' },
  ]);
  statuses.length = 0;
  sticky.length = 0;
  const stalePacket = await reviewGate.enforceReviewConvergence(
    client,
    pullRequest,
    head,
  );
  assert.equal(stalePacket.allowed, false);
  assert.deepEqual(stalePacket.missing, ['packet']);

  client.commit = async () => ({
    commit: { message: 'fix: batched audit\n\nReview-Convergence: complete' },
    files: [{ filename: 'docs/reviews/pr-247-convergence.md' }],
  });
  statuses.length = 0;
  sticky.length = 0;
  const allowed = await reviewGate.enforceReviewConvergence(
    client,
    pullRequest,
    head,
  );
  assert.equal(allowed.allowed, true);
  assert.deepEqual(statuses, []);
  assert.deepEqual(sticky, []);
});

test('one polled Codex invocation owns terminal success and merge completion', async () => {
  const gate = await readFile(
    new URL('./autonomous-review-gate.mjs', import.meta.url),
    'utf8',
  );
  assert.match(gate, /ensureTerminalReviewState\(/);
  const clearBranch = gate.slice(
    gate.indexOf("if (result.state === 'clear')"),
    gate.indexOf('if (attempt < MAX_REVIEW_ATTEMPTS)'),
  );
  const finalEvidence = clearBranch.lastIndexOf(
    'reclassifyCurrentCodexEvidence',
  );
  const publishedSuccess = clearBranch.lastIndexOf("'success'");
  const mergeCompletion = clearBranch.lastIndexOf(
    'completeReviewedPullRequest',
  );
  assert.ok(finalEvidence >= 0);
  assert.ok(publishedSuccess > finalEvidence);
  assert.ok(mergeCompletion > publishedSuccess);
  assert.doesNotMatch(clearBranch, /TERMINAL_SETTLE_MS/);
  assert.doesNotMatch(clearBranch, /admitAutoMerge/);
  assert.doesNotMatch(clearBranch, /handleCodexEvidence/);
});

test('the clean verdict is published while the PR is still open', async () => {
  const gate = await readFile(
    new URL('./autonomous-review-gate.mjs', import.meta.url),
    'utf8',
  );
  const clearBranch = gate.slice(
    gate.indexOf("if (result.state === 'clear')"),
    gate.indexOf('if (attempt < MAX_REVIEW_ATTEMPTS)'),
  );
  // Sessions subscribed to the PR receive comment updates only while it is
  // open; success statuses are never forwarded, and the required status
  // flipping green lets GitHub auto-merge close the PR at any moment after.
  // The `review_clean` sticky update must therefore land BEFORE the success
  // status and BEFORE merge completion — it is the success path's only
  // guaranteed-delivery wake event for watching sessions.
  const publishedClean = clearBranch.indexOf("state: 'review_clean'");
  const publishedSuccess = clearBranch.lastIndexOf("'success'");
  const mergeCompletion = clearBranch.lastIndexOf('completeReviewedPullRequest');
  assert.ok(publishedClean >= 0);
  assert.ok(publishedSuccess > publishedClean);
  assert.ok(mergeCompletion > publishedClean);
  // and the pre-merge update must precede the post-merge 'clear' update
  const clearUpdate = clearBranch.lastIndexOf("state: 'clear'");
  assert.ok(clearUpdate > publishedClean);
});

test('a clean reviewed head is squash-merged directly with exact SHA', async () => {
  assert.equal(typeof reviewGate.completeReviewedPullRequest, 'function');
  const expectedHead = 'a'.repeat(40);
  const pullRequest = {
    number: 230,
    state: 'open',
    draft: false,
    head: { sha: expectedHead },
    base: { ref: 'main' },
  };
  const calls = [];
  const client = {
    async mergeExactHead(number, head) {
      calls.push(['merge', number, head]);
      return { merged: true, sha: 'b'.repeat(40) };
    },
    async enableAutoMerge() {
      calls.push(['auto-merge']);
    },
    async dispatchHandoff(ref, number) {
      calls.push(['handoff', ref, number]);
    },
  };

  assert.equal(
    await reviewGate.completeReviewedPullRequest(
      client,
      pullRequest,
      expectedHead,
    ),
    'merged',
  );
  assert.deepEqual(calls, [
    ['merge', 230, expectedHead],
    ['handoff', 'main', 230],
  ]);
});

test('a reviewed head still waiting on GitHub queues auto-merge', async () => {
  assert.equal(typeof reviewGate.completeReviewedPullRequest, 'function');
  const expectedHead = 'a'.repeat(40);
  const pullRequest = {
    number: 230,
    state: 'open',
    draft: false,
    head: { sha: expectedHead },
    base: { ref: 'main' },
  };
  const calls = [];
  const client = {
    async mergeExactHead(number, head) {
      calls.push(['merge', number, head]);
      return { merged: false, message: 'Not ready to merge' };
    },
    async enableAutoMerge(current, head) {
      calls.push(['auto-merge', current.number, head]);
    },
    async dispatchHandoff(ref, number) {
      calls.push(['handoff', ref, number]);
    },
  };

  assert.equal(
    await reviewGate.completeReviewedPullRequest(
      client,
      pullRequest,
      expectedHead,
    ),
    'queued',
  );
  assert.deepEqual(calls, [
    ['merge', 230, expectedHead],
    ['auto-merge', 230, expectedHead],
    ['handoff', 'main', 230],
  ]);
});

test('a clean-state auto-merge race retries the exact-SHA merge once', async () => {
  assert.equal(typeof reviewGate.completeReviewedPullRequest, 'function');
  const expectedHead = 'a'.repeat(40);
  const pullRequest = {
    number: 230,
    state: 'open',
    draft: false,
    head: { sha: expectedHead },
    base: { ref: 'main' },
  };
  let mergeAttempts = 0;
  const client = {
    async mergeExactHead(number, head) {
      assert.equal(number, 230);
      assert.equal(head, expectedHead);
      mergeAttempts += 1;
      return mergeAttempts === 1
        ? { merged: false, message: 'Not ready to merge' }
        : { merged: true, sha: 'b'.repeat(40) };
    },
    async enableAutoMerge() {
      throw new Error(
        'GitHub GraphQL failed: Pull request Pull request is in clean status',
      );
    },
    async dispatchHandoff(ref, number) {
      assert.equal(ref, 'main');
      assert.equal(number, 230);
    },
  };

  assert.equal(
    await reviewGate.completeReviewedPullRequest(
      client,
      pullRequest,
      expectedHead,
    ),
    'merged',
  );
  assert.equal(mergeAttempts, 2);
});

test('review cycles are serialized by pull request and exact head', async () => {
  const workflow = await readFile(workflowPath, 'utf8');
  assert.match(workflow, /github\.event\.workflow_run\.head_sha/);
  assert.match(workflow, /inputs\.head_sha/);
  assert.doesNotMatch(workflow, /github\.event\.pull_request/);
  assert.match(workflow, /cancel-in-progress:\s*false/);
});

test('the auto-merge fallback sends GitHub the reviewed head OID', async () => {
  const gate = await readFile(
    new URL('./autonomous-review-gate.mjs', import.meta.url),
    'utf8',
  );
  const autoMergeMethod = gate.slice(
    gate.indexOf('async enableAutoMerge'),
    gate.indexOf('async mergeExactHead'),
  );
  assert.match(autoMergeMethod, /expectedHeadOid:\s*\$expectedHead/);
  assert.match(autoMergeMethod, /\{ id: pullRequest\.node_id, expectedHead \}/);
});

test('failure-latch status history is fully paginated', async () => {
  const gate = await readFile(
    new URL('./autonomous-review-gate.mjs', import.meta.url),
    'utf8',
  );
  const statusesMethod = gate.slice(
    gate.indexOf('async statuses(head)'),
    gate.indexOf('async latestStatus'),
  );
  assert.match(statusesMethod, /page \+= 1/);
  assert.match(statusesMethod, /batch\.length < 100/);
  assert.match(statusesMethod, /statuses\.push\(\.\.\.batch\)/);
});

test('result webhooks cannot publish review state or queue auto-merge', async () => {
  const gate = await readFile(
    new URL('./autonomous-review-gate.mjs', import.meta.url),
    'utf8',
  );
  assert.equal(reviewGate.handleCodexEvidence, undefined);
  assert.equal(reviewGate.admitAutoMerge, undefined);
  assert.doesNotMatch(gate, /handleCodexEvidence/);
  assert.doesNotMatch(gate, /admitAutoMerge/);
});

test('terminal failures restore draft and CI failures run before recovery', async () => {
  const gate = await readFile(
    new URL('./autonomous-review-gate.mjs', import.meta.url),
    'utf8',
  );
  const terminalHelper = gate.slice(
    gate.indexOf('async function ensureTerminalReviewState'),
    gate.indexOf('async function waitForRequiredChecks'),
  );
  assert.match(terminalHelper, /status\.state === 'success'/);
  assert.match(terminalHelper, /recovered prior clean Codex result/);
  assert.match(terminalHelper, /persistentReviewFailure/);
  assert.ok(
    terminalHelper.indexOf('persistentReviewFailure')
      < terminalHelper.indexOf('completeReviewedPullRequest'),
  );
  assert.ok(
    terminalHelper.indexOf('recovered prior clean Codex result')
      < terminalHelper.indexOf('completeReviewedPullRequest'),
  );
  assert.match(terminalHelper, /setDraftForCurrentHead[\s\S]*true/);

  const runBody = gate.slice(gate.indexOf('export async function run()'));
  const ciFailure = runBody.indexOf(
    "context.ciConclusion && context.ciConclusion !== 'success'",
  );
  const terminalRecovery = runBody.indexOf('ensureTerminalReviewState(');
  assert.ok(ciFailure >= 0 && ciFailure < terminalRecovery);
  const liveFindingGuard = runBody.indexOf('guardAgainstCurrentHeadFinding(');
  assert.ok(
    liveFindingGuard >= 0 && liveFindingGuard < terminalRecovery,
    'live Codex evidence must be checked before recovered success can return',
  );
  assert.match(runBody, /if \(!isTerminalReviewStatus\(existingStatus\)\)[\s\S]*`ci:/);
});

test('workflow has no AI action or AI credential dependency', async () => {
  const workflow = await readFile(workflowPath, 'utf8');

  assert.doesNotMatch(workflow, /ANTHROPIC_API_KEY/);
  assert.doesNotMatch(workflow, /OPENAI_API_KEY/);
  assert.doesNotMatch(workflow, /anthropics\/claude-code-action/);
  assert.doesNotMatch(workflow, /openai\/codex-action/);
});

test('workflow recovery is exact-head serialized and has terminal time budget', async () => {
  const [workflow, gate] = await Promise.all([
    readFile(workflowPath, 'utf8'),
    readFile(new URL('./autonomous-review-gate.mjs', import.meta.url), 'utf8'),
  ]);
  assert.match(workflow, /head_sha:/);
  assert.match(workflow, /inputs\.head_sha/);
  assert.match(workflow, /terminal_status_id:/);
  assert.match(gate, /event\.inputs\?\.terminal_status_id/);
  assert.match(workflow, /needs:\s*\[request-recovery\]/);
  assert.match(workflow, /autonomous-review-owner-/);
  assert.match(workflow, /timeout-minutes:\s*60/);
});

test('operator recovery documents the required current head SHA', async () => {
  const runbook = await readFile(autonomousLoopPath, 'utf8');
  const recovery = runbook.slice(
    runbook.indexOf('## Recovery'),
    runbook.indexOf('## GitHub Enforcement'),
  );
  assert.match(recovery, /gh pr view/);
  assert.match(recovery, /headRefOid/);
  assert.match(recovery, /-f head_sha="\$HEAD_SHA"/);
  assert.match(recovery, /-f terminal_status_id="\$TERMINAL_STATUS_ID"/);
});

test('documented recovery jq selects an authorized review status id', async () => {
  const runbook = await readFile(autonomousLoopPath, 'utf8');
  const recovery = runbook.slice(
    runbook.indexOf('## Recovery'),
    runbook.indexOf('## GitHub Enforcement'),
  );
  const expression = recovery.match(/--jq '([^']+)'/u)?.[1];
  assert.ok(expression, 'recovery command must include a jq expression');

  const runExpression = (statuses) => spawnSync('jq', ['-r', expression], {
    encoding: 'utf8',
    input: JSON.stringify([statuses]),
  });
  const timeoutStatus = {
    id: 777,
    context: 'codex-current-head',
    state: 'failure',
    description: 'review: Codex review timed out after two attempts',
  };
  const timeout = runExpression([timeoutStatus]);
  assert.equal(timeout.status, 0, timeout.stderr);
  assert.equal(timeout.stdout.trim(), '777');

  const pendingStatus = {
    id: 778,
    context: 'codex-current-head',
    state: 'pending',
    description: 'review: pending required CI and current-head Codex review',
  };
  const pending = runExpression([pendingStatus]);
  assert.equal(pending.status, 0, pending.stderr);
  assert.equal(pending.stdout.trim(), '778');

  const buriedTimeout = runExpression([
    {
      id: 779,
      context: 'codex-current-head',
      state: 'failure',
      description: 'ci: api-e2e failed',
    },
    pendingStatus,
    timeoutStatus,
  ]);
  assert.equal(buriedTimeout.status, 0, buriedTimeout.stderr);
  assert.equal(buriedTimeout.stdout.trim(), '777');

  const findingBearing = runExpression([
    { ...pendingStatus, id: 781 },
    {
      id: 780,
      context: 'codex-current-head',
      state: 'failure',
      description: 'review: 1 current-head Codex finding',
    },
    pendingStatus,
  ]);
  assert.equal(findingBearing.status, 0, findingBearing.stderr);
  assert.equal(findingBearing.stdout.trim(), '');
});

test('workflow invokes the exact-head gate and CI executes its tests', async () => {
  const [workflow, ci, packageJson] = await Promise.all([
    readFile(workflowPath, 'utf8'),
    readFile(ciPath, 'utf8'),
    readFile(packagePath, 'utf8').then(JSON.parse),
  ]);

  assert.match(workflow, /scripts\/autonomous-review-gate\.mjs/);
  assert.match(workflow, /codex-current-head/);
  assert.match(ci, /pnpm test:automation/);
  assert.match(packageJson.scripts['test:automation'], /review-efficiency\.test\.mjs/u);
});

test('rechecks the live head before terminal PR mutations', async () => {
  const gate = await readFile(
    new URL('./autonomous-review-gate.mjs', import.meta.url),
    'utf8',
  );

  assert.match(gate, /async function refreshCurrentHead\(/);
  assert.match(gate, /completeReviewedPullRequest\([\s\S]*expectedHead/);
  assert.match(gate, /if \(!pullRequest\) return;/);
  assert.match(gate, /resolveCodexThreads/);
});

test('reclassifies Codex evidence immediately before publishing success', async () => {
  const implementation = await readFile(
    new URL('./autonomous-review-gate.mjs', import.meta.url),
    'utf8',
  );
  assert.match(implementation, /reclassifyCurrentCodexEvidence/);
  assert.match(implementation, /verifiedResult\.state !== 'clear'/);
});

test('revalidates live policy after polling and immediately before clean success', async () => {
  const gate = await readFile(
    new URL('./autonomous-review-gate.mjs', import.meta.url),
    'utf8',
  );
  const evidence = gate.indexOf('await reclassifyCurrentCodexEvidence');
  const finalPolicy = gate.indexOf('await revalidateFinalReviewPolicy', evidence);
  const success = gate.indexOf("'review: Codex found no blocking issue on this exact head'", finalPolicy);
  assert.ok(evidence >= 0);
  assert.ok(finalPolicy > evidence);
  assert.ok(success > finalPolicy);
});

test('CI runs once per pull-request head', async () => {
  const ci = await readFile(ciPath, 'utf8');

  assert.match(ci, /pull_request:/);
  assert.doesNotMatch(ci, /push:/);
});
