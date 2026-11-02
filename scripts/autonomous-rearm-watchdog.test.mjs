import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  AutoMergeDisarmFailed,
  authorizeRecoveryDispatch,
  disarmBeforeRun,
  ensureTerminalReviewState,
  markAbandonedRearmRequest,
  newestTokenedSuccess,
  pendingRecoveryRequest,
  persistRecoveryRequest,
  recordAdoptedRearmRequest,
  settleUnmatchedRecoveryRequest,
  withRearmSettlement,
} from './autonomous-review-gate.mjs';
import { gateRearmStatus, gateRecoveryStatus } from './correction-lease.mjs';
import {
  CODEX_AUTOMERGE_DISARM_FAILED,
  REARM_ATTEMPT_FAILED,
  REARM_REQUEST_ABANDONED_MS,
  REARM_REQUEST_SUPERSEDED,
  REARM_SETTLEMENTS,
  rearmRequestContext,
  rearmRequestDescription,
} from './review-policy.mjs';

/**
 * G3b — the watchdog re-arm (notes/gate-codex-silent/g3/split-plan.md). G3a′ disarms a queued auto-merge before every
 * success and re-arms only after the merge's authorization; a green whose arming was lost on any path is left ready,
 * tokened and unarmed. The handoff's watchdog (`gateRearmStatus`) asks the gate's recovery to re-judge it, once per
 * re-judged success and per pull request; the re-judge re-arms only through `completeReviewedPullRequest`.
 */
const HEAD = 'c'.repeat(40);
const PR = 7;
const CONTEXT = rearmRequestContext('6100', PR);
const ready = (extra = {}) => ({ number: PR, state: 'open', draft: false, auto_merge: null, html_url: 'u', ...extra });
const success = (id, description = 'review: Codex found no blocking issue on this exact head [wi:none]') =>
  ({ id, context: 'codex-current-head', state: 'success', description });
const green = success(6100);
const requestStatus = (state = 'pending', description = rearmRequestDescription('6100', PR), extra = {}) =>
  ({ id: 9, context: CONTEXT, state, description, ...extra });
const adopted = { terminalStatusId: '6100', status: { context: CONTEXT } };
const writer = (failWrite = false) => {
  const writes = [];
  return { writes, client: { async setStatus(sha, state, description, url, context) {
    if (failWrite) throw new Error('status write 502');
    writes.push({ state, description, context }); return { id: 1 };
  } } };
};

test('G3b — the dispatch\'s status id is a hint: only this head\'s newest tokened success, named exactly, is authorized', () => {
  const older = success(6099);
  const pending = { id: 6101, context: 'codex-current-head', state: 'pending', description: 'review: pending required CI and current-head Codex review' };
  assert.equal(authorizeRecoveryDispatch([green, older], '6100'), green);
  assert.equal(newestTokenedSuccess([green, older], '6100'), green);
  assert.equal(authorizeRecoveryDispatch([green, older], '6099'), null, 'a stale id');
  assert.equal(authorizeRecoveryDispatch([green], '12345'), null, 'another head\'s id');
  assert.equal(authorizeRecoveryDispatch([success(6102, 'review: clean')], '6102'), null, 'an untokened success');
  assert.equal(authorizeRecoveryDispatch([pending, green], '6100'), null, 'a success beneath a newer review');
  assert.equal(newestTokenedSuccess([green], ''), null);
  // the old contract is unchanged: the active pending status and a retryable failure are still authorized
  assert.equal(authorizeRecoveryDispatch([pending, green], '6101'), pending);
  const timedOut = { id: 6103, context: 'codex-current-head', state: 'failure', description: 'review: Codex review timed out' };
  assert.equal(authorizeRecoveryDispatch([timedOut], '6103'), timedOut);
  // gap-check F2c on #1289: judged before an older non-retryable failure beneath the newest success
  const finding = { id: 6000, context: 'codex-current-head', state: 'failure', description: 'review: current-head Codex finding on this exact head' };
  assert.equal(authorizeRecoveryDispatch([green, finding], '6100')?.id, 6100);
  assert.equal(authorizeRecoveryDispatch([success(6100, 'review: clean'), finding], '6100'), null);
  assert.equal(authorizeRecoveryDispatch([finding], '6000'), null);
});

