// Convergence suite for PR #256. Every test here is RED at `baa919a` — the head
// that answered the five Codex findings with isolated patches — and GREEN after
// the batched architectural correction. See docs/reviews/pr-256-convergence.md.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildDriftHandoff,
  buildPostMergeContinuation,
  detectStatusDriftAcrossHeads,
  shouldShepherdOpenPullRequests,
} from './runner-continuation.mjs';
import { startInstruction } from './autonomous-work-lease.mjs';
import {
  handOffStatusDrift,
  loadContinuationContext,
} from './autonomous-handoff.mjs';

// A permitted start authorization. `buildPostMergeContinuation` now FAILS CLOSED
// without one — a handoff built with no lease verdict must not print the words
// that begin a unit — so any probe asserting the start text has to supply it.
const PERMITTED_START = startInstruction({
  verdict: { allowed: true, reason: 'test: lease free' },
  claimId: 'test-claim',
});

const repository = 'JagPat/PMCvitan';

function pullRequest(number, overrides = {}) {
  return {
    state: 'open',
    number,
    draft: true,
    head: {
      ref: `claude/work-${number}`,
      sha: `sha${number}`,
      repo: { full_name: repository },
    },
    base: { ref: 'main', repo: { full_name: repository } },
    ...overrides,
  };
}

// Mirrors the real docs/STATUS.md shape: a `## Now` heading followed by a fenced
// yaml block, which is what parseStatusNow actually reads.
function statusMarkdown({ openPr = 'none', taskState = 'merged', nextTask = 'phase-5-planning' }) {
  return [
    '# STATUS',
    '',
    '## Now',
    '',
    '```yaml',
    'phase: 4',
    'task: 6',
    `task_state: ${taskState}`,
    `open_pr: ${openPr}`,
    `next_task: ${nextTask}`,
    'blocking_directive: none',
    '```',
    '',
  ].join('\n');
}

function fakeClient({ openPrs = [], headStatusBySha = {}, comments = {} } = {}) {
  const posted = [];
  return {
    posted,
    async openPullRequests() {
      return openPrs;
    },
    // The lease is read as part of the continuation context. Deliberately NOT
    // optional-chained in the implementation: a client without this method must
    // fail loudly rather than silently skip the one-active-PR check.
    async runnerState() {
      return { cursor: { mergedAt: 0, number: 0 }, lease: null };
    },
    async fileContent(path, ref) {
      assert.equal(path, 'docs/STATUS.md');
      if (!(ref in headStatusBySha)) throw new Error(`no STATUS at ${ref}`);
      return headStatusBySha[ref];
    },
    async comments(number) {
      return comments[number] ?? [];
    },
    async comment(number, body) {
      posted.push({ number, body });
    },
  };
}

// ---------------------------------------------------------------------------
// Root cause A — one `now` served two authorities with different sources.
// ---------------------------------------------------------------------------

test('A1: drift is quiet when ANY open head carries the correction, not just the newest', () => {
  // #252 already records `open_pr: 252` in its own head; #257 (the highest number,
  // and the only head baa919a consulted) still carries main's `none`. The default
  // branch legitimately lags until #252 merges — that is not drift.
  const drift = detectStatusDriftAcrossHeads({
    defaultBranchNow: { open_pr: 'none', task_state: 'merged' },
    openPullRequests: [pullRequest(252), pullRequest(257)],
    headStatuses: [
      { number: 252, now: { open_pr: '252', task_state: 'in_review' } },
      { number: 257, now: { open_pr: 'none', task_state: 'merged' } },
    ],
  });
  assert.equal(drift.drift, false);
  assert.equal(drift.correctedInFlight, true);
  assert.equal(drift.correctingPullRequest, 252);
});

test('A1b: buildDriftHandoff posts nothing when a correction is in flight on a non-newest head', () => {
  const body = buildDriftHandoff({
    statusNow: { open_pr: 'none', task_state: 'merged', next_task: 'phase-5-planning' },
    openPullRequests: [pullRequest(252), pullRequest(257)],
    headStatuses: [
      { number: 252, now: { open_pr: '252', task_state: 'in_review' } },
      { number: 257, now: { open_pr: 'none', task_state: 'merged' } },
    ],
  });
  assert.equal(body, null);
});

