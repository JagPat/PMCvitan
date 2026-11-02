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
import { capDefersStoredFailure, capFiles, cappedSuccessDetail, ensureTerminalReviewState, EVIDENCE_SNAPSHOT_ATTEMPTS, fileDeferredFindings, finalCodexEvidence, isTerminalReviewStatus, publishBlockingVerdict, publishSettledSuccess, readCodexEvidence, reclassifyCurrentCodexEvidence, reviewAttempt, settleFinalCodexEvidence, SETTLING_DESCRIPTION, unionDeferred } from './autonomous-review-gate.mjs';
import { pendingFollowUpHeads } from './review-follow-up.mjs';
import { recordSecurityVerdict, securityVerdictHeads, securityVerdictMarker, SECURITY_VERDICT_MARKER_AUTHOR } from './security-verdict-marker.mjs';
import { CODEX_RECORD_UNREADABLE_DETAIL, CODEX_RUN_HELD_DETAIL, CODEX_SECURITY_FINDINGS_DETAIL, FOLLOW_UP_RETRY, isRetryableReviewFailureDescription, REVIEW_FOLLOW_UP_LABEL, REVIEW_ROUND_CAP } from './review-policy.mjs';

// M3c C1 — the gate stamps the run id and records a receipt from the Actions env; in CI that env is the test
// runner's own, so clear it to keep the suite hermetic and the runner's GITHUB_ENV untouched.
for (const name of ['GITHUB_RUN_ID', 'GITHUB_ENV', 'RUNNER_TEMP']) delete process.env[name];

const CODEX = 'chatgpt-codex-connector[bot]';
const HEAD = 'c'.repeat(40);
const FILES = [
  { filename: 'apps/web/src/a.ts', patch: '@@ -1,2 +1,3 @@\n a\n+b\n-x\n c\n@@ -10,1 +11,2 @@\n k\n+l' },
  { filename: 'image.png' },
];

/**
 * An in-memory GitHub for the gate and the follow-up component (scripts/review-follow-up.mjs): the PR's Codex
 * evidence, its statuses, its comments (where follow-ups are recorded), and the follow-up issues and their
 * comments. `log` records the externally visible writes in order; `fail.<method> = n` fails the next n calls.
 */
function fakeGitHub({ comments = [], reviews = [], files = FILES, pr = null } = {}) {
  const state = { comments, reviews, issues: [], notes: [], statuses: [], log: [], fail: {}, nextIssue: 800, nextNote: 1 };
  const failing = (method) => {
    if ((state.fail[method] ?? 0) > 0) {
      state.fail[method] -= 1;
      throw new Error(`issues API down (${method})`);
    }
  };
  const note = (issue, body) => {
    const made = { id: state.nextNote++, issue, body, user: { login: 'github-actions[bot]' } };
    state.notes.push(made);
    return made;
  };
  const client = {
    reviews: async () => state.reviews,
    reviewComments: async () => state.comments,
    pullRequestFiles: async () => files,
    reactions: async () => [],
    statuses: async () => [],
    // M3c: the success writer reads the exact head's Work-Item trailer; this head cites none
    commit: async () => ({ commit: { message: 'fix\n\nCorrection-Owner: claude\n' } }),
    pause: async () => {},
    pullRequest: async () => pr,
    setDraft: async (current, draft) => { state.log.push(`draft:${draft}`); return { ...current, draft }; },
    setStatus: async (sha, statusState, description) => { state.log.push(`status:${statusState}`); state.statuses.push({ sha, state: statusState, description }); },
    updateStickyComment: async () => {},
    issuesLabelled: async () => state.issues.map((issue) => ({ ...issue })),
    ensureLabel: async () => {},
    createIssue: async (issue) => {
      state.log.push('file');
      failing('createIssue');
      const made = { ...issue, number: state.nextIssue++, state: 'open', state_reason: null };
      state.issues.push(made);
      return made;
    },
    issueComments: async (number) => state.notes.filter((comment) => comment.issue === number),
    createIssueComment: async (number, body) => {
      state.log.push(number === pr?.number || number === 9 ? 'record' : 'file');
      failing('createIssueComment');
      return note(number, body);
    },
    updateIssueComment: async (id, body) => { state.notes.find((comment) => comment.id === id).body = body; },
    closeIssue: async (number, comment) => {
      note(number, comment);
      Object.assign(state.issues.find((issue) => issue.number === number), { state: 'closed', state_reason: 'not_planned' });
    },
  };
  /** every finding identity a follow-up issue lists: its body and the workflow's comments on it */
  const listed = (number) => [
    state.issues.find((issue) => issue.number === number)?.body ?? '',
    ...state.notes.filter((comment) => comment.issue === number).map((comment) => comment.body),
  ].join('\n');
  return { client, state, listed };
}

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

test('deferred findings are filed once per head, idempotently, through the follow-up component', async () => {
  const { client, state, listed } = fakeGitHub();
  const pr = { number: 9 };
  const deferred = [finding({ p: 2 })];
  assert.equal(await fileDeferredFindings(client, pr, HEAD, deferred), 800);
  assert.equal(await fileDeferredFindings(client, pr, HEAD, deferred), 800);
  assert.equal(state.issues.length, 1);
  assert.match(listed(800), /P2 `apps\/web\/src\/a\.ts:2` — Title 1/u);
  assert.deepEqual(state.issues[0].labels, [REVIEW_FOLLOW_UP_LABEL]);
  assert.deepEqual(pendingFollowUpHeads(state.notes.filter((n) => n.issue === 9), 9), [], 'each filing is recorded and marked filed');
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
  const earlier = [finding({ head: 'a'.repeat(40), id: 1 }), finding({ head: 'b'.repeat(40), id: 2 })];
  const deferrable = finding({ p: 2, id: 3 });
  // a finding that arrived since the earlier read is filed with the earlier one, once each
  const { client, listed } = fakeGitHub({ comments: [...earlier, deferrable] });
  const earlierRead = finding({ p: 3, id: 4 });
  const settled = await settleFinalCodexEvidence(client, { number: 9 }, HEAD, [earlierRead]);
  assert.equal(settled.state, 'clear');
  assert.equal(settled.followUp, 800);
  assert.match(listed(800), /discussion_r3/u);
  assert.match(listed(800), /discussion_r4/u);
  // a blocking finding is returned as blocking, and nothing is filed for it
  const blocked = fakeGitHub({ comments: [...earlier, finding({ p: 1, id: 5 })] });
  assert.equal((await settleFinalCodexEvidence(blocked.client, { number: 9 }, HEAD)).state, 'changes_required');
  assert.equal(blocked.state.issues.length, 0);
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
    issueComments: async () => { order.push('issueComments'); return []; },
  };
  const evidence = await readCodexEvidence(client, 9, { reactions: true });
  // #1254 — Codex's review-state record is read last, after the reactions
  assert.deepEqual(order, ['reviews', 'comments', 'reviews', 'reactions', 'issueComments']);
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
  const settled = await settleFinalCodexEvidence({ ...fakeGitHub().client, reviews: async () => [finding], reviewComments: async () => [] }, { number: 9, changed_files: 2 }, HEAD);
  assert.equal(settled.state, 'changes_required');
});

