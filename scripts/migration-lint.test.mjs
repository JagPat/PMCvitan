import test from 'node:test';
import assert from 'node:assert/strict';
import {
  c1InlineConstraints, c2TruncateSeal, c3NullPassesCheck, touchedTables,
} from './migration-lint.mjs';

/**
 * Tests for the pre-push migration lint.
 *
 * Every case below is a shape this repository actually met in review, and the two negative cases
 * per check matter as much as the positives. This tool went through three corrections before it was
 * trustworthy, and each one was a FALSE reading rather than a missed one:
 *
 *   - C3 looked for `IS NULL` anywhere in a definition, so a guard on a DIFFERENT column read as
 *     covering the bare one. It then reported nothing across 89 migrations, and that silence looked
 *     like precision.
 *   - C1 flagged inline FOREIGN KEYS, which Prisma reproduces perfectly well.
 *   - C3 matched only QUOTED identifiers, while `pg_get_constraintdef` prints a lowercase-safe name
 *     bare — so a guarded column read as unguarded.
 *
 * A check that has never been shown to fire is not known to work. Each one here is therefore pinned
 * against a known-bad input AND a known-good one.
 */

// ── C1 ────────────────────────────────────────────────────────────────────────────────────────
test('C1 flags an inline CHECK inside CREATE TABLE IF NOT EXISTS', () => {
  const sql = `CREATE TABLE IF NOT EXISTS "T" (
    "a" TEXT NOT NULL,
    CONSTRAINT "T_pkey" PRIMARY KEY ("a"),
    CONSTRAINT "T_a_check" CHECK ("a" !~ '^[[:space:]]*$')
  );`;
  const [f] = c1InlineConstraints(sql);
  assert.equal(f?.check, 'C1');
  assert.equal(f?.table, 'T');
});

test('C1 does NOT flag an inline foreign key — Prisma reproduces those', () => {
  const sql = `CREATE TABLE IF NOT EXISTS "T" (
    "a" TEXT NOT NULL,
    CONSTRAINT "T_pkey" PRIMARY KEY ("a"),
    CONSTRAINT "T_a_fkey" FOREIGN KEY ("a") REFERENCES "U"("id")
  );`;
  assert.deepEqual(c1InlineConstraints(sql), []);
});

test('C1 does NOT flag a plain CREATE TABLE — nothing is skipped there', () => {
  assert.deepEqual(c1InlineConstraints(`CREATE TABLE "T" ("a" TEXT, CHECK ("a" <> ''));`), []);
});

test('C1 ignores the word CHECK inside a comment', () => {
  const sql = `-- the CHECK ( below is prose about a constraint, not one
CREATE TABLE IF NOT EXISTS "T" ("a" TEXT NOT NULL);`;
  assert.deepEqual(c1InlineConstraints(sql), []);
});

// ── C2 ────────────────────────────────────────────────────────────────────────────────────────
// This check was deleted once for being noisy, and the deletion cost a P1 two hours later. The
// fixture below is that exact defect: PR #371's `DecisionOptionKindSelection`, an evidence table
// with a row-level guard and no statement-level seal, bypassed by `TRUNCATE` inside the very
// transaction the guard exists to constrain.
test('C2 flags a NEW table given a protective row trigger but no TRUNCATE seal', () => {
  const sql = `CREATE TABLE IF NOT EXISTS "Note" ("k" TEXT NOT NULL, "txid" BIGINT NOT NULL);
CREATE TRIGGER "Note_guard" BEFORE UPDATE OR DELETE ON "Note"
  FOR EACH ROW EXECUTE FUNCTION note_guard();`;
  const [f] = c2TruncateSeal(sql);
  assert.equal(f?.check, 'C2');
  assert.equal(f?.table, 'Note');
  assert.equal(f?.advisory, true, 'it fires on 25 of 57 real migrations, so it must not block');
});

test('C2 is quiet once the statement-level seal is there', () => {
  const sql = `CREATE TABLE IF NOT EXISTS "Note" ("k" TEXT NOT NULL);
CREATE TRIGGER "Note_guard" BEFORE UPDATE OR DELETE ON "Note"
  FOR EACH ROW EXECUTE FUNCTION note_guard();
CREATE TRIGGER "Note_no_truncate" BEFORE TRUNCATE ON "Note"
  FOR EACH STATEMENT EXECUTE FUNCTION note_no_truncate();`;
  assert.deepEqual(c2TruncateSeal(sql), []);
});

