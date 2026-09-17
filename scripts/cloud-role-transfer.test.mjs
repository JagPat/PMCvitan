import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyClaudeShadowReview } from './claude-review-adapter.mjs';
import { parseCorrectionOwner, parseCommitCorrectionOwner, correctionRouting, correctionOwnerProblem } from './correction-owner.mjs';
import { authorizeExactHeadMerge, isValidationOnlyCodexOwner, setDraftForCurrentHead, revalidateFinalReviewPolicy, reviewAttempt, GitHubClient, REQUIRED_CHECKS } from './autonomous-review-gate.mjs';
import { CORRECTION_OWNERS, OWNERSHIP_READ_RETRY, OWNERSHIP_INCONSISTENT_SCOPE, isRetryableReviewFailureDescription } from './review-policy.mjs';

const head = 'a'.repeat(40);
const base = 'b'.repeat(40);
const ownerCommit = (owner, sha = head) => ({ sha, commit: { message: `chore: unit\n\nCorrection-Owner: ${owner}\n` } });
const noOwnerCommit = (sha = head) => ({ sha, commit: { message: 'chore: unit with no trailer\n' } });

// A client that records every protective-hold effect, so a hold's OBSERVABLE consequences
// (the status written, auto-merge disabled, the redraft) can be asserted. `commit` decides the
// HEAD-bound owner; `body` decides the body marker; the two together drive eligibility.
function holdClient({ body = '<!-- correction-owner: claude -->', commit = ownerCommit('claude'), draft = false } = {}) {
  const pull = {
    number: 600, state: 'open', draft, body,
    head: { sha: head, repo: { full_name: 'JagPat/PMCvitan' } },
    base: { ref: 'main', sha: base, repo: { full_name: 'JagPat/PMCvitan' } },
    html_url: 'https://github.com/JagPat/PMCvitan/pull/600',
  };
  const effects = { statusWrites: [], draftWrites: [], autoMergeDisabled: 0, sticky: [] };
  const client = {
    repository: 'JagPat/PMCvitan',
    async pullRequest() { return pull; },
    async commit(sha) { if (commit === 'throw') throw new Error('unreadable'); return typeof commit === 'function' ? commit(sha) : commit; },
    async statuses() { return []; },
    async checkRuns() { return REQUIRED_CHECKS.map((name) => ({ name, status: 'completed', conclusion: 'success' })); },
    async reviews() { return []; },
    async reviewComments() { return []; },
    async comments() { return []; },
    async setStatus(sha, state, description) { effects.statusWrites.push({ sha, state, description }); },
    async setDraft(current, next) { effects.draftWrites.push(next); return { ...current, draft: next }; },
    async disableAutoMerge() { effects.autoMergeDisabled += 1; },
    async updateStickyComment(number, sticky) { effects.sticky.push(sticky); },
  };
  return { client, pull, effects };
}

test('Codex is admitted as a truthful candidate correction owner, on any branch, but is not awakenable', () => {
  // Admission: a body may declare codex, on a codex/** OR a claude/** branch (branch names are
  // historical, never authority). It routes but is NOT awakenable from GitHub — a candidate held
  // pending independent reviewer activation, not wake or merge authority.
  for (const ref of ['codex/maintenance', 'claude/product']) {
    const body = '<!-- correction-owner: codex -->';
    const declaration = parseCorrectionOwner(body, { headRef: ref });
    assert.equal(declaration.state, 'declared');
    assert.equal(declaration.owner, 'codex');
    assert.equal(correctionOwnerProblem({ body, head: { ref } }), null);
    const route = correctionRouting({ declaration, head });
    assert.equal(route.owner, 'codex');
    assert.equal(route.awakenable, false);
  }
  assert.deepEqual([...CORRECTION_OWNERS], ['claude', 'cursor', 'codex']);
});

