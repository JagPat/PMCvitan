import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

import {
  codexThreadIdsToResolve,
  classifyCodexState,
  isEligiblePullRequest,
} from './autonomous-review-state.mjs';
import { LINEAGE_BASE_REF, isLineageBase } from './lineage-policy.mjs';
import { observeReviewLifecycle, lifecycleAdvisory } from './review-lifecycle.mjs';
import {
  CORRECTION_STALLED,
  correctionOwnerDeclaration,
  correctionRouting,
} from './correction-owner.mjs';
import {
  assessReviewScope,
  isRetryableReviewFailureDescription,
  codexFindingHeads,
  PRE_REVIEW_ENFORCE_AFTER_PR,
  REPLACEMENT_REQUIRED_LABEL,
  REVIEW_RESET_AFTER_FINDING_HEADS,
  REVIEW_SCOPE_ENFORCE_AFTER_PR,
} from './review-efficiency.mjs';
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

export const REQUIRED_CHECKS = [
  'review-scope',
  'battery-plan',
  'web',
  'api',
  'e2e',
  'api-e2e',
  'upgrade-proof',
];
export const MAX_REVIEW_ATTEMPTS = 2;

const STATUS_CONTEXT = 'codex-current-head';
const RECOVERY_CONTEXT_PREFIX = 'codex-recovery-request/';
const COMMENT_MARKER = '<!-- autonomous-review-state -->';
const API_ROOT = 'https://api.github.com';
// The settle window must exceed the LONGEST required CI job. The api battery
// runs ~11-13 minutes; a 10-minute window made every orchestrator instance
// woken early (e.g. by a metadata-only `edited` CI run completing while the
// synchronize run's battery was still going) publish a false
// "Checks did not settle" block that only healed when the real run's
// completion re-triggered the workflow. 25 minutes covers the battery with
// headroom and costs nothing when checks are already green.
const CHECK_TIMEOUT_MS = Number(process.env.CHECK_TIMEOUT_MS ?? 25 * 60_000);
// Codex reviews of this repository land 13-23 minutes after their
// draft-to-ready trigger (measured over PR #337's ten rounds). A 15-minute
// attempt window expired before nearly every real review, burning the retry
// on a review that was already in flight and ending runs in a false
// "timed out after two attempts" terminal state minutes before the review
// arrived. 25 minutes covers the observed latency; the two-attempt budget
// still bounds the run.
const REVIEW_TIMEOUT_MS = Number(process.env.REVIEW_TIMEOUT_MS ?? 25 * 60_000);
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS ?? 15_000);

