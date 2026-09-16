import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { authorizeShadowEvent, authorizeShadowRequest, ciMergeIdentityArtifactName, evidenceArtifactName, externalId, requireChangedFileCoverage, validateClaudeReview } from './claude-shadow-review.mjs';

const headSha = 'a'.repeat(40);
const baseSha = 'b'.repeat(40);
const workflowSha = 'd'.repeat(40);
const mergeSha = 'e'.repeat(40);
const identityName = ciMergeIdentityArtifactName({ testedBaseSha: baseSha, headSha, testedMergeSha: mergeSha });
const identity = { trustedWorkflowSha: workflowSha, targetTipSha: baseSha, comparisonBaseSha: baseSha, testedBaseSha: baseSha, testedMergeSha: mergeSha, ciIdentityArtifacts: [{ name: identityName, expired: false }], ciWorkflowChanged: false, diffConsistent: true };
const binding = { repository: 'JagPat/PMCvitan', pullRequest: 600, headSha, baseSha, trustedWorkflowSha: workflowSha, targetTipSha: baseSha, testedBaseSha: baseSha, testedMergeSha: mergeSha, runId: 42, runAttempt: 2 };
const review = { schema: 1, ...binding, complete: true, filesReviewed: ['a.js'], findings: [] };

test('structured interpretation derives clearance only from a valid bound empty finding set', () => {
  assert.equal(validateClaudeReview(JSON.stringify(review), binding).state, 'clear');
  const finding = { severity: 'P1', path: 'a.js', line: 1, rule: 'POLICY', description: 'broken', example: 'x races y' };
  assert.equal(validateClaudeReview(JSON.stringify({ ...review, findings: [finding] }), binding).state, 'changes_required');
  for (const broken of [
    '', '{}', JSON.stringify({ ...review, headSha: 'c'.repeat(40) }),
    JSON.stringify({ ...review, baseSha: 'c'.repeat(40) }),
    JSON.stringify({ ...review, runAttempt: 1 }),
    JSON.stringify({ ...review, complete: false }),
    JSON.stringify({ ...review, findings: [{ ...finding, example: '' }] }),
  ]) assert.equal(validateClaudeReview(broken, binding).state, 'malformed');
});

test('an empty finding set is incomplete until every changed file was reviewed', () => {
  const result = validateClaudeReview(JSON.stringify(review), binding);
  assert.equal(requireChangedFileCoverage(result, ['a.js']).state, 'clear');
  assert.equal(requireChangedFileCoverage(result, ['a.js', 'unreviewed.js']).state, 'incomplete');
});

test('workflow authorization refuses stale, fork, failed CI, wrong base, and closed PR', () => {
  const live = { number: 600, state: 'open', head: { sha: headSha, repo: { full_name: binding.repository } }, base: { ref: 'main', sha: baseSha, repo: { full_name: binding.repository } }, merge_commit_sha: mergeSha };
  const event = { action: 'completed', workflow_sha: workflowSha, repository: { full_name: binding.repository }, workflow_run: { id: 42, run_attempt: 2, name: 'CI', event: 'pull_request', status: 'completed', conclusion: 'success', head_sha: headSha, head_repository: { full_name: binding.repository }, pull_requests: [{ number: 600 }], path: '.github/workflows/ci.yml' } };
  assert.deepEqual(authorizeShadowEvent(event, live, identity), { allowed: true, binding });
  for (const [changedEvent, changedLive] of [
    [{ ...event, workflow_run: { ...event.workflow_run, conclusion: 'failure' } }, live],
    [{ ...event, workflow_run: { ...event.workflow_run, head_sha: 'c'.repeat(40) } }, live],
    [{ ...event, workflow_run: { ...event.workflow_run, head_repository: { full_name: 'fork/repo' } } }, live],
    [event, { ...live, state: 'closed' }],
    [event, { ...live, base: { ...live.base, ref: 'other' } }],
  ]) assert.equal(authorizeShadowEvent(changedEvent, changedLive, identity).allowed, false);
  assert.equal(authorizeShadowEvent({ action: 'completed', workflow_run: {} }, live, identity).allowed, false);
});

test('artifact identity binds trusted run and interpreted outcome', () => {
  const name = evidenceArtifactName(binding, { publisherRunId: 84, publisherRunAttempt: 3 }, { state: 'clear', findings: [] });
  for (const value of [Buffer.from(binding.repository).toString('base64url'), 'pr-600', headSha, baseSha, 'ci-42-2', 'publisher-84-3', 'state-clear', 'findings-0']) assert.match(name, new RegExp(value));
});

