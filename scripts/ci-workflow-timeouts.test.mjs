import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

/**
 * Every `ci.yml` job — and the step that actually hangs — must be bounded in time.
 *
 * Without a budget a stalled step runs toward GitHub's six-hour default. That is not
 * theoretical: `playwright install --with-deps` runs `apt-get update`, and when a runner's
 * mirror stops responding the fetch has no timeout of its own. On PR #370 head 58b2d51 it ran
 * 33 minutes on one attempt and 36 on the next, while the identical command finished in 84
 * seconds elsewhere in the same workflow. It cost the orchestrator's settle window twice, burned
 * the single automatic CI retry, and reported failure on a head whose every product gate passed.
 *
 * The budgets alone do not keep themselves. Deleting one, or adding a new job without one, is
 * invisible: the workflow still parses, every test still passes, and the next stalled runner
 * silently costs another review round. So the invariant is asserted here, over the committed
 * file, rather than trusted to whoever edits it next.
 *
 * There is no YAML parser available to this suite, so the walk below is deliberately small and
 * structural rather than a general parser. Two consequences are load-bearing:
 *
 *  - A budget is matched at its OWN indentation. A job's budget sits at four spaces and a step's
 *    at eight, and `timeout-minutes` appearing anywhere inside a job is not the same claim as
 *    that job carrying one. Matching loosely made deleting `api-e2e`'s job budget invisible,
 *    because the Playwright step's budget nested inside it answered for the job.
 *  - The detection is exercised against fixtures whose budgets have been removed, so what is
 *    proven is that the checks FAIL on a violation — not merely that they run. A checker that
 *    silently found nothing would pass this file forever.
 */

const WORKFLOW = new URL('../.github/workflows/ci.yml', import.meta.url);

/** The `jobs:` block, split per job, preserving each job's own lines. */
export function parseJobs(yaml) {
  const lines = String(yaml).split('\n');
  const start = lines.findIndex((line) => line === 'jobs:');
  if (start < 0) return new Map();

  const jobs = new Map();
  let current = null;
  for (const line of lines.slice(start + 1)) {
    // A top-level KEY ends the jobs block. Checked as a key rather than as any
    // non-space so a column-0 comment does not silently truncate the walk.
    if (/^[A-Za-z][\w-]*:/u.test(line)) break;
    const header = /^ {2}([A-Za-z][\w-]*):\s*$/u.exec(line);
    if (header) {
      current = { name: header[1], lines: [] };
      jobs.set(header[1], current);
      continue;
    }
    if (current) current.lines.push(line);
  }
  return jobs;
}

/** The steps of one job, split on the `- ` that begins each. */
export function parseSteps(jobLines) {
  const steps = [];
  let current = null;
  for (const line of jobLines) {
    if (/^ {6}- /u.test(line)) {
      current = [line];
      steps.push(current);
      continue;
    }
    if (current) current.push(line);
  }
  return steps;
}

/**
 * A budget belonging to THIS scope, not to something nested inside it.
 *
 * `indent` is the column the key must start at: 4 for a job's own key, 8 for a step's. Without
 * it a job containing a bounded step reads as bounded itself, which is precisely the hole a
 * mutation of this file's first draft walked through.
 */
export const hasBudget = (lines, indent) =>
  lines.some((line) => new RegExp(`^ {${indent}}timeout-minutes:\\s*\\d+\\s*$`, 'u').test(line));

const JOB_INDENT = 4;
const STEP_INDENT = 8;

/** Jobs with no budget of their own. */
export function unboundedJobs(yaml) {
  return [...parseJobs(yaml).values()]
    .filter((job) => !hasBudget(job.lines, JOB_INDENT))
    .map((job) => job.name);
}

