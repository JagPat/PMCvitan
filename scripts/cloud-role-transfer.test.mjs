import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyClaudeShadowReview } from './claude-review-adapter.mjs';
import { parseCorrectionOwner, correctionRouting, correctionOwnerProblem } from './correction-owner.mjs';
import { authorizeExactHeadMerge, completeReviewedPullRequest, ensureTerminalReviewState, GitHubClient, REQUIRED_CHECKS, revalidateFinalReviewPolicy, reviewAttempt, run, setDraftForCurrentHead } from './autonomous-review-gate.mjs';

const head = 'a'.repeat(40);
const base = 'b'.repeat(40);

test('Codex implementation ownership is admitted for validation but is not awakenable', () => {
  for (const ref of ['codex/maintenance', 'claude/product']) {
    const body = '<!-- correction-owner: codex -->';
    const declaration = parseCorrectionOwner(body, { headRef: ref });
    assert.equal(declaration.state, 'declared');
    assert.equal(correctionOwnerProblem({ body, head: { ref } }), null);
    const route = correctionRouting({ declaration, head });
    assert.equal(route.owner, 'codex');
    assert.equal(route.awakenable, false);
  }
});

function cleanRun(overrides = {}) {
  const artifact = { id: 789, digest: `sha256:${'d'.repeat(64)}`, name: `claude-shadow-v1-repo-${Buffer.from('JagPat/PMCvitan').toString('base64url')}-pr-600-base-${base}-head-${head}-ci-123-2-publisher-456-1-state-clear-findings-0` };
  return { id: 7, name: 'claude-independent-review', head_sha: head, app: { slug: 'github-actions' }, external_id: `pmcvitan:claude-shadow:v1:repo-JagPat/PMCvitan:pr-600:base-${base}:head-${head}:run-123:attempt-2:publisher-456:publisher-attempt-1`, status: 'completed', conclusion: 'success', completed_at: '2026-09-14T12:00:00Z', output: { summary: JSON.stringify({ schema: 1, repository: 'JagPat/PMCvitan', pullRequest: 600, baseSha: base, headSha: head, runId: 123, runAttempt: 2, publisherRunId: 456, publisherRunAttempt: 1, workflowRef: 'JagPat/PMCvitan/.github/workflows/claude-shadow-review.yml@refs/heads/main', workflowExecutionRef: 'refs/heads/main', trustedWorkflowRef: 'JagPat/PMCvitan/.github/workflows/claude-shadow-review.yml@refs/heads/main', trustedExecutionRef: 'refs/heads/main', workflowSha: 'c'.repeat(40), trustedWorkflowSha: 'c'.repeat(40), targetTipSha: base, testedBaseSha: base, testedMergeSha: 'e'.repeat(40), identityRunAttempt: 1, ciIdentityArtifactId: 99, state: 'clear', findingCount: 0, artifact }) }, ...overrides };
}

