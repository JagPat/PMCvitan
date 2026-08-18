// The correction LEASE and its watchdog — the follow-up unit deferred out of the
// owner-routing PR (#358, merged as `f32343d`).
//
// Routing decided WHO owns a correction. Nothing asked them, and nothing noticed
// when nobody started. This unit does both, and every probe here asserts against
// the artefact the loop actually PUBLISHES — the comment posted by
// `handOffCorrectionLease` — rather than the return value of the function that
// composes it. That distinction is not stylistic: #356's mention and #352's
// `replacement_required` state were both unit-tested green while being
// unreachable in the shipped path, because the probes asked the composer instead
// of the publisher.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { handOffCorrectionLease } from './autonomous-handoff.mjs';
import {
  CORRECTION_LEASE_GRACE_MS,
  assessCorrectionLease,
  correctionLeaseMarker,
  correctionReasonFor,
  owedFailureId,
} from './correction-lease.mjs';
import { isCorrectionEligiblePullRequest } from './correction-owner.mjs';
import { REVIEW_RESET_AFTER_FINDING_HEADS } from './review-efficiency.mjs';

const REPOSITORY = 'JagPat/PMCvitan';
const HEAD = 'dc54a78e0f2b4c1d9a3e5f60718293a4b5c6d7e8';
const OBSERVED = '2026-08-17T10:00:00Z';
const DUE = '2026-08-17T11:30:00Z';
const EARLY = '2026-08-17T10:10:00Z';
const CODEX = 'chatgpt-codex-connector[bot]';
const BOT = 'github-actions[bot]';

function pullRequest(overrides = {}) {
  const { body = '<!-- correction-owner: claude -->', sha = HEAD, ref = 'claude/task' } = overrides;
  return {
    number: overrides.number ?? 358,
    state: overrides.state ?? 'open',
    body,
    head: { sha, ref, repo: { full_name: overrides.headRepo ?? REPOSITORY } },
    base: { ref: overrides.baseRef ?? 'main', repo: { full_name: REPOSITORY } },
    html_url: `https://github.com/${REPOSITORY}/pull/358`,
  };
}

function status(description, state = 'failure') {
  return {
    context: 'codex-current-head',
    state,
    description,
    updated_at: OBSERVED,
  };
}

// Every method the watchdog is ALLOWED to use is implemented. Anything else —
// setStatus, draft changes, merges, sticky edits — is trapped and recorded, so a
// probe can prove the watchdog touched no gate state instead of asserting it in
// prose.
function fakeClient({
  pull,
  live,
  statuses,
  comments = [],
  reviews = [],
  reviewComments = [],
}) {
  const calls = { posted: [], forbidden: [], reads: [] };
  const allowed = {
    combinedStatus: async () => ({ statuses }),
    comments: async () => comments,
    reviews: async () => reviews,
    reviewComments: async () => reviewComments,
    pullRequest: async () => live ?? pull,
    comment: async (number, body) => { calls.posted.push({ number, body }); return { id: 1 }; },
  };
  const client = new Proxy(allowed, {
    get(target, property) {
      if (property in target) {
        calls.reads.push(property);
        return target[property];
      }
      return (...args) => {
        calls.forbidden.push({ method: String(property), args });
        throw new Error(`the watchdog must not call ${String(property)}`);
      };
    },
  });
  return { client, calls };
}

// One watchdog pass over one pull request, returning what it PUBLISHED.
async function watch({ now = DUE, ...options }) {
  const pull = options.pull ?? pullRequest();
  const { client, calls } = fakeClient({ ...options, pull });
  const assessment = await handOffCorrectionLease(client, pull, REPOSITORY, 'main', { now });
  return { assessment, calls, published: calls.posted[0]?.body ?? null };
}

function codexFinding(head) {
  return { user: { login: CODEX }, commit_id: head, body: '**P1** something is wrong' };
}

// ─────────────────────────────────────────────────────────────────────────────
// L1 — the reproduction (requirement 7). Before this unit the hourly handoff job
// drained conflicts, merge continuation and status drift, and reported green
// while a failing head sat untouched. PR #349 and PR #350 both sat that way for
// about an hour on 2026-08-17 and the repository owner had to post the kick by
// hand, twice.

