// The five-head limit, at its CALL SITE.
//
// `review-lifecycle.mjs` shipped in #259 with 20 passing tests and was imported
// by nothing but those tests. PR #263 then ran to six finding-bearing heads
// without the rule ever firing. The policy was never wrong — it was never asked.
//
// So these probes exercise `enforceReviewLifecycle` against a fake client rather
// than the pure function: what governs the loop is the wiring, and the wiring is
// what had no coverage.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { enforceReviewLifecycle } from './autonomous-review-gate.mjs';
import {
  CRITICAL_WINDOW_MINUTES,
  VERY_CRITICAL_WINDOW_MINUTES,
} from './review-lifecycle.mjs';

const CODEX = 'chatgpt-codex-connector[bot]';
const P1 = '![P1 Badge](https://img.shields.io/badge/P1-orange?style=flat) finding';
const P2 = '![P2 Badge](https://img.shields.io/badge/P2-yellow?style=flat) finding';

const heads = (n, body) => Array.from({ length: n }, (_, i) => ({
  user: { login: CODEX }, commit_id: `head${i}`, body,
}));

function fakeClient({ comments = [], sticky = null, stickyThrows = false } = {}) {
  const calls = { status: [], sticky: [], draft: 0 };
  return {
    calls,
    reviewComments: async () => comments,
    reviews: async () => [],
    pullRequestFiles: async () => [{ filename: 'apps/api/src/x.ts' }],
    stickyComment: async () => {
      if (stickyThrows) throw new Error('transport');
      return sticky;
    },
    // setDraftForCurrentHead re-reads the PR, calls setDraft, and requires the
    // RESULT to still be open on the expected head — otherwise it reports the
    // head superseded and returns before writing any status.
    pullRequest: async () => ({ number: 1, state: 'open', head: { sha: 'h' }, draft: true }),
    setDraft: async () => {
      calls.draft += 1;
      return { number: 1, state: 'open', head: { sha: 'h' }, draft: true };
    },
    setStatus: async (...args) => { calls.status.push(args); },
    updateStickyComment: async (n, body) => { calls.sticky.push(body); },
  };
}

const pr = { number: 1, body: '', html_url: 'https://example/pr/1' };

