import assert from 'node:assert/strict';
import test from 'node:test';

import {
  authorizeCodexFixDispatch,
  codexFixComment,
  dedupPrefix,
  expectedAuthorization,
  isGenuineUnresolvedFinding,
  probeMarker,
  pullNumberFromUrl,
  runDispatch,
} from './codex-fix-probe.mjs';

const CODEX = 'chatgpt-codex-connector[bot]';
const repository = 'JagPat/PMCvitan';
const headSha = 'a'.repeat(40);
const base = 'b'.repeat(40);
const findingRef = 'https://github.com/JagPat/PMCvitan/pull/597#discussion_r1';

function livePull(overrides = {}) {
  return {
    number: 597,
    state: 'open',
    head: { sha: headSha, ref: 'codex/feature', repo: { full_name: repository } },
    base: { ref: 'main', sha: base, repo: { full_name: repository } },
    ...overrides,
  };
}
function findingComment(overrides = {}) {
  return {
    user: { login: CODEX },
    original_commit_id: headSha,
    body: '**P1** something is wrong',
    html_url: findingRef,
    pull_request_url: 'https://api.github.com/repos/JagPat/PMCvitan/pulls/597',
    ...overrides,
  };
}
function inputs(overrides = {}) {
  return {
    repository,
    pullRequestNumber: 597,
    headSha,
    findingRef,
    authorization: expectedAuthorization({ pullRequest: 597, headSha }),
    livePull: livePull(),
    findingComment: findingComment(),
    threadUnresolved: true,
    existingComments: [],
    ...overrides,
  };
}

test('pullNumberFromUrl reads the PR number a comment belongs to', () => {
  assert.equal(pullNumberFromUrl('https://api.github.com/repos/o/r/pulls/597'), 597);
  assert.equal(pullNumberFromUrl('https://api.github.com/repos/o/r/pulls/598/comments/1'), 598);
  assert.equal(pullNumberFromUrl(''), null);
  assert.equal(pullNumberFromUrl(undefined), null);
});

test('a genuine unresolved finding needs Codex author, this head+PR, a severity, and an UNRESOLVED thread', () => {
  const ok = { findingComment: findingComment(), headSha, pullRequestNumber: 597, threadUnresolved: true };
  assert.equal(isGenuineUnresolvedFinding(ok), true);
  assert.equal(isGenuineUnresolvedFinding({ ...ok, findingComment: findingComment({ user: { login: 'someone' } }) }), false);
  assert.equal(isGenuineUnresolvedFinding({ ...ok, findingComment: findingComment({ original_commit_id: 'c'.repeat(40) }) }), false, 'stale comment head');
  assert.equal(isGenuineUnresolvedFinding({ ...ok, findingComment: findingComment({ body: 'no severity' }) }), false);
  assert.equal(isGenuineUnresolvedFinding({ ...ok, findingComment: findingComment({ pull_request_url: 'https://api.github.com/repos/JagPat/PMCvitan/pulls/999' }) }), false, 'comment belongs to another PR');
  assert.equal(isGenuineUnresolvedFinding({ ...ok, threadUnresolved: false }), false, 'resolved thread');
  assert.equal(isGenuineUnresolvedFinding({ ...ok, threadUnresolved: null }), false, 'resolution unavailable → fail closed');
  assert.equal(isGenuineUnresolvedFinding({ ...ok, findingComment: null }), false);
});

test('the happy path authorizes one dispatch and derives the marker and source branch', () => {
  const result = authorizeCodexFixDispatch(inputs());
  assert.equal(result.allowed, true);
  assert.equal(result.state, 'ready');
  assert.equal(result.sourceBranch, 'codex/feature');
  assert.equal(result.marker, probeMarker({ pullRequest: 597, headSha, findingRef }));
});

test('dispatch is refused for wrong token, stale head, fork, closed PR, wrong base, wrong-PR comment, resolved or unavailable thread', () => {
  for (const [label, override] of [
    ['wrong token', { authorization: 'arm-pr-597-head-wrong' }],
    ['token for another PR', { authorization: `arm-pr-598-head-${headSha}` }],
    ['armed head not the SHA regex', { headSha: 'nothex' }],
    ['live head advanced', { livePull: livePull({ head: { sha: 'c'.repeat(40), ref: 'codex/feature', repo: { full_name: repository } } }) }],
    ['closed PR', { livePull: livePull({ state: 'closed' }) }],
    ['fork head', { livePull: livePull({ head: { sha: headSha, ref: 'x', repo: { full_name: 'fork/repo' } } }) }],
    ['wrong base ref', { livePull: livePull({ base: { ref: 'other', sha: base, repo: { full_name: repository } } }) }],
    ['fork base', { livePull: livePull({ base: { ref: 'main', sha: base, repo: { full_name: 'fork/repo' } } }) }],
    ['comment on another PR', { findingComment: findingComment({ pull_request_url: 'https://api.github.com/repos/JagPat/PMCvitan/pulls/999' }) }],
    ['resolved thread', { threadUnresolved: false }],
    ['resolution unavailable', { threadUnresolved: null }],
    ['no finding', { findingComment: null }],
    ['empty finding ref', { findingRef: '' }],
  ]) {
    const result = authorizeCodexFixDispatch(inputs(override));
    assert.equal(result.allowed, false, `should refuse: ${label}`);
    assert.equal(result.state, 'unauthorized_or_stale', label);
  }
});

