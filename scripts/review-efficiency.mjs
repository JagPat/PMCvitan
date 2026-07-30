export const REVIEW_SCOPE_ENFORCE_AFTER_PR = 246;
export const STANDARD_MAX_FILES = 20;
export const STANDARD_MAX_CHANGED_LINES = 1_500;
export const CONVERGENCE_AFTER_FINDING_HEADS = 2;

// How many finding-bearing heads a DOCS-ONLY review may take before the still-open
// questions must be handed to probes.
//
// The convergence protocol was written for code. On code it terminates, because every
// finding is answered by a RED→GREEN probe and a fix that either works or does not. A
// PLAN has no executable surface: a finding on it can only be answered with more prose,
// and a plan can always be specified further, so the protocol demands a batched audit
// after two heads and then never says when the review is done.
//
// PR #252 is the measurement. Four finding-bearing heads — 8, 8, 7, 7 — every finding
// correct, none contradicted by a later round, and no declining rate. Every finding in
// rounds 2-4 was of the form "the plan does not yet say how X is handled", which is
// always true of a plan at some depth.
//
// THIS IS NOT A DISMISSAL MECHANISM. A finding-dismissal engine was built for this
// repository in PR #250 and withdrawn, because on the first real case it would have
// suppressed a CORRECT finding. Nothing here discounts, filters, or downgrades a finding,
// and the `codex-current-head` status still fails closed on every current-head finding.
// What this bounds is only WHERE the remaining questions get verified: past the cap the
// author must convert each one into a named probe in the plan and name the task whose
// review stop will settle it. The finding is kept and its verification is moved to the
// one place a verification can exist.
export const PLAN_REVIEW_ROUND_CAP = 3;

export const REQUIRED_INVARIANTS = [
  'authorization-tenancy',
  'civil-time-lifecycle',
  'concurrency-idempotency',
  'data-integrity-conservation',
  'offline-reconciliation',
  'ui-server-parity',
];

const CODEX_LOGIN = 'chatgpt-codex-connector[bot]';
const LARGE_MARKER = '<!-- review-size: justified-large -->';
const CONVERGENCE_PACKET = /^docs\/reviews\/[^/]*convergence[^/]*\.md$/iu;

function finiteCount(value) {
  const count = Number(value);
  return Number.isFinite(count) && count >= 0 ? count : 0;
}

export function assessReviewScope(
  pullRequest,
  {
    enforceAfterPr = REVIEW_SCOPE_ENFORCE_AFTER_PR,
    maxFiles = STANDARD_MAX_FILES,
    maxChangedLines = STANDARD_MAX_CHANGED_LINES,
  } = {},
) {
  const additions = finiteCount(pullRequest?.additions);
  const deletions = finiteCount(pullRequest?.deletions);
  const changedFiles = finiteCount(pullRequest?.changed_files);
  const changedLines = additions + deletions;
  const large = changedFiles > maxFiles || changedLines > maxChangedLines;
  const common = {
    changedFiles,
    changedLines,
    large,
    limits: { maxFiles, maxChangedLines },
  };

  if (!large) {
    return { ...common, state: 'standard', allowed: true, missingInvariants: [] };
  }

  if (finiteCount(pullRequest?.number) <= enforceAfterPr) {
    return {
      ...common,
      state: 'grandfathered',
      allowed: true,
      missingInvariants: [],
    };
  }

  const body = String(pullRequest?.body ?? '');
  const sizeDeclaration = /^<!--\s*review-size:\s*(standard|justified-large)\s*-->/iu
    .exec(body.trimStart());
  const justified = sizeDeclaration?.[1]?.toLowerCase() === 'justified-large';
  const tableRows = body
    .split(/\r?\n/u)
    .filter((line) => line.trimStart().startsWith('|'))
    .map((line) => line.split('|').slice(1, -1).map((cell) => cell.trim()));
  const missingInvariants = REQUIRED_INVARIANTS.filter(
    (invariant) => !tableRows.some(
      (cells) => cells[0]?.toLowerCase() === invariant
        && Boolean(cells[1])
        && Boolean(cells[2]),
    ),
  );
  if (!justified || missingInvariants.length > 0) {
    const missing = [
      ...(!justified ? [`the ${LARGE_MARKER} marker`] : []),
      ...(missingInvariants.length > 0
        ? [`invariant matrix rows: ${missingInvariants.join(', ')}`]
        : []),
    ];
    return {
      ...common,
      state: 'blocked',
      allowed: false,
      missingInvariants,
      detail: `Large review unit requires a justified-large marker and complete invariant matrix; missing ${missing.join('; ')}`,
    };
  }

  return {
    ...common,
    state: 'justified_large',
    allowed: true,
    missingInvariants: [],
  };
}

