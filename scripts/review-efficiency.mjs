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
const BARE_DEFERRAL = new Set(['yes', 'true', 'complete', 'done', 'ok', 'n/a', 'none']);

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
    if (target.length === 0 || BARE_DEFERRAL.has(target.toLowerCase())) return null;
    return target;
  }
  return undefined;
}

// Does the packet record the handoff the trailer claims?
//
// The trailer is the author's ASSERTION that the remaining questions moved to probes; the
// packet ledger is the assertion's content. Accepting the trailer alone made the deferral
// exactly the bare marker the bare-marker rule refuses — a task name and nothing scheduled.
//
// TWO things are required, and both are syntax:
//   1. the packet names the task the trailer defers to — the two artifacts must describe the
//      same handoff;
//   2. it carries at least one LEDGER ENTRY: a table row or list item that names a probe.
//
// (2) is the difference between a ledger and a sentence. A ledger is a MAPPING — one entry
// per deferred question, each pointing at the probe that adjudicates it — so "phase-5-task-1
// has probes elsewhere" satisfies the vocabulary and records no mapping at all. Requiring an
// ENTRY rather than a keyword is still purely structural: distinguishing a row from a
// paragraph needs no opinion about what the row says.
//
// What this deliberately does NOT do is judge whether the ledger is adequate — whether the
// questions are the right questions, or the probes really settle them. That is the whole
// lesson of PR #250, where a mechanism that scored SUBSTANCE would have suppressed a correct
// finding on its first real case. Structure is mechanical; adequacy is the reviewer's.
//
// Table, bullet, or numbered entries all count. Pinning one markdown format would block an
// author who wrote a perfectly good ledger the other way, which is a false refusal and the
// same class of defect as this PR's first finding.
// An entry NAMES a probe; a header LABELS the column. `| Question | Probe | Settled by |`
// is structurally a row and mentions the word, and accepting it let a table of nothing but a
// header and a separator satisfy the ledger. So the probe reference must carry an IDENTIFIER:
// strip the word from the cell that mentions it and something must remain (`probe 5w` → `5w`;
// a bare `Probe` → nothing). Separator rows (`|---|---|`) are excluded for the same reason.
const LEDGER_ROW = /^[\t ]*(?:\|(?<cells>.*)\||(?:[-*+]|\d+[.)])[\t ]+(?<item>\S.*))$/u;
const PROBE_WORD = /\bprobes?\b/iu;
const SEPARATOR_CELL = /^[\t :|-]*$/u;

function namesAProbe(text) {
  return PROBE_WORD.test(text) && text.replace(PROBE_WORD, '').replace(/[^\p{L}\p{N}]/gu, '')
    .length > 0;
}

function isLedgerEntry(line) {
  const row = LEDGER_ROW.exec(line);
  if (!row) return false;
  if (row.groups.item !== undefined) return namesAProbe(row.groups.item);
  const cells = row.groups.cells.split('|');
  if (cells.every((cell) => SEPARATOR_CELL.test(cell))) return false;
  return cells.some((cell) => namesAProbe(cell));
}

// The trailer's task must appear as its own TOKEN, not as a substring: `phase-5-task-1` is a
// prefix of `phase-5-task-10`, so a substring test let the packet name a different review stop
// than the trailer while still passing.
function namesTarget(packetText, target) {
  const token = String(target).replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  return new RegExp(`(?<![\\p{L}\\p{N}_-])${token}(?![\\p{L}\\p{N}_-])`, 'iu').test(packetText);
}

function packetRecordsDeferral(packetText, target) {
  if (typeof packetText !== 'string' || packetText.length === 0) return false;
  if (!namesTarget(packetText, target)) return false;
  return packetText.split(/\r?\n/u).some((line) => isLedgerEntry(line));
}

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
  packetText,
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
      ? ['the Review-Deferred-To-Probes value must name the task that will settle the '
        + 'deferred findings; a bare marker schedules nothing']
      : []),
    // A trailer naming a task, with a packet that records no handoff, is the bare marker
    // wearing a task name: nothing is actually scheduled. The obligation has always been
    // trailer AND ledger (AGENTS.md, and this repo's own packets say so); only the trailer
    // half was enforced.
    ...(deferralRequired && typeof deferral === 'string'
      && !packetRecordsDeferral(packetText, deferral)
      ? [typeof packetText === 'string' && packetText.length > 0
        ? `the convergence packet must record the deferral ledger it claims — name "${deferral}" `
          + 'and the probes each still-open question hands to. The trailer asserts a handoff; '
          + 'the packet is where the handoff is written down'
        : 'the convergence packet could not be read, so the deferral ledger it must contain '
          + 'is unverified. This is not evidence that the ledger is missing — re-run once the '
          + 'packet is readable']
      : []),
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
