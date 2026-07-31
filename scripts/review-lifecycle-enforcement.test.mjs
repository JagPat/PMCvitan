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
  assert.equal(
    preconditions.length, 2,
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
