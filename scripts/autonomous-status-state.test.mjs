import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

import {
  assessPostMergeRunnerState,
  assessRunnerState,
  loadStatusDocument,
  parseMaintenanceQueue,
  parseStatusNow,
} from './autonomous-status-state.mjs';
import { assessCommittedStatus } from './review-scope.mjs';

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
  const { isHandoffShape } = await import('./runner-continuation.mjs');
  // Guard on the SHARED predicate, not a looser restatement of it. The first version tested
  // `work_item: none` plus a non-empty `next_task`, which is also true of a perfectly valid
  // in-progress state (`task_state: in_progress`, `open_pr: 304`) for a unit that does not use a
  // split work-item slug — so this live-file assertion would have failed CI on a correct STATUS
  // and blocked the loop until someone weakened the test or invented a work item. One predicate,
  // two call sites, no room to disagree.
  if (!isHandoffShape(now)) return;
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

// FINDING (#303 P1, round 2) — FIX THE SHEPHERD, NOT ONLY THE RESOLVER.
//
// Round 1 pinned `assessRunnerState` and left `buildDriftHandoff` untouched, so the regression
// went green while the path that PRODUCED the bad advice could repeat it. That is the wrong layer:
// the shepherd is what told the author to name the handoff PR as `open_pr`, and PR #303 took the
// advice. A probe that exercises the fixed layer instead of the causing layer proves nothing about
// the loop.
//
// Cause: a handoff head correctly records `open_pr: none` while its OWN PR is still open, which
// `detectStatusDrift` cannot help but read as drift — so the "correction already in flight"
// suppression never recognised it.
test('the drift shepherd stays quiet when a HANDOFF head already carries the fix', async () => {
  const { buildDriftHandoff } = await import('./runner-continuation.mjs');
  const staleDefaultBranch = {
    phase: '5', task: '7', task_state: 'in_progress',
    work_item: 'phase-5-task-7b-iii-a', open_pr: '302',
    next_task: 'phase-5-task-7b-iii-b', blocking_directive: 'none',
  };
  const handoffHead = {
    phase: '5', task: '7', task_state: 'merged', work_item: 'none',
    open_pr: 'none', next_task: 'phase-5-task-7b-iii-b', blocking_directive: 'none',
  };
  const body = buildDriftHandoff({
    statusNow: staleDefaultBranch,
    openPullRequests: [{ number: 303, headRefName: 'claude/phase5-status-7biii-a', isDraft: true }],
    headStatuses: [{ number: 303, now: handoffHead }],
  });
  assert.equal(
    body, null,
    'the shepherd advised changing `open_pr` while the handoff head already recorded the landing '
    + 'state — the advice that sends the post-merge runner back to a merged status PR',
  );
});

// …and the SYMMETRIC half, which the suppression must not swallow: a genuine work-item PR open
// while STATUS records `open_pr: none` is real drift and must still be reported. That is the
// defect that failed PR #302's first head, and a fix which silenced it too would trade one broken
// loop for another.
test('the drift shepherd still reports a WORK-ITEM PR open against open_pr: none', async () => {
  const { buildDriftHandoff } = await import('./runner-continuation.mjs');
  const workItemHead = {
    phase: '5', task: '7', task_state: 'in_progress',
    work_item: 'phase-5-task-7b-iii-b', open_pr: 'none',
    next_task: 'phase-5-task-7b-iii-c', blocking_directive: 'none',
  };
  const body = buildDriftHandoff({
    statusNow: { ...workItemHead, open_pr: '302' },
    openPullRequests: [{ number: 310, headRefName: 'claude/phase5-task7b-iii-b', isDraft: true }],
    headStatuses: [{ number: 310, now: workItemHead }],
  });
  assert.ok(body, 'a work-item PR whose head still records open_pr: none is real drift');
  assert.match(body, /open_pr/u);
});

