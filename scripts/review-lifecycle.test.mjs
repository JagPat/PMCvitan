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
  mergeRecordedMetrics,
  nextMetrics,
  preserveMetrics,
  readMetrics,
  renderMetrics,
  replacementSource,
} from './review-lifecycle.mjs';
import {
  RETRYABLE_REVIEW_FAILURES,
  enforceRestructure,
  isRetryableTerminalReviewFailure,
  isTerminalReviewStatus,
} from './autonomous-review-gate.mjs';
import * as reviewGate from './autonomous-review-gate.mjs';

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

// ---------------------------------------------------------------------------
// Round 4. Two P2 findings on head `da70792`, both about the floor being SOUND
// but never DURABLE, and both audited to their full site set before fixing.
// ---------------------------------------------------------------------------

test('O1: the runbook recovery command emits every status the code retries', async () => {
  // The runbook's jq is a hand-maintained DUPLICATE of
  // `isRetryableTerminalReviewFailure`. Round 2 added a fifth retryable
  // description and the jq kept four, so an operator following the runbook on an
  // undecided lifecycle block gets an empty TERMINAL_STATUS_ID and cannot
  // dispatch a same-head recovery — a transient block becomes a hand-edit.
  //
  // Pinning the LIST rather than the one missing string is the point: a sixth
  // retryable status added later fails here instead of stranding the next
  // operator.
  const runbook = await readFile('docs/AUTONOMOUS_LOOP.md', 'utf8');
  const missing = RETRYABLE_REVIEW_FAILURES
    .map((entry) => entry.match)
    .filter((description) => !runbook.includes(description));
  assert.deepEqual(
    missing,
    [],
    'every retryable description must appear in the runbook recovery command',
  );
});

test('O1b: the retryable predicate is driven by that same list', () => {
  // The list is only a real pin if it is what the predicate reads; a parallel
  // literal chain would drift from it exactly as the runbook did.
  for (const entry of RETRYABLE_REVIEW_FAILURES) {
    assert.equal(
      isRetryableTerminalReviewFailure({
        state: 'failure',
        description: entry.match,
      }),
      true,
      `${entry.match} must be retryable`,
    );
  }
  assert.equal(
    isRetryableTerminalReviewFailure({
      state: 'failure',
      description: 'review: 2 current-head Codex findings',
    }),
    false,
    'an ordinary finding failure is still persistent',
  );
});

test('O2: a sticky write that carries no metrics preserves the recorded floor', () => {
  // THE DURABILITY DEFECT. Sixteen call sites write the sticky comment and
  // exactly one passed a metrics block, so the floor recorded by the lifecycle
  // precondition was erased by the very next `changes_required` update. The
  // floor was sound (round 3) and never survived to be read.
  const recorded = renderMetrics({
    findingHeads: 4,
    findingHeadIds: ['h1', 'h2', 'h3', 'h4'],
    kind: 'code',
  });
  const previous = `## Autonomous review state\n\n${recorded}\n\n- **Head:** \`old\`\n`;
  const next = '## Autonomous review state\n\n- **Head:** `new`\n- **State:** `changes_required`\n';

  const merged = preserveMetrics(next, previous, null);
  assert.equal(
    readMetrics(merged)?.findingHeads,
    4,
    'the recorded floor survives a metrics-free sticky write',
  );
  assert.deepEqual(readMetrics(merged)?.findingHeadIds, ['h1', 'h2', 'h3', 'h4']);
  assert.match(merged, /- \*\*Head:\*\* `new`/u, 'and the new state is still written');
});

test('O2b: fresher run metrics win over the previous block', () => {
  // Preservation must never freeze the floor: a run that has just assessed the
  // unit supplies the newer count, and that is what gets written.
  const previous = `## Autonomous review state\n\n${renderMetrics({
    findingHeads: 2,
    findingHeadIds: ['h1', 'h2'],
    kind: 'code',
  })}\n\n- **Head:** \`old\`\n`;
  const next = '## Autonomous review state\n\n- **Head:** `new`\n';

  const merged = preserveMetrics(next, previous, {
    findingHeads: 3,
    findingHeadIds: ['h1', 'h2', 'h3'],
    kind: 'code',
  });
  assert.equal(readMetrics(merged)?.findingHeads, 3, 'the run"s own assessment wins');
});

test('O2c: a body that already carries metrics is left exactly as written', () => {
  // The blocking path composes its own metrics through `statusBody`; preservation
  // must not second-guess a caller that supplied them.
  const body = `## Autonomous review state\n\n${renderMetrics({
    findingHeads: 5,
    findingHeadIds: ['a', 'b', 'c', 'd', 'e'],
    kind: 'code',
  })}\n\n- **Head:** \`x\`\n`;
  assert.equal(preserveMetrics(body, 'irrelevant', { findingHeads: 1 }), body);
});

