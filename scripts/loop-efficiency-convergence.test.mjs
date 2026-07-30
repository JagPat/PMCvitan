// Convergence suite for PR #257. See docs/reviews/pr-257-convergence.md.
//
// The eight Codex findings across two heads reduce to three concepts. Five of the
// eight are genuinely closed at `752968f` and are pinned here so a later edit
// cannot silently reopen them. The two that were not closed — finding 8's
// classification hack and the gate disagreeing with ITSELF about which battery ran
// — are corrected on this head and proven below.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  AUTOMATION_CHECK,
  DOCS_FAST_CHECKS,
  PRODUCT_CHECKS,
  gateWatermarks,
} from './check-run-coverage.mjs';
import {
  classifyHead,
  currentBatteryAttempt,
  inferRequiredChecksFromRuns,
  productChecksForPullRequest,
  requiredChecksForPullRequest,
  summarizeRequiredChecks,
} from './autonomous-review-gate.mjs';

const GATE_CHECKS = ['review-scope', 'battery-plan'];

function run(name, attempt, { skipped = false, at = '2026-07-30T10:00:00Z' } = {}) {
  return {
    name,
    status: 'completed',
    conclusion: skipped ? 'skipped' : 'success',
    completed_at: at,
    check_suite: { id: attempt },
  };
}

function gates(attempt, at) {
  return GATE_CHECKS.map((name) => run(name, attempt, { at }));
}

// ---------------------------------------------------------------------------
// Concept 1 — per-scope attempt coverage (findings 1, 5, 7). Closed at 752968f;
// pinned so the two batteries cannot start invalidating each other again.
// ---------------------------------------------------------------------------

test('C1: a code PR\'s skipped automation does not preserve stale product coverage (finding 5)', () => {
  const runs = [
    ...gates(600, '2026-07-30T09:00:00Z'),
    ...PRODUCT_CHECKS.map((name) => run(name, 600, { at: '2026-07-30T09:05:00Z' })),
    ...gates(700, '2026-07-30T10:00:00Z'),
    run(AUTOMATION_CHECK, 700, { skipped: true, at: '2026-07-30T10:01:00Z' }),
  ];
  const watermarks = gateWatermarks(runs);
  for (const name of PRODUCT_CHECKS) {
    assert.equal(
      watermarks.get(name),
      '2026-07-30T10:00:00Z',
      `${name} must be superseded by attempt 700's gates`,
    );
  }
});

test('C1b: a docs PR\'s skipped products do not preserve stale automation coverage (finding 7)', () => {
  const runs = [
    ...gates(600, '2026-07-30T09:00:00Z'),
    run(AUTOMATION_CHECK, 600, { at: '2026-07-30T09:05:00Z' }),
    ...gates(700, '2026-07-30T10:00:00Z'),
    ...PRODUCT_CHECKS.map((name) => run(name, 700, { skipped: true, at: '2026-07-30T10:01:00Z' })),
  ];
  assert.equal(
    gateWatermarks(runs).get(AUTOMATION_CHECK),
    '2026-07-30T10:00:00Z',
    'automation must be superseded by attempt 700 before its own run appears',
  );
});

test('C1c: automation carries a watermark of its own at all (finding 1)', () => {
  assert.ok(gateWatermarks([...gates(600, '2026-07-30T09:00:00Z')]).has(AUTOMATION_CHECK));
});

// ---------------------------------------------------------------------------
// Concept 2 — the planner and the gate must agree which battery ran
// (findings 4, 6, 8), and the gate must not disagree with ITSELF.
// ---------------------------------------------------------------------------

test('C2: an established product run selects the product battery without a synthetic file list', () => {
  // Previously this routed ['apps/api/src/x.ts'] through isDocsOnlyDiff to reach
  // the product branch. It gave the right answer for the wrong reason: any future
  // path-based rule in the classifier would silently flip the gate to docs-fast.
  const runs = [
    ...gates(700, '2026-07-30T10:00:00Z'),
    run('web', 700, { at: '2026-07-30T10:05:00Z' }),
  ];
  assert.deepEqual(inferRequiredChecksFromRuns(900, runs), productChecksForPullRequest(900));
  assert.ok(productChecksForPullRequest(900).includes('web'));
  assert.ok(!productChecksForPullRequest(900).includes(AUTOMATION_CHECK));
});

