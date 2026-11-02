import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  AutoMergeDisarmFailed,
  authorizeRecoveryDispatch,
  completeReviewedPullRequest,
  disarmQueuedAutoMerge,
  newestTokenedSuccess,
  publishDisarmedSuccess,
  REQUIRED_CHECKS,
} from './autonomous-review-gate.mjs';
import {
  CODEX_AUTOMERGE_DISARM_FAILED,
  CODEX_AUTOMERGE_REARM_FAILED,
  isRetryableReviewFailureDescription,
} from './review-policy.mjs';

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

test('G3 (gap-check F1) — every failure inside the disarm is the retryable AutoMergeDisarmFailed, never a raw error', async () => {
  const cases = {
    'the first read': fakeClient({ reads: [] }),
    'the re-read after the disable': fakeClient({ reads: [armed()] }),
    'the moved head\'s status read': { ...fakeClient({ reads: [armed(), pr(NEXT)] }), async statuses() { throw new Error('GitHub 502'); } },
    'the moved-head dispatch': { ...fakeClient({ reads: [armed(), pr(NEXT)], statuses: { [NEXT]: [success(77)] } }), async dispatchGateRecovery() { throw new Error('dispatch 500'); } },
  };
  for (const [name, client] of Object.entries(cases)) {
    const reads = client.pullRequest;
    client.pullRequest = async (number) => { const next = await reads.call(client, number); if (!next) throw new Error('ECONNRESET'); return next; };
    await assert.rejects(disarmQueuedAutoMerge(client, 900, HEAD), AutoMergeDisarmFailed, name);
  }
});

const eligibleCommit = { commit: { message: 'fix: something\n\nCorrection-Owner: claude\n' } };
const greenChecks = REQUIRED_CHECKS.map((name) => ({ name, status: 'completed', conclusion: 'success' }));
const verdict = { outcome: 'eligible', mergeEligible: true, owner: 'claude' };

/** A fake for the success and merge paths: every write is logged in order, and `live` is what each PR read returns. */
function gateClient({ live = () => pr(), statuses = [success(600)], enable = async () => {}, disable = async () => {} } = {}) {
  const log = [];
  const client = {
    log,
    repository: 'JagPat/PMCvitan',
    async pullRequest() { log.push(['read']); return live(); },
    async disableAutoMerge(pull) { log.push(['disable', pull.number]); return disable(); },
    async statuses() { return statuses; },
    async checkRuns() { return greenChecks; },
    async commit() { return eligibleCommit; },
    async issueComments() { return []; },
    async mergeExactHead() { return { merged: false, message: 'Pull request is not mergeable yet' }; },
    // GitHub's own guard: an already-armed pull request is not armed again
    async enableAutoMerge(pull, head) { if (pull.auto_merge) return; log.push(['arm', pull.number, head]); return enable(); },
    async dispatchHandoff() { log.push(['handoff']); },
    async setStatus(sha, state, description) { log.push(['status', sha, state, description]); return { id: 1 }; },
    async setDraft(pull, draft) { log.push(['draft', draft]); return { ...pull, draft }; },
    async updateStickyComment(number, body) { log.push(['sticky', body]); },
    async dispatchGateRecovery() { log.push(['dispatch']); },
  };
  return client;
}

test('G3 (gap-check F4) — the shared success step: an armed head is disabled before the success is written', async () => {
  let armedNow = true;
  const client = gateClient({ live: () => (armedNow ? armed() : pr()), disable: async () => { armedNow = false; } });
  const live = await publishDisarmedSuccess(client, armed(), HEAD, 'review: clean');
  assert.equal(live.auto_merge, null);
  const kinds = client.log.map(([k, , state]) => (k === 'status' ? `status:${state}` : k));
  assert.ok(kinds.indexOf('disable') >= 0 && kinds.indexOf('disable') < kinds.indexOf('status:success'), kinds.join(','));
  assert.equal(kinds.filter((k) => k === 'status:success').length, 1);
});

