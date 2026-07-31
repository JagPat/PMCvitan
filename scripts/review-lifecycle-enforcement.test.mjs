// Part 2: the lifecycle is ENFORCED, and its floor is DURABLE.
//
// Part 1 (#259) merged the policy model. On its own it governed nothing — the gate
// never invoked it, so a unit past its limit could still proceed to Codex and
// merge. These probes pin the enforcement and the persistence that makes the
// policy's floor mean anything.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  RESTRUCTURE_AFTER_FINDING_HEADS,
  mergeRecordedMetrics,
  preserveMetrics,
  readMetrics,
  renderMetrics,
} from './review-lifecycle.mjs';
import { enforceRestructure, isRetryableTerminalReviewFailure } from './autonomous-review-gate.mjs';
import * as reviewGate from './autonomous-review-gate.mjs';

const CODEX = { login: 'chatgpt-codex-connector[bot]' };
const findingsOn = (...heads) => heads.map((head, index) => ({
  user: CODEX, commit_id: head, original_commit_id: head, id: index + 1,
}));

function gateClient({ reads, sticky = null, naiveSetter = false }) {
  let call = 0;
  return {
    statuses: [], sticky: [], drafted: [],
    async reviewComments() { return reads[Math.min(call++, reads.length - 1)]; },
    async reviews() { return []; },
    async stickyComment() { return sticky; },
    async updateStickyComment(number, body) { this.sticky.push(body); },
    async setStatus(head, state, description) { this.statuses.push({ state, description }); },
    async pullRequest() {
      return { number: 900, state: 'open', head: { sha: 'head-x' }, draft: true };
    },
    async setDraft(pullRequest, draft) {
      this.drafted.push(draft);
      return { ...pullRequest, draft };
    },
    setLifecycleMetrics(metrics) {
      this.lifecycleMetrics = naiveSetter
        ? metrics ?? null
        : mergeRecordedMetrics(this.lifecycleMetrics, metrics);
    },
  };
}

const PR = { number: 900, body: '', html_url: 'https://example.invalid/pr/900' };

// ---------------------------------------------------------------------------
// E1: the gate BLOCKS a unit at its limit. This is the whole point of part 2.
// ---------------------------------------------------------------------------

