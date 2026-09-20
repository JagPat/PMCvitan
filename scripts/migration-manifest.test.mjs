import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MANIFEST_PATH, compare, digestsAt, generate, verify } from './migration-manifest.mjs';

const DIR = 'apps/api/prisma/migrations';
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const cleanup = (cwd) => rmSync(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });

/** A tiny repository: two protected migrations, a committed manifest, and `base` tagged. */
function repo() {
  const cwd = mkdtempSync(join(tmpdir(), 'manifest-'));
  git(cwd, 'init', '-q', '-b', 'main');
  git(cwd, 'config', 'user.email', 't@example.com'); git(cwd, 'config', 'user.name', 't');
  // commit must not detach background maintenance: it writes under .git while the repo is removed
  git(cwd, 'config', 'gc.auto', '0'); git(cwd, 'config', 'maintenance.auto', 'false');
  const write = (path, text) => { mkdirSync(join(cwd, path, '..'), { recursive: true }); writeFileSync(join(cwd, path), text); };
  const commit = (message) => { git(cwd, 'add', '-A'); git(cwd, 'commit', '-q', '-m', message); return git(cwd, 'rev-parse', 'HEAD'); };
  write(`${DIR}/20260101000000_one/migration.sql`, 'CREATE TABLE one (id int);\n');
  write(`${DIR}/20260102000000_two/migration.sql`, 'CREATE TABLE two (id int);\n');
  const bootstrap = commit('migrations');
  const bless = (overrides = {}) => write(MANIFEST_PATH, `${JSON.stringify({ ...generate({ cwd }), ...overrides })}\n`);
  bless();
  const base = commit('manifest');
  return { cwd, write, commit, bless, base, bootstrap, verify: (head = 'HEAD', baseRef = base) => verify({ baseRef, headRef: head, cwd }) };
}

test('an unchanged head verifies; one changed byte, a deletion, or a re-blessed digest fails against the BASE manifest', (t) => {
  const r = repo(); t.after(() => cleanup(r.cwd));
  const ok = r.verify();
  assert.equal(ok.ok, true, ok.problems.join(';')); assert.equal(ok.protected, 2); assert.match(ok.source, /migration-manifest\.sha256\.json at/u);
  r.write(`${DIR}/20260101000000_one/migration.sql`, 'CREATE TABLE one (id int) ;\n'); r.commit('one byte');
  assert.match(r.verify().problems.join(';'), /bytes changed: .*20260101000000_one/u);
  r.bless(); r.commit('re-blessed'); // the candidate JSON now agrees with the tampered bytes
  const rebless = r.verify();
  assert.equal(rebless.ok, false);
  assert.match(rebless.problems.join(';'), /bytes changed/u);
  assert.match(rebless.problems.join(';'), /digest redefined/u);
  rmSync(join(r.cwd, DIR, '20260102000000_two'), { recursive: true }); r.commit('deleted');
  const deleted = r.verify().problems.join(';');
  assert.match(deleted, /protected migration removed: .*_two/u);
  assert.match(deleted, /absent at the head: .*_two/u, 'the inherited record still lists what the head deleted');
  r.bless(); r.commit('re-blessed without two');
  assert.match(r.verify().problems.join(';'), /protected migration removed: .*_two.*manifest entry removed: .*_two/u, 'a recorded entry cannot be dropped');
});

test('a new migration passes only once it is recorded; generation sees the UNCOMMITTED tree from any directory; a missing base ref fails explicitly', (t) => {
  const r = repo(); t.after(() => cleanup(r.cwd));
  r.write(`${DIR}/20260103000000_three/migration.sql`, 'CREATE TABLE three (id int);\n');
  const fromSubdir = generate({ cwd: join(r.cwd, DIR) });
  assert.ok(fromSubdir.migrations[`${DIR}/20260103000000_three/migration.sql`], 'the manifest is generated before the migration is committed, from a subdirectory too');
  assert.equal(Object.keys(fromSubdir).sort().join(','), 'migrations,protects,schema', 'the record carries no commit reference: a squash merge would leave it naming a commit main never had');
  r.commit('additive');
  assert.match(r.verify().problems.join(';'), /new migration not recorded: .*_three/u);
  r.bless({ migrations: { ...generate({ cwd: r.cwd }).migrations, [`${DIR}/20260103000000_three/migration.sql`]: 'f'.repeat(64) } }); r.commit('stale');
  assert.match(r.verify().problems.join(';'), /recorded with a stale digest: .*_three/u);
  r.bless(); r.commit('recorded');
  const ok = r.verify();
  assert.equal(ok.ok, true, ok.problems.join(';'));
  assert.equal(ok.protected, 2);
  assert.throws(() => r.verify('HEAD', 'no-such-ref'), /rev-parse/u);
  assert.throws(() => verify({ headRef: 'HEAD', cwd: r.cwd }), /--base/u);
  assert.equal(verify({ baseRef: r.base, headRef: 'HEAD', cwd: join(r.cwd, DIR) }).ok, true, 'verification runs from a subdirectory');
});

