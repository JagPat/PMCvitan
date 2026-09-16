import { CLAUDE_SHADOW_CONTEXT, LINEAGE_BASE_REF } from './review-policy.mjs';
import { evidenceArtifactName } from './claude-shadow-review.mjs';

/**
 * Fail-closed consumer for the subscription-backed hosted shadow reviewer.
 * The trusted default-branch publisher creates this check; comments, the
 * Claude action's exit code, and candidate-authored checks are not accepted.
 */
export async function classifyClaudeShadowReview({
  checkRuns = [],
  expectedHead,
  expectedBase,
  pullRequestNumber,
  trustedAppSlug = 'github-actions',
  verifyProducer,
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
    || !Number.isInteger(result.publisherRunId)
    || !Number.isInteger(result.publisherRunAttempt)
    || result.workflowRef !== `JagPat/PMCvitan/.github/workflows/claude-shadow-review.yml@refs/heads/${LINEAGE_BASE_REF}`
    || result.workflowExecutionRef !== `refs/heads/${LINEAGE_BASE_REF}`
    || result.trustedWorkflowRef !== `JagPat/PMCvitan/.github/workflows/claude-shadow-review.yml@refs/heads/${LINEAGE_BASE_REF}`
    || result.trustedExecutionRef !== `refs/heads/${LINEAGE_BASE_REF}`
    || !/^[0-9a-f]{40}$/u.test(result.workflowSha ?? '')
    || !/^[0-9a-f]{40}$/u.test(result.trustedWorkflowSha ?? '')
    || result.workflowSha !== result.trustedWorkflowSha
    || result.targetTipSha !== expectedBase
    || result.testedBaseSha !== expectedBase
    || !/^[0-9a-f]{40}$/u.test(result.testedMergeSha ?? '')
    || !Number.isInteger(result.identityRunAttempt)
    || result.identityRunAttempt < 1
    || result.identityRunAttempt > result.runAttempt
    || !Number.isInteger(result.ciIdentityArtifactId)
    || !['clear', 'changes_required', 'incomplete', 'malformed', 'reviewer_error'].includes(result.state)
    || !Number.isInteger(result.findingCount)
    || result.findingCount < 0
    || result.findingCount > 100
    || !Number.isInteger(result.artifact?.id)
    || !/^sha256:[0-9a-f]{64}$/u.test(result.artifact?.digest ?? '')
    || result.artifact?.name !== evidenceArtifactName(result, result, {
      state: result.state,
      findings: Array.from({ length: result.findingCount }, () => null),
    })
    || !run.external_id.endsWith(
      `run-${result.runId}:attempt-${result.runAttempt}:publisher-${result.publisherRunId}:publisher-attempt-${result.publisherRunAttempt}`,
    )
  ) {
    return { state: 'replayed', authoritative: false };
  }
  if (result.state !== 'clear' || result.findingCount !== 0) {
    return { state: result.findingCount > 0 ? 'changes_required' : 'incomplete', authoritative: false };
  }
  if (typeof verifyProducer !== 'function' || !await verifyProducer(run, result)) {
    return { state: 'untrusted_producer', authoritative: false };
  }
  return { state: 'shadow_clear', authoritative: false, runId: run.id };
}
