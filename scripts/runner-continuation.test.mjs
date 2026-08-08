import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildDriftHandoff,
  buildPostMergeContinuation,
  detectStatusDrift,
  formatOpenPullRequestList,
  isHandoffOnlyHead,
  selectAutonomousOpenPullRequests,
  shouldShepherdOpenPullRequests,
  workItemPullRequests,
} from './runner-continuation.mjs';

const repository = 'JagPat/PMCvitan';

function pullRequest(overrides = {}) {
  return {
    state: 'open',
    number: 252,
    draft: true,
    head: { ref: 'claude/phase5-planning', repo: { full_name: repository } },
    base: { ref: 'main', repo: { full_name: repository } },
    ...overrides,
  };
}

test('selectAutonomousOpenPullRequests keeps only open same-repo claude branches', () => {
  const selected = selectAutonomousOpenPullRequests(
    [
      pullRequest(),
      pullRequest({ number: 100, head: { ref: 'feature/x', repo: { full_name: repository } } }),
      pullRequest({ number: 101, state: 'closed' }),
      pullRequest({ number: 102, head: { ref: 'claude/other', repo: { full_name: 'fork/repo' } } }),
    ],
    repository,
    'main',
  );
  assert.deepEqual(selected.map((pr) => pr.number), [252]);
});

test('detectStatusDrift flags open_pr none with live autonomous PRs', () => {
  const drift = detectStatusDrift(
    { open_pr: 'none', task_state: 'merged', next_task: 'phase-5-planning' },
    [pullRequest(), pullRequest({ number: 260, draft: false })],
  );
  assert.equal(drift.drift, true);
  assert.equal(drift.suggestedOpenPr, '260');
});

test('detectStatusDrift is quiet when open_pr matches reality', () => {
  assert.equal(
    detectStatusDrift({ open_pr: '252' }, [pullRequest()]).drift,
    false,
  );
  assert.equal(detectStatusDrift({ open_pr: 'none' }, []).drift, false);
});

