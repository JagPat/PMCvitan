import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  DRAIN_DIRECTIVE,
  DRAIN_EVIDENCE_ARTIFACT_FILE,
  DRAIN_EVIDENCE_WORKFLOW,
  DRAIN_MINIMUM_RELEASE,
  drainEvidenceArtifactName,
} from './autonomous-drain-clearance.mjs';
import { drainRecordFromStdout, main, stampProvenance } from './drain-evidence-workflow.mjs';

// The trusted producer of the drain record (the owner's choice of 2026-10-02; #686 finding 4163934186).
// The gate trusts a record only when it is byte-identical to this workflow's artifact from a green run on
// main, so the workflow itself is pinned here: dispatch-only, main-only, read-only, its credentials only in
// the `drain-evidence` environment, every action pinned to a commit.

const workflowUrl = new URL(`../${DRAIN_EVIDENCE_WORKFLOW}`, import.meta.url);
const SHA = 'c3'.repeat(20);
const ENV = (over = {}) => ({
  GITHUB_REF: 'refs/heads/main', GITHUB_RUN_ID: '4242', GITHUB_RUN_ATTEMPT: '1', GITHUB_SHA: SHA, GITHUB_REPOSITORY: 'JagPat/PMCvitan',
  DATABASE_URL: 'postgres://read-only@db/prod', COOLIFY_TOKEN: 'token', COOLIFY_API_URL: 'https://coolify.example/api/v1', COOLIFY_APP_UUID: 'app',
  CLEARING_PARENT: 'b2'.repeat(20), ...over,
});
const CLI_JSON = (over = {}) => JSON.stringify({
  marker: 'DRAIN-EVIDENCE', directive: DRAIN_DIRECTIVE, minimumRelease: DRAIN_MINIMUM_RELEASE, verdict: 'drained', findings: [], recordedAt: '2026-10-02T09:00:00.000Z', ...over,
}, null, 2);

test('the workflow is the trusted producer: dispatch-only, main-only, read-only, environment-held credentials', async () => {
  const workflow = await readFile(workflowUrl, 'utf8');
  const on = /\non:\n([\s\S]*?)\n\S/u.exec(`\n${workflow}`)[1];
  assert.match(on, /^ {2}workflow_dispatch:\n {4}inputs:\n {6}clearing_parent:\n/mu, 'one input: the commit the record is observed for');
  assert.match(on, /required: true\n {8}type: string/u);
  // the input reaches the runner through the environment, never interpolated into a script
  assert.match(workflow, /\n {10}CLEARING_PARENT: \$\{\{ inputs\.clearing_parent \}\}\n {8}run: node scripts\/drain-evidence-workflow\.mjs\n/u);
  assert.equal(workflow.match(/inputs\.clearing_parent/gu).length, 1);
  assert.doesNotMatch(on, /pull_request|push:|schedule|workflow_run/u, 'nothing but a dispatch starts it');
  assert.match(workflow, /\npermissions: \{\}\n/u, 'no default permissions');
  assert.match(workflow, /\n {4}if: github\.ref == 'refs\/heads\/main'\n/u, 'a dispatch from any other ref is refused');
  assert.match(workflow, /\n {4}environment: drain-evidence\n/u, 'the credentials live in the drain-evidence environment');
  assert.match(workflow, /\n {4}permissions:\n {6}contents: read\n {4}steps:/u, 'the job reads its checkout and nothing else');
  assert.match(workflow, /ref: \$\{\{ github\.workflow_sha \}\}/u, 'it runs this workflow\'s own commit');
  assert.match(workflow, /persist-credentials: false/u);
  assert.match(workflow, /fetch-depth: 0/u, 'release ancestry needs the history');
  // every secret it reads is one of the two read-only credentials, and only the judging step sees them
  assert.deepEqual([...workflow.matchAll(/secrets\.([A-Z_]+)/gu)].map((m) => m[1]).sort(), ['DRAIN_COOLIFY_TOKEN', 'DRAIN_DATABASE_URL']);
  assert.equal(workflow.match(/secrets\./gu).length, 2);
  // every action is pinned to a commit
  for (const [, ref] of workflow.matchAll(/uses: ([^\s]+)/gu)) assert.match(ref, /@[0-9a-f]{40}$/u, ref);
  // the artifact is the file the runner writes, under the name the gate looks up
  assert.match(workflow, new RegExp(`path: ${DRAIN_EVIDENCE_ARTIFACT_FILE.replaceAll('.', '\\.')}\\n`, 'u'));
  assert.match(workflow, /name: \$\{\{ steps\.judge\.outputs\.artifact_name \}\}/u);
  // a not-drained run fails, so only a drained run is green
  assert.match(workflow, /if: steps\.judge\.outputs\.verdict != 'drained'\n[\s\S]*?exit 1/u);
  // it posts, pushes and merges nothing
  assert.doesNotMatch(workflow, /GITHUB_TOKEN|gh pr|git push|contents: write|pull-requests: write|issues: write|statuses: write/u);
});

