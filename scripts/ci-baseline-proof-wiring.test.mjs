import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

/**
 * PRODUCTION-RUNNER PROOFS MUST BE RUN BY A REQUIRED JOB.
 *
 * A proof script executes the production `scripts/migrate.sh` over database states no other job
 * reaches. Its own internal mutation steps prove that the RUNNER is coupled to the check — they can
 * say nothing about whether the PROOF is still coupled to CI. Deleting its workflow step leaves a
 * workflow that still parses, a suite that still passes, and the only reproduction of that path
 * never executed. Evidence that no required job runs is a claim, not evidence.
 *
 * So the wiring is asserted here, over the committed file, in `pnpm test:automation` — which the
 * required `automation` job runs. Deleting a step below turns a required job red.
 *
 * The file's name records the first proof it pinned. The TABLE is the unit now: a proof added to
 * `PINNED_PROOFS` is checked by every assertion in this file, so pinning the next one costs one
 * entry rather than another copy of this walk.
 *
 * The walk itself is the same small structural one `ci-workflow-timeouts.test.mjs` uses, restated
 * here rather than imported: importing a sibling `*.test.mjs` would register its tests a second
 * time under this file's name, since both are in the `scripts/ci-*.test.mjs` glob.
 */

const WORKFLOW = new URL('../.github/workflows/ci.yml', import.meta.url);

/** The job that must carry the proofs, and the gate that must require that job. */
const HOST_JOB = 'api';
const GATE_JOB = 'quality-gate';

const PINNED_PROOFS = [
  {
    script: 'apps/api/scripts/schedule-b1-baseline-proof.sh',
    // The only execution of the production `migrate.sh` P3005 BASELINE path. `upgrade-proof.sh`
    // upgrades a LEDGER-BACKED database and never reaches the ALWAYS_EXECUTE handling at all.
    verdicts: [/schedule B1 baseline proof: PASSED/u, /schedule B1 baseline proof: FAILED/u],
    // Every state, named in the script rather than assumed of it: deleting one would let the proof
    // keep reporting PASSED while covering less than it claims. F is not a baseline state — it is
    // the state every database reaches after one, and carries the only execution of the
    // deploy-time seal verifier.
    states: ['STATE A', 'STATE B', 'STATE C', 'STATE D', 'STATE E', 'STATE F'],
  },
  {
    script: 'apps/api/scripts/schema-enforcement-production-runner-proof.sh',
    // The only execution of the production `migrate.sh` over a NOT-ENFORCING database — refused
    // before Prisma, and refused again after a deploy that left the schema dirty.
    verdicts: [/PASSED — schema enforcement behaves correctly/u, /FAILED — see the lines marked FAILED/u],
    // A. fresh · B. clean · C/D. dirty with a migration pending · E. repaired · F. re-run ·
    // G. the post-deploy seam asked directly · H. preflight coupling · I. post-deploy coupling.
    states: ['A. FRESH', 'B. ALREADY-CLEAN', 'C. DIRTY', 'D. DIRTY', 'E. REPAIRED',
             'F. ALREADY-CHECKED', 'G. THE POST-DEPLOY SEAM', 'H. COUPLING', 'I. THE POST-DEPLOY SEAM'],
  },
  {
    script: 'apps/api/scripts/phase6-4c-iiir-production-runner-proof.sh',
    // The only execution of the production `migrate.sh` over a database that needs — or has
    // already had — the Phase 6 4c-iii-r one-shot `decisions.inbox` repair. The integration suite
    // exercises the STEP; only this exercises the RUNNER.
    verdicts: [/4c-iii-r production-runner proof: PASSED/u, /4c-iii-r production-runner proof: FAILED/u],
    // A. fresh/empty (a first deploy is not walled off) · A2. populated but never served (the
    // harness shape — no configuration needed, which is what keeps this step from coupling every
    // other proof) · B. in service + unconfigured (the vacuity refusal) · C/C2/C3. the three
    // identity refusals · D. the repair runs and is verified · E/E2. the marker skips, but never
    // excuses identity · F. a failed attempt writes no marker and is retried · G. coupling.
    states: ['A. FRESH/EMPTY', 'A2. POPULATED BUT NEVER SERVED', 'B. IN SERVICE + UNCONFIGURED',
             'C. WRONG DATABASE', 'C2.', 'C3.', 'D. CONFIGURED AND CORRECT', 'E. RE-RUN', 'E2.',
             'F. A FAILED ATTEMPT', 'F2. CONFIGURED + NEVER SERVED', 'F3. THE MARKER IS SEALED',
             'F4. A CLONE OF PRODUCTION', 'F5. A RESTORE INTO A SIBLING DATABASE',
             'F6. A PARTIAL IDENTITY CONFIGURATION', 'F7. AN UNSEALED MARKER',
             // F8 closes the inventory (Codex on `5f0d382`): it is the only real-`migrate.sh`
             // exercise of a LOST ledger row over a database that still has both the triggers and a
             // genuine marker, and without it here the proof could drop that state while this
             // required test stayed green — which is precisely what this test exists to prevent.
             'F8. THE COMPLETED SEAL MIGRATION RE-RUNS',
             // F9 is pinned by strings from its EXECUTION, not by its banner (Codex on `88ea82c`).
             // The state list is a substring search over the whole file, and `F9.` also appears in
             // the header comment — so a bare state name would keep this required test green while
             // the executable block was deleted, silently dropping the ONLY end-to-end proof that
             // the documented recovery escapes Prisma's P3009 failed-migration state. These two
             // strings exist only inside the block that runs it: the `say` heading, and the
             // assertion that the runner surfaces the resolve step the migration cannot.
             'say "F9. the adoption test ABORTS, and the documented recovery actually recovers"',
             "grep -q 'migrate resolve --rolled-back 20271125000000'",
             // F10 is the runner-level half of the drain declaration (Codex P1 on `88ea82c`):
             // the step's own probe proves the refusal, this proves the real `migrate.sh` refuses to
             // start on it. Pinned by execution strings for the same reason F9 is.
             'say "F10. the legacy-worker drain is not declared — must ABORT, even with a marker present"',
             'say "F10b. the drain is declared to the WRONG release — must ABORT rather than be interpreted"',
             'say "F11. the decisions.inbox writer fence is dropped — the deploy must ABORT"',
             'G. COUPLING'],
  },
];

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

