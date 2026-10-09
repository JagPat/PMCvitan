import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  FOLLOW_UP_RECORD_AUTHOR,
  FILING_ATTEMPTS,
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
 * An in-memory GitHub: issues and comments (on the PR and on issues alike). Every call yields to the event
 * loop first, so two runs started together genuinely interleave. `fail[method] = n` makes the next n calls of
 * that method throw; `onIssueComment(number)` runs after a comment lands on an issue (to stage a concurrent
 * actor).
 */
function fakeGitHub() {
  // `labelLag`: how many label-filtered listings omit an issue after it is created — GitHub attaches a new
  // issue's labels asynchronously (#752–#757 were each labelled one to two seconds after creation)
  const state = { issues: [], comments: [], fail: {}, nextIssue: 1, nextComment: 1, calls: [], onIssueComment: null, labelLag: 0 };
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
  const addComment = (number, body, login = FOLLOW_UP_RECORD_AUTHOR) => {
    const comment = { id: state.nextComment++, issue: number, body, user: { login } };
    state.comments.push(comment);
    return comment;
  };
  const client = {
    async issuesLabelled(label) {
      await guard('issuesLabelled');
      const visible = state.issues.filter((issue) => issue.labels.includes(label) && !(issue.unlabelledFor > 0));
      for (const issue of state.issues) if (issue.unlabelledFor > 0) issue.unlabelledFor -= 1;
      return copy(visible.sort((a, b) => b.number - a.number));
    },
    async issue(number) {
      await guard('issue');
      return copy(state.issues.find((issue) => issue.number === number));
    },
    async ensureLabel() { await guard('ensureLabel'); },
    async createIssue({ title, body, labels }) {
      await guard('createIssue');
      const issue = { number: state.nextIssue++, title, body, labels, state: 'open', state_reason: null, unlabelledFor: state.labelLag };
      state.issues.push(issue);
      return copy(issue);
    },
    async closeIssue(number, comment) {
      await guard('closeIssue');
      addComment(number, comment);
      Object.assign(state.issues.find((issue) => issue.number === number), { state: 'closed', state_reason: 'not_planned' });
    },
    async issueComments(number) {
      await guard('issueComments');
      return copy(state.comments.filter((comment) => comment.issue === number));
    },
    async createIssueComment(number, body) {
      await guard('createIssueComment');
      const comment = addComment(number, body);
      if (number !== PR.number && state.onIssueComment) state.onIssueComment(number);
      return copy(comment);
    },
    async updateIssueComment(id, body) {
      await guard('updateIssueComment');
      state.comments.find((comment) => comment.id === id).body = body;
    },
  };
  const issue = (number, head, lines, extra = {}) => {
    state.issues.push({
      number, labels: [REVIEW_FOLLOW_UP_LABEL], state: 'open', state_reason: null,
      body: [`<!-- review-follow-up: pr-7 head-${head} -->`, '', ...lines].join('\n'), ...extra,
    });
    state.nextIssue = Math.max(state.nextIssue, number + 1);
  };
  return { client, state, issue, addComment };
}

const issueFor = (state, head) => state.issues.filter((issue) => issue.body.includes(`pr-7 head-${head}`));
const openIssueFor = (state, head) => issueFor(state, head).filter((issue) => issue.state === 'open');
const checklistOf = (body) => body.split('\n').filter((line) => line.startsWith('- ['));
/** Every finding an issue lists: its body and the workflow's comments on it. */
const listed = (state, number) => [
  ...checklistOf(state.issues.find((issue) => issue.number === number).body),
  ...state.comments.filter((comment) => comment.issue === number && comment.user.login === FOLLOW_UP_RECORD_AUTHOR)
    .flatMap((comment) => checklistOf(comment.body)),
].map(lineIdentity);

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
  assert.equal(state.calls[0], 'createIssueComment', 'recorded before anything is filed');
  assert.ok(state.calls.indexOf('ensureLabel') < state.calls.indexOf('createIssue'), 'Codex 4220739644 — the label exists before an issue carries it');
  const [issue] = state.issues;
  assert.ok(issue.labels.includes(REVIEW_FOLLOW_UP_LABEL));
  assert.match(issue.body, new RegExp(`<!-- review-follow-up: pr-7 head-${HEAD_A} -->`, 'u'));
  assert.deepEqual(listed(state, 1), [`${URL}#discussion_r1`, `${URL}#pullrequestreview-901`]);
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
  const recordedOnA = followUpRecords(state.comments, 7)[0].records[0].lines;

  // the correction moves the head: A's findings are no longer current-head evidence anywhere
  await fileFollowUp(client, PR, HEAD_B, [inline(2, 3)]);
  assert.deepEqual(pendingFollowUpHeads(state.comments, 7), [HEAD_A]);

  const recovered = await reconcilePendingFollowUps(client, PR);
  assert.deepEqual(recovered, [{ head: HEAD_A, issue: 2, findings: 2 }]);
  const [issueA] = openIssueFor(state, HEAD_A);
  assert.deepEqual(checklistOf(issueA.body), recordedOnA,
    'the lines are exactly those recorded on A — original-head classification and identity');
  assert.deepEqual(listed(state, openIssueFor(state, HEAD_B)[0].number), [`${URL}#discussion_r2`]);
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
  assert.deepEqual(listed(state, 1), [`${URL}#discussion_r1`]);
});

