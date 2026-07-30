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
  inferRequiredChecksFromRuns,
  productChecksForPullRequest,
  requiredChecksForPullRequest,
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
