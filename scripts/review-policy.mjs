// Shared definitions for PR review and correction policy. No imports: this leaf
// is safe for the trusted controller, PR-side preflight and CI evidence readers.
// docs/POLICY.md explains requirements, rationale, exceptions and enforcement.
// Keep environment override names and defaults compatible with existing workflows.

export const REVIEW_SCOPE_ENFORCE_AFTER_PR = 246;
export const PRE_REVIEW_ENFORCE_AFTER_PR = 345;
export const STANDARD_MAX_FILES = 20;
export const STANDARD_MAX_CHANGED_LINES = 1_500;
export const REPLACEMENT_REQUIRED_LABEL = 'review-replacement-required';
export const REQUIRED_PRE_REVIEW_CHECKS = [
  'concurrency-serialization',
  'old-release-migration-compatibility',
  'trigger-alternate-writers',
  'authorization-tenancy',
  'ci-reproduce-first',
];
export const REQUIRED_INVARIANTS = [
  'authorization-tenancy',
  'civil-time-lifecycle',
  'concurrency-idempotency',
  'data-integrity-conservation',
  'offline-reconciliation',
  'ui-server-parity',
];
export const STATUS_DOCUMENT = 'docs/STATUS.md';
export const PRODUCT_CHECKS = ['web', 'api', 'e2e', 'api-e2e', 'upgrade-proof'];
export const GATE_CHECKS = ['review-scope', 'battery-plan'];
export const MAX_REVIEW_ATTEMPTS = 2;
// 40 minutes covers measured ~29-minute API jobs; 25 minutes covers measured
// 13-23-minute Codex latency. Keep the workflow budget above both review attempts
// plus CI settlement and overhead (validated by workflow tests).
export const CHECK_TIMEOUT_MS = Number(process.env.CHECK_TIMEOUT_MS ?? 40 * 60_000);
export const REVIEW_TIMEOUT_MS = Number(process.env.REVIEW_TIMEOUT_MS ?? 25 * 60_000);
export const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS ?? 15_000);
// Merge-eligible correction owners: a declared owner here may (once a later unit's promotion hold
// exists) be promoted and merged. The Codex GitHub implementation task and reviewer share one bot
// identity, so `codex` is NOT here — it is a CANDIDATE (below), recognised in-flight but never merged
// and never awakened.
export const CORRECTION_OWNERS = ['claude', 'cursor'];
// Recognised in-flight CANDIDATE owners: a corrective HEAD may declare one and the ownership verdict
// tracks it, but it is never merge-eligible and never awakenable, and it is NOT admitted to the routable
// set above — so admitting a candidate here does not, by itself, let any consumer route, wake, or merge
// it. A candidate declaration is reported as non-`declared` by the parsers: the scope gate admits it (so
// its head gets CI and review), routing stalls, and the promotion hold holds its reviewed head. Task and
// reviewer share the Codex bot identity, so it stays held pending independent reviewer activation.
export const CANDIDATE_CORRECTION_OWNERS = ['codex'];
// Wake integrations enabled in this repository, not a product capability inventory.
export const AWAKENABLE_FROM_GITHUB = new Set(['claude']);
export const CORRECTION_STALLED = 'correction_stalled';
// ── Canonical ownership status vocabulary (owner-verdict split, unit 2A1) ─────────────────────────────
// The single machine-consumable vocabulary later units publish and the watchdog consumes. Defined here as
// pure strings/classifiers; NO consumer in this unit reads them (no recovery dispatch, no watchdog routing,
// no status publication) — those wirings are unit 2A2.
//
// A retryable INFRASTRUCTURE failure, not an ownership fault: the exact HEAD commit could not be read (or
// the git-faithful trailer primitive could not run), so the trailer's validity is unknown and no correction
// is owed. A later unit adds it to the retryable set and teaches the recovery authorizer to consume it.
export const OWNERSHIP_READ_RETRY = 'validation: head commit ownership temporarily unreadable — retrying';
// A consistent CANDIDATE head (e.g. codex) is held pending independent reviewer activation, never merged.
export const OWNERSHIP_CANDIDATE_HELD = 'validation: candidate owner held for independent reviewer activation';
// Leads a `ci:` failure whose failed `review-scope` job the controller's own scope check of the same exact
// head ADMITS: a CI failure, not an ownership refusal, so the lease must not read it as `scope`.
export const CI_SCOPE_ADMITTED = 'scope check admits this exact head';
// A READABLE ownership fault: the exact head's Correction-Owner trailer is missing, invalid, or disagrees
// with the mandatory PR body marker (including a branch-reservation contradiction). Written as the leading
// text of a `scope:` failure detail.
export const OWNERSHIP_INCONSISTENT_SCOPE = 'unresolved or inconsistent correction ownership';
export function isOwnershipInconsistentScopeDetail(reason, detail) {
  return reason === 'scope'
    && String(detail ?? '').trimStart().startsWith(OWNERSHIP_INCONSISTENT_SCOPE);
}
// The two remedies for a readable ownership fault. A VALID trailer whose owner the branch permits as a body
// marker is body-edit recoverable; a missing/invalid trailer, or a branch that forbids the trailer owner as
// a marker, needs a new head. Both lead with the signature above; the `body` variant carries the fixed
// `is valid` phrase inside GitHub's 140-char truncation so a reader tells them apart without a second read.
export function ownershipInconsistentScopeDetail(remedy, owner) {
  return remedy === 'body'
    ? `${OWNERSHIP_INCONSISTENT_SCOPE} — this head's Correction-Owner trailer (${owner}) is valid but the `
      + `PR body marker is missing or does not match; set exactly one body marker to ${owner}`
    : `${OWNERSHIP_INCONSISTENT_SCOPE} — this exact head needs a single `
      + 'valid Correction-Owner commit trailer matching the PR body marker';
}
export function isBodyOnlyOwnershipRecoveryDetail(reason, detail) {
  return isOwnershipInconsistentScopeDetail(reason, detail) && /\bis valid\b/u.test(String(detail ?? ''));
}
// An hourly watchdog reports an unchanged correction after 45-105 minutes.
export const CORRECTION_LEASE_GRACE_MS = Number(
  process.env.CORRECTION_LEASE_GRACE_MS ?? 45 * 60_000,
);
export const LINEAGE_BASE_REF = 'main';
export const CODEX_LOGIN = 'chatgpt-codex-connector[bot]';
export const CODEX_GRAPHQL_LOGIN = 'chatgpt-codex-connector';

