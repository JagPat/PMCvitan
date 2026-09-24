import {
  CLAUDE_STATUS_CONTEXT,
  CODEX_LOGIN,
  LINEAGE_BASE_REF,
} from './review-policy.mjs';
import { ROLE_ACTIVATION_EVIDENCE_SCHEMA } from './role-activation-evidence.mjs';

/**
 * Role-transfer ACTIVATION-READINESS verdict (pure, mutation-free).
 *
 * The cloud role transfer (Codex codes, Claude independently reviews) may be activated — atomically adding a
 * Claude exact-head required gate and switching correction routing — ONLY after one real, OBSERVED
 * correction cycle is proven. This module performs NO switch and touches NO live gate: it reads evidence and
 * reports which proofs hold and which are missing. In this version the verdict is ALWAYS `hold`: one proof,
 * `codexTaskCausation`, has no trusted evidence yet (below). `codex-current-head` (`STATUS_CONTEXT`) stays the
 * required gate and `claude-independent-review` stays non-authoritative and out of the required checks.
 * Nothing here declares Codex awakenable.
 *
 * BOUNDARY. The evidence is the normalized output of the trusted, read-only reader
 * (`scripts/role-activation-evidence.mjs`, `ROLE_ACTIVATION_EVIDENCE_SCHEMA`). The READER authenticates each
 * source against GitHub and performs every live read — the newest applicable CI attempt, the branch push
 * log, the live head before and after, producer-verified reviews. This VERDICT enforces the normalized
 * contract across records and against the CALLER's expected identity: it never takes the cycle's identity
 * from the evidence alone. Every rule fails closed; a missing, unreadable or malformed record holds.
 *
 * Cycle proofs (all required, any gap → `hold` with the gap named):
 *   cycleIdentity   — schema; expected repository/PR supplied; the cycle names them, a branch, the base,
 *                     the reviewed and corrective heads (distinct) and the correction-request id.
 *   every record    — names the EXPECTED repository (and PR, branch, base, head where it is scoped by them).
 *   initialFullCiGreen            — CI on the reviewed head, at the base, green as of the finding.
 *   initialClaudeFinding          — the producer-verified `changes_required` review of the reviewed head that
 *                                   the request names, with no later review of that head.
 *   correctionRequest             — the GitHub-generated (bot, not human, unedited) request on this PR, for
 *                                   the reviewed head, naming THAT finding (`findingRef === reviewRef`).
 *   codexTaskAcceptance           — the Codex connector's acceptance of THAT request.
 *   codexCorrectivePush           — the first branch update after the request: a non-forced push by the
 *                                   Codex connector from the reviewed head to the corrective head, with the
 *                                   reviewed head a server-verified ancestor (compare `ahead`, `behind 0`).
 *   codexTaskCausation            — that push was made by the task accepted for THIS request. Every Codex
 *                                   task pushes as the same connector bot, so actor and time cannot prove
 *                                   it. The request now asks for a `Codex-Fix-Probe` trailer on every commit
 *                                   and the reader reports each commit's trailers, but this verdict does not
 *                                   consume them yet: the proof is ALWAYS missing (a later unit binds it),
 *                                   so the verdict holds, fail closed.
 *   fullCiGreen                   — the latest applicable CI on the corrective head, at the base, green, with
 *                                   a named, successful run deciding each required name (the reader names
 *                                   them, so a later installer can bind to that exact attempt).
 *   boundClaudeClearReReview      — the newest producer-verified review of the corrective head is clear.
 *   liveHeadFreshness             — read after the review: the open same-repository PR targets the base
 *                                   branch at the cycle base at the start AND at the end (ref, SHA and both
 *                                   repositories), its head was the corrective head at both reads, no branch
 *                                   update follows the corrective push (an away-and-back is two updates), the
 *                                   complete lifecycle event log from no later than the update that
 *                                   brought the branch to the reviewed head (before every workflow for it,
 *                                   and before the initial CI's deciders started) lists only
 *                                   draft transitions (a retarget away and back is two base changes), and
 *                                   every mutable source (request, acceptance, live PR, both heads' reviews
 *                                   and CI, push log, event log) was read after the freshness point, which
 *                                   follows the pass's opening.
 *   milestoneOrder                — strictly: initial CI < finding < request < acceptance < corrective push
 *                                   < final CI < review < freshness window. GitHub stamps whole seconds, so a
 *                                   tie is admitted only where the records themselves prove the order: the
 *                                   request names the finding, and the acceptance is a reaction ON the request.
 *
 * `activate` is not reachable yet. When a trusted binding makes `codexTaskCausation` provable, a later unit adds
 * it: INSTALL the replacement (`ACTIVATION_INSTALL`: a distinct trusted-controller status,
 * `CLAUDE_STATUS_CONTEXT`, published from ADAPTER-VERIFIED shadow evidence, never the raw producer check name)
 * and switch routing, KEEPING `codex-current-head`. Retiring `codex-current-head` needs a trusted observation
 * of the installed gate in role, which cannot exist before installation and has no reader; it is a later,
 * separate unit. This verdict never retires anything: `keepCodexCurrentHead` is always true.
 */

