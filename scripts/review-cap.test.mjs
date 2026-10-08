// Owner decision 2026-10-08 (delivery speed), maintenance unit M2: the review-round cap, the changed-line
// review scope and the completion report.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  blocksUnderCap,
  changedLinesFromFiles,
  findingPriority,
  findingRoundHeads,
  onChangedLine,
  reviewCapState,
  GITHUB_PR_FILES_LIMIT,
} from './review-cap.mjs';
import { classifyCodexState } from './autonomous-review-state.mjs';
import { capFiles, cappedSuccessDetail, fileDeferredFindings, readCodexEvidence, settleFinalCodexEvidence, unionDeferred } from './autonomous-review-gate.mjs';
import { alreadyReported, completionReport, mainNeedsCi, reviewRounds, sweep, SWEEP_WINDOW_MS } from './completion-report.mjs';
import { REVIEW_FOLLOW_UP_LABEL, REVIEW_ROUND_CAP } from './review-policy.mjs';

const CODEX = 'chatgpt-codex-connector[bot]';
const HEAD = 'c'.repeat(40);
const FILES = [
  { filename: 'apps/web/src/a.ts', patch: '@@ -1,2 +1,3 @@\n a\n+b\n-x\n c\n@@ -10,1 +11,2 @@\n k\n+l' },
  { filename: 'image.png' },
];

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

test('findingPriority reads both badge forms and returns null without one', () => {
  assert.equal(findingPriority('![P2 Badge](x)'), 2);
  assert.equal(findingPriority('https://img.shields.io/badge/P1-orange'), 1);
  assert.equal(findingPriority('no badge'), null);
});

test('changedLinesFromFiles maps new-side added lines per hunk; a patchless file is wholly changed', () => {
  const lines = changedLinesFromFiles(FILES);
  assert.deepEqual([...lines.get('apps/web/src/a.ts').right], [2, 12]);
  assert.deepEqual([...lines.get('apps/web/src/a.ts').left], [2]);
  assert.deepEqual(lines.get('image.png'), { right: '*', left: '*' });
});

test('onChangedLine honours multi-line anchors and unknown files', () => {
  const lines = changedLinesFromFiles(FILES);
  assert.equal(onChangedLine({ path: 'apps/web/src/a.ts', line: 3 }, lines), false);
  assert.equal(onChangedLine({ path: 'apps/web/src/a.ts', start_line: 1, line: 3 }, lines), true);
  assert.equal(onChangedLine({ path: 'other.ts', line: 2 }, lines), false);
  assert.equal(onChangedLine({ path: 'image.png', line: 99 }, lines), true);
});

test('Codex 4213960366 — a finding on the LEFT side of a deletion is judged against the deleted lines', () => {
  const lines = changedLinesFromFiles(FILES);
  // old line 2 (`x`) was deleted; new line 2 is the added `b`, new line 3 is unchanged `c`
  assert.equal(onChangedLine({ path: 'apps/web/src/a.ts', line: 2, side: 'LEFT' }, lines), true);
  assert.equal(onChangedLine({ path: 'apps/web/src/a.ts', line: 3, side: 'LEFT' }, lines), false);
  assert.equal(blocksUnderCap({ ...finding({ p: 1 }), line: 2, side: 'LEFT' }, lines), true);
});

test('blocksUnderCap: only P0/P1 (or unbadged) on a changed line', () => {
  const lines = changedLinesFromFiles(FILES);
  assert.equal(blocksUnderCap(finding({ p: 1 }), lines), true);
  assert.equal(blocksUnderCap(finding({ p: 0 }), lines), true);
  assert.equal(blocksUnderCap(finding({ p: null }), lines), true);
  assert.equal(blocksUnderCap(finding({ p: 2 }), lines), false);
  assert.equal(blocksUnderCap(finding({ p: 1, line: 5 }), lines), false);
});

test('reviewCapState counts earlier finding heads only', () => {
  const comments = [finding({ head: 'a'.repeat(40) }), finding({ head: 'b'.repeat(40) }), finding({ head: HEAD })];
  assert.equal(reviewCapState({ expectedHead: HEAD, comments: comments.slice(0, 1), files: FILES }).reached, false);
  const state = reviewCapState({ expectedHead: HEAD, comments, files: FILES });
  assert.equal(state.priorRounds, REVIEW_ROUND_CAP);
  assert.equal(state.reached, true);
});

