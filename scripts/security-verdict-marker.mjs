// Codex 4438607048 (G2, #1280 round 1) — a durable per-head record of a security-findings verdict.
//
// Codex reports security findings only in its ONE review-state record, which it edits in place: once it reviews
// the next head, the earlier head's verdict is gone. Every count of finding-bearing heads (the review-round cap,
// convergence, the correction lease, the lifecycle) reads review comments and reviews, so a head that failed
// only on security findings was never counted. When the gate publishes that verdict it first writes this marker,
// and `codexFindingHeads` (the one shared predicate) counts every head a marker names.
//
// Tight by construction:
//  - only the workflow token writes it, and a reader trusts only that author (a forged copy counts nothing);
//  - one marker per head, written read-then-create and never edited (a duplicate from a race counts once);
//  - its body is exactly the rendered marker: the exact head SHA and the detail constant, nothing else is parsed.

import { CODEX_SECURITY_FINDINGS_DETAIL } from './review-policy.mjs';

/** The only author whose PR comments count as security-verdict markers: the workflow token (as the follow-up
 *  records' `FOLLOW_UP_RECORD_AUTHOR`; not imported, so this module stays a leaf the product checks can load). */
export const SECURITY_VERDICT_MARKER_AUTHOR = 'github-actions[bot]';

const FULL_SHA = /^[0-9a-f]{40}$/u;
const MARKER_HEAD = /^<!-- codex-security-verdict: head-([0-9a-f]{40}) -->\n/u;

/** The marker's whole body for `head`. */
export function securityVerdictMarker(head) {
  if (!FULL_SHA.test(String(head ?? ''))) throw new TypeError(`a security verdict is keyed by a full head SHA, got ${JSON.stringify(head)}`);
  return `<!-- codex-security-verdict: head-${head} -->\n${CODEX_SECURITY_FINDINGS_DETAIL}`;
}

/** The heads named by a workflow-authored marker whose body is exactly the rendered one. */
export function securityVerdictHeads(issueComments = []) {
  const heads = new Set();
  for (const comment of issueComments ?? []) {
    if (comment?.user?.login !== SECURITY_VERDICT_MARKER_AUTHOR) continue;
    const body = String(comment?.body ?? '');
    const head = MARKER_HEAD.exec(body)?.[1];
    if (head && body === securityVerdictMarker(head)) heads.add(head);
  }
  return [...heads];
}

/**
 * Write `head`'s marker unless one is already there. Throws on any failed read or write: the caller publishes
 * the verdict only after this returns, inside its retryable step.
 */
export async function recordSecurityVerdict(client, pullRequest, head) {
  const body = securityVerdictMarker(head);
  if (!Number.isInteger(pullRequest?.number)) throw new TypeError('a security verdict needs the pull request number');
  if (securityVerdictHeads(await client.issueComments(pullRequest.number)).includes(head)) return false;
  await client.createIssueComment(pullRequest.number, body);
  return true;
}