test('L1: an unmoved failing head produces exactly one published notice, ever', async () => {
  const options = {
    statuses: [status('review: 1 current-head Codex finding')],
    reviewComments: [codexFinding(HEAD)],
  };

  const early = await watch({ ...options, now: EARLY });
  assert.equal(early.published, null, 'a bounded interval passes before anything is published');
  assert.equal(early.assessment.state, 'waiting');

  const due = await watch(options);
  assert.equal(due.calls.posted.length, 1, 'exactly one comment is posted');
  assert.match(due.published, new RegExp(HEAD, 'u'), 'it names the exact head');
  assert.match(due.published, /1 current-head Codex finding/u, 'and what is failing');
  assert.match(due.published, /correction_recovery/u);

  // The published comment carries its own idempotency key, and a second pass
  // that can see it publishes nothing — a repeated cron tick, a replaced Actions
  // run, or a second event for the same head all land here.
  const marker = correctionLeaseMarker({
    number: 358,
    head: HEAD,
    owner: 'claude',
    kind: `correction:${owedFailureId('review', '1 current-head Codex finding')}`,
  });
  assert.ok(due.published.includes(marker), 'the notice carries its own lease key');
  assert.equal(due.assessment.marker, marker, 'keyed to the PR, head, owner and owed failure');

  const again = await watch({
    ...options,
    now: '2026-08-17T14:00:00Z',
    comments: [{ user: { login: BOT }, body: due.published }],
  });
  assert.equal(again.published, null, 'the same lease is never published twice');
  assert.equal(again.assessment.state, 'notified');

  // AN ACKNOWLEDGEMENT IS NOT PROGRESS. Both PRs above were acknowledged as a
  // subscription and produced no correction; a check that treated that as
  // healthy would have reported exactly the green this unit removes.
  const acknowledged = await watch({
    ...options,
    now: '2026-08-17T15:00:00Z',
    comments: [{
      user: { login: BOT },
      body: due.published,
      reactions: { total_count: 2, eyes: 1, '+1': 1 },
    }],
  });
  assert.equal(acknowledged.assessment.state, 'notified', 'still an open lease');
  assert.equal(acknowledged.published, null);

  assert.ok(CORRECTION_LEASE_GRACE_MS >= 15 * 60_000, 'the interval is bounded, not instant');
});

// ─────────────────────────────────────────────────────────────────────────────
// L2 — #352 round 2. The watchdog selected owed corrections by matching the
// PROSE of the status description against the two Codex-finding sentences. The
// review-round-limit failure says something else entirely, so the ONE state
// whose remedy is a replacement rather than another head never reached the lease
// — `replacement_required` was documented, unit-tested, and unreachable.

test('L2: the round-limit failure reaches the lease and asks for a replacement', async () => {
  const { published, assessment } = await watch({
    statuses: [status(
      'review: 2 finding-bearing heads reached the review-round limit; '
      + 'this unit requires a replacement PR',
    )],
    reviewComments: [codexFinding('first'), codexFinding(HEAD)],
  });

  assert.ok(published, 'the round-limit failure is an owed correction');
  assert.equal(assessment.reportedState, 'replacement_required');
  assert.match(published, /replacement_required/u);
  assert.match(published, /replacement/iu, 'the published notice asks for a replacement');
  assert.doesNotMatch(
    published,
    /push (a|one) new head/iu,
    'and never for a third correction head',
  );
  assert.equal(REVIEW_RESET_AFTER_FINDING_HEADS, 2);
});

test('L2b: the owed reason comes from the status PREFIX, not its wording', async () => {
  // Prefixes are the review gate's own vocabulary. Selecting on the sentence
  // after them is what made a whole state unreachable, so the classification is
  // pinned here directly.
  assert.equal(correctionReasonFor(status('review: 3 current-head Codex findings')), 'review');
  assert.equal(correctionReasonFor(status('scope: the PR body declares no correction owner')), 'scope');
  assert.equal(correctionReasonFor(status('ci: required checks failed')), 'ci');
  assert.equal(
    correctionReasonFor(status('review: 2 finding-bearing heads reached the review-round limit')),
    'review',
    'the round limit is owed like any other review failure',
  );

  // `recovery:` is the gate asking ITSELF to retry. Nobody owes a correction, so
  // no lease is opened.
  assert.equal(correctionReasonFor(status('recovery: request superseded by newer review state')), null);
  const recovering = await watch({
    statuses: [status('recovery: request superseded by newer review state')],
  });
  assert.equal(recovering.published, null, 'a self-healing state publishes nothing');
  assert.equal(recovering.assessment, null);

  // A success is not a correction, and neither is another context's failure.
  assert.equal(correctionReasonFor(status('review: no blocking issue', 'success')), null);
  assert.equal(correctionReasonFor({ context: 'ci/other', state: 'failure', description: 'x' }), null);

  // An unrecognized prefix is a FUTURE one of ours — only this repository's gate
  // writes this context. Silence is the failure being removed, so it is treated
  // as owed rather than dropped.
  assert.equal(correctionReasonFor(status('novel: something new')), 'review');
});

