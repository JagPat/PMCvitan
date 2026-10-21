// Phase 6 4d-ii-a (#646's review, findings 4114478871 and 4114890644) — the recovery
// `scripts/migrate.sh` prints when a 4d-i half fails.
//
// On the P3005 baseline path, a replayed 4d-i audit can refuse rows a serving 4d-ii-a writer
// produced under the live seals, because the database is a restore that lost its ledger. There
// the half-specific repairs ("remove or reset exactly what it names", the architect re-role) would
// erase attribution the seals already judged, so the ledger-restoration note must come FIRST, for
// EITHER half. On the ordinary path the ledger is intact and the note must not appear.
//
// The functions are executed from the runner itself, never restated: the test extracts them from
// migrate.sh and runs them under `sh` against a failure output naming each half.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const runner = readFileSync(new URL('../apps/api/scripts/migrate.sh', import.meta.url), 'utf8');

function extractFunctions() {
  const start = runner.indexOf('report_4d_i_ledger_loss() {');
  const reportStart = runner.indexOf('report_4d_i_migration_failure() {');
  assert.ok(start >= 0 && reportStart > start, 'both 4d-i report functions are defined in migrate.sh, ledger note first');
  const end = runner.indexOf('\n}\n', reportStart);
  assert.ok(end > reportStart, 'report_4d_i_migration_failure has a closing brace');
  // the shared exact-line match the report uses (#1032's check), defined before it in the runner
  const helper = runner.indexOf('migration_failed_in_output() {');
  assert.ok(helper >= 0 && helper < start, 'the exact-line match is defined before the reports');
  return runner.slice(helper, runner.indexOf('\n}\n', helper) + 3) + runner.slice(start, end + 3);
}

const functions = extractFunctions();
const report = (output, path) =>
  execFileSync('sh', ['-c', `${functions}\nreport_4d_i_migration_failure "$1" ${path}`, 'report', output], {
    encoding: 'utf8',
  });

// Prisma's P3018 shape (measured on a real deploy of a later migration): the failed migration is named on its own
// "Migration name:" line
const p3018 = (applying, failed, error) => [
  ...applying.map((m) => `Applying migration \`${m}\``),
  'Error: P3018', '',
  'A migration failed to apply. New migrations cannot be applied before the error is recovered from. Read more about how to resolve migration issues in a production database: https://pris.ly/d/migrate-resolve',
  '', `Migration name: ${failed}`, '', 'Database error:', error,
].join('\n');
// The abort of a migration that runs its own BEGIN/COMMIT, as Prisma 6.19.3 printed it on a real deploy (measured): no
// P3018, only the database error and the engine's trace, which names the migration that failed
const aborted = (applying, failed) => [
  ...applying.map((m) => `Applying migration \`${m}\``),
  'Error: ERROR: current transaction is aborted, commands ignored until end of transaction block',
  '   0: schema_commands::commands::apply_migrations::Applying migration',
  `           with migration_name="${failed}"`,
  '             at schema-engine/commands/src/commands/apply_migrations.rs:95',
  '   1: schema_core::state::ApplyMigrations',
  '             at schema-engine/core/src/state.rs:260',
  '',
].join('\n');
const DARK = '20271220000000_phase6_t4d_i_dark_migration';
const FACTS = '20271221000000_phase6_t4d_i_decision_facts';
// both halves run their own BEGIN/COMMIT, so an abort of either is the trace shape, never P3018
const REGISTERS = aborted([DARK], DARK);
const DECISIONS = aborted([DARK, FACTS], FACTS);
const LEDGER_NOTE = /READ THIS FIRST[\s\S]*replace `_prisma_migrations`[\s\S]*Do NOT remove or reset those rows/;

for (const [half, output, halfRepair] of [
  ['registers', REGISTERS, /That failure is the 4d-i dark migration/],
  ['decisions', DECISIONS, /That failure is the 4d-i decisions half/],
]) {
  test(`the ${half} half on the P3005 baseline path prints the ledger restoration BEFORE its row repairs`, () => {
    const out = report(output, 'baseline');
    assert.match(out, LEDGER_NOTE);
    assert.match(out, halfRepair);
    assert.ok(out.search(LEDGER_NOTE) < out.search(halfRepair), 'the ledger note precedes the half-specific repair');
  });

  test(`the ${half} half on the ordinary path prints its own repair and no ledger note`, () => {
    const out = report(output, 'ordinary');
    assert.match(out, halfRepair);
    assert.doesNotMatch(out, /READ THIS FIRST/);
  });
}

test('the decisions half is named when both halves appear in the output, and resolves ITS name', () => {
  const out = report(DECISIONS, 'baseline');
  assert.match(out, /--rolled-back 20271221000000_phase6_t4d_i_decision_facts/);
});

test('the P3005 call site passes the baseline path and the ordinary call site does not', () => {
  assert.match(runner, /report_4d_i_migration_failure "\$baseline_out" baseline\n/);
  assert.match(runner, /\nreport_4d_i_migration_failure "\$out"\n/);
});

test('a P3009 naming a half prints that half\'s recovery', () => {
  const out = report(`Error: P3009\n\nmigrate found failed migrations in the target database, new migrations will not be applied. Read more about how to resolve migration issues in a production database: https://pris.ly/d/migrate-resolve\nThe \`${FACTS}\` migration started at 2026-10-21 09:58:30.163191 UTC failed\n`, 'ordinary');
  assert.match(out, /That failure is the 4d-i decisions half/);
});

// Prisma's own output, measured: every migration applied from zero, then a later one failed in the same deploy. Both
// halves are named only as "Applying migration"; neither failed, and a resolve of either would be refused (P3012).
test('a later migration failing after both halves applied prints nothing for either half', () => {
  for (const path of ['ordinary', 'baseline']) {
    assert.equal(report(p3018([DARK, FACTS, '20280119000000_probe_later'], '20280119000000_probe_later', 'ERROR: division by zero'), path), '');
  }
});

test('a later migration aborting in its own transaction after both halves applied prints nothing for either half', () => {
  assert.equal(report(aborted([DARK, FACTS, '20271225000000_probe_later'], '20271225000000_probe_later'), 'ordinary'), '');
});

test('an unrelated failure prints nothing', () => {
  assert.equal(report('Applying migration `20271226000000_phase6_t4d_ii_release_lease_writer`\nError: boom', 'baseline'), '');
});
