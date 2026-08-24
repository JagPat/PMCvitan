import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CODEX_GRAPHQL_LOGIN,
  CODEX_LOGIN,
  codexThreadIdsToResolve,
  classifyCodexState,
  isEligiblePullRequest,
} from './autonomous-review-state.mjs';
import { eligibleShape } from './autonomous-review-gate.mjs';

const HEAD = 'a'.repeat(40);
const OLD_HEAD = 'b'.repeat(40);
const READY_AT = '2026-07-27T10:00:00Z';
const DEADLINE = '2026-07-27T10:15:00Z';

function input(overrides = {}) {
  return {
    expectedHead: HEAD,
    readyAt: READY_AT,
    deadline: DEADLINE,
    now: '2026-07-27T10:05:00Z',
    reviews: [],
    comments: [],
    reactions: [],
    ...overrides,
  };
}

test('accepts only open same-repository pull requests that target main', () => {
  const eligible = {
    state: 'OPEN',
    headRefName: 'claude/fix-readiness',
    baseRefName: 'main',
    headRepository: { nameWithOwner: 'JagPat/PMCvitan' },
    baseRepository: { nameWithOwner: 'JagPat/PMCvitan' },
  };

  assert.equal(isEligiblePullRequest(eligible), true);
  assert.equal(
    isEligiblePullRequest({
      ...eligible,
      headRepository: { nameWithOwner: 'someone/fork' },
    }),
    false,
  );
  assert.equal(isEligiblePullRequest({ ...eligible, state: 'CLOSED' }), false);

  // THE BASE REF, which is the third placement of the lineage base rule. #402 sited it at
  // admission and settlement; neither keeps an off-`main` unit OUT of the lifecycle, and
  // exhaustion deliberately takes no base test — so before this guard a `release`-targeted
  // unit could be labelled `review-replacement-required` and its repository-wide obligation
  // then refused every fresh `main` unit.
  assert.equal(isEligiblePullRequest({ ...eligible, baseRefName: 'release' }), false);
  assert.equal(isEligiblePullRequest({ ...eligible, baseRefName: 'claude/other-unit' }), false);
  // Unreadable is refused too: eligibility only ever decides NOT to act, so an absent base
  // is fail-closed rather than assumed to be `main`.
  assert.equal(isEligiblePullRequest({ ...eligible, baseRefName: undefined }), false);
});

test('the eligibility base rule reaches the orchestrator, which is the placement that matters', () => {
  // The rule was unreachable here before because `eligibleShape` did not project the base
  // ref at all. Asserting the PROJECTION as well as the predicate is what stops a later
  // edit from dropping the field and silently restoring the hole: the predicate would keep
  // passing its own unit tests while every real pull request became ineligible.
  const projected = eligibleShape({
    state: 'OPEN',
    head: { ref: 'claude/x', repo: { full_name: 'JagPat/PMCvitan' } },
    base: { ref: 'release', repo: { full_name: 'JagPat/PMCvitan' } },
  });
  assert.equal(projected.baseRefName, 'release',
    'eligibleShape must carry the base ref, or the guard cannot see it');
  assert.equal(isEligiblePullRequest(projected), false);

  const onMain = eligibleShape({
    state: 'OPEN',
    head: { ref: 'claude/x', repo: { full_name: 'JagPat/PMCvitan' } },
    base: { ref: 'main', repo: { full_name: 'JagPat/PMCvitan' } },
  });
  assert.equal(isEligiblePullRequest(onMain), true);
});

test('classifies a fresh Codex thumbs-up as clear', () => {
  const result = classifyCodexState(
    input({
      reactions: [
        {
          user: { login: CODEX_LOGIN },
          content: '+1',
          created_at: '2026-07-27T10:01:00Z',
        },
      ],
    }),
  );

  assert.deepEqual(result, {
    state: 'clear',
    findingCount: 0,
    detail: 'fresh Codex +1 for this review attempt',
  });
});

test('ignores a clean reaction created before the current ready transition', () => {
  const result = classifyCodexState(
    input({
      reactions: [
        {
          user: { login: CODEX_LOGIN },
          content: '+1',
          created_at: '2026-07-27T09:59:59Z',
        },
      ],
    }),
  );

  assert.equal(result.state, 'pending');
});

test('does not trust the GraphQL thread alias in REST review evidence', () => {
  const result = classifyCodexState(
    input({
      reactions: [
        {
          user: { login: CODEX_GRAPHQL_LOGIN },
          content: '+1',
          created_at: '2026-07-27T10:01:00Z',
        },
      ],
    }),
  );

  assert.equal(result.state, 'pending');
});

