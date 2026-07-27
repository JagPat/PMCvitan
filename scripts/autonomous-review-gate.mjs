import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

import {
  CODEX_LOGIN,
  codexThreadIdsToResolve,
  classifyCodexState,
  isEligiblePullRequest,
} from './autonomous-review-state.mjs';

export const REQUIRED_CHECKS = [
  'web',
  'api',
  'e2e',
  'api-e2e',
  'upgrade-proof',
];
export const MAX_REVIEW_ATTEMPTS = 2;

const STATUS_CONTEXT = 'codex-current-head';
const COMMENT_MARKER = '<!-- autonomous-review-state -->';
const API_ROOT = 'https://api.github.com';
const CHECK_TIMEOUT_MS = Number(process.env.CHECK_TIMEOUT_MS ?? 10 * 60_000);
const REVIEW_TIMEOUT_MS = Number(process.env.REVIEW_TIMEOUT_MS ?? 15 * 60_000);
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS ?? 15_000);
const TERMINAL_SETTLE_MS = Number(process.env.TERMINAL_SETTLE_MS ?? 5_000);

export function summarizeRequiredChecks(checkRuns) {
  const missing = [];
  const pending = [];
  const failed = [];

  for (const name of REQUIRED_CHECKS) {
    const runs = checkRuns.filter((run) => run.name === name);
    if (runs.length === 0) {
      missing.push(name);
      continue;
    }
    if (runs.some((run) => run.status !== 'completed')) {
      pending.push(name);
      continue;
    }
    if (runs.some((run) => run.conclusion !== 'success')) {
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

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function requiredEnvironment(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

class GitHubClient {
  constructor({ repository, token }) {
    this.repository = repository;
    this.token = token;
  }

  async request(path, { method = 'GET', body } = {}) {
    const response = await fetch(`${API_ROOT}${path}`, {
      method,
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${this.token}`,
        'Content-Type': 'application/json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    const payload = text ? JSON.parse(text) : null;
    if (!response.ok) {
      throw new Error(
        `GitHub ${method} ${path} failed (${response.status}): ${text}`,
      );
    }
    return payload;
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

  async checkRuns(head) {
    const payload = await this.request(
      `/repos/${this.repository}/commits/${head}/check-runs?filter=latest&per_page=100`,
    );
    return payload.check_runs;
  }

  async latestStatus(head, context) {
    const statuses = await this.request(
      `/repos/${this.repository}/commits/${head}/statuses?per_page=100`,
    );
    return statuses.find((status) => status.context === context) ?? null;
  }

  reviews(number) {
    return this.request(
      `/repos/${this.repository}/pulls/${number}/reviews?per_page=100`,
    );
  }

  reviewComments(number) {
    return this.request(
      `/repos/${this.repository}/pulls/${number}/comments?per_page=100`,
    );
  }

  reactions(number) {
    return this.request(
      `/repos/${this.repository}/issues/${number}/reactions?per_page=100`,
    );
  }

  setStatus(head, state, description, targetUrl) {
    return this.request(`/repos/${this.repository}/statuses/${head}`, {
      method: 'POST',
      body: {
        state,
        context: STATUS_CONTEXT,
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

  async enableAutoMerge(pullRequest) {
    if (pullRequest.auto_merge) return;
    await this.graphql(
      `mutation($id: ID!) {
        enablePullRequestAutoMerge(
          input: { pullRequestId: $id, mergeMethod: SQUASH }
        ) {
          pullRequest { id autoMergeRequest { enabledAt } }
        }
      }`,
      { id: pullRequest.node_id },
    );
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

async function ensureTerminalReviewState(
  client,
  pullRequest,
  expectedHead,
  status,
) {
  if (!isTerminalReviewStatus(status)) return false;
  if (status.state === 'success') {
    const live = await refreshCurrentHead(
      client,
      pullRequest.number,
      expectedHead,
    );
    if (live) await client.enableAutoMerge(live);
  } else {
    await setDraftForCurrentHead(
      client,
      pullRequest.number,
      expectedHead,
      true,
    );
  }
  return true;
}

async function handleCodexEvidence(
  client,
  pullRequest,
  expectedHead,
  detail,
) {
  const live = await refreshCurrentHead(
    client,
    pullRequest.number,
    expectedHead,
  );
  if (!live) return;

  // Fail branch protection before any best-effort presentation mutation.
  await client.setStatus(
    expectedHead,
    'failure',
    `review: ${detail}`,
    live.html_url,
  );
  const draft = await setDraftForCurrentHead(
    client,
    pullRequest.number,
    expectedHead,
    true,
  );
  if (!draft) return;
  await client.updateStickyComment(
    pullRequest.number,
    statusBody({
      state: 'changes_required',
      head: expectedHead,
      detail,
      attempt: 0,
      next: 'Claude Auto-fix handles the review evidence and pushes a new head.',
    }),
  );
}

async function waitForRequiredChecks(client, pullRequest, expectedHead) {
  const deadline = Date.now() + CHECK_TIMEOUT_MS;
  while (true) {
    const live = await client.pullRequest(pullRequest.number);
    if (live.head.sha !== expectedHead) return { state: 'superseded' };

    const summary = summarizeRequiredChecks(await client.checkRuns(expectedHead));
    if (summary.state !== 'pending' || Date.now() > deadline) return summary;
    await sleep(POLL_INTERVAL_MS);
  }
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

export function contextForEvent(eventName, event, dispatchNumber) {
  if (eventName === 'workflow_dispatch') {
    return {
      number: Number(dispatchNumber ?? event.inputs?.pr_number),
      expectedHead: null,
      ciConclusion: null,
      trigger: 'dispatch',
    };
  }
  if (eventName === 'workflow_run' && event.workflow_run?.event === 'pull_request') {
    return {
      number: Number(event.workflow_run.pull_requests?.[0]?.number),
      expectedHead: event.workflow_run.head_sha,
      ciConclusion: event.workflow_run.conclusion,
      trigger: 'ci',
    };
  }
  if (eventName === 'pull_request_review' && event.action === 'submitted') {
    const expectedHead = event.pull_request?.head?.sha;
    if (
      event.review?.user?.login !== CODEX_LOGIN
      || event.review?.commit_id !== expectedHead
    ) return null;
    return {
      number: Number(event.pull_request?.number),
      expectedHead,
      trigger: 'evidence',
      evidenceDetail: 'Codex submitted a current-head review',
    };
  }
  if (
    eventName === 'pull_request_review_comment'
    && event.action === 'created'
  ) {
    const expectedHead = event.pull_request?.head?.sha;
    const postedHead = event.comment?.original_commit_id
      ?? event.comment?.commit_id;
    if (
      event.comment?.user?.login !== CODEX_LOGIN
      || postedHead !== expectedHead
    ) return null;
    return {
      number: Number(event.pull_request?.number),
      expectedHead,
      trigger: 'evidence',
      evidenceDetail: 'Codex submitted a current-head finding',
    };
  }
  return null;
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
  if (pullRequest.head.sha !== expectedHead) {
    console.log('Workflow event was superseded by a newer pull-request head.');
    return;
  }

  if (context.trigger === 'evidence') {
    await handleCodexEvidence(
      client,
      pullRequest,
      expectedHead,
      context.evidenceDetail,
    );
    return;
  }

  const existingStatus = context.trigger === 'ci'
    ? await client.latestStatus(
        expectedHead,
        STATUS_CONTEXT,
      )
    : null;

  if (context.ciConclusion && context.ciConclusion !== 'success') {
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
    if (!isTerminalReviewStatus(existingStatus)) {
      await client.setStatus(
        expectedHead,
        'failure',
        `ci: workflow concluded ${context.ciConclusion}`,
        pullRequest.html_url,
      );
    }
    await client.updateStickyComment(
      pullRequest.number,
      statusBody({
        state: 'blocked',
        head: expectedHead,
        detail: `CI workflow concluded ${context.ciConclusion}`,
        attempt: 0,
        next: 'Claude Auto-fix addresses CI before review begins.',
      }),
    );
    throw new Error(`CI workflow concluded ${context.ciConclusion}`);
  }

  if (context.trigger === 'ci') {
    if (
      await ensureTerminalReviewState(
        client,
        pullRequest,
        expectedHead,
        existingStatus,
      )
    ) {
      console.log(
        'Exact head already has a terminal Codex state; CI rerun will not request review.',
      );
      return;
    }
  }

  await client.setStatus(
    expectedHead,
    'pending',
    'Waiting for required CI and current-head Codex review',
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
      const finalResult = await reclassifyCurrentCodexEvidence(
        client,
        pullRequest.number,
        expectedHead,
        reviewNotBefore,
      );
      const finalStatus = await client.latestStatus(
        expectedHead,
        STATUS_CONTEXT,
      );
      const concurrentReviewFailure = finalStatus?.state === 'failure'
        && isTerminalReviewStatus(finalStatus);
      if (finalResult.state !== 'clear' || concurrentReviewFailure) {
        const detail = finalResult.state === 'changes_required'
          ? finalResult.detail
          : concurrentReviewFailure
            ? finalStatus.description
            : 'Codex evidence changed during terminal publication';
        await client.setStatus(
          expectedHead,
          'failure',
          `review: ${detail}`,
          pullRequest.html_url,
        );
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
            state: 'changes_required',
            head: expectedHead,
            detail,
            attempt,
            next: 'Claude Auto-fix handles the terminal review evidence and pushes a new head.',
          }),
        );
        throw new Error(detail);
      }
      await client.setStatus(
        expectedHead,
        'success',
        'review: Codex found no blocking issue on this exact head',
        pullRequest.html_url,
      );

      // All events for this PR share one workflow concurrency lane. Keep
      // auto-merge disabled while late review delivery settles, then verify
      // exact-head evidence once more before making the head mergeable.
      await sleep(TERMINAL_SETTLE_MS);
      const settledResult = await reclassifyCurrentCodexEvidence(
        client,
        pullRequest.number,
        expectedHead,
        reviewNotBefore,
      );
      const settledStatus = await client.latestStatus(
        expectedHead,
        STATUS_CONTEXT,
      );
      const settledReviewFailure = settledStatus?.state === 'failure'
        && isTerminalReviewStatus(settledStatus);
      if (settledResult.state !== 'clear' || settledReviewFailure) {
        const detail = settledResult.state === 'changes_required'
          ? settledResult.detail
          : settledReviewFailure
            ? settledStatus.description
            : 'Codex evidence changed during terminal settlement';
        await client.setStatus(
          expectedHead,
          'failure',
          `review: ${detail}`,
          pullRequest.html_url,
        );
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
            state: 'changes_required',
            head: expectedHead,
            detail,
            attempt,
            next: 'Claude Auto-fix handles the settled review evidence and pushes a new head.',
          }),
        );
        throw new Error(detail);
      }

      pullRequest = await refreshCurrentHead(
        client,
        pullRequest.number,
        expectedHead,
      );
      if (!pullRequest) return;
      await client.enableAutoMerge(pullRequest);
      await client.updateStickyComment(
        pullRequest.number,
        statusBody({
          state: 'clear',
          head: expectedHead,
          detail: `${result.detail}; resolved ${resolvedThreadCount} verified Codex thread${resolvedThreadCount === 1 ? '' : 's'}`,
          attempt,
          next: 'GitHub auto-merge is queued behind branch protection.',
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
