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
 * The proof obligations bind ONE correction cycle on EVERY identity dimension. Each
 * record must name the SAME cycle identity — the correction request, PR, branch, the
 * base SHA the cycle is reviewed against, and the pre-correction (reviewed) head — so
 * evidence from a different PR/branch/request, a different base (a retarget or an
 * advancing `main`), or supplied out of order cannot be recombined into a false
 * `activate`. In the order the cycle occurs:
 *   0a. Initial full CI green on the reviewed head, at the cycle's base.
 *   0b. The initial Claude finding on that head that TRIGGERED this correction request
 *       (a `changes_required` shadow review bound to the request id, at the cycle's
 *       base) — the full-cycle contract's "Claude findings" leg.
 *   1.  GitHub-generated Codex task acceptance for THIS request — an automated GitHub
 *       event started a hosted Codex task that CAUSED exactly the corrective head. A
 *       human `@codex` mention is explicitly NOT proof.
 *   2.  Same-branch corrective push for THIS request — the branch update advanced the
 *       tip from the reviewed head (`before === originalHead`) to the corrective head
 *       (`after === correctiveHead`). Ancestry is proven by the push event's
 *       before/after tips, so a task that pushes MORE THAN ONE commit is admitted (the
 *       reviewed head need not be the final commit's direct parent).
 *   3.  Full CI green on that corrective head, at the cycle's base.
 *   4.  A bound independent Claude clear re-review on that EXACT corrective head, at the
 *       cycle's base — a server-verified `shadow_clear` from the (non-authoritative)
 *       consumer.
 *
 * Anything missing → HOLD, keep `codex-current-head`. When every cycle proof holds the
 * verdict permits activation, but in TWO phases so no interval is ever left with
 * neither independent-review gate:
 *   - `activate` — INSTALL the replacement gate and switch routing while KEEPING
 *     `codex-current-head` required. The replacement gate is a distinct trusted-
 *     controller status (`CLAUDE_STATUS_CONTEXT`) the controller publishes from
 *     ADAPTER-VERIFIED shadow evidence, never the raw producer check name.
 *   - `retire` — only once a SEPARATE, concretely bound proof shows that replacement
 *     gate installed as required AND, at a strictly LATER time, observed passing in
 *     that role on a real head under an identified trusted-controller observation, does
 *     the verdict retire `codex-current-head`.
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
// gate must be installed as required AND observed in that role, at a strictly later
// time, under an identified trusted-controller observation.
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

/**
 * @param {object} evidence
 *   cycle               - { pullRequest:int>0, branch:string, baseSha:sha, originalHeadSha:sha, correctionRequestId:string }
 *                         the single identity every record below must match
 *   correctiveHeadSha   - 40-hex SHA the corrective push produced (must differ from originalHeadSha)
 *   initialCi           - { pullRequest, branch, baseSha, headSha, green } full CI on the reviewed head
 *   initialClaudeFinding- { pullRequest, branch, baseSha, headSha, state, correctionRequestId } the triggering finding
 *   codexTaskAcceptance - { pullRequest, branch, githubGenerated, humanAuthored?, correctionRequestId, causedHeadSha }
 *   correctivePush      - { pullRequest, branch, sameBranch, beforeSha, afterSha, correctionRequestId } the branch-update event
 *   ci                  - { pullRequest, branch, baseSha, headSha, green } full CI on the corrective head
 *   claudeReReview      - { pullRequest, branch, baseSha, headSha, state, authoritative? } consumer verdict on corrective head
 *   replacementGate     - { context, repository, installedRequired, observedInRole, installedAtMs, observedAtMs,
 *                           observedHeadSha, observationId } the SEPARATE, bound + ordered retire proof
 * @returns {{state:'hold'|'activate'|'retire', activate:boolean, keepCodexCurrentHead:boolean,
 *            retireCodexCurrentHead:boolean, missing?:string[], missingForRetire?:string[],
 *            correctiveHeadSha?:string, install?:object, retire?:object, switch?:object}}
 *   `hold` (keep codex-current-head) when any cycle proof is missing; `activate` (install the
 *   replacement, KEEP codex-current-head) when the full cycle holds but the replacement is not yet
 *   observed; `retire` (drop codex-current-head) only once it is installed and later observed.
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
  const baseSha = cycle?.baseSha;
  const originalHeadSha = cycle?.originalHeadSha;
  const requestId = cycle?.correctionRequestId;

  // The cycle identity itself must be well-formed and the corrective head a NEW head.
  const cycleOk =
    Number.isInteger(pr) && pr > 0
    && nonEmpty(branch)
    && isSha(baseSha)
    && isSha(originalHeadSha)
    && nonEmpty(requestId)
    && isSha(correctiveHeadSha)
    && correctiveHeadSha !== originalHeadSha;

  // A record belongs to this cycle only if it names the same PR and branch.
  const inCycle = (r) => !!r && r.pullRequest === pr && r.branch === branch;
  // A base-dependent record (CI/review) must additionally name the cycle's base SHA, so
  // evidence from a retargeted or advanced base cannot be recombined.
  const inCycleBase = (r) => inCycle(r) && r.baseSha === baseSha;

  const missing = [];
  if (!cycleOk) missing.push('cycleIdentity');

  // 0a. Initial full CI green on the reviewed head, at the cycle base.
  if (!(cycleOk && inCycleBase(initialCi) && initialCi.headSha === originalHeadSha && initialCi.green === true)) {
    missing.push('initialFullCiGreen');
  }
  // 0b. The initial Claude finding on the reviewed head that triggered THIS request, at the cycle base.
  if (!(cycleOk && inCycleBase(initialClaudeFinding)
    && initialClaudeFinding.headSha === originalHeadSha
    && initialClaudeFinding.state === 'changes_required'
    && initialClaudeFinding.correctionRequestId === requestId)) {
    missing.push('initialClaudeFinding');
  }
  // 1. GitHub-generated (automated) Codex task acceptance for THIS request that caused the corrective head.
  if (!(cycleOk && inCycle(codexTaskAcceptance)
    && codexTaskAcceptance.githubGenerated === true
    && codexTaskAcceptance.humanAuthored !== true
    && codexTaskAcceptance.correctionRequestId === requestId
    && codexTaskAcceptance.causedHeadSha === correctiveHeadSha)) {
    missing.push('codexTaskAcceptanceGitHubGenerated');
  }
  // 2. Same-branch corrective push for THIS request: the branch update advanced the tip from the reviewed
  //    head to the corrective head. before/after tips prove ancestry without requiring exactly one commit.
  if (!(cycleOk && inCycle(correctivePush)
    && correctivePush.sameBranch === true
    && correctivePush.beforeSha === originalHeadSha
    && correctivePush.afterSha === correctiveHeadSha
    && correctivePush.correctionRequestId === requestId)) {
    missing.push('codexCorrectiveSameBranchPush');
  }
  // 3. Full CI green ON the corrective head, at the cycle base.
  if (!(cycleOk && inCycleBase(ci) && ci.headSha === correctiveHeadSha && ci.green === true)) {
    missing.push('fullCiGreen');
  }
  // 4. Bound independent Claude clear re-review on the EXACT corrective head, at the cycle base. The
  //    consumer stays non-authoritative; activation readiness READS its verdict — it is not a merge gate.
  if (!(cycleOk && inCycleBase(claudeReReview)
    && claudeReReview.headSha === correctiveHeadSha
    && claudeReReview.state === 'shadow_clear')) {
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

  // The full cycle is proven. Retiring `codex-current-head` is a SEPARATE proof, bound and ORDERED: the
  // replacement gate (the trusted-controller status) must be installed as required AND, at a strictly
  // later time, observed passing in that role on a real head under an identified trusted-controller
  // observation. Until then INSTALL the replacement and switch routing but KEEP `codex-current-head` —
  // never an interval with neither independent-review gate. A record of only a context + two booleans is
  // insufficient: a stale or unrelated observation must not retire the old gate.
  const replacementObserved =
    !!replacementGate
    && replacementGate.context === CLAUDE_STATUS_CONTEXT
    && nonEmpty(replacementGate.repository)
    && replacementGate.installedRequired === true
    && replacementGate.observedInRole === true
    && isSha(replacementGate.observedHeadSha)
    && nonEmpty(replacementGate.observationId)
    && Number.isFinite(replacementGate.installedAtMs)
    && Number.isFinite(replacementGate.observedAtMs)
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
