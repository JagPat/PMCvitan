import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CONVERSATION_MAX_PAGES,
  CONVERSATION_PAGE_SIZE,
  GITHUB_ACTIONS_LOGIN,
  PUSH_LOG_PAGE_SIZE,
  ROLE_ACTIVATION_EVIDENCE_SCHEMA,
  normalizeConversationItem,
  parseProbeMarker,
  readRoleActivationEvidence,
} from './role-activation-evidence.mjs';
import { probeMarker, probeTrailerValue } from './codex-fix-probe.mjs';
import { CODEX_LOGIN, REQUIRED_CHECKS } from './review-policy.mjs';
import { EVENT_LOG_PAGE_SIZE } from './pull-request-event-log.mjs';
import {
  BASE, BRANCH, CORRECTIVE, FINDING_REF, INITIAL_FINDING_RUN, ORIGINAL, OTHER, PR, REPO, REQUEST_ID, correctiveCommit,
  activity, at, ciRuns, client, clock, conversationItem, issueEvent, ms, pull, readWorld, requestComment, shadowRun, world,
} from './role-activation-test-fixtures.mjs';

const BINDING_VALUE = probeTrailerValue({ pullRequest: PR, headSha: ORIGINAL, findingRef: FINDING_REF });
const HELD_CODEX = { outcome: 'candidate', owner: 'codex' };