// FINDING (#303 P2, round 3a) — the handoff suppression must not mask ANOTHER PR's real drift.
//
// Round 2's `isHandoffShape` branch suppressed drift whenever ANY open head had the handoff shape.
// With a handoff PR and a genuine work-item PR both open, the handoff was found first and the
// work-item PR's real `open_pr` drift went unreported — so the loop would run with STATUS not
// naming the PR it had to shepherd. My own symmetry probe passed because it had only ONE open PR:
// it tested the direction, not the interference.
test('a handoff head does not mask a CONCURRENT work-item PR drift', async () => {
  const { buildDriftHandoff } = await import('./runner-continuation.mjs');
  const body = buildDriftHandoff({
    statusNow: {
      phase: '5', task: '7', task_state: 'in_progress', work_item: 'phase-5-task-7b-iii-a',
      open_pr: '302', next_task: 'phase-5-task-7b-iii-b', blocking_directive: 'none',
    },
    openPullRequests: [
      { number: 303, headRefName: 'claude/phase5-status-7biii-a', isDraft: false },
      { number: 310, headRefName: 'claude/phase5-task7b-iii-b', isDraft: true },
    ],
    headStatuses: [
      // the handoff, correctly recording the landing state…
      { number: 303, now: { phase: '5', task_state: 'merged', work_item: 'none', open_pr: 'none', next_task: 'phase-5-task-7b-iii-b', blocking_directive: 'none' } },
      // …and a REAL work-item PR whose head still records open_pr: none, which IS drift
      { number: 310, now: { phase: '5', task_state: 'in_progress', work_item: 'phase-5-task-7b-iii-b', open_pr: 'none', next_task: 'phase-5-task-7b-iii-c', blocking_directive: 'none' } },
    ],
  });
  assert.ok(body, 'the handoff head silenced a concurrent work-item PR\'s genuine open_pr drift');
});

// FINDING (#303 P2, round 3b) — the live-file guard must be the SHARED predicate.
// `task_state: in_progress` with `work_item: none` and an open PR is a legitimate state for a unit
// that does not use a split work-item slug; the looser guard would have failed CI on it.
test('a valid in-progress state is not mistaken for a handoff', async () => {
  const { isHandoffShape } = await import('./runner-continuation.mjs');
  assert.equal(
    isHandoffShape({ task_state: 'in_progress', work_item: 'none', open_pr: '304', next_task: 'phase-5-task-9' }),
    false,
    'a work-item PR in progress would have tripped the handoff assertion and blocked the loop',
  );
  assert.equal(
    isHandoffShape({ task_state: 'merged', work_item: 'none', open_pr: 'none', next_task: 'phase-5-task-9' }),
    true,
  );
});

// FINDING (#334 P2, round 1) — the `none` SENTINEL is the absence of a next task, not a name.
// The owner-gated interregnum (merged, nothing scheduled, the maintenance queue as the work
// source) records `next_task: none`; the predicate read any non-empty string as "a next task
// named" and classified that state as a HANDOFF — so a live maintenance PR whose head carried
// it would have suppressed its own `open_pr: none` drift in detectStatusDriftAcrossHeads, and
// the hourly shepherd would have posted no correction for the PR actually open.
test('the none-sentinel interregnum is NOT a handoff shape, and does not suppress live-PR drift', async () => {
  const { isHandoffShape, buildDriftHandoff } = await import('./runner-continuation.mjs');
  const interregnum = { phase: '6', task: '2', task_state: 'merged', work_item: 'none', open_pr: 'none', next_task: 'none', blocking_directive: 'none' };
  assert.equal(
    isHandoffShape(interregnum),
    false,
    "next_task 'none' was read as a named next task — the interregnum masqueraded as a handoff",
  );
  // The F2 interference scenario: a maintenance PR is open, its head still CARRIES the
  // interregnum STATUS unchanged (editsStatus: false — its diff does not touch
  // docs/STATUS.md), and the default branch says open_pr: none — that IS drift, and the
  // shepherd must say so instead of treating the maintenance PR as a correction.
  const body = buildDriftHandoff({
    statusNow: interregnum,
    openPullRequests: [{ number: 340, headRefName: 'claude/maintenance-upkeep', isDraft: true }],
    headStatuses: [{ number: 340, now: interregnum, editsStatus: false }],
  });
  assert.ok(body, "a live maintenance PR's open_pr drift was suppressed by the none-sentinel handoff misclassification");
});

