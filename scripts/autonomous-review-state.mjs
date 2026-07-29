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
const MARKDOWN_LINK = /\[([^\]]*)\]\([^)]*\)/gu;
const BARE_URL = /https?:\/\/\S+/gu;

// A 40-character hex string is not necessarily a commit. Checksums, object ids,
// storage keys and test fixtures have the same shape, and the commits endpoint
// answers 404 for every one of them — so treating any hex token as a commit
// citation would let a real finding ABOUT such a value be discounted as
// "absent commit". A token counts only when the prose immediately before it
// says it is a commit.
// `object` is deliberately ABSENT: "the object key <hex>" is precisely the
// non-commit citation this rule exists to protect, and git's own object
// vocabulary would have swallowed it.
const COMMIT_CONTEXT =
  /\b(?:commits?|heads?|shas?|revisions?|revs?|refs?|parents?|merges?|git(?:\s+(?:show|log|cat-file|rev-parse|interpret-trailers))?)\b[^\n]{0,80}$/iu;

// A citation is a PHRASE, not a paragraph. "…the two recorded finding heads
// report X. The digest <hex> is stale." names a digest, and only a window that
// ran back across the sentence break would find "heads" and read it as a commit
// citation. Cutting at the last sentence terminator keeps the proximity rule
// honest, and it errs the safe way: a token that loses its context becomes BARE
// hex, which blocks a dismissal rather than permitting one.
const SENTENCE_BREAK = /[.!?]\s|\n/gu;

