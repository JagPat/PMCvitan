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
//
// RELATIVE to now, not fixed. An earlier draft pinned these to absolute dates
// while `enforceReviewLifecycle` reads the REAL clock, so the window silently
// expired as the session ran: the same probes passed at 01:00 and failed at
// 03:10, because 190 minutes had elapsed against a 180-minute window. A test
// whose verdict depends on what time it is run is worse than no test — it goes
// red in CI for a reason that has nothing to do with the change.
//
// The SWEEP probes are unaffected and stay on fixed timestamps: they inject
// `nowIso` explicitly, so they are deterministic by construction.
const ago = (minutes) => new Date(Date.now() - minutes * 60_000).toISOString();
const ASKED_AT = ago(2);      // asked two minutes ago: every window still open
const AFTER = ago(1);         // answered after the request
const BEFORE = ago(90 * 24 * 60);  // written three months before it

// A recorded request, so a declaration has something to answer. Request-scoped
// fields live under ONE key so a spent request cannot leak into its successor.
const asked = (request = {}) => `<!-- autonomous-review-metrics: ${
  JSON.stringify({ lifecycleRequest: { at: ASKED_AT, ...request } })} -->`;

// The FLAT shape written before the nesting. A pull request mid-flight when this
// ships carries one, so reading it must still work.
const askedLegacy = (extra = {}) => `<!-- autonomous-review-metrics: ${
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
  assert.match(client.calls.status[0][2], /^review: lifecycle —/u,
    'the block must speak the vocabulary the status state machine classifies');

  const posted = client.calls.sticky[0];
  assert.match(posted, /review-restructure: continue/u, 'the comment must say how to answer');
  assert.match(posted, new RegExp(String(CRITICAL_WINDOW_MINUTES), 'u'),
    'the P1 request must quote the 3-hour critical window');
  assert.match(posted, /"lifecycleRequest":\{"at":/u, 'the window start must be recorded');
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
      says('restructure', null, ago(0)),
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
  assert.match(written, /"lifecycleRequest":\{"at":/u, 'without dropping the request stamp');

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

// ---------------------------------------------------------------------------
// F3 — the fallback sweep. Events drive this loop; a deadline passing is the one
// transition no event announces, because it is DEFINED by nothing happening.
// ---------------------------------------------------------------------------

function sweepClient({ pulls = [], sticky = {}, statuses = {}, stickyThrowsFor = [] } = {}) {
  const calls = { dispatched: [], logs: [] };
  return {
    calls,
    openAutonomousPullRequests: async () => pulls,
    stickyComment: async (n) => {
      if (stickyThrowsFor.includes(n)) throw new Error('transport');
      return sticky[n] ?? null;
    },
    statuses: async (sha) => statuses[sha] ?? [],
    dispatchReviewRecovery: async (args) => { calls.dispatched.push(args); },
  };
}

// Fixed, because every sweep probe injects `nowIso` — deterministic regardless
// of when the suite runs.
const SWEEP_ASKED_AT = '2026-08-01T00:00:00Z';
const SWEEP_ASKED = `<!-- autonomous-review-metrics: ${
  JSON.stringify({ declarationRequestedAt: SWEEP_ASKED_AT })} -->`;

const blocked = (id = 55) => [{
  id, context: 'codex-current-head', state: 'failure',
  description: 'review: lifecycle — 5 finding-bearing heads still drawing P1 findings',
}];

test('W22: with nothing expired the sweep writes NOTHING', async () => {
  // It runs every fifteen minutes over every open unit. If an idle tick had side
  // effects, the fallback would be a source of churn rather than a safety net.
  const { sweepExpiredWindows } = await import('./autonomous-review-gate.mjs');
  const client = sweepClient({
    pulls: [{ number: 1, head: { sha: 'h1', ref: 'claude/x' } }],
    sticky: { 1: SWEEP_ASKED },   // a window, but only 30 minutes old
    statuses: { h1: blocked() },
  });
  const result = await sweepExpiredWindows(client, {
    nowIso: '2026-08-01T00:30:00Z', log: (m) => client.calls.logs.push(m),
  });
  assert.equal(client.calls.dispatched.length, 0, 'an unexpired window is left alone');
  assert.equal(result.woken.length, 0);
  assert.equal(result.scanned, 1);
});

test('W23: an EXPIRED window wakes the ordinary gate — nothing else', async () => {
  const { sweepExpiredWindows } = await import('./autonomous-review-gate.mjs');
  const client = sweepClient({
    pulls: [{ number: 7, head: { sha: 'h7', ref: 'claude/y' } }],
    sticky: {
      7: `<!-- autonomous-review-metrics: ${JSON.stringify({
        declarationRequestedAt: SWEEP_ASKED_AT,
        declarationWindowMinutes: CRITICAL_WINDOW_MINUTES,
      })} -->`,
    },
    statuses: { h7: blocked(99) },
  });
  // Four hours after a three-hour window opened.
  const result = await sweepExpiredWindows(client, {
    nowIso: '2026-08-01T04:00:00Z', ref: 'main', log: () => {},
  });

  assert.equal(result.woken.length, 1);
  assert.deepEqual(client.calls.dispatched, [{
    pullRequestNumber: 7, headSha: 'h7', terminalStatusId: 99, ref: 'main',
  }]);

  // Once the override is RECORDED the window is spent, so the sweep stops firing
  // — R4's durable record is what makes this fallback terminate.
  const spent = sweepClient({
    pulls: [{ number: 7, head: { sha: 'h7', ref: 'claude/y' } }],
    sticky: {
      7: `<!-- autonomous-review-metrics: ${JSON.stringify({
        declarationRequestedAt: SWEEP_ASKED_AT,
        declarationWindowMinutes: CRITICAL_WINDOW_MINUTES,
        autonomousAt: '2026-08-01T03:15:00Z',
      })} -->`,
    },
    statuses: { h7: blocked(99) },
  });
  await sweepExpiredWindows(spent, { nowIso: '2026-08-01T09:00:00Z', log: () => {} });
  assert.equal(spent.calls.dispatched.length, 0, 'a spent window is never re-woken');
});

test('W24: resuming is NOT approving', async () => {
  // The sweep can only re-dispatch the gate, and the gate re-decides from the
  // record. So a lifecycle block is resumable — and a window that has not
  // actually expired blocks again on the next run.
  const { isRetryableTerminalReviewFailure } = await import('./autonomous-review-gate.mjs');
  assert.equal(isRetryableTerminalReviewFailure(blocked()[0]), true,
    'a lifecycle block must be resumable, or an expired window is unreachable');

  // Re-running with an unexpired window blocks a second time.
  const again = await enforceReviewLifecycle(
    fakeClient({ comments: heads(5, P1), sticky: asked() }), pr, 'h',
  );
  assert.equal(again.allowed, false, 'resumption re-decides; it does not admit');
  assert.equal(again.state, 'restructure_declaration_required');

  // A non-lifecycle, non-retryable failure stays non-retryable.
  assert.equal(isRetryableTerminalReviewFailure({
    id: 1, context: 'codex-current-head', state: 'failure',
    description: 'review: Codex found issues on this head',
  }), false, 'widening must not admit a real review failure');
});

test('W25: an unreadable unit is REPORTED, never silently skipped', async () => {
  // "The sweep found nothing" and "the sweep could not look" are different
  // facts, and only one of them means all is well.
  const { sweepExpiredWindows } = await import('./autonomous-review-gate.mjs');
  const logs = [];
  const client = sweepClient({
    pulls: [{ number: 3, head: { sha: 'h3', ref: 'claude/z' } }],
    stickyThrowsFor: [3],
  });
  const result = await sweepExpiredWindows(client, { nowIso: SWEEP_ASKED_AT, log: (m) => logs.push(m) });
  assert.equal(result.skipped.length, 1);
  assert.match(result.skipped[0].reason, /unreadable/u);
  assert.ok(logs.some((l) => /skipped #3/u.test(l)), 'and it says so in the log');
});

test('W26: both wake paths are wired, and neither drives the orchestrator', async () => {
  // Anchored on the PARSED workflow, not on the text. The first draft matched
  // `if: github.event_name == 'schedule'` verbatim and broke the moment a second
  // legitimate trigger made the condition multi-line — the fifth position-coupled
  // pin in this workstream to fail on an edit that did not touch its subject.
  const raw = await readFile(
    new URL('../.github/workflows/auto-merge.yml', import.meta.url), 'utf8',
  );

  // Triggers: the event path AND the fallback timer must both exist.
  assert.match(raw, /^ {2}schedule:\n {4}- cron: '\*\/15 \* \* \* \*'$/mu,
    'the fallback runs every 15 minutes');
  assert.match(raw, /^ {2}issue_comment:$/mu,
    'a maintainer answering is an EVENT and must not wait for the timer');

  const sweep = raw.slice(
    raw.indexOf('  window-sweep:'), raw.indexOf('  request-recovery:'),
  );
  const condition = sweep.slice(sweep.indexOf('if:'), sweep.indexOf('runs-on:'));
  for (const [signal, why] of [
    ["github.event_name == 'schedule'", 'the timer fallback'],
    ["github.event_name == 'issue_comment'", 'the answer event'],
    ['github.event.issue.pull_request', 'issue comments are not pull-request comments'],
    ["contains(github.event.comment.body, 'review-restructure:')", 'ordinary chat is free'],
  ]) {
    assert.ok(condition.includes(signal), `the sweep condition must carry ${why}`);
  }
  assert.match(sweep, /AUTONOMOUS_REVIEW_MODE: window-sweep/u);

  // Neither wake path may drive the orchestrator DIRECTLY: a tick and a comment
  // are not CI completions, and orchestrating from one would run the gate on
  // stale context. The sweep re-dispatches through the recovery path instead.
  const orchestrate = raw.slice(raw.indexOf('  orchestrate:'));
  const orchestrateCondition = orchestrate.slice(0, orchestrate.indexOf('concurrency:'));
  assert.doesNotMatch(orchestrateCondition, /event_name == 'schedule'/u);
  assert.doesNotMatch(orchestrateCondition, /event_name == 'issue_comment'/u);
});

test('W27: a Codex review CONTAINER is not an unreadable finding', async () => {
  // Every Codex review is posted as a wrapper whose body carries no badge — the
  // findings are inline review comments. Counting the wrapper as an unreadable
  // finding tainted EVERY reviewed head as unknown, so a unit carrying nothing
  // but P2s would still stop and ask a human. That is the critical-only rule
  // defeated in the normal case, not an edge case.
  //
  // My earlier probes all passed `reviews: []`, which is why they missed it.
  // This one uses the real shape.
  const { findingHeadSeverity } = await import('./review-efficiency.mjs');
  const CONTAINER = '\n### 💡 Codex Review\n\nHere are some automated review '
    + 'suggestions for this pull request.\n\n**Reviewed commit:** `abc1234`\n';
  const badge = (n) => `![P${n} Badge](https://img.shields.io/badge/P${n}-x?style=flat)`;

  const severity = findingHeadSeverity(
    [{ user: { login: CODEX }, commit_id: 'h', body: badge(2) }],
    [{ user: { login: CODEX }, commit_id: 'h', body: CONTAINER }],
  );
  assert.equal(severity.get('h'), 'minor', 'the wrapper must not taint its own head');

  // A container that DOES carry a badge still counts — it is evidence either way.
  assert.equal(
    findingHeadSeverity([], [{ user: { login: CODEX }, commit_id: 'h', body: badge(1) }]).get('h'),
    'critical',
  );

  // And an inline comment with no badge still taints: only the wrapper is exempt.
  assert.equal(
    findingHeadSeverity(
      [{ user: { login: CODEX }, commit_id: 'h', body: badge(2) },
        { user: { login: CODEX }, commit_id: 'h', body: 'no badge here' }],
      [{ user: { login: CODEX }, commit_id: 'h', body: CONTAINER }],
    ).get('h'),
    'unknown',
  );

  // End to end: five P2 heads, each with its container, must NOT ask a human.
  const client = fakeClient({ comments: heads(5, P2) });
  client.reviews = async () => Array.from({ length: 5 }, (_, i) => ({
    user: { login: CODEX }, commit_id: `head${i}`, body: CONTAINER,
  }));
  const result = await enforceReviewLifecycle(client, pr, 'h');
  assert.equal(result.allowed, true, 'a P2-only unit converges without interrupting anyone');
  assert.equal(client.calls.status.length, 0);
});

