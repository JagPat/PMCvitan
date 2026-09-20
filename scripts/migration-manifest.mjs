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

// A regular blob is mode 100644 or 100755. A symlink (120000) or gitlink/submodule (160000) is NOT
// one: its object is a target pathname or a commit, not SQL, while a checkout follows the link — so
// hashing the object would freeze bytes nobody deploys. Such an entry is rejected, never hashed.
const REGULAR_MODE = /^100(?:644|755)$/u;
const FORBIDDEN_TREE_MODE = /^1(?:20000|60000)$/u; // 120000 symlink, 160000 gitlink/submodule
// The gitattributes that make a checkout's bytes DIVERGE from the stored blob: end-of-line/text
// normalization, a working-tree re-encoding, a clean/smudge filter, or `ident` ($Id$) substitution.
// Only `unspecified`/`unset` leave the blob untouched; any other effective value is rejected so the
// checksum can never certify a blob that the deployment checkout would rewrite.
const CHECKOUT_ATTRS = ['text', 'eol', 'working-tree-encoding', 'filter', 'ident'];
const SAFE_ATTR = new Set(['unspecified', 'unset']);

// Every entry under the migrations directory, mode + path. `-r -z`: recursive, NUL-terminated,
// UNQUOTED names (default output C-quotes non-ASCII paths, which the MIGRATION regex would then drop).
// git never recurses INTO a symlink or submodule, so a symlinked migration DIRECTORY appears here as a
// single mode-120000 entry at the directory path — which the topology audit rejects BEFORE any path
// filtering, so it cannot smuggle a checkout-materialized migration past the checksum.
function treeEntriesAt(ref, cwd) {
  return git(['ls-tree', '-r', '-z', ref, '--', MIGRATIONS_DIR], cwd)
    .split('\0')
    .map((record) => /^(\d{6}) [^ ]+ [0-9a-f]+\t([\s\S]*)$/u.exec(record))
    .filter(Boolean)
    .map((match) => ({ mode: match[1], path: match[2] }));
}
// Tree topology, validated before path filtering (owner ruling): no symlink or submodule may appear
// anywhere under the migrations directory, so a protected migration is a real tree of regular files
// and the stored blob is the file a checkout materializes.
function topologyProblems(entries) {
  return entries
    .filter((entry) => FORBIDDEN_TREE_MODE.test(entry.mode))
    .map((entry) => `migration tree topology rejected: ${entry.path} is a `
      + `${entry.mode === '120000' ? 'symlink' : 'submodule/gitlink'} (git mode ${entry.mode}); `
      + 'a protected migration path must be a real tree of regular files');
}
// Prove the stored blob equals the checkout-visible file: no gitattribute in effect at `ref` may
// transform bytes on checkout. `check-attr --source=<ref>` reads .gitattributes AS OF that tree; an
// unreadable result fails closed. `-z` output is NUL-separated (path, attr, value) triples.
function attributeProblems(ref, paths, cwd) {
  if (paths.length === 0) return [];
  let out;
  try {
    out = git(['check-attr', '-z', `--source=${ref}`, ...CHECKOUT_ATTRS, '--', ...paths], cwd);
  } catch (error) {
    return [`migration checkout attributes unreadable at ${ref}: ${error.message}`];
  }
  const parts = out.split('\0');
  const problems = [];
  for (let i = 0; i + 2 < parts.length; i += 3) {
    const [path, attr, value] = [parts[i], parts[i + 1], parts[i + 2]];
    if (path === '' || SAFE_ATTR.has(value)) continue;
    problems.push(`migration checkout attribute would transform bytes: ${path} has ${attr}=${value} `
      + '(only unspecified/unset are safe); the stored blob would not match the deployed file');
  }
  return problems;
}
export function migrationsAt(ref, cwd) {
  return treeEntriesAt(ref, cwd)
    .filter((entry) => MIGRATION.test(entry.path))
    .map((entry) => entry.path)
    .sort();
}
export function digestsAt(ref, cwd) {
  const entries = treeEntriesAt(ref, cwd);
  const topology = topologyProblems(entries);
  if (topology.length > 0) throw new Error(topology.join('; '));
  const migrations = entries.filter((entry) => MIGRATION.test(entry.path));
  return Object.fromEntries(migrations.map((entry) => {
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
  // ADDITIVE ORDERING: a new migration must sort strictly AFTER the entire base inventory. Prisma
  // applies directories lexicographically, so a migration inserted before an existing one runs before
  // recorded successors on a fresh database but after them on an already-upgraded one — divergent
  // schemas. (Base removals/renames/reorders are already named as removed/changed above; migration.sql
  // paths share one prefix and suffix, so path order equals directory order.)
  const baseKeys = Object.keys(protectedDigests);
  if (baseKeys.length > 0) {
    const baseMax = baseKeys.reduce((a, b) => (a > b ? a : b));
    for (const path of Object.keys(headDigests)) {
      if (path in protectedDigests) continue;
      if (!(path > baseMax)) problems.push(`new migration sorts before the protected inventory (reorders apply order): ${path} is not after ${baseMax}`);
    }
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
  let attrProblems = [];
  try {
    base = protectedAt(baseRef, top);
    headManifest = readManifest(headRef, top);
    headDigests = digestsAt(headRef, top);
    // Every protected/new migration at the HEAD, plus the manifest, must checkout byte-for-byte as
    // stored — evaluated against the HEAD tree's own gitattributes, where a transform is introduced.
    const headPaths = [...new Set([...Object.keys(headDigests), MANIFEST_PATH])];
    attrProblems = attributeProblems(headRef, headPaths, top);
  } catch (error) {
    return { ok: false, problems: [error.message], protected: 0, source: `unverifiable at ${headRef}` };
  }
  const result = compare({ ...base, headManifest, headDigests });
  // a base whose record contradicts its own tree is repaired on the trusted base, never by a head
  const problems = [...base.problems, ...attrProblems, ...result.problems];
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