test('bootstrap: with no manifest at the base, the base TREE is the protected set; the head manifest cannot narrow or redefine it', (t) => {
  const r = repo(); t.after(() => cleanup(r.cwd));
  const ok = r.verify('HEAD', r.bootstrap);
  assert.equal(ok.ok, true, ok.problems.join(';')); assert.equal(ok.protected, 2); assert.match(ok.source, /bootstrap/u);
  r.write(`${DIR}/20260101000000_one/migration.sql`, 'CREATE TABLE one (id bigint);\n'); r.commit('tamper'); r.bless(); r.commit('rebless');
  assert.match(r.verify('HEAD', r.bootstrap).problems.join(';'), /bytes changed.*_one.*digest redefined.*_one/u);
  // a manifest that records only what the author chose protects nothing extra and is refused
  r.bless({ migrations: { [`${DIR}/20260109000000_phantom/migration.sql`]: 'a'.repeat(64) } }); r.commit('narrow + phantom');
  const narrowed = r.verify('HEAD', r.bootstrap);
  assert.equal(narrowed.protected, 2, 'the tree keeps protecting what the narrowed record omits');
  assert.match(narrowed.problems.join(';'), /bytes changed: .*_one/u);
  assert.match(narrowed.problems.join(';'), /absent at the head: .*_phantom/u);
});

test('a migration the base tree carries but its manifest never recorded is protected by its base bytes, and an unrelated head need not record it', (t) => {
  const r = repo(); t.after(() => cleanup(r.cwd));
  // the in-flight window: a PR that merged without the gate left a migration on the base unrecorded
  r.write(`${DIR}/20260104000000_late/migration.sql`, 'CREATE TABLE late (id int);\n');
  const late = r.commit('merged without recording');
  const untouched = r.verify('HEAD', late);
  assert.equal(untouched.ok, true, untouched.problems.join(';'));
  assert.equal(untouched.protected, 3); assert.match(untouched.source, /plus 1 tree-only migration/u);
  r.write(`${DIR}/20260104000000_late/migration.sql`, 'CREATE TABLE late (id bigint);\n'); r.commit('tamper the unrecorded one');
  const tampered = r.verify('HEAD', late).problems.join(';');
  assert.match(tampered, /bytes changed: .*_late/u);
  assert.doesNotMatch(tampered, /manifest entry removed/u, 'an entry the base never recorded cannot be "removed"');
  git(r.cwd, 'checkout', '-q', late, '--', `${DIR}/20260104000000_late/migration.sql`);
  r.bless({ migrations: { ...generate({ cwd: r.cwd }).migrations, [`${DIR}/20260104000000_late/migration.sql`]: 'b'.repeat(64) } }); r.commit('record it wrongly');
  assert.match(r.verify('HEAD', late).problems.join(';'), /digest redefined: .*_late/u, 'once listed, it must agree with the base bytes');
  r.bless(); r.commit('record it');
  const recorded = r.verify('HEAD', late);
  assert.equal(recorded.ok, true, recorded.problems.join(';'));
  // a base whose own record contradicts its tree is named, and no head can clear it
  r.bless({ migrations: { ...generate({ cwd: r.cwd }).migrations, [`${DIR}/20260101000000_one/migration.sql`]: 'c'.repeat(64) } });
  const broken = r.commit('a wrongly blessed base');
  r.write('README.md', 'an unrelated head\n'); r.commit('unrelated follow-up');
  assert.match(r.verify('HEAD', broken).problems.join(';'), /base manifest disagrees with the base tree: .*_one/u);
});

test('a committed migration whose path carries non-ASCII bytes is protected (ls-tree -z, not C-quoted names)', (t) => {
  const r = repo(); t.after(() => cleanup(r.cwd));
  // default `ls-tree --name-only` C-quotes a non-ASCII path (".../20260105000000_\303\251/…"), which the
  // path regex then discards, so the migration would silently fall outside the protected inventory
  r.write(`${DIR}/20260105000000_é/migration.sql`, 'CREATE TABLE accented (id int);\n');
  const committed = generate({ cwd: r.cwd });
  assert.ok(committed.migrations[`${DIR}/20260105000000_é/migration.sql`], 'generation records the non-ASCII migration');
  r.commit('accented migration'); r.bless(); const base = r.commit('bless accented');
  const protectedNow = digestsAt('HEAD', r.cwd);
  assert.ok(protectedNow[`${DIR}/20260105000000_é/migration.sql`], 'the non-ASCII migration is in the protected inventory');
  // tamper the non-ASCII migration's bytes: verification must catch it, proving it is protected
  r.write(`${DIR}/20260105000000_é/migration.sql`, 'CREATE TABLE accented (id bigint);\n'); r.commit('tamper accented'); r.bless(); r.commit('rebless accented');
  assert.match(r.verify('HEAD', base).problems.join(';'), /bytes changed: .*20260105000000_é/u);
});

