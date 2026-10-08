// Owner decision 2026-10-08 (rule 10) — every merged PR carries a completion report: hours from open to
// merge, Codex review rounds and changed lines. Posted by `.github/workflows/completion-report.yml` when the
// PR is CLOSED AS MERGED, so a PR that waited in auto-merge is measured to its real `merged_at`
// (Codex 4213960407), not to the moment the controller queued it.
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

export async function run({
  eventPath = process.env.GITHUB_EVENT_PATH,
  repository = process.env.GITHUB_REPOSITORY,
  token = process.env.GITHUB_TOKEN,
  fetchImpl = globalThis.fetch,
} = {}) {
  const event = JSON.parse(await readFile(eventPath, 'utf8'));
  const pullRequest = event.pull_request;
  if (!pullRequest?.merged) {
    console.log('completion-report: the pull request closed without merging; nothing to report');
    return null;
  }
  const api = `https://api.github.com/repos/${repository}`;
  const issueComments = await readAll(fetchImpl, `${api}/issues/${pullRequest.number}/comments`, token);
  if (alreadyReported(issueComments)) {
    console.log('completion-report: already posted');
    return null;
  }
  const [comments, reviews, statuses] = await Promise.all([
    readAll(fetchImpl, `${api}/pulls/${pullRequest.number}/comments`, token),
    readAll(fetchImpl, `${api}/pulls/${pullRequest.number}/reviews`, token),
    readAll(fetchImpl, `${api}/commits/${pullRequest.head.sha}/statuses`, token),
  ]);
  const trivial = mergedThroughTrivialLane(statuses);
  const body = completionReport(pullRequest, { rounds: reviewRounds(pullRequest, { comments, reviews, trivial }) });
  const response = await fetchImpl(`${api}/issues/${pullRequest.number}/comments`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'user-agent': 'pmcvitan-completion-report', 'content-type': 'application/json' },
    body: JSON.stringify({ body }),
  });
  if (!response.ok) throw new Error(`GitHub ${response.status} posting the completion report`);
  console.log(body);
  return body;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  await run();
}
