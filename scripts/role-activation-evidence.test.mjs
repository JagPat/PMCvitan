import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CODEX_ACCEPTANCE_REACTION,
  GITHUB_ACTIONS_LOGIN,
  PUSH_LOG_PAGE_SIZE,
  ROLE_ACTIVATION_EVIDENCE_SCHEMA,
  parseProbeMarker,
  readRoleActivationEvidence,
} from './role-activation-evidence.mjs';
import { codexFixComment, probeMarker } from './codex-fix-probe.mjs';
import { evidenceArtifactName } from './claude-shadow-review.mjs';
import { CODEX_LOGIN, REQUIRED_CHECKS } from './review-policy.mjs';

const REPO = 'JagPat/PMCvitan';
const PR = 619;
const BRANCH = 'claude/x';
const BASE = 'b'.repeat(40);
const ORIGINAL = 'a'.repeat(40);
const CORRECTIVE = 'c'.repeat(40);
const OTHER = 'e'.repeat(40);
const REQUEST_ID = 5001;
const at = (hhmm) => `2026-09-23T${hhmm}:00Z`;
const ms = (hhmm) => Date.parse(at(hhmm));

let nextId = 1;
function ciRuns(headSha, { start = '10:00', end = '10:05', suite = 1, conclusion = 'success' } = {}) {
  return REQUIRED_CHECKS.map((name) => ({
    id: nextId++,
    name,
    head_sha: headSha,
    status: 'completed',
    conclusion,
    started_at: at(start),
    completed_at: at(end),
    check_suite: { id: suite },
  }));
}

function shadowRun(headSha, { id, completed, state }) {
  const findingCount = state === 'clear' ? 0 : 1;
  const summary = {
    schema: 1,
    repository: REPO,
    pullRequest: PR,
    baseSha: BASE,
    headSha,
    testedBaseSha: BASE,
    runId: 100 + id,
    runAttempt: 1,
    publisherRunId: 200 + id,
    publisherRunAttempt: 1,
    workflowRef: `${REPO}/.github/workflows/claude-shadow-review.yml@refs/heads/main`,
    workflowSha: BASE,
    workflowExecutionRef: 'refs/heads/main',
    state,
    findingCount,
  };
  summary.artifact = {
    id: 300 + id,
    digest: `sha256:${'d'.repeat(64)}`,
    name: evidenceArtifactName(summary, summary, { state, findings: Array.from({ length: findingCount }) }),
  };
  return {
    id,
    name: 'claude-independent-review',
    head_sha: headSha,
    html_url: `https://github.com/${REPO}/runs/${id}`,
    app: { slug: 'github-actions' },
    external_id: `pmcvitan:claude-shadow:v1:repo-${REPO}:pr-${PR}:base-${BASE}:head-${headSha}:run-${summary.runId}`
      + `:attempt-1:publisher-${summary.publisherRunId}:publisher-attempt-1`,
    status: 'completed',
    conclusion: state === 'clear' ? 'success' : 'failure',
    started_at: completed,
    completed_at: completed,
    output: { summary: JSON.stringify(summary) },
  };
}

const INITIAL_FINDING_RUN = 7001;
const FINDING_REF = `https://github.com/${REPO}/runs/${INITIAL_FINDING_RUN}`;

function requestComment(overrides = {}) {
  const marker = probeMarker({ pullRequest: PR, headSha: ORIGINAL, findingRef: FINDING_REF });
  return {
    id: REQUEST_ID,
    issue_url: `https://api.github.com/repos/${REPO}/issues/${PR}`,
    user: { login: GITHUB_ACTIONS_LOGIN, type: 'Bot' },
    created_at: at('10:30'),
    updated_at: at('10:30'),
    body: codexFixComment({ pullRequestNumber: PR, headSha: ORIGINAL, sourceBranch: BRANCH, findingRef: FINDING_REF, marker }),
    ...overrides,
  };
}

