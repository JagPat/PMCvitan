import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { isAutonomousPullRequest, handOffConflict } from './autonomous-handoff.mjs';

const repository = 'JagPat/PMCvitan';

function pullRequest(overrides = {}) {
  return {
    state: 'open',
    head: { ref: 'claude/task', repo: { full_name: repository } },
    base: { ref: 'main', repo: { full_name: repository } },
    ...overrides,
  };
}

// The exact HEAD commit the conflict handoff reads to confirm the body owner before waking one
// (finding r4032740389). By default the trailer agrees with the PR body marker (the healthy case).
const BODY_OWNER_RE = /<!--\s*correction-owner:\s*([a-z]+)\s*-->/u;
function commitFor(pull) {
  const owner = BODY_OWNER_RE.exec(pull?.body ?? '')?.[1];
  const message = owner ? `chore: unit\n\nCorrection-Owner: ${owner}\n` : 'chore: unit with no trailer\n';
  return { sha: pull?.head?.sha, commit: { message } };
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
    commit: async () => commitFor(live),
    comments: async () => [],
    comment: async (number, body) => comments.push(body),
  }, live, repository, 'main');
  assert.equal(comments.length, 1);
  assert.match(comments[0], /@claude/u);
});

test('a conflict wake is withheld when the head trailer disagrees with a claude body', async () => {
  // finding r4032740389: the editable body marker cannot authorize a wake on its own. Here the body
  // declares claude but the immutable head trailer names cursor — the head is not routable, so no
  // @claude wake is posted; the notice is stalled and names the trailer remedy.
  const live = conflict();
  const comments = [];
  await handOffConflict({
    pullRequest: async () => live,
    commit: async () => ({ sha: live.head.sha, commit: { message: 'x\n\nCorrection-Owner: cursor\n' } }),
    comments: async () => [],
    comment: async (number, body) => comments.push(body),
  }, live, repository, 'main');
  assert.equal(comments.length, 1);
  assert.doesNotMatch(comments[0], /@claude/u, 'the body owner is not woken on a disagreeing head');
  assert.match(comments[0], /correction_stalled/u);
  assert.match(comments[0], /Correction-Owner/u, 'and it names the trailer that must be pushed');
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
    commit: async () => commitFor(live),
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
