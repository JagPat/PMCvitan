// The correction LEASE: a bounded, idempotent watch over one owed correction.
//
// A failing required status returns the PR to draft, the controller publishes
// WHO owns the correction — and then, under subscription-only authentication,
// nothing in this repository can observe whether that owner ever started. On
// 2026-08-17 both PR #349 and PR #350 sat on a finding-bearing head for about an
// hour with the handoff job reporting green, and the repository owner had to
// notice by hand and post the kick himself, twice.
//
// This module is the automated version of exactly that kick, with the three
// properties a human doing it by hand cannot guarantee:
//
//   IDEMPOTENT — the lease is keyed to (pull request, EXACT head, owner). One
//   notification per key, ever. A repeated cron tick, a replaced Actions run, or
//   a second event for the same head produces no second comment.
//
//   ACTIONABLE — the notice is a NEW comment, which is the only thing that
//   creates a GitHub notification. Claude Code web Auto-fix wakes on that
//   notification, so the mention lives HERE and not in the state comment, which
//   is `PATCH`ed after it exists and therefore notifies nobody. Routing decided
//   who; this is the unit that asks them.
//
//   HONEST — the lease is satisfied by head movement or by the required status
//   ceasing to fail, and by nothing else. Not by the notification existing, not
//   by a reaction on it, not by a reply. Both PRs above were "acknowledged only
//   as a subscription and produced no correction activity", which is precisely
//   the state an acknowledgement-based check would have called healthy.
//
// It publishes a comment and nothing else. It never touches
// `codex-current-head`, draft state, auto-merge, or Codex.
import { REVIEW_RESET_AFTER_FINDING_HEADS } from './review-efficiency.mjs';
import {
  AWAKENABLE_FROM_GITHUB,
  CORRECTION_STALLED,
  correctionRouting,
  parseCorrectionOwner,
} from './correction-owner.mjs';

export const CORRECTION_LEASE_MARKER = '<!-- autonomous-correction-lease:';
export const ACTIONS_BOT_LOGIN = 'github-actions[bot]';
export const CORRECTION_STATUS_CONTEXT = 'codex-current-head';

// How long an owed correction may show no movement before the lease is
// reported. The handoff watchdog runs hourly, so a notice lands 45-105 minutes
// after the failure — comfortably longer than a real correction round takes to
// produce its first push, and far shorter than the silent hours this replaces.
export const CORRECTION_LEASE_GRACE_MS = Number(
  process.env.CORRECTION_LEASE_GRACE_MS ?? 45 * 60_000,
);

// Which failures on the required status are an OWED CORRECTION, classified by
// the PREFIX the review gate writes rather than by the prose after it.
//
// The prose is exactly where the previous draft went wrong. It matched only the
// two Codex-finding sentences, so the round-limit failure — the ONE state whose
// remedy is a replacement PR rather than another head — never reached the lease
// at all, and `replacement_required` was unreachable in the shipped code while
// being documented as a state the watchdog reports. Prefixes are the gate's own
// vocabulary: `review:`, `scope:`, `ci:` are corrections someone owes.
const OWED_REASON_BY_PREFIX = new Map([
  ['review', 'review'],
  ['scope', 'scope'],
  ['ci', 'ci'],
]);
// `recovery:` is the gate asking ITSELF to retry, not an agent to fix anything.
const SELF_HEALING_PREFIXES = new Set(['recovery']);

// One `review:` failure is not a finding at all: the gate publishes it when the
// Codex integration did not answer twice. Its remedy is a re-dispatch, and
// asking for a head instead invalidates the reviewed one and restarts CI without
// touching the outage.
//
// This is prose matching, which the prefix rule above exists to avoid — but the
// two do different jobs and fail in opposite directions. The PREFIX decides
// WHETHER a correction is owed, and a missed prefix means silence, which is the
// failure this unit removes. This phrase only refines WHAT is asked; if the gate
// ever rewords it, the lease falls back to the ordinary correction notice, which
// is merely too generic rather than absent.
const REVIEW_TIMEOUT = /review timed out/iu;

// The reasons whose remedy is an action by the declared owner. A reason outside
// this set is reported but never mentions anyone: waking an owner who has
// nothing to do is the same false signal as claiming work that is not happening.
const OWNER_ACTIONABLE_REASONS = new Set(['review', 'scope', 'ci', 'replacement']);

// What a non-actionable report calls itself. Distinct from `correction_stalled`,
// which means an owner cannot be asked; this means nobody needs to be.
export const REVIEW_TIMEOUT_STATE = 'review_timeout';

