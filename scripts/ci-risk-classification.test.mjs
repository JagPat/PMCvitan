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

test('R1: a docs-only change with no consumer runs no product suite', () => {
  // NOT `docs/RUNBOOK.md` — an API integration test reads that one, and using
  // it here as an example of inert prose was exactly the wrong belief. R18
  // enforces the register of docs files that really do have consumers.
  const plan = classify('docs/STATUS.md', 'docs/ARCHITECTURE.md', 'README.md');
  assert.deepEqual(plan.suites, []);
  assert.equal(plan.confident, true);
  assert.match(plan.reason, /no changed path can affect a product suite/u);
});

test('R2: loop-machinery .mjs runs no product suite', () => {
  // A `scripts/*.mjs` file is loop machinery, covered by `pnpm test:automation`
  // — which is never gated on the classification, so it always runs.
  const plan = classify('scripts/review-scope.mjs', 'scripts/ci-battery-plan.mjs');
  assert.deepEqual(plan.suites, []);
  assert.equal(plan.confident, true);
});

// ---------------------------------------------------------------------------
// The three map errors. Each is a file that DRIVES a product job while living
// outside the tree that job tests — the shape the first version got wrong three
// separate times. Blanket-trusting a directory is what made all three possible.
// ---------------------------------------------------------------------------

test('R2a: a product RUNNER script in scripts/ is not machinery — it widens', () => {
  // `scripts/test-api-e2e.sh` IS the api-e2e runner: package.json routes the
  // acceptance scripts through it and the api-e2e job calls those scripts.
  // `pnpm test:automation` never executes it, so calling it safe let a broken
  // acceptance runner merge with api-e2e skipped and the gate green.
  for (const file of ['scripts/test-api-e2e.sh', 'scripts/validate-live.sh',
    'scripts/lockdown-check.sh']) {
    const plan = classify(file);
    assert.deepEqual(plan.suites, SUITES, `${file} must widen`);
    assert.equal(plan.confident, false, `${file} must be unconfident`);
  }
});

test('R2b: a workflow file widens — it defines the product jobs themselves', () => {
  // The automation tests pin selected workflow invariants; they do not execute
  // the web/api/api-e2e/e2e/upgrade-proof job bodies. An edit that breaks a
  // job's commands or setup must not skip that job.
  const plan = classify('.github/workflows/ci.yml');
  assert.deepEqual(plan.suites, SUITES);
  assert.equal(plan.confident, false);

  // Markdown under .github/ is still documentation.
  assert.deepEqual(classify('.github/PULL_REQUEST_TEMPLATE.md').suites, []);
});

test('R2c: the upgrade-proof RUNNER reaches the upgrade-proof suite', () => {
  // The upgrade-proof job executes `apps/api/scripts/upgrade-proof.sh`. The
  // generic `apps/api/` rule gave api + api-e2e only, so a broken legacy-upgrade
  // proof runner could merge with its own proof job skipped.
  assert.deepEqual(classify('apps/api/scripts/upgrade-proof.sh').suites, [
    'api', 'api-e2e', 'upgrade-proof',
  ]);
});