test('dedup is per PR/head across finding ids — a probe comment for this head blocks a different finding', () => {
  const prefix = dedupPrefix({ pullRequest: 597, headSha });
  const otherFinding = probeMarker({ pullRequest: 597, headSha, findingRef: 'https://x/pull/597#discussion_r2' });
  assert.ok(otherFinding.startsWith(prefix));
  const blocked = authorizeCodexFixDispatch(inputs({ existingComments: [{ body: `earlier\n${otherFinding}\n` }] }));
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.state, 'duplicate');
  // a probe comment for a DIFFERENT head does not block this one
  const otherHead = probeMarker({ pullRequest: 597, headSha: 'c'.repeat(40), findingRef });
  assert.equal(authorizeCodexFixDispatch(inputs({ existingComments: [{ body: otherHead }] })).allowed, true);
});

test('the posted request is a single @codex fix naming head/branch/finding, requiring a stale-head recheck, preserving other findings', () => {
  const marker = probeMarker({ pullRequest: 597, headSha, findingRef });
  const body = codexFixComment({ pullRequestNumber: 597, headSha, sourceBranch: 'codex/feature', findingRef, marker });
  assert.match(body, /^<!-- codex-fix-probe:/u);
  assert.match(body, /@codex fix/u);
  assert.match(body, new RegExp(headSha, 'u'));
  assert.match(body, /codex\/feature/u);
  assert.match(body, /verify the remote branch still has this exact head/u);
  assert.match(body, /STOP and report stale-dispatch/u);
  assert.match(body, /preserve every other open finding/u);
  assert.match(body, /do not open a new PR/u);
  assert.doesNotMatch(body, /codex-current-head/u);
});

test('runDispatch refuses an untrusted ref and a non-dispatch event before any API call', async () => {
  const api = new Proxy({}, { get() { return () => { throw new Error('no API call expected'); }; } });
  const baseEnv = { GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REF: 'refs/heads/main', PROBE_PR_NUMBER: '597', PROBE_HEAD_SHA: headSha, PROBE_FINDING_COMMENT_ID: '4023550608', PROBE_AUTHORIZATION: expectedAuthorization({ pullRequest: 597, headSha }) };
  await assert.rejects(runDispatch({ env: { ...baseEnv, GITHUB_REF: 'refs/heads/codex/feature' }, loadEvent: () => ({ repository: { full_name: repository } }), api }), /untrusted_ref/u);
  await assert.rejects(runDispatch({ env: { ...baseEnv, GITHUB_EVENT_NAME: 'push' }, loadEvent: () => ({ repository: { full_name: repository } }), api }), /not_workflow_dispatch/u);
});

test('overlapping dispatches post once: the second dedups at the pre-post recheck (barrier on the real seam)', async () => {
  const commentId = 4023550608;
  const comments = [];
  const makeApi = () => ({
    getPull: async () => livePull(),
    getReviewComment: async () => findingComment(),
    threadUnresolved: async () => true,
    listComments: async () => comments.map((c) => ({ ...c })),
    postComment: async (_repo, _n, body) => {
      const created = { id: comments.length + 1, user: { login: 'github-actions[bot]' }, body };
      comments.push(created);
      return created;
    },
  });
  const env = { GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REF: 'refs/heads/main', PROBE_PR_NUMBER: '597', PROBE_HEAD_SHA: headSha, PROBE_FINDING_COMMENT_ID: String(commentId), PROBE_AUTHORIZATION: expectedAuthorization({ pullRequest: 597, headSha }) };
  const loadEvent = () => ({ repository: { full_name: repository } });

  // B authorizes against the empty list, then parks at the barrier before its recheck.
  let bAtBarrier;
  const bReached = new Promise((resolve) => { bAtBarrier = resolve; });
  let releaseB;
  const barrier = new Promise((resolve) => { releaseB = resolve; });
  const bRun = runDispatch({ env, loadEvent, api: makeApi(), onBeforePost: async () => { bAtBarrier(); await barrier; } });

  await bReached;                                     // B has authorized (saw no marker) and is paused
  const aEvidence = await runDispatch({ env, loadEvent, api: makeApi() }); // A authorizes (empty) and posts
  releaseB();                                         // release B: its recheck now sees A's comment

  assert.equal(aEvidence.commentAuthor, 'github-actions[bot]');
  await assert.rejects(bRun, /duplicate/u);
  assert.equal(comments.length, 1, 'exactly one @codex fix comment was posted');
});
