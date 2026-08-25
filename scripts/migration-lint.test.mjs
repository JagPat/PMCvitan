// Tests for the migration-invariant linter.
//
// A RULE THAT DOES NOT FIRE ON THE HEAD THAT PRODUCED ITS FINDING IS NOT IMPLEMENTED, so each rule
// is proven in BOTH directions against real historical commits: RED on the defective head, GREEN on
// the head that fixed it. And because the defect PR #423 was closed for was a rule whose evidence
// was gathered more coarsely than the site it judged, the binding itself is a test, with a fixture
// built to defeat exactly that — one block, two resolutions, one verdict each.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadParser, parseMigration } from './pg-parse.mjs';
import {
  lintMigration, lintAll, EXEMPTIONS, RULE_IDS, MIGRATIONS_DIR, migrationNames,
} from './migration-lint.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, 'fixtures', 'migration-lint');
const fixture = (name) => readFileSync(join(FIXTURES, `${name}.sql`), 'utf8');
const linesOf = (sql) => sql.split(String.fromCharCode(10));
const lintFixture = (name) => lintMigration({ name, sql: fixture(name) });

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

// ── The binding: evidence counts only inside the site it was found in ────────────────────────

test('MI-001 binds to the QUERY, with a correct resolution in the same DO block', () => {
  const name = 'mi001-decoy-adjacent-guard';
  const sql = fixture(name);
  const lines = linesOf(sql);

  // The probe is only a probe if both resolutions really are in ONE routine. Asserted from the
  // parse rather than trusted from the layout: a fixture that drifted into two blocks would
  // silently stop testing the thing that failed twice in PR #423.
  assert.equal(parseMigration(sql).routines.length, 1, 'both resolutions must live in a single DO block');

  const findings = lintMigration({ name, sql });
  assert.equal(findings.length, 1, 'resolution B is judged and resolution A is not');
  assert.equal(findings[0].rule, 'MI-001');
  assert.match(lines[findings[0].line - 1], /k\.convalidated AND k\.confrelid/, 'the finding is on resolution B');

  const resolutionA = lines.findIndex((l) => l.includes('SELECT k.conname INTO v_bad')) + 1;
  assert.ok(resolutionA > 0);
  assert.ok(findings.every((f) => f.line !== resolutionA), 'resolution A must not be reported');
  assert.ok(findings[0].line > resolutionA, 'and the reported site is the later one');
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

test('every exemption names a real migration, a real rule, and a checkable reason', () => {
  const onDisk = new Set(readdirSync(MIGRATIONS_DIR));
  for (const [migration, rules] of EXEMPTIONS) {
    if (migration === '__README__') continue;
    assert.ok(onDisk.has(migration), `exemption names a migration that is not on disk: ${migration}`);
    assert.ok(existsSync(join(MIGRATIONS_DIR, migration, 'migration.sql')));
    for (const [rule, reason] of Object.entries(rules)) {
      assert.ok(RULE_IDS.includes(rule), `exemption names a rule that does not exist: ${rule}`);
      assert.ok(typeof reason === 'string' && reason.length > 120,
        `${migration}/${rule} needs a reason a reviewer can check, not a label`);
    }
  }
});

test('no exemption is dead', () => {
  const raised = new Set(lintAll({ applyExemptions: false }).map((f) => `${f.migration} ${f.rule}`));
  for (const [migration, rules] of EXEMPTIONS) {
    if (migration === '__README__') continue;
    for (const rule of Object.keys(rules)) {
      assert.ok(raised.has(`${migration} ${rule}`),
        `${migration}/${rule} suppresses nothing — delete it rather than leave it standing`);
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
