import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

import {
  codexThreadIdsToResolve,
  classifyCodexState,
  isEligiblePullRequest,
} from './autonomous-review-state.mjs';
import {
  assessConvergence,
  assessReviewScope,
  REVIEW_SCOPE_ENFORCE_AFTER_PR,
} from './review-efficiency.mjs';

export const REQUIRED_CHECKS = [
  'review-scope',
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
const CHECK_TIMEOUT_MS = Number(process.env.CHECK_TIMEOUT_MS ?? 10 * 60_000);
const REVIEW_TIMEOUT_MS = Number(process.env.REVIEW_TIMEOUT_MS ?? 15 * 60_000);
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS ?? 15_000);

export function requiredChecksForPullRequest(pullRequestNumber) {
  if (
    Number.isInteger(pullRequestNumber)
    && pullRequestNumber > 0
    && pullRequestNumber <= REVIEW_SCOPE_ENFORCE_AFTER_PR
  ) {
    return REQUIRED_CHECKS.filter((name) => name !== 'review-scope');
  }
  return REQUIRED_CHECKS;
}

function newerRunFirst(a, b) {
  const aStarted = typeof a.started_at === 'string' ? a.started_at : '';
  const bStarted = typeof b.started_at === 'string' ? b.started_at : '';
  if (aStarted !== bStarted) return aStarted > bStarted ? -1 : 1;
  return (Number(b.id) || 0) - (Number(a.id) || 0);
}

