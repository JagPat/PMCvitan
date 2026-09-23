import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyClaudeShadowReview } from './claude-review-adapter.mjs';
import { parseCorrectionOwner, correctionRouting, correctionOwnerProblem } from './correction-owner.mjs';
import { authorizeExactHeadMerge, GitHubClient, REQUIRED_CHECKS } from './autonomous-review-gate.mjs';
import { roleTransferActivationVerdict, ACTIVATION_SWITCH, ACTIVATION_REQUIRED_PROOFS } from './role-activation.mjs';
import { STATUS_CONTEXT, CLAUDE_SHADOW_CONTEXT } from './review-policy.mjs';

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
  return { id: 7, name: 'claude-independent-review', head_sha: head, app: { slug: 'github-actions' }, external_id: `pmcvitan:claude-shadow:v1:repo-JagPat/PMCvitan:pr-600:base-${base}:head-${head}:run-123:attempt-2:publisher-456:publisher-attempt-1`, status: 'completed', conclusion: 'success', completed_at: '2026-09-14T12:00:00Z', output: { summary: JSON.stringify({ schema: 1, repository: 'JagPat/PMCvitan', pullRequest: 600, baseSha: base, headSha: head, runId: 123, runAttempt: 2, publisherRunId: 456, publisherRunAttempt: 1, workflowRef: 'JagPat/PMCvitan/.github/workflows/claude-shadow-review.yml@refs/heads/main', workflowSha: base, workflowExecutionRef: 'refs/heads/main', state: 'clear', findingCount: 0, artifact }) }, ...overrides };
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
  // A clear-evidence summary carrying a `failure` conclusion is inconsistent with what the publisher
  // emits for a clear result (`success`), so it is rejected — the conclusion is bound to the evidence.
  assert.equal((await classify([cleanRun({ conclusion: 'failure' })])).state, 'replayed');
  assert.equal((await classify([cleanRun({ output: { summary: '{}' } })])).state, 'replayed');
  assert.equal((await classify([alteredSummary({ publisherRunId: 999 })])).state, 'replayed');
  assert.equal((await classify([alteredSummary({ workflowRef: 'JagPat/PMCvitan/.github/workflows/other.yml@refs/heads/main' })])).state, 'replayed');
  // (b) role-transfer broadening: a valid 40-hex workflowSha that is NOT the PR base is now accepted —
  // the base-equality pin is gone and trust moved to server-side producer verification (head_branch=main
  // + head_sha binding), so an earlier trusted `main` workflow SHA is admitted. RED before this unit
  // (was 'replayed'); the format check still rejects non-hex.
  assert.equal((await classify([alteredSummary({ workflowSha: 'c'.repeat(40) })])).state, 'shadow_clear');
  assert.equal((await classify([alteredSummary({ workflowSha: 'not-hex' })])).state, 'replayed');
  // (a) role-transfer broadening: the summary must assert main-lineage execution; a non-main or absent
  // workflowExecutionRef is rejected. RED before this unit (the field was published but unread).
  assert.equal((await classify([alteredSummary({ workflowExecutionRef: 'refs/heads/other' })])).state, 'replayed');
  assert.equal((await classify([alteredSummary({ workflowExecutionRef: undefined })])).state, 'replayed');
  // (c) role-transfer broadening: a real non-clear result publishes conclusion `failure` (the
  // publisher's deterministic form) and is admitted WITH its authenticated state + finding count,
  // after the SAME server-side producer verification a clear result requires; still non-authoritative.
  const changesArtifact = { ...JSON.parse(cleanRun().output.summary).artifact };
  changesArtifact.name = changesArtifact.name.replace('state-clear-findings-0', 'state-changes_required-findings-1');
  const changesRun = () => {
    const run = alteredSummary({ state: 'changes_required', findingCount: 1, artifact: changesArtifact });
    run.conclusion = 'failure';
    return run;
  };
  // A non-clear summary carrying `success` disagrees with the publisher's form and is rejected.
  assert.equal((await classify([alteredSummary({ state: 'changes_required', findingCount: 1, artifact: changesArtifact })])).state, 'replayed');
  // RED before this unit: the `failure`-form check short-circuited to state 'failure', never verified/admitted.
  assert.equal((await classify([changesRun()], async () => false)).state, 'untrusted_producer');
  assert.deepEqual(await classify([changesRun()]), { state: 'changes_required', findingCount: 1, authoritative: false, runId: 7 });
  // A network-dependent verification error is CONTAINED as untrusted_producer, never thrown out — a
  // transient GitHub metadata outage must not strand the authoritative gate. RED before this unit
  // (the now-unconditional verification propagated for non-clear results).
  const throwing = async () => { throw new Error('gh metadata outage'); };
  assert.equal((await classify([changesRun()], throwing)).state, 'untrusted_producer');
  assert.equal((await classify([cleanRun()], throwing)).state, 'untrusted_producer');
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
  const workflowRun = { id: 456, run_attempt: 1, path: '.github/workflows/claude-shadow-review.yml', event: 'workflow_run', status: 'completed', conclusion: 'success', head_sha: base, head_branch: 'main', repository: { full_name: 'JagPat/PMCvitan' } };
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
  // (a) role-transfer broadening: the publisher run must have executed on `main`. This server-side
  // head_branch proof is the anchor that lets the adapter drop its base-equality pin. RED before this unit.
  assert.equal(await makeClient({ run: { ...workflowRun, head_branch: 'feature' } }).verifyClaudeShadowProducer(cleanRun(), evidence), false);
  assert.equal(await makeClient({ jobs: [{ ...job, conclusion: 'failure' }] }).verifyClaudeShadowProducer(cleanRun(), evidence), false);
  assert.equal(await makeClient({ artifacts: [{ ...artifact, name: 'copied-evidence' }] }).verifyClaudeShadowProducer(cleanRun(), evidence), false);
  assert.equal(await makeClient({ artifacts: [{ ...artifact, digest: `sha256:${'e'.repeat(64)}` }] }).verifyClaudeShadowProducer(cleanRun(), evidence), false);
  // (c) role-transfer broadening: a non-clear result authenticates through the publisher's FAILING
  // run/job form. Verification requires the run and its publish job to conclude `failure` (matching the
  // evidence), and rejects the `success` form that a clear result would carry.
  const nonClearEvidence = { ...evidence, state: 'changes_required', findingCount: 1 };
  const failRun = { ...workflowRun, conclusion: 'failure' };
  const failJob = { ...job, conclusion: 'failure' };
  assert.equal(await makeClient({ run: failRun, jobs: [failJob] }).verifyClaudeShadowProducer(cleanRun(), nonClearEvidence), true);
  assert.equal(await makeClient({ run: workflowRun, jobs: [job] }).verifyClaudeShadowProducer(cleanRun(), nonClearEvidence), false);
  assert.equal(await makeClient({ run: failRun, jobs: [job] }).verifyClaudeShadowProducer(cleanRun(), nonClearEvidence), false);
});

