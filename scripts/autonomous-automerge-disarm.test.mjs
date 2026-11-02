import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  AutoMergeDisarmFailed,
  GitHubClient,
  completeCleanReview,
  completeReviewedPullRequest,
  disarmQueuedAutoMerge,
  publishDisarmedSuccess,
  REQUIRED_CHECKS,
} from './autonomous-review-gate.mjs';
import {
  CODEX_AUTOMERGE_DISARM_FAILED,
  CODEX_AUTOMERGE_REARM_FAILED,
  isRetryableReviewFailureDescription,
} from './review-policy.mjs';

/**
 * G3a (#1280 Codex 4438874584; split from #1289 per notes/gate-codex-silent/g3/split-plan.md). A native auto-merge queued from an earlier green
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

function fakeClient({ reads, statuses = {}, disable = async () => {}, siblings = [] } = {}) {
  const calls = [];
  return {
    calls,
    async pullRequest(number) { calls.push(['read', number]); return reads.shift(); },
    async openPullRequestsAt(sha) { calls.push(['list', sha]); return siblings; },
    async disableAutoMerge(pull) { calls.push(['disable', pull.node_id]); return disable(); },
    async statuses(head) { calls.push(['statuses', head]); return statuses[head] ?? []; },
  };
}

test('G3a — a pull request with nothing queued is not disabled', async () => {
  const client = fakeClient({ reads: [pr()] });
  assert.equal((await disarmQueuedAutoMerge(client, 900, HEAD)).head.sha, HEAD);
  assert.deepEqual(client.calls.map(([k]) => k), ['read', 'list']);
});

test('G3a — a queued auto-merge is disabled, in the order check the head, disable, re-read; the disarmed PR is returned', async () => {
  const client = fakeClient({ reads: [armed(), pr()] });
  const live = await disarmQueuedAutoMerge(client, 900, HEAD);
  assert.equal(live.auto_merge, null);
  assert.deepEqual(client.calls.map(([k]) => k), ['read', 'list', 'disable', 'read']);
});

test('G3a — a disable that fails, or a re-read still armed, is the retryable failure: nothing green may follow', async () => {
  const failing = fakeClient({ reads: [armed()], disable: async () => { throw new Error('GraphQL down'); } });
  await assert.rejects(disarmQueuedAutoMerge(failing, 900, HEAD), AutoMergeDisarmFailed);
  const stuck = fakeClient({ reads: [armed(), armed()] });
  await assert.rejects(disarmQueuedAutoMerge(stuck, 900, HEAD), AutoMergeDisarmFailed);
  assert.equal(isRetryableReviewFailureDescription(`review: ${CODEX_AUTOMERGE_DISARM_FAILED}`), true);
});

test('G3a — a head that is no longer current is not touched', async () => {
  const client = fakeClient({ reads: [armed(NEXT)] });
  assert.equal(await disarmQueuedAutoMerge(client, 900, HEAD), null);
  assert.deepEqual(client.calls.map(([k]) => k), ['read']);
});

test('G3a — a push between the head check and the disable: this run writes nothing and dispatches nothing', async () => {
  // the new head's own run writes its success through the same step and arms through its own authorization; a head
  // whose run had already finished stays green and unarmed (G3a's residual, ended by G3b's watchdog re-arm)
  const moved = fakeClient({ reads: [armed(), armed(NEXT)], statuses: { [NEXT]: [success(77)] } });
  assert.equal(await disarmQueuedAutoMerge(moved, 900, HEAD), null);
  assert.deepEqual(moved.calls.map(([k]) => k), ['read', 'list', 'disable', 'read']);
});

test('G3a (gap-check F1) — every failure inside the disarm is the retryable AutoMergeDisarmFailed, never a raw error', async () => {
  const cases = {
    'the first read': fakeClient({ reads: [] }),
    'the re-read after the disable': fakeClient({ reads: [armed()] }),
  };
  for (const [name, client] of Object.entries(cases)) {
    const reads = client.pullRequest;
    client.pullRequest = async (number) => { const next = await reads.call(client, number); if (!next) throw new Error('ECONNRESET'); return next; };
    await assert.rejects(disarmQueuedAutoMerge(client, 900, HEAD), AutoMergeDisarmFailed, name);
  }
});

/** Line and block comments removed; a `//` inside a string (a URL) is kept. */
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/(^|[^:'"`\\])\/\/.*$/gmu, '$1');
}

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
    async openPullRequestsAt() { return []; },
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
  };
  return client;
}

