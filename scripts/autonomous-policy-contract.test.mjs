import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as gate from './autonomous-review-gate.mjs';
import * as scope from './review-efficiency.mjs';
import * as coverage from './check-run-coverage.mjs';
import * as owner from './correction-owner.mjs';
import * as lineage from './lineage-policy.mjs';

test('gate, CI planner and scope consumers use the same canonical policy definitions', async () => {
  const policy = await import('./review-policy.mjs');
  assert.strictEqual(gate.requiredChecksForPullRequest, policy.requiredChecksForPullRequest);
  assert.strictEqual(scope.isRetryableReviewFailureDescription, policy.isRetryableReviewFailureDescription);
  assert.strictEqual(gate.REQUIRED_CHECKS, policy.REQUIRED_CHECKS);
  assert.strictEqual(coverage.PRODUCT_CHECKS, policy.PRODUCT_CHECKS);
  assert.strictEqual(coverage.GATE_CHECKS, policy.GATE_CHECKS);
  assert.deepEqual(gate.REQUIRED_CHECKS, [...coverage.GATE_CHECKS, ...coverage.PRODUCT_CHECKS]);
  assert.strictEqual(scope.REQUIRED_PRE_REVIEW_CHECKS, policy.REQUIRED_PRE_REVIEW_CHECKS);
  assert.strictEqual(scope.REQUIRED_INVARIANTS, policy.REQUIRED_INVARIANTS);
  assert.equal(scope.STANDARD_MAX_FILES, policy.STANDARD_MAX_FILES);
  assert.equal(scope.STANDARD_MAX_CHANGED_LINES, policy.STANDARD_MAX_CHANGED_LINES);
  assert.equal(lineage.LINEAGE_BASE_REF, policy.LINEAGE_BASE_REF);
});

test('owner admission and routing share the canonical supported and awakenable owners', async () => {
  const policy = await import('./review-policy.mjs');
  assert.strictEqual(owner.CORRECTION_OWNERS, policy.CORRECTION_OWNERS);
  assert.strictEqual(owner.AWAKENABLE_FROM_GITHUB, policy.AWAKENABLE_FROM_GITHUB);
  for (const name of policy.CORRECTION_OWNERS) {
    const declaration = owner.parseCorrectionOwner(`<!-- correction-owner: ${name} -->`);
    assert.equal(declaration.state, 'declared');
    const routed = owner.correctionRouting({ declaration, head: 'a'.repeat(40), reason: 'review' });
    assert.equal(routed.owner, name);
    assert.equal(routed.awakenable, policy.AWAKENABLE_FROM_GITHUB.has(name));
  }
  assert.equal(owner.parseCorrectionOwner('<!-- correction-owner: unknown -->').state, 'invalid');
});

test('all agent entrypoints require the canonical contract instead of embedding competing rules', async () => {
  for (const path of ['../AGENTS.md', '../CLAUDE.md']) {
    const text = await readFile(new URL(path, import.meta.url), 'utf8');
    assert.match(text, /Read \[docs\/POLICY\.md\]/u);
    assert.ok(text.length < 2000, `${path} is an entrypoint, not another policy copy`);
  }
  const contract = await readFile(new URL('../docs/POLICY.md', import.meta.url), 'utf8');
  assert.match(contract, /Keep unresolved PRs open/u);
  assert.match(contract, /Deployed migrations are immutable/u);
  assert.match(contract, /OPERATOR-ATTESTATION/u);
  assert.match(contract, /scripts\/review-policy\.mjs/u);
});

