import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { actionArtifacts, authorizeShadowEvent, authorizeShadowRequest, ciMergeIdentityArtifactName, evidenceArtifactName, externalId, main, normalizeArtifactDigest, requireChangedFileCoverage, selectCiIdentityArtifact, validateClaudeReview } from './claude-shadow-review.mjs';

const headSha = 'a'.repeat(40);
const baseSha = 'b'.repeat(40);
const workflowSha = 'd'.repeat(40);
const mergeSha = 'e'.repeat(40);
const identityRunAttempt = 2;
const identityName = ciMergeIdentityArtifactName({ testedBaseSha: baseSha, headSha, testedMergeSha: mergeSha, identityRunAttempt });
const identityArtifact = { id: 99, name: identityName, expired: false, workflow_run: { id: 42, head_sha: headSha } };
const workflowRef = 'JagPat/PMCvitan/.github/workflows/claude-shadow-review.yml@refs/heads/main';
const executionRef = 'refs/heads/main';
const identity = { trustedWorkflowSha: workflowSha, trustedWorkflowRef: workflowRef, trustedExecutionRef: executionRef, targetTipSha: baseSha, comparisonBaseSha: baseSha, testedBaseSha: baseSha, testedMergeSha: mergeSha, identityRunAttempt, ciIdentityArtifactId: 99, ciIdentityArtifacts: [identityArtifact], ciWorkflowChanged: false, diffConsistent: true };
const binding = { repository: 'JagPat/PMCvitan', pullRequest: 600, headSha, baseSha, trustedWorkflowSha: workflowSha, trustedWorkflowRef: workflowRef, trustedExecutionRef: executionRef, targetTipSha: baseSha, testedBaseSha: baseSha, testedMergeSha: mergeSha, identityRunAttempt, ciIdentityArtifactId: 99, runId: 42, runAttempt: 2 };
const review = { schema: 1, ...binding, complete: true, filesReviewed: ['a.js'], findings: [] };

test('artifact digest normalization accepts real action and API shapes only', () => {
  const hex = '8c76db7f8760544c8d1e307e1a8bef36e75785f3319bbdfeac9e1f430dfe8334';
  assert.equal(normalizeArtifactDigest(hex), `sha256:${hex}`);
  assert.equal(normalizeArtifactDigest(`sha256:${hex}`), `sha256:${hex}`);
  for (const malformed of ['', `sha512:${hex}`, `sha256:${hex.slice(1)}`, `${hex}00`, 'g'.repeat(64)]) {
    assert.equal(normalizeArtifactDigest(malformed), null);
  }
  assert.notEqual(normalizeArtifactDigest(hex), `sha256:${'d'.repeat(64)}`, 'a different server digest cannot compare equal');
});

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
  const latestIdentity = { ...identity, testedMergeSha: latestMerge, identityRunAttempt: 1, ciIdentityArtifactId: 100, ciIdentityArtifacts: [{ id: 100, name: ciMergeIdentityArtifactName({ testedBaseSha: baseSha, headSha: latestHead, testedMergeSha: latestMerge, identityRunAttempt: 1 }), expired: false, workflow_run: { id: 42, head_sha: latestHead } }] };
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
    { trustedWorkflowRef: 'JagPat/PMCvitan/.github/workflows/other.yml@refs/heads/main' },
    { trustedWorkflowRef: 'Other/Repo/.github/workflows/claude-shadow-review.yml@refs/heads/main' },
    { trustedExecutionRef: 'refs/heads/codex/untrusted-workflow' },
    { testedBaseSha: 'f'.repeat(40) },
    { comparisonBaseSha: 'f'.repeat(40) },
    { ciIdentityArtifacts: [] },
    { ciWorkflowChanged: true },
    { diffConsistent: false },
  ]) assert.equal(authorizeShadowRequest({ repository: binding.repository, pullRequestNumber: 600, expectedHead: headSha, ...identity, trustedWorkflowSha: workflowSha, sourceRun, livePull, ...changed }).allowed, false);
});

test('actual artifact selector supports observed partial and full reruns and rejects ambiguity', () => {
  const artifact = (id, attempt) => ({ id, name: ciMergeIdentityArtifactName({ testedBaseSha: baseSha, headSha, testedMergeSha: mergeSha, identityRunAttempt: attempt }), expired: false, workflow_run: { id: 42, head_sha: headSha } });
  const partial = selectCiIdentityArtifact({ artifacts: [artifact(1, 1)], sourceRunId: 42, expectedHead: headSha, sourceRunAttempt: 2 });
  assert.equal(partial.identityRunAttempt, 1, 'partial rerun carries the attempt-1 artifact even though server jobs are relabelled attempt 2');
  const full = selectCiIdentityArtifact({ artifacts: [artifact(1, 1), artifact(2, 2)], sourceRunId: 42, expectedHead: headSha, sourceRunAttempt: 2 });
  assert.equal(full.identityRunAttempt, 2);
  assert.equal(full.artifact.id, 2);
  assert.equal(selectCiIdentityArtifact({ artifacts: [artifact(2, 2), artifact(3, 2)], sourceRunId: 42, expectedHead: headSha, sourceRunAttempt: 2 }), null, 'same-attempt ambiguity fails closed');
  assert.equal(selectCiIdentityArtifact({ artifacts: [{ ...artifact(2, 2), workflow_run: { id: 41, head_sha: headSha } }], sourceRunId: 42, expectedHead: headSha, sourceRunAttempt: 2 }), null);
  const conflicting = { ...artifact(3, 1), name: ciMergeIdentityArtifactName({ testedBaseSha: 'f'.repeat(40), headSha, testedMergeSha: mergeSha, identityRunAttempt: 1 }) };
  assert.equal(selectCiIdentityArtifact({ artifacts: [artifact(1, 1), conflicting], sourceRunId: 42, expectedHead: headSha, sourceRunAttempt: 2 }), null, 'conflicting reserved identities cannot be filtered away');
  assert.equal(selectCiIdentityArtifact({ artifacts: [artifact(1, 1), { ...artifact(4, 1), name: 'ci-merge-v1-malformed' }], sourceRunId: 42, expectedHead: headSha, sourceRunAttempt: 2 }), null, 'malformed reserved identities fail closed');
});

