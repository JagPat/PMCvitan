import { civilDateIn, dayLabel, formatCivilDate, servedDayIn, type Activity, type Lang } from '@vitan/shared';

/** A plan/actual date as the schedule shows it: the civil date when the activity has one, else the
 *  legacy day offset's label. */
export function labelOf(iso: string | null | undefined, legacy: number | null, lang: Lang = 'en'): string {
  if (iso) return lang === 'en' ? formatCivilDate(iso) : civilDateIn(iso, lang);
  return legacy == null ? '' : servedDayIn(dayLabel(legacy), lang);
}

/** "10 Jun → 20 Jun" — the activity's planned window, the same text the schedule row shows. */
export function plannedWindow(a: Activity, lang: Lang = 'en'): string {
  return `${labelOf(a.plannedStartDate, a.ps, lang)} → ${labelOf(a.plannedEndDate, a.pe, lang)}`;
}
