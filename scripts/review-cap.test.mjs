// Owner decision 2026-10-08 (delivery speed): the review-round cap, the trivial fast lane, the
// focused-unit size target and the completion report.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  blocksUnderCap,
  changedLinesFromFiles,
  findingPriority,
  onChangedLine,
  reviewCapState,
} from './review-cap.mjs';
import { classifyCodexState } from './autonomous-review-state.mjs';
import { assessReviewScope } from './review-efficiency.mjs';
import { completionReport, fileDeferredFindings } from './autonomous-review-gate.mjs';
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
  assert.deepEqual([...lines.get('apps/web/src/a.ts')], [2, 12]);
  assert.equal(lines.get('image.png'), '*');
});

test('onChangedLine honours multi-line anchors and unknown files', () => {
  const lines = changedLinesFromFiles(FILES);
  assert.equal(onChangedLine({ path: 'apps/web/src/a.ts', line: 3 }, lines), false);
  assert.equal(onChangedLine({ path: 'apps/web/src/a.ts', start_line: 1, line: 3 }, lines), true);
  assert.equal(onChangedLine({ path: 'other.ts', line: 2 }, lines), false);
  assert.equal(onChangedLine({ path: 'image.png', line: 99 }, lines), true);
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

test('the completion report carries hours, rounds and changed lines', () => {
  const report = completionReport(
    { created_at: '2026-10-08T00:00:00Z', additions: 120, deletions: 30, changed_files: 4 },
    { rounds: 2, completion: 'merged', now: new Date('2026-10-08T03:30:00Z') },
  );
  assert.match(report, /^<!-- completion-report -->/u);
  assert.match(report, /open to merge: 3\.5/u);
  assert.match(report, /review rounds: 2/u);
  assert.match(report, /Changed lines: 150 \(\+120 \/ −30\) across 4 files/u);
});

const OWNER = '<!-- correction-owner: claude -->';

function scope(body, files, extra = {}) {
  return assessReviewScope(
    { number: 9_999, additions: 40, deletions: 10, changed_files: files.length, body, base: { ref: 'main' }, ...extra },
    { changedFiles: files.map((filename) => ({ filename })), preReviewEnforceAfterPr: 100_000 },
  );
}

test('a trivial web/docs change takes the fast lane', () => {
  const result = scope(`<!-- review-size: trivial -->\n${OWNER}`, ['apps/web/src/Button.tsx', 'docs/x.md']);
  assert.equal(result.state, 'trivial');
  assert.equal(result.allowed, true);
});

test('a trivial claim outside web/docs or over 100 lines is refused', () => {
  const api = scope(`<!-- review-size: trivial -->\n${OWNER}`, ['apps/api/src/x.ts']);
  assert.equal(api.allowed, false);
  assert.match(api.detail, /trivial fast lane/u);
  const big = scope(`<!-- review-size: trivial -->\n${OWNER}`, ['apps/web/src/x.ts'], { additions: 101, deletions: 0 });
  assert.equal(big.allowed, false);
});

test('a live-bug unit over 8 files or 300 lines needs an owner-approved size', () => {
  const files = Array.from({ length: 9 }, (_, i) => `apps/web/src/f${i}.ts`);
  const body = `<!-- review-size: standard -->\n<!-- unit-kind: live-bug -->\n${OWNER}`;
  const over = scope(body, files);
  assert.equal(over.allowed, false);
  assert.match(over.detail, /live-bug unit targets at most 8 files and 300/u);
  const approved = scope(`${body}\nOwner-approved-size: https://github.com/o/r/issues/482#issuecomment-1`, files);
  assert.equal(approved.allowed, true);
  const small = scope(body, files.slice(0, 3), { additions: 250, deletions: 50 });
  assert.equal(small.allowed, true);
});