test('L2c: a scope or CI failure is asked for in its own words', async () => {
  const scope = await watch({
    statuses: [status('scope: the PR body declares no correction owner')],
  });
  assert.match(scope.published, /scope gate|invariant|split the review unit/iu);
  assert.match(
    scope.published,
    /the PR body declares no correction owner/u,
    'the published notice quotes the failing status, with its prefix stripped',
  );

  const ci = await watch({ statuses: [status('ci: required checks failed')] });
  assert.match(ci.published, /required checks/iu);
});

// ─────────────────────────────────────────────────────────────────────────────
// L3 — #352 F1. The open-PR snapshot is taken once at the top of the handoff
// loop; a correction landing while the loop works through conflicts and status
// reads leaves it stale. A lease keyed to the stale head then matches itself and
// publishes a stalled notice for a head that has already been superseded.

test('L4: the wake-up is a NEW comment, and mentions only an owner GitHub can wake', async () => {
  const claude = await watch({
    statuses: [status('review: 1 current-head Codex finding')],
    reviewComments: [codexFinding(HEAD)],
  });
  assert.match(claude.published, /@claude/u, 'a Claude-owned correction is actually asked');
  assert.equal(claude.calls.posted.length, 1, 'through a POSTed comment, which notifies');
  assert.deepEqual(claude.calls.forbidden, [], 'and no sticky edit, which would not');

  const cursor = await watch({
    pull: pullRequest({ body: '<!-- correction-owner: cursor -->', ref: 'codex/task' }),
    statuses: [status('review: 1 current-head Codex finding')],
    reviewComments: [codexFinding(HEAD)],
  });
  assert.doesNotMatch(cursor.published, /@claude/u, 'Claude is never tagged on another owner');
  assert.doesNotMatch(cursor.published, /claude/iu, 'nor claimed anywhere in the notice');
  assert.doesNotMatch(cursor.published, /@cursor/u, 'and no handle is invented for an agent GitHub cannot wake');
});

// ─────────────────────────────────────────────────────────────────────────────
// L5 — requirement 8. When the declared owner cannot be started from GitHub, the
// notice reports `correction_stalled` with everything a human needs to resume,
// and never says progress is continuing.

test('L5: an owner GitHub cannot start is published as correction_stalled with a resume action', async () => {
  const { published } = await watch({
    pull: pullRequest({ body: '<!-- correction-owner: cursor -->', ref: 'codex/task' }),
    statuses: [status('review: 3 current-head Codex findings')],
    reviewComments: [codexFinding(HEAD)],
  });

  assert.match(published, /correction_stalled/u, 'the exact machine-readable state');
  assert.match(published, /`cursor`/u, 'the exact owner');
  assert.match(published, new RegExp(HEAD, 'u'), 'the exact head');
  assert.match(published, /3 current-head Codex findings/u, 'the findings');
  assert.match(published, /Required resume action/u, 'and the required resume action');
  assert.match(published, /codex\/task/u, 'naming the branch the session must run on');
  assert.doesNotMatch(
    published,
    /(in progress|is working|continuing|under way)/iu,
    'it never claims work that is not happening',
  );

  // An undeclared owner resolves to no agent and names the marker instead.
  const undeclared = await watch({
    pull: pullRequest({ body: '## Objective', ref: 'codex/task' }),
    statuses: [status('review: 1 current-head Codex finding')],
  });
  assert.match(undeclared.published, /correction_stalled/u);
  assert.match(undeclared.published, /undeclared/u);
  assert.match(undeclared.published, /correction-owner/u, 'the marker that fixes it');
  assert.doesNotMatch(undeclared.published, /@claude/u, 'and nobody is woken by default');
});

// ─────────────────────────────────────────────────────────────────────────────
// L6 — the boundaries. The watchdog is a comment publisher and nothing else.

