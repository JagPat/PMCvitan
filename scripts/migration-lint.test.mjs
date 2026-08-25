// Every rule in scripts/migration-lint.mjs is proved RED against the REAL HISTORICAL COMMIT that
// produced its finding, and GREEN against the commit that fixed it.
//
// The fragments are committed verbatim extracts under scripts/fixtures/migration-lint/, NOT
// references to the live migration: that file is one a later unit may edit, and a test reading it
// directly would go vacuous — silently, and in the green direction — the moment somebody rewrote
// the section it depends on. Pinning the fragment is what stops the detection rotting.
//
// The SHA→PR mapping was verified against `git log` before these citations were written, because
// it is easy and expensive to get wrong: each finding was found ON one head and fixed IN the next,
// so the head that CARRIES a defect is the PREDECESSOR of the PR whose title announces the fix.
//
//   a222e91  = head of PR #411   — carries the barrier-by-name and unenforced-FK defects
//   96c9cc4  = head of PR #412   — fixes both; carries the TRUNCATE-isolation and FK-name defects
//   2f0e2af9 = head of PR #415   — fixes both; merged to main as squash commit d37a1c7e
//   c1054005 = head of PR #410   — carries the inert top-level `SET LOCAL`

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { lintMigration, lintAll, parseMigration, RULE_IDS, MIGRATIONS_DIR, repoContext } from './migration-lint.mjs';
import { statements } from './migration-sql-scan.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, 'fixtures', 'migration-lint');
const fixture = (name) => readFileSync(join(FIXTURES, name), 'utf8');

/** The two migrate.sh shapes MI-003 distinguishes, quoted from the real file at each head. */
const MIGRATE_SH = {
  // PR #411 head a222e91: no B1 verifier at all. "section B1" DOES appear after the deploy — in a
  // COMMENT about an unrelated migration-resolution branch — which is why MI-003 reads executable
  // lines only. This fixture reproduces that trap deliberately.
  withoutVerifier: [
    'out=$(npx prisma migrate deploy 2>&1)',
    'code=$?',
    'if [ $code -eq 0 ]; then',
    '  if ! node "$T3C_PREFLIGHT" seals; then',
    '    echo "[migrate] ERROR: T3C seal verification FAILED."',
    '    exit 1',
    '  fi',
    'fi',
    '# object and points at docs/RUNBOOK.md section B1. ROWS ALONE ARE NOT A REFUSAL: a COMPLETE',
    '# install may be replayed as often as you like.',
  ].join('\n'),
  // PR #412 head 96c9cc4: the counterpart, on the success path.
  withVerifier: [
    'out=$(npx prisma migrate deploy 2>&1)',
    'code=$?',
    'if [ $code -eq 0 ]; then',
    '  if ! node "$B1_SEALS" seals; then',
    '    echo "[migrate] ERROR: the schedule B1 seal verification FAILED."',
    '    echo "[migrate] Repair per docs/RUNBOOK.md section B1, then redeploy."',
    '    exit 1',
    '  fi',
    'fi',
  ].join('\n'),
};

/**
 * THE RED-AGAINST-HISTORY TABLE. Each row names the rule, the head pinned as its fixture, and what
 * that head did. `red` must produce at least one finding of that rule; `green` must produce none.
 */
const CASES = [
  {
    rule: 'MI-001',
    finding: 'the barrier was resolved by conname and its DEFINITION fetched but only NULL-tested, so a '
      + 'same-named hollow CHECK (true) read as "this table is unwritable"',
    red: { head: 'a222e91 (PR #411)', sql: fixture('mi001-red-a222e91.sql') },
    green: { head: '96c9cc4 (PR #412)', sql: fixture('green-96c9cc4.sql') },
  },
  {
    rule: 'MI-002',
    finding: 'five foreign keys were compared by definition, confrelid OID and convalidated — none of which '
      + 'survives being asked whether the key still ENFORCES after DISABLE TRIGGER ALL',
    red: { head: 'a222e91 (PR #411)', sql: fixture('mi002-red-a222e91.sql') },
    green: { head: '96c9cc4 (PR #412)', sql: fixture('green-96c9cc4.sql') },
  },
  {
    rule: 'MI-003',
    finding: 'the seals were verified only while the migration was being applied; migrate.sh had no '
      + 'counterpart, so a restore that disabled one produced a green deploy',
    red: { head: 'a222e91 (PR #411)', sql: fixture('mi003-seals.sql'), context: { migrateSh: MIGRATE_SH.withoutVerifier } },
    green: { head: '96c9cc4 (PR #412)', sql: fixture('mi003-seals.sql'), context: { migrateSh: MIGRATE_SH.withVerifier } },
  },
  {
    rule: 'MI-004',
    finding: 'a top-level SET LOCAL search_path in a file with no explicit transaction block — inert for '
      + 'the caller that supplies none, so the foreign-key targets bound through the caller\'s path',
    red: { head: 'c1054005 (PR #410)', sql: fixture('mi004-red-c1054005.sql') },
    green: { head: '2f0e2af9 (PR #415)', sql: fixture('green-2f0e2af9.sql') },
  },
];