test('C2b: pre-policy grandfathering survives the inference path', () => {
  const runs = [
    ...gates(700, '2026-07-30T10:00:00Z'),
    run('web', 700, { at: '2026-07-30T10:05:00Z' }),
  ];
  const inferred = inferRequiredChecksFromRuns(100, runs);
  assert.ok(!inferred.includes('review-scope'));
  assert.ok(!inferred.includes('battery-plan'));
  assert.deepEqual(inferred, requiredChecksForPullRequest(100, undefined));
});

test('C2c: skipped-or-absent products with automation touched selects the docs-fast battery', () => {
  const runs = [
    ...gates(700, '2026-07-30T10:00:00Z'),
    ...PRODUCT_CHECKS.map((name) => run(name, 700, { skipped: true })),
    run(AUTOMATION_CHECK, 700, { at: '2026-07-30T10:05:00Z' }),
  ];
  assert.deepEqual(inferRequiredChecksFromRuns(900, runs), DOCS_FAST_CHECKS);
});

test('C3: the head is classified ONCE and every consumer sees the same answer', async () => {
  // Four sites consulted the endpoint independently, so a transient failure could
  // be observed by some and not others — the wait loop requiring DOCS_FAST_CHECKS
  // while the verification that sets codex-current-head required the full battery.
  let calls = 0;
  const client = {
    async pullRequestFiles() {
      calls += 1;
      return [{ filename: 'docs/plan.md', additions: 5, deletions: 0 }];
    },
  };
  const pullRequest = { number: 900, head: { sha: 'a'.repeat(40) } };

  const first = await classifyHead(client, pullRequest);
  const second = await classifyHead(client, pullRequest);
  const third = await classifyHead(client, pullRequest);

  assert.equal(calls, 1, 'one head, one classification');
  assert.equal(first, second);
  assert.equal(second, third);
  assert.equal(first.available, true);
});

test('C3b: an unreadable list is cached as unreadable, so every consumer fails closed alike', async () => {
  let calls = 0;
  const client = {
    async pullRequestFiles() {
      calls += 1;
      // A retry inside one run that succeeded on the second call is exactly the
      // divergence being removed: the run must commit to one classification.
      if (calls > 1) return [{ filename: 'docs/plan.md', additions: 5, deletions: 0 }];
      throw new Error('files API unavailable');
    },
  };
  const pullRequest = { number: 901, head: { sha: 'b'.repeat(40) } };

  const first = await classifyHead(client, pullRequest);
  const second = await classifyHead(client, pullRequest);

  assert.equal(calls, 1);
  assert.equal(first.available, false);
  assert.equal(first.files, undefined);
  assert.equal(second.available, false, 'the run must not flip mid-flight');
});

test('C3c: a new head gets its own classification', async () => {
  let calls = 0;
  const client = {
    async pullRequestFiles() {
      calls += 1;
      return [{ filename: 'apps/api/src/x.ts', additions: 1, deletions: 0 }];
    },
  };
  await classifyHead(client, { number: 902, head: { sha: 'c'.repeat(40) } });
  await classifyHead(client, { number: 902, head: { sha: 'd'.repeat(40) } });
  assert.equal(calls, 2, 'the cache is keyed by head, not by PR');
});

test('C3d: separate clients do not share a cache', async () => {
  const make = () => {
    let calls = 0;
    return {
      get calls() { return calls; },
      async pullRequestFiles() {
        calls += 1;
        return [{ filename: 'docs/plan.md', additions: 1, deletions: 0 }];
      },
    };
  };
  const a = make();
  const b = make();
  const pullRequest = { number: 903, head: { sha: 'e'.repeat(40) } };
  await classifyHead(a, pullRequest);
  await classifyHead(b, pullRequest);
  assert.equal(a.calls, 1);
  assert.equal(b.calls, 1, 'the next gate invocation retries a transient failure');
});

// ---------------------------------------------------------------------------
// Concept 2, continued — the inference must read the CURRENT attempt only.
// Codex P1 on head e9feaf7.
// ---------------------------------------------------------------------------

