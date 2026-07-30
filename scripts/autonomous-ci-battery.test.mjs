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
import { summarizeRequiredChecks } from './autonomous-review-gate.mjs';

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
  const automationStart = workflow.indexOf('  automation:');
  const webStart = workflow.indexOf('  web:');
  assert.ok(planStart >= 0 && automationStart > planStart && webStart > automationStart);
  const planJob = workflow.slice(planStart, automationStart);
  assert.match(planJob, /node scripts\/ci-battery-plan\.mjs/u);
  assert.doesNotMatch(planJob, /pnpm install|setup-node|postgres/u);

  const automationJob = workflow.slice(automationStart, webStart);
  assert.match(automationJob, /pnpm test:automation/u);
  assert.doesNotMatch(automationJob, /postgres/u);
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

// A retarget attempt whose gates BOTH passed but whose product jobs have not
// been created yet: the old base's product successes are older than those gates,
// so they belong to a superseded attempt and cannot be coverage for the new
// merge result. Fail toward running rather than promote untested code.
test('product evidence older than the newest passing gate is not coverage', () => {
  // Real check runs always belong to a workflow run; attempt identity is what
  // distinguishes "gates with no products yet" from "gates of a deliberate
  // skip", so the fixture carries it.
  const at = (name, runId, stamp, conclusion = 'success') => ({
    name,
    status: 'completed',
    conclusion,
    completed_at: stamp,
    html_url: `https://github.com/o/r/actions/runs/${runId}/job/1`,
  });
  // base A: gates then products, all green at 10:0x
  const baseA = [
    at('review-scope', '600', '2026-07-29T10:00:00Z'),
    at('battery-plan', '600', '2026-07-29T10:00:30Z'),
    ...PRODUCT_CHECKS.map((name) => at(name, '600', '2026-07-29T10:05:00Z')),
  ];
  // that alone is coverage: a metadata edit skips the battery
  assert.equal(
    assessBatteryPlan({ action: 'edited', baseChanged: false, checkRuns: baseA }).runProducts,
    false,
  );

  // now a retarget lands: its gates pass at 11:0x, its products do not exist yet
  const afterRetarget = [
    ...baseA,
    at('review-scope', '700', '2026-07-29T11:00:00Z'),
    at('battery-plan', '700', '2026-07-29T11:00:30Z'),
  ];
  const verdict = assessBatteryPlan({
    action: 'edited',
    baseChanged: false,
    checkRuns: afterRetarget,
  });
  assert.equal(verdict.runProducts, true, 'base-A products cannot cover the base-B gates');
  assert.match(verdict.reason, /from the current attempt/u);

  // once the new attempt's products land, coverage is restored
  const complete = [
    ...afterRetarget,
    ...PRODUCT_CHECKS.map((name) => at(name, '700', '2026-07-29T11:05:00Z')),
  ];
  assert.equal(
    assessBatteryPlan({ action: 'edited', baseChanged: false, checkRuns: complete }).runProducts,
    false,
  );
});

// REGRESSION (round 8's watermark, caught in round 9): a DELIBERATE skip
// attempt's gates must not invalidate the very evidence that skip preserved.
// Without this, every second metadata-only edit relaunched the full battery —
// the exact duplication this design exists to prevent.
test('a deliberate skip attempt does not invalidate the evidence it preserved', () => {
  const job = (name, conclusion, runId, stamp) => ({
    name,
    status: 'completed',
    conclusion,
    completed_at: stamp,
    html_url: `https://github.com/o/r/actions/runs/${runId}/job/1`,
  });

  // Attempt 600: gates green, real products green. Attempt 700: the first
  // metadata edit — gates green, products SKIPPED because 600 already covered.
  const afterOneSkip = [
    job('review-scope', 'success', '600', '2026-07-29T10:00:00Z'),
    job('battery-plan', 'success', '600', '2026-07-29T10:00:30Z'),
    ...PRODUCT_CHECKS.map((n) => job(n, 'success', '600', '2026-07-29T10:05:00Z')),
    job('review-scope', 'success', '700', '2026-07-29T11:00:00Z'),
    job('battery-plan', 'success', '700', '2026-07-29T11:00:30Z'),
    ...PRODUCT_CHECKS.map((n) => job(n, 'skipped', '700', '2026-07-29T11:01:00Z')),
  ];
  const second = assessBatteryPlan({
    action: 'edited',
    baseChanged: false,
    checkRuns: afterOneSkip,
  });
  assert.equal(
    second.runProducts,
    false,
    'the second metadata edit must still skip: attempt 700 deliberately kept 600 as coverage',
  );

  // The retarget window is unaffected: attempt 800's gates pass and it has NO
  // product runs at all, so the older evidence is genuinely superseded.
  const retargetPending = [
    ...afterOneSkip,
    job('review-scope', 'success', '800', '2026-07-29T12:00:00Z'),
    job('battery-plan', 'success', '800', '2026-07-29T12:00:30Z'),
  ];
  assert.equal(
    assessBatteryPlan({
      action: 'edited',
      baseChanged: false,
      checkRuns: retargetPending,
    }).runProducts,
    true,
    'gates with no products of their own must still force the battery',
  );
});