test('G3 (gap-check F1/F4) — the shared success step: a disarm that fails writes the retryable hold and no success', async () => {
  for (const client of [
    gateClient({ live: () => armed(), disable: async () => { throw new Error('GraphQL down'); } }),
    gateClient({ live: () => armed() }),
    (() => { let n = 0; const c = gateClient({ live: () => { n += 1; if (n === 2) throw new Error('ECONNRESET'); return n === 1 ? armed() : pr(); } }); return c; })(),
  ]) {
    await assert.rejects(publishDisarmedSuccess(client, armed(), HEAD, 'review: clean'), AutoMergeDisarmFailed);
    const statuses = client.log.filter(([k]) => k === 'status');
    assert.equal(statuses.some(([, , state]) => state === 'success'), false, 'nothing green');
    assert.deepEqual(statuses.at(-1).slice(2), ['failure', `review: ${CODEX_AUTOMERGE_DISARM_FAILED}`]);
    assert.match(client.log.find(([k]) => k === 'sticky')?.[1] ?? '', /review_retry/u);
  }
  // a head no longer current: nothing written at all
  const moved = gateClient({ live: () => pr(NEXT) });
  assert.equal(await publishDisarmedSuccess(moved, pr(), HEAD, 'review: clean'), null);
  assert.equal(moved.log.some(([k]) => k === 'status'), false);
});

test('G3 (gap-check F3) — the re-arm reads the fresh post-disarm pull request, not a stale armed object, and names this head', async () => {
  const client = gateClient();
  assert.equal(await completeReviewedPullRequest(client, armed(), HEAD, verdict), 'queued');
  assert.deepEqual(client.log.filter(([k]) => k === 'arm'), [['arm', 900, HEAD]], 'armed once, for this exact head (expectedHeadOid)');
});

test('G3 (gap-check F2d) — a re-arm that fails replaces the green with the retryable hold, so recovery re-judges the head', async () => {
  const client = gateClient({ enable: async () => { throw new Error('GraphQL down'); } });
  await assert.rejects(completeReviewedPullRequest(client, pr(), HEAD, verdict), /GraphQL down/u);
  const statuses = client.log.filter(([k]) => k === 'status');
  assert.deepEqual(statuses.at(-1).slice(2), ['failure', `review: ${CODEX_AUTOMERGE_REARM_FAILED}`]);
  assert.equal(isRetryableReviewFailureDescription(`review: ${CODEX_AUTOMERGE_REARM_FAILED}`), true);
  assert.match(client.log.find(([k]) => k === 'sticky')?.[1] ?? '', /review_retry/u);
  assert.equal(client.log.some(([k]) => k === 'handoff'), false);
  // GitHub's "clean status" answer is not a re-arm failure: the exact-head merge is retried as before, no hold
  const clean = gateClient({ enable: async () => { throw new Error('Pull request is in clean status'); } });
  clean.mergeExactHead = async () => ({ merged: true });
  assert.equal(await completeReviewedPullRequest(clean, pr(), HEAD, verdict), 'merged');
  assert.equal(clean.log.some(([k]) => k === 'status'), false);
});

test('G3 (gap-check F2c) — the hint is judged before an older non-retryable failure beneath the newest success', () => {
  const finding = { id: 70, context: 'codex-current-head', state: 'failure', description: 'review: current-head Codex finding on this exact head' };
  assert.equal(authorizeRecoveryDispatch([success(77), finding], '77')?.id, 77);
  // the latch still refuses everything else it refused before
  assert.equal(authorizeRecoveryDispatch([success(77, 'review: clean'), finding], '77'), null);
  assert.equal(authorizeRecoveryDispatch([finding], '70'), null);
});

