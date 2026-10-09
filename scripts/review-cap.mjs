// Owner decision 2026-10-08 (delivery speed) — Codex review rounds.
//
// A round is a distinct head on which Codex opened findings. The completion report counts them
// (completion-report.mjs); the review-round cap (maintenance unit M2b) will read the same count.

import { CODEX_LOGIN, isCodexReplyOnlyReview } from './review-policy.mjs';
import { codexFindingHeads } from './review-efficiency.mjs';

/**
 * The heads on which Codex opened findings. Codex 4214270298 — a REPLY (a comment answering an existing
 * thread, `in_reply_to_id` set) opens no finding, so it never makes its thread's head a review round;
 * only thread-opening comments and Codex's own reviews count.
 */
export function findingRoundHeads(comments = [], reviews = []) {
  const heads = new Set(codexFindingHeads(comments.filter((comment) => comment?.in_reply_to_id == null), []));
  // Reviews are judged against the FULL comment set: the replies are exactly the evidence
  // `isCodexReplyOnlyReview` needs to recognise a blank reply-only review (Codex 4214359522); filtering them
  // out first would count that review as a round.
  for (const review of reviews ?? []) {
    if (review?.user?.login !== CODEX_LOGIN || isCodexReplyOnlyReview(review, comments)) continue;
    // Codex 4220861370 — a blank review container that opens no thread is no verdict, so it is no round
    const opensThread = comments.some((comment) => comment?.pull_request_review_id === review.id && comment?.in_reply_to_id == null);
    if (String(review?.body ?? '').trim().length === 0 && !opensThread) continue;
    if (typeof review.commit_id === 'string' && review.commit_id.length > 0) heads.add(review.commit_id);
  }
  return [...heads];
}
