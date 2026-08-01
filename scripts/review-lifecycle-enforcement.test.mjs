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

test('W10: the gate runs BEFORE Codex promotion, not only at final admission', async () => {
  // F3. With the check only in revalidateFinalReviewPolicy, a unit already at
  // five critical heads was promoted for ANOTHER review, and a finding from it
  // drafted the head without the lifecycle gate ever running — producing the
  // sixth finding-bearing head this wiring exists to prevent.
  const source = await readFile(
    new URL('./autonomous-review-gate.mjs', import.meta.url), 'utf8',
  );
  const promotion = source.slice(
    source.lastIndexOf('const convergence = await enforceReviewConvergence('),
    source.lastIndexOf('const reviewNotBefore'),
  );
  assert.match(
    promotion, /enforceReviewLifecycle\(/u,
    'the promotion path must consult the lifecycle gate before requesting a review',
  );
});

test('W11: a legacy count-only floor fails CLOSED', async () => {
  // F5. An old record carries a count but no identities, and severity is keyed
  // by identity. If the live read no longer returns those comments, the unit
  // would read as minor and be forgiven despite having crossed the limit.
  const client = fakeClient({
    comments: [],
    sticky: `<!-- autonomous-review-metrics: ${JSON.stringify({ findingHeads: 5 })} -->`,
  });
  const result = await enforceReviewLifecycle(client, pr, 'h');
  assert.equal(result.allowed, false, 'an unclassifiable crossed unit must not be forgiven');
  assert.equal(result.tier, 'very-critical', 'unclassifiable means unknown, the longest window');
});

test('W12: an unreadable finding taints its whole head', async () => {
  // F2. One badged comment must not vouch for an unbadged sibling on the same
  // head — that returned "minor" for a head carrying unknown severity.
  const { findingHeadSeverity } = await import('./review-efficiency.mjs');
  const at = (head, body) => ({ user: { login: CODEX }, commit_id: head, body });
  const badge = (n) => `![P${n} Badge](https://img.shields.io/badge/P${n}-x?style=flat)`;

  const severity = findingHeadSeverity([
    at('mixed', badge(2)), at('mixed', 'a finding with no badge'),
    at('clean', badge(2)),
  ]);
  assert.equal(severity.get('mixed'), 'unknown', 'an unbadged sibling taints the head');
  assert.equal(severity.get('clean'), 'minor', 'a fully badged minor head stays minor');
});

test('W13: the metrics block survives OTHER sticky writes', async () => {
  // F6. Sixteen call sites write this comment with a plain status body. Any one
  // of them would have erased the lifecycle floor and the reply deadline.
  //
  // This EXERCISES the writer rather than grepping for a variable name. The
  // first version of this probe asserted the source mentioned `priorMetrics`,
  // which still passed when the value was computed and then never used — a test
  // of a mention, not of a behaviour, and it failed to discriminate.
  const { GitHubClient } = await import('./autonomous-review-gate.mjs');
  const metrics = '<!-- autonomous-review-metrics: {"findingHeads":5,'
    + '"declarationRequestedAt":"2026-08-01T00:00:00Z"} -->';

  const written = [];
  const client = Object.create(GitHubClient.prototype);
  client.repository = 'o/r';
  client.request = async (path, options) => {
    if (!options) {
      return [{
        id: 7,
        user: { login: 'github-actions[bot]' },
        body: `<!-- autonomous-review-state -->\nold status\n${metrics}`,
      }];
    }
    written.push(options.body.body);
    return {};
  };

  // A status-only write, exactly as the other fifteen call sites make it.
  await client.updateStickyComment(1, 'a plain status body with no metrics');
  assert.equal(written.length, 1);
  assert.match(
    written[0], /declarationRequestedAt/u,
    'a status-only write must not erase the recorded deadline',
  );
  assert.match(written[0], /findingHeads/u, 'nor the finding-head floor');

  // A writer supplying its OWN metrics replaces rather than duplicates.
  written.length = 0;
  await client.updateStickyComment(1, `fresh status\n${metrics.replace('5', '6')}`);
  assert.equal(
    written[0].match(/autonomous-review-metrics/gu).length, 1,
    'a supplied block replaces the old one rather than stacking',
  );
});

test('W14: a failed sticky READ never rewrites the durable floor', async () => {
  // A transient read failure left this run's counts computed WITHOUT the floor.
  // Writing them patched a recorded five-head floor down to however many heads
  // were visible, and the next run read the lowered value and passed a unit that
  // had already crossed the limit — a walk-back the floor rule exists to forbid.
  const client = fakeClient({ comments: heads(1, P1), stickyThrows: true });
  const result = await enforceReviewLifecycle(client, pr, 'h');

  assert.equal(result.allowed, false, 'an unreadable floor blocks');
  assert.equal(client.calls.sticky.length, 1, 'it still reports why');
  assert.doesNotMatch(
    client.calls.sticky[0], /autonomous-review-metrics/u,
    'but it must NOT write a floor computed without the floor it could not read',
  );
});
