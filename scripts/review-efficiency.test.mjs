import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  assessConvergence,
  deferralPhases,
  assessReviewScope,
  codexFindingHeads,
  isDocsOnlyDiff,
  PLAN_REVIEW_ROUND_CAP,
  REQUIRED_INVARIANTS,
} from './review-efficiency.mjs';
import { OPEN_TASK_STATES, parseStatusNow } from './autonomous-status-state.mjs';
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
      + '| --- | --- | --- |\n| does overage clamp? | probe 5w | phase-5-task-1 |\n',
    planText: '## Required plan probes\n5w. §0 COMMITTED close-short behaviour.\n',
    // and STATUS must SHOW phase 5 still has a review stop ahead of it — see the
    // fail-closed test below for why an absent phase set no longer passes
    activePhases: [5],
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
  assert.match(bare.missing.join(' '), /name the TASK/u);

  // FINDING (#253 round 6 P2) — the check was a BLOCKLIST of bare words, so any value the
  // list had not anticipated was accepted as a scheduled handoff. An allowlist of this
  // repository's own task vocabulary treats an unrecognised value as no task at all.
  for (const value of ['later', 'the next task', 'TBD', 'phase-5', 'task-1', 'soon']) {
    const notATask = assessConvergence({
      comments: [],
      reviews,
      headMessage: [
        'fix: correction',
        '',
        'Review-Convergence: complete',
        `Review-Deferred-To-Probes: ${value}`,
      ].join('\n'),
      changedFiles,
      pullRequestFiles: changedFiles,
    });
    assert.equal(notATask.allowed, false, `"${value}" is not a task reference`);
    assert.match(notATask.missing.join(' '), /name the TASK/u);
  }
  // the real shapes are accepted when STATUS shows their phase still has work — INCLUDING the
  // split-unit ids `docs/STATUS.md` actually uses. Lettered units have existed since Task 5A, so
  // `phase-5-task-6b` was rejected before any finer id was coined: a deferral trailer naming the
  // unit under review could never parse, which is the opposite of what the vocabulary is for.
  // `phase-5-task-7b-ii-b` is the third level, and it is not hypothetical: 7B-ii-a and 7B-ii-b
  // are merged, independently-cleared units, and STATUS carried that id before this test did.
  for (const value of [
    'phase-5-task-1', 'phase-6-planning', 'phase-5-task-6b', 'phase-5-task-6b-i',
    'phase-5-task-7b-ii-b', 'phase-5-task-7b-iii-a',
  ]) {
    const real = assessConvergence({
      comments: [],
      reviews,
      activePhases: [5, 6],
      headMessage: [
        'fix: correction',
        '',
        'Review-Convergence: complete',
        `Review-Deferred-To-Probes: ${value}`,
      ].join('\n'),
      changedFiles,
      pullRequestFiles: changedFiles,
      packetText: `## Deferral ledger\n| q? | probe 5w | ${value} |\n`,
      planText: '5w. §0 COMMITTED close-short behaviour.\n',
    });
    assert.equal(real.allowed, true, `${value} is a task reference`);
    assert.equal(real.deferredTo, value);
  }
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

