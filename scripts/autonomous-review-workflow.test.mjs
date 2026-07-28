import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';

import * as reviewGate from './autonomous-review-gate.mjs';

const {
  hasTerminalReviewFailureAfterPending,
  MAX_REVIEW_ATTEMPTS,
  REQUIRED_CHECKS,
  summarizeRequiredChecks,
} = reviewGate;

const workflowPath = new URL('../.github/workflows/auto-merge.yml', import.meta.url);
const ciPath = new URL('../.github/workflows/ci.yml', import.meta.url);
const autonomousLoopPath = new URL('../docs/AUTONOMOUS_LOOP.md', import.meta.url);

function checkRun(name, conclusion = 'success', status = 'completed') {
  return { name, conclusion, status };
}

function deferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function statusClient(statuses) {
  let nextId = 1_000;
  return {
    async setStatus(head, state, description, targetUrl, context) {
      const status = {
        id: nextId,
        context,
        state,
        description,
        target_url: targetUrl,
        sha: head,
      };
      nextId += 1;
      statuses.unshift(status);
      return status;
    },
  };
}

test('requires every named CI check to have a successful latest run', () => {
  const success = REQUIRED_CHECKS.map((name) => checkRun(name));
  assert.deepEqual(summarizeRequiredChecks(success), {
    state: 'success',
    missing: [],
    pending: [],
    failed: [],
  });

  assert.deepEqual(summarizeRequiredChecks(success.slice(1)), {
    state: 'pending',
    missing: ['web'],
    pending: [],
    failed: [],
  });

  assert.deepEqual(
    summarizeRequiredChecks([
      ...success.filter((run) => run.name !== 'api'),
      checkRun('api', 'failure'),
    ]),
    {
      state: 'failure',
      missing: [],
      pending: [],
      failed: ['api'],
    },
  );
});

test('keeps the Codex trigger retry bounded', () => {
  assert.equal(MAX_REVIEW_ATTEMPTS, 2);
});

test('only CI completion or exact-head dispatch can own a review cycle', () => {
  assert.equal(typeof reviewGate.contextForEvent, 'function');
  const head = 'a'.repeat(40);
  const pullRequest = { number: 230, head: { sha: head } };
  const codex = { login: 'chatgpt-codex-connector[bot]' };

  assert.equal(
    reviewGate.contextForEvent('pull_request_review', {
      action: 'submitted',
      pull_request: pullRequest,
      review: { user: codex, commit_id: head },
    }),
    null,
  );
  assert.equal(
    reviewGate.contextForEvent('pull_request_review_comment', {
      action: 'created',
      pull_request: pullRequest,
      comment: {
        user: codex,
        commit_id: head,
        original_commit_id: head,
      },
    }),
    null,
  );
  assert.equal(
    reviewGate.contextForEvent('pull_request_review', {
      action: 'submitted',
      pull_request: pullRequest,
      review: { user: codex, commit_id: 'b'.repeat(40) },
    }),
    null,
  );
  assert.equal(
    reviewGate.contextForEvent('pull_request_review_comment', {
      action: 'created',
      pull_request: pullRequest,
      comment: {
        user: { login: 'human-reviewer' },
        original_commit_id: head,
      },
    }),
    null,
  );
  assert.deepEqual(
    reviewGate.contextForEvent('workflow_dispatch', {
      inputs: {
        pr_number: '230',
        head_sha: head,
        terminal_status_id: '987654321',
      },
    }),
    {
      number: 230,
      expectedHead: head,
      terminalStatusId: '987654321',
      ciConclusion: null,
      trigger: 'dispatch',
    },
  );
  assert.deepEqual(
    reviewGate.contextForEvent('workflow_run', {
      workflow_run: {
        event: 'pull_request',
        pull_requests: [{ number: 230 }],
        head_sha: head,
        conclusion: 'success',
      },
    }),
    {
      number: 230,
      expectedHead: head,
      ciConclusion: 'success',
      trigger: 'ci',
    },
  );
});

test('a CI rerun cannot reopen a terminal review cycle on the same head', () => {
  assert.equal(typeof reviewGate.isTerminalReviewStatus, 'function');
  assert.equal(
    reviewGate.isTerminalReviewStatus({
      state: 'failure',
      description: 'review: 3 current-head Codex findings',
    }),
    true,
  );
  assert.equal(
    reviewGate.isTerminalReviewStatus({
      state: 'failure',
      description: '11 current-head Codex findings',
    }),
    true,
  );
  assert.equal(
    reviewGate.isTerminalReviewStatus({
      state: 'failure',
      description: 'Codex submitted a current-head review',
    }),
    true,
  );
  assert.equal(
    reviewGate.isTerminalReviewStatus({
      state: 'success',
      description: 'review: Codex found no blocking issue',
    }),
    true,
  );
  assert.equal(
    reviewGate.isTerminalReviewStatus({
      state: 'failure',
      description: 'ci: api-e2e failed',
    }),
    false,
  );
  assert.equal(
    reviewGate.isTerminalReviewStatus({
      state: 'pending',
      description: 'Waiting for Codex',
    }),
    false,
  );
});

