import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  AutoMergeDisarmFailed,
  authorizeRecoveryDispatch,
  completeReviewedPullRequest,
  disarmQueuedAutoMerge,
  newestTokenedSuccess,
  REQUIRED_CHECKS,
} from './autonomous-review-gate.mjs';
import { CODEX_AUTOMERGE_DISARM_FAILED, isRetryableReviewFailureDescription } from './review-policy.mjs';

/**
 * G3 (#1280 Codex 4438874584; notes/gate-codex-silent/g3/design.md). A native auto-merge queued from an earlier green
 * would merge the moment a republished success lands, before the merge's own authorization reads Codex's record. Every
 * success writer disarms it first; only `completeReviewedPullRequest`, after `authorizeExactHeadMerge`, re-arms it.
 */
const HEAD = 'a'.repeat(40);
const NEXT = 'b'.repeat(40);
const BASE = 'c'.repeat(40);
const repo = { full_name: 'JagPat/PMCvitan' };
const pr = (sha = HEAD, extra = {}) => ({
  number: 900, node_id: 'PR_900', state: 'open', draft: false, auto_merge: null,
  head: { sha, ref: 'claude/g3', repo }, base: { ref: 'main', sha: BASE, repo }, html_url: 'https://example.invalid/pr/900', ...extra,
});
const armed = (sha = HEAD) => pr(sha, { auto_merge: { enabled_at: '2026-11-02T00:00:00Z', merge_method: 'squash' } });
const success = (id, description = 'review: Codex found no blocking issue on this exact head [wi:none]') =>
  ({ id, context: 'codex-current-head', state: 'success', description });

function fakeClient({ reads, statuses = {}, disable = async () => {} } = {}) {
  const calls = [];
  return {
    calls,
    async pullRequest(number) { calls.push(['read', number]); return reads.shift(); },
    async disableAutoMerge(pull) { calls.push(['disable', pull.node_id]); return disable(); },
    async statuses(head) { calls.push(['statuses', head]); return statuses[head] ?? []; },
    async dispatchGateRecovery(ref, inputs) { calls.push(['dispatch', ref, inputs]); },
  };
}

test('G3 — a pull request with nothing queued is not disabled', async () => {
  const client = fakeClient({ reads: [pr()] });
  assert.equal((await disarmQueuedAutoMerge(client, 900, HEAD)).head.sha, HEAD);
  assert.deepEqual(client.calls.map(([k]) => k), ['read']);
});

test('G3 — a queued auto-merge is disabled, in the order check the head, disable, re-read; the disarmed PR is returned', async () => {
  const client = fakeClient({ reads: [armed(), pr()] });
  const live = await disarmQueuedAutoMerge(client, 900, HEAD);
  assert.equal(live.auto_merge, null);
  assert.deepEqual(client.calls.map(([k]) => k), ['read', 'disable', 'read']);
});

test('G3 — a disable that fails, or a re-read still armed, is the retryable failure: nothing green may follow', async () => {
  const failing = fakeClient({ reads: [armed()], disable: async () => { throw new Error('GraphQL down'); } });
  await assert.rejects(disarmQueuedAutoMerge(failing, 900, HEAD), AutoMergeDisarmFailed);
  const stuck = fakeClient({ reads: [armed(), armed()] });
  await assert.rejects(disarmQueuedAutoMerge(stuck, 900, HEAD), AutoMergeDisarmFailed);
  assert.equal(isRetryableReviewFailureDescription(`review: ${CODEX_AUTOMERGE_DISARM_FAILED}`), true);
});

test('G3 — a head that is no longer current is not touched', async () => {
  const client = fakeClient({ reads: [armed(NEXT)] });
  assert.equal(await disarmQueuedAutoMerge(client, 900, HEAD), null);
  assert.deepEqual(client.calls.map(([k]) => k), ['read']);
});

test('G3 — a push between the head check and the disable: this run writes nothing, and a green tokened new head is handed back to its own recovery', async () => {
  const green = fakeClient({ reads: [armed(), armed(NEXT)], statuses: { [NEXT]: [success(77)] } });
  assert.equal(await disarmQueuedAutoMerge(green, 900, HEAD), null);
  assert.deepEqual(green.calls.at(-1), ['dispatch', 'main', { pr_number: '900', head_sha: NEXT, terminal_status_id: '77' }]);
  // the new head not green, or green without an approval token: nothing is dispatched (its own run is still deciding)
  for (const newest of [{ id: 78, context: 'codex-current-head', state: 'pending', description: 'review: pending' }, success(79, 'review: clean')]) {
    const quiet = fakeClient({ reads: [armed(), pr(NEXT)], statuses: { [NEXT]: [newest] } });
    assert.equal(await disarmQueuedAutoMerge(quiet, 900, HEAD), null);
    assert.equal(quiet.calls.some(([k]) => k === 'dispatch'), false);
  }
});