test('the runner stamps the CLI\'s record with this run\'s identity, and refuses anything else', () => {
  const stamped = stampProvenance(CLI_JSON(), ENV());
  assert.deepEqual(stamped.provenance, { workflow: DRAIN_EVIDENCE_WORKFLOW, repository: 'JagPat/PMCvitan', runId: 4242, runAttempt: 1, workflowSha: SHA, clearingParent: 'b2'.repeat(20) });
  assert.equal(stampProvenance(CLI_JSON(), ENV({ CLEARING_PARENT: ` ${'B2'.repeat(20)} ` })).provenance.clearingParent, 'b2'.repeat(20));
  assert.throws(() => stampProvenance(CLI_JSON(), ENV({ CLEARING_PARENT: 'b2b2b2b' })), /full 40-character SHA/u);
  assert.throws(() => stampProvenance(CLI_JSON(), ENV({ CLEARING_PARENT: '' })), /full 40-character SHA/u);
  assert.equal(stamped.verdict, 'drained');
  assert.equal(drainEvidenceArtifactName(4242, 1), 'phase-6-4d-drain-evidence-4242-1');
  assert.throws(() => stampProvenance('usage: …', ENV()), /printed no JSON record/u);
  // pnpm writes its failure banner to stdout after the record when the CLI exits non-zero. The record is
  // still the first JSON value, including when a finding itself contains a brace.
  const banner = '\n ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL  Command failed with exit code 1: tsx src/platform/rollout/drain-evidence.cli.ts\n';
  const noisy = CLI_JSON({ verdict: 'unclassified', findings: ['image commit "HEAD" cannot be placed (brace } in the finding)'] }) + banner;
  assert.equal(stampProvenance(noisy, ENV()).verdict, 'unclassified');
  assert.equal(drainRecordFromStdout(noisy).findings[0], 'image commit "HEAD" cannot be placed (brace } in the finding)');
  assert.throws(() => stampProvenance(`${banner}${CLI_JSON()}`, ENV()), /did not start with the record/u);
  assert.throws(() => stampProvenance('{', ENV()), /truncated JSON/u);
  assert.throws(() => stampProvenance(CLI_JSON({ marker: 'X' }), ENV()), /other than a DRAIN-EVIDENCE record/u);
  assert.throws(() => stampProvenance(CLI_JSON({ directive: 'another' }), ENV()), /other than a DRAIN-EVIDENCE record/u);
  assert.throws(() => stampProvenance(CLI_JSON(), ENV({ GITHUB_RUN_ID: '' })), /must name this run/u);
  assert.throws(() => stampProvenance(CLI_JSON(), ENV({ GITHUB_SHA: 'main' })), /this run's commit/u);
});

test('the runner runs only on main, only with its environment, and writes the stamped file and outputs', async () => {
  assert.throws(() => main(ENV({ GITHUB_REF: 'refs/heads/feature' }), () => { throw new Error('must not run'); }), /runs on main only/u);
  assert.throws(() => main(ENV({ DATABASE_URL: '', COOLIFY_TOKEN: ' ' }), () => { throw new Error('must not run'); }), /missing DATABASE_URL, COOLIFY_TOKEN/u);
  assert.throws(() => main(ENV({ CLEARING_PARENT: 'main' }), () => { throw new Error('must not run'); }), /full 40-character SHA/u);

  const directory = await mkdtemp(join(tmpdir(), 'drain-evidence-'));
  const previous = process.cwd();
  process.chdir(directory);
  try {
    const calls = [];
    const env = ENV({ GITHUB_WORKSPACE: directory, GITHUB_OUTPUT: join(directory, 'out'), GITHUB_STEP_SUMMARY: join(directory, 'summary') });
    const stamped = main(env, (command, args, options) => {
      calls.push([command, args, options.stdio]);
      return { status: 0, stdout: CLI_JSON() };
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0][0], 'pnpm');
    assert.deepEqual(calls[0][1].slice(0, 7), ['--filter', 'api', 'exec', 'tsx', 'src/platform/rollout/drain-evidence.cli.ts', '--minimum-release', DRAIN_MINIMUM_RELEASE]);
    assert.deepEqual(calls[0][2], ['ignore', 'pipe', 'inherit'], 'stdout is the record; stderr passes through');
    const written = await readFile(join(directory, DRAIN_EVIDENCE_ARTIFACT_FILE), 'utf8');
    assert.equal(written, `${JSON.stringify(stamped, null, 2)}\n`);
    assert.equal(await readFile(join(directory, 'out'), 'utf8'), 'artifact_name=phase-6-4d-drain-evidence-4242-1\nverdict=drained\n');
    assert.match(await readFile(join(directory, 'summary'), 'utf8'), /commit its one file, unchanged, as `docs\/rollout\/phase-6-4d-drain-evidence\.json` in ONE commit directly on top of `b2b2/u);
    // a judged not-drained run still writes its record (exit 1), so the operator sees why
    const notDrained = main(env, () => ({ status: 1, stdout: CLI_JSON({ verdict: 'not-drained', findings: ['live lease i-0 is below the minimum'] }) }));
    assert.equal(notDrained.verdict, 'not-drained');
    // the same exit, with pnpm's banner after the JSON, still writes the record the job uploads
    const noisyVerdict = main(env, () => ({ status: 1, stdout: `${CLI_JSON({ verdict: 'unclassified', findings: ['image commit "HEAD" cannot be placed'] })}\n ELIFECYCLE  Command failed with exit code 1.\n` }));
    assert.equal(noisyVerdict.verdict, 'unclassified');
    assert.equal(await readFile(join(directory, DRAIN_EVIDENCE_ARTIFACT_FILE), 'utf8'), `${JSON.stringify(noisyVerdict, null, 2)}\n`);
    assert.match(await readFile(join(directory, 'out'), 'utf8'), /verdict=unclassified\n/u);
    // a usage or read failure has no record
    assert.throws(() => main(env, () => ({ status: 2, stdout: '' })), /failed \(exit 2\) without a verdict/u);
  } finally {
    process.chdir(previous);
    await rm(directory, { recursive: true, force: true });
  }
});
