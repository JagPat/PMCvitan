// One product-CI battery per SHA, in ONE workflow.
//
// Every PR event runs through ci.yml, so a completed CI run always wakes the
// trusted default-branch owner (a second workflow would complete unseen). The
// five expensive product jobs are gated by the cheap battery-plan job:
//   - code events (opened/synchronize/reopened) always run them;
//   - a metadata-only body/title edit whose head already has REAL product runs
//     skips them (the skipped runs defer to the kept evidence — see the gate's
//     summarizeRequiredChecks semantics);
//   - a base retarget (`changes.base`) re-runs them, because the merge result
//     under test changed even though the head SHA did not;
//   - an edit on a head whose product jobs never really ran (a large PR whose
//     first run failed review-scope) finally launches them, so a body edit
//     that fixes the scope evidence unsticks the loop autonomously.
// If someone re-splits `edited` into a second workflow, drops the plan gate,
// or defines a second launcher for a product job, this file goes red.
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import test from 'node:test';

import { assessBatteryPlan, belongsToRun, PRODUCT_CHECKS } from './ci-battery-plan.mjs';

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
    .filter((name) => !['with', 'env', 'ports', 'options'].includes(name));
}

test('ci.yml handles every PR event and gates the battery on the plan', async () => {
  const workflow = await readFile(new URL('ci.yml', workflowsDir), 'utf8');
  assert.deepEqual(
    pullRequestTypes(workflow),
    ['opened', 'synchronize', 'reopened', 'edited'],
    'edited must stay in the ONE workflow so its completion wakes the owner',
  );
  const jobs = jobNames(workflow);
  assert.ok(jobs.includes('review-scope'), 'ci.yml runs the scope check');
  assert.ok(jobs.includes('battery-plan'), 'ci.yml plans the battery');
  for (const job of PRODUCT_JOBS) {
    assert.ok(jobs.includes(job), `ci.yml defines the product job ${job}`);
    const gated = new RegExp(
      `\\n {2}${job}:\\n {4}needs: \\[review-scope, battery-plan\\]`
        + `\\n {4}if: needs\\.battery-plan\\.outputs\\.run_products == 'true'`,
      'u',
    );
    assert.match(workflow, gated, `${job} must be gated on the battery plan`);
  }

  // the plan job itself stays cheap: no dependency install, no database
  const planStart = workflow.indexOf('  battery-plan:');
  const webStart = workflow.indexOf('  web:');
  assert.ok(planStart >= 0 && webStart > planStart);
  const planJob = workflow.slice(planStart, webStart);
  assert.match(planJob, /node scripts\/ci-battery-plan\.mjs/u);
  assert.doesNotMatch(planJob, /pnpm install|setup-node|postgres/u);
});

test('the plan reads the whole check history, not just the latest run', async () => {
  const plan = await readFile(
    new URL('./ci-battery-plan.mjs', import.meta.url),
    'utf8',
  );
  // GitHub's default is filter=latest, which after one metadata edit shows only
  // the newer SKIPPED product runs — the plan would then launch a duplicate
  // battery for an already-covered SHA.
  assert.match(plan, /check-runs\?filter=all&per_page=100&page=\$\{page\}/u);
  assert.doesNotMatch(plan, /check-runs\?per_page=100(?!&)/u);
  // a page that fails mid-read must not leave a partial prefix in play: only a
  // COMPLETE read may become checkRuns, otherwise the decision falls through to
  // "history unavailable" and the battery runs
  assert.match(plan, /if \(complete\) checkRuns =/u);
});

test('the current run\'s own checks are excluded from the history it reads', () => {
  const own = {
    name: 'review-scope',
    html_url: 'https://github.com/o/r/actions/runs/4242/job/99',
  };
  const other = {
    name: 'review-scope',
    details_url: 'https://github.com/o/r/actions/runs/4243/job/98',
  };
  assert.equal(belongsToRun(own, '4242'), true);
  assert.equal(belongsToRun(other, '4242'), false);
  // no run id, or an unparseable url, is never "mine" — the guard stays on
  assert.equal(belongsToRun(own, undefined), false);
  assert.equal(belongsToRun({ name: 'x' }, '4242'), false);
});

