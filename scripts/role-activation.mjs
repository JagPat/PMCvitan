import { STATUS_CONTEXT, CLAUDE_SHADOW_CONTEXT, CLAUDE_STATUS_CONTEXT } from './review-policy.mjs';

/**
 * Role-transfer ACTIVATION-READINESS contract (pure, mutation-free).
 *
 * The cloud role transfer (Codex codes, Claude independently reviews) is activated
 * — atomically adding a Claude exact-head required gate and switching correction
 * routing — ONLY after one real, OBSERVED correction cycle, and `codex-current-head`
 * is retired ONLY after the replacement gate is installed and later observed in that
 * role. This module defines and enforces that proof sequence. It performs NO switch and
 * touches NO live gate: it reads evidence and returns a verdict. Until the verdict is
 * `activate`, the existing `codex-current-head` (`STATUS_CONTEXT`) required gate stays
 * in force and `claude-independent-review` (`CLAUDE_SHADOW_CONTEXT`) stays
 * non-authoritative and out of the required checks. Nothing here declares Codex
 * awakenable.
 *
 * BOUNDARY — pure shape/consistency vs. trusted-consumer authentication. This module
 * verifies that every required evidence field is PRESENT and INTERNALLY CONSISTENT: the
 * same cycle identity (repository, PR, branch, base SHA, reviewed head, correction
 * request) on every record; the correct SHAs; a non-forced fast-forward push whose
 * before/after tips and server-supplied ancestry flag agree; and a monotonic time
 * order (initial runs before the corrective push, final runs after it, the retire
 * observation after its installation). It does NOT and cannot AUTHENTICATE evidence
 * against GitHub. PRODUCING and server-verifying these fields — the repository match to
 * the installation, the ancestry/fast-forward comparison, and the authenticated run,
 * observation and installation identities and their ordering — is the trusted
 * consumer's responsibility, exactly as the shadow path delegates producer
 * authentication to `verifyClaudeShadowProducer`. A forged field is a consumer-
 * authentication failure, not a gap this pure verdict closes.
 *
 * The proof obligations bind ONE correction cycle on EVERY identity and ordering
 * dimension, in the order the cycle occurs:
 *   0a. Initial full CI green on the reviewed head, at the cycle base, for this
 *       request, run BEFORE the corrective push.
 *   0b. The initial Claude finding (`changes_required`) on that head that TRIGGERED
 *       this request, at the cycle base, run BEFORE the corrective push.
 *   1.  GitHub-generated Codex task acceptance for THIS request that CAUSED exactly the
 *       corrective head. A human `@codex` mention is NOT proof.
 *   2.  Same-branch corrective push for THIS request: a NON-FORCED fast-forward whose
 *       before tip is the reviewed head and after tip is the corrective head, with the
 *       reviewed head a server-verified ancestor of the corrective head. before/after
 *       alone is insufficient (a force push can carry any tips), so ancestry is proven,
 *       not assumed — admitting a task that pushed more than one commit.
 *   3.  Full CI green on the corrective head, at the cycle base, for THIS request, run
 *       AFTER the corrective push.
 *   4.  A bound independent Claude clear re-review on that EXACT corrective head, at the
 *       cycle base, for THIS request, run AFTER the corrective push — a server-verified
 *       `shadow_clear` from the (non-authoritative) consumer. Binding the request and
 *       the after-push order defeats replay of a prior clear on a restored SHA.
 *
 * Anything missing → HOLD, keep `codex-current-head`. When every cycle proof holds the
 * verdict permits activation in TWO phases so no interval is ever left with neither
 * independent-review gate:
 *   - `activate` — INSTALL the replacement gate (a distinct trusted-controller status,
 *     `CLAUDE_STATUS_CONTEXT`, the controller publishes from ADAPTER-VERIFIED shadow
 *     evidence, never the raw producer check name) and switch routing, while KEEPING
 *     `codex-current-head` required.
 *   - `retire` — only once a SEPARATE, concretely bound proof shows that replacement
 *     gate installed as required for THIS repository AND, at a strictly LATER time,
 *     observed passing in role on a real head under an identified trusted-controller
 *     observation, does the verdict retire `codex-current-head`.
 */

// The cycle proofs, in the order the correction cycle must occur. Retirement of the old
// gate is a SEPARATE proof (below), never one of these.
export const ACTIVATION_REQUIRED_PROOFS = Object.freeze([
  'cycleIdentity',
  'initialFullCiGreen',
  'initialClaudeFinding',
  'codexTaskAcceptanceGitHubGenerated',
  'codexCorrectiveSameBranchPush',
  'fullCiGreen',
  'boundClaudeClearReReview',
]);

// Retirement of `codex-current-head` is gated on this SEPARATE proof: the replacement
// gate must be installed as required for this repository AND observed in that role, at a
// strictly later time, under an identified trusted-controller observation.
export const ACTIVATION_RETIRE_PROOF = 'replacementGateInstalledObserved';

