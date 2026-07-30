import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  assessConvergence,
  assessReviewScope,
  codexFindingHeads,
  isDocsOnlyDiff,
  PLAN_REVIEW_ROUND_CAP,
  REQUIRED_INVARIANTS,
} from './review-efficiency.mjs';
import { run as runScope } from './review-scope.mjs';

const CODEX = 'chatgpt-codex-connector[bot]';

function pullRequest(overrides = {}) {
  return {
    number: 247,
    additions: 700,
    deletions: 300,
    changed_files: 12,
    body: '',
    ...overrides,
  };
}

function justifiedLargeBody(categories = REQUIRED_INVARIANTS) {
  return [
    '<!-- review-size: justified-large -->',
    '## Review-unit justification',
    'This workflow crosses generated contracts and their acceptance fixture.',
    '',
    '## Invariant matrix',
    '| Invariant | Risk | Evidence |',
    '| --- | --- | --- |',
    ...categories.map((category) => `| ${category} | relevant risk | focused probe |`),
  ].join('\n');
}

test('standard review units pass without large-PR ceremony', () => {
  const result = assessReviewScope(pullRequest());
  assert.equal(result.state, 'standard');
  assert.equal(result.allowed, true);
  assert.equal(result.changedLines, 1_000);
});

test('the in-flight rollout PR and earlier are grandfathered from size evidence', () => {
  const result = assessReviewScope(pullRequest({
    number: 246,
    additions: 5_561,
    deletions: 27,
    changed_files: 31,
  }));
  assert.equal(result.state, 'grandfathered');
  assert.equal(result.allowed, true);
  assert.equal(result.large, true);
});

test('an unjustified large review unit fails before expensive CI', () => {
  const result = assessReviewScope(pullRequest({
    additions: 1_501,
    changed_files: 21,
  }));
  assert.equal(result.state, 'blocked');
  assert.equal(result.allowed, false);
  assert.match(result.detail, /justified-large/u);
  assert.match(result.detail, /invariant matrix/u);
});

test('a large review unit with an incomplete invariant matrix remains blocked', () => {
  const result = assessReviewScope(pullRequest({
    additions: 2_000,
    changed_files: 24,
    body: justifiedLargeBody(REQUIRED_INVARIANTS.slice(0, -1)),
  }));
  assert.equal(result.allowed, false);
  assert.match(result.detail, new RegExp(REQUIRED_INVARIANTS.at(-1), 'u'));
});

test('invariant labels without risk and evidence do not satisfy a large review unit', () => {
  const body = [
    '<!-- review-size: justified-large -->',
    '| Invariant | Risk | Evidence |',
    '| --- | --- | --- |',
    ...REQUIRED_INVARIANTS.map((invariant) => `| ${invariant} | | |`),
  ].join('\n');
  const result = assessReviewScope(pullRequest({
    additions: 2_000,
    changed_files: 24,
    body,
  }));
  assert.equal(result.allowed, false);
  assert.deepEqual(result.missingInvariants, REQUIRED_INVARIANTS);
});

test('instructional marker text cannot replace the leading size declaration', () => {
  const body = [
    '<!-- review-size: standard -->',
    '',
    'For a large PR use `<!-- review-size: justified-large -->`.',
    justifiedLargeBody().split('\n').slice(2).join('\n'),
  ].join('\n');
  const result = assessReviewScope(pullRequest({
    additions: 2_000,
    changed_files: 24,
    body,
  }));
  assert.equal(result.allowed, false);
  assert.match(result.detail, /justified-large marker/u);
});

test('a justified large review unit passes only with the complete invariant matrix', () => {
  const result = assessReviewScope(pullRequest({
    additions: 2_000,
    changed_files: 24,
    body: justifiedLargeBody(),
  }));
  assert.equal(result.state, 'justified_large');
  assert.equal(result.allowed, true);
  assert.deepEqual(result.missingInvariants, []);
});

