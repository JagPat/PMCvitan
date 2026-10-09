import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  FOLLOW_UP_RECORD_AUTHOR,
  fileFollowUp,
  fileFollowUpLines,
  findingIdentity,
  followUpRecords,
  lineIdentity,
  pendingFollowUpHeads,
  reconcilePendingFollowUps,
  renderFollowUpLines,
} from './review-follow-up.mjs';
import { REVIEW_FOLLOW_UP_LABEL } from './review-policy.mjs';

const HEAD_A = 'a'.repeat(40);
const HEAD_B = 'b'.repeat(40);
const PR = { number: 7 };
const URL = 'https://github.com/o/r/pull/7';

const inline = (id, priority, extra = {}) => ({
  id,
  pull_request_review_id: 900,
  path: 'scripts/x.mjs',
  line: 10 + id,
  side: 'RIGHT',
  body: `**<sub><sub>![P${priority} Badge](https://img.shields.io/badge/P${priority}-x)</sub></sub>  Finding ${id}**\n\ndetail`,
  html_url: `${URL}#discussion_r${id}`,
  ...extra,
});
const reviewBody = (id, text = 'A substantive review-level finding') => ({
  id,
  body: `${text}\n\nmore`,
  html_url: `${URL}#pullrequestreview-${id}`,
});

/**
 * An in-memory GitHub: issues and the PR's comments. Every call yields to the event loop first, so two runs
 * started together genuinely interleave. `fail[method] = n` makes the next n calls of that method throw.
 */
function fakeGitHub() {
  const state = { issues: [], comments: [], fail: {}, nextIssue: 1, nextComment: 1, calls: [] };
  const tick = () => new Promise((resolve) => setImmediate(resolve));
  const guard = async (method) => {
    await tick();
    state.calls.push(method);
    if ((state.fail[method] ?? 0) > 0) {
      state.fail[method] -= 1;
      throw new Error(`GitHub ${method} failed (502)`);
    }
  };
  const copy = (value) => JSON.parse(JSON.stringify(value));
  const client = {
    async issuesLabelled(label) {
      await guard('issuesLabelled');
      return copy(state.issues.filter((issue) => issue.labels.includes(label)).sort((a, b) => b.number - a.number));
    },
    async ensureLabel() { await guard('ensureLabel'); },
    async createIssue({ title, body, labels }) {
      await guard('createIssue');
      const issue = { number: state.nextIssue++, title, body, labels, state: 'open', state_reason: null };
      state.issues.push(issue);
      return copy(issue);
    },
    async updateIssueBody(number, body) {
      await guard('updateIssueBody');
      state.issues.find((issue) => issue.number === number).body = body;
    },
    async closeIssue(number) {
      await guard('closeIssue');
      Object.assign(state.issues.find((issue) => issue.number === number), { state: 'closed', state_reason: 'not_planned' });
    },
    async issueComments(number) {
      await guard('issueComments');
      return copy(state.comments.filter((comment) => comment.issue === number));
    },
    async createIssueComment(number, body) {
      await guard('createIssueComment');
      const comment = { id: state.nextComment++, issue: number, body, user: { login: FOLLOW_UP_RECORD_AUTHOR } };
      state.comments.push(comment);
      return copy(comment);
    },
    async updateIssueComment(id, body) {
      await guard('updateIssueComment');
      state.comments.find((comment) => comment.id === id).body = body;
    },
  };
  return { client, state };
}

const issueFor = (state, head) => state.issues.filter((issue) => issue.body.includes(`pr-7 head-${head}`));
const openIssueFor = (state, head) => issueFor(state, head).filter((issue) => issue.state === 'open');
const identitiesIn = (body) => body.split('\n').filter((line) => line.startsWith('- [')).map(lineIdentity);

