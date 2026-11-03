import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GitHubClient, contextForEvent, run } from './autonomous-review-gate.mjs';
import { codexRecordLatestMs, codexStateRecordVerdict } from './autonomous-review-state.mjs';
import { securityVerdictMarker } from './security-verdict-marker.mjs';
import {
  CODEX_RUN_HELD_DETAIL, CODEX_SECURITY_FINDINGS_DETAIL, CODEX_SHARED_COMMIT_DETAIL, CODEX_AUTOMERGE_DISARM_FAILED, OWNERSHIP_CANDIDATE_HELD, REARM_SETTLEMENTS, REARM_ATTEMPT_FAILED,
} from './review-policy.mjs';

/**
 * 2A3b (notes/gate-codex-silent/2a3/2a3b-design.md; Stage 1's ruling of 2 Nov) — the event-driven disarm. On the event
 * that invalidates a queued merge (a push, an arm on a shared commit, a Codex run on the head, a withholding ownership
 * verdict) the gate disarms within seconds, from trusted default-branch code, and never arms or writes a success.
 */
// the real client methods, captured before any harness swaps the prototype
const realRequest = GitHubClient.prototype.request;
const realIssueComment = GitHubClient.prototype.issueComment;
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
// written after the fixtures' Codex records (21:00), so a dirty record here is one this green judged
const tokenedSuccess = (at = '2026-11-02T21:30:00Z') => ({ id: 6100, context: 'codex-current-head', state: 'success', description: 'review: Codex found no blocking issue on this exact head [wi:none]', created_at: at, updated_at: at });
const codexRecord = (head, status, login = 'chatgpt-codex-connector[bot]') => ({
  id: 77, user: { login }, updated_at: '2026-11-02T21:00:00Z',
  body: `<!-- codex-pull-request-review-summary -->\n<!-- codex-review-state:v1 ${JSON.stringify({
    code_review: { commit_sha: head, has_any_findings: null, has_unresolved_findings: null, status },
    security_review: { commit_sha: null, has_any_findings: null, has_unresolved_findings: null, status: null },
  })} -->`,
});
// Codex's record of a code review completed clean on `head`, the security review idle
const cleanRecord = (head) => ({
  id: 77, user: { login: 'chatgpt-codex-connector[bot]' }, updated_at: '2026-11-02T21:00:00Z',
  body: `<!-- codex-pull-request-review-summary -->\n<!-- codex-review-state:v1 ${JSON.stringify({
    code_review: { commit_sha: head, has_any_findings: false, has_unresolved_findings: false, status: 'completed' },
    security_review: { commit_sha: null, has_any_findings: null, has_unresolved_findings: null, status: null },
  })} -->`,
});
// Codex's record of a code review completed on `head` with unresolved findings (`dirty`)
const dirtyRecord = (head) => ({
  id: 77, user: { login: 'chatgpt-codex-connector[bot]' }, updated_at: '2026-11-02T21:00:00Z',
  body: `<!-- codex-pull-request-review-summary -->\n<!-- codex-review-state:v1 ${JSON.stringify({
    code_review: { commit_sha: head, has_any_findings: true, has_unresolved_findings: true, status: 'completed' },
    security_review: { commit_sha: null, has_any_findings: null, has_unresolved_findings: null, status: null },
  })} -->`,
});
// Codex's record with code_review idle and security_review running on `head` (gap-check P10)
const securityRecord = (head, status) => ({
  id: 78, user: { login: 'chatgpt-codex-connector[bot]' }, updated_at: '2026-11-02T21:00:00Z',
  body: `<!-- codex-pull-request-review-summary -->\n<!-- codex-review-state:v1 ${JSON.stringify({
    code_review: { commit_sha: null, has_any_findings: null, has_unresolved_findings: null, status: null },
    security_review: { commit_sha: head, has_any_findings: null, has_unresolved_findings: null, status },
  })} -->`,
});
// #1318 Codex 4448897199 — a code review still running while the security review has completed with findings
const securityFindingsWhileRunning = (head) => ({
  id: 79, user: { login: 'chatgpt-codex-connector[bot]' }, updated_at: '2026-11-02T21:00:00Z',
  body: `<!-- codex-pull-request-review-summary -->\n<!-- codex-review-state:v1 ${JSON.stringify({
    code_review: { commit_sha: head, has_any_findings: null, has_unresolved_findings: null, status: 'in_progress' },
    security_review: { commit_sha: head, has_any_findings: true, has_unresolved_findings: true, status: 'completed' },
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
    async issueComment(id) {
      log.push(['comment', id]);
      const found = liveComments.find((c) => String(c.id) === String(id));
      if (!found) throw new Error(`GitHub GET /repos/JagPat/PMCvitan/issues/comments/${id} failed (404): Not Found`);
      return { ...found, issue_url: `https://api.github.com/repos/JagPat/PMCvitan/issues/${number}` };
    },
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
  // the id read back belongs to another pull request: not this PR's record
  const elsewhere = new Map([[610, pullAt(610, { auto_merge: queued })]]);
  const other = await runDisarm({ number: 610, pulls: elsewhere, statuses: [tokenedSuccess()], event: events.record(610, running),
    overrides: { async issueComment() { return { ...running, issue_url: 'https://api.github.com/repos/JagPat/PMCvitan/issues/611' }; } } });
  assert.ok(elsewhere.get(610).auto_merge, 'another pull request\'s comment: the merge stays queued');
  assert.deepEqual(written(other.log), []);
  // the payload says completed, the live record shows a new run on the head: held on the live state
  const pulls = new Map([[610, pullAt(610, { auto_merge: queued })]]);
  const fresh = await runDisarm({ number: 610, pulls, statuses: [tokenedSuccess()],
    event: events.record(610, codexRecord(HEAD, 'completed')), comments: [running] });
  assert.equal(pulls.get(610).auto_merge, null, 'the live run disarms');
  assert.deepEqual(written(fresh.log), [['failure', `review: ${CODEX_RUN_HELD_DETAIL}`]]);
  // the re-read fails: the event's copy is judged, which fails closed (a retryable hold the recovery re-judges)
  const closedPulls = new Map([[610, pullAt(610, { auto_merge: queued })]]);
  const unread = await runDisarm({ number: 610, pulls: closedPulls, statuses: [tokenedSuccess()], event: events.record(610, running),
    overrides: { async issueComment() { throw new Error('GitHub GET /repos/JagPat/PMCvitan/issues/comments/77 failed (502): Bad Gateway'); } } });
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

// Gap-check of aa882775 (P10) — a security review running on the head holds as a code review does
test('2A3b-2 (W2) — a security review running on the head, the code review idle, is disarmed and held', { timeout: 30_000 }, async () => {
  const pulls = new Map([[610, pullAt(610, { auto_merge: queued })]]);
  const result = await runDisarm({ number: 610, pulls, statuses: [tokenedSuccess()], event: events.record(610, securityRecord(HEAD, 'in_progress')) });
  assert.equal(result.error, null);
  assert.equal(pulls.get(610).auto_merge, null, 'disarmed');
  assert.deepEqual(written(result.log), [['failure', `review: ${CODEX_RUN_HELD_DETAIL}`]]);
});

// #1318 Codex 4448897199 — security findings completed on the head outrank a run still going: the event takes the
// security verdict (its durable marker, then the correction failure), never the retryable run hold
test('2A3b-2 (#1318 Codex 4448897199) — security findings on the head with a run still going take the security verdict, not the hold', { timeout: 30_000 }, async () => {
  const pulls = new Map([[610, pullAt(610, { auto_merge: queued })]]);
  const record = securityFindingsWhileRunning(HEAD);
  const markers = [];
  const result = await runDisarm({
    number: 610, pulls, statuses: [tokenedSuccess()], event: events.record(610, record),
    overrides: {
      async createIssueComment(n, body) { markers.push(['marker', n, body]); return { id: 902 }; },
      async reviews() { return []; },
      async reviewComments() { return []; },
    },
  });
  assert.equal(result.error, null);
  assert.equal(pulls.get(610).auto_merge, null, 'disarmed');
  const failures = written(result.log).filter(([state]) => state === 'failure');
  assert.deepEqual(failures, [['failure', `review: ${CODEX_SECURITY_FINDINGS_DETAIL}`]], 'the security verdict');
  assert.equal(written(result.log).some(([, description]) => String(description).includes(CODEX_RUN_HELD_DETAIL)), false, 'never the run hold');
  assert.deepEqual(markers, [['marker', 610, securityVerdictMarker(HEAD)]], 'the durable marker');
  neverArmsOrMerges(result.log, 'security');
});

// #1318 round 2 (Codex 4449402442) — the refusal is chosen over every current record, the named one verified live:
// security findings in another record outrank the run the event names
test('2A3b-2 (#1318 Codex 4449402442) — security findings in another record outrank the named run; an unlistable set judges the named record', { timeout: 30_000 }, async () => {
  const running = codexRecord(HEAD, 'in_progress');
  const findings = { ...securityFindingsWhileRunning(HEAD), id: 80 };
  const pulls = new Map([[610, pullAt(610, { auto_merge: queued })]]);
  const markers = [];
  const result = await runDisarm({
    number: 610, pulls, statuses: [tokenedSuccess()], event: events.record(610, running), comments: [running, findings],
    overrides: {
      async createIssueComment(n, body) { markers.push([n, body]); return { id: 903 }; },
      async reviews() { return []; },
      async reviewComments() { return []; },
    },
  });
  assert.equal(result.error, null);
  assert.equal(pulls.get(610).auto_merge, null, 'disarmed');
  assert.deepEqual(written(result.log).filter(([state]) => state === 'failure'), [['failure', `review: ${CODEX_SECURITY_FINDINGS_DETAIL}`]]);
  assert.deepEqual(markers, [[610, securityVerdictMarker(HEAD)]]);

  const listless = new Map([[610, pullAt(610, { auto_merge: queued })]]);
  const unlisted = await runDisarm({
    number: 610, pulls: listless, statuses: [tokenedSuccess()], event: events.record(610, running),
    overrides: { async issueComments() { throw new Error('GitHub GET comments failed (502)'); } },
  });
  assert.equal(unlisted.error, null);
  assert.deepEqual(written(unlisted.log), [['failure', `review: ${CODEX_RUN_HELD_DETAIL}`]], 'the named live record alone: held');
});

// #1318 round 2 (Codex 4449402449) — the exact-head orchestrator may publish a withholding ownership verdict after this
// run's opening read: the newest verdict is read again after the disarm, and kept
test('2A3b-2 (#1318 Codex 4449402449) — an ownership verdict that became newest during the run is kept: disarmed, nothing written', { timeout: 30_000 }, async () => {
  const withholding = { id: 6105, context: 'codex-current-head', state: 'failure', description: `${OWNERSHIP_CANDIDATE_HELD}` };
  const statuses = [tokenedSuccess()];
  const pulls = new Map([[610, pullAt(610, { auto_merge: queued })]]);
  const result = await runDisarm({
    number: 610, pulls, statuses, event: events.record(610, codexRecord(HEAD, 'in_progress')),
    overrides: {
      async disableAutoMerge(pull) { pulls.get(pull.number).auto_merge = null; statuses.unshift(withholding); },
    },
  });
  assert.equal(result.error, null);
  assert.equal(pulls.get(610).auto_merge, null, 'disarmed');
  assert.deepEqual(result.log.filter(([k]) => k === 'status' || k === 'draft' || k === 'sticky'), [], 'nothing written over the ownership verdict');

  // the re-read itself fails: the merge is already disarmed, so the retryable refusal is still written (fail closed)
  const failing = new Map([[611, pullAt(611, { auto_merge: queued })]]);
  const failingStatuses = [tokenedSuccess()];
  let disabled = false;
  let failedReads = 0;
  const unread = await runDisarm({
    number: 611, pulls: failing, statuses: failingStatuses, event: events.record(611, codexRecord(HEAD, 'in_progress')),
    overrides: {
      async disableAutoMerge(pull) { failing.get(pull.number).auto_merge = null; disabled = true; },
      // every read after the disable fails, so the re-read before the refusal is the one that fails
      async statuses() { if (disabled) { failedReads += 1; throw new Error('GitHub GET statuses failed (502)'); } return [...failingStatuses]; },
    },
  });
  assert.equal(unread.error, null, 'an unreadable re-read does not fail the run');
  assert.equal(failing.get(611).auto_merge, null, 'disarmed');
  assert.ok(failedReads >= 1, 'the statuses were read again after the disarm');
  assert.deepEqual(written(unread.log).map(([state]) => state), ['failure'], 'the retryable run hold is written');
});

// #1318 round 2 (Codex 4449402452) — a review that ran and completed with findings before this run read it leaves the
// record dirty with no run left to see. Written after the head's green: news that green never judged, so disarmed and
// re-judged. Written before it (the record the green judged; a cap-deferred head), or with no green newest: nothing
test('2A3b-2 C (#1318 Codex 4449402452) — a dirty record written after the green disarms and is re-judged; one the green was written after stays', { timeout: 30_000 }, async () => {
  const dirty = dirtyRecord(HEAD); // written 21:00
  for (const [name, event] of [['the run event, read after it completed', events.record(610, codexRecord(HEAD, 'in_progress'))], ['the completion event', events.record(610, dirty)]]) {
    const pulls = new Map([[610, pullAt(610, { auto_merge: queued })]]);
    const result = await runDisarm({ number: 610, pulls, statuses: [tokenedSuccess('2026-11-02T20:30:00Z')], event, comments: [dirty] });
    assert.equal(result.error, null, name);
    assert.equal(pulls.get(610).auto_merge, null, `${name}: disarmed`);
    assert.deepEqual(written(result.log), [['failure', 'review: Codex evidence changed during final verification']], `${name}: the retryable re-judge`);
    neverArmsOrMerges(result.log, name);
  }
  for (const [name, statuses] of [
    ['the green was written after it (the record it judged)', [tokenedSuccess('2026-11-02T21:30:00Z')]],
    ['no green newest', [{ id: 6106, context: 'codex-current-head', state: 'failure', description: 'review: 1 current-head Codex finding', created_at: '2026-11-02T20:30:00Z' }]],
  ]) {
    const pulls = new Map([[610, pullAt(610, { auto_merge: queued })]]);
    const result = await runDisarm({ number: 610, pulls, statuses, event: events.record(610, dirty), comments: [dirty] });
    assert.equal(result.error, null, name);
    assert.ok(pulls.get(610).auto_merge, `${name}: the merge stays queued`);
    assert.deepEqual(result.log.filter(([k]) => k === 'status' || k === 'disable'), [], `${name}: nothing written`);
  }
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

// #1318 Codex 4448897199 — the event judges the live record whole, with the one classifier the authorization uses
test('2A3b-2 — the record judgement: Codex\'s login, the marker, the live head, a run not completed, security findings first', () => {
  const judge = (comment, head = HEAD) => codexStateRecordVerdict(comment ? [comment] : [], head, 0);
  assert.equal(judge(codexRecord(HEAD, 'in_progress')), 'hold');
  assert.equal(judge(codexRecord(HEAD, 'queued')), 'hold');
  assert.notEqual(judge(codexRecord(HEAD, 'completed')), 'hold');
  assert.equal(judge(securityRecord(HEAD, 'in_progress')), 'hold', 'a security review running counts');
  assert.notEqual(judge(securityRecord(HEAD, 'completed')), 'hold');
  assert.equal(judge(securityRecord(OLD, 'in_progress')), 'none');
  assert.equal(judge(codexRecord(OLD, 'in_progress')), 'none');
  assert.equal(judge(codexRecord(HEAD, 'in_progress', 'chatgpt-codex-connector')), 'none', 'the REST login only');
  assert.equal(judge(null), 'none');
  assert.equal(judge(securityFindingsWhileRunning(HEAD)), 'security', 'security findings outrank a run still going');
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
  const reader = state.slice(state.indexOf('export function codexStateRecordVerdict'), state.indexOf('export function codexRecordFingerprint'));
  assert.match(reader, /if \(!isCodexActor\(comment\)\) continue;/u);
  // eventDisarm never arms and never writes a success
  const disarm = gate.slice(gate.indexOf('export async function eventDisarm'), gate.indexOf('\n}\n', gate.indexOf('export async function eventDisarm')));
  assert.doesNotMatch(disarm, /enableAutoMerge|completeReviewedPullRequest|publishSettledSuccess|publishDisarmedSuccess|completeCleanReview|setStatus\(|, 'success'/u);
  assert.equal([...disarm.matchAll(/'success'/gu)].length, 1, 'its one success is the newest green it reads, never one it writes');
  // the live record is judged by that reader, and the ownership predicate has its consumer, judged before any write
  assert.match(disarm, /codexStateRecordVerdict\(records, expectedHead, 0\)/u, 'every current record (#1318 Codex 4449402442)');
  assert.match(disarm, /const live = await liveCodexRecord\(client, pullRequest\.number, context\.comment\);\s*if \(!live\) return 'nothing';/u);
  // #1318 Codex 4449402449 — the newest verdict is read again after the disarm, before the refusal
  assert.ok(disarm.lastIndexOf('ownershipStatusWithholdsAutoMerge(') > disarm.indexOf('disarmBeforeRun(client, pullRequest, expectedHead, statuses, observed)', disarm.indexOf('const live'))
    && disarm.lastIndexOf('ownershipStatusWithholdsAutoMerge(') < disarm.lastIndexOf('refuseReviewedGreen('), 'ownership re-read between the disarm and the refusal');
  assert.match(disarm, /ownershipStatusWithholdsAutoMerge\(/u);
  assert.ok(disarm.indexOf('ownershipStatusWithholdsAutoMerge(') < Math.min(disarm.indexOf('refuseSharedCommit('), disarm.indexOf('refuseReviewedGreen(')),
    'the ownership verdict is judged before any event write (#1318 Codex 4448897194)');
  assert.doesNotMatch(gate, /deferred to (the )?2A3b|has NO consumer in this unit/u);
  // 2A3b-2 C (Stage 1's re-check of dc9d177a, gap A) — strict: a tie or an unreadable time counts as changed
  assert.match(disarm, /!\(codexRecordLatestMs\(records\) < green\)/u);
  // the push and arm keep the orchestrator's exact-head group, which the orchestrator itself names (auto-merge.yml)
  const automerge = await readFile(new URL('../.github/workflows/auto-merge.yml', import.meta.url), 'utf8');
  assert.match(automerge, /group: autonomous-review-owner-\$\{\{ github\.event\.workflow_run\.pull_requests\[0\]\.number [^\n]*\}\}-\$\{\{ github\.event\.workflow_run\.head_sha /u,
    'the orchestrator\'s exact-head group');
});

// Fold check of 190a20b4 (2) — the client method behind the live re-read: the scoped path, and a 404 from the real
// request() is the "gone" the reader treats as no record (null), so nothing is disarmed
test('2A3b-2 (fold 2) — issueComment reads this repository\'s comment by id; a real 404 makes the record gone', { timeout: 30_000 }, async () => {
  const client = new GitHubClient({ repository: 'JagPat/PMCvitan', token: 'test-token' });
  const calls = [];
  client.request = async (path, options = {}) => { calls.push([options.method ?? 'GET', path]); return { id: 77 }; };
  await client.issueComment(77);
  assert.deepEqual(calls, [['GET', '/repos/JagPat/PMCvitan/issues/comments/77']]);

  // through run(): the real issueComment and request(), over a fetch that answers 404 for the comment
  const savedFetch = globalThis.fetch;
  const fetched = [];
  globalThis.fetch = async (url, init = {}) => {
    fetched.push([init.method ?? 'GET', String(url)]);
    return new Response(JSON.stringify({ message: 'Not Found' }), { status: 404 });
  };
  try {
    const pulls = new Map([[12, pullAt(12, { auto_merge: queued })]]);
    const { log, error } = await runDisarm({
      number: 12, pulls, statuses: [tokenedSuccess()], event: events.record(12, codexRecord(HEAD, 'in_progress')),
      overrides: { request: realRequest, issueComment: realIssueComment },
    });
    assert.equal(error, null);
    assert.deepEqual(fetched, [['GET', 'https://api.github.com/repos/JagPat/PMCvitan/issues/comments/77']]);
    assert.equal(log.some(([k]) => k === 'disable' || k === 'status' || k === 'draft'), false, 'a gone record disarms and writes nothing');
  } finally {
    globalThis.fetch = savedFetch;
  }
});

// 2A3b-2 A (#1318 Codex 4448897194) — a withholding ownership verdict is judged FIRST, on a push or a person's arm: a
// queued merge is disarmed and nothing is written over the SHA-immutable verdict, whatever newer status of another
// context sits above it
test('2A3b-2 A — the ownership consumer: a queued merge under a withholding verdict is disarmed, nothing written', { timeout: 30_000 }, async () => {
  const withholding = { id: 6101, context: 'codex-current-head', state: 'failure', description: `${OWNERSHIP_CANDIDATE_HELD}` };
  const request = { id: 7002, context: 'codex-recovery-request/6101', state: 'pending', description: 'recovery: requested terminal status 6101' };
  const settlement = { id: 7003, context: 'codex-recovery-request/6000/pr-610', state: 'success', description: 'recovery: consumed by clean review' };
  for (const [name, statuses, event, siblings] of [
    ['a person\'s arm', [withholding], events.armed(610), false],
    ['a recovery request above the verdict, on an arm', [request, withholding], events.armed(610), false],
    ['a re-arm settlement above the verdict, on an arm', [settlement, withholding], events.armed(610), false],
    ['a push', [withholding], events.synchronize(610), false],
    ['a push onto a commit another open PR has queued', [withholding], events.synchronize(610), true],
    ['a person\'s arm on a commit another open PR has queued', [withholding], events.armed(610), true],
  ]) {
    const pulls = new Map([[610, pullAt(610, { auto_merge: queued })]]);
    if (siblings) pulls.set(611, pullAt(611, { auto_merge: queued }));
    const lines = [];
    const saved = console.log;
    console.log = (...args) => { lines.push(args.join(' ')); };
    let result;
    try {
      result = await runDisarm({ number: 610, pulls, statuses: [...statuses], event });
    } finally {
      console.log = saved;
    }
    assert.equal(result.error, null, name);
    // the outcome names what this run did: it disabled the queued merge itself
    assert.ok(lines.some((line) => /^Event disarm \([a-z-]+\): ownership disarmed\.$/u.test(line)), `${name}: ${lines.join(' | ')}`);
    assert.equal(pulls.get(610).auto_merge, null, `${name}: disarmed`);
    if (siblings) assert.equal(pulls.get(611).auto_merge, null, `${name}: the sibling at the commit disarmed too`);
    assert.deepEqual(result.log.filter(([k]) => k === 'status' || k === 'draft' || k === 'sticky'), [], `${name}: the withholding failure stays; nothing written over it`);
    neverArmsOrMerges(result.log, name);
  }
});

// With nothing queued the ownership branch still ends the event: a push or a person's arm on a commit another open PR
// has writes no shared-commit refusal over the withholding verdict
test('2A3b-2 A — the ownership consumer: nothing queued, a shared commit, on a push and on a person\'s arm, writes nothing', { timeout: 30_000 }, async () => {
  const withholding = { id: 6101, context: 'codex-current-head', state: 'failure', description: `${OWNERSHIP_CANDIDATE_HELD}` };
  for (const [name, event] of [['a push', events.synchronize(610)], ['a person\'s arm', events.armed(610)]]) {
    const pulls = new Map([[610, pullAt(610)], [611, pullAt(611)]]);
    const lines = [];
    const saved = console.log;
    console.log = (...args) => { lines.push(args.join(' ')); };
    let result;
    try {
      result = await runDisarm({ number: 610, pulls, statuses: [withholding], event });
    } finally {
      console.log = saved;
    }
    assert.equal(result.error, null, name);
    assert.deepEqual(result.log.filter(([k]) => k === 'disable' || k === 'status' || k === 'draft' || k === 'sticky'), [], `${name}: nothing written over the verdict`);
    assert.ok(lines.some((line) => /^Event disarm \([a-z-]+\): nothing\.$/u.test(line)), `${name}: ${lines.join(' | ')}`);
  }
});

test('2A3b-2 A — the ownership consumer: a non-withholding newest verdict, or a withholding one replaced since, is left alone', { timeout: 30_000 }, async () => {
  const withholding = { id: 6101, context: 'codex-current-head', state: 'failure', description: `${OWNERSHIP_CANDIDATE_HELD}` };
  const other = { id: 6102, context: 'codex-current-head', state: 'failure', description: 'review: 1 current-head Codex finding' };
  for (const [name, statuses] of [['a non-withholding failure', [other]], ['a withholding failure a later verdict replaced', [other, withholding]]]) {
    const pulls = new Map([[610, pullAt(610, { auto_merge: queued })]]);
    const result = await runDisarm({ number: 610, pulls, statuses, event: events.armed(610) });
    assert.equal(result.error, null, name);
    assert.ok(pulls.get(610).auto_merge, `${name}: a person's arm alone at its commit stays (Q1 = a)`);
    assert.deepEqual(result.log.filter(([k]) => k === 'disable' || k === 'status'), [], name);
  }
  // the gate's own arm is still ignored, whatever the newest verdict
  const own = new Map([[610, pullAt(610, { auto_merge: queued })]]);
  const gate = await runDisarm({ number: 610, pulls: own, statuses: [withholding], event: events.armed(610, 'github-actions[bot]') });
  assert.equal(gate.error, null);
  assert.ok(own.get(610).auto_merge, 'the gate\'s own arm');
  assert.deepEqual(gate.log.filter(([k]) => k === 'disable' || k === 'status'), []);
});

// 2A3b-2 A (#1318 Codex 4448897209) — two runs can disable one queued merge; GitHub refuses the second. The re-read
// decides: a merge no longer queued is disarmed, whoever disabled it; one still queued is the retryable disarm hold
test('2A3b-2 A — a disable another run already did is disarmed; a refused disable still queued takes the disarm hold', { timeout: 30_000 }, async () => {
  // a push: counted as this run's disarm, so the PR's consumed re-arm settlement is lifted (Stage 1's split check, A-M1)
  const settlement = { id: 7003, context: 'codex-recovery-request/6000/pr-610', state: 'success', description: REARM_SETTLEMENTS[0] };
  const raced = new Map([[610, pullAt(610, { auto_merge: queued })]]);
  const done = await runDisarm({
    number: 610, pulls: raced, statuses: [settlement, tokenedSuccess()], event: events.synchronize(610),
    overrides: { async disableAutoMerge(pull) { raced.get(pull.number).auto_merge = null; throw new Error('GraphQL: Auto merge is not enabled for this pull request.'); } },
  });
  assert.equal(done.error, null);
  assert.equal(raced.get(610).auto_merge, null);
  assert.deepEqual(written(done.log), [], 'disarmed, not a disarm failure');
  assert.deepEqual(done.log.filter(([k, , , context]) => k === 'status' && context === settlement.context), [['status', 'failure', REARM_ATTEMPT_FAILED, settlement.context]], 'the consumed settlement is lifted');

  // under a withholding ownership verdict: the raced disable counts, so the outcome names the disarm
  const withholding = { id: 6101, context: 'codex-current-head', state: 'failure', description: `${OWNERSHIP_CANDIDATE_HELD}` };
  const owned = new Map([[610, pullAt(610, { auto_merge: queued })]]);
  const lines = [];
  const saved = console.log;
  console.log = (...args) => { lines.push(args.join(' ')); };
  let ownedResult;
  try {
    ownedResult = await runDisarm({
      number: 610, pulls: owned, statuses: [withholding], event: events.armed(610),
      overrides: { async disableAutoMerge(pull) { owned.get(pull.number).auto_merge = null; throw new Error('GraphQL: Auto merge is not enabled for this pull request.'); } },
    });
  } finally {
    console.log = saved;
  }
  assert.equal(ownedResult.error, null);
  assert.ok(lines.some((line) => /^Event disarm \([a-z-]+\): ownership disarmed\.$/u.test(line)), lines.join(' | '));
  assert.deepEqual(ownedResult.log.filter(([k]) => k === 'status' || k === 'draft' || k === 'sticky'), []);

  const stuck = new Map([[610, pullAt(610, { auto_merge: queued })]]);
  const failed = await runDisarm({
    number: 610, pulls: stuck, statuses: [tokenedSuccess()], event: events.synchronize(610),
    overrides: { async disableAutoMerge() { throw new Error('GitHub GraphQL failed (502)'); } },
  });
  assert.deepEqual(written(failed.log), [['failure', `review: ${CODEX_AUTOMERGE_DISARM_FAILED}`]], 'still queued: the retryable disarm hold');
});

// 2A3b-2 C (Stage 1's re-check of dc9d177a, gaps A and C) — strict: a dirty set written in the same second as the green,
// or whose time cannot be read, counts as changed; the latest time is taken over EVERY record, so a clean named record
// beside another record that went dirty after the green still disarms
test('2A3b-2 C — dirty-after-green is strict and spans every record: a tie, an unreadable time, another record\'s write', { timeout: 30_000 }, async () => {
  const other = { ...dirtyRecord(HEAD), id: 81, updated_at: '2026-11-02T21:45:00Z' };
  for (const [name, event, comments, green] of [
    ['a dirty record in the same second as the green', events.record(610, dirtyRecord(HEAD)), [dirtyRecord(HEAD)], '2026-11-02T21:00:00Z'],
    ['a dirty record whose update time cannot be read', events.record(610, { ...dirtyRecord(HEAD), updated_at: 'not a time' }), [{ ...dirtyRecord(HEAD), updated_at: 'not a time' }], '2026-11-02T21:30:00Z'],
    ['the named record clean and older, another record dirty after the green', events.record(610, cleanRecord(HEAD)), [cleanRecord(HEAD), other], '2026-11-02T21:30:00Z'],
    ['the named record on an older head, another record dirty after the green', events.record(610, codexRecord(OLD, 'completed')), [codexRecord(OLD, 'completed'), other], '2026-11-02T21:30:00Z'],
  ]) {
    const pulls = new Map([[610, pullAt(610, { auto_merge: queued })]]);
    const result = await runDisarm({ number: 610, pulls, statuses: [tokenedSuccess(green)], event, comments });
    assert.equal(result.error, null, name);
    assert.equal(pulls.get(610).auto_merge, null, `${name}: disarmed`);
    assert.deepEqual(written(result.log), [['failure', 'review: Codex evidence changed during final verification']], `${name}: the retryable re-judge`);
    neverArmsOrMerges(result.log, name);
  }
  // one second earlier than the green is the record the green was written after: nothing
  const pulls = new Map([[610, pullAt(610, { auto_merge: queued })]]);
  const kept = await runDisarm({ number: 610, pulls, statuses: [tokenedSuccess('2026-11-02T21:00:01Z')], event: events.record(610, dirtyRecord(HEAD)), comments: [dirtyRecord(HEAD)] });
  assert.equal(kept.error, null);
  assert.ok(pulls.get(610).auto_merge, 'the merge stays queued');
  assert.deepEqual(kept.log.filter(([k]) => k === 'status' || k === 'disable'), []);
});

test('2A3b-2 C — codexRecordLatestMs: Codex\'s records only; none is -Infinity; an unreadable time is NaN', () => {
  const late = { ...dirtyRecord(HEAD), id: 81, updated_at: '2026-11-02T22:00:00Z' };
  assert.equal(codexRecordLatestMs([dirtyRecord(HEAD), late]), Date.parse('2026-11-02T22:00:00Z'));
  assert.equal(codexRecordLatestMs([{ ...late, user: { login: 'someone' } }]), -Infinity, 'another login with the marker');
  assert.equal(codexRecordLatestMs([{ id: 5, user: { login: 'chatgpt-codex-connector[bot]' }, body: 'note', updated_at: '2026-11-02T23:00:00Z' }]), -Infinity, 'Codex without the marker');
  assert.ok(Number.isNaN(codexRecordLatestMs([late, { ...dirtyRecord(HEAD), updated_at: 'x' }])), 'one unreadable time makes it unreadable');
  assert.equal(codexRecordLatestMs([{ ...dirtyRecord(HEAD), updated_at: undefined, created_at: '2026-11-02T20:00:00Z' }]), Date.parse('2026-11-02T20:00:00Z'), 'created when never updated');
  assert.equal(codexRecordLatestMs(null), -Infinity);
});

// 2A3b-2 C (#1318 Codex 4448897194, the event half) — the ownership verdict is judged first on a Codex record event
// too: a run, security findings or a completed record on the head writes nothing over it, and its queued merge is disarmed
test('2A3b-2 C — the ownership consumer on a Codex record event: disarmed, nothing written over the verdict', { timeout: 30_000 }, async () => {
  const withholding = { id: 6101, context: 'codex-current-head', state: 'failure', description: `${OWNERSHIP_CANDIDATE_HELD}` };
  for (const [name, record] of [
    ['a Codex run on the head', codexRecord(HEAD, 'in_progress')],
    ['security findings on the head', securityFindingsWhileRunning(HEAD)],
    ['a Codex record not running', codexRecord(HEAD, 'completed')],
  ]) {
    const pulls = new Map([[610, pullAt(610, { auto_merge: queued })]]);
    const result = await runDisarm({ number: 610, pulls, statuses: [withholding], event: events.record(610, record) });
    assert.equal(result.error, null, name);
    assert.equal(pulls.get(610).auto_merge, null, `${name}: disarmed`);
    assert.deepEqual(result.log.filter(([k]) => k === 'status' || k === 'draft' || k === 'sticky' || k === 'marker'), [], `${name}: nothing written over the verdict`);
  }
});
