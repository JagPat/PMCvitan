import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  isAutonomousPullRequest,
  handOffConflict,
  handOffStatusDrift,
} from './autonomous-handoff.mjs';

const repository = 'JagPat/PMCvitan';

function pullRequest(overrides = {}) {
  return {
    state: 'open',
    head: { ref: 'claude/task', repo: { full_name: repository } },
    base: { ref: 'main', repo: { full_name: repository } },
    ...overrides,
  };
}

function conflict(overrides = {}) {
  return pullRequest({
    number: 600,
    body: '<!-- correction-owner: claude -->',
    mergeable: false,
    mergeable_state: 'dirty',
    head: { ref: 'claude/task', sha: 'a'.repeat(40), repo: { full_name: repository } },
    ...overrides,
  });
}

test('conflict handoff uses the refreshed owner instead of waking the branch-prefix agent', async () => {
  for (const owner of ['codex', 'cursor', 'unknown', null]) {
    const live = conflict({ body: owner ? `<!-- correction-owner: ${owner} -->` : '' });
    const comments = [];
    await handOffConflict({
      pullRequest: async () => live,
      comments: async () => [],
      comment: async (number, body) => comments.push(body),
    }, conflict(), repository, 'main');
    assert.equal(comments.length, 1);
    assert.doesNotMatch(comments[0], /@claude|@codex|@cursor/u);
    assert.match(comments[0], /correction_stalled/u);
  }
});

test('a valid Claude owner is awakened for a conflict on a non-Claude branch', async () => {
  const live = conflict({ head: { ref: 'codex/maintenance', sha: 'a'.repeat(40), repo: { full_name: repository } } });
  const comments = [];
  await handOffConflict({
    pullRequest: async () => live,
    comments: async () => [],
    comment: async (number, body) => comments.push(body),
  }, live, repository, 'main');
  assert.equal(comments.length, 1);
  assert.match(comments[0], /@claude/u);
});

test('conflict publication stops if the owner changes during the comments read', async () => {
  const live = conflict();
  let current = live;
  const comments = [];
  await handOffConflict({
    pullRequest: async () => current,
    comments: async () => { current = { ...live, body: '<!-- correction-owner: codex -->' }; return []; },
    comment: async (number, body) => comments.push(body),
  }, live, repository, 'main');
  assert.equal(comments.length, 0);
});

test('conflict notices are idempotent per head and owner, and an owner fix can resume', async () => {
  let live = conflict({ body: '<!-- correction-owner: codex -->' });
  const comments = [];
  const client = {
    pullRequest: async () => live,
    comments: async () => comments,
    comment: async (number, body) => comments.push({ user: { login: 'github-actions[bot]' }, body }),
  };
  await handOffConflict(client, live, repository, 'main');
  await handOffConflict(client, live, repository, 'main');
  assert.equal(comments.length, 1);
  live = { ...live, body: '<!-- correction-owner: claude -->' };
  await handOffConflict(client, live, repository, 'main');
  await handOffConflict(client, live, repository, 'main');
  assert.equal(comments.length, 2);
  assert.match(comments[1].body, /@claude/u);
});

test('conflict publication stops after closure, retargeting, or a new head', async () => {
  const initial = conflict();
  for (const changed of [
    { ...initial, state: 'closed' },
    { ...initial, base: { ...initial.base, ref: 'release' } },
    { ...initial, base: { ...initial.base, sha: 'b'.repeat(40) } },
    { ...initial, head: { ...initial.head, sha: 'b'.repeat(40) } },
    { ...initial, head: { ...initial.head, repo: { full_name: 'fork/repo' } } },
  ]) {
    let live = initial;
    await handOffConflict({
      pullRequest: async () => live,
      comments: async () => { live = changed; return []; },
      comment: async () => assert.fail('must not publish after the review unit changes'),
    }, initial, repository, 'main');
  }
});

test('accepts only open same-repository Claude branches', () => {
  assert.equal(isAutonomousPullRequest(pullRequest(), repository, 'main'), true);
  assert.equal(
    isAutonomousPullRequest(pullRequest({ state: 'closed' }), repository, 'main'),
    false,
  );
  assert.equal(
    isAutonomousPullRequest(
      pullRequest({ head: { ref: 'feature/task', repo: { full_name: repository } } }),
      repository,
      'main',
    ),
    false,
  );
  assert.equal(
    isAutonomousPullRequest(
      pullRequest({ head: { ref: 'claude/task', repo: { full_name: 'fork/repo' } } }),
      repository,
      'main',
    ),
    false,
  );
  assert.equal(
    isAutonomousPullRequest(
      pullRequest({ base: { ref: 'release', repo: { full_name: repository } } }),
      repository,
      'main',
    ),
    false,
  );
});