export function requiredChecksForPullRequest(pullRequestNumber) {
  if (
    Number.isInteger(pullRequestNumber)
    && pullRequestNumber > 0
    && pullRequestNumber <= REVIEW_SCOPE_ENFORCE_AFTER_PR
  ) {
    // Neither job exists on pre-policy branches; requiring them would strand
    // an older PR on a check it cannot emit.
    return REQUIRED_CHECKS.filter(
      (name) => name !== 'review-scope' && name !== 'battery-plan',
    );
  }
  return REQUIRED_CHECKS;
}

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
  const watermarks = gateWatermarks(checkRuns);
  const attemptStamps = attemptGateStamps(checkRuns);
  const gatesPassed = attemptsWithPassingGates(checkRuns);
  const missing = [];
  const pending = [];
  const failed = [];

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
    }
  }

  return {
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

export function shouldRetryCiFailure(context, existingStatus, failedChecks = []) {
  return context?.trigger === 'ci'
    && context.ciConclusion
    && context.ciConclusion !== 'success'
    && Number.isInteger(context.ciRunId)
    && context.ciRunId > 0
    && context.ciRunAttempt === 1
    && !failedChecks.includes('review-scope')
    && !isTerminalReviewStatus(existingStatus);
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

export function recoverableTerminalReviewStatus(statuses) {
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
      throw new Error(`GitHub GraphQL failed: ${JSON.stringify(payload.errors)}`);
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

  // The PR's CUMULATIVE diff against its base — every file the review unit touches,
  // not just the files of the current head commit.
  pullRequestFiles(number) {
    return this.paginated(
      `/repos/${this.repository}/pulls/${number}/files`,
    );
  }

  async ensureReplacementRequiredLabel() {
    const path = `/repos/${this.repository}/labels/${encodeURIComponent(REPLACEMENT_REQUIRED_LABEL)}`;
    try {
      await this.request(path);
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes('(404)')) throw error;
      await this.request(`/repos/${this.repository}/labels`, {
        method: 'POST',
        body: {
          name: REPLACEMENT_REQUIRED_LABEL,
          color: 'b60205',
          description: 'Review-round limit reached; a declared replacement is required',
        },
      });
    }
  }

  async markReplacementRequired(number) {
    await this.ensureReplacementRequiredLabel();
    await this.request(`/repos/${this.repository}/issues/${number}/labels`, {
      method: 'POST',
      body: { labels: [REPLACEMENT_REQUIRED_LABEL] },
    });
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

  // A file's text AT a ref. Used for the convergence packet, whose CONTENT carries the
  // deferral ledger — a filename alone cannot show that the ledger exists.

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

  async setDraft(pullRequest, draft) {
    if (Boolean(pullRequest.draft) === draft) return pullRequest;
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

function eligibleShape(pullRequest) {
  return {
    state: pullRequest.state,
    headRefName: pullRequest.head.ref,
    baseRefName: pullRequest.base.ref,
    headRepository: { nameWithOwner: pullRequest.head.repo?.full_name },
    baseRepository: { nameWithOwner: pullRequest.base.repo?.full_name },
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
    const [comments, reviews] = await Promise.all([
      client.reviewComments(pullRequest.number),
      client.reviews(pullRequest.number),
    ]);
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
    `- **Codex attempt:** ${attempt}/${MAX_REVIEW_ATTEMPTS}`,
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

async function refreshCurrentHead(client, number, expectedHead) {
  const pullRequest = await client.pullRequest(number);
  if (pullRequest.state !== 'open' || pullRequest.head.sha !== expectedHead) {
    console.log('Pull request closed or a newer head superseded this workflow.');
    return null;
  }
  // THE BASE IS CHECKED HERE, and only here, because this is the one primitive every
  // acting boundary already re-reads the pull request through: promotion, completion,
  // final policy and terminal recovery all pass through it. A base is MUTABLE and
  // retargeting leaves the head SHA untouched, so a check taken once and carried
  // across awaits is a snapshot, not a guard — the placement is the fix, not another
  // call site to remember.
  //
  // RETARGETING IS NOT SUPERSESSION. A superseded head is dropped silently because a
  // newer head is already being processed; nothing will pick up a retargeted unit, so
  // the refusal is PERSISTED before returning. Without that, a terminal-success status
  // written while the unit still targeted `main` would survive and leave an off-base
  // unit mergeable.
  if (!isLineageBase(pullRequest.base?.ref)) {
    const target = typeof pullRequest.base?.ref === 'string'
      && pullRequest.base.ref.length > 0
      ? pullRequest.base.ref
      : 'an unreadable base';
    console.log(`Pull request no longer targets ${LINEAGE_BASE_REF}: ${target}.`);
    await client.setDraft(pullRequest, true);
    await client.setStatus(
      expectedHead,
      'failure',
      `scope: a reviewed unit must target ${LINEAGE_BASE_REF}; this unit targets ${target}`,
      pullRequest.html_url,
    );
    return null;
  }
  return pullRequest;
}

async function setDraftForCurrentHead(
  client,
  number,
  expectedHead,
  draft,
) {
  const pullRequest = await refreshCurrentHead(client, number, expectedHead);
  if (!pullRequest) return null;
  const updated = await client.setDraft(pullRequest, draft);
  return updated.state === 'open' && updated.head.sha === expectedHead
    ? updated
    : null;
}

export async function completeReviewedPullRequest(
  client,
  pullRequest,
  expectedHead,
) {
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

export async function ensureTerminalReviewState(
  client,
  pullRequest,
  expectedHead,
  status,
  statuses,
) {
  if (!isTerminalReviewStatus(status)) return false;
  if (status.state === 'success') {
    if (persistentReviewFailure(statuses)) {
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
    if (finalPolicy.superseded || !finalPolicy.allowed) return true;
    const latestStatus = statuses.find(
      (candidate) => candidate.context === STATUS_CONTEXT,
    );
    if (String(latestStatus?.id) !== String(status.id)) {
      await client.setStatus(
        expectedHead,
        'success',
        'review: recovered prior clean Codex result on this exact head',
        pullRequest.html_url,
      );
    }
    await completeReviewedPullRequest(
      client,
      finalPolicy.pullRequest,
      expectedHead,
    );
  } else {
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
    await setDraftForCurrentHead(
      client,
      pullRequest.number,
      expectedHead,
      true,
    );
  }
  return true;
}

async function waitForRequiredChecks(client, pullRequest, expectedHead) {
  const deadline = Date.now() + CHECK_TIMEOUT_MS;
  const requiredChecks = requiredChecksForPullRequest(pullRequest.number);
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
  const [comments, reviews] = await Promise.all([
    client.reviewComments(pullRequest.number),
    client.reviews(pullRequest.number),
  ]);
  const findingHeads = codexFindingHeads(comments, reviews);
  const findingHeadCount = findingHeads.length;
  if (findingHeadCount < REVIEW_RESET_AFTER_FINDING_HEADS) {
    return {
      state: 'reviewing',
      required: false,
      allowed: true,
      findingHeadCount,
      findingHeads,
    };
  }
  const result = {
    state: 'replacement_required',
    required: true,
    allowed: false,
    findingHeadCount,
    findingHeads,
    threshold: REVIEW_RESET_AFTER_FINDING_HEADS,
  };

  const live = await setDraftForCurrentHead(
    client,
    pullRequest.number,
    expectedHead,
    true,
  );
  if (!live) return { ...result, superseded: true };
  await client.markReplacementRequired(pullRequest.number);
  const detail = `${findingHeadCount} finding-bearing heads reached the review-round limit; this unit requires a replacement PR`;
  await client.setStatus(
    expectedHead,
    'failure',
    `review: ${detail}`,
    pullRequest.html_url,
  );
  const notice = correctionNotice(live, { detail, reason: 'replacement' });
  await client.updateStickyComment(
    pullRequest.number,
    statusBody({
      state: 'replacement_required',
      head: expectedHead,
      detail,
      attempt: 0,
      owner: notice.owner ?? 'undeclared',
      correctionState: noticeState(notice),
      next: notice.instruction,
    }),
  );
  return result;
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
  const result = assessReviewScope(pullRequest, {
    changedFiles,
    requireChangedFiles: true,
    requireReplacementLineage: pullRequest.number > PRE_REVIEW_ENFORCE_AFTER_PR,
    requiredReplacements: lineage?.requiredReplacements,
    replacementPullRequests: lineage?.replacementPullRequests,
  });
  if (result.allowed) return result;

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
  if (!scope.allowed) return { ...scope, state: 'scope_required' };

  const convergence = await enforceReviewConvergence(
    client,
    pullRequest,
    expectedHead,
  );
  if (convergence.superseded) {
    return { ...convergence, state: 'superseded' };
  }
  if (!convergence.allowed) {
    return { ...convergence, state: 'replacement_required' };
  }

  const finding = await guardAgainstCurrentHeadFinding(
    client, pullRequest, expectedHead, null,
  );
  if (finding) {
    return { state: 'changes_required', allowed: false, detail: finding };
  }

  return { state: 'allowed', allowed: true, pullRequest };
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

    const [reviews, comments, reactions] = await Promise.all([
      client.reviews(pullRequest.number),
      client.reviewComments(pullRequest.number),
      client.reactions(pullRequest.number),
    ]);
    const result = classifyCodexState({
      expectedHead,
      readyAt: reviewNotBefore,
      deadline,
      now: new Date().toISOString(),
      reviews,
      comments,
      reactions,
    });
    if (result.state !== 'pending') return result;
    await sleep(POLL_INTERVAL_MS);
  }
}

async function reclassifyCurrentCodexEvidence(
  client,
  number,
  expectedHead,
  reviewNotBefore,
) {
  const [reviews, comments, reactions] = await Promise.all([
    client.reviews(number),
    client.reviewComments(number),
    client.reactions(number),
  ]);
  const now = new Date();
  return classifyCodexState({
    expectedHead,
    readyAt: reviewNotBefore,
    deadline: new Date(now.getTime() + REVIEW_TIMEOUT_MS).toISOString(),
    now: now.toISOString(),
    reviews,
    comments,
    reactions,
  });
}

export async function publishCurrentHeadFinding(
  client,
  pullRequest,
  expectedHead,
  recoveryRequest,
  { detail, attempt },
) {
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

  const live = await setDraftForCurrentHead(
    client,
    pullRequest.number,
    expectedHead,
    true,
  );
  if (!live) return { state: 'superseded', superseded: true };
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
      next: notice.instruction,
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
  const [reviews, comments] = await Promise.all([
    client.reviews(pullRequest.number),
    client.reviewComments(pullRequest.number),
  ]);
  const now = new Date();
  const result = classifyCodexState({
    expectedHead,
    readyAt: new Date(0).toISOString(),
    deadline: new Date(now.getTime() + REVIEW_TIMEOUT_MS).toISOString(),
    now: now.toISOString(),
    reviews,
    comments,
    reactions: [],
  });
  if (result.state !== 'changes_required') return null;

  await publishCurrentHeadFinding(
    client,
    pullRequest,
    expectedHead,
    recoveryRequest,
    { detail: result.detail, attempt: 0 },
  );
  return result.detail;
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

  const scope = await enforceReviewScope(client, pullRequest, expectedHead);
  if (scope.superseded) return;
  if (!scope.allowed) throw new Error(scope.detail);

  if (context.ciConclusion && context.ciConclusion !== 'success') {
    const ciSummary = summarizeRequiredChecks(
      await client.checkRuns(expectedHead),
      requiredChecksForPullRequest(pullRequest.number),
    );
    if (shouldRetryCiFailure(context, existingStatus, ciSummary.failed)) {
      try {
        await client.rerunFailedJobs(context.ciRunId);
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
        return;
      } catch (error) {
        console.warn(
          `Could not request the bounded CI retry; failing closed: ${error.message}`,
        );
      }
    }
    pullRequest = shouldDraftForCiFailure(existingStatus)
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
    if (!pullRequest) return;
    const ciDetail = ciSummary.failed.length > 0
      ? `Failed checks: ${ciSummary.failed.join(', ')}`
      : `CI workflow concluded ${context.ciConclusion}`;
    if (!isTerminalReviewStatus(existingStatus)) {
      await client.setStatus(
        expectedHead,
        'failure',
        `ci: ${ciDetail}`,
        pullRequest.html_url,
      );
    }
    const ciNotice = correctionNotice(pullRequest, {
      detail: ciDetail,
      reason: ciSummary.failed.includes('review-scope') ? 'scope' : 'ci',
    });
    await client.updateStickyComment(
      pullRequest.number,
      statusBody({
        state: 'blocked',
        head: expectedHead,
        detail: ciDetail,
        attempt: 0,
        owner: ciNotice.owner ?? 'undeclared',
        correctionState: noticeState(ciNotice),
          next: ciNotice.instruction,
      }),
    );
    throw new Error(ciDetail);
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
        { detail: result.detail, attempt },
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
            { detail, attempt },
          );
          if (published.superseded) return;
          throw new Error(detail);
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
          `review: ${detail}`,
          pullRequest.html_url,
        );
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
        requiredChecksForPullRequest(pullRequest.number),
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
        throw new Error(`Final review policy changed: ${finalPolicy.state}`);
      }
      pullRequest = finalPolicy.pullRequest;
      // One run polls one Codex invocation to its mutually exclusive terminal
      // result: finding-bearing evidence or the clean reaction. Review webhooks
      // never enter this orchestrator, so no second writer can race admission.
      await client.setStatus(
        expectedHead,
        'success',
        'review: Codex found no blocking issue on this exact head',
        pullRequest.html_url,
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
            : 'GitHub auto-merge is queued behind branch protection.',
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