test('W28: the sticky WRITER pages the same way the reader does', async () => {
  // Paginating the read and leaving the write on one page is worse than
  // paginating neither: past a hundred comments the writer would not find the
  // sticky it means to patch, POST a second one, and every lifecycle read —
  // which does page — would keep returning the original. The floor and the
  // deadline would be written to a comment nothing reads.
  const { GitHubClient } = await import('./autonomous-review-gate.mjs');
  const client = Object.create(GitHubClient.prototype);
  client.repository = 'o/r';

  const sticky = {
    id: 4242,
    user: { login: 'github-actions[bot]' },
    body: '<!-- autonomous-review-state -->\nold\n<!-- autonomous-review-metrics: '
      + '{"findingHeads":5,"declarationRequestedAt":"2026-08-01T00:00:00Z"} -->',
  };
  const writes = [];
  client.request = async (path, options) => {
    if (!options) {
      // The sticky lives on page 2 — past the first hundred comments.
      const page = Number(/[?&]page=(\d+)/u.exec(path)?.[1] ?? 1);
      if (page === 1) return Array.from({ length: 100 }, (_, i) => ({ id: i, user: { login: 'someone' }, body: 'chat' }));
      return [sticky];
    }
    writes.push({ path, method: options.method, body: options.body.body });
    return {};
  };

  await client.updateStickyComment(1, 'a plain status body');
  assert.equal(writes.length, 1);
  assert.equal(writes[0].method, 'PATCH', 'it must PATCH the existing sticky, not POST a second');
  assert.match(writes[0].path, /issues\/comments\/4242/u, 'and patch the one it found');
  assert.match(writes[0].body, /declarationRequestedAt/u, 'carrying the record forward');
});

