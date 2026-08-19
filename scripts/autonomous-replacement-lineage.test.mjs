// Who owes the unresolved scope of an exhausted review unit, and what settles it.
//
// The gate refuses every pull request in this repository, so the rule is worth
// pinning directly. Three designs have already failed here, and each probe below
// is the state that killed one of them:
//
//   - Deriving the chain from `Replaces:` PROSE. Matching only a merge that
//     names the exhausted unit STRANDS the debt when a replacement dies
//     unmerged: on 2026-08-18 #354 exhausted, #360 replaced it and exhausted
//     too, #361 replaced #360, and every fresh unit in the repository was
//     refused until the label was cleared by hand, three times in one night.
//     Following the chain instead trusts bodies, which anyone who can edit a
//     pull request can rewrite.
//   - MOVING one boolean label. It records that a debt was taken on but not
//     WHICH, and moving it is two writes — so an interrupted move and a unit
//     absorbing a second obligation are the same state.
//   - Inferring those apart from the claimant's own review history. It cannot
//     tell a half-finished transfer from a completed transfer of a different
//     source.
//
// A claim label names the source and is one write. `review-replacement-required`
// marks the exhausted unit and never moves; `review-replaces-N` on a claimant is
// the controller's record that it admitted that claim.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  LEGACY_SETTLED_OBLIGATIONS,
  assessReplacementLineage,
  claimsFromTimeline,
} from './review-efficiency.mjs';

import * as reviewGate from './autonomous-review-gate.mjs';

// A unit is opened `number` minutes into the day and closed thirty seconds
// later, so a higher-numbered unit is opened after a lower-numbered one closed —
// the shape of every real replacement here (#374 closed 18:21:34Z, #375 opened
// 18:45:11Z). Fixtures that need another history state it.
const DAY = Date.parse('2026-08-18T00:00:00Z');
const at = (minutes) => new Date(DAY + minutes * 60_000).toISOString();

function pr(number, {
  state = 'closed',
  merged = false,
  replaces = null,
  openedAt = at(number),
  closedAt = state === 'closed' ? at(number + 0.5) : null,
  base = 'main',
} = {}) {
  return {
    number,
    state,
    created_at: openedAt,
    closed_at: closedAt,
    merged_at: merged ? closedAt : null,
    base: { ref: base },
    body: `## Objective\n\nReplaces: ${replaces === null ? 'none' : `#${replaces}`}\n`,
  };
}

// An exhausted unit and the claims the CONTROLLER recorded on it, as resolved
// from its own timeline. A number is shorthand for "recorded shortly after that
// claimant opened".
function exhausted(source, claimants = []) {
  return {
    pullRequest: source,
    claims: claimants.map((claim) => (typeof claim === 'number'
      ? { claimant: claim, recordedAt: at(claim + 1) }
      : claim)),
  };
}

// `labelled` is what carries `review-replacement-required`.
// `labelled` is what carries `review-replacement-required`: either a pull
// request (no claims recorded) or an `exhausted(...)` entry that carries them.
const lineage = (pullRequest, labelled, all = [], containsDefaultHead = true) =>
  assessReplacementLineage({
    pullRequest,
    requiredReplacements: labelled.map((entry) => (entry?.pullRequest
      ? entry
      : { pullRequest: entry, claims: [] })),
    replacementPullRequests: [...all, pullRequest],
    containsDefaultHead,
  });

test('T1: admitting a claim names the obligation to record', () => {
  const exhausted = pr(354);
  const claim = pr(360, { state: 'open', replaces: 354 });

  const result = lineage(claim, [exhausted], [exhausted]);
  assert.equal(result.allowed, true, result.detail ?? '');
  assert.equal(result.claimFor, 354, 'the caller is told which claim to record');
});

test('T2: a recorded claim is re-read, not re-admitted', () => {
  const source = pr(354);
  const claim = pr(360, { state: 'open', replaces: 354 });

  const result = lineage(claim, [exhausted(source, [360])], [source]);
  assert.equal(result.allowed, true, result.detail ?? '');
  assert.equal(result.claimFor, null, 'nothing more to record');
});

