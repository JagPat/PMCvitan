import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

import {
  assessPlanDocumentScope,
  assessReviewScope,
  planFileStatsFromDiff,
} from './review-efficiency.mjs';

export function assessPullRequestScope(pullRequest, planStats = []) {
  const scope = assessReviewScope(pullRequest);
  if (!scope.allowed) return scope;

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

  const planStats = planFileStatsFromDiff(
    event.pull_request?.base?.sha,
    event.pull_request?.head?.sha,
    (baseSha, headSha) => execFileSync(
      'git',
      ['diff', '--numstat', `${baseSha}...${headSha}`],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    ),
  );

  const result = assessPullRequestScope(event.pull_request, planStats);
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
