// Protected-migration checksums. The protected inventory is the BASE commit's committed manifest,
// unioned with the base TREE (a migration the base carries but never recorded is protected by its
// base bytes; while the base has no manifest at all, the tree alone is the inventory), compared
// with the HEAD commit's bytes. A head manifest may add entries but never redefine or drop a
// recorded digest. Built-ins only: CI runs the BASE commit's copy of this file from outside the
// checkout, so a candidate cannot edit a migration and the gate together. The record is ONE line
// (generated; `verify` names what differs, so the file never spends a review unit's line budget).
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

// beside the migrations directory, never inside it: migrate.sh, the proof scripts and the
// seal-stripped harness enumerate every entry of that directory as a migration
export const MANIFEST_PATH = 'apps/api/prisma/migration-manifest.sha256.json';
const MIGRATIONS_DIR = 'apps/api/prisma/migrations';
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
/** Every git pathspec below is repository-relative, so the commands run from the repository root. */
const root = (cwd) => git(['rev-parse', '--show-toplevel'], cwd).trim();
export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

// A regular blob is mode 100644 or 100755. A symlink (120000) or gitlink (160000) is NOT one: its
// blob is the target pathname, not SQL, while every deployment consumer opens the file and follows
// the link — so hashing the blob would freeze bytes nobody runs. Such an entry is rejected, never hashed.
const REGULAR_MODE = /^100(?:644|755)$/u;
// `ls-tree -r -z` emits one NUL-terminated `MODE SP TYPE SP OBJECT TAB PATH` record per entry, with
// the PATH verbatim. Default output C-quotes any non-ASCII path (`"…/\303\251/migration.sql"`), which
// the MIGRATION regex then discards — so a committed non-ASCII migration would fall outside the
// protected inventory. `-z` gives the raw name and lets us read the mode in the same pass.
function entriesAt(ref, cwd) {
  return git(['ls-tree', '-r', '-z', ref, '--', MIGRATIONS_DIR], cwd)
    .split('\0')
    .map((record) => /^(\d{6}) [^ ]+ [0-9a-f]+\t([\s\S]*)$/u.exec(record))
    .filter((match) => match && MIGRATION.test(match[2]))
    .map((match) => ({ mode: match[1], path: match[2] }))
    .sort((a, b) => (a.path < b.path ? -1 : 1));
}
export function migrationsAt(ref, cwd) {
  return entriesAt(ref, cwd).map((entry) => entry.path);
}
export function digestsAt(ref, cwd) {
  return Object.fromEntries(entriesAt(ref, cwd).map((entry) => {
    if (!REGULAR_MODE.test(entry.mode)) {
      throw new Error(`protected migration is not a regular file (git mode ${entry.mode}): ${entry.path} — a symlink or gitlink cannot be checksummed as migration SQL`);
    }
    return [entry.path, sha256(blob(ref, entry.path, cwd))];
  }));
}
/** The WORKING TREE's migrations: generation runs before the new migration is committed. */
export function digestsInTree(cwd) {
  const dir = join(cwd, MIGRATIONS_DIR);
  return Object.fromEntries(readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(dir, entry.name, 'migration.sql')))
    .map((entry) => {
      const file = join(dir, entry.name, 'migration.sql');
      // lstat, not stat: a symlinked migration.sql would be recorded here as the hash of the target's
      // CONTENT (readFileSync follows the link) while verify hashes the committed blob (the link text),
      // so a recorded symlink could never verify. Refuse to record one at all — migrations are files.
      if (!lstatSync(file).isFile()) {
        throw new Error(`migration is not a regular file: ${MIGRATIONS_DIR}/${entry.name}/migration.sql — a symlink cannot be a migration`);
      }
      return [`${MIGRATIONS_DIR}/${entry.name}/migration.sql`, sha256(readFileSync(file))];
    })
    .sort(([a], [b]) => (a < b ? -1 : 1)));
}
export function generate({ cwd = process.cwd() } = {}) {
  return {
    schema: 1,
    protects: 'the SHA-256 of every migration in the tree when generated: a conservative superset of the deployed inventory, not a verified deployment record; CI compares the PR base commit\'s copy of this record with the PR head\'s bytes',
    migrations: digestsInTree(root(cwd)),
  };
}
export function readManifest(ref, cwd) {
  const bytes = blob(ref, MANIFEST_PATH, cwd);
  if (!bytes) return null;
  const manifest = JSON.parse(bytes.toString('utf8'));
  if (!manifest || typeof manifest.migrations !== 'object' || manifest.migrations === null) {
    throw new Error(`${MANIFEST_PATH} at ${ref} is not a manifest`);
  }
  return manifest;
}

