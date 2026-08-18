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
import { isCorrectionEligiblePullRequest } from './correction-owner.mjs';
import {
  assessCorrectionLease,
  correctionReasonFor,
  gateRecoveryStatus,
  owedCorrectionStatus,
} from './correction-lease.mjs';
import { codexFindingHeads } from './review-efficiency.mjs';

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

  // The review gate's recovery entry point. `auto-merge.yml` runs recovery only
  // on `workflow_dispatch`, and it authorises the request against the exact head
  // and terminal status id, so all three inputs are mandatory.
  dispatchRecovery(defaultBranch, inputs) {
    return this.request(
      `/repos/${this.repository}/actions/workflows/auto-merge.yml/dispatches`,
      { method: 'POST', body: { ref: defaultBranch, inputs } },
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

  async paginated(path) {
    const items = [];
    for (let page = 1; ; page += 1) {
      const separator = path.includes('?') ? '&' : '?';
      const batch = await this.request(`${path}${separator}per_page=100&page=${page}`);
      items.push(...batch);
      if (batch.length < 100) return items;
    }
  }

  reviews(number) {
    return this.paginated(`/repos/${this.repository}/pulls/${number}/reviews`);
  }

  reviewComments(number) {
    return this.paginated(`/repos/${this.repository}/pulls/${number}/comments`);
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
      if (!headSha) return { number: pullRequest?.number ?? null, now: null, editsStatus: null };
      try {
        const markdown = await client.fileContent('docs/STATUS.md', headSha);
        return {
          number: pullRequest.number,
          now: parseStatusNow(markdown ?? ''),
          // Whether this PR's DIFF touches docs/STATUS.md (#334 round 3): a terminal
          // none-flip head is indistinguishable, from its Now block alone, from a
          // maintenance PR that merely carries main's terminal state — only the diff
          // says which one PROPOSES the state. `null` on failure: the drift logic
          // treats unknown as editing, failing toward the recoverable mistake.
          editsStatus: await pullRequestEditsStatus(client, pullRequest.number),
        };
      } catch (error) {
        console.warn(
          `Could not read STATUS from PR #${pullRequest.number} head: ${error.message}`,
        );
        return { number: pullRequest.number, now: null, editsStatus: null };
      }
    }),
  );
}