export function codexFindingHeads(comments, reviews = []) {
  const heads = new Set();
  for (const comment of comments ?? []) {
    if (comment?.user?.login !== CODEX_LOGIN) continue;
    const head = comment.original_commit_id ?? comment.commit_id;
    if (typeof head === 'string' && head.length > 0) heads.add(head);
  }
  for (const review of reviews ?? []) {
    if (review?.user?.login !== CODEX_LOGIN) continue;
    const head = review.commit_id;
    if (typeof head === 'string' && head.length > 0) heads.add(head);
  }
  return [...heads];
}

function changedFilename(file) {
  return typeof file === 'string' ? file : file?.filename;
}

// Documentation, for the purpose of "can a finding on this be proven?". Anything that
// runs — a script, a schema, a migration, a test, a workflow, application source — makes
// the diff provable and puts it back under the ordinary code protocol.
//
// A directory name cannot decide that. `docs/probes/x.test.mjs`, `docs/schema.prisma` and
// `docs/ci/deploy.yml` run exactly as they would anywhere else, and a rule that admitted
// everything under `docs/` would hand the deferral escape to a diff whose findings are
// perfectly provable. So a file is documentation only when BOTH its extension and its
// location say so.
//
// The extension test is an ALLOWLIST, deliberately. A blocklist of runnable extensions
// has to anticipate every one that exists and silently admits the ones it missed; an
// allowlist treats an unrecognised extension as code, which is the direction that fails
// closed. An empty diff is not a plan review either; it is a broken read, and it also
// fails toward the strict path.
const DOCS_EXTENSION = /\.(?:md|mdx|txt|rst|svg|png|jpe?g|gif|webp|pdf)$/iu;
const DOCS_LOCATION = /^(?:docs\/.+|\.github\/.+|[^/]+)$/u;

function isDocumentation(name) {
  return DOCS_EXTENSION.test(name) && DOCS_LOCATION.test(name);
}

// Every path a diff entry TOUCHES. A rename touches two: GitHub reports it as
// `status: 'renamed'` with `filename` set to the new path and `previous_filename` to the
// old one, so reading only `filename` let `scripts/old-gate.mjs` → `docs/old-gate.md`
// present as pure documentation while runnable code was removed. A rename is a removal
// plus an addition, and both sides have to be classified.
function changedPaths(file) {
  if (typeof file === 'string') return [file];
  return [file?.filename, file?.previous_filename]
    .filter((name) => typeof name === 'string' && name.length > 0);
}

export function isDocsOnlyDiff(changedFiles) {
  // Every entry, INCLUDING removals and renames. Deleting `scripts/old-gate.mjs` — or
  // moving it out from under that name — changes what runs just as surely as editing it,
  // so such a diff is provable and is not a plan review. (The convergence-PACKET check
  // below keeps its own `removed` filter and reads only `filename`: there the question is
  // whether the head ADDS the audit at that path, which the surviving name answers.)
  const names = (changedFiles ?? []).flatMap((file) => changedPaths(file));
  return names.length > 0 && names.every((name) => isDocumentation(name));
}

// The deferral names the TASK that will settle the deferred findings, so the handoff is
// schedulable rather than an assertion that the review is over. A bare marker ("yes",
// "complete", "done") schedules nothing and is refused.
const DEFERRAL_TRAILER = 'review-deferred-to-probes';
// The trailer names THE TASK whose review stop settles the deferred questions, so the value
// must be a task reference. This was a BLOCKLIST of bare words, which is the exact mistake
// this PR's own round-2 remedy argued against for file extensions: a blocklist has to
// anticipate every placeholder that exists and silently admits the ones it missed, so
// `Review-Deferred-To-Probes: later` was accepted as a scheduled handoff. An ALLOWLIST treats
// an unrecognised value as no task at all — the direction that fails closed. The two shapes
// are this repository's own task vocabulary, the same strings `docs/STATUS.md` uses for
// `next_task`/`work_item`.
const TASK_REFERENCE = /^phase-(?<phase>\d+)-(?:task-\d+|planning)$/iu;

