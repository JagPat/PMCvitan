import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import * as reviewGate from './autonomous-review-gate.mjs';

const {
  hasTerminalReviewFailureSince,
  reviewCycleStartedAt,
  MAX_REVIEW_ATTEMPTS,
  REQUIRED_CHECKS,
  summarizeRequiredChecks,
} = reviewGate;

const workflowPath = new URL('../.github/workflows/auto-merge.yml', import.meta.url);
const ciPath = new URL('../.github/workflows/ci.yml', import.meta.url);
const autonomousLoopPath = new URL('../docs/AUTONOMOUS_LOOP.md', import.meta.url);

function checkRun(name, conclusion = 'success', status = 'completed') {
  return { name, conclusion, status };
}

test('requires every named CI check to have a successful latest run', () => {
  const success = REQUIRED_CHECKS.map((name) => checkRun(name));
  assert.deepEqual(summarizeRequiredChecks(success), {
    state: 'success',
    missing: [],
    pending: [],
    failed: [],
  });

  assert.deepEqual(summarizeRequiredChecks(success.slice(1)), {
    state: 'pending',
    missing: ['web'],
    pending: [],
    failed: [],
  });

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
      trigger: 'ci',
    },
  );
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

test('a review failure remains latched after a later success write', () => {
  const reviewStartedAt = '2026-07-27T18:00:00Z';
  assert.equal(
    hasTerminalReviewFailureSince(
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
          created_at: '2026-07-27T18:00:02Z',
        },
      ],
      reviewStartedAt,
    ),
    true,
  );
  assert.equal(
    hasTerminalReviewFailureSince(
      [
        {
          context: 'codex-current-head',
          state: 'failure',
          description: 'review: stale finding',
          created_at: '2026-07-27T17:59:59Z',
        },
      ],
      reviewStartedAt,
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
  const cycleStartedAt = reviewCycleStartedAt(statuses);
  assert.equal(cycleStartedAt, '2026-07-27T18:10:00Z');
  assert.equal(
    hasTerminalReviewFailureSince(statuses, cycleStartedAt),
    true,
  );
});

test('a recovery dispatch requires the exact latest failed terminal status', () => {
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

test('recovery uses a durable status token and a CI-independent lane', async () => {
  const [workflow, gate] = await Promise.all([
    readFile(workflowPath, 'utf8'),
    readFile(new URL('./autonomous-review-gate.mjs', import.meta.url), 'utf8'),
  ]);

  assert.match(workflow, /terminal_status_id:/);
  assert.match(workflow, /github\.event_name == 'workflow_dispatch' && 'recovery'/);
  assert.match(gate, /authorizeRecoveryDispatch\(/);
  assert.doesNotMatch(gate, /GITHUB_RUN_ID/);
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
  assert.match(gate, /context\.trigger === 'ci'/);
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

test('one polled Codex invocation owns terminal success and auto-merge', async () => {
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
  const autoMerge = clearBranch.lastIndexOf('enableAutoMerge');
  assert.ok(finalEvidence >= 0);
  assert.ok(publishedSuccess > finalEvidence);
  assert.ok(autoMerge > publishedSuccess);
  assert.doesNotMatch(clearBranch, /TERMINAL_SETTLE_MS/);
  assert.doesNotMatch(clearBranch, /admitAutoMerge/);
  assert.doesNotMatch(clearBranch, /handleCodexEvidence/);
});

test('review cycles are serialized by pull request and exact head', async () => {
  const workflow = await readFile(workflowPath, 'utf8');
  assert.match(workflow, /github\.event\.workflow_run\.head_sha/);
  assert.match(workflow, /inputs\.head_sha/);
  assert.doesNotMatch(workflow, /github\.event\.pull_request/);
  assert.match(workflow, /cancel-in-progress:\s*false/);
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
  assert.match(terminalHelper, /reviewCycleStartedAt/);
  assert.match(terminalHelper, /hasTerminalReviewFailureSince/);
  assert.ok(
    terminalHelper.indexOf('hasTerminalReviewFailureSince')
      < terminalHelper.indexOf('enableAutoMerge'),
  );
  assert.match(terminalHelper, /setDraftForCurrentHead[\s\S]*true/);

  const runBody = gate.slice(gate.indexOf('export async function run()'));
  const ciFailure = runBody.indexOf(
    "context.ciConclusion && context.ciConclusion !== 'success'",
  );
  const terminalRecovery = runBody.indexOf('ensureTerminalReviewState(');
  assert.ok(ciFailure >= 0 && ciFailure < terminalRecovery);
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
  const workflow = await readFile(workflowPath, 'utf8');
  assert.match(workflow, /head_sha:/);
  assert.match(workflow, /inputs\.head_sha/);
  assert.match(workflow, /terminal_status_id:/);
  assert.match(workflow, /inputs\.terminal_status_id/);
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

test('workflow invokes the exact-head gate and CI executes its tests', async () => {
  const [workflow, ci] = await Promise.all([
    readFile(workflowPath, 'utf8'),
    readFile(ciPath, 'utf8'),
  ]);

  assert.match(workflow, /scripts\/autonomous-review-gate\.mjs/);
  assert.match(workflow, /codex-current-head/);
  assert.match(ci, /pnpm test:automation/);
});

test('rechecks the live head before terminal PR mutations', async () => {
  const gate = await readFile(
    new URL('./autonomous-review-gate.mjs', import.meta.url),
    'utf8',
  );

  assert.match(gate, /async function refreshCurrentHead\(/);
  assert.match(gate, /enableAutoMerge\(pullRequest\)/);
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

test('CI runs once per pull-request head', async () => {
  const ci = await readFile(ciPath, 'utf8');

  assert.match(ci, /pull_request:/);
  assert.doesNotMatch(ci, /push:/);
});
