import { describe, it, expect } from 'vitest';
import { parseCivilDate, addCivilDays, diffCivilDays, toIsoCivilDate, fromIsoCivilDate } from './civil-date';

/**
 * The SAME leap/year-boundary vectors as packages/shared (format.test.ts) — the
 * two implementations are pinned copies and must never drift apart.
 */
describe('civil dates (API pinned copy) — shared vectors', () => {
  it('adds days across month, year and leap boundaries', () => {
    expect(addCivilDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addCivilDays('2028-02-28', 1)).toBe('2028-02-29'); // 2028 is a leap year
    expect(addCivilDays('2027-02-28', 1)).toBe('2027-03-01'); // 2027 is not
    expect(addCivilDays('2026-06-01', 31)).toBe('2026-07-02');
    expect(addCivilDays('2026-01-01', -1)).toBe('2025-12-31');
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

  it('round-trips Prisma @db.Date values', () => {
    expect(toIsoCivilDate(new Date('2026-07-03T00:00:00.000Z'))).toBe('2026-07-03');
    expect(toIsoCivilDate(null)).toBeNull();
    expect(fromIsoCivilDate('2026-07-03')?.toISOString()).toBe('2026-07-03T00:00:00.000Z');
    expect(fromIsoCivilDate(null)).toBeNull();
  });
});
