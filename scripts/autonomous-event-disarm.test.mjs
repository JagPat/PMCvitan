import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GitHubClient, contextForEvent, run } from './autonomous-review-gate.mjs';
import { codexRecordRunningOn } from './autonomous-review-state.mjs';
import {
  CODEX_RUN_HELD_DETAIL, CODEX_SHARED_COMMIT_DETAIL, CODEX_AUTOMERGE_DISARM_FAILED, OWNERSHIP_CANDIDATE_HELD,
} from './review-policy.mjs';

/**
 * 2A3b (notes/gate-codex-silent/2a3/2a3b-design.md; Stage 1's ruling of 2 Nov) — the event-driven disarm. On the event
 * that invalidates a queued merge (a push, an arm on a shared commit, a Codex run on the head, a withholding ownership
 * verdict) the gate disarms within seconds, from trusted default-branch code, and never arms or writes a success.
 */
const HEAD = 'e'.repeat(40);
const OLD = 'd'.repeat(40);
const repo = { full_name: 'JagPat/PMCvitan' };
const queued = { enabled_at: '2026-11-02T00:00:00Z', merge_method: 'squash', enabled_by: { login: 'a-person' } };
const pullAt = (number, extra = {}) => ({
  number, node_id: `PR_${number}`, state: 'open', draft: false, additions: 1, deletions: 0, changed_files: 1,
  auto_merge: null, body: '<!-- review-size: standard -->\n<!-- correction-owner: claude -->',
  head: { sha: HEAD, ref: `claude/unit-${number}`, repo },
  base: { ref: 'main', sha: 'b'.repeat(40), repo },
  html_url: `https://github.com/JagPat/PMCvitan/pull/${number}`,
  ...extra,
});
const tokenedSuccess = () => ({ id: 6100, context: 'codex-current-head', state: 'success', description: 'review: Codex found no blocking issue on this exact head [wi:none]' });
const codexRecord = (head, status, login = 'chatgpt-codex-connector[bot]') => ({
  id: 77, user: { login }, updated_at: '2026-11-02T21:00:00Z',
  body: `<!-- codex-pull-request-review-summary -->\n<!-- codex-review-state:v1 ${JSON.stringify({
    code_review: { commit_sha: head, has_any_findings: null, has_unresolved_findings: null, status },
    security_review: { commit_sha: null, has_any_findings: null, has_unresolved_findings: null, status: null },
  })} -->`,
});
const events = {
  synchronize: (number, head = HEAD) => ['pull_request_target', { action: 'synchronize', pull_request: { number, head: { sha: head } } }],
  armed: (number, login = 'a-person', head = HEAD) => ['pull_request_target', {
    action: 'auto_merge_enabled', sender: { login }, pull_request: { number, head: { sha: head }, auto_merge: { enabled_by: { login } } },
  }],
  record: (number, comment) => ['issue_comment', { action: 'edited', issue: { number, pull_request: { url: 'u' } }, comment }],
};

