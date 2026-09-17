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
export const CORRECTION_OWNERS = ['claude', 'cursor', 'codex'];
// Wake integrations enabled in this repository, not a product capability inventory.
export const AWAKENABLE_FROM_GITHUB = new Set(['claude']);
export const CORRECTION_STALLED = 'correction_stalled';
// An hourly watchdog reports an unchanged correction after 45-105 minutes.
export const CORRECTION_LEASE_GRACE_MS = Number(
  process.env.CORRECTION_LEASE_GRACE_MS ?? 45 * 60_000,
);
export const LINEAGE_BASE_REF = 'main';
export const CODEX_LOGIN = 'chatgpt-codex-connector[bot]';
export const CODEX_GRAPHQL_LOGIN = 'chatgpt-codex-connector';
export const REQUIRED_CHECKS = [...GATE_CHECKS, ...PRODUCT_CHECKS];
export const STATUS_CONTEXT = 'codex-current-head';
export const CLAUDE_SHADOW_CONTEXT = 'claude-independent-review';
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

// A merge attempted on a fully authorized exact head that GitHub did not confirm merged leaves a
// RECOVERABLE obligation, not a terminal review failure, in two distinct cases: (1) an outcome that is
// genuinely uncertain — transport loss, a 5xx, or an unreadable confirming read — where completion is
// unknown; and (2) a CONFIRMED readable-405 refusal by branch protection while the gates are green,
// for which the selected contract is a durable, freshly authorized exact-SHA DIRECT RETRY (POLICY.md
// permits a direct automatic merge OR GitHub auto-merge; it does not mandate queueing a 405). The next
// dispatch re-authorizes the exact head/owner/CI/findings and retries the merge through the existing
// gate-recovery lane; it is fail-safe because the merge is re-confirmed before any second attempt, and
// a superseded head (changed head/base/owner or a closed PR) is held, never handed this obligation. A
// single stable marker keeps the recovery idempotent: a repeated unchanged failure re-uses this exact
// description (no new occurrence), while a fresh failure after a completed recovery mints one.
export const MERGE_RECOVERY_OWED = 'review: exact-head merge unconfirmed — recovery owed';

const RETRYABLE_REVIEW_FAILURES = [
  'Codex review timed out',
  'Codex evidence changed during final verification',
  'review: Required CI changed during current-head Codex review',
  'review: bootstrap exact-head review requested',
  MERGE_RECOVERY_OWED,
];

export function isRetryableReviewFailureDescription(description) {
  const text = String(description ?? '');
  // Re-evaluate failures written by the retired round-reset gate. This does
  // not clear a status: the ordinary CI and current-head review guards run again.
  return /^review: \d+ finding-bearing heads reached the review-round limit\b/u.test(text)
    || RETRYABLE_REVIEW_FAILURES.some((marker) => text.includes(marker));
}

// Real prior clean evidence behind a MERGE_RECOVERY_OWED head, shared by the gate's merge
// authorization and the merged-backlog reconciliation so the two cannot drift. `statuses` is the
// newest-first history. Skip ONLY consecutive leading exact owed markers; the very next STATUS_CONTEXT
// status must ITSELF be a clean success. A pending review, an error, or any non-owed failure (a real
// current or buried finding) between the clean success and the owed marker therefore denies clearance
// — an owed obligation is never reinterpreted as a clean result, and a stale success never revives it.
export function priorCleanReviewEvidence(statuses) {
  const context = (statuses ?? []).filter((status) => status?.context === STATUS_CONTEXT);
  let index = 0;
  while (
    index < context.length
    && context[index].state === 'failure'
    && context[index].description === MERGE_RECOVERY_OWED
  ) {
    index += 1;
  }
  return context[index]?.state === 'success';
}