test('finding history counts distinct Codex heads and ignores human comments', () => {
  const comments = [
    {
      user: { login: CODEX },
      original_commit_id: 'a'.repeat(40),
      commit_id: 'd'.repeat(40),
    },
    { user: { login: CODEX }, commit_id: 'a'.repeat(40) },
    {
      user: { login: CODEX },
      original_commit_id: 'b'.repeat(40),
      commit_id: 'd'.repeat(40),
    },
    { user: { login: 'human-reviewer' }, commit_id: 'c'.repeat(40) },
  ];
  assert.deepEqual(codexFindingHeads(comments), [
    'a'.repeat(40),
    'b'.repeat(40),
  ]);
});

test('finding history includes blocking Codex review records without inline comments', () => {
  const result = assessConvergence({
    comments: [],
    reviews: [
      { user: { login: CODEX }, commit_id: 'a'.repeat(40) },
      { user: { login: CODEX }, commit_id: 'b'.repeat(40) },
    ],
    headMessage: 'fix: isolated patch',
    changedFiles: [],
  });
  assert.equal(result.required, true);
  assert.equal(result.allowed, false);
  assert.equal(result.findingHeadCount, 2);
});

test('one finding head still permits an ordinary correction', () => {
  const result = assessConvergence({
    comments: [{ user: { login: CODEX }, commit_id: 'a'.repeat(40) }],
    headMessage: 'fix: one review finding',
    changedFiles: ['apps/web/src/store/store.ts'],
  });
  assert.equal(result.required, false);
  assert.equal(result.allowed, true);
  assert.equal(result.findingHeadCount, 1);
});

test('two finding heads require both the convergence trailer and packet', () => {
  const comments = [
    { user: { login: CODEX }, commit_id: 'a'.repeat(40) },
    { user: { login: CODEX }, commit_id: 'b'.repeat(40) },
  ];

  const missingBoth = assessConvergence({
    comments,
    headMessage: 'fix: another isolated patch',
    changedFiles: ['apps/web/src/store/store.ts'],
  });
  assert.equal(missingBoth.required, true);
  assert.equal(missingBoth.allowed, false);
  assert.deepEqual(missingBoth.missing, ['trailer', 'packet']);

  // A trailer demoted to body text by a blank line above the final block is
  // the common authoring mistake. It is still a refusal, but the reason names
  // the actual cause instead of reading as "you forgot it".
  const misplaced = assessConvergence({
    comments,
    headMessage: [
      'fix: batched correction',
      '',
      'Review-Convergence: complete',
      '',
      'Co-Authored-By: Someone <someone@example.com>',
    ].join('\n'),
    changedFiles: ['docs/reviews/pr-247-convergence.md'],
  });
  assert.equal(misplaced.allowed, false);
  assert.equal(misplaced.hasTrailer, false);
  assert.equal(misplaced.missing.length, 1);
  assert.match(misplaced.missing[0], /git does not parse it as a trailer/u);

  // The same three lines with no blank line above the trailer DO parse.
  const wellFormed = assessConvergence({
    comments,
    headMessage: [
      'fix: batched correction',
      '',
      'Review-Convergence: complete',
      'Co-Authored-By: Someone <someone@example.com>',
    ].join('\n'),
    changedFiles: ['docs/reviews/pr-247-convergence.md'],
  });
  assert.equal(wellFormed.allowed, true);

  // A genuinely absent trailer keeps the plain word, with no misleading hint.
  const absent = assessConvergence({
    comments,
    headMessage: 'fix: batched correction\n\nCo-Authored-By: Someone <someone@example.com>',
    changedFiles: ['docs/reviews/pr-247-convergence.md'],
  });
  assert.deepEqual(absent.missing, ['trailer']);

  const missingPacket = assessConvergence({
    comments,
    headMessage: 'fix: batched correction\n\nReview-Convergence: complete',
    changedFiles: ['apps/web/src/store/store.ts'],
  });
  assert.equal(missingPacket.allowed, false);
  assert.deepEqual(missingPacket.missing, ['packet']);

  const complete = assessConvergence({
    comments,
    headMessage: 'fix: batched correction\n\nReview-Convergence: complete',
    changedFiles: [
      'apps/web/src/store/store.ts',
      'docs/reviews/pr-247-convergence.md',
    ],
  });
  assert.equal(complete.required, true);
  assert.equal(complete.allowed, true);
  assert.deepEqual(complete.missing, []);
});