// The INSTALL half of the switch, applied in the `activate` phase: add the trusted-
// controller replacement status as required and swap correction routing. It does NOT
// retire the old gate. `addRequired` is the trusted-controller status, NOT the raw
// `claude-independent-review` check name — promoting the raw producer check would let a
// PR-emitted check of that name satisfy branch protection without a verified review.
export const ACTIVATION_INSTALL = Object.freeze({
  addRequired: CLAUDE_STATUS_CONTEXT, // trusted-controller status over ADAPTER-VERIFIED shadow evidence
  codingOwner: 'codex', // correction routing switches: Codex codes
  reviewer: 'claude', // Claude independently reviews
});

// The RETIRE half, applied ONLY in the `retire` phase, after the replacement gate is
// installed and later observed in role — never leaving an interval with neither gate.
export const ACTIVATION_RETIRE = Object.freeze({
  retire: STATUS_CONTEXT, // codex-current-head retired, only after the replacement is proved in role
});

// The whole switch, as data, for documentation/consumers. This unit APPLIES none of it.
export const ACTIVATION_SWITCH = Object.freeze({ ...ACTIVATION_INSTALL, ...ACTIVATION_RETIRE });

const SHA = /^[0-9a-f]{40}$/u;
const isSha = (x) => typeof x === 'string' && SHA.test(x);
const nonEmpty = (x) => typeof x === 'string' && x.length > 0;
const finite = (x) => Number.isFinite(x);

/**
 * @param {object} evidence
 *   cycle               - { pullRequest:int>0, branch, repository, baseSha:sha, originalHeadSha:sha, correctionRequestId }
 *                         the single identity every record below must match
 *   correctiveHeadSha   - 40-hex SHA the corrective push produced (must differ from originalHeadSha)
 *   initialCi           - { pullRequest, branch, baseSha, headSha, green, correctionRequestId, ranAtMs } CI on the reviewed head
 *   initialClaudeFinding- { pullRequest, branch, baseSha, headSha, state, correctionRequestId, ranAtMs } the triggering finding
 *   codexTaskAcceptance - { pullRequest, branch, githubGenerated, humanAuthored?, correctionRequestId, causedHeadSha }
 *   correctivePush      - { pullRequest, branch, sameBranch, forced, originalIsAncestor, beforeSha, afterSha, correctionRequestId, pushedAtMs }
 *   ci                  - { pullRequest, branch, baseSha, headSha, green, correctionRequestId, ranAtMs } CI on the corrective head
 *   claudeReReview      - { pullRequest, branch, baseSha, headSha, state, correctionRequestId, ranAtMs } consumer verdict on corrective head
 *   replacementGate     - { context, repository, installedRequired, observedInRole, installedAtMs, observedAtMs,
 *                           observedHeadSha, observationId } the SEPARATE, repository-bound + ordered retire proof
 * @returns {{state:'hold'|'activate'|'retire', activate:boolean, keepCodexCurrentHead:boolean,
 *            retireCodexCurrentHead:boolean, missing?:string[], missingForRetire?:string[],
 *            correctiveHeadSha?:string, install?:object, retire?:object, switch?:object}}
 */