test('the reader normalizes a full correction cycle with identity and server timestamps on every record', async () => {
  const { evidence, calls } = await readWorld();
  assert.equal(evidence.schema, ROLE_ACTIVATION_EVIDENCE_SCHEMA);
  assert.deepEqual(evidence.problems, []);
  assert.deepEqual(evidence.cycle, {
    repository: REPO, pullRequest: PR, branch: BRANCH, baseSha: BASE,
    originalHeadSha: ORIGINAL, correctiveHeadSha: CORRECTIVE, correctionRequestId: REQUEST_ID,
  });
  const { initialCi, initialFinding, request, acceptance, correctivePush, finalCi, finalReview, freshness, conversation } = evidence.records;
  // Every record names the repository it was read under.
  for (const record of [initialCi, initialFinding, request, acceptance, correctivePush, finalCi, finalReview, freshness, conversation]) {
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
  assert.deepEqual(acceptance, { repository: REPO, pullRequest: PR, requestId: REQUEST_ID, actorLogin: CODEX_LOGIN, atMs: ms('10:31'), readAtMs: acceptance.readAtMs });
  assert.deepEqual(correctivePush, {
    repository: REPO, pullRequest: PR, branch: BRANCH, activityId: 900, activityType: 'push', actorLogin: CODEX_LOGIN,
    beforeSha: ORIGINAL, afterSha: CORRECTIVE, atMs: ms('10:50'),
    ancestry: {
      status: 'ahead', aheadBy: 2, behindBy: 0, mergeBaseSha: ORIGINAL, commitsComplete: true,
      commits: [
        { sha: '1'.repeat(40), authorLogin: CODEX_LOGIN, probeTrailers: [BINDING_VALUE], correctionOwner: HELD_CODEX },
        { sha: CORRECTIVE, authorLogin: CODEX_LOGIN, probeTrailers: [BINDING_VALUE], correctionOwner: HELD_CODEX },
      ],
    },
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
  assert.deepEqual(
    { headRepositoryAtEnd: freshness.headRepositoryAtEnd, baseRefAtEnd: freshness.baseRefAtEnd, baseRepositoryAtEnd: freshness.baseRepositoryAtEnd },
    { headRepositoryAtEnd: REPO, baseRefAtEnd: 'main', baseRepositoryAtEnd: REPO },
  );
  assert.deepEqual(initialFinding.laterReviewRunIds, []);
  // The lifecycle event log covers the cycle from its earliest milestone: the update that brought the branch
  // to the reviewed head (09:00; every workflow for that head was created after it), before the initial CI
  // started, the finding and the request. The retarget before it is not the cycle's.
  assert.deepEqual(freshness.reviewedHeadArrival, { activityId: 800, afterSha: ORIGINAL, atMs: ms('09:00') });
  assert.equal(initialCi.startedAtMs, ms('10:00'));
  assert.equal(freshness.lifecycleSinceMs, ms('09:00'));
  assert.deepEqual(freshness.lifecycleEvents, []);
  // The final CI names the one run that decided each required name.
  assert.deepEqual(finalCi.deciders.map((decider) => decider.name).sort(), [...REQUIRED_CHECKS].sort());
  assert.ok(finalCi.deciders.every((decider) => decider.conclusion === 'success' && decider.completedAtMs === ms('11:00')));
  // Every closing read starts after the freshness point, which follows the pass's opening.
  assert.ok(freshness.startedAtMs < freshness.observedAtMs);
  // The final live-PR read is the very last read of the pass, after the event log.
  assert.ok(freshness.eventLogReadAtMs < freshness.pullFinalReadAtMs);
  assert.deepEqual(
    [freshness.prStateAtClose, freshness.liveHeadAtClose, freshness.baseRefAtClose, freshness.baseShaAtClose, freshness.baseRepositoryAtClose],
    ['open', CORRECTIVE, 'main', BASE, REPO],
  );
  // Every mutable source is read after the freshness point.
  for (const readAt of [request.readAtMs, acceptance.readAtMs, conversation.readAtMs, initialFinding.readAtMs, initialCi.readAtMs,
    freshness.pullReadAtMs, freshness.pushLogReadAtMs, finalCi.readAtMs, finalReview.readAtMs,
    freshness.eventLogCoveredFromMs, freshness.eventLogReadAtMs]) {
    assert.ok(freshness.observedAtMs < readAt);
  }
  // Read-only: GETs only (the fake refuses writes), and only the documented read endpoints.
  assert.ok(calls.every((path) => /\/(issues\/comments|issues\/619$|issues\/619\/(events|comments)\?|pulls\/619\/(comments|reviews)\?|activity\?|compare\/)/u.test(path)));
  // The push log names its period; this cycle is inside a day.
  assert.ok(calls.filter((path) => path.includes('/activity?')).every((path) => path.endsWith('&time_period=day')));
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

test('the push log covers the whole cycle: the Activity period widens past the default day, and older than a year is uncovered', async () => {
  const day = (offset, hhmm) => `2026-09-${String(23 - offset).padStart(2, '0')}T${hhmm}:00Z`;
  const dated = (id, before, after, when, options) => ({ ...activity(id, before, after, '00:00', options), timestamp: when });
  // A cycle two days old with a recent later update: the default day would show only the later update, and
  // it would pass for the corrective push.
  const old = await readWorld((w) => {
    w.comment = requestComment({ created_at: day(2, '10:30'), updated_at: day(2, '10:30') });
    w.reactions[0].created_at = day(2, '10:31');
    w.activities = [
      dated(960, OTHER, CORRECTIVE, day(0, '11:40')),
      dated(950, CORRECTIVE, OTHER, day(0, '11:30')),
      dated(900, ORIGINAL, CORRECTIVE, day(2, '10:50')),
      dated(800, OTHER, ORIGINAL, day(2, '09:00'), { actor: 'JagPat' }),
    ];
  });
  assert.equal(old.evidence.records.correctivePush.activityId, 900);
  assert.deepEqual(old.evidence.records.freshness.pushesAfterCorrective.map((entry) => entry.activityId), [950, 960]);
  assert.ok(old.calls.filter((path) => path.includes('/activity?')).every((path) => path.endsWith('&time_period=week')));
  // A recent request on a head pushed days earlier: the day page lacks an update at or before the request,
  // so the reader widens rather than trusting a short page.
  const widened = await readWorld((w) => { w.activities[1] = dated(800, OTHER, ORIGINAL, day(3, '09:00'), { actor: 'JagPat' }); });
  assert.equal(widened.evidence.records.correctivePush.activityId, 900);
  assert.ok(widened.calls.some((path) => path.endsWith('&time_period=week')));
  // Older than the longest period: uncovered, never guessed.
  const ancient = await readWorld((w) => { w.comment = requestComment({ created_at: '2025-09-01T10:30:00Z', updated_at: '2025-09-01T10:30:00Z' }); });
  assert.equal(ancient.evidence.records.correctivePush, null);
  assert.ok(ancient.evidence.problems.some((problem) => problem.includes('longest Activity API period')));
});

test('a push inside the freshness window is caught by the closing push-log read, even away-and-back', async () => {
  // Barrier: the branch moves C -> D -> C right after the reader's FIRST push-log read, before the rest of
  // the pass. Both live PR reads still show C.
  const { evidence } = await readWorld((w) => {
    w.after = { activity: { 1: (world) => world.activities.unshift(activity(960, OTHER, CORRECTIVE, '11:59'), activity(950, CORRECTIVE, OTHER, '11:58')) } };
  });
  const { freshness } = evidence.records;
  assert.equal(freshness.liveHeadAtStart, CORRECTIVE);
  assert.equal(freshness.liveHeadAtEnd, CORRECTIVE);
  assert.deepEqual(freshness.pushesAfterCorrective.map((entry) => entry.activityId), [950, 960]);
  assert.ok(freshness.observedAtMs < freshness.pushLogReadAtMs);
  // A closing log that no longer confirms the corrective push is unknown, never "no pushes".
  const lost = await readWorld((w) => {
    w.after = { activity: { 1: (world) => { world.activities = []; } } };
  });
  assert.equal(lost.evidence.records.freshness.pushesAfterCorrective, null);
  assert.ok(lost.evidence.problems.some((problem) => problem.startsWith('push-log-closing')));
  const renamed = await readWorld((w) => {
    w.after = { activity: { 1: (world) => { world.activities[0] = { ...world.activities[0], id: 901 }; } } };
  });
  assert.equal(renamed.evidence.records.freshness.pushesAfterCorrective, null);
  assert.ok(renamed.evidence.problems.includes('push-log-closing: the closing log names a different corrective push'));
});

test('the final CI is read after the freshness point, so a rerun started before it is the governing attempt', async () => {
  // Barrier: a rerun of `api` starts on the corrective SHA right after the closing live-PR read.
  const { evidence } = await readWorld((w) => {
    w.after = { pull: { 2: (world) => world.runs[CORRECTIVE].push({
      ...world.runs[CORRECTIVE].find((run) => run.name === 'api'),
      id: 9300, status: 'in_progress', conclusion: null, started_at: at('11:58'), completed_at: null, check_suite: { id: 6 },
    }) } };
  });
  const { finalCi, freshness } = evidence.records;
  assert.equal(finalCi.state, 'pending');
  assert.deepEqual(finalCi.pending, ['api']);
  assert.ok(freshness.observedAtMs < finalCi.readAtMs);
});

test('the request is re-read after the freshness point: an edit, a re-pointing or a deletion during the pass is visible', async () => {
  // Barrier: the request comment is edited right after the reader's opening read of it.
  const edited = await readWorld((w) => {
    w.after = { comment: { 1: (world) => { world.comment = requestComment({ updated_at: at('11:59') }); } } };
  });
  assert.equal(edited.evidence.records.request.edited, true);
  assert.ok(edited.evidence.records.freshness.observedAtMs < edited.evidence.records.request.readAtMs);
  // Re-pointed at another finding: no request, and a diagnostic.
  const repointed = await readWorld((w) => {
    w.after = { comment: { 1: (world) => {
      const marker = probeMarker({ pullRequest: PR, headSha: ORIGINAL, findingRef: `https://github.com/${REPO}/runs/7999` });
      world.comment = requestComment({ body: `@codex fix\n${marker}` });
    } } };
  });
  assert.equal(repointed.evidence.records.request, null);
  assert.equal(repointed.evidence.records.acceptance, null);
  assert.ok(repointed.evidence.problems.includes('request-recheck: the request changed during the pass'));
  // Stripped of its marker: no longer this cycle's request.
  const stripped = await readWorld((w) => {
    w.after = { comment: { 1: (world) => { world.comment = requestComment({ body: '@codex fix\nno marker' }); } } };
  });
  assert.equal(stripped.evidence.records.request, null);
  assert.deepEqual(stripped.evidence.problems.filter((problem) => problem.startsWith('request-recheck:')), [
    'request-recheck: rejected: no single codex-fix-probe marker with an @codex fix line',
    "request-recheck: the request is no longer readable as this cycle's request",
  ]);
  // Unreadable at the opening read but readable later: nothing was planned from it, so no request at all.
  const late = await readWorld((w) => {
    const comment = w.comment;
    w.comment = null;
    w.after = { comment: { 1: (world) => { world.comment = comment; } } };
  });
  assert.equal(late.evidence.records.request, null);
  assert.equal(late.evidence.cycle.originalHeadSha, null);
  assert.ok(late.evidence.problems.some((problem) => problem.startsWith('request: Not Found')));
  // Deleted: no request, and a diagnostic.
  const deleted = await readWorld((w) => { w.after = { comment: { 1: (world) => { world.comment = null; } } }; });
  assert.equal(deleted.evidence.records.request, null);
  assert.ok(deleted.evidence.problems.some((problem) => problem.startsWith('request-recheck:')));
});

test('a corrective push that lands during the pass is a diagnostic, never silently absent', async () => {
  // Barrier: no update after the request at the opening push-log read; the corrective push lands right after.
  const { evidence } = await readWorld((w) => {
    w.activities = w.activities.filter((entry) => entry.id !== 900);
    w.pulls = [pull(ORIGINAL), pull(CORRECTIVE)];
    w.after = { activity: { 1: (world) => world.activities.unshift(activity(900, ORIGINAL, CORRECTIVE, '11:59')) } };
  });
  assert.equal(evidence.records.correctivePush, null);
  assert.equal(evidence.records.freshness.liveHeadAtEnd, CORRECTIVE);
  assert.ok(evidence.problems.includes('push-log-closing: a corrective push landed during the pass; read the cycle again'));
});

test('a later review of the reviewed head that appears during the pass is listed', async () => {
  // Barrier: a new shadow review of the reviewed head appears right after the opening push-log read.
  const { evidence } = await readWorld((w) => {
    w.after = { activity: { 1: (world) => world.runs[ORIGINAL].push(shadowRun(ORIGINAL, { id: 7600, completed: at('11:59'), state: 'clear' })) } };
  });
  assert.equal(evidence.records.initialFinding.reviewRef, FINDING_REF);
  assert.deepEqual(evidence.records.initialFinding.laterReviewRunIds, [7600]);
});

test('the CI record is dated by the runs that decided it, not by a superseded straggler', async () => {
  // An earlier attempt (suite 1) on the corrective SHA was superseded by suite 2 (the fixture's), but its
  // `api` job straggles to a success at 11:30 — after the applicable suite finished at 11:00.
  const { evidence } = await readWorld((w) => {
    const gate = (name, id) => ({ id, name, head_sha: CORRECTIVE, status: 'completed', conclusion: 'success', started_at: at('10:50'), completed_at: at('10:51'), check_suite: { id: 1 } });
    w.runs[CORRECTIVE].push(gate('review-scope', 9401), gate('battery-plan', 9402),
      { ...gate('api', 9403), started_at: at('10:51'), completed_at: at('11:30') });
  });
  const { finalCi } = evidence.records;
  assert.equal(finalCi.state, 'success');
  assert.equal(finalCi.atMs, ms('11:00'));
  assert.notEqual(finalCi.deciders.find((decider) => decider.name === 'api').checkRunId, 9403);
});

test('the ending base ref and repositories are recorded, so a retarget to a same-SHA branch is visible', async () => {
  const { evidence } = await readWorld((w) => {
    w.pulls = [pull(), pull(CORRECTIVE, { base: { ref: 'release', sha: BASE, repo: { full_name: 'fork/PMCvitan' } } })];
  });
  const { freshness } = evidence.records;
  assert.equal(freshness.baseRef, 'main');
  assert.equal(freshness.baseShaAtEnd, BASE);
  assert.equal(freshness.baseRefAtEnd, 'release');
  assert.equal(freshness.baseRepositoryAtEnd, 'fork/PMCvitan');
});

test('a later review counts only when producer-verified; a same-named unverified run is reported apart', async () => {
  const { evidence } = await readWorld((w) => {
    w.runs[ORIGINAL].push(
      shadowRun(ORIGINAL, { id: 7500, completed: at('10:40'), state: 'clear' }),
      shadowRun(ORIGINAL, { id: 7600, completed: at('10:45'), state: 'clear' }),
    );
    w.verify = (run) => run.id !== 7600; // 7600 carries the shadow name but fails producer verification
  });
  assert.deepEqual(evidence.records.initialFinding.laterReviewRunIds, [7500]);
  assert.deepEqual(evidence.records.initialFinding.unverifiedLaterRunIds, [7600]);
});

test('the initial finding is the run the request names; a later review of the same head is reported beside it', async () => {
  const { evidence } = await readWorld((w) => {
    w.runs[ORIGINAL].push(shadowRun(ORIGINAL, { id: 7500, completed: at('10:40'), state: 'clear' }));
  });
  const { initialFinding } = evidence.records;
  assert.equal(initialFinding.reviewRef, FINDING_REF);
  assert.equal(initialFinding.state, 'changes_required');
  assert.equal(initialFinding.atMs, ms('10:20'));
  assert.deepEqual(initialFinding.laterReviewRunIds, [7500]);
  // A marker naming no run of the reviewed head yields no finding identity.
  const unnamed = await readWorld((w) => { w.runs[ORIGINAL] = w.runs[ORIGINAL].filter((run) => run.id !== INITIAL_FINDING_RUN); });
  assert.equal(unnamed.evidence.records.initialFinding.state, 'missing');
  assert.equal(unnamed.evidence.records.initialFinding.reviewRef, undefined);
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
  assert.deepEqual(forced.evidence.records.correctivePush.ancestry,
    { status: 'diverged', aheadBy: 1, behindBy: 1, mergeBaseSha: OTHER, commits: null, commitsComplete: false });
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
  assert.ok(truncated.evidence.problems.some((problem) => problem.includes('uncovered')));
  // A full page cannot be widened into coverage, so neither the opening nor the closing read retries it
  // under a longer period.
  assert.equal(truncated.calls.filter((path) => path.includes('/activity?')).length, 2);
});

test('the correction request is the GitHub-generated probe comment on THIS PR, with its author and finding', async () => {
  const human = await readWorld((w) => { w.comment = requestComment({ user: { login: 'JagPat', type: 'User' } }); });
  assert.equal(human.evidence.records.request.githubGenerated, false);
  assert.equal(human.evidence.records.request.humanAuthored, true);
  const edited = await readWorld((w) => { w.comment = requestComment({ updated_at: at('10:45') }); });
  assert.equal(edited.evidence.records.request.edited, true);
  const noMarker = 'no single codex-fix-probe marker with an @codex fix line';
  for (const [comment, reason] of [
    [requestComment({ issue_url: `https://api.github.com/repos/${REPO}/issues/620` }), 'the comment is not on this repository and pull request'], // another PR
    [requestComment({ issue_url: `https://api.github.com/repos/fork/PMCvitan/issues/${PR}` }), 'the comment is not on this repository and pull request'], // another repository
    [requestComment({ body: '@codex fix\nno marker' }), noMarker],
    [requestComment({ body: `${requestComment().body}\n${probeMarker({ pullRequest: PR, headSha: ORIGINAL, findingRef: 'x' })}` }), noMarker], // two markers
    [requestComment({ body: `@codex fix\n${probeMarker({ pullRequest: 620, headSha: ORIGINAL, findingRef: FINDING_REF })}` }), 'the marker names another pull request'],
    [requestComment({ created_at: 'not a time' }), 'no readable creation time'],
    [{ ...requestComment(), id: 'x' }, 'not a comment record'],
    [null, 'not a comment record'], // an empty answer, not a thrown error
  ]) {
    const { evidence } = await readWorld((w) => { w.comment = comment; w.emptyAnswer = comment === null; });
    assert.equal(evidence.records.request, null);
    assert.equal(evidence.records.acceptance, null);
    assert.equal(evidence.cycle.correctionRequestId, null);
    // Fetched but rejected is diagnosed with its reason, never a silent null.
    assert.deepEqual(evidence.problems, [`request: rejected: ${reason}`], reason);
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
  assert.equal(untrusted.evidence.records.initialFinding.state, 'untrusted_producer');
  assert.equal(untrusted.evidence.records.initialFinding.reviewRef, undefined);
  assert.deepEqual(untrusted.evidence.records.finalReview, { state: 'untrusted_producer', readAtMs: untrusted.evidence.records.finalCi.readAtMs });
  assert.equal(untrusted.evidence.records.initialCi, null); // no finding time to evaluate the initial CI at
  const rebased = await readWorld((w) => { w.pulls = [pull(CORRECTIVE, { base: { ref: 'main', sha: OTHER, repo: { full_name: REPO } } }), pull()]; });
  assert.equal(rebased.evidence.records.initialFinding.state, 'missing');
  assert.equal(rebased.evidence.records.initialFinding.reviewRef, undefined);
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

test('an away-and-back base retarget inside the window is listed from the event log, though both PR reads agree', async () => {
  // Barrier: right after the opening live-PR read, the PR is retargeted main -> release -> main. Both live
  // PR reads show main at the same SHA, and the head push log is untouched.
  const { evidence } = await readWorld((w) => {
    w.after = { pull: { 1: (world) => world.events.push(
      issueEvent(50, 'base_ref_changed', '11:58'), issueEvent(51, 'base_ref_changed', '11:59'),
    ) } };
  });
  const { freshness } = evidence.records;
  assert.deepEqual(
    [freshness.baseRef, freshness.baseRefAtEnd, freshness.baseSha, freshness.baseShaAtEnd],
    ['main', 'main', BASE, BASE],
  );
  assert.deepEqual(freshness.lifecycleEvents, [
    { eventId: 50, event: 'base_ref_changed', actorLogin: 'JagPat', atMs: ms('11:58') },
    { eventId: 51, event: 'base_ref_changed', actorLogin: 'JagPat', atMs: ms('11:59') },
  ]);
  assert.deepEqual(evidence.problems, []);
  // A close and reopen inside the window is listed the same way.
  const reopened = await readWorld((w) => {
    w.after = { pull: { 1: (world) => world.events.push(issueEvent(52, 'closed', '11:58'), issueEvent(53, 'reopened', '11:59')) } };
  });
  assert.deepEqual(reopened.evidence.records.freshness.lifecycleEvents.map((entry) => entry.event), ['closed', 'reopened']);
});

test('the event log is a closing read: an event appended before the freshness point is listed', async () => {
  // Barrier: the retarget lands after the reader's last opening read (the push log), before any closing read.
  const { evidence } = await readWorld((w) => {
    w.after = { activity: { 1: (world) => world.events.push(issueEvent(60, 'base_ref_changed', '11:59')) } };
  });
  const { freshness } = evidence.records;
  assert.deepEqual(freshness.lifecycleEvents.map((entry) => entry.eventId), [60]);
  assert.ok(freshness.observedAtMs < freshness.eventLogCoveredFromMs);
  assert.ok(freshness.pushLogReadAtMs < freshness.eventLogCoveredFromMs);
});

test('the event log is anchored at the cycle\'s earliest milestone; without a finding time, at the request', async () => {
  // A retarget between the finding (10:20) and the request (10:30) is the cycle's.
  const between = await readWorld((w) => { w.events.push(issueEvent(70, 'base_ref_changed', '10:25')); });
  assert.deepEqual(between.evidence.records.freshness.lifecycleEvents.map((entry) => entry.eventId), [70]);
  // So is one after the initial CI started (10:00) but before the finding: it moves the base the deciding
  // runs were launched on.
  const afterCi = await readWorld((w) => { w.events.push(issueEvent(70, 'base_ref_changed', '10:10')); });
  assert.deepEqual(afterCi.evidence.records.freshness.lifecycleEvents.map((entry) => entry.eventId), [70]);
  // The anchor is the EARLIEST decider start: one required check started at 09:50 moves it there.
  const staggered = await readWorld((w) => {
    w.runs[ORIGINAL][0] = { ...w.runs[ORIGINAL][0], started_at: at('09:50') };
    w.events.push(issueEvent(71, 'base_ref_changed', '09:55'));
  });
  assert.equal(staggered.evidence.records.initialCi.startedAtMs, ms('09:50'));
  assert.deepEqual(staggered.evidence.records.freshness.lifecycleEvents.map((entry) => entry.eventId), [71]);
  // Finding 4086243264: a workflow can be created (and queued) before its first job starts. The head's
  // arrival bounds every workflow for it, so a retarget between the arrival (09:00) and the first job start
  // (10:00) is the cycle's.
  const queued = await readWorld((w) => { w.events.push(issueEvent(72, 'base_ref_changed', '09:10')); });
  assert.deepEqual(queued.evidence.records.freshness.lifecycleEvents.map((entry) => entry.eventId), [72]);
  // The arrival is the LATEST update at or before the request, not an older one.
  const older = await readWorld((w) => { w.activities.push(activity(700, BASE, OTHER, '08:00', { actor: 'JagPat' })); });
  assert.deepEqual(older.evidence.records.freshness.reviewedHeadArrival, { activityId: 800, afterSha: ORIGINAL, atMs: ms('09:00') });
  // The anchor is the earliest of every milestone: when deciders started before the recorded arrival (the
  // same head arrived earlier too), the CI start moves it earlier still.
  const reArrived = await readWorld((w) => {
    w.activities[1] = { ...w.activities[1], timestamp: at('10:10') };
    w.events.push(issueEvent(73, 'base_ref_changed', '10:05'));
  });
  assert.equal(reArrived.evidence.records.freshness.reviewedHeadArrival.atMs, ms('10:10'));
  assert.equal(reArrived.evidence.records.freshness.lifecycleSinceMs, ms('10:00'));
  assert.deepEqual(reArrived.evidence.records.freshness.lifecycleEvents.map((entry) => entry.eventId), [73]);
  // With no arrival, no finding time and no CI, the anchor is the request.
  const unverified = await readWorld((w) => {
    w.verify = false;
    w.activities = w.activities.map((entry) => (entry.id === 800 ? { ...entry, timestamp: at('10:30') } : entry));
    w.events.push(issueEvent(70, 'base_ref_changed', '10:25'), issueEvent(71, 'base_ref_changed', '10:40'));
  });
  assert.equal(unverified.evidence.records.freshness.lifecycleSinceMs, ms('10:30'));
  assert.deepEqual(unverified.evidence.records.freshness.lifecycleEvents.map((entry) => entry.eventId), [71]);
  // No request, no cycle: the log is not read at all.
  const none = await readWorld((w) => { w.comment = null; });
  assert.ok(!none.calls.some((path) => path.includes('/events?')));
  assert.equal(none.evidence.records.freshness.lifecycleEvents, null);
});

test('an incomplete event log is unknown with a diagnostic, never "no events"', async () => {
  const failed = await readWorld((w) => { w.eventsError = 'boom'; });
  assert.equal(failed.evidence.records.freshness.lifecycleEvents, null);
  assert.deepEqual(failed.evidence.problems, ['event-log: events page 1: boom']);
  const disordered = await readWorld((w) => { w.events.reverse(); });
  assert.equal(disordered.evidence.records.freshness.lifecycleEvents, null);
  assert.deepEqual(disordered.evidence.problems, ['event-log: events: ids do not strictly increase (uncovered)']);
  // Read to its end across pages: a retarget on the second page is listed.
  const paged = await readWorld((w) => {
    w.events = [...Array.from({ length: EVENT_LOG_PAGE_SIZE }, (_, index) => issueEvent(1000 + index, 'labeled', '09:00')),
      issueEvent(2000, 'base_ref_changed', '11:00')];
  });
  assert.deepEqual(paged.evidence.records.freshness.lifecycleEvents.map((entry) => entry.eventId), [2000]);
  assert.equal(paged.calls.filter((path) => path.includes('/events?')).length, 2);
});

test('the corrective push reports each commit\'s binding trailers, and whether the commit list is complete', async () => {
  const { evidence } = await readWorld((w) => {
    w.comparison.commits = [
      correctiveCommit('1'.repeat(40), 'fix: no trailer here'),
      correctiveCommit(CORRECTIVE, `fix: two\n\nCodex-Fix-Probe: other-request\nCodex-Fix-Probe: ${BINDING_VALUE}`),
      // Quoted in a code fence, not a terminal trailer; and a commit with no message is unreadable.
      correctiveCommit('2'.repeat(40), `fix: fenced\n\n\`\`\`\nCodex-Fix-Probe: ${BINDING_VALUE}\n\`\`\`\n`),
      { sha: '3'.repeat(40), author: { login: CODEX_LOGIN }, commit: {} },
    ];
  });
  assert.deepEqual(evidence.records.correctivePush.ancestry.commits.map((commit) => commit.probeTrailers),
    [[], ['other-request', BINDING_VALUE], [], null]);
  // The owner is read exactly as the controller reads a head: none of these declares a held Codex candidate.
  assert.deepEqual(evidence.records.correctivePush.ancestry.commits.map((commit) => commit.correctionOwner),
    [{ outcome: 'invalid', owner: null }, { outcome: 'invalid', owner: null }, { outcome: 'invalid', owner: null }, null]);
  // The compare API returns at most one page of commits: a list shorter than total_commits, or a
  // total_commits that differs from ahead_by, is incomplete; so is a response without a commit list.
  for (const change of [
    { total_commits: 3 }, { total_commits: 2, ahead_by: 3 }, { commits: undefined }, { total_commits: undefined },
    { commits: [correctiveCommit(CORRECTIVE)] }, // a truncated page: total_commits and ahead_by still 2
  ]) {
    const partial = await readWorld((w) => { Object.assign(w.comparison, change); });
    assert.equal(partial.evidence.records.correctivePush.ancestry.commitsComplete, false, JSON.stringify(change));
  }
});

test('the conversation lists every issue comment, review comment and review, with author, dates and @codex mentions', async () => {
  const { evidence } = await readWorld();
  const { conversation } = evidence.records;
  assert.equal(conversation.pullRequest, PR);
  assert.deepEqual(conversation.items.map((item) => [item.kind, item.id, item.authorLogin, item.mentionsCodex]), [
    ['pull_request', 9619, 'JagPat', false],
    ['issue_comment', 61, 'JagPat', false],
    ['issue_comment', 62, GITHUB_ACTIONS_LOGIN, false],
    ['issue_comment', REQUEST_ID, GITHUB_ACTIONS_LOGIN, true],
    ['review_comment', 63, CODEX_LOGIN, false],
    ['review', 64, CODEX_LOGIN, true],
  ]);
  assert.deepEqual([conversation.items[2].createdAtMs, conversation.items[2].updatedAtMs], [ms('08:50'), ms('11:30')]);
  // The description is dated by its creation only (the issue's updated_at is any activity), and its title counts.
  assert.deepEqual([conversation.items[0].createdAtMs, conversation.items[0].updatedAtMs], [ms('09:30'), ms('09:30')]);
  assert.equal(normalizeConversationItem('pull_request', { id: 3, title: 'ask @codex', body: null }).mentionsCodex, true);
  // A review is dated by its submission; an undated item keeps null dates; any `@codex` counts as a mention.
  assert.deepEqual(normalizeConversationItem('review', { id: 1, user: { login: 'x' }, submitted_at: at('10:00'), updated_at: at('11:00'), body: 'Hey @Codex, fix it' }),
    { kind: 'review', id: 1, authorLogin: 'x', createdAtMs: ms('10:00'), updatedAtMs: ms('10:00'), mentionsCodex: true });
  assert.deepEqual(normalizeConversationItem('issue_comment', { id: 2, user: { login: 'x' } }),
    { kind: 'issue_comment', id: 2, authorLogin: 'x', createdAtMs: null, updatedAtMs: null, mentionsCodex: null });
  assert.equal(normalizeConversationItem('review', { id: 3, body: null }).mentionsCodex, false);
  // A partial comment or review is unread, never a blank non-mention (Codex finding on #624). A null body is
  // no text; a review is dated by its submission only.
  for (const [kind, change] of [
    ['issue_comment', (item) => { delete item.body; }], ['issue_comment', (item) => { item.body = 7; }],
    ['issue_comment', (item) => { item.id = '62'; }], ['issue_comment', (item) => { item.user = {}; }],
    ['issue_comment', (item) => { delete item.created_at; }], ['issue_comment', (item) => { item.updated_at = 'x'; }],
    ['review_comment', (item) => { delete item.body; }], ['review', (item) => { delete item.submitted_at; }],
    ['review', (item) => { item.user.login = ''; }],
  ]) {
    const partial = await readWorld((w) => { change(w.conversation[kind].at(-1)); });
    assert.equal(partial.evidence.records.conversation, null, `${kind} ${change}`);
    assert.deepEqual(partial.evidence.problems, [`conversation ${kind} page 1: malformed item`], `${kind} ${change}`);
  }
  const nullBody = await readWorld((w) => { w.conversation.issue_comment[1].body = null; delete w.conversation.review[0].updated_at; });
  assert.equal(nullBody.evidence.records.conversation.items[2].mentionsCodex, false);
  // Read to its end across pages.
  const paged = await readWorld((w) => {
    w.conversation.review_comment = Array.from({ length: CONVERSATION_PAGE_SIZE + 1 }, (_, index) => conversationItem(1000 + index, CODEX_LOGIN, '11:25'));
  });
  assert.equal(paged.evidence.records.conversation.items.filter((item) => item.kind === 'review_comment').length, CONVERSATION_PAGE_SIZE + 1);
  assert.equal(paged.calls.filter((path) => path.includes('/pulls/619/comments?')).length, 2);
  // Bounded like the event log: a source that ends on its last allowed page is read; one still full there is
  // uncovered, fail closed (Claude shadow finding on #624).
  const atLimit = await readWorld((w) => {
    w.conversation.review = Array.from({ length: CONVERSATION_MAX_PAGES * CONVERSATION_PAGE_SIZE - 1 }, (_, index) => conversationItem(2000 + index, CODEX_LOGIN, '11:25'));
  });
  assert.equal(atLimit.evidence.records.conversation.items.filter((item) => item.kind === 'review').length, CONVERSATION_MAX_PAGES * CONVERSATION_PAGE_SIZE - 1);
  const overLimit = await readWorld((w) => {
    w.conversation.review = Array.from({ length: CONVERSATION_MAX_PAGES * CONVERSATION_PAGE_SIZE }, (_, index) => conversationItem(2000 + index, CODEX_LOGIN, '11:25'));
  });
  assert.equal(overLimit.evidence.records.conversation, null);
  assert.deepEqual(overLimit.evidence.problems, [`conversation review: ${CONVERSATION_MAX_PAGES} full pages without an end (uncovered)`]);
  assert.equal(overLimit.calls.filter((path) => path.includes('/pulls/619/reviews?')).length, CONVERSATION_MAX_PAGES);
  // A failed or malformed page leaves no conversation, with a diagnostic (never a partial list).
  const failed = await readWorld((w) => { w.conversationError = { review: 'boom' }; });
  assert.equal(failed.evidence.records.conversation, null);
  assert.deepEqual(failed.evidence.problems, ['conversation review page 1: boom']);
  const noIssue = await readWorld((w) => { w.conversationError = { pull_request: 'gone' }; });
  assert.equal(noIssue.evidence.records.conversation, null);
  assert.deepEqual(noIssue.evidence.problems, ['conversation pull_request: gone']);
  const listIssue = await readWorld((w) => { w.conversation.pull_request = []; });
  assert.equal(listIssue.evidence.records.conversation, null);
  assert.deepEqual(listIssue.evidence.problems, ['conversation pull_request: not a record']);
  // A partial or foreign record is unread, never a blank description (Codex finding on #624). A null body (a PR
  // without a description) is whole.
  for (const change of [
    (issue) => { for (const key of Object.keys(issue)) delete issue[key]; }, // {}
    (issue) => { issue.number = PR + 1; }, (issue) => { delete issue.pull_request; }, (issue) => { issue.id = null; },
    (issue) => { issue.user = null; }, (issue) => { issue.user.login = ''; }, (issue) => { issue.created_at = null; },
    (issue) => { delete issue.title; }, (issue) => { delete issue.body; }, (issue) => { issue.body = 42; },
  ]) {
    const partial = await readWorld((w) => { change(w.conversation.pull_request); });
    assert.equal(partial.evidence.records.conversation, null, String(change));
    assert.deepEqual(partial.evidence.problems, ['conversation pull_request: malformed record'], String(change));
  }
  const noBody = await readWorld((w) => { w.conversation.pull_request.body = null; });
  assert.equal(noBody.evidence.records.conversation.items[0].mentionsCodex, false);
  const malformed = await readWorld((w) => { w.conversation.issue_comment = { not: 'a list' }; });
  assert.equal(malformed.evidence.records.conversation, null);
  assert.deepEqual(malformed.evidence.problems, ['conversation issue_comment page 1: not a list']);
  // Without a request there is no cycle, so the conversation is not read at all.
  const noRequest = await readWorld((w) => { w.comment = null; });
  assert.equal(noRequest.evidence.records.conversation, null);
  assert.ok(!noRequest.calls.some((path) => /\/(comments|reviews)\?|\/issues\/619$/u.test(path)));
});
