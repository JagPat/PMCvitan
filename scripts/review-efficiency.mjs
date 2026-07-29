export const REVIEW_SCOPE_ENFORCE_AFTER_PR = 246;
export const STANDARD_MAX_FILES = 20;
export const STANDARD_MAX_CHANGED_LINES = 1_500;
export const CONVERGENCE_AFTER_FINDING_HEADS = 2;

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
  const missing = [
    ...(!hasTrailer ? [convergenceTrailerHint(headMessage)] : []),
    ...(!hasPacket ? ['packet'] : []),
  ];
  return {
    required: true,
    allowed: missing.length === 0,
    findingHeadCount,
    findingHeads,
    hasTrailer,
    hasPacket,
    missing,
  };
}
