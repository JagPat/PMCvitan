import { assessRunnerState } from './autonomous-status-state.mjs';

const NONE = 'none';

export function isAutonomousPullRequest(
  pullRequest,
  repository,
  defaultBranch,
) {
  return (
    pullRequest?.state === 'open' &&
    pullRequest?.head?.repo?.full_name === repository &&
    pullRequest?.base?.repo?.full_name === repository &&
    pullRequest?.base?.ref === defaultBranch &&
    pullRequest?.head?.ref?.startsWith('claude/')
  );
}

function isNone(value) {
  return value === undefined || value === null || value === '' || value === NONE;
}

export function selectAutonomousOpenPullRequests(
  pullRequests,
  repository,
  defaultBranch,
) {
  return (pullRequests ?? [])
    .filter((pullRequest) =>
      isAutonomousPullRequest(pullRequest, repository, defaultBranch)
    )
    .sort((left, right) => left.number - right.number);
}

export function formatOpenPullRequestList(openPullRequests) {
  if (!openPullRequests?.length) return 'none';
  return openPullRequests
    .map((pullRequest) => {
      const state = pullRequest.draft ? 'draft' : 'ready';
      return `#${pullRequest.number} \`${pullRequest.head?.ref}\` (${state})`;
    })
    .join(', ');
}

export function detectStatusDrift(statusNow, openPullRequests) {
  const openPrField = statusNow?.open_pr;
  const hasOpenAutonomousPrs = (openPullRequests ?? []).length > 0;

  if (!isNone(openPrField) || !hasOpenAutonomousPrs) {
    return { drift: false };
  }

  const primary = openPullRequests[openPullRequests.length - 1];
  return {
    drift: true,
    reason:
      'docs/STATUS.md records open_pr: none while autonomous PR(s) are still open',
    suggestedOpenPr: String(primary.number),
    primaryPullRequest: primary,
  };
}

export function buildPostMergeContinuation({
  statusNow,
  maintenanceQueue = [],
  openPullRequests = [],
}) {
  const assessment = assessRunnerState(statusNow, maintenanceQueue);
  const drift = detectStatusDrift(statusNow, openPullRequests);
  const nextStep = assessment.nextStep ?? 'none';

  const lines = [
    '@claude This exact-head reviewed PR has merged into `main`.',
    '',
    'Continue the autonomous runner from the new `main`: verify the merge, advance `docs/STATUS.md` according to its state machine, and start only the next permitted roadmap task or named correction.',
    '',
    `**Runner next step:** \`${nextStep}\` — ${assessment.reason}`,
    `**Open autonomous PRs:** ${formatOpenPullRequestList(openPullRequests)}`,
  ];

  if (drift.drift) {
    lines.push(
      '',
      `**STATUS drift:** ${drift.reason}. Update \`open_pr\` to \`${drift.suggestedOpenPr}\` (or the correct current PR) and align \`task_state\` before opening new work.`,
    );
  }

  lines.push(
    '',
    'Create the next same-repository `claude/**` branch and draft PR with Auto-fix enabled. If the merged result or state file is inconsistent, open a focused correction instead of advancing.',
  );

  return lines.join('\n');
}

export function buildDriftHandoff({
  statusNow,
  maintenanceQueue = [],
  openPullRequests = [],
}) {
  const drift = detectStatusDrift(statusNow, openPullRequests);
  if (!drift.drift) return null;

  const assessment = assessRunnerState(statusNow, maintenanceQueue);
  const nextStep = assessment.nextStep ?? 'none';

  return [
    '@claude The autonomous runner detected drift between `docs/STATUS.md` and live GitHub state.',
    '',
    `**STATUS drift:** ${drift.reason}.`,
    `**Recorded next step:** \`${nextStep}\` — ${assessment.reason}`,
    `**Open autonomous PRs:** ${formatOpenPullRequestList(openPullRequests)}`,
    '',
    `Update \`open_pr\` to \`${drift.suggestedOpenPr}\` (or the correct current PR), align \`task_state\`, and shepherd the open PR. Do not open a competing branch for the same work item.`,
  ].join('\n');
}
