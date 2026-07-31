// The ONE required status: turns every job's result into a single verdict.
//
// `JOB_RESULTS` is `toJSON(needs)` — an object keyed by job name whose values
// carry `.result`. The gate reduces that to pass/fail and prints the reason so
// a skipped suite is explained on the pull request rather than merely absent.
import { pathToFileURL } from 'node:url';

import { assessQualityGate } from './ci-quality-verdict.mjs';

export function run({
  raw = process.env.JOB_RESULTS,
  productsRerun = process.env.RUN_PRODUCTS !== 'false',
  log = console.log,
} = {}) {
  let results;
  try {
    const parsed = JSON.parse(raw ?? '');
    results = Object.fromEntries(
      Object.entries(parsed).map(([job, value]) => [job, value?.result]),
    );
  } catch (error) {
    // Unparseable job results are not "nothing failed" — the gate cannot see
    // the run at all, which is the one state it must never treat as success.
    log(`quality-gate: FAILED — job results unreadable (${error.message})`);
    return { passed: false };
  }

  const verdict = assessQualityGate(results, { productsRerun });
  log(`quality-gate: ${verdict.passed ? 'PASSED' : 'FAILED'} — ${verdict.reason}`);
  return verdict;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  if (!run().passed) process.exit(1);
}
