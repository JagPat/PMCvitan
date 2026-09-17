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
  setDraftForCurrentHead,
  isValidationOnlyCodexOwner,
  GitHubClient,
  REQUIRED_CHECKS,
} from './autonomous-review-gate.mjs';
import {
  OWNERSHIP_READ_RETRY,
  OWNERSHIP_INCONSISTENT_SCOPE,
  isRetryableReviewFailureDescription,
} from './review-policy.mjs';

const head = 'a'.repeat(40);
const base = 'b'.repeat(40);

// The exact HEAD commit the promotion hold reads to resolve ownership: its terminal Correction-Owner trailer.
const ownerCommit = (owner, sha = head) => ({ sha, commit: { message: `chore: unit\n\nCorrection-Owner: ${owner}\n` } });
// A message whose trailer output overflows git's parse buffer, so the git-faithful primitive returns its
// `unreadable` state (finding 4041980997): an infrastructure read failure, distinct from a missing trailer.
const unreadableCommit = (sha = head) => ({ sha, commit: { message: `subject\n\nX-Pad: ${'a'.repeat(9 * 1024 * 1024)}` } });

// A client that records the protective-hold effects `setDraftForCurrentHead`'s promotion guard applies.
function holdClient({ body = '<!-- correction-owner: claude -->', commit = ownerCommit('claude'), draft = true, ref = 'claude/x' } = {}) {
  const effects = { statusWrites: [], draftWrites: [], autoMergeDisabled: 0, sticky: [] };
  const pull = {
    number: 600, node_id: 'PR_x', state: 'open', draft, body, auto_merge: { enabledAt: 'x' },
    html_url: 'https://pr',
    head: { sha: head, ref, repo: { full_name: 'JagPat/PMCvitan' } },
    base: { ref: 'main', sha: base, repo: { full_name: 'JagPat/PMCvitan' } },
  };
  const client = {
    repository: 'JagPat/PMCvitan',
    async pullRequest() { return { ...pull }; },
    async commit(sha) {
      if (commit === 'throw') throw new Error('unreadable commit fetch');
      return typeof commit === 'function' ? commit(sha) : { ...commit, sha: commit.sha ?? sha };
    },
    async setDraft(current, d) { effects.draftWrites.push(d); return { ...current, draft: d }; },
    async setStatus(sha, state, description) { effects.statusWrites.push({ state, description }); },
    async updateStickyComment(number, b) { effects.sticky.push(b); },
    async disableAutoMerge() { effects.autoMergeDisabled += 1; },
    async reviews() { return []; },
    async reviewComments() { return []; },
  };
  return { client, effects };
}

test('Codex is admitted as a truthful candidate correction owner, but is never merge-eligible', () => {
  // Admitting `codex` tracks a Codex-owned corrective head as an in-flight unit; it is NOT awakenable and NOT
  // merge-eligible — the implementation task and reviewer share one bot identity, held pending independent
  // reviewer activation (docs/POLICY.md). Its non-eligibility is enforced by the pre-publication hold below.
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
  // The exact HEAD commit trailer also resolves codex (the hold reads the trailer, not only the body).
  assert.equal(parseCommitCorrectionOwner('x\n\nCorrection-Owner: codex\n').state, 'declared');
  assert.equal(parseCommitCorrectionOwner('x\n\nCorrection-Owner: codex\n').owner, 'codex');
});

// ── Pre-publication ownership hold: an ineligible head is never promoted, armed, or given a green status ──
// These reproduce the convergent P1s Codex raised on #603 (findings 4041980984/991/995/997): the merge gate
// alone could not keep an ineligible head out of a mergeable state. This unit (2A) enforces body/trailer
// AGREEMENT and the retryable/terminal split at PROMOTION, before any green status — so no ineligible head
// ever becomes a ready PR. On the pre-change gate (no promotion guard) each of these PROMOTED the head.

