import test from 'node:test';
import assert from 'node:assert/strict';

import {
  citedCommits,
  citesBareHex,
  CODEX_GRAPHQL_LOGIN,
  CODEX_LOGIN,
  codexThreadIdsToResolve,
  classifyCodexState,
  isEligiblePullRequest,
  isUnfoundedFinding,
  reviewBodyFinding,
  reviewCarriesOwnFinding,
} from './autonomous-review-state.mjs';

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

test('accepts only open same-repository pull requests', () => {
  const eligible = {
    state: 'OPEN',
    headRefName: 'claude/fix-readiness',
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
    dismissedCount: 0,
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
    dismissedCount: 0,
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
    dismissedCount: 0,
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
    dismissedCount: 0,
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
    dismissedCount: 0,
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
    dismissedCount: 0,
    detail: 'Codex did not respond before the deadline',
  });
});

// ---------------------------------------------------------------------------
// Unfounded findings: a review claim argued from a commit that does not exist.
//
// The bodies below are the VERBATIM prose of real findings from PR #248 head
// `baf31b9` and PR #249 head `36a5377`, minus the AGENTS.md permalink where the
// original omitted it. Every SHA they name was checked with `git cat-file -t`
// against this repository and against `refs/pull/<n>/head`: none is an object
// here, while each reviewed head verifiably carried the trailer the finding
// says is missing. They are fixtures of a real failure, not invented ones.
// ---------------------------------------------------------------------------

const ABSENT = 'd822f79f1061fbe682d2755db2248bc3acd114c9';
const ABSENT_TOO = 'cdb23e72e758d0eb995f3588066396c10f3e4abe';

const PHANTOM_TRAILER_BODY = '**P1 Put the convergence trailer on d822f79**\n\n'
  + 'Fresh evidence on the requested single-parent head '
  + `\`${ABSENT}\` itself shows this verification is false: `
  + `\`git show -s --format='%(trailers:key=Review-Convergence,valueonly)' ${ABSENT}\` `
  + 'outputs nothing, and the repo\'s `assessConvergence` with the two recorded '
  + "finding heads reports `hasTrailer: false` / `missing: ['trailer']`.";

// The same finding as GitHub actually delivers it: with an AGENTS.md permalink
// whose URL embeds the REAL reviewed head. The permalink must not make the
// finding look like it reasons about that head.
const PHANTOM_WITH_PERMALINK = `${PHANTOM_TRAILER_BODY}\n\n`
  + `AGENTS.md reference: [AGENTS.md:L92-L95](https://github.com/JagPat/PMCvitan/blob/${HEAD}/AGENTS.md#L92-L95)`;

// A real PR #249 finding: names a file and an interleaving, no commit at all.
const FOUNDED_BODY = '**P1 Require all product descendants before clearing the watermark**\n\n'
  + "When GitHub exposes only a subset of a newer attempt's product check runs, "
  + 'this set treats the attempt as having products at all and removes its gate '
  + 'watermark for every product name.';

function codexComment(body, overrides = {}) {
  return {
    user: { login: CODEX_LOGIN },
    original_commit_id: HEAD,
    path: 'docs/reviews/pr-248-convergence.md',
    line: 286,
    body,
    ...overrides,
  };
}

test('citedCommits reads the prose, not the permalink', () => {
  assert.deepEqual(citedCommits(PHANTOM_TRAILER_BODY), [ABSENT]);
  // The permalink SHA is a location, not a claim: stripping it is what keeps a
  // fabricated-SHA finding from disguising itself as a finding about the head.
  assert.deepEqual(citedCommits(PHANTOM_WITH_PERMALINK), [ABSENT]);
  assert.deepEqual(citedCommits(FOUNDED_BODY), []);
  assert.deepEqual(citedCommits(undefined), []);
  // Abbreviated SHAs are not commit citations; they cannot be resolved and are
  // routinely used in prose, so a finding naming one is always founded.
  assert.deepEqual(citedCommits('the head d822f79 lacks it'), []);
});