test('G3a (gap-check F4) — the shared success step: an armed head is disabled before the success is written', async () => {
  let armedNow = true;
  const client = gateClient({ live: () => (armedNow ? armed() : pr()), disable: async () => { armedNow = false; } });
  const live = await publishDisarmedSuccess(client, armed(), HEAD, 'review: clean');
  assert.equal(live.auto_merge, null);
  const kinds = client.log.map(([k, , state]) => (k === 'status' ? `status:${state}` : k));
  assert.ok(kinds.indexOf('disable') >= 0 && kinds.indexOf('disable') < kinds.indexOf('status:success'), kinds.join(','));
  assert.equal(kinds.filter((k) => k === 'status:success').length, 1);
});

test('G3a (gap-check F1/F4) — the shared success step: a disarm that fails writes the retryable hold and no success', async () => {
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

test('G3a (gap-check F3) — the re-arm reads the fresh post-disarm pull request, not a stale armed object, and names this head', async () => {
  const client = gateClient();
  assert.equal(await completeReviewedPullRequest(client, armed(), HEAD, verdict), 'queued');
  assert.deepEqual(client.log.filter(([k]) => k === 'arm'), [['arm', 900, HEAD]], 'armed once, for this exact head (expectedHeadOid)');
});

test('G3a (gap-check F2d) — a re-arm that fails replaces the green with the retryable hold, so recovery re-judges the head', async () => {
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
  // Codex 4440931048 on #1295 — a clean-status retry that does not merge, or throws, takes the same retryable hold:
  // with the queue disarmed before the success, nothing else would re-judge the green head
  for (const retry of [async () => ({ merged: false, message: 'Base branch was modified' }), async () => { throw new Error('GitHub 502'); }]) {
    const refused = gateClient({ enable: async () => { throw new Error('Pull request is in clean status'); } });
    let merges = 0;
    // the direct merge is not ready; the retry after the clean-status answer refuses or throws
    refused.mergeExactHead = async () => ((merges += 1) === 1 ? { merged: false, message: 'Not ready' } : retry());
    await assert.rejects(completeReviewedPullRequest(refused, pr(), HEAD, verdict));
    const statuses = refused.log.filter(([k]) => k === 'status');
    assert.deepEqual(statuses.at(-1).slice(2), ['failure', `review: ${CODEX_AUTOMERGE_REARM_FAILED}`]);
    assert.match(refused.log.find(([k]) => k === 'sticky')?.[1] ?? '', /review_retry/u);
  }
});

test('G3a — structural: both writers take the one disarm-then-success step; only the merge authorization re-arms', async () => {
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
  // gap-check F2 on 764669d9 — the same, with comments stripped and any access form (`.x(` or `['x']`): no call left in a
  // comment counts, and none is hidden behind a bracket
  const code = stripComments(gate);
  const tokens = (name) => [...code.matchAll(new RegExp(`\\b${name}\\b`, 'gu'))].map((m) => m.index);
  const within = (index, name) => index > code.indexOf(`export async function ${name}(`)
    && index < code.indexOf('\nexport ', code.indexOf(`export async function ${name}(`) + 1);
  const clientClass = [code.indexOf('class GitHubClient'), code.indexOf('\n}\n', code.indexOf('class GitHubClient'))];
  const inClient = (index) => index > clientClass[0] && index < clientClass[1];
  for (const index of tokens('enableAutoMerge')) assert.ok(inClient(index) || within(index, 'completeReviewedPullRequest'), `enableAutoMerge at ${index}`);
  for (const index of tokens('disableAutoMerge')) assert.ok(inClient(index) || within(index, 'disarmQueuedAutoMerge'), `disableAutoMerge at ${index}`);
  const settled = tokens('publishSettledSuccess');
  assert.ok(settled.every((index) => within(index, 'publishDisarmedSuccess') || index === code.indexOf('export function publishSettledSuccess(') + 'export function '.length), 'publishSettledSuccess only in the shared step');
  const runBody = code.slice(code.indexOf('export async function run()'));
  assert.equal([...runBody.matchAll(/await completeCleanReview\(/gu)].length, 1, 'the review path ends through the one clean step');
  assert.doesNotMatch(runBody, /\b(enableAutoMerge|disableAutoMerge|publishSettledSuccess|publishDisarmedSuccess|completeReviewedPullRequest)\b/u);
  const recovery = code.slice(code.indexOf('export async function ensureTerminalReviewState('));
  assert.match(recovery.slice(0, recovery.indexOf('\nexport ', 1)), /await publishDisarmedSuccess\(/u);
  // #1290 fold — the auto-merge holds are the shared retryable hold (failure, draft, settle, `review_retry`, no notice),
  // and both of their details are ones recovery re-judges
  const rearm = gate.slice(gate.indexOf('export async function completeReviewedPullRequest('), gate.indexOf('export class AutoMergeDisarmFailed'));
  assert.match(rearm, /await publishRetryableHold\(client, pullRequest, expectedHead, recoveryRequest, \{\s*detail: CODEX_AUTOMERGE_REARM_FAILED,/u);
  const { isRetryableReviewFailureDescription, CODEX_AUTOMERGE_DISARM_FAILED, CODEX_AUTOMERGE_REARM_FAILED } = await import('./review-policy.mjs');
  for (const detail of [CODEX_AUTOMERGE_DISARM_FAILED, CODEX_AUTOMERGE_REARM_FAILED]) {
    assert.equal(isRetryableReviewFailureDescription(`review: ${detail}`), true, detail);
  }
});

// G3a — a recovery that finds the pull request drafted writes nothing, disables nothing and arms nothing: the same
// run's ordinary review takes the head on.
test('G3a — a recovered success on a drafted pull request writes nothing and arms nothing', async () => {
  const { ensureTerminalReviewState } = await import('./autonomous-review-gate.mjs');
  const calls = [];
  const client = new Proxy({}, { get: (_, name) => async (...args) => {
    calls.push(name);
    if (name === 'pullRequest') return pr(HEAD, { draft: true });
    if (name === 'statuses' || name === 'checkRuns' || name === 'issueComments') return [];
    throw new Error(`unexpected ${String(name)}`);
  } });
  const green = success(6100);
  assert.equal(await ensureTerminalReviewState(client, pr(), HEAD, green, [green]), false);
  assert.deepEqual(calls, ['pullRequest'], 'one live read, then nothing written, disabled or armed');
});

// gap-check F2 on 764669d9 — the ordinary review's clean ending, behaviourally: over a PR armed from an earlier green, the
// queued merge is disabled before the one success, the merge authorization reads Codex's record after it, and only
// then is this exact head armed again; when the record shows a security finding by then, nothing is armed.
test('G3a (gap-check F2) — the review path\'s clean ending disarms first and arms only after the merge authorization', async () => {
  const scenario = (records) => {
    let armedNow = true;
    let successWritten = false;
    const client = gateClient({ live: () => (armedNow ? armed() : pr()), disable: async () => { armedNow = false; } });
    const setStatus = client.setStatus;
    client.setStatus = async (sha, state, description, ...rest) => {
      if (state === 'success' && !/^recovery:/u.test(description)) successWritten = true;
      return setStatus(sha, state, description, ...rest);
    };
    client.issueComments = async () => { client.log.push(['record']); return successWritten ? records : []; };
    return client;
  };
  const clean = scenario([]);
  const ended = await completeCleanReview(clean, armed(), HEAD, 'review: Codex found no blocking issue on this exact head', verdict);
  assert.equal(ended.completion, 'queued');
  const kinds = clean.log.map(([k, , state]) => (k === 'status' ? `status:${state}` : k));
  const disable = kinds.indexOf('disable');
  const green = kinds.indexOf('status:success');
  const arm = kinds.indexOf('arm');
  assert.ok(disable >= 0 && disable < green, kinds.join(','));
  assert.ok(arm > green && kinds.slice(green, arm).includes('record'), kinds.join(','));
  assert.deepEqual(clean.log.filter(([k]) => k === 'arm'), [['arm', 900, HEAD]]);
  // a security finding at the merge's last record read: nothing armed, and the green is replaced
  const securityRecord = {
    user: { login: 'chatgpt-codex-connector[bot]' }, created_at: '2026-11-02T00:00:00Z',
    body: `<!-- codex-review-state:v1 ${JSON.stringify({
      code_review: { commit_sha: HEAD, has_any_findings: false, has_unresolved_findings: false, status: 'completed' },
      security_review: { commit_sha: HEAD, has_any_findings: true, has_unresolved_findings: true, status: 'completed' },
    })} -->`,
  };
  const refused = scenario([securityRecord]);
  refused.createIssueComment = async () => ({ id: 1 });
  refused.markReplacementRequired = async () => {};
  refused.reviews = async () => [];
  refused.reviewComments = async () => [];
  const out = await completeCleanReview(refused, armed(), HEAD, 'review: Codex found no blocking issue on this exact head', verdict);
  assert.equal(out.completion, 'review_refused');
  assert.equal(refused.log.some(([k]) => k === 'arm'), false);
  assert.ok(refused.log.findIndex(([k]) => k === 'disable') >= 0);
  assert.equal(refused.log.filter(([k]) => k === 'status').at(-1)[2], 'failure');
  // a head no longer current after the success: nothing more is written or armed
  const moved = gateClient({ live: () => (moved?.log.some(([k, , state]) => k === 'status' && state === 'success') ? pr(NEXT) : pr()) });
  assert.equal(await completeCleanReview(moved, pr(), HEAD, 'review: clean', verdict), null);
  assert.equal(moved.log.some(([k]) => k === 'arm'), false);
});

// Codex 4440931056 on #1295 — a commit status is shared by every open PR whose head is that commit: each one with a
// merge queued is disarmed before the success, so none merges on it before its own authorization reads its record.
test('G3a (Codex 4440931056) — every open pull request at this commit with a merge queued is disarmed before the success', async () => {
  const sibling = (extra = {}) => pr(HEAD, { number: 901, node_id: 'PR_901', head: { sha: HEAD, ref: 'claude/other', repo }, ...extra });
  const queued = () => sibling({ auto_merge: { enabled_at: '2026-11-02T00:00:00Z', merge_method: 'squash' } });
  // this PR armed, a sibling armed, a sibling not armed: both armed ones disabled, each re-read, this PR returned
  const both = fakeClient({ reads: [armed(), pr(), sibling()], siblings: [pr(), queued(), sibling({ number: 902, node_id: 'PR_902' })] });
  const live = await disarmQueuedAutoMerge(both, 900, HEAD);
  assert.equal(live.number, 900);
  assert.deepEqual(both.calls, [['read', 900], ['list', HEAD], ['disable', 'PR_900'], ['read', 900], ['disable', 'PR_901'], ['read', 901]]);
  // a sibling still armed after its disable: the retryable failure, nothing green
  const stuck = fakeClient({ reads: [pr(), queued()], siblings: [queued()] });
  await assert.rejects(disarmQueuedAutoMerge(stuck, 900, HEAD), AutoMergeDisarmFailed);
  // a sibling that left this commit, or closed, by its re-read no longer consumes it
  for (const gone of [sibling({ head: { sha: NEXT, ref: 'claude/other', repo }, auto_merge: { enabled_at: 'x' } }), sibling({ state: 'closed', auto_merge: { enabled_at: 'x' } })]) {
    const moved = fakeClient({ reads: [pr(), gone], siblings: [queued()] });
    assert.equal((await disarmQueuedAutoMerge(moved, 900, HEAD)).number, 900);
  }
  // an unreadable list is the retryable failure too
  const blind = fakeClient({ reads: [pr()] });
  blind.openPullRequestsAt = async () => { throw new Error('GitHub 502'); };
  await assert.rejects(disarmQueuedAutoMerge(blind, 900, HEAD), AutoMergeDisarmFailed);
  // through the shared step: the sibling's disable comes before the one success
  let siblingArmed = true;
  const client = gateClient({ live: () => (siblingArmed ? sibling({ auto_merge: { enabled_at: 'x' } }) : sibling()) });
  client.pullRequest = async (number) => { client.log.push(['read', number]); return number === 900 ? pr() : (siblingArmed ? queued() : sibling()); };
  client.openPullRequestsAt = async () => [pr(), siblingArmed ? queued() : sibling()];
  client.disableAutoMerge = async (pull) => { client.log.push(['disable', pull.number]); if (pull.number === 901) siblingArmed = false; };
  await publishDisarmedSuccess(client, pr(), HEAD, 'review: clean');
  const kinds = client.log.map(([k, n, state]) => (k === 'status' ? `status:${state}` : k === 'disable' ? `disable:${n}` : k));
  assert.ok(kinds.indexOf('disable:901') >= 0 && kinds.indexOf('disable:901') < kinds.indexOf('status:success'), kinds.join(','));
});

test('G3a (Codex 4440931056) — the open pull requests at a commit are those whose head is that commit', async () => {
  const paths = [];
  const open = [pr(), pr(NEXT, { number: 903 }), pr(HEAD, { number: 904 })];
  const self = { repository: 'JagPat/PMCvitan', async paginated(path) { paths.push(path); return open; } };
  const at = await GitHubClient.prototype.openPullRequestsAt.call(self, HEAD);
  assert.deepEqual(at.map((pull) => pull.number), [900, 904]);
  assert.deepEqual(paths, ['/repos/JagPat/PMCvitan/pulls?state=open']);
});

// Codex 4441198800 on #1295 — after the success the queue is disarmed: a settlement or head re-read that fails there
// replaces the green with the re-arm hold (which settles the request), so the watchdog asks again
test('G3a (Codex 4441198800) — a failure after the clean success replaces the green with the retryable hold', async () => {
  const request = { status: { id: 7001, context: 'codex-recovery-request/6100' } };
  for (const fail of ['settle', 'refresh']) {
    let reads = 0;
    const client = gateClient({ live: () => { reads += 1; if (fail === 'refresh' && reads === 2) throw new Error('GitHub 502'); return pr(); } });
    const setStatus = client.setStatus;
    let settleFailed = false;
    client.setStatus = async (sha, state, description, url, context) => {
      if (fail === 'settle' && !settleFailed && /^recovery: consumed by clean review/u.test(description)) { settleFailed = true; throw new Error('GitHub 502'); }
      return setStatus(sha, state, description, url, context);
    };
    await assert.rejects(completeCleanReview(client, pr(), HEAD, 'review: clean', verdict, { recoveryRequest: request, attempt: 1 }), /GitHub 502/u, fail);
    const statuses = client.log.filter(([k]) => k === 'status');
    const green = statuses.findIndex(([, , state, description]) => state === 'success' && description.startsWith('review: clean'));
    const hold = statuses.findIndex(([, , state, description]) => state === 'failure' && description === `review: ${CODEX_AUTOMERGE_REARM_FAILED}`);
    assert.ok(green >= 0 && hold > green, `${fail}: the green is replaced`);
    assert.match(client.log.find(([k]) => k === 'sticky')?.[1] ?? '', /review_retry/u, fail);
    assert.equal(client.log.some(([k]) => k === 'arm'), false, fail);
  }
});

// Codex 4441198763 on #1295 — a sibling queued after the disarm's own list would merge on this success before its own
// authorization: the commit's open pull requests are listed again as the last read before the success write (after
// the approval token's reads: Stage 1's re-check G1), and any merge queued there withholds it (the retryable hold, as
// a disarm that fails, over the follow-up failure the success writer leaves)
test('G3a (Codex 4441198763) — a merge queued at this commit after the disarm withholds the success: the retryable hold', async () => {
  const sibling = (extra = {}) => pr(HEAD, { number: 901, node_id: 'PR_901', head: { sha: HEAD, ref: 'claude/other', repo }, ...extra });
  const queued = () => sibling({ auto_merge: { enabled_at: '2026-11-02T00:00:00Z', merge_method: 'squash' } });
  const run = (lists) => {
    const client = gateClient();
    let n = 0;
    client.openPullRequestsAt = async (sha) => { client.log.push(['list', sha]); const next = lists[Math.min(n, lists.length - 1)]; n += 1; return next(); };
    const commit = client.commit;
    client.commit = async (...args) => { client.log.push(['commit']); return commit(...args); };
    const statuses = client.statuses;
    client.statuses = async (...args) => { client.log.push(['statuses']); return statuses(...args); };
    return client;
  };
  // the disarm's list is clean; a sibling, this PR alone, or this PR beside a sibling is queued by the last list; or
  // the last list cannot be read
  for (const [name, second] of [
    ['sibling queued', () => [pr(), queued()]],
    ['this PR queued, alone', () => [armed()]],
    ['this PR queued', () => [armed(), sibling()]],
    ['last list unreadable', () => { throw new Error('GitHub 502'); }],
  ]) {
    const client = run([() => [pr(), sibling()], second]);
    await assert.rejects(publishDisarmedSuccess(client, pr(), HEAD, 'review: clean'), AutoMergeDisarmFailed, name);
    const statuses = client.log.filter(([k]) => k === 'status');
    assert.equal(statuses.some(([, , state]) => state === 'success'), false, `${name}: nothing green`);
    assert.deepEqual(statuses.at(-1).slice(2), ['failure', `review: ${CODEX_AUTOMERGE_DISARM_FAILED}`], name);
    assert.match(client.log.filter(([k]) => k === 'sticky').at(-1)?.[1] ?? '', /review_retry/u, name);
    assert.equal(client.log.filter(([k]) => k === 'list').length, 2, `${name}: listed twice`);
  }
  // a clean last list: it comes after the approval token's reads, and the one success follows it with nothing read or
  // written between them
  const clean = run([() => [pr(), sibling()], () => [pr(), sibling()]]);
  await publishDisarmedSuccess(clean, pr(), HEAD, 'review: clean');
  const kinds = clean.log.map(([k, , state]) => (k === 'status' ? `status:${state}` : k));
  const lastList = kinds.lastIndexOf('list');
  const green = kinds.indexOf('status:success');
  assert.ok(kinds.includes('commit') && kinds.lastIndexOf('commit') < lastList, kinds.join(','));
  assert.ok(kinds.lastIndexOf('statuses') < lastList, kinds.join(','));
  assert.equal(green, lastList + 1, kinds.join(','));
});

// G3a′ (Replaces #1295; Codex 4441669671, root cause of 4441198800 and 4440931048) — every await from the first green
// write to a merge that landed or an arm that took, for both writers, is found by running the clean path once and
// recording each client call after the success; then each one, at each of its occurrences, is made to throw. Whatever
// throws, the head ends merged, armed, or with a failure over the green: never green with nothing queued.
function tracedClient(base, { fail = null } = {}) {
  const seen = [];
  let greened = false;
  const counts = {};
  const client = { ...base };
  for (const [name, fn] of Object.entries(base)) {
    if (typeof fn !== 'function') continue;
    client[name] = async (...args) => {
      if (greened && !['setStatus', 'setDraft', 'updateStickyComment'].includes(name)) {
        counts[name] = (counts[name] ?? 0) + 1;
        seen.push(`${name}#${counts[name]}`);
        if (fail === `${name}#${counts[name]}`) throw new Error(`GitHub 502 at ${fail}`);
      }
      const result = await fn.apply(client, args);
      if (name === 'setStatus' && args[1] === 'success' && /^review: /u.test(args[2])) greened = true;
      return result;
    };
  }
  client.seen = seen;
  return client;
}
const endsSafe = (log) => {
  const last = log.filter(([k, , , description]) => k === 'status' && !/^recovery: /u.test(description)).at(-1);
  return log.some(([k]) => k === 'arm') || last?.[2] === 'failure';
};
const writers = {
  // the review path: `run()` → `completeCleanReview`
  review: (client) => completeCleanReview(client, pr(), HEAD, 'review: clean', verdict, { recoveryRequest: { status: { id: 7001, context: 'codex-recovery-request/6100' } }, attempt: 1 }),
  // the recovered success: `ensureTerminalReviewState` → `publishDisarmedSuccess`, then `completeReviewedPullRequest`
  // with nothing awaited between them (structural row below)
  recovered: async (client) => {
    const disarmed = await publishDisarmedSuccess(client, pr(), HEAD, 'review: recovered prior clean Codex result on this exact head');
    if (disarmed) await completeReviewedPullRequest(client, pr(), HEAD, verdict);
  },
};

test('G3a′ (Codex 4441669671) — a throw at any await between the green and the arm, on either writer, ends held, never green and unqueued', async () => {
  for (const [writer, write] of Object.entries(writers)) {
    const clean = tracedClient(gateClient());
    await write(clean);
    assert.ok(clean.log.some(([k]) => k === 'arm'), `${writer}: the clean path arms`);
    // the table: every call between the green and the arm (the hand-off follows the arm and is checked below)
    const calls = clean.seen.slice(0, clean.seen.indexOf('enableAutoMerge#1') + 1);
    for (const expected of ['pullRequest#1', 'mergeExactHead#1', 'enableAutoMerge#1']) assert.ok(calls.includes(expected), `${writer}: ${expected} in ${calls}`);
    for (const point of calls) {
      const client = tracedClient(gateClient(), { fail: point });
      // a read with its own retry (the head commit's message) recovers and arms; any other throw ends the run
      const failed = await write(client).then(() => false, () => true);
      assert.ok(endsSafe(client.log), `${writer} at ${point}: ${JSON.stringify(client.log.filter(([k]) => k !== 'sticky'))}`);
      if (failed) assert.equal(client.log.some(([k]) => k === 'arm'), false, `${writer} at ${point}: nothing armed`);
      else assert.ok(client.log.some(([k]) => k === 'arm'), `${writer} at ${point}: recovered and armed`);
    }
    // the clean-status retry: it throws, or it does not merge either — held
    for (const retry of [async () => { throw new Error('GitHub 502'); }, async () => ({ merged: false, message: 'Base branch was modified' })]) {
      const client = tracedClient(gateClient({ enable: async () => { throw new Error('Pull request is in clean status'); } }));
      let merges = 0;
      const merge = client.mergeExactHead;
      client.mergeExactHead = async (...args) => { merges += 1; return merges === 1 ? merge(...args) : retry(); };
      await assert.rejects(write(client), undefined, `${writer}: clean-status retry`);
      assert.deepEqual(client.log.filter(([k, , , description]) => k === 'status' && !/^recovery: /u.test(description)).at(-1).slice(2), ['failure', `review: ${CODEX_AUTOMERGE_REARM_FAILED}`], `${writer}: clean-status retry`);
    }
    // a hand-off that fails after the arm took holds nothing: the head is queued
    const handoff = tracedClient(gateClient(), { fail: 'dispatchHandoff#1' });
    await assert.rejects(write(handoff), /GitHub 502/u, `${writer}: hand-off`);
    assert.ok(handoff.log.some(([k]) => k === 'arm'));
    assert.equal(handoff.log.some(([k, , state, description]) => k === 'status' && state === 'failure' && description === `review: ${CODEX_AUTOMERGE_REARM_FAILED}`), false, `${writer}: hand-off`);
  }
});

// Stage 1's condition 2 — a throw that is a merge that in fact landed, or a head that moved, leaves no hold; a re-read
// that fails too leaves the hold (fail closed)
test('G3a′ — the tail re-reads before holding: merged or moved gets no hold; an unreadable re-read is held', async () => {
  for (const [name, after, held] of [
    ['merged', () => pr(HEAD, { state: 'closed', merged: true, merged_at: '2026-11-02T11:00:00Z' }), false],
    ['head moved', () => pr(NEXT), false],
    ['still open on this head', () => pr(), true],
    ['re-read fails', () => { throw new Error('ECONNRESET'); }, true],
  ]) {
    let thrown = false;
    const client = gateClient({ live: () => (thrown ? after() : pr()) });
    client.mergeExactHead = async () => { thrown = true; throw new Error('socket hang up'); };
    await assert.rejects(completeReviewedPullRequest(client, pr(), HEAD, verdict), undefined, name);
    const hold = client.log.some(([k, , state, description]) => k === 'status' && state === 'failure' && description === `review: ${CODEX_AUTOMERGE_REARM_FAILED}`);
    assert.equal(hold, held, name);
  }
});

test('G3a′ — structural: no client call after the authorization sits outside the one guarded tail', async () => {
  const gate = stripComments(await readFile(new URL('./autonomous-review-gate.mjs', import.meta.url), 'utf8'));
  const body = (name) => {
    const start = gate.search(new RegExp(`\\n(export )?async function ${name}\\(`, 'u'));
    return gate.slice(start, gate.indexOf('\n}\n', start) + 2);
  };
  const complete = body('completeReviewedPullRequest');
  // the tail is called once, inside the one try, and every throw from it but the unreadable record's refusal is held
  assert.equal([...gate.matchAll(/\bmergeOrArmAuthorizedHead\(/gu)].length, 2, 'defined once, called once');
  assert.match(complete, /try \{\s*completed = await mergeOrArmAuthorizedHead\(client, pullRequest, expectedHead, verdict, \{ recoveryRequest, attempt \}\);\s*\} catch \(error\) \{\s*if \(!\(error instanceof CodexRecordUnreadable\)\) await holdUnarmedGreen\(client, pullRequest, expectedHead, \{ recoveryRequest, attempt \}\);\s*throw error;\s*\}/u);
  // the only other client call in it is the hand-off, after a merge that landed or an arm that took
  assert.deepEqual([...complete.matchAll(/\bclient\s*(?:\.|\[\s*['"`])(\w+)/gu)].map((m) => m[1]), ['dispatchHandoff'], 'one client call outside the tail: the hand-off');
  assert.match(complete, /if \(completed\.outcome === 'merged' \|\| completed\.outcome === 'queued'\) \{\s*await client\.dispatchHandoff\(/u);
  // the tail holds nothing itself: the one hold is `holdUnarmedGreen`'s
  const tail = body('mergeOrArmAuthorizedHead');
  assert.doesNotMatch(tail, /publishRetryableHold|dispatchHandoff/u);
  assert.match(tail, /authorizeExactHeadMerge\(client/u);
  assert.equal([...gate.matchAll(/\bholdUnarmedGreen\(/gu)].length, 2, 'defined once, called once');
  // the recovered success: nothing awaited between its success and the completion
  const recovery = body('ensureTerminalReviewState');
  const between = recovery.slice(recovery.indexOf('await publishDisarmedSuccess('), recovery.indexOf('await completeReviewedPullRequest('));
  assert.equal([...between.matchAll(/\bawait\b/gu)].length, 1, 'only the success itself');
  // the review path: the settlement and the re-read after its success are held (Codex 4441198800 row), then the completion
  const clean = body('completeCleanReview');
  assert.ok(clean.indexOf('await completeReviewedPullRequest(') > clean.indexOf('catch (error)'));
});
