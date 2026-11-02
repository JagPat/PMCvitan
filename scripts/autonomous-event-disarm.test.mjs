import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GitHubClient, contextForEvent, run } from './autonomous-review-gate.mjs';
import {
  CODEX_SHARED_COMMIT_DETAIL, CODEX_AUTOMERGE_DISARM_FAILED,
} from './review-policy.mjs';

/**
 * 2A3b-1 (notes/gate-codex-silent/2a3/2a3b-design.md; Stage 1's rulings of 2 Nov) — the event-driven disarm for W1. On
 * the event that invalidates a queued merge (a push, an arm on a shared commit) the gate disarms within seconds, from
 * trusted default-branch code, and never arms or writes a success.
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
const events = {
  synchronize: (number, head = HEAD) => ['pull_request_target', { action: 'synchronize', pull_request: { number, head: { sha: head } } }],
  armed: (number, login = 'a-person', head = HEAD) => ['pull_request_target', {
    action: 'auto_merge_enabled', sender: { login }, pull_request: { number, head: { sha: head }, auto_merge: { enabled_by: { login } } },
  }],
};

/** `run()` in the event-disarm mode, with every GitHubClient method replaced by a recorder (the 2A3a harness). */
async function runDisarm({ number, pulls, statuses, event, overrides = {}, mode = 'event-disarm' }) {
  const log = [];
  let nextId = 6200;
  const stubs = {
    async pullRequest(n) { log.push(['read', n]); const found = pulls.get(n); return found ? { ...found } : null; },
    async openPullRequestsAt(sha) { log.push(['list']); return [...pulls.values()].filter((p) => p.state === 'open' && p.head.sha === sha).map((p) => ({ ...p })); },
    async statuses() { return [...statuses]; },
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

test('2A3b-1 — the two event contexts, and none for other events', () => {
  assert.deepEqual(contextForEvent(...events.synchronize(610)),
    { number: 610, expectedHead: HEAD, ciConclusion: null, trigger: 'synchronize', enabledBy: null });
  assert.equal(contextForEvent(...events.armed(610)).trigger, 'auto-merge-enabled');
  assert.equal(contextForEvent(...events.armed(610)).enabledBy, 'a-person');
  assert.equal(contextForEvent('pull_request_target', { action: 'labeled', pull_request: { number: 610 } }), null);
  assert.equal(contextForEvent('issue_comment', { action: 'edited', issue: { number: 610, pull_request: {} }, comment: {} }), null, 'Codex records are 2A3b-2\'s');
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

test('2A3b-1 — structural: the workflow runs trusted default-branch code on its two events, in the exact-head group', async () => {
  const workflow = await readFile(new URL('../.github/workflows/event-disarm.yml', import.meta.url), 'utf8');
  const gate = await readFile(new URL('./autonomous-review-gate.mjs', import.meta.url), 'utf8');
  assert.match(workflow, /pull_request_target:\s*\n\s*types: \[synchronize, auto_merge_enabled\]/u);
  assert.doesNotMatch(workflow, /^\s*(push|pull_request|workflow_run|schedule|workflow_dispatch|issue_comment):/mu);
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
  assert.match(workflow, /group: autonomous-review-owner-\$\{\{ github\.event\.pull_request\.number \}\}-\$\{\{ github\.event\.pull_request\.head\.sha \}\}\n/u,
    'a push or an arm shares the controller\'s exact-head group');
  assert.match(workflow, /cancel-in-progress:\s*false/u);
  // eventDisarm never arms and never writes a success
  const disarm = gate.slice(gate.indexOf('export async function eventDisarm'), gate.indexOf('\n}\n', gate.indexOf('export async function eventDisarm')));
  assert.doesNotMatch(disarm, /enableAutoMerge|completeReviewedPullRequest|publishSettledSuccess|publishDisarmedSuccess|completeCleanReview|'success'/u);
  // 2A3b-2 adds the Codex-record trigger and the ownership consumer
  assert.doesNotMatch(disarm, /publishRetryableHold|ownershipStatusWithholdsAutoMerge/u);
});
