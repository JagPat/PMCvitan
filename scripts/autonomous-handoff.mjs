export { isAutonomousPullRequest } from './runner-continuation.mjs';

import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

import {
  buildDriftHandoff,
  buildPostMergeContinuation,
  isAutonomousPullRequest,
  selectAutonomousOpenPullRequests,
} from './runner-continuation.mjs';
import { loadStatusDocument, parseStatusNow } from './autonomous-status-state.mjs';

const API_ROOT = 'https://api.github.com';
const CONFLICT_MARKER = '<!-- autonomous-conflict:';
const MERGE_MARKER = '<!-- autonomous-post-merge:';
const DRIFT_MARKER = '<!-- autonomous-status-drift:';
const STATE_ISSUE_NUMBER = 235;
const ACTIONS_BOT_LOGIN = 'github-actions[bot]';
// The backlog starts after this workflow was introduced, so historical Claude
// merges cannot accidentally start competing continuation runners.
const HANDOFF_ENABLED_AT = Date.parse('2026-07-27T14:53:00Z');
const MERGEABILITY_TIMEOUT_MS = Number(
  process.env.MERGEABILITY_TIMEOUT_MS ?? 30_000,
);
const MERGEABILITY_POLL_MS = Number(
  process.env.MERGEABILITY_POLL_MS ?? 5_000,
);
const TERMINAL_WAIT_MS = Number(process.env.TERMINAL_WAIT_MS ?? 420_000);
const TERMINAL_POLL_MS = Number(process.env.TERMINAL_POLL_MS ?? 5_000);

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
    if (!response.ok) {
      throw new Error(`GitHub ${method} ${path} failed (${response.status}): ${text}`);
    }
    return text ? JSON.parse(text) : null;
  }

  pullRequest(number) {
    return this.request(`/repos/${this.repository}/pulls/${number}`);
  }

  async openPullRequests() {
    const pullRequests = [];
    for (let page = 1; ; page += 1) {
      const batch = await this.request(
        `/repos/${this.repository}/pulls?state=open&per_page=100&page=${page}`,
      );
      pullRequests.push(...batch);
      if (batch.length < 100) return pullRequests;
    }
  }

  async mergedPullRequestsAfter(cursor) {
    const pullRequests = [];
    for (let page = 1; ; page += 1) {
      const batch = await this.request(
        `/repos/${this.repository}/pulls?state=closed&sort=updated&direction=desc&per_page=100&page=${page}`,
      );
      for (const pullRequest of batch) {
        if (Date.parse(pullRequest.updated_at) < cursor.mergedAt) {
          return pullRequests;
        }
        if (
          pullRequest.merged_at &&
          Date.parse(pullRequest.merged_at) >= cursor.mergedAt
        ) {
          pullRequests.push(pullRequest);
        }
      }
      if (batch.length < 100) return pullRequests;
    }
  }

  async runnerCursor() {
    const issue = await this.request(
      `/repos/${this.repository}/issues/${STATE_ISSUE_NUMBER}`,
    );
    const match = issue.body?.match(
      /Last processed merge: `([^`]+)` \(#(\d+)\)/,
    );
    if (!match) return { mergedAt: HANDOFF_ENABLED_AT, number: 0 };
    return { mergedAt: Date.parse(match[1]), number: Number(match[2]) };
  }

  setRunnerCursor(mergedAt, number) {
    return this.request(
      `/repos/${this.repository}/issues/${STATE_ISSUE_NUMBER}`,
      {
        method: 'PATCH',
        body: {
          body: [
            '<!-- autonomous-runner-state -->',
            'This issue stores the durable cursor for the repository automation. GitHub Actions maintains it; do not close or edit it manually.',
            '',
            `Last processed merge: \`${mergedAt}\` (#${number})`,
          ].join('\n'),
        },
      },
    );
  }

  dispatchRetry(defaultBranch, waitForPullRequest = null) {
    return this.request(
      `/repos/${this.repository}/actions/workflows/autonomous-handoff.yml/dispatches`,
      {
        method: 'POST',
        body: {
          ref: defaultBranch,
          ...(waitForPullRequest
            ? { inputs: { wait_for_pr: String(waitForPullRequest) } }
            : {}),
        },
      },
    );
  }

  combinedStatus(head) {
    return this.request(`/repos/${this.repository}/commits/${head}/status`);
  }

  async comments(number) {
    const comments = [];
    for (let page = 1; ; page += 1) {
      const batch = await this.request(
        `/repos/${this.repository}/issues/${number}/comments?per_page=100&page=${page}`,
      );
      comments.push(...batch);
      if (batch.length < 100) return comments;
    }
  }

  comment(number, body) {
    return this.request(`/repos/${this.repository}/issues/${number}/comments`, {
      method: 'POST',
      body: { body },
    });
  }

  async fileContent(path, ref) {
    const payload = await this.request(
      `/repos/${this.repository}/contents/${path}?ref=${encodeURIComponent(ref)}`,
    );
    if (!payload?.content) return null;
    return Buffer.from(payload.content, payload.encoding ?? 'base64').toString('utf8');
  }
}

