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

/**
 * A PR that is OPEN but is nobody's work item.
 *
 * `open_pr` answers "which PR is this task's work item", and every other part of
 * this module reads it as "is there a live autonomous PR" — the two coincide for a
 * task PR and come apart for exactly one shape: the STATUS-ONLY HANDOFF flip, a PR
 * whose whole content is recording that the previous unit merged and naming the
 * next one.
 *
 * That divergence produced three defects on PR #296 alone (see
 * `docs/reviews/pr-296-convergence.md`): `assessRunnerState` resolving to the
 * merged docs PR, the drift shepherd advising the state that causes it, and the
 * post-merge continuation drift-correcting `open_pr: none` BACK to that PR while
 * labelling the correct `next_task` as stale — leaving the loop waiting on a PR
 * that had already merged.
 *
 * The predicate is SELF-DESCRIBING rather than a new convention: a head whose own
 * Now block says the task is `merged`, names no `work_item`, and records
 * `open_pr: none` is announcing that it is a handoff and not a work item. All
 * three fields already have to be correct for the runner to function, so nothing
 * new can drift. A head that is unreadable (`now: null`) is NOT handoff-only —
 * unknown means it counts, which keeps the failure direction conservative.
 */
export function isHandoffOnlyHead(headStatus) {
  const now = headStatus?.now;
  if (!now) return false;
  return (
    String(now.task_state ?? '').trim().toLowerCase() === 'merged' &&
    isNone(String(now.work_item ?? '').trim()) &&
    isNone(String(now.open_pr ?? '').trim())
  );
}

/**
 * The open PRs that are actually WORK ITEMS — every open autonomous PR except the
 * handoff-only ones. This is the set `open_pr` is supposed to describe, and the
 * set the drift decision and the shepherd instruction must both be computed from.
 *
 * The DISPLAYED list is deliberately not filtered: a reader is told every PR that
 * is open, because hiding one would be its own kind of lie.
 */
export function workItemPullRequests({ openPullRequests = [], headStatuses = [] }) {
  const handoffOnly = new Set(
    (headStatuses ?? [])
      .filter((entry) => isHandoffOnlyHead(entry))
      .map((entry) => String(entry.number)),
  );
  return (openPullRequests ?? []).filter(
    (pullRequest) => !handoffOnly.has(String(pullRequest.number)),
  );
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
  // A handoff-only PR is open but is not a work item, so it must not force
  // `open_pr` to name it — see `isHandoffOnlyHead`.
  const workItems = workItemPullRequests({ openPullRequests, headStatuses });
  const defaultBranchDrift = detectStatusDrift(defaultBranchNow, workItems);
  if (!defaultBranchDrift.drift) return defaultBranchDrift;

  const correctingHead = (headStatuses ?? []).find(
    (entry) => entry?.now && !detectStatusDrift(entry.now, workItems).drift,
  );
  if (correctingHead) {
    // Suppressing the SHEPHERD is not a claim that the record is right — it only
    // says a correction is already in flight, so posting a drift comment would be
    // noise. `suggestedOpenPr` is carried through regardless, because the
    // post-merge next step must still be assessed from the corrected record: the
    // default branch's `open_pr` is stale either way.
    return {
      drift: false,
      correctedInFlight: true,
      correctingPullRequest: correctingHead.number ?? null,
      // The correction comes from the HEAD THAT CORRECTED IT, not from the
      // default drift computation — which suggests the highest-numbered live PR.
      // With #252 correcting and #257 also open, the default suggestion is `257`,
      // so the continuation rendered `Runner next step: pr:257` with no drift
      // warning and sent the runner to the wrong branch after merge.
      suggestedOpenPr: String(correctingHead.now?.open_pr ?? '').trim() || 'none',
    };
  }

  return defaultBranchDrift;
}

// The live GitHub PR set is the ONLY authority on whether something exists to
// shepherd. STATUS disagreeing with it is reported as drift; it is never a
// reason to instruct the runner to open a competing branch.
export function shouldShepherdOpenPullRequests({ openPullRequests = [], headStatuses = [] }) {
  // "Shepherd the open PR instead of opening a competing branch" is right about a
  // work item and wrong about a handoff flip: after that flip merges there is
  // nothing to shepherd, and the instruction parks the loop on a finished PR.
  return workItemPullRequests({ openPullRequests, headStatuses }).length > 0;
}