/**
 * Is this Codex review nothing but replies in threads opened on an EARLIER head than its own?
 *
 * GitHub files every inline reply as a review stamped with the head at the time of the reply. So when a
 * human comment mentions Codex in an old finding's thread, the connector's answer (an account-setup
 * prompt, on #638) arrives as a Codex review of the CURRENT head. Read as a finding, it holds a head no
 * one reviewed and counts that head as finding-bearing. A review is exempt only when all of these are
 * proven:
 * - its body is blank (every real Codex review carries its "Codex Review" summary);
 * - it has an id and owns at least one comment;
 * - every one of its comments is a Codex reply whose thread is PROVEN to belong to another head: its
 *   `in_reply_to_id` chain resolves, comment by comment, to a root that is in `comments` and replies to
 *   nothing, and both that root and the reply itself were first posted against a head other than the
 *   review's own (#639 Codex finding 4110382385: the reply's own SHA alone is not the thread's).
 * A review with no comments, or with any comment that opens a thread, sits in a thread of its own head, or
 * whose chain is orphaned, cyclic or mismatched, is not exempt. `comments` must be the complete, paginated
 * review-comment list of every author, because the root may be anyone's.
 */
export function isCodexReplyOnlyReview(review, comments) {
  if (review?.user?.login !== CODEX_LOGIN) return false;
  const body = review?.body;
  if (body !== undefined && body !== null && (typeof body !== 'string' || body.trim() !== '')) return false;
  const head = review?.commit_id;
  if (!Number.isInteger(review?.id) || typeof head !== 'string' || head.length === 0) return false;
  const all = Array.isArray(comments) ? comments : [];
  const byId = new Map();
  for (const comment of all) {
    if (Number.isInteger(comment?.id)) byId.set(comment.id, comment);
  }
  const postedOn = (comment) => comment?.original_commit_id ?? comment?.commit_id;
  const onAnotherHead = (comment) => typeof postedOn(comment) === 'string' && postedOn(comment) !== head;
  // The thread's root, or null when the chain is broken: a missing parent, or more steps than there are
  // comments (a cycle).
  const rootOf = (comment) => {
    let current = comment;
    for (let steps = 0; steps <= all.length; steps += 1) {
      if (current.in_reply_to_id == null) return current;
      current = byId.get(current.in_reply_to_id);
      if (!current) return null;
    }
    return null;
  };
  const own = all.filter(
    (comment) => comment?.user?.login === CODEX_LOGIN && comment.pull_request_review_id === review.id,
  );
  return own.length > 0 && own.every((comment) => {
    if (comment.in_reply_to_id == null || !onAnotherHead(comment)) return false;
    const root = rootOf(comment);
    return root !== null && root !== comment && onAnotherHead(root);
  });
}
export const REQUIRED_CHECKS = [...GATE_CHECKS, ...PRODUCT_CHECKS];
export const STATUS_CONTEXT = 'codex-current-head';
export const CLAUDE_SHADOW_CONTEXT = 'claude-independent-review';
// The trusted-controller status that WOULD replace `codex-current-head` when the role transfer activates.
// Like `codex-current-head`, it is published only by the trusted controller from ADAPTER-VERIFIED shadow
// evidence (a `shadow_clear` from `classifyClaudeShadowReview` after `verifyClaudeShadowProducer`), never
// the raw `claude-independent-review` producer check name — so a PR-emitted check of that name cannot
// satisfy it. No consumer sets or requires it yet; the activation-readiness contract only names it as the
// gate a later, operator-authorized switch would install.
export const CLAUDE_STATUS_CONTEXT = 'claude-current-head';
export const ROOT_CAUSE_ADVISORY_AFTER_FINDING_HEADS = 2;