// Does the PR's changed-file list include docs/STATUS.md? Bounded to three pages
// (an autonomous PR never legitimately exceeds 300 files — the review budget is 20);
// an over-long or unreadable list returns null rather than guessing false.
async function pullRequestEditsStatus(client, number) {
  try {
    for (let page = 1; page <= 3; page += 1) {
      const batch = await client.request(
        `/repos/${client.repository}/pulls/${number}/files?per_page=100&page=${page}`,
      );
      if ((batch ?? []).some((file) => file?.filename === 'docs/STATUS.md')) return true;
      if ((batch ?? []).length < 100) return false;
    }
    return null;
  } catch {
    return null;
  }
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
  const [{ now, maintenanceQueue }, openPullRequests] = await Promise.all([
    loadStatus(),
    client.openPullRequests().then((pullRequests) =>
      selectAutonomousOpenPullRequests(pullRequests, repository, defaultBranch),
    ),
  ]);
  const headStatuses = await openHeadStatuses(client, openPullRequests);
  return {
    defaultBranchNow: now,
    maintenanceQueue,
    openPullRequests,
    headStatuses,
  };
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
  await client.comment(
    pullRequest.number,
    [
      marker,
      buildPostMergeContinuation({
        statusNow: mergedNow,
      maintenanceQueue: mergedMaintenanceQueue,
        openPullRequests,
        headStatuses,
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
  const body = buildDriftHandoff({
    statusNow: defaultBranchNow,
    maintenanceQueue,
    openPullRequests,
    headStatuses,
  });
  if (!body) return;

  const primary = openPullRequests.at(-1);
  if (!primary) {
    // Key the marker to the drifting state. A constant marker made this recovery
    // one-shot for the repository's lifetime: once posted, every LATER drift with
    // no live PR was silently swallowed and the loop stayed pointed at stale work.
    const staleOpenPr = String(defaultBranchNow?.open_pr ?? 'none').trim() || 'none';
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

// The correction WATCHDOG.
//
// Until now this job drained conflicts, merge continuation and status drift, and
// reported green while a failing head sat untouched — which is what happened to
// PR #349 and PR #350 on 2026-08-17. A correction that nobody started looks,
// from GitHub's side, exactly like one in progress; the difference is only
// visible as time passing with no movement.
//
// So this asks the one question the loop could not: has the head that owes a
// correction moved? It only ever COMMENTS. It never publishes
// `codex-current-head`, never changes draft state, never merges, and never
// invokes Codex — the exact-head gate is untouched and still the only thing that
// admits a merge.
export async function handOffCorrectionLease(
  client,
  pullRequest,
  repository,
  defaultBranch,
  { now = new Date().toISOString() } = {},
) {
  if (!isCorrectionEligiblePullRequest(pullRequest, repository, defaultBranch)) return null;
  const head = pullRequest.head?.sha;
  if (!head) return null;

  // The combined status returns the LATEST status per context, so an owed
  // correction is found only while the exact head's required status is still
  // failing: a newer success, or a head that never failed, produces nothing.
  // That is the lease's second satisfaction — a scope refusal cleared by a body
  // edit moves no head, and must still end the watch.
  const combined = await client.combinedStatus(head);

  // A failure the GATE recovers from is DISPATCHED, not reported. `auto-merge.yml`
  // recovers only through `workflow_dispatch` and the timeout path publishes its
  // failure and throws, so no later CI event arrives — excluding these from the
  // lease left the pull request draft until a human noticed. This workflow
  // already holds `actions: write` and already dispatches itself, so the
  // watchdog asks for the recovery rather than printing instructions for it.
  //
  // Idempotent by the gate's own bookkeeping: an accepted request publishes
  // `recovery: requested terminal status <id>` on this context, and a
  // `recovery:` status is never an owed correction, so the next tick sees
  // nothing to do. A duplicate within that window is harmless — the gate
  // authorises against the exact terminal status id.
  const recoverable = gateRecoveryStatus(combined);
  if (recoverable) {
    await client.dispatchRecovery(defaultBranch, {
      pr_number: String(pullRequest.number),
      head_sha: head,
      terminal_status_id: String(recoverable.id),
    });
    console.log(
      `Dispatched gate recovery for PR #${pullRequest.number} head ${head} `
        + `terminal status ${recoverable.id}.`,
    );
    return { state: 'dispatched', head, terminalStatusId: recoverable.id ?? null };
  }

  const owed = owedCorrectionStatus(combined);
  if (!owed) return null;

  const [comments, reviewComments, reviews] = await Promise.all([
    client.comments(pullRequest.number),
    client.reviewComments(pullRequest.number),
    client.reviews(pullRequest.number),
  ]);

  // Re-read the pull request IMMEDIATELY before assessing.
  //
  // `pullRequest` comes from the open-PR snapshot taken once at the top of the
  // handoff loop, and everything since — conflict handling for other PRs, the
  // status read, three comment fetches — takes time a correction can land in. A
  // stale snapshot still names the old head, so the lease would match itself and
  // publish a stalled notice for a head that has already been superseded: the
  // one thing a lease keyed to an exact head must never do. `assessCorrectionLease`
  // already treats a moved head as satisfied; it just has to be given the live
  // pull request to see it.
  const assessed = await client.pullRequest(pullRequest.number);

  const assessment = assessCorrectionLease({
    pullRequest: assessed,
    head,
    findingHeads: codexFindingHeads(reviewComments, reviews),
    reason: correctionReasonFor(owed),
    detail: String(owed.description ?? '').replace(/^\s*[a-z]+:\s*/u, ''),
    findingObservedAt: owed.updated_at ?? owed.created_at,
    occurrence: owed.id ?? null,
    now,
    comments,
  });

  if (assessment.state === 'notify') {
    // PUBLISH ONLY WHAT A FRESH READ STILL SAYS.
    //
    // The notice is composed from a snapshot, and everything after it takes time
    // each of its inputs can change in. Successive review rounds each found a
    // different one — the status, the head, which failure it is, the declared
    // owner, the finding history — so the guard is not a list of inputs: the
    // whole assessment is RE-DERIVED here and published only if it comes out
    // identical. A lease key is claimed forever, so a wrong notice is worse than
    // a late one, and anything that moved defers to the next hourly tick.
    const [freshStatuses, live, freshReviewComments, freshReviews] = await Promise.all([
      client.combinedStatus(head),
      client.pullRequest(pullRequest.number),
      // The FINDING HISTORY too: it decides whether a correction is owed at all
      // or the round limit has been reached, so delayed evidence for a second
      // head would otherwise publish the forbidden third-head instruction with
      // every other guard passing.
      client.reviewComments(pullRequest.number),
      client.reviews(pullRequest.number),
    ]);
    // Eligibility again, on the REFRESHED object. A pull request closed between
    // the open-PR snapshot and this read keeps the same head and body, so
    // nothing else in the assessment notices — and the watchdog would wake an
    // owner on a closed PR.
    if (!isCorrectionEligiblePullRequest(live, repository, defaultBranch)) {
      return {
        ...assessment,
        state: 'superseded',
        body: null,
        reason: 'the pull request left the watchdog\'s remit while it was reading',
      };
    }
    const freshOwed = owedCorrectionStatus(freshStatuses);
    const fresh = freshOwed
      ? assessCorrectionLease({
        pullRequest: live,
        head,
        findingHeads: codexFindingHeads(freshReviewComments, freshReviews),
        reason: correctionReasonFor(freshOwed),
        detail: String(freshOwed.description ?? '').replace(/^\s*[a-z]+:\s*/u, ''),
        findingObservedAt: freshOwed.updated_at ?? freshOwed.created_at,
        occurrence: freshOwed.id ?? null,
        now,
        comments,
      })
      : null;
    // The RAW BODY too, not only the notice it renders. A checklist item ticked
    // while the watchdog reads can clear a scope verdict the status has not
    // caught up with, leaving the rendered text identical — and a lease key is
    // claimed forever, so publishing then is a permanent stale wake-up.
    if (fresh?.state !== 'notify' || fresh.body !== assessment.body || live.body !== assessed.body) {
      return {
        ...assessment,
        state: 'superseded',
        body: null,
        reason: 'the pull request changed while the watchdog was reading; the next tick reassesses',
      };
    }
    await client.comment(pullRequest.number, assessment.body);
    console.log(
      `Published ${assessment.reportedState} for PR #${pullRequest.number} `
        + `head ${head} owner ${assessment.owner}.`,
    );
  }
  return assessment;
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

  // Every event also drains open conflict state and every owed correction. A
  // pending Actions run may be replaced within the global group, so no
  // event-specific path is essential.
  let retryNeeded = false;
  const watchdogFailures = [];
  for (const pullRequest of await client.openPullRequests()) {
    try {
      await handOffConflict(client, pullRequest, repository, defaultBranch);
    } catch (error) {
      if (!String(error?.message).includes('did not compute mergeability')) throw error;
      retryNeeded = true;
      console.warn(error.message);
    }
    try {
      await handOffCorrectionLease(client, pullRequest, repository, defaultBranch);
    } catch (error) {
      // Collected rather than thrown here, so one unreadable pull request cannot
      // stop the others from being watched — and rethrown below, so a watchdog
      // that could not run never leaves this job reporting green. Reporting green
      // over unobserved corrections is the defect this whole change removes.
      watchdogFailures.push(`#${pullRequest?.number}: ${error?.message}`);
    }
  }
  if (retryWaitForPullRequest || retryNeeded) {
    await client.dispatchRetry(defaultBranch, retryWaitForPullRequest);
  }
  if (watchdogFailures.length > 0) {
    throw new Error(
      `The correction watchdog could not assess ${watchdogFailures.length} pull request(s): `
        + watchdogFailures.join('; '),
    );
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;
if (invokedPath === import.meta.url) {
  run().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
