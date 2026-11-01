import { CODEX_LOGIN, CODEX_GRAPHQL_LOGIN, CODEX_RUN_HELD_DETAIL, isCodexReplyOnlyReview } from './review-policy.mjs';
export { CODEX_LOGIN, CODEX_GRAPHQL_LOGIN } from './review-policy.mjs';

import { isLineageBase } from './lineage-policy.mjs';
import { blocksUnderCap } from './review-cap.mjs';

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

/**
 * Is a Codex review body nothing but the standard container Codex wraps its inline findings in (the heading,
 * the "automated review suggestions" line, the reviewed commit and the About-Codex details)? Such a body adds
 * no finding beyond the inline comments it introduces; any other text in it is a review-level finding.
 */
export function isCodexReviewSummaryOnly(body) {
  const rest = String(body ?? '')
    // only Codex's own About-Codex block: a <details> holding anything else is review text (Codex 4229506031)
    .replace(/<details>\s*<summary>[^<]*About Codex in GitHub\s*<\/summary>[\s\S]*?<\/details>/gu, '')
    .replace(/^#{1,6}\s*(?:\p{Extended_Pictographic}\uFE0F?\s*)?Codex Review\s*$/gmu, '')
    .replace(/^Here are some automated review suggestions for this pull request\.\s*$/gmu, '')
    .replace(/^\*\*Reviewed commit:\*\*\s*`[0-9a-f]{7,40}`\s*$/gmu, '');
  return rest.trim().length === 0;
}

/**
 * #1254 (Jagrut's choice, #1094 6564512390) — Codex's own review-state record. Codex keeps one PR comment it edits
 * in place, carrying `<!-- codex-review-state:v1 {json} -->`; on a clean run it may post neither a +1 nor a
 * comment, so this record is the only verdict. It clears a head only when every part of it holds:
 *  - the comment is Codex's (REST login) and was last written at or after `readyAtMs` (this review attempt);
 *  - `code_review` is `completed` on exactly `expectedHead` with `has_unresolved_findings === false`
 *    (`has_any_findings` counts earlier, resolved rounds too, so it is not read);
 *  - `security_review` is absent or idle (`status` and `commit_sha` null, no unresolved findings), or completed
 *    clean on the same head (Codex 4437814263).
 * Anything else (no marker, unparseable JSON, another head, a run in progress, a stale write) is no verdict.
 * A Codex record that names this head and is not wholly clean (findings, a run still going, a missing flag) vetoes
 * any record's own clear, whenever it was written (Codex 4437620372).
 *
 * Returns 'hold', 'dirty', 'clear' or 'none' (G2, #1094 6565074822). 'hold' is narrower than 'dirty': a same-head
 * run still going (a code or security review on this head whose status is present and not `completed`), or a
 * security review completed on this head with unresolved findings, which the gate cannot see as comments. It holds
 * every clearance (the cap's deferral, a fresh +1, the record's own) as a retryable non-success. A code review
 * completed with `has_unresolved_findings: true` is only 'dirty': that is Codex's normal record for any head it
 * commented on, and those findings are visible to the gate, which blocks them (under the cap) or defers and files
 * them (past it) exactly as before.
 */
export function codexStateRecordVerdict(issueComments, expectedHead, readyAtMs) {
  let clears = false;
  let dirty = false;
  let hold = false;
  for (const comment of issueComments ?? []) {
    if (!isCodexActor(comment)) continue;
    const match = /<!--\s*codex-review-state:v1\s+([\s\S]*?)\s*-->/u.exec(String(comment?.body ?? ''));
    if (!match) continue;
    let record;
    try { record = JSON.parse(match[1]); } catch { continue; }
    const code = record?.code_review;
    const security = record?.security_review;
    const codeClean = code?.status === 'completed' && code?.commit_sha === expectedHead && code?.has_unresolved_findings === false;
    // Codex 4437814263 — idle means wholly empty: an idle section naming a head or reporting unresolved findings is
    // contradictory and never clean (on this head it vetoes below)
    const securityIdle = security == null
      || (security.status == null && security.commit_sha == null && security.has_unresolved_findings !== true);
    const securityClean = securityIdle
      || (security.status === 'completed' && security.commit_sha === expectedHead && security.has_unresolved_findings === false);
    // Codex 4437620372 — any record that names this head and is not wholly clean (a run still going, findings, a
    // missing flag) vetoes, whenever it was written: a clean record never outranks an unfinished or failing one
    const namesHead = code?.commit_sha === expectedHead || security?.commit_sha === expectedHead;
    if (namesHead && !(codeClean && securityClean)) dirty = true;
    const running = (review) => review?.commit_sha === expectedHead && review.status != null && review.status !== 'completed';
    if (running(code) || running(security)
      || (security?.commit_sha === expectedHead && security.status === 'completed' && security.has_unresolved_findings === true)) {
      hold = true;
    }
    const writtenMs = Date.parse(comment?.updated_at ?? comment?.created_at);
    if (Number.isFinite(writtenMs) && writtenMs >= readyAtMs && codeClean && securityClean) clears = true;
  }
  if (hold) return 'hold';
  if (dirty) return 'dirty';
  return clears ? 'clear' : 'none';
}

export function codexStateRecordClears(issueComments, expectedHead, readyAtMs) {
  return codexStateRecordVerdict(issueComments, expectedHead, readyAtMs) === 'clear';
}

export function classifyCodexState({
  expectedHead,
  readyAt,
  deadline,
  now,
  reviews = [],
  comments = [],
  reactions = [],
  // #1254 — the PR's issue comments, for Codex's review-state record (`codexStateRecordVerdict`)
  issueComments = [],
  // Owner decision 2026-10-08: `{ reached, changedLines }` from `reviewCapState`. Past the cap, only a
  // P0/P1 on a changed line blocks; the rest is returned as `deferred` on a `clear` result.
  cap = null,
  // Owner decision 2026-10-08 (M2b) — whether the evidence is one coherent snapshot (`readCodexEvidence`).
  // An unstable one is `unsettled`: it never clears a head and never reads as "nothing new".
  stable = true,
}) {
  if (typeof expectedHead !== 'string' || expectedHead.length === 0) {
    throw new TypeError('expectedHead is required');
  }

  const readyAtMs = timestamp(readyAt, 'readyAt');
  const deadlineMs = timestamp(deadline, 'deadline');
  const nowMs = timestamp(now, 'now');

  if (stable !== true) {
    // past the deadline it times out like a silent Codex (a retryable attempt), so a poll never outlives it
    return nowMs > deadlineMs
      ? { state: 'timed_out', findingCount: 0, detail: 'Codex evidence did not settle before the deadline' }
      : { state: 'unsettled', findingCount: 0, detail: 'Codex evidence changed while it was read' };
  }

  // G2 (Codex 4437635934) — a same-head Codex run still going (or security findings the gate cannot see) holds
  // EVERY clearance below (the cap's deferral, a fresh +1, the record's own), never a finding: findings still block
  // as before. A hold is `held: true` on a pending (or, past the deadline, timed_out) result, so a caller that
  // admits `pending` as "nothing arrived" can tell it apart and refuse it (the settlement, the recovery)
  const record = codexStateRecordVerdict(issueComments, expectedHead, readyAtMs);
  const recordHeld = () => (nowMs > deadlineMs
    ? { state: 'timed_out', findingCount: 0, held: true, detail: CODEX_RUN_HELD_DETAIL }
    : { state: 'pending', findingCount: 0, held: true, detail: CODEX_RUN_HELD_DETAIL });

  const currentHeadComments = new Map(comments
    .filter(
      (comment) => isCodexActor(comment) && postedAgainst(comment) === expectedHead,
    )
    .map((comment) => [findingIdentity(comment), comment]));
  if (cap?.reached) {
    // Codex 4220431616 — a REPLY (in_reply_to_id set) opens no finding (findingRoundHeads), so it is neither
    // judged nor deferred here: a reply alone can never let the cap clear a head Codex has not reviewed. It
    // stays in `comments` for `isCodexReplyOnlyReview`, and falls through to the ordinary evidence rules.
    // Codex 4225790723 — past the cap every finding is judged as GitHub returned it, one per comment id: the
    // `findingIdentity` dedupe (path, line, body) omits the side and range, so a changed-line P1 on the LEFT
    // could be overwritten by an identical one on unchanged RIGHT context and the head would clear
    const byId = new Map(comments
      .filter((comment) => isCodexActor(comment) && postedAgainst(comment) === expectedHead && comment?.in_reply_to_id == null)
      .map((comment) => [comment?.id ?? comment?.html_url ?? findingIdentity(comment), comment]));
    const findings = [...byId.values()];
    const blocking = findings.filter((comment) => blocksUnderCap(comment, cap.changedLines));
    const headReviews = reviews.filter((review) => isCodexActor(review)
      && review.commit_id === expectedHead
      && !isCodexReplyOnlyReview(review, comments));
    // Codex 4213960388 / 4214270288 — a review-level finding (a review body, badged or not: an unbadged one is
    // read conservatively as finding-bearing, as elsewhere) has no line to judge, so it is deferred with the
    // rest rather than silently dropped. Codex 4226684328 — that holds when the review ALSO owns inline
    // comments: its body is a finding of its own unless it is only Codex's standard summary of them
    const reviewLevel = headReviews.filter((review) => String(review?.body ?? '').trim().length > 0
      && !(comments.some((comment) => comment?.pull_request_review_id === review.id) && isCodexReviewSummaryOnly(review.body)));
    const deferred = [...findings.filter((comment) => !blocking.includes(comment)), ...reviewLevel];
    if (blocking.length > 0) {
      const count = blocking.length;
      // Codex 4220861349 — the non-blocking findings beside a blocker are returned too: once the correction
      // moves the head they are no longer current-head evidence, so the gate files them now or never
      return {
        state: 'changes_required',
        findingCount: count,
        deferred,
        detail: `${count} blocking current-head Codex finding${count === 1 ? '' : 's'} (P1 on a changed line, past the review-round cap)`,
      };
    }
    // Codex 4216657953 — the cap clears a head only on findings it actually defers: a blank review record with
    // nothing to defer is no verdict, so it falls through to the ordinary evidence rules (a fresh +1 clears;
    // incomplete evidence stays pending or blocks) exactly as before the cap
    if (deferred.length > 0) {
      if (record === 'hold') return recordHeld();
      const count = deferred.length;
      return {
        state: 'clear',
        findingCount: 0,
        deferred,
        detail: `review-round cap reached: ${count} non-blocking current-head finding${count === 1 ? '' : 's'} deferred to a follow-up issue`,
      };
    }
  }

  if (currentHeadComments.size > 0) {
    const count = currentHeadComments.size;
    return {
      state: 'changes_required',
      findingCount: count,
      detail: `${count} current-head Codex finding${count === 1 ? '' : 's'}`,
    };
  }

  const currentHeadReviews = reviews.filter(
    (review) => isCodexActor(review)
      && review.commit_id === expectedHead
      // A reply-only review (a Codex answer in an older head's thread) is not a review of this head;
      // a new finding on this head is a current-head comment and was counted above (#638).
      && !isCodexReplyOnlyReview(review, comments),
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
  if (hasFreshCleanReaction && record !== 'hold') {
    return {
      state: 'clear',
      findingCount: 0,
      detail: 'fresh Codex +1 for this review attempt',
    };
  }

  // #1254 — reached only with no current-head Codex comment or review and no fresh +1
  if (record === 'clear') {
    return {
      state: 'clear',
      findingCount: 0,
      detail: 'Codex completed this exact head with no unresolved findings',
    };
  }

  if (record === 'hold') return recordHeld();

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