test('a review body and the inline findings of the same review are distinct, each with its complete anchor', () => {
  const lines = renderFollowUpLines([inline(1, 2), { ...reviewBody(900) }, inline(2, 1, { side: 'LEFT' }), inline(1, 2)]);
  assert.equal(lines.length, 3, 'the repeated inline finding is one line; the review body is its own');
  assert.match(lines[0], /^- \[ \] P2 `scripts\/x\.mjs:11 RIGHT` — Finding 1 \(https:\/\/.*#discussion_r1\)$/u);
  assert.match(lines[1], /^- \[ \] P\? `review-level` — A substantive review-level finding \(https:\/\/.*#pullrequestreview-900\)$/u);
  assert.match(lines[2], /`scripts\/x\.mjs:12 LEFT`/u, 'the side is kept, so a LEFT and a RIGHT finding stay distinct');
  assert.notEqual(lineIdentity(lines[0]), lineIdentity(lines[1]));
});

test('identity is the URL, then kind and id — never the editable line', () => {
  assert.equal(findingIdentity(inline(3, 1)), `${URL}#discussion_r3`);
  assert.equal(findingIdentity({ id: 5, path: 'a', pull_request_review_id: 1 }), 'finding:comment-5');
  assert.equal(findingIdentity({ id: 6, body: 'x' }), 'finding:review-6');
  assert.throws(() => findingIdentity({ body: 'no id' }), /no stable identity/u);
  const [line] = renderFollowUpLines([inline(3, 1)]);
  assert.equal(lineIdentity(line.replace('- [ ]', '- [x]').replace('Finding 3', 'edited')), `${URL}#discussion_r3`);
});

test('a filing records first, files in the head\'s one issue, and marks the record filed', async () => {
  const { client, state } = fakeGitHub();
  const number = await fileFollowUp(client, PR, HEAD_A, [inline(1, 2), reviewBody(901)]);
  assert.equal(number, 1);
  assert.deepEqual(state.calls.slice(0, 2), ['issueComments', 'createIssueComment'], 'recorded before anything is filed');
  assert.ok(state.calls.indexOf('ensureLabel') < state.calls.indexOf('createIssue'), 'Codex 4220739644 — the label exists before an issue carries it');
  const [issue] = state.issues;
  assert.ok(issue.labels.includes(REVIEW_FOLLOW_UP_LABEL));
  assert.match(issue.body, new RegExp(`<!-- review-follow-up: pr-7 head-${HEAD_A} -->`, 'u'));
  assert.deepEqual(identitiesIn(issue.body), [`${URL}#discussion_r1`, `${URL}#pullrequestreview-901`]);
  assert.deepEqual(pendingFollowUpHeads(state.comments, 7), []);
  assert.match(state.comments[0].body, /review-follow-up-filed: pr-7 head-a{40}.*\n.*filed in #1/su);
});

test('a RECORDING failure files nothing and throws — the caller must not clear', async () => {
  const { client, state } = fakeGitHub();
  state.fail.createIssueComment = 1;
  await assert.rejects(fileFollowUp(client, PR, HEAD_A, [inline(1, 2)]), /createIssueComment failed/u);
  assert.equal(state.issues.length, 0);
});

test('a FILING failure throws and leaves the head pending', async () => {
  const { client, state } = fakeGitHub();
  state.fail.createIssue = 1;
  await assert.rejects(fileFollowUp(client, PR, HEAD_A, [inline(1, 2)]), /createIssue failed/u);
  assert.deepEqual(pendingFollowUpHeads(state.comments, 7), [HEAD_A]);
});

test('a new push before the retry: the old head is recovered later, in its OWN issue, as classified on that head', async () => {
  const { client, state } = fakeGitHub();
  state.fail.createIssue = 1;
  await assert.rejects(fileFollowUp(client, PR, HEAD_A, [inline(1, 2), reviewBody(901)]));
  const recordedOnA = followUpRecords(state.comments, 7)[0].lines;

  // the correction moves the head: A's findings are no longer current-head evidence anywhere
  await fileFollowUp(client, PR, HEAD_B, [inline(2, 3)]);
  assert.deepEqual(pendingFollowUpHeads(state.comments, 7), [HEAD_A]);

  const recovered = await reconcilePendingFollowUps(client, PR);
  assert.deepEqual(recovered, [{ head: HEAD_A, issue: 2, findings: 2 }]);
  const [issueA] = openIssueFor(state, HEAD_A);
  assert.deepEqual(issueA.body.split('\n').filter((line) => line.startsWith('- [')), recordedOnA,
    'the lines are exactly those recorded on A — original-head classification and identity');
  assert.deepEqual(identitiesIn(openIssueFor(state, HEAD_B)[0].body), [`${URL}#discussion_r2`]);
  assert.deepEqual(pendingFollowUpHeads(state.comments, 7), []);

  // recovery is idempotent
  assert.deepEqual(await reconcilePendingFollowUps(client, PR), []);
  assert.equal(state.issues.length, 2);
});

test('a failed recovery throws and keeps the head pending until a later recovery succeeds', async () => {
  const { client, state } = fakeGitHub();
  state.fail.createIssue = 2;
  await assert.rejects(fileFollowUp(client, PR, HEAD_A, [inline(1, 2)]));
  await assert.rejects(reconcilePendingFollowUps(client, PR), /createIssue failed/u);
  assert.deepEqual(pendingFollowUpHeads(state.comments, 7), [HEAD_A]);
  await reconcilePendingFollowUps(client, PR);
  assert.deepEqual(pendingFollowUpHeads(state.comments, 7), []);
});

test('a failure to MARK the record filed leaves it pending, and recovery adds no duplicate', async () => {
  const { client, state } = fakeGitHub();
  state.fail.updateIssueComment = 1;
  await assert.rejects(fileFollowUp(client, PR, HEAD_A, [inline(1, 2)]));
  assert.equal(state.issues.length, 1, 'the issue was filed');
  assert.deepEqual(pendingFollowUpHeads(state.comments, 7), [HEAD_A]);
  await reconcilePendingFollowUps(client, PR);
  assert.equal(state.issues.length, 1);
  assert.deepEqual(identitiesIn(state.issues[0].body), [`${URL}#discussion_r1`]);
});

test('a repeated filing adds only new findings, and a ticked or edited line is not added again', async () => {
  const { client, state } = fakeGitHub();
  await fileFollowUp(client, PR, HEAD_A, [inline(1, 2)]);
  state.issues[0].body = state.issues[0].body.replace('- [ ]', '- [x]').replace('Finding 1', 'Finding 1 (done)');
  await fileFollowUp(client, PR, HEAD_A, [inline(1, 2), inline(4, 2)]);
  assert.equal(state.issues.length, 1);
  assert.deepEqual(identitiesIn(state.issues[0].body), [`${URL}#discussion_r1`, `${URL}#discussion_r4`]);
  assert.match(state.issues[0].body, /- \[x\] .*Finding 1 \(done\)/u);
  const [entry] = followUpRecords(state.comments, 7);
  assert.equal(entry.lines.length, 2, 'the one record per head gained the new line');
});

test('concurrent runs for one head converge on one open issue holding every finding', async () => {
  const { client, state } = fakeGitHub();
  const runs = await Promise.allSettled([
    fileFollowUp(client, PR, HEAD_A, [inline(1, 2)]),
    fileFollowUp(client, PR, HEAD_A, [inline(2, 2)]),
  ]);
  assert.equal(issueFor(state, HEAD_A).length, 2, 'the race happened: both runs saw no open issue and created one');
  // whatever interleaving happened, a run either completed or left the head pending; recovery finishes it
  if (runs.some((run) => run.status === 'rejected')) await reconcilePendingFollowUps(client, PR);
  await reconcilePendingFollowUps(client, PR);
  const open = openIssueFor(state, HEAD_A);
  assert.equal(open.length, 1, 'one canonical open issue');
  assert.equal(open[0].number, Math.min(...issueFor(state, HEAD_A).map((issue) => issue.number)));
  assert.deepEqual(identitiesIn(open[0].body).sort(), [`${URL}#discussion_r1`, `${URL}#discussion_r2`]);
  for (const other of issueFor(state, HEAD_A).filter((issue) => issue.number !== open[0].number)) {
    assert.equal(other.state_reason, 'not_planned');
  }
  assert.deepEqual(pendingFollowUpHeads(state.comments, 7), []);
});

test('two open twins (a past race) are merged into the lowest-numbered one', async () => {
  const { client, state } = fakeGitHub();
  const [l1, l2, l3] = renderFollowUpLines([inline(1, 2), inline(2, 2), inline(3, 2)]);
  const marker = `<!-- review-follow-up: pr-7 head-${HEAD_A} -->`;
  state.issues.push(
    { number: 4, labels: [REVIEW_FOLLOW_UP_LABEL], body: [marker, '', l1].join('\n'), state: 'open', state_reason: null },
    { number: 5, labels: [REVIEW_FOLLOW_UP_LABEL], body: [marker, '', l2].join('\n'), state: 'open', state_reason: null },
  );
  assert.equal(await fileFollowUpLines(client, PR, HEAD_A, [l3]), 4);
  assert.deepEqual(identitiesIn(state.issues[0].body), [l1, l3, l2].map(lineIdentity));
  assert.equal(state.issues[1].state, 'closed');
});

test('a closed duplicate is never selected: the open canonical issue receives the filing (Codex 4226684318)', async () => {
  const { client, state } = fakeGitHub();
  const [l1, l2] = renderFollowUpLines([inline(1, 2), inline(2, 2)]);
  const marker = `<!-- review-follow-up: pr-7 head-${HEAD_A} -->`;
  state.issues.push(
    { number: 3, labels: [REVIEW_FOLLOW_UP_LABEL], body: [marker, '', l1].join('\n'), state: 'open', state_reason: null },
    { number: 6, labels: [REVIEW_FOLLOW_UP_LABEL], body: [marker, '', l1].join('\n'), state: 'closed', state_reason: 'not_planned' },
  );
  assert.equal(await fileFollowUpLines(client, PR, HEAD_A, [l1, l2]), 3);
  assert.deepEqual(identitiesIn(state.issues[0].body), [l1, l2].map(lineIdentity));
  assert.equal(state.issues[1].body.includes(lineIdentity(l2)), false, 'nothing is appended to the closed duplicate');
});

test('completed follow-up work is not reopened; a new finding goes to a new open issue', async () => {
  const { client, state } = fakeGitHub();
  const [done, fresh] = renderFollowUpLines([inline(1, 2), inline(2, 2)]);
  const marker = `<!-- review-follow-up: pr-7 head-${HEAD_A} -->`;
  state.issues.push({ number: 1, labels: [REVIEW_FOLLOW_UP_LABEL], body: [marker, '', done.replace('[ ]', '[x]')].join('\n'), state: 'closed', state_reason: 'completed' });
  state.nextIssue = 2;
  assert.equal(await fileFollowUpLines(client, PR, HEAD_A, [done]), 1, 'already filed and completed');
  assert.equal(state.issues.length, 1);
  assert.equal(await fileFollowUpLines(client, PR, HEAD_A, [done, fresh]), 2);
  assert.deepEqual(identitiesIn(state.issues[1].body), [lineIdentity(fresh)]);
  assert.equal(state.issues[0].state, 'closed');
});

test('a finding held only by a closed duplicate is filed again in an open issue', async () => {
  const { client, state } = fakeGitHub();
  const [l1] = renderFollowUpLines([inline(1, 2)]);
  const marker = `<!-- review-follow-up: pr-7 head-${HEAD_A} -->`;
  state.issues.push({ number: 1, labels: [REVIEW_FOLLOW_UP_LABEL], body: [marker, '', l1].join('\n'), state: 'closed', state_reason: 'not_planned' });
  state.nextIssue = 2;
  assert.equal(await fileFollowUpLines(client, PR, HEAD_A, [l1]), 2);
  assert.equal(openIssueFor(state, HEAD_A).length, 1);
});

test('a filing that does not stick is reported, not assumed: verification throws and the head stays pending', async () => {
  const { client, state } = fakeGitHub();
  await fileFollowUp(client, PR, HEAD_A, [inline(1, 2)]);
  client.updateIssueBody = async () => {}; // a write that silently does nothing
  await assert.rejects(fileFollowUp(client, PR, HEAD_A, [inline(1, 2), inline(2, 2)]), /incomplete/u);
  assert.deepEqual(pendingFollowUpHeads(state.comments, 7), [HEAD_A]);
});

test('bounded to one PR: records from other PRs, other authors and abbreviated heads are ignored', async () => {
  const { client, state } = fakeGitHub();
  const [line] = renderFollowUpLines([inline(1, 2)]);
  state.comments.push(
    { id: 50, issue: 7, user: { login: 'someone' }, body: `<!-- review-follow-up-pending: pr-7 head-${HEAD_A} -->\n\n${line}` },
    { id: 51, issue: 7, user: { login: FOLLOW_UP_RECORD_AUTHOR }, body: `<!-- review-follow-up-pending: pr-8 head-${HEAD_A} -->\n\n${line}` },
    { id: 52, issue: 7, user: { login: FOLLOW_UP_RECORD_AUTHOR }, body: `<!-- review-follow-up-pending: pr-7 head-aaaaaaa -->\n\n${line}` },
  );
  assert.deepEqual(pendingFollowUpHeads(state.comments, 7), []);
  assert.deepEqual(await reconcilePendingFollowUps(client, PR), []);
  assert.equal(state.issues.length, 0);
  await assert.rejects(fileFollowUp(client, PR, 'aaaaaaa', [inline(1, 2)]), /full head SHA/u);
});

test('two records for one head (a recording race) are merged and both marked filed', async () => {
  const { client, state } = fakeGitHub();
  const [l1, l2] = renderFollowUpLines([inline(1, 2), inline(2, 2)]);
  for (const [id, line] of [[60, l1], [61, l2]]) {
    state.comments.push({ id, issue: 7, user: { login: FOLLOW_UP_RECORD_AUTHOR }, body: `<!-- review-follow-up-pending: pr-7 head-${HEAD_A} -->\n\n${line}` });
  }
  assert.deepEqual(await reconcilePendingFollowUps(client, PR), [{ head: HEAD_A, issue: 1, findings: 2 }]);
  assert.deepEqual(identitiesIn(state.issues[0].body), [l1, l2].map(lineIdentity));
  assert.ok(state.comments.every((comment) => comment.body.includes('review-follow-up-filed')));
});

test('nothing to file is not a filing', async () => {
  const { client, state } = fakeGitHub();
  assert.equal(await fileFollowUp(client, PR, HEAD_A, []), null);
  assert.equal(state.comments.length + state.issues.length, 0);
});
