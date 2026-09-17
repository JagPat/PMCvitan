import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildDriftHandoff,
  buildPostMergeContinuation,
  detectStatusDrift,
  detectStatusDriftAcrossHeads,
  formatOpenPullRequestList,
  isAutonomousPullRequest,
  selectAutonomousOpenPullRequests,
} from './runner-continuation.mjs';

test('finding 4032740385: a maintenance head is not suggested as the open_pr task pointer', () => {
  // Even on an owner-family branch, a maintenance PR (editsStatus === false — its diff does not
  // PROPOSE STATUS) must not be selected as the task pointer. The task-bearing signal is editsStatus,
  // not the branch prefix or the mandatory owner marker.
  const maintenance = { number: 900, headRefName: 'claude/maintenance', isDraft: true };
  const task = { number: 850, headRefName: 'claude/feature', isDraft: true };

  // Only a maintenance PR open, STATUS.open_pr none: drift is still reported, but the pointer
  // suggestion is `none` — a maintenance head is never the task pointer.
  const onlyMaintenance = detectStatusDriftAcrossHeads({
    defaultBranchNow: { open_pr: 'none' },
    openPullRequests: [maintenance],
    headStatuses: [{ number: 900, now: { open_pr: 'none' }, editsStatus: false }],
  });
  assert.equal(onlyMaintenance.suggestedOpenPr, 'none', 'a lone maintenance PR is never suggested as open_pr');

  // A task PR and a higher-numbered maintenance PR: the suggestion is the TASK PR, not the maintenance.
  const withTask = detectStatusDriftAcrossHeads({
    defaultBranchNow: { open_pr: 'none' },
    openPullRequests: [task, maintenance],
    headStatuses: [
      { number: 850, now: { open_pr: 'none' }, editsStatus: true },
      { number: 900, now: { open_pr: 'none' }, editsStatus: false },
    ],
  });
  assert.equal(withTask.drift, true);
  assert.equal(withTask.suggestedOpenPr, '850', 'the maintenance PR is excluded from the pointer suggestion');
});

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

test('findings 3012 + 4032740385 — autonomous units are the owner-family branches, not every marked PR', () => {
  // An in-flight task unit is discriminated by its OWNER-FAMILY branch prefix (claude/, cursor/,
  // codex/), not by the correction-owner body marker. A codex/** unit is tracked (3012) without a
  // parallel claude/** runner, while an unrelated maintenance PR that merely carries the now-mandatory
  // marker on a non-owner-family branch is NOT pulled into the task pointer's population (4032740385).
  const codexUnit = pullRequest({
    number: 610,
    body: '<!-- correction-owner: codex -->',
    head: { ref: 'codex/ownership-recovery', repo: { full_name: repository } },
  });
  const cursorUnit = pullRequest({
    number: 611,
    body: '<!-- correction-owner: cursor -->',
    head: { ref: 'cursor/task', repo: { full_name: repository } },
  });
  // The regression: a maintenance PR carrying the mandatory claude marker on a chore/ branch.
  const markedMaintenancePr = pullRequest({
    number: 612,
    body: '<!-- correction-owner: claude -->\n\n## Bump deps',
    head: { ref: 'chore/bump-deps', repo: { full_name: repository } },
  });
  const selected = selectAutonomousOpenPullRequests(
    [codexUnit, cursorUnit, markedMaintenancePr],
    repository,
    'main',
  );
  assert.deepEqual(selected.map((pr) => pr.number), [610, 611],
    'the codex/** and cursor/** units are tracked; the marked chore/ maintenance PR is not');
  assert.equal(isAutonomousPullRequest(markedMaintenancePr, repository, 'main'), false,
    'the mandatory owner marker does not make a non-owner-family branch an autonomous task unit');
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


test('a partial-task handoff corrects its own stale PR without closing the parent task', async () => {
  const { detectStatusDriftAcrossHeads } = await import('./runner-continuation.mjs');
  const { assessRunnerState } = await import('./autonomous-status-state.mjs');
  const before = { phase: '6', task: '4', task_state: 'in_progress',
    work_item: 'phase-6-task-4d-unit-i-dark-migration', open_pr: '582',
    next_task: 'phase-6-task-4d', blocking_directive: 'none' };
  const after = { ...before, work_item: 'none', open_pr: 'none' };
  const handoff = pullRequest({ number: 590 });
  const verdict = detectStatusDriftAcrossHeads({ defaultBranchNow: before,
    openPullRequests: [handoff], headStatuses: [{ number: 590, now: after, editsStatus: true }] });
  assert.equal(verdict.correctedInFlight, true);
  assert.equal(assessRunnerState(after).nextStep, 'task:4');
  assert.equal(after.task_state, 'in_progress');

  // An unchanged maintenance head and an unrelated live task still need shepherding.
  assert.equal(detectStatusDriftAcrossHeads({ defaultBranchNow: after,
    openPullRequests: [handoff], headStatuses: [{ number: 590, now: after, editsStatus: true }] }).drift, true);
  assert.equal(detectStatusDriftAcrossHeads({ defaultBranchNow: before,
    openPullRequests: [handoff, pullRequest({ number: 591 })],
    headStatuses: [{ number: 590, now: after, editsStatus: true }] }).drift, true);
  assert.equal(detectStatusDriftAcrossHeads({ defaultBranchNow: before,
    openPullRequests: [handoff], headStatuses: [{ number: 590, now: after, editsStatus: false }] }).drift, true);
});


test('partial-task handoff classification does not admit malformed or active work', async () => {
  const { isHandoffShape } = await import('./runner-continuation.mjs');
  const now = { task: '4', task_state: 'in_progress', work_item: 'none',
    open_pr: 'none', next_task: 'phase-6-task-4d', blocking_directive: 'none' };
  assert.equal(isHandoffShape(now), true);
  for (const change of [{ task_state: 'IN_PROGRESS' }, { task: 'none' },
    { work_item: 'next-unit' }, { open_pr: '590' }, { blocking_directive: 'repair' },
    { next_task: 'none' }, { open_pr: 'NONE' }, { work_item: 'NONE' }]) {
    assert.equal(isHandoffShape({ ...now, ...change }), false, JSON.stringify(change));
  }
});
