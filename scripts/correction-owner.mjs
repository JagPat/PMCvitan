// WHO fixes a review finding on this pull request.
//
// The loop had no answer to that question, and answered it anyway. Every
// finding notice said "Claude Auto-fix handles the review comments" because the
// sentence was a string literal at the call site. On 2026-08-17 that was told to
// PR #350, whose corrections belong to a Cursor agent, and to PR #349, whose
// corrections belong to Claude — the same words, with no reading of either PR.
//
// Nothing available to GitHub can INFER the answer. The branch prefix does not
// carry it (both PRs were on `codex/**`), the PR author is the repository owner
// in both cases, and a subscription-backed agent session is invisible from
// here: there is no API that says whether a Claude Auto-fix or a Cursor session
// is alive, so "is a worker running?" is not a question this repository can ask.
//
// So the answer is DECLARED, in the one place both the author and the trusted
// controller can read: a machine-readable marker in the pull request body. The
// declaration is validated by the first, cheapest gate, and every downstream
// notice is derived from it rather than assumed.
//
// This module is a LEAF on purpose — it imports nothing — so the scope gate
// (scripts/review-efficiency.mjs), the review controller
// (scripts/autonomous-review-gate.mjs) and the correction watchdog
// (scripts/correction-lease.mjs) can all read one definition of ownership
// without a cycle.

export const CORRECTION_OWNERS = ['claude', 'cursor'];

// PRs at or below this number were already open when the declaration became
// required, and this branch is not permitted to edit them. They are bootstrapped
// by DECLARING — the owner adds the marker to the PR body, which reruns the
// scope gate and routes the correction — never by being retroactively blocked on
// a rule that did not exist when they were opened. See docs/AUTONOMOUS_LOOP.md.
export const CORRECTION_OWNER_ENFORCE_AFTER_PR = 350;

// Which owners GitHub can actually WAKE, under this repository's
// subscription-only authentication.
//
// Claude Code web Auto-fix subscribes to a pull request and receives its comment
// events, so a marked `@claude` comment reaches that session — this is the same
// mechanism `scripts/runner-continuation.mjs` already relies on. Nothing here can
// start a Cursor agent: there is no credential, no dispatch and no webhook this
// repository owns, and adding one would mean adding an AI credential, which
// docs/AUTONOMOUS_LOOP.md forbids.
//
// An owner outside this set is not a failure to route. It is a correction that
// GitHub can describe but cannot start, and saying so plainly is the whole point
// — see `correction_stalled`.
export const AWAKENABLE_FROM_GITHUB = new Set(['claude']);

// The honest terminal state: a correction is owed, its owner is known (or
// knowably absent), and no automation can begin it.
export const CORRECTION_STALLED = 'correction_stalled';

const DECLARATION = /<!--\s*correction-owner:\s*([A-Za-z][A-Za-z0-9_-]*)\s*-->/gu;
// docs/AUTONOMOUS_LOOP.md reserves this prefix for Claude-authored work, so a
// branch under it declaring another owner contradicts itself. No other prefix
// implies anything — #349 and #350 are both loop PRs on `codex/**`.
const CLAUDE_BRANCH_PREFIX = 'claude/';
const MARKER_HELP = '`<!-- correction-owner: claude -->` or `<!-- correction-owner: cursor -->`';

// A body DECLARES in its marker block and DESCRIBES everywhere else.
//
// The first head of PR #352 proved why that distinction has to exist: its body
// carried `<!-- correction-owner: claude -->` at the top and, further down,
// documented how #349 and #350 would each add their own marker — so a
// whole-body scan read two owners and refused a correctly declared PR. The PR
// template does the same thing, in its own guidance paragraph, which would have
// refused every PR that kept it.
//
// The block is the leading run of marker lines, blanks allowed, ending at the
// first line that is neither — the shape the template already uses for
// `review-size` and `migration-scope`. A marker inside a sentence, a code fence,
// or a later section is prose. Two DIFFERENT markers IN the block are still a
// contradiction, which is exactly what an author who adds a line instead of
// editing one produces.
function declarationBlock(body) {
  const declared = [];
  for (const line of String(body ?? '').split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    if (!/^<!--[\s\S]*-->$/u.test(trimmed)) break;
    for (const match of trimmed.matchAll(DECLARATION)) {
      declared.push(match[1].toLowerCase());
    }
  }
  return declared;
}

