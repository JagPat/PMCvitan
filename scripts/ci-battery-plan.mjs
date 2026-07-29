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

import {
  GATE_CHECKS,
  PRODUCT_CHECKS,
  attemptOf,
  gateWatermark,
  isSkipped,
  newestFirst,
  recency,
} from './check-run-coverage.mjs';

export { PRODUCT_CHECKS };

// A check run's URLs carry the workflow run that produced it:
// .../actions/runs/<runId>/job/<jobId>
export function belongsToRun(checkRun, runId) {
  if (!runId) return false;
  const url = checkRun?.html_url ?? checkRun?.details_url;
  const match = /\/actions\/runs\/(\d+)\//u.exec(typeof url === 'string' ? url : '');
  return Boolean(match) && match[1] === String(runId);
}

// Coverage is decided by the NEWEST non-skipped run of that name, never by
// "some run once succeeded": a newer CANCELLED run means the current attempt
// did not finish, and the gate resolves that same cancelled run as a failure —
// so treating an older success as coverage would deadlock the head (gate red,
// plan refusing to re-run). Skipped runs are ignored entirely (gated off by
// `needs`/`if`), an unfinished run IS coverage in progress (an earlier battery
// for this SHA is mid-flight), and a completed FAILURE is real coverage: red
// products are fixed by a new SHA with its own battery, not by a metadata edit.
function coveredBy(checkRuns, name, notBefore = '') {
  const decider = checkRuns
    .filter((run) => run?.name === name && !isSkipped(run))
    .sort(newestFirst)[0];
  if (!decider || typeof decider.status !== 'string') return false;
  if (decider.status !== 'completed') return true;
  if (decider.conclusion === 'cancelled') return false;
  // Product jobs are created AFTER their gates, so within one attempt a product
  // always completes later than the gates that launched it. Coverage older than
  // the newest completed gate therefore belongs to an EARLIER attempt — the
  // retarget window this rule closes: a new base's gates both pass, its product
  // runs do not exist yet, and the old base's successes would otherwise look
  // like coverage for a merge result they never tested.
  return recency(decider) >= notBefore;
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
  // A scope verdict from ANOTHER attempt is still running (a retarget's scope
  // that has not finished, say). Its product jobs are gated on it and have not
  // been created yet, so every product run visible here predates that attempt
  // — and if it fails, those products get skipped and the only evidence left
  // is from the OLD base. Waiting for a verdict we cannot see means guessing;
  // run the battery instead. The current event's own scope run is excluded by
  // the caller, so this never fires merely because this edit's scope is queued.
  if (checkRuns.some((run) =>
    GATE_CHECKS.includes(run?.name) && run.status !== 'completed')) {
    return {
      runProducts: true,
      reason: 'a gate run from another attempt has not finished, so any product '
        + 'coverage on this head predates an unknown verdict',
    };
  }

  // Either gate of `needs: [review-scope, battery-plan]` failing skips the
  // products of that attempt, so a non-success from EITHER means the product
  // coverage still visible here predates that attempt — and an aborted plan
  // would otherwise be unclearable: every later edit would read the old
  // successes, skip again, and add another aborted skip set forever.
  for (const gate of GATE_CHECKS) {
    const verdict = newestCompleted(checkRuns, gate);
    if (verdict && verdict.conclusion !== 'success') {
      return {
        runProducts: true,
        reason: `the last completed ${gate} run did not pass, so any product `
          + 'coverage on this head predates the current evaluation',
      };
    }
  }

  const notBefore = gateWatermark(checkRuns);
  for (const name of PRODUCT_CHECKS) {
    if (!coveredBy(checkRuns, name, notBefore)) {
      return {
        runProducts: true,
        reason: `product check ${name} has no run covering this head from the current attempt`,
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
  ownRunId = process.env.GITHUB_RUN_ID,
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
      let complete = false;
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
        // A page that fails mid-read leaves a PREFIX of the history, and a
        // prefix can look clean while the unread page holds the cancelled
        // product or failed scope run that would have forced a rerun. Partial
        // history is no history: leave checkRuns undefined and fail toward
        // running the battery.
        if (!response.ok) break;
        const batch = (await response.json()).check_runs ?? [];
        runs.push(...batch);
        if (batch.length < 100) {
          complete = true;
          break;
        }
        page += 1;
      }
      // exclude THIS workflow run's own checks: its review-scope is queued by
      // construction and must not be read as another attempt's pending verdict
      if (complete) checkRuns = runs.filter((run) => !belongsToRun(run, ownRunId));
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
