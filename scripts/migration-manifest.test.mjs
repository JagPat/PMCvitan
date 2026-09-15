import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MANIFEST_PATH, compare, generate, verify } from './migration-manifest.mjs';

const DIR = 'apps/api/prisma/migrations';
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

/** A tiny repository: two protected migrations, a committed manifest, and `base` tagged. */
function repo() {
  const cwd = mkdtempSync(join(tmpdir(), 'manifest-'));
  git(cwd, 'init', '-q', '-b', 'main');
  git(cwd, 'config', 'user.email', 't@example.com'); git(cwd, 'config', 'user.name', 't');
  const write = (path, text) => { mkdirSync(join(cwd, path, '..'), { recursive: true }); writeFileSync(join(cwd, path), text); };
  const commit = (message) => { git(cwd, 'add', '-A'); git(cwd, 'commit', '-q', '-m', message); return git(cwd, 'rev-parse', 'HEAD'); };
  write(`${DIR}/20260101000000_one/migration.sql`, 'CREATE TABLE one (id int);\n');
  write(`${DIR}/20260102000000_two/migration.sql`, 'CREATE TABLE two (id int);\n');
  const bootstrap = commit('migrations');
  const bless = () => write(MANIFEST_PATH, `${JSON.stringify(generate({ cwd }), null, 1)}\n`);
  bless();
  const base = commit('manifest');
  return { cwd, write, commit, bless, base, bootstrap, verify: (head = 'HEAD', baseRef = base) => verify({ baseRef, headRef: head, cwd }) };
}

test('an unchanged head verifies; one changed byte, a deletion, or a re-blessed digest fails against the BASE manifest', (t) => {
  const r = repo(); t.after(() => rmSync(r.cwd, { recursive: true, force: true }));
  assert.equal(r.verify().ok, true);
  r.write(`${DIR}/20260101000000_one/migration.sql`, 'CREATE TABLE one (id int) ;\n'); r.commit('one byte');
  assert.match(r.verify().problems.join(';'), /bytes changed: .*20260101000000_one/u);
  r.bless(); r.commit('re-blessed'); // the candidate JSON now agrees with the tampered bytes
  const rebless = r.verify();
  assert.equal(rebless.ok, false);
  assert.match(rebless.problems.join(';'), /bytes changed/u);
  assert.match(rebless.problems.join(';'), /digest redefined/u);
  rmSync(join(r.cwd, DIR, '20260102000000_two'), { recursive: true }); r.commit('deleted');
  assert.match(r.verify().problems.join(';'), /protected migration removed: .*_two/u);
});

test('a new migration passes only once it is recorded; a missing base ref fails explicitly', (t) => {
  const r = repo(); t.after(() => rmSync(r.cwd, { recursive: true, force: true }));
  r.write(`${DIR}/20260103000000_three/migration.sql`, 'CREATE TABLE three (id int);\n'); r.commit('additive');
  assert.match(r.verify().problems.join(';'), /new migration not recorded: .*_three/u);
  r.bless(); r.commit('recorded');
  const ok = r.verify();
  assert.equal(ok.ok, true, ok.problems.join(';'));
  assert.equal(ok.protected, 2);
  assert.throws(() => r.verify('HEAD', 'no-such-ref'), /rev-parse/u);
  assert.throws(() => verify({ headRef: 'HEAD', cwd: r.cwd }), /--base/u);
});

test('bootstrap: with no manifest at the base, the base TREE is the protected set; the head manifest cannot narrow or redefine it', (t) => {
  const r = repo(); t.after(() => rmSync(r.cwd, { recursive: true, force: true }));
  const ok = r.verify('HEAD', r.bootstrap);
  assert.equal(ok.ok, true, ok.problems.join(';')); assert.equal(ok.protected, 2); assert.match(ok.source, /bootstrap/u);
  const based = (migrations) => r.write(MANIFEST_PATH, `${JSON.stringify({ ...generate({ cwd: r.cwd }), ...migrations }, null, 1)}\n`);
  r.write(`${DIR}/20260101000000_one/migration.sql`, 'CREATE TABLE one (id bigint);\n'); r.commit('tamper'); based({}); r.commit('rebless');
  assert.match(r.verify('HEAD', r.bootstrap).problems.join(';'), /bytes changed.*_one.*digest redefined.*_one/u);
  // a manifest that records only what the author chose protects nothing extra and is refused
  based({ migrations: { [`${DIR}/20260109000000_phantom/migration.sql`]: 'a'.repeat(64) } }); r.commit('narrow + phantom');
  const narrowed = r.verify('HEAD', r.bootstrap).problems.join(';');
  assert.match(narrowed, /manifest entry removed: .*_one/u); assert.match(narrowed, /absent at the head: .*_phantom/u);
});

test('the committed manifest covers every migration in the tree at its recorded base, and CI verifies it against the PR base', async () => {
  const here = new URL('..', import.meta.url).pathname;
  const manifest = JSON.parse(await readFile(new URL(`../${MANIFEST_PATH}`, import.meta.url), 'utf8'));
  assert.match(manifest.baseRef, /^[0-9a-f]{40}$/u);
  const local = compare({ protectedDigests: manifest.migrations, headManifest: manifest, headDigests: (await import('./migration-manifest.mjs')).digestsAt('HEAD', here), source: 'tree' });
  assert.equal(local.ok, true, local.problems.join('; '));
  const ci = await readFile(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
  assert.match(ci, /migration-manifest\.mjs verify --base "\$\{\{ github\.event\.pull_request\.base\.sha \}\}" --head "\$\{\{ github\.event\.pull_request\.head\.sha \}\}"/u);
  assert.match(ci, /git fetch --no-tags --depth=1 origin "\$\{\{ github\.event\.pull_request\.base\.sha \}\}" "\$\{\{ github\.event\.pull_request\.head\.sha \}\}"/u);
});
