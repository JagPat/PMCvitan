import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyClaudeShadowReview } from './claude-review-adapter.mjs';
import { parseCorrectionOwner, parseCommitCorrectionOwner, correctionRouting, correctionOwnerProblem } from './correction-owner.mjs';
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

// --- Commit-addressed ownership, positive eligibility, fail-closed merge (PR #598 batch) ---
// Ownership is the `Correction-Owner:` trailer in the head COMMIT, content-addressed by the SHA;
// the PR body is descriptive only. Promotion/success/recovery/merge require POSITIVE eligibility
// (a cleanly declared, non-Codex commit owner); a real transfer needs a NEW commit (a new head).
const REQUIRED = REQUIRED_CHECKS.map((name) => ({ name, status: 'completed', conclusion: 'success' }));
const ownerCommit = (owner, sha = head) => ({ sha, commit: { message: `chore: unit\n\nCorrection-Owner: ${owner}\n` } });
const noOwnerCommit = (sha = head) => ({ sha, commit: { message: 'chore: unit with no trailer\n' } });
const pullAt = (number, overrides = {}) => ({
  number, state: 'open', draft: false, node_id: 'PR', html_url: 'https://github.com/JagPat/PMCvitan/pull/x',
  head: { sha: head, ref: 'codex/unit', repo: { full_name: 'JagPat/PMCvitan' } },
  base: { ref: 'main', sha: base, repo: { full_name: 'JagPat/PMCvitan' } }, ...overrides,
});

test('commit-owner trailer parses one owner strictly and fails closed otherwise', () => {
  assert.equal(parseCommitCorrectionOwner('x\n\nCorrection-Owner: claude\n').owner, 'claude');
  assert.equal(parseCommitCorrectionOwner('x\n\nCorrection-Owner: codex').owner, 'codex');
  assert.equal(parseCommitCorrectionOwner('no trailer here').state, 'missing');
  assert.equal(parseCommitCorrectionOwner('Correction-Owner: claude\nCorrection-Owner: claude\n').state, 'conflicting');
  assert.equal(parseCommitCorrectionOwner('Correction-Owner: claude\nCorrection-Owner: cursor\n').state, 'conflicting');
  assert.equal(parseCommitCorrectionOwner('Correction-Owner: nobody\n').state, 'invalid');
  for (const bad of ['missing', 'conflicting', 'invalid']) {
    // eslint-disable-next-line no-unused-expressions
    assert.equal(parseCommitCorrectionOwner(bad === 'missing' ? '' : bad === 'conflicting' ? 'Correction-Owner: a\nCorrection-Owner: b\n' : 'Correction-Owner: zzz\n').owner, null);
  }
});

