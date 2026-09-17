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

// --- F1 merged-backlog reconciliation (Unit B) ---------------------------------------------------
import { handOffMergedPullRequest } from './autonomous-handoff.mjs';
import { MERGE_RECOVERY_OWED, STATUS_CONTEXT } from './review-policy.mjs';

const mergeSha = 'm'.repeat(40);
const mergedPr = () => ({
  number: 700,
  merged: true,
  merge_commit_sha: mergeSha,
  head: { ref: 'claude/task', sha: 'a'.repeat(40), repo: { full_name: repository } },
  base: { ref: 'main', repo: { full_name: repository } },
});
const continuation = () => ({
  defaultBranchNow: { open_pr: 'none', task_state: 'merged' },
  maintenanceQueue: [],
  openPullRequests: [],
  headStatuses: [],
});
function mergedClient({ latest, history = [], comments = [] } = {}) {
  const posted = [];
  return {
    posted,
    async combinedStatus() { return { statuses: latest ? [{ context: STATUS_CONTEXT, ...latest }] : [] }; },
    async statuses() { return history; },
    async comments() { return comments; },
    async comment(number, body) { posted.push({ number, body }); },
    async fileContent() { return null; },
  };
}

test('merged-backlog: a clean success head hands off exactly one continuation', async () => {
  const client = mergedClient({ latest: { state: 'success' } });
  await handOffMergedPullRequest(client, mergedPr(), repository, 'main', continuation());
  assert.equal(client.posted.length, 1);
  assert.match(client.posted[0].body, new RegExp(`autonomous-post-merge:${mergeSha}`, 'u'));
});

test('merged-backlog: MERGE_RECOVERY_OWED with prior exact-head clean evidence reconciles to one handoff', async () => {
  const client = mergedClient({
    latest: { state: 'failure', description: MERGE_RECOVERY_OWED },
    history: [
      { context: STATUS_CONTEXT, state: 'failure', description: MERGE_RECOVERY_OWED },
      { context: STATUS_CONTEXT, state: 'success', description: 'review: Codex found no blocking issue on this exact head' },
    ],
  });
  await handOffMergedPullRequest(client, mergedPr(), repository, 'main', continuation());
  assert.equal(client.posted.length, 1, 'a lost-response merge on a prior-clean head is reconciled');
});

test('merged-backlog: MERGE_RECOVERY_OWED without prior clean evidence is never reinterpreted as clearance', async () => {
  const client = mergedClient({
    latest: { state: 'failure', description: MERGE_RECOVERY_OWED },
    history: [{ context: STATUS_CONTEXT, state: 'failure', description: MERGE_RECOVERY_OWED }],
  });
  await handOffMergedPullRequest(client, mergedPr(), repository, 'main', continuation());
  assert.equal(client.posted.length, 0, 'no prior success means no clearance — skip');
});

test('merged-backlog: a genuine finding failure never hands off', async () => {
  const client = mergedClient({
    latest: { state: 'failure', description: 'review: current-head Codex finding' },
    history: [{ context: STATUS_CONTEXT, state: 'success', description: 'review: clean' }],
  });
  await handOffMergedPullRequest(client, mergedPr(), repository, 'main', continuation());
  assert.equal(client.posted.length, 0, 'only the exact MERGE_RECOVERY_OWED marker reconciles');
});

test('merged-backlog: reconciliation is idempotent — an existing merge marker blocks a second handoff', async () => {
  const client = mergedClient({
    latest: { state: 'failure', description: MERGE_RECOVERY_OWED },
    history: [{ context: STATUS_CONTEXT, state: 'success', description: 'review: clean' }],
    comments: [{ user: { login: 'github-actions[bot]' }, body: `<!-- autonomous-post-merge:${mergeSha} -->` }],
  });
  await handOffMergedPullRequest(client, mergedPr(), repository, 'main', continuation());
  assert.equal(client.posted.length, 0, 'the merge-marker comment guards against a double continuation');
});

