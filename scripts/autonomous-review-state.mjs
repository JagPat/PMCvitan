import { CODEX_LOGIN, CODEX_GRAPHQL_LOGIN, CODEX_RUN_HELD_DETAIL, CODEX_SECURITY_FINDINGS_DETAIL, isCodexReplyOnlyReview } from './review-policy.mjs';
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
 * Returns 'security', 'hold', 'dirty', 'clear' or 'none' (G2, #1094 6565074822), in that order of precedence.
 *  - 'security': a security review completed on this head with unresolved findings, which the gate cannot see as
 *    comments. No run ending lifts it, so it blocks every clearance as a finding (non-retryable: a correction is owed),
 *    even while another same-head run is still going (Codex 4439117340).
 *  - 'hold': a same-head run still going (a code or security review on this head whose status is present and not
 *    `completed`). It holds every clearance (the cap's deferral, a fresh +1, the record's own) as a retryable
 *    non-success: the run ends and the head is re-judged.
 *  - 'dirty': any other same-head record that is not wholly clean. A code review completed with
 *    `has_unresolved_findings: true` is Codex's normal record for any head it commented on; those findings are
 *    visible to the gate, which blocks them (under the cap) or defers and files them (past it) exactly as before.
 */
export function codexStateRecordVerdict(issueComments, expectedHead, readyAtMs) {
  let clears = false;
  let dirty = false;
  let hold = false;
  let securityFindings = false;
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
    if (running(code) || running(security)) hold = true;
    if (security?.commit_sha === expectedHead && security.status === 'completed' && security.has_unresolved_findings === true) {
      securityFindings = true;
    }
    const writtenMs = Date.parse(comment?.updated_at ?? comment?.created_at);
    if (Number.isFinite(writtenMs) && writtenMs >= readyAtMs && codeClean && securityClean) clears = true;
  }
  // Codex 4439117340 — a completed security review with unresolved findings outranks a run still going on this head:
  // no run ending lifts those findings, and a hold would only ever publish the retryable state, so a stuck run would
  // keep them from being routed for correction
  if (securityFindings) return 'security';
  if (hold) return 'hold';
  if (dirty) return 'dirty';
  return clears ? 'clear' : 'none';
}

/**
 * 2A3b-2 B (#1318 Codex 4448897188) — what Codex's review-state records say about `expectedHead`, as one string: each
 * Codex-authored record (REST login, marker and parseable JSON, as `codexStateRecordVerdict` reads them) whose code or
 * security section names `expectedHead`, by id, last update and body, sorted. Two reads with the same fingerprint saw
 * the same records for this head; a review that completed between them changes it, even one that ends with an
 * identical body (its update time moves), and so does a record that comes to name this head or stops naming it.
 * #1320 Codex 4450011604 — a record about another head only, edited late, is not evidence for this head and does not
 * change it.
 */
export function codexRecordFingerprint(issueComments, expectedHead) {
  return (issueComments ?? [])
    .filter((comment) => {
      if (!isCodexActor(comment)) return false;
      const match = /<!--\s*codex-review-state:v1\s+([\s\S]*?)\s*-->/u.exec(String(comment?.body ?? ''));
      if (!match) return false;
      let record;
      try { record = JSON.parse(match[1]); } catch { return false; }
      return record?.code_review?.commit_sha === expectedHead || record?.security_review?.commit_sha === expectedHead;
    })
    .map((comment) => `${String(comment.id)}\u0000${String(comment.updated_at ?? comment.created_at ?? '')}\u0000${String(comment.body)}`)
    .sort()
    .join('\u0001');
}

/**
 * 2A3b-2 C (#1318 Codex 4449402452) — when Codex's review-state records were last written: the latest update time of any
 * Codex-authored record (as `codexRecordFingerprint` selects them), in ms; -Infinity with none, NaN when one is
 * unreadable (a caller comparing with `!(latest < t)` treats NaN as newer, fail closed).
 */
export function codexRecordLatestMs(issueComments) {
  let latest = -Infinity;
  for (const comment of issueComments ?? []) {
    if (!isCodexActor(comment) || !/<!--\s*codex-review-state:v1\s/u.test(String(comment?.body ?? ''))) continue;
    const written = Date.parse(comment?.updated_at ?? comment?.created_at);
    if (!Number.isFinite(written)) return Number.NaN;
    if (written > latest) latest = written;
  }
  return latest;
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

  // G2 (Codex 4437635934) — a same-head Codex run still going holds EVERY clearance below (the cap's deferral, a
  // fresh +1, the record's own, the fall-through), never a finding: findings still block first. A hold is
  // `held: true` on a pending (or, past the deadline, timed_out) result, so a caller that admits `pending` as
  // "nothing arrived" can tell it apart and refuse it (the settlement, the recovery). Security findings the gate
  // cannot see block at the same points as a finding (`changes_required`, non-retryable)
  const record = codexStateRecordVerdict(issueComments, expectedHead, readyAtMs);
  const recordStops = () => {
    if (record === 'security') return { state: 'changes_required', findingCount: 1, security: true, detail: CODEX_SECURITY_FINDINGS_DETAIL };
    if (record !== 'hold') return null;
    return nowMs > deadlineMs
      ? { state: 'timed_out', findingCount: 0, held: true, detail: CODEX_RUN_HELD_DETAIL }
      : { state: 'pending', findingCount: 0, held: true, detail: CODEX_RUN_HELD_DETAIL };
  };

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
      const stopped = recordStops();
      // Codex 4438607043 — a security stop carries the deferrable findings beside it, as a blocker does (Codex
      // 4220861349): once its correction moves the head they are no longer current-head evidence. A hold files nothing
      if (stopped?.state === 'changes_required') return { ...stopped, deferred };
      if (stopped) return stopped;
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
  if (hasFreshCleanReaction && !recordStops()) {
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

  const stopped = recordStops();
  if (stopped) return stopped;

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