test('W29: a recorded window is a PROMISE and never shrinks', async () => {
  // I wrote declarationWindowMinutes for the sweep and never read it back, so
  // the assessment recomputed the window from current severity on every run. A
  // unit first blocked on unclassified evidence records 360 minutes; once the
  // heads become classifiable as merely P1 the recompute yields 180, and a run
  // at 3h01 proceeds autonomously while the durable record still promises six
  // hours to a human who is inside it.
  const fourHoursAgo = ago(4 * 60);
  const client = fakeClient({
    comments: heads(5, P1),   // classifies as 'critical' -> would recompute 180
    sticky: `<!-- autonomous-review-metrics: ${JSON.stringify({
      declarationRequestedAt: fourHoursAgo,
      declarationWindowMinutes: VERY_CRITICAL_WINDOW_MINUTES,
    })} -->`,
  });
  const result = await enforceReviewLifecycle(client, pr, 'h');
  assert.equal(result.allowed, false, 'the promised 6-hour window is still open at 4h');
  assert.equal(result.windowMinutes, VERY_CRITICAL_WINDOW_MINUTES);

  // It never CAPS either: a reclassification to something more serious extends
  // the wait, the same fail-closed direction as unknown severity.
  const worse = fakeClient({
    comments: heads(5, '![P0 Badge](https://img.shields.io/badge/P0-red?style=flat) x'),
    sticky: `<!-- autonomous-review-metrics: ${JSON.stringify({
      declarationRequestedAt: ago(200),
      declarationWindowMinutes: CRITICAL_WINDOW_MINUTES,   // 180 recorded
    })} -->`,
  });
  const extended = await enforceReviewLifecycle(worse, pr, 'h');
  assert.equal(extended.windowMinutes, VERY_CRITICAL_WINDOW_MINUTES, 'P0 extends to 360');
  assert.equal(extended.allowed, false, 'and 200 minutes is inside the extended window');
});

