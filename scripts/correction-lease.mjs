// The correction LEASE: a bounded, idempotent watch over one owed correction.
//
// A finding-bearing head returns the PR to draft, the controller publishes who
// owns the correction, and then — under subscription-only authentication —
// nothing in this repository can observe whether that owner ever started. On
// 2026-08-17 both PR #349 and PR #350 sat on a finding-bearing head for about an
// hour with the handoff job reporting green, and the repository owner had to
// notice by hand and post the kick himself, twice.
//
// This module is the automated version of exactly that kick, with the two
// properties a human doing it by hand cannot guarantee:
//
//   IDEMPOTENT — the lease is keyed to (pull request, EXACT head, owner). One
//   notification per key, ever. A repeated cron tick, a replaced Actions run, or
//   a second event for the same head produces no second comment.
//
//   HONEST — the lease is satisfied by ONE thing only: a new head on the branch.
//   Not by the notification existing, not by a reaction on it, not by a reply.
//   Both PRs above were "acknowledged only as a subscription and produced no
//   correction activity", which is precisely the state an acknowledgement-based
//   check would have called healthy.
//
// It publishes a comment and nothing else. It never touches
// `codex-current-head`, draft state, auto-merge, or Codex.
import { REVIEW_RESET_AFTER_FINDING_HEADS } from './review-efficiency.mjs';
import {
  CORRECTION_STALLED,
  correctionRouting,
  parseCorrectionOwner,
} from './correction-owner.mjs';

export const CORRECTION_LEASE_MARKER = '<!-- autonomous-correction-lease:';
export const ACTIONS_BOT_LOGIN = 'github-actions[bot]';

// How long an owed correction may show no head movement before the lease is
// reported. The handoff watchdog runs hourly, so a notice lands 45-105 minutes
// after the finding — comfortably longer than a real correction round takes to
// produce its first push, and far shorter than the silent hours this replaces.
export const CORRECTION_LEASE_GRACE_MS = Number(
  process.env.CORRECTION_LEASE_GRACE_MS ?? 45 * 60_000,
);

export function correctionLeaseMarker({ number, head, owner }) {
  return `${CORRECTION_LEASE_MARKER}pr=${number} head=${head} owner=${owner} -->`;
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
  return [
    marker,
    ...(mention ? [`${mention} **Autonomous correction watchdog — \`${reportedState}\`**`, ''] : [
      `**Autonomous correction watchdog — \`${reportedState}\`**`,
      '',
    ]),
    `- **Pull request:** #${pullRequestNumber}`,
    `- **Exact head:** \`${head}\``,
    `- **Correction owner:** ${ownerLabel}`,
    `- **Findings on this head:** ${detail}`,
    `- **Head movement since the finding:** ${
      stalledMinutes === null ? 'none observed' : `none for ${stalledMinutes} minutes`
    }`,
    '',
    instruction,
    ...(resumeAction ? ['', resumeAction] : []),
    '',
    'This notice is published at most once for this pull request, this exact head and this '
      + 'correction owner. It is a request, not a report of work: only a new head on this branch '
      + 'clears the lease, and the required `codex-current-head` status on the exact head remains '
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
  // The ONLY satisfaction. Everything else below is bookkeeping about a lease
  // that is still open.
  if (pullRequest?.head?.sha !== expected) {
    return {
      state: 'superseded',
      body: null,
      reason: 'the branch has moved past the finding-bearing head',
    };
  }

  const declaration = parseCorrectionOwner(body ?? pullRequest?.body, {
    headRef: pullRequest?.head?.ref,
  });
  const exhausted = (findingHeads ?? []).length >= resetAfterFindingHeads;
  const routing = correctionRouting({
    declaration,
    head: expected,
    detail,
    reason: exhausted ? 'replacement' : 'review',
    pullRequestNumber: pullRequest?.number,
  });

  const owner = routing.owner ?? 'undeclared';
  const marker = correctionLeaseMarker({
    number: pullRequest?.number,
    head: expected,
    owner,
  });
  const reportedState = exhausted
    ? 'replacement_required'
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
      reason: 'this lease has already been reported once; only a new head clears it',
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
  const resumeAction = reportedState !== CORRECTION_STALLED
    ? null
    : routing.owner
      ? `**Required resume action:** start the \`${routing.owner}\` session on branch `
        + `\`${pullRequest?.head?.ref}\` and have it push one corrected head for \`${expected}\`. `
        + 'GitHub cannot start it, so nothing happens on this PR until someone does.'
      : '**Required resume action:** declare the correction owner in the PR body, then the '
        + 'declared owner corrects this head.';

  return {
    ...base,
    state: 'notify',
    stalledMinutes,
    reason: 'the finding-bearing head has not moved within the bounded interval',
    body: leaseBody({
      resumeAction,
      marker,
      mention: routing.mention,
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
