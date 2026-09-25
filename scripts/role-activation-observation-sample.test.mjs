import assert from 'node:assert/strict';
import test from 'node:test';

import { clampPercent } from './role-activation-observation-sample.mjs';

test('clampPercent keeps in-range values and caps values above 100', () => {
  assert.equal(clampPercent(0), 0);
  assert.equal(clampPercent(42.5), 42.5);
  assert.equal(clampPercent(100), 100);
  assert.equal(clampPercent(250), 100);
});

test('clampPercent maps anything that is not a finite number to 0', () => {
  for (const value of [Number.NaN, Number.POSITIVE_INFINITY, '50', null, undefined]) {
    assert.equal(clampPercent(value), 0, String(value));
  }
});
