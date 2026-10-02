import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { assessRunnerState, parseMaintenanceQueue, parseStatusNow } from './autonomous-status-state.mjs';
import { buildPostMergeContinuation, detectStatusDrift, detectStatusDriftAcrossHeads } from './runner-continuation.mjs';

// #687, Codex finding 4164784153: with `task_state: correction_required` and the drain directive
// standing, `assessRunnerState` resolves to the directive before it reads `open_pr`, so the finding
// asked whether recording the open correction (#687) there lets the runner skip it while later rollout
// work proceeds. It cannot, and these pin why on the exact STATUS shape #687 commits:
//   1. the directive outranks every TASK and HANDOFF, so no later rollout work is reachable while it
//      stands (the step is the directive, never `next_task:` / `task:`);
//   2. the runner's instruction to shepherd an open PR is NOT derived from that step — the live
//      GitHub PR set is the one authority (`shouldShepherdOpenPullRequests`), so the continuation
//      tells the runner to shepherd #687 to completion and not to open new work;
//   3. recording `open_pr: 687` is what keeps that record honest — leaving it `none` beside the live
//      PR is reported as drift.

const OPEN_CORRECTION = {
  phase: '6', phase_plan: 'docs/superpowers/plans/2026-09-07-decision-workflow-4d.md', task: '4',
  task_state: 'correction_required', work_item: 'countersign-impact-inputs', reviewed_merge: 'e4ac5d8',
  open_pr: '687', next_task: 'phase-6-task-4d-iii', blocking_directive: 'phase-6-4d-previous-release-drained',
  updated: '2026-10-02',
};
const LIVE = [{ number: 687, draft: true, head: { ref: 'claude/countersign-impact-inputs' } }];

test('the directive outranks every task and handoff: no later rollout work is reachable while it stands', () => {
  const step = assessRunnerState(OPEN_CORRECTION);
  assert.equal(step.nextStep, 'directive:phase-6-4d-previous-release-drained');
  assert.doesNotMatch(step.nextStep, /^(task|next_task|work_item|maintenance):/u);
  // and after the correction merges (its own open_pr clears) it is still the directive, not 4d-iii
  assert.equal(assessRunnerState({ ...OPEN_CORRECTION, open_pr: 'none', work_item: 'none' }).nextStep, 'directive:phase-6-4d-previous-release-drained');
});

test('the open correction is shepherded whatever the step: the continuation names it and opens no new work', () => {
  const comment = buildPostMergeContinuation({ statusNow: OPEN_CORRECTION, openPullRequests: LIVE });
  assert.match(comment, /\*\*Runner next step:\*\* `directive:phase-6-4d-previous-release-drained`/u);
  assert.match(comment, /\*\*Open autonomous PRs:\*\* #687 `claude\/countersign-impact-inputs` \(draft\)/u);
  assert.match(comment, /An autonomous PR is already open — shepherd it to completion instead of opening a competing branch/u);
  assert.doesNotMatch(comment, /Create the next same-repository/u);
  assert.doesNotMatch(comment, /STATUS drift/u);
});

test('recording open_pr is what keeps the record honest: none beside the live correction is drift', () => {
  assert.deepEqual(detectStatusDrift(OPEN_CORRECTION, LIVE), { drift: false });
  const unrecorded = detectStatusDrift({ ...OPEN_CORRECTION, open_pr: 'none', work_item: 'none' }, LIVE);
  assert.equal(unrecorded.drift, true);
  assert.match(unrecorded.reason, /open_pr: none while autonomous PR\(s\) are still open/u);
  // main carries the directive landing (open_pr none) while #687 is open; #687's own head corrects it
  const main = { ...OPEN_CORRECTION, open_pr: 'none', work_item: 'none', updated: '2026-10-01' };
  const acrossHeads = detectStatusDriftAcrossHeads({
    defaultBranchNow: main, openPullRequests: LIVE, headStatuses: [{ number: 687, now: OPEN_CORRECTION, editsStatus: true }],
  });
  assert.equal(acrossHeads.drift, false);
  assert.equal(acrossHeads.correctedInFlight, true);
  assert.equal(acrossHeads.suggestedOpenPr, '687');
});

test('the live STATUS on this head is that exact shape', async () => {
  const markdown = await readFile(new URL('../docs/STATUS.md', import.meta.url), 'utf8');
  const now = parseStatusNow(markdown);
  // pinned while #687 is the open correction; once it merges, the fold records the landing
  if (now.open_pr === '687') {
    for (const key of ['task_state', 'work_item', 'open_pr', 'next_task', 'blocking_directive']) {
      assert.equal(now[key], OPEN_CORRECTION[key], key);
    }
    assert.equal(assessRunnerState(now, parseMaintenanceQueue(markdown)).nextStep, 'directive:phase-6-4d-previous-release-drained');
  }
});
