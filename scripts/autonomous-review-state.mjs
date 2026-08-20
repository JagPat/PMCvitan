export const CODEX_LOGIN = 'chatgpt-codex-connector[bot]';
export const CODEX_GRAPHQL_LOGIN = 'chatgpt-codex-connector';

function timestamp(value, field) {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new TypeError(`${field} must be an ISO-8601 timestamp`);
  }
  return parsed;
}

function isCodexActor(item) {
  return item?.user?.login === CODEX_LOGIN;
}

function isCodexThreadActor(login) {
  return login === CODEX_LOGIN || login === CODEX_GRAPHQL_LOGIN;
}

/**
 * The commit a review comment was POSTED against.
 *
 * GitHub keeps two SHAs on a review comment. `original_commit_id` is the head Codex actually
 * reviewed and never changes. `commit_id` is the newest commit the comment still applies to, and
 * GitHub ADVANCES it every time the branch moves, for every comment whose anchor still resolves.
 *
 * Reading `commit_id` therefore makes yesterday's findings look like a review of today's head: a
 * corrective push inherits every still-anchorable comment from the previous round, the gate fails
 * again, the pull request returns to draft, and the loop can never clear — no review of the new
 * head has happened or is even required for that to occur. Binding to `original_commit_id` asks the
 * question that actually matters: did Codex review THIS head and find something?
 *
 * `commit_id` is the fallback only for a payload that omits the original (older API shapes and
 * hand-written fixtures), so a comment is never silently ignored.
 */
function postedAgainst(comment) {
  return comment?.original_commit_id ?? comment?.commit_id;
}

function findingIdentity(comment) {
  return [comment?.path, comment?.line ?? comment?.original_line, comment?.body]
    .map((value) => String(value ?? ''))
    .join('\0');
}

export function isEligiblePullRequest(pullRequest) {
  const state = String(pullRequest?.state ?? '').toUpperCase();
  const headRepository = pullRequest?.headRepository?.nameWithOwner;
  const baseRepository = pullRequest?.baseRepository?.nameWithOwner;

  // Eligibility answers "is this unit ours to process at all", and its refusals are
  // SILENT — a closed or forked pull request is skipped with nothing written.
  //
  // A base is policy, not ownership, so it is deliberately NOT checked here — but the
  // reason is the SILENCE, not the timing. An off-`main` unit does have to be stopped
  // before its review lifecycle begins, because two finding-bearing heads would create
  // a repository-wide replacement obligation from work that was never eligible to
  // land. Routing that through this predicate would skip it with any status already on
  // its head left standing, including a terminal success written while it still
  // targeted `main`. So the entry refusal lives in `run()`, where it can PERSIST the
  // refusal and settle any obligation already earned first; see
  // `refuseOffLineageBaseAtEntry`. The merge boundary guards it again, because a base
  // can change after admission.
  return (
    state === 'OPEN' &&
    typeof headRepository === 'string' &&
    headRepository === baseRepository
  );
}

export function codexThreadIdsToResolve(threads = [], expectedHead) {
  return threads
    .filter((thread) => {
      const firstComment = thread?.comments?.nodes?.[0];
      return (
        !thread?.isResolved &&
        isCodexThreadActor(firstComment?.author?.login) &&
        firstComment?.originalCommit?.oid !== expectedHead
      );
    })
    .map((thread) => thread.id);
}

export function classifyCodexState({
  expectedHead,
  readyAt,
  deadline,
  now,
  reviews = [],
  comments = [],
  reactions = [],
}) {
  if (typeof expectedHead !== 'string' || expectedHead.length === 0) {
    throw new TypeError('expectedHead is required');
  }

  const readyAtMs = timestamp(readyAt, 'readyAt');
  const deadlineMs = timestamp(deadline, 'deadline');
  const nowMs = timestamp(now, 'now');

  const currentHeadComments = new Map(comments
    .filter(
      (comment) => isCodexActor(comment) && postedAgainst(comment) === expectedHead,
    )
    .map((comment) => [findingIdentity(comment), comment]));
  if (currentHeadComments.size > 0) {
    const count = currentHeadComments.size;
    return {
      state: 'changes_required',
      findingCount: count,
      detail: `${count} current-head Codex finding${count === 1 ? '' : 's'}`,
    };
  }

  const currentHeadReviews = reviews.filter(
    (review) => isCodexActor(review) && review.commit_id === expectedHead,
  );
  if (currentHeadReviews.length > 0) {
    return {
      state: 'changes_required',
      findingCount: currentHeadReviews.length,
      detail: 'Codex submitted a current-head review',
    };
  }

  const hasFreshCleanReaction = reactions.some(
    (reaction) =>
      isCodexActor(reaction) &&
      reaction.content === '+1' &&
      timestamp(reaction.created_at, 'reaction.created_at') >= readyAtMs,
  );
  if (hasFreshCleanReaction) {
    return {
      state: 'clear',
      findingCount: 0,
      detail: 'fresh Codex +1 for this review attempt',
    };
  }

  if (nowMs > deadlineMs) {
    return {
      state: 'timed_out',
      findingCount: 0,
      detail: 'Codex did not respond before the deadline',
    };
  }

  return {
    state: 'pending',
    findingCount: 0,
    detail: 'waiting for a current-head Codex result',
  };
}
