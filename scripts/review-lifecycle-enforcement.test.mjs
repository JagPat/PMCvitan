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
    const body = await client.stickyComment(900);
    assert.equal(readMetrics(body)?.findingHeads, 4, 'the floor is found on page two');
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
