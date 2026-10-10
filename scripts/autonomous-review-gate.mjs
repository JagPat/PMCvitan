import {
  requiredChecksForPullRequest,
  reviewHistoryPolicy,
  MAX_REVIEW_ATTEMPTS,
  CHECK_TIMEOUT_MS,
  REVIEW_TIMEOUT_MS,
  POLL_INTERVAL_MS,
  REQUIRED_CHECKS,
  STATUS_CONTEXT,
  FOLLOW_UP_RETRY,
  OWNERSHIP_READ_RETRY,
  OWNERSHIP_CANDIDATE_HELD,
  CI_SCOPE_ADMITTED,
  WORK_ITEM_TRAILER_SCOPE,
  WORK_ITEM_APPROVAL_WITHDRAWN,
  ownershipInconsistentScopeDetail,
  isOwnershipInconsistentScopeDetail,
  isBodyOnlyOwnershipRecoveryDetail,
  REVIEW_ROUND_CAP,
} from './review-policy.mjs';
export {
  requiredChecksForPullRequest,
  MAX_REVIEW_ATTEMPTS,
  CHECK_TIMEOUT_MS,
  REVIEW_TIMEOUT_MS,
  POLL_INTERVAL_MS,
  REQUIRED_CHECKS,
} from './review-policy.mjs';

import { readFile } from 'node:fs/promises';
import { affectedProducts } from './ci-affected.mjs';
import { pathToFileURL } from 'node:url';

import {
  codexThreadIdsToResolve,
  classifyCodexState,
  isEligiblePullRequest,
} from './autonomous-review-state.mjs';
import { observeReviewLifecycle, lifecycleAdvisory } from './review-lifecycle.mjs';
import { reviewCapState } from './review-cap.mjs';
import { fileFollowUp, findingIdentity, reconcilePendingFollowUps, recordPendingFollowUp, renderFollowUpLines } from './review-follow-up.mjs';
import {
  CORRECTION_STALLED,
  correctionOwnerDeclaration,
  readHeadCommitMessage,
  correctionRouting,
  shaMergeAuthority,
} from './correction-owner.mjs';
import { classifyClaudeShadowReview } from './claude-review-adapter.mjs';
import {
  assessReviewScope,
  isRetryableReviewFailureDescription,
  codexFindingHeads,
  PRE_REVIEW_ENFORCE_AFTER_PR,
  REPLACEMENT_REQUIRED_LABEL,
} from './review-efficiency.mjs';
import { parseWorkItemTrailer } from './work-item-trailer.mjs';
import { approvalToken, classifyIssueRead, parseApprovalToken, tokenMatchesTrailer, withApprovalToken } from './work-item-approval.mjs';
import { assessCommittedDirectiveClearance, githubProvenanceReader, headCommitFromGitHub } from './autonomous-drain-clearance.mjs';
import {
  PRODUCT_CHECKS,
  attemptGateStamps,
  attemptsWithPassingGates,
  coverageOrder,
  coverageStamp,
  gateWatermarks,
  newestFirst,
  recency,
} from './check-run-coverage.mjs';

// Owner decision 2026-10-08 (rule 7): the required product checks are the ones this PR's files affect —
// the same `affectedProducts` the CI battery plan launched. An unreadable file list requires them all.
async function requiredChecksFor(client, pullRequest) {
  let files = null;
  try {
    files = typeof client.pullRequestFiles === 'function' ? await client.pullRequestFiles(pullRequest.number) : null;
  } catch {
    files = null;
  }
  return requiredChecksForPullRequest(
    pullRequest.number,
    Array.isArray(files) ? affectedProducts(files).products : null,
  );
}

const RECOVERY_CONTEXT_PREFIX = 'codex-recovery-request/';
const COMMENT_MARKER = '<!-- autonomous-review-state -->';
const API_ROOT = 'https://api.github.com';
// Identify the CI attempt a check run belongs to. `check_suite.id` is the
// authoritative grouping key — every job of one workflow run shares a check
// suite — and it does not depend on URL shape. The URL parse stays as a
// fallback for payloads without the suite (GitHub Actions check runs carry
// /actions/runs/<workflow_run_id>/job/<job_id> in BOTH html_url and
// details_url; this repository's live responses were verified to do so).
function attemptOf(run) {
  const suite = run?.check_suite?.id;
  if (suite !== undefined && suite !== null) return `suite:${suite}`;
  for (const url of [run?.html_url, run?.details_url]) {
    const match = /\/actions\/runs\/(\d+)\//u.exec(typeof url === 'string' ? url : '');
    if (match) return `run:${match[1]}`;
  }
  return null;
}

// A product job is skipped either because the battery plan decided this head is
// already covered — both gates of `needs: [review-scope, battery-plan]` green,
// so the skip was the plan's `run_products=false` — or because one of those
// gates failed/cancelled, in which case the attempt was aborted and proves
// nothing. Only the first kind may defer to older evidence.
//
// Only an attempt whose gates ALL passed skipped deliberately; anything else
// aborted, and an aborted attempt's skips prove nothing. `attemptsWithPassingGates`
// is the shared definition — the battery plan's watermark reads the same set,
// so the two cannot disagree about which skips preserve older evidence.
function intentionalSkip(skipped, gatesPassed) {
  const attempt = attemptOf(skipped);
  return attempt !== null && gatesPassed.has(attempt);
}

export function summarizeRequiredChecks(checkRuns, requiredChecks = REQUIRED_CHECKS) {
  const { state, missing, pending, failed } = resolveRequiredChecks(checkRuns, requiredChecks);
  return { state, missing, pending, failed };
}

// The summary above plus, per required name that reached a verdict (failed or passed), the ONE run that
// decided it. Evidence readers that must date or bind the CI verdict use these runs — never every run of a
// required name, since a superseded straggler can finish after the run that actually decides.
export function resolveRequiredChecks(checkRuns, requiredChecks = REQUIRED_CHECKS) {
  const watermarks = gateWatermarks(checkRuns);
  const attemptStamps = attemptGateStamps(checkRuns);
  const gatesPassed = attemptsWithPassingGates(checkRuns);
  const missing = [];
  const pending = [];
  const failed = [];
  const deciders = [];

  for (const name of requiredChecks) {
    const runs = checkRuns.filter((run) => run.name === name);
    if (runs.length === 0) {
      missing.push(name);
      continue;
    }
    // The NEWEST evidence decides, including whether we are still waiting.
    // Asking "is ANY run of this name unfinished?" over the full `filter=all`
    // history let a superseded attempt's still-running job hold the head
    // pending until timeout even though the current attempt had already passed
    // that check — the job will report on a merge result nobody is asking about.
    //
    // A PRODUCT job is ordered by ATTEMPT currency first, not completion time:
    // one from a superseded attempt can still be running when a retarget lands
    // and finish after the current attempt's run of the same name has already
    // failed, and a completion-ordered sort selects that stale success and
    // publishes green over red exact-head CI. Within one attempt (a
    // rerun-failed-jobs keeps the suite) completion still decides, so a rerun
    // continues to mask the failure it repaired.
    //
    // A GATE dates ITSELF. Attempt currency is the completion of the gates that
    // LAUNCHED a run — meaningful for a product, circular for a gate, which
    // would inherit its sibling's stamp: a `review-scope` that passed at 11:00
    // in an attempt whose `battery-plan` finished at 11:10 would outrank a
    // NEWER `review-scope` failure at 11:05 and this gate would publish success
    // over a red current scope check.
    const ordered = [...runs].sort(
      PRODUCT_CHECKS.includes(name) ? coverageOrder(attemptStamps) : newestFirst,
    );
    if (ordered[0].status !== 'completed') {
      pending.push(name);
      continue;
    }
    const completed = ordered.filter((run) => run.status === 'completed');
    // One SHA can carry several completed runs of the same check: an `edited`
    // re-run of the scope check, or product jobs the battery plan skipped.
    // A skipped run may defer to older evidence ONLY when the skip was the
    // plan's deliberate "this head is already covered" decision. A skip caused
    // by an upstream failure (review-scope red, or battery-plan itself failed
    // or cancelled) means the products of THAT attempt never ran, and older
    // evidence may predate the change that attempt was testing — so it counts
    // as a real non-success and fails closed.
    const decider = completed
      .find((run) => run.conclusion !== 'skipped' || !intentionalSkip(run, gatesPassed));
    if (!decider) {
      // A deliberate skip deferring to evidence that is itself still running is
      // waiting, not absent.
      (completed.length < runs.length ? pending : missing).push(name);
      continue;
    }
    if (decider.conclusion !== 'success') {
      failed.push(name);
      deciders.push(decider);
      continue;
    }
    // A passing product run must belong to the CURRENT attempt. Product jobs
    // are created after the gates that launch them, so a product completion
    // older than a gate attempt that produced no run OF THIS NAME belongs to a
    // superseded attempt — the retarget window in which the new base's gates
    // are green, this product's job does not exist yet, and the old base's
    // success would otherwise let this gate publish success for a merge result
    // it never tested. Per-name, because a newer attempt's five product runs
    // appear one at a time: `web` being visible says nothing about `api`.
    // Not yet run is pending, not failed.
    // Dated by the ATTEMPT that launched it, not by when it finished: a
    // straggler from the superseded base can complete after the new base's
    // gates and would otherwise pass a timestamp-only comparison.
    if (
      PRODUCT_CHECKS.includes(name)
      && coverageStamp(decider, attemptStamps) < (watermarks.get(name) ?? '')
    ) {
      pending.push(name);
      continue;
    }
    deciders.push(decider);
  }

  return {
    deciders,
    state:
      failed.length > 0
        ? 'failure'
        : missing.length > 0 || pending.length > 0
          ? 'pending'
          : 'success',
    missing,
    pending,
    failed,
  };
}

export function isTerminalReviewStatus(status) {
  if (!status || status.state === 'pending') return false;
  if (status.state === 'success') return true;
  if (status.state !== 'failure') return false;

  const description = status.description ?? '';
  return description.startsWith('review:')
    // Ownership-verdict lifecycle (unit 2A2-i): an `unreadable` head is published as this `validation:`-prefixed
    // status. It is a TERMINAL review failure so the recovery authorizer can classify it — and it is in the
    // shared retryable set, so it resolves as retryable (gate recovers) rather than persistent (owed).
    || description.startsWith(OWNERSHIP_READ_RETRY)
    || description.includes('current-head Codex finding')
    || description.includes('Codex submitted a current-head review')
    || description.includes('Codex review timed out')
    || description.includes('Codex evidence changed');
}

export function shouldDraftForCiFailure(status) {
  return !(
    isTerminalReviewStatus(status)
    && status.state === 'success'
  );
}

export function shouldRetryCiFailure(context, existingStatus, failedChecks = [], { candidateScope = false } = {}) {
  return context?.trigger === 'ci'
    && context.ciConclusion
    && context.ciConclusion !== 'success'
    && Number.isInteger(context.ciRunId)
    && context.ciRunId > 0
    && context.ciRunAttempt === 1
    && (candidateScope || !failedChecks.includes('review-scope'))
    && !isTerminalReviewStatus(existingStatus);
}

// What a failed CI run on one exact head gets. A `review-scope` failure is normally deterministic, so it is
// never retried and the PR drafts. The one exception (Codex finding 4101926931 on #630): a CANDIDATE body
// whose head the CLI could not read. The controller has already re-read that same SHA (`scope`); when its
// read admits the candidate, or is itself still unreadable, the CLI's failure may be only the transient read,
// so the one bounded failed-job retry re-runs the same head with no new head or PR edit. While the head is
// still unreadable the PR is not drafted either, so a later green run on the same head proceeds. A readable
// head that does not declare the candidate never reaches here: scope refuses it first (fail closed).
// `draft` applies only when no retry is taken (the controller returns after requesting one). `reason` routes
// the notice: when the controller's own read ADMITS the candidate, the failed job is a CI failure, not a
// scope refusal, so it must not say "Scope refused this head" or ask for a new head (shadow finding on #630).
export function ciFailureDisposition(context, existingStatus, failedChecks = [], { pullRequest, scope, skipped = [] } = {}) {
  const candidateScope = failedChecks.includes('review-scope')
    && correctionOwnerDeclaration(pullRequest).state === 'candidate'
    && Boolean(scope?.allowed || scope?.retryable);
  // Held as retryable only when review-scope is the sole INDEPENDENT failure. The jobs that need it are
  // skipped when it fails, and the summary counts those skips as failed (Codex finding 4103993627 on #630),
  // so a required check whose deciding run was skipped is its consequence, not a separate failure. Any
  // other failure is real and keeps its ordinary draft and correction; the unread head must not hide it.
  const unreadable = candidateScope && scope?.retryable === true
    && failedChecks.every((name) => name === 'review-scope' || skipped.includes(name));
  const scopeAdmitted = candidateScope && scope?.allowed === true;
  return {
    retry: Boolean(shouldRetryCiFailure(context, existingStatus, failedChecks, { candidateScope })),
    draft: !unreadable && shouldDraftForCiFailure(existingStatus),
    unreadable,
    scopeAdmitted,
    reason: failedChecks.includes('review-scope') && !scopeAdmitted ? 'scope' : 'ci',
  };
}

function statusesAfterLatestReviewPending(statuses) {
  const pendingIndex = statuses.findIndex(isReviewPendingStatus);
  return pendingIndex < 0 ? [] : statuses.slice(0, pendingIndex);
}

export function hasTerminalReviewFailureAfterPending(statuses) {
  return statusesAfterLatestReviewPending(statuses).some((status) =>
    status.context === STATUS_CONTEXT
    && status.state === 'failure'
    && isTerminalReviewStatus(status));
}

export function persistentReviewFailure(statuses) {
  return statuses.find((status) =>
    status.context === STATUS_CONTEXT
    && status.state === 'failure'
    && isTerminalReviewStatus(status)
    && !isRetryableTerminalReviewFailure(status)) ?? null;
}

function hasCiFailureAfterPending(statuses) {
  return statusesAfterLatestReviewPending(statuses).some((status) =>
    status.context === STATUS_CONTEXT
    && status.state === 'failure'
    && status.description?.startsWith('ci:'));
}

function isReviewPendingStatus(status) {
  return status.context === STATUS_CONTEXT
    && status.state === 'pending'
    && (
      status.description?.startsWith('review: pending')
      || status.description?.startsWith('Waiting for required CI')
    );
}

// Ownership-verdict lifecycle (unit 2A2-i′): a candidate-held head is the newest NON-retryable terminal
// ownership state — held for independent-reviewer activation. Recovery selection considers only the newest
// review status, so once a candidate hold is the latest `codex-current-head` status, no older retryable
// review status may authorize or persist a recovery. It is deliberately NOT added to `isTerminalReviewStatus`
// (that would draft/close the head — a readiness mutation outside this unit); it only gates recovery here.
function candidateHoldIsNewestReview(statuses) {
  const latest = (statuses ?? []).find((status) => status.context === STATUS_CONTEXT);
  return latest?.state === 'failure'
    && String(latest?.description ?? '').startsWith(OWNERSHIP_CANDIDATE_HELD);
}

// Neither re-review orchestration nor recovery may act on a head whose newest failure a title/body
// edit cannot change. Two ownership holds are SHA-IMMUTABLE — only reviewer activation or a new head
// resolves them: a candidate hold, and a HEAD-remedy ownership inconsistency (a missing/malformed/
// conflicting trailer). A BODY-remedy inconsistency (the head trailer is valid; only the mandatory PR
// body marker disagrees) IS fixable by a body edit, so it is deliberately EXCLUDED — a re-review must
// still run for it once the body is corrected. This is the superset of `candidateHoldIsNewestReview`
// and gates the same three places recovery selection/authorization did: an older retryable status
// beneath a newer invalid-trailer hold must not be re-selected any more than beneath a candidate hold.
export function immutableOwnershipHoldIsNewestReview(statuses) {
  if (candidateHoldIsNewestReview(statuses)) return true;
  const latest = (statuses ?? []).find((status) => status.context === STATUS_CONTEXT);
  if (latest?.state !== 'failure') return false;
  const detail = String(latest?.description ?? '').replace(/^\s*scope:\s*/u, '');
  // A malformed `Work-Item` trailer is in the immutable head commit: only a new head clears it, so an older
  // retryable status beneath it must not be recovered or re-reviewed either (#761 Codex 4235923859).
  if (detail.startsWith(WORK_ITEM_TRAILER_SCOPE)) return true;
  return isOwnershipInconsistentScopeDetail('scope', detail)
    && !isBodyOnlyOwnershipRecoveryDetail('scope', detail);
}

