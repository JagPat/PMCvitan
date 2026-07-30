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

export function openPrIsLive(statusNow, openPullRequests) {
  const openPrField = String(statusNow?.open_pr ?? '').trim();
  if (isNone(openPrField)) return false;
  return (openPullRequests ?? []).some(
    (pullRequest) => String(pullRequest.number) === openPrField,
  );
}

// Drift is a property of the STATUS that will exist on the default branch, but a
// correction already in flight on an open PR head is NOT drift — the default
// branch legitimately lags until that PR merges. Consult EVERY open head, not
// just the highest-numbered one: with several autonomous PRs open, the head that
// records reality is not necessarily the newest.
export function detectStatusDriftAcrossHeads({
  defaultBranchNow,
  headStatuses = [],
  openPullRequests = [],
}) {
  const defaultBranchDrift = detectStatusDrift(defaultBranchNow, openPullRequests);
  if (!defaultBranchDrift.drift) return defaultBranchDrift;

  const correctingHead = (headStatuses ?? []).find(
    (entry) => entry?.now && !detectStatusDrift(entry.now, openPullRequests).drift,
  );
  if (correctingHead) {
    return {
      drift: false,
      correctedInFlight: true,
      correctingPullRequest: correctingHead.number ?? null,
    };
  }

  return defaultBranchDrift;
}

// The live GitHub PR set is the ONLY authority on whether something exists to
// shepherd. STATUS disagreeing with it is reported as drift; it is never a
// reason to instruct the runner to open a competing branch.
export function shouldShepherdOpenPullRequests({ openPullRequests = [] }) {
  return openPullRequests.length > 0;
}

export function buildPostMergeContinuation({
  statusNow,
  maintenanceQueue = [],
  openPullRequests = [],
  headStatuses = [],
}) {
  const assessment = assessRunnerState(statusNow, maintenanceQueue);
  const drift = detectStatusDriftAcrossHeads({
    defaultBranchNow: statusNow,
    headStatuses,
    openPullRequests,
  });
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

  const shouldShepherd = shouldShepherdOpenPullRequests({ openPullRequests });
  const openPrField = String(statusNow?.open_pr ?? '').trim();

  lines.push('');
  if (shouldShepherd) {
    lines.push(
      'An autonomous PR is already open — shepherd it to completion instead of opening a competing branch. If the merged result or state file is inconsistent, open a focused correction instead of advancing.',
    );
  } else {
    lines.push(
      'Create the next same-repository `claude/**` branch and draft PR with Auto-fix enabled. If the merged result or state file is inconsistent, open a focused correction instead of advancing.',
    );
    if (!isNone(openPrField) && !openPrIsLive(statusNow, openPullRequests)) {
      lines.push(
        '',
        `**Note:** clear stale \`open_pr: ${openPrField}\` in STATUS before starting new work.`,
      );
    }
  }

  return lines.join('\n');
}

export function buildDriftHandoff({
  statusNow,
  maintenanceQueue = [],
  openPullRequests = [],
  headStatuses = [],
}) {
  const drift = detectStatusDriftAcrossHeads({
    defaultBranchNow: statusNow,
    headStatuses,
    openPullRequests,
  });
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
    (openPullRequests ?? []).length > 0
      ? `Update \`open_pr\` to \`${drift.suggestedOpenPr}\` (or the correct current PR), align \`task_state\`, and shepherd the open PR. Do not open a competing branch for the same work item.`
      : `Update \`open_pr\` to \`${drift.suggestedOpenPr}\`, align \`task_state\`, and start the next permitted work item. There is no live autonomous PR to shepherd.`,
  ].join('\n');
}
