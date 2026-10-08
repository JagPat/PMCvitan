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
} from './review-cap.mjs';
import { classifyCodexState } from './autonomous-review-state.mjs';
import { capFiles, fileDeferredFindings, unionDeferred } from './autonomous-review-gate.mjs';
import { alreadyReported, completionReport, reviewRounds } from './completion-report.mjs';
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
  // a failed read is not cached: the next poll retries it
  await assert.rejects(capFiles(client, 9, 'h1'));
  for (let poll = 0; poll < 5; poll++) assert.deepEqual(await capFiles(client, 9, 'h1'), [{ filename: 'a.mjs' }]);
  assert.equal(reads, 2);
  // a new head is a new list
  await capFiles(client, 9, 'h2');
  assert.equal(reads, 3);
});
