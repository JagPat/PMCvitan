import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GitHubClient, REQUIRED_CHECKS, refuseSharedCommit, run } from './autonomous-review-gate.mjs';
import { handOffCorrectionLease, otherOpenPullRequestAt, sharedHeadCheck, inheritedBodyVerdictFrom } from './autonomous-handoff.mjs';
import { gateRecoveryStatus } from './correction-lease.mjs';
import { CODEX_SHARED_COMMIT_DETAIL, CODEX_SHARED_COMMIT_UNREADABLE, isRetryableReviewFailureDescription } from './review-policy.mjs';

/**
 * 2A3a (Stage 1's ruling (b) on notes/gate-codex-silent/2a3/design.md) — one open pull request per commit. A commit status
 * belongs to the commit, so while more than one open pull request has a head, none of them is green: every queued merge
 * at it is disarmed and the commit gets the retryable shared-commit refusal, a verdict true of the commit itself. Every
 * verdict the gate derives from one pull request's body (#1307 sibling audit S18) is then that pull request's alone.
 */
const HEAD = 'e'.repeat(40);
const SHARED = `review: ${CODEX_SHARED_COMMIT_DETAIL}`;
const repo = { full_name: 'JagPat/PMCvitan' };
const VALID_BODY = [
  '<!-- review-size: standard -->', '<!-- correction-owner: claude -->', '',
  '- [x] `concurrency-serialization` — n/a', '- [x] `old-release-migration-compatibility` — n/a',
  '- [x] `trigger-alternate-writers` — n/a', '- [x] `authorization-tenancy` — n/a', '- [x] `ci-reproduce-first` — n/a', '',
  'Replaces: none',
].join('\n');
const tokenedSuccess = () => ({ id: 6100, context: 'codex-current-head', state: 'success', description: 'review: Codex found no blocking issue on this exact head [wi:none]' });
const pullAt = (number, extra = {}) => ({
  number, node_id: `PR_${number}`, state: 'open', draft: false, additions: 1, deletions: 0, changed_files: 1,
  auto_merge: null, body: VALID_BODY,
  head: { sha: HEAD, ref: `claude/unit-${number}`, repo },
  base: { ref: 'main', sha: 'b'.repeat(40), repo },
  html_url: `https://github.com/JagPat/PMCvitan/pull/${number}`,
  ...extra,
});
const queued = { enabled_at: '2026-11-02T00:00:00Z', merge_method: 'squash' };

/**
 * `run()` itself, with every GitHubClient method replaced by a recorder (the G3b X2g harness). `pulls` is the live set
 * of open pull requests, shared by every run of a scenario, so one PR's run disarming another is seen by the next.
 */