/** `run()` in the event-disarm mode, with every GitHubClient method replaced by a recorder (the 2A3a harness). */
async function runDisarm({ number, pulls, statuses, event, overrides = {}, mode = 'event-disarm', comments = null }) {
  const log = [];
  // the live comments: by default the record as the event carried it
  const liveComments = comments ?? (event[0] === 'issue_comment' && event[1].comment ? [event[1].comment] : []);
  let nextId = 6200;
  const stubs = {
    async pullRequest(n) { log.push(['read', n]); const found = pulls.get(n); return found ? { ...found } : null; },
    async openPullRequestsAt(sha) { log.push(['list']); return [...pulls.values()].filter((p) => p.state === 'open' && p.head.sha === sha).map((p) => ({ ...p })); },
    async statuses() { return [...statuses]; },
    async issueComments(n) { log.push(['comments', n]); return liveComments.map((c) => ({ ...c })); },
    async setStatus(sha, state, description, url, context = 'codex-current-head') {
      const status = { id: nextId += 1, context, state, description, target_url: url };
      statuses.unshift(status);
      log.push(['status', state, description, context]);
      return status;
    },
    async setDraft(current, draft) { log.push(['draft', current.number, draft]); const p = pulls.get(current.number); p.draft = draft; if (draft) p.auto_merge = null; return { ...p }; },
    async updateStickyComment(n, body) { log.push(['sticky', n, body]); },
    async disableAutoMerge(pull) { log.push(['disable', pull.number]); pulls.get(pull.number).auto_merge = null; },
    async enableAutoMerge(current) { log.push(['arm', current.number]); },
    async mergeExactHead(n) { log.push(['merge', n]); return { merged: false }; },
  };
  const names = Object.getOwnPropertyNames(GitHubClient.prototype).filter((name) => name !== 'constructor');
  const saved = new Map(names.map((name) => [name, Object.getOwnPropertyDescriptor(GitHubClient.prototype, name)]));
  const keys = ['GITHUB_REPOSITORY', 'GITHUB_TOKEN', 'GITHUB_EVENT_NAME', 'GITHUB_EVENT_PATH', 'AUTONOMOUS_REVIEW_MODE', 'GITHUB_ENV', 'PR_NUMBER'];
  const env = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  const dir = await mkdtemp(join(tmpdir(), '2a3b-run-'));
  try {
    for (const name of names) {
      Object.defineProperty(GitHubClient.prototype, name, {
        configurable: true, writable: true,
        value: overrides[name] ?? stubs[name] ?? (async function unstubbed() { log.push(['unstubbed', name]); return undefined; }),
      });
    }
    const [eventName, payload] = event;
    const eventPath = join(dir, 'event.json');
    await writeFile(eventPath, JSON.stringify(payload));
    for (const key of keys) delete process.env[key];
    Object.assign(process.env, {
      GITHUB_REPOSITORY: 'JagPat/PMCvitan', GITHUB_TOKEN: 'test-token', GITHUB_EVENT_NAME: eventName, GITHUB_EVENT_PATH: eventPath,
      AUTONOMOUS_REVIEW_MODE: mode,
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

const written = (log) => log.filter(([k, , , context]) => k === 'status' && context === 'codex-current-head').map(([, state, description]) => [state, description]);
const neverArmsOrMerges = (log, name) => assert.equal(log.some(([k, , state]) => k === 'arm' || k === 'merge' || (k === 'status' && state === 'success')), false, `${name}: never arms, merges or writes a success`);

test('2A3b-1/2 — the three event contexts, and none for other events', () => {
  assert.deepEqual(contextForEvent(...events.synchronize(610)),
    { number: 610, expectedHead: HEAD, ciConclusion: null, trigger: 'synchronize', enabledBy: null });
  assert.equal(contextForEvent(...events.armed(610)).trigger, 'auto-merge-enabled');
  assert.equal(contextForEvent(...events.armed(610)).enabledBy, 'a-person');
  const record = codexRecord(HEAD, 'in_progress');
  assert.deepEqual(contextForEvent(...events.record(610, record)),
    { number: 610, expectedHead: null, ciConclusion: null, trigger: 'codex-record', comment: record });
  assert.equal(contextForEvent('issue_comment', { action: 'created', issue: { number: 9 }, comment: record }), null, 'an issue, not a pull request');
  assert.equal(contextForEvent('issue_comment', { action: 'deleted', issue: { number: 9, pull_request: {} }, comment: record }), null);
  assert.equal(contextForEvent('pull_request_target', { action: 'labeled', pull_request: { number: 610 } }), null);
});

test('2A3b-1 — a push disarms every queued merge at the new head, and refuses a commit another open PR has', { timeout: 30_000 }, async () => {
  const armed = await runDisarm({ number: 610, pulls: new Map([[610, pullAt(610, { auto_merge: queued })]]), statuses: [], event: events.synchronize(610) });
  assert.equal(armed.error, null);
  assert.deepEqual(armed.log.filter(([k]) => k === 'disable'), [['disable', 610]], 'its arm for the old head is dropped');
  assert.deepEqual(written(armed.log), [], 'alone: nothing written, CI judges the head');
  neverArmsOrMerges(armed.log, 'armed');

  const pulls = new Map([[610, pullAt(610, { auto_merge: queued })], [611, pullAt(611, { auto_merge: queued })]]);
  const statuses = [tokenedSuccess()];
  const shared = await runDisarm({ number: 610, pulls, statuses, event: events.synchronize(610) });
  assert.equal(shared.error, null);
  assert.deepEqual([...pulls.values()].filter((p) => p.auto_merge).map((p) => p.number), [], 'both disarmed');
  assert.deepEqual(written(shared.log), [['failure', `review: ${CODEX_SHARED_COMMIT_DETAIL}`]], 'the 2A3a refusal, within seconds of the push');
  neverArmsOrMerges(shared.log, 'shared');

  const quiet = await runDisarm({ number: 610, pulls: new Map([[610, pullAt(610)]]), statuses: [], event: events.synchronize(610) });
  assert.deepEqual(quiet.log.filter(([k]) => k === 'disable' || k === 'status' || k === 'draft'), [], 'alone and unarmed: nothing');
});

test('2A3b-1 (Q1 = a) — an arm acts only on a shared commit: a person\'s arm alone stays; the gate\'s own is ignored', { timeout: 30_000 }, async () => {
  const pulls = new Map([[610, pullAt(610, { auto_merge: queued })], [611, pullAt(611, { auto_merge: queued })]]);
  const statuses = [tokenedSuccess()];
  const shared = await runDisarm({ number: 611, pulls, statuses, event: events.armed(611) });
  assert.equal(shared.error, null);
  assert.deepEqual([...pulls.values()].filter((p) => p.auto_merge).map((p) => p.number), [], 'every arm at the commit dropped');
  assert.deepEqual(written(shared.log), [['failure', `review: ${CODEX_SHARED_COMMIT_DETAIL}`]]);
  neverArmsOrMerges(shared.log, 'shared');

  const alonePulls = new Map([[610, pullAt(610, { auto_merge: queued })]]);
  const alone = await runDisarm({ number: 610, pulls: alonePulls, statuses: [tokenedSuccess()], event: events.armed(610) });
  assert.equal(alone.error, null);
  assert.ok(alonePulls.get(610).auto_merge, 'a person\'s arm on a PR alone at its commit stays (the Board ruling on #1094)');
  assert.deepEqual(alone.log.filter(([k]) => k === 'disable' || k === 'status' || k === 'draft'), []);

  const gatePulls = new Map([[610, pullAt(610, { auto_merge: queued })], [611, pullAt(611)]]);
  const gate = await runDisarm({ number: 610, pulls: gatePulls, statuses: [], event: events.armed(610, 'github-actions[bot]') });
  assert.deepEqual(gate.log.filter(([k]) => k !== 'read'), [], 'the gate\'s own arm: nothing read beyond the PR, nothing written');
});

// Gap-check gap 1 (mutant G9) — the group is keyed by the event's head, so a run can start after the PR moved on; the
// payload head no longer live must write nothing, or a stale event could disarm or refuse a legitimately reviewed head
test('2A3b-1 — a stale event (its head is no longer the live head) disables nothing and writes nothing', { timeout: 30_000 }, async () => {
  for (const [name, event] of [['a push', events.synchronize(610, OLD)], ['an arm', events.armed(610, 'a-person', OLD)]]) {
    const pulls = new Map([[610, pullAt(610, { auto_merge: queued })], [611, pullAt(611, { auto_merge: queued })]]);
    const statuses = [tokenedSuccess()];
    const stale = await runDisarm({ number: 610, pulls, statuses, event });
    assert.equal(stale.error, null, name);
    assert.deepEqual([...pulls.values()].filter((p) => p.auto_merge).map((p) => p.number), [610, 611], `${name}: every live merge stays queued`);
    assert.deepEqual(stale.log.filter(([k]) => k === 'disable' || k === 'status' || k === 'draft' || k === 'sticky'), [], `${name}: nothing written`);
    assert.equal(statuses.length, 1, `${name}: the live head's success is untouched`);
  }
});

// Gap-check gap 3 (mutant G2) — the refusal settles the recovery request this run adopted, so the watchdog's next ask
// is for the refusal and is not held until the abandoned limit
test('2A3b-1 — the refusal settles the adopted recovery request, on a push and on an arm', { timeout: 30_000 }, async () => {
  for (const [name, number, event] of [['a push', 610, events.synchronize(610)], ['an arm', 611, events.armed(611)]]) {
    const request = { id: 7001, context: 'codex-recovery-request/6100', state: 'pending', description: 'recovery: requested terminal status 6100' };
    const pulls = new Map([[610, pullAt(610, { auto_merge: queued })], [611, pullAt(611, { auto_merge: queued })]]);
    const statuses = [request, tokenedSuccess()];
    const result = await runDisarm({ number, pulls, statuses, event });
    assert.equal(result.error, null, name);
    assert.deepEqual(written(result.log), [['failure', `review: ${CODEX_SHARED_COMMIT_DETAIL}`]], `${name}: the refusal`);
    const settled = result.log.filter(([k, , , context]) => k === 'status' && context === 'codex-recovery-request/6100');
    assert.equal(settled.length, 1, `${name}: the adopted request is settled`);
    assert.equal(settled[0][1], 'success');
    assert.match(settled[0][2], /^recovery: consumed by /u);
  }
});

test('2A3b-2 (W2) — a Codex run on the live head with a merge queued is disarmed and held; otherwise nothing', { timeout: 30_000 }, async () => {
  const pulls = new Map([[610, pullAt(610, { auto_merge: queued })]]);
  const statuses = [tokenedSuccess()];
  const held = await runDisarm({ number: 610, pulls, statuses, event: events.record(610, codexRecord(HEAD, 'in_progress')) });
  assert.equal(held.error, null);
  assert.equal(pulls.get(610).auto_merge, null, 'disarmed');
  assert.deepEqual(written(held.log), [['failure', `review: ${CODEX_RUN_HELD_DETAIL}`]], 'the retryable hold the recovery re-judges');
  assert.ok(held.log.some(([k, n, draft]) => k === 'draft' && n === 610 && draft === true));
  neverArmsOrMerges(held.log, 'held');

  for (const [name, comment, auto] of [
    ['a run on an older head (the head moved while the job waited)', codexRecord(OLD, 'in_progress'), queued],
    ['a completed review', codexRecord(HEAD, 'completed'), queued],
    ['another login carrying the marker', codexRecord(HEAD, 'in_progress', 'someone-else'), queued],
    ['unparseable JSON', { ...codexRecord(HEAD, 'in_progress'), body: '<!-- codex-review-state:v1 {not json -->' }, queued],
    ['a run with nothing queued (the waiting orchestrate run sees it)', codexRecord(HEAD, 'in_progress'), null],
  ]) {
    const quietPulls = new Map([[610, pullAt(610, { auto_merge: auto })]]);
    const quiet = await runDisarm({ number: 610, pulls: quietPulls, statuses: [tokenedSuccess()], event: events.record(610, comment) });
    assert.equal(quiet.error, null, name);
    assert.deepEqual(quiet.log.filter(([k]) => k === 'status' || k === 'draft' || k === 'sticky' || k === 'disable'), [], `${name}: nothing written`);
    if (auto) assert.ok(quietPulls.get(610).auto_merge, `${name}: the merge stays queued`);
  }
});

// Gap-check of 500fbea6 (carried to 2A3b-2) — the record is judged as it reads now, never on the event's copy alone
test('2A3b-2 (W2) — the Codex record is re-read live: a run the event saw that has since completed or gone writes nothing', { timeout: 30_000 }, async () => {
  const running = codexRecord(HEAD, 'in_progress');
  for (const [name, live] of [
    ['completed since the event', [{ ...codexRecord(HEAD, 'completed'), id: running.id }]],
    ['now names another head', [{ ...codexRecord(OLD, 'in_progress'), id: running.id }]],
    ['deleted since the event', []],
  ]) {
    const pulls = new Map([[610, pullAt(610, { auto_merge: queued })]]);
    const result = await runDisarm({ number: 610, pulls, statuses: [tokenedSuccess()], event: events.record(610, running), comments: live });
    assert.equal(result.error, null, name);
    assert.ok(pulls.get(610).auto_merge, `${name}: the merge stays queued`);
    assert.deepEqual(result.log.filter(([k]) => k === 'status' || k === 'draft' || k === 'sticky' || k === 'disable'), [], `${name}: nothing written`);
  }
  // the payload says completed, the live record shows a new run on the head: held on the live state
  const pulls = new Map([[610, pullAt(610, { auto_merge: queued })]]);
  const fresh = await runDisarm({ number: 610, pulls, statuses: [tokenedSuccess()],
    event: events.record(610, codexRecord(HEAD, 'completed')), comments: [running] });
  assert.equal(pulls.get(610).auto_merge, null, 'the live run disarms');
  assert.deepEqual(written(fresh.log), [['failure', `review: ${CODEX_RUN_HELD_DETAIL}`]]);
  // the re-read fails: the event's copy is judged, which fails closed (a retryable hold the recovery re-judges)
  const closedPulls = new Map([[610, pullAt(610, { auto_merge: queued })]]);
  const unread = await runDisarm({ number: 610, pulls: closedPulls, statuses: [tokenedSuccess()], event: events.record(610, running),
    overrides: { async issueComments() { throw new Error('REST down'); } } });
  assert.equal(unread.error, null);
  assert.equal(closedPulls.get(610).auto_merge, null, 'disarmed on the event\'s copy');
  assert.deepEqual(written(unread.log), [['failure', `review: ${CODEX_RUN_HELD_DETAIL}`]]);
});

// Gap-check of 500fbea6 (carried to 2A3b-2) — the hold is the commit's: a sibling's queued merge at the head, with this
// PR unarmed, is disarmed and held too; and the hold settles the recovery request this run adopted
test('2A3b-2 (W2) — a sibling\'s queued merge at the head is held too; the hold settles the adopted recovery request', { timeout: 30_000 }, async () => {
  const pulls = new Map([[610, pullAt(610)], [611, pullAt(611, { auto_merge: queued })]]);
  const request = { id: 7001, context: 'codex-recovery-request/6100', state: 'pending', description: 'recovery: requested terminal status 6100' };
  const result = await runDisarm({ number: 610, pulls, statuses: [request, tokenedSuccess()], event: events.record(610, codexRecord(HEAD, 'in_progress')) });
  assert.equal(result.error, null);
  assert.equal(pulls.get(611).auto_merge, null, 'the sibling\'s merge on this commit is disarmed');
  assert.deepEqual(written(result.log), [['failure', `review: ${CODEX_RUN_HELD_DETAIL}`]], 'and the commit held');
  const settled = result.log.filter(([k, , , context]) => k === 'status' && context === 'codex-recovery-request/6100');
  assert.equal(settled.length, 1, 'the adopted request is settled');
  assert.match(settled[0][2], /^recovery: consumed by /u);
  neverArmsOrMerges(result.log, 'sibling');
});

test('2A3b-2 — the ownership consumer: a merge queued under a withholding verdict is disarmed, the verdict stays', { timeout: 30_000 }, async () => {
  const withholding = { id: 6101, context: 'codex-current-head', state: 'failure', description: `${OWNERSHIP_CANDIDATE_HELD}` };
  const pulls = new Map([[610, pullAt(610, { auto_merge: queued })]]);
  const result = await runDisarm({ number: 610, pulls, statuses: [withholding], event: events.armed(610) });
  assert.equal(result.error, null);
  assert.equal(pulls.get(610).auto_merge, null, 'disarmed');
  assert.deepEqual(written(result.log), [], 'the withholding failure stays; nothing written over it');

  const other = { id: 6102, context: 'codex-current-head', state: 'failure', description: 'review: 1 current-head Codex finding' };
  const kept = new Map([[610, pullAt(610, { auto_merge: queued })]]);
  const left = await runDisarm({ number: 610, pulls: kept, statuses: [other], event: events.armed(610) });
  assert.ok(kept.get(610).auto_merge, 'a non-withholding failure is left to the ordinary review');
  assert.deepEqual(left.log.filter(([k]) => k === 'disable' || k === 'status'), []);

  // only the newest verdict counts: a withholding failure a later verdict replaced withholds nothing
  const superseded = new Map([[610, pullAt(610, { auto_merge: queued })]]);
  const newer = await runDisarm({ number: 610, pulls: superseded, statuses: [other, withholding], event: events.armed(610) });
  assert.ok(superseded.get(610).auto_merge, 'an older withholding failure, replaced since, is not acted on');
  assert.deepEqual(newer.log.filter(([k]) => k === 'disable' || k === 'status'), []);
});

test('2A3b-1 — a disarm that fails takes the retryable disarm hold; a mode on the wrong event refuses', { timeout: 30_000 }, async () => {
  const pulls = new Map([[610, pullAt(610, { auto_merge: queued })]]);
  const failed = await runDisarm({ number: 610, pulls, statuses: [], event: events.synchronize(610),
    overrides: { async disableAutoMerge() { throw new Error('GraphQL down'); } } });
  assert.ok(failed.error, 'the run fails');
  assert.deepEqual(written(failed.log), [['failure', `review: ${CODEX_AUTOMERGE_DISARM_FAILED}`]], 'fails closed');

  const wrong = await runDisarm({ number: 610, pulls: new Map([[610, pullAt(610)]]), statuses: [], event: events.synchronize(610), mode: 'orchestrate' });
  assert.match(String(wrong.error?.message), /does not run on a synchronize event/u);
  const wrongEvent = await runDisarm({ number: 610, pulls: new Map([[610, pullAt(610)]]), statuses: [],
    event: ['pull_request_target', { action: 'edited', pull_request: { number: 610, head: { sha: HEAD } } }] });
  assert.match(String(wrongEvent.error?.message), /does not run on a relabel event/u);
});

test('2A3b-2 — the record reader: Codex\'s login, the marker, the live head, a run not completed', () => {
  assert.equal(codexRecordRunningOn(codexRecord(HEAD, 'in_progress'), HEAD), true);
  assert.equal(codexRecordRunningOn(codexRecord(HEAD, 'queued'), HEAD), true);
  assert.equal(codexRecordRunningOn(codexRecord(HEAD, 'completed'), HEAD), false);
  assert.equal(codexRecordRunningOn(codexRecord(OLD, 'in_progress'), HEAD), false);
  assert.equal(codexRecordRunningOn(codexRecord(HEAD, 'in_progress', 'chatgpt-codex-connector'), HEAD), false, 'the REST login only');
  assert.equal(codexRecordRunningOn(codexRecord(HEAD, 'in_progress'), null), false);
  assert.equal(codexRecordRunningOn(null, HEAD), false);
});

test('2A3b-2 — structural: the workflow runs trusted default-branch code on its three events, and both login checks exist', async () => {
  const workflow = await readFile(new URL('../.github/workflows/event-disarm.yml', import.meta.url), 'utf8');
  const gate = await readFile(new URL('./autonomous-review-gate.mjs', import.meta.url), 'utf8');
  const state = await readFile(new URL('./autonomous-review-state.mjs', import.meta.url), 'utf8');
  assert.match(workflow, /pull_request_target:\s*\n\s*types: \[synchronize, auto_merge_enabled\]/u);
  assert.match(workflow, /issue_comment:\s*\n\s*types: \[created, edited\]/u);
  assert.doesNotMatch(workflow, /^\s*(push|pull_request|workflow_run|schedule|workflow_dispatch):/mu);
  assert.deepEqual([...workflow.matchAll(/^\s*ref:\s*(.+)$/gmu)].map(([, ref]) => ref.trim()), ['${{ github.event.repository.default_branch }}'], 'never PR code');
  assert.match(workflow, /persist-credentials:\s*false/u);
  assert.match(workflow, /actions\/checkout@[0-9a-f]{40}/u);
  assert.match(workflow, /actions\/setup-node@[0-9a-f]{40}/u);
  assert.doesNotMatch(workflow, /pnpm|npm (ci|install)/u);
  assert.match(workflow, /head\.repo\.full_name == github\.repository/u);
  assert.match(workflow, /AUTONOMOUS_REVIEW_MODE: event-disarm/u);
  const permissions = workflow.slice(workflow.indexOf('permissions:'), workflow.indexOf('jobs:'));
  assert.deepEqual([...permissions.matchAll(/^\s+([a-z-]+):\s*(\w+)/gmu)].map(([, name, level]) => `${name}:${level}`).sort(),
    ['contents:read', 'issues:write', 'pull-requests:write', 'statuses:write']);
  assert.match(workflow, /format\('autonomous-review-owner-\{0\}-\{1\}', github\.event\.pull_request\.number, github\.event\.pull_request\.head\.sha\)/u,
    'a push or an arm shares the controller\'s exact-head group');
  assert.match(workflow, /\|\| format\('autonomous-review-event-disarm-\{0\}', github\.event\.issue\.number\) \}\}/u,
    'a Codex record: a per-PR group (Q3), never per run');
  assert.match(workflow, /cancel-in-progress:\s*false/u);
  // the job filter: only a pull request's comment, by Codex, carrying the record marker
  assert.match(workflow, /github\.event\.issue\.pull_request &&/u);
  assert.match(workflow, /contains\(github\.event\.comment\.body, 'codex-review-state:v1'\)/u);
  // Stage 1's ruling: neither login check can be dropped alone — the job filter, and the reader's own re-check
  assert.match(workflow, /github\.event\.comment\.user\.login == 'chatgpt-codex-connector\[bot\]'/u);
  const reader = state.slice(state.indexOf('export function codexRecordRunningOn'), state.indexOf('export function codexStateRecordClears'));
  assert.match(reader, /if \(!isCodexActor\(comment\)/u);
  // eventDisarm never arms and never writes a success
  const disarm = gate.slice(gate.indexOf('export async function eventDisarm'), gate.indexOf('\n}\n', gate.indexOf('export async function eventDisarm')));
  assert.doesNotMatch(disarm, /enableAutoMerge|completeReviewedPullRequest|publishSettledSuccess|publishDisarmedSuccess|completeCleanReview|'success'/u);
  // the ownership predicate has its consumer
  assert.match(disarm, /ownershipStatusWithholdsAutoMerge\(/u);
  assert.doesNotMatch(gate, /deferred to (the )?2A3b/u);
});
