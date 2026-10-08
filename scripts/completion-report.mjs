// Owner decision 2026-10-08 (rule 10) — every merged PR carries a completion report: hours from open to
// merge, Codex review rounds and changed lines. Posted by `.github/workflows/completion-report.yml` when the
// PR is CLOSED AS MERGED, or by its sweep for merges the workflow token made (see `sweep`), so a PR that
// waited in auto-merge is measured to its real `merged_at` (Codex 4213960407), not to the moment the
// controller queued it.
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

import { findingRoundHeads } from './review-cap.mjs';
import { STATUS_CONTEXT } from './review-policy.mjs';

export const COMPLETION_MARKER = '<!-- completion-report -->';
const TRIVIAL_LANE_STATUS = 'review: trivial fast lane';
const ACTIONS_LOGIN = 'github-actions[bot]';

/**
 * Did the controller complete this head through the trivial fast lane? Read from the immutable evidence
 * it recorded — the newest `codex-current-head` status on the merged head — never from the PR body, which
 * can be edited after the review path ran (Codex 4214270301). `statuses` are newest first, as GitHub
 * lists them.
 */
export function mergedThroughTrivialLane(statuses = []) {
  const newest = statuses.find((status) => status?.context === STATUS_CONTEXT);
  return String(newest?.description ?? '').startsWith(TRIVIAL_LANE_STATUS);
}

/**
 * Codex review rounds for a merged PR: every head on which Codex opened findings (replies excluded, as the
 * cap counts them), plus the clean merged head's own round when Codex found nothing there. A head merged
 * through the trivial fast lane had no Codex round of its own.
 */
export function reviewRounds(pullRequest, { comments = [], reviews = [], trivial = false } = {}) {
  const heads = new Set(findingRoundHeads(comments, reviews));
  if (trivial || heads.has(pullRequest?.head?.sha)) return heads.size;
  return heads.size + 1;
}

/**
 * Has the workflow already reported on this PR? Only a comment the Actions identity authored, carrying the
 * report's own shape, counts (Codex 4214389907): anyone can paste the marker, and a pasted one must not
 * suppress the report.
 */
export function alreadyReported(issueComments = []) {
  return issueComments.some((comment) => comment?.user?.login === ACTIONS_LOGIN
    && comment?.user?.type === 'Bot'
    && String(comment?.body ?? '').startsWith(`${COMPLETION_MARKER}\n**Completion report**\n`));
}

export function completionReport(pullRequest, { rounds }) {
  const opened = Date.parse(pullRequest?.created_at);
  const merged = Date.parse(pullRequest?.merged_at);
  const hours = Number.isFinite(opened) && Number.isFinite(merged) ? ((merged - opened) / 3_600_000).toFixed(1) : '?';
  const additions = Number(pullRequest?.additions ?? 0);
  const deletions = Number(pullRequest?.deletions ?? 0);
  return [
    COMPLETION_MARKER,
    '**Completion report**',
    `- Hours from open to merge: ${hours}`,
    `- Codex review rounds: ${rounds}`,
    `- Changed lines: ${additions + deletions} (+${additions} / −${deletions}) across ${Number(pullRequest?.changed_files ?? 0)} files`,
  ].join('\n');
}

async function readAll(fetchImpl, url, token) {
  const rows = [];
  for (let page = 1; page <= 30; page += 1) {
    const response = await fetchImpl(`${url}?per_page=100&page=${page}`, {
      headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'user-agent': 'pmcvitan-completion-report' },
    });
    if (!response.ok) throw new Error(`GitHub ${response.status} on ${url}`);
    const batch = await response.json();
    rows.push(...batch);
    if (batch.length < 100) return rows;
  }
  return rows;
}

/** How far back a sweep looks for merged PRs still missing their report. */
export const SWEEP_WINDOW_MS = 48 * 3_600_000;
/** A bound on the closed-PR pages one sweep reads (10,000 PRs closed inside the window). */
export const SWEEP_MAX_PAGES = 100;

function headersFor(token) {
  return { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'user-agent': 'pmcvitan-completion-report' };
}

async function getJson(fetchImpl, url, token) {
  const response = await fetchImpl(url, { headers: headersFor(token) });
  if (!response.ok) throw new Error(`GitHub ${response.status} on ${url}`);
  return response.json();
}

