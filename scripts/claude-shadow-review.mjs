import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';

import { CLAUDE_SHADOW_CONTEXT, LINEAGE_BASE_REF } from './review-policy.mjs';

const SHA = /^[0-9a-f]{40}$/u;
const SEVERITIES = new Set(['P1', 'P2']);

export function validateClaudeReview(raw, expected) {
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    return { state: 'malformed', findings: [] };
  }
  if (
    value?.schema !== 1
    || value.repository !== expected.repository
    || value.pullRequest !== expected.pullRequest
    || value.headSha !== expected.headSha
    || value.baseSha !== expected.baseSha
    || value.runId !== expected.runId
    || value.runAttempt !== expected.runAttempt
    || value.complete !== true
    || !Array.isArray(value.filesReviewed)
    || value.filesReviewed.length === 0
    || value.filesReviewed.length > 1_000
    || !value.filesReviewed.every((path) => typeof path === 'string' && path.length > 0)
    || !Array.isArray(value.findings)
    || value.findings.length > 100
  ) return { state: 'malformed', findings: [] };

  const validFinding = (finding) =>
    finding && SEVERITIES.has(finding.severity)
    && typeof finding.path === 'string' && finding.path.length > 0
    && Number.isInteger(finding.line) && finding.line > 0
    && typeof finding.rule === 'string' && finding.rule.length > 0
    && typeof finding.description === 'string' && finding.description.length > 0
    && typeof finding.example === 'string' && finding.example.length > 0;
  if (!value.findings.every(validFinding)) return { state: 'malformed', findings: [] };
  return {
    state: value.findings.length === 0 ? 'clear' : 'changes_required',
    findings: value.findings,
    filesReviewed: [...new Set(value.filesReviewed)].sort(),
  };
}

export function requireChangedFileCoverage(result, changedFiles) {
  if (result.state === 'malformed') return result;
  const reviewed = new Set(result.filesReviewed);
  return changedFiles.every((path) => reviewed.has(path))
    ? result
    : { state: 'incomplete', findings: result.findings, filesReviewed: result.filesReviewed };
}

export function externalId(binding, provenance = {}) {
  return [
    'pmcvitan:claude-shadow:v1',
    `repo-${binding.repository}`,
    `pr-${binding.pullRequest}`,
    `base-${binding.baseSha}`,
    `head-${binding.headSha}`,
    `run-${binding.runId}`,
    `attempt-${binding.runAttempt}`,
    ...(provenance.publisherRunId ? [
      `publisher-${provenance.publisherRunId}`,
      `publisher-attempt-${provenance.publisherRunAttempt}`,
    ] : []),
  ].join(':');
}

export function evidenceArtifactName(binding, provenance, result) {
  return [
    'claude-shadow-v1',
    `repo-${Buffer.from(binding.repository).toString('base64url')}`,
    `pr-${binding.pullRequest}`,
    `base-${binding.baseSha}`,
    `head-${binding.headSha}`,
    `ci-${binding.runId}-${binding.runAttempt}`,
    `publisher-${provenance.publisherRunId}-${provenance.publisherRunAttempt}`,
    `state-${result.state}`,
    `findings-${result.findings.length}`,
  ].join('-');
}

export function authorizeShadowRequest({
  repository,
  pullRequestNumber,
  expectedHead,
  expectedRunAttempt,
  trustedWorkflowSha,
  sourceRun,
  livePull,
}) {
  const pullNumbers = sourceRun?.pull_requests?.map((pull) => pull.number) ?? [];
  if (
    sourceRun?.name !== 'CI'
    || sourceRun?.event !== 'pull_request'
    || sourceRun?.status !== 'completed'
    || sourceRun?.conclusion !== 'success'
    || sourceRun?.head_sha !== expectedHead
    || sourceRun?.head_repository?.full_name !== repository
    || !pullNumbers.includes(pullRequestNumber)
    || !Number.isInteger(sourceRun?.id)
    || !Number.isInteger(sourceRun?.run_attempt)
    || sourceRun.run_attempt !== (expectedRunAttempt ?? sourceRun.run_attempt)
    || !SHA.test(expectedHead ?? '')
    || livePull?.state !== 'open'
    || livePull?.number !== pullRequestNumber
    || livePull?.head?.sha !== expectedHead
    || livePull?.head?.repo?.full_name !== repository
    || livePull?.base?.ref !== LINEAGE_BASE_REF
    || livePull?.base?.repo?.full_name !== repository
    || !SHA.test(livePull?.base?.sha ?? '')
    || (trustedWorkflowSha !== undefined && livePull.base.sha !== trustedWorkflowSha)
  ) return { allowed: false, state: 'unauthorized_or_stale' };
  return {
    allowed: true,
    binding: {
      repository,
      pullRequest: pullRequestNumber,
      headSha: expectedHead,
      baseSha: livePull.base.sha,
      runId: sourceRun.id,
      runAttempt: sourceRun.run_attempt,
    },
  };
}

export function authorizeShadowEvent(event, livePull) {
  const sourceRun = event?.workflow_run;
  if (event?.action !== 'completed' || sourceRun?.pull_requests?.length !== 1) {
    return { allowed: false, state: 'unauthorized_or_stale' };
  }
  return authorizeShadowRequest({
    repository: event?.repository?.full_name,
    pullRequestNumber: sourceRun.pull_requests[0].number,
    expectedHead: sourceRun.head_sha,
    trustedWorkflowSha: event?.workflow_sha,
    sourceRun,
    livePull,
  });
}

async function github(path, token, options = {}) {
  const response = await fetch(`https://api.github.com${path}`, {
    ...options,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
      ...options.headers,
    },
  });
  if (!response.ok) throw new Error(`GitHub ${options.method ?? 'GET'} ${path}: ${response.status}`);
  return response.json();
}

