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

/**
 * The first JSON value in the CLI's stdout. `pnpm --filter api exec` appends its failure banner to
 * stdout after the record when the command exits non-zero, and `JSON.parse` then rejects the whole
 * buffer — which is how a judged `unclassified` or `not-drained` record was discarded. The record is
 * the first value and it starts the output; anything after it is the banner, not a second record.
 * Leading non-whitespace is refused: a banner before the record would mean this is not the CLI's output.
 */
export function drainRecordFromStdout(stdout) {
  const text = String(stdout ?? '');
  const start = text.search(/\S/u);
  if (start < 0 || text[start] !== '{') {
    throw new Error('rollout:drain-evidence printed no JSON record (stdout did not start with the record)');
  }
  const end = endOfFirstJsonValue(text, start);
  if (end === null) throw new Error('rollout:drain-evidence printed no JSON record (truncated JSON)');
  try {
    return JSON.parse(text.slice(start, end));
  } catch (error) {
    throw new Error(`rollout:drain-evidence printed no JSON record (${error.message})`);
  }
}

function endOfFirstJsonValue(text, start) {
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < text.length; i++) {
    const char = text[i];
    if (inString) {
      if (escape) escape = false;
      else if (char === '\\') escape = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === '{' || char === '[') depth += 1;
    else if (char === '}' || char === ']') {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
  }
  return null;
}

/** The CLI's JSON with this run's identity added under `provenance`. Pure; throws on a malformed record. */
export function stampProvenance(stdout, env) {
  const evidence = drainRecordFromStdout(stdout);
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
  const clearingParent = String(env.CLEARING_PARENT ?? '').trim().toLowerCase();
  if (!/^[0-9a-f]{40}$/u.test(clearingParent)) {
    throw new Error('the clearing_parent input must be the full 40-character SHA of the clearing PR\'s current head');
  }
  return {
    ...evidence,
    provenance: {
      workflow: DRAIN_EVIDENCE_WORKFLOW,
      repository: env.GITHUB_REPOSITORY,
      runId,
      runAttempt,
      workflowSha: env.GITHUB_SHA,
      // the commit the record will be committed directly on top of (#686 finding 4164136422)
      clearingParent,
    },
  };
}

export function main(env = process.env, run = spawnSync) {
  if (env.GITHUB_REF !== 'refs/heads/main') throw new Error(`refusing to run from ${env.GITHUB_REF}: the trusted producer runs on main only`);
  const missing = REQUIRED_ENV.filter((name) => !String(env[name] ?? '').trim());
  if (missing.length) throw new Error(`the drain-evidence environment is not set up: missing ${missing.join(', ')}`);
  if (!/^[0-9a-f]{40}$/u.test(String(env.CLEARING_PARENT ?? '').trim().toLowerCase())) {
    throw new Error('the clearing_parent input must be the full 40-character SHA of the clearing PR\'s current head');
  }

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
        ? `Download the artifact \`${name}\` and commit its one file, unchanged, as \`docs/rollout/phase-6-4d-drain-evidence.json\` in ONE commit directly on top of \`${stamped.provenance.clearingParent}\`, the commit that sets \`blocking_directive: none\`. Any other commit in between means running this workflow again.`
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
