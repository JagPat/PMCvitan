import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

import {
  assessReviewScope,
  PRE_REVIEW_ENFORCE_AFTER_PR,
  STATUS_DOCUMENT,
} from './review-efficiency.mjs';
import {
  assessPostMergeRunnerState,
  parseMaintenanceQueue,
  parseStatusNow,
} from './autonomous-status-state.mjs';

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

  // The post-merge runner state, checked HERE because this job already holds the
  // PR's own tree — `on: pull_request` checks out the merge result, so the
  // committed STATUS is on disk. That also keeps the check read-only: this job
  // has `contents: read` and `pull-requests: read` and no write capability, so
  // reading PR content as DATA carries none of the risk the write-capable
  // workflows avoid by checking out only the default branch.
  //
  // Reported independently of the scope verdict rather than folded into it: the
  // two answer different questions, and a PR can fail one while passing the other.
  // Both must be visible in one run, or fixing the first only reveals the second.
  const statusResult = await assessCommittedStatus(event.pull_request, changedFiles);
  if (statusResult) {
    if (statusResult.allowed) {
      console.log(`review-scope: post-merge runner state resolves to ${statusResult.nextStep}`);
    } else {
      console.error(`::error title=STATUS post-merge state::${statusResult.detail}`);
      process.exitCode = 1;
    }
  }

  return { ...result, status: statusResult };
}

/**
 * Null when this PR does not touch STATUS — the check is scoped to the diff that
 * can break it, so every other unit pays nothing.
 *
 * An UNREADABLE file when the diff says it changed is a failure, not a skip: the
 * alternative is a PR that edits STATUS into an unparseable shape and passes
 * because the check could not read what it edited.
 */
export async function assessCommittedStatus(pullRequest, changedFiles, readImpl = readFile) {
  if (!Array.isArray(changedFiles)) return null;
  const touchesStatus = changedFiles.some((file) =>
    file?.filename === STATUS_DOCUMENT || file?.previous_filename === STATUS_DOCUMENT);
  if (!touchesStatus) return null;

  let markdown;
  try {
    // Resolved from this module rather than the working directory, matching
    // `loadStatusDocument`. The CI job happens to run from the repo root, so a
    // relative path would work there and break for anyone who ran it elsewhere.
    markdown = await readImpl(new URL(`../${STATUS_DOCUMENT}`, import.meta.url), 'utf8');
  } catch (error) {
    return {
      allowed: false,
      detail: `${STATUS_DOCUMENT} is changed by this PR but could not be read (${error.message}), `
        + 'so the state the runner reads after this merge cannot be checked',
    };
  }

  return assessPostMergeRunnerState(
    parseStatusNow(markdown),
    parseMaintenanceQueue(markdown),
    pullRequest?.number,
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  await run();
}
