// The ONE required status, and only that.
//
// A path-based risk classifier lived alongside this and was withdrawn — see
// `docs/reviews/pr-263-convergence.md`. These probes are the subset that were
// never about classification: they test whether the gate correctly summarises
// what the jobs actually reported.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { assessQualityGate } from './ci-quality-verdict.mjs';

const SUITES = ['web', 'e2e', 'api', 'api-e2e', 'upgrade-proof'];

test('G1: all-success passes', () => {
  const gate = assessQualityGate({ web: 'success', api: 'success' });
  assert.equal(gate.passed, true);
  assert.match(gate.reason, /all 2 required checks passed/u);
});

test('G2: a deliberate skip passes and is NAMED, never silently absent', () => {
  // `battery-plan` skips the products when this exact head is already covered.
  // That is deliberate, and the gate says which suites did not run rather than
  // leaving them unexplained.
  const gate = assessQualityGate({
    'review-scope': 'success',
    web: 'skipped',
    api: 'skipped',
    'upgrade-proof': 'skipped',
  });
  assert.equal(gate.passed, true);
  assert.match(gate.reason, /not applicable to this change/u);
  assert.match(gate.reason, /upgrade-proof/u, 'skipped suites are listed by name');
});

test('G3: failure and CANCELLED both block — a cancel never reached a verdict', () => {
  assert.equal(assessQualityGate({ web: 'success', api: 'failure' }).passed, false);

  const cancelled = assessQualityGate({ web: 'success', api: 'cancelled' });
  assert.equal(cancelled.passed, false, 'a cancelled run is not a passed run');
  assert.match(cancelled.reason, /api: cancelled/u);
});

test('G4: an upstream gate failing blocks even though everything below is skipped', () => {
  // review-scope failing skips every product job. If skips alone were accepted,
  // the gate would pass a pull request its own scope check refused.
  const gate = assessQualityGate({
    'review-scope': 'failure',
    web: 'skipped',
    api: 'skipped',
  });
  assert.equal(gate.passed, false);
  assert.match(gate.reason, /review-scope: failure/u);
});

test('G5: an unrecognised result is a FAILURE, not a pass', () => {
  // A whitelist, not a blacklist: a result GitHub introduces later that this
  // code has never seen must block rather than slip through.
  assert.equal(assessQualityGate({ web: 'neutral' }).passed, false);
  assert.equal(assessQualityGate({ web: '' }).passed, false);
  assert.equal(assessQualityGate({ web: undefined }).passed, false);
  assert.equal(assessQualityGate({}).passed, false, 'no results is not a pass');
  assert.equal(assessQualityGate(null).passed, false);
});

test('G6: the workflow wires the gate to every job, and runs it even on failure', async () => {
  const workflow = await readFile(
    new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8',
  );
  const gate = workflow.slice(workflow.indexOf('  quality-gate:'));

  // `always()` is the load-bearing part: without it a failing job SKIPS the
  // gate, and a skipped required check is not a failing one — the pull request
  // would sit forever instead of being refused.
  assert.match(gate, /if:\s*always\(\)/u, 'the gate must run even when a job fails');

  for (const job of [...SUITES, 'review-scope', 'battery-plan', 'automation']) {
    assert.ok(gate.includes(`- ${job}`), `the gate must depend on ${job}`);
  }
});

test('G7: the automation suite is NOT gated on the battery plan', async () => {
  // It tests the loop's own scripts and must run for every change, including a
  // docs-only one — `docs/STATUS.md` is parsed by the state machine, so a
  // Markdown edit really can break it. Seconds, not minutes.
  const workflow = await readFile(
    new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8',
  );
  const automation = workflow.slice(
    workflow.indexOf('  automation:'), workflow.indexOf('  web:'),
  );
  assert.doesNotMatch(automation, /run_products/u);
  assert.match(automation, /pnpm test:automation/u);
});