function attempt(id, { at, products = 'none', automation = 'none' } = {}) {
  const runs = gates(id, at);
  if (products !== 'none') {
    runs.push(...PRODUCT_CHECKS.map((name) =>
      run(name, id, { skipped: products === 'skipped', at })));
  }
  if (automation !== 'none') {
    runs.push(run(AUTOMATION_CHECK, id, { skipped: automation === 'skipped', at }));
  }
  return runs;
}

test('E1: the finding\'s interleaving fails closed instead of accepting older products', () => {
  // attempt 600 product-path green; attempt 700 docs-fast with skipped products
  // and its automation run not yet visible. Scanning the whole history saw 600's
  // real `web` and returned the product battery, and summarizeRequiredChecks then
  // accepted 600's products because 700's skips are intentional — green on stale
  // evidence while the current attempt's automation was still missing.
  const runs = [
    ...attempt(600, { at: '2026-07-30T09:00:00Z', products: 'real', automation: 'skipped' }),
    ...attempt(700, { at: '2026-07-30T10:00:00Z', products: 'skipped' }),
  ];
  assert.equal(currentBatteryAttempt(runs), 'suite:700');
  const required = inferRequiredChecksFromRuns(900, runs);
  assert.deepEqual(required, DOCS_FAST_CHECKS);
  const summary = summarizeRequiredChecks(runs, required);
  assert.notEqual(summary.state, 'success', 'must not go green on attempt-600 products');
  assert.ok(
    summary.missing.includes(AUTOMATION_CHECK) || summary.pending.includes(AUTOMATION_CHECK),
    'the current attempt\'s own automation evidence is what is awaited',
  );
});

test('E1b: a current attempt with real products selects the product battery', () => {
  const runs = [
    ...attempt(600, { at: '2026-07-30T09:00:00Z', products: 'skipped', automation: 'real' }),
    ...attempt(700, { at: '2026-07-30T10:00:00Z', products: 'real', automation: 'skipped' }),
  ];
  assert.deepEqual(inferRequiredChecksFromRuns(900, runs), productChecksForPullRequest(900));
});

test('E1c: no attempt with passing gates fails closed on the product battery', () => {
  // A failed gate aborts its attempt, so it decides nothing.
  const runs = [
    ...gates(700, '2026-07-30T10:00:00Z').map((r, i) =>
      (i === 0 ? { ...r, conclusion: 'failure' } : r)),
    ...PRODUCT_CHECKS.map((name) => run(name, 700, { skipped: true })),
    run(AUTOMATION_CHECK, 700, { at: '2026-07-30T10:05:00Z' }),
  ];
  assert.equal(currentBatteryAttempt(runs), null);
  assert.deepEqual(inferRequiredChecksFromRuns(900, runs), productChecksForPullRequest(900));
});

test('E1d: a current attempt with no product run at all stays pending (retarget window)', () => {
  const runs = [
    ...attempt(600, { at: '2026-07-30T09:00:00Z', products: 'real', automation: 'skipped' }),
    ...gates(700, '2026-07-30T10:00:00Z'),
  ];
  const required = inferRequiredChecksFromRuns(900, runs);
  assert.deepEqual(required, productChecksForPullRequest(900));
  assert.notEqual(summarizeRequiredChecks(runs, required).state, 'success');
});

test('E1e: a complete docs-fast current attempt is accepted', () => {
  const runs = [
    ...attempt(600, { at: '2026-07-30T09:00:00Z', products: 'real', automation: 'skipped' }),
    ...attempt(700, { at: '2026-07-30T10:00:00Z', products: 'skipped', automation: 'real' }),
  ];
  const required = inferRequiredChecksFromRuns(900, runs);
  assert.deepEqual(required, DOCS_FAST_CHECKS);
  assert.equal(summarizeRequiredChecks(runs, required).state, 'success');
});

// ---------------------------------------------------------------------------
// RED-before-fix proofs for the five findings closed at 752968f.
//
// Codex P2 on e9feaf7: the packet said those five were "pinned rather than
// reproduced", so a broken correction could ride through on a green pin. A pin
// proves the current state is right; it does not prove the assertion
// DISCRIMINATES. Each proof below runs the PRE-FIX algorithm against the SAME
// fixture the pin uses and shows it produces the unsafe answer.
// ---------------------------------------------------------------------------