/** The minutes in a budget belonging to THIS scope, or null when the scope carries none. */
export const budgetMinutes = (lines, indent) => {
  const pattern = new RegExp(`^ {${indent}}timeout-minutes:\\s*(\\d+)\\s*$`, 'u');
  for (const line of lines) {
    const found = pattern.exec(line);
    if (found) return Number(found[1]);
  }
  return null;
};

/**
 * Jobs whose own budget cannot even cover the budgets of the steps inside them.
 *
 * A job budget is not a formality once its steps carry bounds of their own: it is the outer
 * bound, and it must be able to hold them. On PR #517 head deb9b2f the `api` job carried 60
 * minutes while three production-runner proofs inside it were bounded at 25 each. The battery
 * and the first proof passed, then the JOB timeout cancelled the second proof mid-flight and
 * skipped the third. GitHub reports that as a red required job, and nothing in it names a
 * budget — the failure looks like a broken proof. Each step bound was individually reasonable;
 * only their sum against the job's was wrong, and no check looked at the sum.
 *
 * The comparison is deliberately the weakest necessary one — the sum of the STEP bounds alone,
 * ignoring every unbounded step (install, build, the batteries) that also consumes the job. A
 * job passing this is not proven to fit; a job failing it is proven not to.
 */
export function jobsBudgetedBelowTheirSteps(yaml) {
  return [...parseJobs(yaml).values()].flatMap((job) => {
    const budget = budgetMinutes(job.lines, JOB_INDENT);
    if (budget === null) return [];
    const steps = parseSteps(job.lines)
      .map((step) => budgetMinutes(step, STEP_INDENT))
      .filter((minutes) => minutes !== null);
    const required = steps.reduce((total, minutes) => total + minutes, 0);
    return required > budget ? [{ job: job.name, budget, required }] : [];
  });
}

/** Playwright install steps, with the job each belongs to. */
export function playwrightInstalls(yaml) {
  return [...parseJobs(yaml).values()].flatMap((job) =>
    parseSteps(job.lines)
      .filter((step) => step.some((line) => line.includes('playwright install')))
      .map((step) => ({ job: job.name, step })));
}

test('every ci.yml job is bounded in time', async () => {
  const yaml = await readFile(WORKFLOW, 'utf8');

  // A walk that found nothing would satisfy the assertion below without checking anything.
  const jobs = parseJobs(yaml);
  assert.ok(jobs.size >= 8, `expected the jobs block to parse; found ${jobs.size} jobs`);

  const unbounded = unboundedJobs(yaml);
  assert.deepEqual(
    unbounded, [],
    `these ci.yml jobs have no timeout-minutes of their own, so a stalled step runs toward the six-hour cap: ${unbounded.join(', ')}`,
  );
});

test('the step that hangs carries its own, tighter budget', async () => {
  const yaml = await readFile(WORKFLOW, 'utf8');

  // Both e2e jobs install Chromium. If that ever drops to zero the guard has stopped guarding.
  const installs = playwrightInstalls(yaml);
  assert.ok(installs.length >= 2, `expected the Playwright installs to be found; got ${installs.length}`);

  const unbounded = installs.filter(({ step }) => !hasBudget(step, STEP_INDENT)).map(({ job }) => job);
  assert.deepEqual(
    unbounded, [],
    `the Playwright install step is where apt stalls; it needs its own budget in: ${unbounded.join(', ')}`,
  );
});