test('a failed CI rerun preserves readiness after a terminal review success', () => {
  assert.equal(typeof reviewGate.shouldDraftForCiFailure, 'function');
  assert.equal(
    reviewGate.shouldDraftForCiFailure({
      state: 'success',
      description: 'review: Codex found no blocking issue',
    }),
    false,
  );
  assert.equal(
    reviewGate.shouldDraftForCiFailure({
      state: 'failure',
      description: 'review: 1 current-head Codex finding',
    }),
    true,
  );
  assert.equal(
    reviewGate.shouldDraftForCiFailure({
      state: 'failure',
      description: 'ci: api failed',
    }),
    true,
  );
});

test('a buried clean verdict cannot promote a draft without a fresh polled review', async () => {
  const expectedHead = 'a'.repeat(40);
  const cleanStatus = {
    id: 301,
    context: 'codex-current-head',
    state: 'success',
    description: 'review: Codex found no blocking issue on this exact head',
  };
  const statuses = [
    {
      id: 303,
      context: 'codex-current-head',
      state: 'failure',
      description: 'ci: api-e2e failed',
    },
    {
      id: 302,
      context: 'codex-current-head',
      state: 'pending',
      description: 'Waiting for required CI before Codex review',
    },
    cleanStatus,
  ];
  const pullRequest = {
    number: 230,
    state: 'open',
    draft: true,
    head: { sha: expectedHead },
    html_url: 'https://github.com/JagPat/PMCvitan/pull/230',
  };
  const draftTransitions = [];
  const statusWrites = [];
  let autoMergeDraft = null;
  const client = {
    async pullRequest() {
      return pullRequest;
    },
    async setDraft(current, draft) {
      draftTransitions.push(draft);
      current.draft = draft;
      return current;
    },
    async setStatus(head, state, description) {
      statusWrites.push({ head, state, description });
    },
    async enableAutoMerge(current) {
      autoMergeDraft = current.draft;
    },
  };

  assert.equal(
    await reviewGate.ensureTerminalReviewState(
      client,
      pullRequest,
      expectedHead,
      cleanStatus,
      statuses,
    ),
    false,
  );
  assert.deepEqual(draftTransitions, []);
  assert.equal(autoMergeDraft, null);
  assert.deepEqual(statusWrites, []);

  pullRequest.draft = false;
  assert.equal(
    await reviewGate.ensureTerminalReviewState(
      client,
      pullRequest,
      expectedHead,
      cleanStatus,
      statuses,
    ),
    true,
  );
  assert.deepEqual(draftTransitions, []);
  assert.equal(autoMergeDraft, false);
  assert.equal(statusWrites[0].state, 'success');
  assert.match(statusWrites[0].description, /recovered prior clean/u);
});

test('a review failure remains latched after a later success write', () => {
  assert.equal(
    hasTerminalReviewFailureAfterPending(
      [
        {
          context: 'codex-current-head',
          state: 'success',
          description: 'review: Codex found no blocking issue',
          created_at: '2026-07-27T18:00:03Z',
        },
        {
          context: 'codex-current-head',
          state: 'failure',
          description: 'review: current-head Codex finding',
          created_at: '2026-07-27T18:00:03Z',
        },
        {
          context: 'codex-current-head',
          state: 'pending',
          description: 'review: pending required CI and current-head Codex review',
          created_at: '2026-07-27T18:00:03Z',
        },
      ],
    ),
    true,
  );
  assert.equal(
    hasTerminalReviewFailureAfterPending(
      [
        {
          context: 'codex-current-head',
          state: 'success',
          description: 'review: Codex found no blocking issue',
          created_at: '2026-07-27T18:00:03Z',
        },
        {
          context: 'codex-current-head',
          state: 'pending',
          description: 'review: pending required CI and current-head Codex review',
          created_at: '2026-07-27T18:00:03Z',
        },
        {
          context: 'codex-current-head',
          state: 'failure',
          description: 'review: stale finding',
          created_at: '2026-07-27T18:00:03Z',
        },
      ],
    ),
    false,
  );
});

