import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildDriftHandoff,
  buildPostMergeContinuation,
  detectStatusDrift,
  formatOpenPullRequestList,
  selectAutonomousOpenPullRequests,
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

test('formatOpenPullRequestList renders none for an empty list', () => {
  assert.equal(formatOpenPullRequestList([]), 'none');
});