test('L6: the watchdog changes no gate state and watches only trusted heads', async () => {
  const { calls } = await watch({
    statuses: [status('review: 1 current-head Codex finding')],
    reviewComments: [codexFinding(HEAD)],
  });
  assert.deepEqual(
    calls.forbidden,
    [],
    'no status, draft, merge, label or Codex call is made — the exact-head gate is untouched',
  );

  const source = readFileSync(new URL('./correction-lease.mjs', import.meta.url), 'utf8');
  for (const forbidden of ['setStatus', 'markReadyForReview', 'mergePullRequest', 'enableAutoMerge']) {
    assert.doesNotMatch(source, new RegExp(forbidden, 'u'), `the lease never references ${forbidden}`);
  }

  // Eligibility is the existing trust boundary, minus the `claude/**` condition:
  // the whole point of the declaration is that ownership is NOT inferable from
  // the branch, and PR #350 — the Cursor-owned unit that started this work — was
  // on `codex/**`.
  assert.equal(
    isCorrectionEligiblePullRequest(pullRequest({ ref: 'codex/task' }), REPOSITORY, 'main'),
    true,
    'a non-Claude branch in this repository is watched',
  );
  assert.equal(
    isCorrectionEligiblePullRequest(pullRequest({ headRepo: 'fork/repo' }), REPOSITORY, 'main'),
    false,
    'a fork head is never watched',
  );
  assert.equal(
    isCorrectionEligiblePullRequest(pullRequest({ baseRef: 'release' }), REPOSITORY, 'main'),
    false,
    'and neither is a PR against another base',
  );

  const fork = await watch({
    pull: pullRequest({ headRepo: 'fork/repo' }),
    statuses: [status('review: 1 current-head Codex finding')],
  });
  assert.equal(fork.published, null);
  assert.equal(fork.assessment, null);
});