test('a removed packet or narrative marker cannot satisfy convergence', () => {
  const comments = [
    { user: { login: CODEX }, commit_id: 'a'.repeat(40) },
    { user: { login: CODEX }, commit_id: 'b'.repeat(40) },
  ];
  const packet = { filename: 'docs/reviews/pr-247-convergence.md', status: 'removed' };
  const removed = assessConvergence({
    comments,
    headMessage: 'fix: correction\n\nReview-Convergence: complete',
    changedFiles: [packet],
  });
  assert.equal(removed.allowed, false);
  assert.deepEqual(removed.missing, ['packet']);

  const narrative = assessConvergence({
    comments,
    headMessage: [
      'fix: correction',
      '',
      'Review-Convergence: complete',
      'This is narrative text, not a trailer.',
    ].join('\n'),
    changedFiles: [{ ...packet, status: 'modified' }],
  });
  assert.equal(narrative.allowed, false);
  assert.equal(narrative.missing.length, 1);
  assert.match(narrative.missing[0], /git does not parse it as a trailer/u);

  const finalTrailerBlock = assessConvergence({
    comments,
    headMessage: [
      'fix: correction',
      '',
      'Review-Convergence: complete',
      'Signed-off-by: Reviewer <reviewer@example.com>',
    ].join('\n'),
    changedFiles: [{ ...packet, status: 'modified' }],
  });
  assert.equal(finalTrailerBlock.allowed, true);

  const continuedMarker = assessConvergence({
    comments,
    headMessage: 'fix: correction\n\nReview-Convergence: complete\n continued',
    changedFiles: [{ ...packet, status: 'modified' }],
  });
  assert.equal(continuedMarker.allowed, false);
  assert.equal(continuedMarker.missing.length, 1);
  assert.match(continuedMarker.missing[0], /git does not parse it as a trailer/u);
});

test('agent guidance and the PR template share the executable policy vocabulary', async () => {
  const [agents, claude, loop, template] = await Promise.all([
    readFile(new URL('../AGENTS.md', import.meta.url), 'utf8'),
    readFile(new URL('../CLAUDE.md', import.meta.url), 'utf8'),
    readFile(new URL('../docs/AUTONOMOUS_LOOP.md', import.meta.url), 'utf8'),
    readFile(new URL('../.github/pull_request_template.md', import.meta.url), 'utf8'),
  ]);

  for (const text of [agents, claude, loop]) {
    assert.match(text, /20\s+files/u);
    assert.match(text, /1,500\s+changed lines/u);
    assert.match(text, /Review-Convergence: complete/u);
  }
  assert.match(template, /<!-- review-size: standard -->/u);
  assert.match(template, /<!-- review-size: justified-large -->/u);
  assert.match(agents, /authoritative PR head/u);
  assert.match(agents, /synthetic merge/u);
  for (const invariant of REQUIRED_INVARIANTS) {
    assert.match(template, new RegExp(invariant, 'u'));
  }
});

test('the dependency-free scope CLI returns success or failure from the PR event', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pmcvitan-review-scope-'));
  const eventPath = join(directory, 'event.json');
  const previousExitCode = process.exitCode;
  try {
    await writeFile(eventPath, JSON.stringify({ pull_request: pullRequest() }));
    const standard = await runScope({ eventPath });
    assert.equal(standard.allowed, true);
    assert.equal(process.exitCode, previousExitCode);

    await writeFile(eventPath, JSON.stringify({
      pull_request: pullRequest({ additions: 2_000, changed_files: 30 }),
    }));
    const blocked = await runScope({ eventPath });
    assert.equal(blocked.allowed, false);
    assert.equal(process.exitCode, 1);
  } finally {
    process.exitCode = previousExitCode;
    await rm(directory, { recursive: true, force: true });
  }
});