test('Claude shadow evidence is exact-head/app and fail-closed but non-authoritative', async () => {
  const verifyProducer = async () => true;
  const classify = (runs, verify = verifyProducer) => classifyClaudeShadowReview({ checkRuns: runs, expectedHead: head, expectedBase: base, pullRequestNumber: 600, verifyProducer: verify });
  const alteredSummary = (changes) => {
    const run = cleanRun();
    run.output.summary = JSON.stringify({ ...JSON.parse(run.output.summary), ...changes });
    return run;
  };
  assert.deepEqual(await classify([cleanRun()]), { state: 'shadow_clear', authoritative: false, runId: 7 });
  assert.equal((await classify([cleanRun()], async () => false)).state, 'untrusted_producer');
  assert.equal((await classifyClaudeShadowReview({ checkRuns: [cleanRun()], expectedHead: head, expectedBase: base, pullRequestNumber: 600 })).state, 'untrusted_producer');
  assert.equal((await classify([cleanRun({ head_sha: 'c'.repeat(40) })])).state, 'missing');
  assert.equal((await classify([cleanRun({ app: { slug: 'wrong' } })])).state, 'missing');
  assert.equal((await classify([cleanRun({ status: 'in_progress', conclusion: null, completed_at: null })])).state, 'partial');
  assert.equal((await classify([cleanRun({ conclusion: 'timed_out' })])).state, 'timed_out');
  assert.equal((await classify([cleanRun({ conclusion: 'failure' })])).state, 'failure');
  assert.equal((await classify([cleanRun({ output: { summary: '{}' } })])).state, 'replayed');
  assert.equal((await classify([alteredSummary({ publisherRunId: 999 })])).state, 'replayed');
  assert.equal((await classify([alteredSummary({ workflowRef: 'JagPat/PMCvitan/.github/workflows/other.yml@refs/heads/main' })])).state, 'replayed');
  assert.equal((await classify([alteredSummary({ workflowRef: 'Other/Repo/.github/workflows/claude-shadow-review.yml@refs/heads/main' })])).state, 'replayed');
  assert.equal((await classify([alteredSummary({ workflowExecutionRef: 'refs/heads/codex/untrusted-workflow' })])).state, 'replayed');
  assert.equal((await classify([alteredSummary({ trustedWorkflowRef: 'JagPat/PMCvitan/.github/workflows/other.yml@refs/heads/main' })])).state, 'replayed');
  assert.equal((await classify([alteredSummary({ trustedExecutionRef: 'refs/heads/codex/untrusted-workflow' })])).state, 'replayed');
  assert.equal((await classify([alteredSummary({ workflowSha: 'f'.repeat(40) })])).state, 'replayed');
  assert.equal((await classify([])).state, 'missing');
});

test('a newer pending Claude rerun supersedes an older clear completion', async () => {
  for (const status of ['queued', 'in_progress']) {
    const newer = cleanRun({ id: 8, status, conclusion: null, completed_at: null });
    for (const runs of [[cleanRun(), newer], [newer, cleanRun()]]) {
      assert.equal((await classifyClaudeShadowReview({ checkRuns: runs, expectedHead: head, expectedBase: base, pullRequestNumber: 600, verifyProducer: async () => true })).state, 'partial');
    }
  }
});

test('server-side workflow run and artifact association rejects forged producer claims', async () => {
  const evidence = JSON.parse(cleanRun().output.summary);
  const workflowRun = { id: 456, run_attempt: 1, path: '.github/workflows/claude-shadow-review.yml', event: 'workflow_run', status: 'completed', conclusion: 'success', head_sha: 'c'.repeat(40), head_branch: 'main', repository: { full_name: 'JagPat/PMCvitan' } };
  const job = { name: 'publish', status: 'completed', conclusion: 'success' };
  const artifact = { ...evidence.artifact, expired: false };
  const makeClient = ({ run = workflowRun, jobs = [job], artifacts = [artifact] } = {}) => {
    const client = new GitHubClient({ repository: 'JagPat/PMCvitan', token: 'not-used' });
    client.request = async () => run;
    client.actionRunItems = async (_id, endpoint) => endpoint === 'jobs' ? jobs : artifacts;
    return client;
  };
  assert.equal(await makeClient().verifyClaudeShadowProducer(cleanRun(), evidence), true);
  assert.equal(await makeClient({ run: { ...workflowRun, path: '.github/workflows/evil.yml' } }).verifyClaudeShadowProducer(cleanRun(), evidence), false);
  assert.equal(await makeClient({ run: { ...workflowRun, head_sha: 'f'.repeat(40) } }).verifyClaudeShadowProducer(cleanRun(), evidence), false);
  assert.equal(await makeClient({ run: { ...workflowRun, head_branch: 'codex/untrusted-workflow' } }).verifyClaudeShadowProducer(cleanRun(), evidence), false);
  assert.equal(await makeClient({ jobs: [{ ...job, conclusion: 'failure' }] }).verifyClaudeShadowProducer(cleanRun(), evidence), false);
  assert.equal(await makeClient({ artifacts: [{ ...artifact, name: 'copied-evidence' }] }).verifyClaudeShadowProducer(cleanRun(), evidence), false);
  assert.equal(await makeClient({ artifacts: [{ ...artifact, digest: `sha256:${'e'.repeat(64)}` }] }).verifyClaudeShadowProducer(cleanRun(), evidence), false);
});