test('A1c: drift still fires when NO open head records reality', () => {
  const body = buildDriftHandoff({
    statusNow: { open_pr: 'none', task_state: 'merged', next_task: 'phase-5-planning' },
    openPullRequests: [pullRequest(252), pullRequest(257)],
    headStatuses: [
      { number: 252, now: { open_pr: 'none', task_state: 'merged' } },
      { number: 257, now: null },
    ],
  });
  assert.ok(body, 'uncorrected drift must still be reported');
  assert.match(body, /open_pr: none while autonomous PR\(s\) are still open/);
});

test('A2: the post-merge next step comes from the default branch, never a foreign PR head', async () => {
  // baa919a substituted the newest open head's STATUS for main's and fed it to the
  // post-merge handoff, so an unrelated in-flight branch decided the next step.
  const client = fakeClient({
    openPrs: [pullRequest(257)],
    headStatusBySha: { sha257: statusMarkdown({ openPr: '999', taskState: 'in_review' }) },
  });
  const context = await loadContinuationContext(client, repository, 'main', {
    loadStatus: async () => ({
      now: {
        phase: '4',
        task_state: 'merged',
        open_pr: 'none',
        next_task: 'phase-5-planning',
        blocking_directive: 'none',
      },
      maintenanceQueue: [],
    }),
  });

  assert.equal(context.defaultBranchNow.open_pr, 'none');
  assert.equal(context.headStatuses.length, 1);
  assert.equal(context.headStatuses[0].now.open_pr, '999');

  const message = buildPostMergeContinuation({
    statusNow: context.defaultBranchNow,
    maintenanceQueue: context.maintenanceQueue,
    openPullRequests: context.openPullRequests,
    headStatuses: context.headStatuses,
  });
  assert.doesNotMatch(
    message,
    /Runner next step:\s*`pr:999`/,
    'the foreign head STATUS must not decide the post-merge next step',
  );
});

test('A2b: an unreadable head STATUS degrades to null and cannot suppress drift', async () => {
  const client = fakeClient({
    openPrs: [pullRequest(301)],
    headStatusBySha: {}, // fileContent throws
  });
  const context = await loadContinuationContext(client, repository, 'main', {
    loadStatus: async () => ({
      now: { task_state: 'merged', open_pr: 'none', next_task: 'phase-5-planning' },
      maintenanceQueue: [],
    }),
  });
  assert.deepEqual(context.headStatuses, [{ number: 301, now: null }]);
  assert.equal(context.defaultBranchNow.open_pr, 'none');
});

// ---------------------------------------------------------------------------
// Root cause B — the live PR set is the only authority on shepherd-vs-advance.
// ---------------------------------------------------------------------------

test('B1: shepherd whenever a live autonomous PR exists, whatever STATUS records', () => {
  assert.equal(shouldShepherdOpenPullRequests({ openPullRequests: [pullRequest(256)] }), true);
  assert.equal(shouldShepherdOpenPullRequests({ openPullRequests: [] }), false);
});

test('B1b: a live PR with drifted `open_pr: none` is never answered with a competing branch', () => {
  // This is Codex finding 2. baa919a made shepherding conditional on STATUS
  // agreeing, so exactly the drifted case re-emitted "create the next branch".
  const message = buildPostMergeContinuation({
    statusNow: { task_state: 'merged', open_pr: 'none', next_task: 'phase-5-planning' },
    openPullRequests: [pullRequest(256), pullRequest(257)],
  });
  assert.match(message, /An autonomous PR is already open — shepherd it/);
  assert.doesNotMatch(message, /Create the next same-repository/);
  assert.match(message, /STATUS drift/, 'the disagreement is still reported, as drift');
});

// ---------------------------------------------------------------------------
// Root cause D — the displayed next step must come from the drift-CORRECTED
// state. Codex finding on head ab7f4dc.
// ---------------------------------------------------------------------------