function pull(headSha = CORRECTIVE, overrides = {}) {
  return {
    number: PR,
    state: 'open',
    head: { ref: BRANCH, sha: headSha, repo: { full_name: REPO } },
    base: { ref: 'main', sha: BASE, repo: { full_name: REPO } },
    ...overrides,
  };
}

function activity(id, before, after, hhmm, { type = 'push', actor = CODEX_LOGIN } = {}) {
  return { id, before, after, ref: `refs/heads/${BRANCH}`, timestamp: at(hhmm), activity_type: type, actor: { login: actor } };
}

// A full, valid cycle as GitHub would serve it.
function world() {
  return {
    comment: requestComment(),
    reactions: [{ user: { login: CODEX_LOGIN, type: 'Bot' }, content: CODEX_ACCEPTANCE_REACTION, created_at: at('10:31') }],
    runs: {
      [ORIGINAL]: [...ciRuns(ORIGINAL), shadowRun(ORIGINAL, { id: INITIAL_FINDING_RUN, completed: at('10:20'), state: 'changes_required' })],
      [CORRECTIVE]: [...ciRuns(CORRECTIVE, { start: '10:51', end: '11:00', suite: 2 }), shadowRun(CORRECTIVE, { id: 7002, completed: at('11:20'), state: 'clear' })],
    },
    // newest first, as the Activity API returns it
    activities: [activity(900, ORIGINAL, CORRECTIVE, '10:50'), activity(800, OTHER, ORIGINAL, '09:00', { actor: 'JagPat' })],
    comparison: { status: 'ahead', ahead_by: 2, behind_by: 0, merge_base_commit: { sha: ORIGINAL } },
    pulls: [pull(), pull()],
    verify: true,
  };
}

// A fake GitHubClient. It records every request and refuses anything but a GET, so a test also proves the
// reader is read-only.
function client(w) {
  const calls = [];
  const fake = {
    repository: REPO,
    async request(path, { method = 'GET' } = {}) {
      calls.push(path);
      if (method !== 'GET') throw new Error(`write attempted: ${method} ${path}`);
      if (path === `/repos/${REPO}/issues/comments/${REQUEST_ID}`) return w.comment;
      if (path.startsWith(`/repos/${REPO}/issues/comments/${REQUEST_ID}/reactions`)) return w.reactions;
      if (path.startsWith(`/repos/${REPO}/activity?`)) return w.activities;
      if (path.startsWith(`/repos/${REPO}/compare/`)) return w.comparison;
      throw new Error(`unexpected ${path}`);
    },
    async pullRequest(number) {
      assert.equal(number, PR);
      return w.pulls.shift() ?? pull();
    },
    async checkRuns(sha) {
      return w.runs[sha] ?? [];
    },
    async verifyClaudeShadowProducer() {
      return w.verify;
    },
  };
  return { fake, calls };
}

function clock() {
  let t = ms('12:00');
  return () => (t += 1_000);
}

async function readWorld(mutate = () => {}) {
  const w = world();
  mutate(w);
  const { fake, calls } = client(w);
  const evidence = await readRoleActivationEvidence(fake, { pullRequest: PR, requestCommentId: REQUEST_ID, now: clock() });
  return { evidence, calls };
}

