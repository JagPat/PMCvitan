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

import { assessReplacementLineage } from './review-efficiency.mjs';
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
const lineage = (pullRequest, labelled, all = []) => assessReplacementLineage({
  pullRequest,
  requiredReplacements: labelled.map((source) => ({ pullRequest: source })),
  replacementPullRequests: [...all, pullRequest],
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
