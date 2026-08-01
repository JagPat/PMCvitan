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
import { codexFindingHeads, findingHeadSeverity } from './review-efficiency.mjs';

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

// How long a restructure decision waits on a human, by how serious the unit is.
//
// The owner's rule: ask only when it is critical, and if nobody answers within
// the window, carry on rather than stall. The windows are tiered because the
// more serious the unit, the more worth waiting for a real answer — a P0 gets
// the longest chance to reach a human before the loop proceeds alone.
//
// UNKNOWN severity takes the LONGEST window, which is the same fail-closed
// instinct as treating it critical: when the gate cannot see how bad something
// is, it waits longer, not less.
export const VERY_CRITICAL_WINDOW_MINUTES = 6 * 60;
export const CRITICAL_WINDOW_MINUTES = 3 * 60;

export function declarationWindowFor(tier) {
  return tier === 'critical' ? CRITICAL_WINDOW_MINUTES : VERY_CRITICAL_WINDOW_MINUTES;
}

// The declaration a human adds to the PR body to answer the request.
//   <!-- review-restructure: continue -->   keep correcting this unit
//   <!-- review-restructure: restructure --> split and replace it
const DECLARATION = /<!--\s*review-restructure:\s*(continue|restructure)\s*-->/iu;

export function restructureDeclaration(body) {
  return DECLARATION.exec(String(body ?? ''))?.[1]?.toLowerCase() ?? null;
}

function windowExpired(requestedAtIso, nowIso, windowMinutes) {
  const requested = Date.parse(typeof requestedAtIso === 'string' ? requestedAtIso : '');
  const now = Date.parse(typeof nowIso === 'string' ? nowIso : '');
  if (!Number.isFinite(requested) || !Number.isFinite(now)) return false;
  return now - requested >= windowMinutes * 60_000;
}

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
  nowIso = null,
  requestedAt = null,
  declarationWindowMinutes = null,
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
    // CRITICAL ONLY. Five heads of P2 polish is a unit converging slowly; five
    // heads still turning up P1s is a unit whose design is in question, and only
    // the second is worth interrupting a human for. Blocking on both was the
    // merged behaviour and it would have stopped PR #263 at head 5 — before the
    // withdrawal that made it shippable.
    // Critical unless PROVABLY minor. A head whose severity cannot be read is
    // critical, so losing the ability to see severity makes the gate ask a human
    // rather than wave the unit through.
    // Critical unless PROVABLY minor, and TIERED by the worst head. Unknown
    // severity counts as very-critical: losing the ability to read severity
    // makes the gate wait longer for a human, never less.
    const severity = findingHeadSeverity(comments, reviews);
    const criticalHeads = merged.ids.filter((id) => severity.get(id) !== 'minor');

    // A LEGACY floor carries a count but no identities, and identities are what
    // severity is keyed by. If the live read no longer returns those old
    // comments, `criticalHeads` comes back empty and the unit reads as minor —
    // forgiving a unit that had already crossed the limit, on the strength of
    // evidence we cannot see. Heads we know exist but cannot classify count as
    // unknown, which is critical.
    const unclassified = Math.max(0, findingHeadCount - merged.ids.length);
    const critical = criticalHeads.length > 0 || unclassified > 0;
    // An unclassifiable head is unknown severity, which takes the longest window.
    const tier = unclassified > 0
      || criticalHeads.some((id) => severity.get(id) !== 'critical')
      ? 'very-critical'
      : 'critical';
    const window = declarationWindowMinutes ?? declarationWindowFor(tier);
    if (!critical) {
      return {
        ...base,
        criticalHeads,
        critical: false,
        // No tier and no window: nothing is being waited for, and reporting one
        // would put a misleading "critical" in the durable record.
        tier: null,
        windowMinutes: null,
        state: 'reviewing',
        required: false,
        allowed: true,
        undecided: false,
        thresholdCrossed: true,
        reason: `${findingHeadCount} finding-bearing heads reaches the `
          + `${RESTRUCTURE_AFTER_FINDING_HEADS}-head limit, but none carries a P1 — `
          + 'the unit is converging, so it continues without a human decision',
      };
    }

    const declared = restructureDeclaration(body);
    if (declared) {
      return {
        ...base,
        criticalHeads,
        critical: true,
        tier,
        windowMinutes: window,
        declared,
        state: declared === 'restructure' ? 'restructure_required' : 'reviewing',
        required: declared === 'restructure',
        allowed: declared === 'continue',
        undecided: false,
        thresholdCrossed: true,
        reason: `${findingHeadCount} finding-bearing heads with a P1; the declared `
          + `decision is to ${declared}`,
      };
    }

    // Nobody has answered yet. Wait — but only for the window.
    if (windowExpired(requestedAt, nowIso, window)) {
      return {
        ...base,
        criticalHeads,
        critical: true,
        tier,
        windowMinutes: window,
        declared: null,
        state: 'reviewing',
        required: false,
        allowed: true,
        undecided: false,
        thresholdCrossed: true,
        autonomous: true,
        reason: `${findingHeadCount} finding-bearing heads with a P1; no decision was `
          + `declared within ${declarationWindowMinutes} minutes, so the loop proceeds `
          + 'on its own judgement and records that it did',
      };
    }

    return {
      ...base,
      criticalHeads,
      critical: true,
      tier,
      windowMinutes: window,
      declared: null,
      state: 'restructure_declaration_required',
      required: true,
      allowed: false,
      undecided: false,
      thresholdCrossed: true,
      requestedAt: requestedAt ?? nowIso,
      reason: `${findingHeadCount} finding-bearing heads and this unit is still drawing `
        + 'P1 findings; a human decides whether to keep correcting it or restructure it '
        + '(add "<!-- review-restructure: continue -->" or "restructure" to the body; ${window} minutes)',
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