/**
 * The correction reason a failing required status implies, or null when the
 * status is not an owed correction.
 *
 * An unrecognized prefix is treated as OWED with the generic `review` wording.
 * Only this repository's review gate writes this status context, so an unknown
 * prefix is a future one of ours, and the failure this whole unit exists to
 * remove is silence: a wrong-but-visible notice costs one comment, a missing one
 * costs the loop.
 */
export function correctionReasonFor(status) {
  if (status?.context !== CORRECTION_STATUS_CONTEXT) return null;
  if (status?.state !== 'failure') return null;
  const description = String(status?.description ?? '');
  const prefix = /^\s*([a-z]+):/u.exec(description)?.[1];
  if (prefix && SELF_HEALING_PREFIXES.has(prefix)) return null;
  const reason = OWED_REASON_BY_PREFIX.get(prefix) ?? 'review';
  return reason === 'review' && REVIEW_TIMEOUT.test(description) ? 'timeout' : reason;
}

/** The failing required status on this exact head, or null. */
export function owedCorrectionStatus(combinedStatus) {
  return (combinedStatus?.statuses ?? []).find(
    (status) => correctionReasonFor(status) !== null,
  ) ?? null;
}

// The lease KEY. `kind` is part of it because a non-actionable report and an
// owed correction are different leases over the same head: a timed-out review
// can be re-dispatched on that exact head and come back with findings, and if
// the timeout report had already claimed the key the actionable wake-up would be
// suppressed — leaving a PR whose only notice says NOT to push.
export function correctionLeaseMarker({ number, head, owner, kind = 'correction' }) {
  return `${CORRECTION_LEASE_MARKER}pr=${number} head=${head} owner=${owner} kind=${kind} -->`;
}

// The mention lives with the comment that carries it. A handle rendered anywhere
// that cannot notify is the "computed but never asked" defect this lineage kept
// producing, so it is derived from the same set that decides `awakenable` and
// can never name an owner GitHub could not have woken.
export function awakeningMention(owner, reason = 'review') {
  return AWAKENABLE_FROM_GITHUB.has(owner) && OWNER_ACTIONABLE_REASONS.has(reason)
    ? `@${owner}`
    : null;
}

function minutesBetween(fromIso, toIso) {
  const from = Date.parse(typeof fromIso === 'string' ? fromIso : '');
  const to = Date.parse(typeof toIso === 'string' ? toIso : '');
  if (!Number.isFinite(from) || !Number.isFinite(to)) return null;
  return Math.max(0, Math.round((to - from) / 60_000));
}

function leaseBody({
  marker,
  mention,
  reportedState,
  pullRequestNumber,
  head,
  ownerLabel,
  detail,
  stalledMinutes,
  instruction,
  resumeAction,
}) {
  const heading = `**Autonomous correction watchdog — \`${reportedState}\`**`;
  return [
    marker,
    ...(mention ? [`${mention} ${heading}`] : [heading]),
    '',
    `- **Pull request:** #${pullRequestNumber}`,
    `- **Exact head:** \`${head}\``,
    `- **Correction owner:** ${ownerLabel}`,
    `- **Failing required status:** ${detail}`,
    `- **Movement since it was published:** ${
      stalledMinutes === null ? 'none observed' : `none for ${stalledMinutes} minutes`
    }`,
    '',
    instruction,
    ...(resumeAction ? ['', resumeAction] : []),
    '',
    'This notice is published at most once for this pull request, this exact head and this '
      + 'correction owner. It is a request, not a report of work: it is cleared by a new head, '
      + 'or by this required status ceasing to fail — never by an acknowledgement, a reaction or '
      + 'a reply. The required `codex-current-head` status on the exact head remains '
      + 'authoritative.',
  ].join('\n');
}

/**
 * Assess one owed correction.
 *
 * States:
 *   superseded  — the branch has moved past `head`; the lease is satisfied
 *   notified    — this exact lease has already been reported once
 *   waiting     — still inside the bounded interval
 *   notify      — publish `body`, exactly once
 *
 * `reportedState` is what the notice CALLS the situation:
 *   correction_recovery   — a declared owner GitHub can wake
 *   correction_stalled    — a declared owner it cannot wake, or none declared
 *   replacement_required  — the review-round limit is reached, so the remedy is
 *                           a replacement PR and never a third correction head
 */