test('a repeated filing adds only new findings, and a ticked or edited line is not added again', async () => {
  const { client, state } = fakeGitHub();
  await fileFollowUp(client, PR, HEAD_A, [inline(1, 2)]);
  state.issues[0].body = state.issues[0].body.replace('- [ ]', '- [x]').replace('Finding 1', 'Finding 1 (done)');
  await fileFollowUp(client, PR, HEAD_A, [inline(1, 2), inline(4, 2)]);
  assert.equal(state.issues.length, 1);
  assert.deepEqual(listed(state, 1), [`${URL}#discussion_r1`, `${URL}#discussion_r4`]);
  assert.match(state.issues[0].body, /- \[x\] .*Finding 1 \(done\)/u, 'the body is never rewritten');
  const [entry] = followUpRecords(state.comments, 7);
  assert.deepEqual(entry.records.map((record) => record.pending), [false, false], 'one record per recording, each filed');
});

test('concurrent runs for one head converge on one open issue holding every finding', async () => {
  const { client, state } = fakeGitHub();
  const runs = await Promise.allSettled([
    fileFollowUp(client, PR, HEAD_A, [inline(1, 2)]),
    fileFollowUp(client, PR, HEAD_A, [inline(2, 2)]),
  ]);
  assert.equal(issueFor(state, HEAD_A).length, 2, 'the race happened: both runs saw no open issue and created one');
  assert.deepEqual(runs.map((run) => run.status), ['fulfilled', 'fulfilled']);
  const open = openIssueFor(state, HEAD_A);
  assert.equal(open.length, 1, 'one canonical open issue');
  assert.equal(open[0].number, 1);
  // append-only writes can list a finding twice under a race; they can never drop one
  assert.deepEqual([...new Set(listed(state, 1))].sort(), [`${URL}#discussion_r1`, `${URL}#discussion_r2`]);
  assert.equal(issueFor(state, HEAD_A).find((issue) => issue.number === 2).state, 'closed');
  assert.deepEqual(pendingFollowUpHeads(state.comments, 7), []);
});

test('Codex 4228313741 — concurrent appends to one canonical issue both survive', async () => {
  const { client, state, issue } = fakeGitHub();
  const [l1, l2, l3] = renderFollowUpLines([inline(1, 2), inline(2, 2), inline(3, 2)]);
  issue(1, HEAD_A, [l1]);
  const runs = await Promise.all([
    fileFollowUpLines(client, PR, HEAD_A, [l2]),
    fileFollowUpLines(client, PR, HEAD_A, [l3]),
  ]);
  assert.deepEqual(runs, [1, 1]);
  assert.deepEqual(listed(state, 1), [l1, l2, l3].map(lineIdentity), 'no write replaced another');
});

test('Codex 4228313747 — the canonical issue closed during the filing: the finding is filed again in an open issue', async () => {
  const { client, state, issue } = fakeGitHub();
  const [l1, l2] = renderFollowUpLines([inline(1, 2), inline(2, 2)]);
  issue(1, HEAD_A, [l1]);
  // someone completes #1 the moment the new finding lands on it
  state.onIssueComment = (number) => {
    if (number !== 1) return;
    Object.assign(state.issues[0], { state: 'closed', state_reason: 'completed' });
    state.onIssueComment = null;
  };
  assert.equal(await fileFollowUpLines(client, PR, HEAD_A, [l2]), 2);
  assert.equal(state.issues[1].state, 'open');
  assert.deepEqual(listed(state, 2), [lineIdentity(l2)], 'the new finding is tracked by an OPEN issue');
});

test('a filing that never sticks is reported, not assumed: it throws after its attempts and the head stays pending', async () => {
  const { client, state } = fakeGitHub();
  await fileFollowUp(client, PR, HEAD_A, [inline(1, 2)]);
  const create = client.createIssueComment;
  client.createIssueComment = async (number, body) => (number === PR.number ? create(number, body) : {});
  await assert.rejects(fileFollowUp(client, PR, HEAD_A, [inline(1, 2), inline(2, 2)]), new RegExp(`incomplete after ${FILING_ATTEMPTS} attempts`, 'u'));
  assert.deepEqual(pendingFollowUpHeads(state.comments, 7), [HEAD_A]);
});

