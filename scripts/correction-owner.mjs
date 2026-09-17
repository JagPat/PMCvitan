import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CORRECTION_OWNERS, AWAKENABLE_FROM_GITHUB, CORRECTION_STALLED } from './review-policy.mjs';
export { CORRECTION_OWNERS, AWAKENABLE_FROM_GITHUB, CORRECTION_STALLED } from './review-policy.mjs';

// Parse a declared owner and render a correction instruction. Supported owners
// and wake capabilities are defined once in review-policy.mjs, a dependency-free
// leaf shared with the scope gate and watchdog. Agent session liveness cannot be
// inferred from a PR author or branch name; docs/POLICY.md states that contract.

const DECLARATION = /<!--\s*correction-owner:\s*([A-Za-z][A-Za-z0-9_-]*)\s*-->/gu;
// docs/POLICY.md reserves this prefix for Claude-authored work, so a
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

// ── HEAD-bound owner parsing/resolution primitives (Owner primitive unit) ────────────────────────────
// Read the exact HEAD commit's terminal `Correction-Owner:` trailer as authority. These primitives change
// NO gate, wake, merge, handoff, watchdog, continuation, or authoritative consumer — no caller in this unit
// routes on them. Admission (three-valued holds, codex candidacy) and exact-head merge authorization are
// later units that will consume the merged primitive; here it only parses and resolves.
//
// Trailer extraction is DELEGATED to real `git interpret-trailers --parse --unfold`, not reimplemented. A
// hand-rolled reproduction of git's trailer grammar repeatedly diverged from git on adversarial input — the
// comment/continuation interaction, the exact recognized-token spelling (`Signed-off-by` only, and not when
// space-padded), the `(cherry picked from commit …)` provenance suffix, the trailer-token grammar (`-X:` is
// a valid token), and continuation reset after a dropped non-trailer line. Delegating makes the primitive
// git itself for the extraction step, so it cannot diverge as further git edge cases surface. It fails
// CLOSED: a missing or erroring git yields `unreadable` and never an owner, which a later consumer must
// treat as no merge authority.
const OWNER_VALUE = /^[A-Za-z][A-Za-z0-9_-]*$/u;
// Strip only git's ASCII horizontal padding (never Unicode whitespace, which git preserves in the value).
const asciiTrim = (value) => value.replace(/^[ \t]+|[ \t]+$/gu, '');

// The terminal trailers of a commit message, exactly as `git interpret-trailers --parse --unfold` emits
// them: `Key: value` lines with folded continuations already joined. The message is fed on STDIN, never as
// an argument, so no content can be read as a flag. Returns null when git cannot be run at all (binary
// missing or non-zero exit), so the caller fails closed rather than reading an unreadable commit as owning
// nothing.
// A single empty directory pointed at by `GIT_DIR`, so git uses it AS the repository and never discovers
// the ambient one from the working directory. It stays empty (`--parse` reads config, writes nothing), so
// it holds no local config; created lazily and reused. Discovery matters because a repository's local
// config — including a `trailer.<name>.key` that changes block recognition — would otherwise be read, and
// `GIT_DIR`/`GIT_WORK_TREE`/a repo-inside-`TMPDIR` are all repository-selection inputs that no
// `GIT_CEILING_DIRECTORIES` reliably fences once the cwd is inside a repo.
let cleanGitDir;
function isolatedGitDir() {
  if (!cleanGitDir) cleanGitDir = mkdtempSync(join(tmpdir(), 'owner-trailer-gitdir-'));
  return cleanGitDir;
}

// The environment that ISOLATES git from every external config source, so `--parse` depends only on the
// config this module pins and never on the runner. Every inherited `GIT_*` variable is dropped (config
// sources AND repository-selection inputs — `GIT_DIR`, `GIT_WORK_TREE`, `GIT_CONFIG*`, …); global
// (`~/.gitconfig`) and system (`/etc/gitconfig`) are redirected to `/dev/null` with `GIT_CONFIG_NOSYSTEM`;
// and `GIT_DIR` is set to the empty directory above so git reads no local repository config. The remaining
// config comes only from the command-line `-c` flags this module passes.
function isolatedGitEnv() {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith('GIT_')) continue;
    env[key] = value;
  }
  env.GIT_DIR = isolatedGitDir();
  env.GIT_CONFIG_GLOBAL = '/dev/null';
  env.GIT_CONFIG_SYSTEM = '/dev/null';
  env.GIT_CONFIG_NOSYSTEM = '1';
  return env;
}

