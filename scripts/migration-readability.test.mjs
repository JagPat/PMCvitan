// Tests for the migration parser adapter and its coverage claim.
//
// THE CLAIM UNDER TEST IS A NEGATIVE ONE — that nothing in the corpus is silently unread — so the
// probes are built to defeat the two ways this exact adapter has previously reported false total
// coverage. Both are real findings from the closed lineage of this work, not imagined ones:
//
//   a PL/pgSQL `EXECUTE` was parsed as the STRING it holds and counted as a fully-read site
//   a `LANGUAGE sql` function body was skipped by a bare `continue` and appeared in no list at all
//
// Each has a probe that FAILS against the behaviour it replaced, and the corpus totals are pinned
// so a new unreadable construct cannot arrive without a visible diff.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadParser, parseMigration, relationsIn } from './pg-parse.mjs';
import { readCorpus, migrationNames, MIGRATIONS_DIR } from './migration-readability.mjs';

const linesOf = (sql) => sql.split(String.fromCharCode(10));

await loadParser();

// ── A routine body is read according to its declared language ────────────────────────────────

test('a LANGUAGE sql body is parsed as SQL, and its statements become sites', () => {
  // RED against the bare `continue` this replaces: the body was skipped, and because
  // CreateFunctionStmt is also excluded from top-level sites, the catalog query below existed in
  // NO list — not a site, not a fragment, not a count. Five such bodies are in this corpus.
  const sql = 'CREATE FUNCTION public.helper() RETURNS BOOLEAN AS $$\n'
    + "  SELECT EXISTS (SELECT 1 FROM pg_constraint k WHERE k.conname = 'X')\n"
    + '$$ LANGUAGE sql STABLE;';
  const parsed = parseMigration(sql);
  assert.deepEqual(parsed.unreadable, [], 'a SQL body is readable, so it is not a fragment');
  assert.equal(parsed.routines.length, 1);
  assert.equal(parsed.routines[0].language, 'sql');

  const inBody = parsed.sites.filter((site) => site.routine === parsed.routines[0]);
  assert.equal(inBody.length, 1, 'the body statement is a site of its own');
  assert.ok(relationsIn(inBody[0].tree).includes('pg_constraint'),
    'and a reader asked about this site sees the catalog it queries');
  assert.equal(inBody[0].line, 2, 'reported at its real line, so the report is checkable');
});

test('a body in a language this adapter cannot read is NAMED, never stepped over', () => {
  // The honest failure. Silence here is what the whole unit exists to refuse, so an unsupported
  // language must produce a fragment rather than a quiet `continue`.
  const sql = "CREATE FUNCTION public.native() RETURNS INT AS 'obj', 'sym' LANGUAGE c;";
  const parsed = parseMigration(sql);
  assert.equal(parsed.sites.length, 0, 'nothing here may be reported as read');
  assert.deepEqual(parsed.unreadable.map((u) => u.kind), ['language-unsupported']);
  assert.equal(parsed.unreadable[0].detail, 'c');
});

test('a PL/pgSQL body is still compiled by the PL/pgSQL parser', () => {
  const sql = 'DO $$ DECLARE n INT; BEGIN\n  SELECT count(*) INTO n FROM pg_constraint;\nEND $$;';
  const parsed = parseMigration(sql);
  assert.deepEqual(parsed.unreadable, []);
  assert.equal(parsed.routines[0].language, 'plpgsql');
  assert.ok(parsed.sites.some((s) => relationsIn(s.tree).includes('pg_constraint')));
});

// ── Dynamic SQL is the statement it runs, or it is a named fragment ──────────────────────────

test('a dynamic EXECUTE whose SQL is constant is parsed as the SQL, not as a string', () => {
  const sql = 'DO $$ BEGIN\n'
    + "  EXECUTE 'SELECT k.conname FROM pg_constraint k';\nEND $$;";
  const parsed = parseMigration(sql);
  assert.deepEqual(parsed.unreadable, [], 'a constant EXECUTE is resolvable, so it is not a fragment');
  const executed = parsed.sites.filter((site) => site.dynamic);
  assert.equal(executed.length, 1);
  assert.ok(relationsIn(executed[0].tree).includes('pg_constraint'),
    'the site is the EXECUTED statement — read as a value expression it names no relation at all');
});

