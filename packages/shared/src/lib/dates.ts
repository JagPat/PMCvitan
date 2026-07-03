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
