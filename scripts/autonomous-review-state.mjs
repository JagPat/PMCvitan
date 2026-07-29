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

const FULL_SHA = /\b[0-9a-f]{40}\b/gu;
// Markdown links and bare URLs cite a LOCATION, not the subject of a claim. A
// permalink embeds the head the reviewer was given, so leaving it in would make
// every finding look like it discusses the real head. Stripping URLs first
// leaves only the SHAs the finding's prose actually reasons about.
const URL_TOKEN = /\[[^\]]*\]\([^)]*\)|https?:\/\/\S+/gu;

/**
 * The distinct full commit SHAs a finding's prose asserts something about.
 */
export function citedCommits(body) {
  const prose = String(body ?? '').replace(URL_TOKEN, ' ');
  return [...new Set(prose.match(FULL_SHA) ?? [])];
}

/**
 * A finding states its evidence as "on head <sha>, X is false". When every SHA
 * it names is absent from the repository, that evidence is about nothing: the
 * commit was never pushed, is not the reviewed head, and cannot be inspected by
 * anyone. Such a finding is unfounded by construction — not a judgement that it
 * is wrong, but the observation that it describes no state this repository has
 * ever been in.
 *
 * Deliberately narrow, and every ambiguity resolves toward KEEPING the finding:
 *
 * - A finding that names no full SHA is always founded (the overwhelming
 *   majority — findings normally point at a file and a line, not a commit).
 * - A finding that names the reviewed head is always founded, even if it also
 *   names absent SHAs.
 * - `missingCommits` holds only SHAs whose absence GitHub confirmed. A lookup
 *   that failed or was never attempted leaves the SHA out, so the finding
 *   stands.
 *
 * The dismissal is therefore reachable only when the repository definitively
 * does not contain any commit the finding argues from.
 */
export function isUnfoundedFinding(comment, expectedHead, missingCommits) {
  const cited = citedCommits(comment?.body);
  if (cited.length === 0) return false;
  if (cited.includes(expectedHead)) return false;
  const missing = missingCommits instanceof Set ? missingCommits : new Set();
  return cited.every((sha) => missing.has(sha));
}

export function isEligiblePullRequest(pullRequest) {
  const state = String(pullRequest?.state ?? '').toUpperCase();
  const headRepository = pullRequest?.headRepository?.nameWithOwner;
  const baseRepository = pullRequest?.baseRepository?.nameWithOwner;

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
  missingCommits = new Set(),
}) {
  if (typeof expectedHead !== 'string' || expectedHead.length === 0) {
    throw new TypeError('expectedHead is required');
  }

  const readyAtMs = timestamp(readyAt, 'readyAt');
  const deadlineMs = timestamp(deadline, 'deadline');
  const nowMs = timestamp(now, 'now');

  const postedOnHead = comments.filter(
    (comment) => isCodexActor(comment) && postedAgainst(comment) === expectedHead,
  );
  const founded = postedOnHead.filter(
    (comment) => !isUnfoundedFinding(comment, expectedHead, missingCommits),
  );
  // Counted from the filter, never from the map-size delta: the map also
  // deduplicates byte-identical findings, and collapsing a duplicate is not a
  // dismissal. Conflating them would overstate what the gate discounted.
  const dismissed = postedOnHead.length - founded.length;
  const currentHeadComments = new Map(
    founded.map((comment) => [findingIdentity(comment), comment]),
  );
  if (currentHeadComments.size > 0) {
    const count = currentHeadComments.size;
    return {
      state: 'changes_required',
      findingCount: count,
      dismissedCount: dismissed,
      detail: `${count} current-head Codex finding${count === 1 ? '' : 's'}`
        + (dismissed > 0 ? ` (${dismissed} unfounded, absent commits)` : ''),
    };
  }

  // Codex answered on this exact head and every finding it raised argued from a
  // commit this repository does not contain. There is no statement left about
  // any state this repository has been in, so the head carries no finding. The
  // count is reported rather than swallowed: a dismissal is a claim the loop
  // makes out loud, on the status and in the sticky comment.
  if (postedOnHead.length > 0) {
    return {
      state: 'clear',
      findingCount: 0,
      dismissedCount: postedOnHead.length,
      detail: `Codex raised ${postedOnHead.length} finding${postedOnHead.length === 1 ? '' : 's'} `
        + 'on this head, each citing only commits absent from this repository',
    };
  }

  const currentHeadReviews = reviews.filter(
    (review) => isCodexActor(review) && review.commit_id === expectedHead,
  );
  if (currentHeadReviews.length > 0) {
    return {
      state: 'changes_required',
      findingCount: currentHeadReviews.length,
      dismissedCount: 0,
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
      dismissedCount: 0,
      detail: 'fresh Codex +1 for this review attempt',
    };
  }

  if (nowMs > deadlineMs) {
    return {
      state: 'timed_out',
      findingCount: 0,
      dismissedCount: 0,
      detail: 'Codex did not respond before the deadline',
    };
  }

  return {
    state: 'pending',
    findingCount: 0,
    dismissedCount: 0,
    detail: 'waiting for a current-head Codex result',
  };
}