test('D1: a stale open_pr with no live PR does not publish the stale next step', () => {
  // assessRunnerState reads open_pr first, so STATUS naming a closed PR yielded
  // `pr:251` — published as the instruction while the same comment said the list
  // was `none` and to create the next branch. That sends the runner back to a PR
  // that no longer exists.
  const message = buildPostMergeContinuation({
    statusNow: { task_state: 'merged', open_pr: '251', next_task: 'phase-5-planning' },
    openPullRequests: [],
    start: PERMITTED_START,
  });
  assert.match(
    message,
    /\*\*Runner next step:\*\* `next_task:phase-5-planning`/,
    'the actionable step must come from the corrected state',
  );
  assert.doesNotMatch(
    message,
    /\*\*Runner next step:\*\* `pr:251`/,
    'the closed PR must never be the published instruction',
  );
  // The record is still visible, explicitly as stale.
  assert.match(message, /\*\*Recorded in STATUS \(STALE — do not act on it\):\*\* `pr:251`/);
  // And it agrees with the rest of the comment.
  assert.match(message, /Create the next same-repository/);
});

test('D1b: the corrected step names a live PR when the drift correction points at one', () => {
  const message = buildPostMergeContinuation({
    statusNow: { task_state: 'merged', open_pr: 'none', next_task: 'phase-5-planning' },
    openPullRequests: [pullRequest(256)],
  });
  assert.match(message, /\*\*Runner next step:\*\* `pr:256`/);
  assert.match(message, /An autonomous PR is already open — shepherd it/);
});

test('D1c: with no drift the assessment is untouched and nothing is labelled stale', () => {
  const message = buildPostMergeContinuation({
    statusNow: { task_state: 'merged', open_pr: 'none', next_task: 'phase-5-planning' },
    openPullRequests: [],
  });
  assert.match(message, /\*\*Runner next step:\*\* `next_task:phase-5-planning`/);
  assert.doesNotMatch(message, /STALE/);
  assert.doesNotMatch(message, /STATUS drift/);
});

test('D1d: correcting a broken record reports it honestly rather than inventing a step', () => {
  // `in_review` with open_pr none is a broken record: STATUS defines that state by
  // its open PR. The corrected assessment says so instead of naming phantom work.
  const message = buildPostMergeContinuation({
    statusNow: { task_state: 'in_review', open_pr: '251', next_task: 'phase-5-planning' },
    openPullRequests: [],
  });
  assert.match(message, /\*\*Runner next step:\*\* `none`/);
  assert.match(message, /open_pr is none; STATUS defines that state by its open PR/);
  assert.match(message, /\*\*Recorded in STATUS \(STALE — do not act on it\):\*\* `pr:251`/);
});

test('D2: the drift handoff also derives its step from the corrected state', () => {
  const body = buildDriftHandoff({
    statusNow: { task_state: 'merged', open_pr: '251', next_task: 'phase-5-planning' },
    openPullRequests: [],
    start: PERMITTED_START,
  });
  assert.match(body, /\*\*Next step after correcting STATUS:\*\* `next_task:phase-5-planning`/);
  assert.match(body, /\*\*Recorded in STATUS \(STALE — do not act on it\):\*\* `pr:251`/);
  assert.doesNotMatch(
    body,
    /\*\*Recorded next step:\*\* `pr:251`/,
    'the old unqualified label is gone',
  );
});

test('B1c: with no live PR, a stale open_pr still advances and is called out (finding 5)', () => {
  const message = buildPostMergeContinuation({
    statusNow: { task_state: 'merged', open_pr: '251', next_task: 'phase-5-planning' },
    openPullRequests: [],
    start: PERMITTED_START,
  });
  assert.match(message, /Create the next same-repository `claude\/\*\*` branch/);
  assert.doesNotMatch(message, /already open — shepherd it/);
  assert.match(message, /clear stale `open_pr: 251`/);
});

// ---------------------------------------------------------------------------
// Root cause C — the no-live-PR recovery was one-shot for the repo's lifetime.
// ---------------------------------------------------------------------------