test('two open twins (a past race) are merged into the lowest-numbered one', async () => {
  const { client, state, issue } = fakeGitHub();
  const [l1, l2, l3] = renderFollowUpLines([inline(1, 2), inline(2, 2), inline(3, 2)]);
  issue(4, HEAD_A, [l1]);
  issue(5, HEAD_A, [l2]);
  assert.equal(await fileFollowUpLines(client, PR, HEAD_A, [l3]), 4);
  assert.deepEqual(listed(state, 4), [l1, l3, l2].map(lineIdentity));
  assert.equal(state.issues[1].state, 'closed');
  assert.match(state.comments.find((comment) => comment.issue === 5).body, /review-follow-up-duplicate-of: 4/u);
});

test('a closed duplicate is never selected: the open canonical issue receives the filing (Codex 4226684318)', async () => {
  const { client, state, issue, addComment } = fakeGitHub();
  const [l1, l2] = renderFollowUpLines([inline(1, 2), inline(2, 2)]);
  issue(3, HEAD_A, [l1]);
  issue(6, HEAD_A, [l1], { state: 'closed', state_reason: 'not_planned' });
  addComment(6, '<!-- review-follow-up-duplicate-of: 3 -->\nDuplicate of #3');
  assert.equal(await fileFollowUpLines(client, PR, HEAD_A, [l1, l2]), 3);
  assert.deepEqual(listed(state, 3), [l1, l2].map(lineIdentity));
  assert.deepEqual(listed(state, 6), [lineIdentity(l1)], 'nothing is added to the closed duplicate');
});

test('completed follow-up work is not reopened; a new finding goes to a new open issue', async () => {
  const { client, state, issue } = fakeGitHub();
  const [done, fresh] = renderFollowUpLines([inline(1, 2), inline(2, 2)]);
  issue(1, HEAD_A, [done.replace('[ ]', '[x]')], { state: 'closed', state_reason: 'completed' });
  assert.equal(await fileFollowUpLines(client, PR, HEAD_A, [done]), 1, 'already filed and completed');
  assert.equal(state.issues.length, 1);
  assert.equal(await fileFollowUpLines(client, PR, HEAD_A, [done, fresh]), 2);
  assert.deepEqual(listed(state, 2), [lineIdentity(fresh)]);
  assert.equal(state.issues[0].state, 'closed');
});

test('a person\'s not-planned closure stands; only a duplicate this component closed is filed again', async () => {
  const { client, state, issue, addComment } = fakeGitHub();
  const [declined, carried] = renderFollowUpLines([inline(1, 2), inline(2, 2)]);
  issue(1, HEAD_A, [declined], { state: 'closed', state_reason: 'not_planned' });
  assert.equal(await fileFollowUpLines(client, PR, HEAD_A, [declined]), 1, 'declined by a person: not reopened');
  issue(2, HEAD_A, [carried], { state: 'closed', state_reason: 'not_planned' });
  addComment(2, '<!-- review-follow-up-duplicate-of: 9 -->\nDuplicate of #9');
  assert.equal(await fileFollowUpLines(client, PR, HEAD_A, [carried]), 3);
  assert.deepEqual(listed(state, 3), [lineIdentity(carried)]);
});

test('bounded to one PR: records from other PRs, other authors and abbreviated heads are ignored', async () => {
  const { client, state, addComment } = fakeGitHub();
  const [line] = renderFollowUpLines([inline(1, 2)]);
  addComment(7, `<!-- review-follow-up-pending: pr-7 head-${HEAD_A} -->\n\n${line}`, 'someone');
  addComment(7, `<!-- review-follow-up-pending: pr-8 head-${HEAD_A} -->\n\n${line}`);
  addComment(7, `<!-- review-follow-up-pending: pr-7 head-aaaaaaa -->\n\n${line}`);
  assert.deepEqual(pendingFollowUpHeads(state.comments, 7), []);
  assert.deepEqual(await reconcilePendingFollowUps(client, PR), []);
  assert.equal(state.issues.length, 0);
  await assert.rejects(fileFollowUp(client, PR, 'aaaaaaa', [inline(1, 2)]), /full head SHA/u);
});

test('two records for one head are filed together, and each is marked filed with its own lines', async () => {
  const { client, state, addComment } = fakeGitHub();
  const [l1, l2] = renderFollowUpLines([inline(1, 2), inline(2, 2)]);
  addComment(7, `<!-- review-follow-up-pending: pr-7 head-${HEAD_A} -->\n\n${l1}`);
  addComment(7, `<!-- review-follow-up-pending: pr-7 head-${HEAD_A} -->\n\n${l2}`);
  assert.deepEqual(await reconcilePendingFollowUps(client, PR), [{ head: HEAD_A, issue: 1, findings: 2 }]);
  assert.deepEqual(listed(state, 1), [l1, l2].map(lineIdentity));
  const records = state.comments.filter((comment) => comment.issue === 7);
  assert.ok(records.every((comment) => comment.body.includes('review-follow-up-filed')));
  assert.deepEqual(records.map((comment) => checklistOf(comment.body).map(lineIdentity)), [[lineIdentity(l1)], [lineIdentity(l2)]]);
});

