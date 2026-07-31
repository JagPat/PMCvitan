// Lifecycle tests: reviewing → convergence_audit → restructure_required →
// replacement_reviewing.
//
// Every probe here fails without `scripts/review-lifecycle.mjs`: the module is new,
// so the reproduction of each case is that the repository could not answer the
// question at all before it. That is stated plainly rather than dressed up as a
// behavioural RED — see docs/reviews/pr-lifecycle-convergence.md.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  RESTRUCTURE_AFTER_CODE_FINDING_HEADS,
  RESTRUCTURE_AFTER_DOCS_FINDING_HEADS,
  assessRestructure,
  mergeFindingHeadCount,
  mergeFindingHeads,
  nextMetrics,
  readMetrics,
  renderMetrics,
  replacementSource,
} from './review-lifecycle.mjs';
import {
  isRetryableTerminalReviewFailure,
  isTerminalReviewStatus,
} from './autonomous-review-gate.mjs';

const CODEX = { login: 'chatgpt-codex-connector[bot]' };

function findingsOn(...heads) {
  return heads.map((head, index) => ({
    user: CODEX,
    commit_id: head,
    original_commit_id: head,
    id: index + 1,
  }));
}

const DOCS = [{ filename: 'docs/superpowers/plans/phase-6.md', additions: 40, deletions: 0 }];
const CODE = [{ filename: 'scripts/autonomous-review-gate.mjs', additions: 40, deletions: 2 }];

// ---------------------------------------------------------------------------
// Threshold: docs-only units restructure at three finding-bearing heads.
// ---------------------------------------------------------------------------

test('L1: a docs-only unit keeps reviewing below the docs threshold', () => {
  const result = assessRestructure({
    comments: findingsOn('a1', 'b2'),
    reviews: [],
    pullRequestFiles: DOCS,
    body: '',
  });
  assert.equal(result.kind, 'docs');
  assert.equal(result.threshold, RESTRUCTURE_AFTER_DOCS_FINDING_HEADS);
  assert.equal(result.findingHeadCount, 2);
  assert.equal(result.state, 'reviewing');
  assert.equal(result.allowed, true);
});

test('L2: a docs-only unit requires restructuring at the third finding head', () => {
  const result = assessRestructure({
    comments: findingsOn('a1', 'b2', 'c3'),
    reviews: [],
    pullRequestFiles: DOCS,
    body: '',
  });
  assert.equal(result.state, 'restructure_required');
  assert.equal(result.required, true);
  assert.equal(result.allowed, false);
  assert.match(result.reason, /must be restructured and replaced/u);
});

// ---------------------------------------------------------------------------
// Threshold: ordinary code units get five.
// ---------------------------------------------------------------------------

test('L3: a code unit still reviews at four finding heads', () => {
  const result = assessRestructure({
    comments: findingsOn('a1', 'b2', 'c3', 'd4'),
    reviews: [],
    pullRequestFiles: CODE,
    body: '',
  });
  assert.equal(result.kind, 'code');
  assert.equal(result.threshold, RESTRUCTURE_AFTER_CODE_FINDING_HEADS);
  assert.equal(result.state, 'reviewing');
  assert.equal(result.allowed, true);
});

test('L4: a code unit requires restructuring at the fifth finding head', () => {
  const result = assessRestructure({
    comments: findingsOn('a1', 'b2', 'c3', 'd4', 'e5'),
    reviews: [],
    pullRequestFiles: CODE,
    body: '',
  });
  assert.equal(result.state, 'restructure_required');
  assert.equal(result.required, true);
  assert.equal(result.allowed, false);
});

test('L4b: PR #257\'s real shape — five code heads — is restructure_required', () => {
  // The case this lifecycle was written for, using the actual head SHAs.
  const result = assessRestructure({
    comments: findingsOn('c7913a9', '596fa99', 'e9feaf7', 'bd58504', 'd5e8f61'),
    reviews: [],
    pullRequestFiles: CODE,
    body: '',
  });
  assert.equal(result.findingHeadCount, 5);
  assert.equal(result.state, 'restructure_required');
});

// ---------------------------------------------------------------------------
// An unreadable diff never silently picks a threshold.
// ---------------------------------------------------------------------------