// FINDING (#334 P2, round 3) — the OTHER direction of the same sentinel. A STATUS-only flip
// that deliberately LANDS the interregnum is a correction in flight: once round 1 stopped
// calling the none-state a handoff, the flip's own head was no longer recognized, the
// shepherd would advise setting `open_pr` to the flip's own number, and the merged record
// would send the runner to a closed PR — the exact #303 trap. The distinguisher the Now
// block cannot carry is whether the PR's DIFF edits docs/STATUS.md: a flip PROPOSES the
// state (editsStatus: true → suppressed), a maintenance PR inherits it (false → reported,
// pinned above), and unknown fails toward suppression because the #303 trap is the
// unrecoverable side.
test('a none-flip that EDITS STATUS is recognized as the correction in flight', async () => {
  const { buildDriftHandoff } = await import('./runner-continuation.mjs');
  const interregnum = { phase: '6', task: '2', task_state: 'merged', work_item: 'none', open_pr: 'none', next_task: 'none', blocking_directive: 'none' };
  const flip = buildDriftHandoff({
    statusNow: { ...interregnum, task_state: 'in_review', open_pr: 'none' },
    openPullRequests: [{ number: 341, headRefName: 'claude/status-flip', isDraft: true }],
    headStatuses: [{ number: 341, now: interregnum, editsStatus: true }],
  });
  assert.equal(flip, null, "the flip PR proposing the none-state was not recognized as the correction in flight — the shepherd would advise the #303 stale-open_pr trap");
  const unknown = buildDriftHandoff({
    statusNow: { ...interregnum, task_state: 'in_review', open_pr: 'none' },
    openPullRequests: [{ number: 342, headRefName: 'claude/status-flip-2', isDraft: true }],
    headStatuses: [{ number: 342, now: interregnum }],
  });
  assert.equal(unknown, null, 'an UNKNOWN editsStatus must fail toward suppression (the recoverable mistake), not toward the #303 trap');
});

// FINDING (#334 P2, round 4) — the PROPOSES-vs-CARRIES test belongs to the CLASS, not to the
// shape that last bit us. With a NAMED handoff already merged on the default branch (merged /
// none / none / next_task: phase-6-task-4), every fresh maintenance PR's head CARRIES exactly
// the handoff shape — round 3 gated only the none-flip, so the carried named handoff still
// qualified as "the correction in flight", self-exclusion left no drift, and the shepherd
// never corrected `open_pr: none` for the live PR.
test('a maintenance PR carrying a NAMED handoff from main does not suppress its own drift', async () => {
  const { buildDriftHandoff } = await import('./runner-continuation.mjs');
  const namedHandoff = { phase: '6', task: '2', task_state: 'merged', work_item: 'none', open_pr: 'none', next_task: 'phase-6-task-4', blocking_directive: 'none' };
  const carried = buildDriftHandoff({
    statusNow: namedHandoff,
    openPullRequests: [{ number: 343, headRefName: 'claude/maintenance-upkeep-2', isDraft: true }],
    headStatuses: [{ number: 343, now: namedHandoff, editsStatus: false }],
  });
  assert.ok(carried, "a maintenance PR carrying main's named handoff was mistaken for the correction in flight — its open_pr drift went unreported");
  // …while a REAL handoff PR (its diff edits STATUS) still suppresses, as always.
  const proposing = buildDriftHandoff({
    statusNow: { ...namedHandoff, task_state: 'in_review' },
    openPullRequests: [{ number: 344, headRefName: 'claude/status-handoff', isDraft: true }],
    headStatuses: [{ number: 344, now: namedHandoff, editsStatus: true }],
  });
  assert.equal(proposing, null, 'a genuine handoff PR editing STATUS must still be recognized as the correction in flight');
});

// FINDING (#334 P2, round 5) — `editsStatus` is a FILE-level fact, and the file holds more
// than the Now block. A maintenance PR that edits only a HISTORICAL paragraph of
// docs/STATUS.md gets editsStatus: true while its Now block still equals the default
// branch's — it proposes NO transition, and calling it the correction in flight suppresses
// the very drift nudge the shepherd owes the live PR. Proposing takes BOTH halves: the file
// in the diff AND the landing fields differing from the default branch's.
test('a PR editing only a historical STATUS paragraph does not suppress its own drift', async () => {
  const { buildDriftHandoff } = await import('./runner-continuation.mjs');
  const namedHandoff = { phase: '6', task: '2', task_state: 'merged', work_item: 'none', open_pr: 'none', next_task: 'phase-6-task-4', blocking_directive: 'none' };
  const body = buildDriftHandoff({
    statusNow: namedHandoff, // the default branch ALREADY records this landing
    openPullRequests: [{ number: 345, headRefName: 'claude/docs-touchup', isDraft: true }],
    // the head edits STATUS (a narrative paragraph) but its Now block equals main's
    headStatuses: [{ number: 345, now: namedHandoff, editsStatus: true }],
  });
  assert.ok(body, "a historical-paragraph STATUS edit was mistaken for a landing proposal — the live PR's open_pr drift went unreported");
});

