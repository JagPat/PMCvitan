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
  // Every state of the baseline path, named in the script rather than assumed of it. C, D and E
  // are the populated and partial states: deleting one of them here would let the proof keep
  // reporting PASSED while covering less than it claims.
  assert.match(source, /STATE A/u, 'the proof must cover the table-absent install');
  assert.match(source, /STATE B/u, 'the proof must cover the table-present abort');
  assert.match(source, /STATE C/u, 'the proof must cover completing a partial apply');
  assert.match(source, /STATE D/u, 'the proof must cover the populated INCOMPLETE refusal');
  assert.match(source, /STATE E/u, 'the proof must cover replaying a populated COMPLETE install');
  // F is not a baseline state. It is the state every database reaches AFTER the baseline: the
  // ledger is complete, so `migrate deploy` re-reads nothing, and the migration's own proof cannot
  // run again. Deleting it here would let the proof keep reporting PASSED while the only execution
  // of the deploy-time seal verifier disappeared.
  assert.match(source, /STATE F/u, 'the proof must cover the ledger-complete database whose guards were switched off');
});

// ── The armed-seal falsification proof — the same requirement, for the unscoped verifier ────────
// `armed-seals-falsification-proof.sh` is the only test that drives the production `migrate.sh`
// over a database whose guards have been switched OFF. Without it the deploy-time armed-seal check
// could regress to accepting everything and every required job would still pass, because no other
// suite tampers with the catalog. The walk above is reused rather than restated: this is the same
// concern — a proof that must be RUN BY A REQUIRED JOB — asked about a second script.
const ARMED_SCRIPT = 'apps/api/scripts/armed-seals-falsification-proof.sh';

test('the armed-seal falsification proof is a step of the `api` job', async () => {
  const jobs = parseJobs(await readFile(WORKFLOW, 'utf8'));
  assert.equal(stepsRunning(jobs.get(HOST_JOB), ARMED_SCRIPT), 1,
    `exactly one step of \`${HOST_JOB}\` must run ${ARMED_SCRIPT}`);
});

test('the armed-seal detection FAILS when its step is removed — it is not merely running', async () => {
  const yaml = await readFile(WORKFLOW, 'utf8');
  const withoutStep = yaml.split('\n').filter((line) => !line.includes(ARMED_SCRIPT)).join('\n');
  assert.equal(stepsRunning(parseJobs(withoutStep).get(HOST_JOB), ARMED_SCRIPT), 0,
    'the fixture must not still contain the step, or this test proves nothing');
});

test('the armed-seal proof reports a verdict, and covers every unarming mechanism it claims', async () => {
  const source = await readFile(new URL(`../${ARMED_SCRIPT}`, import.meta.url), 'utf8');
  assert.match(source, /\[armed-seals\] PASSED/u);
  assert.match(source, /\[armed-seals\] FAILED/u);
  // Each is a distinct way an object stays in the catalog and stops enforcing. Deleting one would
  // let the proof keep reporting PASSED while covering less than the verifier claims to check.
  assert.match(source, /F1 disabled trigger/u, 'must cover a DISABLED trigger');
  assert.match(source, /F2 blinded foreign key/u, 'must cover a key whose internal RI triggers are off');
  assert.match(source, /F3 NOT VALID constraint/u, 'must cover a constraint that was never validated');
  assert.match(source, /F4 relhastriggers bypass/u, 'must cover the relhastriggers table-wide bypass');
  // The baseline is what makes a refusal meaningful: a checker that refuses everything proves
  // nothing, so the untampered pass and the repaired pass are both required to be asserted.
  assert.match(source, /untampered ledger-complete database deploys clean/u,
    'must assert that an intact database still passes');
  assert.match(source, /passes again once repaired/u,
    'must assert the check is precise, not merely strict');
});
