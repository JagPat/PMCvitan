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