// FINDING (#334 P2, round 6) — round 5 enumerated the landing fields and promptly missed
// one: a correction that ONLY clears a stale `blocking_directive` from a terminal handoff
// differs in no enumerated field, so it was not recognized as the correction in flight and
// the shepherd would advise the #303 stale-open_pr trap. The comparison is now the WHOLE
// Now block minus the timestamp — the round-4 lesson (gate the class, not the instance)
// applied to fields.
test('a directive-only STATUS correction is recognized as the correction in flight', async () => {
  const { buildDriftHandoff } = await import('./runner-continuation.mjs');
  const stale = { phase: '6', task: '2', task_state: 'merged', work_item: 'none', open_pr: 'none', next_task: 'phase-6-task-4', blocking_directive: 'fix-something', updated: '2026-08-12' };
  const corrected = { ...stale, blocking_directive: 'none', updated: '2026-08-13' };
  const body = buildDriftHandoff({
    statusNow: stale,
    openPullRequests: [{ number: 346, headRefName: 'claude/status-directive-clear', isDraft: true }],
    headStatuses: [{ number: 346, now: corrected, editsStatus: true }],
  });
  assert.equal(body, null, 'the directive-only correction was not recognized — the shepherd would advise the #303 stale-open_pr trap');
  // …and `updated` alone must NEVER count as a proposal: a date-touch is not a transition.
  const dateOnly = buildDriftHandoff({
    statusNow: stale,
    openPullRequests: [{ number: 347, headRefName: 'claude/docs-touchup-2', isDraft: true }],
    headStatuses: [{ number: 347, now: { ...stale, updated: '2026-08-14' }, editsStatus: true }],
  });
  assert.ok(dateOnly, 'a timestamp-only difference was mistaken for a landing proposal');
});

