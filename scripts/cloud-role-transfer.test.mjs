import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { classifyClaudeShadowReview } from './claude-review-adapter.mjs';
import {
  HEAD_READ_DELAYS_MS, parseCorrectionOwner, correctionRouting, correctionOwnerProblem, readHeadCommitMessage,
} from './correction-owner.mjs';
import { authorizeExactHeadMerge, GitHubClient, REQUIRED_CHECKS } from './autonomous-review-gate.mjs';
import { assessCorrectionLease, correctionReasonFor } from './correction-lease.mjs';
import { assessReviewScope } from './review-efficiency.mjs';
import {
  CANDIDATE_CORRECTION_OWNERS, CORRECTION_OWNERS, CORRECTION_STALLED, OWNERSHIP_CANDIDATE_HELD, STATUS_CONTEXT,
} from './review-policy.mjs';

const head = 'a'.repeat(40);
const base = 'b'.repeat(40);

test('Codex implementation ownership is recognised as an in-flight candidate but never routed or merged', () => {
  // Codex is a recognised CANDIDATE owner: the body parse names it as a first-class `candidate` state on a
  // branch that permits it, and as `contradictory` on a `claude/**` branch it cannot claim. Neither is
  // `declared`. The scope gate admits the candidate (so its head gets CI and review) and still refuses the
  // contradiction; routing stalls for both — a candidate is tracked, never merge-eligible and never awakenable.
  const expectedState = { 'codex/maintenance': 'candidate', 'claude/product': 'contradictory' };
  for (const ref of ['codex/maintenance', 'claude/product']) {
    const body = '<!-- correction-owner: codex -->\n<!-- correction-transfer: claude->codex -->';
    const declaration = parseCorrectionOwner(body, { headRef: ref });
    assert.equal(declaration.state, expectedState[ref]);
    assert.notEqual(declaration.state, 'declared');
    const problem = correctionOwnerProblem({ body, head: { ref } }, { headCommitMessage: 'fix\n\nCorrection-Owner: codex\n' });
    if (ref === 'claude/product') assert.match(problem ?? '', /reserved for Claude-authored work/u);
    else assert.equal(problem, null);
    const route = correctionRouting({ declaration, head });
    assert.equal(route.owner, null);
    assert.equal(route.awakenable, false);
  }
});

test('finding 4094243334: an admitted candidate gets a held diagnostic, never an undeclared-owner remedy', () => {
  // The candidate marker is truthful and admitted, so telling the reader ownership is not established and
  // to replace the marker would be false. It is still routed to nobody, stalled and not awakenable.
  const declaration = parseCorrectionOwner('<!-- correction-owner: codex -->', { headRef: 'codex/observation-seed' });
  for (const reason of ['review', 'ci']) {
    const route = correctionRouting({ declaration, head, reason, detail: 'x' });
    assert.equal(route.owner, null, reason);
    assert.equal(route.state, CORRECTION_STALLED, reason);
    assert.equal(route.awakenable, false, reason);
    assert.match(route.instruction, /admitted candidate correction owner/u, reason);
    assert.match(route.instruction, /Keep the marker as it is/u, reason);
    // Codex finding 4098329042: an unrouted result proves only that this loop requested nothing, never
    // that no correction is running.
    assert.match(route.instruction, /has requested no correction; it cannot observe whether one is already running/u, reason);
    assert.doesNotMatch(route.instruction, /no correction is in flight/u, reason);
    assert.doesNotMatch(route.instruction, /not established|replace the correction-owner marker|@/u, reason);
  }
  // Codex finding 4101018333 on #630: when scope refused the head (a candidate body over a head that does
  // not declare it, or any other scope rule), the notice names the refusal and its remedy, never "admitted"
  // or "keep the marker". Still routed to nobody, stalled and not awakenable.
  const refusal = 'the PR body declares candidate correction owner "codex", but its head commit does not declare it';
  const refused = correctionRouting({ declaration, head, reason: 'scope', detail: refusal });
  assert.equal(refused.owner, null);
  assert.equal(refused.state, CORRECTION_STALLED);
  assert.equal(refused.awakenable, false);
  assert.ok(refused.instruction.startsWith(`Scope refused this head: ${refusal}.`));
  assert.match(refused.instruction, /Resume action: clear the refusal above/u);
  // Codex finding 4101298577: scope reads only the exact head, so the remedy names that head, not every commit.
  assert.match(refused.instruction, /one new head whose own message ends with `Correction-Owner: codex`/u);
  assert.doesNotMatch(refused.instruction, /every commit/u);
  assert.doesNotMatch(refused.instruction, /admitted candidate correction owner of this PR|Keep the marker as it is|@/u);
  // A real ownership fault keeps its remedy.
  const contradictory = parseCorrectionOwner('<!-- correction-owner: codex -->', { headRef: 'claude/x' });
  assert.match(correctionRouting({ declaration: contradictory, head }).instruction,
    /not established[\s\S]*replace the correction-owner marker/u);
});