test('W30: a crossed-but-MINOR unit still records its floor', async () => {
  // The P2-only path continues, and used to return without writing anything, so
  // the crossing left no durable trace. The floor exists to survive a partial
  // read: if a later sixth head carries a P1 while the live read exposes only
  // that head, the gate would count one instead of six and promote another
  // review rather than asking.
  const client = fakeClient({ comments: heads(5, P2) });
  const result = await enforceReviewLifecycle(client, pr, 'h');

  assert.equal(result.allowed, true, 'a converging unit is not interrupted');
  assert.equal(client.calls.status.length, 0, 'and nothing is failed');
  assert.equal(client.calls.sticky.length, 1, 'but the crossing IS written down');
  assert.match(client.calls.sticky[0], /"findingHeads":5/u);
  assert.match(client.calls.sticky[0], /lifecycle_crossed/u);

  // Below the threshold there is no crossing to record and nothing is written.
  const under = fakeClient({ comments: heads(3, P2) });
  await enforceReviewLifecycle(under, pr, 'h');
  assert.equal(under.calls.sticky.length, 0, 'an uncrossed unit stays untouched');
});

test('W31: a DECLARED restructure is not retried every fifteen minutes', async () => {
  // The sweep resumes any `review: lifecycle —` block. A block that exists
  // because a maintainer SAID "restructure" is terminal by decision, not a wait:
  // resuming it re-reads the same declaration, fails again, and leaves another
  // pending recovery request — every quarter of an hour, forever, while everyone
  // waits for the replacement PR.
  const { isRetryableTerminalReviewFailure } = await import('./autonomous-review-gate.mjs');

  // Read the description the gate ACTUALLY WROTE, not one this test composes.
  // The first draft of this probe built the string itself, so reverting the fix
  // left it green — it tested its own fixture rather than the code.
  const declaredClient = fakeClient({
    comments: heads(5, P1), sticky: asked(), issueComments: [says('restructure')],
  });
  const declared = await enforceReviewLifecycle(declaredClient, pr, 'h');
  assert.equal(declared.state, 'restructure_required');
  const declaredDescription = declaredClient.calls.status[0][2];
  assert.equal(
    isRetryableTerminalReviewFailure({
      id: 1, context: 'codex-current-head', state: 'failure',
      description: declaredDescription,
    }),
    false,
    'a declared restructure must not be resumable',
  );

  // A unit still WAITING on an answer stays resumable — that is what makes an
  // expired window reachable at all. Also read from a real run.
  const waitingClient = fakeClient({ comments: heads(5, P1) });
  await enforceReviewLifecycle(waitingClient, pr, 'h');
  assert.equal(
    isRetryableTerminalReviewFailure({
      id: 2, context: 'codex-current-head', state: 'failure',
      description: waitingClient.calls.status[0][2],
    }),
    true,
    'a unit awaiting an answer must stay resumable',
  );

  // The two must be genuinely distinguishable in what is written.
  assert.notEqual(declaredDescription, waitingClient.calls.status[0][2]);
});

