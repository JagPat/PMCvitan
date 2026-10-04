import { dayLabel, formatCivilDate, type Activity } from '@vitan/shared';

/** A plan/actual date as the schedule shows it: the civil date when the activity has one, else the
 *  legacy day offset's label. */
export function labelOf(iso: string | null | undefined, legacy: number | null): string {
  if (iso) return formatCivilDate(iso);
  return legacy == null ? '' : dayLabel(legacy);
}

/** "10 Jun → 20 Jun" — the activity's planned window, the same text the schedule row shows. */
export function plannedWindow(a: Activity): string {
  return `${labelOf(a.plannedStartDate, a.ps)} → ${labelOf(a.plannedEndDate, a.pe)}`;
}