test('W1: the rule is actually CALLED by the final policy chain', async () => {
  // The defect this whole unit exists to fix: a policy nothing consults. If the
  // enforcer is ever dropped from the chain again, this fails.
  const source = await readFile(
    new URL('./autonomous-review-gate.mjs', import.meta.url), 'utf8',
  );
  const chain = source.slice(source.indexOf('export async function revalidateFinalReviewPolicy'));
  assert.match(
    chain.slice(0, 1400), /enforceReviewLifecycle\(/u,
    'revalidateFinalReviewPolicy must call the lifecycle enforcer',
  );
});

test('W2: a unit below the limit is untouched', async () => {
  const client = fakeClient({ comments: heads(3, P1) });
  const result = await enforceReviewLifecycle(client, pr, 'h');
  assert.equal(result.allowed, true);
  assert.equal(client.calls.status.length, 0, 'no status written below the limit');
});

test('W3: at the limit with a P1 and no answer, a human is ASKED and the unit blocks', async () => {
  const client = fakeClient({ comments: heads(5, P1) });
  const result = await enforceReviewLifecycle(client, pr, 'h');
  assert.equal(result.allowed, false);
  assert.equal(result.state, 'restructure_declaration_required');
  assert.match(client.calls.status[0][2], /lifecycle:/u);

  const posted = client.calls.sticky[0];
  assert.match(posted, /review-restructure: continue/u, 'the comment must say how to answer');
  assert.match(posted, new RegExp(String(CRITICAL_WINDOW_MINUTES), 'u'),
    'the P1 request must quote the 3-hour critical window');
  assert.match(posted, /declarationRequestedAt/u, 'the window start must be recorded');
});

test('W4: at the limit with only P2 findings, the loop CONTINUES without asking', async () => {
  // The owner's rule: interrupt a human only when it is critical. Five heads of
  // polish is a unit converging slowly.
  const client = fakeClient({ comments: heads(5, P2) });
  const result = await enforceReviewLifecycle(client, pr, 'h');
  assert.equal(result.allowed, true);
  assert.equal(result.thresholdCrossed, true, 'crossing is still recorded');
  assert.equal(client.calls.status.length, 0, 'nobody is interrupted');
});

test('W5: unanswered past the window, the loop PROCEEDS and records that it did', async () => {
  const long_ago = new Date(Date.now() - (VERY_CRITICAL_WINDOW_MINUTES + 60) * 60_000)
    .toISOString();
  const client = fakeClient({
    comments: heads(5, P1),
    sticky: `<!-- autonomous-review-metrics: ${JSON.stringify({ declarationRequestedAt: long_ago })} -->`,
  });
  const result = await enforceReviewLifecycle(client, pr, 'h');
  assert.equal(result.allowed, true, 'a silent human must not stall the loop forever');
  assert.equal(result.autonomous, true, 'and the record must show it proceeded unanswered');
});

test('W6: a declared decision is obeyed, both ways', async () => {
  const cont = await enforceReviewLifecycle(
    fakeClient({ comments: heads(5, P1) }),
    { ...pr, body: '<!-- review-restructure: continue -->' }, 'h',
  );
  assert.equal(cont.allowed, true);
  assert.equal(cont.declared, 'continue');

  const split = await enforceReviewLifecycle(
    fakeClient({ comments: heads(5, P1) }),
    { ...pr, body: '<!-- review-restructure: restructure -->' }, 'h',
  );
  assert.equal(split.allowed, false);
  assert.equal(split.state, 'restructure_required');
});

test('W7: UNKNOWN severity fails closed — it asks, it does not wave through', async () => {
  // A badge format change, or a finding written without one, must not silently
  // turn the gate permissive. Unknown means ask.
  const client = fakeClient({ comments: heads(5, 'a finding with no severity badge') });
  const result = await enforceReviewLifecycle(client, pr, 'h');
  assert.equal(result.allowed, false, 'unreadable severity must block, not pass');
});

test('W8: the client can actually READ the sticky comment', async () => {
  // Caught during implementation: the client had `updateStickyComment` but no
  // reader, so `client.stickyComment()` threw, the catch set floorUnreadable,
  // and EVERY pull request would have been permanently blocked by the component
  // that merges pull requests. A missing method must fail this, not production.
  const source = await readFile(
    new URL('./autonomous-review-gate.mjs', import.meta.url), 'utf8',
  );
  assert.match(source, /async stickyComment\(number\)/u, 'the client needs a sticky reader');

  // Absence of a comment is a legitimate state and must NOT block.
  const fresh = await enforceReviewLifecycle(fakeClient({ comments: [] }), pr, 'h');
  assert.equal(fresh.allowed, true);

  // A FAILED read is different from an absent one, and blocks.
  const broken = await enforceReviewLifecycle(
    fakeClient({ comments: heads(5, P1), stickyThrows: true }), pr, 'h',
  );
  assert.equal(broken.allowed, false, 'an unreadable floor blocks rather than guesses');
});

test('W9: the window is TIERED by severity — 6h very critical, 3h critical', async () => {
  // The owner's rule. More serious means a longer chance to reach a human before
  // the loop proceeds alone, so P0 waits longer than P1 — and UNKNOWN severity
  // takes the longest window, the same fail-closed instinct that makes it block.
  const badge = (n) => `![P${n} Badge](https://img.shields.io/badge/P${n}-x?style=flat)`;
  const at = async (body) => enforceReviewLifecycle(
    fakeClient({ comments: heads(5, body) }), pr, 'h',
  );

  const p0 = await at(badge(0));
  assert.equal(p0.tier, 'very-critical');
  assert.equal(p0.windowMinutes, VERY_CRITICAL_WINDOW_MINUTES);
  assert.equal(VERY_CRITICAL_WINDOW_MINUTES, 6 * 60);

  const p1 = await at(badge(1));
  assert.equal(p1.tier, 'critical');
  assert.equal(p1.windowMinutes, CRITICAL_WINDOW_MINUTES);
  assert.equal(CRITICAL_WINDOW_MINUTES, 3 * 60);

  const unknown = await at('a finding with no badge');
  assert.equal(unknown.tier, 'very-critical', 'unknown waits the LONGEST, not the least');

  // A provably minor unit reports no tier at all — nothing is being waited for,
  // and a "critical" in the durable record would be a lie.
  const minor = await at(badge(2));
  assert.equal(minor.allowed, true);
  assert.equal(minor.tier, null);
  assert.equal(minor.windowMinutes, null);
});
