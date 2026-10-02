import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { assessPostMergeRunnerState, assessRunnerState, parseMaintenanceQueue, parseStatusNow } from './autonomous-status-state.mjs';
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

// #687, Codex finding 4165112252: once #687 merges, the committed STATUS still records `open_pr: 687`.
// That is the designed handoff (#675 → #676, #684 → #685): the PR names itself while open, and the
// post-merge record (`reviewed_merge` = the merge commit, which cannot exist on this head) lands in a
// separate STATUS PR. These feed the UNMODIFIED committed STATUS — the file on this head, parsed as is,
// no field overridden — into the post-merge handoff, with nothing left open and with a parallel UX PR
// (#690) open, and pin that the stale pointer is reported for cleanup, the closed PR is never
// shepherded or advanced, and the drain directive stays the runner's step, so rollout is not unlocked.
const PARALLEL_UX = [{ number: 690, draft: true, head: { ref: 'claude/pmcvitan-mobile-places-n3fxup' } }];
const DIRECTIVE = 'directive:phase-6-4d-previous-release-drained';

async function committedStatus(t) {
  const markdown = await readFile(new URL('../docs/STATUS.md', import.meta.url), 'utf8');
  const now = parseStatusNow(markdown);
  // the scenario exists only while the committed block names #687; once the merge is recorded there
  // is no stale pointer left to test, and the case says so rather than passing vacuously
  if (now.open_pr !== '687') {
    t.skip(`docs/STATUS.md records open_pr: ${now.open_pr} — #687's merge is already recorded`);
    return null;
  }
  return { now, queue: parseMaintenanceQueue(markdown) };
}

for (const [name, live] of [['nothing left open', []], ['the parallel UX PR #690 open', PARALLEL_UX]]) {
  test(`after #687 merges with ${name}, the committed STATUS asks for cleanup and keeps the directive`, async (t) => {
    const status = await committedStatus(t);
    if (!status) return;
    const { now, queue } = status;

    // the merge-time simulation: only this PR's own pointer clears, and the step is the directive
    const simulated = assessPostMergeRunnerState(now, queue, 687);
    assert.equal(simulated.allowed, true);
    assert.equal(simulated.simulated, true);
    assert.equal(simulated.nextStep, DIRECTIVE);

    // the stale pointer is reported, and its correction never keeps #687
    const drift = detectStatusDrift(now, live);
    assert.equal(drift.drift, true);
    assert.match(drift.reason, /records open_pr: 687 but that PR is not among the live autonomous PRs/u);
    assert.notEqual(drift.suggestedOpenPr, '687');

    const comment = buildPostMergeContinuation({ statusNow: now, maintenanceQueue: queue, openPullRequests: live });
    assert.match(comment, /\*\*STATUS drift:\*\* docs\/STATUS\.md records open_pr: 687 but that PR is not among the live autonomous PRs\. Update `open_pr`/u);
    // the closed PR is never named as open, so nothing tells the runner to shepherd or advance it
    assert.doesNotMatch(comment, /#687/u);
    // the drain directive stays the step; `next_task` (4d-iii) is not reachable and no stale label appears
    assert.match(comment, new RegExp(`\\*\\*Runner next step:\\*\\* \`${DIRECTIVE}\``, 'u'));
    assert.doesNotMatch(comment, /Runner next step:\*\* `(task|next_task|maintenance):/u);
    assert.doesNotMatch(comment, /STALE — do not act on it/u);
    // whichever value the cleanup writes (none, or a live PR the drift suggests), the directive still outranks it
    for (const openPr of ['none', drift.suggestedOpenPr]) {
      assert.equal(assessRunnerState({ ...now, open_pr: openPr, work_item: 'none' }, queue).nextStep, DIRECTIVE, openPr);
    }

    if (live.length === 0) {
      assert.match(comment, /\*\*Open autonomous PRs:\*\* none/u);
      assert.match(comment, /\*\*Note:\*\* clear stale `open_pr: 687` in STATUS before starting new work\./u);
    } else {
      // a parallel PR is shepherded as itself; #687 is not among the open PRs
      assert.match(comment, /\*\*Open autonomous PRs:\*\* #690 `claude\/pmcvitan-mobile-places-n3fxup` \(draft\)/u);
      assert.match(comment, /An autonomous PR is already open — shepherd it to completion/u);
    }
  });
}