// WITHDRAWN (#253 round 7) — the packet-ledger and plan-probe verification is gone. Rounds
// 3-6 built it four times and round 7 defeated the "complete" definition twice over: a ledger
// maps QUESTIONS to probes and the definition specified only the probe side, and
// `planDefinesProbe` could not tell `5. **Task 5 — frontend surfaces**` from a probe named 5.
// Both need MEANING, which is the reviewer's side of the PR #250 line. This test pins the
// withdrawal so it is not silently reintroduced: past the cap the gate demands a task-shaped
// TRAILER and nothing about the packet's prose.
test('the deferral is the trailer only; the ledger is the reviewer\'s to judge', () => {
  const reviews = Array.from({ length: PLAN_REVIEW_ROUND_CAP }, (_, i) => ({
    user: { login: CODEX },
    commit_id: String.fromCharCode(97 + i).repeat(40),
  }));
  const docsOnly = ['docs/superpowers/plans/plan.md', 'docs/reviews/pr-252-convergence.md'];
  const base = {
    comments: [], reviews, changedFiles: docsOnly, pullRequestFiles: docsOnly,
    // STATUS shows phase 5 with work ahead; the fail-closed cases override this
    activePhases: [5],
  };
  const withTrailer = (value) => [
    'fix: plan convergence',
    '',
    'Review-Convergence: complete',
    `Review-Deferred-To-Probes: ${value}`,
  ].join('\n');

  // a task-shaped trailer is the whole obligation the GATE enforces
  const allowed = assessConvergence({ ...base, headMessage: withTrailer('phase-5-task-1') });
  assert.equal(allowed.allowed, true);
  assert.equal(allowed.deferredTo, 'phase-5-task-1');
  assert.deepEqual(allowed.missing, []);

  // ...and no packet or plan content is consulted, so passing either changes nothing
  for (const extra of [
    { packetText: '' },
    { packetText: 'no ledger here at all' },
    { planText: '' },
    { packetText: '## Deferral ledger\n| q | probe 5w | phase-5-task-1 |\n', planText: '5w. x' },
  ]) {
    const same = assessConvergence({
      ...base, ...extra, headMessage: withTrailer('phase-5-task-1'),
    });
    assert.equal(same.allowed, true, `${JSON.stringify(extra)} must not change the verdict`);
  }

  // the trailer still has to name a task, and it still has to be PRESENT past the cap
  for (const value of ['yes', 'later', 'TBD', 'phase-5', 'task-1']) {
    const notATask = assessConvergence({ ...base, headMessage: withTrailer(value) });
    assert.equal(notATask.allowed, false, `"${value}" is not a task reference`);
    assert.match(notATask.missing.join(' '), /name the TASK/u);
  }
  const noTrailer = assessConvergence({
    ...base,
    headMessage: 'fix: plan convergence\n\nReview-Convergence: complete',
  });
  assert.equal(noTrailer.allowed, false);
  assert.match(noTrailer.missing.join(' '), /Review-Deferred-To-Probes/u);

  // FINDING (#253 round 8 P2) — a shape-valid value can name a review stop that does not
  // exist. The PHASE is checkable against docs/STATUS.md, a machine-readable state file, so
  // this is a structured-field read rather than the prose parsing round 7 withdrew.
  const phases = deferralPhases({
    phase: '4', task_state: 'in_progress', next_task: 'phase-5-planning',
  });
  assert.deepEqual(phases, [4, 5]);
  const unreal = assessConvergence({
    ...base, activePhases: phases, headMessage: withTrailer('phase-999-task-999'),
  });
  assert.equal(unreal.allowed, false, 'phase 999 is not a phase this repository is in');
  assert.match(unreal.missing.join(' '), /names phase 999/u);
  const real = assessConvergence({
    ...base, activePhases: phases, headMessage: withTrailer('phase-5-task-1'),
  });
  assert.equal(real.allowed, true, 'phase 5 is the phase under review');

  // FINDING (#253 round 10 P2) — an unreadable STATUS used to impose NO constraint, on the
  // reasoning that it is not evidence the task is fake. True, and beside the point: it is
  // equally not evidence the task is REAL, and round 9 had already settled that an
  // unreadable cumulative diff must block rather than pick a path. The same principle, two
  // fields apart in one commit, resolved two different ways. It now fails closed.
  const noStatus = assessConvergence({
    ...base, activePhases: deferralPhases(null), headMessage: withTrailer('phase-999-task-999'),
  });
  assert.equal(noStatus.allowed, false, 'an unprovable phase is not a proven one');
  assert.match(noStatus.missing.join(' '), /could not be read/u);
  // ...and it blocks a REAL task too, because the gate cannot tell the difference
  const realButUnprovable = assessConvergence({
    ...base, activePhases: undefined, headMessage: withTrailer('phase-5-task-1'),
  });
  assert.equal(realButUnprovable.allowed, false);

  // FINDING (#253 round 10 P2) — the gate runs from the trusted default branch, so it reads
  // main's STATUS. When the PR itself edits STATUS, that copy is not the PR's phase truth: a
  // head closing phase 5 while deferring into phase-5-task-1 would pass on the pre-merge
  // state. Reading the head's STATUS would also fix it, and would mean pulling PR-authored
  // content into a write-capable workflow — the boundary this loop does not cross. The file
  // LIST is metadata the gate already has, and it is enough.
  const statusInDiff = ['docs/superpowers/plans/plan.md', 'docs/STATUS.md',
    'docs/reviews/pr-252-convergence.md'];
  // FINDING (#253 round 11 P2) — git's trailer separator is ':' with OPTIONAL whitespace.
  // `git interpret-trailers --parse` normalizes `Key:value` to `Key: value`, so a head
  // spelled without the space carries a VALID trailer that all three of this file's parsers
  // reported as missing — the convergence trailer included. A gate that rejects a trailer git
  // accepts blocks a compliant head.
  const noSpace = assessConvergence({
    ...base,
    headMessage: [
      'fix: plan convergence',
      '',
      'Review-Convergence:complete',
      'Review-Deferred-To-Probes:phase-5-task-1',
    ].join('\n'),
  });
  assert.equal(noSpace.hasTrailer, true, 'git parses Key:value as a trailer');
  assert.equal(noSpace.deferredTo, 'phase-5-task-1');
  assert.equal(noSpace.allowed, true);
  // ...and extra whitespace is still fine
  assert.equal(assessConvergence({
    ...base,
    headMessage: 'fix: x\n\nReview-Convergence:\tcomplete\nReview-Deferred-To-Probes:  phase-5-task-1',
  }).allowed, true);

  // FINDING (#253 round 11 P2) — a RENAME away from docs/STATUS.md carries the new path in
  // `filename` and the old one in `previous_filename`, so the guard read only half the entry
  // and a PR that moved the phase truth out from under the gate passed. Round 2 of this PR
  // established the two-path rule and built changedPaths; the new check now uses it.
  const renamedAway = assessConvergence({
    ...base,
    changedFiles: [{ filename: 'docs/STATE.md', previous_filename: 'docs/STATUS.md',
      status: 'renamed' }, 'docs/reviews/pr-252-convergence.md'],
    pullRequestFiles: [{ filename: 'docs/STATE.md', previous_filename: 'docs/STATUS.md',
      status: 'renamed' }, 'docs/reviews/pr-252-convergence.md'],
    headMessage: withTrailer('phase-5-task-1'),
  });
  assert.equal(renamedAway.allowed, false, 'a rename still moves the phase truth');
  assert.match(renamedAway.missing.join(' '), /changes docs\/STATUS\.md/u);

  const editsStatus = assessConvergence({
    ...base,
    changedFiles: statusInDiff,
    pullRequestFiles: statusInDiff,
    headMessage: withTrailer('phase-5-task-1'),
  });
  assert.equal(editsStatus.allowed, false, "main's STATUS is not this PR's phase truth");
  assert.match(editsStatus.missing.join(' '), /changes docs\/STATUS\.md/u);
  // a PR that does NOT touch STATUS is unaffected
  assert.equal(assessConvergence({
    ...base, headMessage: withTrailer('phase-5-task-1'),
  }).allowed, true);

  // the task INDEX inside a valid phase is deliberately unchecked — it lives in the plan's
  // markdown table, and reading that is what round 7 withdrew
  const unknownIndex = assessConvergence({
    ...base, activePhases: phases, headMessage: withTrailer('phase-5-task-99'),
  });
  assert.equal(unknownIndex.allowed, true, 'the task index is the reviewer\'s to check');

  // FINDING (#253 round 9 P2) — the CURRENT phase was admitted unconditionally, so once its
  // last task merged the gate still accepted a deferral to it. A deferral names the review
  // stop that will SETTLE the question; a phase with no open work has no such stop left, and
  // the questions would be settled by nothing. The current phase counts only while it has
  // open work; the next_task phase always counts, because that is where work is going.
  const closed = deferralPhases({ phase: '4', task_state: 'merged', work_item: 'none' });
  assert.deepEqual(closed, [], 'a phase whose work is merged settles nothing further');
  const toClosedPhase = assessConvergence({
    ...base, activePhases: closed, headMessage: withTrailer('phase-4-task-99'),
  });
  assert.equal(toClosedPhase.allowed, false, 'phase 4 has no remaining review stop');
  assert.match(toClosedPhase.missing.join(' '), /no phase with open work/u);

  // The probe above exposed a defect in its own fix: an EMPTY phase set was read as "no
  // constraint", the same as an unreadable STATUS, so a closed phase authorized every
  // deferral. The two answers are different and must stay different — undefined is
  // "STATUS told us nothing" (no constraint), [] is "nothing is open" (refuse).
  assert.equal(deferralPhases(null), undefined, 'no STATUS is not an empty phase set');
  assert.equal(deferralPhases({}), undefined);
  assert.equal(deferralPhases({ phase: 'unreleased' }), undefined, 'an unparseable phase');

  // ...but the phase named as NEXT still counts even when the current one is closed, which
  // is exactly the state a phase-boundary planning PR sits in
  assert.deepEqual(
    deferralPhases({
      phase: '4', task_state: 'merged', work_item: 'none', next_task: 'phase-5-planning',
    }),
    [5],
  );
  // FINDING (#301) — the BETWEEN-WORK shape is where an unparseable `next_task` becomes fatal,
  // and it is the shape every merge flip passes through. With `merged` + `work_item: none`,
  // `phaseHasOpenWork` is false, so `next_task` is the ONLY source of an eligible phase: a
  // split-unit id the vocabulary uses but the regex rejected collapsed this to `[]`, which the
  // contract above reads as "nothing is open" — refusing a deferral that names a REAL upcoming
  // stop. RED before the third-level suffix: returns [] for both ids below.
  //
  // These are not invented shapes. `phase-5-task-7b-ii-b` names a merged, cleared unit and sat
  // in STATUS as `work_item`, where `in_progress` masked the mismatch.
  for (const nextTask of ['phase-5-task-7b-iii-a', 'phase-5-task-7b-ii-b']) {
    assert.deepEqual(
      deferralPhases({ phase: '5', task_state: 'merged', work_item: 'none', next_task: nextTask }),
      [5],
      `${nextTask} must keep its phase eligible between work items`,
    );
  }

  // an open work item keeps the current phase eligible whatever the state word is
  assert.deepEqual(
    deferralPhases({ phase: '4', task_state: 'complete', work_item: 'P4T7 follow-up' }),
    [4],
  );
  assert.deepEqual(deferralPhases({ phase: '4', task_state: 'in_review' }), [4]);

  // FINDING (#253 round 11 P2) — the open test was a BLOCKLIST of closed words, so any state
  // it had not heard of counted as open and authorized a deferral STATUS never justified.
  // Round 6 of this PR replaced exactly such a blocklist with an allowlist; this is the same
  // lesson at a second site. An UNRECOGNIZED or ABSENT state is unverified, not open — and
  // the allowlist is docs/STATUS.md's own, imported rather than copied.
  for (const state of ['somewhere-new', '', 'OPEN', 'done']) {
    assert.deepEqual(
      deferralPhases({ phase: '5', task_state: state }), [],
      `"${state}" is not a state STATUS defines as open`,
    );
  }
  assert.deepEqual(deferralPhases({ phase: '5' }), [], 'an absent task_state proves nothing');
  // ...while every state STATUS DOES define as open counts
  for (const state of [...OPEN_TASK_STATES]) {
    assert.deepEqual(deferralPhases({ phase: '5', task_state: state }), [5], state);
  }

  // below the cap no deferral is owed at all
  const withinCap = assessConvergence({
    ...base,
    reviews: reviews.slice(0, PLAN_REVIEW_ROUND_CAP - 1),
    headMessage: 'fix: correction\n\nReview-Convergence: complete',
  });
  assert.equal(withinCap.allowed, true);
  assert.equal(withinCap.deferralRequired, false);
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

  // An unknown cumulative diff used to fall to the CODE path. That silently dropped
  // the deferral obligation from a docs-only PR whose file list happened not to read,
  // so past the cap it now BLOCKS on its own unreadability instead of guessing: it
  // demands no trailer (deferralRequired stays false — the gate cannot justify one)
  // but it does not certify the head either, and the next event re-runs the read.
  const unknown = assessConvergence({
    comments: [], reviews, headMessage, changedFiles: packetOnlyHead,
  });
  assert.equal(unknown.deferralRequired, false, 'an unread diff cannot demand a deferral');
  assert.equal(unknown.cumulativeUnreadable, true);
  assert.equal(unknown.allowed, false, 'nor may it certify the head by guessing "code"');
  assert.match(unknown.missing.join(' '), /cumulative diff could not be read/u);

  // Below the cap the same unread list is irrelevant: no deferral is owed at all,
  // so the ordinary convergence protocol proceeds untouched.
  const belowCap = assessConvergence({
    comments: [],
    reviews: reviews.slice(0, PLAN_REVIEW_ROUND_CAP - 1),
    headMessage,
    changedFiles: packetOnlyHead,
  });
  assert.equal(belowCap.cumulativeUnreadable, false);
  assert.equal(belowCap.allowed, true);
});