async function refreshedMergeability(client, pullRequest) {
  const deadline = Date.now() + MERGEABILITY_TIMEOUT_MS;
  let live = await client.pullRequest(pullRequest.number);
  while (live.mergeable === null && Date.now() < deadline) {
    await sleep(MERGEABILITY_POLL_MS);
    live = await client.pullRequest(pullRequest.number);
  }
  if (live.mergeable === null) {
    throw new Error(
      `GitHub did not compute mergeability for PR #${pullRequest.number} before the deadline`,
    );
  }
  return live;
}

export async function waitForTerminalPullRequest(client, number) {
  const deadline = Date.now() + TERMINAL_WAIT_MS;
  let pullRequest = await client.pullRequest(number);
  while (pullRequest.state === 'open' && Date.now() < deadline) {
    await sleep(TERMINAL_POLL_MS);
    pullRequest = await client.pullRequest(number);
  }
  return pullRequest.state === 'open' ? null : pullRequest;
}

async function handOffConflict(
  client,
  pullRequest,
  repository,
  defaultBranch,
) {
  if (!isAutonomousPullRequest(pullRequest, repository, defaultBranch)) return;
  const live = await refreshedMergeability(client, pullRequest);
  if (live.mergeable !== false && live.mergeable_state !== 'behind') return;

  const marker = `${CONFLICT_MARKER}${live.head.sha} -->`;
  const comments = await client.comments(live.number);
  if (comments.some((comment) =>
    comment.user?.login === ACTIONS_BOT_LOGIN && comment.body?.includes(marker)
  )) return;

  await client.comment(
    live.number,
    [
      marker,
      '@claude This autonomous PR is behind or conflicts with the current `main` branch.',
      '',
      'Merge `origin/main` into this PR branch without rebasing or force-pushing. Resolve the conflicts according to `AGENTS.md`, run the complete documented validation suite, and push the resolution normally. Keep the PR in draft until CI and the exact-head Codex review are clean.',
    ].join('\n'),
  );
}

async function authoritativeStatusForDrift(client, defaultBranchStatus, openPullRequests) {
  if (!openPullRequests?.length) return defaultBranchStatus;
  const primary = openPullRequests[openPullRequests.length - 1];
  const headRef = primary?.head?.sha;
  if (!headRef) return defaultBranchStatus;
  try {
    const markdown = await client.fileContent('docs/STATUS.md', headRef);
    const headNow = parseStatusNow(markdown ?? '');
    if (headNow) return headNow;
  } catch (error) {
    console.warn(
      `Could not read STATUS from PR #${primary.number} head: ${error.message}`,
    );
  }
  return defaultBranchStatus;
}

async function loadContinuationContext(client, repository, defaultBranch) {
  const [{ now, maintenanceQueue }, openPullRequests] = await Promise.all([
    loadStatusDocument(),
    client.openPullRequests().then((pullRequests) =>
      selectAutonomousOpenPullRequests(pullRequests, repository, defaultBranch),
    ),
  ]);
  const authoritativeNow = await authoritativeStatusForDrift(
    client,
    now,
    openPullRequests,
  );
  return { now: authoritativeNow, maintenanceQueue, openPullRequests };
}

