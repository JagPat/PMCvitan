import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyClaudeShadowReview } from './claude-review-adapter.mjs';
import { parseCorrectionOwner, parseCommitCorrectionOwner, correctionRouting, correctionOwnerProblem } from './correction-owner.mjs';
import { authorizeExactHeadMerge, completeReviewedPullRequest, enforceReviewScope, ensureTerminalReviewState, GitHubClient, recoverExactHeadMerge, REQUIRED_CHECKS, revalidateFinalReviewPolicy, reviewAttempt, run, setDraftForCurrentHead } from './autonomous-review-gate.mjs';
import { MERGE_RECOVERY_OWED } from './review-policy.mjs';
import { gateRecoveryStatus } from './correction-lease.mjs';

const head = 'a'.repeat(40);
const base = 'b'.repeat(40);
const checklist = ['concurrency-serialization', 'old-release-migration-compatibility', 'trigger-alternate-writers', 'authorization-tenancy', 'ci-reproduce-first'].map((item) => `- [x] \`${item}\``).join('\n');

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

// Unit A adapter fail-closed coverage (preserved as installed on main; B defers its metadata
// tightening to the later full consumer).
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

const REQUIRED = REQUIRED_CHECKS.map((name) => ({ name, status: 'completed', conclusion: 'success' }));
const ownerCommit = (owner, sha = head) => ({ sha, commit: { message: `chore: unit\n\nCorrection-Owner: ${owner}\n` } });
const noOwnerCommit = (sha = head) => ({ sha, commit: { message: 'chore: unit with no trailer\n' } });
const pullAt = (number, overrides = {}) => ({
  number, state: 'open', draft: false, node_id: 'PR', html_url: 'https://github.com/JagPat/PMCvitan/pull/x',
  body: '<!-- correction-owner: claude -->',
  head: { sha: head, ref: 'codex/unit', repo: { full_name: 'JagPat/PMCvitan' } },
  base: { ref: 'main', sha: base, repo: { full_name: 'JagPat/PMCvitan' } }, ...overrides,
});