export const ACTIVATION_REQUIRED_PROOFS = Object.freeze([
  'cycleIdentity',
  'initialFullCiGreen',
  'initialClaudeFinding',
  'correctionRequest',
  'codexTaskAcceptance',
  'codexCorrectivePush',
  'codexTaskCausation',
  'fullCiGreen',
  'boundClaudeClearReReview',
  'liveHeadFreshness',
  'milestoneOrder',
]);

// The INSTALL switch, as data; this module applies none of it. `addRequired` is the trusted-controller status, NOT the
// raw `claude-independent-review` check name, which a PR-emitted check of that name could otherwise satisfy.
export const ACTIVATION_INSTALL = Object.freeze({
  addRequired: CLAUDE_STATUS_CONTEXT,
  codingOwner: 'codex',
  reviewer: 'claude',
});

// The only lifecycle events a proven cycle may contain: draft transitions, which change neither the merge
// target nor the code under test (the controller toggles them to request a review). Every other event — a
// base change (even away and back), close, reopen, merge, a head-ref event, or one this list does not
// know — holds, so the rule fails closed.
export const CYCLE_NEUTRAL_LIFECYCLE_EVENTS = Object.freeze(['convert_to_draft', 'converted_to_draft', 'ready_for_review']);

const SHA = /^[0-9a-f]{40}$/u;
const isSha = (value) => typeof value === 'string' && SHA.test(value);
const nonEmpty = (value) => typeof value === 'string' && value.length > 0;
const finite = (value) => Number.isFinite(value);
// Adjacent milestones in order. GitHub stamps whole seconds, so a pair may tie only when `tieProvenBy` names
// the record binding that proves its order (e.g. a reaction attached to the comment it follows).
const ordered = (chain) => chain.every(({ atMs }) => finite(atMs))
  && chain.every(({ atMs, tieProvenBy }, index) => index === 0
    || chain[index - 1].atMs < atMs
    || (tieProvenBy === true && chain[index - 1].atMs === atMs));

/**
 * @param {object} evidence  the reader's normalized output (`{ schema, cycle, records }`).
 * @param {{repository: string, pullRequest: number}} expected  the identity the CALLER expects.
 * @returns {{state:'hold', activate:false, keepCodexCurrentHead:true, retireCodexCurrentHead:false,
 *            proven:string[], missing:string[]}}  every required proof, in order, is in exactly one list.
 */