test('the battery plan launches products exactly when they are needed', () => {
  assert.deepEqual(PRODUCT_CHECKS, PRODUCT_JOBS);
  const realRuns = (conclusion) => PRODUCT_CHECKS.map((name) => ({
    name,
    status: 'completed',
    conclusion,
  }));

  // code events always run the battery
  for (const action of ['opened', 'synchronize', 'reopened', undefined]) {
    assert.equal(
      assessBatteryPlan({ action, baseChanged: false, checkRuns: realRuns('success') })
        .runProducts,
      true,
    );
  }

  // metadata-only edit with real product runs recorded: skip (one battery/SHA)
  assert.equal(
    assessBatteryPlan({
      action: 'edited',
      baseChanged: false,
      checkRuns: realRuns('success'),
    }).runProducts,
    false,
  );

  // failed runs are still REAL runs — a body edit re-runs nothing; the fix for
  // red products is a new SHA (with its own battery), not a metadata edit
  assert.equal(
    assessBatteryPlan({
      action: 'edited',
      baseChanged: false,
      checkRuns: realRuns('failure'),
    }).runProducts,
    false,
  );

  // a base retarget re-runs the battery even on a green head: the merge result
  // under test changed although the head SHA did not
  assert.equal(
    assessBatteryPlan({
      action: 'edited',
      baseChanged: true,
      checkRuns: realRuns('success'),
    }).runProducts,
    true,
  );

  // the stuck-large-PR path: products only ever SKIPPED (first run failed
  // review-scope) — the body edit that fixes the scope evidence must finally
  // launch the battery instead of leaving the SHA untested forever
  assert.equal(
    assessBatteryPlan({
      action: 'edited',
      baseChanged: false,
      checkRuns: realRuns('skipped'),
    }).runProducts,
    true,
  );

  // in-flight coverage: an earlier battery for this SHA is still running when
  // the body edit lands — do not start a second one alongside it
  assert.equal(
    assessBatteryPlan({
      action: 'edited',
      baseChanged: false,
      checkRuns: PRODUCT_CHECKS.map((name) => ({
        name,
        status: 'in_progress',
        conclusion: null,
      })),
    }).runProducts,
    false,
  );
  assert.equal(
    assessBatteryPlan({
      action: 'edited',
      baseChanged: false,
      checkRuns: PRODUCT_CHECKS.map((name, index) => ({
        name,
        status: index === 0 ? 'queued' : 'completed',
        conclusion: index === 0 ? null : 'success',
      })),
    }).runProducts,
    false,
  );

  // retarget → scope fails on the new base → products skipped → the body edit
  // that fixes the scope evidence must NOT accept the pre-retarget product
  // runs: they were green against the OLD base
  assert.equal(
    assessBatteryPlan({
      action: 'edited',
      baseChanged: false,
      checkRuns: [
        ...PRODUCT_CHECKS.map((name) => ({
          name,
          status: 'completed',
          conclusion: 'success',
          started_at: '2026-07-29T07:00:00Z',
        })),
        {
          name: 'review-scope',
          status: 'completed',
          conclusion: 'success',
          started_at: '2026-07-29T07:00:00Z',
        },
        // the base-change attempt: scope failed, products skipped
        ...PRODUCT_CHECKS.map((name) => ({
          name,
          status: 'completed',
          conclusion: 'skipped',
          started_at: '2026-07-29T07:20:00Z',
        })),
        {
          name: 'review-scope',
          status: 'completed',
          conclusion: 'failure',
          started_at: '2026-07-29T07:20:00Z',
        },
      ],
    }).runProducts,
    true,
  );

  // …but a passing scope check on the newest completed attempt keeps the
  // metadata-only skip (the one-battery-per-SHA goal) intact
  assert.equal(
    assessBatteryPlan({
      action: 'edited',
      baseChanged: false,
      checkRuns: [
        ...realRuns('success'),
        {
          name: 'review-scope',
          status: 'completed',
          conclusion: 'success',
          started_at: '2026-07-29T07:00:00Z',
        },
      ],
    }).runProducts,
    false,
  );

  // a NEWER cancelled run means the current attempt never finished: an older
  // success must not mask it, or the head deadlocks (the gate resolves the
  // cancelled run as red while the plan refuses to re-run)
  assert.equal(
    assessBatteryPlan({
      action: 'edited',
      baseChanged: false,
      checkRuns: [
        ...PRODUCT_CHECKS.map((name) => ({
          name,
          status: 'completed',
          conclusion: 'success',
          completed_at: '2026-07-29T07:10:00Z',
        })),
        {
          name: PRODUCT_CHECKS[0],
          status: 'completed',
          conclusion: 'cancelled',
          completed_at: '2026-07-29T07:40:00Z',
        },
      ],
    }).runProducts,
    true,
  );

  // …and an OLDER cancelled run below a newer success is correctly ignored
  assert.equal(
    assessBatteryPlan({
      action: 'edited',
      baseChanged: false,
      checkRuns: [
        ...PRODUCT_CHECKS.map((name) => ({
          name,
          status: 'completed',
          conclusion: 'success',
          completed_at: '2026-07-29T07:40:00Z',
        })),
        {
          name: PRODUCT_CHECKS[0],
          status: 'completed',
          conclusion: 'cancelled',
          completed_at: '2026-07-29T07:10:00Z',
        },
      ],
    }).runProducts,
    false,
  );

  // recency is decided by completion, not by start: a run that started first
  // but finished LAST is the decider
  assert.equal(
    assessBatteryPlan({
      action: 'edited',
      baseChanged: false,
      checkRuns: [
        ...PRODUCT_CHECKS.map((name) => ({
          name,
          status: 'completed',
          conclusion: 'success',
          started_at: '2026-07-29T07:05:00Z',
          completed_at: '2026-07-29T07:20:00Z',
        })),
        {
          name: PRODUCT_CHECKS[0],
          status: 'completed',
          conclusion: 'cancelled',
          started_at: '2026-07-29T07:00:00Z',
          completed_at: '2026-07-29T07:30:00Z',
        },
      ],
    }).runProducts,
    true,
  );

  // a scope run from ANOTHER attempt is still running: its verdict is unknown
  // and its products are not created yet, so the visible product runs are all
  // pre-retarget — do not skip on them
  assert.equal(
    assessBatteryPlan({
      action: 'edited',
      baseChanged: false,
      checkRuns: [
        ...realRuns('success'),
        {
          name: 'review-scope',
          status: 'completed',
          conclusion: 'success',
          completed_at: '2026-07-29T07:00:00Z',
        },
        { name: 'review-scope', status: 'in_progress', conclusion: null },
      ],
    }).runProducts,
    true,
  );

  // one product check missing entirely, or history unavailable: fail toward
  // running the battery
  assert.equal(
    assessBatteryPlan({
      action: 'edited',
      baseChanged: false,
      checkRuns: realRuns('success').slice(1),
    }).runProducts,
    true,
  );
  assert.equal(
    assessBatteryPlan({ action: 'edited', baseChanged: false, checkRuns: undefined })
      .runProducts,
    true,
  );
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
  assert.deepEqual(editedHandlers, ['ci.yml']);
});
