import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

import {
  assessReviewScope,
  PRE_REVIEW_ENFORCE_AFTER_PR,
} from './review-efficiency.mjs';

async function pullRequestFiles({ fetchImpl, repository, number, token }) {
  if (typeof fetchImpl !== 'function' || !repository || !token) {
    throw new Error('repository, GITHUB_TOKEN, and fetch are required to inspect PR files');
  }

  const files = [];
  for (let page = 1; ; page += 1) {
    const response = await fetchImpl(
      `https://api.github.com/repos/${repository}/pulls/${number}/files?per_page=100&page=${page}`,
      {
        headers: {
          accept: 'application/vnd.github+json',
          authorization: `Bearer ${token}`,
          'x-github-api-version': '2022-11-28',
        },
      },
    );
    if (!response.ok) {
      throw new Error(`GitHub pull files request failed with HTTP ${response.status}`);
    }
    const pageFiles = await response.json();
    if (!Array.isArray(pageFiles)) {
      throw new Error('GitHub pull files response was not an array');
    }
    files.push(...pageFiles);
    if (pageFiles.length < 100) return files;
  }
}

export async function run({
  eventPath = process.env.GITHUB_EVENT_PATH,
  token = process.env.GITHUB_TOKEN,
  repository = process.env.GITHUB_REPOSITORY,
  fetchImpl = globalThis.fetch,
} = {}) {
  if (!eventPath) throw new Error('GITHUB_EVENT_PATH is required');
  const event = JSON.parse(await readFile(eventPath, 'utf8'));
  if (!event.pull_request) {
    console.log('review-scope: no pull request in this event; nothing to assess');
    return { state: 'not_applicable', allowed: true };
  }

  const preReviewRequired = event.pull_request.number > PRE_REVIEW_ENFORCE_AFTER_PR;
  let changedFiles;
  if (preReviewRequired) {
    try {
      changedFiles = await pullRequestFiles({
        fetchImpl,
        repository: repository || event.repository?.full_name,
        number: event.pull_request.number,
        token,
      });
    } catch (error) {
      console.error(`review-scope: could not inspect cumulative PR files: ${error.message}`);
    }
  }
  const result = assessReviewScope(event.pull_request, {
    changedFiles,
    requireChangedFiles: preReviewRequired,
  });
  console.log(
    `review-scope: ${result.state}; ${result.changedFiles} files, ${result.changedLines} changed lines`,
  );
  if (!result.allowed) {
    console.error(`::error title=Review preflight failed::${result.detail}`);
    process.exitCode = 1;
  }
  return result;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  await run();
}