test('a finding whose every cited commit is absent is not evidence', () => {
  const missing = new Set([ABSENT]);
  assert.equal(isUnfoundedFinding(codexComment(PHANTOM_TRAILER_BODY), missing), true);
  assert.equal(isUnfoundedFinding(codexComment(PHANTOM_WITH_PERMALINK), missing), true);

  // Every path that is not "definitively absent" keeps the finding.
  assert.equal(isUnfoundedFinding(codexComment(FOUNDED_BODY), missing), false);
  assert.equal(
    isUnfoundedFinding(codexComment(PHANTOM_TRAILER_BODY), new Set()),
    false,
    'an unresolved lookup must never discount a finding',
  );
  assert.equal(isUnfoundedFinding(codexComment(PHANTOM_TRAILER_BODY), undefined), false);
  // Names its own reviewed head as well: founded, even alongside an absent SHA.
  assert.equal(
    isUnfoundedFinding(codexComment(`${PHANTOM_TRAILER_BODY} on head ${HEAD}`), missing),
    false,
  );
  // Judged against its OWN posted head, so a historical comment is assessed on
  // the head it actually reviewed — this is what convergence counting needs.
  assert.equal(
    isUnfoundedFinding(
      codexComment(`on head ${OLD_HEAD} the trailer is missing`, {
        original_commit_id: OLD_HEAD,
      }),
      new Set([OLD_HEAD]),
    ),
    false,
    "a comment citing its own reviewed head is founded",
  );
});

// FINDING (#250 P1) — a 40-hex token is not necessarily a commit. Checksums,
// object ids and fixture values share the shape, and the commits endpoint 404s
// for every one of them, so extracting them indiscriminately would let a real
// finding ABOUT such a value be waived as an "absent commit".
test('bare hex data is not a commit citation and never permits a dismissal', () => {
  const CHECKSUM = 'f'.repeat(40);
  // A real finding about a checksum constant: no commit context anywhere.
  const aboutAChecksum = `The frozen digest \`${CHECKSUM}\` no longer matches the `
    + 'recomputed value, so the seal accepts a forged row.';
  assert.deepEqual(citedCommits(aboutAChecksum), []);
  assert.equal(citesBareHex(aboutAChecksum), true);
  assert.equal(
    isUnfoundedFinding(codexComment(aboutAChecksum), new Set([CHECKSUM])),
    false,
    'a finding about hex DATA must survive even when that value 404s as a commit',
  );

  // FINDING (#250 round 2) — `object` was in the context list, so "the object
  // key <hex> was deleted before commit" read as a commit citation and the
  // finding could be dismissed. An object key is exactly what the rule protects.
  const objectKey = `The object key ${CHECKSUM} is deleted before the commit lands, `
    + 'so the evidence photo is gone.';
  assert.deepEqual(citedCommits(objectKey), [], 'an object key is not a commit citation');
  assert.equal(citesBareHex(objectKey), true);
  assert.equal(isUnfoundedFinding(codexComment(objectKey), new Set([CHECKSUM])), false);

  // Commit context is what makes a token a citation.
  for (const phrase of ['head', 'commit', 'revision', 'git show -s', 'merge parent']) {
    assert.deepEqual(
      citedCommits(`evidence on the ${phrase} \`${ABSENT}\` shows nothing`),
      [ABSENT],
      `"${phrase}" must introduce a commit citation`,
    );
  }

  // A body mixing a cited commit with unrelated hex data is not dismissible:
  // the finding may be about the data, whatever the commit lookup says.
  const mixed = `${PHANTOM_TRAILER_BODY} and the digest ${CHECKSUM} is stale.`;
  assert.deepEqual(citedCommits(mixed), [ABSENT]);
  assert.equal(citesBareHex(mixed), true);
  assert.equal(
    isUnfoundedFinding(codexComment(mixed), new Set([ABSENT, CHECKSUM])),
    false,
  );
});