test('run() drain: a lost-read merge retains the cursor and blocks later items; a later run reconciles once, never repeating', async () => {
  // Executable liveness boundary: drive the ACTUAL exported run() with a bounded global fetch mock.
  // Backlog (after cursor, by merged_at): #700 recovery-owed on a prior-clean head, #701 clean
  // success, #702 a genuine current-head finding, #703 recovery-owed with a finding BURIED between
  // its older clean success and the owed marker. #700's confirming read fails on the first run.
  const { mkdtempSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { run } = await import('./autonomous-handoff.mjs');

  const eventPath = join(mkdtempSync(join(tmpdir(), 'handoff-run-')), 'event.json');
  writeFileSync(eventPath, JSON.stringify({ repository: { default_branch: 'main' } }));
  const savedFetch = globalThis.fetch;
  const savedEnv = { ...process.env };
  process.env.GITHUB_EVENT_NAME = 'workflow_run';
  process.env.GITHUB_EVENT_PATH = eventPath;
  process.env.GITHUB_REPOSITORY = repository;
  process.env.GITHUB_TOKEN = 'test-token';

  const CURSOR_CTX = '<!-- autonomous-runner-state -->';
  let cursor = { at: '2026-09-01T00:00:00Z', number: 0 };
  let pr700Readable = false;
  const posted = { 700: 0, 701: 0, 702: 0, 703: 0 };
  const hasMarker = { 700: false, 701: false, 702: false, 703: false };
  const backlog = [
    { number: 700, merged_at: '2026-09-17T00:01:00Z', updated_at: '2026-09-17T00:01:00Z' },
    { number: 701, merged_at: '2026-09-17T00:02:00Z', updated_at: '2026-09-17T00:02:00Z' },
    { number: 702, merged_at: '2026-09-17T00:03:00Z', updated_at: '2026-09-17T00:03:00Z' },
    { number: 703, merged_at: '2026-09-17T00:04:00Z', updated_at: '2026-09-17T00:04:00Z' },
  ];
  const heads = { 700: 'a'.repeat(40), 701: 'b'.repeat(40), 702: 'c'.repeat(40), 703: 'd'.repeat(40) };
  const mergeShas = { 700: '7'.repeat(40), 701: '8'.repeat(40), 702: '9'.repeat(40), 703: 'e'.repeat(40) };
  const prBody = (n) => ({
    number: n, merged: true, merge_commit_sha: mergeShas[n],
    head: { ref: 'claude/task', sha: heads[n], repo: { full_name: repository } },
    base: { ref: 'main', repo: { full_name: repository } },
  });
  const combined = {
    [heads[700]]: { state: 'failure', description: MERGE_RECOVERY_OWED },
    [heads[701]]: { state: 'success', description: 'review: clean' },
    [heads[702]]: { state: 'failure', description: 'review: current-head Codex finding' },
    [heads[703]]: { state: 'failure', description: MERGE_RECOVERY_OWED },
  };
  const history = {
    [heads[700]]: [
      { context: STATUS_CONTEXT, state: 'failure', description: MERGE_RECOVERY_OWED },
      { context: STATUS_CONTEXT, state: 'success', description: 'review: clean' },
    ],
    [heads[701]]: [{ context: STATUS_CONTEXT, state: 'success', description: 'review: clean' }],
    [heads[702]]: [{ context: STATUS_CONTEXT, state: 'failure', description: 'review: finding' }],
    [heads[703]]: [
      { context: STATUS_CONTEXT, state: 'failure', description: MERGE_RECOVERY_OWED },
      { context: STATUS_CONTEXT, state: 'failure', description: 'review: current-head Codex finding' },
      { context: STATUS_CONTEXT, state: 'success', description: 'review: clean' },
    ],
  };
  const ok = (value) => ({ ok: true, status: 200, text: async () => JSON.stringify(value) });

  globalThis.fetch = async (urlString, options = {}) => {
    const url = new URL(urlString);
    const path = url.pathname;
    const method = options.method ?? 'GET';
    const page = url.searchParams.get('page') ?? '1';
    if (path.endsWith('/issues/235') && method === 'GET') {
      return ok({ body: `${CURSOR_CTX}\nLast processed merge: \`${cursor.at}\` (#${cursor.number})` });
    }
    if (path.endsWith('/issues/235') && method === 'PATCH') {
      const m = JSON.parse(options.body).body.match(/Last processed merge: `([^`]+)` \(#(\d+)\)/);
      cursor = { at: m[1], number: Number(m[2]) };
      return ok({});
    }
    if (path.endsWith('/pulls') && url.searchParams.get('state') === 'open') return ok([]);
    if (path.endsWith('/pulls') && url.searchParams.get('state') === 'closed') {
      if (page !== '1') return ok([]);
      const cursorAt = Date.parse(cursor.at);
      return ok(backlog.filter((p) => Date.parse(p.merged_at) >= cursorAt).map((p) => ({ ...p, ...prBody(p.number) })));
    }
    const prMatch = path.match(/\/pulls\/(\d+)$/);
    if (prMatch && method === 'GET') {
      const n = Number(prMatch[1]);
      if (n === 700 && !pr700Readable) return { ok: false, status: 502, text: async () => 'bad gateway' };
      return ok(prBody(n));
    }
    const statusMatch = path.match(/\/commits\/([0-9a-f]+)\/status$/);
    if (statusMatch) return ok({ statuses: [{ context: STATUS_CONTEXT, ...combined[statusMatch[1]] }] });
    const histMatch = path.match(/\/statuses\/([0-9a-f]+)$/);
    if (histMatch) return page === '1' ? ok(history[histMatch[1]] ?? []) : ok([]);
    const commentsGet = path.match(/\/issues\/(\d+)\/comments$/);
    if (commentsGet && method === 'GET') {
      const n = Number(commentsGet[1]);
      if (page !== '1') return ok([]);
      return ok(hasMarker[n]
        ? [{ user: { login: 'github-actions[bot]' }, body: `<!-- autonomous-post-merge:${mergeShas[n]} -->` }]
        : []);
    }
    if (commentsGet && method === 'POST') {
      const n = Number(commentsGet[1]);
      posted[n] += 1;
      hasMarker[n] = true;
      return ok({ id: 1 });
    }
    throw new Error(`unexpected ${method} ${path}`);
  };

  try {
    await run(); // Run 1: #700 read fails → loop breaks, cursor unchanged, nothing handed off.
    assert.deepEqual(posted, { 700: 0, 701: 0, 702: 0, 703: 0 }, 'no handoff while the first merge is unresolved');
    assert.equal(cursor.number, 0, 'the cursor is not advanced past the unresolved gap');

    // Run 2: #700 now readable → reconcile+handoff; #701 clean → handoff; #702 finding → skip;
    // #703 recovery-owed but with a finding buried behind its stale clean success → skip.
    pr700Readable = true;
    await run();
    assert.equal(posted[700], 1, 'recovery-owed head with prior clean evidence reconciles to one handoff');
    assert.equal(posted[701], 1, 'the clean success head hands off');
    assert.equal(posted[702], 0, 'a genuine finding is never reinterpreted as clearance');
    assert.equal(posted[703], 0, 'a clean success across an intervening finding never clears recovery');
    assert.equal(cursor.number, 703, 'the cursor advances to the last resolved merge');

    await run(); // nothing repeats — the merge markers dedup, no second handoff.
    assert.deepEqual(posted, { 700: 1, 701: 1, 702: 0, 703: 0 }, 'a completed handoff never repeats');
  } finally {
    globalThis.fetch = savedFetch;
    process.env = savedEnv;
  }
});
