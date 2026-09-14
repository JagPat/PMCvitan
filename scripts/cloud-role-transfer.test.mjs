import assert from 'node:assert/strict';
import test from 'node:test';
import { assessBoardMergeAuthorization } from './board-merge-authorization.mjs';
import { classifyClaudeShadowReview } from './claude-review-adapter.mjs';
import { parseCorrectionOwner, correctionRouting } from './correction-owner.mjs';
import { authorizeExactHeadMerge, REQUIRED_CHECKS } from './autonomous-review-gate.mjs';

const head = 'a'.repeat(40);
const base = 'b'.repeat(40);
const body = (decision = 'authorize') => `<!-- pmcvitan-board-merge-authorization -->\nPR: #600\nHead: ${head}\nBase: ${base}\nDecision: ${decision}`;
const comment = (overrides = {}) => ({ id: 1, body: body(), user: { login: 'board-chair' }, created_at: '2026-09-14T12:00:00Z', updated_at: '2026-09-14T12:00:00Z', ...overrides });

test('Board authorization is exact-head/base, trusted, unedited and revocable', () => {
  const input = { comments: [comment()], pullRequestNumber: 600, expectedHead: head, expectedBase: base, trustedActors: ['board-chair'] };
  assert.equal(assessBoardMergeAuthorization(input).allowed, true);
  for (const changed of [
    { expectedHead: 'c'.repeat(40) },
    { expectedBase: 'd'.repeat(40) },
    { trustedActors: ['implementer'] },
    { comments: [comment({ updated_at: '2026-09-14T12:01:00Z' })] },
  ]) assert.equal(assessBoardMergeAuthorization({ ...input, ...changed }).allowed, false);
  const revoked = comment({ id: 2, body: body('revoke'), created_at: '2026-09-14T12:01:00Z', updated_at: '2026-09-14T12:01:00Z' });
  assert.deepEqual(assessBoardMergeAuthorization({ ...input, comments: [comment(), revoked] }), { allowed: false, state: 'revoked' });
});

function cleanRun(overrides = {}) {
  return { id: 7, name: 'claude-independent-review', head_sha: head, app: { slug: 'claude-review-service' }, external_id: `pmcvitan:claude-review:v1:pr-600:sha-${head}:nonce`, status: 'completed', conclusion: 'success', completed_at: '2026-09-14T12:00:00Z', output: { summary: JSON.stringify({ schema: 1, pullRequest: 600, headSha: head, outcome: 'clear', openFindings: 0, complete: true }) }, ...overrides };
}

test('Claude shadow evidence is exact-head/app and fail-closed but non-authoritative', () => {
  const classify = (runs) => classifyClaudeShadowReview({ checkRuns: runs, expectedHead: head, pullRequestNumber: 600, trustedAppSlug: 'claude-review-service' });
  assert.deepEqual(classify([cleanRun()]), { state: 'clear', authoritative: false, runId: 7 });
  assert.equal(classify([cleanRun({ head_sha: 'c'.repeat(40) })]).state, 'missing');
  assert.equal(classify([cleanRun({ app: { slug: 'wrong' } })]).state, 'missing');
  assert.equal(classify([cleanRun({ status: 'in_progress', conclusion: null, completed_at: null })]).state, 'partial');
  assert.equal(classify([cleanRun({ conclusion: 'timed_out' })]).state, 'timed_out');
  assert.equal(classify([cleanRun({ conclusion: 'failure' })]).state, 'failure');
  assert.equal(classify([cleanRun({ output: { summary: '{}' } })]).state, 'replayed');
  assert.equal(classify([cleanRun({ output: { summary: JSON.stringify({ schema: 1, pullRequest: 600, headSha: head, outcome: 'changes_required', openFindings: 1, complete: true }) } })]).state, 'changes_required');
  assert.equal(classify([]).state, 'missing');
});