export function roleTransferActivationVerdict(evidence, expected) {
  const cycle = evidence?.cycle ?? null;
  const records = evidence?.records ?? {};
  const {
    initialCi = null,
    initialFinding = null,
    request = null,
    acceptance = null,
    correctivePush = null,
    finalCi = null,
    finalReview = null,
    freshness = null,
  } = records;

  const repository = expected?.repository;
  const pullRequest = expected?.pullRequest;
  const branch = cycle?.branch;
  const baseSha = cycle?.baseSha;
  const originalHeadSha = cycle?.originalHeadSha;
  const correctiveHeadSha = cycle?.correctiveHeadSha;
  const requestId = cycle?.correctionRequestId;

  const cycleOk = evidence?.schema === ROLE_ACTIVATION_EVIDENCE_SCHEMA
    && nonEmpty(repository)
    && Number.isInteger(pullRequest) && pullRequest > 0
    && cycle?.repository === repository
    && cycle?.pullRequest === pullRequest
    && nonEmpty(branch)
    && isSha(baseSha)
    && isSha(originalHeadSha)
    && isSha(correctiveHeadSha)
    && correctiveHeadSha !== originalHeadSha
    && Number.isInteger(requestId);

  // Identity scopes. Every record names the EXPECTED repository; PR-scoped records also the expected PR;
  // base-bound records (CI and reviews) also the cycle base.
  const inRepository = (record) => !!record && record.repository === repository;
  const inPullRequest = (record) => inRepository(record) && record.pullRequest === pullRequest;
  const atBase = (record) => inPullRequest(record) && record.baseSha === baseSha;

  const missing = [];
  const prove = (proof, holds) => { if (!(cycleOk && holds)) missing.push(proof); };

  if (!cycleOk) missing.push('cycleIdentity');

  prove('initialFullCiGreen', atBase(initialCi)
    && initialCi.headSha === originalHeadSha
    && initialCi.state === 'success');

  prove('initialClaudeFinding', atBase(initialFinding)
    && initialFinding.headSha === originalHeadSha
    && initialFinding.state === 'changes_required'
    && nonEmpty(initialFinding.reviewRef)
    && Array.isArray(initialFinding.laterReviewRunIds)
    && initialFinding.laterReviewRunIds.length === 0);

  prove('correctionRequest', inPullRequest(request)
    && request.requestId === requestId
    && request.githubGenerated === true
    && request.humanAuthored === false
    && request.edited === false
    && request.headSha === originalHeadSha
    && nonEmpty(request.findingRef)
    && request.findingRef === initialFinding?.reviewRef);

  prove('codexTaskAcceptance', inPullRequest(acceptance)
    && acceptance.requestId === requestId
    && acceptance.actorLogin === CODEX_LOGIN);

  prove('codexCorrectivePush', inPullRequest(correctivePush)
    && correctivePush.branch === branch
    && correctivePush.activityType === 'push'
    && correctivePush.actorLogin === CODEX_LOGIN
    && correctivePush.beforeSha === originalHeadSha
    && correctivePush.afterSha === correctiveHeadSha
    && correctivePush.ancestry?.status === 'ahead'
    && correctivePush.ancestry?.behindBy === 0
    && correctivePush.ancestry?.mergeBaseSha === originalHeadSha);

  // Every Codex task pushes as the same bot, so actor and time cannot prove causation (another Codex task on
  // the same branch could push first). The reader now reports each corrective commit's `Codex-Fix-Probe`
  // trailers (the binding the request asks for); consuming them is a later unit, so this proof stays missing.
  prove('codexTaskCausation', false);

  const ciDeciderRunIds = Array.isArray(finalCi?.deciders) ? finalCi.deciders.map((run) => run?.checkRunId) : [];
  prove('fullCiGreen', atBase(finalCi)
    && finalCi.headSha === correctiveHeadSha
    && finalCi.state === 'success'
    && ciDeciderRunIds.length > 0
    && ciDeciderRunIds.every(Number.isInteger)
    && finalCi.deciders.every((run) => run.conclusion === 'success'));

  prove('boundClaudeClearReReview', atBase(finalReview)
    && finalReview.headSha === correctiveHeadSha
    && finalReview.state === 'shadow_clear');

  // Every mutable source is a closing read: each starts after the freshness point, so each covers the cycle
  // up to it.
  const closingReads = [
    request?.readAtMs, acceptance?.readAtMs, initialFinding?.readAtMs, initialCi?.readAtMs,
    freshness?.pullReadAtMs, freshness?.pushLogReadAtMs, finalCi?.readAtMs, finalReview?.readAtMs,
    freshness?.eventLogCoveredFromMs, freshness?.eventLogReadAtMs,
  ];
  prove('liveHeadFreshness', inPullRequest(freshness)
    && freshness.branch === branch
    && freshness.baseSha === baseSha
    && freshness.headRepository === repository
    && freshness.baseRepository === repository
    && freshness.baseRef === LINEAGE_BASE_REF
    && freshness.prState === 'open'
    && freshness.liveHeadAtStart === correctiveHeadSha
    && freshness.liveHeadAtEnd === correctiveHeadSha
    && freshness.branchAtEnd === branch
    && freshness.headRepositoryAtEnd === repository
    && freshness.baseRepositoryAtEnd === repository
    && freshness.baseRefAtEnd === LINEAGE_BASE_REF
    && freshness.baseShaAtEnd === baseSha
    // The final live-PR read, after every other closing read (the event log included): an ordinary
    // fast-forward of the base branch appends no PR event, so the base must still be the cycle's here.
    && freshness.prStateAtClose === 'open'
    && freshness.liveHeadAtClose === correctiveHeadSha
    && freshness.baseRefAtClose === LINEAGE_BASE_REF
    && freshness.baseShaAtClose === baseSha
    && freshness.baseRepositoryAtClose === repository
    && finite(freshness.pullFinalReadAtMs)
    && closingReads.every((time) => finite(time) && time < freshness.pullFinalReadAtMs)
    && Array.isArray(freshness.pushesAfterCorrective)
    && freshness.pushesAfterCorrective.length === 0
    // The lifecycle event log covers the cycle from no later than the update that brought the branch to the
    // reviewed head: every workflow for that head (queued or running) was created after it, and the initial
    // CI's deciders must have started after it too (a decider from an earlier arrival of the same SHA could
    // predate the coverage). It is complete and lists only cycle-neutral events (an undated or unknown event
    // is listed, so its kind still decides).
    && freshness.reviewedHeadArrival?.afterSha === originalHeadSha
    && finite(freshness.reviewedHeadArrival?.atMs)
    && finite(initialCi?.startedAtMs)
    && freshness.reviewedHeadArrival.atMs <= initialCi.startedAtMs
    && finite(freshness.lifecycleSinceMs)
    && freshness.lifecycleSinceMs <= freshness.reviewedHeadArrival.atMs
    && Array.isArray(freshness.lifecycleEvents)
    && freshness.lifecycleEvents.every((entry) => CYCLE_NEUTRAL_LIFECYCLE_EVENTS.includes(entry?.event))
    && finite(freshness.startedAtMs)
    && finite(freshness.observedAtMs)
    && freshness.startedAtMs < freshness.observedAtMs
    && closingReads.every((time) => finite(time) && time > freshness.observedAtMs));

  prove('milestoneOrder', ordered([
    { atMs: initialCi?.atMs },
    // The request names this finding (`findingRef === reviewRef`, proven above), so it follows it.
    { atMs: initialFinding?.atMs },
    {
      atMs: request?.atMs,
      tieProvenBy: nonEmpty(request?.findingRef) && request.findingRef === initialFinding?.reviewRef,
    },
    // The acceptance is a reaction ON the request comment, so it follows it.
    {
      atMs: acceptance?.atMs,
      tieProvenBy: Number.isInteger(acceptance?.requestId) && acceptance.requestId === request?.requestId,
    },
    { atMs: correctivePush?.atMs },
    { atMs: finalCi?.atMs },
    { atMs: finalReview?.atMs },
    { atMs: freshness?.startedAtMs },
  ]));

  return {
    state: 'hold',
    activate: false,
    keepCodexCurrentHead: true,
    retireCodexCurrentHead: false,
    proven: ACTIVATION_REQUIRED_PROOFS.filter((proof) => !missing.includes(proof)),
    missing,
  };
}
