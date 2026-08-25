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
//   a222e91  = head of PR #411  — carries the name-over-definition and unenforced-key defects
//   96c9cc4  = head of PR #412  — fixes them; also the head that added the deploy-time verifier
//   2f0e2af9 = head of PR #415  — the merged head, squashed to main as d37a1c7e
//
// MI-000 and MI-004 are deferred to the follow-on unit. Their corrected implementations, fixtures
// and tests are committed at a8b401ba on this branch and recorded in docs/MIGRATION_INVARIANTS.md.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { lintMigration, lintAll, parseMigration, guardedProcedureTokens, RULE_IDS, MIGRATIONS_DIR } from './migration-lint.mjs';
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
    rule: 'MI-001',
    finding: 'a constraint definition FETCHED with pg_get_constraintdef and then only NULL-tested, so a '
      + 'same-named hollow CHECK (true) satisfied the guard while admitting every INSERT',
    red: { head: 'a222e91 (PR #411)', sql: fixture('mi001-red-a222e91.sql') },
    green: { head: '96c9cc4 (PR #412)', sql: fixture('green-96c9cc4.sql') },
  },
  {
    rule: 'MI-002',
    finding: 'five foreign keys verified through pg_constraint — conname, contype, conrelid, confrelid — '
      + 'none of which changes when ALTER TABLE ... DISABLE TRIGGER ALL stops the key enforcing',
    red: { head: 'a222e91 (PR #411)', sql: fixture('mi002-red-a222e91.sql') },
    green: { head: '96c9cc4 (PR #412)', sql: fixture('green-96c9cc4.sql') },
  },
  {
    // MI-003's RED and GREEN are the SAME migration. What differs is migrate.sh: at a222e91 the
    // seals were verified only by a PREFLIGHT, which runs against the database as it WAS.
    rule: 'MI-003',
    finding: 'seals verified only while the migration was applying, so once its row was in '
      + '_prisma_migrations a restore that disabled a seal still produced a green deploy',
    red: {
      head: 'a222e91 (PR #411)',
      sql: fixture('mi003-seals.sql'),
      context: { migrateSh: fixture('mi003-red-migrate-preflight-only.sh') },
    },
    green: {
      head: '96c9cc4 (PR #412)',
      sql: fixture('mi003-seals.sql'),
      context: { migrateSh: fixture('mi003-green-migrate-invoked.sh') },
    },
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
  assert.deepEqual(RULE_IDS.filter((id) => !covered.has(id)), [],
    'a rule exists with no proof that it fires on the defect it was written for');
});

// ── PER-SITE BINDING — the Codex findings against head c6e9ff17 ───────────────────────────────
//
// FOUR OF THE SEVEN WERE ONE DEFECT, and it is this linter's own subject matter one level up: a
// FILE-GLOBAL TEST STANDING IN FOR A PER-SITE CHECK. MI-001 asked "does this FILE contain a
// definition read?", MI-002 "does this FILE mention tgconstraint?", MI-003 "does this FILE's
// migrate.sh contain the token?", MI-004 "does this FILE contain a BEGIN?" — when the question in
// every case is whether THIS resolution site is guarded. That is "a check narrower than the object
// it judges" wearing its opposite: a check WIDER than the site it judges, which is the same error,
// because in both cases the evidence and the claim are about different things.
//
// Three of the four are proved here — F2 (MI-001), F3 (MI-002) and F1 (MI-003). F4 (MI-004) is
// proved by the same shape at a8b401ba, the head this one replaces, and travels with that rule.
//
// EVERY ONE OF THESE IS AN ADJACENT-DECOY TEST, and that is not decoration. Each fixture holds TWO
// sites: one correctly guarded, one not. A fixture with a single unguarded site would fire both
// before and after the fix and would prove nothing at all — the file-global rule fires on it for
// the wrong reason. Only a satisfied neighbour can show that the rule stopped accepting one site's
// evidence for another's. Each `sql`/`context` pair below was confirmed to produce NO finding of
// its rule when run against the c6e9ff17 implementation.

const DECOY_CASES = [
  {
    id: 'F2',
    rule: 'MI-001',
    title: 'a guard with no definition read is no longer excused by a neighbour that has one',
    was: 'the rule took one site per catalog with .find() and then asked pg_get_constraintdef of file.masked',
    sql: fixture('mi001-decoy-adjacent-guard.sql'),
    decoy: 'the first guard genuinely fetches pg_get_constraintdef and compares what came back',
    site: 27,
  },
  {
    id: 'F3',
    rule: 'MI-002',
    title: 'a foreign-key guard with no enforcement read is no longer excused by a neighbour that has one',
    was: 'the rule took the first contype=\'f\' site and asked whether the FILE mentioned tgconstraint and tgenabled',
    sql: fixture('mi002-decoy-adjacent-guard.sql'),
    decoy: 'the first guard genuinely joins pg_trigger on tgconstraint and refuses tgenabled in (D, R)',
    site: 31,
  },
  {
    id: 'F1',
    rule: 'MI-003',
    title: 'a procedure token printed by an echo is not an invocation that verifies anything',
    was: 'the rule stripped COMMENT lines and asked whether the token appeared in the remaining post-deploy text',
    sql: fixture('mi003-seals.sql'),
    context: { migrateSh: fixture('mi003-decoy-migrate-echo-only.sh') },
    decoy: 'the adjacent §OTHER procedure IS properly verified, in the failure branch of a real command',
  },
];

