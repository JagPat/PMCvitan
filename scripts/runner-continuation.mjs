import { assessRunnerState, isNoneValue } from './autonomous-status-state.mjs';

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

/**
 * The HANDOFF shape: nothing in progress, the last unit merged, and a next task named.
 *
 * A STATUS-only handoff PR is not a work item — it IS the handoff, and the runner reads it only
 * once it has merged, at which point no PR exists. So it correctly records `open_pr: none` while
 * its own PR is still open, and `detectStatusDrift` reads exactly that as drift.
 *
 * That made the "correction already in flight" suppression below unable to recognise the one head
 * carrying the fix, so the shepherd advised setting `open_pr` to the handoff PR's own number —
 * which `assessRunnerState` consumes before `next_task`, sending the post-merge runner back to a
 * PR that no longer exists. PR #303 got that advice and took it.
 *
 * A work-item PR is not affected: it NAMES its work item, so this predicate is false for it and a
 * `open_pr: none` beside a live work-item PR is still reported as the drift it is (which is what
 * caught PR #302's first head).
 */
export function isHandoffShape(now) {
  const workItem = String(now?.work_item ?? '').trim().toLowerCase();
  const state = String(now?.task_state ?? '').trim().toLowerCase();
  const openPr = String(now?.open_pr ?? '').trim().toLowerCase();
  const nextTask = String(now?.next_task ?? '').trim();
  return (
    (workItem === '' || workItem === 'none')
    && TERMINAL_HANDOFF_STATES.has(state)
    && (openPr === '' || openPr === 'none')
    // A handoff NAMES its next task. The `none` sentinel is the ABSENCE of one (the
    // owner-gated interregnum: merged, nothing scheduled, the maintenance queue as the
    // work source) — treating it as a name classified that state as a handoff, and a
    // live maintenance PR whose head carried it would have suppressed the very
    // `open_pr: none` drift the hourly shepherd exists to correct (#334 round 1).
    // The predicate is the RUNNER'S OWN, case-exact (#334 round 3): a lowercased
    // check here would call `NONE` the sentinel while assessRunnerState treats it as
    // a named task — the same state read two ways by two readers.
    && !isNoneValue(nextTask)
  );
}

/** The terminal NONE-flip: a STATUS that deliberately lands `merged` with NOTHING
 *  scheduled (the owner-gated interregnum). Not a handoff — it names no task — but a
 *  PR that PROPOSES this state is still a correction in flight (#334 round 3): the
 *  shepherd must not advise pointing `open_pr` at that PR's own number, or the merged
 *  STATUS sends the runner to a closed PR (the exact #303 trap). Whether a head
 *  PROPOSES the state or merely CARRIES it from main is decided by `editsStatus`. */
export function isNoneFlipShape(now) {
  const workItem = String(now?.work_item ?? '').trim().toLowerCase();
  const state = String(now?.task_state ?? '').trim().toLowerCase();
  const openPr = String(now?.open_pr ?? '').trim().toLowerCase();
  return (
    (workItem === '' || workItem === 'none')
    && TERMINAL_HANDOFF_STATES.has(state)
    && (openPr === '' || openPr === 'none')
    && isNoneValue(String(now?.next_task ?? '').trim())
  );
}
const TERMINAL_HANDOFF_STATES = new Set(['merged', 'complete', 'completed', 'cleared']);

/** The DIRECTIVE landing: a status-only correction that records a post-merge defect —
 *  `open_pr: none` with a scheduled `blocking_directive` — and is therefore neither a
 *  handoff (its task is not terminal) nor a none-flip (it schedules work).
 *
 *  It belongs to the SAME class as the two shapes above and for the same reason: the
 *  record it proposes is the one that will be true AFTER its own merge, so
 *  `detectStatusDrift` cannot help but read its `open_pr: none` as drift while its own
 *  PR is still open. Without this arm the shepherd advises pointing `open_pr` at the
 *  correction's own number — the #303 trap, planted by the very PR whose purpose is to
 *  remove a stale pointer.
 *
 *  The states are the two `assessRunnerState` schedules a directive from, spelled the
 *  same way: a directive recorded from any other state does not resolve, so treating it
 *  as a landing would suppress drift for a record the runner cannot act on. The directive
 *  itself is tested with the runner's own case-exact sentinel (#334 round 3) rather than a
 *  lowercased compare, so `NONE` is refused here exactly as `assessRunnerState` refuses it
 *  instead of being read as "no directive" by one reader and a named one by the other. */
