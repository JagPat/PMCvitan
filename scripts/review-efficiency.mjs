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
// the diff provable and puts it back under the ordinary code protocol. An empty diff is
// not a plan review; it is a broken read, and it fails toward the strict path.
const DOCS_PATH = /^(?:docs\/.+|[^/]+\.md|\.github\/[^/]*\.md)$/u;

export function isDocsOnlyDiff(changedFiles) {
  const names = (changedFiles ?? [])
    .filter((file) => file?.status !== 'removed')
    .map((file) => changedFilename(file))
    .filter((name) => typeof name === 'string' && name.length > 0);
  return names.length > 0 && names.every((name) => DOCS_PATH.test(name));
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

export function assessConvergence({ comments, reviews, headMessage, changedFiles }) {
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
  const deferralRequired = isDocsOnlyDiff(changedFiles)
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