export function roleTransferActivationVerdict(evidence = {}) {
  const {
    cycle = null,
    correctiveHeadSha = null,
    initialCi = null,
    initialClaudeFinding = null,
    codexTaskAcceptance = null,
    correctivePush = null,
    ci = null,
    claudeReReview = null,
    replacementGate = null,
  } = evidence ?? {};

  const pr = cycle?.pullRequest;
  const branch = cycle?.branch;
  const repository = cycle?.repository;
  const baseSha = cycle?.baseSha;
  const originalHeadSha = cycle?.originalHeadSha;
  const requestId = cycle?.correctionRequestId;

  // The cycle identity itself must be well-formed and the corrective head a NEW head.
  const cycleOk =
    Number.isInteger(pr) && pr > 0
    && nonEmpty(branch)
    && nonEmpty(repository)
    && isSha(baseSha)
    && isSha(originalHeadSha)
    && nonEmpty(requestId)
    && isSha(correctiveHeadSha)
    && correctiveHeadSha !== originalHeadSha;

  // A record belongs to this cycle only if it names the same PR, branch, and request.
  const inCycle = (r) => !!r && r.pullRequest === pr && r.branch === branch && r.correctionRequestId === requestId;
  // A base-dependent record (CI/review) must additionally name the cycle's base SHA.
  const inCycleBase = (r) => inCycle(r) && r.baseSha === baseSha;
  // Time ordering relative to the corrective push, so a run cannot be recombined out of order.
  const pushedAtMs = correctivePush?.pushedAtMs;
  const ranBeforePush = (r) => finite(r?.ranAtMs) && finite(pushedAtMs) && r.ranAtMs < pushedAtMs;
  const ranAfterPush = (r) => finite(r?.ranAtMs) && finite(pushedAtMs) && r.ranAtMs > pushedAtMs;

  const missing = [];
  if (!cycleOk) missing.push('cycleIdentity');

  // 0a. Initial full CI green on the reviewed head, at the cycle base, for this request, before the push.
  if (!(cycleOk && inCycleBase(initialCi) && initialCi.headSha === originalHeadSha
    && initialCi.green === true && ranBeforePush(initialCi))) {
    missing.push('initialFullCiGreen');
  }
  // 0b. The initial Claude finding on the reviewed head that triggered THIS request, before the push.
  if (!(cycleOk && inCycleBase(initialClaudeFinding)
    && initialClaudeFinding.headSha === originalHeadSha
    && initialClaudeFinding.state === 'changes_required'
    && ranBeforePush(initialClaudeFinding))) {
    missing.push('initialClaudeFinding');
  }
  // 1. GitHub-generated (automated) Codex task acceptance for THIS request that caused the corrective head.
  if (!(cycleOk && inCycle(codexTaskAcceptance)
    && codexTaskAcceptance.githubGenerated === true
    && codexTaskAcceptance.humanAuthored !== true
    && codexTaskAcceptance.causedHeadSha === correctiveHeadSha)) {
    missing.push('codexTaskAcceptanceGitHubGenerated');
  }
  // 2. Same-branch corrective push for THIS request: a NON-FORCED fast-forward advancing the tip from the
  //    reviewed head to the corrective head, with the reviewed head a (server-verified) ancestor. before/after
  //    tips prove the endpoints; `forced === false && originalIsAncestor === true` proves the ancestry a force
  //    push could otherwise fake — admitting a multi-commit push without requiring exactly one commit.
  if (!(cycleOk && inCycle(correctivePush)
    && correctivePush.sameBranch === true
    && correctivePush.forced === false
    && correctivePush.originalIsAncestor === true
    && correctivePush.beforeSha === originalHeadSha
    && correctivePush.afterSha === correctiveHeadSha
    && finite(pushedAtMs))) {
    missing.push('codexCorrectiveSameBranchPush');
  }
  // 3. Full CI green ON the corrective head, at the cycle base, for THIS request, AFTER the push.
  if (!(cycleOk && inCycleBase(ci) && ci.headSha === correctiveHeadSha
    && ci.green === true && ranAfterPush(ci))) {
    missing.push('fullCiGreen');
  }
  // 4. Bound independent Claude clear re-review on the EXACT corrective head, at the cycle base, for THIS
  //    request, AFTER the push. The consumer stays non-authoritative; activation readiness READS its verdict.
  if (!(cycleOk && inCycleBase(claudeReReview)
    && claudeReReview.headSha === correctiveHeadSha
    && claudeReReview.state === 'shadow_clear'
    && ranAfterPush(claudeReReview))) {
    missing.push('boundClaudeClearReReview');
  }

  if (missing.length > 0) {
    return {
      state: 'hold',
      activate: false,
      keepCodexCurrentHead: true,
      retireCodexCurrentHead: false,
      missing,
    };
  }

  // The full cycle is proven. Retiring `codex-current-head` is a SEPARATE proof, bound to THIS repository
  // and ORDERED: the replacement gate (the trusted-controller status) must be installed as required for this
  // repository AND, at a strictly later time, observed passing in that role on a real head under an
  // identified trusted-controller observation. Until then INSTALL the replacement and switch routing but
  // KEEP `codex-current-head` — never an interval with neither independent-review gate. A record that is a
  // bare context + two booleans, or whose repository is not this cycle's, must not retire the old gate.
  const replacementObserved =
    !!replacementGate
    && replacementGate.context === CLAUDE_STATUS_CONTEXT
    && replacementGate.repository === repository
    && replacementGate.installedRequired === true
    && replacementGate.observedInRole === true
    && isSha(replacementGate.observedHeadSha)
    && nonEmpty(replacementGate.observationId)
    && finite(replacementGate.installedAtMs)
    && finite(replacementGate.observedAtMs)
    && replacementGate.observedAtMs > replacementGate.installedAtMs;

  if (!replacementObserved) {
    return {
      state: 'activate',
      activate: true,
      keepCodexCurrentHead: true,
      retireCodexCurrentHead: false,
      correctiveHeadSha,
      install: ACTIVATION_INSTALL,
      missingForRetire: [ACTIVATION_RETIRE_PROOF],
    };
  }
  return {
    state: 'retire',
    activate: true,
    keepCodexCurrentHead: false,
    retireCodexCurrentHead: true,
    correctiveHeadSha,
    install: ACTIVATION_INSTALL,
    retire: ACTIVATION_RETIRE,
    switch: ACTIVATION_SWITCH,
  };
}
