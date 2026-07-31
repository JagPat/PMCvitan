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
const METRICS_MARKER = '<!-- autonomous-review-metrics:';

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
export function mergeFindingHeadCount(recorded, live) {
  const floor = Number.isInteger(recorded?.findingHeads) && recorded.findingHeads >= 0
    ? recorded.findingHeads
    : 0;
  return Math.max(floor, live);
}

export function assessRestructure({
  comments,
  reviews,
  pullRequestFiles,
  body,
  recordedMetrics,
}) {
  const replaces = replacementSource(body);
  const liveHeads = codexFindingHeads(comments, reviews);
  const findingHeadCount = mergeFindingHeadCount(recordedMetrics, liveHeads.length);

  const readable = Array.isArray(pullRequestFiles);
  const docsOnly = readable ? isDocsOnlyDiff(pullRequestFiles) : undefined;
  const kind = readable ? (docsOnly ? 'docs' : 'code') : 'unknown';
  const threshold = kind === 'docs'
    ? RESTRUCTURE_AFTER_DOCS_FINDING_HEADS
    : kind === 'code'
      ? RESTRUCTURE_AFTER_CODE_FINDING_HEADS
      : undefined;

  const base = {
    findingHeadCount,
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
