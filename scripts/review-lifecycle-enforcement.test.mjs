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

// The gate stamps `declarationRequestedAt` when it first asks, and an answer
// only counts if it POSTDATES that request.
const ASKED_AT = '2026-08-01T00:00:00Z';
const AFTER = '2026-08-01T00:30:00Z';
const BEFORE = '2026-07-01T00:00:00Z';

// A recorded request, so a declaration has something to answer.
const asked = (extra = {}) => `<!-- autonomous-review-metrics: ${
  JSON.stringify({ declarationRequestedAt: ASKED_AT, ...extra })} -->`;

// A maintainer's answer, on the only channel that carries one: a comment with a
// real author and write access. `says(null, body)` writes arbitrary prose.
const says = (decision, body = null, at = AFTER) => ({
  user: { login: 'JagPat', type: 'User' },
  author_association: 'OWNER',
  created_at: at,
  updated_at: at,
  body: body ?? `<!-- review-restructure: ${decision} -->`,
});

function fakeClient({
  comments = [], sticky = null, stickyThrows = false, issueComments = [],
  issueCommentsThrows = false,
} = {}) {
  const calls = { status: [], sticky: [], draft: 0 };
  return {
    calls,
    reviewComments: async () => comments,
    reviews: async () => [],
    issueComments: async () => {
      if (issueCommentsThrows) throw new Error('transport');
      return issueComments;
    },
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
    fakeClient({ comments: heads(5, P1), sticky: asked(), issueComments: [says('continue')] }),
    pr, 'h',
  );
  assert.equal(cont.allowed, true);
  assert.equal(cont.declared, 'continue');
  assert.equal(cont.declaredBy, 'JagPat', 'the decision is attributed to whoever made it');

  const split = await enforceReviewLifecycle(
    fakeClient({ comments: heads(5, P1), sticky: asked(), issueComments: [says('restructure')] }),
    pr, 'h',
  );
  assert.equal(split.allowed, false);
  assert.equal(split.state, 'restructure_required');
});

test('W16: quoting the instructions is NOT obeying them', async () => {
  // Found while auditing, and it is the worst defect this unit had: the answer
  // was read from the PR BODY, and the request tells a human to use this exact
  // marker — so prose EXPLAINING how to answer contained an answer. This pull
  // request's own description documented the mechanism and would have declared
  // "continue" on its own behalf. That is a fabricated human approval, in a
  // repository whose standing rule is that approvals stay attributable.
  const marker = '<' + '!-- review-restructure: continue --' + '>';

  // 1. The body is no longer a channel at all. It is written by the loop, so a
  //    decision read from it is the loop approving itself.
  const viaBody = await enforceReviewLifecycle(
    fakeClient({ comments: heads(5, P1) }),
    { ...pr, body: `A human answers by adding ${marker} to the body.` }, 'h',
  );
  assert.equal(viaBody.allowed, false, 'the PR body can never declare a decision');
  assert.equal(viaBody.state, 'restructure_declaration_required');

  // 2. Nor can the loop's OWN comment, which quotes the marker every time it asks.
  const viaBot = await enforceReviewLifecycle(
    fakeClient({
      comments: heads(5, P1),
      sticky: asked(),
      issueComments: [{
        user: { login: 'github-actions[bot]', type: 'Bot' },
        author_association: 'NONE', created_at: AFTER, updated_at: AFTER,
        body: `A maintainer decides by commenting ${marker}`,
      }],
    }), pr, 'h',
  );
  assert.equal(viaBot.allowed, false, 'the asker must not be able to answer itself');

  // 3. Nor a drive-by from someone without write access.
  const viaStranger = await enforceReviewLifecycle(
    fakeClient({
      comments: heads(5, P1),
      sticky: asked(),
      issueComments: [{
        user: { login: 'passer-by', type: 'User' },
        author_association: 'NONE', created_at: AFTER, updated_at: AFTER, body: marker,
      }],
    }), pr, 'h',
  );
  assert.equal(viaStranger.allowed, false, 'only a maintainer decides');

  // 4. And a maintainer SHOWING the marker in a code span is documenting it.
  const viaCodeSpan = await enforceReviewLifecycle(
    fakeClient({
      comments: heads(5, P1), sticky: asked(),
      issueComments: [says(null, `you answer with \`${marker}\`, like this`)],
    }), pr, 'h',
  );
  assert.equal(viaCodeSpan.allowed, false, 'a marker being shown is not a marker being used');

  // The real thing still works — the gate is closed, not welded shut.
  const real = await enforceReviewLifecycle(
    fakeClient({ comments: heads(5, P1), sticky: asked(), issueComments: [says('continue')] }),
    pr, 'h',
  );
  assert.equal(real.allowed, true);
});