// FINDING (#250 P2) — discounting inline comments must not silently clear a
// review record that explicitly requested changes.
test('a CHANGES_REQUESTED review outlives the dismissal of its comments', () => {
  const CONTAINER = 987;
  const blocked = classifyCodexState(input({
    comments: [codexComment(PHANTOM_WITH_PERMALINK, { pull_request_review_id: CONTAINER })],
    reviews: [{
      user: { login: CODEX_LOGIN }, commit_id: HEAD, id: CONTAINER, state: 'CHANGES_REQUESTED',
    }],
    missingCommits: new Set([ABSENT]),
  }));
  assert.equal(blocked.state, 'changes_required');
  assert.match(blocked.detail, /requested changes on this exact head/u);
  assert.equal(blocked.dismissedCount, 1, 'the dismissal is still reported honestly');

  // The COMMENTED record that CARRIED the dismissed comments is discounted with
  // them — matched by id, not inferred from the head merely having comments.
  const cleared = classifyCodexState(input({
    comments: [codexComment(PHANTOM_WITH_PERMALINK, { pull_request_review_id: CONTAINER })],
    reviews: [{ user: { login: CODEX_LOGIN }, commit_id: HEAD, id: CONTAINER, state: 'COMMENTED' }],
    missingCommits: new Set([ABSENT]),
  }));
  assert.equal(cleared.state, 'clear');
  assert.equal(cleared.dismissedCount, 1);
});

// FINDING (#250 round 3) — a standalone COMMENTED review is its own statement.
// Suppressing every COMMENTED record whenever the head had any dismissed comment
// discarded review bodies that cited no absent SHA at all.
test('a COMMENTED review that carried nothing dismissed still blocks', () => {
  const CONTAINER = 987;
  const STANDALONE = 654;
  const result = classifyCodexState(input({
    comments: [codexComment(PHANTOM_WITH_PERMALINK, { pull_request_review_id: CONTAINER })],
    reviews: [
      { user: { login: CODEX_LOGIN }, commit_id: HEAD, id: CONTAINER, state: 'COMMENTED' },
      { user: { login: CODEX_LOGIN }, commit_id: HEAD, id: STANDALONE, state: 'COMMENTED' },
    ],
    missingCommits: new Set([ABSENT]),
  }));
  assert.equal(result.state, 'changes_required', 'the unmatched review is its own evidence');
  assert.equal(result.findingCount, 1);
  assert.equal(result.dismissedCount, 1);

  // And when the container link is absent entirely, nothing can be matched, so
  // the record survives — fail closed rather than guess.
  const unlinked = classifyCodexState(input({
    comments: [codexComment(PHANTOM_WITH_PERMALINK)],
    reviews: [{ user: { login: CODEX_LOGIN }, commit_id: HEAD, state: 'COMMENTED' }],
    missingCommits: new Set([ABSENT]),
  }));
  assert.equal(unlinked.state, 'changes_required');
});

// REPRODUCTION: at PR #248 head baf31b9 this was the ONLY finding, and it cost
// a full round. With the commit confirmed absent the head carries no finding.
test('a head whose only findings are unfounded is clear, and says so', () => {
  const result = classifyCodexState(input({
    comments: [codexComment(PHANTOM_WITH_PERMALINK)],
    missingCommits: new Set([ABSENT]),
  }));
  assert.equal(result.state, 'clear');
  assert.equal(result.findingCount, 0);
  assert.equal(result.dismissedCount, 1);
  assert.match(result.detail, /absent from this repository/u);

  // Without the confirmed absence the same head blocks — the filter is doing
  // the work, not the fixture.
  const unresolved = classifyCodexState(input({
    comments: [codexComment(PHANTOM_WITH_PERMALINK)],
  }));
  assert.equal(unresolved.state, 'changes_required');
  assert.equal(unresolved.findingCount, 1);
});