export function isDirectiveLandingShape(now) {
  const workItem = String(now?.work_item ?? '').trim().toLowerCase();
  const state = String(now?.task_state ?? '').trim().toLowerCase();
  const openPr = String(now?.open_pr ?? '').trim().toLowerCase();
  return (
    (workItem === '' || workItem === 'none')
    && DIRECTIVE_SCHEDULING_STATES.has(state)
    && (openPr === '' || openPr === 'none')
    && !isNoneValue(String(now?.blocking_directive ?? '').trim())
  );
}
// Mirrors assessRunnerState's DIRECTIVE_STATES: the states STATUS schedules a directive from.
const DIRECTIVE_SCHEDULING_STATES = new Set(['correction_required', 'in_progress']);

/** Whether a head's Now block PROPOSES a state transition (#334 rounds 5–6). A head whose
 *  Now block EQUALS the default branch's is carrying main's state, whatever else its diff
 *  touches — editing a historical STATUS paragraph puts the file in the diff without
 *  proposing anything. Round 5 compared an enumerated field list and round 6 promptly
 *  found the field it missed (`blocking_directive` — a directive-only correction differs
 *  in nothing else), which is the round-4 lesson pointed at FIELDS: gate the class, not
 *  the instance. So the comparison is now the WHOLE Now block minus `updated` (the
 *  timestamp — a cosmetic touch that must never count as a transition), over the UNION of
 *  both sides' keys so an added or removed field also counts. Field values are trimmed. */
function landingFieldsDiffer(headNow, defaultBranchNow) {
  const keys = new Set([
    ...Object.keys(headNow ?? {}),
    ...Object.keys(defaultBranchNow ?? {}),
  ]);
  keys.delete('updated');
  return [...keys].some(
    (field) => String(headNow?.[field] ?? '').trim() !== String(defaultBranchNow?.[field] ?? '').trim(),
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

  const correctingHead = (headStatuses ?? []).find((entry) => {
    if (!entry?.now) return false;
    if (!detectStatusDrift(entry.now, openPullRequests).drift) return true;
    // …OR the head records the HANDOFF shape, which `detectStatusDrift` cannot help but call drift
    // (`open_pr: none` beside its own live PR) even though it is the correct landing state.
    //
    // But a handoff head may only excuse drift attributable to ITS OWN PR. The first version of
    // this branch tested `isHandoffShape` alone, so with a handoff PR and a real WORK-ITEM PR both
    // open, the handoff was found first, `drift: false` was returned, and the work-item PR's
    // genuine `open_pr` drift went unreported — the loop then ran with STATUS not naming the PR it
    // had to shepherd. Silencing one broken loop by opening another is not a fix.
    //
    // So: exclude this head's own PR from the live set and re-ask. Nothing else open can be in
    // drift against it, or the head is not a correction — it is one of the things that is wrong.
    //
    // THREE landing shapes qualify (#334 rounds 3–5; the directive landing added on #485),
    // and the PROPOSES-vs-CARRIES test
    // applies to BOTH — the distinguisher belongs to the CLASS, not to whichever shape
    // last bit us. A HANDOFF names its next task; a NONE-FLIP is the deliberate
    // interregnum. Either one, read from a head's Now block, is IDENTICAL to a
    // maintenance PR that merely CARRIES the default branch's terminal state (round 4:
    // with a named handoff already merged on main, every fresh PR's head carries that
    // exact shape) — so a head qualifies only when it actually PROPOSES the state, which
    // takes BOTH halves (round 5): its diff EDITS docs/STATUS.md (`entry.editsStatus` —
    // a file-level fact) AND its Now block's LANDING FIELDS differ from the default
    // branch's (a PR that edits only a historical STATUS paragraph carries the file in
    // its diff while proposing nothing). `editsStatus` unknown (null/undefined) counts
    // as editing: wrongly suppressing a maintenance PR's drift costs one missed
    // shepherd nudge, while wrongly advising a landing head to point `open_pr` at
    // itself plants the #303 trap in the merged record. Fail toward the recoverable
    // mistake.
    const qualifies = (
      isHandoffShape(entry.now)
      || isNoneFlipShape(entry.now)
      || isDirectiveLandingShape(entry.now)
    )
      && entry.editsStatus !== false
      && landingFieldsDiffer(entry.now, defaultBranchNow);
    if (!qualifies) return false;
    const others = (openPullRequests ?? []).filter(
      (pullRequest) => String(pullRequest.number) !== String(entry.number),
    );
    return !detectStatusDrift(entry.now, others).drift;
  });
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
export function shouldShepherdOpenPullRequests({ openPullRequests = [] }) {
  return openPullRequests.length > 0;
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
