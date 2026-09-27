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
  return runner.slice(start, end + 3);
}

const functions = extractFunctions();
const report = (output, path) =>
  execFileSync('sh', ['-c', `${functions}\nreport_4d_i_migration_failure "$1" ${path}`, 'report', output], {
    encoding: 'utf8',
  });

const REGISTERS = 'Applying migration `20271220000000_phase6_t4d_i_dark_migration`\nError: ERROR: current transaction is aborted';
const DECISIONS =
  'Applying migration `20271220000000_phase6_t4d_i_dark_migration`\n' +
  'Applying migration `20271221000000_phase6_t4d_i_decision_facts`\n' +
  'Error: phase6 4d-i ABORT: row(s) already carry this unit\'s 4d-only columns';
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

test('an unrelated failure prints nothing', () => {
  assert.equal(report('Applying migration `20271226000000_phase6_t4d_ii_release_lease_writer`\nError: boom', 'baseline'), '');
});
