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

// The state values that mean a task still has work attached to it. Exported because the
// review gate's deferral-phase check needs the SAME vocabulary: a phase counts as having
// work ahead of it only in one of these states, and an unrecognized state is unverified
// rather than open (this module's own assessRunnerState already refuses to resolve one).
export const OPEN_TASK_STATES = new Set([
  'not_started',
  'correction_required',
  'in_progress',
  'in_review',
  'ready',
]);

// STATUS defines these two by their open PR: "PR open as a draft, waiting on a
// Codex review" and "PR marked ready for review". Without one they are broken.
const PR_BEARING_STATES = new Set(['in_review', 'ready']);

// The states STATUS schedules a `blocking_directive` from: `correction_required` ("launch the
// named blocking_directive") and `in_progress` (the post-merge fix-forward path). A directive
// recorded from any OTHER state parks the loop behind work the state machine never scheduled,
// which is the shape a human-approval gate takes.
//
// EXPORTED, and compared CASE-EXACTLY against the raw field, because a second reader exists:
// `isDirectiveLandingShape` in runner-continuation decides whether a head is a valid landing and
// suppresses the drift shepherd when it is. Round 1 of #486 found it lowercasing the field while
// this resolver did not, so a typo'd `IN_PROGRESS` was a valid landing to one reader and
// unactionable to the other — drift silently suppressed AND no next step after merge, the worst
// of both. One derivation, one spelling: a malformed state is refused by both, loudly.
export const DIRECTIVE_STATES = new Set(['correction_required', 'in_progress']);

const NONE = 'none';

// EXPORTED (#334 round 3): the sentinel predicate is an interface with several readers
// (assessRunnerState here, isHandoffShape in runner-continuation, the live-file pins),
// and each spelling its own variant is how `NONE` came to satisfy a guard's lowercased
// check while this exact-case runner treated it as a NAMED task. One derivation,
// every caller — deliberately case-exact: `NONE` is not the sentinel, it is a value
// the allowlist will refuse, loudly, which is the correct failure for a typo.
export function isNoneValue(value) {
  return value === undefined || value === null || value === '' || value === NONE;
}
const isNone = isNoneValue;

