import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

function bashEval(script) {
  // Pass the script via env so the outer `sh -c` from execSync cannot expand
  // `$PORT` / `$NODE_ENV` before bash -lc runs.
  return execSync('bash -lc "$CLOUD_AGENT_EVAL_SCRIPT"', {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, CLOUD_AGENT_EVAL_SCRIPT: script },
  }).trim();
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

test('psql_database_url strips Prisma-only pool args while keeping libpq params', () => {
  const input = 'postgresql://u:p@h:5432/db?schema=public&connection_limit=5&pool_timeout=10&sslmode=require';
  const output = psqlDatabaseUrl(input);
  assert.match(output, /sslmode=require/);
  assert.doesNotMatch(output, /schema=/);
  assert.doesNotMatch(output, /connection_limit=/);
  assert.doesNotMatch(output, /pool_timeout=/);
});

function withApiEnv(run) {
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
    return run(apiEnv);
  } finally {
    if (hadBackup) {
      execSync(`mv ${JSON.stringify(backup)} ${JSON.stringify(apiEnv)}`, { cwd: root });
    } else {
      execSync(`rm -f ${JSON.stringify(apiEnv)}`, { cwd: root });
    }
  }
}

test('ensure_api_env refuses external DATABASE_URL without JWT_SECRET', () => {
  withApiEnv((apiEnv) => {
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
  });
});

test('ensure_api_env writes dev auth defaults for the local disposable URL', () => {
  withApiEnv((apiEnv) => {
    execSync(`rm -f ${JSON.stringify(apiEnv)}`, { cwd: root });
    bashEval(
      `cd ${JSON.stringify(root)} && source scripts/cloud-agent-env.sh && `
      + `export DATABASE_URL='postgresql://vitan:vitan@localhost:5432/vitan_pmc?schema=public' && ensure_api_env`,
    );
    const text = execSync(`cat ${JSON.stringify(apiEnv)}`, { cwd: root, encoding: 'utf8' });
    assert.match(text, /JWT_SECRET='dev-secret-change-in-prod'/);
    assert.match(text, /ALLOW_DEV_AUTH='true'/);
  });
});

test('ensure_api_env rejects leftover local-dev JWT when switching to an external database', () => {
  withApiEnv((apiEnv) => {
    bashEval(
      `cd ${JSON.stringify(root)} && source scripts/cloud-agent-env.sh && `
      + `export DATABASE_URL='postgresql://vitan:vitan@localhost:5432/vitan_pmc?schema=public' && ensure_api_env`,
    );
    assert.throws(
      () => bashEval(
        `cd ${JSON.stringify(root)} && source scripts/cloud-agent-env.sh && `
        + `export DATABASE_URL='postgresql://remote:secret@db.example.com:5432/staging' && `
        + `unset JWT_SECRET && unset ALLOW_DEV_AUTH && ensure_api_env`,
      ),
      (err) => err.status !== 0,
    );
    const text = execSync(`cat ${JSON.stringify(apiEnv)}`, { cwd: root, encoding: 'utf8' });
    assert.doesNotMatch(text, /JWT_SECRET="dev-secret-change-in-prod"/);
    assert.doesNotMatch(text, /ALLOW_DEV_AUTH="true"/);
  });
});

test('ensure_api_env rejects apps/api/.env.example JWT_SECRET=change-me on an external database', () => {
  withApiEnv((apiEnv) => {
    execSync(
      `printf '%s\\n' 'DATABASE_URL="postgresql://remote:secret@db.example.com:5432/staging"' 'JWT_SECRET="change-me"' 'ALLOW_DEV_AUTH="true"' > ${JSON.stringify(apiEnv)}`,
      { cwd: root },
    );
    assert.throws(
      () => bashEval(
        `cd ${JSON.stringify(root)} && source scripts/cloud-agent-env.sh && `
        + `export DATABASE_URL='postgresql://remote:secret@db.example.com:5432/staging' && `
        + `unset JWT_SECRET && unset ALLOW_DEV_AUTH && ensure_api_env`,
      ),
      (err) => err.status !== 0,
    );
    const text = execSync(`cat ${JSON.stringify(apiEnv)}`, { cwd: root, encoding: 'utf8' });
    assert.doesNotMatch(text, /JWT_SECRET="change-me"/);
  });
});