// The next step must never be assessed from a record the drift detector has just
// declared wrong.
//
// `assessRunnerState` reads `open_pr` first, so a STATUS still naming a closed PR
// yields `pr:<closed>` — and the handoff published that as the instruction while
// the same comment said the open-PR list was `none` and to create the next branch.
// That sends the runner back to a PR that no longer exists.
//
// The drift correction already computes what `open_pr` SHOULD say
// (`suggestedOpenPr`), so assess from that. The recorded value is still returned,
// explicitly labelled stale, because an operator reading the comment needs to know
// what STATUS currently claims — but it is never the actionable line.
function assessDriftCorrected(statusNow, maintenanceQueue, drift) {
  const assessment = assessRunnerState(statusNow, maintenanceQueue);
  // Key on whether a CORRECTION exists, not on whether drift is REPORTED.
  //
  // When an open head already records the fix, `detectStatusDriftAcrossHeads`
  // sets `drift: false` to keep the hourly shepherd quiet — but the record this
  // function is assessing is still the stale default-branch one. Keying on
  // `drift.drift` therefore assessed it as if there were no disagreement, and the
  // comment rendered "shepherd the open PR" beside a next step computed from an
  // `open_pr` that predates it.
  if (drift?.suggestedOpenPr === undefined) return { assessment, recorded: null };

  const corrected = assessRunnerState(
    { ...statusNow, open_pr: drift.suggestedOpenPr },
    maintenanceQueue,
  );
  // Only call the record stale when correcting it actually changes the answer;
  // otherwise the label is noise.
  return corrected.nextStep === assessment.nextStep
    ? { assessment, recorded: null }
    : { assessment: corrected, recorded: assessment };
}

export function buildPostMergeContinuation({
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
  const { assessment, recorded } = assessDriftCorrected(
    statusNow,
    maintenanceQueue,
    drift,
  );
  const nextStep = assessment.nextStep ?? 'none';

  const lines = [
    '@claude This exact-head reviewed PR has merged into `main`.',
    '',
    'Continue the autonomous runner from the new `main`: verify the merge, advance `docs/STATUS.md` according to its state machine, and start only the next permitted roadmap task or named correction.',
    '',
    `**Runner next step:** \`${nextStep}\` — ${assessment.reason}`,
    `**Open autonomous PRs:** ${formatOpenPullRequestList(openPullRequests)}`,
  ];

  if (recorded) {
    lines.push(
      `**Recorded in STATUS (STALE — do not act on it):** \`${recorded.nextStep ?? 'none'}\` — ${recorded.reason}`,
    );
  }

  if (drift.drift) {
    lines.push(
      '',
      `**STATUS drift:** ${drift.reason}. Update \`open_pr\` to \`${drift.suggestedOpenPr}\` (or the correct current PR) and align \`task_state\` before opening new work.`,
    );
  }

  const shouldShepherd = shouldShepherdOpenPullRequests({ openPullRequests, headStatuses });
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

  // Drift is true by construction here, so the same rule applies: the actionable
  // step is the drift-corrected one, and the recorded value is shown only as the
  // stale record it is.
  const { assessment, recorded } = assessDriftCorrected(
    statusNow,
    maintenanceQueue,
    drift,
  );
  const nextStep = assessment.nextStep ?? 'none';

  return [
    '@claude The autonomous runner detected drift between `docs/STATUS.md` and live GitHub state.',
    '',
    `**STATUS drift:** ${drift.reason}.`,
    `**Next step after correcting STATUS:** \`${nextStep}\` — ${assessment.reason}`,
    ...(recorded
      ? [`**Recorded in STATUS (STALE — do not act on it):** \`${recorded.nextStep ?? 'none'}\` — ${recorded.reason}`]
      : []),
    `**Open autonomous PRs:** ${formatOpenPullRequestList(openPullRequests)}`,
    '',
    (openPullRequests ?? []).length > 0
      ? `Update \`open_pr\` to \`${drift.suggestedOpenPr}\` (or the correct current PR), align \`task_state\`, and shepherd the open PR. Do not open a competing branch for the same work item.`
      : `Update \`open_pr\` to \`${drift.suggestedOpenPr}\`, align \`task_state\`, and start the next permitted work item. There is no live autonomous PR to shepherd.`,
  ].join('\n');
}