test('automatic merge needs an eligible commit owner, CI and exact-head review, no human authorization', async () => {
  const pull = pullAt(600);
  const makeClient = ({ pulls = [pull, pull], statuses = [{ context: 'codex-current-head', state: 'success' }], runs = REQUIRED, commit = ownerCommit('claude') } = {}) => ({
    repository: 'JagPat/PMCvitan',
    async commit() { return commit; },
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
    assert.equal((await authorizeExactHeadMerge(makeClient({ runs: REQUIRED.map((r) => (r.name === name ? { ...r, conclusion: 'failure' } : r)) }), pull, head)).state, 'gates_not_green');
  }
});

test('authoritative ownership is the head commit trailer, immutable under body edits and fresh objects', async () => {
  const clientFor = (commitOwner) => ({
    repository: 'JagPat/PMCvitan',
    async commit() { return ownerCommit(commitOwner); },
    async pullRequest() { return pullAt(600); },
    async statuses() { return [{ context: 'codex-current-head', state: 'success' }]; },
    async checkRuns() { return REQUIRED; },
  });
  // Same head H, opposite BODY markers on fresh objects → the same authoritative owner (the commit).
  const bodyClaude = pullAt(600, { body: '<!-- correction-owner: claude -->' });
  assert.equal((await authorizeExactHeadMerge(clientFor('codex'), bodyClaude, head)).state, 'validation_only_codex_owner');
  const bodyCodex = pullAt(600, { body: '<!-- correction-owner: codex -->' });
  assert.equal((await authorizeExactHeadMerge(clientFor('claude'), bodyCodex, head)).allowed, true);
});

test('a missing / malformed / wrong-SHA commit-owner trailer is held fail-closed: no READY, review, success or merge', async () => {
  for (const commit of [
    noOwnerCommit(),
    ownerCommit('claude', 'c'.repeat(40)),
    { sha: head, commit: { message: 'Correction-Owner: claude\nCorrection-Owner: cursor\n' } },
  ]) {
    const events = [];
    const pull = pullAt(606);
    const client = {
      repository: 'JagPat/PMCvitan',
      async commit() { return commit; },
      async pullRequest() { return pull; },
      async statuses() { return [{ context: 'codex-current-head', state: 'success' }]; },
      async checkRuns() { return REQUIRED; },
      async setStatus(_h, state, description) { events.push(['status', state, description]); },
      async setDraft(p, draft) { events.push(['draft', draft]); return { ...p, draft }; },
      async disableAutoMerge() { events.push(['disableAutoMerge']); },
      async mergeExactHead() { events.push(['merge']); return { merged: true }; },
      async enableAutoMerge() { events.push(['enableAutoMerge']); },
      async dispatchHandoff() {},
    };
    assert.equal((await authorizeExactHeadMerge(client, pull, head)).state, 'owner_not_merge_eligible');
    assert.equal(await completeReviewedPullRequest(client, pull, head), 'held_for_gates');
    const held = await setDraftForCurrentHead(client, 606, head, false);
    assert.equal(held.draft, true, 'a missing-binding head is held as draft, never promoted');
    assert.equal(events.some(([k, v]) => k === 'draft' && v === false), false, 'never promoted to READY');
    assert.equal(events.some(([k]) => k === 'merge'), false, 'never merged');
    assert.equal(events.some(([k]) => k === 'enableAutoMerge'), false, 'never arms auto-merge');
  }
});

test('a real transfer H1->H2 is rejected by the exact-H1 authorization and merge', async () => {
  const H2 = 'c'.repeat(40);
  const pull1 = pullAt(607);
  const pull2 = pullAt(607, { head: { sha: H2, repo: { full_name: 'JagPat/PMCvitan' } } });
  let mergeSha = null;
  const client = {
    repository: 'JagPat/PMCvitan',
    async commit() { return ownerCommit('claude'); },
    async pullRequest() { return pull2; },
    async statuses() { return [{ context: 'codex-current-head', state: 'success' }]; },
    async checkRuns() { return REQUIRED; },
    async mergeExactHead(_n, sha) { mergeSha = sha; return { merged: false }; },
    async enableAutoMerge() { throw new Error('auto-merge must not be armed'); },
    async dispatchHandoff() {},
  };
  assert.equal((await authorizeExactHeadMerge(client, pull1, head)).state, 'superseded');
  assert.equal(await completeReviewedPullRequest(client, pull1, head), 'held_for_gates');
  assert.equal(mergeSha, null, 'no merge is attempted once the head has moved');
});

test('a Codex commit owner is held across merge authorization and recovered terminal success, and armed auto-merge is reconciled', async () => {
  const codexPull = pullAt(601, { auto_merge: { enabled_by: {} } });
  let current = codexPull;
  const mutations = [];
  const client = {
    repository: 'JagPat/PMCvitan',
    async commit() { return ownerCommit('codex'); },
    async pullRequest() { return current; },
    async statuses() { return [{ context: 'codex-current-head', state: 'success' }]; },
    async checkRuns() { return REQUIRED; },
    async setStatus(_h, state, description) { mutations.push(['status', state, description]); },
    async setDraft(_p, draft) { mutations.push(['draft', draft]); current = { ...current, draft }; return current; },
    async disableAutoMerge() { mutations.push(['disableAutoMerge']); },
  };
  assert.equal((await authorizeExactHeadMerge(client, codexPull, head)).state, 'validation_only_codex_owner');
  assert.equal(await ensureTerminalReviewState(client, codexPull, head, { context: 'codex-current-head', state: 'success' }, [{ context: 'codex-current-head', state: 'success' }]), true);
  assert.deepEqual(mutations.map((m) => m.slice(0, 2)), [['status', 'pending'], ['disableAutoMerge'], ['draft', true]]);
});

test('a terminal Codex failure stays a truthful failure, never masked with a validation pending', async () => {
  const codexPull = pullAt(608);
  let current = codexPull;
  const statusWrites = [];
  const failure = { id: 5, context: 'codex-current-head', state: 'failure', description: 'review: current-head Codex finding' };
  const client = {
    repository: 'JagPat/PMCvitan',
    async commit() { return ownerCommit('codex'); },
    async pullRequest() { return current; },
    async setStatus(_h, state, description) { statusWrites.push({ state, description }); },
    async setDraft(_p, draft) { current = { ...current, draft }; return current; },
    async disableAutoMerge() {},
  };
  assert.equal(await ensureTerminalReviewState(client, codexPull, head, failure, [failure]), true);
  assert.equal(statusWrites.some((s) => s.state === 'pending'), false, 'a terminal failure is never replaced with pending');
});

test('promotion and final-policy require positive eligibility: Codex and missing-owner heads are held', async () => {
  for (const commit of [ownerCommit('codex'), noOwnerCommit()]) {
    let current = pullAt(602);
    const drafts = [];
    const client = {
      repository: 'JagPat/PMCvitan',
      async commit() { return commit; },
      async pullRequest() { return current; },
      async statuses() { return [{ context: 'codex-current-head', state: 'success' }]; },
      async setDraft(_p, draft) { drafts.push(draft); current = { ...current, draft }; return current; },
      async setStatus() {},
      async disableAutoMerge() {},
    };
    assert.equal((await reviewAttempt(client, pullAt(602), head, 1, new Date().toISOString())).state, 'held_ineligible_owner');
    assert.equal(drafts.some((d) => d === false), false, 'never promoted READY');
    assert.equal((await revalidateFinalReviewPolicy(client, 602, head)).state, 'held_ineligible_owner');
  }
});

test('completeReviewedPullRequest merges the exact head or holds fail-closed, never arming auto-merge', async () => {
  const pull = pullAt(603);
  const baseClient = () => ({
    repository: 'JagPat/PMCvitan',
    async commit() { return ownerCommit('claude'); },
    async pullRequest() { return pull; },
    async statuses() { return [{ context: 'codex-current-head', state: 'success' }]; },
    async checkRuns() { return REQUIRED; },
    async enableAutoMerge() { throw new Error('auto-merge must not be armed in the validation stage'); },
    async dispatchHandoff() {},
  });
  assert.equal(await completeReviewedPullRequest({ ...baseClient(), async mergeExactHead() { return { merged: true }; } }, pull, head), 'merged');
  assert.equal(await completeReviewedPullRequest({ ...baseClient(), async mergeExactHead() { return { merged: false }; } }, pull, head), 'held_for_gates');
});

test('the real GitHubClient draft seam never emits READY for a Codex commit owner', async () => {
  const codex = pullAt(604, { node_id: 'PR_node', draft: true });
  const client = new GitHubClient({ repository: 'JagPat/PMCvitan', token: 'unused' });
  const mutations = [];
  client.pullRequest = async () => codex;
  client.commit = async () => ownerCommit('codex');
  client.statuses = async () => [{ context: 'codex-current-head', state: 'success' }];
  client.setStatus = async () => {};
  client.request = async () => ({});
  client.graphql = async (query) => { mutations.push(query); return {}; };
  const held = await setDraftForCurrentHead(client, 604, head, false);
  assert.equal(held.draft, true);
  assert.equal(mutations.some((query) => query.includes('markPullRequestReadyForReview')), false);
});

test('full run holds a non-eligible head without retry or timeout failure, never READY', async () => {
  const checklist = ['concurrency-serialization', 'old-release-migration-compatibility', 'trigger-alternate-writers', 'authorization-tenancy', 'ci-reproduce-first'].map((item) => `- [x] \`${item}\``).join('\n');
  const codexBody = pullAt(605, { additions: 1, deletions: 0, changed_files: 1, body: `<!-- correction-owner: codex -->\n${checklist}\nReplaces: none` });
  let current = codexBody;
  const statusWrites = [];
  let readyCalls = 0;
  const checks = REQUIRED.map((r) => ({ ...r, started_at: '2026-09-16T12:00:00Z' }));
  const client = {
    repository: 'JagPat/PMCvitan',
    async commit() { return ownerCommit('codex'); },
    async pullRequest() { return current; },
    async pullRequestFiles() { return [{ filename: 'scripts/example.mjs', additions: 1, deletions: 0, changes: 1 }]; },
    async replacementLineage() { return { requiredReplacements: [], replacementPullRequests: [] }; },
    async statuses() { return statusWrites.map((value, index) => ({ id: index + 1, context: 'codex-current-head', ...value })); },
    async checkRuns() { return checks; },
    async reviewComments() { return []; },
    async reviews() { return []; },
    async reactions() { return []; },
    async setStatus(_h, state, description) { statusWrites.unshift({ state, description }); },
    async setDraft(_p, draft) { if (!draft) readyCalls += 1; current = { ...current, draft }; return current; },
    async disableAutoMerge() {},
    async updateStickyComment() {},
  };
  await run({ context: { number: 605, expectedHead: head, ciConclusion: 'success' }, client });
  assert.equal(readyCalls, 0, 'the full orchestrator never requests READY for a non-eligible head');
  assert.equal(statusWrites.some(({ state, description }) => state === 'failure' && /timed out/u.test(description)), false);
  assert.equal(statusWrites.some(({ state }) => state === 'pending'), true);
});

test('failed CI records a truthful failure and routes, never a masking pending, even over a stale terminal success', async () => {
  const checklist = ['concurrency-serialization', 'old-release-migration-compatibility', 'trigger-alternate-writers', 'authorization-tenancy', 'ci-reproduce-first'].map((item) => `- [x] \`${item}\``).join('\n');
  const codexBody = pullAt(609, { additions: 1, deletions: 0, changed_files: 1, body: `<!-- correction-owner: codex -->\n${checklist}\nReplaces: none` });
  let current = codexBody;
  const statusWrites = [];
  const seed = [{ id: 1, context: 'codex-current-head', state: 'success', description: 'review: Codex found no blocking issue on this exact head' }];
  const failingChecks = REQUIRED.map((r, i) => (i === 0 ? { ...r, conclusion: 'failure' } : r));
  const client = {
    repository: 'JagPat/PMCvitan',
    async commit() { return ownerCommit('codex'); },
    async pullRequest() { return current; },
    async pullRequestFiles() { return [{ filename: 'scripts/example.mjs', additions: 1, deletions: 0, changes: 1 }]; },
    async replacementLineage() { return { requiredReplacements: [], replacementPullRequests: [] }; },
    async statuses() { return [...statusWrites.map((value, index) => ({ id: 100 + index, context: 'codex-current-head', ...value })), ...seed]; },
    async checkRuns() { return failingChecks; },
    async setStatus(_h, state, description) { statusWrites.unshift({ state, description }); },
    async setDraft(_p, draft) { current = { ...current, draft }; return current; },
    async disableAutoMerge() {},
    async updateStickyComment() {},
  };
  await assert.rejects(run({ context: { number: 609, expectedHead: head, ciConclusion: 'failure' }, client }), /Failed checks/u);
  assert.equal(statusWrites.some(({ state, description }) => state === 'failure' && description.startsWith('ci:')), true, 'a truthful ci: failure is recorded, overriding the stale terminal success');
  assert.equal(statusWrites[0].state, 'failure', 'the last write is the failure, not a masking validation pending');
  assert.equal(statusWrites.some(({ state }) => state === 'pending'), false, 'no masking pending is written');
});