// FINDING (#331 head 35d9532, P1) — STATUS named a `phase_plan` that existed only on a
// DIFFERENT unmerged branch. The runner's first act after parsing STATUS is opening that
// file (docs/AUTONOMOUS_LOOP.md), so a dangling reference is the documented stall mode:
// an in-progress task whose plan cannot be read. The rule this mechanizes — a merged
// state is COMPLETE; every reference it makes resolves within the tree that carries it —
// was learned twice on that PR's lineage (once as a promise of a follow-up PR, once as a
// file on a sibling branch), and a rule learned twice belongs in CI, not in prose.
//
// Unconditional over phase_plan: even for a merged task the named plan is history the
// loop may re-read, and no state is improved by pointing at a file that is not there.
//
// A REGULAR FILE inside the repository, not merely an existing path (Codex, #331
// round 4): `phase_plan: docs/superpowers/plans` names a directory that exists, and the
// runner's read of it stalls exactly like the missing-file case this pin was built for.
// The containment check closes the sibling hole — a path that resolves outside the repo
// is not this tree's plan no matter what it points at.
test("the live STATUS's phase_plan resolves to a regular file in this tree", async () => {
  const { statSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const path = await import('node:path');
  const { now } = await loadStatusDocument();
  const plan = String(now?.phase_plan ?? '').trim();
  // `none` is only a valid answer when there is no work whose plan the runner
  // must open (Codex, #331 round 5): an ACTIONABLE task with `phase_plan: none`
  // passes an existence-only guard and still stalls the loop at its documented
  // first read. And "terminal" alone is not that answer either (Codex, #331
  // round 6): `task_state: merged` is a terminal LABEL that still schedules
  // work — `assessRunnerState` consults `work_item`, then `next_task`, from
  // exactly that state — so a merged handoff naming a next task beside
  // `phase_plan: none` would be certified by a terminal-set exemption and
  // stall all the same. The exemption therefore asks the SHARED state machine
  // (the #303 rule: the live-file guard uses the shared predicate, never a
  // fork of it) whether this state schedules anything. The queue is passed
  // empty on purpose: maintenance slugs are STATUS-local upkeep between
  // phases, not phase-plan tasks, and the between-phases drain is precisely
  // the legitimate `phase_plan: none` state.
  const state = String(now?.task_state ?? '').trim().toLowerCase();
  const terminal = new Set(['merged', 'complete', 'completed', 'cleared']);
  if (!plan || plan === 'none') {
    const scheduled = assessRunnerState(now, []);
    assert.ok(
      terminal.has(state) && !scheduled.actionable,
      `docs/STATUS.md records task_state '${now?.task_state}' with phase_plan `
        + `'${now?.phase_plan}'`
        + (scheduled.actionable ? ` while still scheduling '${scheduled.nextStep}'` : '')
        + '. The runner opens phase_plan immediately after STATUS, so any state that '
        + 'schedules work must name a real plan file — none/empty is only valid once '
        + 'the work is terminal AND nothing (work_item, next_task, open_pr) is '
        + 'scheduled from it.',
    );
    return;
  }
  const repoRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
  const resolved = path.resolve(repoRoot, plan);
  assert.ok(
    resolved.startsWith(repoRoot + path.sep),
    `docs/STATUS.md names phase_plan '${plan}', which resolves OUTSIDE this repository. `
      + 'The runner reads phase_plan relative to the repo; a path that escapes it is not '
      + "this tree's plan regardless of what it points at.",
  );
  let isFile = false;
  try {
    isFile = statSync(resolved).isFile();
  } catch {
    isFile = false;
  }
  assert.ok(
    isFile,
    `docs/STATUS.md names phase_plan '${plan}', but no regular file exists there in this `
      + 'tree (missing, or a directory). The runner opens phase_plan immediately after '
      + 'STATUS, so an unopenable reference is a stall shipped as state. Land the plan in '
      + 'the same PR as the STATUS that names it — a merged state must be complete in its '
      + 'own tree.',
  );
});


// ---------------------------------------------------------------------------
// The folded STATUS must survive its own merge.
//
// These shapes are the ones the loop actually produced. The gap they close is
// real rather than theoretical: head f9a4125 carried a block that resolved back
// into the work item its own PR completed, and `handoff` reported success on it,
// because that job orchestrates rather than validating the committed shape.
// ---------------------------------------------------------------------------

const STATUS_DOC = (now, queue = []) => [
  '# Status', '', '## Now', '', '```yaml',
  ...Object.entries(now).map(([key, value]) => `${key}: ${value}`),
  '```', '',
  ...(queue.length > 0
    ? ['## Maintenance queue', '', ...queue.map((slug, index) => `${index + 1}. \`${slug}\``), '']
    : []),
].join('\n');

test('a folded STATUS that resolves past its own merge is allowed', () => {
  // The well-formed fold, and the one CLAUDE.md asks for: `open_pr` names this PR
  // while it is open, and the task behind it is what the runner picks up after.
  const now = {
    task_state: 'in_progress', task: '4', work_item: 'none',
    open_pr: '403', next_task: 'none', blocking_directive: 'none',
  };
  const verdict = assessPostMergeRunnerState(now, [], 403);
  assert.equal(verdict.allowed, true, verdict.detail ?? '');
  assert.equal(verdict.nextStep, 'task:4');
  assert.equal(verdict.simulated, true, 'the self-naming open_pr must be the thing simulated away');
});

test('a folded STATUS that strands the runner after its own merge is refused', () => {
  // `in_review` and `ready` are defined BY their open PR. Committed alongside an
  // `open_pr` naming this PR they read as coherent — and the moment the PR merges
  // the state defines itself by a pull request that no longer exists.
  for (const taskState of ['in_review', 'ready']) {
    const verdict = assessPostMergeRunnerState({
      task_state: taskState, task: '4', work_item: 'none',
      open_pr: '403', next_task: 'none', blocking_directive: 'none',
    }, [], 403);
    assert.equal(verdict.allowed, false, `${taskState} must not survive its own merge`);
    assert.match(verdict.detail, /no next step/u);
    assert.match(verdict.detail, /open_pr is none/u);
  }

  // The exhausted-handoff shape: merged, with nothing named and nothing queued.
  const empty = assessPostMergeRunnerState({
    task_state: 'merged', task: '4', work_item: 'none',
    open_pr: '403', next_task: 'none', blocking_directive: 'none',
  }, [], 403);
  assert.equal(empty.allowed, false);
  assert.match(empty.detail, /nothing it can start/u);

  // ...and the same block is fine the moment the queue gives it somewhere to go,
  // so the refusal is about the stall and not about `merged`.
  const queued = assessPostMergeRunnerState({
    task_state: 'merged', task: '4', work_item: 'none',
    open_pr: '403', next_task: 'none', blocking_directive: 'none',
  }, ['tidy-fixtures'], 403);
  assert.equal(queued.allowed, true, queued.detail ?? '');
  assert.equal(queued.nextStep, 'maintenance:tidy-fixtures');
});

test('another unit\'s open_pr is left exactly as committed', () => {
  // Merging THIS pull request does not close a different one, so its entry still
  // resolves. Clearing it would invent a state nobody committed — and would fail
  // a correct block whose author was pointing at genuinely open work.
  const now = {
    task_state: 'in_review', task: '4', work_item: 'none',
    open_pr: '363', next_task: 'none', blocking_directive: 'none',
  };
  const verdict = assessPostMergeRunnerState(now, [], 403);
  assert.equal(verdict.allowed, true, verdict.detail ?? '');
  assert.equal(verdict.nextStep, 'pr:363');
  assert.equal(verdict.simulated, false);
});

test('an unparseable committed Now block is a refusal, not a skip', () => {
  const verdict = assessPostMergeRunnerState(null, [], 403);
  assert.equal(verdict.allowed, false);
  assert.match(verdict.detail, /could not be parsed/u);
});

test('the committed-status check reads the PR tree, and only when the diff touches STATUS', async () => {
  const pullRequest = { number: 403 };
  const stranded = STATUS_DOC({
    task_state: 'in_review', task: '4', work_item: 'none',
    open_pr: '403', next_task: 'none', blocking_directive: 'none',
  });

  // Untouched STATUS: the check does not run at all, so every other unit pays nothing.
  assert.equal(
    await assessCommittedStatus(pullRequest, [{ filename: 'apps/api/src/thing.ts' }], async () => stranded),
    null,
  );

  // Touched and stranded: refused.
  const refused = await assessCommittedStatus(
    pullRequest, [{ filename: 'docs/STATUS.md' }], async () => stranded,
  );
  assert.equal(refused.allowed, false);
  assert.match(refused.detail, /no next step/u);

  // Touched and coherent: allowed.
  const allowed = await assessCommittedStatus(
    pullRequest,
    [{ filename: 'docs/STATUS.md' }],
    async () => STATUS_DOC({
      task_state: 'in_progress', task: '4', work_item: 'none',
      open_pr: '403', next_task: 'none', blocking_directive: 'none',
    }),
  );
  assert.equal(allowed.allowed, true, allowed.detail ?? '');
  assert.equal(allowed.nextStep, 'task:4');

  // Changed but unreadable is a REFUSAL. A skip here would let a PR edit STATUS
  // into a shape the check cannot read and pass precisely because it cannot.
  const unreadable = await assessCommittedStatus(
    pullRequest, [{ filename: 'docs/STATUS.md' }],
    async () => { throw new Error('ENOENT'); },
  );
  assert.equal(unreadable.allowed, false);
  assert.match(unreadable.detail, /could not be read/u);

  // A rename away from STATUS still counts as touching it.
  const renamed = await assessCommittedStatus(
    pullRequest,
    [{ filename: 'docs/STATE.md', previous_filename: 'docs/STATUS.md' }],
    async () => stranded,
  );
  assert.equal(renamed.allowed, false);
});

test('the live docs/STATUS.md survives the merge of the PR it names', async () => {
  // The invariant applied to the file itself, so a future fold that strands the
  // runner fails here as well as in the gate.
  const { now, maintenanceQueue } = await loadStatusDocument();
  const named = Number.parseInt(String(now.open_pr ?? ''), 10);
  const verdict = assessPostMergeRunnerState(
    now, maintenanceQueue, Number.isInteger(named) ? named : undefined,
  );
  assert.equal(verdict.allowed, true, verdict.detail ?? '');
});

// FINDING (#485 P1, round 1) — the THIRD landing shape. A status-only correction that records a
// post-merge defect lands `open_pr: none` WITH a scheduled `blocking_directive`, so its task is
// not terminal (not a handoff) and it does schedule work (not a none-flip). Neither predicate
// recognized it, so `detectStatusDriftAcrossHeads` treated the correction's own head as drift and
// `buildDriftHandoff` advised replacing `open_pr: none` with the correction PR's OWN number —
// planting the #303 stale-pointer trap in the merged record, by way of the very PR whose purpose
// is to remove a stale pointer. Reproduced against the live #485 shape before the fix.
test('a directive-scheduling status-only landing is recognized as the correction in flight', async () => {
  const { isDirectiveLandingShape, buildDriftHandoff } = await import('./runner-continuation.mjs');
  const stale = {
    phase: '6', task: '4', task_state: 'in_progress', work_item: 'none',
    reviewed_merge: 'fe9df58d', open_pr: '480', next_task: 'phase-6-task-4c', blocking_directive: 'none',
  };
  const landing = {
    ...stale, open_pr: 'none', blocking_directive: 'phase-6-4c-plan-independent-clearance',
  };
  assert.equal(isDirectiveLandingShape(landing), true);
  assert.equal(
    buildDriftHandoff({
      statusNow: stale,
      openPullRequests: [{ number: 485, headRefName: 'claude/github-app-install-1m0mir', isDraft: true }],
      headStatuses: [{ number: 485, now: landing, editsStatus: true }],
    }),
    null,
    'the shepherd advised pointing open_pr at the correction PR itself — the #303 trap',
  );
});

// The same class gates that the other two landings gate. A directive landing must not become a
// blanket excuse: it qualifies only when the head PROPOSES the transition, only from a state the
// runner actually schedules a directive from, and never while another PR's drift is real.
test('the directive landing does not over-suppress', async () => {
  const { isDirectiveLandingShape, buildDriftHandoff } = await import('./runner-continuation.mjs');
  const landing = {
    phase: '6', task: '4', task_state: 'in_progress', work_item: 'none',
    open_pr: 'none', next_task: 'phase-6-task-4c', blocking_directive: 'phase-6-4c-plan-independent-clearance',
  };

  // A PR that NAMES its own open PR is a work item, not a landing.
  assert.equal(isDirectiveLandingShape({ ...landing, open_pr: '486' }), false);
  // …but a RETAINED work item is still a landing: a directive outranks the work item, and
  // assessRunnerState resolves that exact shape to the directive (pinned above). Requiring
  // `work_item: none` here rejected a valid landing straight into the #303 trap (#485 round 2).
  assert.equal(isDirectiveLandingShape({ ...landing, work_item: 'phase-6-task-4c-i' }), true);
  // `merged` + a directive does not RESOLVE (assessRunnerState refuses a directive from a
  // non-scheduling state), so suppressing drift for it would hide an unactionable record.
  assert.equal(isDirectiveLandingShape({ ...landing, task_state: 'merged' }), false);
  // No directive at all is a plain in-progress record, not a directive landing.
  assert.equal(isDirectiveLandingShape({ ...landing, blocking_directive: 'none' }), false);
  // Case-exact, like the runner's own sentinel: `NONE` is refused, not read as "no directive".
  assert.equal(isDirectiveLandingShape({ ...landing, blocking_directive: 'NONE' }), true);

  // CARRIES rather than proposes: the head's Now block equals the default branch's, so a
  // maintenance PR inheriting a merged directive record is still reported as drift.
  assert.ok(
    buildDriftHandoff({
      statusNow: landing,
      openPullRequests: [{ number: 490, headRefName: 'claude/maintenance', isDraft: true }],
      headStatuses: [{ number: 490, now: landing, editsStatus: false }],
    }),
    'a maintenance PR merely carrying the directive record suppressed its own open_pr drift',
  );

  // …and it must not mask a CONCURRENT work-item PR's genuine drift (the #303 round-3a lesson).
  assert.ok(
    buildDriftHandoff({
      statusNow: { ...landing, open_pr: '480', blocking_directive: 'none' },
      openPullRequests: [
        { number: 485, headRefName: 'claude/github-app-install-1m0mir', isDraft: true },
        { number: 491, headRefName: 'claude/phase6-work-item', isDraft: true },
      ],
      headStatuses: [
        { number: 485, now: landing, editsStatus: true },
        { number: 491, now: { ...landing, work_item: 'phase-6-task-4c-i', open_pr: 'none', blocking_directive: 'none' }, editsStatus: true },
      ],
    }),
    'the directive landing silenced a concurrent work-item PR\'s genuine open_pr drift',
  );
});

// FINDING (#485 P1, round 2) — a directive landing that RETAINS its work item is still a landing.
// `assessRunnerState` accepts `in_progress` with BOTH a named work item and a named directive and
// resolves it to the directive (the exemption pinned in 'a directive outranks work_item without
// tripping the override guard'). Round 1's predicate required `work_item: none`, so a status-only
// correction for a defect belonging to a NAMED sub-unit was reported as drift and buildDriftHandoff
// instructed the owner to point `open_pr` at the correction PR itself — the #303 trap, reached from
// the one shape the resolver explicitly blesses.
test('a directive landing that retains a work item is recognized', async () => {
  const { isDirectiveLandingShape, buildDriftHandoff } = await import('./runner-continuation.mjs');
  const landing = {
    phase: '6', task: '4', task_state: 'in_progress', work_item: 'phase-6-task-4c-i',
    open_pr: 'none', next_task: 'phase-6-task-4c', blocking_directive: 'fix-forward-something',
  };
  const { assessRunnerState } = await import('./autonomous-status-state.mjs');
  assert.equal(
    assessRunnerState(landing, ['upkeep']).nextStep,
    'directive:fix-forward-something',
    'precondition: the resolver treats this shape as a directive landing',
  );
  assert.equal(isDirectiveLandingShape(landing), true);
  assert.equal(
    buildDriftHandoff({
      statusNow: { ...landing, open_pr: '480', blocking_directive: 'none' },
      openPullRequests: [{ number: 486, headRefName: 'claude/status-correction', isDraft: true }],
      headStatuses: [{ number: 486, now: landing, editsStatus: true }],
    }),
    null,
    'a directive landing with a retained work item was sent into the #303 trap',
  );
});

// FINDING (#486 P2, round 1) — the two readers must not spell the state vocabulary differently.
// `isDirectiveLandingShape` lowercased `task_state` while `assessRunnerState` compares it
// case-exactly, so a typo'd `IN_PROGRESS` was a VALID LANDING to the drift reader (shepherd
// suppressed, on the theory a correction was in flight) and UNACTIONABLE to the resolver (a
// directive from a non-scheduling state) — the loop left with no next step after merge AND no
// warning that anything was wrong. The predicate now tests the resolver's own exported
// DIRECTIVE_STATES against the raw field: one derivation, one spelling, refused loudly by both.
test('a malformed directive state is refused by BOTH readers, not just one', async () => {
  const { isDirectiveLandingShape, buildDriftHandoff } = await import('./runner-continuation.mjs');
  const { assessRunnerState, DIRECTIVE_STATES } = await import('./autonomous-status-state.mjs');
  const base = {
    phase: '6', task: '4', work_item: 'none', open_pr: 'none',
    next_task: 'phase-6-task-4c', blocking_directive: 'phase-6-4c-plan-independent-clearance',
  };

  for (const typo of ['IN_PROGRESS', 'In_Progress', 'CORRECTION_REQUIRED']) {
    const now = { ...base, task_state: typo };
    assert.equal(
      assessRunnerState(now, ['upkeep']).actionable,
      false,
      `precondition: the resolver refuses '${typo}'`,
    );
    assert.equal(
      isDirectiveLandingShape(now),
      false,
      `'${typo}' was a valid landing to the drift reader while the resolver called it unactionable`,
    );
    assert.ok(
      buildDriftHandoff({
        statusNow: { ...base, task_state: 'in_progress', open_pr: '480', blocking_directive: 'none' },
        openPullRequests: [{ number: 487, headRefName: 'claude/typo-head', isDraft: true }],
        headStatuses: [{ number: 487, now, editsStatus: true }],
      }),
      `a malformed head silenced the shepherd for '${typo}'`,
    );
  }

  // The well-formed states stay landings, and the vocabulary is the resolver's own object.
  for (const state of DIRECTIVE_STATES) {
    assert.equal(isDirectiveLandingShape({ ...base, task_state: state }), true);
    assert.equal(assessRunnerState({ ...base, task_state: state }, ['upkeep']).actionable, true);
  }
});