test('T3: a chain of dead replacements never strands the debt', () => {
  // The 2026-08-18 shape. #360 claimed #354 and exhausted, #361 claimed #360.
  // Until #361 merges the debt is owed; when it does, the whole chain settles —
  // the state the prose rule could never reach without a human deleting a label.
  const first = pr(354);
  const second = pr(360, { replaces: 354 });
  const owed = [exhausted(first, [360]), exhausted(second, [361])];
  const open = pr(361, { state: 'open', replaces: 360 });
  const fresh = pr(400, { state: 'open' });

  const blocked = lineage(fresh, owed, [first, second, open]);
  assert.equal(blocked.allowed, false);
  assert.match(blocked.detail, /exhausted PR #354 still requires a replacement/u);

  const merged = pr(361, { merged: true, replaces: 360 });
  assert.equal(lineage(fresh, owed, [first, second, merged]).allowed, true);
});

test('T4: an obligation still owed blocks fresh work, open or closed', () => {
  const fresh = pr(400, { state: 'open' });
  for (const claimant of [
    pr(360, { state: 'open', replaces: 354 }),
    pr(360, { replaces: 354 }),
  ]) {
    const result = lineage(fresh, [exhausted(pr(354), [360])], [pr(354), claimant]);
    assert.equal(result.allowed, false, `a ${claimant.state} claimant settles nothing`);
    assert.match(result.detail, /exhausted PR #354 still requires a replacement/u);
  }
});

test('T5: an edited body settles nothing', () => {
  // The forgery every derived rule admitted: #360 exhausted its OWN rounds,
  // closed, and had `Replaces: #354` written into it afterwards; #361 merged
  // naming #360. Nothing here reads those bodies — only claims the controller
  // recorded — so #354 still owes the work.
  const fresh = pr(400, { state: 'open' });
  const forged = pr(360, { replaces: 354 });
  const merged = pr(361, { merged: true, replaces: 360 });

  const result = lineage(fresh, [pr(354)], [forged, merged]);
  assert.equal(result.allowed, false);
  assert.match(result.detail, /exhausted PR #354 still requires a replacement/u);

  // Naming it directly fails the same way: a merged body is editable too.
  const direct = pr(361, { merged: true, replaces: 354 });
  assert.equal(lineage(fresh, [pr(354)], [direct]).allowed, false);
});

test('T6: two units cannot claim one obligation', () => {
  const source = pr(354);
  const first = pr(360, { state: 'open', replaces: 354 });
  const second = pr(361, { state: 'open', replaces: 354 });

  const competing = lineage(second, [exhausted(source, [360])], [source, first]);
  assert.equal(competing.allowed, false);
  assert.match(competing.detail, /already claimed by PR #360/u);
});

test('L1: the labels the previous rule left behind do not block the repository', () => {
  // Under the rule this replaces, the label stayed on the exhausted unit and a
  // merged pull request NAMING it discharged the debt. Those units carry no
  // claim label, so reading claims alone would block every `Replaces: none` unit
  // for good — #344's replacement #349 merged long before claims existed.
  const fresh = pr(400, { state: 'open' });
  const legacy = [...LEGACY_SETTLED_OBLIGATIONS].map((number) => pr(number));

  assert.equal(lineage(fresh, legacy, legacy).allowed, true);

  // The migration is those numbers and nothing else.
  const current = lineage(fresh, [...legacy, pr(380)], [...legacy, pr(381, { merged: true, replaces: 380 })]);
  assert.equal(current.allowed, false);
  assert.match(current.detail, /exhausted PR #380 still requires a replacement/u);
});

test('L2: a recorded claim names its source, so a body cannot redirect it', () => {
  // #360 was admitted as #354's replacement and its claim is recorded. Editing
  // its declaration to a DIFFERENT pending source must not settle that one:
  // merging #360 would then appear to discharge scope it never carried.
  //
  // This is what a boolean label could not express, and what the claimant's own
  // review history could not distinguish — an interrupted transfer and a
  // completed transfer of another source look identical in both.
  const redirected = pr(360, { state: 'open', replaces: 350 });
  const result = lineage(
    redirected,
    [exhausted(pr(350)), exhausted(pr(354), [360])],
    [pr(350), pr(354)],
  );

  assert.equal(result.allowed, false);
  assert.match(result.detail, /admitted as the replacement for #354/u);
  assert.match(result.detail, /cannot also take on #350/u);
  assert.equal(result.claimFor, undefined, 'nothing is recorded for the redirected source');
});

test('L3: a claimant must be a replacement, not an older unit already in flight', () => {
  // An unrelated pull request opened BEFORE the exhausted unit closed can have a
  // source written into it afterwards. The protocol is "close the exhausted
  // unit, then open a smaller replacement from current `main`", and GitHub
  // records both times.
  const source = pr(380, { openedAt: at(100), closedAt: at(300) });

  const older = pr(370, { state: 'open', replaces: 380, openedAt: at(110) });
  const byNumber = lineage(older, [source], [source]);
  assert.equal(byNumber.allowed, false);
  assert.match(byNumber.detail, /a replacement is opened after the unit it replaces/u);

  const inFlight = pr(390, { state: 'open', replaces: 380, openedAt: at(200) });
  const byTime = lineage(inFlight, [source], [source]);
  assert.equal(byTime.allowed, false);
  assert.match(byTime.detail, /close the exhausted unit, then open its replacement/u);

  const replacement = pr(390, { state: 'open', replaces: 380, openedAt: at(310) });
  assert.equal(lineage(replacement, [source], [source]).allowed, true);

  // And from `main`, not stacked on another branch.
  const stacked = pr(391, { state: 'open', replaces: 380, openedAt: at(320), base: 'claude/other' });
  const offBase = lineage(stacked, [source], [source]);
  assert.equal(offBase.allowed, false);
  assert.match(offBase.detail, /opened from `main`/u);
});

test('T7: the controller records the admitted claim, once', async () => {
  const head = 'a'.repeat(40);
  const claim = {
    ...pr(360, { state: 'open', replaces: 354 }),
    additions: 40,
    deletions: 0,
    changed_files: 2,
    draft: true,
    html_url: 'https://github.com/JagPat/PMCvitan/pull/360',
    head: { sha: head },
    body: [
      '<!-- correction-owner: claude -->',
      '## Objective',
      '',
      'Replaces: #354',
      '',
      '- [x] `concurrency-serialization` — n/a',
      '- [x] `old-release-migration-compatibility` — n/a',
      '- [x] `trigger-alternate-writers` — n/a',
      '- [x] `authorization-tenancy` — n/a',
      '- [x] `ci-reproduce-first` — probes RED first',
      '',
    ].join('\n'),
  };
  const calls = [];
  const client = {
    async pullRequest() { return claim; },
    async pullRequestFiles() { return [{ filename: 'scripts/review-efficiency.mjs' }]; },
    async replacementLineage() {
      return {
        requiredReplacements: [{ pullRequest: pr(354) }],
        replacementPullRequests: [pr(354), claim],
      };
    },
    async containsDefaultHead() { return true; },
    async recordReplacementClaim(number, source) { calls.push(['claim', number, source]); },
    async markReplacementRequired(number) { calls.push(['exhaust', number]); },
    async setDraft(live, draft) { return { ...live, draft }; },
    async setStatus(...args) { calls.push(['status', ...args]); },
    async updateStickyComment() { calls.push(['sticky']); },
  };

  const result = await reviewGate.enforceReviewScope(client, claim, head);
  assert.equal(result.allowed, true, result.detail ?? '');
  assert.deepEqual(calls, [['claim', 360, 354]], 'one write, nothing removed');
});

test('T8: a refused claim records nothing', async () => {
  const head = 'b'.repeat(40);
  const oversized = {
    ...pr(360, { state: 'open', replaces: 354 }),
    additions: 4_000,
    deletions: 0,
    changed_files: 40,
    draft: true,
    html_url: 'https://github.com/JagPat/PMCvitan/pull/360',
    head: { sha: head },
    body: '<!-- correction-owner: claude -->\n## Objective\n\nReplaces: #354\n',
  };
  const calls = [];
  const client = {
    async pullRequest() { return oversized; },
    async pullRequestFiles() { return [{ filename: 'scripts/review-efficiency.mjs' }]; },
    async replacementLineage() {
      return {
        requiredReplacements: [{ pullRequest: pr(354) }],
        replacementPullRequests: [pr(354), oversized],
      };
    },
    async containsDefaultHead() { return true; },
    async recordReplacementClaim(...args) { calls.push(['claim', ...args]); },
    async setDraft(live, draft) { return { ...live, draft }; },
    async setStatus() {},
    async updateStickyComment() {},
  };

  const result = await reviewGate.enforceReviewScope(client, oversized, head);
  assert.equal(result.allowed, false);
  assert.deepEqual(calls, []);
});

test('L4: a unit that changed while it was assessed has no claim recorded', async () => {
  // The files, lineage and body are read asynchronously. A head pushed or a
  // declaration edited while those were in flight would otherwise record a claim
  // for scope this controller never assessed — and the recorded claim would then
  // admit that unit on every later evaluation.
  const head = 'c'.repeat(40);
  const assessed = {
    ...pr(360, { state: 'open', replaces: 354 }),
    additions: 40,
    deletions: 0,
    changed_files: 2,
    draft: true,
    html_url: 'https://github.com/JagPat/PMCvitan/pull/360',
    head: { sha: head },
    body: [
      '<!-- correction-owner: claude -->',
      '## Objective',
      '',
      'Replaces: #354',
      '',
      '- [x] `concurrency-serialization` — n/a',
      '- [x] `old-release-migration-compatibility` — n/a',
      '- [x] `trigger-alternate-writers` — n/a',
      '- [x] `authorization-tenancy` — n/a',
      '- [x] `ci-reproduce-first` — probes RED first',
      '',
    ].join('\n'),
  };

  const run = async (live) => {
    const calls = [];
    const client = {
      async pullRequest() { return live; },
      async pullRequestFiles() { return [{ filename: 'scripts/review-efficiency.mjs' }]; },
      async replacementLineage() {
        return {
          requiredReplacements: [{ pullRequest: pr(354) }],
          replacementPullRequests: [pr(354), assessed],
        };
      },
      async containsDefaultHead() { return true; },
      async recordReplacementClaim(...args) { calls.push(['claim', ...args]); },
      async setDraft(live_, draft) { return { ...live_, draft }; },
      async setStatus() {},
      async updateStickyComment() {},
    };
    return { result: await reviewGate.enforceReviewScope(client, assessed, head), calls };
  };

  const pushed = await run({ ...assessed, head: { sha: 'd'.repeat(40) } });
  assert.equal(pushed.result.superseded, true);
  assert.deepEqual(pushed.calls, [], 'a new head is assessed on its own');

  const edited = await run({
    ...assessed,
    body: assessed.body.replace('Replaces: #354', 'Replaces: #350'),
  });
  assert.equal(edited.result.superseded, true);
  assert.deepEqual(edited.calls, []);

  const unchanged = await run(assessed);
  assert.equal(unchanged.result.allowed, true, unchanged.result.detail ?? '');
  assert.deepEqual(unchanged.calls, [['claim', 360, 354]]);
});

test('P1: a label the controller did not write is not a claim', () => {
  // Labels carry no proof of who applied them, and anyone who can manage a pull
  // request here can apply one. Reading the label SET by name would let an
  // author write `review-replaces-354` onto an ineligible unit and skip the
  // pending-source, closure, ordering, base and competing-claim checks entirely.
  //
  // The controller resolves claims from the issue timeline, which records the
  // actor, so a self-applied label leaves `verifiedClaims` empty and the unit is
  // assessed on its merits like any other.
  const source = pr(380, { openedAt: at(100), closedAt: at(300) });
  const selfLabelled = pr(370, {              // older than the source
    state: 'open',
    replaces: 380,
    openedAt: at(110),
  });

  const result = lineage(selfLabelled, [source], [source]);
  assert.equal(result.allowed, false, 'the label alone admits nothing');
  assert.match(result.detail, /a replacement is opened after the unit it replaces/u);

  // And it settles nothing either: a merged unit wearing a self-applied label
  // leaves the obligation exactly where it was.
  const forged = pr(390, { merged: true, replaces: 380 });
  const fresh = pr(400, { state: 'open' });
  const blocked = lineage(fresh, [source], [source, forged]);
  assert.equal(blocked.allowed, false);
  assert.match(blocked.detail, /exhausted PR #380 still requires a replacement/u);
});

test('P2: when two claims race, the earliest recorded one is the claim', () => {
  // Nothing in GitHub makes two label writes mutually exclusive: both runs can
  // read a state with no claim on #354 and both write one. The timeline gives
  // them a total order, so both runs converge on the same answer afterwards
  // without having been serialised.
  const source = pr(354);
  const first = pr(360, { state: 'open', replaces: 354 });
  const second = pr(361, { state: 'open', replaces: 354 });
  const raced = exhausted(source, [
    { claimant: 360, recordedAt: at(500) },
    { claimant: 361, recordedAt: at(501) },
  ]);
  const all = [source, first, second];

  const loser = lineage(second, [raced], all);
  assert.equal(loser.allowed, false);
  assert.match(loser.detail, /was claimed first by PR #360/u);

  const winner = lineage(first, [raced], all);
  assert.equal(winner.allowed, true, winner.detail ?? '');

  // And the loser's merge settles nothing — only the claim that was first does.
  const fresh = pr(400, { state: 'open' });
  const mergedLoser = { ...second, state: 'closed', merged_at: at(600) };
  const stillOwed = lineage(fresh, [raced], [source, first, mergedLoser]);
  assert.equal(stillOwed.allowed, false);
  assert.match(stillOwed.detail, /exhausted PR #354 still requires a replacement/u);
});

test('P3: a replacement is branched from the default branch, not merely aimed at it', () => {
  // `base.ref === 'main'` says where a pull request is going, not where its
  // branch came from. A branch cut from a stale `main` months ago and opened
  // only after the source closed passes number, creation time and base — and
  // merging it would settle the obligation with scope that never carried it.
  const source = pr(380, { openedAt: at(100), closedAt: at(300) });
  const claimant = pr(390, { state: 'open', replaces: 380, openedAt: at(310) });

  const stale = lineage(claimant, [source], [source], false);
  assert.equal(stale.allowed, false);
  assert.match(stale.detail, /built on current `main`; merge `main` into this branch/u);

  const unknown = lineage(claimant, [source], [source], null);
  assert.equal(unknown.allowed, false, 'an unknown comparison is unproven');

  const current = lineage(claimant, [source], [source], true);
  assert.equal(current.allowed, true, current.detail ?? '');
});

test('P4: claims are read from the timeline actor, not the label set', () => {
  // The timeline is the only reading of a claim label that means anything: it is
  // server-written and names who applied each one.
  const claims = claimsFromTimeline([
    { event: 'labeled', label: { name: 'review-replaced-by-360' }, actor: { login: 'a-collaborator' }, created_at: at(10) },
    { event: 'labeled', label: { name: 'review-replaced-by-361' }, actor: { login: 'github-actions[bot]' }, created_at: at(20) },
    { event: 'labeled', label: { name: 'review-replacement-required' }, actor: { login: 'github-actions[bot]' }, created_at: at(40) },
    { event: 'unlabeled', label: { name: 'review-replaced-by-361' }, actor: { login: 'a-collaborator' }, created_at: at(50) },
  ]);

  assert.deepEqual(claims, [{ claimant: 361, recordedAt: at(20) }],
    'the collaborator\'s label is not a claim, and removing the real one does not undo it');
});

test('P5: removing a claim label does not erase the lineage it recorded', () => {
  // The claim is recorded on the EXHAUSTED unit, whose timeline this controller
  // reads for every unit awaiting replacement — so the record is found again
  // whatever the label set now says. Following claim labels instead would mean
  // deleting one displaces an open claimant, and unsettles a merged one so every
  // fresh unit in the repository is blocked again.
  const source = pr(354);
  const claimant = pr(360, { state: 'open', replaces: 354 });
  // Recorded by the controller, then unlabelled by somebody. `claims` is what
  // the timeline still shows.
  const stillRecorded = exhausted(source, [360]);

  const displacing = pr(361, { state: 'open', replaces: 354 });
  const displaced = lineage(displacing, [stillRecorded], [source, claimant]);
  assert.equal(displaced.allowed, false, 'the recorded claimant keeps its claim');
  assert.match(displaced.detail, /already claimed by PR #360/u);

  const merged = pr(360, { merged: true, replaces: 354 });
  const fresh = pr(400, { state: 'open' });
  assert.equal(lineage(fresh, [stillRecorded], [source, merged]).allowed, true,
    'a merged claimant still settles its source');
});