/**
 * Pure comparison. `protectedDigests` are the base's (manifest and tree), never the candidate's;
 * `recordedAtBase` names the paths the base MANIFEST lists, the only entries a head may not drop.
 */
export function compare({ protectedDigests, recordedAtBase = new Set(Object.keys(protectedDigests)), headManifest, headDigests, source }) {
  const problems = [];
  for (const [path, digest] of Object.entries(protectedDigests)) {
    if (headDigests[path] === undefined) problems.push(`protected migration removed: ${path}`);
    else if (headDigests[path] !== digest) problems.push(`protected migration bytes changed: ${path}`);
    if (!headManifest) continue;
    const listed = headManifest.migrations[path];
    if (listed === undefined) { if (recordedAtBase.has(path)) problems.push(`manifest entry removed: ${path}`); }
    else if (listed !== digest) problems.push(`manifest digest redefined: ${path}`);
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

/** The base's protected inventory: its manifest's digests over its tree's, plus any tree-only path. */
export function protectedAt(baseRef, cwd) {
  const manifest = readManifest(baseRef, cwd);
  const tree = digestsAt(baseRef, cwd);
  const recorded = manifest?.migrations ?? {};
  const protectedDigests = { ...tree, ...recorded };
  const problems = [];
  for (const [path, digest] of Object.entries(recorded)) {
    if (tree[path] === undefined) problems.push(`base manifest lists a migration absent from the base tree: ${path}`);
    else if (tree[path] !== digest) problems.push(`base manifest disagrees with the base tree: ${path}`);
  }
  const unrecorded = Object.keys(tree).filter((path) => recorded[path] === undefined).length;
  const source = manifest
    ? `${MANIFEST_PATH} at ${baseRef}${unrecorded ? ` plus ${unrecorded} tree-only migration(s)` : ''}`
    : `bootstrap from the tree at ${baseRef}`;
  return { protectedDigests, recordedAtBase: new Set(Object.keys(recorded)), problems, source };
}

export function verify({ baseRef, headRef = 'HEAD', cwd = process.cwd() }) {
  if (!baseRef) throw new Error('verify needs --base <ref>');
  const top = root(cwd);
  for (const ref of [baseRef, headRef]) git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], top);
  // A non-regular protected migration (a symlink/gitlink digestsAt refuses to checksum) or an
  // unreadable record is a NAMED verification failure, never a thrown escape: the caller — the CLI
  // step and the trusted merge gate alike — must see `ok: false` with the reason, not an exception.
  let base;
  let headManifest;
  let headDigests;
  try {
    base = protectedAt(baseRef, top);
    headManifest = readManifest(headRef, top);
    headDigests = digestsAt(headRef, top);
  } catch (error) {
    return { ok: false, problems: [error.message], protected: 0, source: `unverifiable at ${headRef}` };
  }
  const result = compare({ ...base, headManifest, headDigests });
  // a base whose record contradicts its own tree is repaired on the trusted base, never by a head
  const problems = [...base.problems, ...result.problems];
  return { ...result, ok: problems.length === 0, problems };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const [command, ...rest] = process.argv.slice(2);
  const option = (flag, fallback) => (rest.includes(flag) ? rest[rest.indexOf(flag) + 1] : fallback);
  if (command === 'generate') {
    writeFileSync(join(root(process.cwd()), MANIFEST_PATH), `${JSON.stringify(generate())}\n`);
    console.log(`migration-manifest: wrote ${MANIFEST_PATH}`);
  } else if (command === 'verify') {
    // an unreadable ref or record is a named failure, never a green step
    let result;
    try { result = verify({ baseRef: option('--base'), headRef: option('--head', 'HEAD') }); } catch (error) { result = { ok: false, problems: [error.message], protected: 0, source: 'unverifiable' }; }
    for (const problem of result.problems) console.error(`::error title=Migration manifest::${problem}`);
    console.log(`migration-manifest: ${result.ok ? 'ok' : 'FAILED'}; ${result.protected} protected (${result.source})`);
    process.exitCode = result.ok ? 0 : 1;
  } else {
    console.error('usage: migration-manifest.mjs generate | verify --base <ref> [--head <ref>]');
    process.exitCode = 2;
  }
}