export function assessCorrectionLease({
  pullRequest,
  head,
  body,
  findingHeads = [],
  reason = 'review',
  detail = 'current-head Codex findings',
  findingObservedAt,
  now,
  comments = [],
  graceMs = CORRECTION_LEASE_GRACE_MS,
  resetAfterFindingHeads = REVIEW_RESET_AFTER_FINDING_HEADS,
}) {
  const expected = typeof head === 'string' && head.length > 0 ? head : null;
  if (!expected) {
    return { state: 'superseded', body: null, reason: 'no exact head was supplied' };
  }
  // Head movement is one of the two satisfactions; the other — the status no
  // longer failing — is upstream of this function, which is only reached while
  // `owedCorrectionStatus` still finds a failure on this exact head.
  if (pullRequest?.head?.sha !== expected) {
    return {
      state: 'superseded',
      body: null,
      reason: 'the branch has moved past the failing head',
    };
  }

  const declaration = parseCorrectionOwner(body ?? pullRequest?.body, {
    headRef: pullRequest?.head?.ref,
  });
  // The round limit outranks the status's own reason: once two heads have borne
  // findings the remedy is a replacement whatever the current failure says.
  const exhausted = (findingHeads ?? []).length >= resetAfterFindingHeads;
  const routing = correctionRouting({
    declaration,
    head: expected,
    detail,
    reason: exhausted ? 'replacement' : reason,
    pullRequestNumber: pullRequest?.number,
  });

  const owner = routing.owner ?? 'undeclared';
  const effectiveReason = exhausted ? 'replacement' : reason;
  const actionable = OWNER_ACTIONABLE_REASONS.has(effectiveReason);
  const marker = correctionLeaseMarker({
    number: pullRequest?.number,
    head: expected,
    owner,
    kind: actionable ? 'correction' : effectiveReason,
  });
  // A timed-out review is not stalled on its OWNER — nobody owes anything, and
  // labelling it `correction_stalled` pulled in the stalled-owner resume action,
  // which contradicted the instruction it was appended to. It is stalled on the
  // integration, and says so under its own name.
  const reportedState = exhausted
    ? 'replacement_required'
    : !actionable
      ? REVIEW_TIMEOUT_STATE
      : routing.awakenable
        ? 'correction_recovery'
        : CORRECTION_STALLED;

  const base = {
    owner,
    reportedState,
    marker,
    findingHeadCount: (findingHeads ?? []).length,
  };

  if ((comments ?? []).some((comment) =>
    comment?.user?.login === ACTIONS_BOT_LOGIN && String(comment?.body ?? '').includes(marker))) {
    // Already asked. An acknowledgement — a reaction, a reply, a subscription —
    // is NOT progress, so the lease stays open and simply says nothing further.
    return {
      ...base,
      state: 'notified',
      body: null,
      reason: 'this lease has already been reported once; only movement clears it',
    };
  }

  const stalledMinutes = minutesBetween(findingObservedAt, now);
  // An unreadable observation time reports rather than waits. The failure this
  // module exists to remove is silence, and the notification is bounded to one
  // per key, so reporting early costs a single comment while waiting forever
  // costs the loop.
  if (stalledMinutes !== null && stalledMinutes * 60_000 < graceMs) {
    return {
      ...base,
      state: 'waiting',
      body: null,
      stalledMinutes,
      reason: `${stalledMinutes} minutes elapsed; the lease is reported after `
        + `${Math.round(graceMs / 60_000)}`,
    };
  }

  // `correction_stalled` is a dead end unless the notice says how to leave it.
  // A declared owner GitHub cannot wake needs a human to start that session; an
  // undeclared one needs the marker, which the routed instruction already names.
  const resumeAction = !actionable || reportedState !== CORRECTION_STALLED
    ? null
    : routing.owner
      ? `**Required resume action:** start the \`${routing.owner}\` session on branch `
        + `\`${pullRequest?.head?.ref}\` and have it correct head \`${expected}\`. `
        + 'GitHub can neither start that session nor observe whether one is already running, '
        + 'so this notice does not report whether the correction has begun.'
      : '**Required resume action:** declare the correction owner in the PR body, then the '
        + 'declared owner corrects this head.';

  return {
    ...base,
    state: 'notify',
    stalledMinutes,
    reason: 'the failing head has not moved within the bounded interval',
    body: leaseBody({
      resumeAction,
      marker,
      mention: awakeningMention(routing.owner, effectiveReason),
      reportedState,
      pullRequestNumber: pullRequest?.number,
      head: expected,
      ownerLabel: routing.owner ? `\`${routing.owner}\`` : '`undeclared`',
      detail,
      stalledMinutes,
      instruction: routing.instruction,
    }),
  };
}
