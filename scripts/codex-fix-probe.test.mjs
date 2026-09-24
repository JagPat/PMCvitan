import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  authorizeCodexFixDispatch,
  PROBE_TRAILER_KEY,
  codexFixComment,
  dedupPrefix,
  expectedAuthorization,
  isGenuineUnresolvedFinding,
  probeMarker,
  probeTrailer,
  probeTrailerValue,
  probeTrailersIn,
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
  // The request asks for the binding trailer, verbatim, on every commit.
  assert.ok(body.includes(`\n${probeTrailer({ pullRequest: 597, headSha, findingRef })}\n`));
  assert.match(body, /EVERY commit you push for this request/u);
});

test('the binding trailer repeats the request identity and is parsed back exactly', () => {
  const identity = { pullRequest: 597, headSha, findingRef };
  const value = probeTrailerValue(identity);
  assert.equal(value, `pr-597:head-${headSha}:finding-${findingRef}`);
  assert.equal(probeTrailer(identity), `${PROBE_TRAILER_KEY}: ${value}`);
  // A trailer in the terminal block is read back; one per line, in order; trailing spaces trimmed.
  assert.deepEqual(probeTrailersIn(`fix: x\n\nBody.\n\n${probeTrailer(identity)}  \nCo-Authored-By: a`), [value]);
  assert.deepEqual(probeTrailersIn('x\n\nCodex-Fix-Probe: a\nCodex-Fix-Probe: b\n'), ['a', 'b']);
  // Keys match case-insensitively, as git's do, so a differently-cased trailer is still reported.
  assert.deepEqual(probeTrailersIn(`x\n\ncodex-fix-probe: ${value}`), [value]);
  // An empty value is reported as empty (it cannot equal the requested value), never dropped.
  assert.deepEqual(probeTrailersIn('x\n\nCodex-Fix-Probe:\n'), ['']);
  // A missing message is unreadable, never "none".
  for (const message of [null, undefined, 42]) assert.equal(probeTrailersIn(message), null, String(message));
});

test('finding 4089074932: only the terminal trailer block counts; a quoted, fenced, mid-body or folded value does not', () => {
  const trailer = probeTrailer({ pullRequest: 597, headSha, findingRef });
  const value = probeTrailerValue({ pullRequest: 597, headSha, findingRef });
  for (const message of [
    `x see ${trailer}`, // mid-line
    trailer, // the subject alone is never a trailer block
    `x\n\n${trailer}\n\nFollowed by ordinary prose.\n`, // not the terminal paragraph
    `x\n\n\`\`\`\n${trailer}\n\`\`\`\n`, // quoted in a code fence
    `x\n\nThe request said:\n${trailer}\n`, // prose in the block, no recognized trailer
  ]) {
    assert.deepEqual(probeTrailersIn(message), [], JSON.stringify(message));
  }
  // A folded continuation is joined into the value, so it no longer equals the requested one.
  assert.deepEqual(probeTrailersIn(`x\n\n${trailer}\n continuation\n`), [`${value} continuation`]);
});

test('probeTrailersIn agrees with real `git interpret-trailers --parse --unfold`', () => {
  for (const message of [
    'x\n\nCodex-Fix-Probe: a\n',
    'x\n\nCodex-Fix-Probe: a\n continued\nOther: b\n',
    'x\n\nprose\nCodex-Fix-Probe: a\n',
    'x\n\nprose\nSigned-off-by: s <s@x>\nCodex-Fix-Probe: a\n',
    'x\n\nCodex-Fix-Probe: a\n\nprose\n',
    'x\r\n\r\nCodex-Fix-Probe: a\r\n',
  ]) {
    const git = execFileSync('git', ['-c', 'trailer.separators=:', 'interpret-trailers', '--parse', '--unfold'], {
      input: message, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
    }).split('\n').filter((line) => /^codex-fix-probe:/iu.test(line)).map((line) => line.slice(line.indexOf(':') + 1).trim());
    assert.deepEqual(probeTrailersIn(message), git, JSON.stringify(message));
  }
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

test('the pre-post recheck reruns the full authorizer: a mid-window resolve, retarget or withdrawal aborts with no post', async () => {
  const commentId = 4023550608;
  const env = { GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REF: 'refs/heads/main', PROBE_PR_NUMBER: '597', PROBE_HEAD_SHA: headSha, PROBE_FINDING_COMMENT_ID: String(commentId), PROBE_AUTHORIZATION: expectedAuthorization({ pullRequest: 597, headSha }) };
  const loadEvent = () => ({ repository: { full_name: repository } });
  for (const [label, mutate] of [
    ['selected thread resolved', (state) => { state.threadUnresolved = false; }],
    ['PR retargeted off main', (state) => { state.pull = livePull({ base: { ref: 'release', sha: base, repo: { full_name: repository } } }); }],
    ['finding body withdrawn', (state) => { state.comment = findingComment({ body: 'withdrawn — no severity here' }); }],
  ]) {
    const comments = [];
    const state = { pull: livePull(), comment: findingComment(), threadUnresolved: true };
    const api = {
      getPull: async () => state.pull,
      getReviewComment: async () => state.comment,
      threadUnresolved: async () => state.threadUnresolved,
      listComments: async () => comments.map((comment) => ({ ...comment })),
      postComment: async (_repo, _n, body) => { const created = { id: comments.length + 1, user: { login: 'github-actions[bot]' }, body }; comments.push(created); return created; },
    };
    await assert.rejects(
      runDispatch({ env, loadEvent, api, onBeforePost: async () => { mutate(state); } }),
      /stale_before_post/u,
      label,
    );
    assert.equal(comments.length, 0, `${label}: nothing was posted`);
  }
});

test('the probe workflow declares a non-cancelling per-PR concurrency group, the main-ref guard and minimal permissions', () => {
  const workflow = readFileSync(new URL('../.github/workflows/codex-fix-probe.yml', import.meta.url), 'utf8');
  assert.match(workflow, /on:\s*\n\s*workflow_dispatch:/u);
  assert.match(workflow, /concurrency:\s*\n\s*group: codex-fix-probe-pr-/u);
  assert.match(workflow, /cancel-in-progress: false/u);
  assert.match(workflow, /if: github\.ref == 'refs\/heads\/main'/u);
  assert.match(workflow, /^permissions: \{\}/mu);
  assert.match(workflow, /pull-requests: write/u);
  assert.match(workflow, /contents: read/u);
  assert.doesNotMatch(workflow, /contents: write|actions: write|checks: write|statuses: write/u);
  assert.match(workflow, /actions\/checkout@11d5960a326750d5838078e36cf38b85af677262/u);
  assert.match(workflow, /node scripts\/codex-fix-probe\.mjs dispatch/u);
});
