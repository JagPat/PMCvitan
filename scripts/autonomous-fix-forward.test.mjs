import test from 'node:test';
import assert from 'node:assert/strict';
import { enforceReviewConvergence, guardAgainstCurrentHeadFinding } from './autonomous-review-gate.mjs';
import { assessCorrectionLease, correctionReasonFor } from './correction-lease.mjs';
import { assessReplacementLineage, isRetryableReviewFailureDescription } from './review-efficiency.mjs';
const head = 'c'.repeat(40);
const pr = { number: 572, state: 'open', draft: false, body: '<!-- correction-owner: claude -->', head: { sha: head, ref: 'claude/unit', repo: { full_name: 'JagPat/PMCvitan' } }, base: { ref: 'main', repo: { full_name: 'JagPat/PMCvitan' } } };
const findings = ['a', 'b', 'c'].map(x => ({ user: { login: 'chatgpt-codex-connector[bot]' }, original_commit_id: x.repeat(40), body: '**P1** unresolved defect' }));
function client(reviewFindings = findings) {
  const calls = [];
  return { calls, async reviews() { return []; }, async reviewComments() { return reviewFindings; }, async pullRequest() { return pr; }, async setDraft(p, draft) { calls.push(['draft', draft]); return { ...p, draft }; }, async setStatus(...args) { calls.push(['status', ...args]); }, async markReplacementRequired() { calls.push(['replacement']); }, async updateStickyComment(...args) { calls.push(['notice', ...args]); } };
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

test('repeated findings reach the actual correction notice as a root-cause audit', async () => {
  for (const count of [1, 2, 3]) {
    const c = client(findings.slice(-count));
    await guardAgainstCurrentHeadFinding(c, pr, head, null);
    const notices = JSON.stringify(c.calls.filter(call => call[0] === 'notice'));
    if (count >= 2) {
      assert.match(notices, /root-cause audit/u);
      assert.match(notices, /stronger proofs/u);
    } else {
      assert.doesNotMatch(notices, /root-cause audit/u);
    }
  }
});

function voluntaryReplacement(sourceChanges = {}, targetChanges = {}) {
  const source = { ...pr, number: 570, state: 'closed', merged_at: null, ...sourceChanges };
  const target = {
    ...pr, number: 580,
    body: 'Replaces: #570\nReplacement reason: Separate the policy correction from unrelated consolidation.',
    ...targetChanges,
  };
  return assessReplacementLineage({
    pullRequest: target, requiredReplacements: [], replacementPullRequests: [source],
  });
}

test('a justified voluntary replacement has provenance without a round-limit label', () => {
  assert.equal(voluntaryReplacement().allowed, true);
});

test('voluntary replacement cannot discard reason, source state, base or repository provenance', () => {
  assert.equal(voluntaryReplacement({}, {body:'Replaces: #570'}).allowed, false);
  assert.equal(voluntaryReplacement({state:'open'}).allowed, false);
  assert.equal(voluntaryReplacement({merged_at:'2026-09-08T00:00:00Z'}).allowed, false);
  assert.equal(voluntaryReplacement({base:{...pr.base, ref:'release'}}).allowed, false);
  assert.equal(voluntaryReplacement({head:{...pr.head, repo:{full_name:'outsider/PMCvitan'}}}).allowed, false);
  assert.equal(voluntaryReplacement({}, {number:569}).allowed, false);
});

test('a placeholder reason does not buy a voluntary replacement', () => {
  // The provenance path existed and validated nothing: the first version tested only that SOME
  // non-whitespace followed the label, so `n/a` cleared the canonical requirement to record a
  // concrete scope or approach benefit. These are the shapes that carry no claim at all.
  for (const reason of ['n/a', 'na', 'none', 'TBD', 'todo', 'x', '-', '?', 'see above', 'same',
                        'scope', 'approach', 'replacement', 'test']) {
    assert.equal(
      voluntaryReplacement({}, { body: `Replaces: #570\nReplacement reason: ${reason}` }).allowed,
      false,
      `placeholder reason "${reason}" must not clear the provenance path`,
    );
  }
  // …and a fragment too short to state anything is refused on the same ground
  assert.equal(voluntaryReplacement({}, {body:'Replaces: #570\nReplacement reason: two concerns'}).allowed, false);
});

test('a reason that names a concrete scope or approach benefit is admitted', () => {
  // The floor is not a quality judgement — a gate cannot tell whether a stated benefit is real,
  // and pretending to would be worse than refusing placeholders. These clear it without trying.
  for (const reason of [
    'Splits the migration from the service work so each is reviewable alone.',
    'Retargets onto the correct base branch after main moved underneath it.',
    'Two unrelated concerns were mixed; this carries only the readiness fix.',
  ]) {
    assert.equal(
      voluntaryReplacement({}, { body: `Replaces: #570\nReplacement reason: ${reason}` }).allowed,
      true,
      `concrete reason "${reason}" must be admitted`,
    );
  }
});

test('a merged successor prevents a second voluntary replacement of the same source', () => {
  const source = { ...pr, number:570, state:'closed', merged_at:null };
  const result = assessReplacementLineage({
    pullRequest: { ...pr, number:580, body:'Replaces: #570\nReplacement reason: Narrow the scope to the migration seam alone.' },
    requiredReplacements: [],
    replacementPullRequests: [source, {
      number:579, state:'closed', merged_at:'2026-09-08T00:00:00Z',
      base:pr.base, body:'Replaces: #570',
    }],
  });
  assert.equal(result.allowed, false);
});
