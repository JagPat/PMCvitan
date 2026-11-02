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

test('a Codex review that only replies in an older head\'s thread is not a current-head review (#638)', () => {
  // Observed on #638: a human reply in an old finding's thread mentioned Codex, and the connector's
  // account-setup answer was filed as a blank-bodied Codex review stamped with the new head. The
  // conservative rule read it as a finding and held a head no one had reviewed.
  const reply = {
    id: 9001,
    user: { login: CODEX_LOGIN },
    pull_request_review_id: 77,
    in_reply_to_id: 9000,
    original_commit_id: OLD_HEAD,
    commit_id: HEAD,
    path: 'docs/STATUS.md',
    body: 'To use Codex here, create a Codex account and connect to github.',
  };
  // The thread's root: the old finding, posted against OLD_HEAD by an earlier review.
  const root = {
    id: 9000,
    user: { login: CODEX_LOGIN },
    pull_request_review_id: 76,
    original_commit_id: OLD_HEAD,
    commit_id: HEAD,
    path: 'docs/STATUS.md',
    body: '**P2** old finding',
  };
  const replyOnly = { id: 77, user: { login: CODEX_LOGIN }, commit_id: HEAD, state: 'COMMENTED', body: '' };
  assert.equal(classifyCodexState(input({ reviews: [replyOnly], comments: [root, reply] })).state, 'pending');
  // A human reply between the root and Codex's answer resolves through the chain too.
  const human = { id: 9500, user: { login: 'JagPat' }, in_reply_to_id: 9000, original_commit_id: OLD_HEAD, commit_id: HEAD };
  assert.equal(classifyCodexState(input({
    reviews: [replyOnly], comments: [root, human, { ...reply, in_reply_to_id: 9500 }],
  })).state, 'pending');
  // The same with an absent body, as some readers return it.
  const { body: _omitted, ...bodiless } = replyOnly;
  assert.equal(classifyCodexState(input({ reviews: [bodiless], comments: [root, reply] })).state, 'pending');
  // ...and a fresh clean reaction on this head still clears it.
  assert.equal(classifyCodexState(input({
    reviews: [replyOnly],
    comments: [root, reply],
    reactions: [{ user: { login: CODEX_LOGIN }, content: '+1', created_at: '2026-07-27T10:01:00Z' }],
  })).state, 'clear');
});

