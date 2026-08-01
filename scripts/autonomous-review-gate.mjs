import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { loadStatusDocument } from './autonomous-status-state.mjs';
import {
  METRICS_MARKER,
  assessRestructure,
  expiredWindow,
  humanDeclaration,
  readMetrics,
  recordedWindowMinutes,
  renderMetrics,
} from './review-lifecycle.mjs';

import {
  codexThreadIdsToResolve,
  classifyCodexState,
  isEligiblePullRequest,
} from './autonomous-review-state.mjs';
import {
  assessConvergence,
  assessReviewScope,
  deferralPhases,
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
const CHECK_TIMEOUT_MS = Number(process.env.CHECK_TIMEOUT_MS ?? 10 * 60_000);
const REVIEW_TIMEOUT_MS = Number(process.env.REVIEW_TIMEOUT_MS ?? 15 * 60_000);
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

// WHICH sticky comment is the durable record.
//
// A pull request can carry more than one: the earlier single-page writer bug
// could POST a second `autonomous-review-state` comment past the hundredth
// comment while the original stayed at the top. `find()` over the ascending list
// then returns the STALE first marker and ignores the newer one actually holding
// the floor — so a recorded five-head crossing reads as absent and the gate
// promotes another review instead of failing closed.
//
// The newest comment CARRYING the record wins; only if none carries one does the
// newest bare sticky win. The writer picks the same comment, which consolidates
// a duplicated pair back onto the record-bearing one instead of forking further.
export function pickSticky(comments) {
  const stickies = (comments ?? []).filter(
    (comment) => comment?.user?.login === 'github-actions[bot]'
      && comment?.body?.includes(COMMENT_MARKER),
  );
  if (stickies.length === 0) return null;
  const bearing = stickies.filter((comment) => comment.body.includes(METRICS_MARKER));
  return (bearing.length > 0 ? bearing : stickies).at(-1);
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
    || description === 'review: bootstrap exact-head review requested'
    // A lifecycle declaration block is resumable because RESUMING IS NOT
    // APPROVING. The dispatch only makes the gate run again on the same head;
    // the gate then re-reads the record and re-decides, so a window that has not
    // actually expired blocks a second time (`W24`). Without this the fallback
    // sweep could see an expired window and have no way to act on it, which is
    // the whole of finding F3.
    || description.startsWith('review: lifecycle —')
    || description.startsWith('review: lifecycle unreadable —');
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

  // Open autonomous units only. The sweep runs on a timer over every open pull
  // request, so it stays scoped to the branches this loop owns.
  async openAutonomousPullRequests() {
    const open = await this.paginated(
      `/repos/${this.repository}/pulls?state=open`,
    );
    return open.filter((pr) => String(pr?.head?.ref ?? '').startsWith('claude/'));
  }

  async dispatchReviewRecovery({ pullRequestNumber, headSha, terminalStatusId, ref }) {
    return this.request(
      `/repos/${this.repository}/actions/workflows/auto-merge.yml/dispatches`,
      {
        method: 'POST',
        body: {
          ref,
          inputs: {
            pr_number: String(pullRequestNumber),
            head_sha: String(headSha),
            terminal_status_id: String(terminalStatusId),
          },
        },
      },
    );
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

  // EVERY comment, not the first hundred.
  //
  // Two pieces of lifecycle evidence live here — the durable floor on the sticky
  // comment, and a maintainer's restructure declaration — and both are read to
  // decide whether an over-limit unit may proceed. A long review unit passes a
  // hundred comments easily, and a single unread page would make the gate treat
  // a recorded floor or a posted `restructure` as ABSENT: the permissive
  // outcome, decided by a page boundary. Truncated evidence is the one thing a
  // fail-closed gate must never mistake for no evidence.
  //
  // A page that fails to load THROWS rather than returning a short list, so the
  // caller can tell "read everything" from "read some of it".
  async issueComments(number) {
    const all = [];
    for (let page = 1; page <= 20; page += 1) {
      const batch = await this.request(
        `/repos/${this.repository}/issues/${number}/comments?per_page=100&page=${page}`,
      );
      if (!Array.isArray(batch)) {
        throw new Error(`issue comments page ${page} was not a list`);
      }
      all.push(...batch);
      if (batch.length < 100) return all;
    }
    // 2000 comments without exhausting the pages. Returning what we have would
    // be the same truncation this method exists to prevent, silently.
    throw new Error('issue comments exceeded the pagination bound; evidence would be partial');
  }

  async stickyComment(number) {
    return pickSticky(await this.issueComments(number))?.body ?? null;
  }

  async updateStickyComment(number, body) {
    // The SAME paged read the finder uses. Paginating the read and leaving the
    // write on one page is worse than paginating neither: past a hundred
    // comments the writer would not find the sticky it is meant to patch, POST a
    // second one, and then every lifecycle read — which does page — would keep
    // returning the original. The floor and the reply deadline would be written
    // to a comment nothing reads, and the window could be reset or replayed.
    const comments = await this.issueComments(number);
    const existing = pickSticky(comments);
    // The lifecycle floor and the declaration deadline live in a metrics block
    // inside this comment, and sixteen other call sites write it with a plain
    // status body. Every one of those would erase the record — resetting the
    // finding-head floor and the reply window — so the carry-forward is done
    // HERE rather than by remembering to append metrics at sixteen call sites.
    // A writer that supplies its own block replaces it; a writer that does not
    // preserves what was already there.
    const priorMetrics = existing?.body?.includes(METRICS_MARKER)
      && !body.includes(METRICS_MARKER)
      ? existing.body.slice(existing.body.indexOf(METRICS_MARKER)).split('-->')[0] + '-->'
      : null;
    const fullBody = `${COMMENT_MARKER}\n${body}${priorMetrics ? `\n${priorMetrics}` : ''}`;
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
  // The head commit answers "does THIS head carry the audit?". Whether the review unit
  // is provable at all is a question about the PR's CUMULATIVE diff — a code PR's
  // convergence head is very often the packet alone. An unreadable list is left
  // undefined, which assessConvergence resolves toward the ordinary code protocol.
  let pullRequestFiles;
  try {
    pullRequestFiles = await client.pullRequestFiles(pullRequest.number);
  } catch {
    pullRequestFiles = undefined;
  }
  // Which phases a deferral may name. `docs/STATUS.md` is a machine-readable state file and
  // this workflow runs from the trusted default branch's own checkout, so this is a plain
  // structured-field read — not the PR-head content fetching this PR withdrew. Unreadable
  // leaves it undefined, which assessConvergence treats as "no constraint".
  let activePhases;
  try {
    const status = await loadStatusDocument();
    activePhases = deferralPhases(status?.now);
  } catch {
    activePhases = undefined;
  }
  const result = assessConvergence({
    comments,
    reviews,
    headMessage: commit.commit?.message,
    changedFiles: commit.files ?? [],
    pullRequestFiles,
    activePhases,
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

// The five-head limit, wired.
//
// `review-lifecycle.mjs` shipped as a policy model in #259 and was imported by
// nothing but its own tests, so the rule never fired — PR #263 ran to six
// finding-bearing heads without it once triggering. A rule nothing consults
// governs nothing; this is the call site that makes it real.
//
// The owner's shape: ask a human only when it is CRITICAL, and if nobody answers
// inside the window, proceed and record that it proceeded unanswered.
// The FALLBACK, and only the fallback.
//
// Every other transition in this loop is event-driven and reacts the moment it
// happens; nothing here waits on a tick to do work an event already announced.
// A declaration window is the one exception, because its expiry is defined by
// the absence of activity — nobody pushes, nobody comments, nobody answers — so
// there is no event to react to. This runs on a timer for that case alone.
//
// It is cheap and side-effect-free when idle: one list call plus one comment
// read per open autonomous unit, and it writes NOTHING unless a window has
// actually run out. Waking a unit means re-dispatching the normal gate on the
// same head — this function never decides anything itself, so the exact-head
// gate stays the only authority and still fails closed.
export async function sweepExpiredWindows(client, {
  nowIso = new Date().toISOString(),
  ref = 'main',
  log = console.log,
} = {}) {
  const open = await client.openAutonomousPullRequests();
  const woken = [];
  const skipped = [];

  for (const pullRequest of open) {
    let metrics = null;
    try {
      metrics = readMetrics(await client.stickyComment(pullRequest.number));
    } catch (error) {
      // A unit whose record cannot be read is REPORTED, never silently passed
      // over: "the sweep found nothing" and "the sweep could not look" are
      // different facts, and only one of them means all is well.
      skipped.push({ number: pullRequest.number, reason: `sticky unreadable (${error.message})` });
      continue;
    }

    const statuses = await client.statuses(pullRequest.head.sha);
    const terminal = statuses.find((status) => status.context === STATUS_CONTEXT);
    if (!isRetryableTerminalReviewFailure(terminal)) {
      // Either nothing is blocking this head, or the block is a DECLARED
      // restructure — terminal by decision, and re-dispatching it every quarter
      // hour would only pile up recovery requests while everyone waits for the
      // replacement pull request.
      continue;
    }

    // Three ways a blocked unit becomes actionable, and the sweep must catch all
    // of them. Only the first is about time.
    const expired = expiredWindow(metrics, nowIso);
    const unreadable = String(terminal.description ?? '')
      .startsWith('review: lifecycle unreadable —');
    // A maintainer ANSWERING is an event, and the issue_comment trigger reacts to
    // it immediately. This is the fallback for the answer that arrives while the
    // event path is unavailable — a webhook dropped, the workflow disabled — so
    // the unit is never left sitting on a decision that was already made.
    let answered = null;
    if (!expired && !unreadable && metrics?.declarationRequestedAt) {
      try {
        answered = humanDeclaration(
          await client.issueComments(pullRequest.number),
          metrics.declarationRequestedAt,
        );
      } catch {
        answered = null;
      }
    }

    const why = expired
      ? `the ${expired.minutes}-minute window closed `
        + `${expired.elapsedMinutes - expired.minutes} minutes ago`
      : unreadable
        ? 'the previous run could not read its own evidence, which is transient'
        : answered
          ? `${answered.by ?? 'a maintainer'} answered "${answered.declared}"`
          : null;
    if (!why) continue;

    await client.dispatchReviewRecovery({
      pullRequestNumber: pullRequest.number,
      headSha: pullRequest.head.sha,
      terminalStatusId: terminal.id,
      ref,
    });
    woken.push({ number: pullRequest.number, head: pullRequest.head.sha, why });
    log(`sweep: woke #${pullRequest.number} — ${why}`);
  }

  for (const entry of skipped) {
    log(`sweep: skipped #${entry.number} — ${entry.reason}`);
  }
  if (!woken.length) log(`sweep: nothing actionable across ${open.length} open units`);
  return { woken, skipped, scanned: open.length };
}

export async function enforceReviewLifecycle(client, pullRequest, expectedHead) {
  const [comments, reviews] = await Promise.all([
    client.reviewComments(pullRequest.number),
    client.reviews(pullRequest.number),
  ]);

  // The durable floor lives in the sticky comment. An unreadable read is passed
  // through as `floorUnreadable` rather than treated as "no record", because the
  // module blocks on that instead of guessing.
  let recordedMetrics = null;
  let floorUnreadable = false;
  try {
    recordedMetrics = readMetrics(await client.stickyComment(pullRequest.number));
  } catch {
    floorUnreadable = true;
  }

  let pullRequestFiles;
  try {
    pullRequestFiles = await client.pullRequestFiles(pullRequest.number);
  } catch {
    pullRequestFiles = undefined;
  }

  // The human's answer lives in a COMMENT, not the body. A failed read is NOT an
  // empty answer list: the permissive outcomes are `continue` and window expiry,
  // and expiry needs no answer at all, so a read that failed would look exactly
  // like silence and let the loop override a `restructure` it never saw. The
  // model is told the difference and blocks on it.
  let issueComments = [];
  let declarationsUnreadable = false;
  try {
    issueComments = await client.issueComments(pullRequest.number);
  } catch {
    declarationsUnreadable = true;
  }

  const nowIso = new Date().toISOString();
  const result = assessRestructure({
    comments,
    reviews,
    pullRequestFiles,
    body: pullRequest.body,
    issueComments,
    declarationsUnreadable,
    recordedMetrics,
    floorUnreadable,
    nowIso,
    requestedAt: recordedMetrics?.declarationRequestedAt ?? null,
    // The recorded window, fed BACK. It was written for the sweep and then never
    // read here, so the assessment recomputed it from current severity every
    // run. A unit first blocked on unclassified evidence records 360 minutes;
    // once the heads become classifiable as P1 the recompute yields 180, and a
    // run at 3h01 proceeds autonomously while the durable record still says the
    // human has six hours. A window is a promise made at request time.
    //
    // The LONGER of the two wins, so the promise cannot shrink and a
    // reclassification to something more serious still extends it — the same
    // fail-closed direction as unknown severity taking the longest window.
    declarationWindowMinutes: recordedWindowMinutes(recordedMetrics),
  });

  // Proceeding UNANSWERED is the one permissive outcome nobody authorised, and
  // the reason string says the loop "records that it did". It did not: this
  // function's only sticky write was on the blocking path below, so the override
  // left no trace and the next status body carried the old metrics forward
  // unchanged. A claim to have recorded something is worth less than nothing
  // when it IS the only record. So it is written before returning, and stamped
  // once — `autonomousAt` is preserved if an earlier run already recorded it.
  if (result.allowed && result.autonomous) {
    await client.updateStickyComment(
      pullRequest.number,
      `${statusBody({
        state: 'lifecycle_autonomous',
        head: expectedHead,
        detail: result.reason,
        attempt: 0,
        next: `No maintainer answered within the ${result.windowMinutes}-minute `
          + `${result.tier} window, so the loop proceeded on its own judgement. `
          + 'This is the durable record of that override.',
      })}\n${renderMetrics({
        ...(recordedMetrics ?? {}),
        findingHeads: result.findingHeadCount,
        findingHeadIds: result.findingHeadIds ?? [],
        declarationRequestedAt: recordedMetrics?.declarationRequestedAt ?? nowIso,
        autonomousAt: recordedMetrics?.autonomousAt ?? nowIso,
        autonomousTier: recordedMetrics?.autonomousTier ?? result.tier,
      })}`,
    );
    return result;
  }

  // A crossed-but-minor unit CONTINUES, and used to return here without writing
  // anything — so the five-head crossing left no durable trace. The floor exists
  // precisely to survive a partial read: if a later sixth head carries a P1 while
  // the live read happens to expose only that head, the gate would count one head
  // instead of six and promote another review rather than asking. Crossing the
  // threshold is the fact worth recording, whatever the verdict on it was.
  if (result.allowed && result.thresholdCrossed) {
    await client.updateStickyComment(
      pullRequest.number,
      `${statusBody({
        state: 'lifecycle_crossed',
        head: expectedHead,
        detail: result.reason,
        attempt: 0,
        next: 'The unit continues — no finding head carries a P1. The crossing is '
          + 'recorded so a later critical head is judged against it.',
      })}\n${renderMetrics({
        ...(recordedMetrics ?? {}),
        findingHeads: result.findingHeadCount,
        findingHeadIds: result.findingHeadIds ?? [],
      })}`,
    );
    return result;
  }
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
    // `review:` is the vocabulary `isTerminalReviewStatus` recognises. Written
    // as a bare `lifecycle:` this status was not classified as terminal at all,
    // so the state machine could neither see the block nor resume from it — the
    // fallback sweep had nothing to act on even once a window had expired.
    // A declared restructure is terminal BY DECISION and must not be retried: the
    // sweep would dispatch recovery every fifteen minutes, the gate would re-read
    // the same declaration and fail again, and each pass would leave another
    // pending recovery request while everyone waits for a replacement PR. Only a
    // unit still WAITING on an answer is resumable.
    // Three distinct kinds of lifecycle block, and the sweep treats them
    // differently: a DECLARED restructure is terminal by decision and must never
    // be retried; an UNREADABLE-evidence block is transient and should be retried
    // as soon as possible; a plain wait is resumable only once its window runs out.
    (result.state === 'restructure_required'
      ? `review: lifecycle restructure — ${result.reason}`
      : result.undecided
        ? `review: lifecycle unreadable — ${result.reason}`
        : `review: lifecycle — ${result.reason}`).slice(0, 140),
    pullRequest.html_url,
  );
  await client.updateStickyComment(
    pullRequest.number,
    // When the floor could NOT be read, this run's counts were computed without
    // it — writing them would patch a recorded five-head floor down to however
    // many heads happen to be visible now, and the next run would read the
    // lowered value and pass a unit that had already crossed the limit. So the
    // metrics block is omitted entirely on that path and `updateStickyComment`
    // carries the existing one forward untouched. A durable floor is only ever
    // rewritten from a reading that actually saw it.
    `${statusBody({
      state: result.state,
      head: expectedHead,
      detail: result.reason,
      attempt: 0,
      next: result.state === 'restructure_required'
        ? 'A human declared RESTRUCTURE: split this unit and open a replacement that declares Replaces: #'
          + `${pullRequest.number}.`
        // The markers are shown in code spans, and the answer is read from a
        // maintainer's COMMENT rather than the body: quoting the instructions
        // must never count as obeying them, and the decision has to be
        // attributable to a person rather than to a document the loop writes.
        : 'A maintainer decides, by posting a COMMENT on this pull request containing '
          + '`<!-- review-restructure: continue -->` to keep correcting this unit, or '
          + '`<!-- review-restructure: restructure -->` to split and replace it. If '
          + `nobody answers within ${result.windowMinutes} minutes (the ${result.tier} `
          + 'window) the loop proceeds on its own judgement and records that it did.',
    })}${floorUnreadable ? '' : `\n${renderMetrics({
      ...(recordedMetrics ?? {}),
      findingHeads: result.findingHeadCount,
      findingHeadIds: result.findingHeadIds ?? [],
      // Stamped ONCE, when the request is first made, so the window measures the
      // human's reply and not the age of the newest head.
      declarationRequestedAt: recordedMetrics?.declarationRequestedAt ?? nowIso,
      // Recorded WITH the stamp so the fallback sweep can tell when this window
      // runs out from the sticky comment alone — no review re-read, no severity
      // recomputation, on every open pull request every fifteen minutes.
      declarationWindowMinutes:
        recordedMetrics?.declarationWindowMinutes ?? result.windowMinutes,
    })}`}`,
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

  const lifecycle = await enforceReviewLifecycle(client, pullRequest, expectedHead);
  if (lifecycle.superseded) return { ...lifecycle, state: 'superseded' };
  // `undecided` means the durable floor could not be read, so whether this unit
  // has already crossed its limit is unverified. It blocks — but it is NOT the
  // same as a decided verdict, and returning the module's `reviewing` state for
  // it would publish a blocked PR labelled as if it were progressing.
  if (lifecycle.undecided) {
    return { ...lifecycle, state: 'lifecycle_undecided', allowed: false };
  }
  if (!lifecycle.allowed) return { ...lifecycle };

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
  // The scheduled fallback runs BEFORE any pull-request context is resolved,
  // because it has no single pull request: it sweeps every open autonomous unit
  // looking for the one state no event can announce. It decides nothing itself
  // and re-dispatches the ordinary gate for anything it finds.
  if (process.env.AUTONOMOUS_REVIEW_MODE === 'window-sweep') {
    const client = new GitHubClient({
      repository: requiredEnvironment('GITHUB_REPOSITORY'),
      token: requiredEnvironment('GITHUB_TOKEN'),
    });
    await sweepExpiredWindows(client, {
      ref: process.env.GITHUB_REF_NAME || 'main',
    });
    return;
  }

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

  // BEFORE promotion, not only at final admission.
  //
  // Placing this check solely in `revalidateFinalReviewPolicy` left the normal
  // path running from convergence straight into `reviewAttempt`: a unit already
  // at five critical heads would be promoted for ANOTHER Codex review, and a
  // finding from that review would draft the head without the lifecycle gate
  // ever running. The sixth finding-bearing head is exactly what this wiring
  // exists to prevent, so it has to run before the review is requested.
  const lifecycle = await enforceReviewLifecycle(client, pullRequest, expectedHead);
  if (lifecycle.superseded) return;
  if (!lifecycle.allowed) {
    throw new Error(`lifecycle: ${lifecycle.reason}`);
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
