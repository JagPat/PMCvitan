import {
  CORRECTION_LEASE_GRACE_MS,
  CI_SCOPE_ADMITTED,
  isRetryableReviewFailureDescription,
  isOwnershipInconsistentScopeDetail,
  OWNERSHIP_CANDIDATE_HELD,
  REARM_ATTEMPT_FAILED,
  REARM_REQUEST_ABANDONED_MS,
  REARM_SETTLEMENTS,
  rearmRequestContext,
  STATUS_CONTEXT as CORRECTION_STATUS_CONTEXT,
} from './review-policy.mjs';
export { CORRECTION_LEASE_GRACE_MS, STATUS_CONTEXT as CORRECTION_STATUS_CONTEXT } from './review-policy.mjs';

// The correction LEASE: a bounded, idempotent watch over one owed correction.
//
// A failing required status returns the PR to draft and the controller publishes
// WHO owns the correction — and then, under subscription-only authentication,
// nothing here can observe whether that owner ever started. On 2026-08-17 both
// PR #349 and PR #350 sat on a finding-bearing head for about an hour with the
// handoff job reporting green, and the repository owner had to notice by hand
// and post the kick himself, twice.
//
// This is that kick, automated, with the three properties a human doing it by
// hand cannot guarantee — IDEMPOTENT (one notification per pull request, exact
// head, owner and owed failure), ACTIONABLE (a NEW comment, the only thing that
// notifies; the state comment is PATCHed and wakes nobody), and HONEST (cleared
// by head movement or by the status ceasing to fail, never by an
// acknowledgement — both PRs above were acknowledged as a subscription and
// produced no correction). `docs/AUTONOMOUS_LOOP.md` states the contract; this
// file implements it.
//
// It publishes a comment and nothing else. It never touches
// `codex-current-head`, draft state, auto-merge, or Codex. (It may ask the gate
// to recover a head, through the gate's own dispatch: `gateRecoveryStatus`,
// `gateRearmStatus`.)
import { createHash } from 'node:crypto';

import { parseApprovalToken } from './work-item-approval.mjs';

import {
  AWAKENABLE_FROM_GITHUB,
  CORRECTION_STALLED,
  correctionRouting,
  parseCorrectionOwner,
} from './correction-owner.mjs';

export const CORRECTION_LEASE_MARKER = '<!-- autonomous-correction-lease:';
export const ACTIONS_BOT_LOGIN = 'github-actions[bot]';
// docs/POLICY.md reserves this branch prefix for Claude-authored work; a non-Claude owner on such a branch
// can only be reconciled toward `claude` (or by moving the work off the branch), never by matching the two
// contradictory sides. Kept local to avoid depending on a private constant in correction-owner.mjs.
const CLAUDE_BRANCH_PREFIX = 'claude/';

// Which failures on the required status are an OWED CORRECTION, classified by
// the PREFIX the review gate writes rather than by the prose after it.
//
// Prefixes are the gate's vocabulary: review, scope and CI failures owe a
// correction unless the shared policy classifies them as gate recovery.
const OWED_REASON_BY_PREFIX = new Map([
  ['review', 'review'],
  ['scope', 'scope'],
  ['ci', 'ci'],
]);
// `recovery:` is the gate asking ITSELF to retry, not an agent to fix anything.
const SELF_HEALING_PREFIXES = new Set(['recovery']);

// Retryable descriptions come from review-policy.mjs, shared with the gate.
// These open no correction lease; handOffCorrectionLease requests gate recovery.
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
  // Ownership-verdict lifecycle (unit 2A2-i): a candidate-held head owes NO correction. The exact head is
  // consistently owned by a recognised in-flight candidate (e.g. codex) and is held pending independent
  // reviewer activation — not merge-eligible, not awakenable, and not correctable by swapping the body
  // marker to claude/cursor. Routing it as an ordinary `validation:`→`review` correction would publish a
  // marker-replacement instruction that cannot clear the hold, so it opens no lease at all.
  if (description.startsWith(OWNERSHIP_CANDIDATE_HELD)) return null;
  const reason = OWED_REASON_BY_PREFIX.get(prefix) ?? 'review';
  if (reason === 'review' && isRetryableReviewFailureDescription(description)) return null;
  // The gate summarises a FAILED PR-side `review-scope` check as
  // `ci: Failed checks: review-scope`, while its own sticky routes that same
  // result as a scope verdict. Read as CI it told the owner to push a new head,
  // which invalidates the head for a verdict a body edit clears.
  // Unless the controller's own scope check of the same head ADMITS it (shadow finding on #630): then the
  // failed job is a CI failure, and reading it as `scope` would publish a false "scope refused" remedy.
  if (reason === 'ci' && /\breview-scope\b/u.test(description) && !description.includes(CI_SCOPE_ADMITTED)) {
    return 'scope';
  }
  return reason;
}

