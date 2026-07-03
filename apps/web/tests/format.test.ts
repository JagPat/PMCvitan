import { describe, it, expect } from 'vitest';
import { group, inr, signed, dayLabel } from '@vitan/shared';

describe('group() — Indian digit grouping', () => {
  it('groups lakhs correctly', () => {
    expect(group(140000)).toBe('1,40,000');
    expect(group(210000)).toBe('2,10,000');
    expect(group(118000)).toBe('1,18,000');
  });
  it('leaves 3-digit and smaller numbers ungrouped', () => {
    expect(group(0)).toBe('0');
    expect(group(999)).toBe('999');
    expect(group(1000)).toBe('1,000');
  });
});

describe('inr()', () => {
  it('prefixes the rupee sign', () => {
    expect(inr(140000)).toBe('₹1,40,000');
  });
});

describe('signed() — cost deltas', () => {
  it('reports zero as "No cost change"', () => {
    expect(signed(0)).toBe('No cost change');
  });
  it('prefixes a plus for positive deltas', () => {
    expect(signed(140000)).toBe('+₹1,40,000');
  });
  it('uses the U+2212 minus sign for negative deltas', () => {
    expect(signed(-45000)).toBe('−₹45,000');
  });
});

describe('dayLabel() — offsets from 1 Jun 2026', () => {
  it('maps todayDay (32) to 3 Jul', () => {
    expect(dayLabel(32)).toBe('3 Jul');
  });
  it('handles June and August boundaries', () => {
    expect(dayLabel(0)).toBe('1 Jun');
    expect(dayLabel(9)).toBe('10 Jun');
    expect(dayLabel(61)).toBe('1 Aug');
  });
});