test('a dynamic EXECUTE the adapter cannot resolve is a fragment, never a clean site', () => {
  const sql = "DO $$ DECLARE t TEXT := 'Alpha'; BEGIN\n"
    + "  EXECUTE format('SELECT 1 FROM pg_constraint WHERE conrelid = %L::regclass', t);\nEND $$;";
  const parsed = parseMigration(sql);
  assert.equal(parsed.sites.filter((s) => s.dynamic).length, 0, 'nothing may be reported as read');
  assert.deepEqual(parsed.unreadable.map((u) => u.kind), ['dynamic-unresolved']);
  assert.equal(parsed.unreadable[0].line, 2, 'and it names the line');
});

test('an unclassified PL/pgSQL statement kind stops the run rather than passing', () => {
  // Not danger — refusal to walk a position the walker has not been told how to read. That is
  // what let a hand-written lexer desync silently in the closed PR #423.
  assert.throws(
    () => parseMigration('DO $$ BEGIN FOR i IN 1..3 LOOP PERFORM 1; END LOOP; END $$;'),
    /unclassified PL\/pgSQL statement/,
  );
});

// ── Each of these was a Codex finding on head 01a89d5, reproduced before it was fixed ────────

test('a DO block honours its DECLARED language instead of assuming PL/pgSQL', () => {
  // PostgreSQL accepts `DO LANGUAGE <any installed language>`. Assuming plpgsql handed the body to
  // raw_parse_plpgsql, which ABORTS — turning a construct that should be a reportable fragment
  // into a hard failure no explicit pin could ever clear.
  const sql = 'DO LANGUAGE plpython3u $$\nplpy.execute("SELECT 1")\n$$;';
  const parsed = parseMigration(sql);
  assert.equal(parsed.sites.length, 0);
  assert.deepEqual(parsed.unreadable.map((u) => u.kind), ['language-unsupported']);
  assert.equal(parsed.unreadable[0].detail, 'plpython3u', 'and it names the language it could not read');
});

test('a DO block with no LANGUAGE clause is still PL/pgSQL', () => {
  // The default must survive the fix: `plpgsql` is what PostgreSQL means by an absent clause.
  const parsed = parseMigration('DO $$ BEGIN PERFORM 1; END $$;');
  assert.deepEqual(parsed.unreadable, []);
  assert.equal(parsed.routines[0].language, 'plpgsql');
});

test('a multi-command dynamic EXECUTE becomes one site PER COMMAND', () => {
  // RED against recording the whole tree as one site: a rule judging that single site would draw
  // evidence from one command and excuse a defect in its neighbour — the cross-neighbour false
  // pass this adapter exists to make impossible.
  const sql = 'DO $$ BEGIN\n'
    + "  EXECUTE 'SELECT 1 FROM pg_constraint; SELECT 1 FROM pg_trigger';\nEND $$;";
  const parsed = parseMigration(sql);
  assert.deepEqual(parsed.unreadable, []);
  const executed = parsed.sites.filter((site) => site.dynamic);
  assert.equal(executed.length, 2, 'two commands are two sites');
  assert.deepEqual(executed.map((site) => relationsIn(site.tree)), [['pg_constraint'], ['pg_trigger']],
    'and each site sees only its OWN command');
});

test('a routine body is located inside its own statement, not wherever the text first appears', () => {
  // A comment quoting a short body is an earlier occurrence of the same bytes. A repository-wide
  // search takes it, and the routine plus every site inside it is then reported at unrelated text —
  // worse than not reporting, because an exact pin would point somewhere meaningless.
  // The decoy is in a BLOCK comment, which also puts a dollar tag inside a comment — one of the
  // two constructs that desynced PR #423's hand-written lexer. PostgreSQL's own grammar handles it.
  const body = '\n  SELECT 1 FROM pg_constraint\n';
  const sql = `/* a comment quoting the body: $$${body}$$ */\n`
    + `CREATE FUNCTION public.helper() RETURNS INT AS $$${body}$$ LANGUAGE sql;`;
  const parsed = parseMigration(sql);
  assert.deepEqual(parsed.unreadable, []);
  assert.equal(parsed.routines.length, 1);
  // The decoy body opens on line 1; the REAL one opens on line 4.
  assert.equal(parsed.routines[0].startLine, 4, 'the body inside the CREATE FUNCTION, not the quote');
  assert.equal(parsed.sites.filter((site) => site.routine === parsed.routines[0])[0].line, 5,
    'and the site inside it is reported at its own line, not at the comment');
});

