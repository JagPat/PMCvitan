// The exclusive work lease.
//
// #252, #257, #260 and #261 were open at once. Nothing forbade it — the rule
// lived in prose. These probes pin the state that makes it enforceable.
//
// The `C*` probes are the correction round: the first version of this module
// ASSESSED the lease but never HELD it, and let the verdict decorate a start
// instruction rather than gate it. Each C probe fails against that version.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  LEASE_STATES,
  STATE_ISSUE_NUMBER,
  assessLease,
  readCursor,
  readLease,
  releaseOnMerge,
  renderRunnerState,
  replacementSource,
  startInstruction,
} from './autonomous-work-lease.mjs';
import {
  buildDriftHandoff,
  buildPostMergeContinuation,
} from './runner-continuation.mjs';
import {
  handOffMergedPullRequest,
  handOffStatusDrift,
  loadContinuationContext,
} from './autonomous-handoff.mjs';

// Shaped to satisfy `selectAutonomousOpenPullRequests`: same-repository head and
// base, and a default-branch base. A thinner fixture is silently filtered out,
// which makes a drift probe pass for the wrong reason.
const claudePr = (number, ref = `claude/thing-${number}`) => ({
  number,
  state: 'open',
  draft: true,
  head: { ref, sha: `sha-${number}`, repo: { full_name: 'o/r' } },
  base: { ref: 'main', repo: { full_name: 'o/r' } },
});

const allowed = assessLease({ lease: null, intent: {}, openPullRequests: [] });
const blocked = assessLease({
  lease: { pr: 260, claimId: null, head: 'a', state: 'reviewing' },
  intent: {},
  openPullRequests: [claudePr(260)],
});

const STATUS_DRIFTING = { phase: 4, task: 6, task_state: 'in_review', open_pr: 'none' };

// ---------------------------------------------------------------------------
// L1: the lease blocks a SECOND unit and never the first.
// ---------------------------------------------------------------------------

