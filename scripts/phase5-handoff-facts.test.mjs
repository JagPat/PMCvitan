import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

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

const root = join(import.meta.dirname, '..');
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
  const controller = read('apps/api/src/commercial/commercial.controller.ts');
  assert.ok(
    controller.includes("@Post('commercial/advances')"),
    'paying an advance is delivered; if this fails the §H claim in the packet is wrong',
  );
  assert.ok(
    !/@Get\('commercial\/advances'\)/u.test(controller),
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
  const grantBody = cert.slice(cert.indexOf("commandType: 'commercial.sod.grant'"));
  assert.ok(grantBody.length > 0, 'the grant command moved — re-derive where its guard belongs');
  assert.ok(
    !/certifiedById/u.test(grantBody.slice(0, 4000)),
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
