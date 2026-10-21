#!/usr/bin/env node
// The api test type-check ratchet: the third step of `pnpm --filter api typecheck`.
//
// It runs `tsc -p tsconfig.tests.json` and holds every file to the error count test/typecheck-baseline.json allows it.
// The step fails when:
//   - a file not in the baseline has an error (every new or fixed test file stays clean);
//   - a listed file has more errors than its count (no listed file gains one);
//   - a listed file has fewer errors than its count, until its count is lowered (or its entry deleted, at zero) in the
//     same change, so the baseline always equals the tree;
//   - an error tsc reports without a file, or tsc exits 2 and no error can be read from what it wrote;
//   - the baseline allows more than the base branch's baseline does, for any file (it only ever goes down). This is
//     checked against the base's copy, read from git: `TYPECHECK_BASE` if set, else the pull request's base branch
//     (`GITHUB_BASE_REF`, fetched at depth 1), else `origin/main` (in Actions, `main` fetched at depth 1). With no
//     base, or a base copy that cannot be read, the step fails. It skips the comparison, and says so, only when the
//     base's tree has no baseline file (the change that adds it).
// Each burn-down unit fixes its files and deletes their entries; the step ends when the baseline is `{}`.
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const api = join(dirname(fileURLToPath(import.meta.url)), '..');
const BASELINE = 'test/typecheck-baseline.json';
const REPO_PATH = `apps/api/${BASELINE}`;
const UNPLACED = '(an error tsc reports without a file)';

/** A baseline's JSON: an object whose every count is a whole number of at least 1. */
function parseBaseline(text, where) {
  const b = JSON.parse(text);
  if (!b || typeof b !== 'object' || Array.isArray(b)) throw new Error(`${where} is not a JSON object`);
  for (const [file, n] of Object.entries(b)) if (!Number.isInteger(n) || n < 1) throw new Error(`${where}: ${file} has ${JSON.stringify(n)}, not a count of 1 or more`);
  return b;
}

/** `path(line,col): error TS…` lines, counted per file, with paths relative to apps/api. */
export function countErrors(output) {
  const counts = {};
  for (const m of output.matchAll(/^(.+?)\(\d+,\d+\): error TS\d+:/gm)) counts[m[1]] = (counts[m[1]] ?? 0) + 1;
  // an error tsc reports without a file (TS18003 no inputs, TS2688 a missing types entry, ...) is never in the baseline
  const unplaced = output.match(/^error TS\d+:/gm)?.length ?? 0;
  if (unplaced) counts[UNPLACED] = unplaced;
  return counts;
}

/** Every way `actual` breaks `allowed`, and `allowed` breaks `base` (null when there is no base to compare with), and
 *  the listed files that now have fewer errors than their count. */
export function judge(actual, allowed, base) {
  const problems = [];
  const lower = [];
  for (const [file, n] of Object.entries(actual)) {
    if (!Object.hasOwn(allowed, file)) problems.push(`${file}: ${n} type error(s), and it has no entry in ${BASELINE}`);
    else if (n > allowed[file]) problems.push(`${file}: ${n} type errors, more than the ${allowed[file]} ${BASELINE} allows`);
  }
  for (const [file, n] of Object.entries(allowed)) {
    const now = actual[file] ?? 0;
    if (now < n) problems.push(`${file}: ${now} type error(s), fewer than its ${n}: ${now === 0 ? 'delete its entry' : `lower its count to ${now}`} in ${BASELINE}`);
  }
  if (base) {
    for (const [file, n] of Object.entries(allowed)) {
      if (!Object.hasOwn(base, file)) problems.push(`${file}: added to ${BASELINE}; the baseline only goes down`);
      else if (n > base[file]) problems.push(`${file}: raised from ${base[file]} to ${n} in ${BASELINE}; the baseline only goes down`);
    }
  }
  return { problems, lower };
}

function git(...args) {
  return spawnSync('git', args, { cwd: api, encoding: 'utf8' });
}