// #1289 round 3, Codex 4440445763 — a commit status belongs to the commit, `auto_merge` to the pull request. A re-arm
// request is keyed by its pull request, so a request or settlement for PR A at a commit never holds PR B's watchdog,
// and B's run never adopts, settles or supersedes A's request.
test('G3b (Codex 4440445763) — a re-arm request names its pull request; another PR at the same commit holds nothing', async () => {
  // request-recovery writes the scoped request for a success, the unscoped one for a failure (unchanged)
  const writes = [];
  const client = { async setStatus(sha, state, description, url, context) { writes.push({ state, description, context }); return { id: 1 }; } };
  await persistRecoveryRequest(client, HEAD, ready(), green);
  await persistRecoveryRequest(client, HEAD, ready(), { id: 6050, state: 'failure' });
  assert.deepEqual(writes, [
    { state: 'pending', description: 'recovery: requested terminal status 6100 for pull request #7', context: 'codex-recovery-request/6100/pr-7' },
    { state: 'pending', description: 'recovery: requested terminal status 6050', context: 'codex-recovery-request/6050' },
  ]);
  // the run adopts only its own pull request's re-arm request
  const mine = requestStatus();
  const theirs = { ...requestStatus(), context: rearmRequestContext('6100', 8), description: rearmRequestDescription('6100', 8) };
  assert.equal(pendingRecoveryRequest([theirs, green], PR), null, 'PR 8\'s request is not PR 7\'s');
  assert.equal(pendingRecoveryRequest([theirs, mine, green], PR)?.status.context, CONTEXT);
  assert.equal(pendingRecoveryRequest([mine, green]), null, 'with no pull request named, no re-arm request is read');
  assert.equal(pendingRecoveryRequest([{ ...mine, description: 'recovery: requested terminal status 6100' }], PR), null, 'a mismatched description');
  // a failure's request is read as before, with or without a pull request
  const failureRequest = { id: 5, context: 'codex-recovery-request/6050', state: 'pending', description: 'recovery: requested terminal status 6050' };
  assert.equal(pendingRecoveryRequest([failureRequest], PR)?.terminalStatusId, '6050');
  assert.equal(pendingRecoveryRequest([failureRequest])?.terminalStatusId, '6050');
  // the watchdog: PR 8's pending request and PR 8's newer consumption hold nothing for PR 7
  assert.equal(gateRearmStatus({ statuses: [theirs, green] }, ready())?.id, 6100);
  const consumedFor = (number) => ({ id: 6101, context: rearmRequestContext('6100', number), state: 'success', description: REARM_SETTLEMENTS[0] });
  assert.equal(gateRearmStatus({ statuses: [consumedFor(8), green] }, ready())?.id, 6100, 'another PR\'s consumption');
  assert.equal(gateRearmStatus({ statuses: [consumedFor(PR), green] }, ready()), null, 'its own consumption holds it');
  assert.equal(gateRearmStatus({ statuses: [consumedFor(17), green] }, ready()).id, 6100, 'PR 17 is not PR 7');
  // and the cleanup marks only this pull request's request
  const cleanup = writer();
  const reads = { async statuses() { return [theirs, green]; } };
  assert.equal(await markAbandonedRearmRequest({ ...reads, ...cleanup.client }, HEAD, '6100', PR, 'u'), 'settled');
  assert.deepEqual(cleanup.writes, []);
});

test('G3b — an unmatched recovery request: the re-arm hint is kept for its re-judge, a stale one superseded', async () => {
  const settle = async (statuses, req) => {
    const { client, writes } = writer();
    return { outcome: await settleUnmatchedRecoveryRequest(client, ready(), HEAD, statuses, req), writes };
  };
  const hint = await settle([green], adopted);
  assert.equal(hint.outcome, 'rearm');
  assert.deepEqual(hint.writes, [], 'nothing is settled before the re-judge runs (#1289 round 1)');
  const stale = await settle([success(6300), green], adopted);
  assert.equal(stale.outcome, 'superseded');
  assert.deepEqual(stale.writes, [{ state: 'failure', description: REARM_REQUEST_SUPERSEDED, context: CONTEXT }]);
  const failure = { id: 6050, context: 'codex-current-head', state: 'failure', description: 'review: Codex review timed out after two attempts' };
  const other = await settle([success(6300), failure], { terminalStatusId: '6050', status: { context: 'codex-recovery-request/6050' } });
  assert.deepEqual(other.writes.map((w) => w.description), ['recovery: request superseded by newer review state']);
});