test('C1: the status-only drift marker is keyed to the drifting state', async () => {
  const context = {
    defaultBranchNow: { task_state: 'merged', open_pr: '251', next_task: 'phase-5-planning' },
    maintenanceQueue: [],
    openPullRequests: [],
    headStatuses: [],
    leaseFor: () => ({ allowed: true, reason: 'test: lease free' }),
    acquire: async () => {},
  };
  const client = fakeClient({});
  await handOffStatusDrift(client, repository, 'main', context);
  assert.equal(client.posted.length, 1);
  assert.equal(client.posted[0].number, 235);
  assert.match(client.posted[0].body, /autonomous-status-drift:status-only:251 -->/);
});

test('C1b: a LATER drift with a different stale value is not swallowed', async () => {
  const alreadyPosted = {
    235: [
      {
        user: { login: 'github-actions[bot]' },
        body: '<!-- autonomous-status-drift:status-only:251 -->\nolder shepherd',
      },
    ],
  };
  // Same stale value → still deduplicated.
  const repeat = fakeClient({ comments: alreadyPosted });
  await handOffStatusDrift(repeat, repository, 'main', {
    defaultBranchNow: { task_state: 'merged', open_pr: '251', next_task: 'phase-5-planning' },
    maintenanceQueue: [],
    openPullRequests: [],
    headStatuses: [],
    // A literal context still has to answer "may the runner start?" — the
    // accessor is not optional-chained in production precisely so a context
    // that cannot answer fails loudly instead of silently skipping the check.
    leaseFor: () => ({ allowed: true, reason: 'test: lease free' }),
    acquire: async () => {},
  });
  assert.equal(repeat.posted.length, 0, 'the same drift state must post once');

  // Different stale value → a fresh shepherd. At baa919a the constant marker
  // matched and this recovery was silently dropped forever.
  const fresh = fakeClient({ comments: alreadyPosted });
  await handOffStatusDrift(fresh, repository, 'main', {
    defaultBranchNow: { task_state: 'merged', open_pr: '263', next_task: 'phase-5-planning' },
    maintenanceQueue: [],
    openPullRequests: [],
    headStatuses: [],
    // A literal context still has to answer "may the runner start?" — the
    // accessor is not optional-chained in production precisely so a context
    // that cannot answer fails loudly instead of silently skipping the check.
    leaseFor: () => ({ allowed: true, reason: 'test: lease free' }),
    acquire: async () => {},
  });
  assert.equal(fresh.posted.length, 1);
  assert.match(fresh.posted[0].body, /autonomous-status-drift:status-only:263 -->/);
});

test('C1c: drift with a live PR is posted on that PR, keyed to its head SHA (finding 4 path intact)', async () => {
  const client = fakeClient({});
  await handOffStatusDrift(client, repository, 'main', {
    defaultBranchNow: { task_state: 'merged', open_pr: 'none', next_task: 'phase-5-planning' },
    maintenanceQueue: [],
    openPullRequests: [pullRequest(256)],
    headStatuses: [{ number: 256, now: { open_pr: 'none' } }],
    // A literal context still has to answer "may the runner start?" — the
    // accessor is not optional-chained in production precisely so a context
    // that cannot answer fails loudly instead of silently skipping the check.
    leaseFor: () => ({ allowed: true, reason: 'test: lease free' }),
    acquire: async () => {},
  });
  assert.equal(client.posted.length, 1);
  assert.equal(client.posted[0].number, 256);
  assert.match(client.posted[0].body, /autonomous-status-drift:sha256 -->/);
});

// ---------------------------------------------------------------------------
// Root cause E — suppressing the drift SHEPHERD is not a claim that the record
// is right. Codex findings on head d9372c9.
// ---------------------------------------------------------------------------

test('E1: an in-flight correction still corrects the post-merge next step', () => {
  // main says `open_pr: none`; #256 is live and its own head already records
  // `open_pr: 256`, so the hourly shepherd is correctly suppressed. The record
  // being assessed is STILL main's stale one — keying the correction on
  // `drift.drift` rendered "shepherd the open PR" beside `next_task:…`.
  const message = buildPostMergeContinuation({
    statusNow: { task_state: 'merged', open_pr: 'none', next_task: 'phase-5-planning' },
    openPullRequests: [pullRequest(256)],
    headStatuses: [{ number: 256, now: { open_pr: '256', task_state: 'in_review' } }],
  });
  assert.match(message, /An autonomous PR is already open — shepherd it/);
  assert.match(
    message,
    /\*\*Runner next step:\*\* `pr:256`/,
    'the actionable step must agree with the shepherd instruction',
  );
  assert.doesNotMatch(
    message,
    /\*\*Runner next step:\*\* `next_task:phase-5-planning`/,
    'the stale record must not drive the next step just because drift is quiet',
  );
  // The shepherd stays suppressed — this fix must not reintroduce the noise.
  assert.doesNotMatch(message, /\*\*STATUS drift:\*\*/);
});