export function summarizeRequiredChecks(checkRuns, requiredChecks = REQUIRED_CHECKS) {
  const missing = [];
  const pending = [];
  const failed = [];

  for (const name of requiredChecks) {
    const runs = checkRuns.filter((run) => run.name === name);
    if (runs.length === 0) {
      missing.push(name);
      continue;
    }
    if (runs.some((run) => run.status !== 'completed')) {
      pending.push(name);
      continue;
    }
    // One SHA can carry several completed runs of the same check: an `edited`
    // re-run of the scope check, or product jobs the battery plan skipped.
    // The newest REAL execution decides; a skipped run defers to the evidence
    // it deliberately kept, and a name with only skipped runs never really ran.
    const decider = [...runs]
      .sort(newerRunFirst)
      .find((run) => run.conclusion !== 'skipped');
    if (!decider) {
      missing.push(name);
      continue;
    }
    if (decider.conclusion !== 'success') {
      failed.push(name);
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
  const description = status.description ?? '';
  return description.includes('Codex review timed out')
    || description.includes('Codex evidence changed during final verification')
    || description === 'review: Required CI changed during current-head Codex review'
    || description === 'review: bootstrap exact-head review requested';
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
    const payload = await this.request(
      `/repos/${this.repository}/commits/${head}/check-runs?filter=latest&per_page=100`,
    );
    return payload.check_runs;
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
    headRepository: { nameWithOwner: pullRequest.head.repo?.full_name },
    baseRepository: { nameWithOwner: pullRequest.base.repo?.full_name },
  };
}

function statusBody({ state, head, detail, attempt, next }) {
  return [
    '## Autonomous review state',
    '',
    `- **Head:** \`${head}\``,
    `- **State:** \`${state}\``,
    `- **Codex attempt:** ${attempt}/${MAX_REVIEW_ATTEMPTS}`,
    `- **Detail:** ${detail}`,
    `- **Next:** ${next}`,
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
  const preliminary = assessConvergence({
    comments,
    reviews,
    headMessage: '',
    changedFiles: [],
  });
  if (!preliminary.required) return preliminary;

  const commit = await client.commit(expectedHead);
  const result = assessConvergence({
    comments,
    reviews,
    headMessage: commit.commit?.message,
    changedFiles: commit.files ?? [],
  });
  if (result.allowed) return result;

  const live = await setDraftForCurrentHead(
    client,
    pullRequest.number,
    expectedHead,
    true,
  );
  if (!live) return { ...result, superseded: true };
  const detail = `${result.findingHeadCount} finding heads require convergence evidence; missing ${result.missing.join(' and ')}`;
  await client.setStatus(
    expectedHead,
    'failure',
    `review: ${detail}`,
    pullRequest.html_url,
  );
  await client.updateStickyComment(
    pullRequest.number,
    statusBody({
      state: 'convergence_required',
      head: expectedHead,
      detail,
      attempt: 0,
      next: `Claude must batch every open finding into one architectural audit, add docs/reviews/pr-${pullRequest.number}-convergence.md, and push a head whose commit includes Review-Convergence: complete.`,
    }),
  );
  return result;
}

export async function enforceReviewScope(client, pullRequest, expectedHead) {
  const result = assessReviewScope(pullRequest);
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
  await client.updateStickyComment(
    pullRequest.number,
    statusBody({
      state: 'scope_required',
      head: expectedHead,
      detail: result.detail,
      attempt: 0,
      next: 'Claude splits the review unit or completes every justified-large invariant row with concrete risk and verification evidence.',
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
    return { ...convergence, state: 'convergence_required' };
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

  const live = await setDraftForCurrentHead(
    client,
    pullRequest.number,
    expectedHead,
    true,
  );
  if (!live) return result.detail;
  await client.setStatus(
    expectedHead,
    'failure',
    `review: ${result.detail}`,
    pullRequest.html_url,
  );
  await settleRecoveryRequest(
    client,
    expectedHead,
    pullRequest,
    recoveryRequest,
    'current-head finding observed before recovery',
  );
  await client.updateStickyComment(
    pullRequest.number,
    statusBody({
      state: 'changes_required',
      head: expectedHead,
      detail: result.detail,
      attempt: 0,
      next: 'Claude Auto-fix handles the review comments and pushes a new head.',
    }),
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
    await client.updateStickyComment(
      pullRequest.number,
      statusBody({
        state: 'blocked',
        head: expectedHead,
        detail: ciDetail,
        attempt: 0,
        next: ciSummary.failed.includes('review-scope')
          ? 'Claude splits the review unit or completes the justified-large invariant matrix; editing the PR body reruns the scope gate.'
          : 'Claude Auto-fix addresses CI before review begins.',
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
    await client.updateStickyComment(
      pullRequest.number,
      statusBody({
        state: 'blocked',
        head: expectedHead,
        detail,
        attempt: 0,
        next: 'Claude Auto-fix addresses CI; a new head restarts the loop.',
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
      `${convergence.findingHeadCount} finding heads require a consolidated convergence audit`,
    );
  }

  const reviewNotBefore = new Date(Date.now() - 1_000).toISOString();
  for (let attempt = 1; attempt <= MAX_REVIEW_ATTEMPTS; attempt += 1) {
    const result = await reviewAttempt(
      client,
      pullRequest,
      expectedHead,
      attempt,
      reviewNotBefore,
    );
    if (result.state === 'superseded') return;

    if (result.state === 'changes_required') {
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
        `review: ${result.detail}`,
        pullRequest.html_url,
      );
      await settleRecoveryRequest(
        client,
        expectedHead,
        pullRequest,
        recoveryRequest,
        'review finding',
      );
      await client.updateStickyComment(
        pullRequest.number,
        statusBody({
          state: 'changes_required',
          head: expectedHead,
          detail: result.detail,
          attempt,
          next: 'Claude Auto-fix handles the review comments and pushes a new head.',
        }),
      );
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
        pullRequest = await setDraftForCurrentHead(
          client,
          pullRequest.number,
          expectedHead,
          true,
        );
        if (!pullRequest) return;
        const detail = verifiedResult.state === 'changes_required'
          ? verifiedResult.detail
          : 'Codex evidence changed during final verification';
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
        await client.updateStickyComment(
          pullRequest.number,
          statusBody({
            state: 'changes_required',
            head: expectedHead,
            detail,
            attempt,
            next: 'Claude Auto-fix handles the latest review evidence and pushes a new head.',
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