test('terminal recovery scopes its failure latch to the latest review cycle', () => {
  const statuses = [
    {
      context: 'codex-current-head',
      state: 'success',
      description: 'review: Codex found no blocking issue',
      created_at: '2026-07-27T18:10:05Z',
    },
    {
      context: 'codex-current-head',
      state: 'failure',
      description: 'review: current-head Codex finding',
      created_at: '2026-07-27T18:10:04Z',
    },
    {
      context: 'codex-current-head',
      state: 'pending',
      description: 'review: pending required CI and current-head Codex review',
      created_at: '2026-07-27T18:10:00Z',
    },
    {
      context: 'codex-current-head',
      state: 'failure',
      description: 'review: prior-cycle timeout',
      created_at: '2026-07-27T18:00:05Z',
    },
    {
      context: 'codex-current-head',
      state: 'pending',
      description: 'review: pending required CI and current-head Codex review',
      created_at: '2026-07-27T18:00:00Z',
    },
  ];
  assert.equal(
    hasTerminalReviewFailureAfterPending(statuses),
    true,
  );
});

test('recovery requires an exact retryable failure or active pending status', () => {
  assert.equal(typeof reviewGate.authorizeRecoveryDispatch, 'function');
  const terminal = {
    id: 987654321,
    context: 'codex-current-head',
    state: 'success',
    description: 'review: Codex found no blocking issue',
    created_at: '2026-07-27T19:10:00Z',
  };
  const failed = {
    ...terminal,
    id: 987654322,
    state: 'failure',
    description: 'review: Codex review timed out after 2 attempts',
  };
  const olderFailedInSameSecond = {
    ...failed,
    id: 987654320,
  };
  const persistentFinding = {
    ...failed,
    id: 987654323,
    description: 'review: 1 current-head Codex finding',
  };
  const bootstrap = {
    ...failed,
    id: 987654324,
    description: 'review: bootstrap exact-head review requested',
  };
  const stuckPending = {
    ...failed,
    id: 987654325,
    state: 'pending',
    description: 'review: pending required CI and current-head Codex review',
  };
  const findingBeforeTimeout = {
    ...persistentFinding,
    id: 987654326,
  };
  const timeoutAfterFinding = {
    ...failed,
    id: 987654327,
  };
  const pendingAfterFinding = {
    ...stuckPending,
    id: 987654328,
  };
  const pendingBeforeFinding = {
    ...stuckPending,
    id: 987654329,
  };

  assert.equal(
    reviewGate.authorizeRecoveryDispatch(
      [failed, olderFailedInSameSecond, terminal],
      '987654322',
    ),
    failed,
  );
  assert.equal(
    reviewGate.authorizeRecoveryDispatch(
      [failed, olderFailedInSameSecond, terminal],
      '987654320',
    ),
    null,
  );
  assert.equal(
    reviewGate.authorizeRecoveryDispatch([terminal], '987654321'),
    null,
  );
  assert.equal(
    reviewGate.authorizeRecoveryDispatch([persistentFinding], '987654323'),
    null,
  );
  assert.equal(
    reviewGate.authorizeRecoveryDispatch([bootstrap], '987654324'),
    bootstrap,
  );
  assert.equal(
    reviewGate.authorizeRecoveryDispatch([stuckPending], '987654325'),
    stuckPending,
  );
  assert.equal(
    reviewGate.authorizeRecoveryDispatch([stuckPending], '987654324'),
    null,
  );
  assert.equal(
    reviewGate.authorizeRecoveryDispatch(
      [timeoutAfterFinding, findingBeforeTimeout, stuckPending],
      '987654327',
    ),
    null,
  );
  assert.equal(
    reviewGate.authorizeRecoveryDispatch(
      [pendingAfterFinding, findingBeforeTimeout, pendingBeforeFinding],
      '987654328',
    ),
    null,
  );
});

test('legacy CI statuses cannot bury a terminal review result', () => {
  assert.equal(typeof reviewGate.recoverableTerminalReviewStatus, 'function');
  const terminal = {
    id: 101,
    context: 'codex-current-head',
    state: 'success',
    description: 'review: Codex found no blocking issue',
    created_at: '2026-07-27T19:10:00Z',
  };
  const pending = {
    id: 102,
    context: 'codex-current-head',
    state: 'pending',
    description: 'review: pending required CI and current-head Codex review',
    created_at: '2026-07-27T19:11:00Z',
  };
  const ciFailure = {
    id: 103,
    context: 'codex-current-head',
    state: 'failure',
    description: 'ci: api-e2e failed',
    created_at: '2026-07-27T19:12:00Z',
  };

  assert.equal(
    reviewGate.recoverableTerminalReviewStatus([ciFailure, pending, terminal]),
    terminal,
  );
  assert.equal(
    reviewGate.recoverableTerminalReviewStatus([pending, terminal]),
    null,
  );
  assert.equal(
    reviewGate.recoverableTerminalReviewStatus([terminal]),
    terminal,
  );
});