test('W32: the NEWEST record-bearing sticky wins, and is the one patched', async () => {
  // The earlier one-page writer bug could leave TWO state comments: the stale
  // original at the top and a newer duplicate actually carrying the floor. A
  // `find()` over the ascending list returns the stale one, so a recorded
  // five-head crossing reads as absent and the gate promotes instead of asking.
  const { GitHubClient, pickSticky } = await import('./autonomous-review-gate.mjs');
  const bare = { id: 1, user: { login: 'github-actions[bot]' },
    body: '<!-- autonomous-review-state -->\nold, no record' };
  const bearing = { id: 2, user: { login: 'github-actions[bot]' },
    body: '<!-- autonomous-review-state -->\nnewer\n'
      + '<!-- autonomous-review-metrics: {"findingHeads":5} -->' };

  assert.equal(pickSticky([bare, bearing]).id, 2, 'the record-bearing one wins');
  assert.equal(pickSticky([bearing, bare]).id, 2, 'even when it is not last');
  assert.equal(pickSticky([bare]).id, 1, 'with no record, the newest sticky');
  assert.equal(pickSticky([]), null);
  assert.equal(pickSticky([{ id: 9, user: { login: 'JagPat' }, body: 'hi' }]), null,
    'a human comment is never the sticky');

  // The WRITER must patch the same one, which consolidates the pair rather than
  // forking it further.
  const client = Object.create(GitHubClient.prototype);
  client.repository = 'o/r';
  const writes = [];
  client.request = async (path, options) => {
    if (!options) return [bare, bearing];
    writes.push(path);
    return {};
  };
  await client.updateStickyComment(1, 'a plain status body');
  assert.match(writes[0], /issues\/comments\/2/u, 'patch the record-bearing sticky');

  // And the reader agrees with the writer.
  assert.match(await client.stickyComment(1), /findingHeads/u);
});

test('W33: the sweep wakes an ANSWERED unit and an UNREADABLE one', async () => {
  // Waking only on expiry meant a maintainer who answered two minutes after
  // being asked still watched the unit sit for the rest of the window, and a
  // transient read failure had no autonomous recovery at all.
  const { sweepExpiredWindows } = await import('./autonomous-review-gate.mjs');

  // Answered inside an open window: woken immediately, not at the deadline.
  const answered = sweepClient({
    pulls: [{ number: 5, head: { sha: 'h5', ref: 'claude/a' } }],
    sticky: { 5: SWEEP_ASKED },
    statuses: { h5: blocked(11) },
  });
  answered.issueComments = async () => [{
    user: { login: 'JagPat', type: 'User' }, author_association: 'OWNER',
    created_at: '2026-08-01T00:10:00Z', updated_at: '2026-08-01T00:10:00Z',
    body: '<!-- review-restructure: continue -->',
  }];
  const r1 = await sweepExpiredWindows(answered, {
    nowIso: '2026-08-01T00:20:00Z', log: () => {},   // well inside the window
  });
  assert.equal(r1.woken.length, 1, 'an answer must not wait for the deadline');
  assert.match(r1.woken[0].why, /answered "continue"/u);

  // Unanswered inside the window: still left alone.
  const quiet = sweepClient({
    pulls: [{ number: 6, head: { sha: 'h6', ref: 'claude/b' } }],
    sticky: { 6: SWEEP_ASKED },
    statuses: { h6: blocked(12) },
  });
  quiet.issueComments = async () => [];
  const r2 = await sweepExpiredWindows(quiet, { nowIso: '2026-08-01T00:20:00Z', log: () => {} });
  assert.equal(r2.woken.length, 0, 'silence inside the window is not actionable');

  // An unreadable-evidence block is transient and retried without any window.
  const stuck = sweepClient({
    pulls: [{ number: 8, head: { sha: 'h8', ref: 'claude/c' } }],
    sticky: { 8: null },
    statuses: { h8: [{
      id: 13, context: 'codex-current-head', state: 'failure',
      description: 'review: lifecycle unreadable — the recorded floor could not be read',
    }] },
  });
  const r3 = await sweepExpiredWindows(stuck, { nowIso: '2026-08-01T00:20:00Z', log: () => {} });
  assert.equal(r3.woken.length, 1, 'a transient read failure must self-recover');
  assert.match(r3.woken[0].why, /could not read its own evidence/u);
});