test('review-scope admits a declared or candidate owner and refuses every other declaration', () => {
  const KEYS = ['concurrency-serialization', 'old-release-migration-compatibility', 'trigger-alternate-writers',
    'authorization-tenancy', 'ci-reproduce-first'];
  const body = (markers) => ['<!-- review-size: standard -->', '<!-- migration-scope: n/a -->', ...markers,
    'Replaces: none', '', '## Pre-review checklist', ...KEYS.map((key) => `- [x] \`${key}\` — checked`), '',
    '- Migration/service seam: n/a'].join('\n');
  const codexHead = 'seed\n\nCorrection-Owner: codex\n';
  // The head message defaults to a codex head only when the argument is omitted, never for an explicit undefined.
  const scope = (markers, ref, ...head) => assessReviewScope({
    number: 700, additions: 20, deletions: 0, changed_files: 2, body: body(markers),
    base: { ref: 'main' }, head: { ref },
  }, { headCommitMessage: head.length > 0 ? head[0] : codexHead });
  const owner = (name) => `<!-- correction-owner: ${name} -->`;
  // Admitted: the routable owners, and codex as a candidate on a branch that permits it.
  for (const [markers, ref] of [[[owner('claude')], 'claude/x'], [[owner('cursor')], 'codex/x'],
    [[owner('codex')], 'codex/observation-seed']]) {
    assert.equal(scope(markers, ref).allowed, true, `${markers} on ${ref}`);
  }
  // Refused, each on its own owner fault: codex on a Claude branch, no marker, an unknown owner, two
  // conflicting owners, one owner declared twice.
  for (const [markers, ref, detail] of [
    [[owner('codex')], 'claude/x', /reserved for Claude-authored work/u],
    [[], 'codex/x', /must declare its correction owner/u],
    [[owner('devin')], 'codex/x', /"devin" is not a correction owner/u],
    [[owner('codex'), owner('claude')], 'codex/x', /conflicting correction owners/u],
    [[owner('codex'), owner('codex')], 'codex/x', /declared 2 times/u],
  ]) {
    const result = scope(markers, ref);
    assert.equal(result.allowed, false, `${markers} on ${ref}`);
    assert.match(result.detail, detail);
  }
  // Codex findings on #628: a candidate body is admitted only over a head that declares the same candidate.
  // A mergeable Claude head, a head with no owner, a conflicting head, or an unread head is refused, so a
  // body edit can never put a merge-eligible head (or a queued auto-merge) into candidate scope.
  for (const [label, headCommitMessage, detail] of [
    ['an eligible Claude head', 'fix\n\nCorrection-Owner: claude\n', /head commit does not declare it/u],
    ['a head with no owner', 'fix: no trailer', /head commit does not declare it/u],
    ['a conflicting head', 'fix\n\nCorrection-Owner: codex\nCorrection-Owner: claude\n', /head commit does not declare it/u],
    ['an unread head', undefined, /head commit could not be read/u],
  ]) {
    const result = scope([owner('codex')], 'codex/observation-seed', headCommitMessage);
    assert.equal(result.allowed, false, label);
    assert.match(result.detail, detail, label);
    assert.match(result.detail, /the exact head commit's message must end with a single `Correction-Owner: codex`/u, label);
    assert.doesNotMatch(result.detail, /every commit/u, label);
  }
  // The head is consulted only for a candidate body: a declared owner never needs it.
  assert.equal(scope([owner('claude')], 'claude/x', undefined).allowed, true);
});

test('the written owner contract names every marker review-scope admits (finding 4093756711)', () => {
  // POLICY is the canonical contract: its marker sentence must not forbid the codex candidate that the
  // executable scope gate now admits, and it must still say the candidate is held.
  const contract = readFileSync(new URL('../docs/POLICY.md', import.meta.url), 'utf8');
  const markerRule = contract.slice(contract.indexOf('Every PR declares exactly one correction owner'),
    contract.indexOf('A `claude/**` branch must declare Claude.'));
  for (const owner of [...CORRECTION_OWNERS, ...CANDIDATE_CORRECTION_OWNERS]) {
    assert.match(markerRule, new RegExp(owner, 'u'), `the marker rule names ${owner}`);
  }
  assert.match(markerRule, /held codex candidate/u);
  assert.match(contract, /Codex is a recognised CANDIDATE owner: scope admits its marker off `claude\/\*\*`/u);
});

test('shadow finding on #630: one shared bounded head re-read for the CLI and the controller', async () => {
  // Two copies of the retry bound could drift and give the review-scope job and the controller different
  // verdicts for the same head. The loop and its bound live once, in correction-owner.mjs.
  for (const file of ['review-scope.mjs', 'autonomous-review-gate.mjs']) {
    const source = readFileSync(new URL(`./${file}`, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /HEAD_READ_DELAYS_MS\s*=/u, `${file} defines no retry bound of its own`);
    assert.match(source, /readHeadCommitMessage\(/u, `${file} uses the shared re-read`);
  }
  assert.deepEqual([...HEAD_READ_DELAYS_MS], [1_000, 3_000]);
  assert.ok(Object.isFrozen(HEAD_READ_DELAYS_MS));
  const pauses = [];
  const sleep = async (ms) => { pauses.push(ms); };
  const reader = (answers) => async () => {
    const answer = answers.shift();
    if (answer instanceof Error) throw answer;
    return answer;
  };
  assert.equal(await readHeadCommitMessage(reader([new Error('502'), undefined, 'seed']), { sleep }), 'seed');
  assert.deepEqual(pauses, [1_000, 3_000]);
  pauses.length = 0;
  assert.equal(await readHeadCommitMessage(reader([new Error('502'), new Error('502'), new Error('502'), 'late']), { sleep }), undefined);
  assert.deepEqual(pauses, [1_000, 3_000], 'exactly three reads, then fail closed');
  pauses.length = 0;
  assert.equal(await readHeadCommitMessage(reader(['first']), { sleep }), 'first');
  assert.deepEqual(pauses, [], 'no pause when the first read succeeds');
});

test('an admitted candidate PR still opens no autonomous correction writer', () => {
  // Scope admission changes no routing: a finding on a candidate PR names nobody and wakes nobody, and
  // the candidate hold on its reviewed head owes no correction at all.
  const pullRequest = { number: 700, head: { sha: head, ref: 'codex/observation-seed' },
    body: '<!-- correction-owner: codex -->' };
  for (const [reason, detail] of [['review', '1 current-head Codex finding'], ['ci', 'api failed']]) {
    const lease = assessCorrectionLease({ pullRequest, head, reason, detail,
      findingObservedAt: '2026-09-24T00:00:00Z', now: '2026-09-24T12:00:00Z', comments: [] });
    assert.equal(lease.owner, 'undeclared', reason);
    assert.equal(lease.reportedState, CORRECTION_STALLED, reason);
    assert.doesNotMatch(lease.body ?? '', /@[A-Za-z]/u, reason);
  }
  assert.equal(correctionReasonFor({ context: STATUS_CONTEXT, state: 'failure', description: OWNERSHIP_CANDIDATE_HELD }), null);
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
  // Codex finding 4098329036 on #628: a PR whose body declares the codex candidate never merges, even
  // when its unchanged head carries an eligible `Correction-Owner: claude` trailer (read or carried).
  const candidatePull = { ...pull, body: '<!-- correction-owner: codex -->', head: { ...pull.head, ref: 'codex/observation-seed' } };
  assert.equal((await authorizeExactHeadMerge(makeClient({ pulls: [candidatePull, candidatePull] }), candidatePull, head)).state, 'ownership_not_eligible');
  assert.equal((await authorizeExactHeadMerge(makeClient({ pulls: [candidatePull, candidatePull] }), candidatePull, head,
    { outcome: 'eligible', mergeEligible: true, owner: 'claude' })).state, 'ownership_not_eligible');
  // Codex finding 4098699869: a candidate marker that appears between the first and the final read
  // (the PR the merge acts on) still holds.
  assert.equal((await authorizeExactHeadMerge(makeClient({ pulls: [pull, candidatePull] }), pull, head)).state, 'ownership_not_eligible');
  assert.equal((await authorizeExactHeadMerge(makeClient({ pulls: [pull, candidatePull] }), pull, head,
    { outcome: 'eligible', mergeEligible: true, owner: 'claude' })).state, 'ownership_not_eligible');
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