test('a buried current-head finding vetoes recovered clean state', async () => {
  const expectedHead = 'b'.repeat(40);
  const cleanStatus = {
    id: 401,
    context: 'codex-current-head',
    state: 'success',
    description: 'review: Codex found no blocking issue',
  };
  const statuses = [
    {
      id: 404,
      context: 'codex-current-head',
      state: 'failure',
      description: 'ci: api-e2e failed',
    },
    {
      id: 403,
      context: 'codex-current-head',
      state: 'pending',
      description: 'review: pending required CI and current-head Codex review',
    },
    cleanStatus,
    {
      id: 400,
      context: 'codex-current-head',
      state: 'failure',
      description: 'review: 1 current-head Codex finding',
    },
    {
      id: 399,
      context: 'codex-current-head',
      state: 'pending',
      description: 'review: pending required CI and current-head Codex review',
    },
  ];
  const pullRequest = {
    number: 230,
    state: 'open',
    draft: false,
    head: { sha: expectedHead },
    html_url: 'https://github.com/JagPat/PMCvitan/pull/230',
  };
  const draftTransitions = [];
  const statusWrites = [];
  let autoMergeCalls = 0;
  const client = {
    async pullRequest() {
      return pullRequest;
    },
    async setDraft(current, draft) {
      draftTransitions.push(draft);
      current.draft = draft;
      return current;
    },
    async setStatus(head, state, description) {
      statusWrites.push({ head, state, description });
    },
    async enableAutoMerge() {
      autoMergeCalls += 1;
    },
  };

  const recoveredFailure = reviewGate.recoverableTerminalReviewStatus(statuses);
  assert.equal(recoveredFailure, statuses[3]);
  await reviewGate.ensureTerminalReviewState(
    client,
    pullRequest,
    expectedHead,
    recoveredFailure,
    statuses,
  );
  assert.deepEqual(draftTransitions, [true]);
  assert.equal(autoMergeCalls, 0);
  assert.equal(statusWrites[0].state, 'failure');
  assert.match(statusWrites[0].description, /current-head Codex finding/u);
});

test('live current-head findings stop recovery before another ready transition', async () => {
  const expectedHead = 'c'.repeat(40);
  const pullRequest = {
    number: 230,
    state: 'open',
    draft: true,
    head: { sha: expectedHead },
    html_url: 'https://github.com/JagPat/PMCvitan/pull/230',
  };
  const draftTransitions = [];
  const statusWrites = [];
  const client = {
    async reviews() {
      return [];
    },
    async reviewComments() {
      return [{
        user: { login: 'chatgpt-codex-connector[bot]' },
        original_commit_id: expectedHead,
        body: '**P2** finding arrived after timeout',
      }];
    },
    async pullRequest() {
      return pullRequest;
    },
    async setDraft(current, draft) {
      draftTransitions.push(draft);
      current.draft = draft;
      return current;
    },
    async setStatus(head, state, description) {
      statusWrites.push({ head, state, description });
    },
    async updateStickyComment() {},
  };

  const result = await reviewGate.guardAgainstCurrentHeadFinding(
    client,
    pullRequest,
    expectedHead,
    null,
  );
  assert.equal(result, '1 current-head Codex finding');
  assert.deepEqual(draftTransitions, [true]);
  assert.equal(statusWrites[0].state, 'failure');
  assert.match(statusWrites[0].description, /1 current-head Codex finding/u);
});