test('G3 — the dispatch\'s status id is a hint: only this head\'s newest tokened success, named exactly, is authorized', () => {
  const tokened = success(500);
  const older = success(499);
  const pending = { id: 501, context: 'codex-current-head', state: 'pending', description: 'review: pending required CI and current-head Codex review' };
  // the newest tokened success, named exactly
  assert.equal(authorizeRecoveryDispatch([tokened, older], '500'), tokened);
  assert.equal(newestTokenedSuccess([tokened, older], '500'), tokened);
  // a stale id (an older success beneath it)
  assert.equal(authorizeRecoveryDispatch([tokened, older], '499'), null);
  // another head's id: not among this head's statuses
  assert.equal(authorizeRecoveryDispatch([tokened], '12345'), null);
  // an untokened success
  assert.equal(authorizeRecoveryDispatch([success(502, 'review: clean')], '502'), null);
  // a success no longer the head's newest status (a newer review began)
  assert.equal(authorizeRecoveryDispatch([pending, tokened], '500'), null);
  // no id at all
  assert.equal(newestTokenedSuccess([tokened], ''), null);
  // the old contract is unchanged: the active pending status and a retryable failure are still authorized
  assert.equal(authorizeRecoveryDispatch([pending, tokened], '501'), pending);
  const timedOut = { id: 503, context: 'codex-current-head', state: 'failure', description: 'review: Codex review timed out' };
  assert.equal(authorizeRecoveryDispatch([timedOut], '503'), timedOut);
});

test('G3 — the re-arm names this head (expectedHeadOid), and a re-arm that fails leaves the head green and unarmed', async () => {
  const eligibleCommit = { commit: { message: 'fix: something\n\nCorrection-Owner: claude\n' } };
  const checks = REQUIRED_CHECKS.map((name) => ({ name, status: 'completed', conclusion: 'success' }));
  const makeClient = ({ enable }) => {
    const writes = [];
    return {
      writes,
      repository: 'JagPat/PMCvitan',
      async pullRequest() { return pr(); },
      async statuses() { return [success(600)]; },
      async checkRuns() { return checks; },
      async commit() { return eligibleCommit; },
      async issueComments() { return []; },
      async mergeExactHead() { return { merged: false, message: 'Pull request is not mergeable yet' }; },
      async enableAutoMerge(pull, head) { writes.push(['arm', pull.number, head]); return enable(); },
      async dispatchHandoff() { writes.push(['handoff']); },
      async setStatus(...args) { writes.push(['status', ...args]); },
    };
  };
  const verdict = { outcome: 'eligible', mergeEligible: true, owner: 'claude' };
  const ok = makeClient({ enable: async () => {} });
  assert.equal(await completeReviewedPullRequest(ok, pr(), HEAD, verdict), 'queued');
  assert.deepEqual(ok.writes.filter(([k]) => k === 'arm'), [['arm', 900, HEAD]], 'armed once, for this exact head');
  const failing = makeClient({ enable: async () => { throw new Error('GraphQL down'); } });
  await assert.rejects(completeReviewedPullRequest(failing, pr(), HEAD, verdict), /GraphQL down/u);
  // nothing withdrew the green and nothing armed: today's not-armed state, which the next re-judge repeats
  assert.deepEqual(failing.writes, [['arm', 900, HEAD]]);
});

test('G3 — structural: every success writer disarms first; only the merge authorization re-arms', async () => {
  const gate = await readFile(new URL('./autonomous-review-gate.mjs', import.meta.url), 'utf8');
  const writers = [...gate.matchAll(/await publishSettledSuccess\(/gu)].map((m) => m.index);
  assert.equal(writers.length, 2, 'the review path and the recovered success');
  for (const at of writers) {
    const fnStart = Math.max(gate.lastIndexOf('\nexport async function ', at), gate.lastIndexOf('\nasync function ', at));
    const before = gate.slice(fnStart, at);
    const disarm = before.lastIndexOf('disarmQueuedAutoMerge(client');
    assert.ok(disarm > 0, 'a disarm precedes the success in its function');
    assert.ok(!before.slice(disarm).includes('await publishSettledSuccess('), 'no other success between them');
  }
  const arms = [...gate.matchAll(/client\.enableAutoMerge\(/gu)].map((m) => m.index);
  assert.equal(arms.length, 1);
  const complete = gate.indexOf('export async function completeReviewedPullRequest(');
  assert.ok(arms[0] > gate.indexOf('authorizeExactHeadMerge(client', complete) && arms[0] > complete);
  assert.equal([...gate.matchAll(/client\.disableAutoMerge\(/gu)].length, 1, 'one disable, inside the shared helper');
  // a disarm not confirmed is held at both writers: the retryable failure and review_retry sticky, then the throw
  const holds = [...gate.matchAll(/if \(!\(error instanceof AutoMergeDisarmFailed\)\) throw error;\s*await holdUndisarmedHead\([^;]*;\s*throw error;/gu)];
  assert.equal(holds.length, 2);
  const hold = gate.slice(gate.indexOf('async function holdUndisarmedHead('), gate.indexOf('/** G3 — the head moved under a disarm'));
  assert.match(hold, /publishBlockingVerdict\(client, pullRequest, expectedHead, \{ description: `review: \$\{CODEX_AUTOMERGE_DISARM_FAILED\}` \}\)/u);
  assert.match(hold, /state: 'review_retry'/u);
  assert.doesNotMatch(hold, /correctionNotice|changes_required/u);
  // a request naming the newest tokened success is consumed before the "superseded" write, and the success recovered
  const consume = gate.indexOf("'recovered success re-authorization'");
  assert.ok(consume > 0 && consume < gate.indexOf("'recovery: request superseded by newer review state'"));
});
