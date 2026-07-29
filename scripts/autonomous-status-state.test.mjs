import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

import {
  assessRunnerState,
  loadStatusDocument,
  parseMaintenanceQueue,
  parseStatusNow,
} from './autonomous-status-state.mjs';

// The Now blocks exactly as they stood on the two PR #248 finding heads.
// These are committed literals, not git reads: CI checks out at fetch-depth 1,
// so historical objects are simply absent there and a git-only fixture would
// make the whole invariant untestable in the one place it matters most.
const FINDING_HEADS = [
  {
    sha: '8c8f42324583bd652ec07cf32dc98dc686e74ea4',
    label: 'finding 1 — no next step at all',
    now: {
      phase: '4',
      phase_plan: 'docs/superpowers/plans/2026-07-23-phase-4-labour-readiness.md',
      task: '6',
      task_state: 'merged',
      work_item: 'none',
      reviewed_merge: '67e7a00',
      open_pr: 'none',
      next_task: 'none',
      blocking_directive: 'none',
      updated: '2026-07-29',
    },
  },
  {
    sha: '1d1de471c9d4eeca24b0482e95f2273b441ce2a0',
    label: 'finding 2 — directive parks the loop',
    now: {
      phase: '4',
      phase_plan: 'docs/superpowers/plans/2026-07-23-phase-4-labour-readiness.md',
      task: '6',
      task_state: 'merged',
      work_item: 'none',
      reviewed_merge: '67e7a00',
      open_pr: 'none',
      next_task: 'phase-5-planning',
      blocking_directive: 'phase-5-planning-approval',
      updated: '2026-07-29',
    },
  },
];

// Returns null when the object is not in this clone (CI's shallow checkout).
function statusAt(sha) {
  try {
    const markdown = execFileSync('git', ['show', `${sha}:docs/STATUS.md`], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 32 * 1024 * 1024,
    });
    return { now: parseStatusNow(markdown), maintenanceQueue: parseMaintenanceQueue(markdown) };
  } catch {
    return null;
  }
}

test('parses the Now block into a flat state map', () => {
  const state = parseStatusNow([
    '# STATUS',
    '',
    '## Now',
    '',
    '```yaml',
    'phase: 4',
    'task: 6',
    'task_state: merged',
    '# a comment is not state',
    'next_task: phase-5-planning',
    '```',
    '',
    '## Later',
  ].join('\n'));
  assert.deepEqual(state, {
    phase: '4',
    task: '6',
    task_state: 'merged',
    next_task: 'phase-5-planning',
  });
  assert.equal(parseStatusNow('# STATUS\n\nno now block here\n'), null);
  assert.equal(parseStatusNow(undefined), null);
});

// FINDING 1 (head 8c8f423) — "Keep Phase 5 unblockable by automation".
// The merged terminal state recorded nothing to do next.
test('a merged state with no work, no PR and no next task is not actionable', () => {
  const verdict = assessRunnerState({
    phase: '4',
    task: '6',
    task_state: 'merged',
    work_item: 'none',
    open_pr: 'none',
    next_task: 'none',
    blocking_directive: 'none',
  });
  assert.equal(verdict.actionable, false);
  assert.equal(verdict.nextStep, null);
  assert.match(verdict.reason, /nothing it can start/u);
});

// The same shape WITH a maintenance queue is actionable — STATUS says the queue
// keeps the loop live between work items. 8c8f423 had no queue section at all,
// which is why it reproduces RED above and this does not contradict it.
test('the maintenance queue is the between-work fallback when it has items', () => {
  const verdict = assessRunnerState({
    phase: '4',
    task: '6',
    task_state: 'merged',
    work_item: 'none',
    open_pr: 'none',
    next_task: 'none',
    blocking_directive: 'none',
  }, ['dependabot-security-updates', 'e2e-flake-burndown']);
  assert.equal(verdict.actionable, true);
  assert.equal(verdict.nextStep, 'maintenance:dependabot-security-updates');
});

// FINDING 2 (head 1d1de47) — "Remove the owner-approval gate from Phase 5".
// A directive parked the loop from a state that never schedules one.
test('a directive recorded outside a directive-scheduling state is not work', () => {
  const verdict = assessRunnerState({
    phase: '4',
    task: '6',
    task_state: 'merged',
    work_item: 'none',
    open_pr: 'none',
    next_task: 'phase-5-planning',
    blocking_directive: 'phase-5-planning-approval',
  });
  assert.equal(verdict.actionable, false);
  assert.equal(verdict.nextStep, null);
  assert.match(verdict.reason, /only from correction_required or in_progress/u);
});

