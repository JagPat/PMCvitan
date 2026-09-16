import { readFileSync } from 'node:fs';

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
    || !value.filesReviewed.every((path) => typeof path === 'string' && path.length > 0)
    || !Array.isArray(value.findings)
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

export function externalId(binding) {
  return [
    'pmcvitan:claude-shadow:v1',
    `repo-${binding.repository}`,
    `pr-${binding.pullRequest}`,
    `base-${binding.baseSha}`,
    `head-${binding.headSha}`,
    `run-${binding.runId}`,
    `attempt-${binding.runAttempt}`,
  ].join(':');
}

export function authorizeShadowEvent(event, livePull) {
  const pull = event?.workflow_run?.pull_requests?.[0];
  const head = event?.workflow_run?.head_sha;
  const repository = event?.repository?.full_name;
  if (
    event?.action !== 'completed'
    || event?.workflow_run?.event !== 'pull_request'
    || event?.workflow_run?.conclusion !== 'success'
    || event.workflow_run.pull_requests.length !== 1
    || !SHA.test(head ?? '')
    || event?.workflow_run?.head_repository?.full_name !== repository
    || livePull?.state !== 'open'
    || livePull?.head?.sha !== head
    || livePull?.head?.repo?.full_name !== repository
    || livePull?.base?.ref !== LINEAGE_BASE_REF
    || livePull?.base?.repo?.full_name !== repository
    || !SHA.test(livePull?.base?.sha ?? '')
  ) return { allowed: false, state: 'unauthorized_or_stale' };
  return {
    allowed: true,
    binding: {
      repository,
      pullRequest: pull.number,
      headSha: head,
      baseSha: livePull.base.sha,
      runId: event.workflow_run.id,
      runAttempt: event.workflow_run.run_attempt,
    },
  };
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

async function main() {
  const [mode] = process.argv.slice(2);
  const token = process.env.GITHUB_TOKEN;
  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
  const summary = process.env.CLAUDE_STRUCTURED_OUTPUT ?? '';
  if (!token) throw new Error('GITHUB_TOKEN is required');
  const hinted = event?.workflow_run?.pull_requests?.[0];
  const repository = event?.repository?.full_name;
  const live = hinted
    ? await github(`/repos/${repository}/pulls/${hinted.number}`, token)
    : null;
  const authorization = authorizeShadowEvent(event, live);
  if (!authorization.allowed) throw new Error(authorization.state);
  const binding = authorization.binding;

  if (mode === 'prepare') {
    const output = process.env.GITHUB_OUTPUT;
    if (!output) throw new Error('GITHUB_OUTPUT is required');
    const { appendFileSync } = await import('node:fs');
    appendFileSync(output, Object.entries(binding).map(([key, value]) => `${key}=${value}\n`).join(''));
    return;
  }
  if (mode !== 'publish') throw new Error('Expected prepare or publish mode');

  const result = process.env.CLAUDE_ACTION_OUTCOME === 'success'
    ? validateClaudeReview(summary, binding)
    : { state: 'reviewer_error', findings: [] };
  const conclusion = result.state === 'clear' ? 'success' : 'failure';
  const findings = result.findings.slice(0, 20).map((finding) =>
    `${finding.severity} ${finding.path}:${finding.line} ${finding.description} (${finding.rule}; example: ${finding.example})`);
  await github(`/repos/${repository}/check-runs`, token, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: CLAUDE_SHADOW_CONTEXT,
      head_sha: binding.headSha,
      external_id: externalId(binding),
      status: 'completed',
      conclusion,
      output: {
        title: `Claude shadow review: ${result.state}`,
        summary: JSON.stringify({ schema: 1, ...binding, state: result.state, findingCount: result.findings.length }),
        text: findings.join('\n') || 'No P1/P2 finding was reported. Shadow evidence is not a merge gate.',
      },
    }),
  });
  if (conclusion !== 'success') process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  await main();
}