test('CI artifact discovery paginates the complete server collection', async () => {
  const calls = [];
  const pageOne = Array.from({ length: 100 }, (_, id) => ({ id, name: `unrelated-${id}` }));
  const expected = { id: 101, name: identityName };
  const artifacts = await actionArtifacts(binding.repository, 42, 'token', async (path) => {
    calls.push(path);
    return { artifacts: new URL(`https://example.test${path}`).searchParams.get('page') === '1' ? pageOne : [expected] };
  });
  assert.equal(artifacts.length, 101);
  assert.equal(artifacts.at(-1), expected);
  assert.deepEqual(calls.map((path) => new URL(`https://example.test${path}`).searchParams.get('page')), ['1', '2']);
});

test('automatic main orchestration authorizes only the refreshed server attempt', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'claude-shadow-main-'));
  const eventPath = join(directory, 'event.json');
  const outputPath = join(directory, 'output');
  const eventRun = { id: 42, run_attempt: 1, name: 'CI', event: 'pull_request', status: 'completed', conclusion: 'success', head_sha: headSha, head_repository: { full_name: binding.repository }, pull_requests: [{ number: 600 }], path: '.github/workflows/ci.yml' };
  writeFileSync(eventPath, JSON.stringify({ action: 'completed', repository: { full_name: binding.repository }, workflow_run: eventRun }));
  const priorEnv = { ...process.env };
  const priorFetch = globalThis.fetch;
  try {
    Object.assign(process.env, { GITHUB_TOKEN: 'test', GITHUB_EVENT_PATH: eventPath, GITHUB_EVENT_NAME: 'workflow_run', GITHUB_WORKFLOW_SHA: workflowSha, GITHUB_WORKFLOW_REF: workflowRef, GITHUB_REF: executionRef, GITHUB_OUTPUT: outputPath });
    for (const fresh of [
      { ...eventRun, run_attempt: 2, status: 'in_progress', conclusion: null },
      { ...eventRun, run_attempt: 2, conclusion: 'failure' },
      { ...eventRun, run_attempt: 2 },
    ]) {
      const calls = [];
      globalThis.fetch = async (url) => {
        calls.push(String(url));
        const path = new URL(url).pathname;
        let value;
        if (path.endsWith('/actions/runs/42')) value = fresh;
        else if (path.endsWith('/pulls/600')) value = { number: 600, state: 'open', head: { sha: headSha, repo: { full_name: binding.repository } }, base: { ref: 'main', sha: baseSha, repo: { full_name: binding.repository } }, merge_commit_sha: mergeSha };
        else if (path.endsWith('/git/ref/heads/main')) value = { object: { sha: baseSha } };
        else if (path.includes('/compare/')) value = { merge_base_commit: { sha: baseSha }, files: [{ filename: 'a.js' }] };
        else if (path.endsWith('/pulls/600/files')) value = [{ filename: 'a.js' }];
        else if (path.endsWith('/actions/runs/42/artifacts')) value = { artifacts: [identityArtifact] };
        else throw new Error(`unexpected ${path}`);
        return new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } });
      };
      await assert.rejects(main('prepare'), /unauthorized_or_stale/u);
      assert.ok(calls.some((url) => url.endsWith('/actions/runs/42')), 'production orchestration fetched the server run');
    }
  } finally {
    globalThis.fetch = priorFetch;
    process.env = priorEnv;
    rmSync(directory, { recursive: true, force: true });
  }
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
  const reviewJob = workflow.slice(workflow.indexOf('  review:'), workflow.indexOf('  publish:'));
  const publishJob = workflow.slice(workflow.indexOf('  publish:'));
  assert.match(reviewJob, /if: github\.ref == 'refs\/heads\/main'/u);
  assert.match(publishJob, /github\.ref == 'refs\/heads\/main'/u);
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
  const diagnosticStep = workflow.slice(workflow.indexOf('- name: Categorize Claude SDK outcome'), workflow.indexOf('  publish:'));
  assert.match(diagnosticStep, /if: always\(\)/u);
  assert.ok(diagnosticStep.includes('CLAUDE_EXECUTION_FILE: ${{ steps.claude.outputs.execution_file }}'));
  assert.match(diagnosticStep, /node scripts\/claude-shadow-diagnostic\.mjs/u);
  assert.doesNotMatch(workflow, /ACTIONS_STEP_DEBUG/u);
  assert.equal(workflow.includes('path: ${{ steps.claude.outputs.execution_file }}'), false);
  assert.doesNotMatch(workflow, /node candidate\//u);
});
