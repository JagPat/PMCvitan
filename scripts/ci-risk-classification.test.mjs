// Risk-based CI: run the suites a change can actually break, and publish ONE
// required gate.
//
// The safety property under test is asymmetric. Skipping a suite that could
// have caught a defect is the failure that matters; running a suite that could
// not possibly fail is only waste. Every probe below is therefore written to
// catch the first kind.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  SUITES,
  assessQualityGate,
  classifyChangedFiles,
} from './ci-risk-classification.mjs';

const classify = (...files) => classifyChangedFiles(files);

// ---------------------------------------------------------------------------
// R1–R5: each class of change reaches the suites that can break, and no more.
// ---------------------------------------------------------------------------

test('R1: a docs-only change runs no product suite', () => {
  const plan = classify('docs/STATUS.md', 'docs/RUNBOOK.md', 'README.md');
  assert.deepEqual(plan.suites, []);
  assert.equal(plan.confident, true);
  assert.match(plan.reason, /no changed path can affect a product suite/u);
});

test('R2: an automation-only change runs no product suite', () => {
  // `scripts/` and `.github/` are the loop's own machinery. Their tests are
  // `pnpm test:automation`, which runs unconditionally — see R9.
  const plan = classify('scripts/review-scope.mjs', '.github/workflows/ci.yml');
  assert.deepEqual(plan.suites, []);
  assert.equal(plan.confident, true);
});

test('R3: a web-only change runs web, e2e and the browser acceptance chain', () => {
  const plan = classify('apps/web/src/screens/LabourScreen.tsx');
  assert.deepEqual(plan.suites, ['web', 'e2e', 'api-e2e']);
  assert.equal(plan.confident, true);
});

test('R4: an API change runs the API suites but not the web unit suite', () => {
  const plan = classify('apps/api/src/labour/labour.service.ts');
  assert.deepEqual(plan.suites, ['api', 'api-e2e']);
});

test('R5: a schema/migration change additionally runs the upgrade proof', () => {
  // The upgrade proof exists to prove a legacy database survives migrations.
  // Only a migration or schema edit can break it — but every one of them can.
  const plan = classify('apps/api/prisma/migrations/20270305000000_x/migration.sql');
  assert.deepEqual(plan.suites, ['api', 'api-e2e', 'upgrade-proof']);
  assert.deepEqual(classify('apps/api/prisma/schema.prisma').suites, [
    'api', 'api-e2e', 'upgrade-proof',
  ]);
});

test('R6: shared contracts are CROSS-CUTTING, not web', () => {
  // Both apps import @vitan/shared at runtime. Classifying it as "web" was the
  // first draft: a shared contract edit is exactly the change that breaks the
  // API typecheck, and skipping the API suite for it would be the defect this
  // whole module has to avoid.
  assert.deepEqual(classify('packages/shared/src/index.ts').suites, SUITES);
});

// ---------------------------------------------------------------------------
// R7–R8: unknown widens. This is the safety property.
// ---------------------------------------------------------------------------

test('R7: an unrecognised path runs the FULL battery and says it is unsure', () => {
  const plan = classify('apps/web/src/App.tsx', 'infra/terraform/main.tf');
  assert.deepEqual(plan.suites, SUITES, 'never narrower than everything');
  assert.equal(plan.confident, false);
  assert.deepEqual(plan.unknown, ['infra/terraform/main.tf']);
  assert.match(plan.reason, /match no classification rule/u);
});

test('R7b: ONE unknown path outweighs any number of known-safe ones', () => {
  // The union must not be computed first and the unknown noticed afterwards —
  // that ordering is how a "mostly docs" pull request skips the API suite.
  const plan = classify('docs/a.md', 'docs/b.md', 'docs/c.md', 'Makefile');
  assert.deepEqual(plan.suites, SUITES);
  assert.equal(plan.confident, false);
});

test('R8: unclassified ROOT files widen — dependencies change what every suite installs', () => {
  for (const file of ['package.json', 'pnpm-lock.yaml', 'tsconfig.base.json']) {
    const plan = classify(file);
    assert.deepEqual(plan.suites, SUITES, `${file} must widen`);
    assert.equal(plan.confident, false, `${file} must be unconfident`);
  }
});

test('R8b: an empty or unreadable file list widens rather than skipping everything', () => {
  // "No files changed" is not a thing a real pull request is; it means the
  // listing failed. Treating it as "nothing can break" would skip the entire
  // battery on an API error.
  for (const input of [[], null, undefined, 'not-an-array']) {
    const plan = classifyChangedFiles(input);
    assert.deepEqual(plan.suites, SUITES);
    assert.equal(plan.confident, false);
  }
  const malformed = classifyChangedFiles([{ nope: true }]);
  assert.deepEqual(malformed.suites, SUITES);
  assert.equal(malformed.confident, false);
});

test('R9: a Markdown file inside a product tree is still documentation', () => {
  assert.deepEqual(classify('apps/api/README.md').suites, []);
  assert.deepEqual(classify('packages/shared/NOTES.md').suites, []);
});

