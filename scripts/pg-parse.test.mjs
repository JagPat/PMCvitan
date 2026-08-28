// Tests for the parser binding.
//
// The claim is small enough to test directly: all 91 migrations parse with PostgreSQL's grammar
// through this binding, and the binding neither leaks nor truncates on the largest of them. Each
// probe below corresponds to a measured fact in the binding's header — a decision recorded there
// without a test to hold it would be a comment, not a property.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  loadParser, parseSql, parsePlpgsqlStatement, walk, nodesOfType,
} from './pg-parse.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(HERE, '..', 'apps', 'api', 'prisma', 'migrations');
const migrationNames = () => readdirSync(MIGRATIONS_DIR).sort()
  .filter((n) => existsSync(join(MIGRATIONS_DIR, n, 'migration.sql')));
const sqlOf = (name) => readFileSync(join(MIGRATIONS_DIR, name, 'migration.sql'), 'utf8');

const pg = await loadParser();

// ── The claim ────────────────────────────────────────────────────────────────────────────────

test('every migration in the corpus parses with PostgreSQL’s own grammar', () => {
  const names = migrationNames();
  assert.equal(names.length, 92, 'the corpus size is pinned, so a new migration is a visible diff');
  for (const name of names) {
    // The file is NAMED here, because parseSql is handed text and cannot name it. A check whose
    // failure output does not say which of 92 files failed is not a usable check.
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

test('the binding RECLAIMS what it allocates — observed, not assumed', () => {
  // AN EARLIER VERSION OF THIS PROBE PROVED NOTHING. It parsed 4,000 short statements (~204 KB) and
  // asserted they still parsed. That reproduces the WRAPPER's 64 KB STACK exhaustion, which is a
  // different defect: 204 KB of leaked HEAP sits comfortably inside an already-17 MB WASM heap, so
  // the probe passed with `_free` deleted outright — measured. A test that survives the removal of
  // the fix it exists to protect is a check narrower than the object it judges.
  //
  // What distinguishes the two is the ALLOCATOR'S OWN BEHAVIOUR. Freed and re-requested, the same
  // size comes back at the same address; retained, each request takes a fresh one and they march
  // upward. Measured: 1 distinct pointer across 8 parses when freed, 8 when not.
  const addresses = [];
  const allocate = pg.allocate.bind(pg);
  pg.allocate = (bytes, kind) => {
    const at = allocate(bytes, kind);
    addresses.push(at);
    return at;
  };
  try {
    for (let i = 0; i < 8; i += 1) parseSql("SELECT 1 FROM pg_constraint k WHERE k.contype = 'f'");
  } finally {
    pg.allocate = allocate;
  }
  assert.equal(addresses.length, 8, 'every parse allocates once');
  assert.equal(new Set(addresses).size, 1,
    `identical inputs must reuse one reclaimed address; saw ${new Set(addresses).size} distinct: `
    + `${[...new Set(addresses)].join(' ')}`);
});

test('cumulative volume far past the wrapper’s death threshold still parses', () => {
  // The other half, kept as its own probe because it is a different claim: the convenience wrappers
  // die after 44,590–62,874 cumulative input bytes. This sends several times that on one instance.
  const sql = "SELECT 1 FROM pg_constraint k WHERE k.contype = 'f'";
  let bytes = 0;
  for (let i = 0; i < 4000; i += 1) {
    parseSql(sql);
    bytes += Buffer.byteLength(sql, 'utf8');
  }
  assert.ok(bytes > 150_000, `expected to pass the measured death threshold, sent ${bytes} bytes`);
  assert.equal(nodesOfType(parseSql(sql), 'RangeVar')[0].relname, 'pg_constraint',
    'and it still parses correctly');
});

// ── What the binding refuses, it refuses loudly ──────────────────────────────────────────────

test('SQL the grammar refuses throws, carrying the server’s own message', () => {
  assert.throws(() => parseSql('SELECT FROM WHERE'), /SQL parse failed:/);
});

test('a routine body the PL/pgSQL parser refuses throws', () => {
  assert.throws(() => parsePlpgsqlStatement('DO $$ BEGIN this is not plpgsql END $$;'),
    /PL\/pgSQL compilation failed:/);
});

test('a call before loadParser is refused by name, in a FRESH process', () => {
  // This is exercised in a child process because the parser is loaded process-wide and no test can
  // unload it. An earlier version of this probe searched the SOURCE for the guard's message, which
  // proved the string exists and nothing about the behaviour — a check narrower than the object it
  // judges, in the test rather than the code. The guard was in fact unreachable: `pg.raw_parse`
  // evaluated at the call site dereferenced a null `pg` first, so callers saw a TypeError.
  const child = spawnSync(process.execPath, ['--input-type=module', '-e',
    `import { parseSql } from ${JSON.stringify(join(HERE, 'pg-parse.mjs'))};\n`
    + 'try { parseSql("SELECT 1"); process.stdout.write("NO THROW"); }\n'
    + 'catch (err) { process.stdout.write(err.constructor.name + ": " + err.message); }',
  ], { encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);
  assert.match(child.stdout, /^Error: pg-parse: call loadParser\(\) first$/,
    'the caller is told what they forgot — not a TypeError from a null dereference');
});

test('text with an embedded NUL is refused, never parsed as its prefix', () => {
  // libpg_query reads a NUL-terminated C string, so a NUL inside the text ends it early: the
  // parser reads the prefix, returns a clean tree for it, and everything after is gone with no
  // error anywhere. A caller could not tell a short file from a truncated read, which is precisely
  // the silent-truncation failure this binding's claim rules out.
  const truncating = 'SELECT 1 FROM pg_constraint;\u0000 SELECT 1 FROM pg_trigger;';
  assert.throws(() => parseSql(truncating), /embedded NUL byte at offset 28/);

  // And the refusal is precise, not merely strict: the same text without the NUL parses whole,
  // with BOTH relations visible. A binding that rejected this too would be useless.
  const whole = truncating.replace('\u0000', '');
  assert.deepEqual(nodesOfType(parseSql(whole), 'RangeVar').map((r) => r.relname),
    ['pg_constraint', 'pg_trigger']);
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
  assert.deepEqual(nodesOfType(tree, 'RangeVar').map((r) => r.relname), ['pg_trigger']);
});

test('a RangeVar keeps the identity fields a rule will need', () => {
  // Recorded here because `relationsIn` was REMOVED for discarding them: PostgreSQL preserves the
  // case of a quoted identifier and a schema qualifies the name, so these are three DIFFERENT
  // objects. The binding hands all three apart; deciding what a rule may conclude from them is the
  // rule's own business, and is deferred with it.
  const identity = (sql) => {
    const r = nodesOfType(parseSql(sql), 'RangeVar')[0];
    return [r.schemaname ?? null, r.relname];
  };
  assert.deepEqual(identity('SELECT 1 FROM pg_trigger'), [null, 'pg_trigger']);
  assert.deepEqual(identity('SELECT 1 FROM public.pg_trigger'), ['public', 'pg_trigger']);
  assert.deepEqual(identity('SELECT 1 FROM "PG_TRIGGER"'), [null, 'PG_TRIGGER']);
});
