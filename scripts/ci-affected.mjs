// Owner decision 2026-10-08 (rule 7): a pull request runs only the product jobs its files can affect;
// the push to main runs the full battery.
//
// ONE function, read by both sides: `ci-battery-plan.mjs` decides which product jobs this CI run launches,
// and the merge gate (`requiredChecksForPullRequest`) requires exactly those. They cannot disagree, so a
// job skipped as unaffected is never waited on, and a job the gate requires is never skipped as
// unaffected. Every uncertainty — an unreadable or empty file list, a path no rule names — fails toward
// the full battery.
//
// This is not the withdrawn risk classifier (docs/reviews/pr-263-convergence.md): nothing here reads prior
// evidence or defers to an earlier run. An unaffected job is simply not part of this PR's contract.

import { PRODUCT_CHECKS } from './review-policy.mjs';

const WEB = ['web', 'e2e', 'api-e2e'];
const API = ['api', 'api-e2e'];
const MIGRATION = ['api', 'api-e2e', 'upgrade-proof'];

// First match wins. `products: []` means the always-on `automation` job covers the path.
const RULES = [
  // Codex 4214321813 — a document a product test reads is product input: the API integration suite asserts
  // the archived runbook's operator procedures (phase4-t3-correction3.test.ts)
  { pattern: /^docs\/archive\/RUNBOOK-[^/]+\.md$/u, products: ['api'], proofs: false },
  { pattern: /^docs\//u, products: [], proofs: false },
  { pattern: /^[^/]+\.md$/u, products: [], proofs: false },
  { pattern: /^\.claude\//u, products: [], proofs: false },
  // Codex 4214270280 — a root script a product consumes is product code. build-info.mjs runs in the web
  // (Vite) build and the API image build; the drain-clearance gate and everything it imports run in an API
  // unit test (drain-evidence.test.ts). `ci-affected.test.mjs` recomputes this set from the imports in
  // apps/ and packages/, so a new consumer cannot silently fall through to automation-only.
  { pattern: /^scripts\/build-info\.(?:mjs|d\.mts)$/u, products: ['web', 'e2e', 'api', 'api-e2e'], proofs: false },
  {
    pattern: /^scripts\/(?:autonomous-drain-clearance|autonomous-status-state|review-efficiency|review-policy|lineage-policy|correction-owner|zip-entry)\.mjs$/u,
    products: ['api'],
    proofs: false,
  },
  { pattern: /^scripts\/[^/]+\.mjs$/u, products: [], proofs: false },
  { pattern: /^apps\/web\//u, products: WEB, proofs: false },
  { pattern: /^apps\/api\/(?:prisma|scripts)\//u, products: MIGRATION, proofs: true },
  { pattern: /^apps\/api\//u, products: API, proofs: false },
];

/**
 * `{ products, runnerProofs, full, reason }` for a PR's changed files (strings or `{ filename }`).
 * `full` is true when the whole battery runs, including the production-runner proofs.
 */
export function affectedProducts(files) {
  const all = { products: [...PRODUCT_CHECKS], runnerProofs: true, full: true };
  if (!Array.isArray(files) || files.length === 0) {
    return { ...all, reason: 'changed files unavailable; failing toward the full battery' };
  }
  const products = new Set();
  let runnerProofs = false;
  for (const file of files) {
    // Codex 4213960372 — a rename affects BOTH packages: the one it leaves and the one it enters
    const paths = typeof file === 'string'
      ? [file]
      : [file?.filename, ...(file?.previous_filename ? [file.previous_filename] : [])];
    for (const path of paths) {
      const rule = typeof path === 'string' ? RULES.find(({ pattern }) => pattern.test(path)) : undefined;
      if (!rule) return { ...all, reason: `${path ?? 'an unnamed file'} is outside the per-package rules; full battery` };
      for (const product of rule.products) products.add(product);
      runnerProofs ||= rule.proofs;
    }
  }
  const ordered = PRODUCT_CHECKS.filter((name) => products.has(name));
  return {
    products: ordered,
    runnerProofs,
    full: false,
    reason: ordered.length === 0
      ? 'docs/automation only; the automation job covers it'
      : `affected: ${ordered.join(', ')}${runnerProofs ? ' + runner proofs' : ''}`,
  };
}