export function requiredChecksForPullRequest(pullRequestNumber) {
  if (
    Number.isInteger(pullRequestNumber)
    && pullRequestNumber > 0
    && pullRequestNumber <= REVIEW_SCOPE_ENFORCE_AFTER_PR
  ) {
    // Neither job exists on pre-policy branches; requiring them would strand
    // an older PR on a check it cannot emit.
    return REQUIRED_CHECKS.filter(
      (name) => name !== 'review-scope' && name !== 'battery-plan',
    );
  }
  return REQUIRED_CHECKS;
}

// Review history can prompt an audit, but cannot refuse the next correction.
// The caller still validates live head/base, CI and current-head review evidence.
export function reviewHistoryPolicy(findingHeads) {
  const findingHeadCount = findingHeads.length;
  return {
    state: 'reviewing',
    required: false,
    allowed: true,
    findingHeadCount,
    findingHeads,
    ...(findingHeadCount >= ROOT_CAUSE_ADVISORY_AFTER_FINDING_HEADS
      ? { rootCauseAdvisory: true, threshold: ROOT_CAUSE_ADVISORY_AFTER_FINDING_HEADS }
      : {}),
  };
}

const RETRYABLE_REVIEW_FAILURES = [
  'Codex review timed out',
  'Codex evidence changed during final verification',
  'review: Required CI changed during current-head Codex review',
  'review: bootstrap exact-head review requested',
  // Ownership-verdict lifecycle (unit 2A2-i): an `unreadable` head is a retryable INFRASTRUCTURE fault, not
  // an ownership fault — the exact head could not be read, so the trailer's validity is unknown and no
  // correction is owed. Classifying it retryable is what teaches the recovery authorizer to retry and the
  // watchdog to open no correction lease. A later unit publishes this status; here the consumers recognise it.
  OWNERSHIP_READ_RETRY,
];

export function isRetryableReviewFailureDescription(description) {
  const text = String(description ?? '');
  // Re-evaluate failures written by the retired round-reset gate. This does
  // not clear a status: the ordinary CI and current-head review guards run again.
  return /^review: \d+ finding-bearing heads reached the review-round limit\b/u.test(text)
    || RETRYABLE_REVIEW_FAILURES.some((marker) => text.includes(marker));
}