export function recoverableTerminalReviewStatus(statuses) {
  if (immutableOwnershipHoldIsNewestReview(statuses)) return null;
  const persistentFailure = persistentReviewFailure(statuses);
  if (persistentFailure) return persistentFailure;

  const reviewStatuses = statuses.filter(
    (status) => status.context === STATUS_CONTEXT,
  );
  const terminalIndex = reviewStatuses.findIndex(isTerminalReviewStatus);
  if (terminalIndex < 0) return null;
  if (terminalIndex === 0) return reviewStatuses[0];

  const newerStatuses = reviewStatuses.slice(0, terminalIndex);
  const pendingIndex = newerStatuses.findIndex(isReviewPendingStatus);
  if (pendingIndex < 0) return reviewStatuses[terminalIndex];

  const newerCycleFailedBeforeReview = newerStatuses
    .slice(0, pendingIndex)
    .some((status) =>
      status.state === 'failure' && !isTerminalReviewStatus(status));
  return newerCycleFailedBeforeReview ? reviewStatuses[terminalIndex] : null;
}

function latestTerminalReviewStatus(statuses) {
  return statuses.find((status) =>
    status.context === STATUS_CONTEXT && isTerminalReviewStatus(status)) ?? null;
}

export function pendingRecoveryRequest(statuses) {
  const latestByContext = new Map();
  for (const status of statuses) {
    if (
      status.context?.startsWith(RECOVERY_CONTEXT_PREFIX)
      && !latestByContext.has(status.context)
    ) {
      latestByContext.set(status.context, status);
    }
  }

  let newestRequest = null;
  for (const status of latestByContext.values()) {
    const contextToken = status.context.slice(RECOVERY_CONTEXT_PREFIX.length);
    const descriptionMatch = /^recovery: requested terminal status ([0-9]+)$/u
      .exec(status.description ?? '');
    if (!descriptionMatch || descriptionMatch[1] !== contextToken) continue;
    if (
      !newestRequest
      || BigInt(contextToken) > BigInt(newestRequest.terminalStatusId)
    ) {
      newestRequest = { status, terminalStatusId: contextToken };
    }
  }

  return newestRequest?.status.state === 'pending' ? newestRequest : null;
}

export function recoveryRequestContext(terminalStatusId) {
  return `${RECOVERY_CONTEXT_PREFIX}${terminalStatusId}`;
}

export function recoverySettlementContext(recoveryRequest) {
  return recoveryRequest?.status?.context ?? null;
}

export async function persistRecoveryRequest(
  client,
  expectedHead,
  pullRequest,
  authorizedStatus,
) {
  return client.setStatus(
    expectedHead,
    'pending',
    `recovery: requested terminal status ${authorizedStatus.id}`,
    pullRequest.html_url,
    recoveryRequestContext(authorizedStatus.id),
  );
}

export function recoveryRequestTerminal(statuses, request) {
  if (!request) return null;
  // A newer SHA-immutable ownership hold (candidate OR a head-remedy inconsistency) supersedes a
  // pending recovery request too: it must not keep persisting beneath a hold a metadata edit cannot lift.
  if (immutableOwnershipHoldIsNewestReview(statuses)) return null;
  const sourceIndex = statuses.findIndex((status) =>
    status.context === STATUS_CONTEXT
    && String(status.id) === String(request.terminalStatusId));
  const sourceStatus = sourceIndex < 0 ? null : statuses[sourceIndex];
  if (isReviewPendingStatus(sourceStatus)) {
    const supersedingTerminal = statuses.slice(0, sourceIndex).find((status) =>
      status.context === STATUS_CONTEXT && isTerminalReviewStatus(status));
    if (!supersedingTerminal) return sourceStatus;
    if (persistentReviewFailure(statuses)) return null;
    return isRetryableTerminalReviewFailure(supersedingTerminal)
      ? supersedingTerminal
      : null;
  }
  if (persistentReviewFailure(statuses)) return null;
  const terminalStatus = latestTerminalReviewStatus(statuses);
  if (!isRetryableTerminalReviewFailure(terminalStatus)) return null;
  return String(terminalStatus.id) === String(request.terminalStatusId)
    ? terminalStatus
    : null;
}

export function isRetryableTerminalReviewFailure(status) {
  if (!status || status.state !== 'failure' || !isTerminalReviewStatus(status)) {
    return false;
  }
  return isRetryableReviewFailureDescription(status.description);
}

