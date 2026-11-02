import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GitHubClient, REQUIRED_CHECKS, refuseSharedCommit, run } from './autonomous-review-gate.mjs';
import { handOffCorrectionLease, otherOpenPullRequestAt } from './autonomous-handoff.mjs';
import { gateRecoveryStatus } from './correction-lease.mjs';
import { CODEX_SHARED_COMMIT_DETAIL, isRetryableReviewFailureDescription } from './review-policy.mjs';

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
async function runGate({ number, pulls, statuses, mode = null, trigger = 'ci' }) {
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
        value: stubs[name] ?? (async function unstubbed() { log.push(['unstubbed', name]); return undefined; }),
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
  const candidate = '<!-- review-size: standard -->\n<!-- correction-owner: codex -->';
  const pulls = new Map([[610, pullAt(610, { body: candidate })], [611, pullAt(611, { auto_merge: queued })]]);
  const statuses = [];
  const guarded = await runGate({ number: 610, pulls, statuses, mode: 'relabel-guard', trigger: 'relabel' });
  assert.equal(guarded.error, null);
  // no CI-triggered disarm ran on this path: the refusal itself disarms the sibling's queued merge
  assert.deepEqual(guarded.log.filter(([k]) => k === 'disable').map(([, n]) => n), [611]);
  assert.equal(pulls.get(611).auto_merge, null);
  assert.deepEqual(reviewStatuses(guarded.log).filter(([, state]) => state !== 'pending').map(([, s, d]) => [s, d]), [['failure', SHARED]]);
  assert.equal(guarded.log.some(([k]) => k === 'scope-read'), false);
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