function classify(comments, cap) {
  const readyAt = '2026-10-08T00:00:00Z';
  return classifyCodexState({
    expectedHead: HEAD,
    readyAt,
    deadline: '2026-10-08T01:00:00Z',
    now: '2026-10-08T00:01:00Z',
    comments,
    reviews: [{ user: { login: CODEX }, commit_id: HEAD, state: 'COMMENTED', body: '', submitted_at: '2026-10-08T00:00:30Z' }],
    cap,
  });
}

test('before the cap a P2 still blocks', () => {
  const result = classify([finding({ p: 2 })], { reached: false, changedLines: changedLinesFromFiles(FILES) });
  assert.equal(result.state, 'changes_required');
});

test('past the cap a P2 or an off-diff P1 is deferred and the head clears', () => {
  const comments = [finding({ p: 2, id: 1 }), finding({ p: 1, line: 5, id: 2 })];
  const result = classify(comments, { reached: true, changedLines: changedLinesFromFiles(FILES) });
  assert.equal(result.state, 'clear');
  assert.equal(result.deferred.length, 2);
});

test('past the cap a P1 on a changed line still blocks', () => {
  const comments = [finding({ p: 2, id: 1 }), finding({ p: 1, id: 2 })];
  const result = classify(comments, { reached: true, changedLines: changedLinesFromFiles(FILES) });
  assert.equal(result.state, 'changes_required');
  assert.match(result.detail, /1 blocking/u);
});

test('deferred findings are filed once per head, idempotently', async () => {
  const created = [];
  const client = {
    async issuesLabelled(label) {
      assert.equal(label, REVIEW_FOLLOW_UP_LABEL);
      return created;
    },
    async createIssue(issue) {
      const made = { ...issue, number: 900 + created.length };
      created.push(made);
      return made;
    },
  };
  const pr = { number: 9 };
  const deferred = [finding({ p: 2 })];
  assert.equal(await fileDeferredFindings(client, pr, HEAD, deferred), 900);
  assert.equal(await fileDeferredFindings(client, pr, HEAD, deferred), 900);
  assert.equal(created.length, 1);
  assert.match(created[0].body, /P2 `apps\/web\/src\/a\.ts:2` — Title 1/u);
  assert.deepEqual(created[0].labels, [REVIEW_FOLLOW_UP_LABEL]);
});

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
  const state = reviewCapState({ expectedHead: HEAD, comments: [reply, opener], files: FILES });
  assert.equal(state.priorRounds, 1);
  assert.equal(state.reached, false);
  assert.deepEqual([...findingRoundHeads([reply, opener])], ['b'.repeat(40)]);
});

test('Codex 4214270293 — deferred findings from the poll and the final re-read are filed once each', () => {
  const a = finding({ id: 1 });
  const b = finding({ id: 2 });
  assert.deepEqual(unionDeferred([a], [a, b]).map((f) => f.id), [1, 2]);
});

test('Codex 4214270288 — an UNBADGED review-level finding past the cap is deferred too', () => {
  const result = classifyCodexState({
    expectedHead: HEAD,
    readyAt: '2026-10-08T00:00:00Z',
    deadline: '2026-10-08T01:00:00Z',
    now: '2026-10-08T00:01:00Z',
    comments: [],
    reviews: [{ id: 78, user: { login: CODEX }, commit_id: HEAD, state: 'COMMENTED', body: 'The retry path drops the lease.', submitted_at: '2026-10-08T00:00:30Z' }],
    cap: { reached: true, changedLines: changedLinesFromFiles(FILES) },
  });
  assert.equal(result.state, 'clear');
  assert.deepEqual(result.deferred.map((r) => r.id), [78]);
});

test('Codex 4213960388 — a review-level finding past the cap is deferred, not dropped', () => {
  const readyAt = '2026-10-08T00:00:00Z';
  const result = classifyCodexState({
    expectedHead: HEAD,
    readyAt,
    deadline: '2026-10-08T01:00:00Z',
    now: '2026-10-08T00:01:00Z',
    comments: [],
    reviews: [{ id: 77, user: { login: CODEX }, commit_id: HEAD, state: 'COMMENTED', body: '![P2 Badge](x) Consider the retry path', submitted_at: '2026-10-08T00:00:30Z' }],
    cap: { reached: true, changedLines: changedLinesFromFiles(FILES) },
  });
  assert.equal(result.state, 'clear');
  assert.equal(result.deferred.length, 1);
  assert.equal(result.deferred[0].id, 77);
});