test('L5: unreadable diff below both limits keeps reviewing', () => {
  const result = assessRestructure({
    comments: findingsOn('a1', 'b2'),
    reviews: [],
    pullRequestFiles: undefined,
    body: '',
  });
  assert.equal(result.kind, 'unknown');
  assert.equal(result.state, 'reviewing');
  assert.equal(result.allowed, true);
  assert.equal(result.undecided, false);
});

test('L5b: unreadable diff between the limits is undecided and blocks, not clears', () => {
  const result = assessRestructure({
    comments: findingsOn('a1', 'b2', 'c3'),
    reviews: [],
    pullRequestFiles: undefined,
    body: '',
  });
  assert.equal(result.undecided, true);
  assert.equal(result.allowed, false, 'an undecided unit must not be clearable');
  assert.equal(result.required, false, 'nor may it be declared restructure-required on a guess');
  assert.match(result.reason, /not evidence either way/u);
});

test('L5c: unreadable diff past BOTH limits is restructure_required regardless', () => {
  const result = assessRestructure({
    comments: findingsOn('a1', 'b2', 'c3', 'd4', 'e5'),
    reviews: [],
    pullRequestFiles: undefined,
    body: '',
  });
  assert.equal(result.state, 'restructure_required');
  assert.equal(result.allowed, false);
  assert.equal(result.undecided, false);
});

// ---------------------------------------------------------------------------
// State persistence across reruns, and history reset as an evasion.
// ---------------------------------------------------------------------------

test('L6: the recorded count is a floor — a rerun seeing fewer heads cannot walk it back', () => {
  const recordedMetrics = { findingHeads: 5 };
  const result = assessRestructure({
    // A paginated or partial read showing only one head.
    comments: findingsOn('a1'),
    reviews: [],
    pullRequestFiles: CODE,
    body: '',
    recordedMetrics,
  });
  assert.equal(result.findingHeadCount, 5, 'the floor survives a smaller live reading');
  assert.equal(result.state, 'restructure_required');
});

test('L6b: rewriting the branch does not evade the threshold', () => {
  // A force-push mints new head SHAs, but the findings already recorded against the
  // PR remain, and the floor holds independently of what the live read returns.
  const afterReset = assessRestructure({
    comments: findingsOn('fresh1'),
    reviews: [],
    pullRequestFiles: CODE,
    body: '',
    recordedMetrics: { findingHeads: RESTRUCTURE_AFTER_CODE_FINDING_HEADS },
  });
  assert.equal(afterReset.state, 'restructure_required');
  assert.equal(afterReset.allowed, false);
});

test('L6c: mergeFindingHeadCount takes the max and tolerates a missing record', () => {
  assert.equal(mergeFindingHeadCount(undefined, 3), 3);
  assert.equal(mergeFindingHeadCount({ findingHeads: 4 }, 2), 4);
  assert.equal(mergeFindingHeadCount({ findingHeads: 1 }, 6), 6);
  assert.equal(mergeFindingHeadCount({ findingHeads: 'nonsense' }, 2), 2);
});

// ---------------------------------------------------------------------------
// Superseding heads: a new head does not reset the unit's history.
// ---------------------------------------------------------------------------

test('L7: a new clean head does not clear a unit that already crossed the limit', () => {
  // The current head carries no findings — every finding belongs to earlier heads.
  const result = assessRestructure({
    comments: findingsOn('a1', 'b2', 'c3', 'd4', 'e5'),
    reviews: [],
    pullRequestFiles: CODE,
    body: '',
    recordedMetrics: { findingHeads: 5 },
  });
  assert.equal(result.state, 'restructure_required');
  assert.equal(
    result.allowed,
    false,
    'pushing another head is exactly the move the limit exists to stop',
  );
});

// ---------------------------------------------------------------------------
// Replacements: declared lineage, fresh review history.
// ---------------------------------------------------------------------------

test('L8: a declared replacement reviews fresh and records its source', () => {
  const result = assessRestructure({
    comments: [],
    reviews: [],
    pullRequestFiles: CODE,
    body: 'Restructures the loop-efficiency unit.\n\nReplaces: #257\n',
  });
  assert.equal(result.replaces, 257);
  assert.equal(result.state, 'replacement_reviewing');
  assert.equal(result.findingHeadCount, 0);
  assert.equal(result.allowed, true);
});