test('the battery plan launches products exactly when they are needed', () => {
  assert.deepEqual(PRODUCT_CHECKS, PRODUCT_JOBS);
  // Real check runs always carry a completion time, and a product job always
  // completes after the gates that launched it — the fixture reflects that so
  // the coverage rules are exercised as they behave in production.
  const realRuns = (conclusion, completedAt = '2026-07-29T09:00:00Z') =>
    PRODUCT_CHECKS.map((name) => ({
      name,
      status: 'completed',
      conclusion,
      completed_at: completedAt,
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
  launchers.set('automation', []);
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
      `job ${job} must be defined only by ci.yml`,
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

// FINDING (round 9, head 36a5377): the watermark was cleared per ATTEMPT, so an
// attempt that had produced ANY product run was treated as vouching for all
// five. GitHub creates those five check runs one at a time, so a newer attempt
// commonly exposes `web` while `api`/`e2e`/`api-e2e`/`upgrade-proof` do not
// exist yet — and the four missing names fell back to the previous base's
// successes. The head could then be promoted with four of five product jobs
// never run against the current merge result.
test('a partially visible attempt vouches only for the products it produced', () => {
  const job = (name, conclusion, runId, stamp) => ({
    name,
    status: 'completed',
    conclusion,
    completed_at: stamp,
    html_url: `https://github.com/o/r/actions/runs/${runId}/job/1`,
  });

  const baseA = [
    job('review-scope', 'success', '600', '2026-07-29T10:00:00Z'),
    job('battery-plan', 'success', '600', '2026-07-29T10:00:30Z'),
    ...PRODUCT_CHECKS.map((n) => job(n, 'success', '600', '2026-07-29T10:05:00Z')),
  ];

  // Attempt 700 retargets: gates green, and ONLY `web` has appeared so far.
  const partial = [
    ...baseA,
    job('review-scope', 'success', '700', '2026-07-29T11:00:00Z'),
    job('battery-plan', 'success', '700', '2026-07-29T11:00:30Z'),
    job('web', 'success', '700', '2026-07-29T11:05:00Z'),
  ];

  const plan = assessBatteryPlan({ action: 'edited', baseChanged: false, checkRuns: partial });
  assert.equal(plan.runProducts, true, 'the four absent product names are not covered');
  assert.match(plan.reason, /product check (api|e2e|api-e2e|upgrade-proof)/u);

  // And the gate must not publish success on that head either: the four names
  // whose jobs have not run on attempt 700 are PENDING, not passed.
  const summary = summarizeRequiredChecks(partial);
  assert.equal(summary.state, 'pending');
  assert.deepEqual(
    [...summary.pending].sort(),
    ['api', 'api-e2e', 'e2e', 'upgrade-proof'],
    'web is genuinely covered by attempt 700; the other four are not',
  );
  assert.deepEqual(summary.failed, [], 'not-yet-run is pending, never failed');

  // Once attempt 700's remaining products land, the head is covered again.
  const complete = [
    ...partial,
    ...PRODUCT_CHECKS.filter((n) => n !== 'web')
      .map((n) => job(n, 'success', '700', '2026-07-29T11:06:00Z')),
  ];
  assert.equal(
    assessBatteryPlan({ action: 'edited', baseChanged: false, checkRuns: complete }).runProducts,
    false,
  );
  assert.equal(summarizeRequiredChecks(complete).state, 'success');
});

// FINDING (round 10) — the R9 per-name watermark had a mirror-image defect. A
// SKIPPING attempt's five skipped runs need not be visible at once either, and
// per-name alone treated the not-yet-visible names as "this attempt produced no
// run of N", raising the watermark and rejecting the very evidence that attempt
// deliberately preserved. What resolves the ambiguity is the CHARACTER of the
// runs the attempt does have, not the presence of a specific name.
test('a partially visible skip still preserves the evidence it kept', () => {
  const job = (name, conclusion, runId, stamp) => ({
    name,
    status: 'completed',
    conclusion,
    completed_at: stamp,
    html_url: `https://github.com/o/r/actions/runs/${runId}/job/1`,
  });

  // A: full real battery. B: a metadata edit that skipped, with only `web`
  // visible as skipped so far. C: a second metadata edit asking the question.
  const partialSkip = [
    job('review-scope', 'success', '600', '2026-07-29T10:00:00Z'),
    job('battery-plan', 'success', '600', '2026-07-29T10:00:30Z'),
    ...PRODUCT_CHECKS.map((n) => job(n, 'success', '600', '2026-07-29T10:05:00Z')),
    job('review-scope', 'success', '700', '2026-07-29T11:00:00Z'),
    job('battery-plan', 'success', '700', '2026-07-29T11:00:30Z'),
    job('web', 'skipped', '700', '2026-07-29T11:01:00Z'),
  ];
  assert.equal(
    assessBatteryPlan({ action: 'edited', baseChanged: false, checkRuns: partialSkip }).runProducts,
    false,
    "attempt 700 is skipping, so it preserves 600's evidence for every name",
  );
  assert.equal(summarizeRequiredChecks(partialSkip).state, 'success');

  // The R9 case is unchanged: a partially visible RUNNING attempt supersedes.
  const partialRun = [
    ...partialSkip.slice(0, 7),
    job('review-scope', 'success', '700', '2026-07-29T11:00:00Z'),
    job('battery-plan', 'success', '700', '2026-07-29T11:00:30Z'),
    job('web', 'success', '700', '2026-07-29T11:05:00Z'),
  ];
  assert.equal(
    assessBatteryPlan({ action: 'edited', baseChanged: false, checkRuns: partialRun }).runProducts,
    true,
    'a running attempt vouches only for the names it has produced',
  );
});

// FINDING (round 10) — `html_url ?? details_url` only falls through on
// null/undefined, so a populated non-Actions html_url hid the Actions job URL.
test('the current-run exclusion reads both URLs', () => {
  const runId = '900';
  assert.equal(
    belongsToRun({ html_url: `https://github.com/o/r/actions/runs/${runId}/job/1` }, runId),
    true,
  );
  assert.equal(
    belongsToRun({
      html_url: 'https://github.com/o/r/runs/12345',
      details_url: `https://github.com/o/r/actions/runs/${runId}/job/1`,
    }, runId),
    true,
    'an Actions job URL in details_url must be seen past a populated html_url',
  );
  assert.equal(belongsToRun({ html_url: 'https://example.test/x' }, runId), false);
  assert.equal(belongsToRun({}, runId), false);
  assert.equal(belongsToRun({ html_url: `https://github.com/o/r/actions/runs/${runId}/job/1` }, null), false);
});

// FINDING (round 11) — DELIBERATELY NOT FIXED, and pinned here so the choice is
// visible rather than an oversight.
//
// When an attempt's gates have completed but none of its product check runs
// exist yet, that observation is identical whether the plan chose to skip (its
// skipped runs are about to appear) or the base changed (its real runs are). The
// finding asks the plan to assume "skip" so a second metadata edit does not
// relaunch. It cannot: assuming "skip" after a retarget accepts the previous
// base's products as coverage for a merge result they never tested, which is the
// exact defect rounds 4-9 were spent closing.
//
// A consumer-split was tried and rejected — the plan needs opposite answers in
// two states it cannot distinguish, so there is no sound rule to write. The
// window therefore resolves toward RUNNING: it costs one redundant battery in a
// window measured in seconds, and it cannot promote untested code.
test('the undecidable gates-only window resolves toward running, not toward trust', () => {
  const job = (name, conclusion, runId, stamp) => ({
    name,
    status: 'completed',
    conclusion,
    completed_at: stamp,
    html_url: `https://github.com/o/r/actions/runs/${runId}/job/1`,
  });
  const gatesOnly = [
    job('review-scope', 'success', '600', '2026-07-29T10:00:00Z'),
    job('battery-plan', 'success', '600', '2026-07-29T10:00:30Z'),
    ...PRODUCT_CHECKS.map((n) => job(n, 'success', '600', '2026-07-29T10:05:00Z')),
    job('review-scope', 'success', '700', '2026-07-29T11:00:00Z'),
    job('battery-plan', 'success', '700', '2026-07-29T11:00:30Z'),
  ];

  assert.equal(
    assessBatteryPlan({ action: 'edited', baseChanged: false, checkRuns: gatesOnly }).runProducts,
    true,
    'the redundant battery is the accepted cost; trusting the older base is not',
  );
  assert.equal(summarizeRequiredChecks(gatesOnly).state, 'pending');
  assert.deepEqual(summarizeRequiredChecks(gatesOnly).failed, []);

  // The window is genuinely transient: once attempt 700's skipped runs appear it
  // is recognised as skipping, and attempt 600's evidence stands again.
  const resolved = [
    ...gatesOnly,
    ...PRODUCT_CHECKS.map((n) => job(n, 'skipped', '700', '2026-07-29T11:01:00Z')),
  ];
  assert.equal(
    assessBatteryPlan({ action: 'edited', baseChanged: false, checkRuns: resolved }).runProducts,
    false,
  );
  assert.equal(summarizeRequiredChecks(resolved).state, 'success');
});

// FINDING (#249 round 10, P1) — the watermark compared a product's own
// COMPLETION time, but what dates evidence is the attempt that launched it. A
// straggler from the superseded base can finish after the new base's gates and
// pass a timestamp-only check, so the gate publishes success for a merge result
// whose product jobs never ran against it.
test('a straggling product run from a superseded attempt is not coverage', () => {
  const at = (name, runId, stamp, extra = {}) => ({
    name,
    status: 'completed',
    conclusion: 'success',
    completed_at: stamp,
    html_url: `https://github.com/o/r/actions/runs/${runId}/job/1`,
    ...extra,
  });

  // Attempt 800 ran on base A: gates at 10:00, four products done at 10:05 —
  // but its `api` job is slow and is still running.
  const baseA = [
    at('review-scope', '800', '2026-07-29T10:00:00Z'),
    at('battery-plan', '800', '2026-07-29T10:00:30Z'),
    ...PRODUCT_CHECKS.filter((n) => n !== 'api').map((n) => at(n, '800', '2026-07-29T10:05:00Z')),
  ];

  // A retarget to base B lands. Attempt 900's gates pass at 11:00. None of its
  // product jobs exist yet.
  const afterRetarget = [
    ...baseA,
    at('review-scope', '900', '2026-07-29T11:00:00Z'),
    at('battery-plan', '900', '2026-07-29T11:00:30Z'),
  ];

  // NOW the stale base-A `api` finally finishes — at 11:05, AFTER base B's
  // gates. Its completion is the newest of any `api` run, but it tested base A.
  const withStraggler = [
    ...afterRetarget,
    at('api', '800', '2026-07-29T11:05:00Z'),
  ];

  const summary = summarizeRequiredChecks(withStraggler, [...PRODUCT_CHECKS]);
  assert.ok(
    summary.pending.includes('api'),
    'a base-A product that merely finished late is not base-B coverage',
  );
  assert.deepEqual(summary.failed, [], 'superseded is pending, never failed');
  assert.equal(summary.passed?.includes?.('api') ?? false, false);

  // The same run IS coverage while its own attempt is still the current one:
  // with no retarget, attempt 800's late `api` completes the battery.
  const noRetarget = [...baseA, at('api', '800', '2026-07-29T11:05:00Z')];
  const covered = summarizeRequiredChecks(noRetarget, [...PRODUCT_CHECKS]);
  assert.deepEqual(covered.pending, [], 'no supersession: the late run counts');
  assert.deepEqual(covered.failed, []);
});

// FINDING (#249 round 11 P1) — the decider was chosen by COMPLETION time across
// attempts, before attempt currency was considered. A stale straggler that
// succeeds after the current attempt has already failed the same name was
// therefore selected, and the gate reported success over red exact-head CI.
test('a current-attempt failure outranks a stale straggling success', () => {
  const at = (name, runId, stamp, conclusion = 'success') => ({
    name,
    status: 'completed',
    conclusion,
    completed_at: stamp,
    html_url: `https://github.com/o/r/actions/runs/${runId}/job/1`,
  });

  const runs = [
    // attempt 800 on base A: gates at 10:00, api still running
    at('review-scope', '800', '2026-07-29T10:00:00Z'),
    at('battery-plan', '800', '2026-07-29T10:00:30Z'),
    // retarget: attempt 900's gates at 11:00, and its api FAILS at 11:02
    at('review-scope', '900', '2026-07-29T11:00:00Z'),
    at('battery-plan', '900', '2026-07-29T11:00:30Z'),
    at('api', '900', '2026-07-29T11:02:00Z', 'failure'),
    // the stale base-A api then SUCCEEDS at 11:05
    at('api', '800', '2026-07-29T11:05:00Z'),
  ];

  const summary = summarizeRequiredChecks(runs, ['api']);
  assert.ok(
    summary.failed.includes('api'),
    'the current attempt failed api; a stale straggler must not report success',
  );
  assert.equal(summary.passed?.includes?.('api') ?? false, false);
});

// FINDING (#249 round 11 P2) — the gate began dating evidence by its attempt's
// gates while the planner still used completion time. The two then disagree: the
// planner sees old-base products finishing after the retarget gates and skips
// the battery, while the gate dates the same evidence to the old attempt and
// stays pending. Nothing relaunches the products, so the head stalls forever.
test('the planner and the gate date coverage identically', () => {
  const at = (name, runId, stamp) => ({
    name,
    status: 'completed',
    conclusion: 'success',
    completed_at: stamp,
    html_url: `https://github.com/o/r/actions/runs/${runId}/job/1`,
  });

  // attempt 800 on base A: gates at 10:00; ALL five products finish at 11:05 —
  // after attempt 900's retarget gates at 11:00.
  const runs = [
    at('review-scope', '800', '2026-07-29T10:00:00Z'),
    at('battery-plan', '800', '2026-07-29T10:00:30Z'),
    at('review-scope', '900', '2026-07-29T11:00:00Z'),
    at('battery-plan', '900', '2026-07-29T11:00:30Z'),
    ...PRODUCT_CHECKS.map((n) => at(n, '800', '2026-07-29T11:05:00Z')),
  ];

  const plan = assessBatteryPlan({ action: 'edited', baseChanged: false, checkRuns: runs });
  const summary = summarizeRequiredChecks(runs, [...PRODUCT_CHECKS]);

  // The gate holds this evidence superseded, so the planner must relaunch it.
  // Whatever the two decide, they must not decide OPPOSITE things — that is the
  // deadlock: skipped products plus a permanently pending gate.
  const gateSuperseded = summary.pending.length > 0;
  assert.equal(
    gateSuperseded && plan.runProducts === false,
    false,
    'planner skipped the battery while the gate treats the same evidence as superseded',
  );
});

// FINDING (#249 round 12 P2) — the planner's in-flight fast path returned
// "covered" before asking whether the run's attempt was still current. A base-A
// product still executing when base B's gates pass is not coverage in progress
// for base B: whatever it reports will describe the old merge result.
test('an in-flight product from a superseded attempt is not coverage', () => {
  const at = (name, runId, stamp, extra = {}) => ({
    name,
    status: 'completed',
    conclusion: 'success',
    completed_at: stamp,
    html_url: `https://github.com/o/r/actions/runs/${runId}/job/1`,
    ...extra,
  });
  const others = PRODUCT_CHECKS.filter((n) => n !== 'api');

  const runs = [
    // attempt 800 on base A: gates, four products done, `api` still running
    at('review-scope', '800', '2026-07-29T10:00:00Z'),
    at('battery-plan', '800', '2026-07-29T10:00:30Z'),
    ...others.map((n) => at(n, '800', '2026-07-29T10:05:00Z')),
    { name: 'api', status: 'in_progress', conclusion: null,
      html_url: 'https://github.com/o/r/actions/runs/800/job/9' },
    // retarget: attempt 900's gates pass, its four other products land, and its
    // own `api` job has not been created yet
    at('review-scope', '900', '2026-07-29T11:00:00Z'),
    at('battery-plan', '900', '2026-07-29T11:00:30Z'),
    ...others.map((n) => at(n, '900', '2026-07-29T11:05:00Z')),
  ];

  const plan = assessBatteryPlan({ action: 'edited', baseChanged: false, checkRuns: runs });
  assert.equal(
    plan.runProducts,
    true,
    'base B has no api evidence; a base-A job still running is not coverage for it',
  );
});

// FINDING (#249 round 12 P2) — a skip was called deliberate whenever the
// attempt held SOME successful gate run, so a `rerun-failed-jobs` success
// retroactively blessed products that had skipped because that same gate FAILED.
test('a gate rerun does not bless the skips its earlier failure caused', () => {
  const job = (name, conclusion, runId, stamp) => ({
    name,
    status: 'completed',
    conclusion,
    completed_at: stamp,
    html_url: `https://github.com/o/r/actions/runs/${runId}/job/1`,
  });

  const runs = [
    // attempt 800: a full, real, green battery on the previous base
    job('review-scope', 'success', '800', '2026-07-29T10:00:00Z'),
    job('battery-plan', 'success', '800', '2026-07-29T10:00:30Z'),
    ...PRODUCT_CHECKS.map((n) => job(n, 'success', '800', '2026-07-29T10:05:00Z')),
    // attempt 900: battery-plan FAILS, so every product of that attempt skips
    job('review-scope', 'success', '900', '2026-07-29T11:00:00Z'),
    job('battery-plan', 'failure', '900', '2026-07-29T11:00:30Z'),
    ...PRODUCT_CHECKS.map((n) => job(n, 'skipped', '900', '2026-07-29T11:01:00Z')),
    // the bounded retry reruns battery-plan; its product reruns are not visible
    job('battery-plan', 'success', '900', '2026-07-29T11:30:00Z'),
  ];

  const summary = summarizeRequiredChecks(runs, [...PRODUCT_CHECKS]);
  assert.notEqual(
    summary.state,
    'success',
    'attempt 900 aborted; its skips cannot defer to the previous base',
  );
  assert.deepEqual(summary.failed, [...PRODUCT_CHECKS]);
});

// FINDING (#249 round 12 P2) — `filter=all` returns every historical run, and
// the gate marked a check pending if ANY of them was unfinished. A superseded
// attempt's still-running job then held the head pending until timeout even
// though the current attempt had already passed that check.
test('a stale in-flight run does not hold a passed current attempt pending', () => {
  const at = (name, runId, stamp) => ({
    name,
    status: 'completed',
    conclusion: 'success',
    completed_at: stamp,
    html_url: `https://github.com/o/r/actions/runs/${runId}/job/1`,
  });

  const runs = [
    at('review-scope', '800', '2026-07-29T10:00:00Z'),
    at('battery-plan', '800', '2026-07-29T10:00:30Z'),
    // attempt 800's api never finished
    { name: 'api', status: 'in_progress', conclusion: null,
      html_url: 'https://github.com/o/r/actions/runs/800/job/9' },
    at('review-scope', '900', '2026-07-29T11:00:00Z'),
    at('battery-plan', '900', '2026-07-29T11:00:30Z'),
    at('api', '900', '2026-07-29T11:05:00Z'),
  ];

  const summary = summarizeRequiredChecks(runs, ['api']);
  assert.deepEqual(summary.pending, [], 'the current attempt passed api');
  assert.deepEqual(summary.failed, []);
  assert.deepEqual(summary.missing, []);

  // The converse still holds: the CURRENT attempt's own unfinished job is
  // genuinely pending, even with an older completed success on the same name.
  const currentRunning = [
    at('review-scope', '800', '2026-07-29T10:00:00Z'),
    at('battery-plan', '800', '2026-07-29T10:00:30Z'),
    at('api', '800', '2026-07-29T10:05:00Z'),
    at('review-scope', '900', '2026-07-29T11:00:00Z'),
    at('battery-plan', '900', '2026-07-29T11:00:30Z'),
    { name: 'api', status: 'in_progress', conclusion: null,
      html_url: 'https://github.com/o/r/actions/runs/900/job/9' },
  ];
  assert.deepEqual(
    summarizeRequiredChecks(currentRunning, ['api']).pending,
    ['api'],
    'the current attempt is still running api',
  );
});

// FINDING (#249 round 13 P2) — round 12 taught the GATE that an aborted
// attempt's skips prove nothing, but the shared watermark still read them as a
// deliberate "already covered". The two then deadlock the head: the gate calls
// the aborted skips a failure while the planner refuses to launch the battery
// that would replace them.
test('an aborted attempt\'s skips neither produce nor preserve coverage', () => {
  const job = (name, conclusion, runId, stamp) => ({
    name,
    status: 'completed',
    conclusion,
    completed_at: stamp,
    html_url: `https://github.com/o/r/actions/runs/${runId}/job/1`,
  });

  const runs = [
    // attempt 800: a full, real, green battery
    job('review-scope', 'success', '800', '2026-07-29T10:00:00Z'),
    job('battery-plan', 'success', '800', '2026-07-29T10:00:30Z'),
    ...PRODUCT_CHECKS.map((n) => job(n, 'success', '800', '2026-07-29T10:05:00Z')),
    // attempt 900: battery-plan fails, products skip, the retry then succeeds
    job('review-scope', 'success', '900', '2026-07-29T11:00:00Z'),
    job('battery-plan', 'failure', '900', '2026-07-29T11:00:30Z'),
    ...PRODUCT_CHECKS.map((n) => job(n, 'skipped', '900', '2026-07-29T11:01:00Z')),
    job('battery-plan', 'success', '900', '2026-07-29T11:30:00Z'),
  ];

  const plan = assessBatteryPlan({ action: 'edited', baseChanged: false, checkRuns: runs });
  const summary = summarizeRequiredChecks(runs, [...PRODUCT_CHECKS]);
  assert.equal(
    plan.runProducts,
    true,
    'attempt 900 aborted; the next edit must launch the battery it never ran',
  );
  // The two sides must not disagree — that disagreement IS the deadlock.
  assert.equal(
    summary.state === 'failure' && plan.runProducts === false,
    false,
    'the gate rejects the aborted skips while the planner refuses to replace them',
  );
});

// FINDING (#249 round 13 P2) — the unfinished-gate guard fired for ANY pending
// gate anywhere in the history, so one hung straggler forced a full duplicate
// battery on every later metadata edit, defeating one-battery-per-SHA.
test('a hung gate from a superseded attempt does not force a duplicate battery', () => {
  const job = (name, runId, stamp) => ({
    name,
    status: 'completed',
    conclusion: 'success',
    completed_at: stamp,
    html_url: `https://github.com/o/r/actions/runs/${runId}/job/1`,
  });

  const runs = [
    // attempt 800: review-scope hangs, so its product jobs never get created
    { name: 'review-scope', status: 'in_progress', conclusion: null,
      html_url: 'https://github.com/o/r/actions/runs/800/job/1' },
    job('battery-plan', '800', '2026-07-29T10:00:30Z'),
    // attempt 900: complete and green for the same SHA
    job('review-scope', '900', '2026-07-29T11:00:00Z'),
    job('battery-plan', '900', '2026-07-29T11:00:30Z'),
    ...PRODUCT_CHECKS.map((n) => job(n, '900', '2026-07-29T11:05:00Z')),
  ];

  assert.equal(
    assessBatteryPlan({ action: 'edited', baseChanged: false, checkRuns: runs }).runProducts,
    false,
    'attempt 900 already covers this head; 800 can no longer change that',
  );

  // The frontier's unknown verdict still forces a run: an attempt with NO
  // completed gate cannot be dated, so it may yet supersede this evidence.
  const frontierUnknown = [
    ...runs,
    { name: 'review-scope', status: 'queued', conclusion: null,
      html_url: 'https://github.com/o/r/actions/runs/1000/job/1' },
    { name: 'battery-plan', status: 'queued', conclusion: null,
      html_url: 'https://github.com/o/r/actions/runs/1000/job/2' },
  ];
  assert.equal(
    assessBatteryPlan({
      action: 'edited', baseChanged: false, checkRuns: frontierUnknown,
    }).runProducts,
    true,
    'an undatable in-flight attempt is still a reason to run',
  );
});

// FINDING (#249 round 14 P1) — attempt-currency ordering dates a run by the
// GATES THAT LAUNCHED IT. That is meaningful for a product job and wrong for a
// gate, which dates itself: a gate run inherits its sibling gate's later
// completion and can outrank a NEWER failure of its own name.
test('a gate check is ordered by its own completion, not its sibling\'s', () => {
  const job = (name, conclusion, runId, stamp) => ({
    name,
    status: 'completed',
    conclusion,
    completed_at: stamp,
    started_at: stamp,
    html_url: `https://github.com/o/r/actions/runs/${runId}/job/1`,
  });

  const runs = [
    // attempt 900: review-scope passes at 11:00; its battery-plan is slow
    job('review-scope', 'success', '900', '2026-07-29T11:00:00Z'),
    // a body edit starts attempt 1000, whose review-scope FAILS at 11:05
    job('review-scope', 'failure', '1000', '2026-07-29T11:05:00Z'),
    // only now does attempt 900's battery-plan finish, at 11:10
    job('battery-plan', 'success', '900', '2026-07-29T11:10:00Z'),
  ];

  const summary = summarizeRequiredChecks(runs, ['review-scope']);
  assert.deepEqual(
    summary.failed,
    ['review-scope'],
    'the current review-scope is red; 900 must not borrow 11:10 to outrank it',
  );
  assert.notEqual(summary.state, 'success');
});

// FINDING (#249 round 14 P2) — an attempt whose gates are ALL still queued has
// no attempt stamp, so the undatable sentinel sorted its runs ahead of a later
// completed attempt and held the head pending until timeout.
test('a hung undatable attempt does not hold completed gates pending', () => {
  const queued = (name, runId, started) => ({
    name,
    status: 'queued',
    conclusion: null,
    started_at: started,
    html_url: `https://github.com/o/r/actions/runs/${runId}/job/1`,
  });
  const job = (name, runId, stamp) => ({
    name,
    status: 'completed',
    conclusion: 'success',
    completed_at: stamp,
    started_at: stamp,
    html_url: `https://github.com/o/r/actions/runs/${runId}/job/1`,
  });

  const runs = [
    // attempt 800 queues both gates and hangs: neither ever completes, so the
    // attempt has no gate stamp at all
    queued('review-scope', '800', '2026-07-29T09:00:00Z'),
    queued('battery-plan', '800', '2026-07-29T09:00:00Z'),
    // attempt 900 then completes everything for the same SHA
    job('review-scope', '900', '2026-07-29T11:00:00Z'),
    job('battery-plan', '900', '2026-07-29T11:00:30Z'),
    ...PRODUCT_CHECKS.map((n) => job(n, '900', '2026-07-29T11:05:00Z')),
  ];

  const summary = summarizeRequiredChecks(runs);
  assert.deepEqual(summary.pending, [], 'attempt 900 completed every check');
  assert.deepEqual(summary.failed, []);
  assert.deepEqual(summary.missing, []);
  assert.equal(summary.state, 'success');

  // The converse: a gate started AFTER the newest completion is live activity
  // and still holds the head pending.
  const liveRerun = [
    ...runs,
    queued('review-scope', '1000', '2026-07-29T11:30:00Z'),
  ];
  assert.deepEqual(
    summarizeRequiredChecks(liveRerun).pending,
    ['review-scope'],
    'a gate that started after the newest completion is genuinely pending',
  );
});