test('E1b: with no correction available the assessment is untouched', () => {
  const message = buildPostMergeContinuation({
    statusNow: { task_state: 'merged', open_pr: 'none', next_task: 'phase-5-planning' },
    openPullRequests: [],
  });
  assert.match(message, /\*\*Runner next step:\*\* `next_task:phase-5-planning`/);
  assert.doesNotMatch(message, /STALE/);
});

test('E2: the merged handoff reads STATUS at the merge commit, not the run checkout', async () => {
  const { statusAtCommit } = await import('./autonomous-handoff.mjs');
  const merged = [
    '# STATUS', '', '## Now', '', '```yaml',
    'task_state: merged', 'open_pr: none', 'next_task: phase-5-planning',
    '```', '',
  ].join('\n');
  const client = {
    async fileContent(path, ref) {
      assert.equal(path, 'docs/STATUS.md');
      if (ref !== 'mergesha') throw new Error(`unexpected ref ${ref}`);
      return merged;
    },
  };
  assert.deepEqual(
    await statusAtCommit(client, 'mergesha'),
    { task_state: 'merged', open_pr: 'none', next_task: 'phase-5-planning' },
  );
  // Unreadable or missing ref degrades to null so the caller falls back rather
  // than acting on an empty state.
  assert.equal(await statusAtCommit(client, 'nope'), null);
  assert.equal(await statusAtCommit(client, ''), null);
});

// ---------------------------------------------------------------------------
// Root cause F — the in-flight correction must come from the head that MADE it.
// Codex finding on head 0175c01.
// ---------------------------------------------------------------------------

test('F1: the suppressed correction names the correcting head\'s PR, not the newest', () => {
  // #252 and #257 both open; #252's head records `open_pr: 252`, #257 still says
  // `none`. The default drift suggestion is the highest live PR (257), so the
  // continuation rendered `pr:257` — with no drift warning, because the drift was
  // suppressed — and sent the runner to the wrong branch.
  const drift = detectStatusDriftAcrossHeads({
    defaultBranchNow: { open_pr: 'none', task_state: 'merged' },
    openPullRequests: [pullRequest(252), pullRequest(257)],
    headStatuses: [
      { number: 252, now: { open_pr: '252', task_state: 'in_review' } },
      { number: 257, now: { open_pr: 'none', task_state: 'merged' } },
    ],
  });
  assert.equal(drift.drift, false);
  assert.equal(drift.correctingPullRequest, 252);
  assert.equal(drift.suggestedOpenPr, '252', 'the correcting head decides the correction');

  const message = buildPostMergeContinuation({
    statusNow: { open_pr: 'none', task_state: 'merged', next_task: 'phase-5-planning' },
    openPullRequests: [pullRequest(252), pullRequest(257)],
    headStatuses: [
      { number: 252, now: { open_pr: '252', task_state: 'in_review' } },
      { number: 257, now: { open_pr: 'none', task_state: 'merged' } },
    ],
  });
  assert.match(message, /\*\*Runner next step:\*\* `pr:252`/);
  assert.doesNotMatch(message, /\*\*Runner next step:\*\* `pr:257`/);
  assert.doesNotMatch(message, /\*\*STATUS drift:\*\*/, 'the shepherd stays suppressed');
});

test('F1b: a correcting head recording `none` yields `none`, not a phantom PR', () => {
  const drift = detectStatusDriftAcrossHeads({
    defaultBranchNow: { open_pr: '251', task_state: 'merged' },
    openPullRequests: [],
    headStatuses: [{ number: 260, now: { open_pr: 'none', task_state: 'merged' } }],
  });
  assert.equal(drift.drift, false);
  assert.equal(drift.suggestedOpenPr, 'none');
});