test('L8b: a replacement is still bound by the limit on its OWN findings', () => {
  const result = assessRestructure({
    comments: findingsOn('r1', 'r2', 'r3', 'r4', 'r5'),
    reviews: [],
    pullRequestFiles: CODE,
    body: 'Replaces: #257',
  });
  assert.equal(
    result.state,
    'restructure_required',
    'declaring a replacement buys a fresh count, not immunity',
  );
});

test('L8c: replacementSource reads only a well-formed declaration', () => {
  assert.equal(replacementSource('Replaces: #257'), 257);
  assert.equal(replacementSource('replaces:   #12\n'), 12);
  assert.equal(replacementSource('This replaces #257 eventually'), null);
  assert.equal(replacementSource('Replaces: #0'), null);
  assert.equal(replacementSource(undefined), null);
});

// ---------------------------------------------------------------------------
// A finding-bearing restructured unit cannot merge.
// ---------------------------------------------------------------------------

test('L9: restructure_required never reports allowed, at any count past the limit', () => {
  for (const count of [5, 6, 9]) {
    const heads = Array.from({ length: count }, (_, index) => `h${index}`);
    const result = assessRestructure({
      comments: findingsOn(...heads),
      reviews: [],
      pullRequestFiles: CODE,
      body: '',
    });
    assert.equal(result.state, 'restructure_required', `count ${count}`);
    assert.equal(result.allowed, false, `count ${count} must never be allowed`);
  }
});

// ---------------------------------------------------------------------------
// Metrics: sticky, round-trippable, and elapsed time is telemetry only.
// ---------------------------------------------------------------------------

test('L10: metrics round-trip through the sticky comment', () => {
  const metrics = {
    findingHeads: 5,
    findingsPerHead: { d5e8f61: 2 },
    kind: 'code',
    threshold: 5,
    state: 'restructure_required',
    firstSeenAt: '2026-07-30T08:00:00Z',
    elapsedMinutes: 1_200,
    replaces: 257,
  };
  const body = `## Autonomous review state\n\n${renderMetrics(metrics)}\n`;
  assert.deepEqual(readMetrics(body), metrics);
});

test('L10b: a malformed or absent metrics block reads as null, never as a lower count', () => {
  assert.equal(readMetrics('no marker here'), null);
  assert.equal(readMetrics('<!-- autonomous-review-metrics: {not json} -->'), null);
  assert.equal(readMetrics(undefined), null);
  // And a null record cannot lower a live reading.
  assert.equal(mergeFindingHeadCount(null, 4), 4);
});

test('L11: elapsed time is recorded as telemetry and gates nothing', () => {
  const assessment = assessRestructure({
    comments: findingsOn('a1', 'b2'),
    reviews: [],
    pullRequestFiles: CODE,
    body: '',
  });
  const long = nextMetrics({
    recordedMetrics: { firstSeenAt: '2026-07-01T00:00:00Z' },
    assessment: { ...assessment, head: 'b2' },
    findingsThisHead: 1,
    nowIso: '2026-07-31T00:00:00Z',
  });
  assert.equal(long.elapsedMinutes, 43_200, 'thirty days is recorded');
  assert.equal(
    assessment.allowed,
    true,
    'and a month in review still does not block: only the head count gates',
  );
  assert.equal(long.findingsPerHead.b2, 1);
  assert.equal(long.firstSeenAt, '2026-07-01T00:00:00Z', 'the start is never rewritten');
});

test('L11b: elapsed time is null rather than negative when the clock disagrees', () => {
  const metrics = nextMetrics({
    recordedMetrics: { firstSeenAt: '2026-07-31T00:00:00Z' },
    assessment: assessRestructure({
      comments: [],
      reviews: [],
      pullRequestFiles: CODE,
      body: '',
    }),
    nowIso: '2026-07-01T00:00:00Z',
  });
  assert.equal(metrics.elapsedMinutes, null);
});

