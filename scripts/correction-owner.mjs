import { CORRECTION_OWNERS, AWAKENABLE_FROM_GITHUB, CORRECTION_STALLED } from './review-policy.mjs';
export { CORRECTION_OWNERS, AWAKENABLE_FROM_GITHUB, CORRECTION_STALLED } from './review-policy.mjs';

// Parse a declared owner and render a correction instruction. Supported owners
// and wake capabilities are defined once in review-policy.mjs, a dependency-free
// leaf shared with the scope gate and watchdog. Agent session liveness cannot be
// inferred from a PR author or branch name; docs/POLICY.md states that contract.

const DECLARATION = /<!--\s*correction-owner:\s*([A-Za-z][A-Za-z0-9_-]*)\s*-->/gu;
// Branch names are historical source locations, not authorship assertions. The explicit
// declaration is authoritative, including for retained claude/** branches.
const MARKER_HELP = '`<!-- correction-owner: claude -->`, `<!-- correction-owner: cursor -->`, or `<!-- correction-owner: codex -->`';

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
  return { declared };
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
  const { declared } = declarationBlock(body);

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

  return { state: 'declared', owner, declared, detail: null };
}

// Immutable, commit-addressed correction ownership.
//
// The authoritative correction owner of an EXACT head is declared by a single
// `Correction-Owner:` trailer line in THAT head commit's message. Because the message is
// content-addressed by the commit SHA, this owner cannot change without a new commit — a new
// head — and re-running every check. A pull-request BODY edit is descriptive only (routing,
// notices, the scope gate) and never redefines it. Callers verify the server-returned commit
// SHA equals the expected head before trusting the message, so a moved head is never read as
// this head's owner, and resolve the SAME owner for the same head across fresh objects and
// independently restarted runs.
//
// Fail closed: no trailer, more than one trailer (even the same owner twice), two different
// owners, or an unknown owner all yield no authoritative owner.
//
// Ownership is read ONLY from the commit's terminal trailer block — the last paragraph, and
// only when it is separated from the body by a blank line and consists entirely of Git trailer
// lines (`Token: value` / `Token:value`, or a folded continuation). This matches how Git's own
// trailer parser scopes trailers, so a `Correction-Owner:` line in the body or inside a fenced
// code example never confers ownership, and a second declaration Git would honour — including
// the no-space `Correction-Owner:codex` form — is SEEN here and rejected as conflicting rather
// than silently dropped by a stricter whitespace rule. Anything malformed fails closed.

// A Git trailer token is alphanumerics and '-', then ':'; the value (spaced or not) is optional.
const TRAILER_LINE = /^[A-Za-z0-9][A-Za-z0-9-]*:/u;
// A folded continuation of the previous trailer begins with whitespace.
const TRAILER_CONTINUATION = /^[ \t]+\S/u;
// A clean single-token owner value.
const OWNER_VALUE = /^[A-Za-z][A-Za-z0-9_-]*$/u;

function terminalTrailerBlock(commitMessage) {
  const lines = String(commitMessage ?? '').replace(/\r\n?/gu, '\n').split('\n');
  while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop();
  if (lines.length === 0) return null;
  // Walk up from the end while every line is a trailer or a folded continuation.
  let start = lines.length;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (TRAILER_LINE.test(lines[index]) || TRAILER_CONTINUATION.test(lines[index])) {
      start = index;
      continue;
    }
    break;
  }
  if (start === lines.length) return null; // the message does not end in a trailer line
  // The terminal trailer block must be a distinct paragraph: preceded by a blank line, never the
  // whole message (which would have no subject/body) and never glued to body prose.
  if (start === 0 || lines[start - 1].trim() !== '') return null;
  return lines.slice(start);
}

export function parseCommitCorrectionOwner(commitMessage) {
  const block = terminalTrailerBlock(commitMessage);
  if (!block) {
    return { state: 'missing', owner: null, declared: [] };
  }
  // Reconstruct trailers exactly as Git folds them: a whitespace-led continuation joins the
  // previous trailer's value. A continuation attached to the owner trailer is therefore VALIDATED
  // as part of the owner value (Git reads `claude\n codex` as the single value "claude codex"),
  // never silently dropped so a multi-token declaration slips through as clean.
  const trailers = [];
  for (const line of block) {
    if (TRAILER_CONTINUATION.test(line) && trailers.length > 0) {
      trailers[trailers.length - 1].value += `\n${line.trim()}`;
      continue;
    }
    const separator = line.indexOf(':');
    if (separator < 0) continue; // defensive; the block admits only trailer/continuation lines
    trailers.push({
      key: line.slice(0, separator),
      value: line.slice(separator + 1).replace(/^[ \t]+/u, ''),
    });
  }
  // Git recognises trailer keys case-insensitively, so `correction-owner:` is the same key as
  // `Correction-Owner:` — a second declaration in either spelling is a conflict, not ignorable.
  const declared = trailers
    .filter((trailer) => trailer.key.toLowerCase() === 'correction-owner')
    .map((trailer) => trailer.value.trim());
  if (declared.length === 0) {
    return { state: 'missing', owner: null, declared };
  }
  // Any duplicate or conflicting declaration in the block fails closed — a real transfer is a
  // new commit with a single clean declaration, never two competing lines on one head.
  if (declared.length > 1 || new Set(declared.map((value) => value.toLowerCase())).size > 1) {
    return { state: 'conflicting', owner: null, declared };
  }
  const [raw] = declared;
  if (!OWNER_VALUE.test(raw)) {
    return { state: 'invalid', owner: null, declared };
  }
  const owner = raw.toLowerCase();
  if (!CORRECTION_OWNERS.includes(owner)) {
    return { state: 'invalid', owner: null, declared };
  }
  return { state: 'declared', owner, declared };
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
  if (owner === 'claude') return 'Claude Code web Auto-fix';
  if (owner === 'codex') return 'The Codex coding owner on this branch';
  return 'The Cursor agent on this branch';
}


// What the loop asks the declared owner to do, per reason. The OWNER decision is
// made once, above; these only phrase it.
function declaredInstruction(owner, { reason, detail }) {
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
    : ' The configured GitHub loop can neither start that session nor observe whether it is already running, so '
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

  return `${who} owns this correction: read every current-head Codex finding, reproduce the `
    + `complete set, fix them forward as one coherent batch, and push one new head.${start}`;
}

// And what it says when nobody is declared. It names the defect and the exact
// action that resolves it, and it resolves to no agent — least of all to Claude
// by default, which is the assumption this whole module exists to remove.
function undeclaredInstruction(declaration) {
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
} = {}) {
  const resolved = declaration ?? parseCorrectionOwner('');
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