test('the commit-owner trailer is read only from the terminal trailer block, Git-faithfully', () => {
  assert.equal(parseCommitCorrectionOwner('x\n\nCorrection-Owner: claude\n').owner, 'claude');
  assert.equal(parseCommitCorrectionOwner('x\n\nCorrection-Owner: codex').owner, 'codex');
  assert.equal(parseCommitCorrectionOwner('x\n\ncorrection-owner: claude\n').owner, 'claude');
  assert.equal(parseCommitCorrectionOwner(
    'fix: x\n\nbody\n\nCorrection-Owner: claude\n'
    + 'Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>\n'
    + 'Claude-Session: https://claude.ai/code/session_x\n',
  ).owner, 'claude');
  assert.equal(parseCommitCorrectionOwner('no trailer here').state, 'missing');
  assert.equal(parseCommitCorrectionOwner('subject only\n').state, 'missing');
  assert.equal(parseCommitCorrectionOwner('doc: how to\n\n```\nCorrection-Owner: claude\n```\n').state, 'missing');
  assert.equal(parseCommitCorrectionOwner('doc\n\nUse Correction-Owner: claude\n\nMore prose.\n').state, 'missing');
  assert.equal(parseCommitCorrectionOwner('x\n\nCorrection-Owner: claude\nCorrection-Owner: claude\n').state, 'conflicting');
  assert.equal(parseCommitCorrectionOwner('x\n\nCorrection-Owner: claude\nCorrection-Owner: cursor\n').state, 'conflicting');
  assert.equal(parseCommitCorrectionOwner('x\n\nCorrection-Owner: claude\nCorrection-Owner:codex\n').state, 'conflicting');
  assert.equal(parseCommitCorrectionOwner('x\n\nCorrection-Owner: claude\ncorrection-owner:codex\n').state, 'conflicting');
  assert.equal(parseCommitCorrectionOwner('x\n\nCorrection-Owner: claude\n codex\n').state, 'invalid');
  assert.equal(parseCommitCorrectionOwner('x\n\nCorrection-Owner: nobody\n').state, 'invalid');
  // A continuation before the first trailer is not a valid block (git interpret-trailers rejects it),
  // so it confers no owner rather than skipping the leading continuation and accepting a later trailer.
  assert.equal(parseCommitCorrectionOwner('x\n\n leading continuation\nCorrection-Owner: claude\nCo-Authored-By: y <y@z>\n').state, 'missing');
  for (const message of [
    '',
    'x\n\nCorrection-Owner: a\nCorrection-Owner: b\n',
    'x\n\nCorrection-Owner: zzz\n',
    'x\n\nCorrection-Owner: claude\n codex\n',
    'doc\n\n```\nCorrection-Owner: claude\n```\n',
    'x\n\n leading continuation\nCorrection-Owner: claude\n',
  ]) {
    assert.equal(parseCommitCorrectionOwner(message).owner, null);
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
  // F1 P1-2: a MERGE_RECOVERY_OWED head (its merge left unconfirmed) authorizes the merge RETRY on
  // real prior clean evidence plus fresh green gates — never requiring the owed marker itself to be a
  // success, which would strand recovery forever. It still refuses a buried finding, a pending review,
  // or no prior clean, so it never invents clearance or overrides a new finding.
  const owed = { context: 'codex-current-head', state: 'failure', description: MERGE_RECOVERY_OWED };
  const clean = { context: 'codex-current-head', state: 'success' };
  const finding = { context: 'codex-current-head', state: 'failure', description: 'review: current-head Codex finding' };
  const pending = { context: 'codex-current-head', state: 'pending' };
  assert.equal((await authorizeExactHeadMerge(makeClient({ statuses: [owed, clean] }), pull, head)).allowed, true);
  assert.equal((await authorizeExactHeadMerge(makeClient({ statuses: [owed] }), pull, head)).state, 'gates_not_green');
  assert.equal((await authorizeExactHeadMerge(makeClient({ statuses: [owed, finding, clean] }), pull, head)).state, 'gates_not_green');
  assert.equal((await authorizeExactHeadMerge(makeClient({ statuses: [owed, pending, clean] }), pull, head)).state, 'gates_not_green');
  // The owed head with prior clean is still refused when the fresh required CI is not green — the
  // recovery authorizes review clearance from history but demands live gates on every path.
  assert.equal((await authorizeExactHeadMerge(makeClient({ statuses: [owed, clean], runs: [] }), pull, head)).state, 'gates_not_green');
  // P1-2 dispatchability: a producer that writes only the owed failure (no self-persisted request)
  // leaves it dispatchable; a pending accepted request suppresses re-dispatch.
  assert.ok(gateRecoveryStatus({ statuses: [{ id: 9, ...owed }] }), 'an owed failure with no request is dispatchable');
  assert.equal(
    gateRecoveryStatus({ statuses: [{ id: 9, ...owed }, { context: 'codex-recovery-request/9', state: 'pending', description: 'recovery: requested terminal status 9' }] }),
    null,
    'an accepted pending request suppresses re-dispatch',
  );
});

test('the commit trailer is the immutable anchor; a body/trailer mismatch is held, never merged', async () => {
  const clientFor = (commitOwner, bodyOwner) => ({
    repository: 'JagPat/PMCvitan',
    async commit() { return ownerCommit(commitOwner); },
    async pullRequest() { return pullAt(600, { body: `<!-- correction-owner: ${bodyOwner} -->` }); },
    async statuses() { return [{ context: 'codex-current-head', state: 'success' }]; },
    async checkRuns() { return REQUIRED; },
  });
  assert.equal((await authorizeExactHeadMerge(clientFor('codex', 'claude'), pullAt(600), head)).state, 'validation_only_codex_owner');
  assert.equal((await authorizeExactHeadMerge(clientFor('claude', 'codex'), pullAt(600), head)).state, 'owner_not_merge_eligible');
  assert.equal((await authorizeExactHeadMerge(clientFor('claude', 'claude'), pullAt(600), head)).allowed, true);
});

test('a missing / malformed / wrong-SHA commit-owner trailer is held fail-closed: no READY, review, success or merge', async () => {
  for (const commit of [
    noOwnerCommit(),
    ownerCommit('claude', 'c'.repeat(40)),
    { sha: head, commit: { message: 'chore: unit\n\nCorrection-Owner: claude\nCorrection-Owner: cursor\n' } },
  ]) {
    const events = [];
    const pull = pullAt(606);
    const client = {
      repository: 'JagPat/PMCvitan',
      async commit() { return commit; },
      async pullRequest() { return pull; },
      async statuses() { return [{ context: 'codex-current-head', state: 'success' }]; },
      async checkRuns() { return REQUIRED; },
      async reviews() { return []; },
      async reviewComments() { return []; },
      async setStatus(_h, state, description) { events.push(['status', state, description]); },
      async setDraft(p, draft) { events.push(['draft', draft]); return { ...p, draft }; },
      async disableAutoMerge() { events.push(['disableAutoMerge']); },
      async updateStickyComment() { events.push(['sticky']); },
      async mergeExactHead() { events.push(['merge']); return { merged: true }; },
      async enableAutoMerge() { events.push(['enableAutoMerge']); },
      async dispatchHandoff() {},
    };
    assert.equal((await authorizeExactHeadMerge(client, pull, head)).state, 'owner_not_merge_eligible');
    assert.equal(await completeReviewedPullRequest(client, pull, head), 'held_for_gates');
    const held = await setDraftForCurrentHead(client, 606, head, false);
    assert.equal(held.draft, true, 'a missing-binding head is held as draft, never promoted');
    assert.equal(events.some(([k, s]) => k === 'status' && s === 'failure'), true, 'unresolved ownership is an actionable failure');
    assert.equal(events.some(([k, s]) => k === 'status' && s === 'pending'), false, 'never a silent pending for unresolved ownership');
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
  const codexPull = pullAt(601, { auto_merge: { enabled_by: {} }, body: '<!-- correction-owner: codex -->' });
  let current = codexPull;
  const mutations = [];
  const client = {
    repository: 'JagPat/PMCvitan',
    async commit() { return ownerCommit('codex'); },
    async pullRequest() { return current; },
    async statuses() { return [{ context: 'codex-current-head', state: 'success' }]; },
    async checkRuns() { return REQUIRED; },
    async reviews() { return []; },
    async reviewComments() { return []; },
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
      async checkRuns() { return REQUIRED; },
      async reviews() { return []; },
      async reviewComments() { return []; },
      async setDraft(_p, draft) { drafts.push(draft); current = { ...current, draft }; return current; },
      async setStatus() {},
      async disableAutoMerge() {},
      async updateStickyComment() {},
    };
    assert.equal((await reviewAttempt(client, pullAt(602), head, 1, new Date().toISOString())).state, 'held_ineligible_owner');
    assert.equal(drafts.some((d) => d === false), false, 'never promoted READY');
    assert.equal((await revalidateFinalReviewPolicy(client, 602, head)).state, 'held_ineligible_owner');
  }
});

test('finding 4032309588: an UNREADABLE head commit is a retryable infrastructure hold, not a "fix the trailer" scope fault', async () => {
  // The Correction-Owner trailer may be perfectly valid — the commit read itself failed — so the
  // controller must retry the infrastructure (a pending status the next cycle re-reads), never accuse
  // the owner with a scope failure demanding a fix. A readable-but-unowned commit still faults.
  const current = pullAt(613);
  let readable = false;
  const statusWrites = [];
  const drafts = [];
  const client = {
    repository: 'JagPat/PMCvitan',
    async commit() { if (!readable) throw new Error('502 reading commit'); return noOwnerCommit(); },
    async pullRequest() { return current; },
    async statuses() { return [{ context: 'codex-current-head', state: 'success' }]; },
    async checkRuns() { return REQUIRED; },
    async reviews() { return []; },
    async reviewComments() { return []; },
    async setStatus(_h, state, description) { statusWrites.push({ state, description }); },
    async setDraft(_p, draft) { drafts.push(draft); return { ...current, draft }; },
    async disableAutoMerge() {},
    async updateStickyComment() {},
  };
  assert.equal((await reviewAttempt(client, pullAt(613), head, 1, new Date().toISOString())).state, 'held_ineligible_owner');
  assert.equal(statusWrites.some((s) => s.state === 'pending' && /unreadable/u.test(s.description)), true, 'an unreadable commit holds with a retryable pending status');
  assert.equal(statusWrites.some((s) => /^scope:/u.test(s.description)), false, 'never a scope fault that accuses a possibly-valid trailer');
  assert.equal(drafts.some((d) => d === false), false, 'never promoted READY');
  // A commit that reads cleanly but carries no owner is a genuine scope fault, not an infra retry.
  readable = true;
  statusWrites.length = 0;
  await reviewAttempt(client, pullAt(613), head, 1, new Date().toISOString());
  assert.equal(statusWrites.some((s) => /^scope:/u.test(s.description)), true, 'a readable unowned commit is a scope fault');
});

test('completeReviewedPullRequest: merged, recoverable, or held fail-closed — never auto-merge, never a second merge', async () => {
  // F1 (comment 5705798316): every merge response is classified through one central handler —
  // 'merged' (confirmed), the recoverable 'merge_recovery_owed' (authorized but unconfirmed: racy
  // 405, transport loss, unreadable read), or 'held_for_gates' (no longer gate/owner eligible).
  // Auto-merge is never armed, and a merge that landed reconciles to a single handoff, no second.
  const pull = pullAt(603);
  const mergedRaw = { ...pull, merged: true };
  const baseClient = (over = {}) => ({
    repository: 'JagPat/PMCvitan',
    async commit() { return ownerCommit('claude'); },
    async pullRequest() { return pull; },
    async statuses() { return [{ context: 'codex-current-head', state: 'success' }]; },
    async checkRuns() { return REQUIRED; },
    async enableAutoMerge() { throw new Error('auto-merge must not be armed in the validation stage'); },
    async dispatchHandoff() {},
    ...over,
  });

  // Confirmed merge.
  assert.equal(await completeReviewedPullRequest(baseClient({ async mergeExactHead() { return { merged: true }; } }), pull, head), 'merged');

  // Racy 405 while the gates are still green → recoverable, not a silent hold.
  assert.equal(await completeReviewedPullRequest(baseClient({ async mergeExactHead() { return { merged: false, message: 'not ready' }; } }), pull, head), 'merge_recovery_owed');

  // Gates no longer green → genuine held_for_gates (re-authorization fails).
  assert.equal(await completeReviewedPullRequest(baseClient({ async statuses() { return [{ context: 'codex-current-head', state: 'pending' }]; }, async mergeExactHead() { return { merged: false }; } }), pull, head), 'held_for_gates');

  // Transport throw, then a raw re-read confirms THIS exact head merged → reconcile to merged, one
  // handoff, no second merge. A `thrown` flag models the timeline (authorization reads see the open
  // PR; only the post-throw confirming read sees it merged) independent of the read count.
  let handoffs = 0;
  let merges = 0;
  let thrown = false;
  assert.equal(await completeReviewedPullRequest(baseClient({
    async mergeExactHead() { merges += 1; thrown = true; throw new Error('502 bad gateway'); },
    async pullRequest() { return thrown ? mergedRaw : pull; },
    async dispatchHandoff() { handoffs += 1; },
  }), pull, head), 'merged');
  assert.equal(merges, 1, 'no second merge after a confirmed-merged reconciliation');
  assert.equal(handoffs, 1, 'exactly one handoff on reconciled completion');

  // Transport throw, raw re-read shows the head still open/unmerged → recoverable.
  assert.equal(await completeReviewedPullRequest(baseClient({
    async mergeExactHead() { throw new Error('502 bad gateway'); },
    async pullRequest() { return pull; },
  }), pull, head), 'merge_recovery_owed');

  // Transport throw AND the confirming read is itself unreadable → durable recoverable, never merged.
  let confirmPhase = false;
  assert.equal(await completeReviewedPullRequest(baseClient({
    async mergeExactHead() { confirmPhase = true; throw new Error('502 bad gateway'); },
    async pullRequest() { if (confirmPhase) throw new Error('confirming read failed'); return pull; },
  }), pull, head), 'merge_recovery_owed');

  // Finding 4032309599: a DEFINITIVE HTTP refusal (409 conflict, 422 unmergeable, 404 gone) whose
  // fresh raw re-read confirms the head is NOT merged must NOT mint a MERGE_RECOVERY_OWED sticky —
  // retrying the identical merge cannot clear it, so it is held for the ordinary gates. Only an
  // UNCERTAIN error (5xx / 408 / 429, or a statusless transport reject) mints the owed obligation.
  const withStatus = (status) => Object.assign(new Error(`merge failed (${status})`), { status });
  for (const status of [409, 422, 404, 403]) {
    assert.equal(await completeReviewedPullRequest(baseClient({
      async mergeExactHead() { throw withStatus(status); },
      async pullRequest() { return pull; },
    }), pull, head), 'held_for_gates', `a definitive ${status} is held, never owed`);
  }
  for (const status of [500, 502, 503, 408, 429]) {
    assert.equal(await completeReviewedPullRequest(baseClient({
      async mergeExactHead() { throw withStatus(status); },
      async pullRequest() { return pull; },
    }), pull, head), 'merge_recovery_owed', `an uncertain ${status} is recoverable`);
  }

  // Finding 4032309599 (changed unit): even an UNCERTAIN 5xx must NOT write recovery to an obsolete
  // SHA. When the confirming raw re-read shows a different current head, the unit is SUPERSEDED and is
  // held for the newer head's own cycle — never owed on the stale head (which would clobber its sticky).
  const H2 = 'c'.repeat(40);
  let phase = false;
  assert.equal(await completeReviewedPullRequest(baseClient({
    async mergeExactHead() { phase = true; throw withStatus(502); },
    async pullRequest() { return phase ? { ...pull, head: { ...pull.head, sha: H2 } } : pull; },
  }), pull, head), 'held_for_gates', 'a superseded head is held, never owed on the stale SHA');

  // Finding 4032309586 (root reconciliation r4032371697): a readable 405 is a CONFIRMED refusal by
  // branch protection, not an uncertain outcome. With the gates still green and the exact unit
  // unchanged, the selected B contract mints the durable, freshly authorized exact-SHA direct retry.
  assert.equal(await completeReviewedPullRequest(baseClient({
    async mergeExactHead() { return { merged: false, message: 'Required status check is expected' }; },
    async pullRequest() { return pull; },
  }), pull, head), 'merge_recovery_owed', 'a confirmed 405 with green gates is owed a durable retry');
  // A readable 405 whose raw re-read shows the head has moved is superseded, not owed.
  let put405 = false;
  assert.equal(await completeReviewedPullRequest(baseClient({
    async mergeExactHead() { put405 = true; return { merged: false, message: 'not ready' }; },
    async pullRequest() { return put405 ? { ...pull, head: { ...pull.head, sha: H2 } } : pull; },
  }), pull, head), 'held_for_gates', 'a confirmed 405 on a superseded head is held, never owed');
});

test('the real GitHubClient draft seam never emits READY for a Codex commit owner', async () => {
  const codex = pullAt(604, { node_id: 'PR_node', draft: true, body: '<!-- correction-owner: codex -->' });
  const client = new GitHubClient({ repository: 'JagPat/PMCvitan', token: 'unused' });
  const mutations = [];
  client.pullRequest = async () => codex;
  client.commit = async () => ownerCommit('codex');
  client.statuses = async () => [{ context: 'codex-current-head', state: 'success' }];
  client.reviews = async () => [];
  client.reviewComments = async () => [];
  client.checkRuns = async () => REQUIRED;
  client.setStatus = async () => {};
  client.request = async () => ({});
  client.graphql = async (query) => { mutations.push(query); return {}; };
  const held = await setDraftForCurrentHead(client, 604, head, false);
  assert.equal(held.draft, true);
  assert.equal(mutations.some((query) => query.includes('markPullRequestReadyForReview')), false);
});

test('full run holds a non-eligible head without retry or timeout failure, never READY', async () => {
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

test('a held ineligible head surfaces and routes a LIVE current-head finding, never a masking pending', async () => {
  const codexBody = pullAt(610, { additions: 1, deletions: 0, changed_files: 1, body: `<!-- correction-owner: codex -->\n${checklist}\nReplaces: none` });
  let current = codexBody;
  const statusWrites = [];
  let readyCalls = 0;
  const stickies = [];
  const finding = { id: 11, user: { login: 'chatgpt-codex-connector[bot]' }, commit_id: head, original_commit_id: head, path: 'scripts/example.mjs', line: 3, body: '**P1** current-head finding without a status yet' };
  const client = {
    repository: 'JagPat/PMCvitan',
    async commit() { return ownerCommit('codex'); },
    async pullRequest() { return current; },
    async pullRequestFiles() { return [{ filename: 'scripts/example.mjs', additions: 1, deletions: 0, changes: 1 }]; },
    async replacementLineage() { return { requiredReplacements: [], replacementPullRequests: [] }; },
    async statuses() { return statusWrites.map((value, index) => ({ id: 200 + index, context: 'codex-current-head', ...value })); },
    async checkRuns() { return REQUIRED; },
    async reviewComments() { return [finding]; },
    async reviews() { return []; },
    async reactions() { return []; },
    async setStatus(_h, state, description) { statusWrites.unshift({ state, description }); },
    async setDraft(_p, draft) { if (!draft) readyCalls += 1; current = { ...current, draft }; return current; },
    async disableAutoMerge() {},
    async updateStickyComment(_n, body) { stickies.push(body); },
  };
  await run({ context: { number: 610, expectedHead: head, ciConclusion: null }, client });
  assert.equal(readyCalls, 0, 'a live current-head finding never promotes an ineligible head to READY');
  assert.equal(statusWrites[0].state, 'failure', 'the latest status is the finding failure, not a masking pending');
  assert.match(statusWrites[0].description, /^review:/u, 'the surfaced status is a review finding, routed the ordinary way');
  assert.equal(statusWrites.some(({ state }) => state === 'pending'), false, 'no masking validation pending is written over the live finding');
  assert.equal(stickies.some((body) => /changes/iu.test(body ?? '')), true, 'the ordinary correction-routing sticky is published for the finding');
});

// Shared run() recovery harness. Its merge fixture enforces the REAL server prerequisite — the
// codex-current-head status is SUCCESS and the PR is READY — at the PUT boundary, so a canned success
// cannot conceal a recovery that failed to restore either. `seed(push)` writes the initial statuses.
const currentHead = (statuses) => statuses.find((s) => s.context === 'codex-current-head');
function recoveryHarness({ number, initialDraft, seed, mergeSucceeds }) {
  let draft = initialDraft;
  let nextId = 1;
  const statuses = [];
  let handoffs = 0;
  let puts = 0;
  const push = (state, description, context = 'codex-current-head') => statuses.unshift({ id: nextId++, context, state, description });
  const meta = seed(push) ?? {};
  let current = pullAt(number, { additions: 1, deletions: 0, changed_files: 1, draft, body: `<!-- correction-owner: claude -->\n${checklist}\nReplaces: none` });
  const client = {
    repository: 'JagPat/PMCvitan',
    async commit() { return ownerCommit('claude'); },
    async pullRequest() { return { ...current, draft }; },
    async pullRequestFiles() { return [{ filename: 'scripts/example.mjs', additions: 1, deletions: 0, changes: 1 }]; },
    async replacementLineage() { return { requiredReplacements: [], replacementPullRequests: [] }; },
    async statuses() { return statuses.map((s) => ({ ...s })); },
    async checkRuns() { return REQUIRED; },
    async reviews() { return []; },
    async reviewComments() { return []; },
    async reactions() { return []; },
    async setStatus(_h, state, description, _url, context = 'codex-current-head') { push(state, description, context); },
    async setDraft(_p, value) { draft = value; current = { ...current, draft }; return { ...current, draft }; },
    async disableAutoMerge() {},
    async updateStickyComment() {},
    async mergeExactHead() { puts += 1; if (currentHead(statuses)?.state !== 'success' || draft) return { merged: false }; return mergeSucceeds ? { merged: true } : { merged: false, message: 'Base branch was modified' }; },
    async dispatchHandoff() { handoffs += 1; },
  };
  return { client, statuses, meta, get draft() { return draft; }, get handoffs() { return handoffs; }, get puts() { return puts; } };
}

test('F1 accepted recovery through run() restores success+ready before the single PUT, hands off once, and re-protects on refusal', async () => {
  // The operator criterion: exercise the ACCEPTED recovery request through the actual run(). The owed
  // head is held in draft; the retry must restore success+ready before the single PUT. The owed
  // terminal is id 2, and the accepted recovery request points at it.
  const build = (mergeSucceeds) => recoveryHarness({ number: 611, initialDraft: true, mergeSucceeds, seed: (push) => {
    push('success', 'review: Codex found no blocking issue on this exact head');
    push('failure', MERGE_RECOVERY_OWED);
    push('pending', 'recovery: requested terminal status 2', 'codex-recovery-request/2');
  } });

  const ok = build(true);
  await run({ context: { number: 611, expectedHead: head, ciConclusion: 'success' }, client: ok.client });
  assert.equal(ok.handoffs, 1, 'a recovered merge hands off exactly once');
  assert.ok(ok.puts >= 1, 'the merge PUT was attempted');
  assert.equal(currentHead(ok.statuses).state, 'success', 'the recovered head ends green');
  assert.equal(ok.draft, false, 'the recovered head is ready, not held');
  assert.ok(ok.statuses.some((s) => s.context === 'codex-recovery-request/2' && s.state === 'success'), 'the old accepted request is settled');
  assert.equal(ok.statuses.some((s) => s.context === 'codex-current-head' && s.state === 'pending' && /review: pending required CI/u.test(s.description)), false, 'no fresh review_pending is started');

  const no = build(false);
  await run({ context: { number: 611, expectedHead: head, ciConclusion: 'success' }, client: no.client });
  assert.ok(no.puts >= 1, 'the PUT was attempted after restoring success+ready');
  assert.equal(no.handoffs, 0, 'a refused retry hands off nothing');
  assert.equal(currentHead(no.statuses).description, MERGE_RECOVERY_OWED, 're-protected with a fresh owed occurrence');
  assert.equal(no.draft, true, 'the refused head is drafted again (protective hold)');
  assert.ok(no.statuses.some((s) => s.context === 'codex-recovery-request/2' && s.state === 'success'), 'only the old request is settled');
  const seen = new Set();
  const combined = { statuses: no.statuses.filter((s) => (seen.has(s.context) ? false : seen.add(s.context))) };
  const dispatchable = gateRecoveryStatus(combined);
  assert.ok(dispatchable && dispatchable.description === MERGE_RECOVERY_OWED, 'the fresh owed occurrence is dispatchable (no pending request for its id)');
});

test('F1 P1-1: a terminal-success replay whose merge is unconfirmed re-protects with owed + draft', async () => {
  // The success branch of the terminal replay used to ignore completeReviewedPullRequest's return, so
  // an unconfirmed merge left the prior success and a ready PR with no owed obligation. It must
  // re-protect instead (the fixture never confirms the merge even once success+ready are restored).
  const h = recoveryHarness({ number: 612, initialDraft: false, mergeSucceeds: false, seed: (push) => {
    push('success', 'review: Codex found no blocking issue on this exact head');
  } });
  await run({ context: { number: 612, expectedHead: head, ciConclusion: 'success' }, client: h.client });
  assert.equal(currentHead(h.statuses).description, MERGE_RECOVERY_OWED, 'the unconfirmed merge is re-protected with the owed obligation');
  assert.equal(h.draft, true, 'the head is drafted again so branch protection blocks the merge');
});

test('finding 4032309586: the direct exact-SHA retry CONVERGES — two confirmed-405 refusals then success, one PUT per occurrence, one final handoff, and a fresh finding denies the PUT', async () => {
  // Root reconciliation r4032371697: a readable 405 is a confirmed refusal and the selected contract
  // is a durable, freshly authorized exact-SHA DIRECT RETRY (not queueing). Prove it converges: each
  // owed occurrence re-authorizes and attempts exactly one PUT; two refusals re-protect (owed + draft),
  // then a success restores success+ready and hands off exactly once. A fresh finding denies the PUT.
  let attempts = 0;
  const outcomes = [false, false, true]; // readable-405 refuse, refuse, then merge
  let draft = true;
  let handoffs = 0;
  let puts = 0;
  let injectFinding = false;
  const statuses = [
    { id: 2, context: 'codex-current-head', state: 'failure', description: MERGE_RECOVERY_OWED },
    { id: 1, context: 'codex-current-head', state: 'success', description: 'review: Codex found no blocking issue on this exact head' },
  ];
  const currentH = () => statuses.find((s) => s.context === 'codex-current-head');
  const pull = () => pullAt(614, { draft });
  const client = {
    repository: 'JagPat/PMCvitan',
    async commit() { return ownerCommit('claude'); },
    async pullRequest() { return pull(); },
    async statuses() {
      const extra = injectFinding ? [{ id: 99, context: 'codex-current-head', state: 'failure', description: 'review: current-head Codex finding' }] : [];
      return [...extra, ...statuses];
    },
    async checkRuns() { return REQUIRED; },
    async reviews() { return []; },
    async reviewComments() { return []; },
    async setStatus(_h, state, description) { statuses.unshift({ id: 100 + statuses.length, context: 'codex-current-head', state, description }); },
    async setDraft(_p, value) { draft = value; return { ...pull(), draft }; },
    async disableAutoMerge() {},
    async updateStickyComment() {},
    async mergeExactHead() { puts += 1; if (currentH()?.state !== 'success' || draft) return { merged: false }; const merged = outcomes[attempts++]; return merged ? { merged: true } : { merged: false, message: 'Required status check is expected' }; },
    async dispatchHandoff() { handoffs += 1; },
  };
  // First refusal: re-protected with owed + draft, exactly one PUT.
  assert.equal(await recoverExactHeadMerge(client, pull(), head), 'merge_recovery_owed');
  assert.equal(currentH().description, MERGE_RECOVERY_OWED);
  assert.equal(draft, true, 'refused head is re-drafted');
  assert.equal(puts, 1, 'exactly one PUT for the first occurrence');
  // Second refusal: same, one more PUT, still no handoff.
  assert.equal(await recoverExactHeadMerge(client, pull(), head), 'merge_recovery_owed');
  assert.equal(puts, 2, 'exactly one PUT for the second occurrence');
  assert.equal(handoffs, 0, 'no handoff while refused');
  // Third attempt succeeds: success+ready restored before the PUT, one final handoff.
  assert.equal(await recoverExactHeadMerge(client, pull(), head), 'merged');
  assert.equal(handoffs, 1, 'exactly one handoff on the converged success');
  assert.equal(puts, 3, 'one PUT per occurrence, three in total');
  // A fresh current-head finding denies the next PUT entirely (guard holds, no attempt).
  injectFinding = true;
  draft = true;
  statuses.unshift({ id: 200, context: 'codex-current-head', state: 'failure', description: MERGE_RECOVERY_OWED });
  const before = puts;
  assert.equal(await recoverExactHeadMerge(client, pull(), head), 'held_for_gates');
  assert.equal(puts, before, 'a fresh finding denies the retry before any PUT');
});

test('a promotion hold attempts every protective operation independently, even when one throws', async () => {
  const heldPull = () => pullAt(620, { draft: true, body: '<!-- correction-owner: codex -->' });
  const base = () => ({
    repository: 'JagPat/PMCvitan', async commit() { return ownerCommit('codex'); },
    async pullRequest() { return heldPull(); }, async statuses() { return []; },
    async checkRuns() { return REQUIRED; }, async reviewComments() { return []; },
    async reviews() { return []; }, async reactions() { return []; },
  });
  for (const failing of ['status', 'disable']) {
    let disabled = false;
    let drafted = null;
    const client = {
      ...base(),
      async setStatus() { if (failing === 'status') throw new Error('status failed'); },
      async disableAutoMerge() { if (failing === 'disable') throw new Error('disable failed'); disabled = true; },
      async setDraft(_p, draft) { drafted = draft; return { ...heldPull(), draft }; },
    };
    await assert.rejects(() => setDraftForCurrentHead(client, 620, head, false),
      (error) => error instanceof AggregateError);
    assert.equal(drafted, true, `draft conversion still runs though ${failing} threw`);
    if (failing === 'status') assert.equal(disabled, true, 'auto-merge is still disabled though status threw');
  }
});

test('a READY mutation returning the same SHA with an inconsistent body is compensated back to draft', async () => {
  const eligible = pullAt(621, { draft: true, body: '<!-- correction-owner: claude -->' });
  const draftCalls = [];
  const client = {
    repository: 'JagPat/PMCvitan',
    async commit() { return ownerCommit('claude'); },
    async pullRequest() { return eligible; },
    async disableAutoMerge() {},
    async setDraft(current, draft) {
      draftCalls.push(draft);
      if (draft === false) return { ...current, draft: false, body: '<!-- correction-owner: codex -->' };
      return { ...current, draft: true };
    },
  };
  const result = await setDraftForCurrentHead(client, 621, head, false);
  assert.equal(result, null, 'a same-SHA READY object with an inconsistent body is not accepted');
  assert.deepEqual(draftCalls, [false, true],
    'the promotion is attempted, then compensated back to draft on the observed inconsistent pair');
});

// --- Residual P1/P2: scope-route protective ordering, fresh-head, CI/finding precedence, idempotency.
const largePull = (number, overrides = {}) => pullAt(number, {
  additions: 2000, deletions: 0, changed_files: 24, body: '<!-- correction-owner: claude -->', ...overrides,
});
const scopeClient = (pull, over = {}) => ({
  repository: 'JagPat/PMCvitan',
  async pullRequest() { return over.live ?? pull; },
  async pullRequestFiles() { return []; },
  async replacementLineage() { return { requiredReplacements: [], replacementPullRequests: [] }; },
  async statuses() { return over.statuses ?? []; },
  async checkRuns() { return over.checkRuns ?? REQUIRED; },
  async reviews() { return []; },
  async reviewComments() { return []; },
  async setStatus(_h, state, description) { (over.statusWrites ??= []).push({ state, description }); },
  async disableAutoMerge() { over.disabled = (over.disabled ?? 0) + 1; },
  async setDraft(current, draft) { if (over.draftThrows) throw new Error('draft failed'); return { ...current, draft }; },
  async updateStickyComment(_n, body) { (over.stickies ??= []).push(body); },
});

test('P1: a scope rejection disables auto-merge and writes the scope failure even when draft conversion throws', async () => {
  const pull = largePull(640);
  const over = { draftThrows: true };
  await assert.rejects(() => enforceReviewScope(scopeClient(pull, over), pull, head),
    (error) => error instanceof AggregateError);
  assert.equal(over.disabled, 1, 'auto-merge is disabled though draft conversion threw');
  assert.equal((over.statusWrites ?? []).some((s) => s.state === 'failure' && /^scope:/u.test(s.description)), true,
    'the scope failure is written though draft conversion threw');
});

test('P1: a scope rejection on an already-replaced head stops without old-scope writes', async () => {
  const pull = largePull(641);
  const replaced = largePull(641, { head: { sha: 'e'.repeat(40), ref: 'codex/unit', repo: { full_name: 'JagPat/PMCvitan' } } });
  const over = { live: replaced };
  const result = await enforceReviewScope(scopeClient(pull, over), pull, head);
  assert.equal(result.superseded, true);
  assert.deepEqual(over.statusWrites ?? [], [], 'no old-scope status is written on a replaced head');
  assert.equal(over.disabled ?? 0, 0, 'no auto-merge disable on a replaced head');
});

test('P1: a scope rejection preserves a genuine CI reason instead of masking it with scope', async () => {
  const pull = largePull(642);
  // A currently-failing required check is reconciled forward; the scope explanation never overwrites it.
  const failingChecks = REQUIRED_CHECKS.map((name) => ({ name, status: 'completed', conclusion: name === REQUIRED_CHECKS[0] ? 'failure' : 'success' }));
  const over = { checkRuns: failingChecks };
  await enforceReviewScope(scopeClient(pull, over), pull, head);
  const writes = over.statusWrites ?? [];
  assert.equal(writes.some((s) => /^ci:/u.test(s.description)), true, 'the CI failure is preserved');
  assert.equal(writes.some((s) => /^scope:/u.test(s.description)), false, 'scope does not mask the CI failure');
});

test('P2: an unchanged scope failure is not re-published across repeated runs, but a reintroduction is', async () => {
  const pull = largePull(643);
  // GitHub truncates a status description to 140 chars, so the stored form is the persisted one.
  const statuses = [];
  const over = {
    statuses,
    setStatus() {},
    disableAutoMerge() {},
  };
  const client = {
    ...scopeClient(pull, over),
    async statuses() { return statuses; },
    async setStatus(_h, state, description) {
      statuses.unshift({ id: statuses.length + 1, context: 'codex-current-head', state, description: description.slice(0, 140) });
    },
  };
  await enforceReviewScope(client, pull, head);
  const afterFirst = statuses.filter((s) => /^scope:/u.test(s.description)).length;
  await enforceReviewScope(client, pull, head);
  const afterSecond = statuses.filter((s) => /^scope:/u.test(s.description)).length;
  assert.equal(afterFirst, 1, 'the first run publishes the scope failure once');
  assert.equal(afterSecond, 1, 'the unchanged failure is not re-published on the repeat run');
  // A genuine reintroduction (latest is something else now) mints a fresh occurrence.
  statuses.unshift({ id: 999, context: 'codex-current-head', state: 'success', description: 'clear' });
  await enforceReviewScope(client, pull, head);
  assert.equal(statuses.filter((s) => /^scope:/u.test(s.description)).length, 2, 'a reintroduced failure is published again');
});