test('an older overlapping completion cannot authorize after the live head advances', async () => {
  let releaseOld;
  const oldBlocked = new Promise((resolve) => { releaseOld = resolve; });
  let livePull = { number: 600, state: 'open', head: { sha: headSha, repo: { full_name: binding.repository } }, base: { ref: 'main', sha: baseSha, repo: { full_name: binding.repository } }, merge_commit_sha: mergeSha };
  const sourceRun = (head, id) => ({ id, run_attempt: 1, name: 'CI', event: 'pull_request', status: 'completed', conclusion: 'success', head_sha: head, head_repository: { full_name: binding.repository }, pull_requests: [{ number: 600 }], path: '.github/workflows/ci.yml' });
  const authorizeAfter = async (barrier, expectedHead, run) => {
    await barrier;
    return authorizeShadowRequest({ repository: binding.repository, pullRequestNumber: 600, expectedHead, trustedWorkflowSha: workflowSha, ...identity, sourceRun: run, livePull });
  };
  const oldCompletion = authorizeAfter(oldBlocked, headSha, sourceRun(headSha, 41));
  const latestHead = 'c'.repeat(40);
  const latestMerge = 'f'.repeat(40);
  livePull = { ...livePull, head: { ...livePull.head, sha: latestHead }, merge_commit_sha: latestMerge };
  const latestIdentity = { ...identity, testedMergeSha: latestMerge, ciIdentityArtifacts: [{ name: ciMergeIdentityArtifactName({ testedBaseSha: baseSha, headSha: latestHead, testedMergeSha: latestMerge }), expired: false }] };
  const latestCompletion = await (async () => authorizeShadowRequest({ repository: binding.repository, pullRequestNumber: 600, expectedHead: latestHead, ...latestIdentity, trustedWorkflowSha: workflowSha, sourceRun: sourceRun(latestHead, 42), livePull }))();
  releaseOld();
  assert.equal(latestCompletion.allowed, true);
  assert.deepEqual(await oldCompletion, { allowed: false, state: 'unauthorized_or_stale' });
});

test('manual bootstrap dispatch uses the same live PR and completed CI authorization', () => {
  const livePull = { number: 600, state: 'open', head: { sha: headSha, repo: { full_name: binding.repository } }, base: { ref: 'main', sha: baseSha, repo: { full_name: binding.repository } }, merge_commit_sha: mergeSha };
  const sourceRun = { id: 42, run_attempt: 2, name: 'CI', event: 'pull_request', status: 'completed', conclusion: 'success', head_sha: headSha, head_repository: { full_name: binding.repository }, pull_requests: [{ number: 600 }], path: '.github/workflows/ci.yml' };
  assert.deepEqual(authorizeShadowRequest({ repository: binding.repository, pullRequestNumber: 600, expectedHead: headSha, ...identity, trustedWorkflowSha: workflowSha, sourceRun, livePull }), { allowed: true, binding });
  for (const changed of [
    { sourceRun: { ...sourceRun, name: 'Other' } },
    { sourceRun: { ...sourceRun, pull_requests: [{ number: 601 }] } },
    { sourceRun: { ...sourceRun, status: 'in_progress', conclusion: null } },
    { expectedHead: 'c'.repeat(40) },
    { expectedRunAttempt: 1 },
    { testedBaseSha: 'f'.repeat(40) },
    { comparisonBaseSha: 'f'.repeat(40) },
    { ciIdentityArtifacts: [] },
    { ciWorkflowChanged: true },
    { diffConsistent: false },
  ]) assert.equal(authorizeShadowRequest({ repository: binding.repository, pullRequestNumber: 600, expectedHead: headSha, ...identity, trustedWorkflowSha: workflowSha, sourceRun, livePull, ...changed }).allowed, false);
});

test('external id binds repository, PR, base, head, run and attempt', () => {
  const id = externalId(binding, { publisherRunId: 84, publisherRunAttempt: 3 });
  for (const value of ['JagPat/PMCvitan', '600', headSha, baseSha, '42', '2', '84', '3']) assert.match(id, new RegExp(value));
});

test('hosted workflow is shadow-only, pinned, read-only, and publishes from trusted code', () => {
  const workflow = readFileSync('.github/workflows/claude-shadow-review.yml', 'utf8');
  assert.match(workflow, /workflow_run:/u);
  assert.match(workflow, /workflow_dispatch:/u);
  assert.match(workflow, /group: claude-shadow-review-pr-\$\{\{ github\.event_name == 'workflow_dispatch' && inputs\.pr_number \|\| github\.event\.workflow_run\.pull_requests\[0\]\.number \|\| github\.run_id \}\}/u);
  assert.match(workflow, /cancel-in-progress: true/u);
  assert.match(workflow, /anthropics\/claude-code-action@7b0b255830a1fab6e602658672acad11c12d841d/u);
  assert.match(workflow, /claude_code_oauth_token: \$\{\{ secrets\.CLAUDE_CODE_OAUTH_TOKEN \}\}/u);
  assert.match(workflow, /contents: read/u);
  assert.doesNotMatch(workflow, /contents: write|pull-requests: write|statuses: write/u);
  assert.match(workflow.match(/publish:[\s\S]*/u)[0], /actions: read/u);
  assert.doesNotMatch(workflow, /actions: write/u);
  assert.match(workflow, /publish:[\s\S]*checks: write/u);
  assert.match(workflow, /actions\/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02/u);
  assert.doesNotMatch(workflow.match(/review:[\s\S]*?\n  publish:/u)[0], /checks: write/u);
  assert.doesNotMatch(workflow, /Bash\(/u);
  // --allowedTools only pre-approves; the real read-only boundary needs --tools to constrain
  // built-ins and --disallowedTools to deny the MCP servers the action enables from project config.
  assert.match(workflow, /--tools "Read,Glob,Grep"/u);
  assert.match(workflow, /--disallowedTools "mcp__\*"/u);
  assert.match(workflow, /git -C candidate diff --no-ext-diff --no-textconv/u);
  assert.match(workflow, /publish:[\s\S]*github\.event\.workflow_run\.event == 'pull_request'/u);
  assert.match(workflow, /ref: \$\{\{ github\.workflow_sha \}\}/u);
  assert.match(workflow, /node scripts\/claude-shadow-review\.mjs publish/u);
  assert.doesNotMatch(workflow, /node candidate\//u);
});
