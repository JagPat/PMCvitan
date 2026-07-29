// Shared rules for reading a head's check-run history.
//
// The battery plan and the review gate both answer "do this head's product jobs
// cover the current attempt?" — and rounds 4-9 of the PR #249 review kept
// finding the same defect implemented differently on the two sides. These rules
// live here once so the two cannot drift apart again.

export const PRODUCT_CHECKS = ['web', 'api', 'e2e', 'api-e2e', 'upgrade-proof'];

// The dependency-free jobs the product jobs are gated on via `needs`.
export const GATE_CHECKS = ['review-scope', 'battery-plan'];

export function isSkipped(run) {
  return run?.status === 'completed' && run?.conclusion === 'skipped';
}

// Recency key, newest-first. GitHub's own `latest` filter is defined by
// completed_at, so that is the primary key. A run that has not completed is the
// most recent activity for its name and sorts ahead of every completed one.
export function recency(run) {
  if (run?.status !== 'completed') return '￿';
  return (typeof run?.completed_at === 'string' && run.completed_at)
    || (typeof run?.started_at === 'string' && run.started_at)
    || '';
}

export function newestFirst(a, b) {
  const aKey = recency(a);
  const bKey = recency(b);
  if (aKey !== bKey) return aKey > bKey ? -1 : 1;
  return (Number(b?.id) || 0) - (Number(a?.id) || 0);
}

// Which CI attempt produced this check run. `check_suite.id` is the API's own
// grouping of one workflow run's checks; the Actions URLs
// (.../actions/runs/<runId>/job/<jobId>) are the fallback when it is absent.
export function attemptOf(run) {
  const suite = run?.check_suite?.id;
  if (suite !== undefined && suite !== null) return `suite:${suite}`;
  for (const url of [run?.html_url, run?.details_url]) {
    const match = /\/actions\/runs\/(\d+)\//u.exec(typeof url === 'string' ? url : '');
    if (match) return `run:${match[1]}`;
  }
  return null;
}

// The completion time that product evidence must be at least as recent as.
//
// Product jobs are created AFTER the gates that launch them, so within one
// attempt a product always completes later than its gates. That makes a gate
// completion a watermark — but ONLY for an attempt that produced no product
// runs at all, which is the retarget window: the new base's gates pass, its
// product jobs do not exist yet, and the old base's successes would otherwise
// look like coverage for a merge result they never tested.
//
// An attempt whose products are SKIPPED is the opposite case: the plan
// deliberately decided the head was already covered, and its gates must not
// invalidate the very evidence it chose to keep. Treating those gates as a
// watermark made every second metadata-only edit relaunch the battery, which is
// exactly the duplication this whole design exists to prevent.
//
// A gate run we cannot attribute to an attempt is ignored rather than trusted:
// we cannot tell whether it produced products, and guessing "it did not" would
// resurrect that duplication. Unattributable evidence is handled where it can be
// judged soundly — the gate's skip-attribution rule fails closed on it.
export function gateWatermark(checkRuns) {
  const runs = Array.isArray(checkRuns) ? checkRuns : [];
  const attemptsWithProducts = new Set(
    runs
      .filter((run) => PRODUCT_CHECKS.includes(run?.name))
      .map((run) => attemptOf(run))
      .filter(Boolean),
  );

  return runs
    .filter((run) => GATE_CHECKS.includes(run?.name) && run?.status === 'completed')
    .filter((run) => {
      const attempt = attemptOf(run);
      return Boolean(attempt) && !attemptsWithProducts.has(attempt);
    })
    .map((run) => recency(run))
    .reduce((newest, stamp) => (stamp > newest ? stamp : newest), '');
}
