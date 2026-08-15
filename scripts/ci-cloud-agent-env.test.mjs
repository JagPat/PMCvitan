import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

function bashEval(script) {
  return execSync(`bash -lc ${JSON.stringify(script)}`, { cwd: root, encoding: 'utf8' }).trim();
}

function psqlDatabaseUrl(input) {
  return bashEval(`source scripts/cloud-agent-env.sh && psql_database_url ${JSON.stringify(input)}`);
}

function prismaSchema(input) {
  return bashEval(`source scripts/cloud-agent-env.sh && prisma_schema_from_url ${JSON.stringify(input)}`);
}

test('psql_database_url strips schema only from TCP URLs', () => {
  const input = 'postgresql://vitan:vitan@localhost:5432/vitan_pmc?schema=public';
  assert.equal(psqlDatabaseUrl(input), 'postgresql://vitan:vitan@localhost:5432/vitan_pmc');
});

test('prisma_schema_from_url extracts Prisma schema param', () => {
  assert.equal(prismaSchema('postgresql://u:p@h/db?schema=cloud_agent'), 'cloud_agent');
  assert.equal(prismaSchema('postgresql://u:p@h/db?schema=public'), 'public');
  assert.equal(prismaSchema('postgresql://u:p@h/db'), '');
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

test('ensure_api_env refuses external DATABASE_URL without JWT_SECRET', () => {
  const apiEnv = join(root, 'apps/api/.env');
  const backup = `${apiEnv}.ci-backup`;
  const hadBackup = execSync(`test -f ${JSON.stringify(apiEnv)} && echo yes || echo no`, {
    cwd: root,
    encoding: 'utf8',
  }).trim() === 'yes';
  try {
    if (hadBackup) {
      execSync(`cp ${JSON.stringify(apiEnv)} ${JSON.stringify(backup)}`, { cwd: root });
    }
    execSync(`printf 'DATABASE_URL="postgresql://remote:secret@db.example.com:5432/staging"\\n' > ${JSON.stringify(apiEnv)}`, {
      cwd: root,
    });
    assert.throws(
      () => bashEval(
        `cd ${JSON.stringify(root)} && source scripts/cloud-agent-env.sh && `
        + `export DATABASE_URL='postgresql://remote:secret@db.example.com:5432/staging' && `
        + `unset JWT_SECRET && ensure_api_env`,
      ),
      (err) => err.status !== 0,
    );
  } finally {
    if (hadBackup) {
      execSync(`mv ${JSON.stringify(backup)} ${JSON.stringify(apiEnv)}`, { cwd: root });
    } else {
      execSync(`rm -f ${JSON.stringify(apiEnv)}`, { cwd: root });
    }
  }
});

test('ensure_api_env writes dev auth defaults for the local disposable URL', () => {
  const apiEnv = join(root, 'apps/api/.env');
  const backup = `${apiEnv}.ci-backup`;
  const hadBackup = execSync(`test -f ${JSON.stringify(apiEnv)} && echo yes || echo no`, {
    cwd: root,
    encoding: 'utf8',
  }).trim() === 'yes';
  try {
    if (hadBackup) {
      execSync(`cp ${JSON.stringify(apiEnv)} ${JSON.stringify(backup)}`, { cwd: root });
    }
    execSync(`rm -f ${JSON.stringify(apiEnv)}`, { cwd: root });
    bashEval(
      `cd ${JSON.stringify(root)} && source scripts/cloud-agent-env.sh && `
      + `export DATABASE_URL='postgresql://vitan:vitan@localhost:5432/vitan_pmc?schema=public' && ensure_api_env`,
    );
    const text = execSync(`cat ${JSON.stringify(apiEnv)}`, { cwd: root, encoding: 'utf8' });
    assert.match(text, /JWT_SECRET="dev-secret-change-in-prod"/);
    assert.match(text, /ALLOW_DEV_AUTH="true"/);
  } finally {
    if (hadBackup) {
      execSync(`mv ${JSON.stringify(backup)} ${JSON.stringify(apiEnv)}`, { cwd: root });
    } else {
      execSync(`rm -f ${JSON.stringify(apiEnv)}`, { cwd: root });
    }
  }
});
