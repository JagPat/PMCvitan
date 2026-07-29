// Decides whether a CI event needs the five-job product battery.
//
// Code events (opened/synchronize/reopened) always do. An `edited` event is
// metadata-only EXCEPT in two cases the plan must catch:
//   - a base retarget (`changes.base` in the payload) changes the merge result
//     the product jobs test, so the battery must re-run;
//   - the head SHA may have NO real product runs yet (a large PR whose first CI
//     run failed `review-scope` left the product jobs skipped) — the body edit
//     that fixes the scope evidence is exactly the moment the battery must
//     finally launch, or the autonomous loop is stuck on that SHA.
// Any uncertainty (missing payload, unreachable check history) fails toward
// running the battery — never toward skipping it.
import { readFile, appendFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

export const PRODUCT_CHECKS = ['web', 'api', 'e2e', 'api-e2e', 'upgrade-proof'];

// A check run counts as coverage when it is actually executing or has executed:
// still queued/in_progress is coverage IN PROGRESS (an earlier battery for this
// same SHA is mid-flight — starting a second one duplicates the work and lets a
// later duplicate failure supersede the first run's success), and a completed
// run counts unless it was skipped (gated off by `needs`/`if`) or cancelled
// (never finished). A completed FAILURE is real coverage: red products are
// fixed by a new SHA with its own battery, never by a metadata edit.
function coversHead(run) {
  if (!run || typeof run.status !== 'string') return false;
  if (run.status !== 'completed') return run.conclusion !== 'skipped';
  return typeof run.conclusion === 'string'
    && run.conclusion !== 'skipped'
    && run.conclusion !== 'cancelled';
}

// The newest COMPLETED run of a check, by start time (id breaks ties).
function newestCompleted(checkRuns, name) {
  return checkRuns
    .filter((run) => run?.name === name && run.status === 'completed')
    .sort((a, b) => {
      const aStarted = typeof a.started_at === 'string' ? a.started_at : '';
      const bStarted = typeof b.started_at === 'string' ? b.started_at : '';
      if (aStarted !== bStarted) return aStarted > bStarted ? -1 : 1;
      return (Number(b.id) || 0) - (Number(a.id) || 0);
    })[0] ?? null;
}

export function assessBatteryPlan({ action, baseChanged, checkRuns }) {
  if (action !== 'edited') {
    return { runProducts: true, reason: `code event (${action ?? 'no pull_request action'})` };
  }
  if (baseChanged) {
    return { runProducts: true, reason: 'base retarget changes the merge result under test' };
  }
  if (!Array.isArray(checkRuns)) {
    return { runProducts: true, reason: 'check history unavailable; failing toward a full run' };
  }

  // A failed scope check skips the product jobs of that same attempt, so any
  // product coverage on this head predates it. The retarget case is exactly
  // this shape: retarget to a new base → review-scope fails there → products
  // skipped → a body edit that fixes the scope evidence must run the battery
  // against the NEW base rather than accept the pre-retarget runs. The same
  // rule unsticks a large PR whose first attempt failed review-scope. The
  // scope run for THIS event is still queued at plan time, so this reads the
  // previous attempt's verdict, which is the one that gated those products.
  const scope = newestCompleted(checkRuns, 'review-scope');
  if (scope && scope.conclusion !== 'success') {
    return {
      runProducts: true,
      reason: 'the last completed review-scope run did not pass, so any product '
        + 'coverage on this head predates the current scope evaluation',
    };
  }

  for (const name of PRODUCT_CHECKS) {
    if (!checkRuns.some((run) => run?.name === name && coversHead(run))) {
      return {
        runProducts: true,
        reason: `product check ${name} has no run covering this head`,
      };
    }
  }
  return {
    runProducts: false,
    reason: 'metadata-only edit; every product check already covers this head',
  };
}

export async function run({
  eventPath = process.env.GITHUB_EVENT_PATH,
  repository = process.env.GITHUB_REPOSITORY,
  token = process.env.GH_TOKEN,
  outputPath = process.env.GITHUB_OUTPUT,
  fetchImpl = fetch,
} = {}) {
  let plan;
  try {
    if (!eventPath) throw new Error('GITHUB_EVENT_PATH is required');
    const event = JSON.parse(await readFile(eventPath, 'utf8'));
    const action = event.action;
    const baseChanged = Boolean(event.changes?.base);
    const headSha = event.pull_request?.head?.sha;

    let checkRuns;
    if (action === 'edited' && !baseChanged && headSha && repository && token) {
      const response = await fetchImpl(
        `https://api.github.com/repos/${repository}/commits/${headSha}/check-runs?per_page=100`,
        {
          headers: {
            authorization: `Bearer ${token}`,
            accept: 'application/vnd.github+json',
            'user-agent': 'pmcvitan-ci-battery-plan',
          },
        },
      );
      if (response.ok) {
        checkRuns = (await response.json()).check_runs;
      }
    }
    plan = assessBatteryPlan({ action, baseChanged, checkRuns });
  } catch (error) {
    plan = {
      runProducts: true,
      reason: `battery plan errored (${error.message}); failing toward a full run`,
    };
  }

  console.log(`battery-plan: run_products=${plan.runProducts}; ${plan.reason}`);
  if (outputPath) {
    await appendFile(outputPath, `run_products=${plan.runProducts}\n`);
  }
  return plan;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  await run();
}