test('G3b — withRearmSettlement: consumed after the re-judge ends, re-askable when it throws, races or falls through', async () => {
  const ok = writer();
  const order = [];
  assert.equal(await withRearmSettlement(ok.client, ready(), HEAD, adopted, async () => { order.push(ok.writes.length); return true; }), true);
  assert.deepEqual(order, [0], 'nothing written before the step');
  assert.deepEqual(ok.writes, [{ state: 'success', description: 'recovery: consumed by recovered success re-authorization', context: CONTEXT }]);
  assert.ok(REARM_SETTLEMENTS.includes(ok.writes[0].description));
  // throws: marked failed, the original error surfaces
  const bad = writer();
  await assert.rejects(withRearmSettlement(bad.client, ready(), HEAD, adopted, async () => { throw new Error('record read 502'); }), /record read 502/u);
  assert.deepEqual(bad.writes, [{ state: 'failure', description: REARM_ATTEMPT_FAILED, context: CONTEXT }]);
  assert.equal(REARM_SETTLEMENTS.includes(REARM_ATTEMPT_FAILED), false);
  const down = writer(true);
  await assert.rejects(withRearmSettlement(down.client, ready(), HEAD, adopted, async () => { throw new Error('record read 502'); }), /record read 502/u,
    'a failed mark keeps the original error');
  // #1289 round 2 (Codex 4440043724): a merge whose validation raced a change, or found a draft, is marked failed
  const settle = async (completion, result = true) => {
    const { client, writes } = writer();
    const outcome = {};
    const returned = await withRearmSettlement(client, ready(), HEAD, adopted, async () => { outcome.completion = completion; return result; }, outcome);
    return { returned, writes };
  };
  const raced = await settle('held_changed');
  assert.equal(raced.returned, true);
  assert.deepEqual(raced.writes, [{ state: 'failure', description: REARM_ATTEMPT_FAILED, context: CONTEXT }]);
  for (const completion of ['held_for_gates', 'queued', 'merged', 'review_refused', undefined]) {
    assert.deepEqual((await settle(completion)).writes.map((w) => w.description), [REARM_SETTLEMENTS[0]], String(completion));
  }
  // #1289 round 3 (Codex 4440445746): the recovered success did not end the run (a drafted PR: the ordinary review
  // runs next, outside this settlement), so the request is marked failed, never consumed
  const fellThrough = await settle(undefined, false);
  assert.equal(fellThrough.returned, false);
  assert.deepEqual(fellThrough.writes, [{ state: 'failure', description: REARM_ATTEMPT_FAILED, context: CONTEXT }]);
  // no re-arm request: the step alone, nothing written
  const none = writer();
  assert.equal(await withRearmSettlement(none.client, ready(), HEAD, null, async () => false), false);
  assert.deepEqual(none.writes, []);
});

const repo = { full_name: 'JagPat/PMCvitan' };
const full = (extra = {}) => ({
  ...ready(), node_id: 'PR_7', head: { sha: HEAD, ref: 'claude/g3b', repo }, base: { ref: 'main', sha: 'b'.repeat(40), repo }, ...extra,
});