test('the commit-owner trailer is read only from the terminal trailer block, Git-faithfully', () => {
  assert.equal(parseCommitCorrectionOwner('x\n\nCorrection-Owner: claude\n').owner, 'claude');
  assert.equal(parseCommitCorrectionOwner('x\n\nCorrection-Owner: codex').owner, 'codex');
  assert.equal(parseCommitCorrectionOwner('x\n\ncorrection-owner: cursor\n').owner, 'cursor');
  assert.equal(parseCommitCorrectionOwner(
    'fix: x\n\nbody\n\nCorrection-Owner: claude\nCo-Authored-By: Claude <noreply@anthropic.com>\n',
  ).owner, 'claude');
  assert.equal(parseCommitCorrectionOwner('no trailer here').state, 'missing');
  assert.equal(parseCommitCorrectionOwner('subject only\n').state, 'missing');
  // A marker inside a code fence or prose is not a terminal trailer.
  assert.equal(parseCommitCorrectionOwner('doc\n\n```\nCorrection-Owner: claude\n```\n').state, 'missing');
  assert.equal(parseCommitCorrectionOwner('doc\n\nUse Correction-Owner: claude\n\nMore prose.\n').state, 'missing');
  // Duplicate / conflicting / unknown / malformed all fail closed.
  assert.equal(parseCommitCorrectionOwner('x\n\nCorrection-Owner: claude\nCorrection-Owner: claude\n').state, 'conflicting');
  assert.equal(parseCommitCorrectionOwner('x\n\nCorrection-Owner: claude\nCorrection-Owner: cursor\n').state, 'conflicting');
  assert.equal(parseCommitCorrectionOwner('x\n\nCorrection-Owner: nobody\n').state, 'invalid');
  assert.equal(parseCommitCorrectionOwner('x\n\nCorrection-Owner: claude\n codex\n').state, 'invalid');
  // A continuation before the first trailer voids the block.
  assert.equal(parseCommitCorrectionOwner('x\n\n leading continuation\nCorrection-Owner: claude\n').state, 'missing');
  // finding r4032740248: `git interpret-trailers --parse` ignores a trailing `---` patch divider and
  // reads the trailer block before it, so a Git-valid owner must not be stalled by the divider.
  assert.equal(parseCommitCorrectionOwner('subject\n\nCorrection-Owner: claude\n---\n').owner, 'claude');
  assert.equal(parseCommitCorrectionOwner('subject\n\nCorrection-Owner: claude\n---').owner, 'claude');
  // finding r4034779634: the divider need not be the FINAL line — git reads the trailer block before the
  // FIRST `---` and treats everything after (the diff) as the patch, so the normal `---\n<diff>` tail
  // must not stall a Git-valid owner either.
  assert.equal(
    parseCommitCorrectionOwner('subject\n\nCorrection-Owner: claude\n---\ndiff --git a/a b/a\n').owner,
    'claude',
  );
  assert.equal(
    parseCommitCorrectionOwner(
      'subject\n\nCorrection-Owner: cursor\n---\n a | 1 +\n 1 file changed\ndiff --git a/a b/a\n',
    ).owner,
    'cursor',
  );
  // A `---` divider before the trailer is git's patch boundary too: the "trailer" after it is patch
  // content, so it confers no owner — matching git's top-down `find_patch_start`.
  assert.equal(
    parseCommitCorrectionOwner('subject\n\n---\n\nCorrection-Owner: claude\n').state,
    'missing',
  );
});