async function changedFiles(repository, pullRequestNumber, token) {
  const paths = [];
  for (let page = 1; ; page += 1) {
    const batch = await github(
      `/repos/${repository}/pulls/${pullRequestNumber}/files?per_page=100&page=${page}`,
      token,
    );
    paths.push(...batch.map((file) => file.filename));
    if (batch.length < 100) return paths;
  }
}

async function main() {
  const [mode] = process.argv.slice(2);
  const token = process.env.GITHUB_TOKEN;
  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
  const summary = process.env.CLAUDE_STRUCTURED_OUTPUT ?? '';
  if (!token) throw new Error('GITHUB_TOKEN is required');
  const repository = event?.repository?.full_name;
  const dispatch = process.env.GITHUB_EVENT_NAME === 'workflow_dispatch';
  const pullRequestNumber = dispatch
    ? Number(event?.inputs?.pr_number)
    : event?.workflow_run?.pull_requests?.[0]?.number;
  const sourceRun = dispatch
    ? await github(`/repos/${repository}/actions/runs/${event?.inputs?.ci_run_id}`, token)
    : event?.workflow_run;
  const live = Number.isInteger(pullRequestNumber)
    ? await github(`/repos/${repository}/pulls/${pullRequestNumber}`, token)
    : null;
  const expectedHead = dispatch ? event?.inputs?.head_sha : sourceRun?.head_sha;
  const authorization = dispatch
    ? authorizeShadowRequest({
      repository,
      pullRequestNumber,
      expectedHead,
      expectedRunAttempt: Number(event?.inputs?.ci_run_attempt),
      trustedWorkflowSha: process.env.GITHUB_WORKFLOW_SHA,
      sourceRun,
      livePull: live,
    })
    : authorizeShadowEvent({ ...event, workflow_sha: process.env.GITHUB_WORKFLOW_SHA }, live);
  if (!authorization.allowed) throw new Error(authorization.state);
  const binding = authorization.binding;

  if (mode === 'prepare') {
    const output = process.env.GITHUB_OUTPUT;
    if (!output) throw new Error('GITHUB_OUTPUT is required');
    const { appendFileSync } = await import('node:fs');
    appendFileSync(output, Object.entries(binding).map(([key, value]) => `${key}=${value}\n`).join(''));
    return;
  }
  if (!['evaluate', 'publish'].includes(mode)) throw new Error('Expected prepare, evaluate or publish mode');

  const provenance = {
    publisherRunId: Number(process.env.GITHUB_RUN_ID),
    publisherRunAttempt: Number(process.env.GITHUB_RUN_ATTEMPT),
    workflowRef: process.env.GITHUB_WORKFLOW_REF,
    workflowSha: process.env.GITHUB_WORKFLOW_SHA,
  };
  if (
    !Number.isInteger(provenance.publisherRunId)
    || !Number.isInteger(provenance.publisherRunAttempt)
    || !provenance.workflowRef?.includes('/.github/workflows/claude-shadow-review.yml@')
    || !SHA.test(provenance.workflowSha ?? '')
    || provenance.workflowSha !== binding.baseSha
  ) throw new Error('Trusted publisher provenance is unavailable');
  if (mode === 'evaluate') {
    const interpreted = process.env.CLAUDE_ACTION_OUTCOME === 'success'
      ? validateClaudeReview(summary, binding)
      : { state: 'reviewer_error', findings: [], filesReviewed: [] };
    const result = requireChangedFileCoverage(
      interpreted,
      await changedFiles(repository, pullRequestNumber, token),
    );
    const artifactName = evidenceArtifactName(binding, provenance, result);
    writeFileSync(
      'claude-shadow-evidence.json',
      `${JSON.stringify({
        schema: 1,
        ...binding,
        ...provenance,
        state: result.state,
        findingCount: result.findings.length,
        filesReviewed: result.filesReviewed,
        findings: result.findings,
      })}\n`,
    );
    if (!process.env.GITHUB_OUTPUT) throw new Error('GITHUB_OUTPUT is required');
    appendFileSync(process.env.GITHUB_OUTPUT, `artifact_name=${artifactName}\n`);
    return;
  }

  const evidence = JSON.parse(readFileSync('claude-shadow-evidence.json', 'utf8'));
  const artifact = {
    id: Number(process.env.CLAUDE_ARTIFACT_ID),
    digest: process.env.CLAUDE_ARTIFACT_DIGEST,
    name: evidenceArtifactName(binding, provenance, {
      state: evidence.state,
      findings: Array(evidence.findingCount).fill(null),
    }),
  };
  if (!Number.isInteger(artifact.id) || !/^sha256:[0-9a-f]{64}$/u.test(artifact.digest ?? '')) {
    throw new Error('Server-associated evidence artifact is unavailable');
  }
  const conclusion = evidence.state === 'clear' && evidence.findingCount === 0 ? 'success' : 'failure';
  const { filesReviewed: _filesReviewed, findings: _findings, ...evidenceSummary } = evidence;
  await github(`/repos/${repository}/check-runs`, token, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: CLAUDE_SHADOW_CONTEXT,
      head_sha: binding.headSha,
      external_id: externalId(binding, provenance),
      status: 'completed',
      conclusion,
      output: {
        title: `Claude shadow review: ${evidence.state}`,
        summary: JSON.stringify({
          ...evidenceSummary,
          artifact,
        }),
        text: 'Structured findings are retained in the server-associated evidence artifact. Shadow evidence is not a merge gate.',
      },
    }),
  });
  if (conclusion !== 'success') process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  await main();
}
