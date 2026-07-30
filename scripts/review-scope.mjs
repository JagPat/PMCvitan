import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

import {
  assessPlanDocumentScope,
  assessReviewScope,
  PLAN_SCOPE_ENFORCE_AFTER_PR,
  planFileStatsFromDiff,
} from './review-efficiency.mjs';

function normalizePlanStatsInput(planStatsInput) {
  if (Array.isArray(planStatsInput)) {
    return { unavailable: false, stats: planStatsInput };
  }
  return {
    unavailable: Boolean(planStatsInput?.unavailable),
    stats: Array.isArray(planStatsInput?.stats) ? planStatsInput.stats : [],
  };
}

export function assessPullRequestScope(pullRequest, planStatsInput = []) {
  const { unavailable: planUnavailable, stats: planStats } =
    normalizePlanStatsInput(planStatsInput);
  const scope = assessReviewScope(pullRequest);
  if (!scope.allowed) return scope;

  const prNumber = Number(pullRequest?.number);
  if (
    Number.isInteger(prNumber)
    && prNumber > PLAN_SCOPE_ENFORCE_AFTER_PR
    && planUnavailable
  ) {
    return {
      ...scope,
      state: 'blocked',
      allowed: false,
      detail:
        'Phase plan document scope could not be verified because the base..head '
        + 'diff is unavailable; ensure checkout fetch-depth includes both SHAs',
    };
  }

  const plan = assessPlanDocumentScope(planStats, { prNumber: pullRequest?.number });
  if (!plan.allowed) {
    return {
      ...scope,
      state: 'blocked',
      allowed: false,
      detail: plan.detail,
    };
  }
  return scope;
}

export async function run({ eventPath = process.env.GITHUB_EVENT_PATH } = {}) {
  if (!eventPath) throw new Error('GITHUB_EVENT_PATH is required');
  const event = JSON.parse(await readFile(eventPath, 'utf8'));
  if (!event.pull_request) {
    console.log('review-scope: no pull request in this event; nothing to assess');
    return { state: 'not_applicable', allowed: true };
  }

  const planResult = planFileStatsFromDiff(
    event.pull_request?.base?.sha,
    event.pull_request?.head?.sha,
    (baseSha, headSha) => execFileSync(
      'git',
      ['diff', '--numstat', `${baseSha}...${headSha}`],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    ),
  );

  const result = assessPullRequestScope(event.pull_request, planResult);
  console.log(
    `review-scope: ${result.state}; ${result.changedFiles} files, ${result.changedLines} changed lines`,
  );
  if (!result.allowed) {
    console.error(`::error title=Review unit is too broad::${result.detail}`);
    process.exitCode = 1;
  }
  return result;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  await run();
}