// The Maintenance queue section is STATUS's own answer to "what does the runner
// do between work items" — it says the queue keeps the loop live and never
// idles. So it is part of the state, not commentary, and the assessment reads
// it. Items are the numbered entries, each naming its slug in backticks.
export function parseMaintenanceQueue(markdown) {
  const source = typeof markdown === 'string' ? markdown : '';
  const heading = source.indexOf('\n## Maintenance queue');
  if (heading < 0) return [];
  const next = source.indexOf('\n## ', heading + 1);
  const section = source.slice(heading, next < 0 ? undefined : next);

  const items = [];
  for (const line of section.split('\n')) {
    const item = /^\s*\d+\.\s+`([^`]+)`/u.exec(line);
    if (item) items.push(item[1]);
  }
  return items;
}

// The Now block is the first fenced yaml block under the `## Now` heading. It is
// a flat `key: value` map by construction, so this parses exactly that and
// nothing more — a nested or list value is a malformed Now block, not a state.
export function parseStatusNow(markdown, heading$ = '\n## Now') {
  const source = typeof markdown === 'string' ? markdown : '';
  const heading = source.indexOf(heading$);
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
export function assessRunnerState(state, maintenanceQueue = []) {
  if (!state || typeof state !== 'object') {
    return {
      actionable: false,
      nextStep: null,
      reason: 'no parseable Now block; the runner has no state to act on',
    };
  }

  const taskState = state.task_state;
  const queue = Array.isArray(maintenanceQueue) ? maintenanceQueue : [];

  // STATUS schedules a directive from exactly two states: `correction_required`
  // ("launch the named blocking_directive"), and `in_progress` — the runner
  // rules say a post-merge defect returns the parent task to in_progress AND
  // names its directive, which is the documented fix-forward path. A directive
  // recorded from any OTHER state parks the loop behind work the state machine
  // never scheduled, which is the shape a human-approval gate takes.
  if (!isNone(state.blocking_directive) && !DIRECTIVE_STATES.has(taskState)) {
    return {
      actionable: false,
      nextStep: null,
      reason: `blocking_directive '${state.blocking_directive}' is set while task_state `
        + `is '${taskState}'; STATUS schedules a directive only from correction_required `
        + 'or in_progress, so this state blocks progression without scheduling any work',
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

  // A post-merge defect on an in_progress task: the directive is the focused
  // correction target and outranks the task itself.
  if (taskState === 'in_progress' && !isNone(state.blocking_directive)) {
    return {
      actionable: true,
      nextStep: `directive:${state.blocking_directive}`,
      reason: 'a named correction directive is the focused work item for this task',
    };
  }

  if (!isNone(state.open_pr)) {
    return {
      actionable: true,
      nextStep: `pr:${state.open_pr}`,
      reason: 'an open PR is the current work item until it merges or closes',
    };
  }

  // `in_review` and `ready` are defined by STATUS as PR-bearing: the work item
  // IS the open PR. With `open_pr: none` there is nothing to shepherd, and
  // returning the task instead would invite duplicate work on a task whose PR
  // the runner cannot see. The open_pr branch above already handled the
  // coherent case, so reaching here with one of these states is a broken record.
  if (PR_BEARING_STATES.has(taskState)) {
    return {
      actionable: false,
      nextStep: null,
      reason: `task_state is '${taskState}' but open_pr is none; STATUS defines that `
        + 'state by its open PR, so the runner has no PR to work',
    };
  }

  if (OPEN_TASK_STATES.has(taskState)) {
    // The work item IS the task, so its identifier has to be there. Without it
    // the runner would be handed `task:undefined` — a move it cannot make, and
    // exactly the "certified but unstartable" state this module exists to catch.
    if (isNone(state.task)) {
      return {
        actionable: false,
        nextStep: null,
        reason: `task_state is '${taskState}' but no task id is recorded, `
          + 'so there is nothing for the runner to start',
      };
    }
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

  if (!isNone(state.next_task)) {
    return {
      actionable: true,
      nextStep: `next_task:${state.next_task}`,
      reason: 'the merged task hands off to the recorded next task',
    };
  }

  // The between-work state. STATUS says the Maintenance queue keeps the loop
  // live and never idles, so a non-empty queue IS the next step — the runner
  // drains authorized upkeep rather than stalling.
  if (queue.length > 0) {
    return {
      actionable: true,
      nextStep: `maintenance:${queue[0]}`,
      reason: 'no task, PR or handoff is open, so the standing maintenance queue is the work',
    };
  }

  // Nothing anywhere, including an empty queue: this is the 8c8f423 state, and
  // it is the one configuration the runner genuinely cannot act on.
  return {
    actionable: false,
    nextStep: null,
    reason: 'task_state is merged with no work_item, no open_pr, no next_task and an '
      + 'empty maintenance queue; the runner has nothing it can start',
  };
}

/**
 * Does the STATUS a pull request COMMITS still give the runner a move once that
 * pull request has merged?
 *
 * The loop folds the STATUS update into the work PR, so the committed block is
 * written while the PR is still open — `open_pr` names it, as CLAUDE.md requires.
 * That value is correct for exactly as long as the PR is open, and stale the
 * instant it merges. Nothing failed a PR whose folded block was committed in the
 * shape it has WHILE OPEN rather than the shape it needs AFTER merge, so the
 * loop merged, re-read STATUS, and resolved to a pull request that no longer
 * existed. The `handoff` job does not catch it: it orchestrates rather than
 * validating the committed shape, and `buildPostMergeContinuation` runs only
 * after the merge and only into a comment, by which time the runner has already
 * re-entered the merged work item.
 *
 * So this simulates the merge before allowing it. The ONLY thing simulated is the
 * one fact merging changes for certain: this pull request stops being open. That
 * is deliberately narrow — a check that rewrote more of the block would be
 * asserting a post-merge state nobody committed.
 *
 * It does NOT fight the drift shepherd. The shepherd reads the live value and
 * wants `open_pr` to name the open PR; this reads the same value and asks what
 * happens after. Both are satisfied by the same correct block, which is the point.
 */
export function assessPostMergeRunnerState(state, maintenanceQueue = [], pullNumber) {
  if (!state || typeof state !== 'object') {
    return {
      allowed: false,
      detail: 'docs/STATUS.md is changed but its Now block could not be parsed, so the '
        + 'state the runner reads after this merge is unknown',
    };
  }

  // Merging closes this pull request, so its own `open_pr` entry stops resolving.
  // Any OTHER number is left exactly as committed: it names a different unit whose
  // openness this merge does not change, and overriding it would invent a state.
  //
  // Clearing it IS the whole simulation, and that is why there is no second rule
  // here checking whether the result still points at this PR: it cannot. An
  // earlier draft carried exactly that branch and it was unreachable — a guard
  // that never fires, which is the shape the operating-hazards note warns about.
  // The one question worth asking is whether anything is left to do.
  const namesThisPullRequest = Number.isInteger(pullNumber)
    && String(state.open_pr ?? '').trim() === String(pullNumber);
  const merged = namesThisPullRequest ? { ...state, open_pr: NONE } : state;

  const resolved = assessRunnerState(merged, maintenanceQueue);

  if (!resolved.actionable) {
    return {
      allowed: false,
      detail: 'after this PR merges, docs/STATUS.md leaves the runner with no next step: '
        + `${resolved.reason}`,
      simulated: namesThisPullRequest,
    };
  }

  return {
    allowed: true,
    detail: null,
    nextStep: resolved.nextStep,
    simulated: namesThisPullRequest,
  };
}

export async function loadStatusDocument(path = new URL('../docs/STATUS.md', import.meta.url)) {
  const markdown = await readFile(path, 'utf8');
  return { now: parseStatusNow(markdown), maintenanceQueue: parseMaintenanceQueue(markdown) };
}