// ---------------------------------------------------------------------------
// Round 2 — the gate wiring. Four findings on `a65398d`, all one concept: the
// restructure assessment must be FIRST, re-evaluated wherever the count can
// change, durably recorded, and retryable when undecided.
// ---------------------------------------------------------------------------

test('M1: the undecided restructure failure is retryable, not persistent', () => {
  // Its own instruction says "re-run once the file list is readable". Latching it
  // as a persistent terminal failure makes that instruction unreachable on the
  // same head — a permanent block on a transient condition.
  const undecided = {
    state: 'failure',
    description: 'review: restructure check undecided',
  };
  assert.equal(isTerminalReviewStatus(undecided), true, 'still terminal for this run');
  assert.equal(
    isRetryableTerminalReviewFailure(undecided),
    true,
    'but a later run must re-read the diff instead of restoring the failure',
  );
});

test('M1b: a real restructure block stays persistent', () => {
  // The complement, so the fix is precise rather than blanket: a unit that has
  // genuinely crossed its limit must NOT be retried into a pass.
  const blocked = {
    state: 'failure',
    description: 'review: restructure required',
  };
  assert.equal(isTerminalReviewStatus(blocked), true);
  assert.equal(
    isRetryableTerminalReviewFailure(blocked),
    false,
    'crossing the limit is a decision, not a transient failure',
  );
});

