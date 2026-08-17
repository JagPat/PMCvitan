// The five-head restructure rule, as an OBSERVATION.
//
// The defect: `RESTRUCTURE_AFTER_FINDING_HEADS` shipped in #259 imported by
// nothing but its own tests, so it never fired — PR #263 ran to six
// finding-bearing heads without it triggering once. These probes cover the two
// things that fixes: the rule is CALLED on both paths that reach a review, and
// what it computes is right.
//
// They also pin the thing this unit deliberately does NOT do. Blocking an
// over-limit unit until a human answers is a separate change with its own
// apparatus (declaration channel, reply window, durable record, timer, recovery)
// and its own review budget. `L6` fails if this unit ever starts blocking.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  observeReviewLifecycle,
  lifecycleAdvisory,
  RESTRUCTURE_AFTER_FINDING_HEADS,
} from './review-lifecycle.mjs';
import { findingHeadSeverity } from './review-efficiency.mjs';
import { reportReviewLifecycle } from './autonomous-review-gate.mjs';

const CODEX = 'chatgpt-codex-connector[bot]';
const GATE = new URL('./autonomous-review-gate.mjs', import.meta.url);

const badge = (n) => `![P${n} Badge](https://img.shields.io/badge/P${n}-orange?style=flat)`;
const heads = (n, body) => Array.from(
  { length: n },
  (_, i) => ({ user: { login: CODEX }, commit_id: `h${i}`, body }),
);

function fakeClient({ comments = [], reviews = [], throws = false } = {}) {
  const calls = { logs: [], reviewComments: 0 };
  return {
    calls,
    reviewComments: async () => {
      calls.reviewComments += 1;
      if (throws) throw new Error('transport');
      return comments;
    },
    reviews: async () => reviews,
    log: (line) => calls.logs.push(line),
  };
}

test('L1: the rule is CALLED — an over-limit critical unit is reported', async () => {
  // The whole defect in one probe. Before this wiring the threshold was computed
  // nowhere, so a unit at five P1 heads produced no signal at all.
  const client = fakeClient({ comments: heads(5, badge(1)) });
  const observed = await reportReviewLifecycle(client, { number: 1 }, client.log);

  assert.equal(observed.crossed, true);
  assert.equal(observed.tier, 'critical');
  assert.equal(observed.restructureAdvised, true);
  assert.equal(client.calls.logs.length, 1);
  assert.match(client.calls.logs[0], /5 finding-bearing heads \(limit 5\)/u);
  assert.match(client.calls.logs[0], /splitting it into a smaller review unit/u);
});