test('current-head inline findings block even when a fresh clean reaction exists', () => {
  const result = classifyCodexState(
    input({
      comments: [
        {
          user: { login: CODEX_LOGIN },
          commit_id: HEAD,
          body: '**P1** preserve evidence',
        },
        {
          user: { login: CODEX_LOGIN },
          commit_id: HEAD,
          body: '**P1** preserve evidence',
        },
      ],
      reactions: [
        {
          user: { login: CODEX_LOGIN },
          content: '+1',
          created_at: '2026-07-27T10:02:00Z',
        },
      ],
    }),
  );

  assert.deepEqual(result, {
    state: 'changes_required',
    findingCount: 1,
    detail: '1 current-head Codex finding',
  });
});

test('a current-head Codex review is conservatively blocking without a clean reaction', () => {
  const result = classifyCodexState(
    input({
      reviews: [
        {
          user: { login: CODEX_LOGIN },
          commit_id: HEAD,
          state: 'COMMENTED',
        },
      ],
    }),
  );

  assert.deepEqual(result, {
    state: 'changes_required',
    findingCount: 1,
    detail: 'Codex submitted a current-head review',
  });
});

test('ignores Codex findings attached to an older head', () => {
  const result = classifyCodexState(
    input({
      reviews: [
        {
          user: { login: CODEX_LOGIN },
          commit_id: OLD_HEAD,
          state: 'COMMENTED',
        },
      ],
      comments: [
        {
          user: { login: CODEX_LOGIN },
          commit_id: OLD_HEAD,
          body: 'old finding',
        },
      ],
    }),
  );

  assert.equal(result.state, 'pending');
  assert.equal(result.findingCount, 0);
});

test('a carried-forward comment from an earlier review does not count as a current-head finding', () => {
  // Observed on PR #230. Codex reviewed 0832c7d and left ten inline comments. Claude fixed all ten
  // and pushed 6d17949. GitHub advanced `commit_id` to the new head on the four comments whose
  // anchors still resolved, so the gate read "4 current-head Codex findings" and returned the pull
  // request to draft — while `/pulls/230/reviews` still showed only the two reviews of 0832c7d and
  // no review of 6d17949 existed at all. Left uncorrected this never converges: every corrective
  // push inherits the previous round's still-anchorable comments, so nothing can ever merge.
  const result = classifyCodexState(
    input({
      comments: [
        {
          user: { login: CODEX_LOGIN },
          commit_id: HEAD, // GitHub rolled this forward
          original_commit_id: OLD_HEAD, // …but Codex posted it against the previous head
          body: '**P1** already fixed in the new head',
        },
      ],
    }),
  );

  assert.equal(result.state, 'pending');
  assert.equal(result.findingCount, 0);
});

test('a finding posted against the current head still blocks when its comment has both SHAs', () => {
  const result = classifyCodexState(
    input({
      comments: [
        {
          user: { login: CODEX_LOGIN },
          commit_id: HEAD,
          original_commit_id: HEAD,
          body: '**P1** genuinely about this head',
        },
      ],
    }),
  );

  assert.deepEqual(result, {
    state: 'changes_required',
    findingCount: 1,
    detail: '1 current-head Codex finding',
  });
});

test('resolves only historical unresolved threads opened by Codex', () => {
  assert.deepEqual(
    codexThreadIdsToResolve([
      {
        id: 'codex-open',
        isResolved: false,
        comments: {
          nodes: [{ author: { login: CODEX_LOGIN }, originalCommit: { oid: 'old' } }],
        },
      },
      {
        id: 'codex-resolved',
        isResolved: true,
        comments: {
          nodes: [{ author: { login: CODEX_LOGIN }, originalCommit: { oid: 'old' } }],
        },
      },
      {
        id: 'codex-current-head',
        isResolved: false,
        comments: {
          nodes: [{ author: { login: CODEX_LOGIN }, originalCommit: { oid: HEAD } }],
        },
      },
      {
        id: 'codex-graphql-open',
        isResolved: false,
        comments: {
          nodes: [{ author: { login: CODEX_GRAPHQL_LOGIN }, originalCommit: { oid: 'old' } }],
        },
      },
      {
        id: 'human-open',
        isResolved: false,
        comments: {
          nodes: [{ author: { login: 'reviewer' }, originalCommit: { oid: 'old' } }],
        },
      },
    ], HEAD),
    ['codex-open', 'codex-graphql-open'],
  );
});

test('remains pending before the deadline when Codex has not responded', () => {
  const result = classifyCodexState(input());

  assert.deepEqual(result, {
    state: 'pending',
    findingCount: 0,
    detail: 'waiting for a current-head Codex result',
  });
});

test('times out after the bounded deadline', () => {
  const result = classifyCodexState(
    input({ now: '2026-07-27T10:15:01Z' }),
  );

  assert.deepEqual(result, {
    state: 'timed_out',
    findingCount: 0,
    detail: 'Codex did not respond before the deadline',
  });
});
