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

// ONE request, under ONE key.
//
// The durable record mixes two lifetimes. `findingHeads`, `findingsPerHead` and
// `firstSeenAt` are CUMULATIVE — they describe the unit and never reset. The
// request fields describe a SINGLE declaration request and are meaningless once
// the next one opens.
//
// Held flat, every writer did `{ ...recordedMetrics, ...}` and silently carried
// request-scoped fields across request boundaries. That is not one bug: it was
// found four times (rounds 5, 7, 8, 9), most recently as a stale `autonomousAt`
// surviving into a NEW window, which made `expiredWindow` return null forever and
// stranded the unit on a wait nothing could end.
//
// Nesting them makes the mistake UNREPRESENTABLE rather than something each
// writer must remember: opening a request replaces this object wholesale, so a
// field from the previous request cannot survive into the next one.
export const LIFECYCLE_REQUEST_KEY = 'lifecycleRequest';

// A request opened before this key existed stored its fields flat. Reading one
// is a legitimate upgrade path — a pull request mid-flight when this ships — so
// a legacy shape is normalised rather than discarded, which would silently drop
// a live window and re-ask a human who has already been asked.
export function lifecycleRequestOf(metrics) {
  const nested = metrics?.[LIFECYCLE_REQUEST_KEY];
  if (nested && typeof nested === 'object') return nested;
  if (typeof metrics?.declarationRequestedAt === 'string') {
    return {
      at: metrics.declarationRequestedAt,
      windowMinutes: metrics.declarationWindowMinutes,
      tier: metrics.autonomousTier ?? null,
      ...(metrics.autonomousAt ? { autonomousAt: metrics.autonomousAt } : {}),
    };
  }
  return null;
}

// The recorded request ONLY while it is still live FOR THIS HEAD.
//
// A request ends in exactly two ways, and it ends **for a head**, not at a time:
//
//   `autonomousAt` / `autonomousBy` — the window ran out and the loop overrode it.
//   `consumedAt`   / `consumedBy`   — a maintainer ANSWERED it.
//
// Round 9 modelled only the first ending. Round 10 added the second and keyed it
// to time alone, which broke the merge path: the SAME head passes this gate
// twice — once before Codex promotion, once at final admission — so consuming
// the answer on the first call made the second call open a brand-new window and
// block the merge it had just authorised.
//
// Keying the ending to the head that caused it settles both. The head that spent
// a request still sees it as its own decision, so it merges; any LATER head sees
// it as ended and must ask again. Old evidence fails closed without the decision
// evaporating under the head that earned it.
export function liveLifecycleRequest(metrics, forHead = null) {
  const request = lifecycleRequestOf(metrics);
  if (!request) return null;
  const endedBy = request.consumedBy ?? request.autonomousBy ?? null;
  if (!request.autonomousAt && !request.consumedAt) return request;
  // Ended, but by THIS head: still that head's own decision.
  return forHead && endedBy && endedBy === forHead ? request : null;
}

// Build the request to RECORD. Callers pass the whole thing, never a spread of
// the old one, which is what keeps a stale field from surviving.
export function lifecycleRequest({
  at, windowMinutes, tier,
  autonomousAt = null, autonomousBy = null,
  consumedAt = null, consumedBy = null,
}) {
  return {
    at,
    windowMinutes,
    tier,
    ...(autonomousAt ? { autonomousAt } : {}),
    ...(autonomousBy ? { autonomousBy } : {}),
    ...(consumedAt ? { consumedAt } : {}),
    ...(consumedBy ? { consumedBy } : {}),
  };
}

// The window a human was already promised, read back off the durable record.
//
// Returns null when nothing usable was recorded, which lets the assessment fall
// through to computing one from current severity. A recorded window is never
// allowed to SHRINK on a later run — see the `Math.max` at the call site — so a
// unit first blocked on unclassified evidence keeps its six hours even once the
// heads become classifiable as merely P1.
export function recordedWindowMinutes(metrics, forHead = null) {
  const recorded = Number(liveLifecycleRequest(metrics, forHead)?.windowMinutes);
  return Number.isFinite(recorded) && recorded > 0 ? recorded : null;
}