test('handoff workflow is event-driven and runs trusted default-branch code', async () => {
  const workflow = await readFile(
    new URL('../.github/workflows/autonomous-handoff.yml', import.meta.url),
    'utf8',
  );

  assert.match(workflow, /pull_request_target:/);
  assert.match(workflow, /push:/);
  assert.match(workflow, /wait_for_pr:/);
  assert.match(workflow, /branches:\s*\[main\]/);
  assert.match(workflow, /ref:\s*\$\{\{ github\.event\.repository\.default_branch \}\}/);
  assert.match(workflow, /persist-credentials:\s*false/);
  assert.match(workflow, /scripts\/autonomous-handoff\.mjs/);
  assert.match(workflow, /schedule:/);
  assert.match(workflow, /cron:\s*'17 \* \* \* \*'/);
  assert.match(workflow, /group:\s*autonomous-handoff/);
  assert.match(workflow, /cancel-in-progress:\s*false/);
});

test('handoff implementation covers both conflicts and behind-base states', async () => {
  const implementation = await readFile(
    new URL('./autonomous-handoff.mjs', import.meta.url),
    'utf8',
  );

  assert.match(implementation, /live\.mergeable !== false/);
  assert.match(implementation, /live\.mergeable_state !== 'behind'/);
  assert.match(implementation, /while \(live\.mergeable === null/);
  assert.match(implementation, /MERGEABILITY_TIMEOUT_MS/);
  assert.match(implementation, /pullRequest\?\.base\?\.ref !== defaultBranch/);
  assert.match(implementation, /mergedPullRequestsAfter/);
  assert.match(implementation, /HANDOFF_ENABLED_AT/);
  assert.match(implementation, /liveMergedPullRequest/);
  assert.match(implementation, /STATE_ISSUE_NUMBER/);
  assert.match(implementation, /dispatchRetry/);
  assert.match(implementation, /waitForTerminalPullRequest/);
  assert.match(implementation, /event\.inputs\?\.wait_for_pr/);
  assert.match(implementation, /ACTIONS_BOT_LOGIN/);
  assert.match(implementation, /combinedStatus/);
  assert.match(implementation, /codex-current-head/);
  assert.match(implementation, /comments\?per_page=100&page=\$\{page\}/);
  assert.match(implementation, /buildPostMergeContinuation/);
  assert.match(implementation, /handOffStatusDrift/);
  assert.match(implementation, /eventName === 'schedule'/);
  assert.match(implementation, /DRIFT_MARKER/);
  assert.doesNotMatch(implementation, /if \(eventName === 'pull_request_target'\)/);
});

test('an open queued-merge wait drains durable work before it reschedules', async () => {
  const implementation = await readFile(
    new URL('./autonomous-handoff.mjs', import.meta.url),
    'utf8',
  );
  const waitStart = implementation.indexOf(
    'const waitForPullRequest = Number',
  );
  const backlogStart = implementation.indexOf(
    'const cursor = await client.runnerCursor()',
  );
  const retryStart = implementation.indexOf(
    'if (retryWaitForPullRequest || retryNeeded)',
  );

  assert.ok(waitStart >= 0);
  assert.ok(backlogStart > waitStart);
  assert.ok(retryStart > backlogStart);
  assert.doesNotMatch(
    implementation.slice(waitStart, backlogStart),
    /dispatchRetry|\breturn;/,
  );
});

// Board decision, #482 comment 6330461745 item 1: at most one conflict ping per PR per head,
// and none while merges to main are still settling. The dedupe is the marker comment itself.
function markerClient(initial) {
  const state = { live: initial, comments: [] };
  state.client = {
    pullRequest: async () => state.live,
    comments: async () => state.comments,
    comment: async (number, body) => state.comments.push({ user: { login: 'github-actions[bot]' }, body }),
  };
  return state;
}

test('a conflict ping is not repeated on the same head, and a new head gets one new ping', async () => {
  const state = markerClient(conflict());
  const settled = { clock: () => Date.parse('2026-10-22T12:00:00Z'), lastBaseMergeAt: Date.parse('2026-10-22T10:00:00Z') };
  await handOffConflict(state.client, state.live, repository, 'main', settled);
  await handOffConflict(state.client, state.live, repository, 'main', settled);
  assert.equal(state.comments.length, 1);
  state.live = conflict({ head: { ref: 'claude/task', sha: 'b'.repeat(40), repo: { full_name: repository } } });
  await handOffConflict(state.client, state.live, repository, 'main', settled);
  await handOffConflict(state.client, state.live, repository, 'main', settled);
  assert.equal(state.comments.length, 2);
  assert.match(state.comments[1].body, /autonomous-conflict:b{40}:/u);
  assert.match(state.comments[1].body, /@claude/u, 'the action-required ping keeps its tag');
});

test('no conflict ping while main merged inside the settle window; a later run pings', async () => {
  const state = markerClient(conflict());
  const lastBaseMergeAt = Date.parse('2026-10-22T12:00:00Z');
  for (const minutes of [0, 10, 29]) {
    await handOffConflict(state.client, state.live, repository, 'main', {
      lastBaseMergeAt, clock: () => lastBaseMergeAt + minutes * 60_000,
    });
  }
  assert.equal(state.comments.length, 0, 'merges to main are still settling');
  await handOffConflict(state.client, state.live, repository, 'main', {
    lastBaseMergeAt, clock: () => lastBaseMergeAt + 31 * 60_000,
  });
  assert.equal(state.comments.length, 1);
  assert.match(state.comments[0].body, /@claude/u);
});

test('every handoff run passes the last default-branch merge time to the conflict ping', async () => {
  const implementation = await readFile(new URL('./autonomous-handoff.mjs', import.meta.url), 'utf8');
  assert.match(implementation, /handOffConflict\(client, pullRequest, repository, defaultBranch, \{ lastBaseMergeAt \}\)/u);
});

// Codex r4344002054: the tip time read at the start of the run can be stale by the time a ping
// is published, because merges run in another concurrency group. The final decision re-reads it.
test('a merge to main during the run defers the conflict ping at publication time', async () => {
  const state = markerClient(conflict());
  const at = Date.now();
  let reads = 0;
  state.client.lastCommitAt = async () => { reads += 1; return at - 5 * 60_000; };
  await handOffConflict(state.client, state.live, repository, 'main', {
    lastBaseMergeAt: at - 2 * 60 * 60_000, clock: () => at,
  });
  assert.equal(state.comments.length, 0, 'the fresh read saw a merge inside the window');
  assert.equal(reads, 1);
  state.client.lastCommitAt = async () => null;
  await handOffConflict(state.client, state.live, repository, 'main', {
    lastBaseMergeAt: at - 2 * 60 * 60_000, clock: () => at,
  });
  assert.equal(state.comments.length, 1, 'an unreadable tip time still pings');
});

// Codex r4344002062: the wake tag on a post-merge or drift note is decided from a live read of
// open PRs, not the run's snapshot. An unreadable list wakes.
const idleStatus = { task_state: 'in_review', open_pr: '700', task: '4', work_item: 'none',
  next_task: 'none', blocking_directive: 'none' };
const snapshotOpen = [conflict({ number: 701, mergeable: true, mergeable_state: 'clean' })];

function noteClient(liveOpen) {
  const posted = [];
  return {
    posted,
    openPullRequests: async () => { if (liveOpen instanceof Error) throw liveOpen; return liveOpen; },
    comments: async () => [],
    comment: async (number, body) => posted.push(body),
    combinedStatus: async () => ({ statuses: [{ context: 'codex-current-head', state: 'success' }] }),
    fileContent: async () => null,
  };
}

test('a post-merge note wakes when the last open PR closed after the snapshot, or the list is unreadable', async () => {
  const merged = pullRequest({ number: 690, state: 'closed', merged: true, merge_commit_sha: 'c'.repeat(40),
    head: { ref: 'claude/task', sha: 'd'.repeat(40), repo: { full_name: repository } } });
  const { handOffMergedPullRequest } = await import('./autonomous-handoff.mjs');
  assert.equal(typeof handOffMergedPullRequest, 'function', 'the post-merge publisher is exported for this probe');
  const context = { defaultBranchNow: idleStatus, maintenanceQueue: [], openPullRequests: snapshotOpen, headStatuses: [] };
  for (const [liveOpen, tagged] of [[[], true], [new Error('GitHub 502'), true], [snapshotOpen, false]]) {
    const client = noteClient(liveOpen);
    await handOffMergedPullRequest(client, merged, repository, 'main', context);
    assert.equal(client.posted.length, 1);
    assert.equal(/^<!--[^\n]*-->\n@claude /u.test(client.posted[0]), tagged, String(liveOpen));
  }
});

test('a drift note wakes when the last open PR closed after the snapshot, or the list is unreadable', async () => {
  const context = { defaultBranchNow: idleStatus, maintenanceQueue: [], openPullRequests: snapshotOpen, headStatuses: [] };
  for (const [liveOpen, tagged] of [[[], true], [new Error('GitHub 502'), true], [snapshotOpen, false]]) {
    const client = noteClient(liveOpen);
    await handOffStatusDrift(client, repository, 'main', context);
    assert.equal(client.posted.length, 1);
    assert.equal(/^<!--[^\n]*-->\n@claude /u.test(client.posted[0]), tagged, String(liveOpen));
  }
});
