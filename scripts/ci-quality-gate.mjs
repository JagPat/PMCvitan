// The ONE required status: turns every job's result into a single verdict.
//
// `JOB_RESULTS` is `toJSON(needs)` — an object keyed by job name whose values
// carry `.result`. The gate reduces that to pass/fail and prints the reason so
// a skipped suite is explained on the pull request rather than merely absent.
import { pathToFileURL } from 'node:url';

import { assessQualityGate } from './ci-risk-classification.mjs';

export function run({
  raw = process.env.JOB_RESULTS,
  classifyReason = process.env.CLASSIFY_REASON,
  runProducts = process.env.RUN_PRODUCTS,
  priorEvidence = process.env.PRIOR_EVIDENCE,
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

  // `battery-plan` said this head is already covered, so every product job and
  // every twin skipped. That decision counts a FAILED earlier run as coverage,
  // so the gate must check the preserved evidence rather than read all-skips as
  // success — otherwise a title/body edit turns a red head green with no new
  // commit. Unparseable or absent evidence is not a pass.
  const productsSkippedAsCovered = runProducts === 'false';
  let evidence = null;
  if (productsSkippedAsCovered) {
    try {
      evidence = JSON.parse(priorEvidence ?? '');
    } catch {
      evidence = null;
    }
  }

  const verdict = assessQualityGate(results, { productsSkippedAsCovered, priorEvidence: evidence });
  if (classifyReason) log(`quality-gate: classification — ${classifyReason}`);
  log(`quality-gate: ${verdict.passed ? 'PASSED' : 'FAILED'} — ${verdict.reason}`);
  return verdict;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  if (!run().passed) process.exit(1);
}