for (const c of DECOY_CASES) {
  test(`${c.rule} binds to the SITE, not the file — ${c.id}: ${c.title}`, () => {
    const findings = lintMigration({ name: `${c.rule}-decoy`, sql: c.sql, context: c.context ?? {} });
    const mine = findings.filter((f) => f.rule === c.rule);
    assert.ok(mine.length > 0,
      `${c.rule} did not fire on the unguarded site. Codex ${c.id}: ${c.was}.\n`
      + `The adjacent decoy — ${c.decoy} — satisfied the file-global test and shielded the defect.\n`
      + `Findings actually produced: ${JSON.stringify(findings.map((f) => `${f.rule}@${f.line}`))}`);
    if (c.site !== undefined) {
      assert.deepEqual(mine.map((f) => f.line), [c.site],
        `${c.rule} must fire on the UNGUARDED site only. Firing on the guarded neighbour as well would `
        + 'mean the rule stopped reading the evidence rather than started binding it to a site.');
    }
  });
}

// ── MI-003's shell parser: what counts as an INVOCATION ───────────────────────────────────────
// The rule's whole claim rests on telling a command that VERIFIES from a sentence that DESCRIBES.
// It fails CLOSED: a construct the parser cannot read yields no guarded tokens, so the rule fires.

test('F1: only a token guarded by a real post-deploy invocation counts', () => {
  const invoked = guardedProcedureTokens(fixture('mi003-green-migrate-invoked.sh'));
  assert.ok(invoked.has('section B1'),
    `a token inside the failure branch of \`node "$B1_SEALS" seals\` must count: ${JSON.stringify([...invoked])}`);

  const echoOnly = guardedProcedureTokens(fixture('mi003-decoy-migrate-echo-only.sh'));
  assert.equal(echoOnly.has('section B1'), false,
    'a token named only by an `echo` was accepted as evidence that something verified the seals');
  assert.ok(echoOnly.has('§OTHER'),
    `the adjacent, genuinely-invoked procedure must still count: ${JSON.stringify([...echoOnly])}`);

  const preflightOnly = guardedProcedureTokens(fixture('mi003-red-migrate-preflight-only.sh'));
  assert.equal(preflightOnly.has('section B1'), false,
    'a verifier that runs BEFORE `prisma migrate deploy` answers about the database as it WAS');
});

test('the repository\'s own migrate.sh is read correctly', () => {
  // The live file is the one worked precedent, so it is asserted directly rather than in a fixture.
  // If a later unit rewrites migrate.sh, this test says so instead of MI-003 silently going green.
  const sh = join(HERE, '..', 'apps', 'api', 'scripts', 'migrate.sh');
  const guarded = guardedProcedureTokens(readFileSync(sh, 'utf8'));
  assert.ok(guarded.has('section B1'),
    'apps/api/scripts/migrate.sh invokes `node "$B1_SEALS" seals` on the deploy success path and names '
    + `"section B1" in its failure branch; the parser no longer sees it: ${JSON.stringify([...guarded])}`);
  assert.ok(guarded.has('§P4T3C3'),
    `the T3C seal verification is the same shape and must also be seen: ${JSON.stringify([...guarded])}`);
  assert.equal(guarded.has('§T45'), false,
    'the T45 check is a PREFLIGHT — it runs before the deploy and cannot answer whether the seals are '
    + 'armed now, so it must not be read as a post-deploy verification');
});

// ── The scanner desyncs — findings F6 and F7 ──────────────────────────────────────────────────
// These are not per-site bugs; they are places where TEXT masqueraded as executable SQL or hid it.
// They ship in THIS unit regardless of which rules it carries, because every rule reads the
// scanner's output: a scanner that loses a block makes every rule silently narrower than the file
// it judges. Both probes below hide a CATALOG GUARD, so what they prove is that MI-001 — the rule
// that judges guards — can see it. Under the c6e9ff17 scanner neither produced an MI-001 finding.

test('F6: a block comment cannot fabricate a dollar-quoted block', () => {
  const sql = fixture('scan-block-comment-dollar-tag.sql');
  const tags = dollarBlocks(sql).map((b) => b.tag);
  assert.deepEqual(tags.filter((t) => t === '$tag$'), [],
    `prose in a block comment was read as a dollar-quoted block: ${JSON.stringify(tags)}`);

  const findings = lintMigration({ name: 'F6', sql });
  assert.ok(findings.some((f) => f.rule === 'MI-001'),
    'MI-001 did not see the refusing catalog guard that the fabricated block hid. The fabrication '
    + 'swallowed the real `DO $$` opener, so the guard was never a depth-0 block, and what stood in '
    + `its place ended before the RAISE EXCEPTION and so did not refuse: ${JSON.stringify(findings.map((f) => `${f.rule}@${f.line}`))}`);
});

