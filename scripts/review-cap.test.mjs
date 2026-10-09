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
import { capDefersStoredFailure, capFiles, cappedSuccessDetail, EVIDENCE_SNAPSHOT_ATTEMPTS, fileDeferredFindings, publishBlockingVerdict, readCodexEvidence, settleFinalCodexEvidence, unionDeferred } from './autonomous-review-gate.mjs';
import { isRetryableReviewFailureDescription, REVIEW_FOLLOW_UP_LABEL, REVIEW_ROUND_CAP } from './review-policy.mjs';

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

test('Codex 4220621316 — a patch shorter than its own counts is truncated and counts as changed throughout', () => {
  const patch = '@@ -1,2 +1,3 @@\n a\n+b\n c';
  const whole = changedLinesFromFiles([{ filename: 'x.ts', patch, additions: 1, deletions: 0 }]).get('x.ts');
  assert.ok(whole.right instanceof Set && whole.right.has(2));
  const cut = changedLinesFromFiles([{ filename: 'x.ts', patch, additions: 40, deletions: 0 }]).get('x.ts');
  assert.deepEqual(cut, { right: '*', left: '*' });
  // a P1 in an omitted hunk of a truncated patch blocks
  assert.equal(blocksUnderCap(finding({ p: 1, path: 'x.ts', line: 900, id: 11 }), changedLinesFromFiles([{ filename: 'x.ts', patch, additions: 40, deletions: 3 }])), true);
});