// The declaration a human posts as a COMMENT to answer the request:
//   <!-- review-restructure: continue -->   keep correcting this unit
//   <!-- review-restructure: restructure --> split and replace it
//
// It is read from a comment and not from the PR body, for two reasons.
//
// The body is written by Claude. Reading a human's decision out of a document
// the loop authors itself is not an attributable approval at all — it is the
// loop approving itself, and this repository's standing rule is that human
// approvals stay attributable. A comment carries an author and an association.
//
// And the body form was actively unsafe: the request comment tells a human to
// use this exact marker, so any prose EXPLAINING how to answer contained an
// answer. The first draft of this pull request's own description documented the
// mechanism and would have declared "continue" on its own behalf, fabricating a
// human decision nobody made. Quoting the instructions must never be obeying
// them.
const DECLARATION = /<!--\s*review-restructure:\s*(continue|restructure)\s*-->/iu;

// Markers inside code spans or fences are being SHOWN, not used — which is how
// anyone documents the mechanism, including the request comment this gate posts.
// Fenced blocks, inline spans, AND Markdown's INDENTED code blocks — four
// spaces or a tab. A maintainer showing the marker as an indented example was
// having it read as a real decision.
const FENCED = /```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]*`|^(?: {4}|\t).*$/gmu;

export function restructureDeclaration(source) {
  return DECLARATION.exec(String(source ?? '').replace(FENCED, ' '))?.[1]?.toLowerCase() ?? null;
}

// A cheap PRE-filter, not the authorisation.
//
// `MEMBER` and `COLLABORATOR` are relationship labels: on an organisation repo a
// read-only member carries `MEMBER` and could declare a decision they have no
// authority to make. So this narrows the candidates without deciding, and the
// caller verifies the survivor's real repository permission
// (write / maintain / admin) before the marker counts.
//
// Bots are excluded by both signals GitHub gives, since the loop's own comments
// quote the marker every time it asks.
const PLAUSIBLE = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);

function isHuman(comment) {
  const login = comment?.user?.login ?? '';
  if (comment?.user?.type === 'Bot' || login.endsWith('[bot]')) return false;
  return PLAUSIBLE.has(String(comment?.author_association ?? '').toUpperCase());
}

// When a comment's content last became what it is. A maintainer may answer by
// EDITING a comment, so an edit counts; a comment never edited is judged on when
// it was written.
function contentTime(comment) {
  const created = Date.parse(comment?.created_at ?? '');
  const updated = Date.parse(comment?.updated_at ?? '');
  const times = [created, updated].filter(Number.isFinite);
  return times.length ? Math.max(...times) : null;
}