// Where the gate records that it ACCEPTED a recovery request. A separate
// context, and the original `codex-current-head` failure stays put — so a
// watchdog reading only that failure re-dispatches every tick, and an owner job
// can run 90 minutes, several times the hourly interval.
const RECOVERY_REQUEST_CONTEXT = 'codex-recovery-request/';

// #1307 sibling audit — a failure's request names no pull request: the failure is the commit's, so one request holds
// the ask for every open PR at the commit. A run that never settles it (a lost runner, or a dispatched PR whose head
// moved or which closed, so its run returns before reading the request) would hold every sibling's ask forever, so a
// request pending past `REARM_REQUEST_ABANDONED_MS` no longer holds it, as for a re-arm (row 24)
function hasPendingRecoveryRequest(statuses, terminalStatusId, now) {
  const id = String(terminalStatusId ?? '');
  return (statuses ?? []).some((status) =>
    status?.context === `${RECOVERY_REQUEST_CONTEXT}${id}`
    && status?.state === 'pending'
    && String(status?.description ?? '') === `recovery: requested terminal status ${id}`
    && !pastAbandonedLimit(status, now));
}

/**
 * The failing required status on this exact head that the GATE recovers from and
 * has NOT already been asked to recover, or null. Nobody owes a correction for
 * these, but something has to ask the gate to retry — which is why they are
 * surfaced separately rather than merely skipped.
 */
export function gateRecoveryStatus(combinedStatus, now) {
  // The clock is required, as for `gateRearmStatus`: without it no abandoned request could ever stop holding
  if (!Number.isFinite(Date.parse(String(now ?? '')))) throw new TypeError('gateRecoveryStatus needs the watchdog\'s clock');
  const statuses = combinedStatus?.statuses ?? [];
  // G3b (#1289 round 2, Codex 4440043736) — a head whose newest review status is a success has no failure the gate
  // will recover (`authorizeRecoveryDispatch` refuses every failure id beneath it), so a retryable failure buried
  // under it is not asked about: the green is judged by the re-arm (`gateRearmStatus`) instead
  const newest = statuses.find((status) => status?.context === CORRECTION_STATUS_CONTEXT);
  if (newest?.state === 'success') return null;
  const failing = statuses.find(
    (status) => status?.context === CORRECTION_STATUS_CONTEXT
      && status?.state === 'failure'
      && isRetryableReviewFailureDescription(status?.description),
  ) ?? null;
  if (!failing) return null;
  // Per terminal status id, because that is what the gate authorises against: a
  // request for an older failure says nothing about this one.
  return hasPendingRecoveryRequest(statuses, failing.id, now) ? null : failing;
}

/**
 * G3b (gap-check F2 on #1289) — the green that nothing will arm: this exact head's newest required status is a success
 * carrying an approval token, and the pull request is open, ready (not draft) and has no auto-merge queued. The gate
 * disarms a queued auto-merge before each success and re-arms only after the merge's authorization, so a re-arm lost on
 * any path (G3a′'s five residual ways: a push between the disable and the re-read, a REST read that lagged, a hold
 * whose own write failed, a sibling PR at the same commit, a merge the authorization held) leaves exactly this. The
 * watchdog hands it to the gate's recovery, which re-judges the head from Codex's record and re-arms only through its
 * own authorization (`authorizeRecoveryDispatch` accepts the newest tokened success named exactly).
 *
 * Once per re-judged success, per pull request (#1289 round 3, Codex 4440445763: the request and its settlements are
 * keyed by the pull request too, `rearmRequestContext`, so another PR at the same commit holds nothing here). A request
 * for this success that is pending (within `REARM_REQUEST_ABANDONED_MS`) or settled holds the ask; one marked
 * `REARM_ATTEMPT_FAILED` does not. A consumed settlement for this PR NEWER than the newest success means that success
 * is the re-judge's own (it republishes, then consumes) and was already judged; a success any later run writes is asked
 * about once more. Status ids increase monotonically. That hold lasts `REARM_REQUEST_ABANDONED_MS` (G3b gap-check G1 b):
 * a head disarmed after its re-judge armed it (a person's disable, a body edit lifting an ownership hold, or a later
 * run's disarm whose own lift of the consumption failed) is asked about again, at most once per that limit.
 */
