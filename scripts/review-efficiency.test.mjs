import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  assessConvergence,
  assessReviewScope,
  codexFindingHeads,
  REQUIRED_INVARIANTS,
} from './review-efficiency.mjs';
import { run as runScope } from './review-scope.mjs';
import { GitHubClient } from './autonomous-review-gate.mjs';

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
  assert.deepEqual(narrative.missing, ['trailer']);

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
  assert.deepEqual(continuedMarker.missing, ['trailer']);
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

// FINDING (#250 P2) — convergence counts finding-bearing HEADS, so it must
// discount the same findings the current-head classifier does. Otherwise a head
// whose findings all argued from absent commits still pushes a later correction
// over the two-head threshold and demands trailer + packet evidence for
// findings that were never about this repository.
test('heads whose findings cite only absent commits are not finding heads', () => {
  const ABSENT_A = 'd'.repeat(40);
  const ABSENT_B = 'e'.repeat(40);
  const phantomOn = (head, sha) => ({
    user: { login: CODEX },
    original_commit_id: head,
    body: `Fresh evidence on the requested head \`${sha}\`: `
      + `\`git show -s --format=%B ${sha}\` has no Review-Convergence trailer.`,
  });
  const comments = [
    phantomOn('a'.repeat(40), ABSENT_A),
    phantomOn('b'.repeat(40), ABSENT_B),
  ];

  // Unresolved: both count, convergence is demanded (the fail-closed default).
  const unresolved = assessConvergence({
    comments,
    headMessage: 'fix: correction',
    changedFiles: ['scripts/x.mjs'],
  });
  assert.equal(unresolved.required, true);
  assert.equal(unresolved.findingHeadCount, 2);

  // Confirmed absent: neither head was ever a finding head.
  const discounted = assessConvergence({
    comments,
    headMessage: 'fix: correction',
    changedFiles: ['scripts/x.mjs'],
    missingCommits: new Set([ABSENT_A, ABSENT_B]),
  });
  assert.equal(discounted.required, false);
  assert.equal(discounted.findingHeadCount, 0);

  // A real finding among them still makes its own head count.
  const mixed = assessConvergence({
    comments: [
      ...comments,
      { user: { login: CODEX }, original_commit_id: 'c'.repeat(40), body: 'The lock is taken after the read.' },
    ],
    headMessage: 'fix: correction',
    changedFiles: ['scripts/x.mjs'],
    missingCommits: new Set([ABSENT_A, ABSENT_B]),
  });
  assert.equal(mixed.findingHeadCount, 1);
});

// FINDING (#250 P2) — GitHub uses 422 on this endpoint for validation and abuse
// handling as well as lookup failure, so only 404 proves a commit is absent.
test('only a 404 proves a commit is absent', async () => {
  const client = new GitHubClient({ repository: 'o/r', token: 't' });
  const answers = new Map([
    ['ok', null],
    ['404', new Error('GitHub GET /repos/o/r/commits/x failed (404): Not Found')],
    ['422', new Error('GitHub GET /repos/o/r/commits/x failed (422): Validation Failed')],
    ['403', new Error('GitHub GET /repos/o/r/commits/x failed (403): rate limited')],
    ['500', new Error('GitHub GET /repos/o/r/commits/x failed (500): oops')],
    ['net', new TypeError('fetch failed')],
  ]);
  for (const [label, error] of answers) {
    client.request = async () => { if (error) throw error; return {}; };
    const verdict = await client.commitExists('a'.repeat(40));
    if (label === 'ok') assert.equal(verdict, true);
    else if (label === '404') assert.equal(verdict, false, '404 is a definitive absence');
    else assert.equal(verdict, null, `${label} must stay unresolved, never an absence`);
  }
});

// FINDING (#250 round 2) — GitHub posts a COMMENTED review record alongside
// each set of inline comments. Filtering only the comments left that paired
// record to restore the very head the comments had just lost.
test('a paired COMMENTED review does not restore a discounted head', () => {
  const ABSENT_A = 'd'.repeat(40);
  const HEAD_A = 'a'.repeat(40);
  const HEAD_B = 'b'.repeat(40);
  const phantom = (head) => ({
    user: { login: CODEX },
    original_commit_id: head,
    body: `Fresh evidence on the requested head \`${ABSENT_A}\`: no trailer.`,
  });
  const paired = (head, state) => ({ user: { login: CODEX }, commit_id: head, state });

  const discounted = assessConvergence({
    comments: [phantom(HEAD_A), phantom(HEAD_B)],
    reviews: [paired(HEAD_A, 'COMMENTED'), paired(HEAD_B, 'COMMENTED')],
    headMessage: 'fix: correction',
    changedFiles: ['scripts/x.mjs'],
    missingCommits: new Set([ABSENT_A]),
  });
  assert.equal(discounted.findingHeadCount, 0);
  assert.equal(discounted.required, false);

  // CHANGES_REQUESTED is evidence of its own and still counts its head.
  const blocking = assessConvergence({
    comments: [phantom(HEAD_A), phantom(HEAD_B)],
    reviews: [paired(HEAD_A, 'CHANGES_REQUESTED'), paired(HEAD_B, 'CHANGES_REQUESTED')],
    headMessage: 'fix: correction',
    changedFiles: ['scripts/x.mjs'],
    missingCommits: new Set([ABSENT_A]),
  });
  assert.equal(blocking.findingHeadCount, 2);
  assert.equal(blocking.required, true);
});