test('buildPostMergeContinuation includes assessRunnerState and open PR list', () => {
  const message = buildPostMergeContinuation({
    statusNow: {
      phase: '4',
      task: '6',
      task_state: 'merged',
      work_item: 'none',
      open_pr: 'none',
      next_task: 'phase-5-planning',
      blocking_directive: 'none',
    },
    maintenanceQueue: ['dependabot-security-updates', 'e2e-flake-burndown'],
    openPullRequests: [pullRequest()],
  });

  assert.match(message, /Runner next step/u);
  assert.match(message, /`next_task:phase-5-planning`/u);
  assert.match(message, /#252 `claude\/phase5-planning` \(draft\)/u);
  assert.match(message, /STATUS drift/u);
  assert.match(message, /open_pr` to `252`/u);
});

test('buildDriftHandoff returns null when there is no drift', () => {
  assert.equal(
    buildDriftHandoff({
      statusNow: { open_pr: '252' },
      openPullRequests: [pullRequest()],
    }),
    null,
  );
});

test('buildDriftHandoff names the corrective action when drift exists', () => {
  const message = buildDriftHandoff({
    statusNow: {
      task_state: 'merged',
      open_pr: 'none',
      next_task: 'phase-5-planning',
      blocking_directive: 'none',
    },
    maintenanceQueue: ['e2e-flake-burndown'],
    openPullRequests: [pullRequest()],
  });

  assert.match(message, /detected drift/u);
  assert.match(message, /`next_task:phase-5-planning`/u);
  assert.match(message, /Do not open a competing branch/u);
});

test('detectStatusDrift flags stale non-none open_pr values', () => {
  const drift = detectStatusDrift(
    { open_pr: '251' },
    [pullRequest()],
  );
  assert.equal(drift.drift, true);
  assert.match(drift.reason, /251/);
  assert.equal(drift.suggestedOpenPr, '252');
});

test('detectStatusDrift is quiet when PR head STATUS already records the open PR', () => {
  assert.equal(
    detectStatusDrift({ open_pr: '252' }, [pullRequest()]).drift,
    false,
  );
});

test('buildPostMergeContinuation does not request a new branch when a PR is open', () => {
  const message = buildPostMergeContinuation({
    statusNow: {
      phase: '5',
      task_state: 'in_review',
      open_pr: '252',
      next_task: 'none',
      blocking_directive: 'none',
    },
    maintenanceQueue: [],
    openPullRequests: [pullRequest()],
  });

  assert.doesNotMatch(message, /Create the next same-repository/u);
  assert.match(message, /shepherd it to completion/u);
});

test('buildPostMergeContinuation advances after merge when open_pr is stale', () => {
  const message = buildPostMergeContinuation({
    statusNow: {
      phase: '5',
      task_state: 'merged',
      open_pr: '251',
      next_task: 'phase-5-planning',
      blocking_directive: 'none',
    },
    maintenanceQueue: [],
    openPullRequests: [],
  });

  assert.match(message, /Create the next same-repository/u);
  assert.doesNotMatch(message, /shepherd it to completion/u);
  assert.match(message, /clear stale `open_pr: 251`/u);
});

test('buildDriftHandoff handles stale open_pr with no live autonomous PR', () => {
  const message = buildDriftHandoff({
    statusNow: { open_pr: '251' },
    openPullRequests: [],
  });
  assert.match(message, /no live autonomous PR to shepherd/u);
  assert.match(message, /open_pr` to `none`/u);
});

// ── PR #296, Codex round 2 — A HANDOFF FLIP IS NOT A WORK ITEM ───────────────────────────────
//
// `open_pr` answers "which PR is this task's work item". This module read it as "is there a live
// autonomous PR", and the two come apart for exactly one shape: the STATUS-only handoff flip.
//
// Round 1 fixed `assessRunnerState` (open_pr is consulted before next_task) and Codex correctly
// pointed out that the fix never reached the path that actually runs after a merge:
// `buildPostMergeContinuation` DRIFT-CORRECTS `open_pr: none` back to the handoff PR, prints
// `Runner next step: pr:<that PR>`, labels the correct `next_task` as "STALE — do not act on it",
// and tells the runner to shepherd it. Once that PR merges the loop is parked on a finished PR.
//
// Reproduced before fixing: with the handoff Now block and one live PR, the continuation rendered
// `pr:296`. Every assertion below fails against the pre-fix module.

const handoffNow = {
  phase: '5',
  task: '7',
  task_state: 'merged',
  work_item: 'none',
  open_pr: 'none',
  next_task: 'phase-5-task-7b-i',
  blocking_directive: 'none',
};
const handoffPr = { number: 296, head: { ref: 'claude/phase5-task7-split' }, draft: true };

test('a handoff-only head is recognised, and nothing else is', () => {
  assert.equal(isHandoffOnlyHead({ number: 296, now: handoffNow }), true);
  // a real task PR names itself and is mid-flight — it IS the work item
  assert.equal(
    isHandoffOnlyHead({ number: 300, now: { task_state: 'in_progress', work_item: 'phase-5-task-7b-i', open_pr: '300' } }),
    false,
  );
  // a merged flip that still names a follow-on work item is not a bare handoff
  assert.equal(
    isHandoffOnlyHead({ number: 300, now: { task_state: 'merged', work_item: 'phase-5-task-7b-i', open_pr: 'none' } }),
    false,
  );
  // UNKNOWN counts as a work item: an unreadable head must not be able to silence the shepherd
  assert.equal(isHandoffOnlyHead({ number: 300, now: null }), false);
  assert.equal(isHandoffOnlyHead(undefined), false);
});

test('the work-item set drops handoff-only PRs and keeps every other open PR', () => {
  const taskPr = { number: 300, head: { ref: 'claude/phase5-task7b-i' }, draft: true };
  const numbers = workItemPullRequests({
    openPullRequests: [handoffPr, taskPr],
    headStatuses: [
      { number: 296, now: handoffNow },
      { number: 300, now: { task_state: 'in_progress', work_item: 'phase-5-task-7b-i', open_pr: '300' } },
    ],
  }).map((pullRequest) => pullRequest.number);
  assert.deepEqual(numbers, [300]);
});

test('the post-merge continuation advances to next_task instead of the handoff PR it just merged', () => {
  const message = buildPostMergeContinuation({
    statusNow: handoffNow,
    maintenanceQueue: ['lifecycle-rule-unit-2'],
    openPullRequests: [handoffPr],
    headStatuses: [{ number: 296, now: handoffNow }],
  });

  // the defect, stated as the thing that must NOT appear
  assert.doesNotMatch(message, /Runner next step:\*\*\s*`pr:296`/u);
  assert.doesNotMatch(message, /shepherd it to completion/u);
  assert.doesNotMatch(message, /STALE — do not act on it/u);
  assert.doesNotMatch(message, /STATUS drift/u);
  // …and the answer that must
  assert.match(message, /Runner next step:\*\*\s*`next_task:phase-5-task-7b-i`/u);
  assert.match(message, /Create the next same-repository/u);
  // the DISPLAYED list stays honest — the PR is open and the reader is told so
  assert.match(message, /#296/u);
});

test('the drift shepherd stays silent for a handoff flip, and still fires for a real task PR', () => {
  assert.equal(
    buildDriftHandoff({
      statusNow: handoffNow,
      openPullRequests: [handoffPr],
      headStatuses: [{ number: 296, now: handoffNow }],
    }),
    null,
    'a handoff flip recording open_pr: none is not drift — it is the correct record',
  );

  // NON-REGRESSION: a live task PR that STATUS has not caught up with is still drift, and is
  // still shepherded. The fix must not make the loop blind to a real open work item.
  const taskPr = { number: 300, head: { ref: 'claude/phase5-task7b-i' }, draft: true };
  const message = buildDriftHandoff({
    statusNow: { ...handoffNow, open_pr: 'none' },
    openPullRequests: [taskPr],
    headStatuses: [{ number: 300, now: null }],
  });
  assert.match(message, /open_pr` to `300`/u);
  assert.equal(
    shouldShepherdOpenPullRequests({ openPullRequests: [taskPr], headStatuses: [{ number: 300, now: null }] }),
    true,
  );
  assert.equal(
    shouldShepherdOpenPullRequests({ openPullRequests: [handoffPr], headStatuses: [{ number: 296, now: handoffNow }] }),
    false,
  );
});
