import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { assessBatteryPlan } from './ci-battery-plan.mjs';
import { DOCS_FAST_CHECKS } from './check-run-coverage.mjs';
import { requiredChecksForPullRequest, inferRequiredChecksFromRuns, REQUIRED_CHECKS } from './autonomous-review-gate.mjs';
import { summarizeRequiredChecks } from './autonomous-review-gate.mjs';
import {
  assessPlanDocumentScope,
  isDocsOnlyDiff,
  planFileStatsFromDiff,
} from './review-efficiency.mjs';
import { assessPullRequestScope } from './review-scope.mjs';

test('isDocsOnlyDiff accepts documentation-only cumulative diffs', () => {
  assert.equal(
    isDocsOnlyDiff(['docs/superpowers/plans/plan.md', 'docs/reviews/packet.md']),
    true,
  );
  assert.equal(
    isDocsOnlyDiff(['docs/superpowers/plans/plan.md', 'apps/api/src/x.ts']),
    false,
  );
});

test('requiredChecksForPullRequest uses the docs-fast battery for docs-only PRs', () => {
  const files = ['docs/superpowers/plans/phase-6.md'];
  assert.deepEqual(
    requiredChecksForPullRequest(300, files),
    DOCS_FAST_CHECKS,
  );
  assert.deepEqual(
    requiredChecksForPullRequest(300, ['apps/api/src/x.ts']),
    requiredChecksForPullRequest(300, undefined),
  );
});

test('assessBatteryPlan launches automation instead of products on docs-only code events', () => {
  const plan = assessBatteryPlan({
    action: 'synchronize',
    baseChanged: false,
    checkRuns: undefined,
    docsOnly: true,
  });
  assert.equal(plan.runProducts, false);
  assert.equal(plan.docsFastPath, true);
});

test('summarizeRequiredChecks waits for fresh automation after retarget interleaving', () => {
  const job = (name, runId, stamp, conclusion = 'success') => ({
    name,
    status: 'completed',
    conclusion,
    completed_at: stamp,
    html_url: `https://github.com/o/r/actions/runs/${runId}/job/1`,
  });
  const runs = [
    job('review-scope', '600', '2026-07-29T10:00:00Z'),
    job('battery-plan', '600', '2026-07-29T10:00:30Z'),
    job('automation', '600', '2026-07-29T10:01:00Z'),
    job('review-scope', '700', '2026-07-29T11:00:00Z'),
    job('battery-plan', '700', '2026-07-29T11:00:30Z'),
  ];
  assert.equal(summarizeRequiredChecks(runs, DOCS_FAST_CHECKS).state, 'pending');
});

test('assessBatteryPlan skips automation on a covered docs-only metadata edit', () => {
  const job = (name, runId, stamp, conclusion = 'success') => ({
    name,
    status: 'completed',
    conclusion,
    completed_at: stamp,
    html_url: `https://github.com/o/r/actions/runs/${runId}/job/1`,
  });
  const runs = [
    job('review-scope', '600', '2026-07-29T10:00:00Z'),
    job('battery-plan', '600', '2026-07-29T10:00:30Z'),
    job('automation', '600', '2026-07-29T10:01:00Z'),
    job('review-scope', '700', '2026-07-29T11:00:00Z'),
    job('battery-plan', '700', '2026-07-29T11:00:30Z'),
    job('automation', '700', '2026-07-29T11:01:00Z', 'skipped'),
  ];
  const plan = assessBatteryPlan({
    action: 'edited',
    baseChanged: false,
    checkRuns: runs,
    docsOnly: true,
  });
  assert.equal(plan.runProducts, false);
  assert.equal(plan.docsFastPath, false);
  assert.equal(summarizeRequiredChecks(runs, DOCS_FAST_CHECKS).state, 'success');
});

test('product watermarks ignore skipped automation on a code-path retarget', () => {
  const job = (name, runId, stamp, conclusion = 'success') => ({
    name,
    status: 'completed',
    conclusion,
    completed_at: stamp,
    html_url: `https://github.com/o/r/actions/runs/${runId}/job/1`,
  });
  const runs = [
    job('review-scope', '600', '2026-07-29T10:00:00Z'),
    job('battery-plan', '600', '2026-07-29T10:00:30Z'),
    ...['web', 'api', 'e2e', 'api-e2e', 'upgrade-proof'].map((name) =>
      job(name, '600', '2026-07-29T10:02:00Z')),
    job('review-scope', '700', '2026-07-29T11:00:00Z'),
    job('battery-plan', '700', '2026-07-29T11:00:30Z'),
    job('automation', '700', '2026-07-29T11:00:45Z', 'skipped'),
  ];
  assert.equal(summarizeRequiredChecks(runs, REQUIRED_CHECKS).state, 'pending');
});

