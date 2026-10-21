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
  return runner.slice(start, end + 3);
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
  const out = report(`Error: P3009\n\nmigrate found failed migrations in the target database, new migrations will not be applied.\nThe \`${NAME}\` migration started at 2026-10-21 04:00:00.123 UTC failed\n`);
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

test('both deploy paths call it', () => {
  assert.match(runner, /report_media_guard_migration_failure "\$baseline_out"/);
  assert.match(runner, /report_media_guard_migration_failure "\$out"\nexit \$code/);
});
