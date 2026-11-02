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
  assert.match(step, /if \(!\(error instanceof AutoMergeDisarmFailed\)\) throw error;\s*await publishRetryableHold\(client, pullRequest, expectedHead, recoveryRequest, \{\s*detail: CODEX_AUTOMERGE_DISARM_FAILED,[^;]*;\s*throw error;/u);
  assert.equal([...gate.matchAll(/await publishSettledSuccess\(/gu)].length, 1, 'the success writer is called only by the shared step');
  assert.equal([...gate.matchAll(/await publishDisarmedSuccess\(/gu)].length, 2, 'the review path and the recovered success');
  const arms = [...gate.matchAll(/client\.enableAutoMerge\(/gu)].map((m) => m.index);
  assert.equal(arms.length, 1);
  const complete = gate.indexOf('export async function completeReviewedPullRequest(');
  assert.ok(arms[0] > gate.indexOf('authorizeExactHeadMerge(client', complete) && arms[0] > complete);
  assert.equal([...gate.matchAll(/client\.disableAutoMerge\(/gu)].length, 1, 'one disable, inside the shared helper');
  // #1290 fold — the auto-merge holds are the shared retryable hold (failure, draft, settle, `review_retry`, no notice),
  // and both of their details are ones recovery re-judges
  const rearm = gate.slice(gate.indexOf('export async function completeReviewedPullRequest('), gate.indexOf('export class AutoMergeDisarmFailed'));
  assert.match(rearm, /await publishRetryableHold\(client, pullRequest, expectedHead, recoveryRequest, \{\s*detail: CODEX_AUTOMERGE_REARM_FAILED,/u);
  const { isRetryableReviewFailureDescription, CODEX_AUTOMERGE_DISARM_FAILED, CODEX_AUTOMERGE_REARM_FAILED } = await import('./review-policy.mjs');
  for (const detail of [CODEX_AUTOMERGE_DISARM_FAILED, CODEX_AUTOMERGE_REARM_FAILED]) {
    assert.equal(isRetryableReviewFailureDescription(`review: ${detail}`), true, detail);
  }
  // #1289 round 1 (Codex 4439713463) — the hint is not settled up front; the re-judge (the finding guard and the
  // terminal recovery) runs inside the one step that settles it only once it has ended
  const settle = gate.slice(gate.indexOf('export async function settleUnmatchedRecoveryRequest('), gate.indexOf('export async function withRearmSettlement('));
  assert.match(settle, /if \(newestTokenedSuccess\(statuses, recoveryRequest\.terminalStatusId\)\) return 'rearm';/u);
  assert.doesNotMatch(settle, /REARM_CONSUMED_OUTCOME/u);
  const runBody = gate.slice(gate.indexOf('export async function run()'));
  const wrap = runBody.indexOf('await withRearmSettlement(client, pullRequest, expectedHead, rearmRequest, async () => {');
  assert.ok(runBody.indexOf('await settleUnmatchedRecoveryRequest(') > 0 && wrap > runBody.indexOf('await settleUnmatchedRecoveryRequest('));
  const inside = runBody.slice(wrap, runBody.indexOf('\n  });\n', wrap));
  assert.ok(inside.includes('await guardAgainstCurrentHeadFinding(') && inside.includes('await ensureTerminalReviewState('),
    'the guard and the terminal recovery both run inside the settling step');
});

// Stage 1 re-check G2 (mutant M13) — the orchestrate run tells a re-arm request from a stale one: the request naming
// this head's newest tokened success is CONSUMED (a success settlement, then the success's own recovery), never
// marked superseded; a request naming an older success is superseded under the re-arm name, so the watchdog's
// once-per-head bound holds; any other is superseded as before.
test('G3 — an unmatched recovery request: the re-arm hint is kept for its re-judge, a stale one superseded', async () => {
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
  assert.equal(hint.outcome, 'rearm');
  assert.deepEqual(hint.writes, [], 'nothing is settled before the re-judge runs (#1289 round 1)');
  const stale = await settle([success(6300), success(6100)], request(6100));
  assert.equal(stale.outcome, 'superseded');
  assert.deepEqual(stale.writes, [{ state: 'failure', description: REARM_REQUEST_SUPERSEDED, context: 'codex-recovery-request/6100' }]);
  const failure = { id: 6050, context: 'codex-current-head', state: 'failure', description: 'review: Codex review timed out after two attempts' };
  const other = await settle([success(6300), failure], request(6050));
  assert.deepEqual(other.writes.map((w) => w.description), ['recovery: request superseded by newer review state']);
});

// #1289 round 1 (Codex 4439713463) — the re-arm request is settled only once its re-judge has ended. A re-judge that
// ends is consumed (the head's one re-arm is spent); one that throws marks the request failed, which is no
// settlement, so the watchdog asks again for that success; a failed mark never replaces the original error.
test('G3 — withRearmSettlement: consumed after the re-judge ends, re-askable when it throws', async () => {
  const { withRearmSettlement } = await import('./autonomous-review-gate.mjs');
  const { gateRearmStatus } = await import('./correction-lease.mjs');
  const { REARM_ATTEMPT_FAILED, REARM_SETTLEMENTS } = await import('./review-policy.mjs');
  const head = 'c'.repeat(40);
  const pull = { number: 7, html_url: 'u' };
  const request = { terminalStatusId: '6100', status: { context: 'codex-recovery-request/6100' } };
  const make = (failWrite = false) => {
    const writes = [];
    return { writes, client: { async setStatus(sha, state, description, url, context) {
      if (failWrite) throw new Error('status write 502');
      writes.push({ state, description, context }); return { id: 1 };
    } } };
  };
  // ends: the step runs first, then the consumption
  const ok = make();
  const order = [];
  assert.equal(await withRearmSettlement(ok.client, pull, head, request, async () => { order.push(ok.writes.length); return true; }), true);
  assert.deepEqual(order, [0], 'nothing written before the step');
  assert.deepEqual(ok.writes, [{ state: 'success', description: 'recovery: consumed by recovered success re-authorization', context: 'codex-recovery-request/6100' }]);
  assert.ok(REARM_SETTLEMENTS.includes(ok.writes[0].description));
  // throws: the request is marked failed, the original error surfaces, and nothing consumes it
  const bad = make();
  await assert.rejects(withRearmSettlement(bad.client, pull, head, request, async () => { throw new Error('record read 502'); }), /record read 502/u);
  assert.deepEqual(bad.writes, [{ state: 'failure', description: REARM_ATTEMPT_FAILED, context: 'codex-recovery-request/6100' }]);
  assert.equal(REARM_SETTLEMENTS.includes(REARM_ATTEMPT_FAILED), false);
  // a failed mark keeps the original error
  const down = make(true);
  await assert.rejects(withRearmSettlement(down.client, pull, head, request, async () => { throw new Error('record read 502'); }), /record read 502/u);
  // no re-arm request: the step alone, nothing written
  const none = make();
  assert.equal(await withRearmSettlement(none.client, pull, head, null, async () => 'x'), 'x');
  assert.deepEqual(none.writes, []);
  // the watchdog: a failed attempt is asked again; pending or consumed holds it
  const pr = { state: 'open', draft: false, auto_merge: null };
  const green = { id: 6100, context: 'codex-current-head', state: 'success', description: 'review: Codex found no blocking issue on this exact head [wi:none]' };
  const req = (state, description) => ({ id: 9, context: 'codex-recovery-request/6100', state, description });
  assert.equal(gateRearmStatus({ statuses: [green, req('failure', REARM_ATTEMPT_FAILED)] }, pr)?.id, 6100);
  assert.equal(gateRearmStatus({ statuses: [green, req('pending', 'recovery: requested terminal status 6100')] }, pr), null);
  assert.equal(gateRearmStatus({ statuses: [green, req('success', 'recovery: consumed by recovered success re-authorization')] }, pr), null);
});

// #1289 round 1, Stage 1 option (c) — a run that dies before it settles its re-arm request (a failure, a timeout, a
// cancel) is cleaned up by the owner job's `failure() || cancelled()` step: a still-pending re-arm request is marked
// failed, so the watchdog asks again; anything already settled, or a request for a failure, is left as it is.
test('G3 — the owner job\'s cleanup marks only a still-pending re-arm request', async () => {
  const { markAbandonedRearmRequest, recordAdoptedRearmRequest } = await import('./autonomous-review-gate.mjs');
  const { REARM_ATTEMPT_FAILED } = await import('./review-policy.mjs');
  const { gateRearmStatus } = await import('./correction-lease.mjs');
  const head = 'c'.repeat(40);
  const green = { id: 6100, context: 'codex-current-head', state: 'success', description: 'review: Codex found no blocking issue on this exact head [wi:none]' };
  const pending = { id: 9, context: 'codex-recovery-request/6100', state: 'pending', description: 'recovery: requested terminal status 6100' };
  const drive = async (statuses, id = '6100', sha = head) => {
    const writes = [];
    const client = {
      async statuses(at) { assert.equal(at, sha); return statuses; },
      async setStatus(at, state, description, url, context) { writes.push({ at, state, description, url, context }); return { id: 1 }; },
    };
    return { outcome: await markAbandonedRearmRequest(client, sha, id, 'https://github.com/JagPat/PMCvitan/pull/7'), writes };
  };
  const marked = await drive([pending, green]);
  assert.equal(marked.outcome, 'marked');
  assert.deepEqual(marked.writes, [{ at: head, state: 'failure', description: REARM_ATTEMPT_FAILED, url: 'https://github.com/JagPat/PMCvitan/pull/7', context: 'codex-recovery-request/6100' }]);
  // and the watchdog asks again once it is marked
  const after = [{ ...pending, id: 10, state: 'failure', description: REARM_ATTEMPT_FAILED }, pending, green];
  assert.equal(gateRearmStatus({ statuses: after }, { state: 'open', draft: false, auto_merge: null })?.id, 6100);
  // already settled (consumed, or marked by the run itself): nothing written
  for (const settled of [
    { ...pending, id: 10, state: 'success', description: 'recovery: consumed by recovered success re-authorization' },
    { ...pending, id: 10, state: 'failure', description: REARM_ATTEMPT_FAILED },
  ]) {
    const done = await drive([settled, pending, green]);
    assert.equal(done.outcome, 'settled');
    assert.deepEqual(done.writes, []);
  }
  // a request for a retryable failure is not a re-arm
  const failure = { id: 6100, context: 'codex-current-head', state: 'failure', description: 'review: Codex review timed out after two attempts' };
  const notRearm = await drive([pending, failure]);
  assert.equal(notRearm.outcome, 'not-rearm');
  assert.deepEqual(notRearm.writes, []);
  // nothing adopted (a CI-triggered run with no inputs): no read, no write
  assert.equal((await markAbandonedRearmRequest({ async statuses() { throw new Error('no read'); } }, head, '', null)), 'skipped');
  assert.equal((await markAbandonedRearmRequest({ async statuses() { throw new Error('no read'); } }, '', '6100', null)), 'skipped');
  // the orchestrate run records the request it adopted in the job env, for the cleanup step
  const { mkdtempSync, readFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const envFile = join(mkdtempSync(join(tmpdir(), 'rearm-')), 'env');
  assert.equal(recordAdoptedRearmRequest(head, { terminalStatusId: '6100' }, { GITHUB_ENV: envFile }), true);
  assert.equal(readFileSync(envFile, 'utf8'), `REARM_HEAD_SHA=${head}\nREARM_REQUEST_ID=6100\n`);
  assert.equal(recordAdoptedRearmRequest(head, null, { GITHUB_ENV: envFile }), false);
  assert.equal(recordAdoptedRearmRequest(head, { terminalStatusId: '6100' }, {}), false);
});

test('G3 — structural: the owner job runs the cleanup on failure or cancel; run() records the adopted request', async () => {
  const workflow = await readFile(new URL('../.github/workflows/auto-merge.yml', import.meta.url), 'utf8');
  const owner = workflow.slice(workflow.indexOf('  orchestrate:'));
  const orchestrate = owner.indexOf('- name: Orchestrate CI, Codex review, and auto-merge');
  const cleanup = owner.indexOf('- name: Mark an abandoned re-arm request (G3)');
  assert.ok(orchestrate > 0 && cleanup > orchestrate, 'the cleanup follows the orchestrate step in the owner job');
  const step = owner.slice(cleanup, owner.indexOf('run: node scripts/autonomous-review-gate.mjs', cleanup));
  assert.match(step, /if: \$\{\{ failure\(\) \|\| cancelled\(\) \}\}/u);
  assert.match(step, /AUTONOMOUS_REVIEW_MODE: rearm-cleanup/u);
  assert.match(step, /REARM_REQUEST_ID: \$\{\{ env\.REARM_REQUEST_ID \|\| inputs\.terminal_status_id \}\}/u);
  assert.match(step, /REARM_HEAD_SHA: \$\{\{ env\.REARM_HEAD_SHA \|\| inputs\.head_sha \}\}/u);
  const gate = await readFile(new URL('./autonomous-review-gate.mjs', import.meta.url), 'utf8');
  const runBody = gate.slice(gate.indexOf('export async function run()'));
  assert.ok(runBody.indexOf("process.env.AUTONOMOUS_REVIEW_MODE === 'rearm-cleanup'") < runBody.indexOf('await eventContext()'));
  const adopt = runBody.indexOf('recordAdoptedRearmRequest(expectedHead, rearmRequest);');
  assert.ok(adopt > 0 && adopt < runBody.indexOf('await withRearmSettlement('), 'recorded before its re-judge runs');
});

// #1289 round 2 (Codex 4440043724) — a re-judge whose merge validation raced a base, head or readiness change is
// marked a failed attempt (the watchdog asks again), not consumed; any other ending still spends the head's re-arm.
// The recovered success records how its merge ended for the settlement.
test('G3 — a re-arm whose merge raced its validation stays re-askable', async () => {
  const { withRearmSettlement } = await import('./autonomous-review-gate.mjs');
  const { REARM_ATTEMPT_FAILED } = await import('./review-policy.mjs');
  const head = 'c'.repeat(40);
  const pull = { number: 7, html_url: 'u' };
  const request = { terminalStatusId: '6100', status: { context: 'codex-recovery-request/6100' } };
  const settle = async (completion) => {
    const writes = [];
    const client = { async setStatus(sha, state, description, url, context) { writes.push({ state, description, context }); return { id: 1 }; } };
    const outcome = {};
    const result = await withRearmSettlement(client, pull, head, request, async () => { outcome.completion = completion; return true; }, outcome);
    return { result, writes };
  };
  const raced = await settle('held_changed');
  assert.equal(raced.result, true);
  assert.deepEqual(raced.writes, [{ state: 'failure', description: REARM_ATTEMPT_FAILED, context: 'codex-recovery-request/6100' }]);
  for (const completion of ['held_for_gates', 'queued', 'merged', 'review_refused', undefined]) {
    const ended = await settle(completion);
    assert.deepEqual(ended.writes.map((w) => w.description), ['recovery: consumed by recovered success re-authorization'], String(completion));
  }
  const gate = await readFile(new URL('./autonomous-review-gate.mjs', import.meta.url), 'utf8');
  const recovery = gate.slice(gate.indexOf('export async function ensureTerminalReviewState('), gate.indexOf('async function waitForRequiredChecks'));
  assert.match(recovery, /const recoveredCompletion = await completeReviewedPullRequest\([\s\S]{0,200}if \(outcome\) outcome\.completion = recoveredCompletion;/u);
  const runBody = gate.slice(gate.indexOf('export async function run()'));
  assert.match(runBody, /existingStatuses,\s*rearmOutcome,\s*\)\);\s*\}, rearmOutcome\);/u);
});

// #1289 round 2 (Codex 4440043736) — a retryable failure buried under the head's newest success is no recovery the
// gate will authorize, so the watchdog does not ask about it: the unarmed green goes to the re-arm instead.
test('G3 — a buried retryable failure does not starve the re-arm', async () => {
  const { gateRecoveryStatus, gateRearmStatus } = await import('./correction-lease.mjs');
  const green = { id: 6100, context: 'codex-current-head', state: 'success', description: 'review: Codex found no blocking issue on this exact head [wi:none]' };
  const buried = { id: 6050, context: 'codex-current-head', state: 'failure', description: 'review: Codex review timed out after two attempts' };
  const combined = { statuses: [green, buried] };
  assert.equal(gateRecoveryStatus(combined), null);
  assert.equal(gateRearmStatus(combined, { state: 'open', draft: false, auto_merge: null })?.id, 6100);
  assert.equal(authorizeRecoveryDispatch([green, buried], '6050'), null, 'the buried failure is refused by the gate anyway');
  // the newest retryable failure is still asked about
  assert.equal(gateRecoveryStatus({ statuses: [buried, green] })?.id, 6050);
});