// A plural word introduces a LIST, and the window reset below would otherwise
// hand the second entry of "commits <a> and <b>" an empty context. What makes
// it a list is the text BETWEEN the two tokens: punctuation and a conjunction,
// nothing else. "on commit <a>, the object key <b>" carries a noun phrase
// instead, so it does not continue — which is exactly what keeps a real finding
// about the key alive. The continuation copies whichever classification the
// previous token got, so "the digests <a> and <b>" stays data.
const LIST_GLUE = /^[\s,;`'"()[\]]*(?:and|or|&|plus)?[\s,;`'"()[\]]*$/iu;

function scanFullHex(body) {
  const prose = String(body ?? '')
    .replace(MARKDOWN_LINK, ' $1 ')
    .replace(BARE_URL, ' ');
  const inCommitContext = new Set();
  const bare = new Set();
  // The window for each token starts at the END of the previous one, so a
  // commit word introduces only the SHA that follows it. Without that bound,
  // "on commit <a>, the object key <b> was deleted" reuses "commit" for <b> and
  // a real finding about the key could be discounted.
  let windowStart = 0;
  let previous = null;
  for (const match of prose.matchAll(FULL_SHA)) {
    const preceding = prose.slice(windowStart, match.index);
    const continuesList = previous !== null && LIST_GLUE.test(preceding);
    const cited = continuesList
      ? previous
      : COMMIT_CONTEXT.test(preceding.split(SENTENCE_BREAK).at(-1));
    (cited ? inCommitContext : bare).add(match[0]);
    previous = cited;
    windowStart = match.index + match[0].length;
  }
  return { inCommitContext: [...inCommitContext], bare: [...bare] };
}

/**
 * The distinct full commit SHAs a finding's prose asserts something about.
 *
 * Only tokens the prose introduces AS commits ("on head <sha>",
 * "git show <sha>", "commit <sha>"). A bare 40-hex value is data, not a commit
 * citation, and is reported separately by `citesBareHex`.
 */
export function citedCommits(body) {
  return scanFullHex(body).inCommitContext;
}

/**
 * Whether the body reasons about a 40-hex value that is NOT introduced as a
 * commit. Such a finding may be about that value itself, so it is never
 * discounted on the strength of an absent-commit lookup.
 */
export function citesBareHex(body) {
  return scanFullHex(body).bare.length > 0;
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
export function isUnfoundedFinding(comment, missingCommits) {
  const cited = citedCommits(comment?.body);
  if (cited.length === 0) return false;
  // Its OWN reviewed head, not some ambient expectation: this is asked of
  // historical comments too, and each one's claim is about the head it was
  // posted against.
  if (cited.includes(postedAgainst(comment))) return false;
  // The body also reasons about a 40-hex value that is not a commit, so an
  // absent-commit lookup cannot establish that the finding is about nothing.
  if (citesBareHex(comment?.body)) return false;
  const missing = missingCommits instanceof Set ? missingCommits : new Set();
  return cited.every((sha) => missing.has(sha));
}

// Codex wraps its inline comments in a review record whose body is a fixed
// preamble. That wrapper carries nothing the comments do not; anything Codex
// writes ITSELF in the body is a finding in its own right and must survive the
// comments' dismissal. Stripping only the known boilerplate is what separates
// the two — an unrecognised body is treated as substantive.
const CODEX_BOILERPLATE = [
  /<details>[\s\S]*?<\/details>/giu,
  /#{0,6}\s*\u{1F4A1}?\s*Codex Review/giu,
  /Here are some automated review suggestions for this pull request\./giu,
  /\*\*Reviewed commit:\*\*\s*`?[0-9a-f]{7,40}`?/giu,
];

export function reviewCarriesOwnFinding(review) {
  let body = String(review?.body ?? '');
  for (const pattern of CODEX_BOILERPLATE) body = body.replace(pattern, ' ');
  return body.trim().length > 0;
}

/**
 * The review records the dismissal takes with it.
 *
 * A record qualifies only when it CARRIED dismissed comments (matched by
 * `pull_request_review_id`, never inferred from the head having comments), it
 * did not request changes, it has no surviving comment of its own, and its body
 * adds nothing beyond the boilerplate. Every other record is evidence and
 * blocks. Both the current-head classifier and convergence counting call this,
 * so the two cannot answer the question differently.
 */
export function discountedReviewIds(comments, missingCommits) {
  const carried = new Map();
  for (const comment of comments ?? []) {
    if (comment?.user?.login !== CODEX_LOGIN) continue;
    const id = comment?.pull_request_review_id;
    if (id === undefined || id === null) continue;
    const founded = !isUnfoundedFinding(comment, missingCommits);
    carried.set(id, (carried.get(id) ?? false) || founded);
  }
  const discounted = new Set();
  for (const [id, hasFounded] of carried) {
    if (!hasFounded) discounted.add(id);
  }
  return discounted;
}

export function reviewSurvivesDismissal(review, discountedIds) {
  if (String(review?.state ?? '').toUpperCase() === 'CHANGES_REQUESTED') return true;
  if (reviewCarriesOwnFinding(review)) return true;
  return !discountedIds.has(review?.id);
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
    (comment) => !isUnfoundedFinding(comment, missingCommits),
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

  const currentHeadReviews = reviews.filter(
    (review) => isCodexActor(review) && review.commit_id === expectedHead,
  );

  // Only the record that CARRIED the dismissed comments is discounted with
  // them, and it is identified by id rather than inferred from the head having
  // comments at all. A record that requests changes is evidence in its own
  // right; so is a standalone COMMENTED note whose body says something the
  // dismissed comments did not. Everything else survives the dismissal.
  const discountedIds = discountedReviewIds(postedOnHead, missingCommits);
  const survivingReviews = currentHeadReviews.filter(
    (review) => reviewSurvivesDismissal(review, discountedIds),
  );
  if (survivingReviews.length > 0) {
    const blocking = survivingReviews.some(
      (review) => String(review?.state ?? '').toUpperCase() === 'CHANGES_REQUESTED',
    );
    return {
      state: 'changes_required',
      findingCount: survivingReviews.length,
      dismissedCount: dismissed,
      detail: blocking
        ? 'Codex requested changes on this exact head'
        : 'Codex submitted a current-head review',
    };
  }

  // Codex answered on this exact head and every finding it raised argued from a
  // commit this repository does not contain. There is no statement left about
  // any state this repository has been in, so the head carries no finding. A
  // COMMENTED review record accompanying those comments carries nothing beyond
  // them, which is why it does not survive their dismissal. The count is
  // reported rather than swallowed: a dismissal is a claim the loop makes out
  // loud, on the status and in the sticky comment.
  if (postedOnHead.length > 0) {
    return {
      state: 'clear',
      findingCount: 0,
      dismissedCount: postedOnHead.length,
      detail: `Codex raised ${postedOnHead.length} finding${postedOnHead.length === 1 ? '' : 's'} `
        + 'on this head, each citing only commits absent from this repository',
    };
  }

  // A review record with no inline comments at all states something the gate
  // cannot inspect, so it blocks.
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
