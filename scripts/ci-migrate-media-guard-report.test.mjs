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
  const out = report(`Applying migration \`${NAME}\`\nError: ERROR: media guard install: 1 stored photo(s) carry the key of a deleted photo`);
  const count = out.indexOf('docs/RUNBOOK.md §MG');
  const resolve = out.indexOf(`npx prisma migrate resolve --rolled-back ${NAME}`);
  const redeploy = out.indexOf('2. redeploy');
  assert.ok(count >= 0 && resolve > count && redeploy > resolve, out);
});

test('a P3009 naming the guard prints the same recovery', () => {
  const out = report(`Error: P3009\nmigrate found failed migrations in the target database\nThe \`${NAME}\` migration started at ... failed`);
  assert.match(out, new RegExp(`resolve --rolled-back ${NAME}`));
});

test('a failure of another migration prints nothing', () => {
  assert.equal(report('Applying migration `20280117000000_media_tombstone`\nError: something else'), '');
});

test('both deploy paths call it', () => {
  assert.match(runner, /report_media_guard_migration_failure "\$baseline_out"/);
  assert.match(runner, /report_media_guard_migration_failure "\$out"\nexit \$code/);
});