/**
 * Read the declaration. Four outcomes, all named:
 *
 *   declared      — exactly one owner, known, consistent with the branch
 *   missing       — no marker in the block at the top of the body
 *   invalid       — a marker naming an agent this loop does not route to
 *   contradictory — two different owners, or an owner the branch contradicts
 *
 * A repeated IDENTICAL marker is unambiguous and is accepted: an author who
 * edits the template's marker in place rather than adding a line must not be
 * blocked for tidiness.
 */
export function parseCorrectionOwner(body, { headRef } = {}) {
  const declared = declarationBlock(body);

  if (declared.length === 0) {
    return {
      state: 'missing',
      owner: null,
      declared,
      detail: `the marker block at the top of the PR body must declare its correction owner `
        + `with ${MARKER_HELP}`,
    };
  }

  const distinct = [...new Set(declared)];
  if (distinct.length > 1) {
    return {
      state: 'contradictory',
      owner: null,
      declared,
      detail: `the PR body declares conflicting correction owners (${distinct.join(', ')}); `
        + 'exactly one owner may be declared',
    };
  }

  const [owner] = distinct;
  if (!CORRECTION_OWNERS.includes(owner)) {
    return {
      state: 'invalid',
      owner: null,
      declared,
      detail: `"${owner}" is not a correction owner this loop routes to; use ${MARKER_HELP}`,
    };
  }

  const ref = typeof headRef === 'string' ? headRef : '';
  if (ref.startsWith(CLAUDE_BRANCH_PREFIX) && owner !== 'claude') {
    return {
      state: 'contradictory',
      owner: null,
      declared,
      detail: `branch \`${ref}\` is reserved for Claude-authored work but the body declares `
        + `correction owner "${owner}"`,
    };
  }

  return { state: 'declared', owner, declared, detail: null };
}

export function correctionOwnerDeclaration(pullRequest) {
  return parseCorrectionOwner(pullRequest?.body, { headRef: pullRequest?.head?.ref });
}

/**
 * The scope-gate verdict: the detail string to refuse with, or null.
 *
 * Deliberately evaluated in `assessReviewScope`, which both the PR-side
 * `review-scope` job and the trusted controller's `enforceReviewScope` call, so
 * the two cannot drift. `review-scope` is the first CI job and every product job
 * declares `needs: [review-scope]`, so an undeclared owner costs no product
 * battery and no Codex invocation.
 */
export function correctionOwnerProblem(
  pullRequest,
  { enforceAfterPr = CORRECTION_OWNER_ENFORCE_AFTER_PR } = {},
) {
  const number = Number(pullRequest?.number);
  if (!Number.isFinite(number) || number <= enforceAfterPr) return null;
  const declaration = correctionOwnerDeclaration(pullRequest);
  return declaration.state === 'declared' ? null : declaration.detail;
}

// Open, same-repository, targeting the default branch. Ownership now comes from
// the declaration rather than the branch name, so a `codex/**` PR is watched
// too — but a fork head and a non-default base still are not, which keeps the
// existing trust boundary exactly where it was.
export function isCorrectionEligiblePullRequest(pullRequest, repository, defaultBranch) {
  return (
    pullRequest?.state === 'open'
    && pullRequest?.head?.repo?.full_name === repository
    && pullRequest?.base?.repo?.full_name === repository
    && pullRequest?.base?.ref === defaultBranch
  );
}

function ownerLabel(owner) {
  return owner === 'claude' ? 'Claude Code web Auto-fix' : 'The Cursor agent on this branch';
}

