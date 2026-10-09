// Owner decision 2026-10-08 (delivery speed), maintenance unit M2a: completion reports, review rounds and the
// main-CI sweep.
import test from 'node:test';
import assert from 'node:assert/strict';

import { findingRoundHeads } from './review-cap.mjs';
import { alreadyReported, completionReport, COMPLETION_REPORTED_LABEL, mainNeedsCi, reviewRounds, sweep, SWEEP_WINDOW_MS } from './completion-report.mjs';

const CODEX = 'chatgpt-codex-connector[bot]';
const HEAD = 'c'.repeat(40);

function finding({ head = HEAD, p = 1, path = 'apps/web/src/a.ts', line = 2, id = 1 } = {}) {
  return {
    id,
    user: { login: CODEX },
    commit_id: head,
    original_commit_id: head,
    path,
    line,
    body: p === null ? '**Unbadged**' : `**![P${p} Badge](https://img.shields.io/badge/P${p}-x)  Title ${id}**`,
    html_url: `https://github.com/o/r/pull/9#discussion_r${id}`,
  };
}

test('the completion report carries hours to the real merge, rounds and changed lines', () => {
  const report = completionReport(
    { created_at: '2026-10-08T00:00:00Z', merged_at: '2026-10-08T03:30:00Z', additions: 120, deletions: 30, changed_files: 4 },
    { rounds: 2 },
  );
  assert.match(report, /^<!-- completion-report -->/u);
  assert.match(report, /open to merge: 3\.5/u);
  assert.match(report, /review rounds: 2/u);
  assert.match(report, /Changed lines: 150 \(\+120 \/ −30\) across 4 files/u);
});

test('review rounds: every finding head plus the clean merged head; a trivial-lane head had none', () => {
  const comments = [finding({ head: 'a'.repeat(40) }), finding({ head: 'b'.repeat(40) })];
  assert.equal(reviewRounds({ head: { sha: HEAD } }, { comments }), 3);
  assert.equal(reviewRounds({ head: { sha: 'b'.repeat(40) } }, { comments }), 2);
  assert.equal(reviewRounds({ head: { sha: HEAD } }, { trivial: true }), 0);
});

test('Codex 4214270298 — a Codex REPLY in an older thread is not a review round', () => {
  const reply = { ...finding({ head: 'a'.repeat(40), id: 9 }), in_reply_to_id: 1 };
  const opener = finding({ head: 'b'.repeat(40), id: 10 });
  assert.deepEqual([...findingRoundHeads([reply, opener])], ['b'.repeat(40)]);
});

test('Codex 4214321803 — the completion-report workflow may read commit statuses', async () => {
  const { readFile } = await import('node:fs/promises');
  const workflow = await readFile(new URL('../.github/workflows/completion-report.yml', import.meta.url), 'utf8');
  assert.match(workflow, /\n {2}statuses: read\n/u);
});

test('Codex 4214359522 — a blank reply-only Codex review is no round: its reply is kept as the evidence', () => {
  const older = 'a'.repeat(40);
  const later = 'd'.repeat(40);
  // a human opened a thread on an older head; Codex replied there while reviewing a later head
  const root = { id: 50, user: { login: 'someone' }, commit_id: older, original_commit_id: older, path: 'x', line: 1 };
  const reply = { id: 51, user: { login: CODEX }, in_reply_to_id: 50, pull_request_review_id: 900, commit_id: older, original_commit_id: older, path: 'x', line: 1, body: 'reply' };
  const replyOnly = { id: 900, user: { login: CODEX }, state: 'COMMENTED', body: '', commit_id: later };
  const genuine = finding({ head: 'b'.repeat(40), id: 52 });
  assert.deepEqual(findingRoundHeads([root, reply, genuine], [replyOnly]), ['b'.repeat(40)]);
});