async function handOffMergedPullRequest(
  client,
  pullRequest,
  repository,
  defaultBranch,
  continuationContext,
) {
  if (
    !pullRequest?.merged ||
    pullRequest?.head?.repo?.full_name !== repository ||
    pullRequest?.base?.repo?.full_name !== repository ||
    pullRequest?.base?.ref !== defaultBranch ||
    !pullRequest?.head?.ref?.startsWith('claude/')
  ) return;

  const combinedStatus = await client.combinedStatus(pullRequest.head.sha);
  const exactHeadStatus = combinedStatus.statuses?.find(
    (status) => status.context === 'codex-current-head',
  );
  if (exactHeadStatus?.state !== 'success') {
    console.warn(
      `Skipping continuation for PR #${pullRequest.number}: exact-head Codex status was not successful`,
    );
    return;
  }

  const marker = `${MERGE_MARKER}${pullRequest.merge_commit_sha} -->`;
  const comments = await client.comments(pullRequest.number);
  if (comments.some((comment) =>
    comment.user?.login === ACTIONS_BOT_LOGIN && comment.body?.includes(marker)
  )) return;

  const { now, maintenanceQueue, openPullRequests } = continuationContext;
  await client.comment(
    pullRequest.number,
    [
      marker,
      buildPostMergeContinuation({
        statusNow: now,
        maintenanceQueue,
        openPullRequests,
      }),
    ].join('\n'),
  );
}

async function handOffStatusDrift(
  client,
  repository,
  defaultBranch,
  continuationContext,
) {
  const { now, maintenanceQueue, openPullRequests } = continuationContext;
  const body = buildDriftHandoff({
    statusNow: now,
    maintenanceQueue,
    openPullRequests,
  });
  if (!body) return;

  const primary = openPullRequests.at(-1);
  if (!primary) {
    const marker = `${DRIFT_MARKER}status-only:`;
    const comments = await client.comments(STATE_ISSUE_NUMBER);
    if (comments.some((comment) =>
      comment.user?.login === ACTIONS_BOT_LOGIN && comment.body?.includes(marker)
    )) return;
    await client.comment(STATE_ISSUE_NUMBER, [marker, body].join('\n'));
    return;
  }

  const marker = `${DRIFT_MARKER}${primary.head.sha} -->`;
  const comments = await client.comments(primary.number);
  if (comments.some((comment) =>
    comment.user?.login === ACTIONS_BOT_LOGIN && comment.body?.includes(marker)
  )) return;

  await client.comment(primary.number, [marker, body].join('\n'));
}

export async function run() {
  const eventName = requiredEnvironment('GITHUB_EVENT_NAME');
  const event = JSON.parse(
    await readFile(requiredEnvironment('GITHUB_EVENT_PATH'), 'utf8'),
  );
  const repository = requiredEnvironment('GITHUB_REPOSITORY');
  const defaultBranch = event.repository?.default_branch;
  if (!defaultBranch) throw new Error('Event repository default branch is required');
  const client = new GitHubClient({
    repository,
    token: requiredEnvironment('GITHUB_TOKEN'),
  });

  const waitForPullRequest = Number(event.inputs?.wait_for_pr ?? 0);
  let retryWaitForPullRequest = null;
  if (waitForPullRequest > 0) {
    const terminal = await waitForTerminalPullRequest(
      client,
      waitForPullRequest,
    );
    if (!terminal) retryWaitForPullRequest = waitForPullRequest;
  }

  // Drain the durable merge backlog on every surviving event. GitHub may replace
  // a pending concurrency run, so correctness cannot depend on one closed event.
  const continuationContext = await loadContinuationContext(
    client,
    repository,
    defaultBranch,
  );

  const cursor = await client.runnerCursor();
  const mergedBacklog = await client.mergedPullRequestsAfter(cursor);
  mergedBacklog.sort((left, right) =>
    Date.parse(left.merged_at) - Date.parse(right.merged_at) ||
    left.number - right.number
  );
  for (const mergedPullRequest of mergedBacklog) {
    const liveMergedPullRequest = await client.pullRequest(
      mergedPullRequest.number,
    );
    await handOffMergedPullRequest(
      client,
      liveMergedPullRequest,
      repository,
      defaultBranch,
      continuationContext,
    );
    await client.setRunnerCursor(
      mergedPullRequest.merged_at,
      mergedPullRequest.number,
    );
  }

  if (eventName === 'schedule') {
    await handOffStatusDrift(
      client,
      repository,
      defaultBranch,
      continuationContext,
    );
  }

  // Every event also drains open conflict state. A pending Actions run may be
  // replaced within the global group, so no event-specific path is essential.
  let retryNeeded = false;
  for (const pullRequest of await client.openPullRequests()) {
    try {
      await handOffConflict(client, pullRequest, repository, defaultBranch);
    } catch (error) {
      if (!String(error?.message).includes('did not compute mergeability')) throw error;
      retryNeeded = true;
      console.warn(error.message);
    }
  }
  if (retryWaitForPullRequest || retryNeeded) {
    await client.dispatchRetry(defaultBranch, retryWaitForPullRequest);
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;
if (invokedPath === import.meta.url) {
  run().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
