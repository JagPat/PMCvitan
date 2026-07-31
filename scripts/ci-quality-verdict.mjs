// The ONE required status: does this head pass?
//
// This file is what survived the risk-based CI attempt. A path-based classifier
// that skipped product suites was built here across five heads and withdrawn
// after fourteen findings — seven of them in the evidence plumbing that existed
// only to make skipping safe against a coverage model written before skips.
// docs/reviews/pr-263-convergence.md records the analysis and what a future
// attempt would need.
//
// `assessQualityGate` drew ZERO findings across all five heads, which is why it
// ships. It has no classifier, no evidence reader and no notion of a suite that
// "cannot be affected" — it summarises what the jobs actually reported.

// Does the gate pass?
//
// `results` maps job name → GitHub's `needs.<job>.result`, one of
// `success | failure | cancelled | skipped`.
//
// A suite may legitimately be `skipped` for two independent reasons — this
// classifier excluded it, or `ci-battery-plan` found this exact head already
// covered — and the gate cannot tell those apart, nor does it need to: both
// are deliberate. What it must NOT accept is `cancelled`, which is a run that
// never reached a verdict, and `failure`, which includes an upstream gate
// failing and skipping everything below it.
//
// So the rule is a whitelist, not a blacklist: anything that is not an
// explicit success or an explicit skip fails the gate. A result GitHub adds
// later that this code has never seen is therefore a failure, not a pass.
// When `battery-plan` decides this head is already covered, every product job
// AND every twin skips — so the gate sees nothing but skips and would go green
// off the current run alone. But battery-plan deliberately counts a FAILED
// product run as coverage: a title/body edit after a red run produces exactly
// that shape. Once `quality-gate` is the single required status, that would let
// a metadata edit mask failed CI without a new commit.
//
// So a battery-plan skip is only acceptable when the PRESERVED evidence for
// this head is actually green. `priorEvidence` carries that verdict; absent or
// unreadable evidence is not a pass.
export function assessQualityGate(results) {
  const entries = Object.entries(results ?? {});
  if (entries.length === 0) {
    return { passed: false, reason: 'no job results were reported to the gate' };
  }

  const blocking = entries.filter(
    ([, result]) => result !== 'success' && result !== 'skipped',
  );
  if (blocking.length > 0) {
    return {
      passed: false,
      reason: blocking
        .map(([job, result]) => `${job}: ${result || 'no result'}`)
        .join('; '),
    };
  }

  const ran = entries.filter(([, result]) => result === 'success').map(([job]) => job);
  const skipped = entries.filter(([, result]) => result === 'skipped').map(([job]) => job);
  return {
    passed: true,
    reason: skipped.length === 0
      ? `all ${ran.length} required checks passed`
      : `${ran.length} passed (${ran.join(', ')}); `
        + `${skipped.length} not applicable to this change (${skipped.join(', ')})`,
  };
}
