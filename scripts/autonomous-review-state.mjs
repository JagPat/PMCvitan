import { isLineageBase } from './lineage-policy.mjs';

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

/**
 * May the controller act on this pull request at all?
 *
 * THE BASE REF IS PART OF THAT QUESTION, and it is the third and last placement of the
 * lineage base rule. #402 put the rule at ADMISSION (`assessReviewScope`, so the required
 * `review-scope` check fails an off-`main` unit) and at SETTLEMENT (`settlementOf`, so a
 * merge that never touched `main` discharges nothing). Neither stops an off-`main` unit
 * from ENTERING the lifecycle, and entering is what does the damage.
 *
 * MEASURED on this repository, before this guard: `eligibleShape` did not project
 * `base.ref` at all, so a unit targeting `release` was eligible; the orchestrator then ran
 * its whole lifecycle on it. EXHAUSTION TAKES NO BASE TEST — deliberately, because
 * suppressing an obligation there would be a waiver path, letting a `release`-targeted unit
 * draw findings across two heads and have them neither fixed nor carried. So the off-`main`
 * unit is labelled `review-replacement-required`, which is a REPOSITORY-WIDE obligation, and
 * `assessReplacementLineage` then refuses every fresh `main` unit:
 *
 *     exhausted PR #500 still requires a replacement; declare Replaces: #500
 *     before starting fresh work
 *
 * Every unit in the repository is blocked behind work that was never eligible to land on
 * `main` at all. A claimant merging off-`main` is the narrower failure; this is the one that
 * stops the loop, and admission cannot prevent it because admission fails a CHECK while the
 * lifecycle carries on around it.
 *
 * UNCONDITIONAL, where the admission rule is gated on `preReviewRequired`. The two moments
 * answer different questions and take different risks. Admission FAILS A REQUIRED CHECK, so
 * applying it retroactively would turn a unit red that was valid when it opened — hence the
 * gate. Eligibility only decides NOT TO ACT, which is what this function already does for a
 * fork and for a closed pull request: the controller leaves the pull request untouched and
 * changes nothing. Refusing is therefore fail-closed at both ends, and there is no
 * retroactive failure to protect against.
 *
 * NO ANCESTRY, here or at any placement. `main` advances under an open unit constantly and a
 * squash merge breaks the relation a second way, so an ancestry test refuses ordinary valid
 * work. This reads `base.ref` and nothing else.
 */
export function isEligiblePullRequest(pullRequest) {
  const state = String(pullRequest?.state ?? '').toUpperCase();
  const headRepository = pullRequest?.headRepository?.nameWithOwner;
  const baseRepository = pullRequest?.baseRepository?.nameWithOwner;

  return (
    state === 'OPEN' &&
    typeof headRepository === 'string' &&
    headRepository === baseRepository &&
    isLineageBase(pullRequest?.baseRefName)
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