export function authorizeRecoveryDispatch(statuses, requestedStatusId) {
  // A newer SHA-immutable ownership hold (candidate OR a head-remedy inconsistency) supersedes any
  // older retryable status: hold the head, authorize no recovery. Restricting this to candidate holds
  // let an older retryable status beneath a newer invalid-trailer hold be re-selected for dispatch.
  if (immutableOwnershipHoldIsNewestReview(statuses)) return null;
  if (persistentReviewFailure(statuses)) return null;
  const latestReviewStatus = statuses.find(
    (status) => status.context === STATUS_CONTEXT,
  );
  if (isReviewPendingStatus(latestReviewStatus)) {
    if (String(latestReviewStatus.id) === String(requestedStatusId)) {
      return latestReviewStatus;
    }
  }
  let terminalStatus = recoverableTerminalReviewStatus(statuses);
  if (!terminalStatus) {
    const existingRequest = pendingRecoveryRequest(statuses);
    if (
      existingRequest
      && String(existingRequest.terminalStatusId) === String(requestedStatusId)
    ) {
      terminalStatus = recoveryRequestTerminal(statuses, existingRequest);
    }
  }
  if (!isRetryableTerminalReviewFailure(terminalStatus)) return null;
  return String(terminalStatus.id) === String(requestedStatusId)
    ? terminalStatus
    : null;
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function requiredEnvironment(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

export class GitHubClient {
  constructor({ repository, token }) {
    this.repository = repository;
    this.token = token;
  }

  async request(path, { method = 'GET', body } = {}) {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      let response;
      let text;
      let payload;
      try {
        response = await fetch(`${API_ROOT}${path}`, {
          method,
          headers: {
            Accept: 'application/vnd.github+json',
            Authorization: `Bearer ${this.token}`,
            'Content-Type': 'application/json',
            'X-GitHub-Api-Version': '2022-11-28',
          },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
        text = await response.text();
        payload = text ? JSON.parse(text) : null;
      } catch (error) {
        if (method !== 'GET' || attempt === 3) throw error;
        await sleep(attempt * 250);
        continue;
      }
      if (response.ok) return payload;
      if (method === 'GET' && response.status >= 500 && attempt < 3) {
        await sleep(attempt * 250);
        continue;
      }
      throw new Error(
        `GitHub ${method} ${path} failed (${response.status}): ${text}`,
      );
    }
    throw new Error(`GitHub ${method} ${path} retry loop exhausted`);
  }

  async graphql(query, variables) {
    const payload = await this.request('/graphql', {
      method: 'POST',
      body: { query, variables },
    });
    if (payload.errors?.length) {
      // Keep the structured error entries on the thrown Error. A caller that must recognise ONE specific
      // GraphQL error (e.g. "auto merge is not enabled") inspects each entry's `message` — never a substring
      // of this wrapper string, which embeds the mutation `path` (`disablePullRequestAutoMerge`, etc.) and so
      // would match a test meant for the failure reason against EVERY GraphQL error, genuine ones included.
      const error = new Error(`GitHub GraphQL failed: ${JSON.stringify(payload.errors)}`);
      error.graphqlErrors = payload.errors;
      throw error;
    }
    return payload.data;
  }

  pullRequest(number) {
    return this.request(`/repos/${this.repository}/pulls/${number}`);
  }

  async commit(head) {
    let commit;
    const files = [];
    let page = 1;
    while (true) {
      const batch = await this.request(
        `/repos/${this.repository}/commits/${head}?per_page=100&page=${page}`,
      );
      commit ??= batch;
      const pageFiles = batch.files ?? [];
      files.push(...pageFiles);
      if (pageFiles.length < 100) return { ...commit, files };
      page += 1;
    }
  }

  async checkRuns(head) {
    // filter=all (paginated), not filter=latest: one SHA can carry several runs
    // of the same check name — a re-run scope check after a PR body edit, or
    // product jobs the battery plan skipped. summarizeRequiredChecks resolves
    // each name by its newest REAL run, which it can only do if it is given
    // the older real runs too.
    const runs = [];
    let page = 1;
    while (true) {
      const payload = await this.request(
        `/repos/${this.repository}/commits/${head}/check-runs?filter=all&per_page=100&page=${page}`,
      );
      const batch = payload.check_runs ?? [];
      runs.push(...batch);
      if (batch.length < 100) return runs;
      page += 1;
    }
  }

  async verifyClaudeShadowProducer(checkRun, evidence) {
    // The publisher concludes the run and its publish job deterministically from the
    // evidence: `success` only for a clear result with zero findings, `failure`
    // otherwise. A non-clear result therefore authenticates through a FAILING run/job
    // — requiring `success` here would make every real finding-bearing artifact
    // unverifiable — so verification requires the run/job to conclude in that exact
    // evidence-matching form.
    const expectedConclusion = evidence.state === 'clear' && evidence.findingCount === 0
      ? 'success'
      : 'failure';
    const run = await this.request(
      `/repos/${this.repository}/actions/runs/${evidence.publisherRunId}`,
    );
    if (
      run?.id !== evidence.publisherRunId
      || run?.run_attempt !== evidence.publisherRunAttempt
      || run?.path !== '.github/workflows/claude-shadow-review.yml'
      || !['workflow_run', 'workflow_dispatch'].includes(run?.event)
      || run?.status !== 'completed'
      || run?.conclusion !== expectedConclusion
      || run?.head_sha !== evidence.workflowSha
      || run?.head_branch !== 'main'
      || run?.repository?.full_name !== this.repository
    ) return false;
    const jobs = await this.actionRunItems(run.id, 'jobs', 'jobs', 'filter=all');
    if (!jobs.some((job) =>
      job?.name === 'publish'
      && job?.status === 'completed'
      && job?.conclusion === expectedConclusion)) return false;
    const artifacts = await this.actionRunItems(run.id, 'artifacts', 'artifacts');
    return artifacts.some((artifact) =>
      artifact?.id === evidence.artifact.id
      && artifact?.name === evidence.artifact.name
      && artifact?.digest === evidence.artifact.digest
      && artifact?.expired === false);
  }

  async actionRunItems(runId, endpoint, property, query = '') {
    const items = [];
    for (let page = 1; ; page += 1) {
      const suffix = query ? `${query}&` : '';
      const payload = await this.request(
        `/repos/${this.repository}/actions/runs/${runId}/${endpoint}?${suffix}per_page=100&page=${page}`,
      );
      const batch = payload?.[property] ?? [];
      items.push(...batch);
      if (batch.length < 100) return items;
    }
  }

  rerunFailedJobs(runId) {
    return this.request(
      `/repos/${this.repository}/actions/runs/${runId}/rerun-failed-jobs`,
      { method: 'POST' },
    );
  }

  async dispatchHandoff(ref, pullRequestNumber) {
    let lastError;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        return await this.request(
          `/repos/${this.repository}/actions/workflows/autonomous-handoff.yml/dispatches`,
          {
            method: 'POST',
            body: {
              ref,
              inputs: { wait_for_pr: String(pullRequestNumber) },
            },
          },
        );
      } catch (error) {
        lastError = error;
        if (attempt < 3) await sleep(attempt * 1_000);
      }
    }
    throw lastError;
  }

  async statuses(head) {
    const statuses = [];
    let page = 1;
    while (true) {
      const batch = await this.request(
        `/repos/${this.repository}/commits/${head}/statuses?per_page=100&page=${page}`,
      );
      statuses.push(...batch);
      if (batch.length < 100) return statuses;
      page += 1;
    }
  }

  async paginated(path) {
    const items = [];
    let page = 1;
    while (true) {
      const separator = path.includes('?') ? '&' : '?';
      const batch = await this.request(
        `${path}${separator}per_page=100&page=${page}`,
      );
      items.push(...batch);
      if (batch.length < 100) return items;
      page += 1;
    }
  }

  reviews(number) {
    return this.paginated(
      `/repos/${this.repository}/pulls/${number}/reviews`,
    );
  }

  reviewComments(number) {
    return this.paginated(
      `/repos/${this.repository}/pulls/${number}/comments`,
    );
  }

  // The reader the drain clearance verifies a committed record's provenance with (the producer's run,
  // its artifact, and main's ancestry), over this client's repository and token.
  drainProvenanceReader() {
    return githubProvenanceReader({ repository: this.repository, token: this.token });
  }

  // One file of one exact ref, as text (the raw media type, so a file over the 1 MB JSON limit —
  // docs/STATUS.md — still reads); null when the path is absent at that ref. Retried on 5xx like
  // `request`; any other failure throws.
  async fileContents(path, ref) {
    if (!/^[0-9a-f]{40}$/u.test(String(ref ?? ''))) throw new Error(`no exact ref to read ${path} from`);
    const url = `${API_ROOT}/repos/${this.repository}/contents/${path}?ref=${ref}`;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      let response;
      try {
        response = await fetch(url, {
          headers: {
            Accept: 'application/vnd.github.raw+json',
            Authorization: `Bearer ${this.token}`,
            'X-GitHub-Api-Version': '2022-11-28',
          },
        });
      } catch (error) {
        if (attempt === 3) throw error;
        await sleep(attempt * 250);
        continue;
      }
      if (response.status === 404) return null;
      if (response.ok) return response.text();
      if (response.status >= 500 && attempt < 3) {
        await sleep(attempt * 250);
        continue;
      }
      throw new Error(`GitHub GET contents ${path}@${ref.slice(0, 7)} failed (${response.status})`);
    }
    throw new Error(`GitHub GET contents ${path} retry loop exhausted`);
  }

  // Owner direction 2026-10-09 (M2b-1) — the I/O of the same-PR follow-up component (review-follow-up.mjs).
  issuesLabelled(label) {
    return this.paginated(`/repos/${this.repository}/issues?labels=${encodeURIComponent(label)}&state=all`);
  }

  // read by number: unlike the label-filtered list, it includes an issue whose labels GitHub has not attached yet
  issue(number) {
    return this.request(`/repos/${this.repository}/issues/${number}`);
  }

  // M3c: one read of a cited work item for approval-time verification. 404/410 are ANSWERS (the issue does not
  // exist), so they are returned, not thrown; redirects are followed, so a transferred issue answers from its new
  // repository and `classifyIssueRead` refuses it. Anything else that fails throws and is classified unreadable.
  async workItemIssue(number) {
    const response = await fetch(`${API_ROOT}/repos/${this.repository}/issues/${number}`, {
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${this.token}`,
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });
    const text = await response.text();
    if (response.status === 404 || response.status === 410) return { status: response.status, payload: null };
    if (!response.ok) throw new Error(`GitHub GET issue #${number} failed (${response.status})`);
    return { status: response.status, payload: text ? JSON.parse(text) : null };
  }

  createIssue({ title, body, labels }) {
    return this.request(`/repos/${this.repository}/issues`, { method: 'POST', body: { title, body, labels } });
  }

  // Idempotent: an existing label (or one a concurrent run just created, 422) is left as it is. Codex
  // 4220739644 — the label must exist before an issue carries it, or the labelled lookup never finds the issue.
  async ensureLabel(name) {
    try {
      await this.request(`/repos/${this.repository}/labels/${encodeURIComponent(name)}`);
      return;
    } catch (error) {
      if (!/failed \(404\)/u.test(String(error?.message))) throw error;
    }
    try {
      await this.request(`/repos/${this.repository}/labels`, {
        method: 'POST',
        body: { name, color: 'c5def5', description: 'Codex findings carried into follow-up work' },
      });
    } catch (error) {
      if (!/failed \(422\)/u.test(String(error?.message))) throw error;
    }
  }

  issueComments(number) {
    return this.paginated(`/repos/${this.repository}/issues/${number}/comments`);
  }

  createIssueComment(number, body) {
    return this.request(`/repos/${this.repository}/issues/${number}/comments`, { method: 'POST', body: { body } });
  }

  updateIssueComment(id, body) {
    return this.request(`/repos/${this.repository}/issues/comments/${id}`, { method: 'PATCH', body: { body } });
  }

  // the closing comment carries the follow-up component's duplicate marker; the issue closes `not_planned`
  async closeIssue(number, comment) {
    await this.request(`/repos/${this.repository}/issues/${number}/comments`, { method: 'POST', body: { body: comment } });
    await this.request(`/repos/${this.repository}/issues/${number}`, { method: 'PATCH', body: { state: 'closed', state_reason: 'not_planned' } });
  }

  // The PR's CUMULATIVE diff against its base — every file the review unit touches,
  // not just the files of the current head commit.
  pullRequestFiles(number) {
    return this.paginated(
      `/repos/${this.repository}/pulls/${number}/files`,
    );
  }

  async replacementLineage() {
    const label = encodeURIComponent(REPLACEMENT_REQUIRED_LABEL);
    const [issues, pullRequests] = await Promise.all([
      this.paginated(
        `/repos/${this.repository}/issues?state=all&labels=${label}`,
      ),
      this.paginated(`/repos/${this.repository}/pulls?state=all`),
    ]);
    const pullsByNumber = new Map(
      pullRequests.map((pullRequest) => [pullRequest.number, pullRequest]),
    );
    const requiredReplacements = await Promise.all(
      issues
        .filter((issue) => issue.pull_request)
        .map(async (issue) => ({
          pullRequest: pullsByNumber.get(issue.number)
            ?? await this.pullRequest(issue.number),
        })),
    );
    return { requiredReplacements, replacementPullRequests: pullRequests };
  }

  reactions(number) {
    return this.request(
      `/repos/${this.repository}/issues/${number}/reactions?per_page=100`,
    );
  }

  setStatus(
    head,
    state,
    description,
    targetUrl,
    context = STATUS_CONTEXT,
  ) {
    return this.request(`/repos/${this.repository}/statuses/${head}`, {
      method: 'POST',
      body: {
        state,
        context,
        description: description.slice(0, 140),
        target_url: targetUrl,
      },
    });
  }

  // Returns the LIVE pull request after ensuring the requested draft state — never the object
  // it was handed. The no-op branch refetches for the same reason the mutating branch does.
  //
  // MEASURED as a P1: when an exhaustion check begins with the pull request already in draft,
  // this method took its no-op branch and returned the CALLER'S object, which
  // `refreshCurrentHead` had read moments earlier. A retarget in that window was therefore
  // re-validated against a stale base, `isCurrentReviewUnit` accepted it, and
  // `enforceReviewConvergence` went on to apply the repository-wide replacement label and a
  // failure status to a pull request that had left `main`.
  //
  // The predicate was not the defect — its INPUT was. A guard can only be as current as the
  // object it is given, so freshness is made structural here rather than remembered at each
  // call site; that is the same reason acceptance itself is one predicate rather than a check
  // per site. An extra read on a no-op is the whole cost.
  async setDraft(pullRequest, draft) {
    if (Boolean(pullRequest.draft) === draft) return this.pullRequest(pullRequest.number);
    const mutation = draft
      ? `mutation($id: ID!) {
          convertPullRequestToDraft(input: { pullRequestId: $id }) {
            pullRequest { id isDraft }
          }
        }`
      : `mutation($id: ID!) {
          markPullRequestReadyForReview(input: { pullRequestId: $id }) {
            pullRequest { id isDraft }
          }
        }`;
    await this.graphql(mutation, { id: pullRequest.node_id });
    return this.pullRequest(pullRequest.number);
  }

  async enableAutoMerge(pullRequest, expectedHead) {
    if (pullRequest.auto_merge) return;
    await this.graphql(
      `mutation($id: ID!, $expectedHead: GitObjectID!) {
        enablePullRequestAutoMerge(
          input: {
            pullRequestId: $id
            expectedHeadOid: $expectedHead
            mergeMethod: SQUASH
          }
        ) {
          pullRequest { id autoMergeRequest { enabledAt } }
        }
      }`,
      { id: pullRequest.node_id, expectedHead },
    );
  }

  async mergeExactHead(number, expectedHead) {
    const response = await fetch(
      `${API_ROOT}/repos/${this.repository}/pulls/${number}/merge`,
      {
        method: 'PUT',
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${this.token}`,
          'Content-Type': 'application/json',
          'X-GitHub-Api-Version': '2022-11-28',
        },
        body: JSON.stringify({
          merge_method: 'squash',
          sha: expectedHead,
        }),
      },
    );
    const text = await response.text();
    const payload = text ? JSON.parse(text) : null;
    if (response.status === 405) {
      return {
        merged: false,
        message: payload?.message ?? 'Pull request is not ready to merge',
      };
    }
    if (!response.ok) {
      throw new Error(
        `GitHub PUT exact-head merge failed (${response.status}): ${text}`,
      );
    }
    return payload;
  }

  async reviewThreads(number) {
    const [owner, name] = this.repository.split('/');
    const threads = [];
    let after = null;
    do {
      const data = await this.graphql(
        `query($owner: String!, $name: String!, $number: Int!, $after: String) {
          repository(owner: $owner, name: $name) {
            pullRequest(number: $number) {
              reviewThreads(first: 100, after: $after) {
                nodes {
                  id
                  isResolved
                  comments(first: 1) {
                    nodes { author { login } originalCommit { oid } }
                  }
                }
                pageInfo { hasNextPage endCursor }
              }
            }
          }
        }`,
        { owner, name, number, after },
      );
      const page = data.repository?.pullRequest?.reviewThreads;
      if (!page) throw new Error('Pull-request review threads were unavailable');
      threads.push(...page.nodes);
      after = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
    } while (after);
    return threads;
  }

  async resolveCodexThreads(number, expectedHead) {
    const ids = codexThreadIdsToResolve(
      await this.reviewThreads(number),
      expectedHead,
    );
    for (const threadId of ids) {
      await this.graphql(
        `mutation($threadId: ID!) {
          resolveReviewThread(input: { threadId: $threadId }) {
            thread { id isResolved }
          }
        }`,
        { threadId },
      );
    }
    return ids.length;
  }

  async updateStickyComment(number, body) {
    const comments = await this.request(
      `/repos/${this.repository}/issues/${number}/comments?per_page=100`,
    );
    const existing = comments.find(
      (comment) =>
        comment.user?.login === 'github-actions[bot]' &&
        comment.body?.includes(COMMENT_MARKER),
    );
    const fullBody = `${COMMENT_MARKER}\n${body}`;
    if (existing) {
      await this.request(
        `/repos/${this.repository}/issues/comments/${existing.id}`,
        { method: 'PATCH', body: { body: fullBody } },
      );
      return;
    }
    await this.request(`/repos/${this.repository}/issues/${number}/comments`, {
      method: 'POST',
      body: { body: fullBody },
    });
  }
}

// `baseRefName` is projected because eligibility ASKS about it: an off-`main` unit must
// never enter the lifecycle, since exhaustion takes no base test and would mint a
// repository-wide obligation for work that could not land on `main`. The projection was the
// reason the rule could not be sited here before — the shape simply did not carry the base.
export function eligibleShape(pullRequest) {
  return {
    state: pullRequest.state,
    headRefName: pullRequest.head.ref,
    baseRefName: pullRequest.base?.ref,
    headRepository: { nameWithOwner: pullRequest.head.repo?.full_name },
    baseRepository: { nameWithOwner: pullRequest.base?.repo?.full_name },
  };
}

// The advisory as of RIGHT NOW, for a sticky written after findings landed.
//
// The crossing that matters most is the one caused by the review that just
// finished: four prior finding heads, and the fifth arrives in the poll. An
// advisory snapshotted before that review is null exactly then, so the
// `changes_required` sticky would tell auto-fix to push another head at the one
// moment the split advice is due. Nobody is standing by to notice the omission,
// so it is recomputed rather than carried.
async function freshAdvisory(client, pullRequest) {
  const observed = await reportReviewLifecycle(client, pullRequest, () => {});
  return observed?.advisory ?? null;
}

// Report the lifecycle observation. NEVER blocks, NEVER throws.
//
// Called on BOTH paths that reach a review. The first attempt at this change
// wired only the final-admission path, so a unit already at five critical heads
// was promoted for yet another Codex review and the finding path drafted the
// head without the rule ever running — the exact sixth finding-bearing head the
// rule exists to notice. `L2` slices the source between the promotion-path
// convergence call and `reviewNotBefore` and requires this call inside that
// region, so a future path that promotes without it fails CI.
export async function reportReviewLifecycle(client, pullRequest, log = console.log) {
  let observation = null;
  try {
    const { comments, reviews } = await readCodexEvidence(client, pullRequest.number);
    observation = observeReviewLifecycle({ comments, reviews });
  } catch {
    // Evidence unreadable. This path reports; it does not decide, so there is
    // nothing to fail closed ON — it says nothing rather than something wrong.
    return null;
  }
  const advisory = lifecycleAdvisory(observation);
  if (advisory) log(`lifecycle: ${advisory}`);
  // The caller threads this into the sticky comment. Returned rather than
  // written here so this helper keeps its one job and cannot race the
  // status writes it would otherwise be interleaved with.
  return { ...observation, advisory };
}

// Who the loop will ask to fix this, and what it will ask them to do.
//
// Derived from the pull request's own declaration on EVERY notice, rather than
// asserted by a string literal at the call site. Before this, three call sites
// each said "Claude Auto-fix handles the review comments" unconditionally, and
// said it to a Cursor-owned PR. See scripts/correction-owner.mjs.
function correctionNotice(pullRequest, { detail = null, reason = 'review' } = {}) {
  return correctionRouting({
    declaration: correctionOwnerDeclaration(pullRequest),
    head: pullRequest?.head?.sha ?? null,
    detail,
    reason,
    pullRequestNumber: pullRequest?.number,
  });
}

// Only a state a reader must ACT on is published. `routed` is the ordinary case
// and adds nothing beside the owner label; `correction_stalled` is the one that
// says nobody is coming, which is exactly what a reader needs to see.
function noticeState(notice) {
  return notice?.state === CORRECTION_STALLED ? CORRECTION_STALLED : null;
}

// The sticky's ownership fields for a non-eligible SHA verdict, derived from the VERDICT alone —
// NEVER from the mutable PR body. The canonical `codex-current-head` failure and the correction-lease
// watchdog both treat an `invalid` head's ownership as unconfirmed (the head authenticates nobody) and
// a `candidate` head as held-for-activation. The sticky must show the same, so a watching session is
// never handed a body-declared owner the head does not authenticate — the two routing verdicts must
// agree. (Deriving `owner` from `correctionNotice(pullRequest, …)` read it from the body and could
// publish e.g. `claude` with no `correction_stalled` state while the status said the owner was
// unconfirmed.)
function ownershipHoldNotice(verdict) {
  switch (verdict?.outcome) {
    case 'candidate':
      // A real candidate owner named by the head trailer, held for independent-reviewer activation.
      // No correction is owed (the watchdog routes none), so it is not `correction_stalled`.
      return {
        owner: verdict.owner ?? 'undeclared',
        correctionState: null,
        next: 'This exact head is held for independent-reviewer activation; the required status stays '
          + 'red until a reviewer activates the candidate owner or a new head supersedes it.',
      };
    case 'unreadable':
      // Transient: a later run re-reads the head and recovers. Assert no owner.
      return {
        owner: 'undeclared',
        correctionState: null,
        next: 'This exact head could not be read; the required status stays red until a later run '
          + 're-reads the commit and recovers.',
      };
    default:
      // `invalid`: the head trailer is missing, malformed, or conflicting — it authenticates nobody.
      // Ownership is unconfirmed and no agent is routed; only a new head resolves it, so surface it as
      // stalled rather than naming the body's declared owner.
      return {
        owner: 'undeclared',
        correctionState: CORRECTION_STALLED,
        next: 'This exact head authenticates no owner; the required status stays red until a new head '
          + 'carries a single valid Correction-Owner trailer matching the PR body marker.',
      };
  }
}

// Replace whatever sticky was last published (`review_clean`/`clear`, or a stale success) when the
// exact head's SHA verdict is not merge-eligible. The only notification a subscribed session receives
// is a sticky-comment update, so a hold that changes only the required status would leave the reader
// looking at a comment that says GitHub will complete a head that is actually blocked. Shared by the
// ordinary clean-review path and the post-deploy recovery arm so both report the identical hold.
async function publishOwnershipHoldSticky(
  client,
  pullRequest,
  expectedHead,
  { ownershipReason, verdict, attempt = null },
) {
  const hold = ownershipHoldNotice(verdict);
  await client.updateStickyComment(
    pullRequest.number,
    statusBody({
      state: 'scope_required',
      head: expectedHead,
      detail: ownershipReason,
      attempt,
      owner: hold.owner,
      correctionState: hold.correctionState,
      next: hold.next,
    }),
  );
}

function statusBody({
  state,
  head,
  detail,
  attempt,
  next,
  advisory = null,
  owner = null,
  correctionState = null,
}) {
  // No mention is rendered here, deliberately. This comment is maintained by
  // PATCH once it exists, and an edit creates no notification — so a handle
  // written into it would look like a wake-up and wake nobody, which is the
  // precise class of false signal this unit exists to remove. Waking the owner
  // belongs to the correction lease, with the new-comment publisher that makes
  // it real.
  return [
    '## Autonomous review state',
    '',
    `- **Head:** \`${head}\``,
    `- **State:** \`${state}\``,
    // A recovery/hold sticky is not a fresh Codex attempt, so it omits the line rather than render a
    // meaningless `null/N`; every review-loop caller passes a positive attempt and still shows it.
    ...(Number.isInteger(attempt) && attempt > 0
      ? [`- **Codex attempt:** ${attempt}/${MAX_REVIEW_ATTEMPTS}`]
      : []),
    `- **Detail:** ${detail}`,
    // Machine-readable, beside the instruction it explains: a reader (human or
    // agent) can see WHO is expected to act without parsing the sentence.
    ...(owner ? [`- **Correction owner:** \`${owner}\``] : []),
    // And WHETHER anyone is routed at all. `correction_stalled` is computed for
    // exactly the inputs that need it — no declaration, an unknown agent, two
    // owners — and publishing only the owner label left that state invisible to
    // every reader of the comment.
    ...(correctionState ? [`- **Correction state:** \`${correctionState}\``] : []),
    `- **Next:** ${next}`,
    // The lifecycle advisory rides the sticky comment, not just the Actions log.
    // The loop's actors — and humans — read PR comments and statuses; a workflow
    // log is neither, so an advisory written only there is a signal nobody
    // receives. It appears beside `Next:` precisely because `Next:` is what it
    // qualifies: "keep correcting" reads differently when this unit has already
    // spent its head budget.
    ...(advisory ? ['', `- **Review lifecycle:** ${advisory}`] : []),
    '',
    'This comment is maintained by GitHub. The required '
      + `\`${STATUS_CONTEXT}\` status on this exact SHA is authoritative.`,
  ].join('\n');
}

export async function settleRecoveryRequest(
  client,
  expectedHead,
  pullRequest,
  recoveryRequest,
  outcome,
) {
  if (!recoveryRequest) return;
  const context = recoverySettlementContext(recoveryRequest);
  await client.setStatus(
    expectedHead,
    'success',
    `recovery: consumed by ${outcome}`,
    pullRequest.html_url,
    context,
  );
}

/**
 * Is this fetched object still the unit this workflow is acting on?
 *
 * ONE PREDICATE, APPLIED WHEREVER SUCH AN OBJECT IS ACCEPTED — and the reason it is one
 * predicate rather than a check per call site is that three review rounds each added one
 * more attribute at one more place, and each time the gap moved rather than closed:
 *
 *   round 1  the base was never asked at all; `eligibleShape` did not even project it, so an
 *            off-`main` unit entered the lifecycle and its exhaustion minted a
 *            repository-wide obligation for work that could never land on `main`.
 *   round 2  the base was asked ONCE, at `run()` start. A retarget mid-poll changes neither
 *            the head SHA nor the state, so the controller carried on mutating.
 *   round 3  the base was asked before `client.setDraft()`, but that call REFETCHES and
 *            returns the post-mutation object, and the helper accepted it on `state` and
 *            `head.sha` alone. A retarget inside the mutation window was accepted and
 *            `reviewAttempt()` proceeded with an off-`main` object, so the ready transition
 *            could still trigger Codex on an ineligible unit.
 *
 * Every one of those is the same defect: an object accepted on fewer attributes than decide
 * whether it is the thing being acted on. A fourth site would be a fourth chance to forget,
 * so acceptance is defined once, here, and there is no other way to say yes to a live pull
 * request. `state`, `head.sha` and eligibility are one verdict, not three checks that
 * different call sites may sample from.
 *
 * NO ANCESTRY, at any placement: `main` advances under an open unit constantly and a squash
 * merge breaks the relation a second way, so an ancestry test refuses ordinary valid work.
 * This reads `base.ref` and nothing else.
 */
function isCurrentReviewUnit(pullRequest, expectedHead) {
  return Boolean(pullRequest)
    && pullRequest.state === 'open'
    && pullRequest.head?.sha === expectedHead
    && isEligiblePullRequest(eligibleShape(pullRequest));
}

// The live pull request, re-verified — or null, which every caller treats as "stop".
async function refreshCurrentHead(client, number, expectedHead) {
  const pullRequest = await client.pullRequest(number);
  if (!isCurrentReviewUnit(pullRequest, expectedHead)) {
    console.log(
      'Pull request is closed, superseded by a newer head, or no longer eligible '
      + '(base retargeted, or head repository changed); leaving it untouched.',
    );
    return null;
  }
  return pullRequest;
}

// Ownership-verdict lifecycle prerequisite (owner-verdict split): whether the latest required review status
// WITHHOLDS a PR-wide auto-merge because the exact head's ownership is not confirmed merge-eligible. Three
// vocabulary cases:
//   - a readable ownership INCONSISTENCY (`scope:` failure whose detail is the ownership-inconsistent
//     signature): the head trailer and body marker disagree, so no owner is confirmed;
//   - a temporarily UNREADABLE head (`validation:` read-retry): the trailer could not be read at all; and
//   - a CANDIDATE head held for independent-reviewer activation (`validation:` candidate-held): a recognised
//     but never-merge-eligible owner.
// This is a PURE predicate over the shared vocabulary and has NO consumer in this unit: it only classifies a
// status. The auto-merge cancellation/reconciliation that consumes it — including the cross-head serialization
// a non-head-scoped `disablePullRequestAutoMerge` requires — is deferred to the 2A3 activation unit, where the
// matching re-arm/requeue behaviour can be designed together. Defining the predicate here grants no behaviour.
export function ownershipStatusWithholdsAutoMerge(status) {
  if (status?.context !== STATUS_CONTEXT || status?.state !== 'failure') return false;
  const description = String(status?.description ?? '');
  return description.startsWith(OWNERSHIP_READ_RETRY)
    || description.startsWith(OWNERSHIP_CANDIDATE_HELD)
    || isOwnershipInconsistentScopeDetail('scope', description.replace(/^\s*scope:\s*/u, ''));
}

export async function setDraftForCurrentHead(
  client,
  number,
  expectedHead,
  draft,
) {
  const pullRequest = await refreshCurrentHead(client, number, expectedHead);
  if (!pullRequest) return null;
  // `client.setDraft` REFETCHES and returns the post-mutation pull request, so `updated` is
  // authoritative evidence about a moment AFTER the guard above ran — and a retarget inside
  // that window would otherwise be accepted. It is held to the identical verdict.
  const updated = await client.setDraft(pullRequest, draft);
  return isCurrentReviewUnit(updated, expectedHead) ? updated : null;
}

// The verdict an exact head that could not be read carries: retryable, never an owner.
const UNREADABLE_VERDICT = Object.freeze({
  outcome: 'unreadable', mergeEligible: false, owner: null, trailerState: 'unreadable',
});

// 2B2: the single SHA-scoped merge-authority read for one run. The controller reads the exact head
// commit MESSAGE once and every required-success publisher and the merge consume this one parsed
// verdict (`shaMergeAuthority`, itself SHA-only and mutation-free). A fetch failure or a message
// that cannot be read fails closed to the retryable `unreadable` outcome, never to an owner — so an
// infrastructure blip never grants merge authority.
export async function readShaMergeVerdict(client, head) {
  try {
    const commit = await client.commit(head);
    const message = commit?.commit?.message;
    if (typeof message !== 'string') {
      // The read did not yield a message at all (absent field) — genuinely unreadable, fail retryably.
      return { outcome: 'unreadable', mergeEligible: false, owner: null, trailerState: 'unreadable' };
    }
    // An EMPTY string is a SUCCESSFUL read of a commit whose message is genuinely empty (e.g.
    // `git commit --allow-empty-message`): the trailer is observably missing, not transiently
    // unreadable. `shaMergeAuthority('')` returns the readable `invalid`/`missing` outcome, which opens
    // the canonical scope hold — never `OWNERSHIP_READ_RETRY`, which would retry a head forever when
    // only a new commit can repair it.
    // M3c: the same one read also yields the head's `Work-Item` trailer, which the merge guard checks the
    // approval token against — no second commit read.
    return { ...shaMergeAuthority(message), workItem: parseWorkItemTrailer(message) };
  } catch {
    return { outcome: 'unreadable', mergeEligible: false, owner: null, trailerState: 'unreadable' };
  }
}

// The canonical `codex-current-head` failure DESCRIPTION a non-eligible SHA verdict publishes in place
// of success — each in the exact vocabulary the correction-lease consumer classifies by prefix
// (`correctionReasonFor`), so an ownership hold routes correctly rather than as a generic review fault:
//   - `eligible`   → null (success proceeds).
//   - `candidate`  → `OWNERSHIP_CANDIDATE_HELD` (a `validation:` string the lease recognises as held —
//                    no correction, never merge-eligible, resolved only by reviewer activation).
//   - `unreadable` → `OWNERSHIP_READ_RETRY` (a retryable `validation:` string — no correction owed).
//   - `invalid`    → a `scope:`-prefixed ownership-inconsistency detail, so `correctionReasonFor`
//                    classifies it `scope` (not the generic `review`) and the lease treats the head's
//                    ownership as unconfirmed rather than trusting the mutable PR-body owner.
export function ownershipReasonForVerdict(verdict) {
  switch (verdict?.outcome) {
    case 'eligible': return null;
    case 'candidate': return OWNERSHIP_CANDIDATE_HELD;
    case 'unreadable': return OWNERSHIP_READ_RETRY;
    default: return `scope: ${ownershipInconsistentScopeDetail('head')}`; // missing/conflicting/malformed
  }
}

// When the PR body declares an admitted CANDIDATE owner, the verdict to hold under (the candidate, never
// merge-eligible), else null. Withhold-only: it never makes an ineligible head eligible.
export function candidateBodyHold(pullRequest, verdict) {
  const declaration = correctionOwnerDeclaration(pullRequest);
  if (declaration.state !== 'candidate') return null;
  return { ...verdict, outcome: 'candidate', mergeEligible: false, owner: declaration.owner };
}

export async function completeReviewedPullRequest(
  client,
  pullRequest,
  expectedHead,
  verdict,
) {
  const authorization = await authorizeExactHeadMerge(client, pullRequest, expectedHead, verdict);
  if (!authorization.allowed) {
    return 'held_for_gates';
  }
  pullRequest = authorization.pullRequest;
  const direct = await client.mergeExactHead(
    pullRequest.number,
    expectedHead,
  );
  if (direct?.merged) {
    await client.dispatchHandoff(pullRequest.base.ref, pullRequest.number);
    return 'merged';
  }

  try {
    await client.enableAutoMerge(pullRequest, expectedHead);
    await client.dispatchHandoff(pullRequest.base.ref, pullRequest.number);
    return 'queued';
  } catch (error) {
    if (
      !(error instanceof Error)
      || !error.message.includes('is in clean status')
    ) {
      throw error;
    }
    const raced = await client.mergeExactHead(
      pullRequest.number,
      expectedHead,
    );
    if (raced?.merged) {
      await client.dispatchHandoff(pullRequest.base.ref, pullRequest.number);
      return 'merged';
    }
    throw new Error(
      `GitHub reported a clean pull request but refused the exact-head merge: ${raced?.message ?? 'unknown reason'}`,
      { cause: error },
    );
  }
}

/** The common mandatory guard for both direct merge and auto-merge entrypoints. */
export async function authorizeExactHeadMerge(client, pullRequest, expectedHead, verdict) {
  const live = await refreshCurrentHead(client, pullRequest.number, expectedHead);
  if (!live || live.draft || !live.base?.sha) {
    return { allowed: false, state: live?.draft ? 'draft' : 'superseded' };
  }
  const [statuses, checks] = await Promise.all([
    client.statuses(expectedHead),
    client.checkRuns(expectedHead),
  ]);
  const latestReview = statuses.find((status) => status.context === STATUS_CONTEXT);
  const required = summarizeRequiredChecks(checks, await requiredChecksFor(client, live));
  if (latestReview?.state !== 'success' || required.state !== 'success') {
    return { allowed: false, state: 'gates_not_green' };
  }
  // 2B2: the merge consumes the same one SHA merge-authority verdict the success publisher carried;
  // called without it (a direct caller) it reads the exact head once and fails closed. Only a
  // SHA-eligible trailer authorizes the merge — the SHA-shared status alone is not sufficient, so a
  // green status left on a head whose trailer is candidate/invalid/unreadable never merges.
  const mergeVerdict = verdict ?? await readShaMergeVerdict(client, expectedHead);
  if (!mergeVerdict?.mergeEligible || candidateBodyHold(live, mergeVerdict)) {
    return { allowed: false, state: 'ownership_not_eligible' };
  }
  // M3c (v3 §A6) — second line only (native auto-merge never consults this guard): the green this merge acts on
  // must carry an approval token that agrees with the exact head's immutable `Work-Item` trailer, taken from the
  // same one SHA read as the merge verdict (read here only when a caller's verdict does not carry it).
  const trailer = mergeVerdict.workItem ?? parseWorkItemTrailer(await readHeadCommitMessage(
    async () => (await client.commit(expectedHead))?.commit?.message,
    typeof client.pause === 'function' ? { sleep: client.pause.bind(client) } : {},
  ));
  if (!tokenMatchesTrailer(parseApprovalToken(latestReview.description), trailer)) {
    return { allowed: false, state: 'work_item_unverified' };
  }
  // Re-read after remote evidence. A push, base update, retarget or draft
  // transition during validation fails closed.
  const finalLive = await refreshCurrentHead(client, live.number, expectedHead);
  if (!finalLive || finalLive.draft || finalLive.base?.sha !== live.base.sha) {
    return { allowed: false, state: 'changed_during_validation' };
  }
  // The body is mutable: a candidate marker that appears between the first read and this one still holds
  // (Codex finding 4098699869 on #628). The PR this returns, and the merge acts on, is the one checked.
  if (candidateBodyHold(finalLive, mergeVerdict)) {
    return { allowed: false, state: 'ownership_not_eligible' };
  }
  return { allowed: true, state: 'authorized', pullRequest: finalLive };
}

/**
 * Codex 4225790715 — does the review-round cap now defer a STORED findings failure on this head? A failure
 * published before the cap reached this head, or by a controller without the cap, would otherwise be
 * preserved (or latched beneath a later success) and the head could only move on with a new push. Only a
 * Codex-findings failure qualifies, and only when the current evidence, classified with the cap, is clear
 * with findings to defer; a blocking finding, or anything less than a settled snapshot, keeps the failure.
 */
export async function capDefersStoredFailure(client, pullRequest, expectedHead, failure) {
  const description = String(failure?.description ?? '');
  if (!/current-head Codex finding|Codex submitted a current-head review/u.test(description)) return false;
  try {
    const evidence = await finalCodexEvidence(client, pullRequest, expectedHead);
    return evidence.state === 'clear' && evidence.deferred.length > 0;
  } catch {
    // unreadable evidence decides nothing: the stored failure stands (fail closed)
    return false;
  }
}

/**
 * M3c (v3 §A5) — withdraw a `codex-current-head` success that carries no approval token: it was written before
 * work-item verification existed, so it is not an approval this controller can stand behind. Returns whether it
 * withdrew. The pending status it writes is then re-earned through the single success writer.
 */
export async function withdrawUntokenedSuccess(client, pullRequest, expectedHead, newestStatus) {
  if (newestStatus?.state !== 'success' || parseApprovalToken(newestStatus.description)) return false;
  await client.setStatus(expectedHead, 'pending', WORK_ITEM_APPROVAL_WITHDRAWN, pullRequest.html_url);
  return true;
}

export async function ensureTerminalReviewState(
  client,
  pullRequest,
  expectedHead,
  status,
  statuses,
) {
  if (!isTerminalReviewStatus(status)) return false;
  if (status.state === 'success') {
    // M3c (v3 §A5) — a success without an approval token was written before work-item verification existed. It
    // is withdrawn FIRST, before any fallible read, so a crash or timeout below can never leave it green beneath
    // an already-enabled native auto-merge; the rest of recovery then re-earns it through the single writer.
    await withdrawUntokenedSuccess(client, pullRequest, expectedHead, status);
    const latched = persistentReviewFailure(statuses);
    if (latched && !(await capDefersStoredFailure(client, pullRequest, expectedHead, latched))) {
      await client.setStatus(
        expectedHead,
        'failure',
        'review: current-head Codex finding latched during recovery',
        pullRequest.html_url,
      );
      await setDraftForCurrentHead(
        client,
        pullRequest.number,
        expectedHead,
        true,
      );
      return true;
    }
    const live = await refreshCurrentHead(
      client,
      pullRequest.number,
      expectedHead,
    );
    if (!live) return true;
    if (live.draft) return false;
    const finalPolicy = await revalidateFinalReviewPolicy(
      client,
      pullRequest.number,
      expectedHead,
    );
    if (finalPolicy.superseded) return true;
    if (!finalPolicy.allowed) {
      if (finalPolicy.ownershipReason) {
        // 2B2: recovery must not republish a stale success when the exact head's SHA verdict is no
        // longer eligible; publish the canonical ownership failure. A canonical hold
        // (candidate/invalid) also drafts, as with any recovered current-head failure; a retryable
        // unreadable read only fails so a later run can re-read and recover without a draft flip.
        await client.setStatus(
          expectedHead,
          'failure',
          finalPolicy.ownershipReason,
          pullRequest.html_url,
        );
        // A canonical hold (candidate/invalid) drafts, as with any recovered current-head failure; a
        // retryable unreadable read only fails so a later run can re-read and recover without a draft
        // flip. Either way capture a LIVE current-head result: a push, close, or retarget between
        // revalidation and here means this reviewed head is no longer current, and replacing the PR's
        // singleton sticky would clobber the new head's state. `setDraftForCurrentHead` returns null
        // when the unit is no longer current; the unreadable branch does not draft, so it rechecks
        // explicitly via `refreshCurrentHead`.
        const stillCurrent = finalPolicy.verdict?.outcome === 'unreadable'
          ? await refreshCurrentHead(client, pullRequest.number, expectedHead)
          : await setDraftForCurrentHead(client, pullRequest.number, expectedHead, true);
        // Recovery must also REPLACE the sticky (the only notification a subscribed session receives),
        // so a prior `review_clean`/`clear` comment cannot keep claiming GitHub will complete a held
        // head. The hold's owner/state come from the verdict, as the clean path does.
        if (stillCurrent) {
          await publishOwnershipHoldSticky(client, stillCurrent, expectedHead, {
            ownershipReason: finalPolicy.ownershipReason,
            verdict: finalPolicy.verdict,
          });
        }
      }
      return true;
    }
    // Codex 4216657933 — recovery settles the head's evidence through the same step as the ordinary success
    // path before it merges: a finding that arrived since the success either blocks, or past the cap is filed
    // in the head's follow-up issue, so a recovered merge never leaves a deferred finding unrecorded.
    // Codex 4220338753 — and it settles BEFORE any success is republished: a green required status is what
    // branch protection (and a queued auto-merge) acts on, so a blocking finding that landed since the
    // original success must turn the head red without a green window in which it could merge
    const settled = await settleFinalCodexEvidence(client, finalPolicy.pullRequest, expectedHead);
    if (settled.state === 'changes_required') {
      await publishBlockingVerdict(client, finalPolicy.pullRequest, expectedHead, {
        description: settled.detail,
        deferred: settled.deferred ?? [],
      });
      return true;
    }
    // Codex 4226684322 — the settlement withdrew the recovered success, so success is ALWAYS republished here,
    // after the filing completed. Codex 4220431600 — a settlement that filed a follow-up issue writes the SAME
    // follow-up-aware description the ordinary success path writes: operators are sent to this status for the
    // deferred findings
    await publishSettledSuccess(
      client,
      pullRequest,
      expectedHead,
      settled.followUp !== null && settled.followUp !== undefined
        ? cappedSuccessDetail(settled)
        : 'review: recovered prior clean Codex result on this exact head',
    );
    await completeReviewedPullRequest(
      client,
      finalPolicy.pullRequest,
      expectedHead,
      finalPolicy.verdict,
    );
  } else {
    // Codex 4225790715 — a stored findings failure the cap now defers is not preserved: the ordinary review
    // path runs instead, which files the deferred findings and completes the head without a new push
    if (await capDefersStoredFailure(client, pullRequest, expectedHead, status)) return false;
    const latestStatus = statuses.find(
      (candidate) => candidate.context === STATUS_CONTEXT,
    );
    if (String(latestStatus?.id) !== String(status.id)) {
      await client.setStatus(
        expectedHead,
        'failure',
        status.description ?? 'review: recovered current-head Codex failure',
        pullRequest.html_url,
      );
    }
    // 2B2: a retryable `OWNERSHIP_READ_RETRY` failure must not flip readiness here either — the exact
    // head could not be read, so a later run re-reads and recovers. Drafting on a transient read
    // failure would strand the PR draft until a manual re-ready; every other recovered failure drafts.
    if (!String(status.description ?? '').startsWith(OWNERSHIP_READ_RETRY)) {
      await setDraftForCurrentHead(
        client,
        pullRequest.number,
        expectedHead,
        true,
      );
    }
  }
  return true;
}

async function waitForRequiredChecks(client, pullRequest, expectedHead) {
  const deadline = Date.now() + CHECK_TIMEOUT_MS;
  const requiredChecks = await requiredChecksFor(client, pullRequest);
  while (true) {
    const live = await client.pullRequest(pullRequest.number);
    if (live.head.sha !== expectedHead) return { state: 'superseded' };

    const summary = summarizeRequiredChecks(
      await client.checkRuns(expectedHead),
      requiredChecks,
    );
    if (summary.state !== 'pending' || Date.now() > deadline) return summary;
    await sleep(POLL_INTERVAL_MS);
  }
}

export async function enforceReviewConvergence(
  client,
  pullRequest,
  expectedHead,
) {
  const { comments, reviews } = await readCodexEvidence(client, pullRequest.number);
  const findingHeads = codexFindingHeads(comments, reviews);
  const live = await refreshCurrentHead(client, pullRequest.number, expectedHead);
  if (!live) return { state: 'superseded', allowed: false, superseded: true };
  return reviewHistoryPolicy(findingHeads);
}

/**
 * M3c (v3 §A4) — verify a cited work item for approval. A prior `codex-current-head` SUCCESS on this exact SHA
 * whose approval token names the same #N is the historical proof: that approval completed with #N verified, so
 * it is reused and the issue is not read again (a later deletion or transfer is the accepted limitation,
 * 6091212460). Only a completed approval is reused — there are no separate receipts, so an observation from a run
 * that failed before its success write cannot be (v3 gap 3). Otherwise the issue is read now.
 * `{ state: 'valid', issue, issueState, reused } | { state: 'invalid' | 'unreadable', detail }`
 */
export async function verifyCitedWorkItem(client, pullRequest, expectedHead, issue) {
  let statuses;
  try {
    statuses = await client.statuses(expectedHead);
  } catch {
    return { state: 'unreadable', detail: `the statuses of ${expectedHead.slice(0, 12)} could not be read` };
  }
  const prior = (statuses ?? [])
    .filter((status) => status.context === STATUS_CONTEXT && status.state === 'success')
    .map((status) => parseApprovalToken(status.description))
    .find((token) => token?.state === 'cited' && token.issue === issue);
  if (prior) return { state: 'valid', issue, issueState: prior.issueState, reused: true };
  const repository = client.repository ?? pullRequest.base?.repo?.full_name;
  try {
    const read = await client.workItemIssue(issue);
    return { ...classifyIssueRead({ ...read, repository, number: issue }), reused: false };
  } catch {
    return { state: 'unreadable', detail: `cited #${issue} could not be read` };
  }
}

/**
 * M3c (v3 §A2) — the approval token the exact head earns NOW, or why it earns none. Reads the head's immutable
 * `Work-Item` trailer: `none` earns `[wi:none]`; `cited #N` earns `[wi:#N open|closed]` only when #N verifies.
 * `{ token } | { refused: detail, retryable }`
 */
export async function approvalTokenForHead(client, pullRequest, expectedHead) {
  const message = await readHeadCommitMessage(
    async () => (await client.commit(expectedHead))?.commit?.message,
    typeof client.pause === 'function' ? { sleep: client.pause.bind(client) } : {},
  );
  const trailer = parseWorkItemTrailer(message);
  if (trailer.state === 'none') return { token: approvalToken({ state: 'none' }) };
  if (trailer.state !== 'cited') {
    return { refused: `${WORK_ITEM_TRAILER_SCOPE} ${trailer.detail}`, retryable: trailer.state === 'unreadable' };
  }
  const verification = await verifyCitedWorkItem(client, pullRequest, expectedHead, trailer.issue);
  if (verification.state !== 'valid') {
    return { refused: `${WORK_ITEM_TRAILER_SCOPE} ${verification.detail}`, retryable: verification.state === 'unreadable' };
  }
  return { token: approvalToken(verification) };
}

export async function enforceReviewScope(client, pullRequest, expectedHead) {
  let changedFiles;
  let lineage;
  if (pullRequest.number > PRE_REVIEW_ENFORCE_AFTER_PR) {
    const [filesResult, lineageResult] = await Promise.allSettled([
      client.pullRequestFiles(pullRequest.number),
      client.replacementLineage(),
    ]);
    changedFiles = filesResult.status === 'fulfilled'
      ? filesResult.value
      : undefined;
    lineage = lineageResult.status === 'fulfilled'
      ? lineageResult.value
      : undefined;
  }
  // A candidate body is admitted only over a head that declares the same candidate, so read that exact
  // head's message for it. A commit is immutable, so a failed read is retried (bounded, as the review-scope
  // CLI does) before it counts; one that still fails leaves it undefined, which refuses retryably.
  let headCommitMessage;
  if (correctionOwnerDeclaration(pullRequest).state === 'candidate') {
    // The shared bounded re-read (correction-owner.mjs), the same one the review-scope CLI uses;
    // `client.pause` is injectable for tests.
    headCommitMessage = await readHeadCommitMessage(
      async () => (await client.commit(expectedHead))?.commit?.message,
      typeof client.pause === 'function' ? { sleep: client.pause.bind(client) } : {},
    );
  }
  let result = assessReviewScope(pullRequest, {
    changedFiles,
    requireChangedFiles: true,
    headCommitMessage,
    requireReplacementLineage: pullRequest.number > PRE_REVIEW_ENFORCE_AFTER_PR,
    requiredReplacements: lineage?.requiredReplacements,
    replacementPullRequests: lineage?.replacementPullRequests,
  });
  // The drain directive's clearance, re-run HERE from the trusted default branch against the exact head
  // and base SHAs (#686 finding 4163577352): the PR-side `review-scope` job runs the same rule from the
  // PR's own checkout, which the PR could edit. Both trees are read through the API, never from this
  // checkout, so a STATUS edit that drops `phase-6-4d-previous-release-drained` is refused unless the PR
  // commits the `drained` verdict the rule demands (`scripts/autonomous-drain-clearance.mjs`). A read
  // failure propagates: the controller re-runs on the next event rather than drafting the PR over a
  // transient API error.
  if (result.allowed && Array.isArray(changedFiles)) {
    const clearance = await assessCommittedDirectiveClearance(pullRequest, changedFiles, {
      readHead: (path) => client.fileContents(path, expectedHead),
      readBase: (path) => client.fileContents(path, pullRequest.base?.sha),
      // the exact head commit's files and date: the record must be regenerated on the clearing head
      readHeadCommit: async () => headCommitFromGitHub(expectedHead, await client.commit(expectedHead)),
      // the trusted producer's artifact: the committed record must be byte-identical to it
      provenanceReader: typeof client.drainProvenanceReader === 'function' ? client.drainProvenanceReader() : undefined,
      repository: client.repository ?? pullRequest.base?.repo?.full_name,
    });
    if (clearance?.applies && !clearance.allowed) {
      result = { ...result, allowed: false, state: 'drain_clearance_refused', detail: `drain clearance: ${clearance.detail}`, clearance };
    }
  }
  // The cited work item (M3b, #761 Codex 4235631755; owner choice A, #482 6091714064): the exact head commit's
  // `Work-Item` trailer, re-parsed HERE from trusted default-branch code, because the PR-side `review-scope` job
  // runs from the PR's own checkout. Syntax only — no issue is read (M3c). A malformed trailer is a `scope:`
  // refusal that only a new head clears; an unreadable head commit, or one git cannot parse, is the existing
  // retryable same-SHA hold (no draft, no correction owed; #761 Codex 4235659448), never a pass.
  if (result.allowed) {
    const message = headCommitMessage ?? await readHeadCommitMessage(
      async () => (await client.commit(expectedHead))?.commit?.message,
      typeof client.pause === 'function' ? { sleep: client.pause.bind(client) } : {},
    );
    const workItem = parseWorkItemTrailer(message);
    if (workItem.state === 'unreadable') {
      result = { ...result, allowed: false, retryable: true, state: 'work_item_unreadable', detail: `${WORK_ITEM_TRAILER_SCOPE} ${workItem.detail}` };
    } else if (workItem.state === 'malformed') {
      result = { ...result, allowed: false, state: 'work_item_malformed', detail: `${WORK_ITEM_TRAILER_SCOPE} ${workItem.detail}` };
    } else if (workItem.state === 'cited') {
      // M3c (v3 §A): a cited work item must be a local, non-PR issue of this repository when the head is approved.
      // Missing, transferred or a PR is a `scope:` refusal only a new head clears; a failed read retries this SHA.
      const verification = await verifyCitedWorkItem(client, pullRequest, expectedHead, workItem.issue);
      if (verification.state === 'unreadable') {
        result = { ...result, allowed: false, retryable: true, state: 'work_item_unreadable', detail: `${WORK_ITEM_TRAILER_SCOPE} ${verification.detail}` };
      } else if (verification.state === 'invalid') {
        result = { ...result, allowed: false, state: 'work_item_invalid', detail: `${WORK_ITEM_TRAILER_SCOPE} ${verification.detail}` };
      }
    }
  }
  if (result.allowed) return result;
  // An unread candidate head is RETRYABLE on this same SHA (Codex finding 4101926931 on #630): no draft, no
  // `scope:` hold, no correction notice. The caller publishes the retryable `OWNERSHIP_READ_RETRY` (or, on a
  // failed CI run, re-runs it), so a later read of the same head and body recovers.
  if (result.retryable) return { ...result, verdict: UNREADABLE_VERDICT };

  const live = await setDraftForCurrentHead(
    client,
    pullRequest.number,
    expectedHead,
    true,
  );
  if (!live) return { ...result, superseded: true };
  await client.setStatus(
    expectedHead,
    'failure',
    `scope: ${result.detail}`,
    pullRequest.html_url,
  );
  const notice = correctionNotice(live, {
    detail: result.detail,
    reason: 'scope',
  });
  await client.updateStickyComment(
    pullRequest.number,
    statusBody({
      state: 'scope_required',
      head: expectedHead,
      detail: result.detail,
      attempt: 0,
      owner: notice.owner ?? 'undeclared',
      correctionState: noticeState(notice),
      next: notice.instruction,
    }),
  );
  return result;
}

// The failed-CI path for one exact head, moved out of `run()` so it is testable. Returns 'retried',
// 'unreadable' or 'superseded', or throws the CI failure after drafting the PR and publishing the failure.
export async function handleCiFailure(
  client,
  context,
  pullRequest,
  expectedHead,
  { existingStatus = null, existingStatuses = [], scope = { allowed: true } } = {},
) {
  const checkRuns = await client.checkRuns(expectedHead);
  const requiredChecks = await requiredChecksFor(client, pullRequest);
  const ciSummary = summarizeRequiredChecks(checkRuns, requiredChecks);
  const disposition = ciFailureDisposition(context, existingStatus, ciSummary.failed, {
    pullRequest, scope, skipped: skippedRequiredChecks(checkRuns, requiredChecks),
  });
  if (disposition.retry) {
    // Re-check the head before re-running and before replacing the singleton sticky: a push during the
    // bounded head reads makes this head obsolete, and its re-run or sticky must not overwrite the newer
    // head's state (Codex finding 4104805621).
    if (!await refreshCurrentHead(client, pullRequest.number, expectedHead)) return 'superseded';
    try {
      await client.rerunFailedJobs(context.ciRunId);
      if (!await refreshCurrentHead(client, pullRequest.number, expectedHead)) return 'superseded';
      await client.updateStickyComment(
        pullRequest.number,
        statusBody({
          state: 'ci_retry',
          head: expectedHead,
          detail: `CI workflow concluded ${context.ciConclusion}`,
          attempt: 0,
          next: 'GitHub is retrying failed CI jobs once before requiring a code change.',
        }),
      );
      console.log(`Requested one failed-job retry for CI run ${context.ciRunId}.`);
      return 'retried';
    } catch (error) {
      console.warn(
        `Could not request the bounded CI retry; failing closed: ${error.message}`,
      );
    }
  }
  pullRequest = disposition.draft
    ? await setDraftForCurrentHead(
        client,
        pullRequest.number,
        expectedHead,
        true,
      )
    : await refreshCurrentHead(
        client,
        pullRequest.number,
        expectedHead,
      );
  if (!pullRequest) return 'superseded';
  if (disposition.unreadable) {
    // Still unreadable after the bounded retry: publish the retryable status, never a `ci:` failure, which
    // the watchdog routes as an owed scope correction (Codex finding 4103259698 on #630). No draft.
    await holdUnreadableCandidateHead(client, pullRequest, expectedHead, scope, existingStatuses);
    return 'unreadable';
  }
  const ciDetail = ciSummary.failed.length > 0
    ? `Failed checks: ${ciSummary.failed.join(', ')}`
    : `CI workflow concluded ${context.ciConclusion}`;
  if (!isTerminalReviewStatus(existingStatus)) {
    // The admission note LEADS the description (statuses are cut at 140 characters), so the lease reads an
    // admitted candidate's failed review-scope job as a CI failure, not an ownership refusal.
    await client.setStatus(
      expectedHead,
      'failure',
      disposition.scopeAdmitted ? `ci: ${CI_SCOPE_ADMITTED}; ${ciDetail}` : `ci: ${ciDetail}`,
      pullRequest.html_url,
    );
  }
  const noticeDetail = disposition.scopeAdmitted
    ? `${ciDetail}; the controller's own scope check admits this exact head, so the failed review-scope `
      + 'job is a CI failure, not an ownership refusal'
    : ciDetail;
  const ciNotice = correctionNotice(pullRequest, {
    detail: noticeDetail,
    reason: disposition.reason,
  });
  await client.updateStickyComment(
    pullRequest.number,
    statusBody({
      state: 'blocked',
      head: expectedHead,
      detail: noticeDetail,
      attempt: 0,
      owner: ciNotice.owner ?? 'undeclared',
      correctionState: noticeState(ciNotice),
        next: ciNotice.instruction,
    }),
  );
  throw new Error(ciDetail);
}

// An exact candidate head that could not be read: publish the retryable `OWNERSHIP_READ_RETRY` with the
// hold sticky — no draft, no `scope:` hold, no correction owed — and settle any pending recovery request,
// so the watchdog can request a fresh same-SHA recovery of this newer status (Codex findings 4101926931
// and 4103259698 on #630).
export async function holdUnreadableCandidateHead(client, pullRequest, expectedHead, scope, existingStatuses = []) {
  await client.setStatus(expectedHead, 'failure', OWNERSHIP_READ_RETRY, pullRequest.html_url);
  await settleRecoveryRequest(
    client, expectedHead, pullRequest, pendingRecoveryRequest(existingStatuses), 'unreadable candidate head',
  );
  const stillCurrent = await refreshCurrentHead(client, pullRequest.number, expectedHead);
  if (stillCurrent) {
    await publishOwnershipHoldSticky(client, stillCurrent, expectedHead, {
      ownershipReason: OWNERSHIP_READ_RETRY,
      verdict: scope?.verdict ?? UNREADABLE_VERDICT,
    });
  }
}

// The required checks whose deciding run was SKIPPED. In an attempt a failed gate aborted, the summary counts
// such a skip as failed, but it is that gate's consequence, not an independent failure.
export function skippedRequiredChecks(checkRuns, requiredChecks = REQUIRED_CHECKS) {
  return resolveRequiredChecks(checkRuns, requiredChecks).deciders
    .filter((run) => run.conclusion === 'skipped')
    .map((run) => run.name);
}

// The workflow run id of the run that decided the required check `name`, from its Actions URL, or null.
export function decidingRunId(checkRuns, name, requiredChecks = REQUIRED_CHECKS) {
  const decider = resolveRequiredChecks(checkRuns, requiredChecks).deciders.find((run) => run.name === name);
  for (const url of [decider?.html_url, decider?.details_url]) {
    const match = /\/actions\/runs\/(\d+)\//u.exec(typeof url === 'string' ? url : '');
    if (match) return Number(match[1]);
  }
  return null;
}

function belongsToWorkflowRun(checkRun, runId) {
  if (!runId) return false;
  for (const url of [checkRun?.html_url, checkRun?.details_url]) {
    const match = /\/actions\/runs\/(\d+)\//u.exec(typeof url === 'string' ? url : '');
    if (match && match[1] === String(runId)) return true;
  }
  return false;
}

// A push can start two `CI` runs for one head. The battery plan skips the products of one, which completes
// within a minute and wakes the controller; the other runs them for ~42 minutes. Waiting on that run from
// this wake spends CHECK_TIMEOUT_MS on a run this wake did not trigger, publishes `ci: Checks did not
// settle: api` and drafts the PR, and the deciding run's own completion then promotes the head a minute
// later (PRs #639 and #640, 2026-09-26). True when the triggering run's products were all deliberately
// skipped (its gates passed) and a required check of ANOTHER run on this head is still unfinished: that
// run's completion wakes the controller again, so this wake decides nothing and publishes nothing. A skip
// over an already-decided head (a metadata edit on a covered SHA) has nothing in flight and proceeds.
export function batteryDeferredToInFlightRun(checkRuns, ciRunId, requiredChecks = REQUIRED_CHECKS) {
  if (!ciRunId) return false;
  const own = checkRuns.filter((run) => belongsToWorkflowRun(run, ciRunId));
  const products = own.filter((run) => PRODUCT_CHECKS.includes(run.name));
  if (products.length === 0) return false;
  const gatesPassed = attemptsWithPassingGates(own);
  const skippedBattery = products.every((run) =>
    run.status === 'completed' && run.conclusion === 'skipped' && intentionalSkip(run, gatesPassed));
  if (!skippedBattery) return false;
  return checkRuns.some((run) =>
    requiredChecks.includes(run.name)
    && !belongsToWorkflowRun(run, ciRunId)
    && run.status !== 'completed');
}

// Same-SHA recovery once the bounded retry is spent (Codex finding 4103259698 on #630): a recovery run
// re-read the candidate head and now admits it, but CI's `review-scope` still carries the failed read.
// Re-run that failed CI run on this same head instead of drafting the PR. Only a candidate body whose scope
// the controller admits qualifies, and only on a run that reaches the check wait with a failed check (a
// recovery run), so recovery requests pace it. Returns null when it does not apply, 'superseded' when the
// head moved (nothing is re-run or published for an obsolete head, Codex finding 4104384974), 'rerun', or
// 'rerun_failed' when GitHub refused the re-run, which the caller keeps retryable (Codex finding 4104384966).
export async function rerunAdmittedCandidateScope(client, pullRequest, expectedHead, failedChecks, scope) {
  if (!failedChecks?.includes('review-scope') || scope?.allowed !== true) return null;
  if (correctionOwnerDeclaration(pullRequest).state !== 'candidate') return null;
  const runId = decidingRunId(
    await client.checkRuns(expectedHead), 'review-scope', await requiredChecksFor(client, pullRequest),
  );
  if (!runId) return null;
  if (!await refreshCurrentHead(client, pullRequest.number, expectedHead)) return 'superseded';
  try {
    await client.rerunFailedJobs(runId);
  } catch (error) {
    console.warn(`Could not re-run the failed review-scope job; keeping it retryable: ${error.message}`);
    return 'rerun_failed';
  }
  if (!await refreshCurrentHead(client, pullRequest.number, expectedHead)) return 'superseded';
  await client.updateStickyComment(
    pullRequest.number,
    statusBody({
      state: 'ci_retry',
      head: expectedHead,
      detail: 'review-scope failed while this exact head could not be read; the controller now reads and admits it',
      attempt: 0,
      next: 'GitHub is re-running the failed CI jobs on this same head.',
    }),
  );
  return 'rerun';
}

// The relabel guard (#628 finding 4100230308, #630 finding 4103625675). A body edit to a candidate marker
// does not revoke a green `codex-current-head` already on the head, so until the edited CI run reports, a
// queued native auto-merge or the controller's own merge could land the relabelled PR. On the edit itself,
// this runs the controller's own scope check. A head that does not declare the candidate is refused exactly
// as `enforceReviewScope` refuses it: a `scope:` failure revokes the green status, and the draft conversion
// cancels any queued auto-merge. An unreadable head gets the retryable hold. A truthful candidate seed, or a
// body that declares no candidate, is left untouched. It adds no new writer path: it is the controller's
// scope enforcement, serialized with the controller on the same exact-head concurrency group.
export async function guardCandidateRelabel(client, pullRequest, expectedHead, existingStatuses = []) {
  if (correctionOwnerDeclaration(pullRequest).state !== 'candidate') return 'not_candidate';
  const scope = await enforceReviewScope(client, pullRequest, expectedHead);
  if (scope.superseded) return 'superseded';
  if (scope.retryable) {
    await holdUnreadableCandidateHead(client, pullRequest, expectedHead, scope, existingStatuses);
    return 'unreadable';
  }
  return scope.allowed ? 'admitted' : 'refused';
}

export async function revalidateFinalReviewPolicy(
  client,
  number,
  expectedHead,
) {
  const pullRequest = await refreshCurrentHead(client, number, expectedHead);
  if (!pullRequest) {
    return { state: 'superseded', allowed: false, superseded: true };
  }

  // And at final admission, so a clean head is also measured — after the head is
  // confirmed current, so a superseded one is never reported on.
  const { advisory = null } = await reportReviewLifecycle(client, pullRequest) ?? {};

  const scope = await enforceReviewScope(client, pullRequest, expectedHead);
  if (scope.superseded) return { ...scope, state: 'superseded' };
  // An unread candidate head keeps its retryable meaning here, never `scope_required`: callers publish
  // `OWNERSHIP_READ_RETRY` without drafting, so a later read of the same SHA recovers.
  if (scope.retryable) {
    return { state: 'ownership_withheld', allowed: false, ownershipReason: OWNERSHIP_READ_RETRY, verdict: scope.verdict, pullRequest };
  }
  if (!scope.allowed) return { ...scope, state: 'scope_required' };

  const convergence = await enforceReviewConvergence(
    client,
    pullRequest,
    expectedHead,
  );
  if (convergence.superseded) {
    return { ...convergence, state: 'superseded' };
  }
  const finding = await guardAgainstCurrentHeadFinding(
    client, pullRequest, expectedHead, null,
  );
  if (finding) {
    return { state: 'changes_required', allowed: false, detail: finding };
  }

  // 2B2: the SHA-scoped merge authority for this exact head, read ONCE here — the single verdict
  // both the required-success publisher and the merge consume. Only an eligible trailer permits a
  // `codex-current-head` success; a non-eligible verdict yields the canonical ownership failure
  // reason (unreadable→retryable, candidate/invalid→held) instead, never success.
  const verdict = await readShaMergeVerdict(client, expectedHead);
  const ownershipReason = ownershipReasonForVerdict(verdict);
  if (ownershipReason) {
    return { state: 'ownership_withheld', allowed: false, ownershipReason, verdict, pullRequest };
  }
  // A PR whose body declares a CANDIDATE owner is held even when its head trailer is eligible (Codex
  // finding 4098329036 on #628): scope admits the candidate marker, so without this an unchanged
  // `Correction-Owner: claude` head would publish success and merge the supposed candidate. The body can
  // only WITHHOLD here, never release, so the SHA-scoped merge authority is unchanged.
  const bodyHold = candidateBodyHold(pullRequest, verdict);
  if (bodyHold) {
    return { state: 'ownership_withheld', allowed: false, ownershipReason: OWNERSHIP_CANDIDATE_HELD, verdict: bodyHold, pullRequest };
  }

  return { state: 'allowed', allowed: true, pullRequest, verdict };
}

/**
 * Owner decision 2026-10-08 — file a capped review's deferred findings through the same-PR follow-up component
 * (scripts/review-follow-up.mjs, M2b-1): recorded on the PR first, then filed in the head's one OPEN follow-up
 * issue, with each finding's original-head classification and identity. Returns the issue number; throws on
 * any failure, leaving the record pending for `reconcilePendingFollowUps`.
 */
export function fileDeferredFindings(client, pullRequest, expectedHead, deferred) {
  return fileFollowUp(client, pullRequest, expectedHead, deferred);
}

/**
 * Owner decision 2026-10-08 — the review-round cap for this exact head, read from the PR's review history
 * and its changed lines. Every Codex classification goes through this, so the polling, the final
 * re-verification, the pre-review guard and the recovery all judge the same head the same way.
 */
// Codex 4220338659 — a head's file list is immutable, and `reviewAttempt` asks for the cap on every poll:
// read it ONCE per (client, PR, exact head), so a slow Codex does not spend the token's hourly budget
// refetching the same list every 15 seconds
const capFilesCache = new WeakMap();

/** How many times one evidence snapshot is attempted before it is reported unstable. */
export const EVIDENCE_SNAPSHOT_ATTEMPTS = 3;

function sameReviewSet(before, after) {
  const ids = (list) => (list ?? []).map((review) => String(review?.id)).sort().join(',');
  return ids(before) === ids(after);
}

/**
 * Owner decision 2026-10-08 (M2b) — ONE coherent Codex evidence snapshot, which every classifier caller uses:
 * reviews → comments → reviews. GitHub submits a review and its inline comments together.
 *  - A review submitted before the comments read is in both review reads, with its comments (Codex 4220621334).
 *  - A review submitted after the comments read is in the second review read only. Its inline comments may be
 *    missing, so its container would pass for a review-level finding (deferrable past the cap) while its
 *    changed-line P0/P1 was simply not read; a BODY-ONLY review there would be missed outright by a single
 *    reviews read (Codex 4221120415).
 * So the snapshot is accepted only when both review reads hold the same reviews; otherwise it is read again,
 * up to EVIDENCE_SNAPSHOT_ATTEMPTS times. An unstable snapshot is returned with `stable: false`, which
 * `classifyCodexState` reads as `unsettled`: never clear, never "nothing new". Reactions are read last.
 */
export async function readCodexEvidence(client, number, { reactions = false } = {}) {
  let snapshot;
  for (let attempt = 1; attempt <= EVIDENCE_SNAPSHOT_ATTEMPTS; attempt += 1) {
    const before = await client.reviews(number);
    const comments = await client.reviewComments(number);
    const reviews = await client.reviews(number);
    snapshot = { reviews, comments, stable: sameReviewSet(before, reviews) };
    if (snapshot.stable) break;
  }
  return reactions ? { ...snapshot, reactions: await client.reactions(number) } : snapshot;
}

/** The success description of a head the review-round cap cleared, naming its follow-up issue. */
export function cappedSuccessDetail(settled) {
  return `review: review-round cap; ${settled.deferred.length} non-blocking finding(s) deferred to #${settled.followUp}`;
}

export async function capFiles(client, number, expectedHead) {
  // no file reader: unknown, which the cap treats as incomplete (fail closed), never as "nothing changed"
  if (typeof client.pullRequestFiles !== 'function') return null;
  let byHead = capFilesCache.get(client);
  if (!byHead) capFilesCache.set(client, (byHead = new Map()));
  const key = `${number}@${expectedHead}`;
  if (!byHead.has(key)) {
    // a failed read is not cached: the next poll retries it. Codex 4221022493 — nor is it thrown: it reads as
    // an unknown list (null), which the cap already treats as incomplete (fail closed: a P0/P1 anywhere
    // blocks), so a transient files-API failure never aborts the review orchestration mid-poll
    const pending = client.pullRequestFiles(number).catch(() => { byHead.delete(key); return null; });
    byHead.set(key, pending);
  }
  return byHead.get(key);
}

async function capFor(client, number, expectedHead, reviews, comments, changedFiles = null) {
  const files = await capFiles(client, number, expectedHead);
  // Codex 4220431586 — `changedFiles` (the PR's own count, when known) lets the cap detect a short list
  return reviewCapState({ expectedHead, reviews, comments, files, changedFiles });
}

async function reviewAttempt(
  client,
  pullRequest,
  expectedHead,
  attempt,
  reviewNotBefore,
  advisory = null,
) {
  let live = await refreshCurrentHead(
    client,
    pullRequest.number,
    expectedHead,
  );
  if (!live) return { state: 'superseded' };

  live = await setDraftForCurrentHead(
    client,
    pullRequest.number,
    expectedHead,
    true,
  );
  if (!live) return { state: 'superseded' };
  live = await setDraftForCurrentHead(
    client,
    pullRequest.number,
    expectedHead,
    false,
  );
  if (!live) return { state: 'superseded' };
  const deadline = new Date(Date.now() + REVIEW_TIMEOUT_MS).toISOString();

  await client.updateStickyComment(
    pullRequest.number,
    statusBody({
      state: 'review_pending',
      advisory,
      head: expectedHead,
      detail: 'CI is green; waiting for Codex on the promoted head',
      attempt,
      next: 'Codex reviews this exact SHA.',
    }),
  );

  while (true) {
    live = await refreshCurrentHead(
      client,
      pullRequest.number,
      expectedHead,
    );
    if (!live) return { state: 'superseded' };

    const { reviews, comments, reactions, stable } = await readCodexEvidence(client, pullRequest.number, { reactions: true });
    const result = classifyCodexState({
      stable,
      expectedHead,
      readyAt: reviewNotBefore,
      deadline,
      now: new Date().toISOString(),
      reviews,
      comments,
      reactions,
      cap: await capFor(client, pullRequest.number, expectedHead, reviews, comments, pullRequest.changed_files),
    });
    // an unsettled snapshot is read again on the next poll, like a pending one
    if (result.state !== 'pending' && result.state !== 'unsettled') return result;
    await sleep(POLL_INTERVAL_MS);
  }
}

async function reclassifyCurrentCodexEvidence(
  client,
  number,
  expectedHead,
  reviewNotBefore,
) {
  const { reviews, comments, reactions, stable } = await readCodexEvidence(client, number, { reactions: true });
  const now = new Date();
  return classifyCodexState({
    stable,
    expectedHead,
    readyAt: reviewNotBefore,
    deadline: new Date(now.getTime() + REVIEW_TIMEOUT_MS).toISOString(),
    now: now.toISOString(),
    reviews,
    comments,
    reactions,
    cap: await capFor(client, number, expectedHead, reviews, comments),
  });
}

/**
 * Owner decision 2026-10-08 (M2b) — the ONE way a blocking Codex verdict is published, in a fixed order:
 *  1. the `codex-current-head` FAILURE status, first, because a head that held a success is mergeable (branch
 *     protection, a queued auto-merge) until that status turns red (Codex 4220338753, 4221120404);
 *  2. back to DRAFT, so no reviewer or controller treats it as ready;
 *  3. past the cap, the non-blocking findings beside the blocker are FILED in the head's follow-up issue: the
 *     correction this verdict asks for moves the head, after which they are no longer current-head evidence
 *     and no later read would see them again (Codex 4220861349). They are filed even when the head has
 *     already moved, since they were found on this one.
 * Returns the refreshed pull request, or null when the head is no longer current.
 */
export async function publishBlockingVerdict(client, pullRequest, expectedHead, { description, deferred = [] }) {
  const lines = renderFollowUpLines(deferred);
  if (lines.length > 0) {
    // Codex 4229506050 — the deferred siblings are made durable BEFORE the correction verdict exists: the head
    // first goes non-green without asking anyone for a push, then the lines are recorded, and only then is the
    // verdict published. A recording that fails leaves a retryable failure, so no correction can move the head
    // past findings nothing recorded. (Codex 4226440227 — and the record still precedes the fallible draft.)
    await client.setStatus(expectedHead, 'pending', RECORDING_DESCRIPTION, pullRequest.html_url);
    // Codex 4229880987 — every write after that pending status, the verdict's own included, is guarded: the gate
    // never ends a run on a pending status it wrote, because recovery resumes only retryable failures
    await withFollowUpRetry(client, pullRequest, expectedHead, async () => {
      await recordPendingFollowUp(client, pullRequest, expectedHead, lines);
      await client.setStatus(expectedHead, 'failure', description, pullRequest.html_url);
    });
  } else {
    await client.setStatus(expectedHead, 'failure', description, pullRequest.html_url);
  }
  const live = await setDraftForCurrentHead(client, pullRequest.number, expectedHead, true);
  // files this head's record, and any other pending one on the PR, each in its own head's issue
  if (lines.length > 0) await reconcilePendingFollowUps(client, pullRequest);
  return live;
}

export async function publishCurrentHeadFinding(
  client,
  pullRequest,
  expectedHead,
  recoveryRequest,
  { detail, attempt, deferred = [] },
) {
  const live = await publishBlockingVerdict(client, pullRequest, expectedHead, { description: `review: ${detail}`, deferred });
  if (!live) return { state: 'superseded', superseded: true };
  const reset = await enforceReviewConvergence(
    client,
    pullRequest,
    expectedHead,
  );
  if (reset.superseded) return reset;
  if (!reset.allowed) {
    await settleRecoveryRequest(
      client,
      expectedHead,
      pullRequest,
      recoveryRequest,
      'review-round reset',
    );
    return reset;
  }
  await settleRecoveryRequest(
    client,
    expectedHead,
    pullRequest,
    recoveryRequest,
    'review finding',
  );
  // The instruction is DERIVED here, not accepted from the caller. A call site
  // that could pass its own sentence is a call site that can reintroduce the
  // "Claude Auto-fix handles this" claim on a PR Claude does not own.
  //
  // Derived from `live` — the pull request as refreshed above — not from the
  // snapshot captured when the run started. A Codex poll lasts many minutes, and
  // an owner marker edited during it would otherwise be ignored: a PR that now
  // declares `cursor` would still be told Claude will fix it, which is the
  // original defect returning through a stale read.
  const notice = correctionNotice(live, { detail, reason: 'review' });
  await client.updateStickyComment(
    pullRequest.number,
    statusBody({
      state: 'changes_required',
      advisory: await freshAdvisory(client, pullRequest),
      head: expectedHead,
      detail,
      attempt,
      owner: notice.owner ?? 'undeclared',
      correctionState: noticeState(notice),
      next: reset.rootCauseAdvisory
        ? `Perform a root-cause audit of the repeated findings and add stronger proofs. ${notice.instruction}`
        : notice.instruction,
    }),
  );
  return { state: 'changes_required', allowed: false, detail };
}

export async function guardAgainstCurrentHeadFinding(
  client,
  pullRequest,
  expectedHead,
  recoveryRequest,
) {
  const { reviews, comments, stable } = await readCodexEvidence(client, pullRequest.number);
  const now = new Date();
  const result = classifyCodexState({
    stable,
    expectedHead,
    readyAt: new Date(0).toISOString(),
    deadline: new Date(now.getTime() + REVIEW_TIMEOUT_MS).toISOString(),
    now: now.toISOString(),
    reviews,
    comments,
    reactions: [],
    cap: await capFor(client, pullRequest.number, expectedHead, reviews, comments, pullRequest.changed_files),
  });
  if (result.state !== 'changes_required') return null;

  await publishCurrentHeadFinding(
    client,
    pullRequest,
    expectedHead,
    recoveryRequest,
    { detail: result.detail, attempt: 0, deferred: result.deferred ?? [] },
  );
  return result.detail;
}

/**
 * The current head's Codex classification as the evidence stands NOW: `{ state, detail, deferred }`. The
 * success paths read it last, so a finding that lands after final revalidation either blocks (Codex
 * 4214321785) or, past the cap, is deferred with the rest (Codex 4214270293).
 */
export async function finalCodexEvidence(client, pullRequest, expectedHead) {
  const { reviews, comments, stable } = await readCodexEvidence(client, pullRequest.number);
  const now = new Date();
  const result = classifyCodexState({
    stable,
    expectedHead,
    readyAt: new Date(0).toISOString(),
    deadline: new Date(now.getTime() + REVIEW_TIMEOUT_MS).toISOString(),
    now: now.toISOString(),
    reviews,
    comments,
    reactions: [],
    cap: await capFor(client, pullRequest.number, expectedHead, reviews, comments, pullRequest.changed_files),
  });
  return {
    state: result.state,
    detail: result.detail,
    // Codex 4220861349 — past the cap a blocking verdict carries its non-blocking findings too
    deferred: result.deferred ?? [],
  };
}

/** Deferred findings from two reads, each once (by its GitHub id). */
export function unionDeferred(first, second) {
  const seen = new Set();
  return [...first, ...second].filter((finding) => {
    // Codex 4229881007 — an inline comment and a review are different GitHub resources that can share a numeric
    // id: keyed by URL, or by kind and id, exactly as the follow-up component identifies a finding
    const key = findingIdentity(finding);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** The non-success status a head carries while its evidence and follow-up filing are settled. */
export const SETTLING_DESCRIPTION = 'review: settling Codex evidence and follow-up filing before completion';
/** The non-success status a head carries while a blocking verdict's deferred siblings are recorded. */
export const RECORDING_DESCRIPTION = 'review: recording deferred Codex findings before the verdict';

/**
 * Run a step of follow-up work the gate owes; if it throws, leave the head on the RETRYABLE `FOLLOW_UP_RETRY`
 * failure (never a pending status nothing resumes — Codex 4229506042), then rethrow. Recovery re-runs the head.
 */
async function withFollowUpRetry(client, pullRequest, expectedHead, work) {
  try {
    return await work();
  } catch (error) {
    await client.setStatus(expectedHead, 'failure', FOLLOW_UP_RETRY, pullRequest.html_url).catch(() => {});
    throw error;
  }
}

/**
 * Owner decision 2026-10-08 — the ONE settlement of a head's Codex evidence before a success lets it merge,
 * shared by the ordinary success path and the recovery of an earlier success (Codex 4216657933): the evidence
 * is re-read now; a blocking finding is returned as blocking; past the cap, every deferred finding — the
 * caller's earlier read and this one — is filed in the head's follow-up issue (reconciled into an existing
 * one) before the merge. `{ state: 'changes_required', detail } | { state: 'clear', deferred, followUp }`.
 */
export async function settleFinalCodexEvidence(client, pullRequest, expectedHead, earlierDeferred = []) {
  // Owner direction 2026-10-09 (#482, 6075561748) / Codex 4226684322 — withdraw any earlier green FIRST: branch
  // protection and a queued auto-merge act on a success, so a head must not stay mergeable while its follow-up
  // filing is still being written. Success is restored only by the caller, after this settlement — filing
  // included — has succeeded; a run that fails here leaves the head non-green, and the stored success it
  // withdrew is recovered (and re-settled) by the next run.
  await client.setStatus(expectedHead, 'pending', SETTLING_DESCRIPTION, pullRequest.html_url);
  // any step below that throws leaves the retryable FOLLOW_UP_RETRY failure, not the pending status
  return withFollowUpRetry(client, pullRequest, expectedHead, () => settleAfterWithdrawal(client, pullRequest, expectedHead, earlierDeferred));
}

async function settleAfterWithdrawal(client, pullRequest, expectedHead, earlierDeferred) {
  // recover any follow-up filing on this PR that was recorded but never completed (an earlier head's included),
  // so no deferred finding is lost when this head merges
  await reconcilePendingFollowUps(client, pullRequest);
  const evidence = await finalCodexEvidence(client, pullRequest, expectedHead);
  // Codex 4220739672 — the settlement is a FINDINGS guard, never the source of the clean verdict: the caller
  // already holds that (the poll's fresh +1 after this attempt's readyAt, or the recovered success status).
  // So it admits exactly two outcomes: `clear` (past the cap, everything deferrable) and `pending` (no
  // current-head finding and no current-head review — nothing arrived since the clean result). Every other
  // state, present or future, fails closed rather than falling through to a success.
  if (evidence.state !== 'clear' && evidence.state !== 'pending') return blockingSettlement(evidence, earlierDeferred);
  // Codex 4229881000 — filing takes time, and Codex can land a finding meanwhile (a late first invocation, after
  // a second one supplied the clean result). So the evidence is read AGAIN after every filing, and the head
  // settles only on a read taken after the last write: a blocker found then blocks, a new deferrable finding is
  // filed too, and evidence that keeps changing throws (the retryable follow-up failure, never a success).
  let current = evidence;
  let deferred = [];
  let followUp = null;
  const filed = new Set();
  for (let attempt = 1; ; attempt += 1) {
    deferred = unionDeferred(deferred, unionDeferred(earlierDeferred, current.deferred));
    const unfiled = deferred.filter((finding) => !filed.has(findingIdentity(finding)));
    if (unfiled.length === 0) return { state: 'clear', deferred, followUp };
    if (attempt > EVIDENCE_SNAPSHOT_ATTEMPTS) throw new Error('Codex evidence kept changing while its follow-ups were filed');
    followUp = await fileDeferredFindings(client, pullRequest, expectedHead, deferred);
    for (const finding of deferred) filed.add(findingIdentity(finding));
    current = await finalCodexEvidence(client, pullRequest, expectedHead);
    if (current.state !== 'clear' && current.state !== 'pending') return blockingSettlement(current, deferred);
  }
}

/** The settlement's answer when the evidence is neither `clear` nor `pending`. */
function blockingSettlement(evidence, deferred) {
  return {
    state: 'changes_required',
    detail: evidence.state === 'changes_required'
      ? evidence.detail
      // an unsettled read is retryable (review-policy RETRYABLE_REVIEW_FAILURES), never a latched finding
      : evidence.state === 'unsettled'
        ? 'review: Codex evidence changed during final verification'
        : `review: final Codex evidence is ${evidence.state}; not merging on it`,
    // Codex 4220861349 — what was deferrable stays deferrable beside a blocker; the caller files it
    deferred: unionDeferred(deferred, evidence.deferred),
    // Codex 4226440219 — an unsettled read is an infrastructure retry, published on the recovery path
    retryable: evidence.state === 'unsettled',
  };
}

/**
 * Publish the success a settlement has earned. It is the last write after the settlement's pending status, so it
 * is guarded like the rest (Codex 4229880987): a failed write leaves the retryable follow-up failure.
 */
export function publishSettledSuccess(client, pullRequest, expectedHead, description) {
  return withFollowUpRetry(client, pullRequest, expectedHead, async () => {
    // M3c (v3 §A2) — the ONLY writer of a `codex-current-head` success. It earns the approval token itself, in this
    // run, after the settlement that precedes it, and writes nothing without one: a cited head whose work item
    // does not verify, or whose trailer cannot be read, never turns green (the failure left here is retryable;
    // the next run's scope check routes an invalid citation to its refusal).
    const approval = await approvalTokenForHead(client, pullRequest, expectedHead);
    if (!approval.token) throw new Error(`success withheld: ${approval.refused}`);
    return client.setStatus(expectedHead, 'success', withApprovalToken(description, approval.token), pullRequest.html_url);
  });
}

export function contextForEvent(eventName, event, dispatchNumber) {
  if (eventName === 'workflow_dispatch') {
    return {
      number: Number(dispatchNumber ?? event.inputs?.pr_number),
      expectedHead: event.inputs?.head_sha ?? null,
      terminalStatusId: event.inputs?.terminal_status_id ?? null,
      ciConclusion: null,
      trigger: 'dispatch',
    };
  }
  if (eventName === 'workflow_run' && event.workflow_run?.event === 'pull_request') {
    return {
      number: Number(event.workflow_run.pull_requests?.[0]?.number),
      expectedHead: event.workflow_run.head_sha,
      ciConclusion: event.workflow_run.conclusion,
      ciRunId: Number(event.workflow_run.id),
      ciRunAttempt: Number(event.workflow_run.run_attempt ?? 1),
      trigger: 'ci',
    };
  }
  // The relabel guard: a PR body edit, seen from trusted default-branch code (`pull_request_target`).
  if (eventName === 'pull_request_target' && event.action === 'edited') {
    return {
      number: Number(event.pull_request?.number),
      expectedHead: event.pull_request?.head?.sha ?? null,
      ciConclusion: null,
      trigger: 'relabel',
    };
  }
  return null;
}

export function assertCurrentHeadForContext(context, currentHead, mode) {
  if (!context.expectedHead || context.expectedHead === currentHead) return true;
  if (context.trigger === 'dispatch' && mode === 'request-recovery') {
    throw new Error(
      `Recovery dispatch head ${context.expectedHead} no longer matches current head ${currentHead}`,
    );
  }
  return false;
}

async function eventContext() {
  const eventName = requiredEnvironment('GITHUB_EVENT_NAME');
  const event = JSON.parse(
    await readFile(requiredEnvironment('GITHUB_EVENT_PATH'), 'utf8'),
  );
  return contextForEvent(eventName, event, process.env.PR_NUMBER);
}

export async function run() {
  const context = await eventContext();
  if (!context?.number) {
    console.log('No pull request is associated with this workflow event.');
    return;
  }

  const repository = requiredEnvironment('GITHUB_REPOSITORY');
  const client = new GitHubClient({
    repository,
    token: requiredEnvironment('GITHUB_TOKEN'),
  });
  let pullRequest = await client.pullRequest(context.number);
  if (!isEligiblePullRequest(eligibleShape(pullRequest))) {
    console.log('Pull request is closed or comes from a fork; leaving it untouched.');
    return;
  }

  const expectedHead = context.expectedHead ?? pullRequest.head.sha;
  const mode = process.env.AUTONOMOUS_REVIEW_MODE ?? 'orchestrate';
  if (!assertCurrentHeadForContext(context, pullRequest.head.sha, mode)) {
    console.log('Workflow event was superseded by a newer pull-request head.');
    return;
  }

  const existingStatuses = await client.statuses(expectedHead);
  const existingStatus = existingStatuses.find(
    (status) => status.context === STATUS_CONTEXT,
  ) ?? null;
  // M3c (v3 §A5, #764 Codex 4237161956) — the first write of every run, before any scope, commit or issue read:
  // the only reads before it are the pull request (to know the head) and this status list (to know a green is
  // there). A green without an approval token is withdrawn here, so a later read that stalls until the job is
  // cancelled can never leave it standing beneath an already-queued native auto-merge.
  await withdrawUntokenedSuccess(client, pullRequest, expectedHead, existingStatus);

  if (mode === 'relabel-guard') {
    if (context.trigger !== 'relabel') throw new Error('The relabel guard runs only on a pull request body edit');
    const outcome = await guardCandidateRelabel(client, pullRequest, expectedHead, existingStatuses);
    console.log(`Relabel guard: ${outcome}.`);
    return;
  }

  if (mode === 'request-recovery') {
    const authorizedStatus = authorizeRecoveryDispatch(
      existingStatuses,
      context.terminalStatusId,
    );
    if (!authorizedStatus) {
      throw new Error(
        'Recovery dispatch requires the exact latest failed terminal '
          + `${STATUS_CONTEXT} status ID`,
      );
    }
    await persistRecoveryRequest(
      client,
      expectedHead,
      pullRequest,
      authorizedStatus,
    );
    console.log(
      `Persisted recovery request for terminal status ${authorizedStatus.id}.`,
    );
    return;
  }

  // 2B2: when the newest current-head review is a candidate ownership hold, the exact head is
  // consistently owned by an in-flight candidate whose IMMUTABLE trailer cannot become merge-eligible
  // through a metadata edit. Re-running CI and Codex on the same SHA would overwrite the hold with
  // `pending` and spend a review that can only reproduce the same hold; leave it until reviewer
  // activation or a new head supersedes it. A new head changes `expectedHead`, so its statuses carry no
  // such hold and orchestration proceeds normally.
  if (immutableOwnershipHoldIsNewestReview(existingStatuses)) {
    console.log(
      'Newest current-head review is a SHA-immutable ownership hold (candidate, or a head-remedy '
        + 'ownership inconsistency); leaving it in place — only reviewer activation or a new head '
        + 'resumes it, never a metadata edit. A body-remedy inconsistency is not held here and reruns.',
    );
    return;
  }

  const scope = await enforceReviewScope(client, pullRequest, expectedHead);
  if (scope.superseded) return;
  if (!scope.allowed && !scope.retryable) throw new Error(scope.detail);
  const ciFailed = Boolean(context.ciConclusion && context.ciConclusion !== 'success');
  if (scope.retryable && !ciFailed) {
    // The exact candidate head could not be read (Codex finding 4101926931 on #630): retryable on this SHA.
    await holdUnreadableCandidateHead(client, pullRequest, expectedHead, scope, existingStatuses);
    console.log(`Exact candidate head is unreadable; retryable on this same head: ${scope.detail}`);
    return;
  }

  if (ciFailed) {
    await handleCiFailure(client, context, pullRequest, expectedHead, { existingStatus, existingStatuses, scope });
    return;
  }

  // Before any status write: a wake from a run whose battery the plan skipped, while another run still
  // decides this head, has nothing to publish — that run's completion wakes the controller again.
  if (batteryDeferredToInFlightRun(
    await client.checkRuns(expectedHead), context.ciRunId, await requiredChecksFor(client, pullRequest),
  )) {
    console.log(
      `CI run ${context.ciRunId} skipped the product battery while another CI run for this head is still `
        + 'deciding it; leaving the head to that run\'s completion.',
    );
    return;
  }

  const terminalStatus = recoverableTerminalReviewStatus(existingStatuses);
  let recoveryRequest = pendingRecoveryRequest(existingStatuses);
  const requestedTerminalStatus = recoveryRequestTerminal(
    existingStatuses,
    recoveryRequest,
  );
  if (recoveryRequest && !requestedTerminalStatus) {
    await client.setStatus(
      expectedHead,
      'failure',
      'recovery: request superseded by newer review state',
      pullRequest.html_url,
      recoveryRequest.status.context,
    );
    recoveryRequest = null;
    if (!terminalStatus) {
      throw new Error(
        'Recovery request no longer matches the latest terminal review state',
      );
    }
  }

  const existingFinding = await guardAgainstCurrentHeadFinding(
    client,
    pullRequest,
    expectedHead,
    recoveryRequest,
  );
  if (existingFinding) throw new Error(existingFinding);

  if (!requestedTerminalStatus && terminalStatus) {
    if (
      await ensureTerminalReviewState(
        client,
        pullRequest,
        expectedHead,
        terminalStatus,
        existingStatuses,
      )
    ) {
      console.log(
        'Exact head already has a recoverable terminal Codex state; no review will be requested.',
      );
      return;
    }
  }

  await client.setStatus(
    expectedHead,
    'pending',
    'review: pending required CI and current-head Codex review',
    pullRequest.html_url,
  );

  const checks = await waitForRequiredChecks(client, pullRequest, expectedHead);
  if (checks.state === 'superseded') return;
  if (checks.state !== 'success') {
    const recovery = await rerunAdmittedCandidateScope(client, pullRequest, expectedHead, checks.failed, scope);
    if (recovery === 'rerun' || recovery === 'superseded') return;
    if (recovery === 'rerun_failed') {
      // Keep the recovery retryable rather than drafting: republish the retryable hold and settle the pending
      // recovery request, so the watchdog can request a fresh same-SHA recovery (Codex finding 4104384966).
      await holdUnreadableCandidateHead(client, pullRequest, expectedHead, scope, existingStatuses);
      return;
    }
    pullRequest = await setDraftForCurrentHead(
      client,
      pullRequest.number,
      expectedHead,
      true,
    );
    if (!pullRequest) return;
    const detail = checks.failed?.length
      ? `Failed checks: ${checks.failed.join(', ')}`
      : `Checks did not settle: ${[...(checks.missing ?? []), ...(checks.pending ?? [])].join(', ')}`;
    await client.setStatus(
      expectedHead,
      'failure',
      `ci: ${detail}`,
      pullRequest.html_url,
    );
    const settleNotice = correctionNotice(pullRequest, { detail, reason: 'ci' });
    await client.updateStickyComment(
      pullRequest.number,
      statusBody({
        state: 'blocked',
        head: expectedHead,
        detail,
        attempt: 0,
        owner: settleNotice.owner ?? 'undeclared',
        correctionState: noticeState(settleNotice),
          next: settleNotice.instruction,
      }),
    );
    throw new Error(detail);
  }

  const convergence = await enforceReviewConvergence(
    client,
    pullRequest,
    expectedHead,
  );
  if (convergence.superseded) return;
  if (!convergence.allowed) {
    throw new Error(
      `${convergence.findingHeadCount} finding heads require a replacement PR`,
    );
  }

  // Observe the lifecycle BEFORE promoting for another review — this is the
  // path the first attempt missed.
  const { advisory = null } = await reportReviewLifecycle(client, pullRequest) ?? {};

  const reviewNotBefore = new Date(Date.now() - 1_000).toISOString();
  for (let attempt = 1; attempt <= MAX_REVIEW_ATTEMPTS; attempt += 1) {
    const result = await reviewAttempt(
      client,
      pullRequest,
      expectedHead,
      attempt,
      reviewNotBefore,
      advisory,
    );
    if (result.state === 'superseded') return;

    if (result.state === 'changes_required') {
      const published = await publishCurrentHeadFinding(
        client,
        pullRequest,
        expectedHead,
        recoveryRequest,
        { detail: result.detail, attempt, deferred: result.deferred ?? [] },
      );
      if (published.superseded) return;
      throw new Error(result.detail);
    }

    if (result.state === 'clear') {
      pullRequest = await refreshCurrentHead(
        client,
        pullRequest.number,
        expectedHead,
      );
      if (!pullRequest) return;
      const resolvedThreadCount = await client.resolveCodexThreads(
        pullRequest.number,
        expectedHead,
      );
      const verifiedResult = await reclassifyCurrentCodexEvidence(
        client,
        pullRequest.number,
        expectedHead,
        reviewNotBefore,
      );
      if (verifiedResult.state !== 'clear') {
        const detail = verifiedResult.state === 'changes_required'
          ? verifiedResult.detail
          : 'Codex evidence changed during final verification';
        if (verifiedResult.state === 'changes_required') {
          const published = await publishCurrentHeadFinding(
            client,
            pullRequest,
            expectedHead,
            recoveryRequest,
            { detail, attempt, deferred: verifiedResult.deferred ?? [] },
          );
          if (published.superseded) return;
          throw new Error(detail);
        }
        pullRequest = await publishBlockingVerdict(client, pullRequest, expectedHead, { description: `review: ${detail}` });
        if (!pullRequest) return;
        await settleRecoveryRequest(
          client,
          expectedHead,
          pullRequest,
          recoveryRequest,
          'changed review evidence',
        );
        const evidenceNotice = correctionNotice(pullRequest, { detail, reason: 'review' });
        await client.updateStickyComment(
          pullRequest.number,
          statusBody({
            state: 'changes_required',
            advisory: await freshAdvisory(client, pullRequest),
            head: expectedHead,
            detail,
            attempt,
            owner: evidenceNotice.owner ?? 'undeclared',
            correctionState: noticeState(evidenceNotice),
                  next: evidenceNotice.instruction,
          }),
        );
        throw new Error(detail);
      }
      const finalStatuses = await client.statuses(expectedHead);
      const finalCheckSummary = summarizeRequiredChecks(
        await client.checkRuns(expectedHead),
        await requiredChecksFor(client, pullRequest),
      );
      if (
        finalCheckSummary.state !== 'success'
        || hasCiFailureAfterPending(finalStatuses)
      ) {
        pullRequest = await setDraftForCurrentHead(
          client,
          pullRequest.number,
          expectedHead,
          true,
        );
        if (!pullRequest) return;
        const detail = 'Required CI changed during current-head Codex review';
        await client.setStatus(
          expectedHead,
          'failure',
          `review: ${detail}`,
          pullRequest.html_url,
        );
        await settleRecoveryRequest(
          client,
          expectedHead,
          pullRequest,
          recoveryRequest,
          'changed CI',
        );
        await client.updateStickyComment(
          pullRequest.number,
          statusBody({
            state: 'blocked',
            head: expectedHead,
            detail,
            attempt,
            next: 'Re-dispatch after required CI is green on this exact head.',
          }),
        );
        throw new Error(detail);
      }
      // Shadow evidence is non-authoritative and MUST NOT affect merge eligibility:
      // contain any error from fetching or classifying it so it can never propagate
      // and strand the authoritative `codex-current-head` gate published below.
      let shadow = { state: 'unavailable', authoritative: false };
      try {
        shadow = await classifyClaudeShadowReview({
          checkRuns: await client.checkRuns(expectedHead),
          expectedHead,
          expectedBase: pullRequest.base.sha,
          pullRequestNumber: pullRequest.number,
          verifyProducer: (run, evidence) => client.verifyClaudeShadowProducer(run, evidence),
        });
      } catch (error) {
        console.log(`Claude independent-review shadow: unavailable (${error?.message ?? error}); non-authoritative, ignored`);
      }
      console.log(
        `Claude independent-review shadow: ${shadow.state}`
        + (Number.isInteger(shadow.findingCount) ? ` (${shadow.findingCount} finding(s))` : '')
        + '; non-authoritative',
      );
      // Publish the clean verdict while the pull request is still OPEN. This
      // sticky update is the last guaranteed-delivery event on the success
      // path: sessions subscribed to the PR receive comment updates only while
      // it is open, success statuses are never forwarded to them, and the
      // moment the required status flips green below GitHub auto-merge may
      // close the PR. Without this event the success path is silent and a
      // watching session cannot know to continue the loop.
      await client.updateStickyComment(
        pullRequest.number,
        statusBody({
          state: 'review_clean',
          head: expectedHead,
          detail: result.detail,
          attempt,
          next: 'GitHub sets the required status and completes this exact reviewed head.',
        }),
      );
      const finalPolicy = await revalidateFinalReviewPolicy(
        client,
        pullRequest.number,
        expectedHead,
      );
      if (finalPolicy.superseded) return;
      if (!finalPolicy.allowed) {
        if (finalPolicy.ownershipReason) {
          // 2B2: Codex found the head clean, but the exact head's SHA merge-authority verdict is
          // not eligible — publish the canonical ownership failure on this same SHA instead of
          // success (unreadable is retryable; candidate/invalid are held). No merge is attempted.
          await client.setStatus(
            expectedHead,
            'failure',
            finalPolicy.ownershipReason,
            pullRequest.html_url,
          );
          // Consume any pending recovery request now: a prior `OWNERSHIP_READ_RETRY` may have minted
          // one, and once this immutable hold is newest, `run()` short-circuits before
          // `pendingRecoveryRequest` on every later pass — so the request would otherwise persist
          // forever. `settleRecoveryRequest` no-ops when there is none.
          await settleRecoveryRequest(
            client,
            expectedHead,
            pullRequest,
            recoveryRequest,
            'ownership hold',
          );
          // Replace the `review_clean` sticky published above: it says GitHub will complete the head,
          // but the head is held on ownership. Only while THIS reviewed head is still current — a push,
          // close, or retarget between revalidation and here means the singleton sticky belongs to a
          // different head now. The hold's owner/state come from the SHA verdict (never the mutable PR
          // body), so this sticky and the canonical status agree on who — if anyone — the head authenticates.
          const stillCurrent = await refreshCurrentHead(client, pullRequest.number, expectedHead);
          if (stillCurrent) {
            await publishOwnershipHoldSticky(client, stillCurrent, expectedHead, {
              ownershipReason: finalPolicy.ownershipReason,
              verdict: finalPolicy.verdict,
              attempt,
            });
          }
          return;
        }
        throw new Error(`Final review policy changed: ${finalPolicy.state}`);
      }
      pullRequest = finalPolicy.pullRequest;
      // Owner decision 2026-10-08 — the head's evidence is settled once more before the success that lets it
      // merge: a finding that arrived after the poll's verification blocks (Codex 4214321785) or, past the cap,
      // is filed in the head's follow-up issue with the rest (Codex 4214270293), so none is lost.
      const settled = await settleFinalCodexEvidence(client, pullRequest, expectedHead, verifiedResult.deferred ?? []);
      if (settled.retryable) {
        // Codex 4226440219 — recovery-only publication: no correction instruction; recovery reruns this head
        pullRequest = await publishBlockingVerdict(client, pullRequest, expectedHead, { description: settled.detail });
        if (!pullRequest) return;
        await settleRecoveryRequest(client, expectedHead, pullRequest, recoveryRequest, 'changed review evidence');
        throw new Error(settled.detail);
      }
      if (settled.state === 'changes_required') {
        await publishCurrentHeadFinding(client, pullRequest, expectedHead, recoveryRequest, {
          detail: settled.detail,
          attempt,
          deferred: settled.deferred ?? [],
        });
        return;
      }
      // One run polls one Codex invocation to its mutually exclusive terminal
      // result: finding-bearing evidence or the clean reaction. Review webhooks
      // never enter this orchestrator, so no second writer can race admission.
      await publishSettledSuccess(
        client,
        pullRequest,
        expectedHead,
        settled.followUp === null
          ? 'review: Codex found no blocking issue on this exact head'
          : cappedSuccessDetail(settled),
      );
      await settleRecoveryRequest(
        client,
        expectedHead,
        pullRequest,
        recoveryRequest,
        'clean review',
      );
      pullRequest = await refreshCurrentHead(
        client,
        pullRequest.number,
        expectedHead,
      );
      if (!pullRequest) return;
      const completion = await completeReviewedPullRequest(
        client,
        pullRequest,
        expectedHead,
        finalPolicy.verdict,
      );
      await client.updateStickyComment(
        pullRequest.number,
        statusBody({
          state: 'clear',
          head: expectedHead,
          detail: `${result.detail}; resolved ${resolvedThreadCount} verified Codex thread${resolvedThreadCount === 1 ? '' : 's'}`,
          attempt,
          next: completion === 'merged'
            ? 'GitHub squash-merged this exact reviewed head.'
            : completion === 'queued'
              ? 'GitHub auto-merge is queued behind branch protection.'
              : 'Merge is held because the current head, base, readiness or required gates changed during validation.',
        }),
      );
      return;
    }

    if (attempt < MAX_REVIEW_ATTEMPTS) {
      pullRequest = await setDraftForCurrentHead(
        client,
        pullRequest.number,
        expectedHead,
        true,
      );
      if (!pullRequest) return;
      await client.updateStickyComment(
        pullRequest.number,
        statusBody({
          state: 'review_retry',
          head: expectedHead,
          detail: result.detail,
          attempt,
          next: 'GitHub repeats the draft-to-ready Codex trigger once.',
        }),
      );
      await sleep(2_000);
    }
  }

  pullRequest = await setDraftForCurrentHead(
    client,
    pullRequest.number,
    expectedHead,
    true,
  );
  if (!pullRequest) return;
  await client.setStatus(
    expectedHead,
    'failure',
    'review: Codex review timed out after two attempts',
    pullRequest.html_url,
  );
  await settleRecoveryRequest(
    client,
    expectedHead,
    pullRequest,
    recoveryRequest,
    'review timeout',
  );
  await client.updateStickyComment(
    pullRequest.number,
    statusBody({
      state: 'blocked',
      head: expectedHead,
      detail: 'Codex review timed out after two attempts',
      attempt: MAX_REVIEW_ATTEMPTS,
      next: 'Re-dispatch this workflow after the Codex integration is healthy.',
    }),
  );
  throw new Error('Codex review timed out after two attempts');
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;
if (invokedPath === import.meta.url) {
  run().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
