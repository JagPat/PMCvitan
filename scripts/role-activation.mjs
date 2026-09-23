import { STATUS_CONTEXT, CLAUDE_SHADOW_CONTEXT } from './review-policy.mjs';

/**
 * Role-transfer ACTIVATION-READINESS contract (pure, mutation-free).
 *
 * The cloud role transfer (Codex codes, Claude independently reviews) is activated
 * — atomically adding the Claude exact-head required gate and switching correction
 * routing — ONLY after one real, OBSERVED cloud cycle. This module defines and
 * enforces that proof sequence. It performs NO switch and touches NO live gate: it
 * reads evidence and returns a verdict. Until the verdict is `activate`, the
 * existing `codex-current-head` (`STATUS_CONTEXT`) required gate stays in force and
 * `claude-independent-review` (`CLAUDE_SHADOW_CONTEXT`) stays non-authoritative and
 * out of the required checks. Nothing here declares Codex awakenable.
 *
 * The proof obligations, each an OBSERVED fact for the SAME corrective head, in the
 * order the sequence must occur:
 *   1. GitHub-generated Codex task acceptance — an automated GitHub event started a
 *      hosted Codex task. A human `@codex` mention is explicitly NOT proof.
 *   2. Same-branch corrective push — that task pushed a new head on the SAME branch,
 *      producing the corrective head SHA.
 *   3. Full CI green on that corrective head.
 *   4. A bound independent Claude finding/clear re-review on that EXACT head — a
 *      server-verified `shadow_clear` from the (still non-authoritative) consumer,
 *      bound to the corrective head SHA.
 *
 * Only when all four hold for one corrective head does the contract permit the
 * atomic switch. Anything missing → HOLD, keep `codex-current-head`.
 */

export const ACTIVATION_REQUIRED_PROOFS = Object.freeze([
  'codexTaskAcceptanceGitHubGenerated',
  'codexCorrectiveSameBranchPush',
  'fullCiGreen',
  'boundClaudeClearReReview',
]);

// What the atomic switch WOULD change, expressed as data. This unit does NOT apply
// any of it; it is the contract a later, operator-authorized step reads once the
// verdict is `activate`. `retire` happens only AFTER `addRequired` is installed and
// observed, never leaving an interval with neither independent-review gate.
export const ACTIVATION_SWITCH = Object.freeze({
  addRequired: CLAUDE_SHADOW_CONTEXT, // claude-independent-review joins the required gate
  retire: STATUS_CONTEXT, // codex-current-head retired — only after the replacement is proved
  codingOwner: 'codex', // correction routing switches: Codex codes
  reviewer: 'claude', // Claude independently reviews
});

const SHA = /^[0-9a-f]{40}$/u;

/**
 * @param {object} evidence
 *   correctiveHeadSha   - 40-hex SHA the corrective push produced
 *   codexTaskAcceptance - { githubGenerated: boolean, humanAuthored?: boolean } observed task-start
 *   correctivePush      - { sameBranch: boolean, headSha: string } observed push
 *   ci                  - { headSha: string, green: boolean } full-CI result on the corrective head
 *   claudeReReview      - { headSha: string, state: string, authoritative?: boolean } consumer verdict
 * @returns {{state:'activate'|'hold', activate:boolean, keepCodexCurrentHead:boolean, missing?:string[], correctiveHeadSha?:string, switch?:object}}
 *   `activate` ONLY when every proof holds for the SAME corrective head; otherwise
 *   `hold` with `keepCodexCurrentHead: true` and the list of missing proofs.
 */
export function roleTransferActivationVerdict(evidence = {}) {
  const {
    correctiveHeadSha = null,
    codexTaskAcceptance = null,
    correctivePush = null,
    ci = null,
    claudeReReview = null,
  } = evidence ?? {};

  const headOk = typeof correctiveHeadSha === 'string' && SHA.test(correctiveHeadSha);
  const missing = [];
  if (!headOk) missing.push('correctiveHeadSha');

  // 1. GitHub-generated (automated) Codex task acceptance — a human @codex mention is not proof.
  if (codexTaskAcceptance?.githubGenerated !== true || codexTaskAcceptance?.humanAuthored === true) {
    missing.push('codexTaskAcceptanceGitHubGenerated');
  }
  // 2. Same-branch corrective push producing exactly this head.
  if (!(correctivePush?.sameBranch === true && headOk && correctivePush?.headSha === correctiveHeadSha)) {
    missing.push('codexCorrectiveSameBranchPush');
  }
  // 3. Full CI green ON the corrective head.
  if (!(ci?.green === true && headOk && ci?.headSha === correctiveHeadSha)) {
    missing.push('fullCiGreen');
  }
  // 4. Bound independent Claude clear re-review on the EXACT corrective head. The consumer stays
  //    non-authoritative; activation readiness READS its verdict — it does not make it a merge gate.
  if (!(claudeReReview?.state === 'shadow_clear' && headOk && claudeReReview?.headSha === correctiveHeadSha)) {
    missing.push('boundClaudeClearReReview');
  }

  if (missing.length > 0) {
    return { state: 'hold', activate: false, keepCodexCurrentHead: true, missing };
  }
  return {
    state: 'activate',
    activate: true,
    keepCodexCurrentHead: false,
    correctiveHeadSha,
    switch: ACTIVATION_SWITCH,
  };
}
