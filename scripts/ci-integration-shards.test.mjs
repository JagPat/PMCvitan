import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_SECONDS,
  listIntegrationFiles,
  partition,
  shardProblems,
} from '../apps/api/test/integration-shards.mjs';

// The api job runs the integration suite as parallel shards (apps/api/test/integration-shards.mjs). These
// pin that no file can be dropped by the split, and that the step fails when a shard's report does not
// name exactly its files, all passed.

const API_ROOT = fileURLToPath(new URL('../apps/api/', import.meta.url));

test('every integration file lands in exactly one shard, for every shard count', async () => {
  const files = listIntegrationFiles(API_ROOT);
  assert.ok(files.length > 100, `found only ${files.length} integration files`);
  const durations = JSON.parse(await readFile(new URL('../apps/api/test/integration-durations.json', import.meta.url), 'utf8'));
  for (const count of [1, 2, 3, 4, 7]) {
    const shards = partition(files, durations, count);
    assert.equal(shards.length, count);
    const placed = shards.flatMap((shard) => shard.files).sort();
    assert.deepEqual(placed, files);
  }
});

test('the split is deterministic and balanced by recorded duration; an unrecorded file still runs', () => {
  const files = ['a.test.ts', 'b.test.ts', 'c.test.ts', 'd.test.ts', 'new.test.ts'];
  const durations = { 'a.test.ts': 100, 'b.test.ts': 60, 'c.test.ts': 50, 'd.test.ts': 10 };
  const first = partition(files, durations, 2);
  assert.deepEqual(partition([...files].reverse(), durations, 2), first);
  assert.deepEqual(first.map((shard) => shard.files), [['a.test.ts', 'd.test.ts', 'new.test.ts'], ['b.test.ts', 'c.test.ts']]);
  assert.deepEqual(first.map((shard) => shard.seconds), [110 + DEFAULT_SECONDS, 110]);
  assert.throws(() => partition(files, durations, 0), /positive integer/u);
});

test('a shard fails unless its report names exactly its files, every one passed', () => {
  const root = '/r';
  const report = (entries) => ({ testResults: entries.map(([name, status]) => ({ name: `/r/${name}`, status })) });
  const want = ['test/integration/a.test.ts', 'test/integration/b.test.ts'];
  assert.deepEqual(shardProblems(want, 0, report([[want[0], 'passed'], [want[1], 'passed']]), root), []);
  assert.deepEqual(shardProblems(want, 0, report([[want[0], 'passed']]), root), ['not run: test/integration/b.test.ts']);
  assert.deepEqual(
    shardProblems(want, 0, report([[want[0], 'passed'], [want[1], 'passed'], ['test/integration/c.test.ts', 'passed']]), root),
    ['ran but not assigned: test/integration/c.test.ts'],
  );
  assert.deepEqual(
    shardProblems(want, 1, report([[want[0], 'passed'], [want[1], 'failed']]), root),
    ['vitest exited 1', 'did not pass: test/integration/b.test.ts'],
  );
  assert.deepEqual(shardProblems(want, 0, null, root), ['no JSON report was written']);
  assert.deepEqual(
    shardProblems(want, 0, report([[want[0], 'passed'], [want[0], 'passed'], [want[1], 'passed']]), root),
    ['a file was reported twice'],
  );
});

test('the api job runs the sharded suite, one migrated server per shard', async () => {
  const workflow = await readFile(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
  const api = workflow.slice(workflow.indexOf('\n  api:\n'));
  const step = api.slice(api.indexOf('- name: Integration tests'));
  assert.match(step, /node test\/integration-shards\.mjs "\$DATABASE_URL"/u);
  for (const port of [5433, 5434, 5435]) {
    assert.match(step, new RegExp(`localhost:${port}/pmcvitan_test`, 'u'));
    assert.match(api, new RegExp(`-p "\\$\\(\\(5432 \\+ i\\)\\):5432"`, 'u'));
  }
  assert.match(api, /for i in 1 2 3; do[\s\S]*pnpm --filter api prisma:migrate/u);
  assert.doesNotMatch(api, /pnpm --filter api test:integration/u);
});