test('automatic merge needs CI and exact-head review, with no human authorization', async () => {
  const pull = { number: 600, state: 'open', draft: false, head: { sha: head, repo: { full_name: 'JagPat/PMCvitan' } }, base: { ref: 'main', sha: base, repo: { full_name: 'JagPat/PMCvitan' } } };
  const checks = REQUIRED_CHECKS.map((name) => ({ name, status: 'completed', conclusion: 'success' }));
  const makeClient = ({ pulls = [pull, pull], statuses = [{ context: 'codex-current-head', state: 'success' }], runs = checks } = {}) => ({
    repository: 'JagPat/PMCvitan',
    async pullRequest() { return pulls.shift() ?? pull; },
    async statuses() { return statuses; },
    async checkRuns() { return runs; },
    async paginated() { throw new Error('Merge must not fetch human authorization comments'); },
  });
  assert.equal((await authorizeExactHeadMerge(makeClient(), pull, head)).allowed, true);
  assert.equal((await authorizeExactHeadMerge(makeClient({ pulls: [{ ...pull, draft: true }] }), pull, head)).state, 'draft');
  assert.equal((await authorizeExactHeadMerge(makeClient({ pulls: [pull, { ...pull, head: { ...pull.head, sha: 'c'.repeat(40) } }] }), pull, head)).state, 'changed_during_validation');
  assert.equal((await authorizeExactHeadMerge(makeClient({ pulls: [pull, { ...pull, base: { ...pull.base, sha: 'd'.repeat(40) } }] }), pull, head)).state, 'changed_during_validation');
  for (const state of ['failure', 'pending']) {
    assert.equal((await authorizeExactHeadMerge(makeClient({ statuses: [{ context: 'codex-current-head', state }] }), pull, head)).state, 'gates_not_green');
  }
  assert.equal((await authorizeExactHeadMerge(makeClient({ statuses: [] }), pull, head)).state, 'gates_not_green');
  assert.equal((await authorizeExactHeadMerge(makeClient({ runs: [] }), pull, head)).state, 'gates_not_green');
  for (const name of REQUIRED_CHECKS) {
    assert.equal((await authorizeExactHeadMerge(makeClient({ runs: checks.map(run => run.name === name ? { ...run, conclusion: 'failure' } : run) }), pull, head)).state, 'gates_not_green');
  }
});


test('Codex-owned candidates are held across merge authorization and recovered terminal success', async () => {
  const codexPull = { number: 601, state: 'open', draft: false, html_url: 'https://github.com/JagPat/PMCvitan/pull/601', body: '<!-- correction-owner: codex -->', head: { sha: head, ref: 'claude/retained', repo: { full_name: 'JagPat/PMCvitan' } }, base: { ref: 'main', sha: base, repo: { full_name: 'JagPat/PMCvitan' } } };
  const checks = REQUIRED_CHECKS.map((name) => ({ name, status: 'completed', conclusion: 'success' }));
  let current = codexPull;
  const mutations = [];
  const client = {
    repository: 'JagPat/PMCvitan',
    async pullRequest() { return current; },
    async statuses() { return [{ context: 'codex-current-head', state: 'success' }]; },
    async checkRuns() { return checks; },
    async setStatus(_head, state, description) { mutations.push(['status', state, description]); },
    async setDraft(_pull, draft) { mutations.push(['draft', draft]); current = { ...current, draft }; return current; },
  };
  assert.equal((await authorizeExactHeadMerge(client, codexPull, head)).state, 'validation_only_codex_owner');
  assert.equal(await ensureTerminalReviewState(client, codexPull, head, { context: 'codex-current-head', state: 'success' }, [{ context: 'codex-current-head', state: 'success' }]), true);
  assert.deepEqual(mutations.map(([kind, value]) => [kind, value]), [['status', 'pending'], ['draft', true]]);

  current = { ...current, body: '<!-- correction-owner: claude -->', draft: false };
  const changingClient = { ...client, async pullRequest() { const value = current; current = { ...current, body: '<!-- correction-owner: codex -->' }; return value; } };
  assert.equal((await authorizeExactHeadMerge(changingClient, current, head)).allowed, false, 'owner changing to Codex during final validation is held');
});