test('M2: both sticky-comment paths paginate', async () => {
  // The floor is read from this comment. Reading only page one loses it on a
  // long-running PR — and the WRITE path has the same defect, which would post a
  // duplicate sticky and split the record the floor is read from.
  const source = await readFile(
    new URL('./autonomous-review-gate.mjs', import.meta.url),
    'utf8',
  );
  const stickyRead = source.slice(source.indexOf('async stickyComment('));
  const stickyWrite = source.slice(source.indexOf('async updateStickyComment('));
  for (const [name, body] of [['read', stickyRead], ['write', stickyWrite]]) {
    const head = body.slice(0, body.indexOf('}\n\n'));
    assert.match(head, /this\.paginated\(/u, `sticky ${name} must paginate`);
    assert.doesNotMatch(
      head,
      /per_page=100`/u,
      `sticky ${name} must not stop at the first page`,
    );
  }
});

test('M3: the restructure gate is the FIRST gate in every flow', async () => {
  // Not "before convergence" — before EVERY gate. Thirteen places write a blocking
  // state and invite another correction head; the question "is another head even
  // permitted?" is answered once, first, so no earlier exit can invite one.
  const source = await readFile(
    new URL('./autonomous-review-gate.mjs', import.meta.url),
    'utf8',
  );
  const flows = ['async function revalidateFinalPolicy', 'async function run('];
  for (const marker of flows) {
    const at = source.indexOf(marker);
    if (at === -1) continue;
    const body = source.slice(at, source.indexOf('\n}\n', at));
    const restructure = body.indexOf('enforceRestructure(');
    const scope = body.indexOf('enforceReviewScope(');
    const convergence = body.indexOf('enforceReviewConvergence(');
    assert.notEqual(restructure, -1, `${marker} must consult the lifecycle`);
    for (const [name, at2] of [['scope', scope], ['convergence', convergence]]) {
      if (at2 === -1) continue;
      assert.ok(
        restructure < at2,
        `${marker}: restructure must precede ${name}`,
      );
    }
  }
});

test('M4: a finding on this head re-assesses the lifecycle before inviting a fix', async () => {
  // The pre-review check ran when the count was one lower. A finding landing NOW
  // is the transition the limit exists to catch, so the changes_required branch
  // must re-assess before telling anyone to push a correction.
  const source = await readFile(
    new URL('./autonomous-review-gate.mjs', import.meta.url),
    'utf8',
  );
  const branch = source.slice(
    source.indexOf("if (result.state === 'changes_required') {"),
  );
  const body = branch.slice(0, branch.indexOf('throw new Error(result.detail);'));
  const reassess = body.indexOf('enforceRestructure(');
  const invite = body.indexOf('Claude Auto-fix handles the review comments');
  assert.notEqual(reassess, -1, 'the branch must re-assess the lifecycle');
  assert.ok(
    reassess < invite,
    're-assessment must precede the instruction to push another correction',
  );
});

// ---------------------------------------------------------------------------
// Round 3 — the floor keeps identities, the threshold is monotonic, and an
// unreadable floor blocks. Codex on `34e2152`.
// ---------------------------------------------------------------------------

test('N1: the floor unions head IDENTITIES, so a partial read cannot walk it back', () => {
  // The exact shape a count-only max misses: the live read ADDS the new fifth head
  // and OMITS an older one, so both sides count four and the unit sits below five
  // while having actually crossed it.
  const merged = mergeFindingHeads(
    { findingHeadIds: ['h1', 'h2', 'h3', 'h4'] },
    ['h2', 'h3', 'h4', 'h5'],
  );
  assert.equal(merged.count, 5, 'the union is five, not the max of two fours');
  assert.deepEqual([...merged.ids].sort(), ['h1', 'h2', 'h3', 'h4', 'h5']);
});

test('N1b: a legacy count-only record still applies as a numeric floor', () => {
  // Records written before identities were stored must not be forgiven by the
  // upgrade: they cannot be unioned, so the count still binds.
  assert.equal(mergeFindingHeads({ findingHeads: 5 }, ['h1']).count, 5);
});

test('N1c: the identity floor drives the verdict', () => {
  const result = assessRestructure({
    comments: findingsOn('h2', 'h3', 'h4', 'h5'),
    reviews: [],
    pullRequestFiles: CODE,
    body: '',
    recordedMetrics: { findingHeadIds: ['h1', 'h2', 'h3', 'h4'] },
  });
  assert.equal(result.findingHeadCount, 5);
  assert.equal(result.state, 'restructure_required');
});

test('N2: a crossed docs-only unit cannot raise its threshold by adding code', () => {
  // Push a correction that adds any runnable file and the live kind becomes
  // `code`, the threshold rises 3 → 5, and the unit returns to `reviewing`.
  // The strictest kind the unit has ever presented governs.
  const result = assessRestructure({
    comments: findingsOn('d1', 'd2', 'd3'),
    reviews: [],
    pullRequestFiles: CODE,
    body: '',
    recordedMetrics: { findingHeads: 3, findingHeadIds: ['d1', 'd2', 'd3'], kind: 'docs' },
  });
  assert.equal(result.kind, 'docs', 'the recorded docs kind is sticky');
  assert.equal(result.threshold, RESTRUCTURE_AFTER_DOCS_FINDING_HEADS);
  assert.equal(result.state, 'restructure_required');
});

test('N2b: a code unit is not retroactively made docs-only', () => {
  // The complement: monotonicity tightens, it never loosens, and it never
  // invents strictness a unit never had.
  const result = assessRestructure({
    comments: findingsOn('c1', 'c2', 'c3'),
    reviews: [],
    pullRequestFiles: CODE,
    body: '',
    recordedMetrics: { findingHeads: 3, findingHeadIds: ['c1', 'c2', 'c3'], kind: 'code' },
  });
  assert.equal(result.kind, 'code');
  assert.equal(result.state, 'reviewing', 'three heads is still under the code limit');
});

test('N3: an unreadable floor blocks rather than continuing on the live count', () => {
  // The durable record is the only thing carrying a crossed limit forward — the
  // failing status belongs to the previous SHA. "Could not read" must not mean
  // "no record", or a partial live read continues a unit that already crossed.
  const result = assessRestructure({
    comments: findingsOn('h1'),
    reviews: [],
    pullRequestFiles: CODE,
    body: '',
    recordedMetrics: null,
    floorUnreadable: true,
  });
  assert.equal(result.allowed, false, 'an unverifiable floor cannot clear a head');
  assert.equal(result.undecided, true, 'and it is undecided, not a restructure verdict');
  assert.match(result.reason, /not evidence either way/u);
});

test('N3b: the unreadable-floor block is the retryable status, so it self-heals', () => {
  // It reports as `undecided`, which the gate publishes with the retryable
  // description — otherwise fail-closed would become fail-forever.
  assert.equal(
    isRetryableTerminalReviewFailure({
      state: 'failure',
      description: 'review: restructure check undecided',
    }),
    true,
  );
});