// A shape-valid value can still name a review stop that does not exist:
// `phase-999-task-999` parses and schedules nothing. The PHASE is checkable against
// `docs/STATUS.md`, which is a machine-readable state file with an existing parser — so this is
// a structured-field read, not the prose parsing withdrawn below. Acceptable phases are the
// CURRENT one and the one `next_task` names: a deferral belongs to the phase under review, and
// pointing at a later phase is a scope change disguised as a deferral, not a handoff.
//
// The task INDEX inside a valid phase is NOT checked. It lives in the plan's markdown task
// table, and reading that is the prose parsing this PR withdrew. AGENTS.md asks the reviewer to
// flag a deferral naming a task the plan does not define.
export function deferralPhases(now) {
  const phases = new Set();
  const current = Number.parseInt(String(now?.phase ?? '').trim(), 10);
  if (Number.isInteger(current)) phases.add(current);
  const next = TASK_REFERENCE.exec(String(now?.next_task ?? '').trim());
  if (next) phases.add(Number.parseInt(next.groups.phase, 10));
  return [...phases];
}

function messageTrailers(message) {
  const blocks = String(message ?? '').trimEnd().split(/\n[\t ]*\n/u);
  if (blocks.length < 2) return [];
  const trailers = [];
  for (const line of blocks.at(-1).split('\n')) {
    if (/^[\t ]+\S/u.test(line)) {
      if (trailers.length === 0) return [];
      trailers.at(-1)[1] += ` ${line.trim()}`;
      continue;
    }
    const trailer = /^([A-Za-z0-9][A-Za-z0-9-]*):[\t ]+(.+)$/u.exec(line);
    if (!trailer) return [];
    trailers.push([trailer[1].toLowerCase(), trailer[2].trim()]);
  }
  return trailers;
}

export function deferredToProbes(message) {
  for (const [key, value] of messageTrailers(message)) {
    if (key !== DEFERRAL_TRAILER) continue;
    const target = value.trim();
    if (!TASK_REFERENCE.test(target)) return null;
    return target;
  }
  return undefined;
}

// The deferral LEDGER is deliberately NOT gate-verified. Read this before adding it back.
//
// Four rounds of this PR tried to verify it mechanically — a keyword, then a row shape, then a
// header exclusion, then a complete artifact definition with a plan cross-reference. Each was
// defeated by a new input, and the round that defeated the "complete" definition settled the
// question rather than adding a fifth clause:
//
//   - a ledger is a mapping from QUESTIONS to probes, and the definition specified only the
//     probe side, so `- probe 5w` under the heading passed with no question anywhere;
//   - `planDefinesProbe` could not tell a probe declaration from an ordinary numbered list
//     item, so `probe 5` matched the plan line `5. **Task 5 — frontend surfaces**`.
//
// Neither is answerable without reading for MEANING. Is this row a question? Is that numbered
// line a probe or a task heading? Those are judgements, which puts them on the reviewer's side
// of the line this repository already draws — the PR #250 line, where a mechanism that scored
// substance was withdrawn because on its first real case it would have suppressed a correct
// finding. The line was right; I had drawn it in the wrong place and defended it for four
// rounds.
//
// And the check was guarding a door that opens onto a wall. `guardAgainstCurrentHeadFinding`
// runs AFTER convergence and fails closed on every current-head finding, so a deferral buys an
// author NOTHING that a clean review would not already give them. There is no incentive to
// forge a ledger, and no outcome a forged one changes.
//
// So what remains is the one thing that is mechanically decidable without interpretation: the
// trailer must name a TASK (see TASK_REFERENCE). The ledger itself is an author obligation
// stated in AGENTS.md and judged by the reviewer, which is where a question about whether
// enough thinking happened belongs.

const CONVERGENCE_MARKER = /^[\t ]*review-convergence:[\t ]+complete[\t ]*$/imu;

function hasConvergenceTrailer(message) {
  const blocks = String(message ?? '').trimEnd().split(/\n[\t ]*\n/u);
  if (blocks.length < 2) return false;
  const lines = blocks.at(-1).split('\n');
  const trailers = [];
  for (const line of lines) {
    if (/^[\t ]+\S/u.test(line)) {
      if (trailers.length === 0) return false;
      trailers.at(-1)[1] += ` ${line.trim()}`;
      continue;
    }
    const trailer = /^([A-Za-z0-9][A-Za-z0-9-]*):[\t ]+(.+)$/u.exec(line);
    if (!trailer) return false;
    trailers.push([trailer[1].toLowerCase(), trailer[2].trim().toLowerCase()]);
  }
  return trailers.some(
    ([key, value]) => key === 'review-convergence' && value === 'complete',
  );
}