test('L1: a held lease refuses a different unit', () => {
  const result = assessLease({
    lease: { pr: 260, claimId: null, head: 'abc', state: 'reviewing' },
    intent: { pr: null },
    openPullRequests: [claudePr(260)],
  });
  assert.equal(result.allowed, false);
  assert.match(result.reason, /#260 holds the work lease \(reviewing\)/u);
  assert.match(result.reason, /Replaces: #260/u, 'and names the way to supersede it');
});

test('L1b: the holder itself is always allowed to continue', () => {
  // The lease stops a SECOND unit; stranding the first would be the opposite of
  // the point. Shepherding an open PR is not starting new work.
  const result = assessLease({
    lease: { pr: 260, claimId: null, head: 'abc', state: 'reviewing' },
    intent: { pr: 260 },
    openPullRequests: [claudePr(260)],
  });
  assert.equal(result.allowed, true);
  assert.equal(result.held.pr, 260);
});

test('L1c: a declared replacement may take the lease', () => {
  const result = assessLease({
    lease: { pr: 260, claimId: null, head: 'abc', state: 'reviewing' },
    intent: { replaces: 260 },
    openPullRequests: [claudePr(260)],
  });
  assert.equal(result.allowed, true, 'the handover rule the lifecycle already uses');
  assert.equal(result.replaces, 260, 'and the superseded PR is named for closing');
});

test('L1d: a replacement declaration for a DIFFERENT pr does not free the lease', () => {
  const result = assessLease({
    lease: { pr: 260, claimId: null, head: 'abc', state: 'reviewing' },
    intent: { replaces: 257 },
    openPullRequests: [claudePr(260)],
  });
  assert.equal(result.allowed, false, 'superseding #257 says nothing about #260');
});

// ---------------------------------------------------------------------------
// L2: a free lease is only free when reality agrees.
// ---------------------------------------------------------------------------

test('L2: a free lease with open claude PRs is a DISAGREEMENT, not permission', () => {
  const result = assessLease({
    lease: null,
    intent: {},
    openPullRequests: [claudePr(257), claudePr(252)],
  });
  assert.equal(result.allowed, false);
  assert.deepEqual(result.orphaned, [257, 252]);
  assert.match(result.reason, /close or adopt them/u);
});

test('L2b: a free lease with no claude PRs open permits work', () => {
  assert.equal(assessLease({ lease: null, intent: {}, openPullRequests: [] }).allowed, true);
});

test('L2c: non-claude branches do not hold the lease', () => {
  const result = assessLease({
    lease: null,
    intent: {},
    openPullRequests: [{ number: 99, head: { ref: 'dependabot/npm/x' } }],
  });
  assert.equal(result.allowed, true);
});

// ---------------------------------------------------------------------------
// L3 / C1: unreadable is not free — and the reader must actually be exact.
// ---------------------------------------------------------------------------

test('L3: an unreadable lease line blocks rather than assuming availability', () => {
  const lease = readLease('<!-- x -->\nActive work: #not-a-number oops\n');
  assert.equal(lease, undefined, 'present but unparseable is distinguishable from absent');

  const result = assessLease({ lease, intent: {}, openPullRequests: [] });
  assert.equal(result.allowed, false, 'a lease it cannot read might name an active PR');
  assert.match(result.reason, new RegExp(`#${STATE_ISSUE_NUMBER}`, 'u'));
});

test('L3b: an explicit "none" IS free, and a body with no lease line at all is free', () => {
  assert.equal(readLease('Active work: none'), null);
  assert.equal(readLease('nothing here'), null, 'a pre-lease body upgrades as free');
});

test('C1: the free state is an EXACT line, not a substring (finding 2)', () => {
  // `includes('Active work: none')` read all of these as FREE. Each is a shape a
  // half-written update actually produces, and each would have let the runner
  // start a second unit while one was active.
  assert.equal(readLease('Active work: nonee'), undefined, 'a corrupted suffix is not "none"');
  assert.equal(
    readLease('Active work: none\nActive work: #260 `abc` reviewing'),
    undefined,
    'a stale free line beside a held line: which is current is exactly what is unknown',
  );
  assert.equal(
    readLease('Active work: #260 `abc` reviewing\nActive work: #261 `def` building'),
    undefined,
    'two held lines is a half-finished write, not a state',
  );
  assert.equal(
    readLease('Active work: #260 `abc` marinating'),
    undefined,
    'an unknown state is an unreadable lease',
  );

  // ...and the legitimate shapes still read, including incidental whitespace.
  assert.equal(readLease('Active work: none   '), null);
  assert.deepEqual(readLease('Active work: #260 `abc` reviewing'), {
    pr: 260, claimId: null, head: 'abc', state: 'reviewing',
  });
});

// ---------------------------------------------------------------------------
// L4: ONE renderer for the whole body — the cursor cannot be dropped.
// ---------------------------------------------------------------------------

test('L4: rendering with a lease round-trips the cursor', () => {
  const cursor = { mergedAt: Date.parse('2026-07-31T07:28:15Z'), number: 259 };
  const body = renderRunnerState({
    cursor,
    lease: { pr: 261, claimId: null, head: 'deadbeef', state: 'reviewing' },
  });

  const readBack = readCursor(body, 0);
  assert.equal(readBack.number, 259, 'the cursor survives a lease write');
  assert.equal(readBack.mergedAt, cursor.mergedAt);
  assert.deepEqual(readLease(body), {
    pr: 261, claimId: null, head: 'deadbeef', state: 'reviewing',
  });
});

test('L4b: releasing the lease round-trips the cursor too', () => {
  const cursor = { mergedAt: Date.parse('2026-07-31T07:28:15Z'), number: 259 };
  const body = renderRunnerState({ cursor, lease: null });
  assert.equal(readCursor(body, 0).number, 259);
  assert.equal(readLease(body), null);
});

test('L4c: the module exposes no way to write the lease without the cursor', async () => {
  const module = await import('./autonomous-work-lease.mjs');
  const writers = Object.keys(module).filter((name) => name.startsWith('render'));
  assert.deepEqual(
    writers, ['renderRunnerState'],
    'one renderer, taking the whole state; a lease-only writer could drop the cursor',
  );
});

test('L4d: a replacement declaration is recorded on the lease', () => {
  const body = renderRunnerState({
    cursor: { mergedAt: Date.parse('2026-07-31T07:28:15Z'), number: 259 },
    lease: { pr: 262, claimId: null, head: 'cafe', state: 'building', replaces: 261 },
  });
  assert.equal(replacementSource(body), 261, 'the handover is visible where the runner looks');
  assert.equal(readLease(body).pr, 262);
});

test('L4e: a pending claim round-trips before its pull request exists', () => {
  // The window between "start this unit" and "the PR is open" is the one two
  // backlog drains both walked through. It has to be representable to be held.
  const body = renderRunnerState({
    cursor: { mergedAt: Date.parse('2026-07-31T07:28:15Z'), number: 259 },
    lease: { pr: null, claimId: 'merge-abc123', head: null, state: 'building' },
  });
  assert.deepEqual(readLease(body), {
    pr: null, claimId: 'merge-abc123', head: null, state: 'building',
  });
  assert.equal(readCursor(body, 0).number, 259, 'and still carries the cursor');
});

// ---------------------------------------------------------------------------
// L5: the cursor reader is unchanged in behaviour.
// ---------------------------------------------------------------------------

test('L5: a body with no cursor falls back rather than inventing one', () => {
  assert.deepEqual(readCursor('Active work: none', 1234), { mergedAt: 1234, number: 0 });
});

test('L5b: the lease states are a closed set', () => {
  assert.deepEqual(LEASE_STATES, ['building', 'reviewing', 'correcting']);
});

// ---------------------------------------------------------------------------
// C2: the lease HOLDER is the continued unit, not a stranger (finding 4).
//
// This replaces the original L6, which asserted the OPPOSITE — that a drift
// handoff posted to the lease holder's own PR reads BLOCKED. That probe passed
// because it passed the empty intent itself, and it pinned the defect as
// expected behaviour. It is recorded here rather than quietly deleted.
// ---------------------------------------------------------------------------

test('C2: a pending claim is fulfilled by the PR the runner then opened', () => {
  const result = assessLease({
    lease: { pr: null, claimId: 'merge-abc', head: null, state: 'building' },
    intent: { pr: 263 },
    openPullRequests: [claudePr(263)],
  });
  assert.equal(result.allowed, true, 'the claim closing is not a second unit starting');
  assert.equal(result.adopts, 263);
});

test('C2b: a pending claim still refuses an ANONYMOUS start', () => {
  const result = assessLease({
    lease: { pr: null, claimId: 'merge-abc', head: null, state: 'building' },
    intent: {},
    openPullRequests: [],
  });
  assert.equal(result.allowed, false, 'a start was already issued and not yet opened');
  assert.match(result.reason, /merge-abc/u);
});

test('C2c: the drift handoff names the PR it is posted to, so the holder is not blocked by itself', async () => {
  const openPullRequests = [claudePr(260)];
  const posted = [];
  const client = {
    openPullRequests: async () => openPullRequests,
    combinedStatus: async () => ({ statuses: [] }),
    runnerState: async () => ({
      cursor: { mergedAt: 0, number: 0 },
      lease: { pr: 260, claimId: null, head: 'sha-260', state: 'reviewing' },
    }),
    setRunnerState: async () => {},
    comments: async () => [],
    comment: async (target, body) => { posted.push({ target, body }); },
  };
  const context = await loadContinuationContext(client, 'o/r', 'main');
  context.defaultBranchNow = STATUS_DRIFTING;
  context.maintenanceQueue = ['dependabot-security-updates'];
  context.headStatuses = [{ number: 260, now: null }];

  // Precondition: assessed anonymously, this state IS blocked — so a probe that
  // never states an intent cannot tell the fix from the defect.
  assert.equal(context.leaseFor({}).allowed, false);
  assert.equal(context.leaseFor({ pr: 260 }).allowed, true, 'the holder continues its own unit');

  await handOffStatusDrift(client, 'o/r', 'main', context);
  assert.equal(posted.length, 1, 'precondition: this state does drift');
  assert.doesNotMatch(
    posted[0].body, /Work lease: BLOCKED/u,
    'shepherding the lease holder is not starting a second unit',
  );
  assert.match(posted[0].body, /shepherd the open PR/u);
});

test('C2d: shepherding a NON-holder while another unit holds the lease is reported', async () => {
  // The other half of naming the unit. Assessed as #263 — the PR the handoff is
  // posted to — a lease held by #260 is a genuine disagreement, and saying so is
  // what makes the intent parameter load-bearing rather than decorative.
  const openPullRequests = [claudePr(263)];
  const posted = [];
  const client = {
    openPullRequests: async () => openPullRequests,
    combinedStatus: async () => ({ statuses: [] }),
    runnerState: async () => ({
      cursor: { mergedAt: 0, number: 0 },
      lease: { pr: 260, claimId: null, head: 'sha-260', state: 'reviewing' },
    }),
    setRunnerState: async () => {},
    comments: async () => [],
    comment: async (target, body) => { posted.push({ target, body }); },
  };
  const context = await loadContinuationContext(client, 'o/r', 'main');
  context.defaultBranchNow = STATUS_DRIFTING;
  context.maintenanceQueue = ['dependabot-security-updates'];
  context.headStatuses = [{ number: 263, now: null }];

  await handOffStatusDrift(client, 'o/r', 'main', context);
  assert.equal(posted.length, 1);
  assert.match(posted[0].body, /shepherd the open PR/u, 'still shepherds — never stranded');
  assert.match(
    posted[0].body, /BLOCKED/u,
    'but the lease naming a different unit is surfaced, not silently resolved',
  );
  assert.match(posted[0].body, /#260 holds the work lease/u);
});

// ---------------------------------------------------------------------------
// C3: a blocked lease GATES the start instruction (finding 1).
// ---------------------------------------------------------------------------

test('C3: a blocked verdict removes the start instruction, not merely annotates it', () => {
  const shared = {
    statusNow: { phase: 4, task: 6, task_state: 'merged', open_pr: 'none', next_task: 'phase-5' },
    maintenanceQueue: ['dependabot-security-updates'],
    openPullRequests: [],
    headStatuses: [],
  };

  const permitted = buildPostMergeContinuation({
    ...shared,
    start: startInstruction({ verdict: allowed, claimId: 'merge-a' }),
  });
  assert.match(permitted, /Create the next same-repository/u, 'permitted still starts');

  const refused = buildPostMergeContinuation({
    ...shared,
    start: startInstruction({ verdict: blocked, claimId: 'merge-a' }),
  });
  assert.doesNotMatch(
    refused, /Create the next same-repository/u,
    'the post-merge path never received the lease at all before this',
  );
  assert.match(refused, /BLOCKED — do not start new work/u);
});

test('C3b: a builder with NO lease verdict fails closed', () => {
  const body = buildPostMergeContinuation({
    statusNow: { phase: 4, task: 6, task_state: 'merged', open_pr: 'none', next_task: 'phase-5' },
    maintenanceQueue: ['dependabot-security-updates'],
    openPullRequests: [],
    headStatuses: [],
  });
  assert.doesNotMatch(body, /Create the next same-repository/u);
  assert.match(body, /NOT ASSESSED — do not start new work/u);
});

test('C3c: the drift no-live-PR branch is gated too', () => {
  // Drift with NO live PR: STATUS still records an open_pr that is not open.
  // (`open_pr: none` with nothing open is consistent, not drift.)
  const shared = {
    statusNow: { phase: 4, task: 6, task_state: 'in_review', open_pr: '259' },
    maintenanceQueue: ['dependabot-security-updates'],
    openPullRequests: [],
    headStatuses: [],
  };
  const refused = buildDriftHandoff({
    ...shared,
    start: startInstruction({ verdict: blocked, claimId: 'drift-none' }),
  });
  assert.ok(refused, 'precondition: this state drifts');
  assert.doesNotMatch(
    refused, /start the next permitted work item|Create the next same-repository/u,
    'the blocked verdict used to sit BESIDE "start the next permitted work item"',
  );
  assert.match(refused, /BLOCKED — do not start new work/u);

  const permitted = buildDriftHandoff({
    ...shared,
    start: startInstruction({ verdict: allowed, claimId: 'drift-none' }),
  });
  assert.match(permitted, /Create the next same-repository/u);
});

test('C3d: the start wording exists in exactly ONE source file', async () => {
  // Structural, and stated as such. It is what makes "a start instruction that
  // did not come with an acquisition" unwritable rather than merely discouraged:
  // the words live beside the claim in `startInstruction`.
  const files = [
    'scripts/runner-continuation.mjs',
    'scripts/autonomous-handoff.mjs',
    'scripts/autonomous-work-lease.mjs',
  ];
  const carrying = [];
  for (const file of files) {
    const source = await readFile(new URL(`../${file}`, import.meta.url), 'utf8');
    if (source.includes('Create the next same-repository')) carrying.push(file);
  }
  assert.deepEqual(carrying, ['scripts/autonomous-work-lease.mjs']);
});

// ---------------------------------------------------------------------------
// C4 / C5: the lease is ACQUIRED before work is published, and RELEASED when
// the unit merges (findings 5 and 3).
// ---------------------------------------------------------------------------

function mergedPr(number, mergeSha) {
  return {
    number,
    merged: true,
    merge_commit_sha: mergeSha,
    head: { ref: `claude/unit-${number}`, sha: `head-${number}`, repo: { full_name: 'o/r' } },
    base: { ref: 'main', repo: { full_name: 'o/r' } },
    merged_at: '2026-07-31T10:00:00Z',
  };
}

function drainClient(initialLease) {
  const writes = [];
  const posted = [];
  let state = { cursor: { mergedAt: 0, number: 0 }, lease: initialLease };
  return {
    writes,
    posted,
    get state() { return state; },
    openPullRequests: async () => [],
    combinedStatus: async () => ({
      statuses: [{ context: 'codex-current-head', state: 'success' }],
    }),
    runnerState: async () => state,
    setRunnerState: async (next) => {
      state = { ...next, lease: next.lease ? { ...next.lease } : next.lease };
      writes.push(state);
    },
    comments: async () => [],
    comment: async (target, body) => { posted.push({ target, body, writes: writes.length }); },
    fileContent: async () => null,
  };
}

test('C4: two merged PRs drained in ONE run cannot both start a unit (finding 5)', async () => {
  const client = drainClient(null);
  const context = await loadContinuationContext(client, 'o/r', 'main');
  context.defaultBranchNow = {
    phase: 4, task: 6, task_state: 'merged', open_pr: 'none', next_task: 'phase-5',
  };
  context.maintenanceQueue = ['dependabot-security-updates'];

  await handOffMergedPullRequest(client, mergedPr(240, 'aaa111222333'), 'o/r', 'main', context);
  await handOffMergedPullRequest(client, mergedPr(241, 'bbb444555666'), 'o/r', 'main', context);

  assert.equal(client.posted.length, 2, 'both merges are still acknowledged');
  assert.match(
    client.posted[0].body, /Create the next same-repository/u,
    'the first drain starts the next unit',
  );
  assert.doesNotMatch(
    client.posted[1].body, /Create the next same-repository/u,
    'the second drain reads the claim the first one took — this is the whole finding',
  );
  assert.match(client.posted[1].body, /BLOCKED — do not start new work/u);

  // ...and the claim was durable BEFORE the words were published.
  assert.ok(client.posted[0].writes >= 1, 'acquire precedes publish');
  assert.equal(client.writes[0].lease.state, 'building');
  assert.equal(client.writes[0].lease.pr, null, 'claimed before the PR exists');
  assert.equal(client.writes[0].lease.claimId, 'merge-aaa111222333');
});

test('C5: draining the merge of the lease holder RELEASES it (finding 3)', () => {
  const held = { pr: 262, claimId: null, head: 'abc', state: 'reviewing' };
  assert.equal(releaseOnMerge(held, 262), true, 'a merged unit is finished');
  assert.equal(releaseOnMerge(held, 999), false, 'another PR merging says nothing about it');
  assert.equal(releaseOnMerge(null, 262), false);
  assert.equal(
    releaseOnMerge({ pr: null, claimId: 'merge-x', head: null, state: 'building' }, 262),
    false,
    'a pending claim is not released by an unrelated merge',
  );
});

test('C5b: the drain loop persists the release, so the next start is not blocked by finished work', async () => {
  const client = drainClient({ pr: 240, claimId: null, head: 'head-240', state: 'reviewing' });
  const context = await loadContinuationContext(client, 'o/r', 'main');
  context.defaultBranchNow = {
    phase: 4, task: 6, task_state: 'merged', open_pr: 'none', next_task: 'phase-5',
  };
  context.maintenanceQueue = ['dependabot-security-updates'];

  // The handoff for #240 is blocked — #240 holds the lease and an anonymous
  // start is a different unit. Releasing is what the MERGE means.
  assert.equal(context.leaseFor({}).allowed, false);

  const state = context.runnerState;
  state.cursor = { mergedAt: Date.parse('2026-07-31T10:00:00Z'), number: 240 };
  if (releaseOnMerge(state.lease, 240)) state.lease = null;
  await client.setRunnerState(state);

  assert.equal(client.state.lease, null, 'the completed unit no longer records as active');
  assert.equal(
    context.leaseFor({}).allowed, true,
    'and the next start is available rather than blocked by a merged PR',
  );
});
