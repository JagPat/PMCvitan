// The runner step of .github/workflows/drain-evidence.yml: runs `rollout:drain-evidence` against
// production for the directive's minimum release, stamps the JSON it prints with THIS run's identity, and
// writes the file the workflow uploads. The clearance gate (autonomous-drain-clearance.mjs) later fetches
// that artifact from the run the stamp names and admits a committed record only when the two are
// byte-identical, so the stamp is checked, not trusted.
//
// Reads and writes nothing else: the credentials stay in the environment and are never printed.
import { spawnSync } from 'node:child_process';
import { appendFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import {
  DRAIN_DIRECTIVE,
  DRAIN_EVIDENCE_ARTIFACT_FILE,
  DRAIN_EVIDENCE_MARKER,
  DRAIN_EVIDENCE_WORKFLOW,
  DRAIN_MINIMUM_RELEASE,
  drainEvidenceArtifactName,
} from './autonomous-drain-clearance.mjs';

const REQUIRED_ENV = ['DATABASE_URL', 'COOLIFY_TOKEN', 'COOLIFY_API_URL', 'COOLIFY_APP_UUID'];

/** The CLI's JSON with this run's identity added under `provenance`. Pure; throws on a malformed record. */
export function stampProvenance(stdout, env) {
  let evidence;
  try {
    evidence = JSON.parse(stdout);
  } catch (error) {
    throw new Error(`rollout:drain-evidence printed no JSON record (${error.message})`);
  }
  if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)
    || evidence.marker !== DRAIN_EVIDENCE_MARKER || evidence.directive !== DRAIN_DIRECTIVE) {
    throw new Error('rollout:drain-evidence printed something other than a DRAIN-EVIDENCE record for this directive');
  }
  const runId = Number(env.GITHUB_RUN_ID);
  const runAttempt = Number(env.GITHUB_RUN_ATTEMPT);
  if (!Number.isInteger(runId) || runId < 1 || !Number.isInteger(runAttempt) || runAttempt < 1) {
    throw new Error('GITHUB_RUN_ID and GITHUB_RUN_ATTEMPT must name this run');
  }
  if (!/^[0-9a-f]{40}$/u.test(String(env.GITHUB_SHA ?? ''))) throw new Error('GITHUB_SHA must name this run\'s commit');
  return {
    ...evidence,
    provenance: {
      workflow: DRAIN_EVIDENCE_WORKFLOW,
      repository: env.GITHUB_REPOSITORY,
      runId,
      runAttempt,
      workflowSha: env.GITHUB_SHA,
    },
  };
}

export function main(env = process.env, run = spawnSync) {
  if (env.GITHUB_REF !== 'refs/heads/main') throw new Error(`refusing to run from ${env.GITHUB_REF}: the trusted producer runs on main only`);
  const missing = REQUIRED_ENV.filter((name) => !String(env[name] ?? '').trim());
  if (missing.length) throw new Error(`the drain-evidence environment is not set up: missing ${missing.join(', ')}`);

  const result = run('pnpm', [
    '--filter', 'api', 'exec', 'tsx', 'src/platform/rollout/drain-evidence.cli.ts',
    '--minimum-release', DRAIN_MINIMUM_RELEASE,
    '--repo', env.GITHUB_WORKSPACE || process.cwd(),
    '--out', `${env.GITHUB_WORKSPACE || process.cwd()}/drain-evidence.md`,
  ], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], maxBuffer: 16 * 1024 * 1024 });
  if (result.error) throw result.error;
  // Exit 0 is `drained`, 1 a judged not-drained or unclassified verdict (still a record worth keeping);
  // anything else is a usage or read failure with no record.
  if (result.status !== 0 && result.status !== 1) throw new Error(`rollout:drain-evidence failed (exit ${result.status}) without a verdict`);

  const stamped = stampProvenance(result.stdout, env);
  writeFileSync(DRAIN_EVIDENCE_ARTIFACT_FILE, `${JSON.stringify(stamped, null, 2)}\n`);
  const name = drainEvidenceArtifactName(stamped.provenance.runId, stamped.provenance.runAttempt);
  if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, `artifact_name=${name}\nverdict=${stamped.verdict}\n`);
  if (env.GITHUB_STEP_SUMMARY) {
    appendFileSync(env.GITHUB_STEP_SUMMARY, [
      `## Drain evidence: \`${stamped.verdict}\``, '',
      `Run ${stamped.provenance.runId} attempt ${stamped.provenance.runAttempt} on \`${stamped.provenance.workflowSha}\`, recorded at ${stamped.recordedAt}.`, '',
      stamped.verdict === 'drained'
        ? `Download the artifact \`${name}\` and commit its one file, unchanged, as \`docs/rollout/phase-6-4d-drain-evidence.json\` in the head commit that sets \`blocking_directive: none\`.`
        : 'This record cannot clear the directive. Findings:',
      '',
      ...stamped.findings.map((finding) => `- ${finding}`),
      '',
    ].join('\n'));
  }
  console.log(`drain-evidence: verdict ${stamped.verdict}; artifact ${name}`);
  return stamped;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    main();
  } catch (error) {
    console.error(`::error title=Drain evidence::${error.message}`);
    process.exitCode = 1;
  }
}
