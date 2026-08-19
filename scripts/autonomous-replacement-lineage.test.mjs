// Who owes the unresolved scope of an exhausted review unit, and how that debt
// is settled.
//
// The gate refuses every pull request in this repository, so the rule is worth
// pinning directly. Two designs have already failed here:
//
//   - Matching only a merge that names the exhausted unit STRANDS the debt the
//     moment a replacement dies unmerged. On 2026-08-18 #354 exhausted, #360
//     replaced it and exhausted too, and #361 replaced #360 — nothing would ever
//     name #354 again, and every `Replaces: none` unit in the repository was
//     refused until the label was cleared by hand, three times in one night.
//   - Following the chain instead trusts pull request BODIES, which anyone who
//     can edit a pull request can rewrite. An unrelated unit that exhausted its
//     own rounds can have `Replaces: #354` written into it afterwards, and a
//     merged replacement of that unit discharges scope it never carried.
//     Ordering by number or by closing time narrows the window without ever
//     proving when the declaration was written.
//
// The obligation MOVES instead. The trusted controller hands the label to the
// claiming unit at the moment it admits the claim, so at every moment exactly
// one live unit holds each debt, and it holds it because the controller put it
// there. T1-T3 pin the transfer, T4-T6 pin what it refuses.
import test from 'node:test';
import assert from 'node:assert/strict';

import { LEGACY_SETTLED_OBLIGATIONS, assessReplacementLineage } from './review-efficiency.mjs';
import * as reviewGate from './autonomous-review-gate.mjs';

function pr(number, { state = 'closed', merged = false, replaces = null } = {}) {
  return {
    number,
    state,
    merged_at: merged ? '2026-08-18T00:00:00Z' : null,
    body: `## Objective\n\nReplaces: ${replaces === null ? 'none' : `#${replaces}`}\n`,
  };
}

// `labelled` is what carries the `review-replacement-required` label right now.
const lineage = (pullRequest, labelled, all = [], claimantExhausted = true) =>
  assessReplacementLineage({
    pullRequest,
    requiredReplacements: labelled.map((source) => ({ pullRequest: source })),
    replacementPullRequests: [...all, pullRequest],
    // Whether the claimant reached the review-round limit on its own heads. The
    // default is the refusing answer, so a fixture that does not say assumes the
    // unit owes its own scope.
    claimantExhausted,
  });

test('T1: claiming an exhausted unit names the obligation to hand over', () => {
  const exhausted = pr(354);
  const claim = pr(360, { state: 'open', replaces: 354 });

  const result = lineage(claim, [exhausted], [exhausted]);
  assert.equal(result.allowed, true);
  assert.equal(result.transferFrom, 354, 'the caller is told which debt moves');
});

test('T2: once the debt has moved, its holder is not asked to claim it again', () => {
  // The state after the controller transferred: #354 no longer holds the label,
  // #360 does. #360's body still says `Replaces: #354`, and re-reading it must
  // not refuse the very unit the controller admitted.
  const claim = pr(360, { state: 'open', replaces: 354 });
  const result = lineage(claim, [claim], [pr(354)]);
  assert.equal(result.allowed, true);
  assert.equal(result.transferFrom, null, 'nothing left to move');
});

test('T3: a chain of dead replacements never strands the debt', () => {
  // The 2026-08-18 shape, replayed under transfer. #354 exhausted, #360 claimed
  // it and exhausted too, #361 claimed #360. The debt is on #361 alone: #354 and
  // #360 gave theirs away when their successors were admitted, and no walk over
  // anybody's body is involved.
  const live = pr(361, { state: 'open', replaces: 360 });
  const history = [pr(354), pr(360, { replaces: 354 })];

  assert.equal(lineage(live, [live], history).allowed, true);
  // A merge settles it, and fresh work is free — the state the old rule could
  // never reach without a human deleting a label.
  const merged = pr(361, { merged: true, replaces: 360 });
  assert.equal(lineage(pr(400, { state: 'open' }), [merged], history).allowed, true);
});