/** Post one merged PR's report unless the workflow already did. Returns the body, or null. */
export async function reportPullRequest({ api, token, fetchImpl, pullRequest }) {
  if (!pullRequest?.merged_at) return null;
  const issueComments = await readAll(fetchImpl, `${api}/issues/${pullRequest.number}/comments`, token);
  if (alreadyReported(issueComments)) return null;
  const [comments, reviews, statuses] = await Promise.all([
    readAll(fetchImpl, `${api}/pulls/${pullRequest.number}/comments`, token),
    readAll(fetchImpl, `${api}/pulls/${pullRequest.number}/reviews`, token),
    readAll(fetchImpl, `${api}/commits/${pullRequest.head.sha}/statuses`, token),
  ]);
  const trivial = mergedThroughTrivialLane(statuses);
  const body = completionReport(pullRequest, { rounds: reviewRounds(pullRequest, { comments, reviews, trivial }) });
  const response = await fetchImpl(`${api}/issues/${pullRequest.number}/comments`, {
    method: 'POST',
    headers: { ...headersFor(token), 'content-type': 'application/json' },
    body: JSON.stringify({ body }),
  });
  if (!response.ok) throw new Error(`GitHub ${response.status} posting the completion report`);
  return body;
}

/**
 * Codex 4220431609 — the controller merges with the workflow token, and GitHub creates no workflow run from
 * an event that token causes: neither the `pull_request: closed` this report listens for nor the push to
 * `main` that should run CI's full battery (owner rule 7). The SWEEP runs instead — after every controller
 * run (`workflow_run`, which that token does trigger) and hourly — and does both duties idempotently:
 *  1. reports every PR merged in the last `SWEEP_WINDOW_MS` that has no report yet;
 *  2. dispatches CI on `main` when `main`'s head has no CI run (a dispatch is an event that token may
 *     create; the battery plan runs the full battery for any non-PR event).
 */
export async function sweep({ repository, token, fetchImpl = globalThis.fetch, now = Date.now() }) {
  const api = `https://api.github.com/repos/${repository}`;
  const reported = [];
  // Codex 4220621322 — every page whose activity is inside the window: the list is newest-updated first, and
  // a PR's merge is never later than its last update, so the first page that reaches past the window is the
  // last one that can hold an in-window merge
  for (let page = 1; page <= SWEEP_MAX_PAGES; page += 1) {
    const closed = await getJson(fetchImpl, `${api}/pulls?state=closed&sort=updated&direction=desc&per_page=100&page=${page}`, token);
    for (const summary of closed) {
      const mergedAt = Date.parse(summary?.merged_at ?? '');
      if (!Number.isFinite(mergedAt) || now - mergedAt > SWEEP_WINDOW_MS) continue;
      // the list omits additions/deletions: read the full pull request the report measures
      const pullRequest = await getJson(fetchImpl, `${api}/pulls/${summary.number}`, token);
      if (await reportPullRequest({ api, token, fetchImpl, pullRequest })) reported.push(pullRequest.number);
    }
    const oldest = Date.parse(closed.at(-1)?.updated_at ?? '');
    if (closed.length < 100 || !Number.isFinite(oldest) || now - oldest > SWEEP_WINDOW_MS) break;
  }
  const main = await getJson(fetchImpl, `${api}/commits/main`, token);
  const runs = await getJson(fetchImpl, `${api}/actions/workflows/ci.yml/runs?head_sha=${main.sha}&per_page=1`, token);
  let dispatched = false;
  if (Number(runs?.total_count ?? 0) === 0) {
    const response = await fetchImpl(`${api}/actions/workflows/ci.yml/dispatches`, {
      method: 'POST',
      headers: { ...headersFor(token), 'content-type': 'application/json' },
      body: JSON.stringify({ ref: 'main' }),
    });
    if (!response.ok) throw new Error(`GitHub ${response.status} dispatching CI on main`);
    dispatched = true;
  }
  return { reported, mainSha: main.sha, dispatched };
}

export async function run({
  eventPath = process.env.GITHUB_EVENT_PATH,
  eventName = process.env.GITHUB_EVENT_NAME,
  repository = process.env.GITHUB_REPOSITORY,
  token = process.env.GITHUB_TOKEN,
  fetchImpl = globalThis.fetch,
} = {}) {
  if (eventName !== 'pull_request') {
    const result = await sweep({ repository, token, fetchImpl });
    console.log(`completion-report sweep: reported ${JSON.stringify(result.reported)}; main ${result.mainSha} CI dispatched=${result.dispatched}`);
    return result;
  }
  const event = JSON.parse(await readFile(eventPath, 'utf8'));
  const pullRequest = event.pull_request;
  if (!pullRequest?.merged) {
    console.log('completion-report: the pull request closed without merging; nothing to report');
    return null;
  }
  const body = await reportPullRequest({ api: `https://api.github.com/repos/${repository}`, token, fetchImpl, pullRequest });
  console.log(body ?? 'completion-report: already posted');
  return body;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  await run();
}