test('W34: a failed sticky WRITE cannot strand the unit', async () => {
  // Round 7 fixed this by writing the record BEFORE the status. That was an
  // over-fix, and round 8 showed why: a throw then left the earlier `pending`
  // status as the latest one, and the sweep only wakes retryable TERMINAL
  // statuses — so the unit sat exactly as before, one layer deeper.
  //
  // The block is published FIRST and the record is best-effort, because the
  // sweep already knows how to recover a block whose record is missing. Losing
  // the record costs one sweep cycle; losing the block costs the unit.
  const { sweepExpiredWindows } = await import('./autonomous-review-gate.mjs');

  const order = [];
  const client = fakeClient({ comments: heads(5, P1) });
  client.setStatus = async (...a) => { order.push('block'); client.calls.status.push(a); };
  client.updateStickyComment = async (n, b) => { order.push('record'); client.calls.sticky.push(b); };
  await enforceReviewLifecycle(client, pr, 'h');
  assert.deepEqual(order, ['block', 'record'],
    'the block the sweep can recover must be published before the record');

  // A throwing record write must NOT swallow the block or fail the run.
  const broken = fakeClient({ comments: heads(5, P1) });
  broken.updateStickyComment = async () => { throw new Error('transport'); };
  const result = await enforceReviewLifecycle(broken, pr, 'h');
  assert.equal(result.allowed, false);
  assert.equal(broken.calls.status.length, 1, 'the block is published regardless');
  assert.match(broken.calls.status[0][2], /^review: lifecycle —/u);

  // SELF-HEAL: the sweep wakes exactly that shape.
  const stranded = sweepClient({
    pulls: [{ number: 4, head: { sha: 'h4', ref: 'claude/d' } }],
    sticky: { 4: null },                 // published wait, no record
    statuses: { h4: blocked(21) },
  });
  stranded.issueComments = async () => [];
  const healed = await sweepExpiredWindows(stranded, {
    nowIso: '2026-08-01T00:20:00Z', log: () => {},
  });
  assert.equal(healed.woken.length, 1, 'an unrecorded wait must not sit forever');
  assert.match(healed.woken[0].why, /never recorded/u);
});

test('W35: the sweep never overrides the Codex attempt cap', async () => {
  // The self-heal above keyed on "no lifecycle metrics", which is ALSO true of
  // an ordinary retryable failure like `review: Codex review timed out after two
  // attempts`. Unscoped, the sweep re-ran the entire review loop every fifteen
  // minutes while Codex was unhealthy — overriding a two-attempt safety cap the
  // sweep has no business touching.
  const { sweepExpiredWindows } = await import('./autonomous-review-gate.mjs');
  const timedOut = sweepClient({
    pulls: [{ number: 9, head: { sha: 'h9', ref: 'claude/e' } }],
    sticky: { 9: null },                 // no lifecycle metrics — same as above
    statuses: { h9: [{
      id: 31, context: 'codex-current-head', state: 'failure',
      description: 'review: Codex review timed out after two attempts',
    }] },
  });
  timedOut.issueComments = async () => [];
  const result = await sweepExpiredWindows(timedOut, {
    nowIso: '2026-08-01T00:20:00Z', log: () => {},
  });
  assert.equal(result.woken.length, 0,
    'a non-lifecycle retryable failure is not the sweep\'s to re-run');

  // The lifecycle wait with the same empty record IS still healed, so the scope
  // narrowed the false positive without losing the fix.
  const wait = sweepClient({
    pulls: [{ number: 10, head: { sha: 'h10', ref: 'claude/f' } }],
    sticky: { 10: null },
    statuses: { h10: blocked(32) },
  });
  wait.issueComments = async () => [];
  assert.equal(
    (await sweepExpiredWindows(wait, { nowIso: '2026-08-01T00:20:00Z', log: () => {} }))
      .woken.length,
    1,
  );
});

