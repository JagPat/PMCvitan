import test from 'node:test';
import assert from 'node:assert/strict';
import { main, plan, readiness } from './test-focused.mjs';

const ROOT = '/repo';
const files = (absolute, pattern) => (absolute.endsWith('/dir')
  ? ['/repo/apps/api/test/integration/dir/a.test.ts', '/repo/apps/api/test/integration/dir/b.test.ts']
  : [absolute]).filter((f) => pattern.test(f));
const options = (exists = () => true) => ({ root: ROOT, exists, files });

test('one existing path resolves to the configuration that owns it, with exact selectors', () => {
  const api = plan(['--', 'apps/api/test/integration/x.test.ts'], options());
  assert.deepEqual(api.argv, ['pnpm', 'exec', 'vitest', 'run', '--config', 'vitest.integration.config.ts', 'test/integration/x.test.ts']);
  assert.equal(api.cwd, '/repo/apps/api');
  assert.equal(api.suite.postgres, true);
  const dir = plan(['apps/api/test/integration/dir'], options());
  assert.deepEqual(dir.selectors, ['test/integration/dir/a.test.ts', 'test/integration/dir/b.test.ts']);
  assert.deepEqual(plan(['apps/api/src/y.test.ts'], options()).argv, ['pnpm', 'exec', 'vitest', 'run', 'src/y.test.ts']);
  assert.deepEqual(plan(['scripts/z.test.mjs'], options()).argv, ['node', '--test', 'scripts/z.test.mjs']);
  assert.equal(plan(['scripts/z.test.mjs'], options()).suite.postgres, undefined);
});

test('missing paths, escapes, flag-only arguments, unknown roots and unmatched selections are refused', () => {
  assert.match(plan([], options()).error, /usage/u);
  assert.match(plan(['--watch'], options()).error, /usage/u);
  assert.match(plan(['a', 'b'], options()).error, /usage/u);
  assert.match(plan(['../outside/x.test.ts'], options()).error, /outside the repository/u);
  assert.match(plan(['apps/api/test/integration/missing.test.ts'], options(() => false)).error, /does not exist/u);
  assert.match(plan(['docs/POLICY.md'], options()).error, /not under a test root/u);
  assert.match(plan(['apps/api/test/integration/helper.ts'], options()).error, /selects no test file/u);
});

test('the child process receives an argument array and its exact status becomes the exit code', () => {
  const calls = [];
  const exec = (command, args, opts) => { calls.push([command, args, opts?.cwd]); return { status: 3 }; };
  const planImpl = () => ({ suite: { postgres: false }, cwd: '/repo/scripts', argv: ['node', '--test', 'scripts/z.test.mjs'] });
  assert.equal(main(['scripts/z.test.mjs'], { exec, env: {}, log() {}, planImpl }), 3);
  assert.deepEqual(calls, [['node', ['--test', 'scripts/z.test.mjs'], '/repo/scripts']]);
  assert.equal(main(['nope'], { exec, env: {}, log() {}, planImpl: () => ({ error: 'no' }) }), 2);
  assert.equal(main(['x'], { exec: () => ({ error: new Error('ENOENT') }), env: {}, log() {}, planImpl }), 2);
});

test('a PostgreSQL suite needs a test database, no live run, and applied migrations', () => {
  const idle = (command) => (command === 'ps' ? { stdout: 'bash\nnode scripts/test-focused.mjs x\n' } : { status: 0 });
  assert.match(readiness({}, idle), /\*test\* database/u);
  assert.match(readiness({ DATABASE_URL: 'postgresql://x/pmcvitan_prod' }, idle), /\*test\* database/u);
  assert.equal(readiness({ DATABASE_URL: 'postgresql://x/pmcvitan_test' }, idle), null);
  const busy = (command) => (command === 'ps' ? { stdout: 'node vitest run --config vitest.integration.config.ts\n' } : { status: 0 });
  assert.match(readiness({ DATABASE_URL: 'postgresql://x/pmcvitan_test' }, busy), /live run/u);
  const down = (command) => (command === 'ps' ? { stdout: '' } : { status: 1, stderr: 'connection refused' });
  assert.match(readiness({ DATABASE_URL: 'postgresql://x/pmcvitan_test' }, down), /not ready/u);
  const seen = [];
  main(['apps/api/test/integration/x.test.ts'], { env: { DATABASE_URL: 'postgresql://x/pmcvitan_test' }, log() {},
    exec: (command, args) => { seen.push([command, ...args].join(' ')); return command === 'ps' ? { stdout: '' } : { status: 0 }; },
    planImpl: () => ({ suite: { postgres: true }, cwd: '/repo/apps/api', argv: ['pnpm', 'exec', 'vitest', 'run', '--config', 'vitest.integration.config.ts', 'test/integration/x.test.ts'] }) });
  assert.deepEqual(seen, ['ps -eo args', 'pnpm --filter api exec prisma migrate deploy', 'pnpm exec vitest run --config vitest.integration.config.ts test/integration/x.test.ts']);
});
