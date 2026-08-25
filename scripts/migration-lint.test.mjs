// Tests for the migration-invariant linter.
//
// A RULE THAT DOES NOT FIRE ON THE HEAD THAT PRODUCED ITS FINDING IS NOT IMPLEMENTED, so each rule
// is proven in BOTH directions against real historical commits: RED on the defective head, GREEN on
// the head that fixed it. And because the defect PR #423 was closed for was a rule whose evidence
// was gathered more coarsely than the site it judged, the binding itself is a test, with a fixture
// built to defeat exactly that — one block, four resolutions, one verdict each.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { loadParser, parseMigration } from './pg-parse.mjs';
import {
  lintMigration, lintAll, unresolvedDynamicSql, EXEMPTIONS, RULE_IDS,
  MIGRATIONS_DIR, migrationNames, exemptionKey,
} from './migration-lint.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, 'fixtures', 'migration-lint');
const fixture = (name) => readFileSync(join(FIXTURES, `${name}.sql`), 'utf8');
const linesOf = (sql) => sql.split(String.fromCharCode(10));
/** The ledger's real entries. `__README__`/`__SCHEMA__` are prose for the reader, not exemptions. */
const ledgerEntries = () => [...EXEMPTIONS].filter(([name]) => !name.startsWith('__'));
const lintFixture = (name) => lintMigration({ name, sql: fixture(name) });
const linesAt = (sql, needle) => linesOf(sql)
  .map((line, i) => (line.includes(needle) ? i + 1 : 0))
  .filter(Boolean);
const lineAt = (sql, needle) => linesAt(sql, needle)[0];

await loadParser();

// ── MI-001, proven against the commits that produced it ──────────────────────────────────────

test('MI-001 fires on PR #411 head a222e91, the head PR #412 replaced', () => {
  const findings = lintFixture('mi001-red-a222e91');
  assert.equal(findings.length, 1, 'exactly one foreign-key resolution in this extract');
  assert.equal(findings[0].rule, 'MI-001');
  // The finding lands on the query that draws the conclusion, not on the block or the file.
  const line = linesOf(fixture('mi001-red-a222e91'))[findings[0].line - 1];
  assert.match(line, /SELECT k\.confrelid::REGCLASS::TEXT INTO v_existing/);
  assert.match(findings[0].message, /tgenabled/);
});

test('MI-001 is silent on PR #412 head 96c9cc4, the head that fixed it', () => {
  assert.deepEqual(lintFixture('mi001-green-96c9cc4'), []);
});

test('MI-001 is coupled to the enforcement read, not to pg_trigger being nearby', () => {
  // Take the GREEN head and remove ONLY the enablement question, leaving the join to the key's own
  // internal triggers in place. A rule satisfied by "pg_trigger appears here" would stay silent.
  const weakened = fixture('mi001-green-96c9cc4').replaceAll('g.tgenabled', 'g.tgname');
  const findings = lintMigration({ name: 'green-weakened', sql: weakened });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].rule, 'MI-001');
});

test('MI-001 is coupled to the tgconstraint link, not to the enablement read alone', () => {
  // Sever only the link between the triggers and the constraint under test. What remains reads the
  // enablement of triggers the query can no longer claim belong to this key.
  const unlinked = fixture('mi001-green-96c9cc4').replaceAll('g.tgconstraint = c.oid', 'g.tgrelid = c.conrelid');
  const findings = lintMigration({ name: 'green-unlinked', sql: unlinked });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].rule, 'MI-001');
});

// ── The binding: evidence counts only inside the site it was found in ────────────────────────

test('MI-001 binds to the QUERY, with a correct resolution in the same DO block', () => {
  const name = 'mi001-decoy-adjacent-guard';
  const sql = fixture(name);

  // The probe is only a probe if every resolution really is in ONE routine. Asserted from the
  // parse rather than trusted from the layout: a fixture that drifted into separate blocks would
  // silently stop testing the thing that failed twice in PR #423.
  assert.equal(parseMigration(sql).routines.length, 1, 'all four resolutions must live in a single DO block');

  // A and D open with the same SELECT; they are told apart by position, in the order they appear.
  const [enforcing, pretend] = linesAt(sql, 'SELECT k.conname INTO v_bad'); // A judges, D pretends
  const presenceOnly = lineAt(sql, 'SELECT (k.convalidated');               // B — the a222e91 shape
  const projected = lineAt(sql, 'SELECT g.tgenabled INTO v_state');         // C — reads, never judges

  const lines = lintMigration({ name, sql }).map((f) => {
    assert.equal(f.rule, 'MI-001');
    return f.line;
  });
  assert.deepEqual(lines, [presenceOnly, projected, pretend],
    'B, C and D are each judged; A, standing among them, is not');
  assert.ok(!lines.includes(enforcing), 'the correct resolution must not be reported');
});