test('G3 — structural: both writers take the one disarm-then-success step; only the merge authorization re-arms', async () => {
  const gate = await readFile(new URL('./autonomous-review-gate.mjs', import.meta.url), 'utf8');
  const step = gate.slice(gate.indexOf('export async function publishDisarmedSuccess('), gate.indexOf('const AUTOMERGE_RETRY_NEXT'));
  assert.ok(step.indexOf('disarmQueuedAutoMerge(client') > 0 && step.indexOf('disarmQueuedAutoMerge(client') < step.indexOf('await publishSettledSuccess('));
  assert.match(step, /if \(!\(error instanceof AutoMergeDisarmFailed\)\) throw error;\s*await holdAutoMergeRetry\(client, pullRequest, expectedHead, CODEX_AUTOMERGE_DISARM_FAILED[^;]*;\s*throw error;/u);
  assert.equal([...gate.matchAll(/await publishSettledSuccess\(/gu)].length, 1, 'the success writer is called only by the shared step');
  assert.equal([...gate.matchAll(/await publishDisarmedSuccess\(/gu)].length, 2, 'the review path and the recovered success');
  const arms = [...gate.matchAll(/client\.enableAutoMerge\(/gu)].map((m) => m.index);
  assert.equal(arms.length, 1);
  const complete = gate.indexOf('export async function completeReviewedPullRequest(');
  assert.ok(arms[0] > gate.indexOf('authorizeExactHeadMerge(client', complete) && arms[0] > complete);
  assert.equal([...gate.matchAll(/client\.disableAutoMerge\(/gu)].length, 1, 'one disable, inside the shared helper');
  const hold = gate.slice(gate.indexOf('async function holdAutoMergeRetry('), gate.indexOf('/** G3 — the head moved under a disarm'));
  assert.match(hold, /publishBlockingVerdict\(client, pullRequest, expectedHead, \{ description: `review: \$\{detail\}` \}\)/u);
  assert.match(hold, /state: 'review_retry'/u);
  assert.doesNotMatch(hold, /correctionNotice|changes_required/u);
  const settle = gate.slice(gate.indexOf('export async function settleUnmatchedRecoveryRequest('), gate.indexOf('export async function run()'));
  const consume = settle.indexOf('REARM_CONSUMED_OUTCOME');
  assert.ok(consume > 0 && consume < settle.indexOf("'recovery: request superseded by newer review state'"));
  const runBody = gate.slice(gate.indexOf('export async function run()'));
  assert.ok(runBody.indexOf('await settleUnmatchedRecoveryRequest(') > 0
    && runBody.indexOf('await settleUnmatchedRecoveryRequest(') < runBody.indexOf('await guardAgainstCurrentHeadFinding('));
});

// Stage 1 re-check G2 (mutant M13) — the orchestrate run tells a re-arm request from a stale one: the request naming
// this head's newest tokened success is CONSUMED (a success settlement, then the success's own recovery), never
// marked superseded; a request naming an older success is superseded under the re-arm name, so the watchdog's
// once-per-head bound holds; any other is superseded as before.
test('G3 — an unmatched recovery request: the re-arm hint is consumed, a stale one superseded', async () => {
  const { settleUnmatchedRecoveryRequest } = await import('./autonomous-review-gate.mjs');
  const { REARM_REQUEST_SUPERSEDED, REARM_SETTLEMENTS } = await import('./review-policy.mjs');
  const head = 'c'.repeat(40);
  const pull = { number: 7, html_url: 'u' };
  const success = (id) => ({ id, context: 'codex-current-head', state: 'success', description: 'review: Codex found no blocking issue on this exact head [wi:none]' });
  const request = (id) => ({ terminalStatusId: String(id), status: { context: `codex-recovery-request/${id}` } });
  const settle = async (statuses, req) => {
    const writes = [];
    const client = { async setStatus(sha, state, description, url, context) { writes.push({ state, description, context }); return { id: 1 }; } };
    const outcome = await settleUnmatchedRecoveryRequest(client, pull, head, statuses, req);
    return { outcome, writes };
  };
  const hint = await settle([success(6100)], request(6100));
  assert.equal(hint.outcome, 'consumed');
  assert.deepEqual(hint.writes, [{ state: 'success', description: 'recovery: consumed by recovered success re-authorization', context: 'codex-recovery-request/6100' }]);
  assert.ok(REARM_SETTLEMENTS.includes(hint.writes[0].description));
  const stale = await settle([success(6300), success(6100)], request(6100));
  assert.equal(stale.outcome, 'superseded');
  assert.deepEqual(stale.writes, [{ state: 'failure', description: REARM_REQUEST_SUPERSEDED, context: 'codex-recovery-request/6100' }]);
  const failure = { id: 6050, context: 'codex-current-head', state: 'failure', description: 'review: Codex review timed out after two attempts' };
  const other = await settle([success(6300), failure], request(6050));
  assert.deepEqual(other.writes.map((w) => w.description), ['recovery: request superseded by newer review state']);
});