test('F7: a backslash escape inside an E-string does not mask the statements after it', () => {
  const sql = fixture('scan-escape-string-literal.sql');
  const stmts = statements(sql);
  assert.equal(stmts.length, 2,
    `expected the SELECT and the DO block to be two statements, got ${stmts.length}: `
    + JSON.stringify(stmts.map((s) => s.masked.trim().slice(0, 40))));
  assert.equal(dollarBlocks(sql).filter((b) => b.depth === 0).length, 1,
    'the runaway literal swallowed the `DO $$` opener, so the guard was not a block at all');

  const findings = lintMigration({ name: 'F7', sql });
  assert.ok(findings.some((f) => f.rule === 'MI-001'),
    `MI-001 did not see the catalog guard that the runaway literal hid: ${JSON.stringify(findings.map((f) => `${f.rule}@${f.line}`))}`);
});

// ── The classification the rules navigate by ─────────────────────────────────────────────────
// MI-001 and MI-003 decide what to ask of a DO block FROM its role, so a block that classifies as
// nothing is checked by neither. MI-000 — the rule that FAILS on such a block during
// `pnpm lint:migrations` — is deferred to the follow-on unit, so until it lands this corpus test
// is the only thing asserting the property. It is a weaker guarantee and the difference is real:
// a new migration carrying an unrecognised construct fails `pnpm test:automation` but NOT
// `pnpm lint:migrations`. That gap closes when MI-000 lands. See docs/MIGRATION_INVARIANTS.md.

test('every top-level statement in every migration on main classifies', () => {
  const unclassified = [];
  for (const name of readdirSync(MIGRATIONS_DIR).sort()) {
    const file = join(MIGRATIONS_DIR, name, 'migration.sql');
    if (!existsSync(file)) continue;
    for (const s of parseMigration(readFileSync(file, 'utf8')).statements) {
      if (!s.kind) unclassified.push(`${name}:${s.line} ${s.masked.trim().replace(/\s+/gu, ' ').slice(0, 60)}`);
    }
  }
  assert.deepEqual(unclassified, [],
    'a top-level statement classifies as nothing. Every rule decides what to ask of a statement '
    + 'from its kind, so an unclassified one is checked by none of them. Add it to STATEMENT_KINDS.');
});

test('every DO block in every migration on main classifies', () => {
  const unclassified = [];
  for (const name of readdirSync(MIGRATIONS_DIR).sort()) {
    const file = join(MIGRATIONS_DIR, name, 'migration.sql');
    if (!existsSync(file)) continue;
    for (const b of parseMigration(readFileSync(file, 'utf8')).blocks) {
      if (b.roles.length === 0) unclassified.push(`${name}:${b.line} block ${b.tag}`);
    }
  }
  assert.deepEqual(unclassified, [],
    'a DO-block role is unrecognised. MI-001 and MI-003 ask a different question of a guard than of '
    + 'a backfill, so an unrecognised block is checked by neither. Classify it in BLOCK_ROLES.');
});

// ── The scanner, which everything else rests on ──────────────────────────────────────────────

test('the scanner does not read defects out of comments or literals', () => {
  // Every rule reads the MASK. If the mask leaked comment text, a file that merely DESCRIBES a
  // defect would be reported as containing it — and, far worse, a comment that mentions
  // pg_get_constraintdef would satisfy a rule asking whether the comparison is present.
  const sql = [
    '-- SET LOCAL search_path = public;  <- this is prose, not a statement',
    '-- and this comment mentions pg_get_constraintdef and tgenabled and conname = \'x\'',
    "SELECT 'conname = ''x'' and no pg_get_constraintdef' AS quoted_prose;",
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

// ── The two LIVE DEFECTS this unit reports but does not fix ───────────────────────────────────
// apps/api/prisma/** is read-only to this unit, so both are recorded in the exemption ledger with
// a written reason and named in docs/MIGRATION_INVARIANTS.md as candidates for their own units.
// This test pins them: if a later unit FIXES one, the exemption goes dead and the test above says
// so. If a later unit makes one WORSE, or a third appears, this count changes and says that.

test('the corpus carries exactly the two live defects this unit reported', () => {
  const all = lintAll({ applyExemptions: false });
  const live = all
    .filter((f) => (f.rule === 'MI-002' && f.migration === '20270225000000_phase4_t3_correction3')
      || (f.rule === 'MI-003' && f.migration === '20270920000000_decision_option_kinds'))
    .map((f) => `${f.rule} ${f.migration}:${f.line}`);
  assert.deepEqual(live, [
    'MI-002 20270225000000_phase4_t3_correction3:169',
    'MI-003 20270920000000_decision_option_kinds:273',
  ], 'the live defects this unit reported have moved, been fixed, or multiplied — update '
    + 'docs/MIGRATION_INVARIANTS.md and the exemption ledger to match what is actually true now');
  assert.equal(all.length, 15,
    'the per-site corpus count changed. It was measured at 15 findings across 3 migrations on main '
    + 'at 8a4b0db8 (MI-001 13, MI-002 1, MI-003 1); a different number means a migration changed or '
    + 'a rule did, and the ledger and the doc both state the old figure.');
});
