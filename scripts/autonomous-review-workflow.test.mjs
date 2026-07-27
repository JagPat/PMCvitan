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

test('workflow runs from trusted default-branch code after CI or dispatch', async () => {
  const workflow = await readFile(workflowPath, 'utf8');

  assert.match(workflow, /workflow_run:/);
  assert.match(workflow, /workflows:\s*\[CI\]/);
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /statuses:\s*write/);
  assert.match(workflow, /pull-requests:\s*write/);
  assert.match(workflow, /issues:\s*write/);
  assert.match(workflow, /ref:\s*\$\{\{ github\.event\.repository\.default_branch \}\}/);
  assert.match(workflow, /persist-credentials:\s*false/);
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