test('a docs-only diff is recognised, and any code file disqualifies it', () => {
  assert.equal(isDocsOnlyDiff([
    'docs/superpowers/plans/2026-07-29-phase-5-commercial-control.md',
    'docs/STATUS.md',
    { filename: 'docs/reviews/pr-252-convergence.md', status: 'modified' },
    'README.md',
  ]), true);

  // one script, schema, test or workflow file and it is no longer a plan review
  for (const code of [
    'scripts/review-efficiency.mjs',
    'apps/api/prisma/schema.prisma',
    'apps/web/tests/labour.test.ts',
    '.github/workflows/ci.yml',
  ]) {
    assert.equal(
      isDocsOnlyDiff(['docs/STATUS.md', code]),
      false,
      `${code} must disqualify a docs-only claim`,
    );
  }
  assert.equal(isDocsOnlyDiff([]), false, 'an empty diff is not a plan review');
});

// A plan has no executable surface, so a finding on it can never be answered
// with a RED→GREEN proof — only with more prose. PR #252 ran four finding-bearing
// heads (8/8/7/7, every finding correct) with no declining rate, because the
// convergence protocol demands a batched audit after two heads and never says
// when a DOCS-ONLY review is finished. This bounds it.
test('a docs-only review past the round cap must record a probe deferral', () => {
  const codexHeads = (n) => Array.from({ length: n }, (_, i) => ({
    user: { login: CODEX },
    commit_id: String.fromCharCode(97 + i).repeat(40),
  }));
  const packet = { filename: 'docs/reviews/pr-252-convergence.md', status: 'modified' };
  const docsOnly = ['docs/superpowers/plans/2026-07-29-phase-5.md', packet];

  // below the cap nothing changes: convergence trailer + packet is enough
  const withinCap = assessConvergence({
    comments: [],
    reviews: codexHeads(PLAN_REVIEW_ROUND_CAP - 1),
    headMessage: 'fix: correction\n\nReview-Convergence: complete',
    changedFiles: docsOnly,
    pullRequestFiles: docsOnly,
  });
  assert.equal(withinCap.allowed, true);
  assert.equal(withinCap.deferralRequired, false);

  // at the cap, the same head is no longer sufficient — the still-open
  // architectural questions must be named, with the probe and task that settle
  // each. This does NOT dismiss a finding; it moves its verification to where a
  // verification can exist.
  const atCap = assessConvergence({
    comments: [],
    reviews: codexHeads(PLAN_REVIEW_ROUND_CAP),
    headMessage: 'fix: correction\n\nReview-Convergence: complete',
    changedFiles: docsOnly,
    pullRequestFiles: docsOnly,
  });
  assert.equal(atCap.deferralRequired, true);
  assert.equal(atCap.allowed, false);
  assert.match(atCap.missing.join(' '), /Review-Deferred-To-Probes/u);

  const deferred = assessConvergence({
    comments: [],
    reviews: codexHeads(PLAN_REVIEW_ROUND_CAP),
    headMessage: [
      'fix: plan convergence, remainder deferred to probes',
      '',
      'Review-Convergence: complete',
      'Review-Deferred-To-Probes: phase-5-task-1',
    ].join('\n'),
    changedFiles: docsOnly,
    pullRequestFiles: docsOnly,
    // the trailer asserts the handoff; the packet is where it is written down
    packetText: '## Deferral ledger\n| Question | Probe | Settled by |\n'
      + '| --- | --- | --- |\n| does overage clamp? | 5w | phase-5-task-1 |\n',
  });
  assert.equal(deferred.allowed, true);
  assert.equal(deferred.deferredTo, 'phase-5-task-1');

  // the cap is for documents only: a CODE PR past the same round count still
  // owes an ordinary convergence head, because its findings ARE provable.
  const codePr = assessConvergence({
    comments: [],
    reviews: codexHeads(PLAN_REVIEW_ROUND_CAP),
    headMessage: 'fix: correction\n\nReview-Convergence: complete',
    changedFiles: ['scripts/review-efficiency.mjs', packet],
    pullRequestFiles: ['scripts/review-efficiency.mjs', packet],
  });
  assert.equal(codePr.deferralRequired, false);
  assert.equal(codePr.allowed, true);
});