// ── SQL that does not exist until the migration runs ─────────────────────────────────────────

test('a run-time-built statement is read as the statement, or reported as unread', () => {
  const name = 'mi001-dynamic-sql';
  const sql = fixture(name);
  const parsed = parseMigration(sql);

  // Decidable text is PARSED — the presence-only guard hidden in the string literal is found.
  const findings = lintMigration({ name, sql });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].rule, 'MI-001');
  assert.match(linesOf(sql)[findings[0].line - 1], /EXECUTE 'SELECT count\(\*\) FROM pg_constraint/);

  // Undecidable text is REPORTED, and is not among the sites the rules were given.
  assert.deepEqual(parsed.unresolvedDynamicSql.map((d) => d.line), [lineAt(sql, 'EXECUTE format(')]);
  assert.ok(parsed.sites.every((s) => !String(s.sql ?? '').includes('DROP TRIGGER IF EXISTS')),
    'the format() call must not reach the rules as an ordinary query');
});

test('the run-time-built statements in the corpus are pinned, not exempted', () => {
  // Not an exemption: there is no ledger entry to write and no reason to author. The set is pinned
  // so that a NEW one fails the required `automation` job and has to be looked at.
  assert.deepEqual(unresolvedDynamicSql().map((d) => `${d.migration}:${d.line}`), [
    '20270705000000_phase5_t7biiih_sod_reviewed_status:225',
    '20270705000000_phase5_t7biiih_sod_reviewed_status:226',
    '20270705000000_phase5_t7biiih_sod_reviewed_status:318',
    '20270705000000_phase5_t7biiih_sod_reviewed_status:319',
    '20270920000000_decision_option_kinds:558',
    '20270930000000_schedule_dependency_graph:1350',
    '20270930000000_schedule_dependency_graph:1427',
    '20270930000000_schedule_dependency_graph:1555',
    '20270930000000_schedule_dependency_graph:1655',
    '20270930000000_schedule_dependency_graph:1887',
    '20270930000000_schedule_dependency_graph:1979',
  ]);
});

// ── The adapter reads the whole corpus, or says which file it could not ──────────────────────

test('every migration parses with the real grammar, and no fragment is skipped', () => {
  let routines = 0;
  let sites = 0;
  let skipped = 0;
  for (const name of migrationNames()) {
    const sql = readFileSync(join(MIGRATIONS_DIR, name, 'migration.sql'), 'utf8');
    let parsed;
    try {
      parsed = parseMigration(sql);
    } catch (err) {
      assert.fail(`${name}: ${err.message}`);
    }
    routines += parsed.routines.length;
    sites += parsed.sites.length;
    skipped += parsed.routines.reduce((n, r) => n + (r.unparsed ?? 0), 0);
  }
  assert.equal(skipped, 0, 'a construct the adapter cannot read must not pass unnoticed');
  assert.ok(routines > 300, `expected the corpus PL/pgSQL routines, saw ${routines}`);
  assert.ok(sites > 4000, `expected the corpus SQL sites, saw ${sites}`);
});

test('an unclassified PL/pgSQL statement kind stops the run rather than passing', () => {
  // The table records the kinds this repository has been SEEN to contain and reasoned about. Any
  // other kind stops the run and names itself, costing one classified line. That is deliberate:
  // PL/pgSQL's dynamic-SQL statements — `FOR … IN EXECUTE`, `OPEN … FOR EXECUTE`,
  // `RETURN QUERY EXECUTE` — are all absent from this corpus, and each would otherwise arrive
  // looking exactly like an ordinary expression. An ordinary counted loop is used as the probe
  // precisely because it is harmless: the refusal is not about danger, it is about never walking a
  // position the walker has not been told how to read.
  assert.throws(
    () => parseMigration('DO $$ BEGIN FOR i IN 1..3 LOOP PERFORM 1; END LOOP; END $$;'),
    /unclassified PL\/pgSQL statement/,
  );
});

test('a reported line is a real line of the file it names', () => {
  for (const f of lintAll().exempted) {
    const lines = linesOf(readFileSync(join(MIGRATIONS_DIR, f.migration, 'migration.sql'), 'utf8'));
    assert.ok(f.line >= 1 && f.line <= lines.length, `${f.migration}:${f.line} is out of range`);
    assert.match(lines[f.line - 1], /SELECT/i, `${f.migration}:${f.line} should name the query`);
  }
});