// REPRODUCTION: PR #249 head 36a5377 — "3 current-head Codex findings", of
// which two were phantom-trailer claims and one was a real watermark defect.
test('a mixed head keeps its real findings and reports the dismissals', () => {
  const result = classifyCodexState(input({
    comments: [
      codexComment(PHANTOM_TRAILER_BODY, { path: 'docs/reviews/pr-249-convergence.md', line: 6 }),
      codexComment(PHANTOM_WITH_PERMALINK, { path: 'docs/reviews/pr-249-convergence.md', line: 6 }),
      codexComment(FOUNDED_BODY, { path: 'scripts/check-run-coverage.mjs', line: 72 }),
    ],
    missingCommits: new Set([ABSENT, ABSENT_TOO]),
  }));
  assert.equal(result.state, 'changes_required');
  assert.equal(result.findingCount, 1, 'the real watermark finding must survive');
  assert.equal(result.dismissedCount, 2);
  assert.match(result.detail, /1 current-head Codex finding \(2 unfounded/u);
});

test('a Codex review record still blocks when it carried no inline findings', () => {
  // The review-record branch is the fallback for a blocking review with no
  // comments. Dismissing comments must not open a path around it.
  const result = classifyCodexState(input({
    reviews: [{ user: { login: CODEX_LOGIN }, commit_id: HEAD }],
    missingCommits: new Set([ABSENT]),
  }));
  assert.equal(result.state, 'changes_required');
  assert.equal(result.detail, 'Codex submitted a current-head review');
});

// FINDING (#250 round 2) — the URL stripper removed whole markdown links, so a
// finding naming the absent commit in LINK TEXT lost its citation entirely and
// could never be discounted. Only the URL target should be ignored.
test('a commit named in markdown link text is still a citation', () => {
  const linked = `Fresh evidence on [commit ${ABSENT}](https://github.com/o/r/commit/${ABSENT}) `
    + 'shows no trailer.';
  assert.deepEqual(citedCommits(linked), [ABSENT]);
  assert.equal(isUnfoundedFinding(codexComment(linked), new Set([ABSENT])), true);

  // The permalink's own SHA lives in the TARGET, which is still ignored — that
  // is what stops a permalink from disguising a fabricated citation.
  const permalinked = `${PHANTOM_TRAILER_BODY}\n\n`
    + `[AGENTS.md:L92-L95](https://github.com/JagPat/PMCvitan/blob/${HEAD}/AGENTS.md#L92-L95)`;
  assert.deepEqual(citedCommits(permalinked), [ABSENT]);
});


// FINDING (#250 round 3) — a commit word introduced only the SHA that followed
// it, but the window scanned the whole preceding text, so "on commit <a>, the
// object key <b>" marked <b> as a commit citation too.
test('a commit word binds only to the SHA it introduces', () => {
  const COMMIT = 'd'.repeat(40);
  const KEY = 'f'.repeat(40);
  const body = `On commit ${COMMIT}, the object key ${KEY} was deleted before the `
    + 'authorizing transaction committed.';
  assert.deepEqual(citedCommits(body), [COMMIT], 'only the introduced SHA is a citation');
  assert.equal(citesBareHex(body), true, 'the key is data the finding reasons about');
  assert.equal(
    isUnfoundedFinding(codexComment(body), new Set([COMMIT, KEY])),
    false,
    'a real finding about the key survives even when both lookups 404',
  );
});

// FINDING (#250 round 4 P2) — the context words were singular only, so
// "commits <a> and <b>" — the natural way to name two of them — left the second
// bare, and the whole finding then blocked on a citation nobody could inspect.
test('plural commit words introduce every SHA they name', () => {
  const A = 'd'.repeat(40);
  const B = 'e'.repeat(40);
  const plural = `The convergence trailer is missing on commits ${A} and ${B}.`;
  assert.deepEqual(citedCommits(plural), [A, B]);
  assert.equal(citesBareHex(plural), false, 'both are citations, neither is data');
  assert.equal(isUnfoundedFinding(codexComment(plural), new Set([A, B])), true);

  for (const phrase of ['heads', 'shas', 'revisions', 'refs', 'merge parents']) {
    assert.deepEqual(
      citedCommits(`the ${phrase} ${A} and ${B} disagree`),
      [A, B],
      `"${phrase}" must introduce both citations`,
    );
  }

  // The plural widened the window, so the sentence bound is what keeps it
  // honest: a digest in the NEXT sentence is data, not a third commit.
  const KEY = 'f'.repeat(40);
  const spillover = `${plural} The frozen digest ${KEY} no longer matches.`;
  assert.deepEqual(citedCommits(spillover), [A, B]);
  assert.equal(citesBareHex(spillover), true);
  assert.equal(
    isUnfoundedFinding(codexComment(spillover), new Set([A, B, KEY])),
    false,
    'the digest keeps the finding founded',
  );

  // The list continuation is symmetric: a plural DATA word keeps its whole list
  // data, so both halves of "the digests <a> and <b>" still block a dismissal.
  const dataList = `The frozen digests ${A} and ${B} no longer match the recomputed values.`;
  assert.deepEqual(citedCommits(dataList), []);
  assert.equal(citesBareHex(dataList), true);
  assert.equal(isUnfoundedFinding(codexComment(dataList), new Set([A, B])), false);

  // And a noun phrase between two SHAs is not list glue, so the second is
  // judged on its own context — the round-3 binding rule is intact.
  const notAList = `On commits ${A} and ${B}, the object key ${KEY} was deleted.`;
  assert.deepEqual(citedCommits(notAList), [A, B]);
  assert.equal(citesBareHex(notAList), true);
});

// FINDING (#250 round 4 P1) — the container filter dropped a review record
// whole once its comments were dismissed, without reading `body`. Codex writes
// its own findings there, and those cite no absent SHA at all.
test('a discounted container keeps the finding its own body carries', () => {
  const CONTAINER = 987;
  const carrying = classifyCodexState(input({
    comments: [codexComment(PHANTOM_WITH_PERMALINK, { pull_request_review_id: CONTAINER })],
    reviews: [{
      user: { login: CODEX_LOGIN },
      commit_id: HEAD,
      id: CONTAINER,
      state: 'COMMENTED',
      body: '💡 Codex Review\n\nHere are some automated review suggestions for this '
        + 'pull request.\n\n**P1** `gateWatermarks` clears the watermark for every '
        + 'name when one attempt is undecidable.',
    }],
    missingCommits: new Set([ABSENT]),
  }));
  assert.equal(carrying.state, 'changes_required', 'the body is a finding of its own');
  assert.equal(carrying.dismissedCount, 1, 'the comment is still reported dismissed');

  // Boilerplate alone is not a finding: the wrapper carries nothing its
  // comments did not, so it goes with them.
  const wrapperOnly = classifyCodexState(input({
    comments: [codexComment(PHANTOM_WITH_PERMALINK, { pull_request_review_id: CONTAINER })],
    reviews: [{
      user: { login: CODEX_LOGIN },
      commit_id: HEAD,
      id: CONTAINER,
      state: 'COMMENTED',
      body: '💡 Codex Review\n\nHere are some automated review suggestions for this '
        + `pull request.\n\n**Reviewed commit:** \`${HEAD}\``,
    }],
    missingCommits: new Set([ABSENT]),
  }));
  assert.equal(wrapperOnly.state, 'clear');
  assert.equal(wrapperOnly.dismissedCount, 1);
});


// ---------------------------------------------------------------------------
// Round 5. Rounds 3, 4 and 5 each found another sentence where a nearby commit
// word bound the wrong token, so the rule stopped being a proximity heuristic:
// a DATA word adjacent to the token now vetoes it outright, and the positive
// side requires the commit word to be ADJACENT rather than merely nearby.
// ---------------------------------------------------------------------------

test('a data word adjacent to the token vetoes any commit reading', () => {
  const COMMIT = 'd'.repeat(40);
  const DATA = 'f'.repeat(40);

  // FINDING (#250 round 5 P1) — a bare comma read as list glue, so
  // "On commit <a>, <b> is the object key" made the key a second citation.
  const comma = `On commit ${COMMIT}, ${DATA} is the object key deleted before commit`;
  assert.deepEqual(citedCommits(comma), [COMMIT], 'a comma is not a list');
  assert.equal(citesBareHex(comma), true);
  assert.equal(isUnfoundedFinding(codexComment(comma), new Set([COMMIT, DATA])), false);

  // FINDING (#250 round 5 P1) — the optional bare-`git` arm matched before an
  // object identifier, so "git object <hex>" read as a commit citation.
  for (const phrase of ['git object', 'git blob', 'git tree']) {
    const body = `The ${phrase} ${DATA} is removed before the authorizing transaction commits.`;
    assert.deepEqual(citedCommits(body), [], `"${phrase}" names an object, not a commit`);
    assert.equal(citesBareHex(body), true);
    assert.equal(isUnfoundedFinding(codexComment(body), new Set([DATA])), false);
  }

  // FINDING (#250 round 5 P1) — a commit word ANYWHERE in the sentence bound
  // the next token, so a digest after an unrelated clause became the citation.
  const nearby = `The current head status is clear, but the digest ${DATA} is stale`;
  assert.deepEqual(citedCommits(nearby), [], 'proximity is not introduction');
  assert.equal(citesBareHex(nearby), true);
  assert.equal(isUnfoundedFinding(codexComment(nearby), new Set([DATA])), false);

  // The data veto beats the positive rule even when both could match.
  const both = `On commit ${COMMIT} the checksum ${DATA} no longer matches.`;
  assert.deepEqual(citedCommits(both), [COMMIT]);
  assert.equal(citesBareHex(both), true);

  // The data veto carries the three phrases the finding named, so it — not the
  // narrowed git arm — is what defends them. The arm still has to be narrowed:
  // a git subcommand the list does not know, followed by a noun the veto does
  // not know, would otherwise make any hex its argument. Only a command that
  // TAKES a revision may introduce one.
  const unlisted = `The git verify-pack summary reported ${DATA} as unreachable.`;
  assert.deepEqual(citedCommits(unlisted), [], 'bare `git` introduces nothing');
  assert.equal(citesBareHex(unlisted), true);
  assert.equal(isUnfoundedFinding(codexComment(unlisted), new Set([DATA])), false);
});

test('an adjacent commit word still introduces its SHA, lists included', () => {
  const A = 'd'.repeat(40);
  const B = 'e'.repeat(40);
  for (const phrase of ['commit', 'head', 'revision', 'ref', 'merge parent']) {
    assert.deepEqual(
      citedCommits(`evidence on the ${phrase} \`${A}\` shows nothing`),
      [A],
      `"${phrase}" must still introduce a citation`,
    );
  }
  // A conjunction carries the list; the earlier bare-comma path does not.
  assert.deepEqual(citedCommits(`the trailer is missing on commits ${A} and ${B}.`), [A, B]);
  assert.equal(citesBareHex(`the trailer is missing on commits ${A} and ${B}.`), false);

  // A real git revision command still introduces its argument through flags.
  const quoted = `\`git show -s --format='%(trailers:key=Review-Convergence,valueonly)' ${A}\` outputs nothing`;
  assert.deepEqual(citedCommits(quoted), [A]);
});

// FINDING (#250 round 5 P2) — a review BODY argues from commits exactly as an
// inline comment does, but the absent-SHA test never reached it, so the wrapper
// kept blocking on the very citation its comments were discounted for.
test('a review body is subject to the same absent-SHA test', () => {
  const phantomBody = `Fresh evidence on the requested head \`${ABSENT}\` shows no trailer.`;
  const review = { user: { login: CODEX_LOGIN }, commit_id: HEAD, id: 7, state: 'COMMENTED', body: phantomBody };
  assert.equal(reviewCarriesOwnFinding(review, new Set([ABSENT])), false, 'the body cites only an absent commit');
  assert.equal(reviewCarriesOwnFinding(review, new Set()), true, 'unresolved: the body stands');

  const result = classifyCodexState(input({
    comments: [codexComment(PHANTOM_WITH_PERMALINK, { pull_request_review_id: 7 })],
    reviews: [review],
    missingCommits: new Set([ABSENT]),
  }));
  assert.equal(result.state, 'clear');

  // A body that cites its OWN reviewed head, or no SHA at all, still blocks.
  for (const body of [`The lock is taken after the read on ${HEAD}.`, 'The lock is taken after the read.']) {
    assert.equal(
      reviewCarriesOwnFinding({ ...review, body }, new Set([ABSENT])),
      true,
    );
  }
});

// FINDING (#250 round 5 P2) — the blanket <details> strip removed a collapsed
// FINDING along with the known wrapper, so a head could clear on a body that
// cited no SHA at all.
test('only the known Codex wrapper details block is boilerplate', () => {
  const wrapper = '<details> <summary>ℹ️ About Codex in GitHub</summary>\n\nCodex reviews PRs.\n</details>';
  const collapsed = '<details><summary>Repro</summary>\n\nThe watermark clears for every name.\n</details>';

  assert.equal(reviewBodyFinding({ body: `💡 Codex Review\n\n${wrapper}` }), '');
  assert.match(
    reviewBodyFinding({ body: `💡 Codex Review\n\n${collapsed}\n\n${wrapper}` }),
    /watermark clears for every name/u,
  );
  assert.equal(
    reviewCarriesOwnFinding(
      { user: { login: CODEX_LOGIN }, commit_id: HEAD, id: 7, state: 'COMMENTED', body: `💡 Codex Review\n\n${collapsed}` },
      new Set([ABSENT]),
    ),
    true,
    'a collapsed finding citing no SHA counts in full',
  );
});