test('Codex 4214389907 — only the workflow\'s own report suppresses a second one; a pasted marker does not', () => {
  const report = completionReport({ created_at: '2026-10-08T00:00:00Z', merged_at: '2026-10-08T01:00:00Z' }, { rounds: 1 });
  const actions = { login: 'github-actions[bot]', type: 'Bot' };
  assert.equal(alreadyReported([{ user: actions, body: report }]), true);
  assert.equal(alreadyReported([{ user: { login: 'someone', type: 'User' }, body: report }]), false);
  assert.equal(alreadyReported([{ user: { login: 'github-actions[bot]', type: 'User' }, body: report }]), false);
  assert.equal(alreadyReported([{ user: actions, body: '<!-- completion-report --> copied diagnostic' }]), false);
  assert.equal(alreadyReported([]), false);
});

test('Codex 4220431609 — the sweep reports token-made merges and dispatches main CI when main has none', async () => {
  const now = Date.parse('2026-10-08T12:00:00Z');
  const reportBody = '<!-- completion-report -->\n**Completion report**\n- x';
  const pr = (number, mergedAt, extra = {}) => ({ number, merged_at: mergedAt, created_at: '2026-10-08T10:00:00Z', head: { sha: `h${number}` }, additions: 1, deletions: 0, ...extra });
  const prs = { 1: pr(1, '2026-10-08T11:00:00Z'), 2: pr(2, '2026-10-08T11:30:00Z'), 3: pr(3, new Date(now - SWEEP_WINDOW_MS - 1).toISOString()), 4: pr(4, null) };
  const posted = [];
  const dispatched = [];
  const json = (body) => ({ ok: true, json: async () => body });
  const fetchFor = (mainRuns) => async (url, init = {}) => {
    const u = String(url);
    if (init.method === 'POST' && u.endsWith('/comments')) { posted.push(Number(/issues\/(\d+)\//u.exec(u)[1])); return json({}); }
    if (init.method === 'POST' && u.endsWith('/dispatches')) { dispatched.push(JSON.parse(init.body).ref); return { ok: true, json: async () => ({}) }; }
    if (u.includes('/pulls?state=closed')) return json(Object.values(prs));
    let m = /\/pulls\/(\d+)$/u.exec(u);
    if (m) return json(prs[m[1]]);
    m = /\/issues\/(\d+)\/comments/u.exec(u);
    if (m) return json(m[1] === '2' ? [{ user: { login: 'github-actions[bot]', type: 'Bot' }, body: reportBody }] : []);
    if (u.includes('/commits/main')) return json({ sha: 'mainsha' });
    if (u.includes('/actions/workflows/ci.yml/runs')) return json({ total_count: mainRuns, workflow_runs: Array.from({ length: mainRuns }, () => ({ status: 'completed', conclusion: 'success' })) });
    return json([]);
  };
  const first = await sweep({ repository: 'o/r', token: 't', fetchImpl: fetchFor(0), now });
  // PR 1 is reported; 2 already was, 3 merged before the window, 4 never merged
  assert.deepEqual(first.reported, [1]);
  assert.deepEqual(posted, [1]);
  assert.equal(first.dispatched, true);
  assert.deepEqual(dispatched, ['main']);
  // main's head already has a CI run: nothing is dispatched
  const second = await sweep({ repository: 'o/r', token: 't', fetchImpl: fetchFor(1), now });
  assert.equal(second.dispatched, false);
  assert.deepEqual(dispatched, ['main']);
});

test('Codex 4220431609 — the report workflow sweeps after every controller run and hourly, and may dispatch CI', async () => {
  const { readFile } = await import('node:fs/promises');
  const workflow = await readFile(new URL('../.github/workflows/completion-report.yml', import.meta.url), 'utf8');
  assert.match(workflow, /workflow_run:\n\s+workflows: \[Autonomous review and merge\]/u);
  assert.match(workflow, /schedule:/u);
  assert.match(workflow, /actions: write/u);
  const gate = await readFile(new URL('../.github/workflows/auto-merge.yml', import.meta.url), 'utf8');
  assert.match(gate, /^name: Autonomous review and merge$/mu, 'the workflow_run trigger names the controller exactly');
});

test('Codex 4220621326 — every completion-report writer shares one concurrency group', async () => {
  const { readFile } = await import('node:fs/promises');
  const workflow = await readFile(new URL('../.github/workflows/completion-report.yml', import.meta.url), 'utf8');
  assert.match(workflow, /concurrency:\n(?:#.*\n)*\s+group: completion-report\n/u);
  assert.doesNotMatch(workflow, /group: .*\$\{\{/u, 'the group is not split by event');
});

test('Codex 4220621322 — the sweep pages until the window is exhausted', async () => {
  const now = Date.parse('2026-10-08T12:00:00Z');
  const recent = '2026-10-08T11:00:00Z';
  const old = '2026-10-01T00:00:00Z';
  const pages = {
    1: Array.from({ length: 100 }, (_, i) => ({ number: 1000 + i, merged_at: null, updated_at: recent })),
    2: [{ number: 5, merged_at: recent, updated_at: recent }, { number: 6, merged_at: old, updated_at: old }],
    3: [{ number: 7, merged_at: recent, updated_at: recent }],
  };
  const read = [];
  const json = (body) => ({ ok: true, json: async () => body });
  const fetchImpl = async (url, init = {}) => {
    const u = String(url);
    if (init.method === 'POST') return json({});
    const page = /pulls\?state=closed.*page=(\d+)/u.exec(u);
    if (page) { read.push(Number(page[1])); return json(pages[page[1]] ?? []); }
    if (/\/pulls\/5$/u.test(u)) return json({ number: 5, merged_at: recent, created_at: recent, head: { sha: 'h5' } });
    if (u.includes('/commits/main')) return json({ sha: 'm' });
    if (u.includes('/actions/workflows/ci.yml/runs')) return json({ total_count: 1, workflow_runs: [{ status: 'in_progress', conclusion: null }] });
    return json([]);
  };
  const result = await sweep({ repository: 'o/r', token: 't', fetchImpl, now });
  // page 2 holds the merge page 1 crowded out; page 2 reaches past the window, so page 3 is never read
  assert.deepEqual(read, [1, 2]);
  assert.deepEqual(result.reported, [5]);
});

test('Codex 4220739652 — main CI is re-dispatched only when no run executed the battery', () => {
  assert.equal(mainNeedsCi([]), true);
  assert.equal(mainNeedsCi([{ status: 'completed', conclusion: 'cancelled' }]), true);
  assert.equal(mainNeedsCi([{ status: 'completed', conclusion: 'startup_failure' }, { status: 'completed', conclusion: 'skipped' }]), true);
  // active, green, or a genuine red: no dispatch (a red main is for a person, not an hourly re-run)
  assert.equal(mainNeedsCi([{ status: 'in_progress', conclusion: null }]), false);
  assert.equal(mainNeedsCi([{ status: 'queued', conclusion: null }]), false);
  assert.equal(mainNeedsCi([{ status: 'completed', conclusion: 'cancelled' }, { status: 'completed', conclusion: 'success' }]), false);
  assert.equal(mainNeedsCi([{ status: 'completed', conclusion: 'failure' }]), false);
});

test('Codex 4220739661 — a manual sweep may widen the window to recover an outage', async () => {
  const now = Date.parse('2026-10-08T12:00:00Z');
  const tenDaysAgo = new Date(now - 10 * 24 * 3_600_000).toISOString();
  const json = (body) => ({ ok: true, json: async () => body });
  const posted = [];
  const fetchImpl = async (url, init = {}) => {
    const u = String(url);
    if (init.method === 'POST' && u.endsWith('/comments')) { posted.push(u); return json({}); }
    if (u.includes('/pulls?state=closed')) return json([{ number: 3, merged_at: tenDaysAgo, updated_at: tenDaysAgo }]);
    if (/\/pulls\/3$/u.test(u)) return json({ number: 3, merged_at: tenDaysAgo, created_at: tenDaysAgo, head: { sha: 'h3' } });
    if (u.includes('/commits/main')) return json({ sha: 'm' });
    if (u.includes('/actions/workflows/ci.yml/runs')) return json({ workflow_runs: [{ status: 'completed', conclusion: 'success' }] });
    return json([]);
  };
  assert.deepEqual((await sweep({ repository: 'o/r', token: 't', fetchImpl, now })).reported, []);
  assert.deepEqual((await sweep({ repository: 'o/r', token: 't', fetchImpl, now, windowMs: 11 * 24 * 3_600_000 })).reported, [3]);
  const { readFile } = await import('node:fs/promises');
  const workflow = await readFile(new URL('../.github/workflows/completion-report.yml', import.meta.url), 'utf8');
  assert.match(workflow, /window_hours:/u);
  assert.match(workflow, /SWEEP_WINDOW_HOURS: \$\{\{ github\.event\.inputs\.window_hours \}\}/u);
});

test('Codex 4220861370 — a blank Codex review container that opens no thread is no review round', () => {
  const blank = (id, head) => ({ id, user: { login: CODEX }, commit_id: head, body: '', state: 'COMMENTED' });
  const a = 'a'.repeat(40);
  const b = 'b'.repeat(40);
  // two empty containers on two heads: no rounds
  assert.deepEqual(findingRoundHeads([], [blank(1, a), blank(2, b)]), []);
  // a blank container that owns a thread-opening comment, or a review with a body, still counts
  const opener = { ...finding({ head: a, id: 3 }), pull_request_review_id: 1 };
  assert.deepEqual(findingRoundHeads([opener], [blank(1, a)]), [a]);
  assert.deepEqual(findingRoundHeads([], [{ ...blank(2, b), body: '**Review-level finding**' }]), [b]);
});

test('Codex 4221120387 — a reported PR is labelled, and later sweeps skip it without re-reading it', async () => {
  const now = Date.parse('2026-10-08T12:00:00Z');
  const reportBody = '<!-- completion-report -->\n**Completion report**\n- x';
  const reported = { name: COMPLETION_REPORTED_LABEL };
  const pr = (number, labels = []) => ({ number, labels, merged_at: '2026-10-08T11:00:00Z', created_at: '2026-10-08T10:00:00Z', head: { sha: `h${number}` }, additions: 1, deletions: 0 });
  // 1 is new; 2 was reported before the label existed; 3..52 are already labelled
  const prs = [pr(1), pr(2), ...Array.from({ length: 50 }, (_, i) => pr(i + 3, [reported]))];
  const requests = [];
  const labelled = [];
  let labelExists = false;
  const json = (body, status = 200) => ({ ok: status < 300, status, json: async () => body });
  const fetchImpl = async (url, init = {}) => {
    const u = String(url);
    requests.push(`${init.method ?? 'GET'} ${u}`);
    if (init.method === 'POST' && u.endsWith('/labels') && u.includes('/issues/')) {
      labelled.push(Number(/issues\/(\d+)\//u.exec(u)[1]));
      return json([]);
    }
    if (init.method === 'POST' && u.endsWith('/labels')) { labelExists = true; return json({}, 201); }
    if (u.endsWith(`/labels/${COMPLETION_REPORTED_LABEL}`)) return labelExists ? json({}) : json({}, 404);
    if (init.method === 'POST') return json({});
    if (u.includes('/pulls?state=closed')) return json(prs);
    let m = /\/pulls\/(\d+)$/u.exec(u);
    if (m) return json(prs[Number(m[1]) - 1]);
    m = /\/issues\/(\d+)\/comments/u.exec(u);
    if (m) return json(m[1] === '2' ? [{ user: { login: 'github-actions[bot]', type: 'Bot' }, body: reportBody }] : []);
    if (u.includes('/commits/main')) return json({ sha: 'mainsha' });
    if (u.includes('/actions/workflows/ci.yml/runs')) return json({ workflow_runs: [{ status: 'completed', conclusion: 'success' }] });
    return json([]);
  };
  const result = await sweep({ repository: 'o/r', token: 't', fetchImpl, now });
  assert.deepEqual(result.reported, [1]);
  // the new report and the pre-label report both get the label; the label is created once
  assert.deepEqual(labelled, [1, 2]);
  assert.equal(requests.filter((r) => r === 'POST https://api.github.com/repos/o/r/labels').length, 1);
  // the fifty labelled PRs cost nothing beyond the list itself
  for (let n = 3; n <= 52; n += 1) assert.ok(!requests.some((r) => r.includes(`/pulls/${n}`) || r.includes(`/issues/${n}/`)), `#${n} is not re-read`);
});