test('automatic merge needs CI and exact-head review, with no human authorization', async () => {
  const pull = { number: 600, state: 'open', draft: false, head: { sha: head, repo: { full_name: 'JagPat/PMCvitan' } }, base: { ref: 'main', sha: base, repo: { full_name: 'JagPat/PMCvitan' } } };
  const checks = REQUIRED_CHECKS.map((name) => ({ name, status: 'completed', conclusion: 'success' }));
  // 2B2: the exact head commit carries a valid terminal Correction-Owner trailer by default, so the
  // SHA merge-authority verdict is `eligible`. `merge` overrides it to exercise the ownership gate.
  const eligibleCommit = { commit: { message: 'fix: something\n\nCorrection-Owner: claude\n' } };
  const makeClient = ({ pulls = [pull, pull], statuses = [{ context: 'codex-current-head', state: 'success' }], runs = checks, commit = eligibleCommit } = {}) => ({
    repository: 'JagPat/PMCvitan',
    async pullRequest() { return pulls.shift() ?? pull; },
    async statuses() { return statuses; },
    async checkRuns() { return runs; },
    async commit() { return commit; },
    async paginated() { throw new Error('Merge must not fetch human authorization comments'); },
  });
  assert.equal((await authorizeExactHeadMerge(makeClient(), pull, head)).allowed, true);
  // 2B2: the merge reads ONE SHA merge-authority verdict and refuses a head whose trailer is not a
  // merge-eligible owner — even with the required status green and all checks passing. A candidate
  // owner, a readable-but-invalid trailer, and an unreadable/absent commit each fail closed.
  assert.equal((await authorizeExactHeadMerge(makeClient({ commit: { commit: { message: 'x\n\nCorrection-Owner: codex\n' } } }), pull, head)).state, 'ownership_not_eligible');
  assert.equal((await authorizeExactHeadMerge(makeClient({ commit: { commit: { message: 'no trailer here' } } }), pull, head)).state, 'ownership_not_eligible');
  assert.equal((await authorizeExactHeadMerge(makeClient({ commit: { commit: { message: '' } } }), pull, head)).state, 'ownership_not_eligible');
  // A caller that pre-parsed the eligible verdict authorizes without a second commit read.
  assert.equal((await authorizeExactHeadMerge({ ...makeClient(), async commit() { throw new Error('must not re-read when verdict is carried'); } }, pull, head, { outcome: 'eligible', mergeEligible: true, owner: 'claude' })).allowed, true);
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

test('role-transfer activation readiness holds until the full observed proof sequence, and switches nothing itself', () => {
  const corrective = 'a'.repeat(40);
  const fullProof = () => ({
    correctiveHeadSha: corrective,
    codexTaskAcceptance: { githubGenerated: true, humanAuthored: false },
    correctivePush: { sameBranch: true, headSha: corrective },
    ci: { headSha: corrective, green: true },
    claudeReReview: { headSha: corrective, state: 'shadow_clear', authoritative: false },
  });

  // All four proofs present for the SAME corrective head → activation permitted.
  const activated = roleTransferActivationVerdict(fullProof());
  assert.equal(activated.state, 'activate');
  assert.equal(activated.activate, true);
  assert.equal(activated.keepCodexCurrentHead, false);
  assert.equal(activated.correctiveHeadSha, corrective);

  // Default / empty evidence → HOLD, keep codex-current-head; every proof is reported missing.
  const held = roleTransferActivationVerdict();
  assert.equal(held.state, 'hold');
  assert.equal(held.activate, false);
  assert.equal(held.keepCodexCurrentHead, true);
  assert.deepEqual(held.missing.filter((m) => m !== 'correctiveHeadSha').sort(), [...ACTIVATION_REQUIRED_PROOFS].sort());

  // Each single missing/failed proof holds and names exactly that gap.
  const drop = (mut) => { const e = fullProof(); mut(e); return roleTransferActivationVerdict(e); };
  const acc = drop((e) => { e.codexTaskAcceptance = { githubGenerated: true, humanAuthored: true }; }); // human @codex is not proof
  assert.equal(acc.state, 'hold');
  assert.deepEqual(acc.missing, ['codexTaskAcceptanceGitHubGenerated']);
  assert.deepEqual(drop((e) => { e.codexTaskAcceptance = { githubGenerated: false }; }).missing, ['codexTaskAcceptanceGitHubGenerated']);
  assert.deepEqual(drop((e) => { e.correctivePush = { sameBranch: false, headSha: corrective }; }).missing, ['codexCorrectiveSameBranchPush']);
  assert.deepEqual(drop((e) => { e.ci = { headSha: corrective, green: false }; }).missing, ['fullCiGreen']);
  assert.deepEqual(drop((e) => { e.claudeReReview = { headSha: corrective, state: 'changes_required' }; }).missing, ['boundClaudeClearReReview']);

  // A proof bound to a DIFFERENT head does not count — CI/review must be on the corrective head.
  const otherHead = 'b'.repeat(40);
  assert.deepEqual(drop((e) => { e.ci = { headSha: otherHead, green: true }; }).missing, ['fullCiGreen']);
  assert.deepEqual(drop((e) => { e.claudeReReview = { headSha: otherHead, state: 'shadow_clear' }; }).missing, ['boundClaudeClearReReview']);
  assert.deepEqual(drop((e) => { e.correctivePush = { sameBranch: true, headSha: otherHead }; }).missing, ['codexCorrectiveSameBranchPush']);

  // The switch is DATA the contract describes, not something it applies: it names the replacement
  // gate to add and the codex-current-head status to retire only afterward, and the role swap.
  assert.equal(ACTIVATION_SWITCH.addRequired, CLAUDE_SHADOW_CONTEXT);
  assert.equal(ACTIVATION_SWITCH.retire, STATUS_CONTEXT);
  assert.equal(ACTIVATION_SWITCH.codingOwner, 'codex');
  assert.equal(ACTIVATION_SWITCH.reviewer, 'claude');
  // codex-current-head remains the live required gate: this unit does not add the shadow context to it.
  assert.ok(!REQUIRED_CHECKS.includes(CLAUDE_SHADOW_CONTEXT));
});
