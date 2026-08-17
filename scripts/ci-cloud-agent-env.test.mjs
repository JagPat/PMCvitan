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

test('API runtime always replaces inherited external and production settings with local dev settings', () => {
  const actual = bashEval([
    'source scripts/cloud-agent-env.sh',
    "export DATABASE_URL='postgresql://remote:secret@db.example.com/staging'",
    "export JWT_SECRET='operator-secret'",
    "export ALLOW_DEV_AUTH='false'",
    "export NODE_ENV='production'",
    "export PORT='8080'",
    "export CORS_ORIGINS='https://pms.vitan.in'",
    'pin_cloud_agent_api_env',
    "printf '%s\\n' \"$DATABASE_URL\" \"$JWT_SECRET\" \"$ALLOW_DEV_AUTH\" \"$NODE_ENV\" \"$PORT\" \"CORS=$CORS_ORIGINS\"",
  ].join('; '));

  assert.equal(actual, [
    'postgresql://vitan:vitan@localhost:5432/vitan_pmc?schema=public',
    'dev-secret-change-in-prod',
    'true',
    'development',
    '3000',
    'CORS=',
  ].join('\n'));
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