test('a probe deferral must name the task that will settle it', () => {
  const reviews = Array.from({ length: PLAN_REVIEW_ROUND_CAP }, (_, i) => ({
    user: { login: CODEX },
    commit_id: String.fromCharCode(97 + i).repeat(40),
  }));
  const changedFiles = [
    'docs/superpowers/plans/plan.md',
    { filename: 'docs/reviews/pr-252-convergence.md', status: 'modified' },
  ];
  const bare = assessConvergence({
    comments: [],
    reviews,
    headMessage: [
      'fix: correction',
      '',
      'Review-Convergence: complete',
      'Review-Deferred-To-Probes: yes',
    ].join('\n'),
    changedFiles,
    pullRequestFiles: changedFiles,
  });
  assert.equal(
    bare.allowed,
    false,
    '"yes" names no task, so nothing is scheduled to settle the deferred findings',
  );
  assert.match(bare.missing.join(' '), /name the task/u);
});

// FINDING (#253 round 1 P2 ×3) — three ways isDocsOnlyDiff misclassified a diff.
test('runnable and schema files never count as documentation, wherever they live', () => {
  for (const runnable of [
    'docs/probes/foo.test.mjs',
    'docs/schema.prisma',
    'docs/tools/repair.ts',
    'docs/ci/deploy.yml',
    'docs/migrations/20270101_x/migration.sql',
    'docs/scripts/gen.py',
  ]) {
    assert.equal(
      isDocsOnlyDiff(['docs/STATUS.md', runnable]),
      false,
      `${runnable} runs, so it is provable and not a plan review`,
    );
  }
  // real documentation under docs/ still qualifies
  assert.equal(isDocsOnlyDiff(['docs/a.md', 'docs/reviews/b.md', 'docs/img/c.svg']), true);
});

// FINDING (#253 round 3 P2) — the trailer alone was accepted as the whole deferral.
test('a deferral needs the packet ledger, not just the trailer', () => {
  const reviews = Array.from({ length: PLAN_REVIEW_ROUND_CAP }, (_, i) => ({
    user: { login: CODEX },
    commit_id: String.fromCharCode(97 + i).repeat(40),
  }));
  const docsOnly = ['docs/superpowers/plans/plan.md', 'docs/reviews/pr-252-convergence.md'];
  const headMessage = [
    'fix: plan convergence, remainder deferred',
    '',
    'Review-Convergence: complete',
    'Review-Deferred-To-Probes: phase-5-task-1',
  ].join('\n');
  const base = {
    comments: [], reviews, headMessage, changedFiles: docsOnly, pullRequestFiles: docsOnly,
  };

  // a packet that says nothing about the handoff the trailer claims
  const noLedger = assessConvergence({
    ...base,
    packetText: '## Architectural cause\nThe folds were written locally.\n',
  });
  assert.equal(noLedger.allowed, false, 'the trailer asserts a handoff the packet does not record');
  assert.match(noLedger.missing.join(' '), /phase-5-task-1/u);

  // names the task but never says what it hands over
  const taskOnly = assessConvergence({
    ...base,
    packetText: '## Next\nphase-5-task-1 continues from here.\n',
  });
  assert.equal(taskOnly.allowed, false);

  // both artifacts agree on the same handoff
  const withLedger = assessConvergence({
    ...base,
    packetText: [
      '## Deferral ledger',
      '| Open question | Probe | Settled by |',
      '| --- | --- | --- |',
      '| does overage clamp? | 5w | phase-5-task-1 |',
    ].join('\n'),
  });
  assert.equal(withLedger.allowed, true);
  assert.equal(withLedger.deferredTo, 'phase-5-task-1');

  // an unreadable packet is not evidence of a ledger, and must not pass silently
  const unreadable = assessConvergence(base);
  assert.equal(unreadable.allowed, false);
  assert.match(unreadable.missing.join(' '), /could not be read/u);

  // below the cap none of this applies — no deferral is owed, so no ledger is either
  const withinCap = assessConvergence({
    ...base,
    reviews: reviews.slice(0, PLAN_REVIEW_ROUND_CAP - 1),
  });
  assert.equal(withinCap.allowed, true);
});

