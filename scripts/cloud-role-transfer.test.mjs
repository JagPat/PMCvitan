import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyClaudeShadowReview } from './claude-review-adapter.mjs';
import { parseCorrectionOwner, correctionRouting, correctionOwnerProblem } from './correction-owner.mjs';
import { authorizeExactHeadMerge, GitHubClient, REQUIRED_CHECKS } from './autonomous-review-gate.mjs';

const head = 'a'.repeat(40);
const base = 'b'.repeat(40);

test('Codex implementation ownership is recognised as an in-flight candidate but never routed or merged', () => {
  // Codex is a recognised CANDIDATE owner: the body parse names it as a first-class `candidate` state on a
  // branch that permits it, and as `contradictory` on a `claude/**` branch it cannot claim. Neither is
  // `declared`, so scope still refuses and routing still stalls — a candidate is tracked, never merge-eligible
  // and never awakenable, until a later unit's promotion hold admits-and-holds it.
  const expectedState = { 'codex/maintenance': 'candidate', 'claude/product': 'contradictory' };
  for (const ref of ['codex/maintenance', 'claude/product']) {
    const body = '<!-- correction-owner: codex -->\n<!-- correction-transfer: claude->codex -->';
    const declaration = parseCorrectionOwner(body, { headRef: ref });
    assert.equal(declaration.state, expectedState[ref]);
    assert.notEqual(declaration.state, 'declared');
    assert.ok(correctionOwnerProblem({ body, head: { ref } }));
    const route = correctionRouting({ declaration, head });
    assert.equal(route.owner, null);
    assert.equal(route.awakenable, false);
  }
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
  const pull = { number: 600, state: 'open', draft: false, body: '<!-- correction-owner: claude -->', head: { sha: head, ref: 'claude/product', repo: { full_name: 'JagPat/PMCvitan' } }, base: { ref: 'main', sha: base, repo: { full_name: 'JagPat/PMCvitan' } } };
  const checks = REQUIRED_CHECKS.map((name) => ({ name, status: 'completed', conclusion: 'success' }));
  // The exact HEAD commit's terminal Correction-Owner trailer. A merge-eligible
  // owner (claude) by default; the ownership cases below vary it.
  const claudeMessage = 'feat: change\n\nCorrection-Owner: claude\n';
  // authorizeExactHeadMerge takes the immutable commit message the chokepoint already read
  // ONCE; it performs NO commit-message network read (a fail spy proves it — boundary 6e).
  const makeClient = ({ pulls = [pull, pull], statuses = [{ context: 'codex-current-head', state: 'success' }], runs = checks } = {}) => ({
    repository: 'JagPat/PMCvitan',
    async pullRequest() { return pulls.shift() ?? pull; },
    async statuses() { return statuses; },
    async checkRuns() { return runs; },
    async commitMessage() { assert.fail('authorizeExactHeadMerge must not read the commit message a second time'); },
    async paginated() { throw new Error('Merge must not fetch human authorization comments'); },
  });
  assert.equal((await authorizeExactHeadMerge(makeClient(), pull, head, claudeMessage)).allowed, true);
  assert.equal((await authorizeExactHeadMerge(makeClient({ pulls: [{ ...pull, draft: true }] }), pull, head, claudeMessage)).state, 'draft');
  assert.equal((await authorizeExactHeadMerge(makeClient({ pulls: [pull, { ...pull, head: { ...pull.head, sha: 'c'.repeat(40) } }] }), pull, head, claudeMessage)).state, 'changed_during_validation');
  assert.equal((await authorizeExactHeadMerge(makeClient({ pulls: [pull, { ...pull, base: { ...pull.base, sha: 'd'.repeat(40) } }] }), pull, head, claudeMessage)).state, 'changed_during_validation');
  for (const state of ['failure', 'pending']) {
    assert.equal((await authorizeExactHeadMerge(makeClient({ statuses: [{ context: 'codex-current-head', state }] }), pull, head, claudeMessage)).state, 'gates_not_green');
  }
  assert.equal((await authorizeExactHeadMerge(makeClient({ statuses: [] }), pull, head, claudeMessage)).state, 'gates_not_green');
  assert.equal((await authorizeExactHeadMerge(makeClient({ runs: [] }), pull, head, claudeMessage)).state, 'gates_not_green');
  for (const name of REQUIRED_CHECKS) {
    assert.equal((await authorizeExactHeadMerge(makeClient({ runs: checks.map(run => run.name === name ? { ...run, conclusion: 'failure' } : run) }), pull, head, claudeMessage)).state, 'gates_not_green');
  }
});