test('the reader normalizes a full correction cycle with identity and server timestamps on every record', async () => {
  const { evidence, calls } = await readWorld();
  assert.equal(evidence.schema, ROLE_ACTIVATION_EVIDENCE_SCHEMA);
  assert.deepEqual(evidence.problems, []);
  assert.deepEqual(evidence.cycle, {
    repository: REPO, pullRequest: PR, branch: BRANCH, baseSha: BASE,
    originalHeadSha: ORIGINAL, correctiveHeadSha: CORRECTIVE, correctionRequestId: REQUEST_ID,
  });
  const { initialCi, initialFinding, request, acceptance, correctivePush, finalCi, finalReview, freshness } = evidence.records;
  // Every record names the repository it was read under.
  for (const record of [initialCi, initialFinding, request, acceptance, correctivePush, finalCi, finalReview, freshness]) {
    assert.equal(record.repository, REPO);
  }
  assert.deepEqual(
    { state: initialCi.state, headSha: initialCi.headSha, baseSha: initialCi.baseSha, atMs: initialCi.atMs },
    { state: 'success', headSha: ORIGINAL, baseSha: BASE, atMs: ms('10:05') },
  );
  assert.deepEqual(
    { state: initialFinding.state, headSha: initialFinding.headSha, reviewRef: initialFinding.reviewRef, atMs: initialFinding.atMs },
    { state: 'changes_required', headSha: ORIGINAL, reviewRef: FINDING_REF, atMs: ms('10:20') },
  );
  assert.deepEqual(
    { githubGenerated: request.githubGenerated, humanAuthored: request.humanAuthored, edited: request.edited,
      headSha: request.headSha, findingRef: request.findingRef, requestId: request.requestId, atMs: request.atMs },
    { githubGenerated: true, humanAuthored: false, edited: false, headSha: ORIGINAL, findingRef: FINDING_REF, requestId: REQUEST_ID, atMs: ms('10:30') },
  );
  assert.deepEqual(acceptance, { repository: REPO, pullRequest: PR, requestId: REQUEST_ID, actorLogin: CODEX_LOGIN, atMs: ms('10:31') });
  assert.deepEqual(correctivePush, {
    repository: REPO, branch: BRANCH, activityId: 900, activityType: 'push', actorLogin: CODEX_LOGIN,
    beforeSha: ORIGINAL, afterSha: CORRECTIVE, atMs: ms('10:50'),
    ancestry: { status: 'ahead', aheadBy: 2, behindBy: 0, mergeBaseSha: ORIGINAL },
  });
  assert.deepEqual(
    { state: finalCi.state, headSha: finalCi.headSha, atMs: finalCi.atMs },
    { state: 'success', headSha: CORRECTIVE, atMs: ms('11:00') },
  );
  assert.deepEqual(
    { state: finalReview.state, headSha: finalReview.headSha, atMs: finalReview.atMs },
    { state: 'shadow_clear', headSha: CORRECTIVE, atMs: ms('11:20') },
  );
  assert.deepEqual(freshness.pushesAfterCorrective, []);
  assert.equal(freshness.liveHeadAtStart, CORRECTIVE);
  assert.equal(freshness.liveHeadAtEnd, CORRECTIVE);
  assert.equal(freshness.headRepository, REPO);
  // The fresh reads fall inside the freshness window.
  for (const readAt of [freshness.pushLogReadAtMs, finalCi.readAtMs, finalReview.readAtMs]) {
    assert.ok(freshness.startedAtMs < readAt && readAt < freshness.observedAtMs);
  }
  // Read-only: GETs only (the fake refuses writes), and only the documented read endpoints.
  assert.ok(calls.every((path) => /\/(issues\/comments|activity\?|compare\/)/u.test(path)));
});

test('the final CI is the latest applicable attempt: a newer failed or cancelled run supersedes an earlier success', async () => {
  for (const conclusion of ['failure', 'cancelled']) {
    const { evidence } = await readWorld((w) => {
      w.runs[CORRECTIVE].push({ ...w.runs[CORRECTIVE].find((run) => run.name === 'api'), id: 9000, conclusion, started_at: at('11:05'), completed_at: at('11:10'), check_suite: { id: 3 } });
    });
    assert.equal(evidence.records.finalCi.state, 'failure', conclusion);
    assert.deepEqual(evidence.records.finalCi.failed, ['api']);
  }
});

test('every branch update after the corrective push is reported, including an away-and-back to the same SHA', async () => {
  const { evidence } = await readWorld((w) => {
    w.activities.unshift(activity(960, OTHER, CORRECTIVE, '11:40'), activity(950, CORRECTIVE, OTHER, '11:30'));
  });
  // The live head is back on the corrective SHA, but the log still shows the two intervening updates.
  assert.equal(evidence.records.freshness.liveHeadAtEnd, CORRECTIVE);
  assert.deepEqual(evidence.records.freshness.pushesAfterCorrective.map((entry) => entry.activityId), [950, 960]);
});