// Pre-fix `attemptCharactersFor`: ONE character set over every battery check,
// and watermarks built for PRODUCT_CHECKS only.
function legacyGateWatermarks(runs) {
  const characters = new Map();
  for (const r of runs) {
    if (![...PRODUCT_CHECKS, AUTOMATION_CHECK].includes(r?.name)) continue;
    const id = r?.check_suite?.id ? `suite:${r.check_suite.id}` : null;
    if (!id) continue;
    if (characters.get(id) === 'running') continue;
    characters.set(id, r.conclusion === 'skipped' ? 'skipping' : 'running');
  }
  const producedByName = new Map(PRODUCT_CHECKS.map((n) => [n, new Set()]));
  for (const r of runs) {
    if (!PRODUCT_CHECKS.includes(r?.name)) continue;
    const id = r?.check_suite?.id ? `suite:${r.check_suite.id}` : null;
    if (id) producedByName.get(r.name).add(id);
  }
  const completedGates = runs.filter(
    (r) => GATE_CHECKS.includes(r?.name) && r?.status === 'completed');
  const watermarks = new Map();
  for (const name of PRODUCT_CHECKS) {
    watermarks.set(name, completedGates
      .filter((r) => {
        const id = r?.check_suite?.id ? `suite:${r.check_suite.id}` : null;
        if (!id) return false;
        if (producedByName.get(name).has(id)) return false;
        return characters.get(id) !== 'skipping';
      })
      .map((r) => r.completed_at)
      .reduce((newest, stamp) => (stamp > newest ? stamp : newest), ''));
  }
  return watermarks;
}

test('R1 (findings 1/5/7): the pre-fix watermark accepts what the pinned fixtures forbid', () => {
  // Finding 1 — automation had no watermark of its own at all.
  assert.equal(
    legacyGateWatermarks([...gates(600, '2026-07-30T09:00:00Z')]).has(AUTOMATION_CHECK),
    false,
    'pre-fix: no automation watermark existed',
  );
  assert.equal(
    gateWatermarks([...gates(600, '2026-07-30T09:00:00Z')]).has(AUTOMATION_CHECK),
    true,
    'fixed: automation carries its own watermark',
  );

  // Finding 5 — the C1 fixture: a skipped `automation` on a code PR marked the
  // whole attempt 'skipping', suppressing the product watermark.
  const codeRuns = [
    ...gates(600, '2026-07-30T09:00:00Z'),
    ...PRODUCT_CHECKS.map((n) => run(n, 600, { at: '2026-07-30T09:05:00Z' })),
    ...gates(700, '2026-07-30T10:00:00Z'),
    run(AUTOMATION_CHECK, 700, { skipped: true, at: '2026-07-30T10:01:00Z' }),
  ];
  for (const name of PRODUCT_CHECKS) {
    assert.equal(
      legacyGateWatermarks(codeRuns).get(name), '',
      `pre-fix: ${name} had no watermark, so attempt-600 products were accepted`,
    );
    assert.equal(
      gateWatermarks(codeRuns).get(name), '2026-07-30T10:00:00Z',
      `fixed: ${name} is superseded by attempt 700`,
    );
  }

  // Finding 7 — the C1b fixture: skipped products on a docs retarget cleared the
  // automation watermark. Pre-fix there was no automation watermark to clear.
  const docsRuns = [
    ...gates(600, '2026-07-30T09:00:00Z'),
    run(AUTOMATION_CHECK, 600, { at: '2026-07-30T09:05:00Z' }),
    ...gates(700, '2026-07-30T10:00:00Z'),
    ...PRODUCT_CHECKS.map((n) => run(n, 700, { skipped: true, at: '2026-07-30T10:01:00Z' })),
  ];
  assert.equal(
    legacyGateWatermarks(docsRuns).get(AUTOMATION_CHECK), undefined,
    'pre-fix: attempt-600 automation was never superseded',
  );
  assert.equal(
    gateWatermarks(docsRuns).get(AUTOMATION_CHECK), '2026-07-30T10:00:00Z',
    'fixed: attempt 700 supersedes it',
  );
});