test('a symlinked migration.sql is rejected before hashing, at verify and at generate', (t) => {
  const r = repo(); t.after(() => cleanup(r.cwd));
  // git records a symlink as mode 120000 whose blob is the TARGET PATH, not SQL; a checkout consumer
  // follows the link and runs different bytes, so hashing the link text would freeze nothing real
  writeFileSync(join(r.cwd, `${DIR}/target.sql`), 'SELECT 1;\n');
  mkdirSync(join(r.cwd, DIR, '20260106000000_link'), { recursive: true });
  execFileSync('ln', ['-s', '../target.sql', 'migration.sql'], { cwd: join(r.cwd, DIR, '20260106000000_link') });
  // generate refuses to record a symlinked migration at all
  assert.throws(() => generate({ cwd: r.cwd }), /not a regular file/u);
  git(r.cwd, 'add', '-A'); git(r.cwd, 'commit', '-q', '-m', 'symlinked migration');
  const head = git(r.cwd, 'rev-parse', 'HEAD');
  assert.equal(git(r.cwd, 'ls-tree', '-r', head, '--', `${DIR}/20260106000000_link/migration.sql`).slice(0, 6), '120000', 'the migration is committed as a symlink');
  // verify surfaces the non-regular file as a named failure rather than checksumming the link text
  const result = r.verify(head, r.base);
  assert.equal(result.ok, false);
  assert.match(result.problems.join(';'), /not a regular file \(git mode 120000\): .*20260106000000_link/u);
});

test('compare is pure: a head that redefines a recorded digest, or lists what the head lacks, is named without git', () => {
  const one = `${DIR}/20260101000000_one/migration.sql`;
  const protectedDigests = { [one]: 'a'.repeat(64) };
  const headDigests = { [one]: 'a'.repeat(64) };
  assert.equal(compare({ protectedDigests, headManifest: { migrations: { [one]: 'a'.repeat(64) } }, headDigests, source: 't' }).ok, true);
  assert.match(compare({ protectedDigests, headManifest: null, headDigests, source: 't' }).problems.join(';'), /missing at the head/u);
  const redefined = compare({ protectedDigests, headManifest: { migrations: { [one]: 'b'.repeat(64), [`${DIR}/x/migration.sql`]: 'c'.repeat(64) } }, headDigests, source: 't' });
  assert.match(redefined.problems.join(';'), /digest redefined: .*_one/u);
  assert.match(redefined.problems.join(';'), /absent at the head: .*\/x\//u);
});

test('the committed manifest covers every migration in this tree, and CI verifies it with the BASE commit\'s verifier inside review-scope', async () => {
  const here = new URL('..', import.meta.url).pathname;
  const manifest = JSON.parse(await readFile(new URL(`../${MANIFEST_PATH}`, import.meta.url), 'utf8'));
  assert.equal(manifest.schema, 1);
  const local = compare({ protectedDigests: manifest.migrations, headManifest: manifest, headDigests: digestsAt('HEAD', here), source: 'tree' });
  assert.equal(local.ok, true, local.problems.join('; '));
  const ci = await readFile(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
  const job = ci.slice(ci.indexOf('\n  review-scope:\n'), ci.indexOf('\n  battery-plan:\n'));
  assert.match(job, /Protected migration checksums/u, 'the step belongs to the one job that runs before install');
  assert.match(job, /if: github\.event_name == 'pull_request'/u);
  assert.match(job, /BASE: \$\{\{ github\.event\.pull_request\.base\.sha \}\}\n\s+HEAD: \$\{\{ github\.event\.pull_request\.head\.sha \}\}/u);
  assert.match(job, /git fetch --no-tags --depth=1 origin "\$BASE" "\$HEAD"/u);
  assert.match(job, /git show "\$BASE:scripts\/migration-manifest\.mjs" > "\$RUNNER_TEMP\/migration-manifest\.mjs"/u);
  assert.match(job, /node "\$RUNNER_TEMP\/migration-manifest\.mjs" verify --base "\$BASE" --head "\$HEAD"/u);
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(pkg.scripts['migrations:manifest'], 'node scripts/migration-manifest.mjs generate');
  assert.match(pkg.scripts['test:automation'], /scripts\/migration-manifest\.test\.mjs/u);
});