for (const proof of PINNED_PROOFS) {
  const { script: SCRIPT } = proof;

  test(`${SCRIPT} is a step of the \`${HOST_JOB}\` job`, async () => {
    const jobs = parseJobs(await readFile(WORKFLOW, 'utf8'));
    const job = jobs.get(HOST_JOB);
    assert.ok(job, `ci.yml must define the \`${HOST_JOB}\` job`);
    assert.equal(stepsRunning(job, SCRIPT), 1,
      `exactly one step of \`${HOST_JOB}\` must run ${SCRIPT}`);
  });

  test(`the detection FAILS when the ${SCRIPT} step is removed — it is not merely running`, async () => {
    // A checker that silently found nothing would pass this file forever. So the same walk is run
    // over a fixture with the step deleted, and is required to come up empty.
    const yaml = await readFile(WORKFLOW, 'utf8');
    const withoutStep = yaml.split('\n').filter((line) => !line.includes(SCRIPT)).join('\n');
    assert.equal(stepsRunning(parseJobs(withoutStep).get(HOST_JOB), SCRIPT), 0,
      'the fixture must not still contain the step, or this test proves nothing');
  });

  test(`${SCRIPT} reports a verdict the step can fail on, and covers every state it claims`, async () => {
    const source = await readFile(new URL(`../${SCRIPT}`, import.meta.url), 'utf8');
    for (const verdict of proof.verdicts) assert.match(source, verdict);
    for (const state of proof.states) {
      assert.ok(source.includes(state), `${SCRIPT} must cover ${state}`);
    }
  });
}

test('the host job is required by the single required status', async () => {
  const jobs = parseJobs(await readFile(WORKFLOW, 'utf8'));
  const gate = jobs.get(GATE_JOB);
  assert.ok(gate, `ci.yml must define the \`${GATE_JOB}\` job`);
  assert.ok(parseNeeds(gate).includes(HOST_JOB),
    `\`${GATE_JOB}\` must need \`${HOST_JOB}\`, or the proofs run in a job nothing waits for`);
});

test('and THAT detection fails too when the job stops being required', async () => {
  const yaml = await readFile(WORKFLOW, 'utf8');
  const withoutNeed = yaml.split('\n')
    .filter((line, i, all) => !(line === `      - ${HOST_JOB}` && all.slice(0, i).some((l) => /^ {4}needs:$/u.test(l))))
    .join('\n');
  assert.ok(!parseNeeds(parseJobs(withoutNeed).get(GATE_JOB)).includes(HOST_JOB),
    'the needs fixture must really drop the job, or the assertion above proves nothing');
});
