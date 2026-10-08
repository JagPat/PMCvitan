// Owner decision 2026-10-08 (rule 10) — every merged PR carries a completion report: hours from open to
// merge, Codex review rounds and changed lines. Posted by `.github/workflows/completion-report.yml` when the
// PR is CLOSED AS MERGED, so a PR that waited in auto-merge is measured to its real `merged_at`
// (Codex 4213960407), not to the moment the controller queued it.
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

import { codexFindingHeads } from './review-efficiency.mjs';

export const COMPLETION_MARKER = '<!-- completion-report -->';
const TRIVIAL = /^<!--\s*review-size:\s*trivial\s*-->/iu;

/**
 * Codex review rounds for a merged PR: every finding-bearing head, plus the clean merged head's own round
 * when Codex found nothing there. A trivial fast-lane PR had no Codex round at all.
 */
export function reviewRounds(pullRequest, { comments = [], reviews = [] } = {}) {
  const heads = new Set(codexFindingHeads(comments, reviews));
  if (TRIVIAL.test(String(pullRequest?.body ?? '').trimStart())) return heads.size;
  return heads.size + (heads.has(pullRequest?.head?.sha) ? 0 : 1);
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
  if (issueComments.some((comment) => String(comment?.body ?? '').startsWith(COMPLETION_MARKER))) {
    console.log('completion-report: already posted');
    return null;
  }
  const [comments, reviews] = await Promise.all([
    readAll(fetchImpl, `${api}/pulls/${pullRequest.number}/comments`, token),
    readAll(fetchImpl, `${api}/pulls/${pullRequest.number}/reviews`, token),
  ]);
  const body = completionReport(pullRequest, { rounds: reviewRounds(pullRequest, { comments, reviews }) });
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