for (const c of CASES) {
  test(`${c.rule} fires on the head that produced its finding — ${c.red.head}`, () => {
    const findings = lintMigration({ name: `${c.rule}-red`, sql: c.red.sql, context: c.red.context ?? {} });
    const mine = findings.filter((f) => f.rule === c.rule);
    assert.ok(mine.length > 0,
      `${c.rule} did not fire on ${c.red.head}, the head that produced its finding: ${c.finding}.\n`
      + `A rule that does not fire on its own originating head is not implemented.\n`
      + `Findings actually produced: ${JSON.stringify(findings.map((f) => `${f.rule}@${f.line}`))}`);
  });

  test(`${c.rule} clears on the head that fixed it — ${c.green.head}`, () => {
    const findings = lintMigration({ name: `${c.rule}-green`, sql: c.green.sql, context: c.green.context ?? {} });
    const mine = findings.filter((f) => f.rule === c.rule);
    assert.deepEqual(mine.map((f) => `${f.rule}@${f.line}: ${f.message.slice(0, 90)}`), [],
      `${c.rule} still fires on ${c.green.head}, which corrected the defect. The rule is detecting `
      + 'something other than the thing it is named for.');
  });
}

test('every rule has a RED-against-history case', () => {
  const covered = new Set(CASES.map((c) => c.rule));
  // MI-000 is the enumerate-and-classify backstop rather than a lineage finding; it is proved by
  // the corpus-totality tests below, which are a stronger claim than a single fixture.
  const expected = RULE_IDS.filter((id) => id !== 'MI-000');
  assert.deepEqual(expected.filter((id) => !covered.has(id)), [],
    'a rule exists with no proof that it fires on the defect it was written for');
});

// ── The enumerate-and-classify property ──────────────────────────────────────────────────────
// MI-000's claim is that nothing passes by being unrecognised. That is checked against the whole
// corpus rather than a fixture, because the claim is about COVERAGE and a fixture cannot show it.

test('every top-level statement in every migration on main classifies', () => {
  const unclassified = [];
  for (const name of readdirSync(MIGRATIONS_DIR).sort()) {
    const file = join(MIGRATIONS_DIR, name, 'migration.sql');
    if (!existsSync(file)) continue;
    const sql = readFileSync(file, 'utf8');
    for (const s of parseMigration(sql).statements) {
      if (!s.kind) unclassified.push(`${name}:${s.line} ${s.masked.trim().replace(/\s+/gu, ' ').slice(0, 60)}`);
    }
  }
  assert.deepEqual(unclassified, [],
    'a top-level statement classifies as nothing. Every rule decides what to ask of a statement '
    + 'from its kind, so an unclassified one is checked by none of them. Add it to STATEMENT_KINDS.');
});

test('every constraint and every DO block in every migration on main classifies', () => {
  const unclassified = [];
  for (const name of readdirSync(MIGRATIONS_DIR).sort()) {
    const file = join(MIGRATIONS_DIR, name, 'migration.sql');
    if (!existsSync(file)) continue;
    const parsed = parseMigration(readFileSync(file, 'utf8'));
    for (const c of parsed.constraints) if (!c.kind) unclassified.push(`${name}:${c.line} constraint ${c.name} (${c.raw})`);
    for (const b of parsed.blocks) if (b.roles.length === 0) unclassified.push(`${name}:${b.line} block ${b.tag}`);
  }
  assert.deepEqual(unclassified, [],
    'a constraint kind or DO-block role is unrecognised. MI-000 exists so that this fails loudly '
    + 'rather than being skipped in silence.');
});

// ── The scanner, which everything else rests on ──────────────────────────────────────────────

