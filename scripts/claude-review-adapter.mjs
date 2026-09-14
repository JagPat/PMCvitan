import { CLAUDE_SHADOW_CONTEXT } from './review-policy.mjs';

/**
 * Fail-closed boundary for a future subscription-backed Claude reviewer.
 * GitHub comments and action exit codes are deliberately not accepted. The
 * service must create a GitHub Check Run, as its own installed GitHub App, with
 * an immutable external id binding the PR and SHA and structured output.
 */
export function classifyClaudeShadowReview({
  checkRuns = [],
  expectedHead,
  pullRequestNumber,
  trustedAppSlug,
}) {
  const prefix = `pmcvitan:claude-review:v1:pr-${pullRequestNumber}:sha-${expectedHead}:`;
  const candidates = checkRuns.filter((run) =>
    run?.name === CLAUDE_SHADOW_CONTEXT
    && run?.head_sha === expectedHead
    && run?.app?.slug === trustedAppSlug
    && typeof run?.external_id === 'string'
    && run.external_id.startsWith(prefix));
  const run = candidates.sort((a, b) => Date.parse(b.completed_at ?? 0) - Date.parse(a.completed_at ?? 0))[0];
  if (!run) return { state: 'missing', authoritative: false };
  if (run.status !== 'completed' || !run.completed_at) return { state: 'partial', authoritative: false };
  if (run.conclusion !== 'success') return { state: run.conclusion ?? 'error', authoritative: false };
  let result;
  try {
    result = JSON.parse(run.output?.summary ?? '');
  } catch {
    return { state: 'malformed', authoritative: false };
  }
  if (result.schema !== 1 || result.headSha !== expectedHead || result.pullRequest !== pullRequestNumber) {
    return { state: 'replayed', authoritative: false };
  }
  if (result.outcome !== 'clear' || result.openFindings !== 0 || result.complete !== true) {
    return { state: result.openFindings > 0 ? 'changes_required' : 'incomplete', authoritative: false };
  }
  return { state: 'clear', authoritative: false, runId: run.id };
}
