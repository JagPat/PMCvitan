// Lifecycle tests: reviewing → convergence_audit → restructure_required →
// replacement_reviewing.
//
// Every probe here fails without `scripts/review-lifecycle.mjs`: the module is new,
// so the reproduction of each case is that the repository could not answer the
// question at all before it. That is stated plainly rather than dressed up as a
// behavioural RED — see docs/reviews/pr-lifecycle-convergence.md.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  RESTRUCTURE_AFTER_FINDING_HEADS,
  assessRestructure,
  mergeFindingHeadCount,
  mergeFindingHeads,
  nextMetrics,
  readMetrics,
  renderMetrics,
  replacementSource,
} from './review-lifecycle.mjs';

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

test('L3: a code unit still reviews at four finding heads', () => {
  const result = assessRestructure({
    comments: findingsOn('a1', 'b2', 'c3', 'd4'),
    reviews: [],
    pullRequestFiles: CODE,
    body: '',
  });
  assert.equal(result.threshold, RESTRUCTURE_AFTER_FINDING_HEADS);
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

test('L5: unreadable diff below both limits keeps reviewing', () => {
  const result = assessRestructure({
    comments: findingsOn('a1', 'b2'),
    reviews: [],
    pullRequestFiles: undefined,
    body: '',
  });
  assert.equal(result.state, 'reviewing');
  assert.equal(result.allowed, true);
  assert.equal(result.undecided, false);
});

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
    recordedMetrics: { findingHeads: RESTRUCTURE_AFTER_FINDING_HEADS },
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


test('S1: an unreadable file list no longer leaves the threshold undecided', () => {
  // F2 dissolved rather than patched. With no docs/code classification there is
  // nothing for an unreadable diff to make ambiguous — the one cap applies either
  // way, so the verdict is decided from the finding count alone.
  const under = assessRestructure({
    comments: findingsOn('a', 'b', 'c', 'd'),
    reviews: [], pullRequestFiles: undefined, body: '',
  });
  assert.equal(under.state, 'reviewing');
  assert.equal(under.allowed, true);
  assert.equal(under.undecided, false, 'no threshold ambiguity remains');

  const over = assessRestructure({
    comments: findingsOn('a', 'b', 'c', 'd', 'e'),
    reviews: [], pullRequestFiles: undefined, body: '',
  });
  assert.equal(over.state, 'restructure_required');
  assert.equal(over.allowed, false);
});

test('S2: a docs-only unit is NOT capped here — probe deferral owns that case', () => {
  // F3. review-efficiency.mjs already governs a docs-only unit at its cap via
  // `Review-Deferred-To-Probes:`. A second, shorter cap here would have blocked
  // that valid handoff, so this module does not classify diffs at all.
  const docs = assessRestructure({
    comments: findingsOn('d1', 'd2', 'd3'),
    reviews: [], pullRequestFiles: DOCS, body: '',
  });
  assert.equal(docs.state, 'reviewing', 'three docs heads is not this gate\'s business');
  assert.equal(docs.allowed, true);
  assert.equal(docs.threshold, RESTRUCTURE_AFTER_FINDING_HEADS);
});