test('Codex 4220621334 / 4221120415 — one evidence snapshot: reviews, comments, then reviews again', async () => {
  const order = [];
  const client = {
    reviews: async () => { order.push('reviews'); return [{ id: 1 }]; },
    reviewComments: async () => { order.push('comments'); return []; },
    reactions: async () => { order.push('reactions'); return []; },
  };
  const evidence = await readCodexEvidence(client, 9, { reactions: true });
  assert.deepEqual(order, ['reviews', 'comments', 'reviews', 'reactions']);
  assert.equal(evidence.stable, true);
  // every gate read of Codex evidence goes through it, and every classification is told whether it is stable
  const { readFile } = await import('node:fs/promises');
  const gate = await readFile(new URL('./autonomous-review-gate.mjs', import.meta.url), 'utf8');
  assert.equal([...gate.matchAll(/Promise\.all\(\[[^\]]*client\.reviews\(/gu)].length, 0, 'no read fetches the reviews concurrently with anything');
  assert.equal([...gate.matchAll(/client\.reviews\(/gu)].length, 2, 'only the snapshot reads reviews');
  const classifications = [...gate.matchAll(/classifyCodexState\(\{\s*stable,/gu)].length;
  assert.equal(classifications, [...gate.matchAll(/classifyCodexState\(\{/gu)].length, 'every classification passes the snapshot stability');
});

test('Codex 4221120415 — a body-only review submitted after the comments read is caught by the second reviews read', async () => {
  // the body-only finding review lands between the comments read and the second reviews read
  const finding = { id: 7, user: { login: CODEX }, commit_id: HEAD, body: '**![P1 Badge](x)** review-level finding', state: 'COMMENTED' };
  let reads = 0;
  const client = {
    reviews: async () => { reads += 1; return reads >= 2 ? [finding] : []; },
    reviewComments: async () => [],
  };
  const evidence = await readCodexEvidence(client, 9);
  // the first attempt is unstable (no review, then one), so the snapshot is read again and settles with it
  assert.equal(evidence.stable, true);
  assert.deepEqual(evidence.reviews.map((review) => review.id), [7]);
  assert.equal(reads, 4);
  // and it blocks: a current-head review is never "nothing new"
  const settled = await settleFinalCodexEvidence({ ...client, reviews: async () => [finding], pullRequestFiles: async () => FILES }, { number: 9, changed_files: 2 }, HEAD);
  assert.equal(settled.state, 'changes_required');
});

test('M2b — evidence that never settles is unsettled: it never clears a head and the final settlement fails closed', async () => {
  let reads = 0;
  const client = {
    reviews: async () => { reads += 1; return [{ id: reads }]; },
    reviewComments: async () => [],
    pullRequestFiles: async () => FILES,
  };
  const evidence = await readCodexEvidence(client, 9);
  assert.equal(evidence.stable, false);
  assert.equal(reads, 2 * EVIDENCE_SNAPSHOT_ATTEMPTS);
  const now = new Date().toISOString();
  const result = classifyCodexState({ expectedHead: HEAD, readyAt: now, deadline: now, now, stable: false, reactions: [{ user: { login: CODEX }, content: '+1', created_at: now }] });
  assert.equal(result.state, 'unsettled', 'not even a fresh +1 clears an unstable snapshot');
  // and past the deadline it times out, so a poll never runs on beyond it
  const later = new Date(Date.parse(now) + 1).toISOString();
  assert.equal(classifyCodexState({ expectedHead: HEAD, readyAt: now, deadline: now, now: later, stable: false }).state, 'timed_out');
  const settled = await settleFinalCodexEvidence(client, { number: 9, changed_files: 2 }, HEAD);
  assert.equal(settled.state, 'changes_required');
  // a retryable failure, never a latched finding that would need a push to move on
  assert.equal(settled.detail, 'review: Codex evidence changed during final verification');
  assert.equal(isRetryableReviewFailureDescription(settled.detail), true);
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
  // every blocking publication hands them over to the one ordered publisher
  const { readFile } = await import('node:fs/promises');
  const gate = await readFile(new URL('./autonomous-review-gate.mjs', import.meta.url), 'utf8');
  const calls = gate.split('publishCurrentHeadFinding(').slice(2);
  assert.equal(calls.length, 4);
  for (const call of calls) assert.match(call.slice(0, 400), /deferred: \w+\.deferred \?\? \[\]/u);
});

test('Codex 4221120404 — a blocking verdict is published in one fixed order: failure, then draft, then deferred findings', async () => {
  const calls = [];
  const pr = { number: 9, html_url: 'u', state: 'open', draft: false, head: { sha: HEAD, repo: { full_name: 'o/r' } }, base: { ref: 'main', repo: { full_name: 'o/r' } } };
  const client = (headMoved = false, failFiling = false) => ({
    setStatus: async (sha, state) => { calls.push(`status:${state}`); },
    pullRequest: async () => (headMoved ? { ...pr, head: { ...pr.head, sha: 'f'.repeat(40) } } : pr),
    setDraft: async (p, draft) => { calls.push(`draft:${draft}`); return { ...p, draft }; },
    issuesLabelled: async () => [],
    ensureLabel: async () => {},
    createIssue: async () => { calls.push('file'); if (failFiling) throw new Error('issues API down'); return { number: 701 }; },
  });
  const deferred = [finding({ p: 2, id: 20 })];
  await publishBlockingVerdict(client(), pr, HEAD, { description: 'review: 1 blocking', deferred });
  assert.deepEqual(calls, ['status:failure', 'draft:true', 'file']);
  // a slow or failed issue write can no longer leave a green head: the failure status is already published
  calls.length = 0;
  await assert.rejects(publishBlockingVerdict(client(false, true), pr, HEAD, { description: 'review: 1 blocking', deferred }));
  assert.deepEqual(calls.slice(0, 2), ['status:failure', 'draft:true']);
  // the head moved: no draft for a head that is not current, but the findings found on it are still filed
  calls.length = 0;
  assert.equal(await publishBlockingVerdict(client(true), pr, HEAD, { description: 'review: 1 blocking', deferred }), null);
  assert.deepEqual(calls, ['status:failure', 'file']);
  // every path that publishes a blocking Codex verdict goes through it
  const { readFile } = await import('node:fs/promises');
  const gate = await readFile(new URL('./autonomous-review-gate.mjs', import.meta.url), 'utf8');
  const publish = gate.slice(gate.indexOf('export async function publishCurrentHeadFinding'), gate.indexOf('export async function guardAgainstCurrentHeadFinding'));
  assert.ok(publish.indexOf('await publishBlockingVerdict(') > 0
    && publish.indexOf('await publishBlockingVerdict(') < publish.indexOf('await enforceReviewConvergence('), 'published before anything can return early');
  assert.doesNotMatch(publish, /client\.setStatus\(|setDraftForCurrentHead\(|fileDeferredFindings\(/u, 'no step of its own');
  const recovery = gate.slice(gate.indexOf('export async function ensureTerminalReviewState'), gate.indexOf('async function waitForRequiredChecks'));
  assert.match(recovery, /if \(settled\.state === 'changes_required'\) \{\s*await publishBlockingVerdict\(/u);
  assert.equal([...gate.matchAll(/await publishBlockingVerdict\(/gu)].length, 3, 'the finding path, recovery and changed final evidence');
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

test('Codex 4225790723 — past the cap, identical findings on the two sides of a line are judged separately', () => {
  // the same P1 text at line 1: on the LEFT it names the deleted (changed) old line 1; on the RIGHT, new line
  // 1 is unchanged context
  const files = [{ filename: 'apps/web/src/a.ts', patch: '@@ -1,3 +1,2 @@\n-x\n a\n c' }];
  const left = { ...finding({ p: 1, line: 1, id: 30 }), side: 'LEFT', body: '**![P1 Badge](x)** same text' };
  const right = { ...finding({ p: 1, line: 1, id: 31 }), side: 'RIGHT', body: '**![P1 Badge](x)** same text' };
  const changedLines = changedLinesFromFiles(files);
  assert.equal(blocksUnderCap(left, changedLines), true, 'the deleted line is a changed line');
  assert.equal(blocksUnderCap(right, changedLines), false, 'the context line is not');
  // whichever order GitHub returns them in, the changed-line P1 still blocks
  for (const comments of [[left, right], [right, left]]) {
    const result = classify(comments, { reached: true, changedLines });
    assert.equal(result.state, 'changes_required');
  }
});

test('Codex 4225790718 — a ticked or edited follow-up item is not appended again', async () => {
  const deferred = [finding({ p: 2, id: 40 })];
  const marker = `<!-- review-follow-up: pr-9 head-${HEAD} -->`;
  const issue = { number: 702, body: `${marker}\n- [x] P2 \`apps/web/src/a.ts:2\` — done (https://github.com/o/r/pull/9#discussion_r40)` };
  const updates = [];
  const client = { issuesLabelled: async () => [issue], updateIssueBody: async (number, body) => { updates.push(body); } };
  assert.equal(await fileDeferredFindings(client, { number: 9 }, HEAD, deferred), 702);
  assert.deepEqual(updates, [], 'the ticked finding stays as the person left it');
  // a genuinely new finding is still added
  await fileDeferredFindings(client, { number: 9 }, HEAD, [...deferred, finding({ p: 2, id: 41 })]);
  assert.equal(updates.length, 1);
  assert.match(updates[0], /discussion_r41/u);
  assert.equal(updates[0].match(/discussion_r40/gu).length, 1);
});

test('Codex 4225790715 — a stored findings failure that the cap now defers no longer latches the head', async () => {
  const rounds = [finding({ head: 'a'.repeat(40), id: 50 }), finding({ head: 'b'.repeat(40), id: 51 })];
  const client = (current) => ({ reviews: async () => [], reviewComments: async () => [...rounds, ...current], pullRequestFiles: async () => FILES });
  const failure = { context: 'codex-current-head', state: 'failure', description: 'review: 1 current-head Codex finding' };
  const pr = { number: 9, changed_files: 2 };
  // past the cap, only a deferrable P2 on this head: the stored failure is re-judged and not preserved
  assert.equal(await capDefersStoredFailure(client([finding({ p: 2, id: 52 })]), pr, HEAD, failure), true);
  // a changed-line P1 still blocks: the failure stands
  assert.equal(await capDefersStoredFailure(client([finding({ p: 1, id: 53 })]), pr, HEAD, failure), false);
  // under the cap nothing is deferrable: the failure stands
  assert.equal(await capDefersStoredFailure({ ...client([finding({ p: 2, id: 54 })]), reviewComments: async () => [finding({ p: 2, id: 54 })] }, pr, HEAD, failure), false);
  // only a findings failure qualifies
  assert.equal(await capDefersStoredFailure(client([finding({ p: 2, id: 55 })]), pr, HEAD, { ...failure, description: 'review: Codex review timed out' }), false);
  // both recovery branches consult it before preserving the failure
  const { readFile } = await import('node:fs/promises');
  const gate = await readFile(new URL('./autonomous-review-gate.mjs', import.meta.url), 'utf8');
  const recovery = gate.slice(gate.indexOf('export async function ensureTerminalReviewState'), gate.indexOf('async function waitForRequiredChecks'));
  assert.match(recovery, /if \(latched && !\(await capDefersStoredFailure\(/u);
  assert.match(recovery, /\} else \{[\s\S]{0,400}if \(await capDefersStoredFailure\(client, pullRequest, expectedHead, status\)\) return false;/u);
});