test('the exact-head commit trailer is the merge authority: only an eligible owner passes', async () => {
  // Every gate below is GREEN (codex-current-head success, required checks success): the merge is refused on
  // the ownership verdict of the immutable HEAD commit trailer alone. The trailer is the `message` the
  // chokepoint read ONCE and threaded in; authorizeExactHeadMerge does NO second commit read (fail spy).
  const checks = REQUIRED_CHECKS.map((name) => ({ name, status: 'completed', conclusion: 'success' }));
  const trailer = (owner) => `feat: change\n\nCorrection-Owner: ${owner}\n`;
  const marker = (owner) => `<!-- correction-owner: ${owner} -->`;
  const makeClient = ({ ref, body }) => {
    const pull = { number: 600, state: 'open', draft: false, body, head: { sha: head, ref, repo: { full_name: 'JagPat/PMCvitan' } }, base: { ref: 'main', sha: base, repo: { full_name: 'JagPat/PMCvitan' } } };
    return {
      repository: 'JagPat/PMCvitan',
      async pullRequest() { return pull; },
      async statuses() { return [{ context: 'codex-current-head', state: 'success' }]; },
      async checkRuns() { return checks; },
      async commitMessage() { assert.fail('authorizeExactHeadMerge must not read the commit message a second time'); },
      async paginated() { throw new Error('Merge must not fetch human authorization comments'); },
    };
  };
  const authorize = ({ ref, body, message }) => authorizeExactHeadMerge(makeClient({ ref, body }), { number: 600 }, head, message);

  // (a) an eligible admitted owner whose trailer agrees with the body marker on a branch it may claim.
  assert.equal((await authorize({ ref: 'claude/product', body: marker('claude'), message: trailer('claude') })).allowed, true);
  assert.equal((await authorize({ ref: 'cursor/fix', body: marker('cursor'), message: trailer('cursor') })).allowed, true);

  // (b) a consistent `codex` CANDIDATE passes codex-current-head yet is never merge-eligible.
  assert.equal((await authorize({ ref: 'codex/maintenance', body: marker('codex'), message: trailer('codex') })).state, 'ownership_ineligible');

  // (c) a missing / conflicting / invalid HEAD trailer names no owner, so nothing is eligible.
  assert.equal((await authorize({ ref: 'claude/product', body: marker('claude'), message: 'feat: change\n\nno trailer here\n' })).state, 'ownership_ineligible');
  assert.equal((await authorize({ ref: 'claude/product', body: marker('claude'), message: 'feat: change\n\nCorrection-Owner: claude\nCorrection-Owner: cursor\n' })).state, 'ownership_ineligible');
  assert.equal((await authorize({ ref: 'claude/product', body: marker('claude'), message: 'feat: change\n\nCorrection-Owner: nobody\n' })).state, 'ownership_ineligible');

  // (d) a trailer that disagrees with the body marker is inconsistent, so not eligible.
  assert.equal((await authorize({ ref: 'claude/product', body: marker('claude'), message: trailer('cursor') })).state, 'ownership_ineligible');

  // (e) a `claude/**` branch whose body declares a non-claude owner is contradictory (branch reservation),
  //     so the head is never eligible however its trailer reads.
  assert.equal((await authorize({ ref: 'claude/product', body: marker('codex'), message: trailer('claude') })).state, 'ownership_ineligible');

  // (f) an absent message (defensive) is readable-missing → not eligible, fail-closed.
  assert.equal((await authorize({ ref: 'claude/product', body: marker('claude'), message: undefined })).state, 'ownership_ineligible');
});
