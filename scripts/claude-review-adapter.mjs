import { CLAUDE_SHADOW_CONTEXT } from './review-policy.mjs';

/**
 * Fail-closed consumer for the subscription-backed hosted shadow reviewer.
 * The trusted default-branch publisher creates this check; comments, the
 * Claude action's exit code, and candidate-authored checks are not accepted.
 */
export function classifyClaudeShadowReview({
  checkRuns = [],
  expectedHead,
  expectedBase,
  pullRequestNumber,
  trustedAppSlug = 'github-actions',
}) {
  const prefix = `pmcvitan:claude-shadow:v1:repo-JagPat/PMCvitan:pr-${pullRequestNumber}:base-${expectedBase}:head-${expectedHead}:run-`;
  const candidates = checkRuns.filter((run) =>
    run?.name === CLAUDE_SHADOW_CONTEXT
    && run?.head_sha === expectedHead
    && run?.app?.slug === trustedAppSlug
    && typeof run?.external_id === 'string'
    && run.external_id.startsWith(prefix));
  // Check-run IDs order new attempts even before they acquire a completion time.
  const run = candidates.sort((a, b) => b.id - a.id)[0];
  if (!run) return { state: 'missing', authoritative: false };
  if (run.status !== 'completed' || !run.completed_at) return { state: 'partial', authoritative: false };
  if (run.conclusion !== 'success') return { state: run.conclusion ?? 'error', authoritative: false };
  let result;
  try {
    result = JSON.parse(run.output?.summary ?? '');
  } catch {
    return { state: 'malformed', authoritative: false };
  }
  if (
    result.schema !== 1
    || result.repository !== 'JagPat/PMCvitan'
    || result.headSha !== expectedHead
    || result.baseSha !== expectedBase
    || result.pullRequest !== pullRequestNumber
    || !Number.isInteger(result.runId)
    || !Number.isInteger(result.runAttempt)
    || !run.external_id.endsWith(`run-${result.runId}:attempt-${result.runAttempt}`)
  ) {
    return { state: 'replayed', authoritative: false };
  }
  if (result.state !== 'clear' || result.findingCount !== 0) {
    return { state: result.findingCount > 0 ? 'changes_required' : 'incomplete', authoritative: false };
  }
  return { state: 'clear', authoritative: false, runId: run.id };
}