test('a durable recovery request survives owner-job replacement', () => {
  assert.equal(typeof reviewGate.pendingRecoveryRequest, 'function');
  assert.equal(typeof reviewGate.recoveryRequestTerminal, 'function');
  const requestStatus = {
    id: 104,
    context: 'codex-recovery-request/103',
    state: 'pending',
    description: 'recovery: requested terminal status 103',
    created_at: '2026-07-27T19:13:00Z',
  };
  const priorFailure = {
    id: 103,
    context: 'codex-current-head',
    state: 'failure',
    description: 'review: Codex review timed out after two attempts',
    created_at: '2026-07-27T19:12:00Z',
  };
  const abandonedOwnerPending = {
    id: 105,
    context: 'codex-current-head',
    state: 'pending',
    description: 'review: pending required CI and current-head Codex review',
    created_at: '2026-07-27T19:14:00Z',
  };

  const request = reviewGate.pendingRecoveryRequest([
    abandonedOwnerPending,
    requestStatus,
    priorFailure,
  ]);
  assert.deepEqual(request, {
    status: requestStatus,
    terminalStatusId: '103',
  });
  assert.equal(
    reviewGate.recoveryRequestTerminal(
      [abandonedOwnerPending, requestStatus, priorFailure],
      request,
    ),
    priorFailure,
  );
  assert.equal(
    reviewGate.authorizeRecoveryDispatch(
      [abandonedOwnerPending, requestStatus, priorFailure],
      '103',
    ),
    priorFailure,
  );
  assert.equal(
    reviewGate.recoveryRequestTerminal(
      [
        { ...priorFailure, id: 106, created_at: '2026-07-27T19:15:00Z' },
        requestStatus,
        priorFailure,
      ],
      request,
    ),
    null,
  );

  const newerRequest = {
    id: 107,
    context: 'codex-recovery-request/106',
    state: 'pending',
    description: 'recovery: requested terminal status 106',
    created_at: '2026-07-27T19:16:00Z',
  };
  assert.equal(
    reviewGate.pendingRecoveryRequest([
      newerRequest,
      requestStatus,
      priorFailure,
    ]).status,
    newerRequest,
  );
  assert.notEqual(
    reviewGate.recoveryRequestContext('103'),
    reviewGate.recoveryRequestContext('106'),
  );

  const stuckPending = {
    id: 108,
    context: 'codex-current-head',
    state: 'pending',
    description: 'review: pending required CI and current-head Codex review',
  };
  const pendingSourceRequestStatus = {
    id: 109,
    context: 'codex-recovery-request/108',
    state: 'pending',
    description: 'recovery: requested terminal status 108',
  };
  const pendingSourceRequest = reviewGate.pendingRecoveryRequest([
    pendingSourceRequestStatus,
    stuckPending,
  ]);
  assert.equal(
    reviewGate.recoveryRequestTerminal(
      [pendingSourceRequestStatus, stuckPending],
      pendingSourceRequest,
    ),
    stuckPending,
  );
  const laterTimeout = {
    id: 110,
    context: 'codex-current-head',
    state: 'failure',
    description: 'review: Codex review timed out after two attempts',
  };
  assert.equal(
    reviewGate.recoveryRequestTerminal(
      [laterTimeout, pendingSourceRequestStatus, stuckPending],
      pendingSourceRequest,
    ),
    laterTimeout,
  );
  const laterFinding = {
    ...laterTimeout,
    id: 111,
    description: 'review: 1 current-head Codex finding',
  };
  assert.equal(
    reviewGate.recoveryRequestTerminal(
      [laterFinding, pendingSourceRequestStatus, stuckPending],
      pendingSourceRequest,
    ),
    null,
  );
});