test('G3b (Codex 4440445746) — a recovered success on a drafted PR writes nothing and arms nothing; its request is re-askable', async () => {
  const calls = [];
  const client = new Proxy({}, { get: (_, name) => async () => {
    calls.push(name);
    if (name === 'pullRequest') return full({ draft: true });
    if (name === 'statuses' || name === 'checkRuns' || name === 'issueComments') return [];
    throw new Error(`unexpected ${String(name)}`);
  } });
  const outcome = {};
  assert.equal(await ensureTerminalReviewState(client, full(), HEAD, green, [green], outcome), false);
  assert.deepEqual(calls, ['pullRequest'], 'one live read, then nothing written, disabled or armed');
  // through the settlement, as run() wraps it: marked failed, so once the PR is ready again the watchdog asks again
  const { client: statusClient, writes } = writer();
  const wrapped = { ...statusClient };
  const result = await withRearmSettlement(wrapped, ready(), HEAD, adopted,
    () => ensureTerminalReviewState(client, full(), HEAD, green, [green], outcome), outcome);
  assert.equal(result, false);
  assert.deepEqual(writes, [{ state: 'failure', description: REARM_ATTEMPT_FAILED, context: CONTEXT }]);
  assert.equal(gateRearmStatus({ statuses: [requestStatus('failure', REARM_ATTEMPT_FAILED), green] }, ready())?.id, 6100);
  // and a structural row: run() reads the step's boolean through the settlement, and only a true result returns
  const gate = await readFile(new URL('./autonomous-review-gate.mjs', import.meta.url), 'utf8');
  const helper = gate.slice(gate.indexOf('export async function withRearmSettlement('), gate.indexOf('export function recordAdoptedRearmRequest('));
  assert.match(helper, /if \(!result \|\| outcome\.completion === 'held_changed'\) \{\s*await client\.setStatus\(expectedHead, 'failure', REARM_ATTEMPT_FAILED/u);
});

test('G3b — the watchdog: a failed attempt is asked again; pending within the limit or consumed holds it', () => {
  assert.equal(gateRearmStatus({ statuses: [green, requestStatus('failure', REARM_ATTEMPT_FAILED)] }, ready())?.id, 6100);
  assert.equal(gateRearmStatus({ statuses: [green, requestStatus()] }, ready()), null);
  assert.equal(gateRearmStatus({ statuses: [green, requestStatus('success', REARM_SETTLEMENTS[0])] }, ready()), null);
  // no pull request number: nothing asked (the key needs it)
  assert.equal(gateRearmStatus({ statuses: [green] }, ready({ number: undefined })), null);
  const now = '2026-08-17T12:00:00Z';
  const at = (ms) => new Date(Date.parse(now) - ms).toISOString();
  const pending = (extra) => requestStatus('pending', rearmRequestDescription('6100', PR), extra);
  assert.equal(gateRearmStatus({ statuses: [pending({ updated_at: at(REARM_REQUEST_ABANDONED_MS + 60_000) }), green] }, ready(), now)?.id, 6100, 'abandoned');
  assert.equal(gateRearmStatus({ statuses: [pending({ created_at: at(REARM_REQUEST_ABANDONED_MS + 60_000) }), green] }, ready(), now)?.id, 6100, 'created_at');
  assert.equal(gateRearmStatus({ statuses: [pending({ updated_at: at(REARM_REQUEST_ABANDONED_MS - 60_000) }), green] }, ready(), now), null, 'within');
  assert.equal(gateRearmStatus({ statuses: [pending({ updated_at: at(REARM_REQUEST_ABANDONED_MS + 60_000) }), green] }, ready()), null, 'no clock');
  assert.equal(gateRearmStatus({ statuses: [pending({ updated_at: 'not a time' }), green] }, ready(), now), null, 'unreadable time');
  const settledOld = requestStatus('failure', REARM_REQUEST_SUPERSEDED, { updated_at: at(REARM_REQUEST_ABANDONED_MS * 2) });
  assert.equal(gateRearmStatus({ statuses: [green, settledOld] }, ready(), now), null, 'age never lifts a settled request');
});

test('G3b — the abandoned limit stays above twice the owner job\'s limit', async () => {
  const workflow = await readFile(new URL('../.github/workflows/auto-merge.yml', import.meta.url), 'utf8');
  const owner = workflow.slice(workflow.indexOf('  orchestrate:'));
  const minutes = Number(/timeout-minutes: (\d+)/u.exec(owner)?.[1]);
  assert.ok(minutes > 0 && REARM_REQUEST_ABANDONED_MS > 2 * minutes * 60_000);
});

// #1289 round 2 (Codex 4440043736) — a retryable failure buried under the newest success is no recovery the gate will
// authorize, so the watchdog does not ask about it: the unarmed green goes to the re-arm instead.
test('G3b — a buried retryable failure does not starve the re-arm', () => {
  const buried = { id: 6050, context: 'codex-current-head', state: 'failure', description: 'review: Codex review timed out after two attempts' };
  assert.equal(gateRecoveryStatus({ statuses: [green, buried] }), null);
  assert.equal(gateRearmStatus({ statuses: [green, buried] }, ready())?.id, 6100);
  assert.equal(authorizeRecoveryDispatch([green, buried], '6050'), null);
  assert.equal(gateRecoveryStatus({ statuses: [buried, green] })?.id, 6050);
});

test('G3b — the owner job\'s cleanup marks only this PR\'s still-pending re-arm request', async () => {
  const drive = async (statuses, id = '6100', sha = HEAD, number = PR) => {
    const writes = [];
    const client = {
      async statuses(head) { assert.equal(head, sha); return statuses; },
      async setStatus(head, state, description, url, context) { writes.push({ head, state, description, url, context }); return { id: 1 }; },
    };
    return { outcome: await markAbandonedRearmRequest(client, sha, id, number, 'https://github.com/JagPat/PMCvitan/pull/7'), writes };
  };
  const marked = await drive([requestStatus(), green]);
  assert.equal(marked.outcome, 'marked');
  assert.deepEqual(marked.writes, [{ head: HEAD, state: 'failure', description: REARM_ATTEMPT_FAILED, url: 'https://github.com/JagPat/PMCvitan/pull/7', context: CONTEXT }]);
  for (const settled of [requestStatus('success', REARM_SETTLEMENTS[0]), requestStatus('failure', REARM_ATTEMPT_FAILED)]) {
    const done = await drive([settled, green]);
    assert.equal(done.outcome, 'settled');
    assert.deepEqual(done.writes, []);
  }
  const noRead = { async statuses() { throw new Error('no read'); } };
  assert.equal(await markAbandonedRearmRequest(noRead, HEAD, '', PR, null), 'skipped', 'nothing adopted');
  assert.equal(await markAbandonedRearmRequest(noRead, '', '6100', PR, null), 'skipped');
  assert.equal(await markAbandonedRearmRequest(noRead, HEAD, '6100', '', null), 'skipped', 'no pull request');
  // the orchestrate run records the request it adopted, with its pull request, for the cleanup step
  const { mkdtempSync, readFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const envFile = join(mkdtempSync(join(tmpdir(), 'rearm-')), 'env');
  assert.equal(recordAdoptedRearmRequest(HEAD, PR, adopted, { GITHUB_ENV: envFile }), true);
  assert.equal(readFileSync(envFile, 'utf8'), `REARM_HEAD_SHA=${HEAD}\nREARM_REQUEST_ID=6100\nREARM_PR_NUMBER=7\n`);
  assert.equal(recordAdoptedRearmRequest(HEAD, PR, null, { GITHUB_ENV: envFile }), false);
  assert.equal(recordAdoptedRearmRequest(HEAD, PR, adopted, {}), false);
});

test('G3b — structural: the owner job runs the cleanup on failure or cancel; run() adopts and settles the request', async () => {
  const workflow = await readFile(new URL('../.github/workflows/auto-merge.yml', import.meta.url), 'utf8');
  const owner = workflow.slice(workflow.indexOf('  orchestrate:'));
  const orchestrate = owner.indexOf('- name: Orchestrate CI, Codex review, and auto-merge');
  const cleanup = owner.indexOf('- name: Mark an abandoned re-arm request (G3b)');
  assert.ok(orchestrate > 0 && cleanup > orchestrate, 'the cleanup follows the orchestrate step in the owner job');
  const step = owner.slice(cleanup, owner.indexOf('run: node scripts/autonomous-review-gate.mjs', cleanup));
  assert.match(step, /if: \$\{\{ \(failure\(\) \|\| cancelled\(\)\) && env\.REARM_REQUEST_ID != '' \}\}/u);
  assert.match(step, /AUTONOMOUS_REVIEW_MODE: rearm-cleanup/u);
  assert.match(step, /pull\/\$\{\{ env\.REARM_PR_NUMBER \}\}/u);
  const gate = await readFile(new URL('./autonomous-review-gate.mjs', import.meta.url), 'utf8');
  const runBody = gate.slice(gate.indexOf('export async function run()'));
  assert.ok(runBody.indexOf("process.env.AUTONOMOUS_REVIEW_MODE === 'rearm-cleanup'") < runBody.indexOf('await eventContext()'));
  assert.match(runBody, /pendingRecoveryRequest\(existingStatuses, pullRequest\.number\)/u);
  const adopt = runBody.indexOf('recordAdoptedRearmRequest(expectedHead, pullRequest.number, rearmRequest);');
  assert.ok(adopt > 0 && adopt < runBody.indexOf('await withRearmSettlement('), 'recorded before its re-judge runs');
  assert.match(runBody, /existingStatuses,\s*rearmOutcome,\s*\)\);\s*\}, rearmOutcome\);/u);
  const recovery = gate.slice(gate.indexOf('export async function ensureTerminalReviewState('), gate.indexOf('async function waitForRequiredChecks'));
  assert.match(recovery, /const recoveredCompletion = await completeReviewedPullRequest\([\s\S]{0,400}if \(outcome\) outcome\.completion = recoveredCompletion;/u);
  // the handoff asks with its clock and re-reads the live pull request before dispatching
  const handoff = await readFile(new URL('./autonomous-handoff.mjs', import.meta.url), 'utf8');
  assert.match(handoff, /gateRearmStatus\(combined, pullRequest, now\)\s*&& gateRearmStatus\(combined, await client\.pullRequest\(pullRequest\.number\), now\)/u);
});