test('C2 only judges tables THIS migration creates, which is what made it usable', () => {
  // Unscoped it fired 75 times across the merged ledger — on work already reviewed and accepted,
  // where the seal question belongs to a reviewer rather than to a script. A trigger added to a
  // pre-existing table is that case.
  const sql = `CREATE TRIGGER "Existing_guard" BEFORE DELETE ON "Existing"
  FOR EACH ROW EXECUTE FUNCTION existing_guard();`;
  assert.deepEqual(c2TruncateSeal(sql), []);
});

test('C2 does not mistake a plain audit trigger for a protective one it can judge', () => {
  // AFTER INSERT with no refusal is a note-writer, not a guard; it is still flagged, because the
  // check cannot read intent — what it must NOT do is miss the sealed case or judge foreign tables.
  const sql = `CREATE TABLE "Log" ("a" TEXT);
CREATE TRIGGER "Log_touch" AFTER INSERT ON "Log" FOR EACH ROW EXECUTE FUNCTION log_touch();`;
  assert.equal(c2TruncateSeal(sql).length, 1);
});

// ── C3 ────────────────────────────────────────────────────────────────────────────────────────
const con = (definition, nullableColumns) => [{ name: 'c', table: 'T', definition, nullableColumns }];

test('C3 catches a regex on a NULLABLE column — a CHECK passes on UNKNOWN', () => {
  // the real schedule-B1 revocation shape
  const d = `CHECK ((("revokedAt" IS NULL) OR ("revokedByName" !~ '^[[:space:]]*$')))`;
  assert.equal(c3NullPassesCheck(con(d, ['revokedByName'])).length, 1);
});

test('C3 does not accept a guard on a DIFFERENT column as covering this one', () => {
  // `revokedAt IS NULL` is present, but says nothing about `revokedByName`. A definition-wide test
  // reads this as handled; that is the bug that made the first cut of C3 silent.
  const d = `CHECK ((("revokedAt" IS NULL) OR ("revokedByName" !~ '^x$')))`;
  const f = c3NullPassesCheck(con(d, ['revokedByName', 'revokedAt']));
  assert.equal(f.length, 1);
  // Assert the REPORTED COLUMN LIST, not the whole message: the message quotes the definition
  // verbatim, so a naive search finds `revokedAt` there and says nothing about what was flagged.
  const listed = /tests the NULLABLE column\(s\) (.+?) without/u.exec(f[0].message)?.[1];
  assert.equal(listed, '"revokedByName"');
});

test('C3 is quiet when the column IS guarded — quoted rendering', () => {
  const d = `CHECK (("x" IS NULL OR "x" !~ '^y$'))`;
  assert.deepEqual(c3NullPassesCheck(con(d, ['x'])), []);
});

test('C3 is quiet when the column is guarded UNQUOTED, as pg_get_constraintdef prints it', () => {
  // PostgreSQL renders a lowercase-safe identifier without quotes. Matching only the quoted form
  // reads a guarded column as unguarded — testing how a name is PRINTED rather than what it is.
  const d = `CHECK (((COALESCE(material, ''::text) !~ '^x$') AND ((description IS NULL) OR (description !~ '^x$'))))`;
  assert.deepEqual(c3NullPassesCheck(con(d, ['description'])), []);
});

test('C3 is quiet when no column in the CHECK is nullable', () => {
  assert.deepEqual(c3NullPassesCheck(con(`CHECK (("a" <> ''))`, [])), []);
});

test('C3 accepts COALESCE as the guard', () => {
  assert.deepEqual(c3NullPassesCheck(con(`CHECK ((COALESCE("a", '') !~ '^x$'))`, ['a'])), []);
});

// ── touchedTables ─────────────────────────────────────────────────────────────────────────────
test('touchedTables finds every table the migration writes objects on', () => {
  const sql = `
CREATE TABLE IF NOT EXISTS "Menu" ("code" TEXT NOT NULL);
ALTER TABLE "Option" ADD COLUMN IF NOT EXISTS "kindCode" TEXT;
CREATE INDEX IF NOT EXISTS "Option_kindCode_idx" ON "Option"("kindCode");
CREATE TRIGGER "Menu_frozen" BEFORE UPDATE OR DELETE ON "Menu"
  FOR EACH ROW EXECUTE FUNCTION menu_frozen();`;
  assert.deepEqual(touchedTables(sql), ['Menu', 'Option']);
});

test('touchedTables scopes the drift check, which is why it must not over-collect', () => {
  // The repository carries ~205 pre-existing drift entries on merged tables, so an unscoped diff is
  // unusable. This is the list that keeps C4 to the tables the migration actually touches.
  assert.deepEqual(touchedTables(`-- ALTER TABLE "NotReal" is prose\nSELECT 1;`), []);
});