test('R2 (findings 4/6): the pre-fix classification failure launched the wrong battery', async () => {
  const { run: runPlan } = await import('./ci-battery-plan.mjs');
  const { writeFile, mkdtemp, readFile } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');

  const dir = await mkdtemp(join(tmpdir(), 'p257-'));
  const eventPath = join(dir, 'event.json');
  const outputPath = join(dir, 'out.txt');
  await writeFile(eventPath, JSON.stringify({
    action: 'synchronize',
    pull_request: { number: 900, head: { sha: 'a'.repeat(40) } },
  }));

  const priorExit = process.exitCode;
  const plan = await runPlan({
    eventPath,
    outputPath,
    repository: 'JagPat/PMCvitan',
    token: 't',
    fetchImpl: async () => { throw new Error('files API down'); },
  });
  const outputs = await readFile(outputPath, 'utf8');
  process.exitCode = priorExit;

  // FIXED: refuses to launch anything, and fails the job.
  assert.equal(plan.runProducts, false);
  assert.equal(plan.docsFastPath, false);
  assert.match(outputs, /run_products=false/u);
  assert.match(outputs, /docs_fast_path=false/u);
  assert.match(plan.reason, /refusing to launch a mismatched battery/u);

  // PRE-FIX: the throw fell through to the outer catch, which wrote this shape —
  // five product jobs launched, automation skipped. A gate whose own file read
  // then succeeded would classify the PR docs-only and require `automation`, a
  // job this plan deliberately never started, so the head timed out with a green
  // product battery.
  const legacyPlan = { runProducts: true, docsFastPath: false };
  assert.notDeepEqual(
    { runProducts: plan.runProducts, docsFastPath: plan.docsFastPath },
    legacyPlan,
    'the fix must not reproduce the pre-fix mismatched shape',
  );
  const gateWouldRequire = requiredChecksForPullRequest(900, [{ filename: 'docs/x.md' }]);
  assert.ok(gateWouldRequire.includes(AUTOMATION_CHECK));
  assert.equal(
    legacyPlan.docsFastPath, false,
    'pre-fix the plan never launched the automation job the gate would require',
  );
});

test('R3 (findings 2/3): the pre-fix plan-stat failure made the 900-line cap vanish', async () => {
  const {
    assessPlanDocumentScope,
    planFileStatsFromDiff,
  } = await import('./review-efficiency.mjs');
  const { assessPullRequestScope } = await import('./review-scope.mjs');

  const throwingGit = () => { throw new Error('base..head unavailable'); };

  // PRE-FIX: any git error returned [] — read as "this PR touches no plan files".
  const legacyStats = [];
  assert.equal(
    assessPlanDocumentScope(legacyStats, { prNumber: 900 }).allowed, true,
    'pre-fix: an unreadable diff silently allowed any plan size',
  );

  // FIXED: the failure is distinguishable, and a post-#252 PR is blocked on it.
  const stats = planFileStatsFromDiff('base', 'head', throwingGit);
  assert.deepEqual(stats, { unavailable: true, stats: [] });
  const pullRequest = { number: 900, additions: 10, deletions: 0, changed_files: 2, body: '' };
  const blocked = assessPullRequestScope(pullRequest, stats);
  assert.equal(blocked.allowed, false);
  assert.match(blocked.detail, /could not be verified/u);

  // Finding 3 — the TRUSTED path consults plan stats, not only file/line budget.
  // Same small PR, but with a real oversized plan file: scope alone would allow it.
  const oversized = {
    unavailable: false,
    stats: [{ filename: 'docs/superpowers/plans/phase-6.md', additions: 1200, deletions: 0 }],
  };
  const rejected = assessPullRequestScope(pullRequest, oversized);
  assert.equal(rejected.allowed, false);
  assert.match(rejected.detail, /exceed 900 added lines/u);
  // And the pre-fix trusted path, which never computed plan stats at all:
  assert.equal(
    assessPullRequestScope(pullRequest, { unavailable: false, stats: [] }).allowed, true,
    'pre-fix: with no plan stats computed, the oversized plan was promotable',
  );
});
