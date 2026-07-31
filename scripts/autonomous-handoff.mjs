export { isAutonomousPullRequest } from './runner-continuation.mjs';

import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

import {
  buildDriftHandoff,
  buildPostMergeContinuation,
  isAutonomousPullRequest,
  selectAutonomousOpenPullRequests,
} from './runner-continuation.mjs';
import { loadStatusDocument, parseStatusNow, parseMaintenanceQueue } from './autonomous-status-state.mjs';
import {
  STATE_ISSUE_NUMBER,
  assessLease,
  readCursor,
  readLease,
  releaseOnMerge,
  renderRunnerState,
  startInstruction,
} from './autonomous-work-lease.mjs';

const API_ROOT = 'https://api.github.com';
const CONFLICT_MARKER = '<!-- autonomous-conflict:';
const MERGE_MARKER = '<!-- autonomous-post-merge:';
const DRIFT_MARKER = '<!-- autonomous-status-drift:';
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

  // The WHOLE runner state, read together. The cursor and the lease live in one
  // issue body and are read in one request, so no caller can hold a fresh
  // cursor beside a stale lease.
  async runnerState() {
    const issue = await this.request(
      `/repos/${this.repository}/issues/${STATE_ISSUE_NUMBER}`,
    );
    return {
      cursor: readCursor(issue.body, HANDOFF_ENABLED_AT),
      lease: readLease(issue.body),
    };
  }

  async runnerCursor() {
    return (await this.runnerState()).cursor;
  }

  // Writes the WHOLE state. There is deliberately no cursor-only or lease-only
  // writer: this body has two concerns, and a partial writer would eventually
  // drop the block it does not know about. Callers advance one field of the
  // state they already read, and hand the state back.
  setRunnerState(state) {
    return this.request(
      `/repos/${this.repository}/issues/${STATE_ISSUE_NUMBER}`,
      { method: 'PATCH', body: { body: renderRunnerState(state) } },
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

// Read every open autonomous PR head's STATUS. These are the in-flight
// corrections: the default branch legitimately lags a draft PR that already set
// `open_pr` in its own head, and that lag must not be reported as drift. A head
// whose STATUS is unreadable or unparsable contributes `now: null` and simply
// cannot suppress anything.
async function openHeadStatuses(client, openPullRequests) {
  return Promise.all(
    (openPullRequests ?? []).map(async (pullRequest) => {
      const headSha = pullRequest?.head?.sha;
      if (!headSha) return { number: pullRequest?.number ?? null, now: null };
      try {
        const markdown = await client.fileContent('docs/STATUS.md', headSha);
        return {
          number: pullRequest.number,
          now: parseStatusNow(markdown ?? ''),
        };
      } catch (error) {
        console.warn(
          `Could not read STATUS from PR #${pullRequest.number} head: ${error.message}`,
        );
        return { number: pullRequest.number, now: null };
      }
    }),
  );
}

// Two questions, two authorities. The post-merge handoff asks "given the STATUS
// that merged into the default branch, what is next?" — only the default branch
// answers that. Drift asks "does the default branch disagree with live GitHub
// state, uncorrected?" — that needs the open heads too. Collapsing them onto one
// value made an unrelated branch's stale STATUS decide the post-merge next step.
export async function loadContinuationContext(
  client,
  repository,
  defaultBranch,
  { loadStatus = loadStatusDocument } = {},
) {
  const [{ now, maintenanceQueue }, openPullRequests, runnerState] = await Promise.all([
    loadStatus(),
    client.openPullRequests().then((pullRequests) =>
      selectAutonomousOpenPullRequests(pullRequests, repository, defaultBranch),
    ),
    client.runnerState(),
  ]);
  const headStatuses = await openHeadStatuses(client, openPullRequests);
  const context = {
    defaultBranchNow: now,
    maintenanceQueue,
    openPullRequests,
    headStatuses,
    runnerState,
    // ONE accessor, and no bare pre-computed verdict beside it. The first
    // version carried a single verdict assessed with an EMPTY intent, so a
    // handoff shepherding the lease's own pull request was told it was blocked
    // by itself. Each consumer now states who it is; nothing can read a verdict
    // without saying what it wants to do.
    leaseFor: (intent = {}) => assessLease({
      lease: context.runnerState.lease,
      intent,
      openPullRequests,
    }),
    // Persist a claim and keep the in-run copy in step. Reading through
    // `context.runnerState` above means a SECOND backlog drain in the same run
    // sees the lease the first one took — two merged PRs draining from one free
    // state was how two units could both be started in good faith.
    async acquire(lease) {
      context.runnerState = { ...context.runnerState, lease };
      await client.setRunnerState(context.runnerState);
    },
  };
  return context;
}

// STATUS as it exists at one commit, or null when it cannot be read or parsed.
// Null is a signal to fall back, never a silent empty state.
export async function statusAtCommit(client, ref) {
  if (!ref) return null;
  try {
    const markdown = await client.fileContent('docs/STATUS.md', ref);
    return parseStatusNow(markdown ?? '');
  } catch (error) {
    console.warn(`Could not read STATUS at ${ref}: ${error.message}`);
    return null;
  }
}

// Maintenance queue as it exists at one commit. Mirrors statusAtCommit so the
// post-merge continuation reads both STATUS fields from the same merge tree
// instead of leaving the queue on the pre-merge checkout while statusNow moves.
export async function maintenanceQueueAtCommit(client, ref) {
  if (!ref) return null;
  try {
    const markdown = await client.fileContent('docs/STATUS.md', ref);
    return parseMaintenanceQueue(markdown ?? '');
  } catch (error) {
    console.warn(`Could not read maintenance queue at ${ref}: ${error.message}`);
    return null;
  }
}

// Exported so the lease lifecycle can be driven directly in tests, the same way
// `handOffStatusDrift` already is. The acquire-before-publish ordering and the
// release-on-merge rule are behaviour, and behaviour that only `run()` can reach
// is behaviour a probe can only assert structurally.
export async function handOffMergedPullRequest(
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

  const { defaultBranchNow, maintenanceQueue, openPullRequests, headStatuses } =
    continuationContext;
  // STATUS as of THIS merge, not as of the run's checkout.
  //
  // `loadContinuationContext` reads the workflow's own checkout, which is taken
  // when the run starts. On the queued auto-merge path the run enables
  // auto-merge and only later observes the merge, so that copy predates it: a PR
  // that merged `open_pr: 252 / in_review` into `merged / next_task: …` would be
  // handed a continuation derived from the state it just replaced. The merge
  // commit is the exact post-merge tree for this PR, so read STATUS there.
  const mergedNow = await statusAtCommit(client, pullRequest.merge_commit_sha)
    ?? defaultBranchNow;
  const mergedMaintenanceQueue =
    (await maintenanceQueueAtCommit(client, pullRequest.merge_commit_sha)) ??
    maintenanceQueue;

  // A post-merge continuation may tell the runner to START the next unit, so it
  // is subject to the lease like any other start. The claim is keyed to this
  // merge commit: deterministic, traceable, and identical if the same merge is
  // processed twice.
  const start = startInstruction({
    verdict: continuationContext.leaseFor({}),
    claimId: `merge-${String(pullRequest.merge_commit_sha).slice(0, 12)}`,
  });
  // Acquire BEFORE publishing. A failed comment then leaves the lease held,
  // which blocks and is recoverable; publishing first and failing to record
  // would leave it free, which duplicates and is not.
  if (start.permitted) await continuationContext.acquire(start.acquire);

  await client.comment(
    pullRequest.number,
    [
      marker,
      buildPostMergeContinuation({
        statusNow: mergedNow,
        maintenanceQueue: mergedMaintenanceQueue,
        openPullRequests,
        headStatuses,
        start,
      }),
    ].join('\n'),
  );
}

export async function handOffStatusDrift(
  client,
  repository,
  defaultBranch,
  continuationContext,
) {
  const { defaultBranchNow, maintenanceQueue, openPullRequests, headStatuses } =
    continuationContext;

  // The drift handoff is posted TO the primary open pull request when there is
  // one, so that pull request is the unit it is asking about — not an anonymous
  // request to start something new. Naming it is what lets the lease holder
  // shepherd its own work instead of being told it is blocked by itself.
  const primary = openPullRequests.at(-1);
  const staleOpenPr = String(defaultBranchNow?.open_pr ?? 'none').trim() || 'none';
  const start = startInstruction({
    verdict: continuationContext.leaseFor(primary ? { pr: primary.number } : {}),
    claimId: `drift-${staleOpenPr}`,
  });

  const body = buildDriftHandoff({
    statusNow: defaultBranchNow,
    maintenanceQueue,
    openPullRequests,
    headStatuses,
    start,
  });
  if (!body) return;

  // Only the no-open-PR branch can issue a start, and only then is a claim owed.
  // With a live pull request the instruction is to shepherd it, which is the
  // lease being used rather than taken.
  if (!primary && start.permitted) await continuationContext.acquire(start.acquire);

  if (!primary) {
    // Key the marker to the drifting state. A constant marker made this recovery
    // one-shot for the repository's lifetime: once posted, every LATER drift with
    // no live PR was silently swallowed and the loop stayed pointed at stale work.
    const marker = `${DRIFT_MARKER}status-only:${staleOpenPr} -->`;
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

  // The cursor comes from the run's ONE state copy — the same object the loop
  // below advances and the handoffs may claim a lease on. A second independent
  // read here would let a claim taken during this run be written back over.
  const mergedBacklog = await client.mergedPullRequestsAfter(
    continuationContext.runnerState.cursor,
  );
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
    // Advance the cursor WITHIN the run's live state, so the lease recorded
    // beside it — including any claim the handoff above just took — is carried
    // forward rather than overwritten by a stale copy.
    const state = continuationContext.runnerState;
    state.cursor = {
      mergedAt: Date.parse(mergedPullRequest.merged_at),
      number: mergedPullRequest.number,
    };
    // A merged unit is finished. Leaving it recorded as active makes the next
    // start look blocked by work that no longer exists, and the runner would
    // wait on a pull request nobody is going to touch again.
    if (releaseOnMerge(state.lease, mergedPullRequest.number)) state.lease = null;
    await client.setRunnerState(state);
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
