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
export const CORRECTION_OWNERS = ['claude', 'cursor'];
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
];

export function isRetryableReviewFailureDescription(description) {
  const text = String(description ?? '');
  // Re-evaluate failures written by the retired round-reset gate. This does
  // not clear a status: the ordinary CI and current-head review guards run again.
  return /^review: \d+ finding-bearing heads reached the review-round limit\b/u.test(text)
    || RETRYABLE_REVIEW_FAILURES.some((marker) => text.includes(marker));
}
