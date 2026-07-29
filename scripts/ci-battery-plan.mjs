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

function isSkipped(run) {
  return run?.status === 'completed' && run?.conclusion === 'skipped';
}

// Recency key, newest-first. GitHub's own `latest` filter is defined by
// completed_at, so that is the primary key (started_at and id only break ties
// or fill gaps). A run that has not completed is the most recent activity for
// its name and sorts ahead of every completed one.
function recency(run) {
  if (run?.status !== 'completed') return '￿';
  return (typeof run?.completed_at === 'string' && run.completed_at)
    || (typeof run?.started_at === 'string' && run.started_at)
    || '';
}

function newestFirst(a, b) {
  const aKey = recency(a);
  const bKey = recency(b);
  if (aKey !== bKey) return aKey > bKey ? -1 : 1;
  return (Number(b?.id) || 0) - (Number(a?.id) || 0);
}

// Coverage is decided by the NEWEST non-skipped run of that name, never by
// "some run once succeeded": a newer CANCELLED run means the current attempt
// did not finish, and the gate resolves that same cancelled run as a failure —
// so treating an older success as coverage would deadlock the head (gate red,
// plan refusing to re-run). Skipped runs are ignored entirely (gated off by
// `needs`/`if`), an unfinished run IS coverage in progress (an earlier battery
// for this SHA is mid-flight), and a completed FAILURE is real coverage: red
// products are fixed by a new SHA with its own battery, not by a metadata edit.
function coveredBy(checkRuns, name) {
  const decider = checkRuns
    .filter((run) => run?.name === name && !isSkipped(run))
    .sort(newestFirst)[0];
  if (!decider || typeof decider.status !== 'string') return false;
  if (decider.status !== 'completed') return true;
  return decider.conclusion !== 'cancelled';
}

// The newest COMPLETED run of a check.
function newestCompleted(checkRuns, name) {
  return checkRuns
    .filter((run) => run?.name === name && run.status === 'completed')
    .sort(newestFirst)[0] ?? null;
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
    if (!coveredBy(checkRuns, name)) {
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
      // filter=all (paginated). The default is filter=latest, which returns
      // only the newest run per name — after one metadata edit the products
      // are recorded as newer SKIPPED runs, so a latest-only read would see no
      // coverage and launch a duplicate battery, defeating this job's purpose.
      const runs = [];
      let page = 1;
      while (true) {
        const response = await fetchImpl(
          `https://api.github.com/repos/${repository}/commits/${headSha}`
            + `/check-runs?filter=all&per_page=100&page=${page}`,
          {
            headers: {
              authorization: `Bearer ${token}`,
              accept: 'application/vnd.github+json',
              'user-agent': 'pmcvitan-ci-battery-plan',
            },
          },
        );
        if (!response.ok) break;
        const batch = (await response.json()).check_runs ?? [];
        runs.push(...batch);
        checkRuns = runs;
        if (batch.length < 100) break;
        page += 1;
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
