import { describe, it, expect } from 'vitest';
import { group, inr, signed, dayLabel, addCivilDays, formatCivilDate, sortCivilDates, diffCivilDays, parseCivilDate } from '@vitan/shared';

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

describe('civil dates (Phase 0 Task 6) — real calendar arithmetic, never display strings', () => {
  it('adds days across month, year and leap boundaries', () => {
    expect(addCivilDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addCivilDays('2028-02-28', 1)).toBe('2028-02-29'); // 2028 is a leap year
    expect(addCivilDays('2027-02-28', 1)).toBe('2027-03-01'); // 2027 is not
    expect(addCivilDays('2026-06-01', 31)).toBe('2026-07-02');
    expect(addCivilDays('2026-01-01', -1)).toBe('2025-12-31');
  });

  it('formats for display without ever being sortable', () => {
    expect(formatCivilDate('2026-07-03')).toBe('03 Jul 2026');
    expect(formatCivilDate('2026-01-12')).toBe('12 Jan 2026');
  });

  it('sorts chronologically across year boundaries (the lexical trap)', () => {
    expect(sortCivilDates(['2027-01-01', '2026-12-31'])).toEqual(['2026-12-31', '2027-01-01']);
    expect(sortCivilDates(['2026-07-03', '2026-06-28'])).toEqual(['2026-06-28', '2026-07-03']);
  });

  it('measures whole-day differences', () => {
    expect(diffCivilDays('2026-06-01', '2026-07-02')).toBe(31);
    expect(diffCivilDays('2026-12-31', '2027-01-01')).toBe(1);
  });

  it('rejects malformed and impossible dates', () => {
    expect(() => parseCivilDate('03 Jul 2026')).toThrow();
    expect(() => parseCivilDate('2026-02-30')).toThrow();
    expect(() => parseCivilDate('2026-13-01')).toThrow();
  });

  it('CHARACTERIZATION: legacy offset 0 IS the anchor date (1 Jun 2026), not the following day', () => {
    // pins the backfill convention: civil date = 2026-06-01 + offset
    expect(dayLabel(0)).toBe('1 Jun');
    expect(dayLabel(32)).toBe('3 Jul');
    expect(addCivilDays('2026-06-01', 0)).toBe('2026-06-01');
    expect(formatCivilDate(addCivilDays('2026-06-01', 32))).toBe('03 Jul 2026');
  });
});
