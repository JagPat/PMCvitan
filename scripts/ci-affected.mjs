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

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

import { PRODUCT_CHECKS } from './review-policy.mjs';

const WEB = ['web', 'e2e', 'api-e2e'];
const API = ['api', 'api-e2e'];
const MIGRATION = ['api', 'api-e2e', 'upgrade-proof'];

// First match wins. `products: []` means the always-on `automation` job covers the path.
const RULES = [
  // Codex 4214321813 / 4218299974 — a document a product test reads is product input: the API integration
  // suite asserts the live runbook's operator procedures (phase4-t3-correction3.test.ts).
  // `ci-affected.test.mjs` finds every document a product source reads, so a new one cannot fall through.
  { pattern: /^docs\/RUNBOOK\.md$/u, products: ['api'], proofs: false },
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
  // `proofs: 'runner-source'` — the production-runner proofs run when the file is in `runnerSources`
  // (Codex 4218299993); see `runnerSourceClosure`
  { pattern: /^apps\/api\/src\//u, products: API, proofs: 'runner-source' },
  // Codex 4219073959 — the proofs are skipped only for what they PROVABLY never build or execute: the
  // API's tests, their runner configs and its README. Every other API path — tsconfig*, package.json,
  // the Dockerfile, anything new — can change what `migrate.sh` runs, so it runs the proofs. (Three
  // findings on this PR were the same root: a list of what needs the proofs is incomplete by
  // construction; the list of what provably does not is the one that can be closed.)
  { pattern: /^apps\/api\/(?:test\/|vitest(?:\.[a-z]+)?\.config\.ts$|README\.md$)/u, products: API, proofs: false },
  { pattern: /^apps\/api\//u, products: API, proofs: true },
];

const API_SCRIPTS = 'apps/api/scripts';

/**
 * Codex 4218299993 — the API sources the production-runner proofs execute: every compiled CLI that
 * `migrate.sh` or a runner proof invokes (`dist/<path>.js` outside a comment in `apps/api/scripts/*.sh`), and every source
 * those CLIs import, transitively. A change to any of them runs the proofs. Read from the checkout under
 * test, so a new import into a CLI is covered by the same run that adds it. Repo-relative paths.
 */
export function runnerSourceClosure(root) {
  const src = join(root, 'apps/api/src');
  const seen = new Set();
  const resolveSource = (base) => {
    for (const candidate of [`${base}.ts`, join(base, 'index.ts'), base]) {
      if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
    }
    return null;
  };
  const visit = (file) => {
    if (seen.has(file)) return;
    seen.add(file);
    const text = readFileSync(file, 'utf8');
    for (const match of text.matchAll(/(?:from\s+|import\(\s*|require\(\s*)['"](\.{1,2}\/[^'"]+)['"]/gu)) {
      const target = resolveSource(resolve(dirname(file), match[1].replace(/\.js$/u, '')));
      if (target) visit(target);
    }
  };
  const dir = join(root, API_SCRIPTS);
  let entries = 0;
  for (const name of readdirSync(dir).filter((n) => n.endsWith('.sh'))) {
    // a comment naming an artifact (`# … before node dist/main.js accepts …`) invokes nothing
    const script = readFileSync(join(dir, name), 'utf8').split('\n').filter((line) => !/^\s*#/u.test(line)).join('\n');
    for (const match of script.matchAll(/\bdist\/([A-Za-z0-9_./-]+)\.js\b/gu)) {
      const source = resolveSource(join(src, match[1]));
      if (!source) continue;
      entries += 1;
      visit(source);
    }
  }
  if (entries === 0) throw new Error(`no runner CLI found under ${API_SCRIPTS}`);
  return new Set([...seen].map((file) => relative(root, file).split('\\').join('/')));
}

/**
 * `{ products, runnerProofs, full, reason }` for a PR's changed files (strings or `{ filename }`).
 * `full` is true when the whole battery runs, including the production-runner proofs.
 * `runnerSources` is `runnerSourceClosure` of the checkout; without it, every API source change runs the
 * proofs. `products` never depends on it, so the merge gate, which passes none, requires the same checks.
 */
export function affectedProducts(files, { runnerSources = null } = {}) {
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
      runnerProofs ||= rule.proofs === 'runner-source'
        ? !(runnerSources instanceof Set) || runnerSources.has(path)
        : rule.proofs;
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