async function runGate({ number, pulls, statuses, mode = null, trigger = 'ci', overrides = {} }) {
  const log = [];
  let nextId = 6200;
  const stubs = {
    async pullRequest(n) { log.push(['read', n]); const found = pulls.get(n); return found ? { ...found, auto_merge: found.auto_merge } : null; },
    async openPullRequestsAt(sha) { log.push(['list']); return [...pulls.values()].filter((p) => p.state === 'open' && p.head.sha === sha).map((p) => ({ ...p })); },
    async statuses() { return [...statuses]; },
    async checkRuns() { log.push(['checks']); return REQUIRED_CHECKS.map((name) => ({ name, conclusion: 'success', status: 'completed' })); },
    async commit(sha) { log.push(['commit']); return { sha, commit: { message: 'fix: x\n\nCorrection-Owner: claude\n' }, files: [] }; },
    async pullRequestFiles() { log.push(['scope-read']); return [{ filename: 'scripts/x.mjs', status: 'modified', additions: 1, deletions: 0 }]; },
    async replacementLineage() { log.push(['scope-read']); return { requiredReplacements: [], replacementPullRequests: [] }; },
    async fileContents() { return null; },
    async setStatus(sha, state, description, url, context = 'codex-current-head') {
      const status = { id: nextId += 1, context, state, description, target_url: url };
      statuses.unshift(status);
      log.push(['status', state, description, context, url]);
      return status;
    },
    async issueComments() { log.push(['record']); return []; },
    async reviewComments() { return []; },
    async reviews() { return []; },
    async reviewThreads() { return []; },
    async reactions() { return []; },
    async setDraft(current, draft) { log.push(['draft', current.number, draft]); const p = pulls.get(current.number); p.draft = draft; if (draft) p.auto_merge = null; return { ...p }; },
    async updateStickyComment(n, body) { log.push(['sticky', n, body]); },
    async createIssueComment() { log.push(['marker']); return { id: 1 }; },
    async disableAutoMerge(pull) { log.push(['disable', pull.number]); pulls.get(pull.number).auto_merge = null; },
    async enableAutoMerge(current) { log.push(['arm', current.number]); },
    async mergeExactHead(n) { log.push(['merge', n]); return { merged: false, message: 'Pull request is not mergeable yet' }; },
    async dispatchHandoff() { log.push(['handoff']); },
    async request(method, path) { log.push(['unstubbed request', method, path]); return null; },
    async graphql() { log.push(['unstubbed graphql']); return {}; },
  };
  const names = Object.getOwnPropertyNames(GitHubClient.prototype).filter((name) => name !== 'constructor');
  const saved = new Map(names.map((name) => [name, Object.getOwnPropertyDescriptor(GitHubClient.prototype, name)]));
  const keys = ['GITHUB_REPOSITORY', 'GITHUB_TOKEN', 'GITHUB_EVENT_NAME', 'GITHUB_EVENT_PATH', 'AUTONOMOUS_REVIEW_MODE',
    'GITHUB_ENV', 'PR_NUMBER', 'GITHUB_RUN_ID', 'RUNNER_TEMP'];
  const env = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  const dir = await mkdtemp(join(tmpdir(), '2a3a-run-'));
  try {
    for (const name of names) {
      Object.defineProperty(GitHubClient.prototype, name, {
        configurable: true, writable: true,
        value: overrides[name] ?? stubs[name] ?? (async function unstubbed() { log.push(['unstubbed', name]); return undefined; }),
      });
    }
    const eventPath = join(dir, 'event.json');
    const event = trigger === 'relabel'
      ? { action: 'edited', pull_request: { ...pulls.get(number) }, changes: { body: { from: '' } } }
      : { workflow_run: { event: 'pull_request', pull_requests: [{ number }], head_sha: HEAD, conclusion: 'success', id: 99, run_attempt: 1 } };
    await writeFile(eventPath, JSON.stringify(event));
    for (const key of keys) delete process.env[key];
    Object.assign(process.env, {
      GITHUB_REPOSITORY: 'JagPat/PMCvitan', GITHUB_TOKEN: 'test-token',
      GITHUB_EVENT_NAME: trigger === 'relabel' ? 'pull_request_target' : 'workflow_run', GITHUB_EVENT_PATH: eventPath,
      ...(mode ? { AUTONOMOUS_REVIEW_MODE: mode } : {}),
    });
    let error = null;
    try { await run(); } catch (thrown) { error = thrown; }
    return { log, error };
  } finally {
    for (const [name, descriptor] of saved) Object.defineProperty(GitHubClient.prototype, name, descriptor);
    for (const [key, value] of Object.entries(env)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await rm(dir, { recursive: true, force: true });
  }
}

// A run() row that does not stop at the refusal (a mutant) would poll for Codex: each run() row is bounded, so it fails
// within its limit instead of hanging the suite
const reviewStatuses = (log) => log.filter(([k, , , context]) => k === 'status' && context === 'codex-current-head');

// The scope note's row (notes/gate-codex-silent/2a3-scope-note.md): two PRs at one commit with different body verdicts each
// get only the commit's own verdict, never the other's body verdict, and neither is green.
test('2A3a — two open PRs at one commit with different body verdicts: each gets only the shared-commit refusal, never the other\'s', { timeout: 30_000 }, async () => {
  const pulls = new Map([
    [610, pullAt(610, { auto_merge: queued })],
    // a body the scope would refuse (no size marker, no owner marker)
    [611, pullAt(611, { body: 'no markers here', auto_merge: queued })],
  ]);
  // the commit already carries a tokened green (main armed or merged PR 610 on it, whatever 611's body says)
  const statuses = [tokenedSuccess()];
  const a = await runGate({ number: 610, pulls, statuses });
  const b = await runGate({ number: 611, pulls, statuses });
  for (const [name, result, other] of [['valid body', a, 611], ['defective body', b, 610]]) {
    assert.equal(result.error, null, name);
    const written = reviewStatuses(result.log);
    assert.ok(written.length > 0, `${name}: the refusal is written`);
    assert.deepEqual(written.filter(([, state]) => state !== 'pending').map(([, state, description]) => [state, description]),
      [['failure', SHARED]], `${name}: only the commit's own verdict`);
    assert.equal(result.log.some(([k]) => k === 'scope-read' || k === 'record' || k === 'checks'), false,
      `${name}: nothing derived from this PR (scope, Codex record, checks) is read`);
    assert.equal(result.log.some(([k]) => k === 'arm' || k === 'merge'), false, `${name}: nothing armed or merged`);
    const sticky = result.log.filter(([k]) => k === 'sticky').at(-1);
    assert.match(sticky[2], /review_retry/u, name);
    assert.match(sticky[2], new RegExp(`#${other}\\b`, 'u'), `${name}: the sticky names the other PR`);
    assert.doesNotMatch(sticky[2], new RegExp(`head of[^.]*#${other === 611 ? 610 : 611}\\b`, 'u'), `${name}: and not itself`);
    assert.doesNotMatch(sticky[2], /Correction owner|changes_required/u, `${name}: no correction is asked of anyone`);
  }
  // every queued merge at the commit was disarmed by the first run, this PR first
  assert.deepEqual(a.log.filter(([k]) => k === 'disable').map(([, n]) => n), [610, 611]);
  assert.equal(statuses.filter((s) => s.context === 'codex-current-head').at(0).state, 'failure', 'the green is replaced');
  assert.equal(statuses.filter((s) => s.context === 'codex-current-head' && s.state === 'success').length, 1, 'no new green');
  assert.equal(isRetryableReviewFailureDescription(SHARED), true, 'the refusal is retryable: the watchdog asks again');
  assert.deepEqual([...a.log, ...b.log].filter(([k]) => String(k).startsWith('unstubbed')), []);
});

// Once one of them closes, the remaining PR's re-judge proceeds to its own verdict.
test('2A3a — once the other PR closes, the re-judge goes on to this PR\'s own verdict', { timeout: 30_000 }, async () => {
  const pulls = new Map([[610, pullAt(610)], [611, pullAt(611)]]);
  const statuses = [];
  const shared = await runGate({ number: 610, pulls, statuses });
  assert.equal(reviewStatuses(shared.log).at(-1)[2], SHARED);
  pulls.get(611).state = 'closed';
  const alone = await runGate({ number: 610, pulls, statuses });
  assert.ok(alone.log.some(([k]) => k === 'scope-read'), 'its own scope is read');
  assert.notEqual(reviewStatuses(alone.log).at(-1)?.[2], SHARED, 'no shared-commit refusal for a PR alone at its head');
});

// The relabel guard (a body edit) writes a body-derived verdict only while this PR is alone at its head.
test('2A3a — the relabel guard writes no body verdict at a shared commit: the shared-commit refusal instead', { timeout: 30_000 }, async () => {
  // a real candidate (gap-check F3, B1): a codex marker on a `codex/**` branch, whose head commit declares no such owner,
  // so the guard, left to run, would write its own `scope:` verdict to the commit
  const candidate = '<!-- review-size: standard -->\n<!-- correction-owner: codex -->';
  const pulls = new Map([
    [610, pullAt(610, { body: candidate, head: { sha: HEAD, ref: 'codex/unit-610', repo } })],
    [611, pullAt(611, { auto_merge: queued })],
  ]);
  const statuses = [];
  const guarded = await runGate({ number: 610, pulls, statuses, mode: 'relabel-guard', trigger: 'relabel' });
  assert.equal(guarded.error, null);
  // no CI-triggered disarm ran on this path: the refusal itself disarms the sibling's queued merge
  assert.deepEqual(guarded.log.filter(([k]) => k === 'disable').map(([, n]) => n), [611]);
  assert.equal(pulls.get(611).auto_merge, null);
  assert.deepEqual(reviewStatuses(guarded.log).filter(([, state]) => state !== 'pending').map(([, s, d]) => [s, d]), [['failure', SHARED]]);
  assert.equal(guarded.log.some(([k]) => k === 'scope-read'), false);
  assert.equal(reviewStatuses(guarded.log).some(([, , description]) => /^scope:/u.test(description)), false, 'no body verdict');
  // alone at its head, the same candidate does get the guard's own verdict: the row is live
  pulls.get(611).state = 'closed';
  const alone = await runGate({ number: 610, pulls, statuses: [], mode: 'relabel-guard', trigger: 'relabel' });
  assert.ok(alone.log.some(([k]) => k === 'scope-read'), 'the guard reads its scope when alone');
});

test('2A3a — refuseSharedCommit: alone is null with nothing written; a PR no longer current writes nothing', async () => {
  const log = [];
  const client = {
    async openPullRequestsAt() { return [pullAt(610)]; },
    async setStatus(...args) { log.push(args); },
  };
  assert.equal(await refuseSharedCommit(client, pullAt(610), HEAD), null);
  assert.deepEqual(log, []);
  const moved = {
    async openPullRequestsAt() { return [pullAt(610), pullAt(611)]; },
    async pullRequest() { return pullAt(610, { head: { sha: 'f'.repeat(40), ref: 'x', repo } }); },
    async setStatus(...args) { log.push(args); },
  };
  assert.equal(await refuseSharedCommit(moved, pullAt(610), HEAD), 'superseded');
  assert.deepEqual(log, [], 'superseded: nothing written');
});

test('2A3a — a disarm that fails still writes the refusal: a red required status keeps every queued merge waiting', async () => {
  const log = [];
  const client = {
    async openPullRequestsAt() { return [pullAt(610), pullAt(611, { auto_merge: queued })]; },
    async pullRequest(n) { return pullAt(n, n === 611 ? { auto_merge: queued } : {}); },
    async disableAutoMerge() { throw new Error('GraphQL down'); },
    async setStatus(sha, state, description) { log.push(['status', state, description]); return { id: 1 }; },
    async setDraft(current, draft) { return { ...current, draft }; },
    async updateStickyComment(n, body) { log.push(['sticky', body]); },
  };
  assert.equal(await refuseSharedCommit(client, pullAt(610), HEAD), 'refused');
  assert.deepEqual(log.find(([k]) => k === 'status'), ['status', 'failure', SHARED]);
});

// A recovery request the run adopted is settled by the refusal, so the watchdog's next ask is for the new failure.
test('2A3a — the refusal settles the adopted recovery request; the watchdog then asks about the new refusal', { timeout: 30_000 }, async () => {
  const request = { id: 7001, context: 'codex-recovery-request/6100', state: 'pending', description: 'recovery: requested terminal status 6100' };
  const statuses = [request, { id: 6100, context: 'codex-current-head', state: 'failure', description: SHARED }];
  const pulls = new Map([[610, pullAt(610)], [611, pullAt(611)]]);
  const result = await runGate({ number: 610, pulls, statuses });
  assert.ok(result.log.some(([k, state, description, context]) => k === 'status' && context === request.context
    && state === 'success' && description === 'recovery: consumed by shared commit refusal'));
  const newest = statuses.find((s) => s.context === 'codex-current-head');
  const asked = gateRecoveryStatus({ statuses }, '2026-11-02T12:00:00Z');
  assert.equal(asked?.id, newest.id, 'the new refusal is asked about (at most once per watchdog tick, per PR)');
});

// The watchdog routes no correction for a verdict on a head another open PR shares: it may be the other PR's.
test('2A3a — the watchdog routes no correction on a shared head, and checks a fresh list before it posts', async () => {
  const pull = pullAt(610);
  const owed = { id: 9, context: 'codex-current-head', state: 'failure', description: 'scope: missing review-size marker', updated_at: '2026-11-01T00:00:00Z' };
  const calls = { posted: [] };
  const client = {
    combinedStatus: async () => ({ statuses: [owed] }),
    comments: async () => [],
    reviews: async () => [],
    reviewComments: async () => [],
    pullRequest: async () => pull,
    comment: async (number, body) => { calls.posted.push(body); return { id: 1 }; },
  };
  const shared = await handOffCorrectionLease(client, pull, 'JagPat/PMCvitan', 'main', {
    now: '2026-11-02T12:00:00Z', sharesHead: async () => true,
  });
  assert.equal(shared.state, 'shared_commit');
  assert.deepEqual(calls.posted, []);
  // alone in the snapshot, but a sibling at the fresh list just before the notice: nothing posted
  const late = await handOffCorrectionLease(client, pull, 'JagPat/PMCvitan', 'main', {
    now: '2026-11-02T12:00:00Z', sharesHead: async (head, number, { fresh = false } = {}) => fresh,
  });
  assert.notEqual(late?.state, 'notify');
  assert.deepEqual(calls.posted, []);
  assert.equal(otherOpenPullRequestAt([pullAt(610), pullAt(611)], HEAD, 610), true);
  assert.equal(otherOpenPullRequestAt([pullAt(610), pullAt(611, { head: { sha: 'f'.repeat(40) } })], HEAD, 610), false);
  assert.equal(otherOpenPullRequestAt([pullAt(610)], HEAD, 610), false);
});

// Structural: the refusal is checked in run() before anything derived from the pull request's body, on both paths that
// write codex-current-head from it, and the watchdog loop passes its shared-head check.
test('2A3a — structural: the shared-commit check precedes every body-derived writer in run(); the watchdog passes it', async () => {
  const gate = await readFile(new URL('./autonomous-review-gate.mjs', import.meta.url), 'utf8');
  const runBody = gate.slice(gate.indexOf('export async function run()'));
  const relabel = runBody.slice(runBody.indexOf("if (mode === 'relabel-guard')"), runBody.indexOf("if (mode === 'request-recovery')"));
  assert.ok(relabel.indexOf('await refuseSharedCommit(') >= 0 && relabel.indexOf('await refuseSharedCommit(') < relabel.indexOf('guardCandidateRelabel('));
  const orchestrate = runBody.slice(runBody.indexOf("if (mode === 'request-recovery')"));
  const check = orchestrate.indexOf('await refuseSharedCommit(');
  for (const writer of ['immutableOwnershipHoldIsNewestReview(', 'enforceReviewScope(', 'holdUnreadableCandidateHead(',
    'handleCiFailure(', 'ensureTerminalReviewState(', 'completeCleanReview(']) {
    assert.ok(check >= 0 && check < orchestrate.indexOf(writer), writer);
  }
  const confirm = gate.slice(gate.indexOf('async function confirmNoQueuedMergeAt('), gate.indexOf('function otherOpenPullRequests('));
  assert.ok(confirm.indexOf('throw new SharedCommitRefused(') < confirm.indexOf('pull.auto_merge'), 'any other open PR refuses, armed or not');
  const handoff = await readFile(new URL('./autonomous-handoff.mjs', import.meta.url), 'utf8');
  assert.match(handoff, /handOffCorrectionLease\(client, pullRequest, repository, defaultBranch, \{ sharesHead \}\)/u);
});

// Gap-check F1 — while the sibling is still open, the watchdog does not dispatch the refusal's recovery: a re-judge could
// only write it again (a new status on the commit) and draft the PR again. The close wakes the watchdog, and that pass
// dispatches exactly once; a pending request then holds the ask.
test('2A3a (gap-check F1) — N watchdog passes with a sibling present dispatch nothing; the close dispatches exactly once', async () => {
  const refusal = { id: 6300, context: 'codex-current-head', state: 'failure', description: SHARED, updated_at: '2026-11-02T11:00:00Z' };
  const statuses = [refusal];
  const open = [pullAt(610), pullAt(611)];
  const dispatched = [];
  const client = {
    combinedStatus: async () => ({ statuses: [...statuses] }),
    openPullRequests: async () => open.filter((pull) => pull.state === 'open').map((pull) => ({ ...pull })),
    pullRequest: async (n) => open.find((pull) => pull.number === n),
    comments: async () => [], reviews: async () => [], reviewComments: async () => [],
    comment: async () => { throw new Error('no notice expected'); },
    dispatchRecovery: async (ref, inputs) => {
      dispatched.push(inputs);
      // the request-recovery job's durable marker, as the gate writes it
      statuses.unshift({ id: 6400 + dispatched.length, context: `codex-recovery-request/${inputs.terminal_status_id}`, state: 'pending',
        description: `recovery: requested terminal status ${inputs.terminal_status_id}`, updated_at: '2026-11-02T12:00:00Z' });
    },
  };
  const pass = async () => {
    const snapshot = await client.openPullRequests();
    const sharesHead = sharedHeadCheck(client, snapshot, 'JagPat/PMCvitan', 'main');
    for (const pull of snapshot) await handOffCorrectionLease(client, pull, 'JagPat/PMCvitan', 'main', { now: '2026-11-02T12:00:00Z', sharesHead });
  };
  for (let n = 0; n < 5; n += 1) await pass();
  assert.deepEqual(dispatched, [], 'five passes with the sibling open: no dispatch');
  open[1].state = 'closed';
  await pass();
  assert.deepEqual(dispatched.map((inputs) => [inputs.pr_number, inputs.terminal_status_id]), [['610', '6300']], 'the close: exactly one');
  await pass();
  assert.equal(dispatched.length, 1, 'and the pending request holds the next pass');
});

// Gap-check F3 (B3) — the fresh check reads a new list, never the snapshot.
test('2A3a (gap-check F3) — the watchdog\'s fresh check re-lists the open pull requests; only gate-judged ones count', async () => {
  let reads = 0;
  const client = { async openPullRequests() { reads += 1; return [pullAt(610), pullAt(611)]; } };
  const check = sharedHeadCheck(client, [pullAt(610)], 'JagPat/PMCvitan', 'main');
  assert.equal(await check(HEAD, 610), false, 'the snapshot shows it alone');
  assert.equal(reads, 0);
  assert.equal(await check(HEAD, 610, { fresh: true }), true, 'the fresh list shows the sibling');
  assert.equal(reads, 1);
  // gap-check F2 — a fork, or a pull request into another base, is not counted
  const fork = pullAt(612, { head: { sha: HEAD, ref: 'patch', repo: { full_name: 'someone/PMCvitan' } } });
  const otherBase = pullAt(613, { base: { ref: 'release', sha: 'b'.repeat(40), repo } });
  const foreign = sharedHeadCheck({ async openPullRequests() { return [pullAt(610), fork, otherBase]; } }, [pullAt(610), fork, otherBase], 'JagPat/PMCvitan', 'main');
  assert.equal(await foreign(HEAD, 610), false);
  assert.equal(await foreign(HEAD, 610, { fresh: true }), false);
  const handoff = await readFile(new URL('./autonomous-handoff.mjs', import.meta.url), 'utf8');
  assert.match(handoff, /const sharesHead = sharedHeadCheck\(client, openSnapshot, repository, defaultBranch\);/u);
});

// Gap-check F2 (Stage 1's ruling) — a fork's pull request, or one into another base, at this commit is never judged by
// the gate, so it does not hold this one: no refusal. Its queued merge is still disarmed before the success.
test('2A3a (gap-check F2) — a fork or other-base sibling holds nothing, but its queued merge is disarmed', { timeout: 30_000 }, async () => {
  for (const [name, sibling] of [
    ['fork', pullAt(612, { head: { sha: HEAD, ref: 'patch', repo: { full_name: 'someone/PMCvitan' } }, auto_merge: queued })],
    ['other base', pullAt(613, { base: { ref: 'release', sha: 'b'.repeat(40), repo }, auto_merge: queued })],
  ]) {
    const quiet = { async openPullRequestsAt() { return [pullAt(610), { ...sibling }]; }, async setStatus() { throw new Error('nothing written'); } };
    assert.equal(await refuseSharedCommit(quiet, pullAt(610), HEAD), null, `${name}: no refusal`);
    const pulls = new Map([[610, pullAt(610)], [sibling.number, { ...sibling }]]);
    const statuses = [tokenedSuccess()];
    const result = await runGate({ number: 610, pulls, statuses });
    assert.equal(result.error, null, name);
    assert.equal(reviewStatuses(result.log).some(([, , description]) => description === SHARED), false, `${name}: not refused`);
    assert.ok(result.log.some(([k, n]) => k === 'disable' && n === sibling.number), `${name}: its queued merge is disarmed`);
    assert.equal(pulls.get(sibling.number).auto_merge, null, name);
    assert.ok(reviewStatuses(result.log).some(([, state]) => state === 'success'), `${name}: this PR goes on to its own green`);
  }
});

// #1311 round 1 (Codex 4446635304) — the commit is listed again after the disarm: a sibling gone by then is not named, and
// with none left this pull request is alone and nothing is written.
test('#1311 Codex 4446635304 — a sibling that leaves during the refusal is not named; with none left nothing is written', async () => {
  for (const [name, lists, expected] of [
    ['the only sibling closed', [[pullAt(610), pullAt(611)], [pullAt(610)]], null],
    ['one of two left', [[pullAt(610), pullAt(611), pullAt(612)], [pullAt(610), pullAt(612)]], 'refused'],
  ]) {
    const log = [];
    let reads = 0;
    const client = {
      async openPullRequestsAt() { const list = lists[Math.min(reads, lists.length - 1)]; reads += 1; return list.map((p) => ({ ...p })); },
      async pullRequest(n) { return pullAt(n); },
      async setStatus(sha, state, description) { log.push(['status', state, description]); return { id: 1 }; },
      async setDraft(current, draft) { log.push(['draft', draft]); return { ...current, draft }; },
      async updateStickyComment(n, body) { log.push(['sticky', body]); },
    };
    assert.equal(await refuseSharedCommit(client, pullAt(610), HEAD), expected, name);
    if (expected === null) {
      assert.deepEqual(log, [], `${name}: nothing written, the run goes on to its own verdict`);
    } else {
      const sticky = log.find(([k]) => k === 'sticky')[1];
      assert.match(sticky, /#612\b/u, name);
      assert.doesNotMatch(sticky, /#611\b/u, `${name}: the closed sibling is not named`);
    }
  }
  // a list that cannot be read again keeps the earlier one: the refusal fails closed
  let reads = 0;
  const log = [];
  const flaky = {
    async openPullRequestsAt() { reads += 1; if (reads === 1) return [pullAt(610), pullAt(611)]; if (reads === 2) return [pullAt(610), pullAt(611)]; throw new Error('502'); },
    async pullRequest(n) { return pullAt(n); },
    async setStatus(sha, state, description) { log.push(['status', state, description]); return { id: 1 }; },
    async setDraft(current, draft) { return { ...current, draft }; },
    async updateStickyComment(n, body) { log.push(['sticky', body]); },
  };
  assert.equal(await refuseSharedCommit(flaky, pullAt(610), HEAD), 'refused');
  assert.deepEqual(log.find(([k]) => k === 'status'), ['status', 'failure', SHARED]);
});

// #1311 round 1 (Codex 4446635309) — on the CI-triggered path a head already shared gets the refusal even when the
// disarm fails: it is checked before the disarm that throws, and the refusal's own disarm writes it anyway.
test('#1311 Codex 4446635309 — a shared head whose disarm fails still gets the shared-commit refusal on a CI-triggered run', { timeout: 30_000 }, async () => {
  const pulls = new Map([[610, pullAt(610, { auto_merge: queued })], [611, pullAt(611, { auto_merge: queued })]]);
  const statuses = [tokenedSuccess()];
  const result = await runGate({ number: 610, pulls, statuses, overrides: { async disableAutoMerge(pull) { throw new Error(`GraphQL down for #${pull.number}`); } } });
  const written = reviewStatuses(result.log).filter(([, state]) => state !== 'pending').map(([, state, description]) => [state, description]);
  assert.deepEqual(written, [['failure', SHARED]], 'the actionable refusal, not the generic disarm hold');
  const sticky = result.log.filter(([k]) => k === 'sticky').at(-1)[2];
  assert.match(sticky, /#611\b/u);
  assert.equal(result.log.some(([k]) => k === 'scope-read' || k === 'arm' || k === 'merge'), false);
});

// #1311 round 1 (Codex 4446635311) — no re-arm is asked about while a sibling has the head on a fresh list.
test('#1311 Codex 4446635311 — the watchdog asks no re-arm while another open pull request has the head', async () => {
  const green = { ...tokenedSuccess(), updated_at: '2026-11-02T11:00:00Z' };
  const dispatched = [];
  const client = {
    combinedStatus: async () => ({ statuses: [green] }),
    pullRequest: async (n) => pullAt(n),
    dispatchRecovery: async (ref, inputs) => { dispatched.push(inputs); },
    comment: async () => { throw new Error('no notice expected'); },
  };
  const shared = await handOffCorrectionLease(client, pullAt(610), 'JagPat/PMCvitan', 'main', {
    now: '2026-11-02T12:00:00Z', sharesHead: async (head, number, { fresh = false } = {}) => fresh,
  });
  assert.equal(shared?.state, 'shared_commit');
  assert.deepEqual(dispatched, []);
  // alone, the same green is asked about: the row is live
  const alone = await handOffCorrectionLease(client, pullAt(610), 'JagPat/PMCvitan', 'main', {
    now: '2026-11-02T12:00:00Z', sharesHead: async () => false,
  });
  assert.equal(alone?.state, 'rearm_dispatched');
  assert.equal(dispatched.length, 1);
});

// #1311 round 1 (Codex 4446635318; Stage 1's re-check of cc1f0412, probe L5) — a verdict written for another pull request
// is never silence. A BODY verdict it wrote is routed with its provenance (it read that pull request's body, not this one's,
// and an edit or push has the gate judge this body); a commit-level verdict (a Codex finding) is the commit's and is routed
// as this pull request's own.
test('#1311 Codex 4446635318 — a verdict written for a closed sibling is routed, never silent; a body verdict names its provenance', async () => {
  const verdict = (number, description) => ({ id: 9, context: 'codex-current-head', state: 'failure', description,
    updated_at: '2026-11-01T00:00:00Z', target_url: `https://github.com/JagPat/PMCvitan/pull/${number}` });
  const route = async (owed, { flip = null } = {}) => {
    const posted = [];
    let reads = 0;
    const client = {
      combinedStatus: async () => ({ statuses: [flip && reads++ > 0 ? flip : owed] }),
      comments: async () => [], reviews: async () => [], reviewComments: async () => [],
      pullRequest: async () => pullAt(611),
      comment: async (number, body) => { posted.push(body); return { id: 1 }; },
    };
    const result = await handOffCorrectionLease(client, pullAt(611), 'JagPat/PMCvitan', 'main', { now: '2026-11-02T12:00:00Z', sharesHead: async () => false });
    return { result, posted };
  };
  // L5: 611 was refused; 610's long run then published a Codex finding (written for 610) and 610 closed. The finding is the
  // commit's, so it is on 611's code too: 611's owner is told, as before 2A3a
  const finding = await route(verdict(610, 'review: 1 current-head Codex finding'));
  assert.equal(finding.result?.state, 'notify');
  assert.equal(finding.posted.length, 1, 'L5: notified, not stranded');
  assert.doesNotMatch(finding.posted[0], /Written for/u, 'a commit-level verdict is this pull request\'s own');
  // a body verdict 610 wrote (its scope, or a mid-run ownership inconsistency): routed, naming 610 and how to re-judge
  const body = await route(verdict(610, 'scope: missing review-size marker'));
  assert.equal(body.result?.state, 'notify');
  assert.equal(body.posted.length, 1, 'never silence');
  assert.match(body.posted[0], /\*\*Written for:\*\* #610, not this pull request/u);
  assert.match(body.posted[0], /Edit or push this pull request and the gate judges its own body/u);
  // its own body verdict carries no provenance line
  const own = await route(verdict(611, 'scope: missing review-size marker'));
  assert.doesNotMatch(own.posted[0], /Written for/u);
  // the fresh read before posting is judged the same way: a verdict that changed hands is not posted on the stale text
  const flipped = await route(verdict(611, 'scope: missing review-size marker'), { flip: verdict(610, 'scope: missing review-size marker') });
  assert.equal(flipped.result?.state, 'superseded');
  assert.deepEqual(flipped.posted, []);
  assert.equal(inheritedBodyVerdictFrom(verdict(610, 'validation: head commit ownership is inconsistent'), pullAt(611)), 610, 'an ownership validation hold');
  assert.equal(inheritedBodyVerdictFrom(verdict(610, 'ci: Failed checks: lint'), pullAt(611)), null, 'CI is the commit\'s');
  assert.equal(inheritedBodyVerdictFrom({ description: 'scope: x', target_url: 'u' }, pullAt(611)), null, 'no pull request target: this one\'s');
  assert.equal(inheritedBodyVerdictFrom({ description: 'scope: x' }, pullAt(611)), null);
});

// Stage 1's re-check of cc1f0412 (mutant C2) — the re-list after the disarm counts only gate-judged pull requests: an
// eligible sibling that leaves beside a fork that stays leaves this pull request alone.
test('#1311 re-check C2 — the re-list counts only gate-judged pull requests: a fork that stays does not keep the refusal', async () => {
  const fork = pullAt(612, { head: { sha: HEAD, ref: 'patch', repo: { full_name: 'someone/PMCvitan' } } });
  const lists = [[pullAt(610), pullAt(611), fork], [pullAt(610), fork], [pullAt(610), fork]];
  let reads = 0;
  const log = [];
  const client = {
    async openPullRequestsAt() { return lists[Math.min(reads++, lists.length - 1)].map((p) => ({ ...p })); },
    async pullRequest(n) { return n === 612 ? fork : pullAt(n); },
    async setStatus(...args) { log.push(args); return { id: 1 }; },
    async setDraft(current, draft) { return { ...current, draft }; },
    async updateStickyComment() {},
  };
  assert.equal(await refuseSharedCommit(client, pullAt(610), HEAD), null);
  assert.deepEqual(log, [], 'nothing written: alone among gate-judged pull requests');
});

// Stage 1's re-check of cc1f0412 (mutant C3) — the check after the CI-triggered disarm: a sibling that appears only after
// the first check (here, on the list after the disarm) still gets the refusal before anything derived from this body.
test('#1311 re-check C3 — a sibling arriving during the CI-triggered disarm is refused by the second check', { timeout: 30_000 }, async () => {
  const pulls = new Map([[610, pullAt(610)], [611, pullAt(611)]]);
  const statuses = [];
  let reads = 0;
  const result = await runGate({ number: 610, pulls, statuses, overrides: {
    async openPullRequestsAt(sha) {
      reads += 1;
      // the first check and the disarm's own list see 610 alone; 611 arrives after
      const open = [...pulls.values()].filter((p) => p.state === 'open' && p.head.sha === sha && (reads > 2 || p.number === 610));
      return open.map((p) => ({ ...p }));
    },
    // anything derived from this body ends the run at once, so a run that is not stopped fails here, not on the clock
    async pullRequestFiles() { throw new Error('the body-derived scope was read'); },
    async replacementLineage() { throw new Error('the body-derived scope was read'); },
  } });
  assert.equal(result.error, null);
  assert.ok(reads > 2, 'the list was read again after the disarm');
  assert.equal(reviewStatuses(result.log).filter(([, state]) => state !== 'pending').at(-1)?.[2], SHARED);
  assert.equal(result.log.some(([k]) => k === 'scope-read' || k === 'record' || k === 'checks'), false, 'nothing derived from this body');
});

// #1311 round 1 (Codex 4446635322) — a shared-head list that cannot be read fails closed, on the relabel guard and on the
// orchestrate path: the previous green is replaced by the retryable hold and the pull request drafted (dropping its queued
// merge); nothing derived from the body is read or written.
test('#1311 Codex 4446635322 — an unreadable shared-head list fails closed: the green is replaced and the PR drafted', { timeout: 30_000 }, async () => {
  const UNREADABLE = `review: ${CODEX_SHARED_COMMIT_UNREADABLE}`;
  assert.equal(isRetryableReviewFailureDescription(UNREADABLE), true, 'retryable: the gate re-judges this exact head');
  const candidate = '<!-- review-size: standard -->\n<!-- correction-owner: codex -->';
  for (const [name, options] of [
    ['relabel guard', { mode: 'relabel-guard', trigger: 'relabel', body: candidate, ref: 'codex/unit-610' }],
    ['orchestrate', { trigger: 'ci', body: VALID_BODY, ref: 'claude/unit-610' }],
  ]) {
    const pulls = new Map([[610, pullAt(610, { body: options.body, head: { sha: HEAD, ref: options.ref, repo }, auto_merge: queued })]]);
    const statuses = [tokenedSuccess()];
    const result = await runGate({ number: 610, pulls, statuses, mode: options.mode ?? null, trigger: options.trigger,
      overrides: { async openPullRequestsAt() { throw new Error('pulls list 502'); } } });
    assert.equal(statuses.find((s) => s.context === 'codex-current-head').description, UNREADABLE, `${name}: the green is replaced`);
    assert.ok(result.log.some(([k, n, draft]) => k === 'draft' && n === 610 && draft === true), `${name}: drafted`);
    assert.equal(pulls.get(610).auto_merge, null, `${name}: its queued merge is dropped`);
    assert.equal(result.log.some(([k]) => k === 'scope-read' || k === 'arm' || k === 'merge'), false, `${name}: nothing body-derived`);
  }
});

// #1311 round 2 (Codex 4447394159) — the publishing pull request must itself still be at the commit: one that moved while
// a failing disarm ran writes nothing, so the commit, now its sibling's alone, is not refused.
test('#1311 Codex 4447394159 — a PR that moved off the commit during a failing disarm writes no refusal on it', async () => {
  const moved = pullAt(610, { head: { sha: 'f'.repeat(40), ref: 'claude/unit-610', repo } });
  for (const [name, relist, reread, expected] of [
    ['the re-list no longer has it', async () => [pullAt(611, { auto_merge: queued })], async () => moved, 'superseded'],
    ['the re-list fails; the re-read shows it moved', async () => { throw new Error('502'); }, async () => moved, 'superseded'],
    ['both fail: the refusal is written (fails closed)', async () => { throw new Error('502'); }, async () => { throw new Error('502'); }, 'refused'],
  ]) {
    const log = [];
    let lists = 0;
    let reads = 0;
    const client = {
      // the first list (the check) and the disarm's own list both see the two PRs; then the re-list
      async openPullRequestsAt() { lists += 1; return lists <= 2 ? [pullAt(610), pullAt(611, { auto_merge: queued })] : relist(); },
      // the disarm's own first read sees 610 current; the re-read after a failed re-list is the scenario's (later reads,
      // the hold's own, see it current)
      async pullRequest(n) { if (n === 611) return pullAt(611, { auto_merge: queued }); reads += 1; return reads === 2 ? reread() : pullAt(610); },
      async disableAutoMerge() { throw new Error('GraphQL down'); },
      async setStatus(sha, state, description) { log.push(['status', state, description]); return { id: 1 }; },
      async setDraft(current, draft) { return { ...current, draft }; },
      async updateStickyComment(n, body) { log.push(['sticky', body]); },
    };
    assert.equal(await refuseSharedCommit(client, pullAt(610), HEAD), expected, name);
    if (expected === 'superseded') assert.deepEqual(log, [], `${name}: nothing written on the commit`);
    else assert.deepEqual(log.find(([k]) => k === 'status'), ['status', 'failure', SHARED], name);
  }
});

// #1311 round 3 (Codex 4447612716) — the untokened-green withdrawal is the first write and can throw; on a shared head the
// refusal still runs: its disarm drops every queued merge at the commit and its failure replaces the green. Alone, or when
// the refusal's own write fails too, the withdrawal's error ends the run as before (the shared case still disarmed).
test('#1311 Codex 4447612716 — a failed untokened-green withdrawal on a shared head still disarms and refuses', { timeout: 30_000 }, async () => {
  const untokened = { id: 6101, context: 'codex-current-head', state: 'success', description: 'review: Codex found no blocking issue on this exact head' };
  for (const [name, shared, always] of [
    ['shared, only the withdrawal fails', true, false],
    ['shared, every status write fails', true, true],
    ['alone, the withdrawal fails', false, false],
  ]) {
    const pulls = new Map([[610, pullAt(610, { auto_merge: queued })]]);
    if (shared) pulls.set(611, pullAt(611, { auto_merge: queued }));
    const statuses = [{ ...untokened }];
    const written = [];
    const result = await runGate({ number: 610, pulls, statuses, overrides: {
      async setStatus(sha, state, description, url, context = 'codex-current-head') {
        if (always || /withdrawn/u.test(description)) throw new Error(`statuses 502 writing ${description}`);
        const status = { id: 7000 + written.length, context, state, description, target_url: url };
        statuses.unshift(status);
        written.push([state, description, context]);
        return status;
      },
    } });
    const queuedLeft = [...pulls.values()].filter((p) => p.auto_merge).map((p) => p.number);
    if (shared) assert.deepEqual(queuedLeft, [], `${name}: every queued merge at the commit is disarmed`);
    if (shared && !always) {
      assert.equal(result.error, null, name);
      assert.deepEqual(written.filter(([, , c]) => c === 'codex-current-head').map(([st, d]) => [st, d]), [['failure', SHARED]], `${name}: the refusal replaces the green`);
    } else {
      assert.match(String(result.error?.message), /statuses 502 writing review: withdrawn/u, `${name}: the withdrawal's own error ends the run`);
      assert.equal(statuses.find((s) => s.context === 'codex-current-head').state, 'success', `${name}: nothing else was written`);
    }
    assert.equal(result.log.some(([k]) => k === 'scope-read' || k === 'arm' || k === 'merge'), false, `${name}: nothing body-derived`);
  }
});