// Stage 1's G3a round-2 ruling (Codex 4441198763) — after a push, the pull request's own CI-triggered run disarms its
// queued merge before anything else on the new head; only its own authorization arms it again.
test('G3b — a CI-triggered run disarms its own queued merge first; a disarm not confirmed is held, nothing green', async () => {
  const armed = full({ auto_merge: { enabled_at: '2026-11-02T00:00:00Z' } });
  const unarmed = { ...armed, auto_merge: null };
  const make = ({ reads, disable = async () => {} }) => {
    const calls = [];
    return { calls, client: {
      async pullRequest() { calls.push(['read']); return reads.shift(); },
      async openPullRequestsAt() { calls.push(['list']); return [unarmed]; },
      async disableAutoMerge() { calls.push(['disable']); return disable(); },
      async setStatus(sha, state, description) { calls.push(['status', state, description]); return { id: 1 }; },
      async setDraft(pull) { calls.push(['draft']); return { ...pull, draft: true }; },
      async updateStickyComment() { calls.push(['sticky']); },
      async statuses() { return []; },
    } };
  };
  // nothing queued: no read, no write
  const quiet = make({ reads: [] });
  assert.equal(await disarmBeforeRun(quiet.client, unarmed, HEAD), unarmed);
  assert.deepEqual(quiet.calls, []);
  // queued: check the head, disable, re-read; the disarmed PR is the run's
  const ok = make({ reads: [armed, unarmed] });
  assert.equal((await disarmBeforeRun(ok.client, armed, HEAD)).auto_merge, null);
  assert.deepEqual(ok.calls.map(([k]) => k), ['read', 'list', 'disable', 'read']);
  // a disarm not confirmed: the retryable hold, rethrown
  const stuck = make({ reads: [armed, armed] });
  await assert.rejects(disarmBeforeRun(stuck.client, armed, HEAD), AutoMergeDisarmFailed);
  assert.ok(stuck.calls.some(([k, state, description]) => k === 'status' && state === 'failure' && description.includes(CODEX_AUTOMERGE_DISARM_FAILED)));
  assert.equal(stuck.calls.some(([k, state]) => k === 'status' && state === 'success'), false);
  // structural: run() takes it on a CI trigger right after the untokened withdrawal, before any scope or recovery read
  const gate = await readFile(new URL('./autonomous-review-gate.mjs', import.meta.url), 'utf8');
  const runBody = gate.slice(gate.indexOf('export async function run()'));
  const withdraw = runBody.indexOf('await withdrawUntokenedSuccess(client, pullRequest, expectedHead, existingStatus);');
  const first = runBody.indexOf("if (context.trigger === 'ci') {\n    pullRequest = await disarmBeforeRun(client, pullRequest, expectedHead, existingStatuses);");
  assert.ok(withdraw > 0 && first > withdraw, 'after the withdrawal');
  assert.ok(first < runBody.indexOf('await enforceReviewScope('), 'before the scope read');
  assert.ok(first < runBody.indexOf('pendingRecoveryRequest(existingStatuses'), 'before the recovery request');
});