test('the reply-only exemption is narrow: anything short of a proven reply-only review still blocks', () => {
  const reply = {
    id: 9001,
    user: { login: CODEX_LOGIN },
    pull_request_review_id: 77,
    in_reply_to_id: 9000,
    original_commit_id: OLD_HEAD,
    commit_id: HEAD,
    path: 'docs/STATUS.md',
    body: 'reply',
  };
  const root = { id: 9000, user: { login: CODEX_LOGIN }, pull_request_review_id: 76, original_commit_id: OLD_HEAD, commit_id: HEAD, body: 'old finding' };
  const review = { id: 77, user: { login: CODEX_LOGIN }, commit_id: HEAD, state: 'COMMENTED', body: '' };
  const blocks = (reviews, comments) => {
    const result = classifyCodexState(input({ reviews, comments }));
    assert.equal(result.state, 'changes_required');
    return result;
  };
  // The proven shape is exempt, so each case below differs from it in one respect.
  assert.equal(classifyCodexState(input({ reviews: [review], comments: [root, reply] })).state, 'pending');
  // A real review carries its summary body, whatever its comments are.
  assert.equal(blocks([{ ...review, body: '### 💡 Codex Review\n\nsuggestions' }], [root, reply]).detail,
    'Codex submitted a current-head review');
  // A blank review that owns no comment proves nothing.
  blocks([review], [root]);
  // A comment of another review, or another author's reply, is not this review's.
  blocks([review], [root, { ...reply, pull_request_review_id: 78 }]);
  blocks([review], [root, { ...reply, user: { login: 'JagPat' } }]);
  // A comment that OPENS a thread (no in_reply_to_id), even one carried from an older head.
  const { in_reply_to_id: _parent, ...opener } = reply;
  blocks([review], [root, opener]);
  // A reply in a thread on THIS head, which is a current-head comment in its own right.
  assert.equal(blocks([review], [root, { ...reply, original_commit_id: HEAD }]).detail, '1 current-head Codex finding');
  // One reply-only comment beside one thread opener in the same review.
  blocks([review], [root, reply, { ...opener, id: 9002, body: 'new thread' }]);
  // Only a COMMENTED review is a reply (#639 Codex finding 4110489910): a blank change request is a verdict.
  blocks([{ ...review, state: 'CHANGES_REQUESTED' }], [root, reply]);
  blocks([{ ...review, state: 'APPROVED' }], [root, reply]);
  blocks([{ ...review, state: 'commented' }], [root, reply]);
  const { state: _state, ...stateless } = review;
  blocks([stateless], [root, reply]);
  // A review without an id cannot be matched to its comments.
  const { id: _id, ...unidentified } = review;
  blocks([unidentified], [root, reply]);
  // THE THREAD MUST RESOLVE (#639 Codex finding 4110382385): the reply's own SHA is not the thread's.
  // An orphaned reply, whose parent is not in the complete list.
  blocks([review], [reply]);
  // A mismatched reply: it claims OLD_HEAD, but its thread's root was posted against this head.
  blocks([review], [{ ...root, original_commit_id: HEAD, user: { login: 'JagPat' } }, reply]);
  // A chain through a missing middle, and a cyclic chain that never reaches a root.
  blocks([review], [root, { ...reply, in_reply_to_id: 9400 }]);
  blocks([review], [{ ...root, in_reply_to_id: 9001 }, reply]);
  // A reply to itself is not a thread.
  blocks([review], [{ ...reply, in_reply_to_id: 9001 }]);
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

// #1254 (Jagrut's choice, #1094 6564512390) — Codex's review-state record, the shape seen on #1254 head 30511ae
function stateRecord({ head = HEAD, unresolved = false, status = 'completed', security = null, login = CODEX_LOGIN, at = '2026-07-27T10:04:00Z', raw } = {}) {
  const record = {
    code_review: { commit_sha: head, has_any_findings: true, has_unresolved_findings: unresolved, status },
    security_review: security ?? { commit_sha: null, has_any_findings: null, has_unresolved_findings: null, status: null },
  };
  return {
    user: { login },
    created_at: '2026-07-27T09:00:00Z',
    updated_at: at,
    body: `<!-- codex-pull-request-review-summary -->\n<!-- codex-review-state:v1 ${raw ?? JSON.stringify(record)} -->\n\n## Codex Review Summary`,
  };
}

test('#1254 — a completed clean Codex record on the exact head, written after readyAt, clears', () => {
  assert.deepEqual(classifyCodexState(input({ issueComments: [stateRecord()] })), {
    state: 'clear',
    findingCount: 0,
    detail: 'Codex completed this exact head with no unresolved findings',
  });
  // the same record past the deadline still clears rather than timing out
  assert.equal(classifyCodexState(input({ now: '2026-07-27T10:15:01Z', issueComments: [stateRecord()] })).state, 'clear');
});

test('#1254 — a record for another head, a run not completed, or one before readyAt is no verdict', () => {
  for (const record of [
    stateRecord({ head: OLD_HEAD }),
    stateRecord({ status: 'in_progress' }),
    stateRecord({ at: '2026-07-27T09:59:59Z' }),
  ]) {
    assert.equal(classifyCodexState(input({ issueComments: [record] })).state, 'pending');
    assert.equal(classifyCodexState(input({ now: '2026-07-27T10:15:01Z', issueComments: [record] })).state, 'timed_out');
  }
});

test('#1254 — a record with unresolved findings never clears, and vetoes another clean record', () => {
  assert.equal(classifyCodexState(input({ issueComments: [stateRecord({ unresolved: true })] })).state, 'pending');
  assert.equal(classifyCodexState(input({ issueComments: [stateRecord(), stateRecord({ unresolved: true })] })).state, 'pending');
  // a missing flag is not "no findings"
  assert.equal(classifyCodexState(input({ issueComments: [stateRecord({ unresolved: null })] })).state, 'pending');
  // nor does a security review with unresolved findings, or one still running on this head
  for (const security of [
    { commit_sha: HEAD, has_any_findings: true, has_unresolved_findings: true, status: 'completed' },
    { commit_sha: HEAD, has_any_findings: null, has_unresolved_findings: null, status: 'in_progress' },
  ]) {
    assert.equal(classifyCodexState(input({ issueComments: [stateRecord({ security })] })).state, 'pending');
  }
});

test('#1254 — a record from a non-Codex actor, or one that does not parse, is ignored', () => {
  for (const record of [
    stateRecord({ login: 'github-actions[bot]' }),
    stateRecord({ login: CODEX_GRAPHQL_LOGIN }),
    stateRecord({ raw: '{"code_review":' }),
    { ...stateRecord(), body: 'codex-review-state:v1 without the marker' },
  ]) {
    assert.equal(classifyCodexState(input({ issueComments: [record] })).state, 'pending');
  }
});

test('#1254 — the record never outranks a current-head finding or an unstable snapshot', () => {
  const finding = { user: { login: CODEX_LOGIN }, original_commit_id: HEAD, path: 'x.ts', line: 1, body: 'P2 finding' };
  assert.equal(classifyCodexState(input({ comments: [finding], issueComments: [stateRecord()] })).state, 'changes_required');
  const review = { id: 5, user: { login: CODEX_LOGIN }, commit_id: HEAD, body: 'review-level finding', state: 'COMMENTED' };
  assert.equal(classifyCodexState(input({ reviews: [review], issueComments: [stateRecord()] })).state, 'changes_required');
  assert.equal(classifyCodexState(input({ stable: false, issueComments: [stateRecord()] })).state, 'unsettled');
});

test('#1254 — a security review counts only on the same head, and its unresolved findings veto across records', () => {
  // security finished clean on an OLDER head: it does not stand in for this head
  const olderSecurity = { commit_sha: OLD_HEAD, has_any_findings: false, has_unresolved_findings: false, status: 'completed' };
  assert.equal(classifyCodexState(input({ issueComments: [stateRecord({ security: olderSecurity })] })).state, 'pending');
  // one Codex record clean, another with security findings unresolved on this head: the veto holds in either order
  const vetoing = stateRecord({ security: { commit_sha: HEAD, has_any_findings: true, has_unresolved_findings: true, status: 'completed' } });
  assert.equal(classifyCodexState(input({ issueComments: [stateRecord(), vetoing] })).state, 'pending');
  assert.equal(classifyCodexState(input({ issueComments: [vetoing, stateRecord()] })).state, 'pending');
});

test('Codex 4437814263 — an idle security section is clean only when wholly empty', () => {
  // status null, yet naming this head with unresolved findings: never clean, and it vetoes a clean record either way
  const contradictory = stateRecord({ security: { commit_sha: HEAD, has_any_findings: true, has_unresolved_findings: true, status: null } });
  assert.equal(classifyCodexState(input({ issueComments: [contradictory] })).state, 'pending');
  assert.equal(classifyCodexState(input({ issueComments: [stateRecord(), contradictory] })).state, 'pending');
  assert.equal(classifyCodexState(input({ issueComments: [contradictory, stateRecord()] })).state, 'pending');
  // status null with unresolved findings and no head, or naming another head: not idle, so no clear
  for (const security of [
    { commit_sha: null, has_any_findings: true, has_unresolved_findings: true, status: null },
    { commit_sha: OLD_HEAD, has_any_findings: null, has_unresolved_findings: null, status: null },
  ]) {
    assert.equal(classifyCodexState(input({ issueComments: [stateRecord({ security })] })).state, 'pending');
  }
  // Codex's real idle section (all null) still clears
  assert.equal(classifyCodexState(input({ issueComments: [stateRecord()] })).state, 'clear');
});

test('Codex 4437620372 — a same-head record that is not wholly clean vetoes a clean one, in either order and at any age', () => {
  const running = [
    stateRecord({ status: 'in_progress' }),
    stateRecord({ status: 'running', at: '2026-07-27T09:00:00Z' }),
    stateRecord({ security: { commit_sha: HEAD, has_any_findings: null, has_unresolved_findings: false, status: 'in_progress' } }),
  ];
  for (const other of running) {
    assert.equal(classifyCodexState(input({ issueComments: [stateRecord(), other] })).state, 'pending');
    assert.equal(classifyCodexState(input({ issueComments: [other, stateRecord()] })).state, 'pending');
  }
  // a record for another head is no veto
  assert.equal(classifyCodexState(input({ issueComments: [stateRecord(), stateRecord({ head: OLD_HEAD, status: 'in_progress' })] })).state, 'clear');
});
