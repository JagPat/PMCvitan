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
// "absent commit".
//
// Deciding that question from prose PROXIMITY does not converge. Rounds 3, 4
// and 5 each found another sentence where a nearby commit word bound the wrong
// token ("the object key <b>", "git object <b>", "…head status is clear, but
// the digest <b>"). Widening the window admits more of them; narrowing it drops
// real citations. The shape of the rule was the defect, not its width.
//
// So the rule is now two-sided, and the DATA side wins:
//
//   1. A DATA word adjacent to the token vetoes it outright. This list is
//      finite and enumerable — the things a 40-hex value actually is when it is
//      not a commit — and it is checked FIRST, so no positive rule can override
//      it.
//   2. Otherwise the token must be INTRODUCED: the commit word sits adjacent,
//      with only quoting and whitespace between. Not "somewhere in the
//      sentence" — adjacent.
//
// Anything else is bare hex, and bare hex BLOCKS a dismissal. Every remaining
// ambiguity therefore keeps the finding.
const DATA_INTRODUCER =
  /\b(?:digests?|checksums?|hash(?:es)?|objects?|blobs?|trees?|keys?|fingerprints?|ids?|identifiers?|values?|constants?|strings?)\s*[`'"([]*\s*$/iu;

const COMMIT_INTRODUCER =
  /\b(?:commits?|heads?|shas?|revisions?|revs?|refs?|parents?|merge\s+parents?)\s*[`'"([]*\s*$/iu;

// A git command's argument IS a revision by construction, so this arm is the
// one place bounded proximity stays sound — the flags and format strings the
// phantom findings quote sit between the command and its SHA. Bare `git` is NOT
// accepted: "git object <hex>" and "git blob <hex>" name objects, not commits,
// and the DATA veto above runs first regardless.
const GIT_REVISION_COMMAND =
  /\bgit\s+(?:show|log|cat-file|rev-parse|interpret-trailers)\b[^\n]{0,60}$/iu;

// A plural word introduces a LIST, so "commits <a> and <b>" must carry the
// classification forward. What makes it a list is an actual CONJUNCTION between
// the two tokens — a bare comma is not enough, because "on commit <a>, <b> is
// the object key" separates a citation from data with exactly that comma.
const LIST_GLUE = /^[\s,;`'"()[\]]*\b(?:and|or|plus)\b[\s,;`'"()[\]]*$|^[\s`'"()[\]]*&[\s`'"()[\]]*$/iu;

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
    let cited;
    if (DATA_INTRODUCER.test(preceding)) {
      cited = false;
    } else if (previous !== null && LIST_GLUE.test(preceding)) {
      cited = previous;
    } else {
      cited = COMMIT_INTRODUCER.test(preceding) || GIT_REVISION_COMMAND.test(preceding);
    }
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
  return isUnfoundedText(comment?.body, postedAgainst(comment), missingCommits);
}

/**
 * The same test, applied to any finding text — an inline comment's body or a
 * review record's own body. Both are findings; only their envelope differs, and
 * a rule that reached one but not the other would keep blocking on exactly the
 * fabricated citation this exists to discount.
 */
export function isUnfoundedText(body, ownHead, missingCommits) {
  const cited = citedCommits(body);
  if (cited.length === 0) return false;
  // Its OWN reviewed head, not some ambient expectation: this is asked of
  // historical findings too, and each one's claim is about the head it was
  // posted against.
  if (ownHead !== undefined && ownHead !== null && cited.includes(ownHead)) return false;
  // The text also reasons about a 40-hex value that is not a commit, so an
  // absent-commit lookup cannot establish that the finding is about nothing.
  if (citesBareHex(body)) return false;
  const missing = missingCommits instanceof Set ? missingCommits : new Set();
  return cited.every((sha) => missing.has(sha));
}

// Codex wraps its inline comments in a review record whose body is a fixed
// preamble. That wrapper carries nothing the comments do not; anything Codex
// writes ITSELF in the body is a finding in its own right and must survive the
// comments' dismissal. Stripping only the known boilerplate is what separates
// the two — an unrecognised body is treated as substantive.
//
// The `<details>` pattern is pinned to the KNOWN wrapper by its summary text. A
// blanket `<details>…</details>` strip removed collapsed findings too, which
// could clear a head on a finding that cites no SHA at all.
const CODEX_BOILERPLATE = [
  /<details>\s*<summary>[^<]*About Codex in GitHub[\s\S]*?<\/details>/giu,
  /#{0,6}\s*\u{1F4A1}?\s*Codex Review/giu,
  /Here are some automated review suggestions for this pull request\./giu,
  /\*\*Reviewed commit:\*\*\s*`?[0-9a-f]{7,40}`?/giu,
];

export function reviewBodyFinding(review) {
  let body = String(review?.body ?? '');
  for (const pattern of CODEX_BOILERPLATE) body = body.replace(pattern, ' ');
  return body.trim();
}

export function reviewCarriesOwnFinding(review, missingCommits) {
  const body = reviewBodyFinding(review);
  if (body.length === 0) return false;
  // A review body argues from commits exactly as an inline comment does, so the
  // same absent-SHA test decides it. Without this the wrapper kept blocking on
  // the very citation the comments were discounted for.
  return !isUnfoundedText(body, review?.commit_id, missingCommits);
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

export function reviewSurvivesDismissal(review, discountedIds, missingCommits) {
  if (String(review?.state ?? '').toUpperCase() === 'CHANGES_REQUESTED') return true;
  if (reviewCarriesOwnFinding(review, missingCommits)) return true;
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
    (review) => reviewSurvivesDismissal(review, discountedIds, missingCommits),
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
