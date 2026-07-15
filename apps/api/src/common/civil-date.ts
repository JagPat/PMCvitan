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
