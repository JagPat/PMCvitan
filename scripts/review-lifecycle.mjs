// The review lifecycle: reviewing → convergence_audit → restructure_required →
// replacement_reviewing.
//
// The convergence protocol (AGENTS.md) stops ORDINARY PATCHING after two
// finding-bearing heads and demands one batched architectural audit. That is the
// right move once. It is not a fixed point: PR #257 produced findings on five
// consecutive heads, three of them regressions introduced by the previous
// correction, because a concept spread across several sites was being fixed two
// sites at a time. Repeating "batch and audit" cannot converge that — the review
// unit itself is wrong, and the remedy is to restructure it.
//
// This module answers one question: has this review unit spent enough rounds to
// prove that another correction head is the wrong instrument? It never dismisses
// a finding and never clears a head. Its only outcomes are "keep reviewing" and
// "stop; restructure".
import { codexFindingHeads, isDocsOnlyDiff } from './review-efficiency.mjs';

// A docs-only unit is cheap to re-cut, and prose that has drawn findings three
// times is arguing rather than converging. Ordinary code carries real structural
// cost, so it gets the longer leash — but not an unlimited one.
export const RESTRUCTURE_AFTER_DOCS_FINDING_HEADS = 3;
export const RESTRUCTURE_AFTER_CODE_FINDING_HEADS = 5;

export const LIFECYCLE_STATES = [
  'reviewing',
  'convergence_audit',
  'restructure_required',
  'replacement_reviewing',
];

// A replacement declares its source in the PR body. The declaration is what makes
// a fresh review history legitimate: the lineage stays visible, and the metrics of
// the PR being replaced are not silently discarded.
const REPLACES = /^[\t ]*replaces:[\t ]*#(?<number>\d+)[\t ]*$/imu;

// Machine-readable metrics carried on the sticky comment. The recorded count is a
// FLOOR, never a fresh reading: see `mergeFindingHeadCount`.
export const METRICS_MARKER = '<!-- autonomous-review-metrics:';

// Keep the floor attached to the sticky comment no matter which writer touches it.
//
// The comment has sixteen writers and exactly one of them ever composed a metrics
// block, so the floor recorded by the lifecycle precondition was erased by the
// very next `changes_required` update. Round 3 made the floor SOUND; it was never
// DURABLE, which meant the union had nothing to union with in precisely the case
// it exists for.
//
// Asking all sixteen call sites to remember the lifecycle is what produced rounds
// 1 and 2 of this PR's findings. So preservation is structural instead: a body
// that carries no metrics inherits them, and a writer that has fresher ones wins.
// A seventeenth writer is correct without knowing this function exists.
export function preserveMetrics(nextBody, previousBody, runMetrics) {
  const body = typeof nextBody === 'string' ? nextBody : '';
  // The caller composed its own block — it is the most specific thing available.
  if (body.includes(METRICS_MARKER)) return body;

  // The run's own assessment beats whatever the comment recorded earlier: the
  // count only ever rises, so the fresher reading is never the smaller one.
  const carried = runMetrics
    ? renderMetrics(runMetrics)
    : metricsBlockOf(previousBody);
  if (!carried) return body;

  const lines = body.split('\n');
  // Match `statusBody`'s layout so the rendered comment reads identically whether
  // the block was composed or inherited.
  const anchor = lines.findIndex((line) => line.startsWith('- **Head:**'));
  if (anchor < 0) return [carried, '', ...lines].join('\n');
  lines.splice(anchor, 0, carried, '');
  return lines.join('\n');
}

function metricsBlockOf(source) {
  const text = typeof source === 'string' ? source : '';
  const start = text.indexOf(METRICS_MARKER);
  if (start === -1) return null;
  const end = text.indexOf('-->', start);
  return end === -1 ? null : text.slice(start, end + 3);
}

export function replacementSource(body) {
  const match = REPLACES.exec(typeof body === 'string' ? body : '');
  if (!match) return null;
  const number = Number(match.groups.number);
  return Number.isInteger(number) && number > 0 ? number : null;
}

