import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const API_ROOT = 'https://api.github.com';
const CONFLICT_MARKER = '<!-- autonomous-conflict:';
const MERGE_MARKER = '<!-- autonomous-post-merge:';

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function requiredEnvironment(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

export function isAutonomousPullRequest(pullRequest, repository) {
  return (
    pullRequest?.state === 'open' &&
    pullRequest?.head?.repo?.full_name === repository &&
    pullRequest?.base?.repo?.full_name === repository &&
    pullRequest?.head?.ref?.startsWith('claude/')
  );
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

  comments(number) {
    return this.request(
      `/repos/${this.repository}/issues/${number}/comments?per_page=100`,
    );
  }

  comment(number, body) {
    return this.request(`/repos/${this.repository}/issues/${number}/comments`, {
      method: 'POST',
      body: { body },
    });
  }
}

async function refreshedMergeability(client, pullRequest) {
  let live = pullRequest;
  for (let attempt = 0; attempt < 3 && live.mergeable === null; attempt += 1) {
    if (attempt > 0) await sleep(2_000);
    live = await client.pullRequest(pullRequest.number);
  }
  return live;
}

async function handOffConflict(client, pullRequest, repository) {
  if (!isAutonomousPullRequest(pullRequest, repository)) return;
  const live = await refreshedMergeability(client, pullRequest);
  if (live.mergeable !== false && live.mergeable_state !== 'behind') return;

  const marker = `${CONFLICT_MARKER}${live.head.sha} -->`;
  const comments = await client.comments(live.number);
  if (comments.some((comment) => comment.body?.includes(marker))) return;

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

async function handOffMergedPullRequest(client, pullRequest, repository) {
  if (
    !pullRequest?.merged ||
    pullRequest?.head?.repo?.full_name !== repository ||
    !pullRequest?.head?.ref?.startsWith('claude/')
  ) return;

  const marker = `${MERGE_MARKER}${pullRequest.merge_commit_sha} -->`;
  const comments = await client.comments(pullRequest.number);
  if (comments.some((comment) => comment.body?.includes(marker))) return;

  await client.comment(
    pullRequest.number,
    [
      marker,
      '@claude This exact-head reviewed PR has merged into `main`.',
      '',
      'Continue the autonomous runner from the new `main`: verify the merge, advance `docs/STATUS.md` according to its state machine, and start only the next permitted roadmap task or named correction. Create the next same-repository `claude/**` branch and draft PR with Auto-fix enabled. If the merged result or state file is inconsistent, open a focused correction instead of advancing.',
    ].join('\n'),
  );
}

export async function run() {
  const eventName = requiredEnvironment('GITHUB_EVENT_NAME');
  const event = JSON.parse(
    await readFile(requiredEnvironment('GITHUB_EVENT_PATH'), 'utf8'),
  );
  const repository = requiredEnvironment('GITHUB_REPOSITORY');
  const client = new GitHubClient({
    repository,
    token: requiredEnvironment('GITHUB_TOKEN'),
  });

  if (eventName === 'pull_request_target') {
    const pullRequest = await client.pullRequest(event.pull_request.number);
    if (event.action === 'closed') {
      await handOffMergedPullRequest(client, pullRequest, repository);
      return;
    }
    await handOffConflict(client, pullRequest, repository);
    return;
  }

  for (const pullRequest of await client.openPullRequests()) {
    await handOffConflict(client, pullRequest, repository);
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;
if (invokedPath === import.meta.url) {
  run().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