// The documented post-merge fix-forward path: STATUS's runner rules say a
// validated defect returns the parent task to in_progress AND names its
// directive. That state must schedule the correction, not stall the loop.
test('a post-merge defect on an in_progress task schedules its directive', () => {
  const verdict = assessRunnerState({
    phase: '4',
    task: '6',
    task_state: 'in_progress',
    work_item: 'none',
    open_pr: 'none',
    next_task: 'none',
    blocking_directive: 'phase-4-task-6-correction',
  });
  assert.equal(verdict.actionable, true);
  assert.equal(verdict.nextStep, 'directive:phase-4-task-6-correction');
});

test('both PR #248 finding heads are non-actionable states', () => {
  for (const { sha, label, now } of FINDING_HEADS) {
    // No maintenance queue existed at either head; the real documents are
    // cross-checked below when history is available.
    assert.equal(
      assessRunnerState(now, []).actionable,
      false,
      `${sha} (${label}) must reproduce as non-actionable`,
    );
  }
});

// When the clone has history (developer machines, any non-shallow checkout),
// prove the literals above ARE those commits' state. In a shallow CI checkout
// the objects are absent and there is nothing to compare — the assertions above
// still run, so the invariant is never silently unenforced.
test('the finding-head fixtures match the real commits when history is available', () => {
  let compared = 0;
  for (const { sha, now } of FINDING_HEADS) {
    const actual = statusAt(sha);
    if (!actual) continue;
    assert.deepEqual(actual.now, now, `fixture for ${sha} has drifted from the commit`);
    // Neither finding head carried a maintenance queue, so the RED verdicts
    // above are the real documents' verdicts, not an artefact of the fixture.
    assert.deepEqual(actual.maintenanceQueue, [], `${sha} unexpectedly has a queue`);
    assert.equal(assessRunnerState(actual.now, actual.maintenanceQueue).actionable, false);
    compared += 1;
  }
  assert.ok(
    compared === FINDING_HEADS.length || compared === 0,
    'a partially available history means one fixture went unverified',
  );
});

test('the correction state hands off to the recorded next task', () => {
  const verdict = assessRunnerState({
    phase: '4',
    task: '6',
    task_state: 'merged',
    work_item: 'none',
    open_pr: 'none',
    next_task: 'phase-5-planning',
    blocking_directive: 'none',
  });
  assert.equal(verdict.actionable, true);
  assert.equal(verdict.nextStep, 'next_task:phase-5-planning');
});

test('every work source resolves to exactly one next step, in precedence order', () => {
  const base = {
    phase: '4',
    task: '6',
    work_item: 'none',
    open_pr: 'none',
    next_task: 'phase-5-planning',
    blocking_directive: 'none',
  };

  // A validated defect outranks everything, including an open PR.
  assert.deepEqual(
    assessRunnerState({
      ...base,
      task_state: 'correction_required',
      blocking_directive: 'fix-the-thing',
      open_pr: '250',
    }).nextStep,
    'directive:fix-the-thing',
  );
  // correction_required with no directive names no work: fail closed.
  assert.equal(
    assessRunnerState({ ...base, task_state: 'correction_required' }).actionable,
    false,
  );
  // An open PR outranks the merged handoff.
  assert.equal(
    assessRunnerState({ ...base, task_state: 'merged', open_pr: '248' }).nextStep,
    'pr:248',
  );
  // A task still being built is its own work item.
  for (const taskState of ['not_started', 'in_progress', 'in_review', 'ready']) {
    assert.equal(
      assessRunnerState({ ...base, task_state: taskState }).nextStep,
      'task:6',
      `${taskState} must resolve to the task itself`,
    );
  }
  // The standing queue outranks starting the next phase.
  assert.equal(
    assessRunnerState({ ...base, task_state: 'merged', work_item: 'maintenance-queue' }).nextStep,
    'work_item:maintenance-queue',
  );
  // An unknown state is never silently actionable.
  assert.equal(
    assessRunnerState({ ...base, task_state: 'somewhere-new' }).actionable,
    false,
  );
  assert.equal(assessRunnerState(null).actionable, false);
});

// The regression surface: the live state file, on every CI run.
test('the committed docs/STATUS.md always leaves the runner a move', async () => {
  const { now, maintenanceQueue } = await loadStatusDocument();
  const verdict = assessRunnerState(now, maintenanceQueue);
  assert.equal(
    verdict.actionable,
    true,
    `docs/STATUS.md leaves the autonomous runner stalled: ${verdict.reason}`,
  );
  assert.ok(verdict.nextStep, 'an actionable state must name its next step');

  // The queue is the documented between-work source, so it must be readable and
  // non-empty — an emptied queue would silently remove the loop's fallback.
  assert.ok(
    maintenanceQueue.length > 0,
    'the Maintenance queue section must parse to at least one named item',
  );
});