export function readMetrics(commentBody) {
  const source = typeof commentBody === 'string' ? commentBody : '';
  const start = source.indexOf(METRICS_MARKER);
  if (start === -1) return null;
  const end = source.indexOf('-->', start);
  if (end === -1) return null;
  try {
    const parsed = JSON.parse(source.slice(start + METRICS_MARKER.length, end).trim());
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

export function renderMetrics(metrics) {
  return `${METRICS_MARKER} ${JSON.stringify(metrics)} -->`;
}

// The count only ever RISES for a given review unit.
//
// Findings live on the pull request, so rewriting the branch does not erase them —
// but a paginated read, a deleted comment, or a transient API result can all make
// the live count look smaller than it has already been. Taking the max of the
// recorded floor and the live reading means neither an accident nor a deliberate
// history rewrite can walk a PR back below a threshold it has already crossed.
// A genuinely fresh unit gets a fresh count by being a DECLARED replacement, which
// is a different pull request with its own comment and its own floor.
export function mergeFindingHeads(recorded, liveHeads) {
  // IDENTITIES, not counts. A count-only max still walks backward when a partial
  // live read ADDS the new head and OMITS an older one: a recorded floor of four
  // plus a live read of three old heads and the new fifth gives max(4, 4) = 4, and
  // the unit sits below the five-head limit while actually having crossed it.
  // Unioning the identities cannot lose a head that either side has seen.
  const recordedIds = Array.isArray(recorded?.findingHeadIds)
    ? recorded.findingHeadIds.filter((id) => typeof id === 'string' && id.length > 0)
    : [];
  const union = new Set([...recordedIds, ...(liveHeads ?? []).filter(Boolean)]);
  // A legacy record written before identities were stored carries only a count.
  // It cannot be unioned, so it still applies as a numeric floor — otherwise
  // upgrading the gate would silently forgive every unit already in flight.
  const legacyFloor = Number.isInteger(recorded?.findingHeads) && recorded.findingHeads >= 0
    ? recorded.findingHeads
    : 0;
  return { ids: [...union], count: Math.max(union.size, legacyFloor) };
}

// Combine several RECORDED floors into one. The floor has more than one source —
// the sticky comment, and the value this run has already observed in memory — and
// every source must be UNIONED, never replaced.
//
// Round 4 made the floor durable across sticky writes but not across repeated
// lifecycle checks inside a single run. `enforceRestructure` runs twice (the
// driver's precondition and the pre-Codex revalidation), and each seeded itself
// from the sticky comment alone. With a metrics-less sticky both saw `null`, so a
// partial second read of three heads replaced a first observation of four — and
// when the fifth head landed, a partial read could still total four and invite
// another correction head on a unit that had already crossed.
//
// Scalars that describe the LATEST assessment (state, threshold, elapsed) take the
// last value; everything that is a floor accumulates.
export function mergeRecordedMetrics(...records) {
  const present = records.filter((record) => record && typeof record === 'object');
  if (present.length === 0) return null;

  const ids = new Set();
  let legacyFloor = 0;
  let kind;
  let firstSeenAt;
  let findingsPerHead = {};
  const latest = {};

  for (const record of present) {
    for (const id of Array.isArray(record.findingHeadIds) ? record.findingHeadIds : []) {
      if (typeof id === 'string' && id.length > 0) ids.add(id);
    }
    // A legacy record carries only a count and cannot be unioned, so it still
    // applies numerically — otherwise upgrading forgives every unit in flight.
    if (Number.isInteger(record.findingHeads) && record.findingHeads > legacyFloor) {
      legacyFloor = record.findingHeads;
    }
    // Strictest kind ever presented wins, exactly as in `assessRestructure`.
    if (record.kind === 'docs') kind = 'docs';
    else if (record.kind === 'code' && kind !== 'docs') kind = 'code';
    // Earliest start: elapsed time should not restart because a later record
    // stamped itself.
    if (typeof record.firstSeenAt === 'string'
      && (firstSeenAt === undefined || record.firstSeenAt < firstSeenAt)) {
      firstSeenAt = record.firstSeenAt;
    }
    findingsPerHead = { ...findingsPerHead, ...(record.findingsPerHead ?? {}) };
    for (const key of ['state', 'threshold', 'elapsedMinutes', 'replaces']) {
      if (record[key] !== undefined && record[key] !== null) latest[key] = record[key];
    }
  }

  return {
    ...latest,
    findingHeads: Math.max(ids.size, legacyFloor),
    findingHeadIds: [...ids],
    findingsPerHead,
    ...(kind ? { kind } : {}),
    ...(firstSeenAt ? { firstSeenAt } : {}),
  };
}

// Retained as the numeric view of the same rule, for callers that only need the
// count. Implemented ON TOP of the identity union so the two cannot disagree.
export function mergeFindingHeadCount(recorded, live) {
  const liveIds = Array.isArray(live)
    ? live
    : Array.from({ length: Number(live) || 0 }, (_, index) => `live:${index}`);
  return mergeFindingHeads(recorded, liveIds).count;
}

export function assessRestructure({
  comments,
  reviews,
  pullRequestFiles,
  body,
  recordedMetrics,
  floorUnreadable = false,
}) {
  const replaces = replacementSource(body);
  const liveHeads = codexFindingHeads(comments, reviews);
  const merged = mergeFindingHeads(recordedMetrics, liveHeads);
  const findingHeadCount = merged.count;

  // An UNREADABLE floor is not an absent one. Once a unit has crossed its limit
  // the durable record is the only thing carrying that fact forward — the failing
  // status belongs to the previous SHA. Treating a failed read as "no record"
  // lets a partial live read continue the unit, which is exactly the walk-back
  // the floor rule forbids. `floorUnreadable` is passed in by the caller when the
  // sticky read itself failed, and it blocks rather than guesses.
  if (floorUnreadable) {
    return {
      findingHeadCount,
      findingHeadIds: merged.ids,
      findingHeads: liveHeads,
      kind: 'unknown',
      threshold: undefined,
      replaces,
      state: 'reviewing',
      required: false,
      allowed: false,
      undecided: true,
      reason: 'the recorded lifecycle floor could not be read, so whether this unit has '
        + 'already crossed its limit is unverified. This is not evidence either way; '
        + 're-run once the sticky comment is readable',
    };
  }

  const readable = Array.isArray(pullRequestFiles);
  const docsOnly = readable ? isDocsOnlyDiff(pullRequestFiles) : undefined;
  const liveKind = readable ? (docsOnly ? 'docs' : 'code') : 'unknown';

  // MONOTONIC. Once a unit has been assessed as docs-only, adding a runnable file
  // in a later correction must not raise its threshold from three to five and
  // return it to `reviewing`. The strictest kind this unit has ever presented is
  // the one that governs: a docs-only unit that crossed three heads stays
  // restructure-required whatever it pushes next.
  const recordedKind = recordedMetrics?.kind === 'docs' || recordedMetrics?.kind === 'code'
    ? recordedMetrics.kind
    : undefined;
  const kind = recordedKind === 'docs' || liveKind === 'docs'
    ? 'docs'
    : recordedKind === 'code' || liveKind === 'code'
      ? 'code'
      : 'unknown';
  const threshold = kind === 'docs'
    ? RESTRUCTURE_AFTER_DOCS_FINDING_HEADS
    : kind === 'code'
      ? RESTRUCTURE_AFTER_CODE_FINDING_HEADS
      : undefined;

  const base = {
    findingHeadCount,
    findingHeadIds: merged.ids,
    findingHeads: liveHeads,
    kind,
    threshold,
    replaces,
  };

  // An unreadable cumulative diff leaves the THRESHOLD unknown, and picking one
  // silently is the defect this repository keeps rediscovering. Two of the three
  // cases are still decidable without it:
  //
  //   - below the docs threshold, neither threshold is crossed — keep reviewing;
  //   - at or above the code threshold, BOTH are crossed — restructure, certainly.
  //
  // Only the band between them genuinely depends on the answer, and there this
  // reports `undecided` and blocks so the next event re-reads the file list. That
  // is a stop, never a clearance: an undecided unit cannot merge either.
  if (kind === 'unknown') {
    if (findingHeadCount < RESTRUCTURE_AFTER_DOCS_FINDING_HEADS) {
      return { ...base, state: 'reviewing', required: false, allowed: true, undecided: false };
    }
    if (findingHeadCount >= RESTRUCTURE_AFTER_CODE_FINDING_HEADS) {
      return {
        ...base,
        state: 'restructure_required',
        required: true,
        allowed: false,
        undecided: false,
        reason: `${findingHeadCount} finding-bearing heads exceeds both the docs `
          + `(${RESTRUCTURE_AFTER_DOCS_FINDING_HEADS}) and code `
          + `(${RESTRUCTURE_AFTER_CODE_FINDING_HEADS}) limits, so the review unit must be `
          + 'restructured regardless of which applies',
      };
    }
    return {
      ...base,
      state: 'reviewing',
      required: false,
      allowed: false,
      undecided: true,
      reason: `${findingHeadCount} finding-bearing heads is past the docs limit `
        + `(${RESTRUCTURE_AFTER_DOCS_FINDING_HEADS}) but not the code limit `
        + `(${RESTRUCTURE_AFTER_CODE_FINDING_HEADS}), and the cumulative diff could not be `
        + 'read, so which limit applies is unverified. This is not evidence either way; '
        + 're-run once the file list is readable',
    };
  }

  if (findingHeadCount >= threshold) {
    return {
      ...base,
      state: 'restructure_required',
      required: true,
      allowed: false,
      undecided: false,
      reason: `${findingHeadCount} finding-bearing heads on a ${kind} review unit reaches the `
        + `${threshold}-head limit; further correction heads are not the remedy — the unit `
        + 'must be restructured and replaced',
    };
  }

  return {
    ...base,
    state: replaces ? 'replacement_reviewing' : 'reviewing',
    required: false,
    allowed: true,
    undecided: false,
  };
}

// What the sticky comment carries forward. Elapsed time is TELEMETRY: it describes
// how long a unit has been in review so a human can see cost, and nothing reads it
// to decide whether a head may merge. Only the finding-head count gates.
export function nextMetrics({
  recordedMetrics,
  assessment,
  findingsThisHead,
  firstSeenAt,
  nowIso,
}) {
  const perHead = {
    ...(recordedMetrics?.findingsPerHead ?? {}),
  };
  if (typeof assessment?.head === 'string' && Number.isInteger(findingsThisHead)) {
    perHead[assessment.head] = findingsThisHead;
  }
  const started = recordedMetrics?.firstSeenAt ?? firstSeenAt ?? nowIso;
  return {
    findingHeads: assessment.findingHeadCount,
    findingHeadIds: assessment.findingHeadIds ?? [],
    findingsPerHead: perHead,
    kind: assessment.kind,
    threshold: assessment.threshold ?? null,
    state: assessment.state,
    // Telemetry only — see above. Recorded so the cost of a long review is visible
    // in the same place the count is, not so anything can time-box a gate.
    firstSeenAt: started,
    elapsedMinutes: elapsedMinutes(started, nowIso),
    ...(assessment.replaces ? { replaces: assessment.replaces } : {}),
  };
}

function elapsedMinutes(fromIso, toIso) {
  const from = Date.parse(typeof fromIso === 'string' ? fromIso : '');
  const to = Date.parse(typeof toIso === 'string' ? toIso : '');
  if (!Number.isFinite(from) || !Number.isFinite(to) || to < from) return null;
  return Math.round((to - from) / 60_000);
}
