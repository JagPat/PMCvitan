import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Phase-5 HAND-OFF FACTS — the open questions PR #318 kept answering with prose.
 *
 * Three finding-bearing heads on a docs-only diff, and every finding was the same shape: the
 * record claimed something about this repository that the repository did not support. Prose is
 * the wrong instrument for that class of claim — it cannot fail. These probes can.
 *
 * Each one pins a fact the Phase-5 hand-off asserts, so 7B-v and 7B-vi cannot start from a
 * description that has drifted from the code. Two of them deliberately pin an ABSENCE: they are
 * expected to be edited by the unit that closes the gap, and the assertion messages say so.
 */

// `import.meta.dirname` lands in Node 20.11, and this package declares `>=20` — on 20.0–20.10 it
// is undefined and `join(undefined, '..')` throws before a single probe runs. CI happens to use
// Node 22, so the gate would never have shown it.
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(root, p), 'utf8');

test('the parked hand-off ledgers are reachable on this branch, not only on their park branches', () => {
  // Finding 2 on head 2473a71: the packet cited both of these while neither existed here. A
  // hand-off that lives only on the branch it hands off from is not a hand-off.
  for (const f of [
    'docs/reviews/phase-5-t7b-v-parked-findings.md',
    'docs/reviews/phase-5-t7b-vi-parked-findings.md',
  ]) {
    assert.ok(existsSync(join(root, f)), `${f} is cited by the Phase-5 packet and must exist here`);
  }
});

test('each parked ledger names its park BRANCH, not "this branch"', () => {
  // Finding 4 (self-caught): the phrase was true where the notes were written and false once they
  // moved. A single-line grep missed one instance because it wrapped, so this checks the whole text.
  const cases = [
    ['docs/reviews/phase-5-t7b-v-parked-findings.md', 'claude/phase5-task7b-v-sod-payment-parked'],
    ['docs/reviews/phase-5-t7b-vi-parked-findings.md', 'claude/phase5-task7b-vi-advance-parked'],
  ];
  for (const [file, branch] of cases) {
    const text = read(file);
    assert.ok(text.includes(branch), `${file} must name its park branch explicitly`);
    assert.ok(
      !/\bthis\s+branch\b/iu.test(text.replace(/\s+/gu, ' ')),
      `${file} still says "this branch" — false wherever it is read from`,
    );
  }
});

test('7B-vi is OPEN: the advance LIST read does not exist (pins the gap, not the wish)', () => {
  // Findings 3 and 4: the packet twice claimed this read was delivered. It was removed with the
  // control in the 7B-iv split, which is why 7B-vi must land the read BEFORE the control — the
  // advance coalesce key has no settling read without it.
  //
  // WHEN 7B-vi LANDS THE READ, THIS PROBE MUST BE INVERTED, and the packet's §H/§M/§5 lines and
  // the 7B-vi ledger updated with it. That coupling is the point: the record moves with the code.
  // Matched by SHAPE over every commercial controller, not by one string spelling: a route
  // restored as a constant, an array decorator, double quotes, backticks, or in a sibling
  // read-only controller would otherwise leave this absence probe green while the read exists.
  const controllers = readdirSync(join(root, 'apps/api/src/commercial'))
    .filter((f) => f.endsWith('.controller.ts'))
    .map((f) => read(join('apps/api/src/commercial', f)));
  const QUOTE = '[\'"`]';
  const advanceRoute = (verb) => new RegExp(
    `@${verb}\\(\\s*(?:\\[[^\\]]*)?${QUOTE}[^'"\`]*commercial/advances`, 'u',
  );
  assert.ok(
    controllers.some((c) => advanceRoute('Post').test(c)),
    'paying an advance is delivered; if this fails the §H claim in the packet is wrong',
  );
  assert.ok(
    !controllers.some((c) => advanceRoute('Get').test(c)),
    'the advance LIST read now exists — invert this probe and update the packet §H/§M/§5 + the 7B-vi ledger',
  );
  assert.ok(
    !read('apps/api/src/commercial/commercial-deduction.service.ts').includes('listAdvances'),
    'listAdvances is back — the packet still describes the read as parked with 7B-vi',
  );
});

test('7B-v is OPEN: the payment-rule grant is not guarded to the certifier at ISSUE time', () => {
  // Finding 5, verified in the service rather than inferred. `approve()` consumes a
  // `certifier-may-not-approve` grant only when `certificate.certifiedById === actor`, but
  // `commercial.sod.grant` checks only that the excused actor holds STANDING for the act. So a pmc
  // can record a grant naming any approver and it can never be spent.
  //
  // The guard belongs at ISSUE, in `commercial.sod.grant` — `approve()` already has its half, and
  // adding a second check there would fix nothing. 7B-v turns this probe around.
  const cert = read('apps/api/src/commercial/commercial-certification.service.ts');
  // `indexOf` returns -1 when the literal moves, and `slice(-1)` is the LAST CHARACTER rather than
  // an empty string — so a length check alone would pass, and the absence assertion below would
  // pass vacuously, in exactly the refactor this probe exists to catch. Locate explicitly.
  const at = cert.indexOf("commandType: 'commercial.sod.grant'");
  assert.ok(
    at >= 0,
    'the grant command literal moved or was hoisted — this probe can no longer see the command it '
    + 'adjudicates; re-derive where the 7B-v guard belongs before trusting a green run',
  );
  // The extent is DERIVED: from the command literal to the next method at class indent. The
  // previous version used a 4,000-character window against a body measuring 7,247 — so a guard
  // added in the natural place, after the existing standing check, left this probe GREEN and the
  // hand-off still saying the gap was open. An arbitrary window is not a boundary.
  const end = cert.indexOf('\n  async ', at);
  const grantBody = cert.slice(at, end < 0 ? undefined : end);
  assert.ok(
    grantBody.length > 1000,
    'the grant command body could not be bounded — re-derive this probe before trusting it',
  );
  assert.ok(
    !/certifiedById/u.test(grantBody),
    'the grant command now consults certifiedById — 7B-v has landed its guard, so invert this probe '
    + 'and update the packet §I plus the 7B-v ledger, which both record it as OPEN',
  );
});

test('the Phase-5 packet does not claim a parked surface is delivered', () => {
  // The class, not the instance — findings 3 and 4 were the same sentence in three places, and the
  // round-2 fix corrected only the one the finding pointed at.
  const packet = read('docs/reviews/phase-5-consolidated-review-packet.md');
  for (const claim of [
    /the vendor advances read — after/u,          // §5 fidelity narrative
    /the read was added rather than the key/u,    // §M
    /reading\s+the advance ledger are available/u, // §H
  ]) {
    assert.ok(!claim.test(packet.replace(/\s+/gu, ' ')),
      `the packet asserts a parked surface is delivered: ${claim}`);
  }
});
