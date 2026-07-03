import { describe, it, expect } from 'vitest';
import { deriveDecisionGate, isActivityReady, gateReady, checklistSubmitError, reinspectionCount } from './transitions';

describe('deriveDecisionGate', () => {
  it('is n/a when there is no linked decision', () => {
    expect(deriveDecisionGate(null)).toBe('na');
  });
  it('is ok once the decision is approved, waiting otherwise', () => {
    expect(deriveDecisionGate('approved')).toBe('ok');
    expect(deriveDecisionGate('pending')).toBe('wait');
    expect(deriveDecisionGate('change')).toBe('wait');
  });
});

describe('activity readiness', () => {
  it('treats ok and na as ready, wait/fail as not', () => {
    expect(gateReady('ok')).toBe(true);
    expect(gateReady('na')).toBe(true);
    expect(gateReady('wait')).toBe(false);
    expect(gateReady('fail')).toBe(false);
  });
  it('is ready only when all four gates align', () => {
    expect(isActivityReady({ d: 'ok', m: 'ok', t: 'na', i: 'ok' })).toBe(true);
    expect(isActivityReady({ d: 'wait', m: 'ok', t: 'ok', i: 'ok' })).toBe(false);
    expect(isActivityReady({ d: 'ok', m: 'fail', t: 'ok', i: 'ok' })).toBe(false);
  });
});

describe('checklistSubmitError (guarded submit)', () => {
  const done = (state: string) => ({ state, photos: 1 });
  it('blocks until every item is marked', () => {
    const items = [done('pass'), { state: null, photos: 0 }];
    expect(checklistSubmitError(items)).toMatch(/mark all/);
  });
  it('requires a photo on a failed item', () => {
    const items = [done('pass'), { state: 'fail', photos: 0 }];
    expect(checklistSubmitError(items)).toMatch(/photo/);
  });
  it('passes when all marked and fails have photos', () => {
    const items = [done('pass'), { state: 'fail', photos: 2 }, done('na')];
    expect(checklistSubmitError(items)).toBeNull();
  });
});

describe('reinspectionCount', () => {
  it('counts FAIL results plus explicitly rejected items', () => {
    const items = [
      { rejected: false, result: 'PASS' },
      { rejected: true, result: 'PASS' },
      { rejected: false, result: 'FAIL' },
    ];
    expect(reinspectionCount(items)).toBe(2);
  });
});
