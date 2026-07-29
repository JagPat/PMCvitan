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

// A check run counts as a REAL execution only when it completed with a
// conclusion produced by actually running (skipped = gated off by `needs` or
// `if`; cancelled = never finished).
function reallyRan(run) {
  return run?.status === 'completed'
    && typeof run?.conclusion === 'string'
    && run.conclusion !== 'skipped'
    && run.conclusion !== 'cancelled';
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
  for (const name of PRODUCT_CHECKS) {
    const ran = checkRuns.some((run) => run?.name === name && reallyRan(run));
    if (!ran) {
      return {
        runProducts: true,
        reason: `product check ${name} has never really run for this head`,
      };
    }
  }
  return {
    runProducts: false,
    reason: 'metadata-only edit; every product check already ran for this head',
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
