// Owner decision 2026-10-08 (rule 7): affected-package CI on PRs, the full battery on main.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { affectedProducts } from './ci-affected.mjs';
import { PRODUCT_CHECKS, REQUIRED_CHECKS, requiredChecksForPullRequest } from './review-policy.mjs';

test('docs and automation scripts run no product job', () => {
  const result = affectedProducts(['docs/STATUS.md', 'README.md', 'scripts/review-cap.mjs']);
  assert.deepEqual(result.products, []);
  assert.equal(result.runnerProofs, false);
});

test('a web change runs web, e2e and api-e2e only', () => {
  assert.deepEqual(affectedProducts(['apps/web/src/App.tsx']).products, ['web', 'e2e', 'api-e2e']);
});

test('an API source change runs api and api-e2e without the runner proofs', () => {
  const result = affectedProducts([{ filename: 'apps/api/src/x.ts' }]);
  assert.deepEqual(result.products, ['api', 'api-e2e']);
  assert.equal(result.runnerProofs, false);
});

test('a migration runs the upgrade proof and the production-runner proofs', () => {
  const result = affectedProducts(['apps/api/prisma/migrations/1/migration.sql']);
  assert.deepEqual(result.products, ['api', 'api-e2e', 'upgrade-proof']);
  assert.equal(result.runnerProofs, true);
});

test('shared code, workflows, lockfiles, unknown paths and unreadable lists fail toward the full battery', () => {
  for (const files of [
    ['packages/shared/src/index.ts'],
    ['.github/workflows/ci.yml'],
    ['pnpm-lock.yaml'],
    ['scripts/test-api-e2e.sh'],
    [],
    null,
  ]) {
    const result = affectedProducts(files);
    assert.deepEqual(result.products, PRODUCT_CHECKS, String(files));
    assert.equal(result.full, true);
    assert.equal(result.runnerProofs, true);
  }
});

test('the gate requires exactly the affected products, or all when unknown', () => {
  assert.deepEqual(requiredChecksForPullRequest(9_999), REQUIRED_CHECKS);
  assert.deepEqual(
    requiredChecksForPullRequest(9_999, affectedProducts(['apps/web/src/a.ts']).products),
    ['review-scope', 'battery-plan', 'web', 'e2e', 'api-e2e'],
  );
  assert.deepEqual(requiredChecksForPullRequest(9_999, []), ['review-scope', 'battery-plan']);
});

test('ci.yml launches each product job only when the plan lists it, and proofs only on runner_proofs', async () => {
  const ci = await readFile(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
  for (const job of PRODUCT_CHECKS) {
    assert.ok(
      ci.includes(`contains(fromJSON(needs.battery-plan.outputs.products), '${job}')`),
      `${job} is gated on the affected products`,
    );
  }
  assert.equal((ci.match(/if: needs\.battery-plan\.outputs\.runner_proofs == 'true'/gu) ?? []).length, 3);
  assert.match(ci, /products: \$\{\{ steps\.plan\.outputs\.products \}\}/u);
});
