import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { observeRoleActivation, renderObservation, runObserve } from './role-activation-observe.mjs';
import { PR, REPO, REQUEST_ID, client, clock, conversationItem, world } from './role-activation-test-fixtures.mjs';

const env = (overrides = {}) => ({
  GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REF: 'refs/heads/main',
  OBSERVE_PR_NUMBER: String(PR), OBSERVE_REQUEST_COMMENT_ID: String(REQUEST_ID), ...overrides,
});
const loadEvent = () => ({ repository: { full_name: REPO } });

test('an observation runs the trusted reader and the pure verdict over one cycle, read-only', async () => {
  const w = world();
  const { fake, calls } = client(w);
  const observation = await observeRoleActivation({ client: fake, pullRequest: PR, requestCommentId: REQUEST_ID, now: clock() });
  assert.equal(observation.verdict.state, 'activate');
  assert.deepEqual(observation.verdict.missing, []);
  assert.equal(observation.verdict.keepCodexCurrentHead, true);
  assert.equal(observation.evidence.cycle.correctionRequestId, REQUEST_ID);
  // The fake GitHub refuses every write, so completing proves the observation wrote nothing.
  assert.ok(calls.length > 0);
});

test('the summary leads with the verdict, lists every proof and diagnostic, and says nothing was installed', async () => {
  // An owner comment inside the cycle window holds causation.
  const quietBroken = world();
  quietBroken.conversation.issue_comment.push(conversationItem(70, 'JagPat', '10:40', 'looks good'));
  const held = await observeRoleActivation({ client: client(quietBroken).fake, pullRequest: PR, requestCommentId: REQUEST_ID, now: clock() });
  assert.deepEqual(held.verdict.missing, ['codexTaskCausation']);
  const text = renderObservation(held);
  assert.match(text, /\*\*Verdict: `hold`\*\*/u);
  assert.match(text, /Nothing was installed, routed or retired/u);
  for (const proof of held.verdict.missing) assert.ok(text.includes(`- \`${proof}\``), proof);
  assert.ok(!text.includes('### Install binding'), 'a held cycle binds no install');
  const ready = renderObservation(await observeRoleActivation({ client: client(world()).fake, pullRequest: PR, requestCommentId: REQUEST_ID, now: clock() }));
  assert.match(ready, /\*\*Verdict: `activate`\*\*/u);
  assert.match(ready, /### Install binding \(data only\)/u);
  assert.match(ready, /### Missing proofs \(0\)\n- none/u);
});

test('runObserve refuses an untrusted ref, a non-dispatch event or bad inputs before any API call', async () => {
  const makeClient = () => { throw new Error('no client expected'); };
  for (const [label, overrides, pattern] of [
    ['another ref', { GITHUB_REF: 'refs/heads/claude/x' }, /untrusted_ref/u],
    ['a push event', { GITHUB_EVENT_NAME: 'push' }, /not_workflow_dispatch/u],
    ['no PR', { OBSERVE_PR_NUMBER: '' }, /pr_number/u],
    ['a non-integer PR', { OBSERVE_PR_NUMBER: '6x' }, /pr_number/u],
    ['a zero request id', { OBSERVE_REQUEST_COMMENT_ID: '0' }, /request_comment_id/u],
    ['no request id', { OBSERVE_REQUEST_COMMENT_ID: '' }, /request_comment_id/u],
  ]) {
    await assert.rejects(runObserve({ env: env(overrides), loadEvent, makeClient }), pattern, label);
  }
  await assert.rejects(runObserve({ env: env(), loadEvent: () => ({}), makeClient }), /no repository/u);
  // A valid dispatch observes once and writes the summary.
  let summary = '';
  const observation = await runObserve({
    env: env(), loadEvent, makeClient: (repository) => { assert.equal(repository, REPO); return client(world()).fake; },
    writeSummary: (text) => { summary += text; }, now: clock(),
  });
  assert.equal(observation.verdict.state, 'activate');
  assert.match(summary, /Role-transfer observation: JagPat\/PMCvitan#619, request 5001/u);
});

test('the observer workflow is manual, main-only and read-only', () => {
  const workflow = readFileSync(new URL('../.github/workflows/role-activation-observe.yml', import.meta.url), 'utf8');
  assert.match(workflow, /on:\s*\n\s*workflow_dispatch:/u);
  assert.doesNotMatch(workflow, /^\s*(push|pull_request|pull_request_target|schedule|workflow_run):/mu);
  assert.match(workflow, /if: github\.ref == 'refs\/heads\/main'/u);
  assert.match(workflow, /^permissions: \{\}/mu);
  assert.doesNotMatch(workflow, /: write\b/u);
  for (const scope of ['actions', 'checks', 'contents', 'issues', 'pull-requests']) {
    assert.match(workflow, new RegExp(`${scope}: read`, 'u'), scope);
  }
  assert.match(workflow, /persist-credentials: false/u);
  assert.match(workflow, /actions\/checkout@11d5960a326750d5838078e36cf38b85af677262/u);
  assert.match(workflow, /node scripts\/role-activation-observe\.mjs/u);
});