// G3b gap-check G1 (Stage 1 probe p1-consumed-then-disarmed) — a watchdog re-arm republished S2, armed the PR and
// consumed its request at C > S2. A later run disarms the PR and ends without a new success (or a person disables the
// merge, or a body edit lifts an ownership hold): the head is green, tokened, unarmed. (a) The run's own confirmed
// disarm lifts this PR's newest consumed settlement, so the watchdog asks again; a lift that fails keeps the disarm's
// outcome. (b) Whatever disarmed it, the consumption holds the watchdog only for `REARM_REQUEST_ABANDONED_MS`.
test('G3b (gap-check G1) — a consumption from an earlier re-arm stops holding once the head is disarmed or the limit passes', async () => {
  const consumedAt = '2026-11-02T10:00:00Z';
  const consumed = { id: 9200, context: rearmRequestContext('9000', PR), state: 'success', description: REARM_SETTLEMENTS[0], updated_at: consumedAt };
  const s2 = { ...success(9100, 'review: recovered prior clean Codex result on this exact head [wi:none]'), updated_at: '2026-11-02T09:59:00Z' };
  const other = { id: 9300, context: rearmRequestContext('9000', PR + 1), state: 'success', description: REARM_SETTLEMENTS[0], updated_at: consumedAt };
  const at = (ms) => new Date(Date.parse(consumedAt) + ms).toISOString();
  // the probe: within the limit, the consumption holds the watchdog (the re-judge's own success was already judged)
  assert.equal(gateRearmStatus({ statuses: [consumed, s2] }, ready(), at(60_000)), null);
  // (b) past the limit it no longer holds: asked about again, once per limit
  assert.equal(gateRearmStatus({ statuses: [consumed, s2] }, ready(), at(REARM_REQUEST_ABANDONED_MS + 60_000))?.id, 9100);
  // (a) a CI-triggered run's confirmed disarm lifts this PR's newest consumed settlement, and only this PR's
  const armed = full({ auto_merge: { enabled_at: '2026-11-02T10:00:00Z' } });
  const unarmed = { ...armed, auto_merge: null };
  const make = (failMark = false) => {
    const calls = [];
    const reads = [armed, unarmed];
    return { calls, client: {
      async pullRequest() { calls.push(['read']); return reads.shift(); },
      async openPullRequestsAt() { return [unarmed]; },
      async disableAutoMerge() { calls.push(['disable']); },
      async setStatus(sha, state, description, url, context) {
        if (failMark && description === REARM_ATTEMPT_FAILED) throw new Error('status write 502');
        calls.push(['status', state, description, context]); return { id: 1 };
      },
    } };
  };
  const lifted = make();
  assert.equal((await disarmBeforeRun(lifted.client, armed, HEAD, [other, consumed, s2])).auto_merge, null);
  const marks = lifted.calls.filter(([k]) => k === 'status');
  assert.deepEqual(marks, [['status', 'failure', REARM_ATTEMPT_FAILED, consumed.context]]);
  // with the lift written, the watchdog asks at once, well inside the limit
  const after = { ...consumed, id: 9400, state: 'failure', description: REARM_ATTEMPT_FAILED };
  assert.equal(gateRearmStatus({ statuses: [after, other, s2] }, ready(), at(60_000))?.id, 9100);
  // a lift that fails keeps the disarm's outcome; (b) then ends the strand
  const failed = make(true);
  assert.equal((await disarmBeforeRun(failed.client, armed, HEAD, [consumed, s2])).auto_merge, null);
  // nothing queued: no read, nothing lifted
  const quiet = make();
  assert.equal(await disarmBeforeRun(quiet.client, unarmed, HEAD, [consumed, s2]), unarmed);
  assert.deepEqual(quiet.calls, []);
});

