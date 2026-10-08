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
 * The new-side lines each file of the PR adds or modifies, from the pull-request files API. A file whose
 * patch GitHub omits (binary, or too large) counts as changed throughout ('*').
 */
export function changedLinesFromFiles(files = []) {
  const changed = new Map();
  for (const file of files) {
    const path = file?.filename;
    if (typeof path !== 'string') continue;
    if (typeof file.patch !== 'string') {
      changed.set(path, '*');
      continue;
    }
    const lines = new Set();
    let next = 0;
    for (const row of file.patch.split('\n')) {
      const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/u.exec(row);
      if (hunk) {
        next = Number(hunk[1]);
        continue;
      }
      if (row.startsWith('+')) {
        lines.add(next);
        next += 1;
      } else if (row.startsWith('-') || row.startsWith('\\')) {
        // a removed line, or "\ No newline at end of file": no new-side line
      } else {
        next += 1;
      }
    }
    changed.set(path, lines);
  }
  return changed;
}

/** Is this finding anchored on a line the PR changed (any line of a multi-line anchor counts)? */
export function onChangedLine(comment, changedLines) {
  const lines = changedLines?.get(comment?.path);
  if (lines === undefined) return false;
  if (lines === '*') return true;
  const end = comment?.line ?? comment?.original_line;
  if (!Number.isInteger(end)) return false;
  const start = comment?.start_line ?? comment?.original_start_line ?? end;
  for (let line = Math.min(start, end); line <= Math.max(start, end); line += 1) {
    if (lines.has(line)) return true;
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
 * The cap for `expectedHead`: how many earlier rounds the PR has had, and whether this head is past the
 * cap. `files` are the pull-request files (for the changed lines a capped finding is judged against).
 */
export function reviewCapState({ expectedHead, reviews = [], comments = [], files = [] }) {
  const priorRounds = [...codexFindingHeads(comments, reviews)].filter((head) => head !== expectedHead).length;
  return {
    priorRounds,
    reached: priorRounds >= REVIEW_ROUND_CAP,
    changedLines: changedLinesFromFiles(files),
  };
}
