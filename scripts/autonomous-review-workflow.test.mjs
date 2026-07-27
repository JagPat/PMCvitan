import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import * as reviewGate from './autonomous-review-gate.mjs';

const {
  MAX_REVIEW_ATTEMPTS,
  REQUIRED_CHECKS,
  summarizeRequiredChecks,
} = reviewGate;

const workflowPath = new URL('../.github/workflows/auto-merge.yml', import.meta.url);
const ciPath = new URL('../.github/workflows/ci.yml', import.meta.url);

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

test('result-only events accept only exact-head Codex evidence', () => {
  assert.equal(typeof reviewGate.contextForEvent, 'function');
  const head = 'a'.repeat(40);
  const pullRequest = { number: 230, head: { sha: head } };
  const codex = { login: 'chatgpt-codex-connector[bot]' };

  assert.deepEqual(
    reviewGate.contextForEvent('pull_request_review', {
      action: 'submitted',
      pull_request: pullRequest,
      review: { user: codex, commit_id: head },
    }),
    {
      number: 230,
      expectedHead: head,
      trigger: 'evidence',
      evidenceDetail: 'Codex submitted a current-head review',
    },
  );
  assert.deepEqual(
    reviewGate.contextForEvent('pull_request_review_comment', {
      action: 'created',
      pull_request: pullRequest,
      comment: {
        user: codex,
        commit_id: head,
        original_commit_id: head,
      },
    }),
    {
      number: 230,
      expectedHead: head,
      trigger: 'evidence',
      evidenceDetail: 'Codex submitted a current-head finding',
    },
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

test('workflow separates review-start events from result-only evidence events', async () => {
  const [workflow, gate] = await Promise.all([
    readFile(workflowPath, 'utf8'),
    readFile(new URL('./autonomous-review-gate.mjs', import.meta.url), 'utf8'),
  ]);

  assert.match(workflow, /workflow_run:/);
  assert.match(workflow, /workflows:\s*\[CI\]/);
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /pull_request_review:\s*\n\s*types:\s*\[submitted\]/);
  assert.match(workflow, /pull_request_review_comment:\s*\n\s*types:\s*\[created\]/);
  assert.match(gate, /eventName === 'pull_request_review'/);
  assert.match(gate, /eventName === 'pull_request_review_comment'/);
  assert.match(gate, /trigger:\s*'evidence'/);
  assert.match(gate, /handleCodexEvidence\(/);
  const evidenceHandler = gate.slice(
    gate.indexOf('async function handleCodexEvidence'),
    gate.indexOf('async function waitForRequiredChecks'),
  );
  assert.doesNotMatch(evidenceHandler, /reviewAttempt\(/);
  assert.doesNotMatch(evidenceHandler, /setDraftForCurrentHead[\s\S]*false/);
  assert.match(gate, /context\.trigger === 'ci'/);
  assert.match(gate, /client\.latestStatus\(/);
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

test('terminal success queues auto-merge before it can end the workflow', async () => {
  const gate = await readFile(
    new URL('./autonomous-review-gate.mjs', import.meta.url),
    'utf8',
  );
  assert.match(gate, /ensureTerminalReviewState\(/);
  const clearBranch = gate.slice(
    gate.indexOf("if (result.state === 'clear')"),
    gate.indexOf('if (attempt < MAX_REVIEW_ATTEMPTS)'),
  );
  assert.ok(clearBranch.indexOf('enableAutoMerge') >= 0);
  assert.ok(clearBranch.indexOf('enableAutoMerge') < clearBranch.indexOf("'success'"));
});

test('workflow has no AI action or AI credential dependency', async () => {
  const workflow = await readFile(workflowPath, 'utf8');

  assert.doesNotMatch(workflow, /ANTHROPIC_API_KEY/);
  assert.doesNotMatch(workflow, /OPENAI_API_KEY/);
  assert.doesNotMatch(workflow, /anthropics\/claude-code-action/);
  assert.doesNotMatch(workflow, /openai\/codex-action/);
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
