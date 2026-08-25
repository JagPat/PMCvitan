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
  // NOT extended with classify/automation/quality-gate. This is the
  // ORCHESTRATOR's wait list, and adding names an older branch cannot emit
  // strands it. `quality-gate` becomes the required check through branch
  // protection, which is a separate change; until then the orchestrator waits
  // on the products, and quality-gate cannot be green unless they are.
  //
  // Honest gap while that is pending: the orchestrator does not wait for the
  // `automation` job, so a head could reach Codex with those tests still
  // running. They are seconds, and they gate nothing the products do not.
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
  // Scoped to the review-scope job ITSELF, and to the dependency every
  // expensive job declares on it. The earlier form asserted "nothing between
  // review-scope and web installs anything", which is a property of a REGION —
  // it failed the moment a correctly-gated job was added in that region, while
  // the ordering it protects was untouched.
  const scopeStart = workflow.indexOf('  review-scope:');
  assert.ok(scopeStart >= 0);
  const scopeJob = workflow.slice(scopeStart, workflow.indexOf('  battery-plan:'));
  assert.match(scopeJob, /node scripts\/review-scope\.mjs/u);
  assert.doesNotMatch(scopeJob, /pnpm install|setup-node|postgres/u);

  // The ordering itself: every job that installs dependencies or starts a
  // database must declare review-scope as a dependency, wherever it sits.
  for (const job of ['automation', 'web', 'e2e', 'api', 'api-e2e', 'upgrade-proof']) {
    const start = workflow.indexOf(`\n  ${job}:\n`);
    assert.ok(start >= 0, `${job} must exist`);
    const declared = workflow.slice(start, start + 400);
    assert.match(
      declared, /needs:\s*\[[^\]]*review-scope[^\]]*\]/u,
      `${job} must run only after review-scope`,
    );
  }

  // Every product job depends on BOTH gates. Matched as set membership rather
  // than as the literal array text, so adding a third dependency (the risk
  // classification) does not fail a pin about the first two.
  for (const job of ['web', 'api', 'e2e', 'api-e2e', 'upgrade-proof']) {
    const start = workflow.indexOf(`\n  ${job}:\n`);
    assert.ok(start >= 0, `${job} must exist`);
    const needs = /needs:\s*\[([^\]]*)\]/u.exec(workflow.slice(start, start + 400));
    assert.ok(needs, `${job} must declare needs`);
    const declared = needs[1].split(',').map((name) => name.trim());
    for (const gate of ['review-scope', 'battery-plan']) {
      assert.ok(declared.includes(gate), `${job} must depend on ${gate}`);
    }
  }
});

