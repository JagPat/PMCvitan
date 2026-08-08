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
  // A task being built with no PR yet is its own work item.
  for (const taskState of ['not_started', 'in_progress']) {
    assert.equal(
      assessRunnerState({ ...base, task_state: taskState }).nextStep,
      'task:6',
      `${taskState} must resolve to the task itself`,
    );
  }
  // The PR-bearing states resolve to their PR, and fail closed without one
  // (covered in full by its own test above).
  for (const taskState of ['in_review', 'ready']) {
    assert.equal(
      assessRunnerState({ ...base, task_state: taskState, open_pr: '248' }).nextStep,
      'pr:248',
      `${taskState} must resolve to its open PR`,
    );
    assert.equal(assessRunnerState({ ...base, task_state: taskState }).actionable, false);
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

// FINDING (round 8) — `in_review`/`ready` are defined by their open PR, so
// recording one with `open_pr: none` leaves the runner nothing to shepherd.
test('a review-only state without an open PR is a broken record, not work', () => {
  for (const taskState of ['in_review', 'ready']) {
    const verdict = assessRunnerState({
      phase: '4',
      task: '6',
      task_state: taskState,
      work_item: 'none',
      open_pr: 'none',
      next_task: 'none',
      blocking_directive: 'none',
    });
    assert.equal(verdict.actionable, false, `${taskState} with no PR must fail closed`);
    assert.match(verdict.reason, /open_pr is none/u);
  }
  // …and with the PR present, the PR is the work item.
  assert.equal(
    assessRunnerState({
      phase: '4', task: '6', task_state: 'in_review',
      work_item: 'none', open_pr: '248', next_task: 'none', blocking_directive: 'none',
    }).nextStep,
    'pr:248',
  );
});

// FINDING (round 10) — an open task whose id is missing yields `task:undefined`,
// a move the runner cannot make. Certifying it would defeat this whole module.
test('an open task with no recorded id fails closed', () => {
  for (const taskState of ['not_started', 'in_progress']) {
    const verdict = assessRunnerState({
      phase: '4',
      task_state: taskState,
      work_item: 'none',
      open_pr: 'none',
      next_task: 'none',
      blocking_directive: 'none',
    });
    assert.equal(verdict.actionable, false, `${taskState} without a task id must fail closed`);
    assert.match(verdict.reason, /no task id is recorded/u);
  }
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

// `actionable` alone is too weak, and a review finding proved it: a Now block recording
// `task: 5 / task_state: not_started / work_item: phase-5-task-5b` is perfectly ACTIONABLE and
// resolves to `task:5` — the already-split PARENT — because an open task state returns the task id
// before `work_item` is ever consulted. The test above passed while the runner was being pointed at
// work that no longer exists as a unit.
//
// The first version of THIS test then made the mirror-image mistake, and review caught that too: it
// demanded `work_item:*` exactly, with a hand-written exemption for open PRs — and a directive
// recorded from `in_progress` legitimately outranks `work_item`, so the documented fix-forward path
// would have failed CI. An exemption LIST is the wrong shape; it is one member short the first time
// the module gains a precedence rule.
//
// So the assertion states the DEFECT instead. `directive:*` and `pr:*` are explicit higher-priority
// claims that a reader of STATUS can see. `task:*` is the one outcome that ignores a named
// `work_item` entirely and silently substitutes the parent — and it is the only one this can be
// wrong about, because when `work_item` is set those four are the module's whole range.
test('a named work_item is never silently overridden by a bare task step', async () => {
  const { now, maintenanceQueue } = await loadStatusDocument();
  const verdict = assessRunnerState(now, maintenanceQueue);
  const workItem = (now.work_item ?? '').trim().toLowerCase();
  if (!workItem || workItem === 'none') return;

  assert.ok(
    verdict.nextStep,
    `docs/STATUS.md names work_item '${now.work_item}' but resolves no next step at all: ${verdict.reason}`,
  );
  assert.ok(
    !verdict.nextStep.startsWith('task:'),
    `docs/STATUS.md names work_item '${now.work_item}' but the runner resolves `
    + `'${verdict.nextStep}' — a bare task step ignores the work item and sends the loop to the `
    + 'parent task. A merged increment must record task_state: merged so work_item is consulted.',
  );
});

// …and the exemption is PROVEN rather than assumed: a directive recorded from `in_progress` with a
// work item still in place must resolve to the directive, and must NOT trip the assertion above.
test('a directive outranks work_item without tripping the override guard', () => {
  const verdict = assessRunnerState({
    phase: '5',
    task: '5',
    task_state: 'in_progress',
    work_item: 'phase-5-task-5b',
    open_pr: 'none',
    blocking_directive: 'fix-forward-something',
    next_task: 'phase-5-task-6',
  });
  assert.equal(verdict.actionable, true);
  assert.equal(verdict.nextStep, 'directive:fix-forward-something');
  assert.ok(!verdict.nextStep.startsWith('task:'), 'a directive is not a bare task step');
});

// Codex, PR #290 (P1). `work_item` is consulted BEFORE `next_task` when a task is `merged`, so a
// STATUS flip that records the merge but leaves `work_item` naming the just-merged unit sends the
// runner straight back into completed work — silently, because every field is individually valid
// and the state machine is right to prefer a concrete follow-on when one is named.
//
// The live document is already checked by the pin above; this one states the RULE, so the next
// person writing a merge flip fails here rather than in review. The two directions are asserted
// together because the fix is only meaningful against the failure it prevents.
// THE ENFORCEMENT, against the LIVE document (Codex, PR #290 P1).
//
// The pin below states what the resolver DOES with a stale `work_item`, which is useful for
// explaining the rule and useless for enforcing it: a future merge flip with exactly that shape
// still passes, because the assertion expects the bad resolution rather than forbidding the bad
// state. And the `task:*` guard above cannot catch it either — a stale flip resolves to
// `work_item:*`, which that guard permits. CI would certify a STATUS file that sends the runner
// backwards, which is precisely the outcome the pin was written to prevent.
//
// A test that describes a defect is not a test that prevents one. This is the one that fails.
test('a MERGED task in the live STATUS must clear work_item — the completed unit is not the next step', async () => {
  const { now, maintenanceQueue } = await loadStatusDocument();
  const taskState = (now.task_state ?? '').trim().toLowerCase();
  if (taskState !== 'merged') return;

  const workItem = (now.work_item ?? '').trim().toLowerCase();
  assert.equal(
    workItem === '' || workItem === 'none',
    true,
    `docs/STATUS.md records task_state: merged while work_item still names '${now.work_item}'. `
    + '`assessRunnerState` consults work_item BEFORE next_task, so the runner would re-enter the '
    + 'unit that just merged instead of advancing. Clear work_item in the same flip that records '
    + 'the merge.',
  );

  // …and the consequence, asserted rather than inferred: with it cleared, the handoff is next_task.
  const verdict = assessRunnerState(now, maintenanceQueue);
  assert.ok(
    verdict.nextStep && !verdict.nextStep.startsWith('work_item:'),
    `docs/STATUS.md is merged but still resolves to '${verdict.nextStep}' — a merged flip must hand `
    + 'off to next_task, an open PR, a directive or the maintenance queue, never back to a work item.',
  );
});

// The SAME defect one field over, found by Codex on the very flip that fixed `work_item`.
//
// `assessRunnerState` returns `pr:<n>` BEFORE it reaches the `merged → work_item → next_task`
// chain. So a between-work handoff — the task merged, no follow-on work item, the next unit not
// yet started — that names its own STATUS-only PR resolves, the moment that PR merges, to the
// docs PR that just finished instead of to `next_task`. The runner shepherds a merged PR while
// the named next unit waits.
//
// `open_pr` belongs to a TASK PR, and the repository rule says so in the same breath: set it
// "and align `task_state` with whether the PR is still being built (`in_progress`) or waiting on
// Codex (`in_review`)". A merged handoff has neither state to align, which is the tell.
//
// This is the shape PR #294 shipped and PR #296 was about to reproduce, so it is closed here
// rather than in a comment nobody reads while writing the next flip. Both directions asserted:
// the bad state is forbidden AND the good state actually resolves to the handoff.
test('a MERGED between-work STATUS must clear open_pr — a merged PR is not the next step', async () => {
  const { now, maintenanceQueue } = await loadStatusDocument();
  const taskState = (now.task_state ?? '').trim().toLowerCase();
  const workItem = (now.work_item ?? '').trim().toLowerCase();
  // only the between-work shape: merged, with no follow-on work item naming an in-flight unit
  if (taskState !== 'merged') return;
  if (!(workItem === '' || workItem === 'none')) return;

  const openPr = (now.open_pr ?? '').trim().toLowerCase();
  assert.equal(
    openPr === '' || openPr === 'none',
    true,
    `docs/STATUS.md records task_state: merged with no work_item while open_pr still names `
    + `'${now.open_pr}'. \`assessRunnerState\` consults open_pr BEFORE next_task, so once that PR `
    + 'merges the runner is pointed at a finished PR instead of the next unit. A merged handoff '
    + 'carries open_pr: none; open_pr belongs to a task PR whose task_state it can be aligned with.',
  );

  const verdict = assessRunnerState(now, maintenanceQueue);
  assert.ok(
    verdict.actionable && verdict.nextStep && !verdict.nextStep.startsWith('pr:'),
    `docs/STATUS.md is a merged handoff but resolves to '${verdict.nextStep}' — it must hand off to `
    + 'next_task, a directive or the maintenance queue, never to a pull request.',
  );
});

// …and the resolver-level pin, so the guard above is not merely describing today's file.
test('a merged between-work flip that names its own PR resolves BACKWARDS to that PR', () => {
  const flip = (openPr) => assessRunnerState({
    phase: '5',
    task: '7',
    task_state: 'merged',
    work_item: 'none',
    open_pr: openPr,
    blocking_directive: 'none',
    next_task: 'phase-5-task-7b-i',
  });

  assert.equal(
    flip('296').nextStep,
    'pr:296',
    'a merged handoff that names its own STATUS PR resolves back to that PR — this is the defect, pinned so the fix means something',
  );
  assert.equal(
    flip('none').nextStep,
    'next_task:phase-5-task-7b-i',
    'with open_pr cleared the merged handoff advances to the named next unit',
  );
});

test('a merged task must CLEAR work_item, or the runner re-enters the unit it just finished', () => {
  const flip = (workItem) => assessRunnerState({
    phase: '5',
    task: '6',
    task_state: 'merged',
    work_item: workItem,
    open_pr: 'none',
    blocking_directive: 'none',
    next_task: 'phase-5-task-6b-ii',
  });

  assert.equal(
    flip('phase-5-task-6b-i').nextStep,
    'work_item:phase-5-task-6b-i',
    'a merged flip that leaves work_item set resolves BACK to that work item — this is the defect, pinned so the fix below means something',
  );
  assert.equal(
    flip('none').nextStep,
    'next_task:phase-5-task-6b-ii',
    'a merged flip with work_item cleared must hand off to next_task',
  );
});

// FINDING (#303 P1) — a STATUS-only HANDOFF PR must land in a state the runner can ADVANCE from.
//
// #303's diff was nothing but this document, recording 7B-iii-a merged and handing off to
// 7B-iii-b — and it named ITSELF as `open_pr` with `task_state: in_review`, on the drift
// shepherd's advice. `assessRunnerState` consumes any non-`none` `open_pr` before it reaches
// `next_task`, so after the merge the runner would have gone looking for the status PR it had
// just merged, and found nothing to shepherd.
//
// The decidable invariant underneath: `work_item: none` MEANS nothing is in progress, so the
// runner must hand off to `next_task` rather than resolve a PR step. A work-item PR names its
// work item, so this never fires on one.
test('with no work item in progress, STATUS hands off to next_task rather than a PR', async () => {
  const { now, maintenanceQueue } = await loadStatusDocument();
  const workItem = (now.work_item ?? '').trim().toLowerCase();
  if (!(workItem === '' || workItem === 'none')) return; // a named work item is in progress
  if (!(now.next_task ?? '').trim()) return;             // nothing to hand off to
  if ((now.blocking_directive ?? 'none').trim().toLowerCase() !== 'none') return; // a directive outranks

  const verdict = assessRunnerState(now, maintenanceQueue);
  assert.ok(verdict.nextStep, `docs/STATUS.md resolves no next step at all: ${verdict.reason}`);
  assert.ok(
    !verdict.nextStep.startsWith('pr:'),
    `docs/STATUS.md records no work_item but resolves '${verdict.nextStep}' — a handoff that names `
    + 'a PR sends the post-merge runner back to a PR instead of starting next_task. A STATUS-only '
    + 'handoff lands as merged/open_pr: none.',
  );
});
