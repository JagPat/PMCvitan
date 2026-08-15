import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

function psqlDatabaseUrl(input) {
  const cmd = `source scripts/cloud-agent-env.sh && psql_database_url ${JSON.stringify(input)}`;
  return execSync(`bash -lc ${JSON.stringify(cmd)}`, { cwd: root, encoding: 'utf8' }).trim();
}

test('psql_database_url strips schema only from TCP URLs', () => {
  const input = 'postgresql://vitan:vitan@localhost:5432/vitan_pmc?schema=public';
  assert.equal(psqlDatabaseUrl(input), 'postgresql://vitan:vitan@localhost:5432/vitan_pmc');
});

test('psql_database_url preserves empty-host libpq URIs (Cloud SQL socket)', () => {
  const input = 'postgresql:///vitan?host=/cloudsql/proj:region:inst&schema=public';
  const output = psqlDatabaseUrl(input);
  assert.match(output, /^postgresql:\/\/\/vitan\?/);
  assert.match(output, /host=%2Fcloudsql%2Fproj%3Aregion%3Ainst/);
  assert.doesNotMatch(output, /\bschema=/);
});

test('psql_database_url keeps other libpq params on empty-host URIs', () => {
  const input = 'postgresql:///vitan?host=/cloudsql/proj:region:inst&sslmode=require&schema=public';
  const output = psqlDatabaseUrl(input);
  assert.match(output, /^postgresql:\/\/\/vitan\?/);
  assert.match(output, /sslmode=require/);
  assert.doesNotMatch(output, /\bschema=/);
});
