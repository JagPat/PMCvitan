// Owner decision 2026-10-08 (delivery speed) — the review-round cap.
//
// A PR gets at most REVIEW_ROUND_CAP Codex review rounds. A round is a distinct head Codex reviewed and
// found something on (`codexFindingHeads`). From the next round on, a current-head finding blocks only
// when it is a P0/P1 AND anchored on a line this PR changed; every other finding (P2/P3, outside the
// diff, or a review-level note with no anchor) is deferred to a follow-up issue and the PR merges on
// green CI. Before the cap is reached, every current-head finding blocks, as before.

import { REVIEW_ROUND_CAP } from './review-policy.mjs';
import { codexFindingHeads } from './review-efficiency.mjs';

const BADGE = /!\[P(\d) Badge\]|badge\/P(\d)-/u;

/** The P-level a Codex finding declares (0 = most severe), or null when it carries no badge. */
export function findingPriority(body) {
  const match = BADGE.exec(String(body ?? ''));
  if (!match) return null;
  return Number(match[1] ?? match[2]);
}

/**
 * The lines each file of the PR changes, per side, from the pull-request files API: `right` holds the
 * new-side lines it adds or modifies, `left` the old-side lines it deletes (Codex 4213960366 — a finding
 * GitHub anchors on the LEFT side of a deletion names an old-file line). A file whose patch GitHub omits
 * (binary, or too large) counts as changed throughout ('*') on both sides.
 */
export function changedLinesFromFiles(files = []) {
  const changed = new Map();
  for (const file of files) {
    const path = file?.filename;
    if (typeof path !== 'string') continue;
    if (typeof file.patch !== 'string') {
      changed.set(path, { right: '*', left: '*' });
      continue;
    }
    const right = new Set();
    const left = new Set();
    let nextNew = 0;
    let nextOld = 0;
    for (const row of file.patch.split('\n')) {
      const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/u.exec(row);
      if (hunk) {
        nextOld = Number(hunk[1]);
        nextNew = Number(hunk[2]);
        continue;
      }
      if (row.startsWith('+')) {
        right.add(nextNew);
        nextNew += 1;
      } else if (row.startsWith('-')) {
        left.add(nextOld);
        nextOld += 1;
      } else if (row.startsWith('\\')) {
        // "\ No newline at end of file": no line on either side
      } else {
        nextNew += 1;
        nextOld += 1;
      }
    }
    changed.set(path, { right, left });
  }
  return changed;
}

/** Is this finding anchored on a line the PR changed (any line of a multi-line anchor counts, on its side)? */
export function onChangedLine(comment, changedLines) {
  const sides = changedLines?.get(comment?.path);
  if (sides === undefined) return false;
  const end = comment?.line ?? comment?.original_line;
  if (!Number.isInteger(end)) return false;
  const start = comment?.start_line ?? comment?.original_start_line ?? end;
  const endSide = comment?.side === 'LEFT' ? 'left' : 'right';
  const startSide = comment?.start_side ? (comment.start_side === 'LEFT' ? 'left' : 'right') : endSide;
  const hit = (side, line) => sides[side] === '*' || sides[side].has(line);
  if (startSide !== endSide) return hit(startSide, start) || hit(endSide, end);
  for (let line = Math.min(start, end); line <= Math.max(start, end); line += 1) {
    if (hit(endSide, line)) return true;
  }
  return false;
}

/**
 * Does a capped finding still block? Only a P0/P1 — or an unbadged finding, read conservatively as a
 * P1 — on a changed line.
 */
export function blocksUnderCap(comment, changedLines) {
  const priority = findingPriority(comment?.body);
  return (priority === null || priority <= 1) && onChangedLine(comment, changedLines);
}

/**
 * The heads on which Codex opened findings. Codex 4214270298 — a REPLY (a comment answering an existing
 * thread, `in_reply_to_id` set) opens no finding, so it never makes its thread's head a review round;
 * only thread-opening comments and Codex's own reviews count.
 */
export function findingRoundHeads(comments = [], reviews = []) {
  return codexFindingHeads(comments.filter((comment) => comment?.in_reply_to_id == null), reviews);
}

/**
 * The cap for `expectedHead`: how many earlier rounds the PR has had, and whether this head is past the
 * cap. `files` are the pull-request files (for the changed lines a capped finding is judged against).
 */
export function reviewCapState({ expectedHead, reviews = [], comments = [], files = [] }) {
  const priorRounds = [...findingRoundHeads(comments, reviews)].filter((head) => head !== expectedHead).length;
  return {
    priorRounds,
    reached: priorRounds >= REVIEW_ROUND_CAP,
    changedLines: changedLinesFromFiles(files),
  };
}
