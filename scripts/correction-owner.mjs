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
 * EXACTLY ONE marker, not merely one distinct owner. An earlier draft
 * deduplicated first and accepted a marker repeated twice, on the reasoning that
 * an author editing the template's marker in place should not be blocked for
 * tidiness — which had it backwards: editing in place produces ONE marker, and a
 * duplicate comes from ADDING a line, the same slip that produces a
 * contradiction. AGENTS.md, CLAUDE.md and the PR template all say exactly one,
 * so the parser now says it too.
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

  // One owner named more than once is malformed rather than contradictory —
  // nothing conflicts, the contract is simply not met — so it reports as
  // `invalid` and the recovery text below tells the author to replace, not add.
  if (declared.length > 1) {
    return {
      state: 'invalid',
      owner: null,
      declared,
      detail: `the correction owner is declared ${declared.length} times; exactly one `
        + `${MARKER_HELP} marker is required`,
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

/**
 * Whether a pull request is inside the correction watchdog's remit.
 *
 * Deliberately NOT `isAutonomousPullRequest`, which additionally requires a
 * `claude/**` branch: the whole point of the declaration is that a correction
 * owner is not inferable from the branch, and PR #350 — the Cursor-owned unit
 * that started this work — was on `codex/**`. Every same-repository pull request
 * targeting the default branch is watched, and the declaration in its body
 * decides who is asked.
 *
 * The same-repository and default-branch conditions are the existing trust
 * boundary and are unchanged: a fork head is never watched, and nothing here
 * runs untrusted code.
 */
export function isCorrectionEligiblePullRequest(pullRequest, repository, defaultBranch) {
  return (
    pullRequest?.state === 'open'
    && pullRequest?.head?.repo?.full_name === repository
    && pullRequest?.base?.repo?.full_name === repository
    && pullRequest?.base?.ref === defaultBranch
  );
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
 *
 * EVERY pull request, with no exemption by number. An earlier draft grandfathered
 * PRs at or below #350 so that #349 and #350 — open at the time, and off-limits
 * to edit — were not retroactively blocked. Both are closed now, as is every
 * other PR in that range, so the carve-out protected nothing and contradicted
 * the contract it was written beside: a PR inside it could pass `review-scope`
 * with no owner and then route to nobody on its first finding.
 */
export function correctionOwnerProblem(pullRequest) {
  const declaration = correctionOwnerDeclaration(pullRequest);
  return declaration.state === 'declared' ? null : declaration.detail;
}

function ownerLabel(owner) {
  return owner === 'claude' ? 'Claude Code web Auto-fix' : 'The Cursor agent on this branch';
}

// What the loop asks the declared owner to do, per reason. The OWNER decision is
// made once, above; these only phrase it.
function declaredInstruction(owner, { reason, pullRequestNumber, detail }) {
  const who = ownerLabel(owner);
  // An owner GitHub cannot wake gets the same instruction plus the truth about
  // who has to start it. Omitting that is how a routed-but-unstarted correction
  // reads as one in progress.
  //
  // It says only what GitHub actually knows. An earlier wording added "so no
  // correction is in flight until a new head appears on this branch", and both
  // halves are unobservable from here: a human may have started the session
  // already, and a scope refusal is routinely cleared by editing the PR body
  // with no new head at all. Reporting that as stalled invites a duplicate
  // intervention. Detecting whether the named owner ever started is the
  // correction lease, a separate unit; until it exists this notice reports the
  // routing and stops there.
  const start = AWAKENABLE_FROM_GITHUB.has(owner)
    ? ''
    : ' GitHub can neither start that session nor observe whether it is already running, so '
      + 'this notice reports the routing only, never whether the correction has begun.';
  if (reason === 'ci') {
    return `${who} owns this correction: fix the failed required checks and push one new head. `
      + `Review begins only after CI is green on the exact head.${start}`;
  }
  if (reason === 'scope') {
    // The VERDICT leads, because the scope gate publishes several and they have
    // different remedies — an undeclared correction owner, replacement lineage,
    // an unchecked pre-review item, a missing migration seam, and the review
    // unit's size. Naming only the size remedy sent every other verdict an
    // actionable instruction that could not clear it, and the lease publishes
    // once per head, so the wrong instruction is the only one that arrives.
    const verdict = typeof detail === 'string' && detail.trim().length > 0
      ? `\`${detail.trim()}\``
      : 'the verdict on the required status';
    const size = /justified-large|invariant matrix|Large review unit/iu.test(String(detail ?? ''))
      ? ' Here that means: split the review unit, or complete every justified-large '
        + 'invariant row with concrete risk and verification evidence.'
      : '';
    return `${who} owns this correction: resolve the scope verdict this head is failing on — `
      + `${verdict}.${size} Editing the PR body reruns the scope gate, so most scope verdicts `
      + `clear with no new head.${start}`;
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

// A failure the review gate recovers from — by being RE-DISPATCHED. It renders
// the command, filled in, because nothing triggers that recovery on its own:
// `auto-merge.yml` recovers only through `workflow_dispatch`, and `request-recovery`
// rejects a missing or wrong `terminal_status_id`. A notice that asks for nothing
// AND cannot be executed as written leaves the pull request in draft indefinitely.
function recoveryInstruction(declaration, { head, pullRequestNumber, statusId, precondition }) {
  // ORDER MATTERS. The dispatched `orchestrate` job runs `enforceReviewScope` on
  // this same exact head, and ownership is required at every PR number since
  // #358 — so dispatching first would only replace this retryable failure with a
  // scope failure. The repair is a body edit and needs no new head.
  const repairFirst = declaration.state !== 'declared'
    ? ' FIRST repair the correction-owner declaration: the recovery re-runs `review-scope` on '
      + `this same head, and it will refuse it (${declaration.detail}). Put exactly one `
      + '`<!-- correction-owner: claude -->` or `<!-- correction-owner: cursor -->` marker in the '
      + 'marker block at the top of the PR body — a body edit, no new head. Then dispatch.'
    : '';
  return 'No correction is owed on this head: the review gate did not reach a verdict, so there '
    + 'is nothing to read and nothing to fix. Do not push a new head — it would invalidate the '
    + `exact head being recovered and restart CI without resolving the failure.${repairFirst} `
    + 'Recovery is a re-dispatch of the `Autonomous review and merge` workflow, which runs only '
    + `on \`workflow_dispatch\`. Run it ${precondition ?? 'once the gate is able to review again'}, `
    + `with \`pr_number=${pullRequestNumber ?? '<this PR>'}\`, `
    + `\`head_sha=${head ?? '<this exact head>'}\` and `
    + `\`terminal_status_id=${statusId ?? '<the failing codex-current-head status id>'}\`. `
    + 'The gate authorises that request against the exact head and status id.';
}

// And what it says when nobody is declared. It names the defect and the exact
// action that resolves it, and it resolves to no agent — least of all to Claude
// by default, which is the assumption this whole module exists to remove.
function undeclaredInstruction(declaration, { reason, pullRequestNumber }) {
  const opening = `Correction ownership is not established on this PR: ${declaration.detail}. `
    + 'No agent is routed and no correction is in flight.';
  // ADD only when the block is empty. Told to a body that already carries a
  // marker — an unknown agent, two owners, a duplicate, or one the branch
  // contradicts — "add one" leaves TWO declarations, which parses as
  // contradictory and keeps review-scope blocked. The recovery text has to
  // resolve the state it is actually addressed to.
  const resume = declaration.state === 'missing'
    ? `Resume action: add exactly one ${MARKER_HELP} marker to the marker block at the top of `
      + 'the PR body. The edit reruns the scope gate and routes the correction to the declared '
      + 'owner.'
    : `Resume action: replace the correction-owner marker(s) in the PR body with exactly one `
      + `${MARKER_HELP}, leaving no other declaration in the block. The edit reruns the scope `
      + 'gate and routes the correction to the declared owner.';
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
 * is. `awakenable` says whether GitHub can start the named owner at all, which
 * decides how the instruction phrases who must begin the work.
 *
 * There is deliberately NO `mention` here. Naming an owner and WAKING one are
 * different jobs, and this unit does only the first. A mention is actionable
 * only as a NEW comment — an edit to the sticky creates no notification, so it
 * wakes nothing — and posting one exactly once per pull request, head and owner
 * is the correction lease, which is its own unit. Returning a handle with no
 * publisher is how this lineage produced three "computed but never asked"
 * findings; the handle ships WITH its publisher or not at all.
 */
export function correctionRouting({
  declaration,
  head = null,
  detail = null,
  reason = 'review',
  pullRequestNumber = null,
  statusId = null,
  precondition = null,
} = {}) {
  const resolved = declaration ?? parseCorrectionOwner('');
  // A gate-retryable failure owes NOBODY a correction, so it is answered before
  // the declaration is consulted. Routed through the undeclared branch it picked
  // up "Resume action: add exactly one marker…", telling someone to fix a
  // declaration so that they could correct a failure a correction cannot fix.
  // The declaration defect is real and is still named — `review-scope` refuses
  // the next head over it — but naming is not the same as asking.
  if (reason === 'recovery') {
    return {
      owner: resolved.state === 'declared' ? resolved.owner : null,
      declarationState: resolved.state,
      state: 'routed',
      awakenable: false,
      head,
      detail,
      instruction: recoveryInstruction(resolved, {
        head, pullRequestNumber, statusId, precondition,
      }),
    };
  }
  if (resolved.state !== 'declared') {
    return {
      owner: null,
      declarationState: resolved.state,
      state: CORRECTION_STALLED,
      awakenable: false,
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
    head,
    detail,
    instruction: declaredInstruction(resolved.owner, { reason, pullRequestNumber, detail }),
  };
}
