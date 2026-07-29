// One product-CI battery per SHA.
//
// The five product jobs (web, api, e2e, api-e2e, upgrade-proof) are expensive.
// A PR body/title edit (`edited` event) changes review-unit EVIDENCE, never
// code, so it must re-run only the dependency-free review-scope check — it must
// never launch a second product battery for a SHA the code events already
// covered. These tests pin that split structurally across EVERY workflow file:
// if someone re-adds `edited` to ci.yml, adds a product job to the edit
// workflow, or defines a second launcher for a product job anywhere, this file
// goes red.
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import test from 'node:test';

const workflowsDir = new URL('../.github/workflows/', import.meta.url);
const PRODUCT_JOBS = ['web', 'api', 'e2e', 'api-e2e', 'upgrade-proof'];

async function workflowFiles() {
  const entries = await readdir(workflowsDir);
  return entries.filter((name) => /\.ya?ml$/u.test(name)).sort();
}

function pullRequestTypes(workflow) {
  const match = /(^|\n)on:[\s\S]*?\n\s+pull_request:\s*\n\s+types:\s*\[([^\]]*)\]/u.exec(
    workflow,
  );
  if (!match) return null;
  return match[2].split(',').map((type) => type.trim()).filter(Boolean);
}

function jobNames(workflow) {
  const jobsStart = workflow.search(/(^|\n)jobs:\s*\n/u);
  assert.ok(jobsStart >= 0, 'workflow has a jobs: block');
  const jobsBlock = workflow.slice(jobsStart);
  return [...jobsBlock.matchAll(/\n {2}([A-Za-z0-9_-]+):/gu)]
    .map((match) => match[1])
    // step-level keys are indented deeper and never match the two-space level;
    // filter well-known non-job keys defensively anyway
    .filter((name) => !['with', 'env', 'ports', 'options'].includes(name));
}

test('ci.yml launches the product battery only on code events', async () => {
  const workflow = await readFile(new URL('ci.yml', workflowsDir), 'utf8');
  const types = pullRequestTypes(workflow);
  assert.deepEqual(
    types,
    ['opened', 'synchronize', 'reopened'],
    'product CI must be keyed to the events that introduce or restore code; a '
      + 'body edit must never launch it',
  );
  const jobs = jobNames(workflow);
  for (const job of PRODUCT_JOBS) {
    assert.ok(jobs.includes(job), `ci.yml defines the product job ${job}`);
  }
  assert.ok(jobs.includes('review-scope'), 'ci.yml runs the scope check first');
});

test('a PR body edit runs only the dependency-free scope check', async () => {
  const workflow = await readFile(
    new URL('pr-edit-scope.yml', workflowsDir),
    'utf8',
  );
  assert.deepEqual(pullRequestTypes(workflow), ['edited']);
  assert.deepEqual(
    jobNames(workflow),
    ['review-scope'],
    'the edited-event workflow must contain exactly the review-scope job',
  );
  assert.match(workflow, /node scripts\/review-scope\.mjs/u);
  // cheap by construction: no dependency install, no database service
  assert.doesNotMatch(workflow, /pnpm install|setup-node|postgres/u);
});

test('exactly one workflow can launch each product job', async () => {
  const launchers = new Map(PRODUCT_JOBS.map((job) => [job, []]));
  for (const file of await workflowFiles()) {
    const workflow = await readFile(new URL(file, workflowsDir), 'utf8');
    for (const job of jobNames(workflow)) {
      if (launchers.has(job)) launchers.get(job).push(file);
    }
  }
  for (const [job, files] of launchers) {
    assert.deepEqual(
      files,
      ['ci.yml'],
      `product job ${job} must be defined only by ci.yml`,
    );
  }
});

test('the edited event reaches exactly one workflow', async () => {
  const editedHandlers = [];
  for (const file of await workflowFiles()) {
    const workflow = await readFile(new URL(file, workflowsDir), 'utf8');
    const types = pullRequestTypes(workflow);
    if (types?.includes('edited')) editedHandlers.push(file);
  }
  assert.deepEqual(editedHandlers, ['pr-edit-scope.yml']);
});