test('Codex 4214321785 — a blocking finding seen by the final read is returned as blocking, never deferred', async () => {
  const { finalCodexEvidence } = await import('./autonomous-review-gate.mjs');
  const earlier = [finding({ head: 'a'.repeat(40), id: 1 }), finding({ head: 'b'.repeat(40), id: 2 })];
  const client = {
    async reviews() { return []; },
    async reviewComments() { return [...earlier, finding({ p: 1, id: 3 })]; },
    async pullRequestFiles() { return FILES; },
  };
  const evidence = await finalCodexEvidence(client, { number: 9 }, HEAD);
  assert.equal(evidence.state, 'changes_required');
  assert.deepEqual(evidence.deferred, []);
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
  const state = reviewCapState({ expectedHead: HEAD, comments: [root, reply, genuine], reviews: [replyOnly], files: FILES });
  assert.equal(state.priorRounds, 1);
  assert.equal(state.reached, false);
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

test('Codex 4214389903 — a retry adds the deferred findings the existing follow-up issue does not list yet', async () => {
  const issues = [];
  const client = {
    async issuesLabelled() { return issues; },
    async createIssue(issue) { const made = { ...issue, number: 900 }; issues.push(made); return made; },
    async updateIssueBody(number, body) { issues.find((issue) => issue.number === number).body = body; },
  };
  const pr = { number: 9 };
  const first = finding({ p: 2, id: 1 });
  const second = { ...finding({ p: 3, id: 2 }), html_url: 'https://github.com/JagPat/PMCvitan/pull/9#discussion_r2' };
  assert.equal(await fileDeferredFindings(client, pr, HEAD, [first]), 900);
  assert.equal(await fileDeferredFindings(client, pr, HEAD, [first, second]), 900);
  assert.equal(issues.length, 1);
  assert.match(issues[0].body, /discussion_r2/u);
  const before = issues[0].body;
  await fileDeferredFindings(client, pr, HEAD, [first, second]);
  assert.equal(issues[0].body, before, 'a listed finding is never duplicated');
});


test('Codex 4216657953 — past the cap, a blank Codex review with nothing to defer does not clear the head', () => {
  const blank = { id: 88, user: { login: CODEX }, commit_id: HEAD, state: 'COMMENTED', body: '', submitted_at: '2026-10-08T00:00:30Z' };
  const result = classifyCodexState({
    expectedHead: HEAD,
    readyAt: '2026-10-08T00:00:00Z',
    deadline: '2026-10-08T01:00:00Z',
    now: '2026-10-08T00:01:00Z',
    comments: [],
    reviews: [blank],
    reactions: [],
    cap: { reached: true, changedLines: changedLinesFromFiles(FILES) },
  });
  // the same incomplete evidence the uncapped path refuses to read as clean: only a fresh +1 or a real
  // deferred finding clears a capped head
  assert.notEqual(result.state, 'clear');
  const uncapped = classifyCodexState({
    expectedHead: HEAD, readyAt: '2026-10-08T00:00:00Z', deadline: '2026-10-08T01:00:00Z', now: '2026-10-08T00:01:00Z',
    comments: [], reviews: [blank], reactions: [],
  });
  assert.equal(result.state, uncapped.state);
});

test('Codex 4216657933 — the one evidence settlement files every deferred finding, or returns a blocking one', async () => {
  const { settleFinalCodexEvidence } = await import('./autonomous-review-gate.mjs');
  const earlier = [finding({ head: 'a'.repeat(40), id: 1 }), finding({ head: 'b'.repeat(40), id: 2 })];
  const issues = [];
  const deferrable = finding({ p: 2, id: 3 });
  const client = (current) => ({
    async reviews() { return []; },
    async reviewComments() { return [...earlier, ...current]; },
    async pullRequestFiles() { return FILES; },
    async issuesLabelled() { return issues; },
    async createIssue(issue) { const made = { ...issue, number: 700 }; issues.push(made); return made; },
    async updateIssueBody(number, body) { issues.find((issue) => issue.number === number).body = body; },
  });
  // a finding that arrived since the earlier read is filed with the earlier one, once each
  const earlierRead = finding({ p: 3, id: 4 });
  const settled = await settleFinalCodexEvidence(client([deferrable]), { number: 9 }, HEAD, [earlierRead]);
  assert.equal(settled.state, 'clear');
  assert.equal(settled.followUp, 700);
  assert.match(issues[0].body, /discussion_r3/u);
  assert.match(issues[0].body, /discussion_r4/u);
  // a blocking finding is returned as blocking, and nothing is filed for it
  const blocked = await settleFinalCodexEvidence(client([finding({ p: 1, id: 5 })]), { number: 9 }, HEAD);
  assert.equal(blocked.state, 'changes_required');
});

test('Codex 4216657933 — recovering an earlier success settles the evidence before it merges', async () => {
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(new URL('./autonomous-review-gate.mjs', import.meta.url), 'utf8');
  const recovery = source.slice(source.indexOf('export async function ensureTerminalReviewState'), source.indexOf('async function waitForRequiredChecks'));
  const settle = recovery.indexOf('await settleFinalCodexEvidence(');
  const merge = recovery.indexOf('await completeReviewedPullRequest(');
  assert.ok(settle > 0 && merge > settle, 'the recovery merge follows the evidence settlement');
  // Codex 4220338753 — and so does the republished success: no green window before a blocking finding
  const republish = recovery.indexOf("'review: recovered prior clean Codex result on this exact head'");
  assert.ok(republish > settle, 'the recovered success is republished only after the evidence settles');
  // Codex 4220431600 — a recovery that filed a follow-up names it in the status, as the ordinary path does
  const followUpStatus = recovery.indexOf('cappedSuccessDetail(settled)');
  assert.ok(followUpStatus > settle, 'the recovered status names the follow-up issue');
});

test('Codex 4220431600 — the capped success description names the follow-up issue', () => {
  assert.equal(cappedSuccessDetail({ deferred: [1, 2], followUp: 701 }), 'review: review-round cap; 2 non-blocking finding(s) deferred to #701');
});

test('Codex 4220338659 — the cap reads a head\'s file list once, however many polls ask', async () => {
  let reads = 0;
  let fail = true;
  const client = {
    async pullRequestFiles() {
      reads += 1;
      if (fail) { fail = false; throw new Error('transient'); }
      return [{ filename: 'a.mjs' }];
    },
  };
  // a failed read is not cached: the next poll retries it. Codex 4221022493 — and it is not thrown either: it
  // reads as an unknown list, which the cap treats as incomplete (fail closed)
  assert.equal(await capFiles(client, 9, 'h1'), null);
  assert.equal(reviewCapState({ expectedHead: 'h1', files: null }).changedLines.incomplete, true);
  for (let poll = 0; poll < 5; poll++) assert.deepEqual(await capFiles(client, 9, 'h1'), [{ filename: 'a.mjs' }]);
  assert.equal(reads, 2);
  // a new head is a new list
  await capFiles(client, 9, 'h2');
  assert.equal(reads, 3);
});

test('Codex 4220431586 — an incomplete file list fails closed: a P1 in an unlisted file still blocks', () => {
  const unlisted = finding({ p: 1, path: 'apps/api/src/far.ts', line: 3, id: 7 });
  // complete list: the unlisted path is genuinely unchanged, so the P1 is deferred
  const complete = reviewCapState({ expectedHead: HEAD, files: FILES });
  assert.equal(blocksUnderCap(unlisted, complete.changedLines), false);
  // GitHub's cap reached, the PR's own count higher than the list, or no list at all: it blocks
  const capped = Array.from({ length: GITHUB_PR_FILES_LIMIT }, (_, i) => ({ filename: `f${i}.ts`, patch: '@@ -1 +1 @@\n+a' }));
  for (const state of [
    reviewCapState({ expectedHead: HEAD, files: capped }),
    reviewCapState({ expectedHead: HEAD, files: FILES, changedFiles: FILES.length + 1 }),
    reviewCapState({ expectedHead: HEAD, files: null }),
  ]) {
    assert.equal(blocksUnderCap(unlisted, state.changedLines), true);
  }
  // a listed file is still judged by its lines: an unchanged line in it does not block
  assert.equal(blocksUnderCap(finding({ p: 1, line: 5, id: 8 }), reviewCapState({ expectedHead: HEAD, files: FILES, changedFiles: 99 }).changedLines), false);
});

test('Codex 4220431616 — past the cap, a Codex REPLY alone never clears the head', () => {
  const reply = { ...finding({ p: 2, line: 5, id: 9 }), in_reply_to_id: 1 };
  const result = classify([reply], { reached: true, changedLines: changedLinesFromFiles(FILES) });
  assert.notEqual(result.state, 'clear');
  // a real off-diff finding beside it is what clears it, and the reply is not filed with it
  const both = classify([reply, finding({ p: 2, id: 10 })], { reached: true, changedLines: changedLinesFromFiles(FILES) });
  assert.equal(both.state, 'clear');
  assert.deepEqual(both.deferred.map((c) => c.id), [10]);
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

test('Codex 4220621316 — a patch shorter than its own counts is truncated and counts as changed throughout', () => {
  const patch = '@@ -1,2 +1,3 @@\n a\n+b\n c';
  const whole = changedLinesFromFiles([{ filename: 'x.ts', patch, additions: 1, deletions: 0 }]).get('x.ts');
  assert.ok(whole.right instanceof Set && whole.right.has(2));
  const cut = changedLinesFromFiles([{ filename: 'x.ts', patch, additions: 40, deletions: 0 }]).get('x.ts');
  assert.deepEqual(cut, { right: '*', left: '*' });
  // a P1 in an omitted hunk of a truncated patch blocks
  assert.equal(blocksUnderCap(finding({ p: 1, path: 'x.ts', line: 900, id: 11 }), changedLinesFromFiles([{ filename: 'x.ts', patch, additions: 40, deletions: 3 }])), true);
});

test('Codex 4220621334 — Codex evidence is read reviews first, then their comments', async () => {
  const order = [];
  let releaseReviews;
  const client = {
    reviews: () => new Promise((resolve) => { order.push('reviews:start'); releaseReviews = () => { order.push('reviews:done'); resolve([]); }; }),
    reviewComments: async () => { order.push('comments:start'); return []; },
    reactions: async () => { order.push('reactions:start'); return []; },
  };
  const pending = readCodexEvidence(client, 9, { reactions: true });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(order, ['reviews:start'], 'no comment read starts before the reviews have been read');
  releaseReviews();
  const evidence = await pending;
  assert.deepEqual(order.slice(0, 2), ['reviews:start', 'reviews:done']);
  assert.ok(order.indexOf('comments:start') > order.indexOf('reviews:done'));
  assert.deepEqual(Object.keys(evidence).sort(), ['comments', 'reactions', 'reviews']);
  // every gate read of Codex evidence goes through it
  const { readFile } = await import('node:fs/promises');
  const gate = await readFile(new URL('./autonomous-review-gate.mjs', import.meta.url), 'utf8');
  const concurrent = [...gate.matchAll(/Promise\.all\(\[[^\]]*client\.reviews\(/gu)];
  assert.equal(concurrent.length, 0, 'no read fetches the reviews concurrently with anything');
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

test('Codex 4220739644 — the follow-up label is provisioned before the first issue carries it', async () => {
  const calls = [];
  const client = {
    issuesLabelled: async () => [],
    ensureLabel: async (name) => { calls.push(`label:${name}`); },
    createIssue: async () => { calls.push('create'); return { number: 701 }; },
  };
  await fileDeferredFindings(client, { number: 9 }, HEAD, [finding({ p: 2, id: 12 })]);
  assert.deepEqual(calls, [`label:${REVIEW_FOLLOW_UP_LABEL}`, 'create']);
});

test('Codex 4220739672 — the final settlement admits only clear or no-new-evidence, and fails closed otherwise', async () => {
  const client = (comments, reviews) => ({
    reviews: async () => reviews,
    reviewComments: async () => comments,
    pullRequestFiles: async () => FILES,
  });
  // nothing arrived since the clean result: the earlier verdict stands
  const quiet = await settleFinalCodexEvidence(client([], []), { number: 9, changed_files: 2 }, HEAD);
  assert.equal(quiet.state, 'clear');
  // a finding arrived: blocking
  const found = await settleFinalCodexEvidence(client([finding({ p: 1, id: 13 })], []), { number: 9, changed_files: 2 }, HEAD);
  assert.equal(found.state, 'changes_required');
  // the gate source admits nothing but `clear` and `pending`
  const { readFile } = await import('node:fs/promises');
  const gate = await readFile(new URL('./autonomous-review-gate.mjs', import.meta.url), 'utf8');
  const body = gate.slice(gate.indexOf('export async function settleFinalCodexEvidence'), gate.indexOf('export function contextForEvent'));
  assert.match(body, /evidence\.state !== 'clear' && evidence\.state !== 'pending'/u);
});

test('Codex 4220861349 — the non-blocking findings beside a blocker are kept and filed before the head moves', async () => {
  // past the cap a blocking verdict carries the rest: a P2 and an off-diff P1 beside a changed-line P1
  const comments = [finding({ p: 1, id: 14 }), finding({ p: 2, id: 15 }), finding({ p: 1, line: 5, id: 16 })];
  const result = classify(comments, { reached: true, changedLines: changedLinesFromFiles(FILES) });
  assert.equal(result.state, 'changes_required');
  assert.deepEqual(result.deferred.map((comment) => comment.id), [15, 16]);
  // the final settlement returns them with its blocking verdict, joined to the caller's earlier read
  const rounds = [finding({ head: 'a'.repeat(40), id: 18 }), finding({ head: 'b'.repeat(40), id: 19 })];
  const client = { reviews: async () => [], reviewComments: async () => [...rounds, ...comments], pullRequestFiles: async () => FILES };
  const earlier = finding({ p: 3, id: 17 });
  const settled = await settleFinalCodexEvidence(client, { number: 9, changed_files: 2 }, HEAD, [earlier]);
  assert.equal(settled.state, 'changes_required');
  assert.deepEqual(settled.deferred.map((comment) => comment.id).sort(), [15, 16, 17]);
  // every blocking publication files them first, and every caller hands them over
  const { readFile } = await import('node:fs/promises');
  const gate = await readFile(new URL('./autonomous-review-gate.mjs', import.meta.url), 'utf8');
  const publish = gate.slice(gate.indexOf('export async function publishCurrentHeadFinding'), gate.indexOf('export async function guardAgainstCurrentHeadFinding'));
  const filed = publish.indexOf('await fileDeferredFindings(');
  assert.ok(filed > 0 && filed < publish.indexOf('await enforceReviewConvergence('), 'filed before anything can return early');
  const calls = gate.split('publishCurrentHeadFinding(').slice(2);
  assert.equal(calls.length, 4);
  for (const call of calls) assert.match(call.slice(0, 400), /deferred: \w+\.deferred \?\? \[\]/u);
  // recovery turns the head red first, then files them
  const recovery = gate.slice(gate.indexOf('export async function ensureTerminalReviewState'), gate.indexOf('async function waitForRequiredChecks'));
  const red = recovery.indexOf("await client.setStatus(expectedHead, 'failure', settled.detail");
  assert.ok(red > 0 && recovery.indexOf('await fileDeferredFindings(client, finalPolicy.pullRequest', red) > red);
});

test('Codex 4220861370 — a blank Codex review container that opens no thread is no review round', () => {
  const blank = (id, head) => ({ id, user: { login: CODEX }, commit_id: head, body: '', state: 'COMMENTED' });
  const a = 'a'.repeat(40);
  const b = 'b'.repeat(40);
  // two empty containers on two heads: no rounds, so the cap is not reached
  assert.deepEqual(findingRoundHeads([], [blank(1, a), blank(2, b)]), []);
  assert.equal(reviewCapState({ expectedHead: HEAD, reviews: [blank(1, a), blank(2, b)], files: FILES }).reached, false);
  // a blank container that owns a thread-opening comment, or a review with a body, still counts
  const opener = { ...finding({ head: a, id: 3 }), pull_request_review_id: 1 };
  assert.deepEqual(findingRoundHeads([opener], [blank(1, a)]), [a]);
  assert.deepEqual(findingRoundHeads([], [{ ...blank(2, b), body: '**Review-level finding**' }]), [b]);
});
