/**
 * Date helpers for Vitan PMC.
 *
 * The site-schedule spine uses integer day-offsets from 1 Jun 2026 (the
 * prototype's DAY0). `dayLabel` mirrors the prototype's branchy formatter so
 * `dayLabel(32)` === "3 Jul" lines up with the seeded `todayDay: 32`.
 */

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Day-offset (from 1 Jun 2026) -> short "D MMM" label. */
export function dayLabel(d: number): string {
  if (d < 30) return d + 1 + ' Jun';
  if (d < 61) return d - 29 + ' Jul';
  return d - 60 + ' Aug';
}

/** Real DD MMM YYYY formatter for live/forward-looking dates (seed dates are pre-formatted strings). */
export function ddMmmYyyy(date: Date): string {
  const dd = String(date.getDate()).padStart(2, '0');
  return `${dd} ${MONTHS[date.getMonth()]} ${date.getFullYear()}`;
}

// ── Civil dates (Phase 0 Task 6) ────────────────────────────────────────────
// A civil date is a calendar day with no time or zone — the day site work
// happened, the day an activity is planned. ISO `YYYY-MM-DD` strings at every
// boundary; UTC arithmetic ONLY (never local time, which shifts across zones).
// The API keeps a pinned copy in apps/api/src/common/civil-date.ts until this
// package is a built runtime dependency — both test suites share the same
// leap/year-boundary vectors.

const ISO_CIVIL_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Parse an ISO civil date to a UTC-midnight Date; throws on anything else
 *  (including real-looking but invalid days like 2026-02-30). */
export function parseCivilDate(value: string): Date {
  if (!ISO_CIVIL_DATE.test(value)) throw new Error(`Invalid civil date: ${value}`);
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    throw new Error(`Invalid civil date: ${value}`);
  }
  return date;
}

/** Add whole days (negative allowed) across month/year/leap boundaries. */
export function addCivilDays(value: string, days: number): string {
  const date = parseCivilDate(value);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/** Whole days from `from` to `to` (positive when `to` is later). */
export function diffCivilDays(from: string, to: string): number {
  return Math.round((parseCivilDate(to).getTime() - parseCivilDate(from).getTime()) / 86_400_000);
}

/** ISO civil date -> display "DD MMM YYYY" (derived, never sorted or compared). */
export function formatCivilDate(value: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC',
  }).format(parseCivilDate(value)).replace(',', '');
}

/** Chronological sort — real date order, never lexical/display order. */
export function sortCivilDates(values: string[]): string[] {
  return [...values].sort((a, b) => parseCivilDate(a).getTime() - parseCivilDate(b).getTime());
}