// `next_task` is consumed by an ALLOWLIST (`TASK_REFERENCE`), and an unparseable value is
// invisible until the exact moment it matters. While the phase has open work `deferralPhases`
// returns the current phase whatever `next_task` says; the moment a flip records `merged` with
// `work_item: none`, `next_task` becomes the ONLY source, an unparseable value yields `[]`, and a
// docs-only head past the round cap can no longer defer its open questions to a real stop.
//
// So this reads the REAL `docs/STATUS.md` and forces the terminal state rather than trusting the
// state of the day. A fixture would only prove the parser parses what I already believe it does;
// the thing worth guarding is the artifact.
test('the recorded next_task names a stop the deferral gate can resolve, or is deliberately none', async () => {
  const markdown = await readFile(new URL('../docs/STATUS.md', import.meta.url), 'utf8');
  const now = parseStatusNow(markdown);
  assert.ok(now, 'docs/STATUS.md must carry a parseable Now block');

  // Forced terminal handoff shape: the one state in which `next_task` is load-bearing alone.
  const handed = { ...now, task_state: 'merged', work_item: 'none' };
  const recorded = String(now.next_task ?? '').trim().toLowerCase();
  if (recorded === '' || recorded === 'none') {
    // A DELIBERATE `none` is the owner-gated interregnum (phase-6-task-2's flip: the rename
    // needs the owner's explicit go, forwarding is sequenced behind it, 6.1b is held), and it
    // is the opposite of the failure this pin exists for — the #328 typo was INVISIBLE until
    // the deferral gate silently resolved no phase. `none` is visible, the runner falls to
    // the Maintenance queue, and a docs-only head past the round cap failing closed on
    // "no phase with open work" is then CORRECT: there is no open stop to defer probes to.
    assert.deepEqual(deferralPhases(handed), [], 'a none next_task must resolve no phase, openly');
  } else {
    const phases = deferralPhases(handed);
    assert.ok(
      Array.isArray(phases) && phases.length > 0,
      `next_task "${now.next_task}" does not parse as phase-<n>-task-<id> or phase-<n>-planning, so `
        + 'after a merged handoff the deferral gate resolves no phase and a docs-only head past the '
        + 'round cap fails closed on "no phase with open work"',
    );
  }

  // …and the guard is only worth having if it can fail: the shape #328 was caught with.
  const unparseable = deferralPhases({ ...handed, next_task: 'phase-6-unit-6.1b' });
  assert.deepEqual(unparseable, [], 'a unit-style next_task must still be rejected by the gate');
});
