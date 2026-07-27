import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  MAX_REVIEW_ATTEMPTS,
  REQUIRED_CHECKS,
  summarizeRequiredChecks,
} from './autonomous-review-gate.mjs';

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

test('workflow starts a review only after CI or an operator dispatch', async () => {
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
  assert.match(workflow, /statuses:\s*write/);
  assert.match(workflow, /pull-requests:\s*write/);
  assert.match(workflow, /issues:\s*write/);
  assert.match(workflow, /ref:\s*\$\{\{ github\.event\.repository\.default_branch \}\}/);
  assert.match(workflow, /persist-credentials:\s*false/);
  assert.match(workflow, /actions\/checkout@[0-9a-f]{40}/);
  assert.match(workflow, /actions\/setup-node@[0-9a-f]{40}/);
  assert.doesNotMatch(workflow, /pull_request_target:/);
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
