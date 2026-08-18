// The replacement LINEAGE gate: which exhausted review units still owe a
// replacement, and therefore whether fresh work may start.
//
// The rule exists because a unit that reached the review-round limit must be
// re-scoped rather than patched again, and nothing else in the loop remembers
// that obligation. It gates EVERY pull request — a `Replaces: none` declaration
// is refused while any exhausted unit is unreplaced — and until this file it had
// no direct test at all.
//
// The defect it was written for is not hypothetical. On 2026-08-18 the
// schedule-dependencies line burned three units: #354 reached the limit, its
// replacement #360 reached the limit too, and #361 replaced #360 in turn.
// Because discharge required a MERGED pull request naming the exhausted number
// EXACTLY, and each replacement named only its immediate predecessor, #354's
// obligation could never be discharged by anything — no future PR would ever
// name it. Every `Replaces: none` unit in the repository was blocked
// indefinitely, including the fix for this defect, and the repository owner had
// to clear the label by hand three times in one night.
import test from 'node:test';
import assert from 'node:assert/strict';

import { assessReplacementLineage } from './review-efficiency.mjs';

function pr(number, { state = 'closed', merged = false, replaces = null, body = null } = {}) {
  return {
    number,
    state,
    merged_at: merged ? '2026-08-18T00:00:00Z' : null,
    body: body ?? `## Objective\n\nReplaces: ${replaces === null ? 'none' : `#${replaces}`}\n`,
  };
}

function lineage(pullRequest, exhausted, all) {
  return assessReplacementLineage({
    pullRequest,
    requiredReplacements: exhausted.map((source) => ({ pullRequest: source })),
    replacementPullRequests: all,
  });
}

test('R1: a replacement that dies unmerged does not strand its predecessor', () => {
  // The live shape from 2026-08-18. #354 exhausted; #360 replaced it and was
  // itself closed unmerged at the limit; #361 replaced #360 and merged.
  const p354 = pr(354);
  const p360 = pr(360, { replaces: 354 });
  const p361 = pr(361, { replaces: 360, merged: true });
  const fresh = pr(400, { state: 'open' });
  const all = [p354, p360, p361, fresh];

  // Merging the end of the chain discharges every unit in it: #361 carries
  // #360's unresolved scope, which carried #354's.
  assert.deepEqual(
    lineage(fresh, [p354, p360], all),
    { allowed: true, detail: null },
    'fresh work is not blocked by an obligation the chain has already discharged',
  );

  // And a longer chain behaves the same way — the rule is transitive, not a
  // special case for one link.
  const p362 = pr(362, { replaces: 361 });
  const p363 = pr(363, { replaces: 362, merged: true });
  assert.equal(
    lineage(fresh, [p354, p360, pr(361, { replaces: 360 }), p362], [
      p354, p360, pr(361, { replaces: 360 }), p362, p363, fresh,
    ]).allowed,
    true,
    'every ancestor of a merged replacement is discharged',
  );
});

test('R2: an undischarged obligation still blocks fresh work', () => {
  // The rule this unit must NOT weaken. An exhausted unit whose chain has not
  // reached a merge is still owed, whether the chain is one link or three.
  const p354 = pr(354);
  const fresh = pr(400, { state: 'open' });

  assert.match(
    lineage(fresh, [p354], [p354, fresh]).detail ?? '',
    /exhausted PR #354 still requires a replacement/u,
    'nothing has replaced it at all',
  );

  const openClaimant = pr(360, { state: 'open', replaces: 354 });
  assert.match(
    lineage(fresh, [p354], [p354, openClaimant, fresh]).detail ?? '',
    /exhausted PR #354 still requires a replacement/u,
    'a replacement in flight is not a replacement merged',
  );

  const deadChain = [p354, pr(360, { replaces: 354 }), pr(361, { replaces: 360 })];
  assert.match(
    lineage(fresh, [p354], [...deadChain, fresh]).detail ?? '',
    /exhausted PR #354 still requires a replacement/u,
    'a chain that died without merging discharges nothing',
  );
});

test('R3: a numbered declaration reads the same discharge rule', () => {
  const p354 = pr(354);
  const p360 = pr(360, { replaces: 354 });
  const p361 = pr(361, { state: 'open', replaces: 360 });

  // #361 legitimately claims #360, which is closed and unreplaced.
  assert.deepEqual(
    lineage(p361, [p354, p360], [p354, p360, p361]),
    { allowed: true, detail: null },
  );

  // Naming a source the chain has already discharged is refused, because it
  // names no live obligation.
  const merged361 = pr(361, { replaces: 360, merged: true });
  const late = pr(400, { state: 'open', replaces: 354 });
  assert.match(
    lineage(late, [p354, p360], [p354, p360, merged361, late]).detail ?? '',
    /does not name a review unit awaiting replacement/u,
  );

  // And two open units cannot claim the same exhausted source.
  const competing = pr(401, { state: 'open', replaces: 360 });
  assert.match(
    lineage(competing, [p354, p360], [p354, p360, p361, competing]).detail ?? '',
    /already claimed by open PR #361/u,
  );
});

test('R4: a self-referential or circular claim terminates and blocks', () => {
  // Nothing prevents a body from naming itself or a cycle, and a graph walk
  // that trusted the data would not return. The obligation stays owed.
  const selfClaim = pr(354, { replaces: 354 });
  const a = pr(360, { replaces: 361 });
  const b = pr(361, { replaces: 360 });
  const fresh = pr(400, { state: 'open' });

  assert.match(
    lineage(fresh, [selfClaim], [selfClaim, fresh]).detail ?? '',
    /exhausted PR #354 still requires a replacement/u,
  );
  assert.match(
    lineage(fresh, [a, b], [a, b, fresh]).detail ?? '',
    /exhausted PR #36[01] still requires a replacement/u,
  );
});