test('M2b — evidence that never settles is unsettled: it never clears a head and the final settlement fails closed', async () => {
  let reads = 0;
  const client = {
    ...fakeGitHub().client,
    reviews: async () => { reads += 1; return [{ id: reads }]; },
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

test('Codex 4220739672 — the final settlement admits only clear or no-new-evidence, and fails closed otherwise', async () => {
  const client = (comments, reviews) => fakeGitHub({ comments, reviews }).client;
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
  const { client } = fakeGitHub({ comments: [...rounds, ...comments] });
  const earlier = finding({ p: 3, id: 17 });
  const settled = await settleFinalCodexEvidence(client, { number: 9, changed_files: 2 }, HEAD, [earlier]);
  assert.equal(settled.state, 'changes_required');
  assert.deepEqual(settled.deferred.map((comment) => comment.id).sort(), [15, 16, 17]);
  // every blocking publication hands them over to the one ordered publisher
  const { readFile } = await import('node:fs/promises');
  const gate = await readFile(new URL('./autonomous-review-gate.mjs', import.meta.url), 'utf8');
  // every call (not the definition), wherever it sits in the file
  const calls = [...gate.matchAll(/(?<!function )publishCurrentHeadFinding\(/gu)].map((match) => gate.slice(match.index + match[0].length));
  assert.equal(calls.length, 7, '#1287/#1288 audit — + recovery\'s findings and the latched finding');
  // G2 — except the merge refusal's security verdict: it reads only Codex's record (no findings to hand over), after
  // the settlement already filed this head's deferrable findings; and the latched finding re-published over a
  // withdrawn success, whose findings were handed over when it was first published
  const refusal = calls.filter((call) => call.slice(0, 400).includes('detail: CODEX_SECURITY_FINDINGS_DETAIL'));
  assert.equal(refusal.length, 1);
  const latched = calls.filter((call) => call.slice(0, 400).includes('detail: LATCHED_FINDING_DETAIL'));
  assert.equal(latched.length, 1);
  for (const call of calls.filter((c) => !refusal.includes(c) && !latched.includes(c))) assert.match(call.slice(0, 400), /deferred: \w+\.deferred \?\? \[\]/u);
});

test('Codex 4221120404 / 4226440227 / 4229506050 — a blocking verdict is published in one fixed order: non-green, record, verdict, draft, filing', async () => {
  const pr = { number: 9, html_url: 'u', state: 'open', draft: false, head: { sha: HEAD, repo: { full_name: 'o/r' } }, base: { ref: 'main', repo: { full_name: 'o/r' } } };
  const deferred = [finding({ p: 2, id: 20 })];
  const run = fakeGitHub({ pr });
  await publishBlockingVerdict(run.client, pr, HEAD, { description: 'review: 1 blocking', deferred });
  assert.deepEqual(run.state.log, ['status:pending', 'record', 'status:failure', 'draft:true', 'file']);
  // with nothing to defer there is nothing to record: the verdict comes first, as before
  const plain = fakeGitHub({ pr });
  await publishBlockingVerdict(plain.client, pr, HEAD, { description: 'review: 1 blocking' });
  assert.deepEqual(plain.state.log, ['status:failure', 'draft:true']);
  // Codex 4229506050 — a recording that fails exposes NO correction verdict: the head is left on the retryable
  // follow-up failure, so no push is asked for while the siblings are unrecorded
  const unrecorded = fakeGitHub({ pr });
  unrecorded.state.fail.createIssueComment = 1;
  await assert.rejects(publishBlockingVerdict(unrecorded.client, pr, HEAD, { description: 'review: 1 blocking', deferred }), /issues API down/u);
  assert.deepEqual(unrecorded.state.statuses.map((status) => [status.state, status.description]), [
    ['pending', 'review: recording deferred Codex findings before the verdict'],
    ['failure', FOLLOW_UP_RETRY],
  ]);
  assert.equal(isRetryableReviewFailureDescription(FOLLOW_UP_RETRY), true);
  // a slow or failed issue write can no longer leave a green head: the failure status is already published,
  // and the record stays pending for recovery
  const failed = fakeGitHub({ pr });
  failed.state.fail.createIssue = 1;
  await assert.rejects(publishBlockingVerdict(failed.client, pr, HEAD, { description: 'review: 1 blocking', deferred }), /issues API down/u);
  assert.deepEqual(failed.state.log.slice(0, 4), ['status:pending', 'record', 'status:failure', 'draft:true']);
  assert.equal(failed.state.statuses.at(-1).description, 'review: 1 blocking', 'the recorded verdict stands; the filing is recovered later');
  assert.deepEqual(pendingFollowUpHeads(failed.state.notes, 9), [HEAD]);
  // the head moved: no draft for a head that is not current, but the findings found on it are still filed
  const moved = fakeGitHub({ pr: { ...pr, head: { ...pr.head, sha: 'f'.repeat(40) } } });
  assert.equal(await publishBlockingVerdict(moved.client, pr, HEAD, { description: 'review: 1 blocking', deferred }), null);
  assert.deepEqual(moved.state.log, ['status:pending', 'record', 'status:failure', 'file']);
  // every path that publishes a blocking Codex verdict goes through it
  const { readFile } = await import('node:fs/promises');
  const gate = await readFile(new URL('./autonomous-review-gate.mjs', import.meta.url), 'utf8');
  const publish = gate.slice(gate.indexOf('export async function publishCurrentHeadFinding'), gate.indexOf('export async function guardAgainstCurrentHeadFinding'));
  assert.ok(publish.indexOf('await publishBlockingVerdict(') > 0
    && publish.indexOf('await publishBlockingVerdict(') < publish.indexOf('await enforceReviewConvergence('), 'published before anything can return early');
  assert.doesNotMatch(publish, /client\.setStatus\(|setDraftForCurrentHead\(|fileDeferredFindings\(/u, 'no step of its own');
  const recovery = gate.slice(gate.indexOf('export async function ensureTerminalReviewState'), gate.indexOf('async function waitForRequiredChecks'));
  assert.match(recovery, /if \(settled\.state === 'changes_required'\) \{\s*await publishCurrentHeadFinding\(/u);
  // #1287/#1288 root-cause audit — publishBlockingVerdict has exactly two callers, the two shared writers: the
  // retryable hold (no correction notice) and the finding publisher (convergence, the correction notice)
  const callers = [...gate.matchAll(/(?<!function )publishBlockingVerdict\(/gu)].map((match) => {
    const before = gate.slice(0, match.index);
    return before.slice(before.lastIndexOf('\nexport async function ') + 1).match(/^export async function (\w+)/u)?.[1];
  });
  assert.deepEqual(callers, ['publishRetryableHold', 'publishCurrentHeadFinding'], 'no other site calls publishBlockingVerdict directly');
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
  // (G2 — each also turns a 'held' answer into the retryable hold before preserving anything)
  // (G2 — in the stored-failure branch a 'held' answer hands the head to the ordinary review; under a success it
  // publishes the latched failure, so the success never stays green through the hold: Codex 4438607038)
  assert.match(recovery, /const latchedDeferral = latched \? await capDefersStoredFailure\([\s\S]{0,500}if \(latched && latchedDeferral !== true\)/u);
  assert.match(recovery, /\} else \{[\s\S]{0,400}const deferral = await capDefersStoredFailure\(client, pullRequest, expectedHead, status\);[\s\S]{0,200}if \(deferral\) return false;/u);
});

test('Codex 4226080917 — a failed follow-up filing is retried by the next controller run on the same head', async () => {
  const { guardAgainstCurrentHeadFinding } = await import('./autonomous-review-gate.mjs');
  const rounds = [finding({ head: 'a'.repeat(40), id: 60 }), finding({ head: 'b'.repeat(40), id: 61 })];
  const current = [finding({ p: 1, id: 62 }), finding({ p: 2, id: 63 })];
  const pr = { number: 9, html_url: 'u', state: 'open', draft: false, changed_files: 2, body: '<!-- correction-owner: claude -->', head: { sha: HEAD, ref: 'b', repo: { full_name: 'o/r' } }, base: { ref: 'main', repo: { full_name: 'o/r' } } };
  const { client, state, listed } = fakeGitHub({ comments: [...rounds, ...current], pr });
  state.fail.createIssue = 1;
  // first run: the blocking verdict is published (failure first), recorded, then the filing fails
  await assert.rejects(guardAgainstCurrentHeadFinding(client, pr, HEAD, null), /issues API down/u);
  assert.deepEqual(state.log.filter((entry) => entry !== 'draft:true'), ['status:pending', 'record', 'status:failure', 'file']);
  assert.deepEqual(pendingFollowUpHeads(state.notes, 9), [HEAD]);
  // the next controller run on this head reaches the same guard first (before any terminal-state recovery),
  // re-derives the blocker and its deferred sibling, and files the sibling
  state.log.length = 0;
  assert.match(await guardAgainstCurrentHeadFinding(client, pr, HEAD, null), /1 blocking current-head Codex finding/u);
  assert.ok(state.log.includes('status:failure'));
  assert.equal(state.issues.length, 1);
  assert.match(listed(state.issues[0].number), /discussion_r63/u);
  assert.doesNotMatch(listed(state.issues[0].number), /discussion_r62/u, 'the blocker itself is not deferred');
  assert.deepEqual(pendingFollowUpHeads(state.notes, 9), []);
  // and in the orchestrator that guard precedes the terminal-state recovery
  const { readFile } = await import('node:fs/promises');
  const gate = await readFile(new URL('./autonomous-review-gate.mjs', import.meta.url), 'utf8');
  const runBody = gate.slice(gate.indexOf('export async function run()'));
  assert.ok(runBody.indexOf('await guardAgainstCurrentHeadFinding(') < runBody.indexOf('await ensureTerminalReviewState('));
});
test('owner direction 2026-10-09 — filing fails, a new head is pushed, and the final settlement recovers the earlier head\'s findings', async () => {
  const H1 = 'd'.repeat(40);
  const H2 = 'e'.repeat(40);
  const pr = { number: 9, html_url: 'u', changed_files: 2 };
  // H2 carries no Codex finding of its own
  const { client, state, listed } = fakeGitHub({ pr });
  state.fail.createIssue = 1;
  // H1: past the cap, a P2 and an off-diff P1 were deferred (classified on H1); the filing fails
  const onH1 = [finding({ head: H1, p: 2, id: 70 }), finding({ head: H1, p: 1, line: 5, id: 71 })];
  await assert.rejects(fileDeferredFindings(client, pr, H1, onH1), /issues API down/u);
  assert.equal(state.issues.length, 0);
  assert.deepEqual(pendingFollowUpHeads(state.notes, 9), [H1], 'the filing was recorded before it ran');
  // a new head H2 is pushed before any retry: H1's findings are no longer current-head evidence
  const settled = await settleFinalCodexEvidence(client, pr, H2);
  assert.equal(settled.state, 'clear');
  assert.deepEqual(state.statuses.map((status) => status.state), ['pending'], 'H2 holds no green while the recovery runs');
  // recovered into H1's OWN follow-up issue, with H1's classification and each finding's identity
  assert.equal(state.issues.length, 1);
  assert.match(state.issues[0].body, new RegExp(`review-follow-up: pr-9 head-${H1}`, 'u'));
  assert.match(listed(800), /P2 `apps\/web\/src\/a\.ts:2` — Title 70 \(https:\/\/github\.com\/o\/r\/pull\/9#discussion_r70\)/u);
  assert.match(listed(800), /P1 `apps\/web\/src\/a\.ts:5` — Title 71 \(https:\/\/github\.com\/o\/r\/pull\/9#discussion_r71\)/u);
  assert.deepEqual(pendingFollowUpHeads(state.notes, 9), []);
  // no duplicate entries: a later settlement files nothing again, and a re-recorded finding is matched by URL
  const before = listed(800);
  await settleFinalCodexEvidence(client, pr, H2);
  await fileDeferredFindings(client, pr, H1, onH1);
  assert.equal(listed(800), before);
  assert.equal(state.log.filter((entry) => entry === 'file').length, 2, 'one failed create, one successful create, nothing more');
  // a pending record someone else wrote is ignored: only the workflow's own records are recovered
  state.notes.push({ id: 99, issue: 9, user: { login: 'someone' }, body: `<!-- review-follow-up-pending: pr-9 head-${H2} -->\n- [ ] P2 \`x:1\` — injected (https://example.com/x)` });
  await settleFinalCodexEvidence(client, pr, H2);
  assert.equal(state.issues.length, 1);
});
test('Codex 4226440227 — the deferred lines are recorded before the draft transition, so a failing draft cannot lose them', async () => {
  const pr = { number: 9, html_url: 'u' };
  const { client, state } = fakeGitHub();
  client.pullRequest = async () => { state.log.push('draft'); throw new Error('GitHub 502'); };
  await assert.rejects(publishBlockingVerdict(client, pr, HEAD, { description: 'review: 1 blocking', deferred: [finding({ p: 2, id: 90 })] }), /502/u);
  assert.deepEqual(state.log, ['status:pending', 'record', 'status:failure', 'draft']);
  assert.deepEqual(pendingFollowUpHeads(state.notes, 9), [HEAD]);
  assert.match(state.notes[0].body, /discussion_r90/u);
});
test('Codex 4226440219 — an unsettled final settlement is published on the recovery path, not as a correction', async () => {
  const { readFile } = await import('node:fs/promises');
  const gate = await readFile(new URL('./autonomous-review-gate.mjs', import.meta.url), 'utf8');
  const success = gate.slice(gate.indexOf('const settled = await settleFinalCodexEvidence(client, pullRequest, expectedHead, verifiedResult.deferred'));
  const retry = success.indexOf('if (settled.retryable) {');
  assert.ok(retry > 0 && retry < success.indexOf('if (settled.state === \'changes_required\') {'), 'checked before the correction path');
  const branch = success.slice(retry, success.indexOf('if (settled.state === \'changes_required\') {'));
  // #1287/#1288 audit — through the one retryable-hold writer, before the throw
  assert.ok(branch.indexOf('await publishRetryableHold(') >= 0 && branch.indexOf('await publishRetryableHold(') < branch.indexOf('throw new Error(settled.detail)'));
  assert.doesNotMatch(branch, /publishCurrentHeadFinding|publishBlockingVerdict|correctionNotice|changes_required/u, 'no correction instruction for the author');
  // G2 (#1280 round 2, Codex 4438874587): that writer replaces the `review_clean` sticky with `review_retry`, after the
  // verdict and the settle, so a held settlement never reads clean
  const helper = gate.slice(gate.indexOf('export async function publishRetryableHold('), gate.indexOf('export async function publishCurrentHeadFinding('));
  const sticky = helper.indexOf('updateStickyComment(');
  assert.ok(sticky > helper.indexOf('settleRecoveryRequest(') && helper.indexOf('settleRecoveryRequest(') > helper.indexOf('publishBlockingVerdict('));
  assert.match(helper.slice(sticky), /state: 'review_retry'/u);
  assert.match(helper, /settleReason = 'changed review evidence'/u);
  // and the settlement marks exactly that case retryable
  let reads = 0;
  const client = { ...fakeGitHub().client, reviews: async () => { reads += 1; return [{ id: reads }]; } };
  const settled = await settleFinalCodexEvidence(client, { number: 9, changed_files: 2 }, HEAD);
  assert.equal(settled.retryable, true);
  const blocked = await settleFinalCodexEvidence(fakeGitHub({ comments: [finding({ p: 1, id: 93 })] }).client, { number: 9, changed_files: 2 }, HEAD);
  assert.equal(blocked.retryable, false);
});

test('Codex 4226684322 — the settlement withdraws any earlier green before it files, and never restores it itself', async () => {
  const rounds = [finding({ head: 'a'.repeat(40), id: 100 }), finding({ head: 'b'.repeat(40), id: 101 })];
  const pr = { number: 9, html_url: 'u', changed_files: 2 };
  const { client, state } = fakeGitHub({ comments: [...rounds, finding({ p: 2, id: 102 })], pr });
  const settled = await settleFinalCodexEvidence(client, pr, HEAD);
  assert.equal(settled.state, 'clear');
  assert.equal(state.log[0], 'status:pending', 'the head is non-green before any follow-up write');
  assert.equal(state.statuses[0].description, SETTLING_DESCRIPTION);
  assert.ok(state.log.indexOf('status:pending') < state.log.indexOf('file'));
  assert.equal(state.statuses.some((status) => status.state === 'success'), false, 'success is the caller\'s, after filing');
  // a filing that fails leaves the head non-green: nothing republishes the withdrawn success
  const failing = fakeGitHub({ comments: [...rounds, finding({ p: 2, id: 103 })], pr });
  failing.state.fail.createIssue = 1;
  await assert.rejects(settleFinalCodexEvidence(failing.client, pr, HEAD), /issues API down/u);
  // Codex 4229506042 — and not a pending status nothing resumes: the retryable follow-up failure recovery re-runs
  assert.deepEqual(failing.state.statuses.map((status) => [status.state, status.description]), [['pending', SETTLING_DESCRIPTION], ['failure', FOLLOW_UP_RETRY]]);
  assert.deepEqual(pendingFollowUpHeads(failing.state.notes, 9), [HEAD]);
  // and an earlier head's pending filing that cannot be completed blocks this head's clearance too
  const owed = fakeGitHub({ pr });
  owed.state.fail.createIssue = 2;
  await assert.rejects(fileDeferredFindings(owed.client, pr, 'd'.repeat(40), [finding({ head: 'd'.repeat(40), p: 2, id: 104 })]));
  await assert.rejects(settleFinalCodexEvidence(owed.client, pr, HEAD), /issues API down/u);
  assert.deepEqual(owed.state.statuses.map((status) => status.state), ['pending', 'failure']);
  // a transient evidence read failure is the same retryable state
  const unreadable = { ...fakeGitHub({ pr }).client };
  const writes = [];
  unreadable.setStatus = async (sha, statusState, description) => { writes.push([statusState, description]); };
  unreadable.reviewComments = async () => { throw new Error('GitHub 502'); };
  await assert.rejects(settleFinalCodexEvidence(unreadable, pr, HEAD), /502/u);
  assert.deepEqual(writes.at(-1), ['failure', FOLLOW_UP_RETRY]);
  // the recovery path republishes success only after the settlement returned clear — never before it
  const { readFile } = await import('node:fs/promises');
  const gate = await readFile(new URL('./autonomous-review-gate.mjs', import.meta.url), 'utf8');
  const recovery = gate.slice(gate.indexOf('export async function ensureTerminalReviewState'), gate.indexOf('async function waitForRequiredChecks'));
  const settle = recovery.indexOf('await settleFinalCodexEvidence(');
  assert.ok(settle > 0);
  assert.doesNotMatch(recovery.slice(0, settle), /client\.setStatus\(\s*expectedHead,\s*'success'|publishSettledSuccess\(/u, 'no success is written before the settlement');
  assert.match(recovery.slice(settle), /await publishSettledSuccess\(/u, 'the withdrawn success is always republished after it');
});

test('Codex 4226684328 — a substantive review body is deferred alongside its review\'s inline findings; a bare summary is not', () => {
  const summary = '### 💡 Codex Review\n\nHere are some automated review suggestions for this pull request.\n\n**Reviewed commit:** `cccccccccc`\n\n<details> <summary>About Codex in GitHub</summary>\n\nCodex has been enabled.\n</details>';
  const review = (body) => ({ id: 500, user: { login: CODEX }, commit_id: HEAD, state: 'COMMENTED', body, submitted_at: '2026-10-08T00:00:30Z' });
  const inline = { ...finding({ p: 2, id: 501 }), pull_request_review_id: 500 };
  const run = (body) => classifyCodexState({
    expectedHead: HEAD, readyAt: '2026-10-08T00:00:00Z', deadline: '2026-10-08T01:00:00Z', now: '2026-10-08T00:01:00Z',
    comments: [inline], reviews: [review(body)], reactions: [],
    cap: { reached: true, changedLines: changedLinesFromFiles(FILES) },
  });
  const substantive = run(`${summary}\n\nAlso: the retry loop in sync.ts never terminates.`);
  assert.equal(substantive.state, 'clear');
  assert.deepEqual(substantive.deferred.map((item) => item.id), [501, 500], 'the review body is a finding of its own');
  const bare = run(summary);
  assert.deepEqual(bare.deferred.map((item) => item.id), [501], 'a summary of the inline findings adds none');
  // Codex 4229506031 — a finding inside a <details> of its own is review text, not the About-Codex boilerplate
  const tucked = run(`${summary}\n\n<details><summary>Additional finding</summary>\n\nThe lease is never released.\n</details>`);
  assert.deepEqual(tucked.deferred.map((item) => item.id), [501, 500]);
});

test('Codex 4229881000 — the evidence is read again after filing: a finding that lands meanwhile is settled, never merged past', async () => {
  const rounds = [finding({ head: 'a'.repeat(40), id: 110 }), finding({ head: 'b'.repeat(40), id: 111 })];
  const pr = { number: 9, html_url: 'u', changed_files: 2 };
  const during = (extra) => {
    const run = fakeGitHub({ comments: [...rounds, finding({ p: 2, id: 112 })], pr });
    const create = run.client.createIssue;
    let added = false;
    run.client.createIssue = async (issue) => {
      const made = await create(issue);
      if (!added && extra) { run.state.comments.push(extra); added = true; }
      return made;
    };
    return run;
  };
  // a changed-line P1 arrives while the follow-up issue is being written: it blocks
  const blocker = during(finding({ p: 1, id: 113 }));
  const blocked = await settleFinalCodexEvidence(blocker.client, pr, HEAD);
  assert.equal(blocked.state, 'changes_required');
  assert.equal(blocker.state.statuses.some((status) => status.state === 'success'), false);
  // a deferrable one arrives instead: it is filed too before the head can clear
  const later = during(finding({ p: 2, id: 114 }));
  const cleared = await settleFinalCodexEvidence(later.client, pr, HEAD);
  assert.equal(cleared.state, 'clear');
  assert.deepEqual(cleared.deferred.map((item) => item.id).sort(), [112, 114]);
  assert.match(later.listed(800), /discussion_r114/u);
  // evidence that never stops changing does not clear: the retryable follow-up failure
  const churn = fakeGitHub({ comments: [...rounds, finding({ p: 2, id: 115 })], pr });
  const create = churn.client.createIssueComment;
  let next = 200;
  churn.client.createIssueComment = async (number, body) => {
    const made = await create(number, body);
    churn.state.comments.push(finding({ p: 2, id: next++ }));
    return made;
  };
  await assert.rejects(settleFinalCodexEvidence(churn.client, pr, HEAD), /kept changing/u);
  assert.deepEqual(churn.state.statuses.at(-1), { sha: HEAD, state: 'failure', description: FOLLOW_UP_RETRY });
});

test('Codex 4229881007 — an inline comment and a review that share a numeric id are two findings', () => {
  const comment = { ...finding({ p: 2, id: 77 }) };
  const review = { id: 77, user: { login: CODEX }, commit_id: HEAD, body: 'Review-level finding', html_url: 'https://github.com/o/r/pull/9#pullrequestreview-77' };
  assert.equal(unionDeferred([comment], [review]).length, 2);
  assert.equal(unionDeferred([comment], [{ ...comment }]).length, 1, 'the same finding read twice is still one');
});

test('Codex 4229880987 — no write after a gate-written pending status can leave it standing', async () => {
  const pr = { number: 9, html_url: 'u', state: 'open', draft: false, head: { sha: HEAD, repo: { full_name: 'o/r' } }, base: { ref: 'main', repo: { full_name: 'o/r' } } };
  // the record succeeds, then the verdict's own status write fails: the retryable failure replaces "recording"
  const run = fakeGitHub({ pr });
  const setStatus = run.client.setStatus;
  let failVerdict = true;
  run.client.setStatus = async (sha, statusState, description) => {
    if (statusState === 'failure' && description === 'review: 1 blocking' && failVerdict) { failVerdict = false; throw new Error('GitHub 502'); }
    return setStatus(sha, statusState, description);
  };
  await assert.rejects(publishBlockingVerdict(run.client, pr, HEAD, { description: 'review: 1 blocking', deferred: [finding({ p: 2, id: 120 })] }), /502/u);
  assert.deepEqual(run.state.statuses.at(-1), { sha: HEAD, state: 'failure', description: FOLLOW_UP_RETRY });
  assert.deepEqual(pendingFollowUpHeads(run.state.notes, 9), [HEAD], 'the record it made stays recoverable');
  // and the success that ends a settlement is guarded the same way
  const success = fakeGitHub({ pr });
  const write = success.client.setStatus;
  success.client.setStatus = async (sha, statusState, description) => {
    if (statusState === 'success') throw new Error('GitHub 502');
    return write(sha, statusState, description);
  };
  await assert.rejects(publishSettledSuccess(success.client, pr, HEAD, 'review: clean'), /502/u);
  assert.deepEqual(success.state.statuses.at(-1), { sha: HEAD, state: 'failure', description: FOLLOW_UP_RETRY });
  // every success write in the gate goes through it
  const { readFile } = await import('node:fs/promises');
  const gate = await readFile(new URL('./autonomous-review-gate.mjs', import.meta.url), 'utf8');
  // (the only other success write is settleRecoveryRequest's, on its own recovery-request context)
  const direct = gate.slice(0, gate.indexOf('export function publishSettledSuccess'));
  assert.doesNotMatch(direct.slice(direct.indexOf('export async function ensureTerminalReviewState')), /client\.setStatus\(\s*expectedHead,\s*'success'/u);
  assert.equal([...gate.matchAll(/await publishSettledSuccess\(/gu)].length, 2, 'the ordinary path and recovery');
});

// #1254 (Jagrut's choice, #1094 6564512390) — the gate passes Codex's review-state record to the classifier at both
// places that can clear a head: the poll (reviewAttempt) and the verification re-read before success
// (reclassifyCurrentCodexEvidence). The record is the only evidence here: no review, comment or +1.
function recordClient({ status = 'completed', head = HEAD } = {}) {
  const pullRequest = {
    number: 9, state: 'open', changed_files: 1,
    head: { sha: HEAD, ref: 'claude/unit', repo: { full_name: 'JagPat/PMCvitan' } },
    base: { ref: 'main', repo: { full_name: 'JagPat/PMCvitan' } },
  };
  const record = { code_review: { commit_sha: head, has_any_findings: true, has_unresolved_findings: false, status },
    security_review: { commit_sha: null, has_any_findings: null, has_unresolved_findings: null, status: null } };
  // the poll reads the pull request four times before its first evidence read; any later read answers closed, so a
  // poll that does not clear on its first read ends as `superseded` instead of waiting out the review deadline
  let reads = 0;
  return {
    pullRequest: async () => { reads += 1; return reads <= 4 ? pullRequest : { ...pullRequest, state: 'closed' }; },
    setDraft: async () => pullRequest,
    updateStickyComment: async () => {},
    pullRequestFiles: async () => [],
    reviews: async () => [],
    reviewComments: async () => [],
    reactions: async () => [],
    issueComments: async () => [{ user: { login: CODEX }, created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
      body: `<!-- codex-pull-request-review-summary -->\n<!-- codex-review-state:v1 ${JSON.stringify(record)} -->` }],
  };
}

test('#1254 — a clean exact-head record alone clears the poll and the verification re-read', async () => {
  const readyAt = new Date(Date.now() - 60_000).toISOString();
  const polled = await reviewAttempt(recordClient(), { number: 9 }, HEAD, 1, readyAt);
  assert.equal(polled.state, 'clear');
  assert.equal(polled.detail, 'Codex completed this exact head with no unresolved findings');
  const verified = await reclassifyCurrentCodexEvidence(recordClient(), 9, HEAD, readyAt);
  assert.equal(verified.state, 'clear');
});

test('#1254 — a record back in progress at the verification re-read is not clear, so no success is published', async () => {
  const readyAt = new Date(Date.now() - 60_000).toISOString();
  for (const client of [recordClient({ status: 'in_progress' }), recordClient({ head: 'd'.repeat(40) })]) {
    const verified = await reclassifyCurrentCodexEvidence(client, 9, HEAD, readyAt);
    assert.equal(verified.state, 'pending');
  }
  // the orchestrator publishes success only on a `clear` re-read; anything else is a blocking verdict
  const { readFile } = await import('node:fs/promises');
  const gate = await readFile(new URL('./autonomous-review-gate.mjs', import.meta.url), 'utf8');
  assert.match(gate, /const verifiedResult = await reclassifyCurrentCodexEvidence\([\s\S]*?if \(verifiedResult\.state !== 'clear'\) \{[\s\S]*?publishRetryableHold\(/u);
});

// G2 (#1094 6565074822) — Codex's REAL record for a head it commented on is `completed` with has_unresolved_findings:
// true (every sampled PR with current-head Codex findings: #1270, #1269, #1267, #1262, #1261, #1255, #1232). That is no
// hold: the findings are visible to the gate. Only a same-head run still going (or security findings) holds, and a
// hold is a retryable non-success everywhere: the poll, the cap deferral, the settlement and the recovery.
const codexRecord = (code) => ({ user: { login: CODEX }, created_at: '2026-10-08T00:00:40Z', updated_at: '2026-10-08T00:00:40Z',
  body: `<!-- codex-review-state:v1 ${JSON.stringify({ code_review: { commit_sha: HEAD, has_any_findings: true, ...code }, security_review: { commit_sha: null, has_any_findings: null, has_unresolved_findings: null, status: null } })} -->` });
const doneWithFindings = codexRecord({ has_unresolved_findings: true, status: 'completed' });
const stillRunning = codexRecord({ has_any_findings: null, has_unresolved_findings: null, status: 'running' });

test('G2 — past the cap: Codex\'s real record still defers (PROBE-A); a running same-head record holds', () => {
  const base = { expectedHead: HEAD, readyAt: '2026-10-08T00:00:00Z', deadline: '2026-10-08T01:00:00Z', now: '2026-10-08T00:01:00Z',
    comments: [finding({ p: 2, id: 60 })], reviews: [], cap: { reached: true, changedLines: changedLinesFromFiles(FILES) } };
  const withRecord = classifyCodexState({ ...base, issueComments: [doneWithFindings] });
  assert.equal(withRecord.state, 'clear');
  assert.deepEqual(withRecord.deferred.map((f) => f.id), [60]);
  assert.equal(classifyCodexState({ ...base, now: '2026-10-08T01:00:01Z', issueComments: [doneWithFindings] }).state, 'clear');
  const held = classifyCodexState({ ...base, issueComments: [stillRunning] });
  assert.equal(held.state, 'pending');
  assert.equal(held.held, true);
  assert.equal(classifyCodexState({ ...base, now: '2026-10-08T01:00:01Z', issueComments: [stillRunning] }).state, 'timed_out');
  // a blocking finding still blocks, record or not
  assert.equal(classifyCodexState({ ...base, comments: [finding()], issueComments: [stillRunning] }).state, 'changes_required');
});

test('G2 — PROBE-B: a stored failure the cap would defer is re-judged with Codex\'s real record; a running one answers held', async () => {
  const rounds = [finding({ head: 'a'.repeat(40), id: 50 }), finding({ head: 'b'.repeat(40), id: 51 })];
  const client = (issueComments) => ({ reviews: async () => [], reviewComments: async () => [...rounds, finding({ p: 2, id: 52 })], pullRequestFiles: async () => FILES, issueComments: async () => issueComments });
  const failure = { context: 'codex-current-head', state: 'failure', description: 'review: 1 current-head Codex finding' };
  assert.equal(await capDefersStoredFailure(client([doneWithFindings]), { number: 9, changed_files: 2 }, HEAD, failure), true);
  assert.equal(await capDefersStoredFailure(client([]), { number: 9, changed_files: 2 }, HEAD, failure), true);
  assert.equal(await capDefersStoredFailure(client([stillRunning]), { number: 9, changed_files: 2 }, HEAD, failure), 'held');
});

test('G2 — PROBE-C: the settlement files a deferrable finding beside Codex\'s real record; a running record is a retryable hold', async () => {
  const earlier = [finding({ head: 'a'.repeat(40), id: 1 }), finding({ head: 'b'.repeat(40), id: 2 })];
  const settle = async (record) => {
    const fake = fakeGitHub({ comments: [...earlier, finding({ p: 2, id: 3 })] });
    const own = fake.client.issueComments;
    fake.client.issueComments = async (number) => [...(await own(number)), ...(number === 9 ? [record] : [])];
    return { ...fake, settled: await settleFinalCodexEvidence(fake.client, { number: 9 }, HEAD) };
  };
  const clean = await settle(doneWithFindings);
  assert.equal(clean.settled.state, 'clear');
  assert.match(clean.listed(clean.settled.followUp), /discussion_r3/u, 'the settlement files the deferrable finding before a success');
  // Codex 4437688608 — the settlement reads the record too: a same-head run still going is never "nothing to file"
  const held = await settle(stillRunning);
  assert.equal(held.settled.state, 'changes_required');
  assert.equal(held.settled.retryable, true);
  assert.equal(held.settled.detail, `review: ${CODEX_RUN_HELD_DETAIL}`);
  assert.equal(isRetryableReviewFailureDescription(held.settled.detail), true);
  assert.deepEqual(held.state.statuses.map((s) => s.state), ['pending'], 'no success, and nothing filed while held');
  assert.equal(held.state.issues.length, 0);
  // with nothing deferrable either, a held head is still no clear
  const quiet = fakeGitHub({ comments: [] });
  quiet.client.issueComments = async () => [stillRunning];
  const quietSettled = await settleFinalCodexEvidence(quiet.client, { number: 9 }, HEAD);
  assert.equal(quietSettled.retryable, true);
  quiet.client.issueComments = async () => [];
  assert.equal((await settleFinalCodexEvidence(quiet.client, { number: 9 }, HEAD)).state, 'clear');
});

test('G2 — the final read takes Codex\'s record without reactions, and reports a hold', async () => {
  const reads = [];
  const client = {
    reviews: async () => { reads.push('reviews'); return []; },
    reviewComments: async () => { reads.push('comments'); return []; },
    reactions: async () => { reads.push('reactions'); return []; },
    issueComments: async () => { reads.push('issueComments'); return [stillRunning]; },
    pullRequestFiles: async () => FILES,
  };
  const evidence = await finalCodexEvidence(client, { number: 9, changed_files: 2 }, HEAD);
  assert.equal(evidence.held, true);
  assert.equal(evidence.state, 'pending');
  assert.ok(!reads.includes('reactions'));
  assert.equal(reads.filter((r) => r !== 'pullRequestFiles').at(-1), 'issueComments');
  // the snapshot read alone still reads no record (the convergence and lifecycle readers ask for it: Codex 4438607048)
  reads.length = 0;
  const snapshot = await readCodexEvidence(client, 9);
  assert.equal(snapshot.issueComments, undefined);
  assert.ok(!reads.includes('issueComments'));
});

test('G2 gap 1 — recovery of a stored findings failure on a held head hands it to the ordinary review (no status preserved)', async () => {
  const rounds = [finding({ head: 'a'.repeat(40), id: 50 }), finding({ head: 'b'.repeat(40), id: 51 })];
  const pr = { number: 9, html_url: 'u', state: 'open', draft: false, changed_files: 2, body: '<!-- correction-owner: claude -->', head: { sha: HEAD, ref: 'b', repo: { full_name: 'o/r' } }, base: { ref: 'main', repo: { full_name: 'o/r' } } };
  const { client, state } = fakeGitHub({ comments: [...rounds, finding({ p: 2, id: 52 })], pr });
  client.issueComments = async () => [stillRunning];
  const failure = { id: 1, context: 'codex-current-head', state: 'failure', description: 'review: 1 current-head Codex finding' };
  // false: the ordinary review runs (its pending status replaces the stored failure; its poll holds until the run
  // ends, then defers and files). A hold published over the stored failure would never be re-dispatched (D2/D3)
  assert.equal(await ensureTerminalReviewState(client, pr, HEAD, failure, [failure]), false);
  assert.deepEqual(state.statuses, []);
  assert.ok(!state.log.includes('draft:true'));
});

test('Codex 4438607038 — a tokened success over a latched failure is withdrawn while the same-head run is held', async () => {
  const rounds = [finding({ head: 'a'.repeat(40), id: 50 }), finding({ head: 'b'.repeat(40), id: 51 })];
  const pr = { number: 9, html_url: 'u', state: 'open', draft: false, changed_files: 2, body: '<!-- correction-owner: claude -->', head: { sha: HEAD, ref: 'b', repo: { full_name: 'o/r' } }, base: { ref: 'main', repo: { full_name: 'o/r' } } };
  const { client, state } = fakeGitHub({ comments: [...rounds, finding({ p: 2, id: 52 })], pr });
  client.issueComments = async () => [stillRunning];
  const latched = { id: 1, context: 'codex-current-head', state: 'failure', description: 'review: 1 current-head Codex finding' };
  const success = { id: 2, context: 'codex-current-head', state: 'success', description: 'Codex approved this exact head [wi:none]' };
  assert.equal(await ensureTerminalReviewState(client, pr, HEAD, success, [success, latched]), true);
  assert.deepEqual(state.statuses.map((s) => [s.state, s.description]), [['failure', 'review: current-head Codex finding latched during recovery']]);
  assert.ok(state.log.includes('draft:true'));
  // the failure it leaves is one the cap's re-judging reads, so once the run ends a later recovery still defers
  client.issueComments = async () => [doneWithFindings];
  assert.equal(await capDefersStoredFailure(client, pr, HEAD, state.statuses[0]), true);
});

test('Codex 4438607043 — past the cap, a security stop carries the deferrable findings; a hold files none', () => {
  const securityRecord = { ...doneWithFindings, body: doneWithFindings.body.replace('"security_review":{"commit_sha":null,"has_any_findings":null,"has_unresolved_findings":null,"status":null}', `"security_review":{"commit_sha":"${HEAD}","has_any_findings":true,"has_unresolved_findings":true,"status":"completed"}`) };
  assert.notEqual(securityRecord.body, doneWithFindings.body);
  const base = { expectedHead: HEAD, readyAt: '2026-10-08T00:00:00Z', deadline: '2026-10-08T01:00:00Z', now: '2026-10-08T00:01:00Z',
    comments: [finding({ p: 2, id: 70 })], reviews: [], cap: { reached: true, changedLines: changedLinesFromFiles(FILES) } };
  const security = classifyCodexState({ ...base, issueComments: [securityRecord] });
  assert.equal(security.state, 'changes_required');
  assert.equal(security.detail, CODEX_SECURITY_FINDINGS_DETAIL);
  assert.deepEqual(security.deferred.map((f) => f.id), [70]);
  assert.equal(classifyCodexState({ ...base, issueComments: [stillRunning] }).deferred, undefined);
});

test('G2 gap 3 (PROBE-H) — a run that starts while the deferred findings are filed holds the settlement (no success)', async () => {
  const earlier = [finding({ head: 'a'.repeat(40), id: 1 }), finding({ head: 'b'.repeat(40), id: 2 })];
  const fake = fakeGitHub({ comments: [...earlier, finding({ p: 2, id: 3 })] });
  let record = [doneWithFindings];
  const own = fake.client.issueComments;
  fake.client.issueComments = async (number) => [...(await own(number)), ...(number === 9 ? record : [])];
  const create = fake.client.createIssue;
  fake.client.createIssue = async (issue) => { record = [stillRunning]; return create(issue); };
  const settled = await settleFinalCodexEvidence(fake.client, { number: 9 }, HEAD);
  assert.equal(fake.state.issues.length, 1, 'the deferred finding was filed');
  assert.equal(settled.state, 'changes_required', 'the re-read after the filing is held');
  assert.equal(settled.retryable, true);
  assert.equal(settled.detail, `review: ${CODEX_RUN_HELD_DETAIL}`);
});

test('G2 gap 2 — security findings settle as a non-retryable finding a correction answers; a run still going opens no lease', async () => {
  const { correctionReasonFor } = await import('./correction-lease.mjs');
  const securityRecord = { ...doneWithFindings, body: doneWithFindings.body.replace('"security_review":{"commit_sha":null,"has_any_findings":null,"has_unresolved_findings":null,"status":null}', `"security_review":{"commit_sha":"${HEAD}","has_any_findings":true,"has_unresolved_findings":true,"status":"completed"}`) };
  assert.notEqual(securityRecord.body, doneWithFindings.body);
  const quiet = fakeGitHub({ comments: [] });
  quiet.client.issueComments = async () => [securityRecord];
  const settled = await settleFinalCodexEvidence(quiet.client, { number: 9 }, HEAD);
  assert.equal(settled.state, 'changes_required');
  assert.equal(settled.retryable, false);
  const status = (description) => ({ context: 'codex-current-head', state: 'failure', description });
  // Stage 1 probe I — published as a terminal `review:` failure on the ordinary path and the success recovery alike
  // (both publish `settled.detail`), so recovery and the authorizer can classify it
  assert.equal(settled.detail, `review: ${CODEX_SECURITY_FINDINGS_DETAIL}`);
  assert.equal(isTerminalReviewStatus(status(settled.detail)), true);
  assert.equal(isTerminalReviewStatus(status(CODEX_SECURITY_FINDINGS_DETAIL)), false, 'unprefixed it is not terminal');
  const { readFile } = await import('node:fs/promises');
  const gate = await readFile(new URL('./autonomous-review-gate.mjs', import.meta.url), 'utf8');
  const recovery = gate.slice(gate.indexOf('export async function ensureTerminalReviewState'), gate.indexOf('async function waitForRequiredChecks'));
  assert.match(recovery, /settled\.state === 'changes_required'\) \{\s*await publishCurrentHeadFinding\(client, finalPolicy\.pullRequest, expectedHead, null, \{\s*detail: settled\.detail,/u);
  assert.equal(isRetryableReviewFailureDescription(`review: ${CODEX_SECURITY_FINDINGS_DETAIL}`), false);
  assert.equal(correctionReasonFor(status(`review: ${CODEX_SECURITY_FINDINGS_DETAIL}`)), 'review');
  assert.equal(correctionReasonFor(status(`review: ${CODEX_RUN_HELD_DETAIL}`)), null);
});

// Codex 4438607048 — a security-only head is a finding-bearing head everywhere a head is counted. Codex's record is
// edited in place, so the gate makes the verdict durable (a workflow-authored marker) and the ONE shared predicate,
// `codexFindingHeads`, counts the heads its markers name.
const SEC_HEAD = '5'.repeat(40);
const COMMENT_HEAD = '6'.repeat(40);
const markerOf = (head, extra = {}) => ({ id: 900, user: { login: 'github-actions[bot]' }, body: securityVerdictMarker(head), ...extra });

test('Codex 4438607048 — the marker: exact body, the workflow token only, one head however many copies', async () => {
  const { FOLLOW_UP_RECORD_AUTHOR } = await import('./review-follow-up.mjs');
  assert.equal(SECURITY_VERDICT_MARKER_AUTHOR, FOLLOW_UP_RECORD_AUTHOR);
  assert.equal(securityVerdictMarker(SEC_HEAD), `<!-- codex-security-verdict: head-${SEC_HEAD} -->\n${CODEX_SECURITY_FINDINGS_DETAIL}`);
  assert.throws(() => securityVerdictMarker('abc'), /full head SHA/u);
  assert.deepEqual(securityVerdictHeads([markerOf(SEC_HEAD), markerOf(SEC_HEAD, { id: 901 })]), [SEC_HEAD], 'a duplicate counts once');
  // forged: another author (Codex itself, a person, another bot) counts nothing
  for (const login of [CODEX, 'JagPat', 'cursor[bot]', 'github-actions']) {
    assert.deepEqual(securityVerdictHeads([markerOf(SEC_HEAD, { user: { login } })]), [], login);
  }
  // and only the exact body: no free text around it, no other detail, no short SHA
  for (const body of [`${securityVerdictMarker(SEC_HEAD)}\n`, `x${securityVerdictMarker(SEC_HEAD)}`, `<!-- codex-security-verdict: head-${SEC_HEAD} -->\nsomething else`,
    `<!-- codex-security-verdict: head-${SEC_HEAD.slice(0, 7)} -->\n${CODEX_SECURITY_FINDINGS_DETAIL}`]) {
    assert.deepEqual(securityVerdictHeads([markerOf(SEC_HEAD, { body })]), [], body);
  }
});

test('Codex 4438607048 — the writer: read, then create only when absent; a failed read writes nothing', async () => {
  const created = [];
  let existing = [];
  const client = { issueComments: async () => existing, createIssueComment: async (number, body) => { created.push([number, body]); } };
  assert.equal(await recordSecurityVerdict(client, { number: 9 }, SEC_HEAD), true);
  assert.deepEqual(created, [[9, securityVerdictMarker(SEC_HEAD)]]);
  existing = [markerOf(SEC_HEAD)];
  assert.equal(await recordSecurityVerdict(client, { number: 9 }, SEC_HEAD), false);
  assert.equal(created.length, 1, 'never a second marker for the same head');
  // a forged copy is not ours: the gate still writes its own
  existing = [markerOf(SEC_HEAD, { user: { login: 'JagPat' } })];
  assert.equal(await recordSecurityVerdict(client, { number: 9 }, SEC_HEAD), true);
  const broken = { issueComments: async () => { throw new Error('GitHub 502'); }, createIssueComment: async () => { created.push('x'); } };
  await assert.rejects(recordSecurityVerdict(broken, { number: 9 }, SEC_HEAD), /GitHub 502/u);
  assert.equal(created.length, 2);
});

test('Codex 4438607048 — publishing a security verdict writes the marker first; a failed write leaves the retryable failure', async () => {
  const { client, state } = fakeGitHub({ comments: [] });
  const markers = [];
  client.createIssueComment = async (number, body) => { state.log.push('marker'); markers.push({ id: 1, user: { login: 'github-actions[bot]' }, body }); };
  client.issueComments = async () => markers;
  await publishBlockingVerdict(client, { number: 9, html_url: 'u' }, HEAD, { description: `review: ${CODEX_SECURITY_FINDINGS_DETAIL}`, security: true });
  assert.deepEqual(securityVerdictHeads(markers), [HEAD]);
  const order = state.log.filter((entry) => entry === 'marker' || entry.startsWith('status:'));
  assert.deepEqual(order, ['status:pending', 'marker', 'status:failure']);
  // another finding's verdict writes none
  const plain = fakeGitHub({ comments: [] });
  plain.client.createIssueComment = async () => { throw new Error('no marker for an ordinary finding'); };
  await publishBlockingVerdict(plain.client, { number: 9, html_url: 'u' }, HEAD, { description: 'review: 1 current-head Codex finding' });
  // a failed marker write: the head is left on the retryable follow-up failure, never on a pending status
  const failing = fakeGitHub({ comments: [] });
  failing.client.issueComments = async () => [];
  failing.client.createIssueComment = async () => { throw new Error('GitHub 502'); };
  await assert.rejects(publishBlockingVerdict(failing.client, { number: 9, html_url: 'u' }, HEAD, { description: `review: ${CODEX_SECURITY_FINDINGS_DETAIL}`, security: true }), /GitHub 502/u);
  const last = failing.state.statuses.at(-1);
  assert.equal(last.state, 'failure');
  assert.equal(isRetryableReviewFailureDescription(last.description), true);
});

test('Codex 4438607048 — every finding-head count counts a security-only head (table across the callers)', async () => {
  const { assessConvergence } = await import('./review-efficiency.mjs');
  const { assessRestructure, observeReviewLifecycle } = await import('./review-lifecycle.mjs');
  const { reviewCapState } = await import('./review-cap.mjs');
  const { enforceReviewConvergence, reportReviewLifecycle } = await import('./autonomous-review-gate.mjs');
  const comments = [finding({ head: COMMENT_HEAD, id: 801 })];
  const counts = {
    'review cap (findingRoundHeads)': (issueComments) => reviewCapState({ expectedHead: HEAD, comments, reviews: [], files: FILES, issueComments }).priorRounds,
    'convergence (assessConvergence)': (issueComments) => assessConvergence({ comments, reviews: [], headMessage: 'fix: x', changedFiles: [], issueComments }).findingHeadCount,
    'lifecycle (assessRestructure)': (issueComments) => assessRestructure({ comments, reviews: [], pullRequestFiles: [], body: '', issueComments }).findingHeadCount,
    'lifecycle (observeReviewLifecycle)': (issueComments) => observeReviewLifecycle({ comments, reviews: [], issueComments }).findingHeadCount,
    'gate convergence (enforceReviewConvergence)': async (issueComments) => {
      const pr = { number: 9, html_url: 'u', state: 'open', draft: false, changed_files: 2, body: '', head: { sha: HEAD, ref: 'b', repo: { full_name: 'o/r' } }, base: { ref: 'main', repo: { full_name: 'o/r' } } };
      const { client } = fakeGitHub({ comments, pr });
      client.issueComments = async () => issueComments;
      return (await enforceReviewConvergence(client, pr, HEAD)).findingHeadCount;
    },
    'gate lifecycle (reportReviewLifecycle)': async (issueComments) => {
      const { client } = fakeGitHub({ comments });
      client.issueComments = async () => issueComments;
      return (await reportReviewLifecycle(client, { number: 9 }, () => {})).findingHeadCount;
    },
  };
  for (const [caller, count] of Object.entries(counts)) {
    assert.equal(await count([]), 1, `${caller}: the comment head alone`);
    assert.equal(await count([markerOf(SEC_HEAD)]), 2, `${caller}: the security-only head counts`);
    assert.equal(await count([markerOf(SEC_HEAD, { user: { login: 'JagPat' } })]), 1, `${caller}: a forged marker counts nothing`);
    assert.equal(await count([markerOf(SEC_HEAD), markerOf(SEC_HEAD, { id: 901 })]), 2, `${caller}: a duplicate counts once`);
  }
  // and no production caller can count without the markers: every call of the predicate passes the issue
  // comments (the handoff's two lease reads, the cap's round heads, the gate and the lifecycle readers)
  const { readFile } = await import('node:fs/promises');
  const files = ['autonomous-review-gate.mjs', 'autonomous-handoff.mjs', 'review-cap.mjs', 'review-efficiency.mjs', 'review-lifecycle.mjs', 'completion-report.mjs'];
  // the arguments of each call, split at top-level commas (balanced brackets); a member call (`x.f(`) is not the
  // predicate, a spread (`...f(`) is
  const callArgs = (source, at) => {
    const args = [];
    let depth = 0;
    let current = '';
    for (let i = at; i < source.length; i += 1) {
      const ch = source[i];
      if ('([{'.includes(ch)) depth += 1;
      if (')]}'.includes(ch)) {
        if (depth === 0) { if (current.trim()) args.push(current.trim()); return args; }
        depth -= 1;
      }
      if (ch === ',' && depth === 0) { args.push(current.trim()); current = ''; } else current += ch;
    }
    throw new Error('unbalanced call');
  };
  let calls = 0;
  let roundCalls = 0;
  for (const file of files) {
    const source = await readFile(new URL(`./${file}`, import.meta.url), 'utf8');
    for (const match of source.matchAll(/(?<!\w|(?<!\.)\.)(codexFindingHeads|findingRoundHeads|reviewCapState|observeReviewLifecycle|assessRestructure|assessConvergence|reviewRounds)\(/gu)) {
      const line = source.slice(source.lastIndexOf('\n', match.index) + 1, match.index);
      if (/function\s*$|\/\/|\*/u.test(line)) continue;
      const args = callArgs(source, match.index + match[0].length);
      if (match[1] === 'codexFindingHeads') {
        calls += 1;
        assert.equal(args.length, 3, `${file}: codexFindingHeads(${args.join(', ')}) passes the issue comments`);
      } else if (match[1] === 'findingRoundHeads') {
        roundCalls += 1;
        assert.equal(args.length, 3, `${file}: findingRoundHeads(${args.join(', ')}) passes the issue comments`);
      } else {
        assert.match(args.join(','), /issueComments/u, `${file}: ${match[1]}(...) passes the issue comments`);
      }
    }
  }
  assert.equal(calls, 7, 'the seven production calls of the predicate (gate convergence, handoff x2, cap, lifecycle x2, convergence)');
  // G2 gap 3 — and the completion report's round count (the eighth caller, through findingRoundHeads)
  assert.equal(roundCalls, 2, 'findingRoundHeads in production: the cap and the completion report');
});

test('Codex 4438607048 — the gate\'s cap reads count a security-only head as a round (final evidence and the guard)', async () => {
  const { guardAgainstCurrentHeadFinding } = await import('./autonomous-review-gate.mjs');
  // one earlier comment round plus one security-only head is the cap (REVIEW_ROUND_CAP rounds before this head)
  const rounds = [finding({ head: COMMENT_HEAD, id: 50 })];
  const failure = { context: 'codex-current-head', state: 'failure', description: 'review: 1 current-head Codex finding' };
  const client = (issueComments) => ({ reviews: async () => [], reviewComments: async () => [...rounds, finding({ p: 2, id: 52 })], pullRequestFiles: async () => FILES, issueComments: async () => issueComments });
  assert.equal(await capDefersStoredFailure(client([markerOf(SEC_HEAD)]), { number: 9, changed_files: 2 }, HEAD, failure), true, 'past the cap: deferred');
  assert.equal(await capDefersStoredFailure(client([]), { number: 9, changed_files: 2 }, HEAD, failure), false, 'under the cap without the marker');
  // the guard reads the markers itself (its snapshot reads no record)
  const pr = { number: 9, html_url: 'u', state: 'open', draft: false, changed_files: 2, body: '<!-- correction-owner: claude -->', head: { sha: HEAD, ref: 'b', repo: { full_name: 'o/r' } }, base: { ref: 'main', repo: { full_name: 'o/r' } } };
  const capped = fakeGitHub({ comments: [...rounds, finding({ p: 2, id: 53 })], pr });
  capped.client.issueComments = async () => [markerOf(SEC_HEAD)];
  assert.equal(await guardAgainstCurrentHeadFinding(capped.client, pr, HEAD, null), null, 'past the cap a P2 is no blocker');
  const under = fakeGitHub({ comments: [...rounds, finding({ p: 2, id: 54 })], pr });
  under.client.issueComments = async () => [];
  assert.notEqual(await guardAgainstCurrentHeadFinding(under.client, pr, HEAD, null), null, 'under the cap it blocks');
});

// G2 (#1280 round 1, Stage 1 gap-check) — Codex's review-state record as the merge reads it last
const recordFor = (code, security = { commit_sha: null, has_any_findings: null, has_unresolved_findings: null, status: null }) => ({
  id: 700, user: { login: CODEX }, created_at: '2026-10-08T00:00:40Z',
  body: `<!-- codex-review-state:v1 ${JSON.stringify({ code_review: { commit_sha: HEAD, ...code }, security_review: security })} -->` });
const RUNNING_RECORD = recordFor({ has_any_findings: null, has_unresolved_findings: null, status: 'running' });
const SECURITY_RECORD = recordFor({ has_any_findings: false, has_unresolved_findings: false, status: 'completed' },
  { commit_sha: HEAD, has_any_findings: true, has_unresolved_findings: true, status: 'completed' });

test('G2 gap 1 — a merge the review-state record refuses never leaves the head green', async () => {
  const { completeReviewedPullRequest, REQUIRED_CHECKS } = await import('./autonomous-review-gate.mjs');
  const pr = { number: 9, html_url: 'u', state: 'open', draft: false, head: { sha: HEAD, repo: { full_name: 'JagPat/PMCvitan' } }, base: { ref: 'main', sha: 'b'.repeat(40), repo: { full_name: 'JagPat/PMCvitan' } } };
  const run = (records) => {
    const fake = fakeGitHub({ pr });
    const green = { context: 'codex-current-head', state: 'success', description: 'review: Codex found no blocking issue on this exact head [wi:none]' };
    Object.assign(fake.client, {
      repository: 'JagPat/PMCvitan',
      statuses: async () => [green],
      checkRuns: async () => REQUIRED_CHECKS.map((name) => ({ name, status: 'completed', conclusion: 'success' })),
      issueComments: async (number) => (typeof records === 'function' ? records() : [...records, ...fake.state.notes.filter((comment) => comment.issue === number)]),
      mergeExactHead: async () => { fake.state.log.push('merge'); return { merged: true }; },
      enableAutoMerge: async () => { fake.state.log.push('auto-merge'); },
      dispatchHandoff: async () => {},
      updateStickyComment: async (number, body) => { fake.state.log.push('sticky'); fake.state.stickies = [...(fake.state.stickies ?? []), body]; },
    });
    return fake;
  };
  const stickyState = (fake) => /- \*\*State:\*\* `([a-z_]+)`/u.exec(fake.state.stickies?.at(-1) ?? '')?.[1];
  // a same-head run still going: the retryable hold replaces the green, the PR is drafted, nothing merges
  const held = run([RUNNING_RECORD]);
  assert.equal(await completeReviewedPullRequest(held.client, pr, HEAD), 'review_refused');
  assert.equal(held.state.statuses.at(-1).state, 'failure');
  assert.equal(held.state.statuses.at(-1).description, `review: ${CODEX_RUN_HELD_DETAIL}`);
  assert.equal(isRetryableReviewFailureDescription(held.state.statuses.at(-1).description), true);
  assert.ok(held.state.log.includes('draft:true') && !held.state.log.includes('merge'));
  assert.deepEqual(securityVerdictHeads(held.state.notes), [], 'a hold writes no security marker');
  assert.equal(stickyState(held), 'review_retry', 'the review_clean sticky is replaced, never left clean');
  // security findings: the blocking verdict, with its marker before the failure; not retryable (a correction answers it)
  const security = run([SECURITY_RECORD]);
  assert.equal(await completeReviewedPullRequest(security.client, pr, HEAD), 'review_refused');
  assert.equal(security.state.statuses.at(-1).state, 'failure');
  assert.equal(security.state.statuses.at(-1).description, `review: ${CODEX_SECURITY_FINDINGS_DETAIL}`);
  assert.equal(isRetryableReviewFailureDescription(security.state.statuses.at(-1).description), false);
  assert.deepEqual(securityVerdictHeads(security.state.notes), [HEAD]);
  const order = security.state.log.filter((entry) => entry === 'record' || entry.startsWith('status:') || entry === 'merge');
  assert.deepEqual(order, ['status:pending', 'record', 'status:failure']);
  // published as a finding is (Stage 1's re-check of b30bea7b): the changes_required sticky with the correction notice
  assert.equal(stickyState(security), 'changes_required');
  assert.match(security.state.stickies.at(-1), new RegExp(CODEX_SECURITY_FINDINGS_DETAIL, 'u'));
  // an unreadable record at the merge's last read: the retryable hold replaces the green, then the run fails
  let reads = 0;
  const unreadable = run(() => { reads += 1; throw new Error('GitHub 502'); });
  await assert.rejects(completeReviewedPullRequest(unreadable.client, pr, HEAD), /GitHub 502/u);
  assert.equal(reads, 1);
  assert.equal(unreadable.state.statuses.at(-1).state, 'failure');
  // its own retryable detail, not the "still running" text (Stage 1's re-check of b30bea7b)
  assert.equal(unreadable.state.statuses.at(-1).description, `review: ${CODEX_RECORD_UNREADABLE_DETAIL}`);
  assert.equal(isRetryableReviewFailureDescription(unreadable.state.statuses.at(-1).description), true);
  assert.ok(!unreadable.state.log.includes('merge'));
  assert.equal(stickyState(unreadable), 'review_retry');
  // after any of these refusals the newest status the gate wrote is never success
  for (const fake of [held, security, unreadable]) assert.notEqual(fake.state.statuses.at(-1).state, 'success');
  // a record with no hold and no security findings merges, writing nothing
  const clean = run([]);
  assert.equal(await completeReviewedPullRequest(clean.client, pr, HEAD), 'merged');
  assert.deepEqual(clean.state.statuses, []);
  assert.equal(clean.state.stickies, undefined, 'a merge writes no sticky here');
  // a recovery request handed in is settled on a refusal, as on any finding or retry
  const settledRuns = [];
  for (const records of [[RUNNING_RECORD], [SECURITY_RECORD]]) {
    const fake = run(records);
    const before = fake.state.statuses.length;
    await completeReviewedPullRequest(fake.client, pr, HEAD, undefined, { recoveryRequest: { status: { context: 'codex-recovery-request' } }, attempt: 1 });
    settledRuns.push(fake.state.statuses.slice(before).some((status) => status.state === 'success' && /^recovery: consumed by /u.test(status.description)));
  }
  assert.deepEqual(settledRuns, [true, true]);
  // and the review path writes no `clear` sticky over a refusal
  const { readFile } = await import('node:fs/promises');
  const gate = await readFile(new URL('./autonomous-review-gate.mjs', import.meta.url), 'utf8');
  const completion = gate.indexOf('const completion = await completeReviewedPullRequest(');
  // the review path hands its recovery request and attempt to the refusal (the finding's settle and sticky)
  assert.match(gate.slice(completion, completion + 300), /finalPolicy\.verdict,\s*\{ recoveryRequest, attempt \},\s*\);/u);
  assert.ok(completion > 0 && gate.indexOf("if (completion === 'review_refused') return;", completion) > completion
    && gate.indexOf("if (completion === 'review_refused') return;", completion) < gate.indexOf("state: 'clear'", completion));
});

test('G2 gap 2 — the security marker is keyed on the structured flag, and the settlement publishes one prefix', async () => {
  const { publishCurrentHeadFinding, reviewDescription } = await import('./autonomous-review-gate.mjs');
  assert.equal(reviewDescription(CODEX_SECURITY_FINDINGS_DETAIL), `review: ${CODEX_SECURITY_FINDINGS_DETAIL}`);
  assert.equal(reviewDescription(`review: ${CODEX_SECURITY_FINDINGS_DETAIL}`), `review: ${CODEX_SECURITY_FINDINGS_DETAIL}`);
  assert.equal(reviewDescription('review: final Codex evidence is timed_out; not merging on it'), 'review: final Codex evidence is timed_out; not merging on it');
  // the settlement's security answer carries the flag, and its detail is what both its publishers write
  const pr = { number: 9, html_url: 'u', state: 'open', draft: false, changed_files: 2, body: '', head: { sha: HEAD, ref: 'b', repo: { full_name: 'o/r' } }, base: { ref: 'main', repo: { full_name: 'o/r' } } };
  const settling = fakeGitHub({ pr });
  settling.client.issueComments = async () => [SECURITY_RECORD];
  const settled = await settleFinalCodexEvidence(settling.client, pr, HEAD);
  assert.equal(settled.state, 'changes_required');
  assert.equal(settled.security, true);
  assert.equal(settled.retryable, false);
  // the ordinary settlement path: publishCurrentHeadFinding with the settlement's detail writes ONE prefix and the marker
  const publishing = fakeGitHub({ pr });
  await publishCurrentHeadFinding(publishing.client, pr, HEAD, null, { detail: settled.detail, attempt: 1, deferred: [], security: settled.security });
  const verdict = publishing.state.statuses.find((status) => status.state === 'failure');
  assert.equal(verdict.description, `review: ${CODEX_SECURITY_FINDINGS_DETAIL}`);
  assert.deepEqual(securityVerdictHeads(publishing.state.notes), [HEAD]);
  // the reviewAttempt path's bare detail gets the same one prefix
  const bare = fakeGitHub({ pr });
  await publishCurrentHeadFinding(bare.client, pr, HEAD, null, { detail: CODEX_SECURITY_FINDINGS_DETAIL, attempt: 1, deferred: [], security: true });
  assert.equal(bare.state.statuses.find((status) => status.state === 'failure').description, `review: ${CODEX_SECURITY_FINDINGS_DETAIL}`);
  assert.deepEqual(securityVerdictHeads(bare.state.notes), [HEAD]);
  // the text alone, without the flag, writes no marker; the flag is what the publisher reads
  const textOnly = fakeGitHub({ pr });
  textOnly.client.createIssueComment = async () => { throw new Error('no marker without the flag'); };
  await publishBlockingVerdict(textOnly.client, pr, HEAD, { description: `review: ${CODEX_SECURITY_FINDINGS_DETAIL}` });
  // every gate path that publishes a changes_required result forwards its flag
  const { readFile } = await import('node:fs/promises');
  const gate = await readFile(new URL('./autonomous-review-gate.mjs', import.meta.url), 'utf8');
  assert.equal([...gate.matchAll(/security: (?:result|verifiedResult|settled)\.security === true/gu)].length, 6, 'the final evidence read, then its publishers: the guard, the review loop, final verification, the settlement, the recovery');
  assert.doesNotMatch(gate, /description === `review: \$\{CODEX_SECURITY_FINDINGS_DETAIL\}`/u);
});