// The LATEST authoritative answer wins, so a human can change their mind by
// posting again rather than editing history.
//
// An answer must POSTDATE the request it answers. Without that, a marker written
// while merely discussing the mechanism — months earlier, in a comment about how
// the gate works — silently answers a request that did not exist yet, and a
// five-P1-head unit proceeds on a decision nobody made about it. `requestedAt` is
// the stamp the gate records when it first asks; a comment with no readable
// timestamp cannot be shown to postdate anything, so it does not count.
//
// Before any request has been made there is nothing to answer, and every
// declaration is stale by definition.
export function humanDeclaration(comments, requestedAt = null) {
  const asked = Date.parse(requestedAt ?? '');
  if (!Number.isFinite(asked)) return null;

  let declared = null;
  let declaredAt = -Infinity;
  for (const comment of comments ?? []) {
    if (!isHuman(comment)) continue;
    const at = contentTime(comment);
    if (at === null || at < asked) continue;
    const found = restructureDeclaration(comment.body);
    if (found && at >= declaredAt) {
      declared = { declared: found, by: comment.user?.login ?? null, at };
      declaredAt = at;
    }
  }
  return declared;
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

// Is this unit sitting on a declaration window that has already run out?
//
// This is the ONE question in the loop that no event can answer. Every other
// transition has something that fires — a push, a CI run, a review, a comment —
// and the gate reacts to it immediately. A deadline passing fires nothing,
// because the thing that defines it is that NOBODY DID ANYTHING. So a timer is
// not the driver here; it is the fallback for the silent case, and this
// predicate is what makes that fallback cheap: a sweep can answer it from the
// sticky comment alone, without re-reading a single review.
//
// `autonomousAt` is what stops the sweep firing forever: once the override is
// recorded, the window is spent and this returns false.
export function expiredWindow(metrics, nowIso) {
  const request = lifecycleRequestOf(metrics);
  const requested = Date.parse(request?.at ?? '');
  const now = Date.parse(nowIso ?? '');
  if (!Number.isFinite(requested) || !Number.isFinite(now)) return null;
  // Over: this REQUEST already ended, by override or by an answer. Scoped to the
  // request object, so opening a new one clears it by construction rather than
  // by remembering to.
  if (request.autonomousAt || request.consumedAt) return null;   // ended: nothing to expire

  // A window recorded without its length is not assumed to be the short one:
  // the wait is what protects a human's chance to answer, so an unreadable
  // length waits the LONGEST, the same instinct as unknown severity.
  const minutes = Number.isFinite(Number(request.windowMinutes))
    && Number(request.windowMinutes) > 0
    ? Number(request.windowMinutes)
    : VERY_CRITICAL_WINDOW_MINUTES;

  const elapsed = now - requested;
  return elapsed >= minutes * 60_000
    ? { requestedAt: request.at, minutes, elapsedMinutes: Math.floor(elapsed / 60_000) }
    : null;
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
  issueComments = null,
  declaration = null,
  declarationsUnreadable = false,
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
    // The LONGER of the promise already made and the one this severity warrants.
    // Never shrink: a human told they had six hours must still have six hours
    // when a later run reclassifies the evidence as merely P1. Never cap either:
    // a reclassification to something MORE serious extends the wait, which is
    // the same fail-closed direction as unknown severity taking the longest.
    const computed = declarationWindowFor(tier);
    const window = declarationWindowMinutes
      ? Math.max(declarationWindowMinutes, computed)
      : computed;
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

    // The answer could not be read, so whether a maintainer has already said
    // "restructure" is unknown. Both permissive outcomes below — an explicit
    // `continue`, and the window expiring — would be decided on evidence we do
    // not have, and expiry is the dangerous one: it needs no answer at all, so a
    // failed read looks exactly like silence. This is the same rule the sticky
    // floor already follows, and I did not apply it when adding this second read.
    if (declarationsUnreadable) {
      return {
        ...base,
        critical: true,
        state: 'restructure_declaration_required',
        required: true,
        allowed: false,
        undecided: true,
        thresholdCrossed: true,
        reason: `${findingHeadCount} finding-bearing heads with a P1, and the comments `
          + 'carrying a maintainer decision could not be read. Whether one was posted is '
          + 'unverified, so the unit waits rather than proceeding on evidence it does not have',
      };
    }

    // Handed in ALREADY VERIFIED. Resolving it here would mean this pure module
    // deciding authorisation, which needs a permission lookup it cannot make.
    const answer = declaration;
    if (answer) {
      const { declared, by } = answer;
      return {
        ...base,
        criticalHeads,
        critical: true,
        tier,
        windowMinutes: window,
        declared,
        declaredBy: by,
        state: declared === 'restructure' ? 'restructure_required' : 'reviewing',
        required: declared === 'restructure',
        allowed: declared === 'continue',
        undecided: false,
        thresholdCrossed: true,
        reason: `${findingHeadCount} finding-bearing heads with a P1; ${by ?? 'a maintainer'} `
          + `declared the decision to ${declared}`,
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
          + `declared within the ${window}-minute ${tier} window, so the loop proceeds `
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
        + 'P1 findings; a maintainer decides whether to keep correcting it or restructure '
        + 'it, by COMMENTING the review-restructure marker (continue or restructure). '
        + `Unanswered after ${window} minutes the loop proceeds on its own judgement`,
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
