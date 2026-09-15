// Protected-migration checksums: the protected inventory is the BASE ref's committed manifest
// (bootstrap, while the base has none: the base TREE itself), compared with the HEAD ref's bytes;
// a head manifest can add entries but never redefine or drop a protected digest. Built-ins only.
// The record is written as ONE line: it is generated, `verify` names exactly what differs, and a
// generated file must not spend a review unit's line budget.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

// beside the migrations directory, never inside it: migrate.sh, the proof scripts and the
// seal-stripped harness enumerate every entry of that directory as a migration
export const MANIFEST_PATH = 'apps/api/prisma/migration-manifest.sha256.json';
const MIGRATION = /^apps\/api\/prisma\/migrations\/[^/]+\/migration\.sql$/u;
const MAX = 64 * 1024 * 1024;

function git(args, cwd) {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: MAX, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (error) {
    throw new Error(`git ${args.join(' ')} failed: ${String(error.stderr ?? error.message).trim()}`);
  }
}
function blob(ref, path, cwd) {
  try {
    return execFileSync('git', ['show', `${ref}:${path}`], { cwd, maxBuffer: MAX, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch { return null; }
}
export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

export function migrationsAt(ref, cwd) {
  return git(['ls-tree', '-r', '--name-only', ref, '--', 'apps/api/prisma/migrations'], cwd)
    .split('\n').filter((path) => MIGRATION.test(path)).sort();
}
export function digestsAt(ref, cwd) {
  return Object.fromEntries(migrationsAt(ref, cwd).map((path) => [path, sha256(blob(ref, path, cwd))]));
}
/** The WORKING TREE's migrations: generation runs before the new migration is committed. */
export function digestsInTree(cwd) {
  const dir = join(cwd, 'apps/api/prisma/migrations');
  return Object.fromEntries(readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(dir, entry.name, 'migration.sql')))
    .map((entry) => [`apps/api/prisma/migrations/${entry.name}/migration.sql`, sha256(readFileSync(join(dir, entry.name, 'migration.sql')))])
    .sort(([a], [b]) => (a < b ? -1 : 1)));
}
export function generate({ cwd = process.cwd() } = {}) {
  return {
    schema: 1,
    protects: 'every migration in the tree when generated (baseRef is the commit generated from) — a conservative superset of the deployed inventory, not a verified deployment record',
    baseRef: git(['rev-parse', 'HEAD^{commit}'], cwd).trim(),
    migrations: digestsInTree(cwd),
  };
}
export function readManifest(ref, cwd) {
  const bytes = blob(ref, MANIFEST_PATH, cwd);
  if (!bytes) return null;
  const manifest = JSON.parse(bytes.toString('utf8'));
  if (!manifest || typeof manifest.migrations !== 'object' || typeof manifest.baseRef !== 'string') {
    throw new Error(`${MANIFEST_PATH} at ${ref} is not a manifest`);
  }
  return manifest;
}

/** Pure comparison: `protectedDigests` are the base's, never the candidate's. */
export function compare({ protectedDigests, headManifest, headDigests, source }) {
  const problems = [];
  for (const [path, digest] of Object.entries(protectedDigests)) {
    if (headDigests[path] === undefined) problems.push(`protected migration removed: ${path}`);
    else if (headDigests[path] !== digest) problems.push(`protected migration bytes changed: ${path}`);
    if (!headManifest) continue;
    if (headManifest.migrations[path] === undefined) problems.push(`manifest entry removed: ${path}`);
    else if (headManifest.migrations[path] !== digest) problems.push(`manifest digest redefined: ${path}`);
  }
  if (!headManifest) problems.push(`${MANIFEST_PATH} is missing at the head`);
  else {
    for (const [path, digest] of Object.entries(headDigests)) {
      if (path in protectedDigests) continue;
      if (headManifest.migrations[path] === undefined) problems.push(`new migration not recorded: ${path} (run pnpm migrations:manifest)`);
      else if (headManifest.migrations[path] !== digest) problems.push(`new migration recorded with a stale digest: ${path}`);
    }
    // a phantom entry would become a "protected migration removed" failure for every later PR
    for (const path of Object.keys(headManifest.migrations)) if (headDigests[path] === undefined) problems.push(`manifest lists a migration absent at the head: ${path}`);
  }
  return { ok: problems.length === 0, problems, protected: Object.keys(protectedDigests).length, source };
}

export function verify({ baseRef, headRef = 'HEAD', cwd = process.cwd() }) {
  if (!baseRef) throw new Error('verify needs --base <ref>');
  for (const ref of [baseRef, headRef]) git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], cwd);
  const headManifest = readManifest(headRef, cwd);
  const baseManifest = readManifest(baseRef, cwd);
  // bootstrap: the base TREE is the protected set, computed here and never read from the candidate
  const protectedDigests = baseManifest ? baseManifest.migrations : digestsAt(baseRef, cwd);
  const source = baseManifest ? `${MANIFEST_PATH} at ${baseRef}` : `bootstrap from the tree at ${baseRef}`;
  return compare({ protectedDigests, headManifest, headDigests: digestsAt(headRef, cwd), source });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const [command, ...rest] = process.argv.slice(2);
  const option = (flag, fallback) => (rest.includes(flag) ? rest[rest.indexOf(flag) + 1] : fallback);
  if (command === 'generate') {
    writeFileSync(MANIFEST_PATH, `${JSON.stringify(generate())}\n`);
    console.log(`migration-manifest: wrote ${MANIFEST_PATH}`);
  } else if (command === 'verify') {
    const result = verify({ baseRef: option('--base'), headRef: option('--head', 'HEAD') });
    for (const problem of result.problems) console.error(`::error title=Migration manifest::${problem}`);
    console.log(`migration-manifest: ${result.ok ? 'ok' : 'FAILED'}; ${result.protected} protected (${result.source})`);
    process.exitCode = result.ok ? 0 : 1;
  } else {
    console.error('usage: migration-manifest.mjs generate | verify --base <ref> [--head <ref>]');
    process.exitCode = 2;
  }
}