test('the scanner does not read defects out of comments or literals', () => {
  // Every rule reads the MASK. If the mask leaked comment text, a file that merely DESCRIBES a
  // defect would be reported as containing it — and, far worse, a comment that mentions
  // pg_get_constraintdef would satisfy a rule asking whether the comparison is present.
  const sql = [
    '-- SET LOCAL search_path = public;  <- this is prose, not a statement',
    "-- and this comment mentions pg_get_constraintdef and tgenabled and transaction_isolation",
    "SELECT 'SET LOCAL search_path = public' AS quoted_prose;",
    'CREATE TABLE IF NOT EXISTS "T" ("id" TEXT NOT NULL);',
  ].join('\n');
  const findings = lintMigration({ name: 'comment-only', sql });
  assert.deepEqual(findings, [], `a defect was read out of a comment or a string literal: ${JSON.stringify(findings)}`);

  const parsed = parseMigration(sql);
  assert.equal(parsed.statements.length, 2, 'comment-only fragments must not be offered as statements');
});

test('the scanner pairs nested dollar-quote tags rather than toggling on $$', () => {
  // `DO $install$ … $body$ … $body$ … $install$` desynchronises any scanner that treats $$ as a
  // single toggle, and half the file is then masked as string content — which fails OPEN.
  const sql = [
    'DO $install$',
    'DECLARE v TEXT := $body$ BEGIN RETURN NULL; END $body$;',
    'BEGIN',
    '  PERFORM 1;',
    'END $install$;',
    'CREATE TABLE IF NOT EXISTS "After" ("id" TEXT);',
  ].join('\n');
  const stmts = statements(sql);
  assert.equal(stmts.length, 2, `expected the DO block and the CREATE to be two statements, got ${stmts.length}`);
  assert.match(stmts[1].masked, /CREATE\s+TABLE/u, 'the statement after a nested block was lost');
});

// ── The corpus contract ──────────────────────────────────────────────────────────────────────

test('the linter is clean against every migration on main, exemptions applied', () => {
  const findings = lintAll();
  assert.deepEqual(findings.map((f) => `${f.rule} ${f.migration}:${f.line}`), [],
    'a migration on main produces an unexempted finding. Either it is a real defect, or the rule '
    + 'needs scoping, or the exemption needs a written reason in scripts/migration-lint-exemptions.json.');
});

test('every exemption names a rule that exists and a migration that exists', () => {
  const raw = JSON.parse(readFileSync(join(HERE, 'migration-lint-exemptions.json'), 'utf8'));
  const stale = [];
  for (const [migration, rules] of Object.entries(raw)) {
    if (migration.startsWith('__')) continue;
    if (!existsSync(join(MIGRATIONS_DIR, migration, 'migration.sql'))) { stale.push(`${migration} (no such migration)`); continue; }
    for (const [rule, reason] of Object.entries(rules)) {
      if (!RULE_IDS.includes(rule)) stale.push(`${migration}/${rule} (no such rule)`);
      if (typeof reason !== 'string' || reason.trim().length < 40) stale.push(`${migration}/${rule} (reason too short to be checkable)`);
    }
  }
  assert.deepEqual(stale, [], 'the exemption ledger has drifted from the repository');
});

test('no exemption is dead — each one still suppresses something', () => {
  // An exemption that no longer suppresses anything is a claim about the corpus that has stopped
  // being true, and leaving it in place hides the next migration that reintroduces the shape.
  const withExemptions = lintAll();
  const without = lintAll({ applyExemptions: false });
  assert.equal(withExemptions.length, 0, 'precondition: the exempted run is clean');
  const raw = JSON.parse(readFileSync(join(HERE, 'migration-lint-exemptions.json'), 'utf8'));
  const live = new Set(without.map((f) => `${f.migration}/${f.rule}`));
  const dead = [];
  for (const [migration, rules] of Object.entries(raw)) {
    if (migration.startsWith('__')) continue;
    for (const rule of Object.keys(rules)) if (!live.has(`${migration}/${rule}`)) dead.push(`${migration}/${rule}`);
  }
  assert.deepEqual(dead, [], 'an exemption suppresses nothing and should be deleted');
});

test('repoContext finds the two files the cross-file rules need', () => {
  const context = repoContext();
  assert.match(context.migrateSh, /prisma\s+migrate\s+deploy/u, 'migrate.sh was not readable; MI-003 would pass vacuously');
  assert.match(context.prismaSchema, /^model\s+/mu, 'schema.prisma was not readable; MI-006 would pass vacuously');
});