test('L7: the handoff run loop drives the watchdog and cannot report green without it', () => {
  const source = readFileSync(new URL('./autonomous-handoff.mjs', import.meta.url), 'utf8');
  const runLoop = source.slice(source.indexOf('export async function run()'));
  assert.match(runLoop, /handOffCorrectionLease\(/u, 'the scheduled job drives the watchdog');
  assert.match(
    runLoop,
    /throw new Error\(\s*`The correction watchdog could not assess/u,
    'and a watchdog that could not run fails the job instead of reporting green',
  );
});

test('L8: the notice is cleared by movement, never by acknowledgement', async () => {
  // Stated in the published artefact, because a human reading it decides what to
  // do next. A scope refusal is routinely cleared by editing the PR body with no
  // new head at all, so "a new head" is not the only satisfaction and the notice
  // must not say it is.
  const { published } = await watch({
    statuses: [status('review: 1 current-head Codex finding')],
    reviewComments: [codexFinding(HEAD)],
  });
  assert.match(published, /cleared by a new head, or by this required status ceasing to fail/u);
  assert.match(published, /never by an acknowledgement, a reaction or a reply/u);
  assert.match(published, /published at most once/u);

  // And the composer agrees with the publisher: no exact head, no lease.
  const headless = assessCorrectionLease({ pullRequest: pullRequest(), head: null });
  assert.equal(headless.state, 'superseded');
  assert.equal(headless.body, null);
});

// ─────────────────────────────────────────────────────────────────────────────
// L9-L11 — Codex findings on `dad8949`, #359's first finding-bearing head.
// Three ways the notice was accurate about WHO and wrong about WHAT.

test('L10: a scope notice carries the verdict that is actually failing', async () => {
  // The `scope` reason alone always produced "split the review unit, or complete
  // every justified-large invariant row" — the remedy for exactly one of the
  // verdicts this gate publishes. This PR was itself refused for replacement
  // lineage and told to split, which would not have cleared it.
  const lineage = await watch({
    statuses: [status('scope: exhausted PR #361 still requires a replacement; declare Replaces: #361 before starting fresh work')],
  });
  assert.match(
    lineage.published,
    /exhausted PR #361 still requires a replacement/u,
    'the specific verdict is carried',
  );
  assert.doesNotMatch(
    lineage.published,
    /split the review unit|justified-large/iu,
    'and the size remedy — which cannot clear a lineage verdict — is not asserted',
  );
  assert.match(lineage.published, /body edit|editing the PR body/iu, 'with the action that clears it');

  const owner = await watch({
    statuses: [status('scope: the PR body declares no correction owner')],
  });
  assert.match(owner.published, /declares no correction owner/u);
  assert.doesNotMatch(owner.published, /split the review unit|justified-large/iu);

  // The size remedy still appears where it is the verdict.
  const size = await watch({
    statuses: [status('scope: Large review unit requires a justified-large marker and complete invariant matrix')],
  });
  assert.match(size.published, /justified-large/iu);
  assert.match(size.published, /split the review unit/iu);
});

test('L15: only a notice a fresh read still produces is published', async () => {
  const base = (overrides) => {
    const pull = pullRequest();
    const calls = { posted: [], statusReads: 0, prReads: 0 };
    const client = {
      combinedStatus: async () => {
        calls.statusReads += 1;
        return {
          statuses: [calls.statusReads === 1 ? overrides.first : (overrides.second ?? overrides.first)],
        };
      },
      comments: async () => [],
      reviews: async () => [],
      reviewComments: async () => [codexFinding(HEAD)],
      pullRequest: async () => {
        calls.prReads += 1;
        return calls.prReads === 1 ? pull : (overrides.livePull ?? pull);
      },
      comment: async (number, body) => { calls.posted.push({ number, body }); },
    };
    return { client, calls, pull };
  };

  // The failing status changed KIND while the watchdog was reading. Publishing
  // the composed scope notice would put a stale verdict under a lease key the
  // correct CI notice then cannot claim.
  const changed = base({
    first: status('scope: the PR body declares no correction owner'),
    second: status('ci: required checks failed'),
  });
  const a = await handOffCorrectionLease(changed.client, changed.pull, REPOSITORY, 'main', { now: DUE });
  assert.equal(changed.calls.posted.length, 0, 'a notice for a superseded verdict is never published');
  assert.equal(a?.state, 'superseded');

  // The DECLARED OWNER changed while the watchdog was reading. The composed
  // notice tags Claude; the PR now says Cursor.
  const reowned = base({
    first: status('review: 1 current-head Codex finding'),
    livePull: pullRequest({ body: '<!-- correction-owner: cursor -->', ref: 'codex/task' }),
  });
  const b = await handOffCorrectionLease(reowned.client, reowned.pull, REPOSITORY, 'main', { now: DUE });
  assert.equal(reowned.calls.posted.length, 0, 'the wrong correction agent is never woken');
  assert.equal(b?.state, 'superseded');

  // The failing status CLEARED while the watchdog was reading — a scope refusal
  // fixed by a body edit, which moves no head, so the head check cannot see it.
  const cleared = base({
    first: status('scope: the PR body declares no correction owner'),
    second: status('scope: cleared', 'success'),
  });
  const d = await handOffCorrectionLease(cleared.client, cleared.pull, REPOSITORY, 'main', { now: DUE });
  assert.equal(cleared.calls.posted.length, 0, 'a resolved failure is never announced');
  assert.equal(d?.state, 'superseded');
  assert.ok(cleared.calls.statusReads >= 2, 'the status is re-read before publishing');

  // The correction LANDED while the watchdog was reading. GitHub keeps the old
  // commit's failing status, so the status check alone would let this through.
  const moved = base({
    first: status('review: 1 current-head Codex finding'),
    livePull: pullRequest({ sha: 'cccc3330000000000000000000000000000000000' }),
  });
  const e = await handOffCorrectionLease(moved.client, moved.pull, REPOSITORY, 'main', { now: DUE });
  assert.equal(moved.calls.posted.length, 0, 'the correction already landed');
  assert.equal(e?.state, 'superseded');
  assert.ok(moved.calls.prReads >= 2, 'the pull request is re-read before publishing');

  // Nothing changed: the notice is published exactly once.
  const steady = base({ first: status('review: 1 current-head Codex finding') });
  const c = await handOffCorrectionLease(steady.client, steady.pull, REPOSITORY, 'main', { now: DUE });
  assert.equal(steady.calls.posted.length, 1);
  assert.equal(c?.state, 'notify');
  assert.match(steady.calls.posted[0].body, /@claude/u);
});

test('L19: each distinct owed failure gets its own lease on the same head', async () => {
  // A scope failure cleared by a body edit does not move the head, so the next
  // gate run can publish a DIFFERENT failure on that same SHA. Both notices took
  // the same `kind=correction` key, so the earlier comment silenced the new one
  // and the loop stalled with a verdict nobody could act on.
  const scope = await watch({
    statuses: [status('scope: the PR body declares no correction owner')],
  });
  assert.ok(scope.published);

  const ci = await watch({
    statuses: [status('ci: Failed checks: web')],
    comments: [{ user: { login: BOT }, body: scope.published }],
    now: '2026-08-17T13:00:00Z',
  });
  assert.equal(ci.assessment.state, 'notify', 'the newly owed failure opens its own lease');
  assert.notEqual(ci.assessment.marker, scope.assessment.marker);
  assert.match(ci.published, /Failed checks: web/u);

  // The SAME failure is still published exactly once.
  const repeat = await watch({
    statuses: [status('ci: Failed checks: web')],
    comments: [{ user: { login: BOT }, body: ci.published }],
    now: '2026-08-17T14:00:00Z',
  });
  assert.equal(repeat.assessment.state, 'notified');
  assert.equal(repeat.published, null);
});

test('L20: a review-scope CI failure is asked for as a scope verdict', async () => {
  // The gate summarises a failed PR-side `review-scope` check as
  // `ci: Failed checks: review-scope`, and the coarse prefix then told the owner
  // to fix CI and push a new head — invalidating the head for a verdict a body
  // edit clears.
  const { published } = await watch({
    statuses: [status('ci: Failed checks: review-scope')],
  });
  assert.match(published, /scope gate|Editing the PR body/iu, 'routed as a scope verdict');
  assert.doesNotMatch(
    published,
    /fix the failed required checks and push one new head/iu,
    'not as a CI failure',
  );

  // A genuine CI failure is untouched.
  const ci = await watch({ statuses: [status('ci: Failed checks: api, web')] });
  assert.match(ci.published, /fix the failed required checks/iu);
});

test('L25: a pull request closed while the watchdog was reading is never notified', async () => {
  // `openPullRequests()` is a snapshot. A PR closed between it and the refresh
  // keeps the same head and body, so nothing else in the assessment notices —
  // and the watchdog would wake an owner on a closed PR.
  const snapshot = pullRequest();
  const calls = { posted: [] };
  const client = {
    combinedStatus: async () => ({ statuses: [status('review: 1 current-head Codex finding')] }),
    comments: async () => [],
    reviews: async () => [],
    reviewComments: async () => [codexFinding(HEAD)],
    pullRequest: async () => pullRequest({ state: 'closed' }),
    comment: async (number, body) => { calls.posted.push({ number, body }); },
  };

  const assessment = await handOffCorrectionLease(client, snapshot, REPOSITORY, 'main', { now: DUE });
  assert.equal(calls.posted.length, 0, 'a closed pull request is never notified');
  assert.equal(assessment?.state, 'superseded');
});

// ─────────────────────────────────────────────────────────────────────────────
// L16 — the boundary this unit deliberately does not cross.

test('L16: a failure the gate recovers from opens no lease at all', async () => {
  const { isRetryableReviewFailureDescription } = await import('./review-efficiency.mjs');
  const gate = await import('./autonomous-review-gate.mjs');

  // The gate publishes these when it did not reach a verdict, and recovers them
  // by re-dispatching itself. No agent owes anything, so the watchdog stays out
  // — exactly as it does for the `recovery:` prefix.
  //
  // Reporting them, and performing that dispatch, are SPLIT OUT to a follow-up
  // unit. Three review rounds established that reporting them well means
  // rendering a runnable `workflow_dispatch` with the exact head, the terminal
  // status id, that failure's own precondition and the owner-marker repair that
  // must precede it — a runbook printed by a reporter, when the better shape is
  // the watchdog performing the dispatch. That is a capability change and is
  // reviewed as one.
  for (const description of [
    'review: Codex review timed out after two attempts',
    'review: Codex evidence changed during final verification',
    'review: Required CI changed during current-head Codex review',
    'review: bootstrap exact-head review requested',
  ]) {
    assert.equal(isRetryableReviewFailureDescription(description), true, description);
    assert.equal(correctionReasonFor(status(description)), null, description);
    assert.equal(
      gate.isRetryableTerminalReviewFailure({
        context: 'codex-current-head', state: 'failure', description,
      }),
      true,
      'the gate and the watchdog read ONE definition, so a fifth cannot diverge',
    );

    const { published, assessment } = await watch({ statuses: [status(description)] });
    assert.equal(published, null, `${description}: nothing is published`);
    assert.equal(assessment, null, `${description}: no lease is opened`);
  }

  // A real finding on the same prefix is untouched.
  assert.equal(correctionReasonFor(status('review: 3 current-head Codex findings')), 'review');
  const finding = await watch({
    statuses: [status('review: 3 current-head Codex findings')],
    reviewComments: [codexFinding(HEAD)],
  });
  assert.match(finding.published, /@claude/u);
});
