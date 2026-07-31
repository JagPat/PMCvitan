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
import { codexFindingHeads } from './review-efficiency.mjs';

// ONE cap, deliberately.
//
// An earlier draft carried a shorter docs-only cap and classified each unit as
// docs or code. That classification produced findings in four separate rounds,
// and the last two showed why: the repository ALREADY has a rule for a docs-only
// unit at its cap — bounded deferral to named probes via
// `Review-Deferred-To-Probes:`, enforced in review-efficiency.mjs. A second,
// shorter cap here did not reinforce that rule, it collided with it, and would
// have blocked a valid probe handoff by declaring the unit unreviewable instead.
//
// So the classification is GONE rather than corrected again. Docs-only units keep
// the protocol that owns them; this module governs the case that had no rule —
// a unit still drawing findings after five heads. Nothing to classify means
// nothing to misclassify, and an unreadable file list can no longer leave the
// threshold undecided, because the threshold no longer depends on it.
export const RESTRUCTURE_AFTER_FINDING_HEADS = 5;

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

  const base = {
    findingHeadCount,
    findingHeadIds: merged.ids,
    findingHeads: liveHeads,
    threshold: RESTRUCTURE_AFTER_FINDING_HEADS,
    replaces,
  };

  if (findingHeadCount >= RESTRUCTURE_AFTER_FINDING_HEADS) {
    return {
      ...base,
      state: 'restructure_required',
      required: true,
      allowed: false,
      undecided: false,
      reason: `${findingHeadCount} finding-bearing heads reaches the `
        + `${RESTRUCTURE_AFTER_FINDING_HEADS}-head limit; further correction heads are not `
        + 'the remedy — the unit must be restructured and replaced',
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
