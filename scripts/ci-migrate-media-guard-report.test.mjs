// #482 site photos (#1032) — the recovery `scripts/migrate.sh` prints when the deleted-photo guard
// (20280118000000_media_tombstone_guard) fails. Any failure of that file leaves P3009 on the next deploy, and the
// recovery is the same each time, so the runner prints it where the operator is looking.
//
// The function is executed from the runner itself, never restated: the test extracts it from migrate.sh and runs it
// under `sh` against a failure output. The install's own tests feed it Prisma's real output.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const runner = readFileSync(new URL('../apps/api/scripts/migrate.sh', import.meta.url), 'utf8');
const NAME = '20280118000000_media_tombstone_guard';

function extractFunction() {
  const start = runner.indexOf('report_media_guard_migration_failure() {');
  assert.ok(start >= 0, 'report_media_guard_migration_failure is defined in migrate.sh');
  const end = runner.indexOf('\n}\n', start);
  assert.ok(end > start, 'it has a closing brace');
  const helper = runner.indexOf('migration_failed_in_output() {');
  assert.ok(helper >= 0 && helper < start, 'the shared exact-line match is defined before it');
  return runner.slice(helper, runner.indexOf('\n}\n', helper) + 3) + runner.slice(start, end + 3);
}

const report = (output) =>
  execFileSync('sh', ['-c', `${extractFunction()}\nreport_media_guard_migration_failure "$1"`, 'report', output], {
    encoding: 'utf8',
  });

test('a failure of the guard prints the count, the resolve and the redeploy, in that order', () => {
  const out = report(`Applying migration \`${NAME}\`\nError: P3018\n\nA migration failed to apply.\n\nMigration name: ${NAME}\n\n`
    + 'Database error:\nERROR: media guard install: 1 stored photo(s) carry the key of a deleted photo; nothing was installed');
  const count = out.indexOf('docs/RUNBOOK.md §MG');
  const resolve = out.indexOf(`npx prisma migrate resolve --rolled-back ${NAME}`);
  const redeploy = out.indexOf('2. redeploy');
  assert.ok(count >= 0 && resolve > count && redeploy > resolve, out);
});

test('a P3009 naming the guard prints the same recovery, and does not claim nothing was kept', () => {
  const out = report(`Error: P3009\n\nmigrate found failed migrations in the target database, new migrations will not be applied. Read more about how to resolve migration issues in a production database: https://pris.ly/d/migrate-resolve\nThe \`${NAME}\` migration started at 2026-10-21 09:58:30.163191 UTC failed\n`);
  assert.match(out, /After a P3009 it may have committed/);
  assert.match(out, new RegExp(`resolve --rolled-back ${NAME}`));
});

// Prisma's own output, measured (#1032 r2b re-check): this file applied, then a later migration failed in the same deploy.
// The guard is named only as "Applying migration"; its resolve would be refused (P3012) and would bury the real failure.
const LATER_FAILED = [
  'Applying migration `20280117000000_media_tombstone`',
  `Applying migration \`${NAME}\``,
  'Applying migration `20280119000000_probe_later`',
  'Error: P3018',
  '',
  'A migration failed to apply. New migrations cannot be applied before the error is recovered from. Read more about how to resolve migration issues in a production database: https://pris.ly/d/migrate-resolve',
  '',
  'Migration name: 20280119000000_probe_later',
  '',
  'Database error code: 22012',
  '',
  'Database error:',
  'ERROR: division by zero',
].join('\n');

test('a later migration failing after the guard applied prints nothing for the guard', () => {
  assert.equal(report(LATER_FAILED), '');
});

test('a failure of another migration prints nothing', () => {
  assert.equal(report('Applying migration `20280117000000_media_tombstone`\nError: something else'), '');
});

test('a P3009 whose line ends "with the following logs:" names the guard as well, with no "Migration name:" line after it', () => {
  // the engine's other ending for the P3009 line (the stored logs follow it); here the logs carry no P3018 text
  const out = report(`Error: P3009\n\nmigrate found failed migrations in the target database, new migrations will not be applied. Read more about how to resolve migration issues in a production database: https://pris.ly/d/migrate-resolve\nThe \`${NAME}\` migration started at 2026-10-21 09:58:30.163191 UTC failed with the following logs:\n\nERROR: canceling statement due to lock timeout\n`);
  assert.match(out, new RegExp(`resolve --rolled-back ${NAME}`));
});

test('only a whole line naming the guard is its failure: a longer name, a line that only contains it, or a P3009 naming another migration prints nothing', () => {
  for (const out of [
    `Error: P3018\n\nMigration name: ${NAME}_v2\n`,
    `Error: P3009\n\nThe \`${NAME}_v2\` migration started at 2026-10-21 04:00:00.123 UTC failed\n`,
    `Error: P3009\n\nThe \`${NAME}_v2\` migration started at 2026-10-21 04:00:00.123 UTC failed with the following logs:\n`,
    'Error: P3009\n\nThe `20280119000000_probe_later` migration started at 2026-10-21 04:00:00.123 UTC failed\n',
    'Error: P3009\n\nThe `20280119000000_probe_later` migration started at 2026-10-21 04:00:00.123 UTC failed with the following logs:\n',
    `Error: ERROR: boom\n           with migration_name="${NAME}_v2"\n`,
    `Note: with migration_name="${NAME}"\n`,
    `Note: Migration name: ${NAME}\n`,
    `Note: The \`${NAME}\` migration started at 2026-10-21 04:00:00.123 UTC failed\n`,
  ]) assert.equal(report(out), '', JSON.stringify(out));
});

test('both deploy paths call it', () => {
  assert.match(runner, /report_media_guard_migration_failure "\$baseline_out"/);
  assert.match(runner, /report_media_guard_migration_failure "\$out"\nexit \$code/);
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