function gitParsedTrailers(commitMessage) {
  let out;
  try {
    // Pin the two config keys that still shape `--parse` output under the isolated environment above:
    // `trailer.separators` decides the accepted AND output separator (its first character), and
    // `core.commentChar` decides which comment lines `--parse` strips.
    out = execFileSync('git', [
      '-c', 'trailer.separators=:',
      '-c', 'core.commentChar=#',
      'interpret-trailers', '--parse', '--unfold',
    ], {
      input: String(commitMessage ?? ''),
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'ignore'],
      maxBuffer: 8 * 1024 * 1024,
      cwd: isolatedGitDir(),
      env: isolatedGitEnv(),
    });
  } catch {
    return null;
  }
  const trailers = [];
  for (const line of out.split('\n')) {
    if (line.length === 0) continue;
    const separator = line.indexOf(':');
    if (separator < 0) continue;
    trailers.push({ key: asciiTrim(line.slice(0, separator)), value: line.slice(separator + 1) });
  }
  return trailers;
}

/**
 * The HEAD-bound owner from the exact commit message's terminal trailer block, read AS
 * `git interpret-trailers --parse` reads it (extraction delegated to git). Named states: `declared`
 * (exactly one terminal `Correction-Owner:` trailer naming a known owner), `missing` (no terminal trailer
 * block, or none named), `conflicting` (more than one, or disagreeing values), `invalid` (a malformed
 * value, or one no correction owner), and `unreadable` (git could not be run, so the commit's owner cannot
 * be determined and a consumer must fail closed). `declared` (the array) always carries the raw trailer
 * value(s) found, so a later consumer can see a value this loop does not route to. Owner admission is
 * unchanged from `CORRECTION_OWNERS`.
 */
export function parseCommitCorrectionOwner(commitMessage) {
  const trailers = gitParsedTrailers(commitMessage);
  if (trailers === null) {
    return { state: 'unreadable', owner: null, declared: [] };
  }
  // ASCII-trim only: git preserves non-ASCII whitespace (vertical tab, NBSP, em-space) IN the value, so a
  // value padded with it stays malformed and fails `OWNER_VALUE` rather than being silently accepted.
  const declared = trailers
    .filter((trailer) => trailer.key.toLowerCase() === 'correction-owner')
    .map((trailer) => asciiTrim(trailer.value));
  if (declared.length === 0) {
    return { state: 'missing', owner: null, declared };
  }
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
 * HEAD-bound owner agreement — a resolution primitive for the later consumers (review gate, conflict
 * handoff, watchdog) that will hold a fetched commit. The exact commit's single terminal `Correction-Owner:`
 * trailer must name a valid owner AND agree with the PR body marker; `consistent` is false for a
 * missing/invalid/disagreeing trailer or an `unreadable` commit (git could not be run). `headRef` is passed
 * through to the body parse so a `claude/**` branch that declares another owner reads as `contradictory`
 * (bodyOwner null → not consistent), the same branch-reservation rule the scope gate applies; omitting it
 * would accept a head+body owner the branch contract forbids. No consumer in this unit calls it; it fails
 * closed so a later caller never wakes a body owner the immutable head does not confirm.
 */
export function headBoundOwnerAgreement(commitMessage, body, { headRef } = {}) {
  const trailer = parseCommitCorrectionOwner(commitMessage);
  const headOwner = trailer.state === 'declared' ? trailer.owner : null;
  const bodyDeclaration = parseCorrectionOwner(body, { headRef });
  const bodyOwner = bodyDeclaration.state === 'declared' ? bodyDeclaration.owner : null;
  const consistent = headOwner !== null && bodyOwner !== null && headOwner === bodyOwner;
  return { headOwner, bodyOwner, consistent, trailerState: trailer.state };
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