test('owner changes are held at promotion and final-policy boundaries', async () => {
  const claude = { number: 602, state: 'open', draft: false, html_url: 'https://github.com/JagPat/PMCvitan/pull/602', body: '<!-- correction-owner: claude -->', head: { sha: head, ref: 'claude/unit', repo: { full_name: 'JagPat/PMCvitan' } }, base: { ref: 'main', sha: base, repo: { full_name: 'JagPat/PMCvitan' } } };
  const codex = { ...claude, body: '<!-- correction-owner: codex -->' };
  let current = claude;
  const drafts = [];
  const statuses = [];
  const client = {
    async pullRequest() { return current; },
    async setDraft(_pull, draft) { drafts.push(draft); current = draft ? codex : { ...current, draft }; return { ...current, draft }; },
    async setStatus(_head, state) { statuses.push(state); },
  };
  assert.equal((await reviewAttempt(client, claude, head, 1, new Date().toISOString())).state, 'validation_only_codex_owner');
  assert.deepEqual(drafts, [true, true], 'the Codex transfer is re-drafted and never promoted ready');
  assert.deepEqual(statuses, ['pending']);
  assert.equal((await revalidateFinalReviewPolicy(client, 602, head)).state, 'validation_only_codex_owner');
});

test('each merge, queue, and clean-status fallback operation gets fresh authorization', async () => {
  const claude = { number: 603, state: 'open', draft: false, html_url: 'https://github.com/JagPat/PMCvitan/pull/603', body: '<!-- correction-owner: claude -->', head: { sha: head, repo: { full_name: 'JagPat/PMCvitan' } }, base: { ref: 'main', sha: base, repo: { full_name: 'JagPat/PMCvitan' } } };
  const codex = { ...claude, body: '<!-- correction-owner: codex -->' };
  const checks = REQUIRED_CHECKS.map((name) => ({ name, status: 'completed', conclusion: 'success' }));
  const makeClient = () => {
    let current = claude;
    let mergeCalls = 0;
    let queueCalls = 0;
    return {
      get counts() { return { mergeCalls, queueCalls }; },
      async pullRequest() { return current; },
      async statuses() { return [{ context: 'codex-current-head', state: 'success' }]; },
      async checkRuns() { return checks; },
      async mergeExactHead() { mergeCalls += 1; current = codex; return { merged: false }; },
      async enableAutoMerge() { queueCalls += 1; },
      async dispatchHandoff() {},
    };
  };
  const changedBeforeQueue = makeClient();
  assert.equal(await completeReviewedPullRequest(changedBeforeQueue, claude, head), 'held_for_gates');
  assert.deepEqual(changedBeforeQueue.counts, { mergeCalls: 1, queueCalls: 0 });

  let current = claude;
  let mergeCalls = 0;
  let queueCalls = 0;
  const fallback = {
    async pullRequest() { return current; },
    async statuses() { return [{ context: 'codex-current-head', state: 'success' }]; },
    async checkRuns() { return checks; },
    async mergeExactHead() { mergeCalls += 1; return { merged: false }; },
    async enableAutoMerge() { queueCalls += 1; current = codex; throw new Error('is in clean status'); },
    async dispatchHandoff() {},
  };
  assert.equal(await completeReviewedPullRequest(fallback, claude, head), 'held_for_gates');
  assert.equal(mergeCalls, 1, 'the fallback direct merge is not attempted after ownership changes');
  assert.equal(queueCalls, 1);
});