test('G8: no classifier remains — the withdrawal is complete', async () => {
  // Fixing by subtraction only works if the subtraction is real. A leftover
  // reference would mean the plumbing is still reachable while its probes are
  // gone, which is worse than either shipping or removing it.
  const workflow = await readFile(
    new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8',
  );
  assert.doesNotMatch(workflow, /classify|not-applicable|force_all|prior-evidence/u);

  const { readdir } = await import('node:fs/promises');
  const scripts = await readdir(new URL('.', import.meta.url).pathname);
  for (const gone of ['ci-risk-classify.mjs', 'ci-prior-evidence.mjs',
    'ci-risk-classification.mjs']) {
    assert.ok(!scripts.includes(gone), `${gone} must be removed, not orphaned`);
  }
});

test('G9: the CLI the workflow runs actually EXECUTES', async () => {
  // This exists because it did not. A rename left `ci-quality-gate.mjs`
  // importing a module that no longer existed, and the suite stayed green at
  // 179/179 because every probe imported the verdict module DIRECTLY and
  // nothing ran the entry point. The workflow found it instead of the tests —
  // a test that does not cover the thing that runs proves nothing about it.
  //
  // So this spawns the real file the workflow invokes, and asserts the exit
  // code, which is the only signal the job actually consumes.
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const run = promisify(execFile);
  const cli = new URL('./ci-quality-gate.mjs', import.meta.url).pathname;

  const pass = await run(process.execPath, [cli], {
    env: { ...process.env, JOB_RESULTS: '{"web":{"result":"success"},"api":{"result":"skipped"}}' },
  });
  assert.match(pass.stdout, /PASSED/u);

  await assert.rejects(
    run(process.execPath, [cli], {
      env: { ...process.env, JOB_RESULTS: '{"web":{"result":"failure"}}' },
    }),
    (error) => {
      assert.equal(error.code, 1, 'a failing gate must exit non-zero');
      assert.match(error.stdout, /FAILED — web: failure/u);
      return true;
    },
  );

  // Unreadable input is not a pass either — the gate cannot see the run at all.
  await assert.rejects(
    run(process.execPath, [cli], { env: { ...process.env, JOB_RESULTS: 'not json' } }),
    (error) => {
      assert.equal(error.code, 1);
      return true;
    },
  );
});

test('G10: when products were not re-run, the gate DECLARES it is deferring', async () => {
  // Codex found that all-skipped products read as an unqualified pass even when
  // the preserved evidence for the head is red. battery-plan deliberately counts
  // a failed run as coverage — "the fix for red products is a new SHA, not a
  // metadata edit" — so the skips are real, and re-running is not the answer.
  //
  // Reading the preserved evidence to resolve it is what cost heads 3-5. The
  // gate instead states the authority it is standing on, so nobody can read a
  // pass as "the product suites were verified on this event".
  const covered = assessQualityGate(
    { 'review-scope': 'success', web: 'skipped', api: 'skipped' },
    { productsRerun: false },
  );
  assert.equal(covered.passed, true, 'the standing product checks still block a red head');
  assert.equal(covered.deferred, true, 'and the gate must mark itself as deferring');
  assert.match(covered.reason, /standing product checks remain the authority/u);
  assert.match(covered.reason, /has NOT verified them/u);

  // When the products DID run, the gate speaks for itself.
  const own = assessQualityGate({ web: 'success', api: 'success' });
  assert.equal(own.deferred, false);
  assert.match(own.reason, /all 2 required checks passed/u);

  // Deferral never rescues a real failure reported in THIS run.
  const red = assessQualityGate({ web: 'failure' }, { productsRerun: false });
  assert.equal(red.passed, false, 'a failure in this run still blocks');

  // And the CLI surfaces it, since the log is what a human reads on the PR.
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const cli = new URL('./ci-quality-gate.mjs', import.meta.url).pathname;
  const out = await promisify(execFile)(process.execPath, [cli], {
    env: {
      ...process.env,
      RUN_PRODUCTS: 'false',
      JOB_RESULTS: '{"review-scope":{"result":"success"},"web":{"result":"skipped"}}',
    },
  });
  assert.match(out.stdout, /has NOT verified them/u);
});
