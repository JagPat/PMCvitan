import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { authorizeShadowEvent, externalId, validateClaudeReview } from './claude-shadow-review.mjs';

const headSha = 'a'.repeat(40);
const baseSha = 'b'.repeat(40);
const binding = { repository: 'JagPat/PMCvitan', pullRequest: 600, headSha, baseSha, runId: 42, runAttempt: 2 };
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

test('workflow authorization refuses stale, fork, failed CI, wrong base, and closed PR', () => {
  const live = { state: 'open', head: { sha: headSha, repo: { full_name: binding.repository } }, base: { ref: 'main', sha: baseSha, repo: { full_name: binding.repository } } };
  const event = { action: 'completed', repository: { full_name: binding.repository }, workflow_run: { id: 42, run_attempt: 2, event: 'pull_request', conclusion: 'success', head_sha: headSha, head_repository: { full_name: binding.repository }, pull_requests: [{ number: 600 }] } };
  assert.deepEqual(authorizeShadowEvent(event, live), { allowed: true, binding });
  for (const [changedEvent, changedLive] of [
    [{ ...event, workflow_run: { ...event.workflow_run, conclusion: 'failure' } }, live],
    [{ ...event, workflow_run: { ...event.workflow_run, head_sha: 'c'.repeat(40) } }, live],
    [{ ...event, workflow_run: { ...event.workflow_run, head_repository: { full_name: 'fork/repo' } } }, live],
    [event, { ...live, state: 'closed' }],
    [event, { ...live, base: { ...live.base, ref: 'other' } }],
  ]) assert.equal(authorizeShadowEvent(changedEvent, changedLive).allowed, false);
});

test('external id binds repository, PR, base, head, run and attempt', () => {
  const id = externalId(binding);
  for (const value of ['JagPat/PMCvitan', '600', headSha, baseSha, '42', '2']) assert.match(id, new RegExp(value));
});

test('hosted workflow is shadow-only, pinned, read-only, and publishes from trusted code', () => {
  const workflow = readFileSync('.github/workflows/claude-shadow-review.yml', 'utf8');
  assert.match(workflow, /workflow_run:/u);
  assert.match(workflow, /anthropics\/claude-code-action@7b0b255830a1fab6e602658672acad11c12d841d/u);
  assert.match(workflow, /claude_code_oauth_token: \$\{\{ secrets\.CLAUDE_CODE_OAUTH_TOKEN \}\}/u);
  assert.match(workflow, /contents: read/u);
  assert.doesNotMatch(workflow, /contents: write|pull-requests: write|statuses: write/u);
  assert.match(workflow, /publish:[\s\S]*checks: write/u);
  assert.doesNotMatch(workflow.match(/review:[\s\S]*?\n  publish:/u)[0], /checks: write/u);
  assert.match(workflow, /ref: \$\{\{ github\.event\.repository\.default_branch \}\}/u);
  assert.match(workflow, /node scripts\/claude-shadow-review\.mjs publish/u);
  assert.doesNotMatch(workflow, /node candidate\//u);
});