// ── The exemption ledger is honest ───────────────────────────────────────────────────────────

test('the corpus is clean, and every recorded exemption is explained', () => {
  const findings = lintAll();
  assert.deepEqual(findings.map((f) => `${f.migration}:${f.line} ${f.rule}`), [],
    'an unexplained finding must fail here as well as in CI');
  assert.ok(findings.exempted.length > 0, 'the ledger is not empty, so the report must not be either');
});

test('an exemption suppresses ONE site, not every site of that rule in the file', () => {
  // The ledger's own README claims exemptions are per site. Keying them by rule alone would let one
  // accepted site discharge a defective neighbour — the ledger committing the defect the rule
  // detects. Run against a real directory so the production lookup is what is being tested.
  const dir = mkdtempSync(join(tmpdir(), 'migration-lint-'));
  const name = '20990101000000_two_sites';
  mkdirSync(join(dir, name));
  const sql = fixture('mi001-decoy-adjacent-guard');
  writeFileSync(join(dir, name, 'migration.sql'), sql);

  const all = lintAll({ dir, applyExemptions: false });
  assert.equal(all.length, 3, 'the fixture carries three defective sites');

  const reason = 'ACCEPTED — a probe entry, long enough to be a reason a reviewer could check rather than a bare label.';
  const ledger = (key) => new Map([[name, { [key]: reason }]]);
  const partial = lintAll({ dir, exemptions: ledger(exemptionKey(all[0])) });
  assert.deepEqual(partial.map((f) => f.line), all.slice(1).map((f) => f.line),
    'the two unexempted sites must still fail');
  assert.deepEqual(partial.exempted.map((f) => f.line), [all[0].line]);

  // BOTH halves of the site's identity are load-bearing, so each is tested by breaking only it. A
  // line-only key lets an edited query inherit its predecessor's acceptance; a fingerprint-only key
  // exempts every identical query in the file — migration-global again.
  const moved = `${all[0].rule}:${all[0].line + 1}:${all[0].fingerprint}`;
  assert.equal(lintAll({ dir, exemptions: ledger(moved) }).exempted.length, 0,
    'a MOVED query must re-earn its exemption');
  const changed = `${all[0].rule}:${all[0].line}:deadbeefdeadbeef`;
  assert.equal(lintAll({ dir, exemptions: ledger(changed) }).exempted.length, 0,
    'a CHANGED query must re-earn its exemption');
});

test('every exemption names a real migration, a real rule, a real site, and a checkable reason', () => {
  const onDisk = new Set(readdirSync(MIGRATIONS_DIR));
  for (const [migration, entries] of ledgerEntries()) {
    assert.ok(onDisk.has(migration), `exemption names a migration that is not on disk: ${migration}`);
    const lines = linesOf(readFileSync(join(MIGRATIONS_DIR, migration, 'migration.sql'), 'utf8'));
    for (const [key, reason] of Object.entries(entries)) {
      const [rule, line, fingerprint] = key.split(':');
      assert.ok(RULE_IDS.includes(rule), `exemption names a rule that does not exist: ${rule}`);
      assert.match(line ?? '', /^\d+$/u, `exemption ${migration}/${key} must name the site's line`);
      assert.ok(Number(line) >= 1 && Number(line) <= lines.length,
        `${migration}/${key} names a line that file does not have`);
      // Both halves of the site's identity, so a CHANGED query at the same address re-earns it.
      assert.match(fingerprint ?? '', /^[0-9a-f]{16}$/u,
        `${migration}/${key} must carry the site's fingerprint as well as its line`);
      assert.ok(typeof reason === 'string' && reason.length > 120,
        `${migration}/${key} needs a reason a reviewer can check, not a label`);
    }
  }
});

test('no exemption is dead', () => {
  const raised = new Set(lintAll({ applyExemptions: false })
    .map((f) => `${f.migration} ${exemptionKey(f)}`));
  for (const [migration, entries] of ledgerEntries()) {
    for (const key of Object.keys(entries)) {
      assert.ok(raised.has(`${migration} ${key}`),
        `${migration}/${key} suppresses nothing — delete it rather than leave it standing`);
    }
  }
});

test('the live defect this unit may not repair is still reported', () => {
  // apps/api/prisma/** is read-only to this unit, so the defect stays. What must not happen is that
  // it becomes invisible: an exemption suppresses the build failure and nothing else.
  const live = lintAll().exempted.filter((f) => f.reason.startsWith('LIVE DEFECT'));
  assert.equal(live.length, 1);
  assert.equal(live[0].migration, '20270225000000_phase4_t3_correction3');
  assert.equal(live[0].rule, 'MI-001');
});
