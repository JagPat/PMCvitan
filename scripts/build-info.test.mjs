import test from 'node:test';
import assert from 'node:assert/strict';

import { buildInfo } from './build-info.mjs';

const NOW = new Date('2026-10-08T12:00:00Z');

test('a hex source commit is reported with its short form and the build time', () => {
  const sha = 'A08F896'.toLowerCase() + '0'.repeat(33);
  assert.deepEqual(buildInfo({ SOURCE_COMMIT: ` ${sha.toUpperCase()} ` }, NOW), {
    commit: sha,
    commitShort: 'a08f896',
    builtAt: '2026-10-08T12:00:00.000Z',
  });
});

test('a missing or non-hex commit is "unknown", so no other value can leak', () => {
  for (const value of [undefined, '', 'main', 'secret=abc', 'abc', `${'a'.repeat(41)}`]) {
    const info = buildInfo({ SOURCE_COMMIT: value, JWT_SECRET: 'x' }, NOW);
    assert.equal(info.commit, 'unknown');
    assert.equal(info.commitShort, 'unknown');
    assert.deepEqual(Object.keys(info), ['commit', 'commitShort', 'builtAt']);
  }
});