/** The base branch's baseline, or why there is none to compare with. */
function baseBaseline() {
  let ref = process.env.TYPECHECK_BASE;
  if (!ref && process.env.GITHUB_BASE_REF) {
    const fetched = git('fetch', '--no-tags', '--depth=1', 'origin', process.env.GITHUB_BASE_REF);
    if (fetched.status !== 0) throw new Error(`could not fetch the base branch ${process.env.GITHUB_BASE_REF}: ${fetched.stderr}`);
    ref = 'FETCH_HEAD';
  }
  if (!ref && git('rev-parse', '--verify', '--quiet', 'origin/main').status === 0) ref = 'origin/main';
  if (!ref && process.env.GITHUB_ACTIONS === 'true') {
    // a push or a dispatch: compare with main
    const fetched = git('fetch', '--no-tags', '--depth=1', 'origin', 'main');
    if (fetched.status !== 0) throw new Error(`could not fetch main to compare the baseline with: ${fetched.stderr}`);
    ref = 'FETCH_HEAD';
  }
  if (!ref) throw new Error('no base to compare the baseline with: fetch origin/main, or set TYPECHECK_BASE');
  if (git('rev-parse', '--verify', '--quiet', `${ref}^{commit}`).status !== 0) throw new Error(`no such base: ${ref}`);
  const listed = git('ls-tree', '--full-tree', '--name-only', ref, '--', REPO_PATH);
  if (listed.status !== 0) throw new Error(`could not list ${ref}'s tree: ${listed.stderr}`);
  if (listed.stdout.trim() === '') return { base: null, skipped: `${ref} has no ${BASELINE} yet` };
  const shown = git('show', `${ref}:${REPO_PATH}`);
  if (shown.status !== 0) throw new Error(`could not read ${ref}'s ${BASELINE}: ${shown.stderr}`);
  return { base: parseBaseline(shown.stdout, `${ref}:${REPO_PATH}`), skipped: null };
}

function main() {
  const allowed = parseBaseline(readFileSync(join(api, BASELINE), 'utf8'), BASELINE);
  let output = '';
  let status = 0;
  try {
    output = execFileSync('npx', ['tsc', '-p', 'tsconfig.tests.json', '--noEmit', '--pretty', 'false'], { cwd: api, encoding: 'utf8', maxBuffer: 64 << 20 });
  } catch (e) {
    // tsc exits 2 when it reports errors; anything else (no output to read) is a failure of the step itself
    if (e.status !== 2 || !e.stdout) throw e;
    output = e.stdout;
    status = 2;
  }
  const actual = countErrors(output);
  if (status === 2 && !Object.keys(actual).length) throw new Error(`tsc exited 2, but no error could be read from what it wrote:\n${output.slice(0, 2000)}`);
  const { base, skipped } = baseBaseline();
  const { problems, lower } = judge(actual, allowed, base);
  if (lower.length) console.log(`api test type-check ratchet: ${BASELINE} can go down\n${lower.map((p) => `  - ${p}`).join('\n')}`);
  const total = Object.values(actual).reduce((a, b) => a + b, 0);
  if (problems.length) {
    // the errors of the files at fault, each with the lines tsc wrote under it
    let shown = false;
    for (const line of output.split('\n')) {
      const file = /^(.+?)\(\d+,\d+\): error TS/.exec(line)?.[1] ?? (/^error TS\d+:/.test(line) ? UNPLACED : undefined);
      if (file !== undefined) shown = problems.some((p) => p.startsWith(`${file}: `));
      if (shown && line) console.error(line);
    }
    console.error(`\napi test type-check ratchet: FAILED\n${problems.map((p) => `  - ${p}`).join('\n')}`);
    process.exit(1);
  }
  const files = Object.keys(allowed).length;
  console.log(`api test type-check ratchet: ${total} known error(s) in ${files} listed file(s), none new`
    + (skipped ? `; the baseline was not compared with a base (${skipped})` : ', and the baseline allows no more than the base\'s'));
}

main();