test('ensure_api_env clears ALLOW_DEV_AUTH when the override is empty', () => {
  withApiEnv((apiEnv) => {
    bashEval(
      `cd ${JSON.stringify(root)} && source scripts/cloud-agent-env.sh && `
      + `export DATABASE_URL='postgresql://vitan:vitan@localhost:5432/vitan_pmc?schema=public' && ensure_api_env`,
    );
    bashEval(
      `cd ${JSON.stringify(root)} && source scripts/cloud-agent-env.sh && `
      + `export DATABASE_URL='postgresql://remote:secret@db.example.com:5432/staging' && `
      + `export JWT_SECRET='operator-secret-not-a-placeholder' && `
      + `export ALLOW_DEV_AUTH='' && ensure_api_env`,
    );
    const text = execSync(`cat ${JSON.stringify(apiEnv)}`, { cwd: root, encoding: 'utf8' });
    assert.doesNotMatch(text, /ALLOW_DEV_AUTH=/);
  });
});

test('ensure_web_env disables VITE_ALLOW_DEV_AUTH for an external database', () => {
  const webEnv = join(root, 'apps/web/.env');
  const backup = `${webEnv}.ci-backup`;
  const hadBackup = execSync(`test -f ${JSON.stringify(webEnv)} && echo yes || echo no`, {
    cwd: root,
    encoding: 'utf8',
  }).trim() === 'yes';
  try {
    if (hadBackup) {
      execSync(`cp ${JSON.stringify(webEnv)} ${JSON.stringify(backup)}`, { cwd: root });
    }
    execSync(`rm -f ${JSON.stringify(webEnv)}`, { cwd: root });
    bashEval(
      `cd ${JSON.stringify(root)} && source scripts/cloud-agent-env.sh && `
      + `export DATABASE_URL='postgresql://remote:secret@db.example.com:5432/staging' && `
      + `unset ALLOW_DEV_AUTH && ensure_web_env`,
    );
    const text = execSync(`cat ${JSON.stringify(webEnv)}`, { cwd: root, encoding: 'utf8' });
    assert.match(text, /VITE_ALLOW_DEV_AUTH='false'/);
  } finally {
    if (hadBackup) {
      execSync(`mv ${JSON.stringify(backup)} ${JSON.stringify(webEnv)}`, { cwd: root });
    } else {
      execSync(`rm -f ${JSON.stringify(webEnv)}`, { cwd: root });
    }
  }
});

test('pin_api_runtime_env forces PORT=3000 and production OTP stubs on an external DB', () => {
  const out = bashEval(
    `cd ${JSON.stringify(root)} && source scripts/cloud-agent-env.sh && `
    + `export PORT=8080 && export NODE_ENV=development && `
    + `export DATABASE_URL='postgresql://remote:secret@db.example.com:5432/staging' && `
    + `unset CLOUD_AGENT_ALLOW_AUTH_STUBS && pin_api_runtime_env && `
    + `printf 'PORT=%s NODE_ENV=%s\\n' "$PORT" "$NODE_ENV"`,
  );
  assert.equal(out, 'PORT=3000 NODE_ENV=production');
});

test('pin_api_runtime_env keeps local disposable DB off production stubs', () => {
  const out = bashEval(
    `cd ${JSON.stringify(root)} && source scripts/cloud-agent-env.sh && `
    + `export PORT=8080 && export NODE_ENV=production && `
    + `export DATABASE_URL='postgresql://vitan:vitan@localhost:5432/vitan_pmc?schema=public' && `
    + `pin_api_runtime_env && printf 'PORT=%s NODE_ENV=%s\\n' "$PORT" "$NODE_ENV"`,
  );
  assert.equal(out, 'PORT=3000 NODE_ENV=development');
});

test('apply_api_env_defaults restores inherited secrets then pins PORT=3000', () => {
  const out = bashEval(
    `cd ${JSON.stringify(root)} && source scripts/cloud-agent-env.sh && `
    + `export PORT=8080 && export DATABASE_URL='postgresql://remote:secret@db.example.com:5432/staging' && `
    + `export JWT_SECRET='operator-staging-secret' && `
    + `apply_api_env_defaults && printf 'PORT=%s JWT=%s NODE_ENV=%s\\n' "$PORT" "$JWT_SECRET" "$NODE_ENV"`,
  );
  assert.equal(out, 'PORT=3000 JWT=operator-staging-secret NODE_ENV=production');
});