// G3b (Stage 1, X2g) — behavioural, through `run()` itself: every GitHubClient method, `request` and `graphql`
// included, is replaced by a recorder, so an arm or merge reached from anywhere in `run()`, by any name (a computed
// property name too), is seen by its effect. Each arm or merge asserts, when it is called, that Codex's record was
// read after the newest success write; an arm before the merge authorization is a violation whatever called it.
test('G3b (X2g) — run() end to end: an arm or merge, by any name, comes only after the record read that follows the success', async () => {
  const { GitHubClient, REQUIRED_CHECKS, run } = await import('./autonomous-review-gate.mjs');
  const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const head = 'e'.repeat(40);
  const ARMING = /merge|automerge/iu;
  const scenario = async ({ securityAfterSuccess }) => {
    const statuses = [success(6100)];
    const pull = {
      number: 260, state: 'open', draft: false, additions: 1, deletions: 0, changed_files: 1,
      auto_merge: { enabled_at: '2026-11-02T00:00:00Z', merge_method: 'squash' },
      body: '<!-- review-size: standard -->\n<!-- correction-owner: claude -->',
      head: { sha: head, ref: 'claude/unit', repo: { full_name: 'JagPat/PMCvitan' } },
      base: { ref: 'main', sha: 'b'.repeat(40), repo: { full_name: 'JagPat/PMCvitan' } },
      html_url: 'https://github.com/JagPat/PMCvitan/pull/260',
    };
    const log = [];
    const violations = [];
    let nextId = 6200;
    let lastSuccess = -1;
    let lastRecord = -1;
    const securityRecord = {
      user: { login: 'chatgpt-codex-connector[bot]' }, created_at: '2026-11-02T00:00:00Z',
      body: `<!-- codex-review-state:v1 ${JSON.stringify({
        code_review: { commit_sha: head, has_any_findings: false, has_unresolved_findings: false, status: 'completed' },
        security_review: { commit_sha: head, has_any_findings: true, has_unresolved_findings: true, status: 'completed' },
      })} -->`,
    };
    const arming = (name) => {
      log.push([name]);
      if (!(lastSuccess >= 0 && lastRecord > lastSuccess)) violations.push(`${name} before the record read that follows the success`);
    };
    const stubs = {
      async pullRequest() { return { ...pull }; },
      async statuses() { return [...statuses]; },
      async checkRuns() { return REQUIRED_CHECKS.map((name) => ({ name, conclusion: 'success', status: 'completed' })); },
      async commit(sha) { return { sha, commit: { message: 'fix: x\n\nCorrection-Owner: claude\n' }, files: [] }; },
      async pullRequestFiles() { return [{ filename: 'scripts/x.mjs', status: 'modified', additions: 1, deletions: 0 }]; },
      async replacementLineage() { return { requiredReplacements: [], replacementPullRequests: [] }; },
      async fileContents() { return null; },
      async openPullRequestsAt() { return []; },
      async setStatus(sha, state, description, url, context = 'codex-current-head') {
        const status = { id: nextId += 1, context, state, description };
        statuses.unshift(status);
        log.push(['status', state]);
        if (state === 'success' && context === 'codex-current-head') lastSuccess = log.length - 1;
        return status;
      },
      async issueComments() {
        log.push(['record']);
        lastRecord = log.length - 1;
        return securityAfterSuccess && lastSuccess >= 0 ? [securityRecord] : [];
      },
      async reviewComments() { return []; },
      async reviews() { return []; },
      async reviewThreads() { return []; },
      async reactions() { return []; },
      async setDraft(current, draft) { log.push(['draft', draft]); pull.draft = draft; return { ...current, draft }; },
      async updateStickyComment() { log.push(['sticky']); },
      async createIssueComment() { log.push(['marker']); return { id: 1 }; },
      async disableAutoMerge() { log.push(['disable']); pull.auto_merge = null; },
      async enableAutoMerge(current) { arming('enableAutoMerge'); if (!current.auto_merge) pull.auto_merge = { merge_method: 'squash' }; },
      async mergeExactHead() { arming('mergeExactHead'); return { merged: false, message: 'Pull request is not mergeable yet' }; },
      async dispatchHandoff() { log.push(['handoff']); },
      async request(method, path) {
        if (ARMING.test(String(path))) arming(`request ${method} ${path}`); else log.push(['unstubbed request', method, path]);
        return null;
      },
      async graphql(query) {
        if (ARMING.test(String(query))) arming('graphql'); else log.push(['unstubbed graphql']);
        return {};
      },
    };
    const names = Object.getOwnPropertyNames(GitHubClient.prototype).filter((name) => name !== 'constructor');
    const saved = new Map(names.map((name) => [name, Object.getOwnPropertyDescriptor(GitHubClient.prototype, name)]));
    const env = Object.fromEntries(['GITHUB_REPOSITORY', 'GITHUB_TOKEN', 'GITHUB_EVENT_NAME', 'GITHUB_EVENT_PATH',
      'AUTONOMOUS_REVIEW_MODE', 'GITHUB_ENV', 'PR_NUMBER', 'GITHUB_RUN_ID', 'RUNNER_TEMP'].map((key) => [key, process.env[key]]));
    const dir = await mkdtemp(join(tmpdir(), 'g3b-run-'));
    try {
      for (const name of names) {
        Object.defineProperty(GitHubClient.prototype, name, {
          configurable: true, writable: true,
          value: stubs[name] ?? (async function unstubbed() { log.push(['unstubbed', name]); return undefined; }),
        });
      }
      const eventPath = join(dir, 'event.json');
      await writeFile(eventPath, JSON.stringify({ workflow_run: {
        event: 'pull_request', pull_requests: [{ number: 260 }], head_sha: head, conclusion: 'success', id: 99, run_attempt: 1,
      } }));
      Object.assign(process.env, { GITHUB_REPOSITORY: 'JagPat/PMCvitan', GITHUB_TOKEN: 'test-token',
        GITHUB_EVENT_NAME: 'workflow_run', GITHUB_EVENT_PATH: eventPath });
      for (const key of ['AUTONOMOUS_REVIEW_MODE', 'GITHUB_ENV', 'PR_NUMBER', 'GITHUB_RUN_ID', 'RUNNER_TEMP']) delete process.env[key];
      let error = null;
      try { await run(); } catch (thrown) { error = thrown; }
      return { log, violations, error };
    } finally {
      for (const [name, descriptor] of saved) Object.defineProperty(GitHubClient.prototype, name, descriptor);
      for (const [key, value] of Object.entries(env)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
      await rm(dir, { recursive: true, force: true });
    }
  };

  const clean = await scenario({ securityAfterSuccess: false });
  assert.equal(clean.error, null);
  assert.deepEqual(clean.violations, []);
  assert.ok(clean.log.some(([k]) => k === 'enableAutoMerge'), 'the row is live: run() reaches the arm');
  assert.ok(clean.log.findIndex(([k]) => k === 'disable') < clean.log.findIndex(([k, state]) => k === 'status' && state === 'success'),
    'the CI-triggered run disarms the queued merge before any success');
  assert.deepEqual(clean.log.filter(([k]) => k === 'unstubbed'), [], 'every client call run() made on this path is a recorded stub');
  const refused = await scenario({ securityAfterSuccess: true });
  assert.equal(refused.error, null);
  assert.deepEqual(refused.violations, []);
  assert.equal(refused.log.some(([k]) => k === 'enableAutoMerge' || k === 'mergeExactHead'), false, 'a security finding by the authorization arms nothing');
  assert.equal(refused.log.filter(([k]) => k === 'status').at(-1)[1], 'failure', 'and the green is replaced');
});