test('E1: a unit at the limit is blocked, drafted, and fails its status', async () => {
  const client = gateClient({ reads: [findingsOn('h1', 'h2', 'h3', 'h4', 'h5')] });
  const result = await enforceRestructure(client, PR, 'head-x');

  assert.equal(result.allowed, false, 'five finding heads must not proceed');
  assert.equal(result.state, 'restructure_required');
  assert.deepEqual(client.drafted, [true], 'the head is returned to draft');
  assert.deepEqual(
    client.statuses.map((entry) => [entry.state, entry.description]),
    [['failure', 'review: restructure required']],
    'and the required status FAILS — it is never published as green',
  );
  assert.match(client.sticky.join('\n'), /Replaces: #900/u, 'the instruction names the replacement');
});

test('E1b: a unit under the limit proceeds untouched', async () => {
  const client = gateClient({ reads: [findingsOn('h1', 'h2', 'h3', 'h4')] });
  const result = await enforceRestructure(client, PR, 'head-x');
  assert.equal(result.allowed, true);
  assert.equal(result.threshold, RESTRUCTURE_AFTER_FINDING_HEADS);
  assert.deepEqual(client.statuses, [], 'no status is written for a healthy unit');
  assert.deepEqual(client.drafted, [], 'and it is not drafted');
});

// ---------------------------------------------------------------------------
// E2: the floor is recorded on the ALLOWED path, and survives other writers.
// ---------------------------------------------------------------------------

test('E2: the floor is recorded even when the head is allowed through', async () => {
  // Recording only on the blocking path records it once the unit has ALREADY
  // crossed — exactly when a floor can no longer do its job.
  const client = gateClient({ reads: [findingsOn('h1', 'h2', 'h3', 'h4')] });
  await enforceRestructure(client, PR, 'head-x');
  assert.equal(client.lifecycleMetrics?.findingHeads, 4);
  assert.deepEqual([...client.lifecycleMetrics.findingHeadIds].sort(), ['h1', 'h2', 'h3', 'h4']);
});

test('E2b: a second check in the same run cannot lower the recorded floor', async () => {
  // Two preconditions run per gate invocation. Against a metrics-less sticky both
  // start from nothing, so a partial second read could replace a larger first.
  const client = gateClient({
    reads: [findingsOn('h1', 'h2', 'h3', 'h4'), findingsOn('h2', 'h3', 'h4')],
    naiveSetter: true, // isolates the SEEDING, not the setter
  });
  await enforceRestructure(client, PR, 'head-x');
  assert.equal(client.lifecycleMetrics.findingHeads, 4);
  await enforceRestructure(client, PR, 'head-x');
  assert.equal(
    client.lifecycleMetrics.findingHeads, 4,
    'the partial second read must not walk the run floor back to three',
  );
});

test('E2c: a metrics-free sticky write through the REAL client preserves the floor', async () => {
  // Driven through GitHubClient.updateStickyComment, not through preserveMetrics
  // directly: the point of this probe is that the WIRING preserves the block, so
  // a writer that knows nothing about the lifecycle cannot erase it. Testing the
  // pure function here would pass with the wiring removed.
  const written = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (init?.method && init.method !== 'GET') {
      written.push(JSON.parse(init.body).body);
      return new Response('{}');
    }
    const page = /[?&]page=(\d+)/u.exec(String(url))?.[1] ?? '1';
    if (page !== '1') return new Response('[]');
    return new Response(JSON.stringify([{
      id: 1,
      user: { login: 'github-actions[bot]' },
      body: `<!-- autonomous-review-state -->\n${renderMetrics({
        findingHeads: 4, findingHeadIds: ['h1', 'h2', 'h3', 'h4'],
      })}\n\n- **Head:** \`old\`\n`,
    }]));
  };
  try {
    const client = new reviewGate.GitHubClient({ repository: 'o/r', token: 't' });
    // The shape every other sticky writer uses: no metrics block at all.
    await client.updateStickyComment(900, '## Autonomous review state\n\n- **Head:** `new`\n');
    assert.equal(written.length, 1);
    assert.equal(
      readMetrics(written[0])?.findingHeads, 4,
      'the recorded floor survives a writer that knows nothing about it',
    );
    assert.match(written[0], /- \*\*Head:\*\* `new`/u, 'and the new state is still written');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ---------------------------------------------------------------------------
// E3: fail closed on an unreadable floor — but transiently, so it self-heals.
// ---------------------------------------------------------------------------

test('E3: an unreadable floor blocks rather than guessing', async () => {
  const client = gateClient({ reads: [findingsOn('h1')] });
  client.stickyComment = async () => { throw new Error('502'); };
  const result = await enforceRestructure(client, PR, 'head-x');
  assert.equal(result.allowed, false, 'an unverifiable floor cannot clear a head');
  assert.equal(result.undecided, true, 'and it is undecided, not a restructure verdict');
  assert.deepEqual(
    client.statuses.map((entry) => entry.description),
    ['review: restructure check undecided'],
  );
});

test('E3b: that undecided block is RETRYABLE, so fail-closed is not fail-forever', () => {
  assert.equal(
    isRetryableTerminalReviewFailure({
      state: 'failure', description: 'review: restructure check undecided',
    }),
    true,
  );
  assert.equal(
    isRetryableTerminalReviewFailure({
      state: 'failure', description: 'review: restructure required',
    }),
    false,
    'a real restructure verdict is persistent — it is not retried away',
  );
});

// ---------------------------------------------------------------------------
// E4: the sticky comment is read and written PAGINATED.
// ---------------------------------------------------------------------------

test('E4: both sticky paths paginate, so a long thread cannot hide the floor', async () => {
  const urls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    urls.push(String(url));
    if (init?.method && init.method !== 'GET') return new Response('{}');
    const page = /[?&]page=(\d+)/u.exec(String(url))?.[1] ?? '1';
    if (page === '1') {
      return new Response(JSON.stringify(
        Array.from({ length: 100 }, (_, i) => ({ id: i, user: { login: 'someone' }, body: 'x' })),
      ));
    }
    if (page === '2') {
      return new Response(JSON.stringify([{
        id: 999,
        user: { login: 'github-actions[bot]' },
        body: `<!-- autonomous-review-state -->\n${renderMetrics({ findingHeads: 4 })}`,
      }]));
    }
    return new Response('[]');
  };
  try {
    const client = new reviewGate.GitHubClient({ repository: 'o/r', token: 't' });
    const bodies = await client.stickyComment(900);
    assert.equal(
      mergeRecordedMetrics(...bodies.map((body) => readMetrics(body)))?.findingHeads, 4,
      'the floor is found on page two',
    );
    assert.ok(urls.some((url) => url.includes('page=2')), 'the reader paginated');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ---------------------------------------------------------------------------
// E5: the precondition runs FIRST, at every seam.
//
// HONEST NOTE: this is a STRUCTURAL pin, not a behavioural one. Driving the full
// gate would need a fixture for the entire run, and the value here is narrow and
// specific — that no future edit reorders the lifecycle behind the scope or CI
// branch, where a blocked unit could reach Codex before anyone checks whether it
// should still be under review. Ordering is the property; source order is the
// evidence. E1 covers the behaviour of the gate itself.
// ---------------------------------------------------------------------------

test('E5: the lifecycle precedes the scope gate at BOTH enforcement seams', async () => {
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(new URL('./autonomous-review-gate.mjs', import.meta.url), 'utf8');

  // `await` excludes the exported definitions and counts CALL SITES only.
  const preconditions = [...source.matchAll(/await enforceRestructure\(/gu)];
  const scopeGates = [...source.matchAll(/await enforceReviewScope\(/gu)];
  assert.equal(scopeGates.length, 2, 'the gate has exactly two enforcement seams');
  assert.ok(
    preconditions.length >= 2,
    'each seam runs the lifecycle precondition — a seam without one is unguarded',
  );

  // Pair each scope gate with the nearest preceding lifecycle call.
  for (const scope of scopeGates) {
    const before = preconditions.filter((entry) => entry.index < scope.index);
    assert.ok(
      before.length > 0,
      'every scope gate is preceded by the lifecycle precondition, never followed by it',
    );
  }
});

// ===========================================================================
// Round 1 corrections. Three findings on head `4e3644a`, all of them real.
// ===========================================================================

// ---------------------------------------------------------------------------
// E6 (P1): the precondition is necessary and NOT sufficient.
//
// It runs before Codex has spoken, so it sees the count as of the PREVIOUS head.
// A unit at four finding-bearing heads passes it; Codex then posts findings on
// this head, making five; and the plain `changes_required` path answers the fifth
// head by asking for a sixth. That is exactly the correction round the policy
// says must not be granted, noticed one head too late.
// ---------------------------------------------------------------------------

test('E6: a finding that CROSSES the limit is answered with restructure, not another round', async () => {
  // Four heads when the precondition ran; five once this head drew findings.
  const client = gateClient({ reads: [findingsOn('h1', 'h2', 'h3', 'h4', 'h5')] });
  const outcome = await reviewGate.publishFindingOutcome(client, PR, 'head-x', {
    detail: '3 current-head Codex findings',
    attempt: 1,
    next: 'Claude Auto-fix handles the review comments and pushes a new head.',
  });

  const sticky = client.sticky.join('\n');
  assert.match(sticky, /restructure_required/u, 'the crossing head gets the replacement verdict');
  assert.doesNotMatch(
    sticky, /State:\D+`changes_required`/u,
    'and is NOT told to push another correction head',
  );
  assert.deepEqual(
    client.statuses.map((entry) => entry.description),
    ['review: restructure required'],
    'exactly one verdict is published for one head',
  );
  assert.match(outcome.detail, /open a declared replacement/u);
});

test('E6b: a finding BELOW the limit still asks for an ordinary correction head', async () => {
  const client = gateClient({ reads: [findingsOn('h1', 'h2', 'h3')] });
  const outcome = await reviewGate.publishFindingOutcome(client, PR, 'head-x', {
    detail: '2 current-head Codex findings',
    attempt: 1,
    next: 'Claude Auto-fix handles the review comments and pushes a new head.',
  });

  assert.match(client.sticky.join('\n'), /changes_required/u);
  assert.deepEqual(
    client.statuses.map((entry) => entry.description),
    ['review: 2 current-head Codex findings'],
  );
  assert.equal(outcome.detail, '2 current-head Codex findings');
});

// ---------------------------------------------------------------------------
// E7 (P2): an unreadable floor blocks only where it is actually BLIND.
//
// The floor is a LOWER bound and a lower bound cannot lower anything. If the live
// reading alone already reaches the limit, the verdict is decided without the
// record — and publishing a retryable `undecided` there would strand an
// already-over-limit unit in recovery instead of issuing the verdict it earned.
// ---------------------------------------------------------------------------

test('E7: an unreadable floor does not rescue a unit the LIVE evidence already convicts', async () => {
  const client = gateClient({ reads: [findingsOn('h1', 'h2', 'h3', 'h4', 'h5')] });
  client.stickyComment = async () => { throw new Error('comments API unavailable'); };

  const result = await enforceRestructure(client, PR, 'head-x');
  assert.equal(result.allowed, false);
  assert.equal(result.undecided, false, 'five live heads decide it without the record');
  assert.equal(result.state, 'restructure_required');
  assert.deepEqual(
    client.statuses.map((entry) => entry.description),
    ['review: restructure required'],
    'the replacement verdict is published, not a retryable "undecided"',
  );
});

test('E7b: an unreadable floor still blocks as undecided when the live reading is UNDER the limit', async () => {
  const client = gateClient({ reads: [findingsOn('h1', 'h2')] });
  client.stickyComment = async () => { throw new Error('comments API unavailable'); };

  const result = await enforceRestructure(client, PR, 'head-x');
  assert.equal(result.allowed, false, 'blind about a possible crossing still fails closed');
  assert.equal(result.undecided, true);
  assert.deepEqual(
    client.statuses.map((entry) => entry.description),
    ['review: restructure check undecided'],
  );
});

// ---------------------------------------------------------------------------
// E8 (P2): a unit that already HAS a rule keeps it.
//
// This module's own header says it governs "the case that had no rule". A
// docs-only unit that has handed its still-open questions to named probes via
// `Review-Deferred-To-Probes:` is not that case — it is following the protocol
// the repository wrote for exactly this situation. Blocking it here would replace
// that protocol, which is what deleting the docs/code classifier was meant to
// prevent. Part 2 shipped the cap without honouring the rule part 1 wrote down.
// ---------------------------------------------------------------------------

test('E8: the policy stands down for a unit holding an accepted probe deferral', async () => {
  const { assessRestructure } = await import('./review-lifecycle.mjs');
  const inputs = {
    comments: findingsOn('h1', 'h2', 'h3', 'h4', 'h5'),
    reviews: [],
    body: '',
  };

  const blocked = assessRestructure(inputs);
  assert.equal(blocked.state, 'restructure_required', 'without a deferral the cap applies');

  const deferred = assessRestructure({ ...inputs, deferralInForce: true });
  assert.equal(deferred.allowed, true, 'with one, the deferral protocol owns the unit');
  assert.equal(deferred.deferred, true);
  assert.match(deferred.reason, /deferral protocol owns it/u);
});

test('E8b: the gate RECOGNISES an accepted deferral through the convergence contract', async () => {
  // Derived from the same source the gate reads, so this tracks docs/STATUS.md
  // instead of pinning a phase number that legitimately changes.
  const { loadStatusDocument } = await import('./autonomous-status-state.mjs');
  const { deferralPhases } = await import('./review-efficiency.mjs');
  const phase = deferralPhases((await loadStatusDocument())?.now)?.[0];
  assert.ok(Number.isInteger(phase), 'STATUS must name a phase with open work');

  const docsOnly = [{ filename: 'docs/superpowers/plans/some-plan.md', status: 'modified' }];
  const client = gateClient({ reads: [findingsOn('h1', 'h2', 'h3', 'h4', 'h5')] });
  client.commit = async () => ({
    commit: {
      message: 'Bound docs-only review\n\nBody.\n\n'
        + `Review-Convergence: complete\nReview-Deferred-To-Probes: phase-${phase}-task-1\n`,
    },
    files: [{ filename: 'docs/reviews/pr-900-convergence.md', status: 'added' }],
  });
  client.pullRequestFiles = async () => docsOnly;

  const result = await enforceRestructure(client, PR, 'head-x');
  assert.equal(result.allowed, true, 'the accepted deferral stands the restructure cap down');
  assert.equal(result.deferred, true);
  assert.deepEqual(client.statuses, [], 'nothing is published against the head');
  assert.deepEqual(client.drafted, [], 'and it is not drafted');
});

test('E8c: an INVALID deferral buys nothing — the cap still applies', async () => {
  // The exemption is granted only on a deferral the convergence gate itself
  // accepts. "later" schedules nothing, so it must not launder past the cap.
  const client = gateClient({ reads: [findingsOn('h1', 'h2', 'h3', 'h4', 'h5')] });
  client.commit = async () => ({
    commit: {
      message: 'Docs head\n\nBody.\n\n'
        + 'Review-Convergence: complete\nReview-Deferred-To-Probes: later\n',
    },
    files: [{ filename: 'docs/reviews/pr-900-convergence.md', status: 'added' }],
  });
  client.pullRequestFiles = async () => [
    { filename: 'docs/superpowers/plans/some-plan.md', status: 'modified' },
  ];

  const result = await enforceRestructure(client, PR, 'head-x');
  assert.equal(result.allowed, false, 'a deferral that schedules nothing exempts nothing');
  assert.equal(result.state, 'restructure_required');
});

test('E8d: a CODE unit at the limit is still blocked — the deferral is docs-only', async () => {
  const client = gateClient({ reads: [findingsOn('h1', 'h2', 'h3', 'h4', 'h5')] });
  client.commit = async () => ({
    commit: { message: 'Code head\n\nBody.\n\nReview-Convergence: complete\n' },
    files: [{ filename: 'docs/reviews/pr-900-convergence.md', status: 'added' }],
  });
  client.pullRequestFiles = async () => [{ filename: 'scripts/thing.mjs', status: 'modified' }];

  const result = await enforceRestructure(client, PR, 'head-x');
  assert.equal(result.allowed, false, 'no deferral is owed or held by a code unit');
  assert.equal(result.state, 'restructure_required');
});

// ===========================================================================
// Round 2. Five findings on head `f2efc44`, all of them one defect:
// "how many finding-bearing heads has this unit had" was re-derived at four
// sites, each from its own possibly-partial read. `findingEvidence` answers it
// once, from every source, and every consumer takes that answer.
// ===========================================================================

test('V1: the view unions the recorded floor, the live read, and the known crossing head', async () => {
  const { findingEvidence } = await import('./review-lifecycle.mjs');

  // The crossing case: four recorded, a live read that lost one, and this head.
  const view = findingEvidence({
    recorded: { findingHeads: 4, findingHeadIds: ['h1', 'h2', 'h3', 'h4'] },
    live: ['h2', 'h4'],
    currentHead: 'h5',
    currentHeadHasFindings: true,
  });
  assert.equal(view.count, 5, 'the partial live read cannot hide a head either other source saw');
  assert.deepEqual([...view.ids].sort(), ['h1', 'h2', 'h3', 'h4', 'h5']);

  // A head NOT known to bear findings is never invented.
  const quiet = findingEvidence({
    recorded: { findingHeads: 4, findingHeadIds: ['h1', 'h2', 'h3', 'h4'] },
    live: [],
    currentHead: 'h5',
  });
  assert.equal(quiet.count, 4, 'a clean head does not count against the unit');
});

test('V2: an unreadable floor is blind only where the gap could change the answer', async () => {
  const { findingEvidence, RESTRUCTURE_AFTER_FINDING_HEADS } = await import('./review-lifecycle.mjs');
  const under = findingEvidence({ live: ['h1', 'h2'], floorUnreadable: true });
  assert.equal(under.blind, true, 'below the cap the hidden record still decides');

  const at = findingEvidence({
    live: Array.from({ length: RESTRUCTURE_AFTER_FINDING_HEADS }, (_, i) => `h${i}`),
    floorUnreadable: true,
  });
  assert.equal(at.blind, false, 'at the cap a missing LOWER bound cannot lower anything');
});

// ---------------------------------------------------------------------------
// V3: the funnel carries the crossing head instead of re-reading for it.
// ---------------------------------------------------------------------------

test('V3: a partial re-read cannot let the crossing head buy another correction round', async () => {
  // The recorded floor holds four heads. The live re-read inside the funnel comes
  // back partial and does NOT include this head — the exact shape that previously
  // published `changes_required` and asked for a sixth head.
  const client = gateClient({ reads: [findingsOn('h1', 'h2', 'h3', 'h4')] });
  client.stickyComment = async () => `<!-- autonomous-review-state -->\n${renderMetrics({
    findingHeads: 4, findingHeadIds: ['h1', 'h2', 'h3', 'h4'],
  })}\n\n- **Head:** \`old\`\n`;

  const outcome = await reviewGate.publishFindingOutcome(client, PR, 'head-x', {
    detail: '5 current-head Codex findings',
    attempt: 1,
    next: 'Claude Auto-fix handles the review comments and pushes a new head.',
  });

  assert.match(client.sticky.join('\n'), /restructure_required/u);
  assert.deepEqual(
    client.statuses.map((entry) => entry.description),
    ['review: restructure required'],
    'the head that crosses is counted from what the caller already knew',
  );
  assert.match(outcome.detail, /open a declared replacement/u);
});

// ---------------------------------------------------------------------------
// V4: preservation MERGES. The one site that preferred was the one that broke.
// ---------------------------------------------------------------------------

test('V4: a smaller run reading cannot rewrite a larger recorded floor downward', async () => {
  const { preserveMetrics, readMetrics: read } = await import('./review-lifecycle.mjs');
  const previous = `- **Head:** \`old\`\n${renderMetrics({
    findingHeads: 4, findingHeadIds: ['h1', 'h2', 'h3', 'h4'],
  })}`;
  const written = preserveMetrics(
    '## Autonomous review state\n\n- **Head:** `new`\n',
    previous,
    { findingHeads: 2, findingHeadIds: ['h1', 'h2'] },
  );
  const carried = read(written);
  assert.equal(carried.findingHeads, 4, 'four heads survive a run that only saw two');
  assert.deepEqual([...carried.findingHeadIds].sort(), ['h1', 'h2', 'h3', 'h4']);
});

// ---------------------------------------------------------------------------
// V5: the deferral consult sees the same unit the cap did.
// ---------------------------------------------------------------------------

test('V5: a partial live read cannot make a deferred unit look below the deferral threshold', async () => {
  const { assessConvergence, PLAN_REVIEW_ROUND_CAP } = await import('./review-efficiency.mjs');
  const docsOnly = [{ filename: 'docs/superpowers/plans/p.md', status: 'modified' }];
  const shared = {
    comments: findingsOn('h1'), // the live read lost almost everything
    reviews: [],
    headMessage: 'Head\n\nBody.\n\nReview-Convergence: complete\nReview-Deferred-To-Probes: phase-9-task-1\n',
    changedFiles: [{ filename: 'docs/reviews/pr-900-convergence.md', status: 'added' }],
    pullRequestFiles: docsOnly,
    activePhases: [9],
  };

  const withoutFloor = assessConvergence(shared);
  assert.notEqual(
    withoutFloor.deferralRequired, true,
    'one live head reads below the deferral cap — the condition the finding describes. '
      + '(The field is absent rather than false, because the assessment short-circuits '
      + 'below the convergence cap; either way `acceptedDeferral` reads it as "no".)',
  );

  const withFloor = assessConvergence({ ...shared, findingHeadCount: 5 });
  assert.equal(withFloor.deferralRequired, true, 'the durable floor restores the real size');
  assert.equal(withFloor.allowed, true, 'and the handoff it holds is accepted');
  assert.ok(PLAN_REVIEW_ROUND_CAP > 1, 'sanity: the cap is above the partial reading');
});

test('V5b: a supplied floor can only RAISE the obligation, never excuse a head', async () => {
  const { assessConvergence } = await import('./review-efficiency.mjs');
  // Two live finding heads owe convergence evidence. A caller passing a smaller
  // count must not be able to buy the head out of that obligation.
  const result = assessConvergence({
    comments: findingsOn('h1', 'h2'),
    reviews: [],
    headMessage: 'Head\n\nNo trailers here.\n',
    changedFiles: [],
    findingHeadCount: 0,
  });
  assert.equal(result.required, true, 'the live reading still governs upward');
  assert.equal(result.allowed, false);
});

// ---------------------------------------------------------------------------
// V6: an accepted deferral is decided BEFORE the floor is consulted, so an
// unreadable record cannot draft a head whose outcome was never in doubt.
// ---------------------------------------------------------------------------

test('V6: a deferred unit is not blocked by an unreadable floor', async () => {
  const { assessRestructure } = await import('./review-lifecycle.mjs');
  const result = assessRestructure({
    comments: findingsOn('h1', 'h2', 'h3'), // under the cap; the hidden floor is the question
    reviews: [],
    body: '',
    floorUnreadable: true,
    deferralInForce: true,
  });
  assert.equal(result.allowed, true, 'the exemption holds on BOTH sides of the cap');
  assert.equal(result.undecided, false, 'so no hidden record can change the answer');
  assert.equal(result.deferred, true);
});

// ---------------------------------------------------------------------------
// V7: the documented recovery command and the code agree on what is retryable.
//
// Finding 4 was a one-line omission, but the reason it happened is that two
// lists of the same fact live in two files. This pins them to each other, so the
// next status added to one and forgotten in the other fails here.
// ---------------------------------------------------------------------------

test('V7: every retryable status the runbook lists is retryable in code, and vice versa', async () => {
  const { readFile } = await import('node:fs/promises');
  const runbook = await readFile(new URL('../docs/AUTONOMOUS_LOOP.md', import.meta.url), 'utf8');
  const source = await readFile(new URL('./autonomous-review-gate.mjs', import.meta.url), 'utf8');

  const jq = runbook.split('\n').find((line) => line.includes('def retryable:'));
  assert.ok(jq, 'the runbook still documents a retryable classifier');
  const documented = [...jq.matchAll(/\$description(?:\s*==\s*|\s*\|\s*contains\()"([^"]+)"/gu)]
    .map((match) => match[1]);
  assert.ok(documented.length >= 4, 'the runbook lists the retryable descriptions');

  for (const description of documented) {
    assert.equal(
      isRetryableTerminalReviewFailure({ state: 'failure', description: `review: ${description}` })
        || isRetryableTerminalReviewFailure({ state: 'failure', description }),
      true,
      `the runbook calls "${description}" retryable, so the code must too`,
    );
  }

  // And the other direction: every literal the code compares by equality is documented.
  const fn = source.slice(source.indexOf('export function isRetryableTerminalReviewFailure'));
  const coded = [...fn.slice(0, fn.indexOf('\n}')).matchAll(/'([^']*review:[^']*)'/gu)]
    .map((match) => match[1]);
  for (const description of coded) {
    assert.ok(
      documented.some((entry) => description.includes(entry)),
      `the code calls "${description}" retryable, so the runbook recovery must list it`,
    );
  }
});

test('V5c: the GATE passes the floor to the deferral consult, not just the ability to', async () => {
  // V5 proves `assessConvergence` CAN take a floor. That is not the same as the
  // gate handing it one — an earlier draft of this suite passed with the wiring
  // reverted, which is a probe testing itself. This drives `enforceRestructure`.
  const { loadStatusDocument } = await import('./autonomous-status-state.mjs');
  const { deferralPhases } = await import('./review-efficiency.mjs');
  const phase = deferralPhases((await loadStatusDocument())?.now)?.[0];
  assert.ok(Number.isInteger(phase), 'STATUS must name a phase with open work');

  // The recorded floor knows five heads; the live read comes back with ONE.
  const client = gateClient({ reads: [findingsOn('h1')] });
  client.stickyComment = async () => `<!-- autonomous-review-state -->\n${renderMetrics({
    findingHeads: 5, findingHeadIds: ['h1', 'h2', 'h3', 'h4', 'h5'],
  })}\n\n- **Head:** \`old\`\n`;
  client.commit = async () => ({
    commit: {
      message: 'Docs head\n\nBody.\n\n'
        + `Review-Convergence: complete\nReview-Deferred-To-Probes: phase-${phase}-task-1\n`,
    },
    files: [{ filename: 'docs/reviews/pr-900-convergence.md', status: 'added' }],
  });
  client.pullRequestFiles = async () => [
    { filename: 'docs/superpowers/plans/p.md', status: 'modified' },
  ];

  const result = await enforceRestructure(client, PR, 'head-x');
  assert.equal(result.findingHeadCount, 5, 'the cap is measured against the durable floor');
  assert.equal(
    result.allowed, true,
    'and the deferral consult must see the SAME five heads — with only the live read '
      + 'it sees one, decides no deferral is owed, and forces replacement',
  );
  assert.equal(result.deferred, true);
  assert.deepEqual(client.statuses, [], 'nothing is published against the head');
});

// ===========================================================================
// Round 1 on #261. Five findings, all "the invariant does not yet reach here".
// ===========================================================================

test('W1: duplicate sticky comments are UNIONED, not first-wins', async () => {
  // There should be one; a missed paginated write is exactly what makes two. A
  // stale first with four heads plus a later one with five must read as five.
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (init?.method && init.method !== 'GET') return new Response('{}');
    const page = /[?&]page=(\d+)/u.exec(String(url))?.[1] ?? '1';
    if (page !== '1') return new Response('[]');
    return new Response(JSON.stringify([
      {
        id: 1,
        user: { login: 'github-actions[bot]' },
        body: `<!-- autonomous-review-state -->\n${renderMetrics({
          findingHeads: 4, findingHeadIds: ['h1', 'h2', 'h3', 'h4'],
        })}`,
      },
      {
        id: 2,
        user: { login: 'github-actions[bot]' },
        body: `<!-- autonomous-review-state -->\n${renderMetrics({
          findingHeads: 5, findingHeadIds: ['h1', 'h2', 'h3', 'h4', 'h5'],
        })}`,
      },
    ]));
  };
  try {
    const client = new reviewGate.GitHubClient({ repository: 'o/r', token: 't' });
    const bodies = await client.stickyComment(900);
    assert.equal(bodies.length, 2, 'every matching comment is returned');
    const merged = mergeRecordedMetrics(...bodies.map((body) => readMetrics(body)));
    assert.equal(merged.findingHeads, 5, 'the later, larger record is not ignored');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('W2: a LEGACY count-only floor still admits the crossing head', async () => {
  const { findingEvidence } = await import('./review-lifecycle.mjs');
  // Legacy record: four heads, no identities. Live read partial. This head is new.
  const view = findingEvidence({
    recorded: { findingHeads: 4 },
    live: [],
    currentHead: 'h5',
    currentHeadHasFindings: true,
  });
  assert.equal(view.count, 5, 'max(ids, floor) would silently absorb the fifth head into four');

  // Self-limiting: once identities are recorded, the same head cannot count twice.
  const rerun = findingEvidence({
    recorded: { findingHeads: 5, findingHeadIds: ['h1', 'h2', 'h3', 'h4', 'h5'] },
    live: [],
    currentHead: 'h5',
    currentHeadHasFindings: true,
  });
  assert.equal(rerun.count, 5, 'a rerun on the same head does not inflate the floor');
});

test('W3: non-finding evidence does not manufacture a finding-bearing head', async () => {
  // Four prior heads and a transiently missing clean reaction. `pending` and
  // `timed_out` are not findings; counting them blocks a unit that never crossed.
  const client = gateClient({ reads: [findingsOn('h1', 'h2', 'h3', 'h4')] });
  const outcome = await reviewGate.publishFindingOutcome(client, PR, 'head-x', {
    detail: 'Codex evidence changed during final verification',
    attempt: 1,
    next: 'Claude Auto-fix handles the latest review evidence and pushes a new head.',
    currentHeadHasFindings: false,
  });
  assert.match(client.sticky.join('\n'), /changes_required/u, 'it is still published as blocking');
  assert.doesNotMatch(
    client.sticky.join('\n'), /restructure_required/u,
    'but a timeout is not a fifth finding-bearing head',
  );
  assert.equal(outcome.detail, 'Codex evidence changed during final verification');
});

test('W4: the deferral is consulted on the UNDECIDED block too, not only restructure', async () => {
  const { loadStatusDocument } = await import('./autonomous-status-state.mjs');
  const { deferralPhases } = await import('./review-efficiency.mjs');
  const phase = deferralPhases((await loadStatusDocument())?.now)?.[0];
  assert.ok(Number.isInteger(phase));

  // Sticky read fails; the live read is UNDER the cap, so the policy would block
  // as `undecided` — but this unit holds an accepted handoff, which makes the
  // hidden record irrelevant either way.
  const client = gateClient({ reads: [findingsOn('h1', 'h2', 'h3')] });
  client.stickyComment = async () => { throw new Error('502'); };
  client.commit = async () => ({
    commit: {
      message: 'Docs head\n\nBody.\n\n'
        + `Review-Convergence: complete\nReview-Deferred-To-Probes: phase-${phase}-task-1\n`,
    },
    files: [{ filename: 'docs/reviews/pr-900-convergence.md', status: 'added' }],
  });
  client.pullRequestFiles = async () => [
    { filename: 'docs/superpowers/plans/p.md', status: 'modified' },
  ];

  const result = await enforceRestructure(client, PR, 'head-x');
  assert.equal(result.allowed, true, 'the accepted deferral is honoured on the undecided path');
  assert.equal(result.deferred, true);
  assert.deepEqual(client.statuses, [], 'nothing is drafted or failed');
});

test('W5: the convergence gate takes the run floor, not only its own live read', async () => {
  const { assessConvergence } = await import('./review-efficiency.mjs');
  // The precondition saw h1,h2; the convergence read returns only h2.
  const partial = assessConvergence({
    comments: findingsOn('h2'),
    reviews: [],
    headMessage: 'Head\n\nNo convergence trailer.\n',
    changedFiles: [],
  });
  assert.equal(partial.required, false, 'one live head reads below the convergence cap');

  const withFloor = assessConvergence({
    comments: findingsOn('h2'),
    reviews: [],
    headMessage: 'Head\n\nNo convergence trailer.\n',
    changedFiles: [],
    findingHeadCount: 2,
  });
  assert.equal(withFloor.required, true, 'the run floor restores the crossed threshold');
  assert.equal(withFloor.allowed, false, 'so the head owes convergence evidence');
});

test('W5b: the GATE hands the convergence check its recorded floor', async () => {
  // Not just that assessConvergence CAN take one — that enforceReviewConvergence
  // passes it. Same discrimination lesson as V5c.
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(new URL('./autonomous-review-gate.mjs', import.meta.url), 'utf8');
  const fn = source.slice(source.indexOf('export async function enforceReviewConvergence'));
  const body = fn.slice(0, fn.indexOf('\n}\n'));
  assert.match(
    body, /findingHeadCount:\s*client\.lifecycleMetrics\?\.findingHeads/u,
    'the convergence assessment receives the floor this run already observed',
  );
});

test('W3b: the final-verification CALL SITE passes the conditional, not a constant', async () => {
  // W3 proves the parameter works; it passes `false` itself, so reverting the call
  // site leaves it green — the same non-discriminating shape as V5c, caught again.
  // This is a STRUCTURAL pin: the branch is reached only through the full review
  // pipeline, so it asserts the call as written rather than as executed. Recorded
  // that way rather than described as an end-to-end proof.
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(new URL('./autonomous-review-gate.mjs', import.meta.url), 'utf8');

  const marker = "recoveryReason: 'changed review evidence',";
  const at = source.indexOf(marker);
  assert.ok(at > 0, 'the final-verification publication still exists');
  const call = source.slice(at, at + 400);
  assert.match(
    call, /currentHeadHasFindings:\s*verifiedResult\.state === 'changes_required'/u,
    'a pending or timed-out verification must not assert a current-head finding',
  );

  // And the ordinary finding path keeps the default, which IS a finding.
  const findingPath = source.indexOf("recoveryReason: 'review finding',");
  assert.ok(findingPath > 0);
  assert.doesNotMatch(
    source.slice(findingPath - 400, findingPath), /currentHeadHasFindings:\s*false/u,
    'the real finding path still counts its head',
  );
});
