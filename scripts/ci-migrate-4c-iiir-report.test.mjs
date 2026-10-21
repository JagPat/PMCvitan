// The recovery `scripts/migrate.sh` prints when the 4c-iii-r marker-seal migration fails. It is printed only when
// Prisma names that migration AS the failure, never when the migration merely applied before a later one failed
// (#1032's check: the old match on the name anywhere sent operators to a resolve Prisma refuses, P3012).
//
// The functions are executed from the runner itself, never restated.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const runner = readFileSync(new URL('../apps/api/scripts/migrate.sh', import.meta.url), 'utf8');
const NAME = '20271125000000_phase6_4c_iiir_marker_seal';
const fn = (name) => {
  const start = runner.indexOf(`${name}() {`);
  assert.ok(start >= 0, `${name} is defined in migrate.sh`);
  return runner.slice(start, runner.indexOf('\n}\n', start) + 3);
};
const report = (output) =>
  execFileSync('sh', ['-c', `${fn('migration_failed_in_output')}${fn('report_4c_iiir_migration_failure')}\nreport_4c_iiir_migration_failure "$1"`, 'report', output], {
    encoding: 'utf8',
  });

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
// Prisma's P3018 shape (measured on a real deploy of a later migration)
const p3018 = (applying, failed, error) => [
  ...applying.map((m) => `Applying migration \`${m}\``),
  'Error: P3018', '',
  'A migration failed to apply. New migrations cannot be applied before the error is recovered from. Read more about how to resolve migration issues in a production database: https://pris.ly/d/migrate-resolve',
  '', `Migration name: ${failed}`, '', 'Database error:', error,
].join('\n');

test('its abort prints its recovery: it runs its own BEGIN/COMMIT, so Prisma names it only in the trace (F9)', () => {
  const out = report(aborted([NAME], NAME));
  assert.match(out, /That failure is the 4c-iii-r marker-seal migration/);
  assert.match(out, new RegExp(`resolve --rolled-back ${NAME}`));
});

test('a P3009 naming it prints the same recovery', () => {
  const out = report(`Error: P3009\n\nmigrate found failed migrations in the target database, new migrations will not be applied. Read more about how to resolve migration issues in a production database: https://pris.ly/d/migrate-resolve\nThe \`${NAME}\` migration started at 2026-10-21 09:58:30.163191 UTC failed\n`);
  assert.match(out, new RegExp(`resolve --rolled-back ${NAME}`));
});

test('a later migration failing after it applied prints nothing, in either shape', () => {
  assert.equal(report(p3018([NAME, '20280119000000_probe_later'], '20280119000000_probe_later', 'ERROR: division by zero')), '');
  assert.equal(report(aborted([NAME, '20271220000000_phase6_t4d_i_dark_migration'], '20271220000000_phase6_t4d_i_dark_migration')), '');
});

test('only a whole trace line naming it exactly is its abort', () => {
  assert.equal(report(aborted([], `${NAME}_v2`)), '');
  assert.equal(report(`Note: with migration_name="${NAME}"\n`), '');
});

test('both deploy paths call it', () => {
  assert.match(runner, /report_4c_iiir_migration_failure "\$baseline_out"/);
  assert.match(runner, /\nreport_4c_iiir_migration_failure "\$out"\n/);
});

// Prisma 6.19.3's real output when its own ledger INSERT for this migration timed out on a lock (measured): the trace
// names the migration, but its SQL never ran, so its resolve is refused (P3011) and a plain redeploy succeeds
test('a trace naming it under any error but the aborted transaction is not its failure', () => {
  assert.equal(report([
    'Error: ERROR: canceling statement due to lock timeout',
    '   0: schema_commands::commands::apply_migrations::Applying migration',
    `           with migration_name="${NAME}"`,
    '             at schema-engine/commands/src/commands/apply_migrations.rs:95',
    '   1: schema_core::state::ApplyMigrations',
    '             at schema-engine/core/src/state.rs:260',
    '',
  ].join('\n')), '');
});