test('nothing to file is not a filing', async () => {
  const { client, state } = fakeGitHub();
  assert.equal(await fileFollowUp(client, PR, HEAD_A, []), null);
  assert.equal(state.comments.length + state.issues.length, 0);
});

test('#482 6085143973 — a new issue missing from the label list is read back by number: one issue, not one per attempt', async () => {
  const { client, state } = fakeGitHub();
  // longer than every attempt: before this repair, each attempt created another issue (#752–#754)
  state.labelLag = 10;
  const number = await fileFollowUp(client, PR, HEAD_A, [inline(1, 2), reviewBody(901)]);
  assert.equal(state.issues.length, 1, 'exactly one issue for the head');
  assert.equal(number, state.issues[0].number);
  assert.deepEqual(listed(state, number), [`${URL}#discussion_r1`, `${URL}#pullrequestreview-901`]);
  assert.deepEqual(pendingFollowUpHeads(state.comments, 7), []);
  assert.equal(state.calls.filter((call) => call === 'createIssue').length, 1);
  // once the label is attached, the same head converges on that issue: nothing new is created or added
  state.labelLag = 0;
  for (const issue of state.issues) issue.unlabelledFor = 0;
  assert.equal(await fileFollowUp(client, PR, HEAD_A, [inline(1, 2)]), number);
  assert.equal(state.issues.length, 1);
});

test('#482 6085143973 — verification still reads the created issue: a filing that never lands throws even when it is unlisted', async () => {
  const { client, state } = fakeGitHub();
  state.labelLag = 10;
  const create = client.createIssueComment;
  // the issue body carries the lines, so this proves the verify step reads the issue, not the record
  client.createIssue = async () => { await create(PR.number, 'noise'); return { number: undefined }; };
  await assert.rejects(fileFollowUp(client, PR, HEAD_A, [inline(1, 2)]), /returned no issue number/u);
  assert.deepEqual(pendingFollowUpHeads(state.comments, 7), [HEAD_A], 'a pending record is not completion');
});

test('#482 6085143973 — after a new push, the earlier head\'s durable record is recovered into one issue despite the label lag', async () => {
  const { client, state } = fakeGitHub();
  state.labelLag = 10;
  state.fail.createIssue = 1;
  await assert.rejects(fileFollowUp(client, PR, HEAD_A, [inline(1, 2), reviewBody(901)]));
  const recordedOnA = followUpRecords(state.comments, 7)[0].records[0].lines;

  // the head moves; B files (lagged) without touching A's pending record
  await fileFollowUp(client, PR, HEAD_B, [inline(2, 3)]);
  assert.deepEqual(pendingFollowUpHeads(state.comments, 7), [HEAD_A]);

  const recovered = await reconcilePendingFollowUps(client, PR);
  assert.equal(recovered.length, 1);
  assert.equal(recovered[0].head, HEAD_A);
  assert.equal(issueFor(state, HEAD_A).length, 1, 'one issue for A, however long its label lags');
  assert.equal(issueFor(state, HEAD_B).length, 1);
  assert.deepEqual(checklistOf(issueFor(state, HEAD_A)[0].body), recordedOnA, 'original-head classification and identity');
  assert.deepEqual(pendingFollowUpHeads(state.comments, 7), []);
  // idempotent once listed
  state.labelLag = 0;
  for (const issue of state.issues) issue.unlabelledFor = 0;
  assert.deepEqual(await reconcilePendingFollowUps(client, PR), []);
  assert.equal(state.issues.length, 2);
});

test('#482 6085143973 — duplicates left by the lag are converged once listed: the lowest open issue is canonical', async () => {
  const { client, state, issue } = fakeGitHub();
  // the shape #752–#754 were left in: three open twins for one head, the findings only in their bodies
  const line = renderFollowUpLines([inline(1, 2)]);
  issue(52, HEAD_A, line);
  issue(53, HEAD_A, line);
  issue(54, HEAD_A, line);
  assert.equal(await fileFollowUpLines(client, PR, HEAD_A, line), 52);
  assert.deepEqual(openIssueFor(state, HEAD_A).map((open) => open.number), [52]);
  assert.deepEqual(issueFor(state, HEAD_A).filter((twin) => twin.state === 'closed').map((twin) => twin.number), [53, 54]);
  assert.equal(state.calls.filter((call) => call === 'createIssue').length, 0);
});