test('set_env_var shell-quotes values so sourced $ and $(...) stay literal', () => {
  withApiEnv(() => {
    const url = 'postgresql://u:p$a$(echo pwned)@db.example.com:5432/staging';
    bashEval(
      `cd ${JSON.stringify(root)} && source scripts/cloud-agent-env.sh && `
      + `set_env_var apps/api/.env DATABASE_URL 'postgresql://u:p$a$(echo pwned)@db.example.com:5432/staging'`,
    );
    const sourced = bashEval(
      `cd ${JSON.stringify(root)} && set -a && source apps/api/.env && set +a && printf '%s' "$DATABASE_URL"`,
    );
    assert.equal(sourced, url);
    const roundTrip = bashEval(
      `cd ${JSON.stringify(root)} && source scripts/cloud-agent-env.sh && read_env_var apps/api/.env DATABASE_URL`,
    );
    assert.equal(roundTrip, url);
  });
});

test('apply_api_env_defaults does not restore a placeholder JWT over an operator .env secret', () => {
  withApiEnv((apiEnv) => {
    execSync(
      `printf '%s\\n' "DATABASE_URL='postgresql://remote:secret@db.example.com:5432/staging'" "JWT_SECRET='operator-staging-secret'" > ${JSON.stringify(apiEnv)}`,
      { cwd: root },
    );
    const out = bashEval(
      `cd ${JSON.stringify(root)} && source scripts/cloud-agent-env.sh && `
      + `export DATABASE_URL='postgresql://remote:secret@db.example.com:5432/staging' && `
      + `export JWT_SECRET='change-me' && `
      + `apply_api_env_defaults && printf '%s' "$JWT_SECRET"`,
    );
    assert.equal(out, 'operator-staging-secret');
  });
});

test('apply_api_env_defaults loads double-quoted .env $ literally under set -u', () => {
  withApiEnv((apiEnv) => {
    execSync(
      `printf '%s\\n' "DATABASE_URL='postgresql://remote:secret@db.example.com:5432/staging'" 'JWT_SECRET="strong-$suffix"' > ${JSON.stringify(apiEnv)}`,
      { cwd: root },
    );
    const out = bashEval(
      `cd ${JSON.stringify(root)} && source scripts/cloud-agent-env.sh && `
      + `export DATABASE_URL='postgresql://remote:secret@db.example.com:5432/staging' && `
      + `unset JWT_SECRET && unset suffix && `
      + `apply_api_env_defaults && printf '%s' "$JWT_SECRET"`,
    );
    assert.equal(out, 'strong-$suffix');
  });
});

test('seed.ts drops the completion marker before TRUNCATE and writes it last as AuditLog', () => {
  const text = execSync('cat apps/api/prisma/seed.ts', { cwd: root, encoding: 'utf8' });
  const lock = text.indexOf("SELECT pg_advisory_lock(hashtext('vitan-pmc-destructive-seed'))");
  const drop = text.indexOf("auditLog.deleteMany({ where: { id: 'cloud-agent-seed-complete' } })");
  const truncate = text.indexOf('TRUNCATE TABLE');
  const library = text.indexOf('createStarterLibrary');
  const create = text.lastIndexOf("prisma.auditLog.create");
  const marker = text.lastIndexOf("id: 'cloud-agent-seed-complete'");
  const unlock = text.indexOf("SELECT pg_advisory_unlock(hashtext('vitan-pmc-destructive-seed'))");
  assert.ok(lock >= 0 && drop >= 0 && truncate >= 0 && library >= 0 && create >= 0 && marker >= 0 && unlock >= 0);
  assert.ok(lock < drop, 'advisory lock must be taken before the marker is cleared');
  assert.ok(drop < truncate, 'marker must be removed before the first TRUNCATE');
  assert.ok(library < create && create < marker, 'marker must be written last as AuditLog after the starter library');
  assert.match(text, /finally\s*\{[\s\S]*pg_advisory_unlock/u);
  assert.doesNotMatch(text, /prisma\.notification\.create\([\s\S]{0,200}cloud-agent-seed-complete/u);
});