test('W36: a SPENT request cannot leak into the one that replaces it', async () => {
  // The bug family this restructure exists to end, found four times in four
  // rounds. Held flat, every writer did `{ ...recordedMetrics, ... }` and carried
  // request-scoped fields across request boundaries.
  //
  // The worst instance: a 180-minute P1 request times out and records
  // `autonomousAt`. A later P0 head opens a NEW 360-minute window — and inherited
  // the old `autonomousAt`, so `expiredWindow` returned null forever and the
  // sweep never re-dispatched. The unit sat on a wait nothing could end.
  const { sweepExpiredWindows } = await import('./autonomous-review-gate.mjs');
  const spent = {
    at: ago(400), windowMinutes: CRITICAL_WINDOW_MINUTES,
    tier: 'critical', autonomousAt: ago(220),
  };
  const client = fakeClient({
    comments: heads(5, '![P0 Badge](https://img.shields.io/badge/P0-red?style=flat) x'),
    sticky: `<!-- autonomous-review-metrics: ${
      JSON.stringify({ findingHeads: 5, lifecycleRequest: spent })} -->`,
  });
  const result = await enforceReviewLifecycle(client, pr, 'h');
  assert.equal(result.allowed, false, 'a P0 unit opens a new wait');

  const written = JSON.parse(
    /autonomous-review-metrics:\s*(\{.*\})\s*-->/u.exec(client.calls.sticky[0])[1],
  );
  assert.equal(written.lifecycleRequest.autonomousAt, undefined,
    'the NEW request must not inherit the old override stamp');
  assert.equal(written.lifecycleRequest.windowMinutes, VERY_CRITICAL_WINDOW_MINUTES);
  assert.notEqual(written.lifecycleRequest.at, spent.at, 'and it is a fresh stamp');
  assert.equal(written.findingHeads, 5, 'while the CUMULATIVE floor is carried');

  // And the sweep can now see that new window expire, which it could not before.
  const fresh = sweepClient({
    pulls: [{ number: 2, head: { sha: 'h2', ref: 'claude/g' } }],
    sticky: { 2: `<!-- autonomous-review-metrics: ${JSON.stringify({
      lifecycleRequest: {
        at: '2026-08-01T00:00:00Z',
        windowMinutes: VERY_CRITICAL_WINDOW_MINUTES,
        tier: 'very-critical',
      },
    })} -->` },
    statuses: { h2: blocked(41) },
  });
  fresh.issueComments = async () => [];
  const swept = await sweepExpiredWindows(fresh, {
    nowIso: '2026-08-01T07:00:00Z', log: () => {},
  });
  assert.equal(swept.woken.length, 1, 'the replacement window expires normally');
});

test('W37: a LEGACY flat record still works', async () => {
  // A pull request mid-flight when this ships carries the old flat shape.
  // Discarding it would silently drop a live window and re-ask a human who has
  // already been asked, so it is normalised on read instead.
  const { lifecycleRequestOf, expiredWindow } = await import('./review-lifecycle.mjs');

  const legacy = {
    findingHeads: 5,
    declarationRequestedAt: '2026-08-01T00:00:00Z',
    declarationWindowMinutes: CRITICAL_WINDOW_MINUTES,
    autonomousTier: 'critical',
  };
  assert.equal(lifecycleRequestOf(legacy).at, '2026-08-01T00:00:00Z');
  assert.equal(lifecycleRequestOf(legacy).windowMinutes, CRITICAL_WINDOW_MINUTES);
  assert.ok(expiredWindow(legacy, '2026-08-01T04:00:00Z'), 'a legacy window still expires');
  assert.equal(expiredWindow(legacy, '2026-08-01T01:00:00Z'), null, 'and still waits');

  // A legacy record that already recorded its override is still spent.
  assert.equal(
    expiredWindow({ ...legacy, autonomousAt: '2026-08-01T03:00:00Z' }, '2026-08-01T09:00:00Z'),
    null,
  );

  // The gate reads one end to end, and the flat fields do not survive the write
  // — leaving both would let the stale copy shadow the nested one on next read.
  const client = fakeClient({ comments: heads(5, P1), sticky: askedLegacy() });
  await enforceReviewLifecycle(client, pr, 'h');
  const written = JSON.parse(
    /autonomous-review-metrics:\s*(\{.*\})\s*-->/u.exec(client.calls.sticky[0])[1],
  );
  assert.equal(written.declarationRequestedAt, undefined, 'the flat copy is dropped');
  assert.equal(written.lifecycleRequest.at, ASKED_AT, 'and the live window is preserved');
});

test('W38: EVERY lifecycle path survives a failed record write', async () => {
  // Round 8 guarded the blocking path; round 9 found the other two unguarded —
  // the same under-application, caught one path at a time. One writer now owns
  // all three, so a transient failure can never fail the run and strand a unit
  // on a `pending` status the sweep does not wake.
  const paths = [
    ['autonomous timeout', {
      comments: heads(5, P1),
      sticky: `<!-- autonomous-review-metrics: ${JSON.stringify({
        lifecycleRequest: { at: ago(400), windowMinutes: CRITICAL_WINDOW_MINUTES, tier: 'critical' },
      })} -->`,
    }],
    ['crossed but minor', { comments: heads(5, P2) }],
    ['blocking request', { comments: heads(5, P1) }],
  ];
  for (const [name, options] of paths) {
    const client = fakeClient(options);
    client.updateStickyComment = async () => { throw new Error('transport'); };
    await assert.doesNotReject(
      () => enforceReviewLifecycle(client, pr, 'h'),
      `${name} must not fail the run when its record cannot be written`,
    );
  }
});