test('an inconsistent-ownership notice names the remedy that actually fixes it (finding r4032740244)', () => {
  // A valid HEAD trailer whose only problem is a missing/mismatched BODY marker is a body-edit fix;
  // a missing/invalid/disagreeing TRAILER needs a new head. The stalled instruction must say which.
  const bodyFix = correctionRouting({
    declaration: { state: 'inconsistent', owner: null, detail: 'trailer valid; body marker missing', remedy: 'body' },
    head,
  });
  assert.equal(bodyFix.state, 'correction_stalled');
  assert.equal(bodyFix.awakenable, false);
  assert.match(bodyFix.instruction, /body marker/u);
  assert.doesNotMatch(bodyFix.instruction, /push a new head/u, 'a valid trailer is not fixed by a new head');

  const headFix = correctionRouting({
    declaration: { state: 'inconsistent', owner: null, detail: 'trailer disagrees with body', remedy: 'head' },
    head,
  });
  assert.match(headFix.instruction, /push a new head/u);
  assert.match(headFix.instruction, /Correction-Owner/u);
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
  const body = '<!-- correction-owner: claude -->';
  const pull = { number: 600, state: 'open', draft: false, body, head: { sha: head, repo: { full_name: 'JagPat/PMCvitan' } }, base: { ref: 'main', sha: base, repo: { full_name: 'JagPat/PMCvitan' } } };
  const checks = REQUIRED_CHECKS.map((name) => ({ name, status: 'completed', conclusion: 'success' }));
  const makeClient = ({ pulls = [pull, pull], statuses = [{ context: 'codex-current-head', state: 'success' }], runs = checks, commit = ownerCommit('claude') } = {}) => ({
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
    assert.equal((await authorizeExactHeadMerge(makeClient({ runs: checks.map(run => run.name === name ? { ...run, conclusion: 'failure' } : run) }), pull, head)).state, 'gates_not_green');
  }
  // A consistent Codex candidate is admitted for validation only, never merged.
  assert.equal((await authorizeExactHeadMerge(makeClient({ commit: ownerCommit('codex'), pulls: [{ ...pull, body: '<!-- correction-owner: codex -->' }, { ...pull, body: '<!-- correction-owner: codex -->' }] }), pull, head)).state, 'validation_only_codex_owner');
  // A body/trailer disagreement (commit says cursor, body says claude) is not merge-eligible.
  assert.equal((await authorizeExactHeadMerge(makeClient({ commit: ownerCommit('cursor') }), pull, head)).state, 'owner_not_merge_eligible');
  // A missing trailer is not merge-eligible.
  assert.equal((await authorizeExactHeadMerge(makeClient({ commit: noOwnerCommit() }), pull, head)).state, 'owner_not_merge_eligible');
});

test('finding 990 — an unreadable HEAD commit holds RETRYABLE, so the watchdog re-dispatches', async () => {
  // The commit read fails (unreadable, not an author fault). Promoting the head must be refused,
  // and the status written must be OWNERSHIP_READ_RETRY — which the SHARED retryable classifier
  // recognises, so the watchdog re-dispatches the gate (which re-reads the commit) instead of
  // stranding a pending status nobody clears.
  const { client, effects } = holdClient({ commit: 'throw', draft: false });
  const result = await setDraftForCurrentHead(client, 600, head, false);
  assert.equal(result.draft, true, 'the head is re-drafted, never promoted, while ownership is unreadable');
  const retry = effects.statusWrites.find((w) => w.description === OWNERSHIP_READ_RETRY);
  assert.ok(retry, 'the retryable ownership-read status is written');
  assert.equal(retry.state, 'failure');
  assert.equal(isRetryableReviewFailureDescription(retry.description), true);
  assert.equal(effects.autoMergeDisabled, 1);
});

test('finding — a consistent Codex candidate is HELD pending (never a scope fault, never merged)', async () => {
  // Body and HEAD trailer agree on codex: an admitted candidate. It is held with a PENDING status
  // (awaiting independent reviewer activation), not a failure — a truthful in-flight unit is not a
  // fault — and it is never promoted.
  const { client, effects } = holdClient({ body: '<!-- correction-owner: codex -->', commit: ownerCommit('codex') });
  const result = await setDraftForCurrentHead(client, 600, head, false);
  assert.equal(result.draft, true);
  assert.equal(effects.statusWrites.length, 1);
  assert.equal(effects.statusWrites[0].state, 'pending');
  assert.match(effects.statusWrites[0].description, /Codex-owned candidate held/u);
  assert.equal(effects.autoMergeDisabled, 1);
});

test('finding 3006 (gate side) — a body/trailer disagreement is a STALLED scope fault', async () => {
  // The body declares claude but the HEAD trailer says cursor: a readable ownership inconsistency.
  // The gate writes a `scope:` failure whose detail LEADS with the shared signature the watchdog
  // keys off, and the sticky comment declares the correction stalled — the body is the half that
  // may be lying, so no owner is woken.
  const { client, effects } = holdClient({ body: '<!-- correction-owner: claude -->', commit: ownerCommit('cursor') });
  const result = await setDraftForCurrentHead(client, 600, head, false);
  assert.equal(result.draft, true);
  const scope = effects.statusWrites.find((w) => w.description.startsWith('scope:'));
  assert.ok(scope, 'a scope failure is written');
  assert.equal(scope.state, 'failure');
  assert.ok(scope.description.includes(OWNERSHIP_INCONSISTENT_SCOPE));
  assert.equal(isRetryableReviewFailureDescription(scope.description), false, 'an ownership fault is not retryable infra');
  assert.ok(effects.sticky.length >= 1, 'the stalled correction is explained on the sticky comment');
});

test('finding — an eligible claude head is PROMOTED, not held', async () => {
  // The complement: body and HEAD trailer agree on claude, so the promotion proceeds and returns the
  // ready pull request. This proves the hold is specific to ineligibility, not a blanket refusal.
  const { client, effects } = holdClient({ body: '<!-- correction-owner: claude -->', commit: ownerCommit('claude'), draft: true });
  const result = await setDraftForCurrentHead(client, 600, head, false);
  assert.ok(result);
  assert.equal(result.draft, false, 'the eligible head is promoted to ready');
  assert.deepEqual(effects.draftWrites, [false]);
  assert.equal(effects.statusWrites.length, 0, 'no hold status is written for an eligible owner');
  assert.equal(effects.autoMergeDisabled, 0);
});
