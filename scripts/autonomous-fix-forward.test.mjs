import test from 'node:test';
import assert from 'node:assert/strict';
import { enforceReviewConvergence, guardAgainstCurrentHeadFinding } from './autonomous-review-gate.mjs';
import { assessCorrectionLease, correctionReasonFor } from './correction-lease.mjs';
import { assessReplacementLineage, isRetryableReviewFailureDescription } from './review-efficiency.mjs';
const head = 'c'.repeat(40);
const pr = { number: 572, state: 'open', draft: false, body: '<!-- correction-owner: claude -->', head: { sha: head, ref: 'claude/unit', repo: { full_name: 'JagPat/PMCvitan' } }, base: { ref: 'main', repo: { full_name: 'JagPat/PMCvitan' } } };
const findings = ['a', 'b', 'c'].map(x => ({ user: { login: 'chatgpt-codex-connector[bot]' }, original_commit_id: x.repeat(40), body: '**P1** unresolved defect' }));
function client() {
  const calls = [];
  return { calls, async reviews() { return []; }, async reviewComments() { return findings; }, async pullRequest() { return pr; }, async setDraft(p, draft) { calls.push(['draft', draft]); return { ...p, draft }; }, async setStatus(...args) { calls.push(['status', ...args]); }, async markReplacementRequired() { calls.push(['replacement']); }, async updateStickyComment(...args) { calls.push(['notice', ...args]); } };
}
test('multiple finding heads allow another correction without replacement mutations', async () => {
  const c = client();
  const result = await enforceReviewConvergence(c, pr, head);
  assert.equal(result.allowed, true);
  assert.deepEqual(c.calls, []);
});
test('current-head findings still fail review and return the same PR to draft', async () => {
  const c = client();
  await guardAgainstCurrentHeadFinding(c, pr, head, null);
  assert.ok(c.calls.some(x => x[0] === 'status' && x[2] === 'failure'));
  assert.ok(c.calls.some(x => x[0] === 'draft' && x[1] === true));
  assert.ok(!c.calls.some(x => x[0] === 'replacement'));
  assert.doesNotMatch(JSON.stringify(c.calls), /close this PR|Replaces: #572/u);
});
test('watchdog keeps the declared owner fixing forward after many finding heads', () => {
  const result = assessCorrectionLease({ pullRequest: pr, head, findingHeads: findings.map(x => x.original_commit_id), findingObservedAt: '2026-09-08T10:00:00Z', now: '2026-09-08T12:00:00Z' });
  assert.equal(result.reportedState, 'correction_recovery');
  assert.match(result.body, /push one new head/u);
  assert.doesNotMatch(result.body, /close this PR|Replaces: #572/u);
});
test('historical replacement labels cannot force unrelated work into a new replacement', () => {
  assert.equal(assessReplacementLineage({ pullRequest: { number: 576, body: 'Replaces: none' }, requiredReplacements: [{ pullRequest: { number: 568, state: 'closed' } }], replacementPullRequests: [] }).allowed, true);
});

test('obsolete round-limit failures request a fresh gate evaluation, not a replacement', () => {
  const description = 'review: 2 finding-bearing heads reached the review-round limit; this unit requires a replacement PR';
  assert.equal(isRetryableReviewFailureDescription(description), true);
  assert.equal(correctionReasonFor({ context: 'codex-current-head', state: 'failure', description }), null);
});