test('W39: one "continue" authorises ONE head, not every head after it', async () => {
  // Round 9 modelled one way a request ends — the window running out — and
  // missed the other: a maintainer ANSWERING it. An answered request stayed
  // live, so the same comment kept postdating it. On the next correction head
  // the gate re-read that one old `continue` and admitted the head without a
  // fresh decision, which is the opposite of what asking a human is for.
  const answer = says('continue');

  // Head 1: the answer is obeyed AND the request it answered is closed.
  const first = fakeClient({
    comments: heads(5, P1), sticky: asked(), issueComments: [answer],
  });
  const admitted = await enforceReviewLifecycle(first, pr, 'h');
  assert.equal(admitted.allowed, true);
  assert.equal(admitted.declared, 'continue');

  const recorded = JSON.parse(
    /autonomous-review-metrics:\s*(\{.*\})\s*-->/u.exec(first.calls.sticky[0])[1],
  );
  assert.ok(recorded.lifecycleRequest.consumedAt, 'the answered request is closed');
  assert.match(first.calls.sticky[0], /lifecycle_declared/u);

  // Head 2: the SAME comment must not admit a second critical head.
  const second = fakeClient({
    comments: heads(6, P1),
    sticky: `<!-- autonomous-review-metrics: ${JSON.stringify(recorded)} -->`,
    issueComments: [answer],
  });
  const again = await enforceReviewLifecycle(second, pr, 'h');
  assert.equal(again.allowed, false, 'a spent answer cannot authorise the next head');
  assert.equal(again.state, 'restructure_declaration_required');

  // A NEW answer, posted after the fresh request, works normally.
  const reopened = JSON.parse(
    /autonomous-review-metrics:\s*(\{.*\})\s*-->/u.exec(second.calls.sticky[0])[1],
  );
  const third = fakeClient({
    comments: heads(6, P1),
    sticky: `<!-- autonomous-review-metrics: ${JSON.stringify(reopened)} -->`,
    issueComments: [answer, says('continue', null, new Date().toISOString())],
  });
  assert.equal((await enforceReviewLifecycle(third, pr, 'h')).allowed, true,
    'answering the new request works — the gate is closed, not welded shut');
});

test('W40: the sweep touches ONLY lifecycle blocks', async () => {
  // Round 8 scoped `incomplete` and left `expired` and `answered` unscoped, so
  // an ordinary `review: Codex review timed out after two attempts` could still
  // be woken whenever a lifecycle request happened to be recorded — re-running
  // the whole review loop every fifteen minutes and bypassing the two-attempt
  // cap. Scoping one of three reasons was the same miss as scoping none.
  const { sweepExpiredWindows } = await import('./autonomous-review-gate.mjs');
  const timedOut = [{
    id: 51, context: 'codex-current-head', state: 'failure',
    description: 'review: Codex review timed out after two attempts',
  }];

  // An EXPIRED window on a non-lifecycle failure: not the sweep's to re-run.
  const expired = sweepClient({
    pulls: [{ number: 11, head: { sha: 'h11', ref: 'claude/h' } }],
    sticky: { 11: `<!-- autonomous-review-metrics: ${JSON.stringify({
      lifecycleRequest: { at: '2026-08-01T00:00:00Z', windowMinutes: 180, tier: 'critical' },
    })} -->` },
    statuses: { h11: timedOut },
  });
  expired.issueComments = async () => [];
  assert.equal(
    (await sweepExpiredWindows(expired, { nowIso: '2026-08-01T09:00:00Z', log: () => {} }))
      .woken.length,
    0, 'an expired window does not license re-running a timed-out review',
  );

  // An ANSWER on a non-lifecycle failure: likewise.
  const answered = sweepClient({
    pulls: [{ number: 12, head: { sha: 'h12', ref: 'claude/i' } }],
    sticky: { 12: SWEEP_ASKED },
    statuses: { h12: timedOut },
  });
  answered.issueComments = async () => [{
    user: { login: 'JagPat', type: 'User' }, author_association: 'OWNER',
    created_at: '2026-08-01T00:10:00Z', updated_at: '2026-08-01T00:10:00Z',
    body: '<!-- review-restructure: continue -->',
  }];
  assert.equal(
    (await sweepExpiredWindows(answered, { nowIso: '2026-08-01T00:20:00Z', log: () => {} }))
      .woken.length,
    0, 'nor does an answer, when the block is not a lifecycle wait',
  );

  // The same two signals on a real lifecycle wait ARE still woken.
  const real = sweepClient({
    pulls: [{ number: 13, head: { sha: 'h13', ref: 'claude/j' } }],
    sticky: { 13: SWEEP_ASKED },
    statuses: { h13: blocked(52) },
  });
  real.issueComments = async () => [{
    user: { login: 'JagPat', type: 'User' }, author_association: 'OWNER',
    created_at: '2026-08-01T00:10:00Z', updated_at: '2026-08-01T00:10:00Z',
    body: '<!-- review-restructure: continue -->',
  }];
  assert.equal(
    (await sweepExpiredWindows(real, { nowIso: '2026-08-01T00:20:00Z', log: () => {} }))
      .woken.length,
    1, 'scoping removed the false positives without losing the fix',
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
