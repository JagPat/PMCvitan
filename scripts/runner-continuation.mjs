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
  const openPrField = String(statusNow?.open_pr ?? '').trim();
  const liveNumbers = new Set(
    (openPullRequests ?? []).map((pullRequest) => String(pullRequest.number)),
  );
  const hasOpenAutonomousPrs = liveNumbers.size > 0;
  const primary = hasOpenAutonomousPrs
    ? openPullRequests[openPullRequests.length - 1]
    : null;

  if (!isNone(openPrField) && !liveNumbers.has(openPrField)) {
    return {
      drift: true,
      reason:
        `docs/STATUS.md records open_pr: ${openPrField} but that PR is not among the live autonomous PRs`,
      suggestedOpenPr: primary ? String(primary.number) : 'none',
      primaryPullRequest: primary,
    };
  }

  if (isNone(openPrField) && hasOpenAutonomousPrs) {
    return {
      drift: true,
      reason:
        'docs/STATUS.md records open_pr: none while autonomous PR(s) are still open',
      suggestedOpenPr: String(primary.number),
      primaryPullRequest: primary,
    };
  }

  return { drift: false };
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

  const hasOpenPrs = (openPullRequests ?? []).length > 0;
  const nextIsOpenPr = typeof nextStep === 'string' && nextStep.startsWith('pr:');

  lines.push('');
  if (hasOpenPrs || nextIsOpenPr) {
    lines.push(
      'An autonomous PR is already open — shepherd it to completion instead of opening a competing branch. If the merged result or state file is inconsistent, open a focused correction instead of advancing.',
    );
  } else {
    lines.push(
      'Create the next same-repository `claude/**` branch and draft PR with Auto-fix enabled. If the merged result or state file is inconsistent, open a focused correction instead of advancing.',
    );
  }

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
