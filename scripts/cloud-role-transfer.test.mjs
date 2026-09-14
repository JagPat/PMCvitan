import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyClaudeShadowReview } from './claude-review-adapter.mjs';
import { parseCorrectionOwner, correctionRouting, correctionOwnerProblem } from './correction-owner.mjs';
import { authorizeExactHeadMerge, REQUIRED_CHECKS } from './autonomous-review-gate.mjs';

const head = 'a'.repeat(40);
const base = 'b'.repeat(40);

test('Codex implementation ownership is refused until independent reviewer provenance exists', () => {
  for (const ref of ['codex/maintenance', 'claude/product']) {
    const body = '<!-- correction-owner: codex -->\n<!-- correction-transfer: claude->codex -->';
    const declaration = parseCorrectionOwner(body, { headRef: ref });
    assert.equal(declaration.state, 'invalid');
    assert.ok(correctionOwnerProblem({ body, head: { ref } }));
    const route = correctionRouting({ declaration, head });
    assert.equal(route.owner, null);
    assert.equal(route.awakenable, false);
  }
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

test('a newer pending Claude rerun supersedes an older clear completion', () => {
  for (const status of ['queued', 'in_progress']) {
    const newer = cleanRun({ id: 8, status, conclusion: null, completed_at: null });
    for (const runs of [[cleanRun(), newer], [newer, cleanRun()]]) {
      assert.equal(classifyClaudeShadowReview({ checkRuns: runs, expectedHead: head, pullRequestNumber: 600, trustedAppSlug: 'claude-review-service' }).state, 'partial');
    }
  }
});

test('automatic merge needs CI and exact-head review, with no human authorization', async () => {
  const pull = { number: 600, state: 'open', draft: false, head: { sha: head, repo: { full_name: 'JagPat/PMCvitan' } }, base: { ref: 'main', sha: base, repo: { full_name: 'JagPat/PMCvitan' } } };
  const checks = REQUIRED_CHECKS.map((name) => ({ name, status: 'completed', conclusion: 'success' }));
  const makeClient = ({ pulls = [pull, pull], statuses = [{ context: 'codex-current-head', state: 'success' }], runs = checks } = {}) => ({
    repository: 'JagPat/PMCvitan',
    async pullRequest() { return pulls.shift() ?? pull; },
    async statuses() { return statuses; },
    async checkRuns() { return runs; },
    async paginated() { throw new Error('Merge must not fetch human authorization comments'); },
  });
  assert.equal((await authorizeExactHeadMerge(makeClient(), pull, head)).allowed, true);
  assert.equal((await authorizeExactHeadMerge(makeClient({ pulls: [{ ...pull, draft: true }] }), pull, head)).state, 'draft');
  assert.equal((await authorizeExactHeadMerge(makeClient({ pulls: [pull, { ...pull, head: { ...pull.head, sha: 'c'.repeat(40) } }] }), pull, head)).state, 'changed_during_validation');
  assert.equal((await authorizeExactHeadMerge(makeClient({ pulls: [pull, { ...pull, base: { ...pull.base, sha: 'd'.repeat(40) } }] }), pull, head)).state, 'changed_during_validation');
  for (const state of ['failure', 'pending']) {
    assert.equal((await authorizeExactHeadMerge(makeClient({ statuses: [{ context: 'codex-current-head', state }] }), pull, head)).state, 'gates_not_green');
  }
  assert.equal((await authorizeExactHeadMerge(makeClient({ statuses: [] }), pull, head)).state, 'gates_not_green');
  assert.equal((await authorizeExactHeadMerge(makeClient({ runs: [] }), pull, head)).state, 'gates_not_green');
  for (const name of REQUIRED_CHECKS) {
    assert.equal((await authorizeExactHeadMerge(makeClient({ runs: checks.map(run => run.name === name ? { ...run, conclusion: 'failure' } : run) }), pull, head)).state, 'gates_not_green');
  }
});
