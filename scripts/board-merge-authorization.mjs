import { BOARD_AUTHORIZATION_MARKER } from './review-policy.mjs';

const AUTHORIZATION = new RegExp(
  `^<!-- ${BOARD_AUTHORIZATION_MARKER} -->\\nPR: #(\\d+)\\nHead: ([0-9a-f]{40})\\nBase: ([0-9a-f]{40})\\nDecision: (authorize|revoke)$`,
  'u',
);

/**
 * Board authority is configuration on the trusted default-branch controller,
 * never a PR label, body field, author association, or implementer assertion.
 */
export function assessBoardMergeAuthorization({
  comments = [],
  pullRequestNumber,
  expectedHead,
  expectedBase,
  trustedActors = [],
}) {
  const trusted = new Set(trustedActors.map((actor) => String(actor).toLowerCase()));
  const decisions = comments.flatMap((comment) => {
    const match = String(comment?.body ?? '').match(AUTHORIZATION);
    if (!match) return [];
    if (!trusted.has(String(comment?.user?.login ?? '').toLowerCase())) return [];
    if (!comment.created_at || comment.updated_at !== comment.created_at) return [];
    if (Number(match[1]) !== Number(pullRequestNumber)) return [];
    return [{
      id: comment.id,
      createdAt: Date.parse(comment.created_at),
      head: match[2],
      base: match[3],
      decision: match[4],
      actor: comment.user.login,
    }];
  }).filter((decision) => Number.isFinite(decision.createdAt))
    .sort((left, right) => left.createdAt - right.createdAt || Number(left.id) - Number(right.id));

  const matching = decisions.filter(
    (decision) => decision.head === expectedHead && decision.base === expectedBase,
  );
  const latest = matching.at(-1);
  if (!latest || latest.decision !== 'authorize') {
    return { allowed: false, state: latest?.decision === 'revoke' ? 'revoked' : 'missing' };
  }
  return { allowed: true, state: 'authorized', evidence: latest };
}

export function configuredBoardActors(environment = process.env) {
  return String(environment.BOARD_MERGE_AUTHORIZERS ?? '')
    .split(',')
    .map((actor) => actor.trim())
    .filter(Boolean);
}