test('R2d: a RENAME classifies both the old and the new path', () => {
  // GitHub reports the new `filename` and keeps the old in `previous_filename`.
  // Renaming API source to a docs path REMOVES API source; classifying only the
  // destination would skip the suites that would notice.
  const plan = classifyChangedFiles([
    { filename: 'docs/foo.md', previous_filename: 'apps/api/src/foo.ts' },
  ]);
  assert.deepEqual(plan.suites, ['api', 'api-e2e']);
  assert.equal(plan.confident, true);

  // And a rename OUT of an unknown path still widens.
  const widened = classifyChangedFiles([
    { filename: 'docs/x.md', previous_filename: 'Makefile' },
  ]);
  assert.deepEqual(widened.suites, SUITES);
  assert.equal(widened.confident, false);
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

test('R19: a battery-plan skip cannot mask a RED head', () => {
  // N2. battery-plan counts a failed product run as coverage, so a later
  // title/body edit skips every job and twin. Judged on the current run alone
  // the gate is all-skips and would go green while the real `api` failure for
  // the same head is still red — a metadata edit masking failed CI with no new
  // commit. Only genuinely green preserved evidence may justify the skip.
  const allSkipped = { web: 'skipped', api: 'skipped', 'api-e2e': 'skipped' };

  const red = assessQualityGate(allSkipped, {
    productsSkippedAsCovered: true,
    priorEvidence: { ok: false, detail: 'api failed on the first run' },
  });
  assert.equal(red.passed, false, 'a red head must not be masked by an edit');
  assert.match(red.reason, /api failed/u);

  // Absent or unreadable evidence is NOT a pass.
  for (const evidence of [null, undefined, {}, { ok: 'yes' }]) {
    assert.equal(
      assessQualityGate(allSkipped, {
        productsSkippedAsCovered: true, priorEvidence: evidence,
      }).passed,
      false,
      'unverifiable evidence must block',
    );
  }

  // Genuinely green preserved evidence justifies the skip.
  assert.equal(
    assessQualityGate(allSkipped, {
      productsSkippedAsCovered: true, priorEvidence: { ok: true },
    }).passed,
    true,
  );

  // And when the products were NOT skipped as covered, the ordinary rules apply
  // — a classification skip still passes with no evidence lookup at all.
  assert.equal(assessQualityGate(allSkipped).passed, true);
});

test('R20: in-flight product evidence is PENDING, never a terminal failure', async () => {
  // The head-3 finding, and it is the same distinction `assessQualityGate` was
  // built around: "never reached a verdict" is not "failed". battery-plan also
  // skips the products when the first battery for this head is still queued or
  // running; a two-state reader called that "no completed run" and the gate
  // published a TERMINAL failure while those jobs were still going green.
  const { assessPriorEvidence } = await import('./ci-prior-evidence.mjs');
  const all = (f) => ['web', 'e2e', 'api', 'api-e2e', 'upgrade-proof'].map(f);
  const green = (n) => ({ name: n, status: 'completed', conclusion: 'success' });

  assert.deepEqual(
    assessPriorEvidence(all(green)),
    { ok: true, pending: false, detail: 'every product check is green on this head' },
  );

  for (const status of ['queued', 'in_progress']) {
    const flying = assessPriorEvidence(all((n) => (n === 'web' ? { name: n, status } : green(n))));
    assert.equal(flying.ok, false, 'in flight is not a pass');
    assert.equal(flying.pending, true, `${status} must be PENDING, not a verdict`);
    assert.match(flying.detail, /still running: web/u);
  }

  // A real failure decides IMMEDIATELY — waiting for a sibling cannot turn an
  // already-red check green, and reporting pending would delay a knowable answer.
  const red = assessPriorEvidence(all((n) => (n === 'api'
    ? { name: n, status: 'completed', conclusion: 'failure' }
    : (n === 'web' ? { name: n, status: 'queued' } : green(n)))));
  assert.equal(red.pending, false, 'a red check decides now, even with a sibling in flight');
  assert.match(red.detail, /api: failure/u);

  // Unreadable history is still not a pass, and not pending either.
  assert.deepEqual(
    assessPriorEvidence(null),
    { ok: false, pending: false, detail: 'check history unavailable' },
  );
});

test('R20b: the runner WAITS out pending evidence instead of publishing a verdict', async () => {
  // Polls until the battery lands, then reports what it actually concluded.
  const { run } = await import('./ci-prior-evidence.mjs');
  const names = ['web', 'e2e', 'api', 'api-e2e', 'upgrade-proof'];
  let call = 0;
  const fetchImpl = async () => {
    call += 1;
    // First two reads: web still running. Third: it landed green.
    const web = call < 3
      ? { name: 'web', status: 'in_progress' }
      : { name: 'web', status: 'completed', conclusion: 'success' };
    return {
      ok: true,
      json: async () => ({
        check_runs: [
          web,
          ...names.slice(1).map((n) => ({ name: n, status: 'completed', conclusion: 'success' })),
        ],
      }),
    };
  };

  const { writeFile, mkdtemp } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const dir = await mkdtemp(join(tmpdir(), 'evidence-'));
  const eventPath = join(dir, 'event.json');
  await writeFile(eventPath, JSON.stringify({ pull_request: { head: { sha: 'abc' } } }));

  const verdict = await run({
    eventPath,
    repository: 'o/r',
    token: 't',
    outputPath: '',
    fetchImpl,
    waitMs: 60_000,
    pollMs: 0,
    sleep: async () => {},
  });
  assert.equal(verdict.ok, true, 'the battery landed green, so the gate may pass');
  assert.equal(verdict.pending, false);
  assert.ok(call >= 3, 'it polled rather than deciding on the first read');
});

test('R20c: a bounded wait that never resolves fails CLOSED, and says so', async () => {
  const { run } = await import('./ci-prior-evidence.mjs');
  const fetchImpl = async () => ({
    ok: true,
    // ALL five in flight — a partial list would make the absent ones read as
    // "no completed run", which decides immediately and would not exercise the
    // wait at all.
    json: async () => ({
      check_runs: ['web', 'e2e', 'api', 'api-e2e', 'upgrade-proof']
        .map((name) => ({ name, status: 'in_progress' })),
    }),
  });
  const { writeFile, mkdtemp } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const dir = await mkdtemp(join(tmpdir(), 'evidence2-'));
  const eventPath = join(dir, 'event.json');
  await writeFile(eventPath, JSON.stringify({ pull_request: { head: { sha: 'abc' } } }));

  let clock = 0;
  const verdict = await run({
    eventPath,
    repository: 'o/r',
    token: 't',
    outputPath: '',
    fetchImpl,
    waitMs: 100,
    pollMs: 0,
    now: () => (clock += 60),
    sleep: async () => {},
  });
  assert.equal(verdict.ok, false, 'undecided is never a pass');
  assert.match(verdict.detail, /still undecided after the wait/u);
});

test('R21: a stale hung run from a SUPERSEDED attempt is not pending', async () => {
  // Head-4 finding. Asking "is any run unfinished?" BEFORE ordering by attempt
  // currency let one hung `api` job from an old attempt pin the suite to
  // pending forever, even after a newer attempt completed all five green — the
  // gate then failed the wait on evidence that was already good.
  const { assessPriorEvidence } = await import('./ci-prior-evidence.mjs');
  const names = ['web', 'e2e', 'api', 'api-e2e', 'upgrade-proof'];
  const gate = (suite, at) => ({
    name: 'review-scope', status: 'completed', conclusion: 'success',
    check_suite: { id: suite }, completed_at: at,
  });
  const product = (name, suite, status, conclusion, at) => ({
    name, status, conclusion, check_suite: { id: suite }, completed_at: at,
  });

  const runs = [
    // OLD attempt: its gate passed, and its `api` job is still hung.
    gate(1, '2026-01-01T00:00:00Z'),
    product('api', 1, 'in_progress', null, null),
    // NEW attempt: gate passed later, all five products completed green.
    gate(2, '2026-01-02T00:00:00Z'),
    ...names.map((n) => product(n, 2, 'completed', 'success', '2026-01-02T01:00:00Z')),
  ];

  const verdict = assessPriorEvidence(runs);
  assert.equal(verdict.pending, false, 'a superseded hung run must not pin it pending');
  assert.equal(verdict.ok, true, 'the current attempt is green');
});

test('R21b: an unfinished run in the CURRENT attempt still counts as pending', async () => {
  // The other direction — currency must not become an excuse to ignore live work.
  const { assessPriorEvidence } = await import('./ci-prior-evidence.mjs');
  const names = ['web', 'e2e', 'api', 'api-e2e', 'upgrade-proof'];
  const gate = (suite, at) => ({
    name: 'review-scope', status: 'completed', conclusion: 'success',
    check_suite: { id: suite }, completed_at: at,
  });
  const runs = [
    gate(1, '2026-01-01T00:00:00Z'),
    ...names.map((n) => ({
      name: n, status: 'completed', conclusion: 'success',
      check_suite: { id: 1 }, completed_at: '2026-01-01T01:00:00Z',
    })),
    // A NEWER attempt is running now.
    gate(2, '2026-01-02T00:00:00Z'),
    { name: 'api', status: 'in_progress', check_suite: { id: 2 } },
  ];
  const verdict = assessPriorEvidence(runs);
  assert.equal(verdict.pending, true, 'a newer in-flight run supersedes older green');
  assert.match(verdict.detail, /still running: api/u);
});

test('R22: classify is a GATE in the shared coverage model', async () => {
  // Head-4 P1. `classify` gates every product job in the workflow, but the
  // coverage model knew only review-scope and battery-plan. An attempt where
  // classify FAILED still counted as "gates passed", so its skipped products
  // read as a deliberate covered-head skip and a later metadata edit accepted
  // the OLD base's successes as preserved evidence — green without the five
  // product jobs ever passing on the new merge result.
  const { GATE_CHECKS, attemptsWithPassingGates } = await import('./check-run-coverage.mjs');
  assert.ok(GATE_CHECKS.includes('classify'), 'classify must be a registered gate');

  const run = (name, conclusion, suite) => ({
    name, status: 'completed', conclusion, check_suite: { id: suite },
  });

  // classify FAILED -> the attempt aborted, so its skips are not deliberate.
  const failed = attemptsWithPassingGates([
    run('review-scope', 'success', 7),
    run('battery-plan', 'success', 7),
    run('classify', 'failure', 7),
  ]);
  assert.equal(failed.has('suite:7'), false, 'a failed classify aborts the attempt');

  // classify CANCELLED is likewise not a pass.
  const cancelled = attemptsWithPassingGates([
    run('review-scope', 'success', 8),
    run('battery-plan', 'success', 8),
    run('classify', 'cancelled', 8),
  ]);
  assert.equal(cancelled.has('suite:8'), false, 'a cancelled classify aborts the attempt');

  // All three green -> passing.
  const green = attemptsWithPassingGates([
    run('review-scope', 'success', 9),
    run('battery-plan', 'success', 9),
    run('classify', 'success', 9),
  ]);
  assert.equal(green.has('suite:9'), true);
});

test('R22b: an attempt older than classify is NOT stranded by its absence', async () => {
  // Presence-tolerance is the rollout half of R22. Requiring every gate to be
  // PRESENT would mark every pre-classify attempt aborted, discarding evidence
  // that is perfectly good — the same stranding shape that kept the new jobs
  // out of REQUIRED_CHECKS.
  const { attemptsWithPassingGates } = await import('./check-run-coverage.mjs');
  const legacy = attemptsWithPassingGates([
    { name: 'review-scope', status: 'completed', conclusion: 'success', check_suite: { id: 5 } },
    { name: 'battery-plan', status: 'completed', conclusion: 'success', check_suite: { id: 5 } },
  ]);
  assert.equal(legacy.has('suite:5'), true, 'a gate that never ran must not veto');
});

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

test('R16: every product suite has a compatibility twin publishing its name', async () => {
  // F6: a classification SKIP is not what the orchestrator waits for. Its
  // `intentionalSkip` is true (this attempt's gates passed), so
  // `summarizeRequiredChecks` finds no decider and counts the check MISSING —
  // the head sits pending until timeout and never reaches the exact-head Codex
  // review. A docs-only change would never merge. The twin emits the check name
  // with an honest "not applicable" verdict so every existing waiter is
  // unaffected.
  const workflow = await readFile(
    new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8',
  );

  for (const suite of SUITES) {
    const twin = new RegExp(`  ${suite}-not-applicable:\\n    name: ${suite}\\n`, 'u');
    assert.match(workflow, twin, `${suite} needs a twin publishing its own name`);

    // The two must be mutually exclusive on the SAME condition, or a suite
    // would either run twice or not report at all.
    const real = new RegExp(
      `\\n  ${suite}:\\n(?:.|\\n)*?\\|\\| contains\\(needs\\.classify\\.outputs\\.suites, ',${suite},'\\)`, 'u',
    );
    const negated = new RegExp(
      `\\n  ${suite}-not-applicable:\\n(?:.|\\n)*?&& !contains\\(needs\\.classify\\.outputs\\.suites, ',${suite},'\\)`, 'u',
    );
    assert.match(workflow, real, `${suite} runs when selected`);
    assert.match(workflow, negated, `${suite} twin runs when NOT selected`);
  }

  // Both arms feed the gate, so neither can be forgotten.
  const gate = workflow.slice(workflow.indexOf('  quality-gate:'));
  for (const suite of SUITES) {
    assert.ok(gate.includes(`- ${suite}-not-applicable`), `gate must need ${suite}'s twin`);
  }
});

test('R17: a base RETARGET forces every suite, bypassing the classifier', async () => {
  // N1. battery-plan's retarget branch exists to re-verify the whole battery
  // against the NEW merge result. The classifier reads the PR's own changed
  // paths, which say nothing about what moved in the base — letting it narrow
  // this rerun defeats the check that requested the battery.
  const { assessBatteryPlan } = await import('./ci-battery-plan.mjs');
  const retarget = assessBatteryPlan({ action: 'edited', baseChanged: true, checkRuns: [] });
  assert.equal(retarget.runProducts, true);
  assert.equal(retarget.forceAll, true, 'a retarget must force ALL suites');

  // An ordinary code event runs the products but does NOT force-all: the
  // classifier is still allowed to narrow there, which is the whole feature.
  const ordinary = assessBatteryPlan({ action: 'synchronize', baseChanged: false });
  assert.equal(ordinary.runProducts, true);
  assert.ok(!ordinary.forceAll, 'a normal code event stays classifiable');

  // An errored plan fails toward BOTH running and forcing.
  const workflow = await readFile(
    new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8',
  );
  for (const suite of SUITES) {
    const block = workflow.slice(workflow.indexOf(`\n  ${suite}:\n`));
    assert.match(
      block.slice(0, 400), /force_all == 'true'/u,
      `${suite} must run when the plan forces all`,
    );
    const twin = workflow.slice(workflow.indexOf(`\n  ${suite}-not-applicable:\n`));
    assert.match(
      twin.slice(0, 500), /force_all != 'true'/u,
      `${suite}'s twin must stand down when the plan forces all`,
    );
  }
});

test('R18: every docs path a PRODUCT test reads is mapped to that suite', async () => {
  // N3 was the FOURTH instance of "safe by location, not by consumer". This is
  // the structural fix: the register is checked against the real test sources,
  // so a new consumer fails here instead of silently skipping the only probe
  // that guards it.
  const { DOCS_CONSUMERS } = await import('./ci-risk-classification.mjs');
  const { readdirSync, readFileSync, statSync } = await import('node:fs');
  const { join } = await import('node:path');

  const roots = [
    new URL('../apps/api/test', import.meta.url).pathname,
    new URL('../apps/web/src', import.meta.url).pathname,
  ];
  const walk = (dir) => {
    let out = [];
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) out = out.concat(walk(full));
      else if (/\.(test|spec)\.[cm]?tsx?$/u.test(entry)) out.push(full);
    }
    return out;
  };

  const unmapped = [];
  for (const root of roots) {
    for (const file of walk(root)) {
      const source = readFileSync(file, 'utf8');
      for (const [, path] of source.matchAll(/['"`](docs\/[A-Za-z0-9_./-]+)['"`]/gu)) {
        if (!DOCS_CONSUMERS.has(path)) unmapped.push(`${file} reads ${path}`);
      }
    }
  }

  assert.deepEqual(
    unmapped, [],
    'a product test reads a docs path that the classifier calls safe. Either add '
      + 'it to DOCS_CONSUMERS with the suite that reads it, or move the probe '
      + 'into pnpm test:automation (which always runs).',
  );

  // And the mapping is honoured by the classifier.
  for (const [path, suites] of DOCS_CONSUMERS) {
    assert.deepEqual(classify(path).suites, suites, `${path} must reach ${suites}`);
  }
});

test('R16b: the twin does NOT claim the suite passed', async () => {
  // It reports that the suite was not applicable and names the reason. A green
  // check that silently implied "api passed" when api never ran would be the
  // dishonest version of this fix.
  const workflow = await readFile(
    new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8',
  );
  const block = workflow.slice(
    workflow.indexOf('  web-not-applicable:'), workflow.indexOf('  e2e-not-applicable:'),
  );
  assert.match(block, /did NOT run/u);
  assert.match(block, /needs\.classify\.outputs\.reason/u, 'the reason is surfaced');
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
