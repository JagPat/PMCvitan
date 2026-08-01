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

// ─────────────────────────────────────────────────────────────────────────────
// The OBSERVATION — the part of this rule that is wired.
//
// `RESTRUCTURE_AFTER_FINDING_HEADS` shipped in #259 as a policy model imported by
// nothing but its own tests. It never fired, and PR #263 ran to six
// finding-bearing heads without it triggering once. The policy was never wrong;
// it was never asked.
//
// This function is what asks it. It DECIDES NOTHING and BLOCKS NOTHING.
//
// That restraint is the design, not a shortcut. AGENTS.md is explicit: *do not
// block on human sign-off — no one is standing by to give it.* A gate that stops
// an over-limit unit until a human answers needs a whole apparatus to stay
// non-blocking: an attributable declaration channel, a reply window, a durable
// request record that survives every other writer, a timer that reaches the
// deadline no event announces, and a recovery path. Each of those is real work
// with real failure modes, and carrying them alongside the wiring is what turned
// the first attempt at this change into twelve review rounds.
//
// So the split is by what each half needs to be SAFE. Reporting a crossing needs
// nothing durable — it is recomputed from live evidence every run, and if the
// read fails it reports nothing rather than reporting wrongly. Acting on a
// crossing needs all of the above, and lands as its own unit.
//
// What this buys today: the threshold is finally computed on both paths that
// reach a review, and a unit that has spent five heads still turning up P1s says
// so, in the place a human is already looking. That is the signal the owner used
// to decide to split this very pull request.
export function observeReviewLifecycle({
  comments,
  reviews,
  threshold = RESTRUCTURE_AFTER_FINDING_HEADS,
}) {
  const findingHeads = codexFindingHeads(comments, reviews);
  const severity = findingHeadSeverity(comments, reviews);

  // Worst-wins, and an unreadable head is never treated as merely minor.
  const RANK = { 'very-critical': 0, unknown: 1, critical: 2, minor: 3 };
  let tier = null;
  for (const head of findingHeads) {
    const seen = severity.get(head) ?? 'unknown';
    if (tier === null || RANK[seen] < RANK[tier]) tier = seen;
  }

  const crossed = findingHeads.length >= threshold;
  return {
    findingHeadCount: findingHeads.length,
    findingHeadIds: findingHeads,
    threshold,
    tier,
    crossed,
    // The advisory itself: this unit is past the limit AND still producing
    // findings that are not provably minor.
    restructureAdvised: crossed && tier !== null && tier !== 'minor',
  };
}

// One line for the status comment a human is already reading. Null when there is
// nothing to say, so the ordinary case is unchanged.
export function lifecycleAdvisory(observation) {
  if (!observation?.restructureAdvised) return null;
  const tier = observation.tier === 'unknown'
    ? 'of unread severity'
    : `up to ${observation.tier.replace('-', ' ')}`;
  return `This unit has ${observation.findingHeadCount} finding-bearing heads `
    + `(limit ${observation.threshold}), with findings ${tier}. `
    + 'Consider splitting it into a smaller review unit.';
}