test('automation watermarks ignore skipped products on a docs-fast retarget', () => {
  const job = (name, runId, stamp, conclusion = 'success') => ({
    name,
    status: 'completed',
    conclusion,
    completed_at: stamp,
    html_url: `https://github.com/o/r/actions/runs/${runId}/job/1`,
  });
  const runs = [
    job('review-scope', '600', '2026-07-29T10:00:00Z'),
    job('battery-plan', '600', '2026-07-29T10:00:30Z'),
    job('automation', '600', '2026-07-29T10:01:00Z'),
    job('review-scope', '700', '2026-07-29T11:00:00Z'),
    job('battery-plan', '700', '2026-07-29T11:00:30Z'),
    ...['web', 'api', 'e2e', 'api-e2e', 'upgrade-proof'].map((name) =>
      job(name, '700', '2026-07-29T11:00:45Z', 'skipped')),
  ];
  assert.equal(summarizeRequiredChecks(runs, DOCS_FAST_CHECKS).state, 'pending');
});

test('inferRequiredChecksFromRuns matches the docs-fast path from check history', () => {
  const job = (name, conclusion = 'success') => ({
    name,
    status: 'completed',
    conclusion,
    completed_at: '2026-07-30T10:00:00Z',
    html_url: 'https://github.com/o/r/actions/runs/1/job/1',
  });
  // The inference reads the CURRENT attempt, which is the newest one whose gates
  // ALL passed, so a realistic fixture carries them. A head with no completed
  // gates has declared no battery at all — pinned as fail-closed below.
  const gateJobs = [job('review-scope'), job('battery-plan')];
  assert.deepEqual(
    inferRequiredChecksFromRuns(300, [
      ...gateJobs,
      job('automation'),
      ...['web', 'api', 'e2e', 'api-e2e', 'upgrade-proof'].map((name) =>
        job(name, 'skipped')),
    ]),
    DOCS_FAST_CHECKS,
  );
  assert.deepEqual(
    inferRequiredChecksFromRuns(300, [...gateJobs, job('web'), job('automation', 'skipped')]),
    REQUIRED_CHECKS,
  );
  // No attempt has completed its gates: nothing declared a battery, so the
  // inference must not read a docs-fast path out of skipped product jobs.
  assert.deepEqual(
    inferRequiredChecksFromRuns(300, [
      job('automation'),
      ...['web', 'api', 'e2e', 'api-e2e', 'upgrade-proof'].map((name) =>
        job(name, 'skipped')),
    ]),
    REQUIRED_CHECKS,
  );
});

test('assessPlanDocumentScope blocks oversized phase plan documents after the rollout PR', () => {
  const blocked = assessPlanDocumentScope(
    [{ filename: 'docs/superpowers/plans/phase-6.md', additions: 1200, deletions: 0 }],
    { prNumber: 300 },
  );
  assert.equal(blocked.allowed, false);
  assert.match(blocked.detail, /Split into a cross-cutting skeleton/u);

  const allowed = assessPlanDocumentScope(
    [{ filename: 'docs/superpowers/plans/phase-6.md', additions: 400, deletions: 0 }],
    { prNumber: 300 },
  );
  assert.equal(allowed.allowed, true);

  const grandfathered = assessPlanDocumentScope(
    [{ filename: 'docs/superpowers/plans/phase-5.md', additions: 1200, deletions: 0 }],
    { prNumber: 252 },
  );
  assert.equal(grandfathered.allowed, true);
});

test('planFileStatsFromDiff parses only phase plan paths', () => {
  const result = planFileStatsFromDiff('base', 'head', () =>
    '1200\t0\tdocs/superpowers/plans/phase-6.md\n10\t1\tdocs/STATUS.md\n');
  assert.equal(result.unavailable, false);
  assert.deepEqual(result.stats, [
    { filename: 'docs/superpowers/plans/phase-6.md', additions: 1200, deletions: 0 },
  ]);
});

test('planFileStatsFromDiff fails closed when git diff is unavailable', () => {
  const result = planFileStatsFromDiff('base', 'head', () => {
    throw new Error('bad revision');
  });
  assert.equal(result.unavailable, true);
  assert.deepEqual(result.stats, []);
});

test('assessPullRequestScope blocks when plan diff stats are unavailable after rollout', () => {
  const blocked = assessPullRequestScope(
    { number: 300, additions: 10, deletions: 0, changed_files: 1, body: '' },
    { unavailable: true, stats: [] },
  );
  assert.equal(blocked.allowed, false);
  assert.match(blocked.detail, /could not be verified/u);
});

test('assessPullRequestScope combines review-unit and plan-document gates', () => {
  const blocked = assessPullRequestScope(
    { number: 300, additions: 10, deletions: 0, changed_files: 1, body: '' },
    [{ filename: 'docs/superpowers/plans/phase-6.md', additions: 1200, deletions: 0 }],
  );
  assert.equal(blocked.allowed, false);
  assert.match(blocked.detail, /Phase plan document/u);
});

test('ci.yml defines the automation fast path behind battery-plan', async () => {
  const workflow = await readFile(
    new URL('../.github/workflows/ci.yml', import.meta.url),
    'utf8',
  );
  assert.match(workflow, /docs_fast_path/);
  assert.match(workflow, /automation:/);
  assert.match(workflow, /pnpm test:automation/);
  assert.match(
    workflow,
    /if: needs\.battery-plan\.outputs\.docs_fast_path == 'true'/,
  );
});