test('the live head is read before and after the fresh reads, so a move inside the window is visible', async () => {
  const { evidence } = await readWorld((w) => { w.pulls = [pull(CORRECTIVE), pull(OTHER)]; });
  assert.equal(evidence.records.freshness.liveHeadAtStart, CORRECTIVE);
  assert.equal(evidence.records.freshness.liveHeadAtEnd, OTHER);
});

test('the corrective push is the first update after the request, with its server type, actor and ancestry', async () => {
  const forced = await readWorld((w) => {
    w.activities[0] = activity(900, ORIGINAL, CORRECTIVE, '10:50', { type: 'force_push' });
    w.comparison = { status: 'diverged', ahead_by: 1, behind_by: 1, merge_base_commit: { sha: OTHER } };
  });
  assert.equal(forced.evidence.records.correctivePush.activityType, 'force_push');
  assert.deepEqual(forced.evidence.records.correctivePush.ancestry, { status: 'diverged', aheadBy: 1, behindBy: 1, mergeBaseSha: OTHER });
  // A human push that lands first after the request IS the first update: its actor is reported, and the
  // Codex push that follows is a later update.
  const human = await readWorld((w) => {
    w.activities.unshift(activity(910, CORRECTIVE, OTHER, '10:55'));
    w.activities[1] = activity(900, ORIGINAL, CORRECTIVE, '10:50', { actor: 'JagPat' });
  });
  assert.equal(human.evidence.records.correctivePush.actorLogin, 'JagPat');
  assert.deepEqual(human.evidence.records.freshness.pushesAfterCorrective.map((entry) => entry.activityId), [910]);
  // A full page that does not reach back to the request is truncated: no corrective push is guessed.
  const truncated = await readWorld((w) => {
    w.activities = Array.from({ length: PUSH_LOG_PAGE_SIZE }, (_, index) =>
      activity(1000 + index, index === PUSH_LOG_PAGE_SIZE - 1 ? ORIGINAL : OTHER, CORRECTIVE, '11:59'));
  });
  assert.equal(truncated.evidence.records.correctivePush, null);
  assert.ok(truncated.evidence.problems.some((problem) => problem.includes('truncated')));
});

test('the correction request is the GitHub-generated probe comment on THIS PR, with its author and finding', async () => {
  const human = await readWorld((w) => { w.comment = requestComment({ user: { login: 'JagPat', type: 'User' } }); });
  assert.equal(human.evidence.records.request.githubGenerated, false);
  assert.equal(human.evidence.records.request.humanAuthored, true);
  const edited = await readWorld((w) => { w.comment = requestComment({ updated_at: at('10:45') }); });
  assert.equal(edited.evidence.records.request.edited, true);
  for (const comment of [
    requestComment({ issue_url: `https://api.github.com/repos/${REPO}/issues/620` }), // another PR
    requestComment({ issue_url: `https://api.github.com/repos/fork/PMCvitan/issues/${PR}` }), // another repository
    requestComment({ body: '@codex fix\nno marker' }),
    requestComment({ body: `${requestComment().body}\n${probeMarker({ pullRequest: PR, headSha: ORIGINAL, findingRef: 'x' })}` }), // two markers
  ]) {
    const { evidence } = await readWorld((w) => { w.comment = comment; });
    assert.equal(evidence.records.request, null);
    assert.equal(evidence.records.acceptance, null);
    assert.equal(evidence.cycle.correctionRequestId, null);
  }
  assert.deepEqual(parseProbeMarker(requestComment().body), { pullRequest: PR, headSha: ORIGINAL, findingRef: FINDING_REF });
});