test('a migration that cannot be read names the FILE, not just the construct', () => {
  // parseMigration is handed TEXT, so none of its four refusals can name a file. Over 91
  // migrations an uncaught throw leaves the one file that matters unidentifiable.
  const dir = mkdtempSync(join(tmpdir(), 'migration-readability-'));
  const name = '20990101000000_unreadable';
  mkdirSync(join(dir, name));
  writeFileSync(join(dir, name, 'migration.sql'),
    'DO $$ BEGIN FOR i IN 1..3 LOOP PERFORM 1; END LOOP; END $$;');
  assert.throws(() => readCorpus({ dir }), (err) => {
    assert.match(err.message, /20990101000000_unreadable\/migration\.sql/, 'the file is named');
    assert.match(err.message, /unclassified PL\/pgSQL statement/, 'and so is the construct');
    assert.equal(err.migration, name);
    return true;
  });
});

// ── The corpus, accounted for ────────────────────────────────────────────────────────────────

test('every migration parses with the real grammar, and the corpus totals are pinned', () => {
  for (const name of migrationNames()) {
    const sql = readFileSync(join(MIGRATIONS_DIR, name, 'migration.sql'), 'utf8');
    assert.doesNotThrow(() => parseMigration(sql), `${name} must parse`);
  }
  const corpus = readCorpus();
  assert.equal(corpus.migrations, 91);
  // 338 routines and 4,101 sites INCLUDE the five LANGUAGE sql bodies and the statements inside
  // them. Before those bodies were read the same corpus measured 333 and 4,096, and reported the
  // difference nowhere at all.
  assert.equal(corpus.routines, 338);
  assert.equal(corpus.sites, 4101);
});

test('the fragments this adapter cannot read are pinned as an exact set, not a count', () => {
  // A count would let one unreadable construct be swapped for another without a diff. Every entry
  // here is SQL built at run time from values that do not exist until the migration runs — ten
  // `format(...)` and one `r.ddl`. None can be resolved without executing the routine.
  assert.deepEqual(readCorpus().unreadable.map((u) => `${u.kind} ${u.migration}:${u.line}`), [
    'dynamic-unresolved 20270705000000_phase5_t7biiih_sod_reviewed_status:225',
    'dynamic-unresolved 20270705000000_phase5_t7biiih_sod_reviewed_status:226',
    'dynamic-unresolved 20270705000000_phase5_t7biiih_sod_reviewed_status:318',
    'dynamic-unresolved 20270705000000_phase5_t7biiih_sod_reviewed_status:319',
    'dynamic-unresolved 20270920000000_decision_option_kinds:558',
    'dynamic-unresolved 20270930000000_schedule_dependency_graph:1350',
    'dynamic-unresolved 20270930000000_schedule_dependency_graph:1427',
    'dynamic-unresolved 20270930000000_schedule_dependency_graph:1555',
    'dynamic-unresolved 20270930000000_schedule_dependency_graph:1655',
    'dynamic-unresolved 20270930000000_schedule_dependency_graph:1887',
    'dynamic-unresolved 20270930000000_schedule_dependency_graph:1979',
  ]);
});

test('every SQL-language body in the corpus is read, and each yields sites', () => {
  // The regression this unit closes, asserted against the real corpus rather than a fixture: the
  // five bodies are found, classified `sql`, and every one contributes at least one site.
  const found = [];
  for (const name of migrationNames()) {
    const parsed = parseMigration(readFileSync(join(MIGRATIONS_DIR, name, 'migration.sql'), 'utf8'));
    for (const routine of parsed.routines.filter((r) => r.language === 'sql')) {
      const sites = parsed.sites.filter((s) => s.routine === routine);
      assert.ok(sites.length > 0, `${name}:${routine.startLine} is read but contributes no site`);
      found.push(`${name}:${routine.startLine}`);
    }
  }
  assert.deepEqual(found, [
    '20270510000000_phase5_t5b_certification:342',
    '20270601000000_phase5_t6a_payment_authority:468',
    '20270610000000_phase5_t6b_status_derivation:83',
    '20270705000000_phase5_t7biiih_sod_reviewed_status:134',
    '20270705000000_phase5_t7biiih_sod_reviewed_status:432',
  ]);
});

test('a reported fragment names a real line of the file it names', () => {
  for (const u of readCorpus().unreadable) {
    const lines = linesOf(readFileSync(join(MIGRATIONS_DIR, u.migration, 'migration.sql'), 'utf8'));
    assert.ok(u.line >= 1 && u.line <= lines.length, `${u.migration}:${u.line} is out of range`);
    assert.match(lines[u.line - 1], /EXECUTE|ddl/i, `${u.migration}:${u.line} should name the statement`);
  }
});