test('manual recovery records intent before entering the single owner lane', async () => {
  const [workflow, gate] = await Promise.all([
    readFile(workflowPath, 'utf8'),
    readFile(new URL('./autonomous-review-gate.mjs', import.meta.url), 'utf8'),
  ]);

  assert.match(workflow, /terminal_status_id:/);
  assert.match(workflow, /request-recovery:/);
  assert.match(workflow, /AUTONOMOUS_REVIEW_MODE: request-recovery/);
  assert.match(workflow, /needs:\s*\[request-recovery\]/);
  assert.match(workflow, /autonomous-review-owner-/);
  assert.doesNotMatch(workflow, /&& 'recovery' \|\| 'ci'/);
  assert.match(gate, /authorizeRecoveryDispatch\(/);
  assert.match(gate, /RECOVERY_CONTEXT_PREFIX/);
  assert.match(gate, /pendingRecoveryRequest\(/);
  assert.match(gate, /recoveryRequestTerminal\(/);
  assert.match(gate, /recoveryRequest\.status\.context/);
  assert.doesNotMatch(gate, /client\.workflowRun\(/);
  assert.doesNotMatch(gate, /triggerQueuedAt|queuedAt|statusAt/);
  assert.match(gate, /finalCheckSummary/);
});

test('an older owner cannot consume a newer request persisted while it is paused', async () => {
  const oldTerminal = {
    id: 103,
    context: 'codex-current-head',
    state: 'failure',
    description: 'review: bootstrap exact-head review requested',
  };
  const newerTerminal = {
    id: 106,
    context: 'codex-current-head',
    state: 'failure',
    description: 'review: Codex review timed out after two attempts',
  };
  const statuses = [oldTerminal];
  const client = statusClient(statuses);
  const pullRequest = {
    number: 230,
    html_url: 'https://github.com/JagPat/PMCvitan/pull/230',
  };
  const expectedHead = 'a'.repeat(40);

  await reviewGate.persistRecoveryRequest(
    client,
    expectedHead,
    pullRequest,
    oldTerminal,
  );
  const oldRequest = reviewGate.pendingRecoveryRequest(statuses);
  const ownerPaused = deferred();
  const resumeOwner = deferred();
  const oldOwner = (async () => {
    ownerPaused.resolve();
    await resumeOwner.promise;
    await reviewGate.settleRecoveryRequest(
      client,
      expectedHead,
      pullRequest,
      oldRequest,
      'review timeout',
    );
  })();

  await ownerPaused.promise;
  statuses.unshift(newerTerminal);
  await reviewGate.persistRecoveryRequest(
    client,
    expectedHead,
    pullRequest,
    newerTerminal,
  );
  resumeOwner.resolve();
  await oldOwner;

  assert.equal(statuses[0].context, 'codex-recovery-request/103');
  assert.equal(statuses[0].state, 'success');
  assert.equal(
    reviewGate.pendingRecoveryRequest(statuses).terminalStatusId,
    '106',
  );
});

test('stale manual recovery heads fail instead of reporting a green no-op', () => {
  const context = {
    expectedHead: 'a'.repeat(40),
    trigger: 'dispatch',
  };

  assert.throws(
    () => reviewGate.assertCurrentHeadForContext(
      context,
      'b'.repeat(40),
      'request-recovery',
    ),
    /Recovery dispatch head .* no longer matches current head/u,
  );
  assert.equal(
    reviewGate.assertCurrentHeadForContext(
      { ...context, trigger: 'ci' },
      'b'.repeat(40),
      'orchestrate',
    ),
    false,
  );
});

test('workflow gives one exact-head run sole ownership of review and merge', async () => {
  const [workflow, gate] = await Promise.all([
    readFile(workflowPath, 'utf8'),
    readFile(new URL('./autonomous-review-gate.mjs', import.meta.url), 'utf8'),
  ]);

  assert.match(workflow, /workflow_run:/);
  assert.match(workflow, /workflows:\s*\[CI\]/);
  assert.match(workflow, /workflow_dispatch:/);
  assert.doesNotMatch(workflow, /pull_request_review:/);
  assert.doesNotMatch(workflow, /pull_request_review_comment:/);
  assert.doesNotMatch(gate, /eventName === 'pull_request_review'/);
  assert.doesNotMatch(gate, /eventName === 'pull_request_review_comment'/);
  assert.doesNotMatch(gate, /trigger:\s*'evidence'/);
  assert.doesNotMatch(gate, /handleCodexEvidence/);
  assert.doesNotMatch(gate, /admitAutoMerge/);
  assert.match(gate, /reviewAttempt\(/);
  assert.match(workflow, /request-recovery:/);
  assert.match(workflow, /autonomous-review-owner-/);
  assert.match(gate, /mode === 'request-recovery'/);
  assert.match(gate, /pendingRecoveryRequest\(/);
  assert.match(gate, /ensureTerminalReviewState\(/);
  assert.match(workflow, /statuses:\s*write/);
  assert.match(workflow, /pull-requests:\s*write/);
  assert.match(workflow, /issues:\s*write/);
  assert.match(workflow, /ref:\s*\$\{\{ github\.event\.repository\.default_branch \}\}/);
  assert.match(workflow, /persist-credentials:\s*false/);
  assert.match(workflow, /actions\/checkout@[0-9a-f]{40}/);
  assert.match(workflow, /actions\/setup-node@[0-9a-f]{40}/);
  assert.doesNotMatch(workflow, /pull_request_target:/);
});

test('one polled Codex invocation owns terminal success and auto-merge', async () => {
  const gate = await readFile(
    new URL('./autonomous-review-gate.mjs', import.meta.url),
    'utf8',
  );
  assert.match(gate, /ensureTerminalReviewState\(/);
  const clearBranch = gate.slice(
    gate.indexOf("if (result.state === 'clear')"),
    gate.indexOf('if (attempt < MAX_REVIEW_ATTEMPTS)'),
  );
  const finalEvidence = clearBranch.lastIndexOf(
    'reclassifyCurrentCodexEvidence',
  );
  const publishedSuccess = clearBranch.lastIndexOf("'success'");
  const autoMerge = clearBranch.lastIndexOf('enableAutoMerge');
  assert.ok(finalEvidence >= 0);
  assert.ok(publishedSuccess > finalEvidence);
  assert.ok(autoMerge > publishedSuccess);
  assert.doesNotMatch(clearBranch, /TERMINAL_SETTLE_MS/);
  assert.doesNotMatch(clearBranch, /admitAutoMerge/);
  assert.doesNotMatch(clearBranch, /handleCodexEvidence/);
});

test('review cycles are serialized by pull request and exact head', async () => {
  const workflow = await readFile(workflowPath, 'utf8');
  assert.match(workflow, /github\.event\.workflow_run\.head_sha/);
  assert.match(workflow, /inputs\.head_sha/);
  assert.doesNotMatch(workflow, /github\.event\.pull_request/);
  assert.match(workflow, /cancel-in-progress:\s*false/);
});

test('failure-latch status history is fully paginated', async () => {
  const gate = await readFile(
    new URL('./autonomous-review-gate.mjs', import.meta.url),
    'utf8',
  );
  const statusesMethod = gate.slice(
    gate.indexOf('async statuses(head)'),
    gate.indexOf('async latestStatus'),
  );
  assert.match(statusesMethod, /page \+= 1/);
  assert.match(statusesMethod, /batch\.length < 100/);
  assert.match(statusesMethod, /statuses\.push\(\.\.\.batch\)/);
});

test('result webhooks cannot publish review state or queue auto-merge', async () => {
  const gate = await readFile(
    new URL('./autonomous-review-gate.mjs', import.meta.url),
    'utf8',
  );
  assert.equal(reviewGate.handleCodexEvidence, undefined);
  assert.equal(reviewGate.admitAutoMerge, undefined);
  assert.doesNotMatch(gate, /handleCodexEvidence/);
  assert.doesNotMatch(gate, /admitAutoMerge/);
});

test('terminal failures restore draft and CI failures run before recovery', async () => {
  const gate = await readFile(
    new URL('./autonomous-review-gate.mjs', import.meta.url),
    'utf8',
  );
  const terminalHelper = gate.slice(
    gate.indexOf('async function ensureTerminalReviewState'),
    gate.indexOf('async function waitForRequiredChecks'),
  );
  assert.match(terminalHelper, /status\.state === 'success'/);
  assert.match(terminalHelper, /recovered prior clean Codex result/);
  assert.match(terminalHelper, /persistentReviewFailure/);
  assert.ok(
    terminalHelper.indexOf('persistentReviewFailure')
      < terminalHelper.indexOf('enableAutoMerge'),
  );
  assert.ok(
    terminalHelper.indexOf('recovered prior clean Codex result')
      < terminalHelper.indexOf('enableAutoMerge'),
  );
  assert.match(terminalHelper, /setDraftForCurrentHead[\s\S]*true/);

  const runBody = gate.slice(gate.indexOf('export async function run()'));
  const ciFailure = runBody.indexOf(
    "context.ciConclusion && context.ciConclusion !== 'success'",
  );
  const terminalRecovery = runBody.indexOf('ensureTerminalReviewState(');
  assert.ok(ciFailure >= 0 && ciFailure < terminalRecovery);
  const liveFindingGuard = runBody.indexOf('guardAgainstCurrentHeadFinding(');
  assert.ok(
    liveFindingGuard >= 0 && liveFindingGuard < terminalRecovery,
    'live Codex evidence must be checked before recovered success can return',
  );
  assert.match(runBody, /if \(!isTerminalReviewStatus\(existingStatus\)\)[\s\S]*`ci:/);
});

test('workflow has no AI action or AI credential dependency', async () => {
  const workflow = await readFile(workflowPath, 'utf8');

  assert.doesNotMatch(workflow, /ANTHROPIC_API_KEY/);
  assert.doesNotMatch(workflow, /OPENAI_API_KEY/);
  assert.doesNotMatch(workflow, /anthropics\/claude-code-action/);
  assert.doesNotMatch(workflow, /openai\/codex-action/);
});

test('workflow recovery is exact-head serialized and has terminal time budget', async () => {
  const [workflow, gate] = await Promise.all([
    readFile(workflowPath, 'utf8'),
    readFile(new URL('./autonomous-review-gate.mjs', import.meta.url), 'utf8'),
  ]);
  assert.match(workflow, /head_sha:/);
  assert.match(workflow, /inputs\.head_sha/);
  assert.match(workflow, /terminal_status_id:/);
  assert.match(gate, /event\.inputs\?\.terminal_status_id/);
  assert.match(workflow, /needs:\s*\[request-recovery\]/);
  assert.match(workflow, /autonomous-review-owner-/);
  assert.match(workflow, /timeout-minutes:\s*60/);
});

test('operator recovery documents the required current head SHA', async () => {
  const runbook = await readFile(autonomousLoopPath, 'utf8');
  const recovery = runbook.slice(
    runbook.indexOf('## Recovery'),
    runbook.indexOf('## GitHub Enforcement'),
  );
  assert.match(recovery, /gh pr view/);
  assert.match(recovery, /headRefOid/);
  assert.match(recovery, /-f head_sha="\$HEAD_SHA"/);
  assert.match(recovery, /-f terminal_status_id="\$TERMINAL_STATUS_ID"/);
});

test('documented recovery jq selects an authorized review status id', async () => {
  const runbook = await readFile(autonomousLoopPath, 'utf8');
  const recovery = runbook.slice(
    runbook.indexOf('## Recovery'),
    runbook.indexOf('## GitHub Enforcement'),
  );
  const expression = recovery.match(/--jq '([^']+)'/u)?.[1];
  assert.ok(expression, 'recovery command must include a jq expression');

  const runExpression = (statuses) => spawnSync('jq', ['-r', expression], {
    encoding: 'utf8',
    input: JSON.stringify([statuses]),
  });
  const timeoutStatus = {
    id: 777,
    context: 'codex-current-head',
    state: 'failure',
    description: 'review: Codex review timed out after two attempts',
  };
  const timeout = runExpression([timeoutStatus]);
  assert.equal(timeout.status, 0, timeout.stderr);
  assert.equal(timeout.stdout.trim(), '777');

  const pendingStatus = {
    id: 778,
    context: 'codex-current-head',
    state: 'pending',
    description: 'review: pending required CI and current-head Codex review',
  };
  const pending = runExpression([pendingStatus]);
  assert.equal(pending.status, 0, pending.stderr);
  assert.equal(pending.stdout.trim(), '778');

  const buriedTimeout = runExpression([
    {
      id: 779,
      context: 'codex-current-head',
      state: 'failure',
      description: 'ci: api-e2e failed',
    },
    pendingStatus,
    timeoutStatus,
  ]);
  assert.equal(buriedTimeout.status, 0, buriedTimeout.stderr);
  assert.equal(buriedTimeout.stdout.trim(), '777');

  const findingBearing = runExpression([
    { ...pendingStatus, id: 781 },
    {
      id: 780,
      context: 'codex-current-head',
      state: 'failure',
      description: 'review: 1 current-head Codex finding',
    },
    pendingStatus,
  ]);
  assert.equal(findingBearing.status, 0, findingBearing.stderr);
  assert.equal(findingBearing.stdout.trim(), '');
});

test('workflow invokes the exact-head gate and CI executes its tests', async () => {
  const [workflow, ci] = await Promise.all([
    readFile(workflowPath, 'utf8'),
    readFile(ciPath, 'utf8'),
  ]);

  assert.match(workflow, /scripts\/autonomous-review-gate\.mjs/);
  assert.match(workflow, /codex-current-head/);
  assert.match(ci, /pnpm test:automation/);
});

test('rechecks the live head before terminal PR mutations', async () => {
  const gate = await readFile(
    new URL('./autonomous-review-gate.mjs', import.meta.url),
    'utf8',
  );

  assert.match(gate, /async function refreshCurrentHead\(/);
  assert.match(gate, /enableAutoMerge\(pullRequest\)/);
  assert.match(gate, /if \(!pullRequest\) return;/);
  assert.match(gate, /resolveCodexThreads/);
});

test('reclassifies Codex evidence immediately before publishing success', async () => {
  const implementation = await readFile(
    new URL('./autonomous-review-gate.mjs', import.meta.url),
    'utf8',
  );
  assert.match(implementation, /reclassifyCurrentCodexEvidence/);
  assert.match(implementation, /verifiedResult\.state !== 'clear'/);
});

test('CI runs once per pull-request head', async () => {
  const ci = await readFile(ciPath, 'utf8');

  assert.match(ci, /pull_request:/);
  assert.doesNotMatch(ci, /push:/);
});

test('clean-status auto-merge refusal falls back to an exact-head merge', async () => {
  const makeClient = () => {
    const client = new reviewGate.GitHubClient({
      repository: 'JagPat/PMCvitan',
      token: 'test-token',
    });
    client.mergeCalls = [];
    client.request = async (path, options) => {
      client.mergeCalls.push({ path, options });
      return {};
    };
    return client;
  };
  const pullRequest = {
    number: 237,
    node_id: 'PR_test',
    auto_merge: null,
    head: { sha: 'feedc0de' },
  };

  // GitHub refuses to ARM auto-merge on a PR with nothing left to wait for,
  // which is exactly the state after this run posts the clean review status.
  // The gate must merge the exact reviewed head directly instead of crashing.
  const cleanRefusal = makeClient();
  cleanRefusal.graphql = async () => {
    throw new Error(
      'GitHub GraphQL failed: [{"type":"UNPROCESSABLE","path":["enablePullRequestAutoMerge"],"locations":[{"line":2,"column":9}],"message":"Pull request is in clean status"}]',
    );
  };
  await cleanRefusal.enableAutoMerge(pullRequest);
  assert.deepEqual(cleanRefusal.mergeCalls, [
    {
      path: '/repos/JagPat/PMCvitan/pulls/237/merge',
      options: {
        method: 'PUT',
        body: { merge_method: 'squash', sha: 'feedc0de' },
      },
    },
  ]);

  // Any other refusal still fails the run and never merges.
  const otherRefusal = makeClient();
  otherRefusal.graphql = async () => {
    throw new Error(
      'GitHub GraphQL failed: [{"type":"FORBIDDEN","message":"Resource not accessible by integration"}]',
    );
  };
  await assert.rejects(
    () => otherRefusal.enableAutoMerge(pullRequest),
    /FORBIDDEN/,
  );
  assert.deepEqual(otherRefusal.mergeCalls, []);

  // Already-armed auto-merge stays a no-op.
  const armed = makeClient();
  armed.graphql = async () => {
    throw new Error('graphql must not be called for an armed pull request');
  };
  await armed.enableAutoMerge({
    ...pullRequest,
    auto_merge: { merge_method: 'squash' },
  });
  assert.deepEqual(armed.mergeCalls, []);

  // A successful arm performs no direct merge.
  const armedNow = makeClient();
  armedNow.graphql = async () => ({});
  await armedNow.enableAutoMerge(pullRequest);
  assert.deepEqual(armedNow.mergeCalls, []);
});