test('finding 4041980995 — a body/trailer OWNER disagreement is held at promotion, never promoted', async () => {
  // Body declares codex (validation-only) but the immutable trailer names claude: the body-declared codex
  // candidate must not be disguised by a mismatched trailer and slipped through as eligible.
  const { client, effects } = holdClient({ body: '<!-- correction-owner: codex -->', commit: ownerCommit('claude') });
  const result = await setDraftForCurrentHead(client, 600, head, false);
  assert.equal(result.draft, true, 'a disagreeing head is re-drafted, never promoted to ready');
  const scope = effects.statusWrites.find((w) => w.description.startsWith('scope:'));
  assert.ok(scope, 'a scope failure is written so the required status is never green for this head');
  assert.equal(scope.state, 'failure');
  assert.ok(scope.description.includes(OWNERSHIP_INCONSISTENT_SCOPE));
  assert.equal(isRetryableReviewFailureDescription(scope.description), false, 'an ownership fault is not retryable infra');
  assert.equal(effects.autoMergeDisabled, 1, 'any armed auto-merge is cancelled for the ineligible head');
  assert.ok(effects.sticky.length >= 1, 'the stalled correction is explained on the sticky comment');
});

test('finding 4041980984/4041980991 — a consistent Codex candidate is held pending, never promoted', async () => {
  // A codex candidate lives on a codex branch (a claude/** branch would make the codex marker a
  // branch-reservation contradiction, i.e. a scope fault, not the consistent-codex pending hold).
  const { client, effects } = holdClient({ body: '<!-- correction-owner: codex -->', commit: ownerCommit('codex'), ref: 'codex/x' });
  assert.equal(isValidationOnlyCodexOwner({ body: '<!-- correction-owner: codex -->' }), true);
  const result = await setDraftForCurrentHead(client, 600, head, false);
  assert.equal(result.draft, true);
  assert.equal(effects.statusWrites.length, 1);
  assert.equal(effects.statusWrites[0].state, 'pending', 'a codex candidate never publishes a green status');
  assert.match(effects.statusWrites[0].description, /Codex-owned candidate held/u);
  assert.equal(effects.autoMergeDisabled, 1);
});

test('finding 4041980997 — an unreadable-PARSE head is held RETRYABLE, not a terminal ineligibility', async () => {
  // The commit FETCH succeeds, but the git-faithful primitive returns `unreadable` (its output overflows the
  // parse buffer). That must publish the RETRYABLE ownership-read status so the watchdog re-dispatches — not a
  // terminal scope fault that strands an otherwise-valid head.
  const { client, effects } = holdClient({ body: '<!-- correction-owner: claude -->', commit: unreadableCommit() });
  const result = await setDraftForCurrentHead(client, 600, head, false);
  assert.equal(result.draft, true, 'an unreadable head is re-drafted, never promoted');
  const retry = effects.statusWrites.find((w) => w.description === OWNERSHIP_READ_RETRY);
  assert.ok(retry, 'the retryable ownership-read status is written');
  assert.equal(retry.state, 'failure');
  assert.equal(isRetryableReviewFailureDescription(retry.description), true);
  assert.equal(
    effects.statusWrites.some((w) => w.description.startsWith('scope:')),
    false,
    'an unreadable read is infra, never an ownership scope accusation',
  );
  assert.equal(effects.autoMergeDisabled, 1);
});

test('finding 4041980997 (fetch throw) — an unreadable commit FETCH is also held RETRYABLE', async () => {
  const { client, effects } = holdClient({ body: '<!-- correction-owner: claude -->', commit: 'throw' });
  const result = await setDraftForCurrentHead(client, 600, head, false);
  assert.equal(result.draft, true);
  assert.ok(effects.statusWrites.find((w) => w.description === OWNERSHIP_READ_RETRY));
  assert.equal(effects.autoMergeDisabled, 1);
});

test('regression — an eligible claude head IS promoted, with no hold', async () => {
  const { client, effects } = holdClient({ body: '<!-- correction-owner: claude -->', commit: ownerCommit('claude'), draft: true });
  const result = await setDraftForCurrentHead(client, 600, head, false);
  assert.ok(result);
  assert.equal(result.draft, false, 'the eligible head is promoted to ready');
  assert.deepEqual(effects.draftWrites, [false]);
  assert.equal(effects.statusWrites.length, 0, 'no hold status is written for an eligible owner');
  assert.equal(effects.autoMergeDisabled, 0);
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