test('task acceptance is only the Codex connector 👀 reaction on the request comment, earliest first', async () => {
  const ignored = await readWorld((w) => {
    w.reactions = [
      { user: { login: 'JagPat', type: 'User' }, content: 'eyes', created_at: at('10:31') },
      { user: { login: CODEX_LOGIN, type: 'Bot' }, content: '+1', created_at: at('10:32') },
    ];
  });
  assert.equal(ignored.evidence.records.acceptance, null);
  const earliest = await readWorld((w) => {
    w.reactions = [
      { user: { login: CODEX_LOGIN, type: 'Bot' }, content: 'eyes', created_at: at('10:40') },
      { user: { login: CODEX_LOGIN, type: 'Bot' }, content: 'eyes', created_at: at('10:33') },
    ];
  });
  assert.equal(earliest.evidence.records.acceptance.atMs, ms('10:33'));
});

test('the initial CI is evaluated as of the triggering finding, not as it stands now', async () => {
  // A rerun that failed AFTER the finding does not rewrite what the finding followed.
  const later = await readWorld((w) => {
    w.runs[ORIGINAL].push({ ...w.runs[ORIGINAL][2], id: 9100, conclusion: 'failure', started_at: at('10:40'), completed_at: at('10:45'), check_suite: { id: 4 } });
  });
  assert.equal(later.evidence.records.initialCi.state, 'success');
  // A run still in progress when the finding completed leaves the initial CI unfinished at that time.
  const inFlight = await readWorld((w) => {
    w.runs[ORIGINAL].push({ ...w.runs[ORIGINAL][2], id: 9200, started_at: at('10:10'), completed_at: at('10:25'), check_suite: { id: 5 } });
  });
  assert.equal(inFlight.evidence.records.initialCi.state, 'pending');
});

test('shadow evidence is producer-verified and base-bound; unverifiable or rebased evidence carries no identity', async () => {
  const untrusted = await readWorld((w) => { w.verify = false; });
  assert.deepEqual(untrusted.evidence.records.initialFinding, { state: 'untrusted_producer' });
  assert.deepEqual(untrusted.evidence.records.finalReview, { state: 'untrusted_producer', readAtMs: untrusted.evidence.records.finalCi.readAtMs });
  assert.equal(untrusted.evidence.records.initialCi, null); // no finding time to evaluate the initial CI at
  const rebased = await readWorld((w) => { w.pulls = [pull(CORRECTIVE, { base: { ref: 'main', sha: OTHER, repo: { full_name: REPO } } }), pull()]; });
  assert.deepEqual(rebased.evidence.records.initialFinding, { state: 'missing' });
  assert.equal(rebased.evidence.cycle.baseSha, OTHER);
});

test('a fork head repository is reported, not normalized away', async () => {
  const { evidence } = await readWorld((w) => {
    w.pulls = [pull(CORRECTIVE, { head: { ref: BRANCH, sha: CORRECTIVE, repo: { full_name: 'fork/PMCvitan' } } }), pull()];
  });
  assert.equal(evidence.records.freshness.headRepository, 'fork/PMCvitan');
});

test('a GitHub read failure is contained as a null record and a diagnostic, never thrown', async () => {
  const w = world();
  const { fake } = client(w);
  const failing = { ...fake, async request(path, options) {
    if (path.includes('/reactions')) throw new Error('boom');
    return fake.request(path, options);
  } };
  const evidence = await readRoleActivationEvidence(failing, { pullRequest: PR, requestCommentId: REQUEST_ID, now: clock() });
  assert.equal(evidence.records.acceptance, null);
  assert.ok(evidence.problems.some((problem) => problem.startsWith('acceptance: boom')));
  assert.ok(evidence.records.finalReview); // the rest of the cycle is still read
  const invalid = await readRoleActivationEvidence(fake, { pullRequest: 0, requestCommentId: REQUEST_ID });
  assert.equal(invalid.cycle, null);
  assert.deepEqual(invalid.problems, ['invalid reader input']);
});