test('Codex ownership requires a traceable transfer on claude branches and is not awakenable', () => {
  assert.equal(parseCorrectionOwner('<!-- correction-owner: codex -->', { headRef: 'codex/maintenance' }).state, 'declared');
  assert.equal(parseCorrectionOwner('<!-- correction-owner: codex -->', { headRef: 'claude/product' }).state, 'contradictory');
  const transferred = parseCorrectionOwner('<!-- correction-owner: codex -->\n<!-- correction-transfer: claude->codex -->', { headRef: 'claude/product' });
  assert.equal(transferred.state, 'declared');
  const route = correctionRouting({ declaration: transferred, head: head, reason: 'review' });
  assert.equal(route.awakenable, false);
  assert.match(route.instruction, /cannot start|neither start/iu);
});

test('transfer examples outside the leading declarations cannot transfer ownership', () => {
  for (const prose of ['Example: <!-- correction-transfer: claude->codex -->', '```\n<!-- correction-transfer: claude->codex -->\n```']) {
    assert.equal(parseCorrectionOwner(`<!-- correction-owner: codex -->\n\n${prose}`, { headRef: 'claude/product' }).state, 'contradictory');
  }
});

test('a newer pending Claude rerun supersedes an older clear completion', () => {
  for (const status of ['queued', 'in_progress']) {
    const newer = cleanRun({ id: 8, status, conclusion: null, completed_at: null });
    for (const runs of [[cleanRun(), newer], [newer, cleanRun()]]) {
      assert.equal(classifyClaudeShadowReview({ checkRuns: runs, expectedHead: head, pullRequestNumber: 600, trustedAppSlug: 'claude-review-service' }).state, 'partial');
    }
  }
});

test('merge guard rejects drafts, new heads/base changes, revoked holds and non-green gates', async () => {
  const prior = process.env.BOARD_MERGE_AUTHORIZERS;
  process.env.BOARD_MERGE_AUTHORIZERS = 'board-chair';
  const pull = { number: 600, state: 'open', draft: false, head: { sha: head, repo: { full_name: 'JagPat/PMCvitan' } }, base: { ref: 'main', sha: base, repo: { full_name: 'JagPat/PMCvitan' } } };
  const checks = REQUIRED_CHECKS.map((name) => ({ name, status: 'completed', conclusion: 'success' }));
  const makeClient = ({ pulls = [pull, pull], statuses = [{ context: 'codex-current-head', state: 'success' }], comments = [[comment()], [comment()]] } = {}) => ({
    repository: 'JagPat/PMCvitan',
    async pullRequest() { return pulls.shift() ?? pull; },
    async statuses() { return statuses; },
    async checkRuns() { return checks; },
    async paginated() { return comments.shift() ?? []; },
  });
  try {
    assert.equal((await authorizeExactHeadMerge(makeClient(), pull, head)).allowed, true);
    assert.equal((await authorizeExactHeadMerge(makeClient({ pulls: [{ ...pull, draft: true }] }), pull, head)).state, 'draft');
    assert.equal((await authorizeExactHeadMerge(makeClient({ pulls: [pull, { ...pull, head: { ...pull.head, sha: 'c'.repeat(40) } }] }), pull, head)).state, 'changed_during_validation');
    assert.equal((await authorizeExactHeadMerge(makeClient({ pulls: [pull, { ...pull, base: { ...pull.base, sha: 'd'.repeat(40) } }] }), pull, head)).state, 'changed_during_validation');
    const revoked = comment({ id: 2, body: body('revoke'), created_at: '2026-09-14T12:01:00Z', updated_at: '2026-09-14T12:01:00Z' });
    assert.equal((await authorizeExactHeadMerge(makeClient({ comments: [[comment()], [comment(), revoked]] }), pull, head)).state, 'revoked');
    assert.equal((await authorizeExactHeadMerge(makeClient({ statuses: [{ context: 'codex-current-head', state: 'failure' }] }), pull, head)).state, 'gates_not_green');
  } finally {
    if (prior === undefined) delete process.env.BOARD_MERGE_AUTHORIZERS;
    else process.env.BOARD_MERGE_AUTHORIZERS = prior;
  }
});
