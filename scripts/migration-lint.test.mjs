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
//   c1054005 = head of PR #410   — carries the inert top-level `SET LOCAL`
//   2f0e2af9 = head of PR #415   — fixes it; merged to main as squash commit d37a1c7e
//
// a222e91 (#411) and 96c9cc4 (#412) are the heads behind MI-001 and MI-002, and their fixtures
// travel with those rules into the catalog-guard unit.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { lintMigration, lintAll, parseMigration, constraintsCreated, RULE_IDS, MIGRATIONS_DIR } from './migration-lint.mjs';
import { statements, dollarBlocks } from './migration-sql-scan.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, 'fixtures', 'migration-lint');
const fixture = (name) => readFileSync(join(FIXTURES, name), 'utf8');

/**
 * THE RED-AGAINST-HISTORY TABLE. Each row names the rule, the head pinned as its fixture, and what
 * that head did. `red` must produce at least one finding of that rule; `green` must produce none.
 */
const CASES = [
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

// ── PER-SITE BINDING — the seven findings Codex returned against head c6e9ff17 ────────────────
//
// FOUR OF THE SEVEN WERE ONE DEFECT, and it is this linter's own subject matter one level up: a
// FILE-GLOBAL TEST STANDING IN FOR A PER-SITE CHECK. MI-001 asked "does this FILE contain a
// definition read?", MI-002 "does this FILE mention tgconstraint?", MI-003 "does this FILE's
// migrate.sh contain the token?", MI-004 "does this FILE contain a BEGIN?" — when the question in
// every case is whether THIS resolution site is guarded. That is "a check narrower than the object
// it judges" wearing its opposite: a check WIDER than the site it judges, which is the same error,
// because in both cases the evidence and the claim are about different things.
//
// ONE of those four is proved here — F4, on MI-004. The corrections for F1 (MI-003), F2 (MI-001)
// and F3 (MI-002) are written and proved by decoy fixtures of exactly this shape, and they travel
// WITH their rules into the two follow-on units the #423 correction split out; see the SCOPE note
// in migration-lint.mjs. What must not be lost is the SHAPE, so it is stated here in full even
// though one rule now carries it: a satisfied requirement at one site never satisfies another.
//
// EVERY ONE OF THESE IS AN ADJACENT-DECOY TEST, and that is not decoration. Each fixture holds TWO
// sites: one correctly guarded, one not. A fixture with a single unguarded site would fire both
// before and after the fix and would prove nothing at all — the file-global rule fires on it for
// the wrong reason. Only a satisfied neighbour can show that the rule stopped accepting one site's
// evidence for another's. Each `red` below was confirmed to produce NO finding at c6e9ff17.

const DECOY_CASES = [
  {
    id: 'F4',
    rule: 'MI-004',
    title: 'a SET LOCAL after COMMIT is no longer excused by the BEGIN that preceded it',
    was: 'file.statements.some(s => s.kind === \'BEGIN\') is order-blind, so any BEGIN accepted every scoped statement',
    sql: fixture('mi004-decoy-after-commit.sql'),
    decoy: 'the first SET LOCAL is genuinely inside the transaction and is correct',
  },
];

for (const c of DECOY_CASES) {
  test(`${c.rule} binds to the SITE, not the file — ${c.id}: ${c.title}`, () => {
    const findings = lintMigration({ name: `${c.rule}-decoy`, sql: c.sql });
    const mine = findings.filter((f) => f.rule === c.rule);
    assert.ok(mine.length > 0,
      `${c.rule} did not fire on the unguarded site. Codex ${c.id}: ${c.was}.\n`
      + `The adjacent decoy — ${c.decoy} — satisfied the file-global test and shielded the defect.\n`
      + `Findings actually produced: ${JSON.stringify(findings.map((f) => `${f.rule}@${f.line}`))}`);
  });
}

// ── The scanner desyncs — findings F5, F6, F7 ─────────────────────────────────────────────────
// These three are not per-site bugs; they are places where TEXT masqueraded as executable SQL or
// hid it. They matter for the same reason: every rule above reads the scanner's output, so a
// scanner that loses a statement makes every rule silently narrower than the file it judges.

test('F5: the constraint inventory enumerates every constraint form, not only CONSTRAINT "name" kind', () => {
  // Codex F5. The regex required a DOUBLE-QUOTED explicit name, so ordinary PostgreSQL — an
  // unquoted constraint name, an inline column constraint, a table-level unnamed one — produced an
  // EMPTY inventory and a clean MI-000. A backstop that claims totality and enumerates nothing is
  // the same false comfort as a name standing in for a definition.
  const found = constraintsCreated(fixture('mi000-unnamed-constraints.sql'));
  const kinds = found.map((c) => `${c.name ?? '(unnamed)'}:${c.kind}`);
  for (const expected of [
    'ck:CHECK',                    // CONSTRAINT ck CHECK (a > 0)      — unquoted explicit name
    'decoy_pk:PRIMARY KEY',        // CONSTRAINT decoy_pk PRIMARY KEY  — unquoted explicit name
    'decoy_b_positive:CHECK',      // ADD CONSTRAINT decoy_b_positive  — unquoted, added form
    '(unnamed):CHECK',             // a int CHECK (a > 0)              — inline column constraint
    '(unnamed):UNIQUE',            // UNIQUE (a)                       — table-level, implicit name
    '(unnamed):FOREIGN KEY',       // FOREIGN KEY (d) REFERENCES …     — table-level, implicit name
  ]) {
    assert.ok(kinds.includes(expected),
      `the inventory omits ${expected}, which is ordinary PostgreSQL. Enumerated: ${JSON.stringify(kinds)}`);
  }
  assert.deepEqual(found.filter((c) => !c.kind), [],
    'a constraint was enumerated with no kind — MI-000 must report it rather than the inventory swallowing it');
});

test('F6: a block comment cannot fabricate a dollar-quoted block', () => {
  // Codex F6. `dollarBlocks` skipped line comments and literals before recognising a `$tag$`, but
  // not BLOCK comments. Two comments carrying matching `$tag$` opened a block at the first and
  // closed it at the second, swallowing every real statement between — `statements()` found no
  // top-level semicolon inside it and merged all three under the leading SELECT. MI-004 never saw
  // the SET LOCAL; MI-000 saw a data-backfill block and was content.
  const sql = fixture('scan-block-comment-dollar-tag.sql');
  const fabricated = dollarBlocks(sql);
  assert.deepEqual(fabricated, [],
    `prose in a block comment was read as a dollar-quoted block: ${JSON.stringify(fabricated.map((b) => b.tag))}`);

  const stmts = statements(sql);
  assert.deepEqual(stmts.map((s) => s.masked.trim().split(/\s+/u).slice(0, 2).join(' ')),
    ['SELECT 1;', 'SET LOCAL', 'UPDATE public."Decoy"'],
    'the three top-level statements were merged into one by the fabricated block');

  const findings = lintMigration({ name: 'F6', sql });
  assert.ok(findings.some((f) => f.rule === 'MI-004'),
    `MI-004 did not see the SET LOCAL that the fabricated block hid: ${JSON.stringify(findings.map((f) => `${f.rule}@${f.line}`))}`);
});

test('F7: a backslash escape inside an E-string does not mask the statements after it', () => {
  // Codex F7. `E'abc\'def'` — a valid escape-string literal — ended at the ESCAPED quote, so the
  // real closing quote opened a second literal that ran on to the next quote in the file, masking
  // everything between. Three statements were reduced to one apparent SELECT and MI-004 was blind.
  const sql = fixture('scan-escape-string-literal.sql');
  const stmts = statements(sql);
  assert.equal(stmts.length, 3,
    `expected three statements, got ${stmts.length}: ${JSON.stringify(stmts.map((s) => s.masked.trim().slice(0, 40)))}`);

  const findings = lintMigration({ name: 'F7', sql });
  assert.ok(findings.some((f) => f.rule === 'MI-004'),
    `MI-004 did not see the SET LOCAL that the runaway literal hid: ${JSON.stringify(findings.map((f) => `${f.rule}@${f.line}`))}`);
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
