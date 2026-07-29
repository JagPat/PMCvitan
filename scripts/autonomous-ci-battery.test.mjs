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
