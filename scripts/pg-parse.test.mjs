// Tests for the parser binding.
//
// The claim is small enough to test directly: all 91 migrations parse with PostgreSQL's grammar
// through this binding, and the binding neither leaks nor truncates on the largest of them. Each
// probe below corresponds to a measured fact in the binding's header — a decision recorded there
// without a test to hold it would be a comment, not a property.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  loadParser, parseSql, parsePlpgsqlStatement, walk, nodesOfType, relationsIn,
} from './pg-parse.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(HERE, '..', 'apps', 'api', 'prisma', 'migrations');
const migrationNames = () => readdirSync(MIGRATIONS_DIR).sort()
  .filter((n) => existsSync(join(MIGRATIONS_DIR, n, 'migration.sql')));
const sqlOf = (name) => readFileSync(join(MIGRATIONS_DIR, name, 'migration.sql'), 'utf8');

await loadParser();

// ── The claim ────────────────────────────────────────────────────────────────────────────────

test('every migration in the corpus parses with PostgreSQL’s own grammar', () => {
  const names = migrationNames();
  assert.equal(names.length, 91, 'the corpus size is pinned, so a new migration is a visible diff');
  for (const name of names) {
    // The file is NAMED here, because parseSql is handed text and cannot name it. A check whose
    // failure output does not say which of 91 files failed is not a usable check.
    try {
      const tree = parseSql(sqlOf(name));
      assert.ok(Array.isArray(tree.stmts) && tree.stmts.length > 0, 'a migration has statements');
    } catch (err) {
      assert.fail(`${name}/migration.sql: ${err.message}`);
    }
  }
});

test('the largest migration parses — the case the convenience wrappers cannot do at all', () => {
  // 177,493 bytes against an emscripten 64 KB stack. This is the measurement that decided the raw
  // entry points, so it is the measurement that is pinned.
  const sizes = migrationNames()
    .map((name) => ({ name, bytes: Buffer.byteLength(sqlOf(name), 'utf8') }))
    .sort((a, b) => b.bytes - a.bytes);
  assert.ok(sizes[0].bytes > 64 * 1024,
    `the largest migration must exceed the 64 KB stack for this probe to mean anything, saw ${sizes[0].bytes}`);
  assert.doesNotThrow(() => parseSql(sqlOf(sizes[0].name)), `${sizes[0].name} is the largest`);
});

test('the binding does not leak across many parses', () => {
  // The wrapper died after 44,590–62,874 cumulative input bytes. Well past that here, on one
  // instance, with no reload: if the heap allocation were not freed this would fail as it did.
  const sql = "SELECT 1 FROM pg_constraint k WHERE k.contype = 'f'";
  let bytes = 0;
  for (let i = 0; i < 4000; i += 1) {
    parseSql(sql);
    bytes += Buffer.byteLength(sql, 'utf8');
  }
  assert.ok(bytes > 150_000, `expected to pass the measured death threshold, sent ${bytes} bytes`);
  assert.deepEqual(relationsIn(parseSql(sql)), ['pg_constraint'], 'and it still parses correctly');
});

// ── What the binding refuses, it refuses loudly ──────────────────────────────────────────────

test('SQL the grammar refuses throws, carrying the server’s own message', () => {
  assert.throws(() => parseSql('SELECT FROM WHERE'), /SQL parse failed:/);
});

test('a routine body the PL/pgSQL parser refuses throws', () => {
  assert.throws(() => parsePlpgsqlStatement('DO $$ BEGIN this is not plpgsql END $$;'),
    /PL\/pgSQL compilation failed:/);
});

test('a call before loadParser would be refused rather than crash', () => {
  // Asserted from the source rather than by unloading the module, which no test can do once the
  // parser is loaded process-wide. The guard exists and names what the caller forgot.
  assert.match(readFileSync(join(HERE, 'pg-parse.mjs'), 'utf8'),
    /call loadParser\(\) first/);
});

// ── The two questions the binding is asked ───────────────────────────────────────────────────

test('a PL/pgSQL routine compiles from its own statement text, verbatim', () => {
  // Verbatim, NOT re-wrapped in a `DO` of our own: a trigger function re-wrapped that way loses
  // NEW and OLD and fails to compile, which is how four merged migrations were found to break.
  const routine = parsePlpgsqlStatement(
    'CREATE FUNCTION t() RETURNS TRIGGER AS $$ BEGIN\n'
    + '  IF NEW."id" IS NULL THEN RAISE EXCEPTION \'no\'; END IF;\n'
    + '  RETURN NEW;\nEND $$ LANGUAGE plpgsql;',
  );
  assert.ok(routine.PLpgSQL_function, 'one compiled routine, and it is a routine');
});

test('the tree walk needs no list of node types', () => {
  // The casing rule is the parser's own convention across all 300-odd node types. Enumerating the
  // ones this repository happens to use would rebuild the defect this whole line of work retires.
  const tree = parseSql("SELECT k.conname FROM pg_constraint k WHERE k.contype = 'f'");
  const types = new Set([...walk(tree)].map((n) => n.type));
  for (const expected of ['SelectStmt', 'RangeVar', 'ColumnRef', 'A_Expr', 'A_Const']) {
    assert.ok(types.has(expected), `the walk reaches ${expected} without being told about it`);
  }
  assert.equal(nodesOfType(tree, 'RangeVar').length, 1);
});

test('the walk reaches into sub-selects, which is where guards hide', () => {
  const tree = parseSql("SELECT 1 WHERE EXISTS (SELECT 1 FROM pg_trigger g WHERE g.tgenabled = 'D')");
  assert.deepEqual(relationsIn(tree), ['pg_trigger']);
});