// FINDING (#253 round 2 P2) — a rename carries TWO paths and only one was classified.
test('a rename out of a runnable path disqualifies a docs-only diff', () => {
  // GitHub reports a rename as status:'renamed', filename = the NEW path,
  // previous_filename = the OLD one. Reading only `filename` made
  // scripts/old-gate.mjs -> docs/old-gate.md look like pure documentation while
  // runnable code was removed — the same defect as the `removed` filter, one step on.
  assert.equal(
    isDocsOnlyDiff([
      { filename: 'docs/STATUS.md', status: 'modified' },
      {
        filename: 'docs/old-gate.md',
        previous_filename: 'scripts/old-gate.mjs',
        status: 'renamed',
      },
    ]),
    false,
    'renaming a script into a docs path still removes runnable code',
  );
  // the reverse direction was already caught by `filename`; pin it so it stays caught
  assert.equal(
    isDocsOnlyDiff([
      {
        filename: 'scripts/gate.mjs',
        previous_filename: 'docs/gate.md',
        status: 'renamed',
      },
    ]),
    false,
  );
  // a doc moved to another doc path is still documentation on both sides
  assert.equal(
    isDocsOnlyDiff([
      {
        filename: 'docs/plans/b.md',
        previous_filename: 'docs/a.md',
        status: 'renamed',
      },
    ]),
    true,
  );
});

test('a deleted code file disqualifies a docs-only diff', () => {
  assert.equal(
    isDocsOnlyDiff([
      { filename: 'docs/STATUS.md', status: 'modified' },
      { filename: 'scripts/old-gate.mjs', status: 'removed' },
    ]),
    false,
    'deleting a script is a provable change, not a plan edit',
  );
  // a removed DOC is still documentation
  assert.equal(
    isDocsOnlyDiff([
      { filename: 'docs/STATUS.md', status: 'modified' },
      { filename: 'docs/old-plan.md', status: 'removed' },
    ]),
    true,
  );
});

// The gate passes the HEAD COMMIT's files as changedFiles. A code PR whose fourth
// head is a convergence-packet-only commit would therefore look docs-only and be
// blocked pending a deferral trailer that means nothing for it — this fix must not
// break the ordinary code convergence flow it is meant to leave alone.
test('the docs-only cap reads the whole PR, not just the convergence commit', () => {
  const reviews = Array.from({ length: PLAN_REVIEW_ROUND_CAP }, (_, i) => ({
    user: { login: CODEX },
    commit_id: String.fromCharCode(97 + i).repeat(40),
  }));
  const packetOnlyHead = [
    { filename: 'docs/reviews/pr-249-convergence.md', status: 'modified' },
  ];
  const headMessage = 'fix: batched correction\n\nReview-Convergence: complete';

  // a CODE pr: the cumulative diff carries scripts, so no deferral is owed even
  // though this head touched only the packet
  const codePr = assessConvergence({
    comments: [],
    reviews,
    headMessage,
    changedFiles: packetOnlyHead,
    pullRequestFiles: ['scripts/check-run-coverage.mjs', 'docs/reviews/pr-249-convergence.md'],
  });
  assert.equal(codePr.deferralRequired, false, 'a code PR keeps the ordinary protocol');
  assert.equal(codePr.allowed, true);

  // a genuine plan pr: the cumulative diff is documentation only
  const planPr = assessConvergence({
    comments: [],
    reviews,
    headMessage,
    changedFiles: packetOnlyHead,
    pullRequestFiles: ['docs/superpowers/plans/plan.md', 'docs/reviews/pr-252-convergence.md'],
  });
  assert.equal(planPr.deferralRequired, true);
  assert.equal(planPr.allowed, false);

  // unknown cumulative diff: fail toward the CODE path, which asks for an
  // ordinary convergence head rather than a deferral it cannot justify
  const unknown = assessConvergence({
    comments: [], reviews, headMessage, changedFiles: packetOnlyHead,
  });
  assert.equal(unknown.deferralRequired, false);
  assert.equal(unknown.allowed, true);
});
