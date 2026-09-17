import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyClaudeShadowReview } from './claude-review-adapter.mjs';
import {
  parseCorrectionOwner,
  parseCommitCorrectionOwner,
  correctionRouting,
  correctionOwnerProblem,
  CORRECTION_OWNERS,
} from './correction-owner.mjs';
import {
  authorizeExactHeadMerge,
  completeReviewedPullRequest,
  GitHubClient,
  REQUIRED_CHECKS,
} from './autonomous-review-gate.mjs';
import { OWNERSHIP_READ_RETRY, isRetryableReviewFailureDescription } from './review-policy.mjs';

const head = 'a'.repeat(40);
const base = 'b'.repeat(40);

// The exact HEAD commit the gate reads to resolve merge authority: its terminal Correction-Owner trailer.
const ownerCommit = (owner, sha = head) => ({ sha, commit: { message: `chore: unit\n\nCorrection-Owner: ${owner}\n` } });
const noOwnerCommit = (sha = head) => ({ sha, commit: { message: 'chore: unit with no trailer\n' } });

test('Codex is admitted as a truthful candidate correction owner, but is never merge-eligible', () => {
  // Admitting `codex` tracks a Codex-owned corrective head as an in-flight unit; it is NOT awakenable and
  // NOT merge-eligible — the implementation task and reviewer share one bot identity, held pending
  // independent reviewer activation (docs/POLICY.md). A transfer marker cannot bypass that hold.
  assert.deepEqual([...CORRECTION_OWNERS], ['claude', 'cursor', 'codex']);
  for (const ref of ['codex/maintenance', 'codex/product']) {
    const body = '<!-- correction-owner: codex -->\n<!-- correction-transfer: claude->codex -->';
    const declaration = parseCorrectionOwner(body, { headRef: ref });
    assert.equal(declaration.state, 'declared');
    assert.equal(declaration.owner, 'codex');
    assert.equal(correctionOwnerProblem({ body, head: { ref } }), null, 'an admitted candidate passes scope');
    const route = correctionRouting({ declaration, head });
    assert.equal(route.owner, 'codex');
    assert.equal(route.awakenable, false, 'codex is admitted but not GitHub-awakenable');
  }
  // The exact HEAD commit trailer also resolves codex (the merge gate reads the trailer, not the body).
  assert.equal(parseCommitCorrectionOwner('x\n\nCorrection-Owner: codex\n').state, 'declared');
  assert.equal(parseCommitCorrectionOwner('x\n\nCorrection-Owner: codex\n').owner, 'codex');
});
function cleanRun(overrides = {}) {
  const artifact = { id: 789, digest: `sha256:${'d'.repeat(64)}`, name: `claude-shadow-v1-repo-${Buffer.from('JagPat/PMCvitan').toString('base64url')}-pr-600-base-${base}-head-${head}-ci-123-2-publisher-456-1-state-clear-findings-0` };
  return { id: 7, name: 'claude-independent-review', head_sha: head, app: { slug: 'github-actions' }, external_id: `pmcvitan:claude-shadow:v1:repo-JagPat/PMCvitan:pr-600:base-${base}:head-${head}:run-123:attempt-2:publisher-456:publisher-attempt-1`, status: 'completed', conclusion: 'success', completed_at: '2026-09-14T12:00:00Z', output: { summary: JSON.stringify({ schema: 1, repository: 'JagPat/PMCvitan', pullRequest: 600, baseSha: base, headSha: head, runId: 123, runAttempt: 2, publisherRunId: 456, publisherRunAttempt: 1, workflowRef: 'JagPat/PMCvitan/.github/workflows/claude-shadow-review.yml@refs/heads/main', workflowSha: base, state: 'clear', findingCount: 0, artifact }) }, ...overrides };
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
  assert.equal((await classify([alteredSummary({ workflowSha: 'c'.repeat(40) })])).state, 'replayed');
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
  const workflowRun = { id: 456, run_attempt: 1, path: '.github/workflows/claude-shadow-review.yml', event: 'workflow_run', status: 'completed', conclusion: 'success', head_sha: base, repository: { full_name: 'JagPat/PMCvitan' } };
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
  assert.equal(await makeClient({ run: { ...workflowRun, head_sha: 'c'.repeat(40) } }).verifyClaudeShadowProducer(cleanRun(), evidence), false);
  assert.equal(await makeClient({ jobs: [{ ...job, conclusion: 'failure' }] }).verifyClaudeShadowProducer(cleanRun(), evidence), false);
  assert.equal(await makeClient({ artifacts: [{ ...artifact, name: 'copied-evidence' }] }).verifyClaudeShadowProducer(cleanRun(), evidence), false);
  assert.equal(await makeClient({ artifacts: [{ ...artifact, digest: `sha256:${'e'.repeat(64)}` }] }).verifyClaudeShadowProducer(cleanRun(), evidence), false);
});