test('O3: the floor VALUE an allowed assessment would record is the real count', () => {
  // HONESTY NOTE: this probe passes at `da70792`. It pins the model, which round
  // 3 already made correct — the value is right and the union works. It does NOT
  // reproduce the round-4 defect, which is that nothing CALLS `nextMetrics` on
  // the allowed path. That reproduction has to be at the wiring level and is
  // `O3b`, which is RED. This one is kept because it establishes what `O3b` is
  // entitled to expect, not because it demonstrates the bug.
  const assessment = assessRestructure({
    comments: findingsOn('h1', 'h2', 'h3', 'h4'),
    reviews: [],
    pullRequestFiles: CODE,
    body: '',
    recordedMetrics: null,
  });
  assert.equal(assessment.allowed, true, 'four code heads is still under the limit');

  const metrics = nextMetrics({
    recordedMetrics: null,
    assessment,
    nowIso: '2026-07-31T06:00:00.000Z',
  });
  assert.equal(metrics.findingHeads, 4, 'and the floor it would record is the real count');
  assert.deepEqual(metrics.findingHeadIds, ['h1', 'h2', 'h3', 'h4']);

  // The fifth head lands while a partial live read omits an older one. Without
  // the recorded floor this reads as 4 and the unit stays under the limit.
  const partial = assessRestructure({
    comments: findingsOn('h2', 'h3', 'h4', 'h5'),
    reviews: [],
    pullRequestFiles: CODE,
    body: '',
    recordedMetrics: metrics,
  });
  assert.equal(partial.findingHeadCount, 5, 'the union with the recorded floor sees five');
  assert.equal(partial.state, 'restructure_required');
});

test('O3b: the lifecycle precondition RECORDS the floor when it lets a head through', async () => {
  // THE WIRING RED. `enforceRestructure` returned at `if (result.allowed) return`
  // before any metrics were written, so the floor existed only once the unit had
  // already crossed its limit — exactly when it can no longer do its job.
  //
  // Four code finding heads: under the limit, so the head is allowed to proceed.
  // The run must still leave the count behind, because the fifth head plus a
  // partial live read is the scenario the floor exists for.
  const recorded = [];
  const client = {
    async reviewComments() { return findingsOn('h1', 'h2', 'h3', 'h4'); },
    async reviews() { return []; },
    async pullRequestFiles() { return CODE; },
    async stickyComment() { return null; },
    async updateStickyComment(number, body) { recorded.push(body); },
    async setStatus() {},
    async setDraft() {},
    setLifecycleMetrics(metrics) { this.lifecycleMetrics = metrics; },
  };

  const result = await enforceRestructure(
    client,
    { number: 258, body: '', html_url: 'https://example.invalid/pr/258' },
    'head-4',
  );
  assert.equal(result.allowed, true, 'four code heads still proceeds');

  const floor = client.lifecycleMetrics;
  assert.ok(floor, 'the run records the lifecycle floor even when it proceeds');
  assert.equal(floor.findingHeads, 4);
  assert.deepEqual(floor.findingHeadIds, ['h1', 'h2', 'h3', 'h4']);
});