test('the real GitHubClient draft seam never emits READY for a known Codex owner', async () => {
  const codex = { number: 604, node_id: 'PR_node', state: 'open', draft: true, html_url: 'https://github.com/JagPat/PMCvitan/pull/604', body: '<!-- correction-owner: codex -->', head: { sha: head, repo: { full_name: 'JagPat/PMCvitan' } }, base: { ref: 'main', sha: base, repo: { full_name: 'JagPat/PMCvitan' } } };
  const client = new GitHubClient({ repository: 'JagPat/PMCvitan', token: 'unused' });
  const mutations = [];
  client.pullRequest = async () => codex;
  client.request = async () => ({});
  client.graphql = async (query) => { mutations.push(query); return {}; };
  const held = await setDraftForCurrentHead(client, 604, head, false);
  assert.equal(held.draft, true);
  assert.equal(mutations.some((query) => query.includes('markPullRequestReadyForReview')), false);
  assert.equal(mutations.some((query) => query.includes('convertPullRequestToDraft')), false, 'already-draft hold needs no GraphQL mutation');
});

test('full run stops on validation-only owner transfer without retry or timeout failure', async () => {
  const checklist = ['concurrency-serialization', 'old-release-migration-compatibility', 'trigger-alternate-writers', 'authorization-tenancy', 'ci-reproduce-first'].map((item) => `- [x] \`${item}\``).join('\n');
  const claude = { number: 605, node_id: 'PR_node', state: 'open', draft: false, additions: 1, deletions: 0, changed_files: 1, html_url: 'https://github.com/JagPat/PMCvitan/pull/605', body: `<!-- correction-owner: claude -->\n${checklist}\nReplaces: none`, head: { sha: head, ref: 'claude/unit', repo: { full_name: 'JagPat/PMCvitan' } }, base: { ref: 'main', sha: base, repo: { full_name: 'JagPat/PMCvitan' } } };
  let current = claude;
  const statusWrites = [];
  const sticky = [];
  let readyCalls = 0;
  const checks = REQUIRED_CHECKS.map((name) => ({ name, status: 'completed', conclusion: 'success', started_at: '2026-09-16T12:00:00Z' }));
  const client = {
    repository: 'JagPat/PMCvitan',
    async pullRequest() { return current; },
    async pullRequestFiles() { return [{ filename: 'scripts/example.mjs', additions: 1, deletions: 0, changes: 1 }]; },
    async replacementLineage() { return { requiredReplacements: [], replacementPullRequests: [] }; },
    async statuses() { return statusWrites.map((value, index) => ({ id: index + 1, context: 'codex-current-head', ...value })); },
    async checkRuns() { return checks; },
    async reviewComments() { return []; },
    async reviews() { return []; },
    async reactions() { return []; },
    async setStatus(_head, state, description) { statusWrites.unshift({ state, description }); },
    async setDraft(_pull, draft) {
      if (!draft) readyCalls += 1;
      current = draft ? { ...current, body: '<!-- correction-owner: codex -->', draft: true } : { ...current, draft: false };
      return current;
    },
    async updateStickyComment(_number, body) { sticky.push(body); },
  };
  await run({ context: { number: 605, expectedHead: head, ciConclusion: 'success' }, client });
  assert.equal(readyCalls, 0, 'the full orchestrator never requests READY after the owner transfer');
  assert.equal(statusWrites.some(({ state, description }) => state === 'failure' && /timed out/u.test(description)), false);
  assert.equal(sticky.some((body) => /timed out/u.test(body)), false);
  assert.equal(statusWrites.filter(({ state }) => state === 'pending').length >= 2, true);
});
