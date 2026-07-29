// The runner-state invariant for docs/STATUS.md.
//
// STATUS is the authoritative state the cloud runner reads to decide what to do
// next. Two PR #248 review findings were both instances of one defect: the file
// recorded a state from which the runner had no move it could make on its own.
// That is not a documentation slip — the runner stalls, and per AGENTS.md the
// loop must never wait on a person for progression.
//
// This module makes that condition executable. `assessRunnerState` is total:
// every Now block returns either the concrete next step or the reason there
// isn't one. `scripts/autonomous-status-state.test.mjs` asserts the live file
// always has one, so a future edit that empties the state fails CI.
import { readFile } from 'node:fs/promises';

// The state values that mean a task still has work attached to it.
const OPEN_TASK_STATES = new Set([
  'not_started',
  'correction_required',
  'in_progress',
  'in_review',
  'ready',
]);

const NONE = 'none';

function isNone(value) {
  return value === undefined || value === null || value === '' || value === NONE;
}

// The Now block is the first fenced yaml block under the `## Now` heading. It is
// a flat `key: value` map by construction, so this parses exactly that and
// nothing more — a nested or list value is a malformed Now block, not a state.
export function parseStatusNow(markdown) {
  const source = typeof markdown === 'string' ? markdown : '';
  const heading = source.indexOf('\n## Now');
  if (heading < 0) return null;
  const fenceStart = source.indexOf('```yaml', heading);
  if (fenceStart < 0) return null;
  const bodyStart = source.indexOf('\n', fenceStart);
  const fenceEnd = source.indexOf('\n```', bodyStart);
  if (bodyStart < 0 || fenceEnd < 0) return null;

  const state = {};
  for (const rawLine of source.slice(bodyStart + 1, fenceEnd).split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const separator = line.indexOf(':');
    if (separator < 0) continue;
    state[line.slice(0, separator).trim()] = line.slice(separator + 1).trim();
  }
  return state;
}

// First-match, and total: every input returns a decision with a reason.
//
// The order encodes the loop's own precedence — a validated defect outranks an
// open PR, which outranks a task still being built, which outranks the standing
// queue, which outranks starting the next phase.
export function assessRunnerState(state) {
  if (!state || typeof state !== 'object') {
    return {
      actionable: false,
      nextStep: null,
      reason: 'no parseable Now block; the runner has no state to act on',
    };
  }

  const taskState = state.task_state;

  // STATUS defines `blocking_directive` as the thing `correction_required`
  // launches. A directive recorded against any other task state parks the loop
  // behind something the state machine never scheduled — which is exactly how a
  // human-approval gate gets expressed. It is a contradiction, not a next step.
  if (!isNone(state.blocking_directive) && taskState !== 'correction_required') {
    return {
      actionable: false,
      nextStep: null,
      reason: `blocking_directive '${state.blocking_directive}' is set while task_state `
        + `is '${taskState}'; STATUS launches a directive only from correction_required, `
        + 'so this state blocks progression without scheduling any work',
    };
  }

  if (taskState === 'correction_required') {
    return isNone(state.blocking_directive)
      ? {
        actionable: false,
        nextStep: null,
        reason: 'task_state is correction_required but no blocking_directive names the correction',
      }
      : {
        actionable: true,
        nextStep: `directive:${state.blocking_directive}`,
        reason: 'a validated defect outranks every other work source',
      };
  }

  if (!isNone(state.open_pr)) {
    return {
      actionable: true,
      nextStep: `pr:${state.open_pr}`,
      reason: 'an open PR is the current work item until it merges or closes',
    };
  }

  if (OPEN_TASK_STATES.has(taskState)) {
    return {
      actionable: true,
      nextStep: `task:${state.task}`,
      reason: `task ${state.task} is ${taskState}, so it is still the work item`,
    };
  }

  if (taskState !== 'merged') {
    return {
      actionable: false,
      nextStep: null,
      reason: `unrecognized task_state '${taskState}'; the runner cannot resolve a next step`,
    };
  }

  if (!isNone(state.work_item)) {
    return {
      actionable: true,
      nextStep: `work_item:${state.work_item}`,
      reason: 'the merged task named a concrete follow-on work item',
    };
  }

  // The terminal case that produced both findings: the task merged, nothing is
  // open, nothing is queued. `next_task` is then the ONLY remaining source of a
  // move, so it must name one.
  if (!isNone(state.next_task)) {
    return {
      actionable: true,
      nextStep: `next_task:${state.next_task}`,
      reason: 'the merged task hands off to the recorded next task',
    };
  }

  return {
    actionable: false,
    nextStep: null,
    reason: 'task_state is merged with no work_item, no open_pr and no next_task; '
      + 'the runner has nothing it can start',
  };
}

export async function loadStatusState(path = new URL('../docs/STATUS.md', import.meta.url)) {
  return parseStatusNow(await readFile(path, 'utf8'));
}
