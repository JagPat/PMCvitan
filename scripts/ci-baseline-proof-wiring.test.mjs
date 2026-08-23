import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

/**
 * `apps/api/scripts/schedule-b1-baseline-proof.sh` must be RUN BY A REQUIRED JOB.
 *
 * It is the only test that executes the production `scripts/migrate.sh` P3005 baseline path.
 * `upgrade-proof.sh` upgrades a LEDGER-BACKED database, which never reaches the ALWAYS_EXECUTE
 * handling at all — so without this wiring, a regression in that handling, or in
 * `20270930000000_schedule_dependency_graph`'s behaviour over a database that already has
 * "ActivityDependency", passes every required job while the reproduction sits unexecuted.
 * Evidence that no required job runs is a claim, not evidence.
 *
 * The wiring does not keep itself. Deleting the step leaves a workflow that still parses and a
 * suite that still passes, so the requirement is asserted here — over the committed file, in
 * `pnpm test:automation`, which the required `automation` job runs. Deleting the step therefore
 * turns a required job red rather than quietly removing the only proof of the baseline path.
 *
 * The walk below is the same small structural one `ci-workflow-timeouts.test.mjs` uses, restated
 * here rather than imported: importing a sibling `*.test.mjs` would register its tests a second
 * time under this file's name, since both are in the `scripts/ci-*.test.mjs` glob.
 */

const WORKFLOW = new URL('../.github/workflows/ci.yml', import.meta.url);
const SCRIPT = 'apps/api/scripts/schedule-b1-baseline-proof.sh';

/** The job that must carry the proof, and the gate that must require that job. */
const HOST_JOB = 'api';
const GATE_JOB = 'quality-gate';

/** The `jobs:` block, split per job, preserving each job's own lines. */
function parseJobs(yaml) {
  const lines = String(yaml).split('\n');
  const start = lines.findIndex((line) => line === 'jobs:');
  if (start < 0) return new Map();

  const jobs = new Map();
  let current = null;
  for (const line of lines.slice(start + 1)) {
    if (/^[A-Za-z][\w-]*:/u.test(line)) break;
    const header = /^ {2}([A-Za-z][\w-]*):\s*$/u.exec(line);
    if (header) { current = []; jobs.set(header[1], current); continue; }
    if (current) current.push(line);
  }
  return jobs;
}

/** How many of a job's steps run `needle`. Counted per STEP, so one step is one answer. */
function stepsRunning(jobLines, needle) {
  let count = 0;
  let inStep = false;
  let hit = false;
  for (const line of jobLines) {
    if (/^ {6}- /u.test(line)) {
      if (inStep && hit) count += 1;
      inStep = true;
      hit = line.includes(needle);
      continue;
    }
    if (inStep && line.includes(needle)) hit = true;
  }
  if (inStep && hit) count += 1;
  return count;
}

/** The `needs:` list of one job, as names. */
function parseNeeds(jobLines) {
  const needs = [];
  let inside = false;
  for (const line of jobLines) {
    if (/^ {4}needs:\s*$/u.test(line)) { inside = true; continue; }
    if (!inside) continue;
    const item = /^ {6}- ([A-Za-z][\w-]*)\s*$/u.exec(line);
    if (item) { needs.push(item[1]); continue; }
    if (line.trim() !== '') break;
  }
  return needs;
}

test('the schedule B1 baseline proof is a step of the `api` job', async () => {
  const jobs = parseJobs(await readFile(WORKFLOW, 'utf8'));
  const job = jobs.get(HOST_JOB);
  assert.ok(job, `ci.yml must define the \`${HOST_JOB}\` job`);
  assert.equal(stepsRunning(job, SCRIPT), 1,
    `exactly one step of \`${HOST_JOB}\` must run ${SCRIPT}`);
});

test('and that job is required by the single required status', async () => {
  const jobs = parseJobs(await readFile(WORKFLOW, 'utf8'));
  const gate = jobs.get(GATE_JOB);
  assert.ok(gate, `ci.yml must define the \`${GATE_JOB}\` job`);
  assert.ok(parseNeeds(gate).includes(HOST_JOB),
    `\`${GATE_JOB}\` must need \`${HOST_JOB}\`, or the proof runs in a job nothing waits for`);
});

test('the detection FAILS when the step is removed — it is not merely running', async () => {
  // A checker that silently found nothing would pass this file forever. So the same walk is run
  // over a fixture with the step deleted, and is required to come up empty.
  const yaml = await readFile(WORKFLOW, 'utf8');
  const withoutStep = yaml.split('\n').filter((line) => !line.includes(SCRIPT)).join('\n');
  assert.equal(stepsRunning(parseJobs(withoutStep).get(HOST_JOB), SCRIPT), 0,
    'the fixture must not still contain the step, or this test proves nothing');

  // …and equally when the job stops being required.
  const withoutNeed = yaml.split('\n')
    .filter((line, i, all) => !(line === `      - ${HOST_JOB}` && all.slice(0, i).some((l) => /^ {4}needs:$/u.test(l))))
    .join('\n');
  assert.ok(!parseNeeds(parseJobs(withoutNeed).get(GATE_JOB)).includes(HOST_JOB),
    'the needs fixture must really drop the job, or the second assertion proves nothing');
});

test('the proof script itself reports a verdict the step can fail on', async () => {
  const source = await readFile(new URL(`../${SCRIPT}`, import.meta.url), 'utf8');
  assert.match(source, /schedule B1 baseline proof: PASSED/u);
  assert.match(source, /schedule B1 baseline proof: FAILED/u);
  // Both halves of the baseline path, named in the script rather than assumed of it.
  assert.match(source, /STATE A/u, 'the proof must cover the table-absent install');
  assert.match(source, /STATE B/u, 'the proof must cover the table-present abort');
});