test('O3c: a later metrics-free sticky write still carries that floor', async () => {
  // The other half of the same defect: recording the floor is worthless if the
  // next of the sixteen sticky writers overwrites it. The run-scoped metrics are
  // injected structurally, so no call site has to remember.
  const written = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (init?.method === 'PATCH' || init?.method === 'POST') {
      written.push(JSON.parse(init.body).body);
      return new Response('{}');
    }
    return new Response(JSON.stringify([{
      id: 1,
      user: { login: 'github-actions[bot]' },
      body: '<!-- autonomous-review-state -->\n## Autonomous review state\n\n- **Head:** `old`\n',
    }]));
  };
  try {
    const client = new reviewGate.GitHubClient({ repository: 'o/r', token: 't' });
    client.setLifecycleMetrics({
      findingHeads: 4,
      findingHeadIds: ['h1', 'h2', 'h3', 'h4'],
      kind: 'code',
    });
    // A plain `changes_required` update — the shape fifteen of the sixteen writers use.
    await client.updateStickyComment(258, '## Autonomous review state\n\n- **Head:** `new`\n');
    assert.equal(written.length, 1);
    assert.equal(
      readMetrics(written[0])?.findingHeads,
      4,
      'the floor survives a sticky write that knows nothing about the lifecycle',
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ---------------------------------------------------------------------------
// Round 5. One P2 finding on head `9bd21ca`: the floor was durable across sticky
// writes but not across REPEATED lifecycle checks inside one run.
// ---------------------------------------------------------------------------

test('P1: a second lifecycle check in the same run cannot lower the floor', async () => {
  // enforceRestructure runs twice per run (driver precondition + pre-Codex
  // revalidation). Each seeded recordedMetrics from the sticky comment ALONE, so
  // against a metrics-less sticky both started from null and the second call's
  // partial read replaced the first call's larger observation.
  const reads = [
    findingsOn('h1', 'h2', 'h3', 'h4'),   // first check: sees all four
    findingsOn('h2', 'h3', 'h4'),         // second check: partial, one omitted
  ];
  let call = 0;
  const client = {
    async reviewComments() { return reads[call++] ?? []; },
    async reviews() { return []; },
    async pullRequestFiles() { return CODE; },
    async stickyComment() { return null; },   // metrics-less sticky
    async updateStickyComment() {},
    async setStatus() {},
    async setDraft() {},
    // DELIBERATELY NAIVE — a plain assignment, so this probe measures the
    // SEEDING fix in enforceRestructure and nothing else. A fake that merged
    // internally would pass with the production fix reverted, i.e. it would be
    // testing the fixture. The monotonic setter is isolated by `P1b`.
    setLifecycleMetrics(metrics) { this.lifecycleMetrics = metrics ?? null; },
  };
  const pr = { number: 258, body: '', html_url: 'https://example.invalid/pr/258' };

  await enforceRestructure(client, pr, 'head-4');
  assert.equal(client.lifecycleMetrics.findingHeads, 4, 'first check observes four');

  await enforceRestructure(client, pr, 'head-4');
  assert.equal(
    client.lifecycleMetrics.findingHeads,
    4,
    'the partial second read must not walk the run floor back to three',
  );
  assert.deepEqual(
    [...client.lifecycleMetrics.findingHeadIds].sort(),
    ['h1', 'h2', 'h3', 'h4'],
    'and it keeps the identity that the partial read omitted',
  );
});

test('P2: the preserved floor still catches the fifth head under a partial read', () => {
  // Why P1 matters. Codex adds h5; the live read is partial and omits h1. With the
  // floor intact the union is five and the unit must restructure. Had the floor
  // been walked back to three, the union would be four and the gate would invite
  // yet another correction head on a unit that had already crossed.
  const preserved = {
    findingHeads: 4,
    findingHeadIds: ['h1', 'h2', 'h3', 'h4'],
    kind: 'code',
  };
  const crossed = assessRestructure({
    comments: findingsOn('h2', 'h3', 'h4', 'h5'),
    reviews: [],
    pullRequestFiles: CODE,
    body: '',
    recordedMetrics: preserved,
  });
  assert.equal(crossed.findingHeadCount, 5);
  assert.equal(crossed.state, 'restructure_required');

  const walkedBack = assessRestructure({
    comments: findingsOn('h2', 'h3', 'h4', 'h5'),
    reviews: [],
    pullRequestFiles: CODE,
    body: '',
    recordedMetrics: { findingHeads: 3, findingHeadIds: ['h2', 'h3', 'h4'], kind: 'code' },
  });
  assert.equal(walkedBack.findingHeadCount, 4, 'the defect this prevents, stated exactly');
  assert.equal(walkedBack.state, 'reviewing');
});

test('P3: mergeRecordedMetrics accumulates floors and keeps the latest assessment', () => {
  const merged = mergeRecordedMetrics(
    { findingHeads: 4, findingHeadIds: ['h1', 'h2', 'h3', 'h4'], kind: 'docs', firstSeenAt: '2026-07-01T00:00:00.000Z', state: 'reviewing' },
    { findingHeads: 3, findingHeadIds: ['h2', 'h3', 'h5'], kind: 'code', firstSeenAt: '2026-07-30T00:00:00.000Z', state: 'restructure_required', threshold: 3 },
  );
  assert.equal(merged.findingHeads, 5, 'identities union, they do not replace');
  assert.deepEqual([...merged.findingHeadIds].sort(), ['h1', 'h2', 'h3', 'h4', 'h5']);
  assert.equal(merged.kind, 'docs', 'strictest kind ever presented governs');
  assert.equal(merged.firstSeenAt, '2026-07-01T00:00:00.000Z', 'elapsed does not restart');
  assert.equal(merged.state, 'restructure_required', 'latest assessment scalars win');
  assert.equal(merged.threshold, 3);
  assert.equal(mergeRecordedMetrics(null, undefined), null, 'nothing recorded stays nothing');
});

test('P1b: the real client setter is monotonic on its own', () => {
  // The other half, isolated: even a caller that hands over a smaller reading
  // cannot lower the stored floor. `P1` proves the seeding; this proves the
  // setter, so neither fix can silently regress behind the other.
  const client = new reviewGate.GitHubClient({ repository: 'o/r', token: 't' });
  client.setLifecycleMetrics({
    findingHeads: 4,
    findingHeadIds: ['h1', 'h2', 'h3', 'h4'],
    kind: 'code',
  });
  client.setLifecycleMetrics({
    findingHeads: 3,
    findingHeadIds: ['h2', 'h3', 'h4'],
    kind: 'code',
  });
  assert.equal(client.lifecycleMetrics.findingHeads, 4, 'a smaller reading cannot lower it');
  assert.deepEqual(
    [...client.lifecycleMetrics.findingHeadIds].sort(),
    ['h1', 'h2', 'h3', 'h4'],
  );
});
