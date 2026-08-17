import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

function bashEval(script) {
  return execFileSync('bash', ['-c', script], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env },
  }).trim();
}

test('Cursor launches the repo-managed local Cloud Agent lifecycle', () => {
  const config = JSON.parse(readFileSync(join(root, '.cursor/environment.json'), 'utf8'));

  assert.equal(config.install, 'bash scripts/cloud-agent-install.sh');
  assert.equal(config.start, 'bash scripts/cloud-agent-start.sh');
  assert.deepEqual(config.terminals, [
    { name: 'api', command: 'bash scripts/cloud-agent-api.sh' },
    { name: 'web', command: 'bash scripts/cloud-agent-web.sh' },
  ]);
  assert.deepEqual(config.ports, [
    { name: 'web', port: 5173 },
    { name: 'api', port: 3000 },
  ]);
});

test('install requires a PostgreSQL server even when client tools are already on PATH', () => {
  const install = readFileSync(join(root, 'scripts/cloud-agent-install.sh'), 'utf8');
  assert.match(install, /cloud_agent_needs_postgres_packages/);
  assert.doesNotMatch(install, /if ! command -v psql/);

  const actual = bashEval([
    'source scripts/cloud-agent-env.sh',
    'mkdir -p /tmp/pg-clients-only-$$',
    'printf \'#!/bin/sh\\nexit 0\\n\' > /tmp/pg-clients-only-$$/psql',
    'printf \'#!/bin/sh\\nexit 0\\n\' > /tmp/pg-clients-only-$$/pg_isready',
    'chmod +x /tmp/pg-clients-only-$$/psql /tmp/pg-clients-only-$$/pg_isready',
    'export PATH=/tmp/pg-clients-only-$$',
    'export CLOUD_AGENT_POSTGRES_LIB_GLOB=/tmp/pg-clients-only-$$/no-such-postgres',
    'if cloud_agent_needs_postgres_packages; then echo NEED_PACKAGES; else echo SKIP_INSTALL; fi',
    'if cloud_agent_has_postgres_server; then echo HAS_SERVER; else echo NO_SERVER; fi',
  ].join('; '));

  assert.equal(actual, 'NEED_PACKAGES\nNO_SERVER');
});

test('API runtime always replaces inherited external and production settings with local dev settings', () => {
  const actual = bashEval([
    'source scripts/cloud-agent-env.sh',
    "export DATABASE_URL='postgresql://remote:secret@db.example.com/staging'",
    "export JWT_SECRET='operator-secret'",
    "export ALLOW_DEV_AUTH='false'",
    "export NODE_ENV='production'",
    "export PORT='8080'",
    "export CORS_ORIGINS='https://pms.vitan.in'",
    "export S3_ENDPOINT='https://r2.example.com'",
    "export S3_BUCKET='vitan-media'",
    "export S3_ACCESS_KEY_ID='ak'",
    "export S3_SECRET_ACCESS_KEY='sk'",
    "export S3_REGION='auto'",
    "export S3_PUBLIC_BASE='https://cdn.example.com'",
    "export SMTP_HOST='smtp.zoho.in'",
    "export SMTP_PORT='465'",
    "export SMTP_SECURE='true'",
    "export SMTP_USER='ops'",
    "export SMTP_PASS='secret'",
    "export SMTP_FROM='ops@vitan.in'",
    "export MSG91_AUTH_KEY='m91'",
    "export MSG91_TEMPLATE_ID='tpl'",
    "export MSG91_SENDER_ID='VITAN'",
    "export FAST2SMS_API_KEY='smskey'",
    "export FAST2SMS_OTP_ID='otp'",
    "export TELEGRAM_GATEWAY_TOKEN='tg'",
    "export VAPID_PUBLIC_KEY='pk'",
    "export VAPID_PRIVATE_KEY='vk'",
    "export VAPID_SUBJECT='mailto:ops@vitan.in'",
    "export GOOGLE_CLIENT_ID='gid'",
    "export WORKER_ENROLL_SECRET='enroll'",
    "export AWS_ACCESS_KEY_ID='awsak'",
    "export AWS_SECRET_ACCESS_KEY='awssk'",
    "export OUTBOX_SENDER_MODE='outbox'",
    'pin_cloud_agent_api_env',
    "printf '%s\\n' \"$DATABASE_URL\" \"$JWT_SECRET\" \"$ALLOW_DEV_AUTH\" \"$NODE_ENV\" \"$PORT\" \"CORS=$CORS_ORIGINS\"",
    'for k in S3_ENDPOINT S3_BUCKET S3_ACCESS_KEY_ID S3_SECRET_ACCESS_KEY S3_REGION S3_PUBLIC_BASE SMTP_HOST SMTP_PORT SMTP_SECURE SMTP_USER SMTP_PASS SMTP_FROM MSG91_AUTH_KEY MSG91_TEMPLATE_ID MSG91_SENDER_ID FAST2SMS_API_KEY FAST2SMS_OTP_ID TELEGRAM_GATEWAY_TOKEN VAPID_PUBLIC_KEY VAPID_PRIVATE_KEY VAPID_SUBJECT GOOGLE_CLIENT_ID WORKER_ENROLL_SECRET AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY OUTBOX_SENDER_MODE; do',
    '  if [[ -n "${!k+x}" ]]; then printf "STILL_SET %s\\n" "$k"; fi',
    'done',
  ].join('\n'));

  assert.equal(actual, [
    'postgresql://vitan:vitan@localhost:5432/vitan_pmc?schema=public',
    'dev-secret-change-in-prod',
    'true',
    'development',
    '3000',
    'CORS=',
  ].join('\n'));
});

test('API terminal watches current source instead of serving stale dist output', () => {
  const api = readFileSync(join(root, 'scripts/cloud-agent-api.sh'), 'utf8');
  assert.match(api, /tsc -p tsconfig\.json --watch/);
  assert.match(api, /node --watch dist\/main\.js/);
  assert.doesNotMatch(api, /pnpm --filter api start$/m);
  assert.doesNotMatch(api, /^pnpm --filter api start:dev$/m);
  const pkg = JSON.parse(readFileSync(join(root, 'apps/api/package.json'), 'utf8'));
  assert.equal(pkg.scripts.start, 'node dist/main.js');
});

test('web runtime enables dev auth against the same local API', () => {
  const actual = bashEval([
    'source scripts/cloud-agent-env.sh',
    "export VITE_API_URL='https://api.example.com'",
    "export VITE_ALLOW_DEV_AUTH='false'",
    'pin_cloud_agent_web_env',
    "printf '%s\\n' \"$VITE_API_URL\" \"$VITE_ALLOW_DEV_AUTH\"",
  ].join('; '));

  assert.equal(actual, 'http://localhost:3000\ntrue');
});