test('T4: an obligation still held blocks fresh work, open or closed', () => {
  const fresh = pr(400, { state: 'open' });
  for (const holder of [pr(360, { state: 'open', replaces: 354 }), pr(360, { replaces: 354 })]) {
    const result = lineage(fresh, [holder], [pr(354)]);
    assert.equal(result.allowed, false, `${holder.state} holder must still block`);
    assert.match(result.detail, /exhausted PR #360 still requires a replacement/u);
  }
});

test('T5: an edited body cannot discharge an obligation', () => {
  // The forgery both earlier designs admitted: #360 exhausted its OWN review
  // rounds, closed, and had `Replaces: #354` written into it afterwards; #361
  // merged naming #360. Under a body-derived rule that discharges #354. Here the
  // label on #354 was never handed anywhere, so #354 still owes the work — and
  // no editable text can change that.
  const forged = pr(360, { replaces: 354 });
  const merged = pr(361, { merged: true, replaces: 360 });
  const fresh = pr(400, { state: 'open' });

  const result = lineage(fresh, [pr(354)], [forged, merged]);
  assert.equal(result.allowed, false);
  assert.match(result.detail, /exhausted PR #354 still requires a replacement/u);

  // Naming it directly fails for the same reason: a merged body is editable too.
  const direct = pr(361, { merged: true, replaces: 354 });
  assert.equal(lineage(fresh, [pr(354)], [direct]).allowed, false);
});

test('T6: two units cannot claim one obligation', () => {
  const exhausted = pr(354);
  const first = pr(360, { state: 'open', replaces: 354 });
  const second = pr(361, { state: 'open', replaces: 354 });

  // Before the transfer, the second claimant is refused as competing.
  const competing = lineage(second, [exhausted], [exhausted, first]);
  assert.equal(competing.allowed, false);
  assert.match(competing.detail, /already claimed by open PR #360/u);

  // After it, there is no obligation left for the second to claim at all.
  const afterTransfer = lineage(second, [first], [exhausted, first]);
  assert.equal(afterTransfer.allowed, false);
  assert.match(afterTransfer.detail, /#354 does not name a review unit awaiting replacement/u);
});

test('T7: the controller hands the label over when it admits the claim', async () => {
  // The transfer is the durable record, so it has to actually happen — and in
  // the safe order: the claimant holds the debt before the exhausted unit lets
  // it go, so no moment exists in which nothing holds it.
  const head = 'a'.repeat(40);
  const claim = {
    number: 360,
    additions: 40,
    deletions: 0,
    changed_files: 2,
    state: 'open',
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
    async pullRequestFiles() { return [{ filename: 'scripts/review-efficiency.mjs' }]; },
    async replacementLineage() {
      return {
        requiredReplacements: [{ pullRequest: pr(354) }],
        replacementPullRequests: [pr(354), claim],
      };
    },
    async markReplacementRequired(number) { calls.push(['add', number]); },
    async transferReplacementObligation(source, target) {
      await this.markReplacementRequired(target);
      calls.push(['remove', source]);
    },
    async setDraft(live, draft) { return { ...live, draft }; },
    async setStatus(...args) { calls.push(['status', ...args]); },
    async updateStickyComment() { calls.push(['sticky']); },
  };

  const result = await reviewGate.enforceReviewScope(client, claim, head);
  assert.equal(result.allowed, true, result.detail ?? '');
  assert.deepEqual(calls, [['add', 360], ['remove', 354]]);
});

test('T8: a refused claim moves nothing', async () => {
  // The debt moves only when the claim is admitted. A unit whose scope fails for
  // any other reason has not been admitted, and taking the label off the
  // exhausted unit there would discharge a debt nobody has picked up.
  const head = 'b'.repeat(40);
  const oversized = {
    number: 360,
    additions: 4_000,
    deletions: 0,
    changed_files: 40,
    state: 'open',
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
    async markReplacementRequired(number) { calls.push(['add', number]); },
    async transferReplacementObligation(source) { calls.push(['remove', source]); },
    async setDraft(live, draft) { return { ...live, draft }; },
    async setStatus() {},
    async updateStickyComment() {},
  };

  const result = await reviewGate.enforceReviewScope(client, oversized, head);
  assert.equal(result.allowed, false);
  assert.deepEqual(calls, []);
});

test('L1: the labels the previous rule left behind do not block the repository', () => {
  // Under the rule this replaces, the label stayed on the exhausted unit and a
  // merged pull request naming it discharged the debt. Reading a label as a live
  // obligation without migrating that state blocks every `Replaces: none` unit
  // for good: #344's replacement #349 MERGED, so nothing will ever transfer
  // #344's label, and the merged unit cannot run the transfer path either.
  const fresh = pr(400, { state: 'open' });
  const legacy = [...LEGACY_SETTLED_OBLIGATIONS].map((number) => pr(number));

  assert.equal(
    lineage(fresh, legacy, [pr(349, { merged: true, replaces: 344 })]).allowed,
    true,
    'the migrated labels are history, not a live debt',
  );

  // The migration is those numbers and nothing else. A label this change did not
  // inherit is a live obligation, whatever its body or its claimants say.
  const current = lineage(fresh, [...legacy, pr(380)], [pr(381, { merged: true, replaces: 380 })]);
  assert.equal(current.allowed, false);
  assert.match(current.detail, /exhausted PR #380 still requires a replacement/u);
});

test('L2: a unit already owing scope cannot take on a second obligation', () => {
  // #360 exhausted its own review rounds and holds the label for that. Editing
  // its body to claim #354 as well would hand it a debt it is not carrying: the
  // label is a boolean, both obligations collapse into it, and merging #360
  // would discharge #354's unresolved scope along with its own.
  const exhausted = pr(354);
  const alreadyOwing = pr(360, { state: 'open', replaces: 354 });

  const result = lineage(alreadyOwing, [exhausted, alreadyOwing], [exhausted]);
  assert.equal(result.allowed, false);
  assert.match(result.detail, /PR #360 already carries a replacement obligation/u);
  assert.match(result.detail, /cannot also take on #354/u);

  // The claimant that was HANDED #354's debt is the same shape minus the pending
  // source, and it must still pass — that is T2, and this refusal must not eat it.
  assert.equal(lineage(alreadyOwing, [alreadyOwing], [exhausted]).allowed, true);
});

test('L3: an interrupted transfer is finished, not treated as a second debt', () => {
  // A label move is two calls, and the second can fail: the claimant holds the
  // debt and the source has not let go. The state is identical to a unit
  // absorbing a second obligation, and refusing it — as L2 must — would mean the
  // transfer is never retried and the loop stays blocked until someone repairs
  // the labels by hand.
  //
  // The two histories differ in one durable, already-recorded fact: a unit that
  // owes its OWN scope reached the review-round limit on its own heads.
  const exhausted = pr(354);
  const claimant = pr(360, { state: 'open', replaces: 354 });
  const bothLabelled = [exhausted, claimant];

  const resumed = lineage(claimant, bothLabelled, [exhausted], false);
  assert.equal(resumed.allowed, true, 'a claimant that never exhausted is mid-transfer');
  assert.equal(resumed.transferFrom, 354, 'naming the source again finishes the removal');

  // The same state, from a unit that DID exhaust its own rounds, is L2's refusal.
  const absorbing = lineage(claimant, bothLabelled, [exhausted], true);
  assert.equal(absorbing.allowed, false);
  assert.match(absorbing.detail, /already carries a replacement obligation/u);
});

test('L4: the controller reads that fact only when this unit holds the label', async () => {
  // The discriminator costs an API call, so it is read in the one state that
  // needs it — and an unreadable history keeps the refusing answer rather than
  // completing a transfer that may never have started.
  const head = 'c'.repeat(40);
  const body = [
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
  ].join('\n');
  const claimant = {
    number: 360,
    additions: 40,
    deletions: 0,
    changed_files: 2,
    state: 'open',
    draft: true,
    html_url: 'https://github.com/JagPat/PMCvitan/pull/360',
    head: { sha: head },
    body,
  };

  const run = async ({ labelled, comments = [], reviews = [], failHistory = false }) => {
    const calls = [];
    const client = {
      async pullRequest() { return claimant; },
      async pullRequestFiles() { return [{ filename: 'scripts/review-efficiency.mjs' }]; },
      async replacementLineage() {
        return {
          requiredReplacements: labelled.map((source) => ({ pullRequest: source })),
          replacementPullRequests: [pr(354), claimant],
        };
      },
      async reviewComments() {
        calls.push(['history']);
        if (failHistory) throw new Error('GitHub 502');
        return comments;
      },
      async reviews() { return reviews; },
      async markReplacementRequired(number) { calls.push(['add', number]); },
      async transferReplacementObligation(source, target) {
        await this.markReplacementRequired(target);
        calls.push(['remove', source]);
      },
      async setDraft(live, draft) { return { ...live, draft }; },
      async setStatus() {},
      async updateStickyComment() {},
    };
    const result = await reviewGate.enforceReviewScope(client, claimant, head);
    return { result, calls };
  };

  // Ordinary claim: this unit holds no label, so the history is never read.
  const plain = await run({ labelled: [pr(354)] });
  assert.equal(plain.result.allowed, true, plain.result.detail ?? '');
  assert.deepEqual(plain.calls, [['add', 360], ['remove', 354]]);

  // Both labelled, no finding-bearing head of its own: the transfer resumes.
  const interrupted = await run({ labelled: [pr(354), claimant] });
  assert.equal(interrupted.result.allowed, true, interrupted.result.detail ?? '');
  assert.deepEqual(interrupted.calls, [['history'], ['add', 360], ['remove', 354]]);

  // Both labelled, and this unit reached the round limit on two of its own
  // heads: it owes its own scope and cannot take on another.
  const twoHeads = [
    { commit_id: 'd'.repeat(40), user: { login: 'chatgpt-codex-connector[bot]' }, body: 'P1 one' },
    { commit_id: 'e'.repeat(40), user: { login: 'chatgpt-codex-connector[bot]' }, body: 'P1 two' },
  ];
  const owing = await run({ labelled: [pr(354), claimant], comments: twoHeads });
  assert.equal(owing.result.allowed, false);
  assert.match(owing.result.detail, /already carries a replacement obligation/u);
  assert.deepEqual(owing.calls, [['history']], 'nothing is moved');

  // Unreadable history refuses rather than guessing.
  const unreadable = await run({ labelled: [pr(354), claimant], failHistory: true });
  assert.equal(unreadable.result.allowed, false);
  assert.deepEqual(unreadable.calls, [['history']]);
});