test('AGENTS.md review guidelines scope ownership findings to the exact PR head commit', async () => {
  // Codex reviews a merge checkout and kept reporting a missing `Correction-Owner` trailer on merge
  // commits that are not in the PR (#629; #630 on cdda658, 02b9392 and ed7c2cc). The note must name the
  // one commit the gate reads, and the gate must still read exactly that commit.
  const agents = await readFile(new URL('../AGENTS.md', import.meta.url), 'utf8');
  const guidelines = agents.slice(agents.indexOf('## Review guidelines'));
  assert.ok(agents.includes('## Review guidelines'));
  for (const rule of [/head\s+commit \(`head\.sha`\)/u, /refs\/pull\/<n>\/merge/u, /`HEAD\^2` on a merge checkout/u, /docs\/POLICY\.md/u]) {
    assert.match(guidelines, rule);
  }
  // An entrypoint procedure, not a policy copy: it states no rule about which check reads what.
  assert.doesNotMatch(guidelines, /review-scope|shaMergeAuthority|merge gate/u);
  const gate = await readFile(new URL('./autonomous-review-gate.mjs', import.meta.url), 'utf8');
  assert.match(gate, /readShaMergeVerdict\(client, expectedHead\)/u);
  const owner = await import('./correction-owner.mjs');
  assert.equal(owner.shaMergeAuthority('Merge 02b9392 into 816e414').mergeEligible, false);
  assert.equal(owner.shaMergeAuthority('fix\n\nCorrection-Owner: claude\n').owner, 'claude');
});

test('the rubric and POLICY stay within their line budgets and name the executable probes', async () => {
  const lines = (text) => text.replace(/\n$/u, '').split('\n').length;
  const rubric = await readFile(new URL('../docs/REVIEW_RUBRIC.md', import.meta.url), 'utf8');
  const contract = await readFile(new URL('../docs/POLICY.md', import.meta.url), 'utf8');
  assert.ok(lines(rubric) <= 120, `REVIEW_RUBRIC.md is ${lines(rubric)} lines; the cap is 120`);
  assert.ok(lines(contract) <= 275, `POLICY.md is ${lines(contract)} lines; the reform may not grow the contract past its 275-line base`);
  for (const rule of [/REVIEW_RUBRIC\.md/u, /THIRD distinct/u, /mints no\s+obligation from the count/u, /no label or gate state reads a dispute/u]) assert.match(contract, rule);
  // no machinery reads a dispute label, so neither document may promise one; deployed-byte immutability is never claimed for rerunTwice
  for (const text of [contract, rubric]) assert.doesNotMatch(text, /disputed-finding/u);
  assert.match(rubric, /git diff --name-only <base>\.\.\.HEAD -- apps\/api\/prisma\/migrations\//u);
  assert.match(rubric, /replay only: `rerunTwice`/u);
  for (const helper of ['pairingMatrix', 'lockOrderProbe', 'rerunTwice', 'noOpUpdateProbe', 'whitespaceCheckProbe']) assert.match(rubric, new RegExp(helper, 'u'));
  // a probe the rubric names but probes.ts does not yet export must say which unit brings it; a probe it exports must not be deferred
  const probesSource = await readFile(new URL('../apps/api/test/invariants/probes.ts', import.meta.url), 'utf8');
  for (const helper of ['pairingMatrix', 'lockOrderProbe', 'rerunTwice', 'noOpUpdateProbe', 'whitespaceCheckProbe']) {
    const exported = new RegExp(`export async function ${helper}\\b`, 'u').test(probesSource);
    const deferred = new RegExp('`' + helper + '` (?:arrives in|\\(arrives in) (?:its own unit, )?`reform-\\w+`', 'u').test(rubric);
    assert.ok(exported !== deferred, `${helper}: exported=${exported} deferred=${deferred}; exactly one must hold`);
  }
  // the four negatives every writer branch owes are named identically by the rubric and by the helper that enforces them
  const probes = await readFile(new URL('../apps/api/test/invariants/probes.ts', import.meta.url), 'utf8');
  const owed = ['missing-counterpart', 'wrong-identity', 'wrong-audience', 'wrong-actor'];
  assert.match(probes, new RegExp(`REQUIRED_NEGATIVES = \\[${owed.map((n) => `'${n}'`).join(', ')}\\] as const`, 'u'));
  for (const name of owed) assert.match(rubric, new RegExp(`\`${name}\``, 'u'));
});