test('R10: mixed known changes take the UNION of their suites', () => {
  const plan = classify('docs/STATUS.md', 'apps/api/src/x.ts', 'apps/web/src/y.tsx');
  assert.deepEqual(plan.suites, ['web', 'e2e', 'api', 'api-e2e']);
  assert.equal(plan.confident, true);
});

test('R10b: the suite order is canonical regardless of file order', () => {
  const forward = classify('apps/api/src/x.ts', 'apps/web/src/y.tsx').suites;
  const reverse = classify('apps/web/src/y.tsx', 'apps/api/src/x.ts').suites;
  assert.deepEqual(forward, reverse);
});

// ---------------------------------------------------------------------------
// R11–R14: the ONE required gate. Only success and deliberate skip may pass.
// ---------------------------------------------------------------------------

test('R11: all-success passes', () => {
  const gate = assessQualityGate({ web: 'success', api: 'success' });
  assert.equal(gate.passed, true);
  assert.match(gate.reason, /all 2 required checks passed/u);
});

test('R12: a deliberate skip passes and is NAMED, never silently absent', () => {
  const gate = assessQualityGate({
    'review-scope': 'success',
    web: 'skipped',
    api: 'skipped',
    'upgrade-proof': 'skipped',
  });
  assert.equal(gate.passed, true);
  assert.match(gate.reason, /not applicable to this change/u);
  assert.match(gate.reason, /upgrade-proof/u, 'the skipped suites are listed by name');
});

test('R13: failure and CANCELLED both block — a cancel never reached a verdict', () => {
  assert.equal(assessQualityGate({ web: 'success', api: 'failure' }).passed, false);

  const cancelled = assessQualityGate({ web: 'success', api: 'cancelled' });
  assert.equal(cancelled.passed, false, 'a cancelled run is not a passed run');
  assert.match(cancelled.reason, /api: cancelled/u);
});

test('R13b: an upstream gate failing blocks even though everything below it is skipped', () => {
  // review-scope failing skips every product job. If skips alone were accepted
  // the gate would pass a pull request whose scope check refused it.
  const gate = assessQualityGate({
    'review-scope': 'failure',
    web: 'skipped',
    api: 'skipped',
  });
  assert.equal(gate.passed, false);
  assert.match(gate.reason, /review-scope: failure/u);
});

test('R14: an unrecognised result is a FAILURE, not a pass', () => {
  // A whitelist, not a blacklist: a result GitHub introduces later that this
  // code has never seen must block rather than slip through.
  assert.equal(assessQualityGate({ web: 'neutral' }).passed, false);
  assert.equal(assessQualityGate({ web: '' }).passed, false);
  assert.equal(assessQualityGate({ web: undefined }).passed, false);
  assert.equal(assessQualityGate({}).passed, false, 'no results is not a pass');
  assert.equal(assessQualityGate(null).passed, false);
});

// ---------------------------------------------------------------------------
// R15: the workflow actually wires this up. A classifier nothing consults
// governs nothing — the objection that cost the lease work two review rounds,
// asserted here before it can repeat.
// ---------------------------------------------------------------------------

test('R15: every product job is gated on the classification and feeds the gate', async () => {
  const workflow = await readFile(
    new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8',
  );

  for (const suite of SUITES) {
    // The COMMA DELIMITERS are the assertion, not decoration: a bare
    // `contains(suites, 'api')` matches inside 'api-e2e', so selecting only
    // api-e2e would silently drag in the api suite.
    assert.match(
      workflow, new RegExp(`contains\\(needs\\.classify\\.outputs\\.suites, ',${suite},'\\)`, 'u'),
      `job ${suite} must be gated on the classification, delimited`,
    );
  }

  // The gate must depend on every product suite plus the scope check, and must
  // run even when they fail — `if: always()` is what makes a failure reach the
  // gate instead of skipping it into a pass.
  const gateBlock = workflow.slice(workflow.indexOf('  quality-gate:'));
  assert.match(gateBlock, /if:\s*always\(\)/u, 'the gate must run even when a job fails');
  for (const suite of [...SUITES, 'review-scope', 'automation']) {
    assert.ok(
      new RegExp(`needs:[^\\n]*\\n(?:[^\\n]*\\n)*?[^\\n]*${suite}`, 'u').test(gateBlock)
        || gateBlock.includes(suite),
      `the gate must depend on ${suite}`,
    );
  }
});

test('R15b: the automation suite is NOT gated on the classification', async () => {
  // It tests the loop's own scripts and must run for every change, including a
  // docs-only one — `docs/STATUS.md` is parsed by the state machine, so a
  // Markdown edit really can break it.
  const workflow = await readFile(
    new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8',
  );
  const automation = workflow.slice(
    workflow.indexOf('  automation:'), workflow.indexOf('  web:'),
  );
  assert.doesNotMatch(automation, /needs\.classify\.outputs\.suites/u);
});
