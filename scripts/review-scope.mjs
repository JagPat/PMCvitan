import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

import {
  assessReviewScope,
  PRE_REVIEW_ENFORCE_AFTER_PR,
  STATUS_DOCUMENT,
} from './review-efficiency.mjs';
import { correctionOwnerDeclaration, readHeadCommitMessage } from './correction-owner.mjs';
import {
  assessPostMergeRunnerState,
  parseMaintenanceQueue,
  parseStatusNow,
} from './autonomous-status-state.mjs';
import {
  assessCommittedDirectiveClearance,
  fileSystemReader,
  githubCommitReader,
  githubContentsReader,
  githubProvenanceReader,
} from './autonomous-drain-clearance.mjs';

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

// The exact head commit's message, read only for a PR whose body declares a CANDIDATE owner: scope admits
// that PR only when the head declares the same candidate. The bounded re-reads are the shared
// `readHeadCommitMessage` (correction-owner.mjs), the same one the controller uses.
async function headCommitMessage({ fetchImpl, repository, sha, token, sleep }) {
  if (typeof fetchImpl !== 'function' || !repository || !token || !/^[0-9a-f]{40}$/u.test(sha ?? '')) return undefined;
  return readHeadCommitMessage(async () => {
    const response = await fetchImpl(`https://api.github.com/repos/${repository}/commits/${sha}`, {
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${token}`,
        'x-github-api-version': '2022-11-28',
      },
    });
    if (!response.ok) return undefined;
    return (await response.json())?.commit?.message;
  }, sleep ? { sleep } : {});
}

export async function run({
  eventPath = process.env.GITHUB_EVENT_PATH,
  token = process.env.GITHUB_TOKEN,
  repository = process.env.GITHUB_REPOSITORY,
  fetchImpl = globalThis.fetch,
  listTreeImpl = trackedTreeEntries,
  sleep,
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
  const message = correctionOwnerDeclaration(event.pull_request).state === 'candidate'
    ? await headCommitMessage({
      fetchImpl,
      repository: repository || event.repository?.full_name,
      sha: event.pull_request.head?.sha,
      token,
      sleep,
    })
    : undefined;
  const result = assessReviewScope(event.pull_request, {
    changedFiles,
    requireChangedFiles: preReviewRequired,
    headCommitMessage: message,
  });
  console.log(
    `review-scope: ${result.state}; ${result.changedFiles} files, ${result.changedLines} changed lines`,
  );
  if (!result.allowed) {
    // An unread candidate head still fails closed, but as RETRYABLE: the controller re-runs this job on the
    // same head once its own read of that head succeeds (`ciFailureDisposition`), and does not draft the PR.
    const title = result.retryable ? 'Review preflight retryable' : 'Review preflight failed';
    console.error(`::error title=${title}::${result.detail}`);
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

  // The drain directive's clearance, checked HERE for the same reason: the PR tree is on disk, and the
  // STATUS diff text is already in hand; the BASE Now block is read from the base SHA through the API,
  // so the base and head VALUES decide, not the diff text alone. A PR whose head no longer carries
  // `phase-6-4d-previous-release-drained` is admitted only when it commits a `drained` verdict from
  // `rollout:drain-evidence` for the directive's minimum release (docs/POLICY.md; #686 findings
  // 4157323191, 4163577340, 4163577348). The controller re-runs this same check from the default
  // branch against the exact head before it permits merge (#686 finding 4163577352). Reported
  // independently, like the two checks above.
  const clearance = await assessCommittedDirectiveClearance(event.pull_request, changedFiles, {
    readHead: fileSystemReader(),
    readBase: githubContentsReader({
      fetchImpl,
      repository: repository || event.repository?.full_name,
      token,
      ref: event.pull_request.base?.sha,
    }),
    // the exact head commit: the record must be regenerated on the clearing head (#686 finding 4163934196)
    readHeadCommit: githubCommitReader({
      fetchImpl,
      repository: repository || event.repository?.full_name,
      token,
      sha: event.pull_request.head?.sha,
    }),
    // the trusted producer's artifact: the committed record must be byte-identical to it
    provenanceReader: githubProvenanceReader({
      fetchImpl,
      repository: repository || event.repository?.full_name,
      token,
    }),
    repository: repository || event.repository?.full_name,
  });
  if (clearance?.applies) {
    if (clearance.allowed) {
      console.log(`review-scope: drain directive clearance verified — ${clearance.detail}`);
    } else {
      console.error(`::error title=Drain directive clearance::${clearance.detail}`);
      process.exitCode = 1;
    }
  }

  // The cited work-item issue (owner, 2026-10-09, M3: one GitHub issue per work item), verified against the
  // repository: a cited number must be a real issue here. Reported independently, like the checks above. A
  // transient read only warns (#751 Codex 4230918008): failing here would draft the PR over a GitHub outage,
  // and the controller re-verifies the citation from the default branch before merge, where an unreadable
  // answer is retryable on the same head (autonomous-review-gate.mjs `enforceReviewScope`).
  const workItem = await verifyWorkItemIssue(event.pull_request?.body, {
    fetchImpl,
    repository: repository || event.repository?.full_name,
    token,
  });
  if (workItem?.retryable) {
    console.warn(`::warning title=Work item issue::${workItem.detail}; the controller re-verifies it before merge`);
  } else if (workItem) {
    console.error(`::error title=Work item issue::${workItem.detail}`);
    process.exitCode = 1;
  } else if (workItemIssueNumber(event.pull_request?.body) !== null) {
    console.log(`review-scope: work item issue #${workItemIssueNumber(event.pull_request?.body)} verified`);
  }

  // The tracked tree itself, checked HERE for the same reason: this is the one
  // job that runs BEFORE `pnpm install`, so it is the only place a packaging
  // defect can be named instead of reported five times as an install failure.
  const treeResult = assessTrackedTree(await listTreeImpl());
  if (treeResult.allowed) {
    console.log(`review-scope: tracked tree carries no dependency path (${treeResult.inspected} entries)`);
  } else {
    console.error(`::error title=Tracked tree::${treeResult.detail}`);
    process.exitCode = 1;
  }

  return { ...result, status: statusResult, clearance, tree: treeResult };
}

const DEPENDENCY_DIRECTORY = 'node_modules';
const SYMLINK_MODE = '120000';

/**
 * Every index entry of the checked-out tree, as `git ls-files --stage` reports
 * it — the MODE is the point: a symlink is `120000`, and a symlink is exactly
 * what the ignore rule `node_modules/` (directory-only) does not cover.
 *
 * Read from the repository this module lives in, not the working directory,
 * matching the STATUS read above.
 */
/** The issue number a PR body cites as its work item (`Work item issue: #N`), or null when it cites none. */
export function workItemIssueNumber(body) {
  return workItemIssueNumbers(body)[0] ?? null;
}

/** Every work-item issue number the body cites, in order (one per `Work item issue: #N` line). */
export function workItemIssueNumbers(body) {
  return workItemCitations(body).numbers;
}

/** Whether the body carries a work-item field at all — a readable citation or one this check refuses. */
export function citesWorkItem(body) {
  const { numbers, malformed } = workItemCitations(body);
  return numbers.length > 0 || malformed.length > 0;
}

// The field in any ordinary Markdown form: list markers (`-`, `*`, `+`, `1.`), quotes, headings, emphasis
// (#751 Codex 4232401607 and 4232566806).
const WORK_ITEM_FIELD = /^[^\S\n]*(?:(?:[-*+>]|\d+[.)]|#{1,6})[^\S\n]*)*[*_]*Work item issue:[*_]*[^\S\n]*#(\d+)\b/iu;
// A line that names the field AND carries a number or a link: it must be exactly one readable citation.
const WORK_ITEM_VALUED = /\bwork[^\w\n]+item[^\w\n]+issue\b.*(?:\d|https?:)/iu;

/**
 * The body's work-item citations. FAIL CLOSED by construction (#751 rounds 4-9): the parser does not model
 * Markdown rendering — every attempt to skip "examples" (fences, indented and nested code) opened a way for
 * a real citation to be skipped instead (Codex 4232706998). So only HTML comments, which GitHub never
 * renders, are ignored; every other line that names the field with a number or a link must be exactly one
 * `Work item issue: #N` field, or it is `malformed` and refused. An example in code is therefore verified or
 * refused like a citation — a visible, fixable rejection, never a silent bypass. A URL value
 * (Codex 4232707002), a second number on the line (4232642450) and any unknown form are malformed. The empty
 * template line names no number and cites nothing, so a citation stays optional.
 */
export function workItemCitations(body) {
  const numbers = [];
  const malformed = [];
  for (const line of String(body ?? '').replace(/<!--[\s\S]*?(?:-->|$)/gu, '').split('\n')) {
    const field = WORK_ITEM_FIELD.exec(line);
    const rest = field ? line.slice(field.index + field[0].length) : '';
    if (field && !/#\d|https?:/iu.test(rest)) numbers.push(Number(field[1]));
    else if (field || WORK_ITEM_VALUED.test(line)) malformed.push(line.trim());
  }
  return { numbers, malformed };
}

/**
 * The problem with a PR's cited work-item issue as `{ detail, retryable }`, or null when it cites none or the
 * citation is a real issue in this repository. #731's Codex 4214321797 — a made-up number must not satisfy the
 * syntax: the issue has to exist here and be an issue, not a pull request. An answer that could not be read
 * is `retryable` (#751 Codex 4230918008): the citation is unknown, not wrong, so no correction is owed.
 */
export async function verifyWorkItemIssue(body, { fetchImpl, repository, token }) {
  const { numbers, malformed } = workItemCitations(body);
  if (malformed.length > 0) {
    return { detail: `the body has a work-item field this check cannot read ("${malformed[0].slice(0, 60)}"); write it as \`- Work item issue: #N\``, retryable: false };
  }
  if (numbers.length === 0) return null;
  // one work item per PR: a second citation is refused outright, so a valid first one cannot mask an
  // invalid or stale second (#751 Codex 4231952204)
  if (numbers.length > 1) {
    return { detail: `the body cites ${numbers.length} work items (${numbers.map((n) => `#${n}`).join(', ')}); cite exactly one`, retryable: false };
  }
  const [number] = numbers;
  const unreadable = (reason) => ({ detail: `the cited work item #${number} could not be read (${reason})`, retryable: true });
  try {
    // `manual`: a transferred issue answers 301 to its new repository, and a followed redirect would accept an
    // issue that no longer belongs here (#751 Codex 4231455060)
    const response = await fetchImpl(`https://api.github.com/repos/${repository}/issues/${number}`, {
      redirect: 'manual',
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${token}`,
        'x-github-api-version': '2022-11-28',
      },
    });
    if (response.status === 404) return { detail: `the cited work item #${number} does not exist in ${repository}`, retryable: false };
    // permanent answers, never retried (#751 Codex 4231455047 and 4231455060): 410 is a deleted issue (or issues
    // disabled here), and a redirect is an issue transferred out of this repository
    if (response.status === 410) return { detail: `the cited work item #${number} was deleted from ${repository}`, retryable: false };
    if (response.status >= 300 && response.status < 400) {
      return { detail: `the cited work item #${number} was moved out of ${repository}`, retryable: false };
    }
    if (!response.ok) return unreadable(`HTTP ${response.status}`);
    const issue = await response.json();
    if (issue?.pull_request) return { detail: `the cited work item #${number} is a pull request, not an issue`, retryable: false };
    return null;
  } catch (error) {
    return unreadable(error?.message ?? String(error));
  }
}

export async function trackedTreeEntries(execImpl = promisify(execFile)) {
  const { stdout } = await execImpl('git', ['ls-files', '--stage', '-z'], {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    maxBuffer: 64 * 1024 * 1024,
  });
  return parseTrackedTree(stdout);
}

export function parseTrackedTree(stdout) {
  return String(stdout)
    .split('\0')
    .filter((record) => record.length > 0)
    .map((record) => {
      const tab = record.indexOf('\t');
      const [mode] = record.slice(0, tab).split(' ');
      return { mode, path: record.slice(tab + 1) };
    });
}

/**
 * No tracked path may have a `node_modules` component, whatever its mode.
 *
 * PR #572 head `e2fd243e` carried a root `node_modules` SYMLINK (mode 120000,
 * pointing at one developer's absolute workspace path): `.gitignore` said
 * `node_modules/`, which matches only a directory, so `git add -A` staged it
 * without complaint. On the runner the checkout materialised a dangling link and
 * every `pnpm install --frozen-lockfile` died with ENOTDIR — five jobs, twice,
 * before a single product test ran. The ignore rule is now `node_modules` (any
 * type, any depth); this check is the tripwire behind it, for a `git add -f`
 * or an ignore rule edited back, and it names the cause in the one job that
 * runs before install.
 *
 * Exact component match: `docs/node_modules-notes.md` is not a dependency path.
 */
export function assessTrackedTree(entries) {
  if (!Array.isArray(entries)) {
    return {
      allowed: false,
      inspected: 0,
      detail: 'the tracked tree could not be listed, so a committed dependency path cannot be ruled out',
    };
  }
  const offenders = entries.filter((entry) =>
    String(entry?.path ?? '').split('/').includes(DEPENDENCY_DIRECTORY));
  if (offenders.length === 0) {
    return { allowed: true, inspected: entries.length, offenders: [] };
  }
  const named = offenders.slice(0, 5).map((entry) =>
    `${entry.path}${entry.mode === SYMLINK_MODE ? ' (symlink)' : ''}`);
  const more = offenders.length > named.length ? ` and ${offenders.length - named.length} more` : '';
  return {
    allowed: false,
    inspected: entries.length,
    offenders,
    detail: `${offenders.length} tracked path(s) under a \`${DEPENDENCY_DIRECTORY}\` component: `
      + `${named.join(', ')}${more}. A checkout materialises them on every runner and `
      + '`pnpm install` fails with ENOTDIR before any product test runs; remove them from the '
      + 'index (`git rm --cached`) — never change the application Node version for this.',
  };
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
