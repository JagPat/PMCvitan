/**
 * Civil-date helpers (Phase 0 Task 6) — a calendar day with no time or zone,
 * ISO `YYYY-MM-DD` at every boundary, UTC arithmetic ONLY.
 *
 * The calendar arithmetic (`parseCivilDate`/`addCivilDays`/`diffCivilDays`) is now
 * IMPORTED from the built `@vitan/shared` runtime package (Phase 2 Task 2) — one
 * source of truth shared with the web app; the former pinned copy is retired.
 * Only the two Prisma `@db.Date` bridges below are API-specific (no web
 * equivalent) and stay local.
 */
import { parseCivilDate } from '@vitan/shared';

export { parseCivilDate, addCivilDays, diffCivilDays } from '@vitan/shared';

/** A Prisma `@db.Date` value (UTC-midnight Date) -> ISO civil date; null passes through. */
export function toIsoCivilDate(value: Date | null | undefined): string | null {
  if (!value) return null;
  return value.toISOString().slice(0, 10);
}

/** ISO civil date -> UTC-midnight Date for a Prisma `@db.Date` column; null passes through. */
export function fromIsoCivilDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  return parseCivilDate(value);
}

/**
 * U3a — the INSTANT a civil day begins in an IANA time zone (as a UTC `Date`), for windowing `DateTime`
 * columns ("since yesterday" on a site's own calendar): the FIRST instant whose local date in the zone is
 * `isoDate`. That is the local midnight, except on a day whose midnight does not exist (a DST change AT
 * midnight, e.g. America/Santiago), where it is the transition instant itself. The candidates are local
 * midnight under the zone's offset just before and just after that day's start (and the offset at the
 * midnight itself); the earliest one that falls on `isoDate` is the day's start. An unknown zone throws,
 * like `Clock.today`.
 */
export function civilDayStartInstant(isoDate: string, timeZone: string): Date {
  const guess = parseCivilDate(isoDate).getTime(); // UTC midnight of that calendar day
  const DAY = 86_400_000;
  const format = new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const local = (instant: number) => {
    const parts = format.formatToParts(new Date(instant));
    const n = (t: string): number => Number(parts.find((p) => p.type === t)!.value);
    return { wall: Date.UTC(n('year'), n('month') - 1, n('day'), n('hour'), n('minute'), n('second')), date: `${String(n('year')).padStart(4, '0')}-${String(n('month')).padStart(2, '0')}-${String(n('day')).padStart(2, '0')}` };
  };
  const offsetAt = (instant: number): number => local(instant).wall - instant;
  const candidates = [guess - offsetAt(guess - DAY), guess - offsetAt(guess + DAY), guess - offsetAt(guess - offsetAt(guess))];
  const onDay = candidates.filter((c) => local(c).date === isoDate);
  return new Date(Math.min(...(onDay.length ? onDay : candidates)));
}