// Git reads trailers from the LAST paragraph only, and only when every line in
// it is a `Key: value` trailer. So the marker can be present and still not be a
// trailer — a blank line above it demotes it to body text, and a prose line
// anywhere in that final block invalidates the whole block. Both are ordinary
// authoring mistakes, and "missing trailer" alone reads as "you forgot it" when
// the line is right there. Naming the real cause turns a wasted round into a
// one-line fix. The hint states the rule rather than guessing which of the two
// it is, so it is never wrong about the cause.
export function convergenceTrailerHint(message) {
  if (hasConvergenceTrailer(message)) return null;
  return CONVERGENCE_MARKER.test(String(message ?? ''))
    ? 'trailer (the line is present but git does not parse it as a trailer: it '
      + 'must be in the final block of the message, and every line in that '
      + 'block must be a "Key: value" trailer)'
    : 'trailer';
}

export function assessConvergence({
  comments,
  reviews,
  headMessage,
  changedFiles,
  pullRequestFiles,
  activePhases,
}) {
  const findingHeads = codexFindingHeads(comments, reviews);
  const findingHeadCount = findingHeads.length;
  if (findingHeadCount < CONVERGENCE_AFTER_FINDING_HEADS) {
    return {
      required: false,
      allowed: true,
      findingHeadCount,
      findingHeads,
      missing: [],
    };
  }

  const hasTrailer = hasConvergenceTrailer(headMessage);
  const hasPacket = (changedFiles ?? [])
    .some((file) => {
      const filename = changedFilename(file);
      return file?.status !== 'removed'
        && typeof filename === 'string'
        && CONVERGENCE_PACKET.test(filename);
    });
  // Past the cap, a docs-only review also owes the probe deferral: each still-open
  // question named, with the probe and the task that will settle it. See
  // PLAN_REVIEW_ROUND_CAP — this adds an obligation, it never removes one.
  //
  // Judged on the PR's CUMULATIVE diff, not on `changedFiles` (this head's commit). A
  // code PR's convergence head is very often the packet alone, and reading that one
  // commit would classify the whole review as a plan review and block it pending a
  // deferral trailer that means nothing for it. `changedFiles` keeps its own meaning
  // above — whether THIS head carries the audit — which is a per-head question.
  //
  // A cumulative diff we could not read is not evidence of anything, so it falls to the
  // CODE path: the ordinary convergence obligations stand and no deferral is demanded on
  // a review that may well be provable.
  const deferralRequired = Array.isArray(pullRequestFiles)
    && isDocsOnlyDiff(pullRequestFiles)
    && findingHeadCount >= PLAN_REVIEW_ROUND_CAP;
  const deferral = deferralRequired ? deferredToProbes(headMessage) : undefined;

  const missing = [
    ...(!hasTrailer ? [convergenceTrailerHint(headMessage)] : []),
    ...(!hasPacket ? ['packet'] : []),
    ...(deferralRequired && deferral === undefined
      ? [`a "Review-Deferred-To-Probes: <task>" trailer — after ${PLAN_REVIEW_ROUND_CAP} `
        + 'finding-bearing heads a docs-only review must hand its remaining open '
        + 'questions to named probes instead of answering them with more prose']
      : []),
    ...(deferralRequired && deferral === null
      ? ['the Review-Deferred-To-Probes value must name the TASK that will settle the '
        + 'deferred findings, in this repository\'s own task vocabulary '
        + '("phase-<n>-task-<m>" or "phase-<n>-planning"); a bare marker or a word like '
        + '"later" schedules nothing']
      : []),
    // A shape-valid task in a phase this repository is not working on schedules nothing
    // either. Checked only when the phase set could be read; an unreadable STATUS is not
    // evidence that the task is fake.
    ...(deferralRequired && typeof deferral === 'string'
      && Array.isArray(activePhases) && activePhases.length > 0
      && !activePhases.includes(
        Number.parseInt(TASK_REFERENCE.exec(deferral).groups.phase, 10),
      )
      ? [`"${deferral}" names phase `
        + `${Number.parseInt(TASK_REFERENCE.exec(deferral).groups.phase, 10)}, but `
        + `docs/STATUS.md puts this repository in phase ${activePhases.join(' or ')}. A `
        + 'deferral hands work to a review stop in the phase under review; a later phase is a '
        + 'scope change, not a handoff']
      : []),
    // A trailer naming a task, with a packet that records no handoff, is the bare marker
    // wearing a task name: nothing is actually scheduled. The obligation has always been
    // trailer AND ledger (AGENTS.md, and this repo's own packets say so); only the trailer
    // half was enforced.
  ];
  return {
    required: true,
    allowed: missing.length === 0,
    findingHeadCount,
    findingHeads,
    hasTrailer,
    hasPacket,
    deferralRequired,
    deferredTo: deferral ?? null,
    missing,
  };
}