test('W17: the LATEST maintainer answer wins', async () => {
  // A human may change their mind, and posting again must be enough — nobody
  // should have to edit history to be heard.
  const client = fakeClient({
    comments: heads(5, P1), sticky: asked(),
    issueComments: [
      says('continue', null, AFTER),
      says('restructure', null, '2026-08-01T01:00:00Z'),
    ],
  });
  const result = await enforceReviewLifecycle(client, pr, 'h');
  assert.equal(result.declared, 'restructure');
  assert.equal(result.allowed, false);
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

test('W15: the recorded REASON states the real window, in both directions', async () => {
  // Found while writing the convergence audit, and it is the same defect family
  // as the six findings: the lifecycle record failing to carry its own truth.
  //
  // The waiting reason interpolated `${window}` inside a SINGLE-quoted string, so
  // it published the literal characters. The proceeding reason used the raw
  // `declarationWindowMinutes` PARAMETER, which is null unless a caller overrides
  // it — so the durable justification for having proceeded without a human read
  // "within null minutes". Neither is load-bearing for the decision, and both are
  // the only account a human gets of why the loop did what it did.
  const waiting = await enforceReviewLifecycle(
    fakeClient({ comments: heads(5, P1) }), pr, 'h',
  );
  assert.equal(waiting.allowed, false);
  assert.doesNotMatch(waiting.reason, /\$\{/u, 'no uninterpolated placeholder may ship');
  assert.match(waiting.reason, new RegExp(`${CRITICAL_WINDOW_MINUTES} minutes`, 'u'));

  const long_ago = new Date(Date.now() - (VERY_CRITICAL_WINDOW_MINUTES + 60) * 60_000)
    .toISOString();
  const proceeded = await enforceReviewLifecycle(
    fakeClient({
      comments: heads(5, '![P0 Badge](https://img.shields.io/badge/P0-red?style=flat) x'),
      sticky: `<!-- autonomous-review-metrics: ${
        JSON.stringify({ declarationRequestedAt: long_ago })} -->`,
    }), pr, 'h',
  );
  assert.equal(proceeded.autonomous, true);
  assert.doesNotMatch(proceeded.reason, /null/u, 'the window it waited must be a number');
  assert.match(proceeded.reason, new RegExp(`${VERY_CRITICAL_WINDOW_MINUTES}-minute`, 'u'));
  assert.match(proceeded.reason, /very-critical/u, 'and it must name the tier it applied');
});

test('W18: an UNREADABLE declaration list blocks — it is not silence', async () => {
  // Round 3, and the same rule I had already applied to the sticky floor one
  // function earlier: a failed read is not evidence of absence. Expiry is the
  // dangerous case precisely because it needs NO answer, so a transport error
  // looks exactly like a human saying nothing — and the loop would override a
  // `restructure` it never saw.
  const expired = new Date(Date.now() - (VERY_CRITICAL_WINDOW_MINUTES + 60) * 60_000)
    .toISOString();
  const client = fakeClient({
    comments: heads(5, P1),
    sticky: `<!-- autonomous-review-metrics: ${
      JSON.stringify({ declarationRequestedAt: expired })} -->`,
    issueCommentsThrows: true,
  });
  const result = await enforceReviewLifecycle(client, pr, 'h');

  assert.equal(result.allowed, false, 'an unread answer must not expire into consent');
  assert.equal(result.undecided, true);
  assert.match(result.reason, /could not be read/u);
});

test('W19: a declaration that PREDATES the request does not answer it', async () => {
  // A marker written while discussing the mechanism — months before this unit
  // crossed the limit — was being treated as the answer to a request that did
  // not exist yet, letting a five-P1-head unit proceed on a decision nobody made
  // about it.
  const stale = await enforceReviewLifecycle(
    fakeClient({
      comments: heads(5, P1), sticky: asked(),
      issueComments: [says('continue', null, BEFORE)],
    }), pr, 'h',
  );
  assert.equal(stale.allowed, false, 'an old marker cannot answer a later request');
  assert.equal(stale.state, 'restructure_declaration_required');

  // An answer with NO readable timestamp cannot be shown to postdate anything.
  const undated = await enforceReviewLifecycle(
    fakeClient({
      comments: heads(5, P1), sticky: asked(),
      issueComments: [{
        user: { login: 'JagPat', type: 'User' }, author_association: 'OWNER',
        body: '<!-- review-restructure: continue -->',
      }],
    }), pr, 'h',
  );
  assert.equal(undated.allowed, false, 'an undated answer is not a proven answer');

  // A maintainer may answer by EDITING an older comment: the edit is the act.
  const edited = await enforceReviewLifecycle(
    fakeClient({
      comments: heads(5, P1), sticky: asked(),
      issueComments: [{
        user: { login: 'JagPat', type: 'User' }, author_association: 'OWNER',
        created_at: BEFORE, updated_at: AFTER,
        body: '<!-- review-restructure: restructure -->',
      }],
    }), pr, 'h',
  );
  assert.equal(edited.declared, 'restructure', 'an edited-in answer counts from the edit');
});

test('W20: proceeding unanswered leaves a DURABLE record of the override', async () => {
  // The reason string said the loop "records that it did" — and it did not. The
  // timeout path returned before this function's only sticky write, so the one
  // permissive outcome nobody authorised was the one that left no trace.
  const expired = new Date(Date.now() - (VERY_CRITICAL_WINDOW_MINUTES + 60) * 60_000)
    .toISOString();
  const client = fakeClient({
    comments: heads(5, P1),
    sticky: `<!-- autonomous-review-metrics: ${
      JSON.stringify({ declarationRequestedAt: expired })} -->`,
  });
  const result = await enforceReviewLifecycle(client, pr, 'h');

  assert.equal(result.allowed, true);
  assert.equal(result.autonomous, true);
  assert.equal(client.calls.sticky.length, 1, 'the override must be written down');
  const written = client.calls.sticky[0];
  assert.match(written, /autonomousAt/u, 'when the loop overrode the request');
  assert.match(written, /lifecycle_autonomous/u, 'and that it is what happened');
  assert.match(written, /declarationRequestedAt/u, 'without dropping the request stamp');

  // The unit is NOT drafted or failed — it proceeds. The record is the point.
  assert.equal(client.calls.status.length, 0);
});

test('W21: the comment reader pages through EVERYTHING', async () => {
  // Both the durable floor and a maintainer's answer are read from this list. A
  // single unread page would make either look ABSENT — which is the permissive
  // outcome, decided by a page boundary.
  const { GitHubClient } = await import('./autonomous-review-gate.mjs');
  const client = Object.create(GitHubClient.prototype);
  client.repository = 'o/r';

  const pages = [];
  client.request = async (path) => {
    pages.push(path);
    // `[?&]` matters: a bare /page=(\d+)/ matches `per_page=100` first.
    const page = Number(/[?&]page=(\d+)/u.exec(path)?.[1] ?? 1);
    return page < 3
      ? Array.from({ length: 100 }, (_, i) => ({ id: page * 100 + i }))
      : [{ id: 'last' }];
  };

  const all = await client.issueComments(1);
  assert.equal(all.length, 201, 'every page is included, not just the first');
  assert.equal(pages.length, 3);
  assert.equal(all.at(-1).id, 'last', 'the final partial page ends the walk');

  // A failed page THROWS rather than returning a short list, so the caller can
  // tell "read everything" from "read some of it" — which is what W18 needs.
  client.request = async (path) => {
    if (path.includes('page=2')) throw new Error('transport');
    return Array.from({ length: 100 }, (_, i) => ({ id: i }));
  };
  await assert.rejects(() => client.issueComments(1), /transport/u);
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
