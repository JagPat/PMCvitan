// Owner decision 2026-10-08 (delivery speed): the review-round cap, the trivial fast lane, the
// focused-unit size target and the completion report.
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
import { assessReviewScope } from './review-efficiency.mjs';
import {
  TRIVIAL_LANE_SUCCESS, authorizeExactHeadMerge, completeTrivialPullRequest, ensureTerminalReviewState, fileDeferredFindings,
  unionDeferred,
} from './autonomous-review-gate.mjs';
import { alreadyReported, completionReport, mergedThroughTrivialLane, reviewRounds } from './completion-report.mjs';
import { REQUIRED_CHECKS, REVIEW_FOLLOW_UP_LABEL, REVIEW_ROUND_CAP } from './review-policy.mjs';

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

test('Codex 4214270301 — the trivial lane is read from the controller status, never the editable body', () => {
  const status = (description) => ({ context: 'codex-current-head', description });
  assert.equal(mergedThroughTrivialLane([status('review: trivial fast lane — CI only, no Codex round (owner decision 2026-10-08)')]), true);
  // a standard PR relabelled trivial after its clean review: the status says how it was really completed
  assert.equal(mergedThroughTrivialLane([status('review: Codex found no blocking issue on this exact head')]), false);
  // the NEWEST status decides
  assert.equal(mergedThroughTrivialLane([status('review: Codex found no blocking issue on this exact head'), status('review: trivial fast lane — x')]), false);
  assert.equal(mergedThroughTrivialLane([]), false);
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

const OWNER = '<!-- correction-owner: claude -->';

function scope(body, files, extra = {}) {
  return assessReviewScope(
    { number: 9_999, additions: 40, deletions: 10, changed_files: files.length, body, base: { ref: 'main' }, ...extra },
    { changedFiles: files.map((filename) => ({ filename })), preReviewEnforceAfterPr: 100_000 },
  );
}

test('a trivial web/docs change takes the fast lane', () => {
  const result = scope(`<!-- review-size: trivial -->\n<!-- trivial-kind: copy -->\n${OWNER}\nWork item issue: #9`, ['apps/web/src/components/Button.tsx', 'docs/x.md']);
  assert.equal(result.state, 'trivial');
  assert.equal(result.allowed, true);
});

test('Codex 4214270304 — a live-bug, UX or trivial unit without its work-item issue is refused', () => {
  const missing = scope(`<!-- review-size: trivial -->\n<!-- trivial-kind: copy -->\n${OWNER}\n- Work item issue: #`, ['apps/web/src/components/Button.tsx']);
  assert.equal(missing.allowed, false);
  assert.match(missing.detail, /Work item issue/u);
  const liveBug = scope(`<!-- review-size: standard -->\n<!-- unit-kind: live-bug -->\n${OWNER}`, ['apps/web/src/screens/x.tsx']);
  assert.equal(liveBug.allowed, false);
  // a unit that is not a work item (maintenance, a phase task) is not asked for one here
  assert.equal(scope(`<!-- review-size: standard -->\n${OWNER}`, ['apps/web/src/screens/x.tsx']).allowed, true);
});

test('a trivial claim outside web/docs or over 100 lines is refused', () => {
  const trivial = `<!-- review-size: trivial -->\n<!-- trivial-kind: labels -->\n${OWNER}`;
  const api = scope(trivial, ['apps/api/src/x.ts']);
  assert.equal(api.allowed, false);
  assert.match(api.detail, /trivial fast lane/u);
  const big = scope(trivial, ['apps/web/src/screens/x.tsx'], { additions: 101, deletions: 0 });
  assert.equal(big.allowed, false);
  // Codex 4213960368 — state, routing and auth code, and the contract files, are never trivial
  for (const path of ['apps/web/src/store/store.ts', 'apps/web/src/lib/screens.ts', 'apps/web/src/data/apiGateway.ts', 'docs/POLICY.md', 'docs/STATUS.md']) {
    assert.equal(scope(trivial, [path]).allowed, false, path);
  }
  // …and the kind of change must be declared
  assert.equal(scope(`<!-- review-size: trivial -->\n${OWNER}`, ['apps/web/src/screens/x.tsx']).allowed, false);
});

test('a live-bug unit over 8 files or 300 lines needs an owner-approved size', () => {
  const files = Array.from({ length: 9 }, (_, i) => `apps/web/src/f${i}.ts`);
  const body = `<!-- review-size: standard -->\n<!-- unit-kind: live-bug -->\n${OWNER}\n- Work item issue: #734`;
  const over = scope(body, files);
  assert.equal(over.allowed, false);
  assert.match(over.detail, /live-bug unit targets at most 8 files and 300/u);
  const approved = scope(`${body}\nOwner-approved-size: https://github.com/JagPat/PMCvitan/issues/482#issuecomment-1`, files);
  assert.equal(approved.allowed, true);
  // Codex 4213960401 — only an issue comment in this repository counts as the owner's OK
  for (const link of ['https://github.com/JagPat/PMCvitan/pull/730', 'https://github.com/JagPat/PMCvitan/issues/482', 'https://github.com/o/r/issues/1#issuecomment-1']) {
    assert.equal(scope(`${body}\nOwner-approved-size: ${link}`, files).allowed, false, link);
  }
  const small = scope(body, files.slice(0, 3), { additions: 250, deletions: 50 });
  assert.equal(small.allowed, true);
});

function trivialClient(body, calls, { draft = true, workItemProblem = null, onDraft = null, statuses = [] } = {}) {
  const live = { body };
  const head = 'd'.repeat(40);
  const pr = () => ({
    number: 9_999,
    additions: 4,
    deletions: 1,
    changed_files: 1,
    body: live.body,
    state: 'open',
    draft,
    node_id: 'PR_1',
    html_url: 'https://github.com/JagPat/PMCvitan/pull/9999',
    head: { sha: head, repo: { full_name: 'JagPat/PMCvitan' } },
    base: { ref: 'main', sha: 'e'.repeat(40), repo: { full_name: 'JagPat/PMCvitan' } },
  });
  return {
    head,
    pr: pr(),
    client: {
      async pullRequest() { return pr(); },
      async pullRequestFiles() { return [{ filename: 'apps/web/src/components/Label.tsx', patch: '@@ -1 +1 @@\n-a\n+b' }]; },
      async replacementLineage() { return { requiredReplacements: [], replacementPullRequests: [] }; },
      async workItemProblem() { return workItemProblem; },
      async reviewComments() { return []; },
      async reviews() { return []; },
      async markReplacementRequired() {},
      async commit() { return { commit: { message: 'copy\n\nCorrection-Owner: claude\n' }, files: [] }; },
      async setDraft(pull, toDraft) {
        calls.push(['draft', toDraft]);
        onDraft?.(live);
        return { ...pull, body: live.body, draft: toDraft };
      },
      async statuses() { return statuses; },
      async checkRuns() {
        return REQUIRED_CHECKS.map((name) => ({ name, head_sha: head, status: 'completed', conclusion: 'success', started_at: '2026-10-08T00:00:00Z', completed_at: '2026-10-08T00:01:00Z', check_suite: { id: 1 } }));
      },
      async setStatus(_head, state) { calls.push(['status', state]); },
      async updateStickyComment() {},
    },
  };
}

const PRE_REVIEW = ['concurrency-serialization', 'old-release-migration-compatibility', 'trigger-alternate-writers', 'authorization-tenancy', 'ci-reproduce-first']
  .map((key) => `- [x] \`${key}\` — n/a`).join('\n');

test('Codex 4213960382 — the trivial lane promotes the draft to ready before publishing success', async () => {
  const calls = [];
  const body = `<!-- review-size: trivial -->\n<!-- trivial-kind: copy -->\n${OWNER}\nWork item issue: #9\nReplaces: none\n\n## Pre-review checklist\n${PRE_REVIEW}`;
  const { client, pr, head } = trivialClient(body, calls);
  // the merge itself is outside this probe: the fake client has no merge methods
  await completeTrivialPullRequest(client, pr, head, null).catch(() => {});
  const ready = calls.findIndex(([kind, value]) => kind === 'draft' && value === false);
  const success = calls.findIndex(([kind, value]) => kind === 'status' && value === 'success');
  assert.ok(ready >= 0, JSON.stringify(calls));
  assert.ok(success > ready, JSON.stringify(calls));
});

test('Codex 4213960394 — a body no longer trivial at final admission leaves the fast lane', async () => {
  const calls = [];
  const body = `<!-- review-size: standard -->\n${OWNER}\nReplaces: none\n\n## Pre-review checklist\n${PRE_REVIEW}`;
  const { client, pr, head } = trivialClient(body, calls);
  assert.equal(await completeTrivialPullRequest(client, pr, head, null), 'not_trivial');
  assert.equal(calls.some(([kind, value]) => kind === 'status' && value === 'success'), false);
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

test('Codex 4214321822 — every relative link in the archived documents resolves', async () => {
  const { readFile } = await import('node:fs/promises');
  const { existsSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const { join, normalize, dirname } = await import('node:path');
  const archive = fileURLToPath(new URL('../docs/archive/', import.meta.url));
  for (const name of ['ROADMAP-2026-10-08.md', 'RUNBOOK-2026-10-08.md', 'STATUS-history-2026-10-08.md']) {
    const text = await readFile(join(archive, name), 'utf8');
    for (const [, target] of text.matchAll(/\]\(([^)\s#]+)(?:#[^)]*)?\)/gu)) {
      if (/^[a-z][a-z0-9+.-]*:/iu.test(target) || target.startsWith('/')) continue;
      assert.ok(existsSync(normalize(join(dirname(join(archive, name)), target))), `${name} → ${target}`);
    }
  }
});

test('Codex 4214321797 — the cited work-item issue must exist and be an issue', async () => {
  const { verifyWorkItemIssue } = await import('./review-scope.mjs');
  const body = '<!-- review-size: standard -->\n<!-- unit-kind: live-bug -->\n- Work item issue: #734';
  const respond = (status, json = {}) => async () => ({ status, ok: status < 400, async json() { return json; } });
  const at = { repository: 'JagPat/PMCvitan', token: 't' };
  assert.equal(await verifyWorkItemIssue(body, { ...at, fetchImpl: respond(200, { number: 734 }) }), null);
  assert.match(await verifyWorkItemIssue(body, { ...at, fetchImpl: respond(404) }), /does not exist/u);
  assert.match(await verifyWorkItemIssue(body, { ...at, fetchImpl: respond(200, { pull_request: {} }) }), /pull request/u);
  // a unit that is not a work item is not looked up
  assert.equal(await verifyWorkItemIssue('<!-- review-size: standard -->', { ...at, fetchImpl: respond(404) }), null);
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

test('Codex 4214389878 — final admission resolves the cited work item again; a stale green check admits nothing', async () => {
  const calls = [];
  const body = `<!-- review-size: trivial -->\n<!-- trivial-kind: copy -->\n${OWNER}\nWork item issue: #9\nReplaces: none\n\n## Pre-review checklist\n${PRE_REVIEW}`;
  const { client, pr, head } = trivialClient(body, calls, { workItemProblem: 'the cited work item #9 is a pull request, not an issue' });
  await assert.rejects(completeTrivialPullRequest(client, pr, head, null), /scope_required/u);
  assert.equal(calls.some(([kind, value]) => kind === 'status' && value === 'success'), false);
});

test('Codex 4214389894 — recovery never consumes a fast-lane success once the live body is no longer trivial', async () => {
  const calls = [];
  const body = `<!-- review-size: standard -->\n${OWNER}\nReplaces: none\n\n## Pre-review checklist\n${PRE_REVIEW}`;
  const { client, pr, head } = trivialClient(body, calls, { draft: false });
  const status = { id: 1, context: 'codex-current-head', state: 'success', description: TRIVIAL_LANE_SUCCESS };
  assert.equal(await ensureTerminalReviewState(client, pr, head, status, [status]), false);
  assert.deepEqual(calls, []);
});

test('Codex 4215318377 — a body edited to standard during the draft promotion publishes no fast-lane success', async () => {
  const calls = [];
  const body = `<!-- review-size: trivial -->\n<!-- trivial-kind: copy -->\n${OWNER}\nWork item issue: #9\nReplaces: none\n\n## Pre-review checklist\n${PRE_REVIEW}`;
  const standard = `<!-- review-size: standard -->\n${OWNER}\nReplaces: none\n\n## Pre-review checklist\n${PRE_REVIEW}`;
  const { client, pr, head } = trivialClient(body, calls, { onDraft: (live) => { live.body = standard; } });
  assert.equal(await completeTrivialPullRequest(client, pr, head, null), 'not_trivial');
  assert.equal(calls.some(([kind, value]) => kind === 'status' && value === 'success'), false);
});

test('Codex 4215318377 — the merge guard refuses a fast-lane success once the live body leaves the lane', async () => {
  const status = { id: 1, context: 'codex-current-head', state: 'success', description: TRIVIAL_LANE_SUCCESS };
  const verdict = { outcome: 'eligible', mergeEligible: true, owner: 'claude' };
  const standard = `<!-- review-size: standard -->\n${OWNER}\nReplaces: none\n\n## Pre-review checklist\n${PRE_REVIEW}`;
  const left = trivialClient(standard, [], { draft: false, statuses: [status] });
  assert.equal((await authorizeExactHeadMerge(left.client, left.pr, left.head, verdict)).state, 'left_trivial_lane');
  // the same status on a body that still declares the lane is authorized, as before
  const trivial = `<!-- review-size: trivial -->\n<!-- trivial-kind: copy -->\n${OWNER}\nWork item issue: #9\nReplaces: none\n\n## Pre-review checklist\n${PRE_REVIEW}`;
  const kept = trivialClient(trivial, [], { draft: false, statuses: [status] });
  assert.equal((await authorizeExactHeadMerge(kept.client, kept.pr, kept.head, verdict)).state, 'authorized');
});

test('Codex 4216250355 — the merge guard re-runs the whole trivial admission, not only the size marker', async () => {
  const status = { id: 1, context: 'codex-current-head', state: 'success', description: TRIVIAL_LANE_SUCCESS };
  const verdict = { outcome: 'eligible', mergeEligible: true, owner: 'claude' };
  // the size marker survives, but the trivial kind is gone: the lane no longer admits this PR
  const kindless = `<!-- review-size: trivial -->\n${OWNER}\nWork item issue: #9\nReplaces: none\n\n## Pre-review checklist\n${PRE_REVIEW}`;
  const noKind = trivialClient(kindless, [], { draft: false, statuses: [status] });
  assert.equal((await authorizeExactHeadMerge(noKind.client, noKind.pr, noKind.head, verdict)).state, 'left_trivial_lane');
  // the marker and kind survive, but the cited work item is no longer a real issue
  const full = `<!-- review-size: trivial -->\n<!-- trivial-kind: copy -->\n${OWNER}\nWork item issue: #9\nReplaces: none\n\n## Pre-review checklist\n${PRE_REVIEW}`;
  const badIssue = trivialClient(full, [], { draft: false, statuses: [status], workItemProblem: 'the cited work item #9 is a pull request, not an issue' });
  assert.equal((await authorizeExactHeadMerge(badIssue.client, badIssue.pr, badIssue.head, verdict)).state, 'left_trivial_lane');
});

test('Codex 4216250368 — the review-scope job may read the cited work-item issue', async () => {
  const { readFile } = await import('node:fs/promises');
  const ci = await readFile(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
  const job = ci.slice(ci.indexOf('\n  review-scope:'), ci.indexOf('node scripts/review-scope.mjs'));
  assert.match(job, /\n {6}issues: read\n/u);
});