// The gate side of the retarget window: an older owner polling a previously
// green SHA must not publish success once a newer attempt's gates have passed
// with no product jobs of their own yet. Not-yet-run is pending, not failure.
test('the gate waits for products belonging to the newest gate attempt', () => {
  const job = (name, conclusion, runId, stamp) => ({
    name,
    status: 'completed',
    conclusion,
    completed_at: stamp,
    html_url: `https://github.com/o/r/actions/runs/${runId}/job/1`,
  });
  const attemptA = [
    job('review-scope', 'success', '600', '2026-07-29T10:00:00Z'),
    job('battery-plan', 'success', '600', '2026-07-29T10:00:30Z'),
    ...PRODUCTS.map((n) => job(n, 'success', '600', '2026-07-29T10:05:00Z')),
  ];
  // Attempt A alone is complete and green.
  assert.equal(summarizeRequiredChecks(attemptA).state, 'success');

  // A newer attempt's gates complete green; its products have not been created.
  const midRetarget = [
    ...attemptA,
    job('review-scope', 'success', '700', '2026-07-29T11:00:00Z'),
    job('battery-plan', 'success', '700', '2026-07-29T11:00:30Z'),
  ];
  const waiting = summarizeRequiredChecks(midRetarget);
  assert.equal(waiting.state, 'pending', 'stale product evidence must not publish success');
  assert.deepEqual(waiting.pending.sort(), [...PRODUCTS].sort());
  assert.deepEqual(waiting.failed, []);

  // Once the new attempt's products pass, the gate is green again.
  assert.equal(
    summarizeRequiredChecks([
      ...midRetarget,
      ...PRODUCTS.map((n) => job(n, 'success', '700', '2026-07-29T11:05:00Z')),
    ]).state,
    'success',
  );

  // A deliberate metadata-only skip is NOT this case: its attempt has skipped
  // product runs, so it keeps deferring to the evidence it preserved.
  assert.equal(
    summarizeRequiredChecks([
      ...attemptA,
      job('review-scope', 'success', '700', '2026-07-29T11:00:00Z'),
      job('battery-plan', 'success', '700', '2026-07-29T11:00:30Z'),
      ...PRODUCTS.map((n) => job(n, 'skipped', '700', '2026-07-29T11:01:00Z')),
    ]).state,
    'success',
  );
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
    // Ownership is a precondition of every scope assessment, so this fixture
    // declares one; the test is about a buried clean verdict, not ownership.
    body: '<!-- correction-owner: claude -->',
    head: { sha: expectedHead, repo: { full_name: 'JagPat/PMCvitan' } },
    base: { ref: 'main', repo: { full_name: 'JagPat/PMCvitan' } },
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
    async markReplacementRequired() {},
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
  assert.match(statusWrites.at(-1).description, /replacement PR/u);
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
    head: { sha: expectedHead, repo: { full_name: 'JagPat/PMCvitan' } },
    base: { ref: 'main', repo: { full_name: 'JagPat/PMCvitan' } },
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
    head: { sha: expectedHead, repo: { full_name: 'JagPat/PMCvitan' } },
    base: { ref: 'main', repo: { full_name: 'JagPat/PMCvitan' } },
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

test('a finding on the second distinct head publishes replacement_required immediately', async () => {
  const expectedHead = 'b'.repeat(40);
  const pullRequest = {
    number: 346,
    state: 'open',
    draft: false,
    head: { sha: expectedHead, repo: { full_name: 'JagPat/PMCvitan' } },
    base: { ref: 'main', repo: { full_name: 'JagPat/PMCvitan' } },
    html_url: 'https://github.com/JagPat/PMCvitan/pull/346',
  };
  const sticky = [];
  const marked = [];
  const client = {
    async reviews() { return []; },
    async reviewComments() {
      return [
        {
          user: { login: 'chatgpt-codex-connector[bot]' },
          original_commit_id: 'a'.repeat(40),
          body: '**P1** first-head finding',
        },
        {
          user: { login: 'chatgpt-codex-connector[bot]' },
          original_commit_id: expectedHead,
          body: '**P1** second-head finding',
        },
      ];
    },
    async pullRequest() { return pullRequest; },
    async setDraft(current, draft) { return { ...current, draft }; },
    async setStatus() {},
    async markReplacementRequired(number) { marked.push(number); },
    async updateStickyComment(...args) { sticky.push(args); },
  };

  await reviewGate.guardAgainstCurrentHeadFinding(
    client,
    pullRequest,
    expectedHead,
    null,
  );

  assert.deepEqual(marked, [346]);
  assert.match(sticky.at(-1)[1], /replacement_required/u);
  assert.match(sticky.at(-1)[1], /Replaces: #346/u);
  assert.doesNotMatch(sticky.at(-1)[1], /pushes a new head/u);
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

test('the trusted owner enforces the review-round reset after CI and before Codex promotion', async () => {
  const gate = await readFile(
    new URL('./autonomous-review-gate.mjs', import.meta.url),
    'utf8',
  );
  const checks = gate.indexOf('await waitForRequiredChecks');
  const reset = gate.indexOf('await enforceReviewConvergence', checks);
  const review = gate.indexOf('await reviewAttempt', reset);

  assert.ok(checks >= 0);
  assert.ok(reset > checks);
  assert.ok(review > reset);
  assert.match(gate, /state: 'replacement_required'/u);
  // The `Replaces: #<n>` sentence moved into scripts/correction-owner.mjs so it
  // is phrased for the PR's DECLARED correction owner rather than for Claude
  // unconditionally. What the gate must still do is ASK for it on this path —
  // the rendered instruction is asserted below, in the behavioural probe.
  // Derived from the REFRESHED pull request (`live`), not the run-start
  // snapshot: an owner marker edited mid-run must change who the notice names.
  assert.match(gate, /correctionNotice\(live, \{ detail, reason: 'replacement' \}\)/u);
  assert.match(gate, /assessReviewScope\(pullRequest,/u);
  assert.match(gate, /state: 'scope_required'/u);
  assert.match(
    gate,
    /async paginated\(path\)[\s\S]*?page \+= 1/u,
  );
  assert.match(gate, /reviewComments\(number\)[\s\S]*?this\.paginated/u);
  assert.equal(
    [...gate.matchAll(/await publishCurrentHeadFinding\(/gu)].length,
    3,
    'every finding-result path must re-evaluate the reset before directing another push',
  );
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
    head: { sha: head, repo: { full_name: 'JagPat/PMCvitan' } },
    base: { ref: 'main', repo: { full_name: 'JagPat/PMCvitan' } },
  };
  const statuses = [];
  const sticky = [];
  const client = {
    async pullRequest() { return pullRequest; },
    async setDraft(live, draft) { return { ...live, draft }; },
    async setStatus(...args) { statuses.push(args); },
    async markReplacementRequired() {},
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

test('trusted scope enforcement reads the cumulative file list and rejects a migration-service mixture', async () => {
  const head = 'f'.repeat(40);
  const checklist = [
    '<!-- review-size: standard -->',
    '<!-- migration-scope: separated -->',
    'Replaces: none',
    '- [x] `concurrency-serialization` — checked',
    '- [x] `old-release-migration-compatibility` — checked',
    '- [x] `trigger-alternate-writers` — checked',
    '- [x] `authorization-tenancy` — checked',
    '- [x] `ci-reproduce-first` — checked',
    '- Migration/service seam: n/a',
  ].join('\n');
  const pullRequest = {
    number: 346,
    additions: 100,
    deletions: 0,
    changed_files: 2,
    body: checklist,
    state: 'open',
    draft: false,
    html_url: 'https://github.com/JagPat/PMCvitan/pull/346',
    head: { sha: head, repo: { full_name: 'JagPat/PMCvitan' } },
    base: { ref: 'main', repo: { full_name: 'JagPat/PMCvitan' } },
  };
  const statuses = [];
  const client = {
    async pullRequest() { return pullRequest; },
    async pullRequestFiles() {
      return [
        { filename: 'apps/api/prisma/migrations/20260817000000_example/migration.sql' },
        { filename: 'apps/api/src/example/example.service.ts' },
      ];
    },
    async replacementLineage() {
      return { requiredReplacements: [], replacementPullRequests: [] };
    },
    async setDraft(live, draft) { return { ...live, draft }; },
    async setStatus(...args) { statuses.push(args); },
    async updateStickyComment() {},
  };

  const result = await reviewGate.enforceReviewScope(client, pullRequest, head);
  assert.equal(result.allowed, false);
  assert.match(result.detail, /separate review units/u);
  assert.equal(statuses[0][1], 'failure');
});

test('final admission revalidates live scope and the late review-round reset', async () => {
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
    head: { sha: head, repo: { full_name: 'JagPat/PMCvitan' } },
    base: { ref: 'main', repo: { full_name: 'JagPat/PMCvitan' } },
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
    async markReplacementRequired() {},
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
  pullRequest.body = '<!-- review-size: standard -->\n<!-- correction-owner: claude -->';
  client.reviewComments = async () => ([
    { user: { login: 'chatgpt-codex-connector[bot]' }, commit_id: 'a'.repeat(40) },
    { user: { login: 'chatgpt-codex-connector[bot]' }, commit_id: 'b'.repeat(40) },
  ]);
  statuses.length = 0;
  sticky.length = 0;
  const lateReset = await reviewGate.revalidateFinalReviewPolicy(
    client,
    pullRequest.number,
    head,
  );
  assert.equal(lateReset.allowed, false);
  assert.equal(lateReset.state, 'replacement_required');

  let commentCalls = 0;
  client.reviewComments = async () => ([{
    user: { login: 'chatgpt-codex-connector[bot]' },
    commit_id: commentCalls++ < 2 ? 'a'.repeat(40) : head,
  }]);
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

test('the trusted client persists the replacement requirement as a repository label', async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url, method: options.method, body: options.body });
    if (options.method === 'GET' && url.includes('/labels/review-replacement-required')) {
      return new Response(JSON.stringify({ message: 'Not Found' }), { status: 404 });
    }
    return new Response('{}', {
      status: url.endsWith('/labels') ? 201 : 200,
    });
  };
  try {
    const client = new reviewGate.GitHubClient({
      repository: 'JagPat/PMCvitan',
      token: 'test-token',
    });
    await client.markReplacementRequired(346);
    assert.ok(calls.some((call) =>
      call.method === 'POST'
      && call.url.endsWith('/repos/JagPat/PMCvitan/labels')));
    const assignment = calls.find((call) =>
      call.method === 'POST'
      && call.url.endsWith('/repos/JagPat/PMCvitan/issues/346/labels'));
    assert.deepEqual(JSON.parse(assignment.body), {
      labels: ['review-replacement-required'],
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('the second finding-bearing head requires replacement even when convergence evidence exists', async () => {
  const head = 'c'.repeat(40);
  const pullRequest = {
    number: 247,
    state: 'open',
    draft: false,
    html_url: 'https://github.com/JagPat/PMCvitan/pull/247',
    head: { sha: head, repo: { full_name: 'JagPat/PMCvitan' } },
    base: { ref: 'main', repo: { full_name: 'JagPat/PMCvitan' } },
  };
  const comments = [
    { user: { login: 'chatgpt-codex-connector[bot]' }, commit_id: 'a'.repeat(40) },
    { user: { login: 'chatgpt-codex-connector[bot]' }, commit_id: 'b'.repeat(40) },
  ];
  const statuses = [];
  const sticky = [];
  let commitCalls = 0;
  const client = {
    async reviewComments() { return comments; },
    async reviews() { return []; },
    async commit() {
      commitCalls += 1;
      return {
        commit: { message: 'fix: legacy audit\n\nReview-Convergence: complete' },
        files: [{ filename: 'docs/reviews/pr-247-convergence.md' }],
      };
    },
    async pullRequest() { return pullRequest; },
    async setDraft(live, draft) { return { ...live, draft }; },
    async setStatus(...args) { statuses.push(args); },
    async markReplacementRequired() {},
    async updateStickyComment(...args) { sticky.push(args); },
  };

  const blocked = await reviewGate.enforceReviewConvergence(
    client,
    pullRequest,
    head,
  );
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.state, 'replacement_required');
  assert.equal(statuses[0][1], 'failure');
  assert.match(statuses[0][2], /replacement PR/u);
  assert.match(sticky[0][1], /replacement_required/u);
  assert.match(sticky[0][1], /Replaces: #247/u);
  assert.match(sticky[0][1], /close this PR/iu);
  assert.equal(commitCalls, 0, 'replacement is decided from finding-head history alone');
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
    head: { sha: expectedHead, repo: { full_name: 'JagPat/PMCvitan' } },
    base: { ref: 'main', repo: { full_name: 'JagPat/PMCvitan' } },
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
    head: { sha: expectedHead, repo: { full_name: 'JagPat/PMCvitan' } },
    base: { ref: 'main', repo: { full_name: 'JagPat/PMCvitan' } },
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
    head: { sha: expectedHead, repo: { full_name: 'JagPat/PMCvitan' } },
    base: { ref: 'main', repo: { full_name: 'JagPat/PMCvitan' } },
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
  assert.match(workflow, /timeout-minutes:\s*90/);
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

test('a base retargeted MID-POLL cannot mint an obligation, publish a finding, or promote', async () => {
  // THE FINDING on this unit's first head, reproduced. Checking the base once in `run()`
  // answers a question about the moment the workflow STARTED. A retarget changes neither the
  // head SHA nor the state, so both of `refreshCurrentHead`'s original guards pass — and the
  // controller carries on mutating a unit that can no longer land on `main`.
  //
  // The damaging mutation is EXHAUSTION: two finding-bearing heads take
  // `enforceReviewConvergence` to `markReplacementRequired`, and that label is a
  // REPOSITORY-WIDE obligation which then refuses every fresh `main` unit — exactly the
  // outcome the eligibility rule exists to prevent, arrived at from the other side.
  const expectedHead = 'd'.repeat(40);
  const onMain = {
    number: 601,
    state: 'open',
    draft: false,
    body: '<!-- correction-owner: claude -->',
    head: { sha: expectedHead, repo: { full_name: 'JagPat/PMCvitan' } },
    base: { ref: 'main', repo: { full_name: 'JagPat/PMCvitan' } },
    html_url: 'https://github.com/JagPat/PMCvitan/pull/601',
  };
  // What the controller re-reads AFTER the poll: same head, same state, new base.
  const retargeted = { ...onMain, base: { ref: 'release', repo: { full_name: 'JagPat/PMCvitan' } } };

  const marked = [];
  const draftTransitions = [];
  const client = {
    async pullRequest() { return retargeted; },
    async setDraft(current, draft) { draftTransitions.push(draft); return { ...current, draft }; },
    async setStatus() {},
    async markReplacementRequired(number) { marked.push(number); },
    async updateStickyComment() {},
    async reviews() { return []; },
    async reviewComments() {
      return [
        { user: { login: 'chatgpt-codex-connector[bot]' },
          original_commit_id: 'c'.repeat(40), body: '**P1** first-head finding' },
        { user: { login: 'chatgpt-codex-connector[bot]' },
          original_commit_id: expectedHead, body: '**P1** second-head finding' },
      ];
    },
  };

  // Two finding-bearing heads: without the re-check this reaches markReplacementRequired.
  const result = await reviewGate.enforceReviewConvergence(client, onMain, expectedHead);

  assert.equal(marked.length, 0,
    'a retargeted unit must not be labelled — that label is a repository-wide obligation');
  assert.equal(result.superseded, true,
    'the convergence must report itself superseded rather than completing');
  assert.deepEqual(draftTransitions, [],
    'and no lifecycle transition may be written against a unit that cannot land on main');
});

test('the same re-check does not disturb a unit that is still on main', async () => {
  // Precision, not strictness: the guard must refuse ONLY the retarget. An identical
  // interleaving whose base is unchanged still records exhaustion exactly as before.
  const expectedHead = 'e'.repeat(40);
  const pullRequest = {
    number: 602,
    state: 'open',
    draft: false,
    body: '<!-- correction-owner: claude -->',
    head: { sha: expectedHead, repo: { full_name: 'JagPat/PMCvitan' } },
    base: { ref: 'main', repo: { full_name: 'JagPat/PMCvitan' } },
    html_url: 'https://github.com/JagPat/PMCvitan/pull/602',
  };
  const marked = [];
  const client = {
    async pullRequest() { return pullRequest; },
    async setDraft(current, draft) { return { ...current, draft }; },
    async setStatus() {},
    async markReplacementRequired(number) { marked.push(number); },
    async updateStickyComment() {},
    async reviews() { return []; },
    async reviewComments() {
      return [
        { user: { login: 'chatgpt-codex-connector[bot]' },
          original_commit_id: 'c'.repeat(40), body: '**P1** first-head finding' },
        { user: { login: 'chatgpt-codex-connector[bot]' },
          original_commit_id: expectedHead, body: '**P1** second-head finding' },
      ];
    },
  };

  const result = await reviewGate.enforceReviewConvergence(client, pullRequest, expectedHead);
  assert.deepEqual(marked, [602], 'a genuine on-main exhaustion is still recorded');
  assert.equal(result.required, true);
  assert.notEqual(result.superseded, true);
});

test('a base retargeted INSIDE the setDraft window is refused on the post-mutation object', async () => {
  // ROUND 3's finding, reproduced. `refreshCurrentHead` base-checks the pull request, then
  // `client.setDraft()` REFETCHES and returns the post-mutation object — authoritative
  // evidence about a moment AFTER that guard ran. Accepting it on `state` and `head.sha`
  // alone let a retarget inside the mutation window through, and `reviewAttempt()` then
  // proceeded with an off-`main` object, so the ready transition could still trigger Codex
  // on a unit that can never land on `main`.
  const expectedHead = 'f'.repeat(40);
  const onMain = {
    number: 700,
    state: 'open',
    draft: true,
    node_id: 'PR_700',
    body: '<!-- correction-owner: claude -->',
    head: { sha: expectedHead, repo: { full_name: 'JagPat/PMCvitan' } },
    base: { ref: 'main', repo: { full_name: 'JagPat/PMCvitan' } },
    html_url: 'https://github.com/JagPat/PMCvitan/pull/700',
  };

  let setDraftCalls = 0;
  const client = {
    // The pre-mutation refresh sees `main`; the post-mutation refetch sees `release`.
    async pullRequest() { return onMain; },
    async setDraft(current, draft) {
      setDraftCalls += 1;
      return {
        ...current,
        draft,
        base: { ref: 'release', repo: { full_name: 'JagPat/PMCvitan' } },
      };
    },
  };

  const result = await reviewGate.setDraftForCurrentHead(client, 700, expectedHead, false);

  assert.equal(setDraftCalls, 1, 'the mutation really was attempted — this is not a no-op');
  assert.equal(result, null,
    'the post-mutation object must be refused, so no caller proceeds with an off-main unit');
});

test('the post-mutation check does not disturb a unit that stayed on main', async () => {
  // Precision: the same path, retarget-free, still returns the promoted pull request.
  const expectedHead = 'a'.repeat(40);
  const onMain = {
    number: 701,
    state: 'open',
    draft: true,
    node_id: 'PR_701',
    body: '<!-- correction-owner: claude -->',
    head: { sha: expectedHead, repo: { full_name: 'JagPat/PMCvitan' } },
    base: { ref: 'main', repo: { full_name: 'JagPat/PMCvitan' } },
    html_url: 'https://github.com/JagPat/PMCvitan/pull/701',
  };
  const client = {
    async pullRequest() { return onMain; },
    async setDraft(current, draft) { return { ...current, draft }; },
  };

  const result = await reviewGate.setDraftForCurrentHead(client, 701, expectedHead, false);
  assert.ok(result, 'an unchanged unit is still promoted');
  assert.equal(result.draft, false);
  assert.equal(result.base.ref, 'main');
});