// What the loop asks the declared owner to do, per reason. The OWNER decision is
// made once, above; these only phrase it.
function declaredInstruction(owner, { reason, pullRequestNumber }) {
  const who = ownerLabel(owner);
  // An owner GitHub cannot wake gets the same instruction plus the truth about
  // who has to start it. Omitting that is how a routed-but-unstarted correction
  // reads as one in progress.
  const start = AWAKENABLE_FROM_GITHUB.has(owner)
    ? ''
    : ' GitHub cannot start that session, so no correction is in flight until a new head '
      + 'appears on this branch.';
  if (reason === 'ci') {
    return `${who} owns this correction: fix the failed required checks and push one new head. `
      + `Review begins only after CI is green on the exact head.${start}`;
  }
  if (reason === 'scope') {
    return `${who} owns this correction: split the review unit, or complete every `
      + 'justified-large invariant row with concrete risk and verification evidence. '
      + `Editing the PR body reruns the scope gate.${start}`;
  }
  if (reason === 'replacement') {
    return `${who} owns this correction: close this PR without another correction head, open a `
      + 'smaller replacement from current `main` carrying only the unresolved scope, and record '
      + `\`Replaces: #${pullRequestNumber}\` in its body. Every finding remains blocking; no `
      + `safety check is waived.${start}`;
  }
  return `${who} owns this correction: read every current-head Codex finding, reproduce the `
    + `complete set, fix them forward as one coherent batch, and push one new head.${start}`;
}

// And what it says when nobody is declared. It names the defect and the exact
// action that resolves it, and it resolves to no agent — least of all to Claude
// by default, which is the assumption this whole module exists to remove.
function undeclaredInstruction(declaration, { reason, pullRequestNumber }) {
  const opening = `Correction ownership is not established on this PR: ${declaration.detail}. `
    + 'No agent is routed and no correction is in flight.';
  const resume = `Resume action: add exactly one ${MARKER_HELP} marker to the PR body. `
    + 'The edit reruns the scope gate and routes the correction to the declared owner.';
  if (reason === 'replacement') {
    // The replacement POLICY is stated even when no owner is: the remedy does
    // not depend on who performs it, and leaving it out would make an
    // undeclared PR the one place the round limit goes unexplained.
    return `${opening} This unit has also reached the review-round limit: close this PR without `
      + 'another correction head and open a smaller replacement from current `main` carrying '
      + `only the unresolved scope and declaring \`Replaces: #${pullRequestNumber}\`. ${resume}`;
  }
  return `${opening} ${resume}`;
}

/**
 * Route a correction to its declared owner.
 *
 * `state` is `routed` when an owner is known and `correction_stalled` when none
 * is. `mention` is the handle to tag, and is null for every owner GitHub cannot
 * wake — a tag that reaches nobody is a false signal of activity, which is the
 * failure mode this replaces. `awakenable` says whether GitHub can start the
 * named owner at all; the watchdog reads it to decide between a recovery
 * notification and an honest `correction_stalled` report.
 */
export function correctionRouting({
  declaration,
  head = null,
  detail = null,
  reason = 'review',
  pullRequestNumber = null,
} = {}) {
  const resolved = declaration ?? parseCorrectionOwner('');
  if (resolved.state !== 'declared') {
    return {
      owner: null,
      declarationState: resolved.state,
      state: CORRECTION_STALLED,
      awakenable: false,
      mention: null,
      head,
      detail,
      instruction: undeclaredInstruction(resolved, { reason, pullRequestNumber }),
    };
  }

  const awakenable = AWAKENABLE_FROM_GITHUB.has(resolved.owner);
  return {
    owner: resolved.owner,
    declarationState: resolved.state,
    state: 'routed',
    awakenable,
    mention: awakenable ? `@${resolved.owner}` : null,
    head,
    detail,
    instruction: declaredInstruction(resolved.owner, { reason, pullRequestNumber }),
  };
}