test('the checks fail on a violation rather than passing over it', () => {
  // Fixtures, so the DETECTION is proven independently of the live file. Without these the two
  // tests above would pass just as happily against a parser that never found anything.
  const bounded = [
    'jobs:',
    '  alpha:',
    '    runs-on: ubuntu-latest',
    '    timeout-minutes: 10',
    '    steps:',
    '      - name: Install Playwright Chromium',
    '        timeout-minutes: 8',
    '        run: pnpm --filter web exec playwright install --with-deps chromium',
    '',
  ].join('\n');

  assert.equal(parseJobs(bounded).size, 1);
  assert.deepEqual(unboundedJobs(bounded), []);
  assert.deepEqual(playwrightInstalls(bounded).filter(({ step }) => !hasBudget(step, STEP_INDENT)), []);

  // The JOB budget removed, with the step's left in place. This is the mutation that walked past
  // the first draft of this file: a loose match found the step's `timeout-minutes` nested inside
  // the job and called the job bounded. It must be caught.
  assert.deepEqual(
    unboundedJobs(bounded.replace('    timeout-minutes: 10\n', '')), ['alpha'],
    'a job whose only timeout-minutes belongs to a nested step is NOT bounded',
  );

  // The STEP budget removed: the step check fails, and the job check still passes on its own.
  const stepUnbounded = bounded.replace('        timeout-minutes: 8\n', '');
  assert.deepEqual(unboundedJobs(stepUnbounded), []);
  assert.deepEqual(
    playwrightInstalls(stepUnbounded).filter(({ step }) => !hasBudget(step, STEP_INDENT)).map(({ job }) => job),
    ['alpha'],
  );

  // A second job added without any budget is caught.
  const added = `${bounded}  beta:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo hi\n`;
  assert.equal(parseJobs(added).size, 2);
  assert.deepEqual(unboundedJobs(added), ['beta']);
});

test('a job budget covers the budgets of the steps inside it', async () => {
  const yaml = await readFile(WORKFLOW, 'utf8');

  // The `api` job is the one that carries bounded steps; if it ever stops, this has stopped
  // checking anything real.
  const withStepBudgets = [...parseJobs(yaml).values()].filter(
    (job) => parseSteps(job.lines).some((step) => budgetMinutes(step, STEP_INDENT) !== null));
  assert.ok(
    withStepBudgets.length >= 1,
    `expected at least one job with bounded steps; found ${withStepBudgets.length}`);

  const under = jobsBudgetedBelowTheirSteps(yaml);
  assert.deepEqual(
    under, [],
    `these ci.yml jobs are budgeted below the steps they contain, so the job timeout cancels a step that was still inside its own bound: ${under
      .map(({ job, budget, required }) => `${job} (${budget} < ${required})`)
      .join(', ')}`,
  );
});

test('the job-covers-its-steps check fails on a violation rather than passing over it', () => {
  const job = (jobMinutes) => [
    'jobs:',
    '  alpha:',
    '    runs-on: ubuntu-latest',
    `    timeout-minutes: ${jobMinutes}`,
    '    steps:',
    '      - name: One long proof',
    '        timeout-minutes: 25',
    '        run: bash proof-one.sh',
    '      - name: Another long proof',
    '        timeout-minutes: 25',
    '        run: bash proof-two.sh',
    '',
  ].join('\n');

  // This is the shape of the deb9b2f failure: 50 minutes of bounded steps under a 40-minute job.
  assert.deepEqual(
    jobsBudgetedBelowTheirSteps(job(40)),
    [{ job: 'alpha', budget: 40, required: 50 }],
  );

  // Exactly covering is not a violation; the step bounds are a lower bound on the job, not a
  // recommendation for it.
  assert.deepEqual(jobsBudgetedBelowTheirSteps(job(50)), []);
  assert.deepEqual(jobsBudgetedBelowTheirSteps(job(90)), []);

  // A job with no bounded steps has nothing to cover, and an unbounded job is the other test's
  // finding — neither is reported here, so the two checks stay independent.
  const noStepBudgets = 'jobs:\n  beta:\n    runs-on: ubuntu-latest\n    timeout-minutes: 1\n    steps:\n      - run: echo hi\n';
  assert.deepEqual(jobsBudgetedBelowTheirSteps(noStepBudgets), []);
  const unboundedJob = job(40).replace('    timeout-minutes: 40\n', '');
  assert.deepEqual(jobsBudgetedBelowTheirSteps(unboundedJob), []);
  assert.deepEqual(unboundedJobs(unboundedJob), ['alpha']);
});