test('L2: the rule is called BEFORE another review is requested, not only at admission', async () => {
  // The first attempt at this change wired only `revalidateFinalReviewPolicy`, so
  // the ordinary path went from the convergence check straight into
  // `reviewAttempt()`: a unit already at five critical heads was promoted for
  // ANOTHER Codex review and the finding path drafted the head without the rule
  // ever running. That is the exact sixth finding-bearing head it exists to
  // notice.
  //
  // Asserting "the function exists" would not have caught that. This slices the
  // source between the promotion-path convergence call and `reviewNotBefore` and
  // requires the call inside that region, so a future path that promotes without
  // consulting the rule fails CI rather than shipping.
  const source = readFileSync(GATE, 'utf8');

  const promotion = source.slice(
    source.indexOf('const convergence = await enforceReviewConvergence('),
    source.indexOf('const reviewNotBefore ='),
  );
  assert.ok(promotion.length > 0, 'the promotion path must still be locatable');
  assert.match(
    promotion,
    /await reportReviewLifecycle\(/u,
    'the promotion path must consult the lifecycle rule before requesting a review',
  );

  const admission = source.slice(source.indexOf('export async function revalidateFinalReviewPolicy('));
  assert.match(
    admission.slice(0, 800),
    /await reportReviewLifecycle\(/u,
    'final admission must consult it too',
  );
});

test('L3: the threshold and the worst-wins tier are computed correctly', () => {
  assert.equal(RESTRUCTURE_AFTER_FINDING_HEADS, 5);

  const below = observeReviewLifecycle({ comments: heads(4, badge(1)), reviews: [] });
  assert.equal(below.crossed, false);
  assert.equal(below.restructureAdvised, false, 'under the limit is never advised');

  const atP2 = observeReviewLifecycle({ comments: heads(5, badge(2)), reviews: [] });
  assert.equal(atP2.crossed, true);
  assert.equal(atP2.tier, 'minor');
  assert.equal(atP2.restructureAdvised, false, 'five heads of provable P2 is converging');

  // Worst-wins across heads: one P1 among four P2s decides.
  const mixed = observeReviewLifecycle({
    comments: [...heads(4, badge(2)), { user: { login: CODEX }, commit_id: 'h4', body: badge(1) }],
    reviews: [],
  });
  assert.equal(mixed.tier, 'critical');
  assert.equal(mixed.restructureAdvised, true);

  assert.equal(lifecycleAdvisory(below), null, 'nothing to say stays silent');
  assert.equal(lifecycleAdvisory(atP2), null);
});

test('L4: unknown severity is never treated as minor', () => {
  // The fail-open this rule must not have: a badge-format change would otherwise
  // turn the signal quiet exactly when it had lost the ability to read severity.
  const unbadged = observeReviewLifecycle({ comments: heads(5, 'a finding, no badge'), reviews: [] });
  assert.equal(unbadged.tier, 'unknown');
  assert.equal(unbadged.restructureAdvised, true);
  assert.match(lifecycleAdvisory(unbadged), /of unread severity/u);

  // One badged comment must not vouch for an unbadged sibling on the SAME head.
  const sameHead = findingHeadSeverity([
    { user: { login: CODEX }, commit_id: 'h', body: badge(2) },
    { user: { login: CODEX }, commit_id: 'h', body: 'unbadged sibling' },
  ]);
  assert.equal(sameHead.get('h'), 'unknown');

  // And an unreadable finding outranks a readable P1 — it is not merely critical.
  const both = findingHeadSeverity([
    { user: { login: CODEX }, commit_id: 'h', body: badge(1) },
    { user: { login: CODEX }, commit_id: 'h', body: 'unbadged sibling' },
  ]);
  assert.equal(both.get('h'), 'unknown');

  // A head whose severity could not be read must be REPORTED as unread even when
  // a sibling head carries a readable P1. Both advise a split, so the ordering
  // shows up only in what the human is told — and "of unread severity" is the
  // actionable one: it says Codex's badge format may have changed and this signal
  // is now partly blind. Without this the ranking would be unobservable.
  const mixed = observeReviewLifecycle({
    comments: [...heads(4, badge(1)), { user: { login: CODEX }, commit_id: 'h4', body: 'unbadged' }],
    reviews: [],
  });
  assert.equal(mixed.tier, 'unknown', 'an unread head is not hidden behind a readable P1');
  assert.match(lifecycleAdvisory(mixed), /of unread severity/u);

  // A Codex REVIEW is a container — its body carries no badge because the
  // findings are inline comments. Counting it as unreadable would taint every
  // reviewed head.
  const container = findingHeadSeverity(
    [{ user: { login: CODEX }, commit_id: 'h', body: badge(2) }],
    [{ user: { login: CODEX }, commit_id: 'h', body: 'Here are some automated review suggestions.' }],
  );
  assert.equal(container.get('h'), 'minor');
});

test('L7: the advisory reaches a PR-VISIBLE channel, not only the Actions log', async () => {
  // The first head of this unit wrote the advisory to `console.log` and stopped.
  // The loop's actors — and humans — read PR comments and statuses; a workflow
  // log is neither, so the signal was real but unreachable, and the sticky went
  // on saying "Auto-fix handles the review comments" with no hint that the unit
  // had already spent its head budget.
  //
  // It rides the sticky beside `Next:` because `Next:` is exactly what it
  // qualifies.
  const client = fakeClient({ comments: heads(5, badge(1)) });
  const observed = await reportReviewLifecycle(client, { number: 1 }, client.log);

  assert.ok(observed.advisory, 'the advisory is RETURNED for the caller to publish');
  assert.match(observed.advisory, /5 finding-bearing heads/u);

  // And the sticky renderer puts it in the comment body.
  const source = readFileSync(GATE, 'utf8');
  const renderer = source.slice(
    source.indexOf('function statusBody({'),
    source.indexOf('export async function settleRecoveryRequest'),
  );
  assert.match(renderer, /advisory \? \[/u, 'statusBody renders it when present');
  assert.match(renderer, /Review lifecycle/u, 'under a label a reader can find');

  // The states that tell the loop to KEEP CORRECTING must carry it — those are
  // the ones the advisory contradicts. Scoped to actual sticky writes: a bare
  // `return { state: 'changes_required' }` is a verdict, not a comment.
  const stickyWrites = [...source.matchAll(/statusBody\(\{[\s\S]*?\n\s*\}\)/gu)]
    .map((m) => m[0]);
  assert.ok(stickyWrites.length >= 10, 'the sticky writers must still be locatable');

  const keepCorrecting = stickyWrites.filter(
    (w) => /state: '(review_pending|changes_required)'/u.test(w),
  );
  assert.ok(keepCorrecting.length >= 2, 'found the keep-correcting sticky writes');
  for (const write of keepCorrecting) {
    assert.match(
      write,
      /\badvisory\b/u,
      `a keep-correcting sticky must carry the lifecycle advisory:\n${write.slice(0, 120)}`,
    );
  }

  // Nothing to say stays silent — the ordinary case is unchanged.
  const quiet = fakeClient({ comments: heads(2, badge(2)) });
  const none = await reportReviewLifecycle(quiet, { number: 1 }, quiet.log);
  assert.equal(none.advisory, null);
  assert.deepEqual(quiet.calls.logs, []);
});

test('L8: the crossing CAUSED by the current review still reaches the sticky', async () => {
  // The case that matters most, and the one a snapshot misses. A unit sits at
  // four finding heads; the review that just ran returns the fifth. An advisory
  // computed BEFORE that review is null exactly then, so the `changes_required`
  // sticky would tell auto-fix to push another head at the one moment the split
  // advice is due — and nobody is standing by to notice it was omitted.
  //
  // So every sticky written AFTER findings land recomputes rather than carries.
  const source = readFileSync(GATE, 'utf8');

  const stickyWrites = [...source.matchAll(/statusBody\(\{[\s\S]*?\n\s*\}\)/gu)].map((m) => m[0]);
  const afterFindings = stickyWrites.filter((w) => /state: 'changes_required'/u.test(w));
  assert.ok(afterFindings.length >= 1, 'found the post-finding sticky writer');
  for (const write of afterFindings) {
    assert.match(
      write,
      /advisory: await freshAdvisory\(/u,
      `a post-finding sticky must RECOMPUTE the advisory, not carry a stale one:\n${write.slice(0, 140)}`,
    );
  }
  assert.equal(
    [...source.matchAll(/await publishCurrentHeadFinding\(/gu)].length,
    3,
    'every path that observes findings must use the reset-aware publisher',
  );

  // The pre-review sticky is the one case where the snapshot is correct — it is
  // written before the review that could cross the limit.
  const beforeReview = stickyWrites.filter((w) => /state: 'review_pending'/u.test(w));
  assert.equal(beforeReview.length, 1);
  assert.doesNotMatch(beforeReview[0], /freshAdvisory/u, 'no wasted second read pre-review');
  assert.match(beforeReview[0], /\badvisory,/u);

  // Behaviourally: four prior heads is silent, and the fifth speaks.
  const four = await reportReviewLifecycle(
    fakeClient({ comments: heads(4, badge(1)) }), { number: 1 }, () => {},
  );
  assert.equal(four.advisory, null, 'four heads says nothing');

  const fifth = await reportReviewLifecycle(
    fakeClient({ comments: heads(5, badge(1)) }), { number: 1 }, () => {},
  );
  assert.ok(fifth.advisory, 'the fifth head speaks — and it is read after the poll');
  assert.match(fifth.advisory, /5 finding-bearing heads/u);
});

test('L5: unreadable evidence reports NOTHING rather than something wrong', async () => {
  // This path reports and does not decide, so there is no verdict to fail closed
  // on. Silence is the honest outcome; a fabricated "all clear" would not be.
  const client = fakeClient({ throws: true });
  const observed = await reportReviewLifecycle(client, { number: 1 }, client.log);

  assert.equal(observed, null);
  assert.deepEqual(client.calls.logs, [], 'no advisory is invented from a failed read');
});

test('L6: the observation never blocks, and never throws', async () => {
  // The deliberate boundary of this unit. AGENTS.md: "do not block on human
  // sign-off — no one is standing by to give it." Blocking an over-limit unit
  // safely needs a declaration channel, a reply window, a durable record, a timer
  // and a recovery path; that is a separate unit with its own review budget.
  //
  // If this unit ever starts blocking, this fails.
  for (const comments of [heads(5, badge(0)), heads(9, badge(1)), heads(5, 'unbadged')]) {
    const client = fakeClient({ comments });
    const observed = await reportReviewLifecycle(client, { number: 1 }, client.log);
    assert.equal(observed.restructureAdvised, true, 'the worst cases still only advise');
    assert.ok(!('allowed' in observed), 'the observation has no verdict to enforce');
  }

  const source = readFileSync(GATE, 'utf8');
  const helper = source.slice(
    source.indexOf('export async function reportReviewLifecycle('),
    source.indexOf('function statusBody('),
  );
  assert.doesNotMatch(helper, /\bthrow\b/u, 'the observation must never throw');
  assert.doesNotMatch(helper, /setDraft|setStatus/u, 'it must not draft or fail a head');
});