function pastAbandonedLimit(status, now) {
  const at = Date.parse(String(status.updated_at ?? status.created_at ?? ''));
  const current = Date.parse(String(now ?? ''));
  return Number.isFinite(at) && Number.isFinite(current) && current - at > REARM_REQUEST_ABANDONED_MS;
}

function abandonedRequest(status, now) {
  return status?.state === 'pending' && pastAbandonedLimit(status, now);
}

function newerStatusId(candidate, than) {
  try {
    return BigInt(String(candidate ?? '')) > BigInt(String(than ?? ''));
  } catch {
    return false;
  }
}

export function gateRearmStatus(combinedStatus, pullRequest, now) {
  // The clock is required (Stage 1's re-check of bf39f441): without it no hold could ever expire, so a missing or
  // unreadable clock is an error, never a silent hold
  if (!Number.isFinite(Date.parse(String(now ?? '')))) throw new TypeError('gateRearmStatus needs the watchdog\'s clock');
  if (pullRequest?.state !== 'open' || pullRequest?.draft !== false || pullRequest?.auto_merge) return null;
  const number = pullRequest?.number;
  if (number === undefined || number === null || number === '') return null;
  const statuses = combinedStatus?.statuses ?? [];
  const newest = statuses.find((status) => status?.context === CORRECTION_STATUS_CONTEXT) ?? null;
  if (newest?.state !== 'success' || !parseApprovalToken(newest.description)) return null;
  const id = String(newest.id ?? '');
  if (!id) return null;
  const asked = statuses.find((status) => status?.context === rearmRequestContext(id, number));
  if (asked && String(asked.description ?? '') !== REARM_ATTEMPT_FAILED && !abandonedRequest(asked, now)) return null;
  const suffix = `/pr-${number}`;
  if (statuses.some((status) => String(status?.context ?? '').startsWith(RECOVERY_REQUEST_CONTEXT)
    && String(status?.context ?? '').endsWith(suffix)
    && REARM_SETTLEMENTS.includes(String(status?.description ?? ''))
    && newerStatusId(status?.id, newest.id)
    && !pastAbandonedLimit(status, now))) return null;
  return newest;
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
// A short, stable identity for one owed failure. The head does not change when a
// body edit clears a scope refusal, so the NEXT gate run can publish a different
// failure on that same SHA — and with a reason-agnostic key the first notice
// silenced the second, leaving the loop stalled behind a verdict nobody could
// act on. Distinct failures are distinct leases.
export function owedFailureId(reason, detail, occurrence = null) {
  // The OCCURRENCE — the failing status's own id — distinguishes two postings of
  // the same verdict. A scope failure notified, cleared by a body edit, and then
  // reintroduced on the same head with the same owner and description produced
  // an identical key, so the first comment silenced the second and nobody was
  // woken for the new correction. A persisting failure keeps its id across
  // watchdog ticks, so it is still published exactly once.
  const normalized = [reason ?? 'review', String(detail ?? '').trim().toLowerCase(), occurrence ?? '']
    .join('\u001f');
  return `${reason ?? 'review'}-${createHash('sha256').update(normalized).digest('hex').slice(0, 8)}`;
}

export function correctionLeaseMarker({ number, head, owner, kind = 'correction' }) {
  return `${CORRECTION_LEASE_MARKER}pr=${number} head=${head} owner=${owner} kind=${kind} -->`;
}

// The mention lives with the comment that carries it. A handle rendered anywhere
// that cannot notify is the "computed but never asked" defect this lineage kept
// producing, so it is derived from the same set that decides `awakenable` and
// can never name an owner GitHub could not have woken.
export function awakeningMention(owner) {
  return AWAKENABLE_FROM_GITHUB.has(owner) ? `@${owner}` : null;
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
 */
export function assessCorrectionLease({
  pullRequest,
  head,
  body,
  findingHeads = [],
  reason = 'review',
  detail = 'current-head Codex findings',
  findingObservedAt,
  occurrence = null,
  now,
  comments = [],
  graceMs = CORRECTION_LEASE_GRACE_MS,
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
  // Keep the same owner correcting this PR regardless of review-round count.
  const effectiveReason = reason === 'replacement' ? 'review' : reason;
  const routing = correctionRouting({
    declaration,
    head: expected,
    detail,
    reason: effectiveReason,
    pullRequestNumber: pullRequest?.number,
  });

  // Ownership-verdict lifecycle (unit 2A2-i): a readable ownership INCONSISTENCY means the exact head's
  // Correction-Owner trailer and the PR body marker disagree, so the body-declared owner is NOT confirmed by
  // the immutable head. The notice must therefore name NO agent — not in the visible owner label, the
  // instruction, the wake mention, or even the marker key — and never route to the body-derived owner. It is
  // reported as stalled, and reconciling head and body is the only resume action.
  const ownershipInconsistent = isOwnershipInconsistentScopeDetail(effectiveReason, detail);
  const owner = ownershipInconsistent ? 'unconfirmed' : (routing.owner ?? 'undeclared');
  const marker = correctionLeaseMarker({
    number: pullRequest?.number,
    head: expected,
    owner,
    kind: `correction:${owedFailureId(effectiveReason, detail, occurrence)}`,
  });
  const reportedState = (!ownershipInconsistent && routing.awakenable)
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
  // A `claude/**` branch is reserved for Claude: a non-Claude owner can never be reconciled on it, so the
  // resume action must require reconciling toward `claude` (or moving the work off the branch) — never an
  // action that keeps the forbidden owner on both sides, which would leave the one-shot notice with no way
  // to clear the failure.
  const claudeReservedBranch = String(pullRequest?.head?.ref ?? '').startsWith(CLAUDE_BRANCH_PREFIX);
  const resumeAction = reportedState !== CORRECTION_STALLED
    ? null
    : ownershipInconsistent
      ? (claudeReservedBranch
        ? `**Required resume action:** branch \`${pullRequest?.head?.ref}\` is reserved for Claude, and the `
          + 'exact head\'s `Correction-Owner` trailer and the PR body marker do not both name `claude`. '
          + 'Reconcile toward `claude`: set the body marker to `claude` and, if the head trailer is not '
          + 'already `claude`, push a new head whose `Correction-Owner` trailer is `claude`. A non-Claude '
          + 'owner cannot be reconciled on a `claude/**` branch — if this work belongs to another owner, '
          + 'move it to a branch reserved for that owner instead.'
        : '**Required resume action:** the exact head\'s `Correction-Owner` commit trailer and the PR body '
          + 'marker disagree, so no owner is confirmed by the immutable head and none is named or woken. '
          + 'Reconcile them to the same valid owner — set the body marker to match a valid head trailer, or '
          + 'push a new head whose trailer matches the body — as the failing status detail above specifies; '
          + 'the reconciled owner then corrects this head.')
      : routing.owner
        ? `**Required resume action:** if no \`${routing.owner}\` session is already running on `
          + `branch \`${pullRequest?.head?.ref}\`, start one and have it correct head `
          + `\`${expected}\`. The configured GitHub loop can neither start that session nor observe whether one is `
          + 'already running, so check before starting: a second session on the same branch is a '
          + 'real risk of this notice, not a hypothetical one.'
        : '**Required resume action:** declare the correction owner in the PR body, then the '
          + 'declared owner corrects this head.';

  // Neutral, non-attributing instruction for an inconsistent-ownership failure — it must not name the
  // body-declared owner the immutable head does not confirm.
  const neutralInconsistentInstruction = 'No correction owner is confirmed by the immutable head, so this '
    + 'notice routes to no agent and names none. The exact head\'s ownership must be reconciled before any '
    + 'owner is routed.';

  return {
    ...base,
    state: 'notify',
    stalledMinutes,
    reason: 'the failing head has not moved within the bounded interval',
    body: leaseBody({
      resumeAction,
      marker,
      // No wake on an inconsistent-ownership failure: the head does not confirm the body-declared owner.
      mention: ownershipInconsistent ? null : awakeningMention(routing.owner),
      reportedState,
      pullRequestNumber: pullRequest?.number,
      head: expected,
      ownerLabel: ownershipInconsistent
        ? '`unconfirmed`'
        : (routing.owner ? `\`${routing.owner}\`` : '`undeclared`'),
      detail,
      stalledMinutes,
      instruction: ownershipInconsistent ? neutralInconsistentInstruction : routing.instruction,
    }),
  };
}
