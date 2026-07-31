// The exclusive work lease.
//
// #252, #257, #260 and #261 were open at once. Nothing forbade it — the rule
// lived in prose. These probes pin the state that makes it enforceable.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  LEASE_STATES,
  STATE_ISSUE_NUMBER,
  assessLease,
  readCursor,
  readLease,
  renderRunnerState,
  replacementSource,
} from './autonomous-work-lease.mjs';

const claudePr = (number, ref = `claude/thing-${number}`) => ({
  number, head: { ref },
});

// ---------------------------------------------------------------------------
// L1: the lease blocks a SECOND unit and never the first.
// ---------------------------------------------------------------------------

test('L1: a held lease refuses a different unit', () => {
  const result = assessLease({
    lease: { pr: 260, head: 'abc', state: 'reviewing' },
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
    lease: { pr: 260, head: 'abc', state: 'reviewing' },
    intent: { pr: 260 },
    openPullRequests: [claudePr(260)],
  });
  assert.equal(result.allowed, true);
  assert.equal(result.held.pr, 260);
});

test('L1c: a declared replacement may take the lease', () => {
  const result = assessLease({
    lease: { pr: 260, head: 'abc', state: 'reviewing' },
    intent: { replaces: 260 },
    openPullRequests: [claudePr(260)],
  });
  assert.equal(result.allowed, true, 'the handover rule the lifecycle already uses');
  assert.equal(result.replaces, 260, 'and the superseded PR is named for closing');
});

test('L1d: a replacement declaration for a DIFFERENT pr does not free the lease', () => {
  const result = assessLease({
    lease: { pr: 260, head: 'abc', state: 'reviewing' },
    intent: { replaces: 257 },
    openPullRequests: [claudePr(260)],
  });
  assert.equal(result.allowed, false, 'superseding #257 says nothing about #260');
});

// ---------------------------------------------------------------------------
// L2: a free lease is only free when reality agrees.
// ---------------------------------------------------------------------------

test('L2: a free lease with open claude PRs is a DISAGREEMENT, not permission', () => {
  // The lease records what the runner claimed; GitHub records what is open. A
  // PR closed without releasing, or opened without acquiring, shows up here —
  // and silently resolving it either way is how the overlap started.
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
  const result = assessLease({ lease: null, intent: {}, openPullRequests: [] });
  assert.equal(result.allowed, true);
});

test('L2c: non-claude branches do not hold the lease', () => {
  // A human's branch is not the autonomous runner's work item.
  const result = assessLease({
    lease: null,
    intent: {},
    openPullRequests: [{ number: 99, head: { ref: 'dependabot/npm/x' } }],
  });
  assert.equal(result.allowed, true);
});

// ---------------------------------------------------------------------------
// L3: unparseable is not free — the same rule the review floor learned.
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

// ---------------------------------------------------------------------------
// L4: ONE renderer for the whole body — the cursor cannot be dropped.
//
// This is the lesson from the review-floor work applied by construction: the
// issue has two writers with different concerns, and "each writer preserves the
// other's block" is a bug waiting for the next writer. There is no way to
// render the lease alone, so there is no way to lose the cursor.
// ---------------------------------------------------------------------------

test('L4: rendering with a lease round-trips the cursor', () => {
  const cursor = { mergedAt: Date.parse('2026-07-31T07:28:15Z'), number: 259 };
  const body = renderRunnerState({
    cursor,
    lease: { pr: 261, head: 'deadbeef', state: 'reviewing' },
  });

  const readBack = readCursor(body, 0);
  assert.equal(readBack.number, 259, 'the cursor survives a lease write');
  assert.equal(readBack.mergedAt, cursor.mergedAt);
  assert.deepEqual(readLease(body), { pr: 261, head: 'deadbeef', state: 'reviewing' });
});

test('L4b: releasing the lease round-trips the cursor too', () => {
  const cursor = { mergedAt: Date.parse('2026-07-31T07:28:15Z'), number: 259 };
  const body = renderRunnerState({ cursor, lease: null });
  assert.equal(readCursor(body, 0).number, 259);
  assert.equal(readLease(body), null);
});

test('L4c: the module exposes no way to write the lease without the cursor', async () => {
  // Structural, and stated as such: it asserts the module's SHAPE, which is what
  // makes the failure mode inexpressible rather than merely avoided.
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
    lease: { pr: 262, head: 'cafe', state: 'building', replaces: 261 },
  });
  assert.equal(replacementSource(body), 261, 'the handover is visible where the runner looks');
  assert.equal(readLease(body).pr, 262);
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
// L6: the verdict reaches the runner. A model nothing consults governs nothing
// — the objection PR #259 drew, applied to this module before it can repeat.
// ---------------------------------------------------------------------------

test('L6: a blocked lease travels with the handoff instruction', async () => {
  const { buildDriftHandoff } = await import('./runner-continuation.mjs');
  const openPullRequests = [{ number: 260, head: { ref: 'claude/x', sha: 'a' }, draft: true }];
  const shared = {
    statusNow: { phase: 4, task: 6, task_state: 'in_review', open_pr: 'none' },
    maintenanceQueue: ['dependabot-security-updates'],
    openPullRequests,
    headStatuses: [{ number: 260, now: null }],
  };

  const blocked = assessLease({
    lease: { pr: 260, head: 'a', state: 'reviewing' },
    intent: {},
    openPullRequests,
  });
  assert.equal(blocked.allowed, false, 'precondition: the lease is held');

  const withLease = buildDriftHandoff({ ...shared, lease: blocked });
  assert.ok(withLease, 'precondition: this state does drift');
  assert.match(withLease, /\*\*Work lease: BLOCKED\.\*\*/u);
  assert.match(withLease, /#260 holds the work lease/u);

  // An available lease adds nothing — the instruction is not cluttered when
  // there is nothing to warn about.
  const free = buildDriftHandoff({
    ...shared,
    lease: assessLease({ lease: null, intent: {}, openPullRequests: [] }),
  });
  assert.doesNotMatch(free ?? '', /Work lease: BLOCKED/u);
});