test('automatic merge needs an eligible commit owner, CI and exact-head review, with no human authorization', async () => {
  const pull = { number: 600, state: 'open', draft: false, head: { sha: head, repo: { full_name: 'JagPat/PMCvitan' } }, base: { ref: 'main', sha: base, repo: { full_name: 'JagPat/PMCvitan' } } };
  const checks = REQUIRED_CHECKS.map((name) => ({ name, status: 'completed', conclusion: 'success' }));
  const makeClient = ({ pulls = [pull, pull], statuses = [{ context: 'codex-current-head', state: 'success' }], runs = checks, commit = ownerCommit('claude') } = {}) => ({
    repository: 'JagPat/PMCvitan',
    async pullRequest() { return pulls.shift() ?? pull; },
    async commit() { return commit; },
    async statuses() { return statuses; },
    async checkRuns() { return runs; },
    async paginated() { throw new Error('Merge must not fetch human authorization comments'); },
  });
  assert.equal((await authorizeExactHeadMerge(makeClient(), pull, head)).allowed, true);
  // Merge authority is the IMMUTABLE HEAD trailer, not the body marker: an eligible non-codex trailer
  // (cursor) authorizes the merge on its own.
  assert.equal((await authorizeExactHeadMerge(makeClient({ commit: ownerCommit('cursor') }), pull, head)).allowed, true);
  // A Codex candidate head is validation-only, never merged.
  assert.equal((await authorizeExactHeadMerge(makeClient({ commit: ownerCommit('codex') }), pull, head)).state, 'validation_only_codex_owner');
  // A missing/unknown trailer confers no owner, so it is not merge-eligible (terminal, not retryable).
  const noTrailer = await authorizeExactHeadMerge(makeClient({ commit: noOwnerCommit() }), pull, head);
  assert.equal(noTrailer.state, 'owner_not_merge_eligible');
  assert.notEqual(noTrailer.retryable, true);
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

test('an unreadable exact-head commit is a retryable ownership hold, never a stranding merge or a false fault', async () => {
  // The exact HEAD commit read itself failing is transient infrastructure, not an ownership accusation:
  // authorizeExactHeadMerge returns a retryable `owner_read_retry`, and completeReviewedPullRequest
  // publishes OWNERSHIP_READ_RETRY (a retryable-review-failure the watchdog re-dispatches) and holds —
  // never merging or arming auto-merge. A READABLE no-trailer head, by contrast, is a terminal ineligibility.
  const pull = { number: 600, state: 'open', draft: false, html_url: 'https://pr', head: { sha: head, repo: { full_name: 'JagPat/PMCvitan' } }, base: { ref: 'main', sha: base, repo: { full_name: 'JagPat/PMCvitan' } } };
  const checks = REQUIRED_CHECKS.map((name) => ({ name, status: 'completed', conclusion: 'success' }));
  // `throwOn` picks which commit() call (1 = pre-gate, 2 = final reread) throws; both must be retryable.
  const unreadableClient = (throwOn) => {
    let calls = 0;
    const effects = { statusWrites: [], merged: 0, armed: 0 };
    return { effects, repository: 'JagPat/PMCvitan',
      async commit() { calls += 1; if (calls === throwOn) throw new Error('transient read failure'); return ownerCommit('claude'); },
      async pullRequest() { return pull; },
      async statuses() { return [{ context: 'codex-current-head', state: 'success' }]; },
      async checkRuns() { return checks; },
      async setStatus(sha, state, description, url) { effects.statusWrites.push({ state, description, url }); },
      async mergeExactHead() { effects.merged += 1; return { merged: true }; },
      async enableAutoMerge() { effects.armed += 1; },
      async dispatchHandoff() {} };
  };
  for (const throwOn of [1, 2]) {
    const auth = await authorizeExactHeadMerge(unreadableClient(throwOn), pull, head);
    assert.equal(auth.allowed, false);
    assert.equal(auth.state, 'owner_read_retry', `commit() #${throwOn} unreadable is a retryable read, not an ineligibility`);
    assert.equal(auth.retryable, true);
    const client = unreadableClient(throwOn);
    assert.equal(await completeReviewedPullRequest(client, pull, head), 'held_for_read_retry');
    assert.equal(client.effects.merged, 0, 'an unreadable head is never merged');
    assert.equal(client.effects.armed, 0, 'an unreadable head never arms native auto-merge');
    const retry = client.effects.statusWrites.find((w) => w.description === OWNERSHIP_READ_RETRY);
    assert.ok(retry, 'the retryable ownership-read status is published so the watchdog re-dispatches');
    assert.equal(retry.state, 'failure');
    assert.equal(isRetryableReviewFailureDescription(retry.description), true);
  }
  // A readable no-trailer head is terminal (held_for_gates), never routed through OWNERSHIP_READ_RETRY.
  const readableUnowned = { repository: 'JagPat/PMCvitan', statusWrites: [],
    async commit() { return noOwnerCommit(); },
    async pullRequest() { return pull; },
    async statuses() { return [{ context: 'codex-current-head', state: 'success' }]; },
    async checkRuns() { return checks; },
    async setStatus(sha, state, description) { this.statusWrites.push({ description }); },
    async mergeExactHead() { throw new Error('must not merge'); },
    async enableAutoMerge() { throw new Error('must not arm'); },
    async dispatchHandoff() {} };
  assert.equal(await completeReviewedPullRequest(readableUnowned, pull, head), 'held_for_gates');
  assert.equal(readableUnowned.statusWrites.find((w) => w.description === OWNERSHIP_READ_RETRY), undefined);
});
