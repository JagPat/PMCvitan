/**
 * Civil-date helpers (Phase 0 Task 6) — a calendar day with no time or zone,
 * ISO `YYYY-MM-DD` at every boundary, UTC arithmetic ONLY.
 *
 * PINNED COPY of packages/shared/src/lib/dates.ts (the shared package is
 * source-only ESM the CommonJS API build can't import — the repo's mirrored
 * convention; both test suites share the same leap/year-boundary vectors).
 * The planned shared-runtime promotion removes this copy.
 */

const ISO_CIVIL_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Parse an ISO civil date to a UTC-midnight Date; throws on anything else. */
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
