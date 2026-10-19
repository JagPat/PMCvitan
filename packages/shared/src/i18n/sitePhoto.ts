import type { Lang, Role } from '../domain/types';
import { forYouRole } from './actionItems';

/**
 * #482 site photos — the words of the "Add site photo" button on the Dashboard, and the line on each photo
 * that says who added it, their role and when. A person's name is data, shown as recorded.
 */

export const sitePhotoLabels = {
  add: { en: 'Add site photo', hi: 'साइट फ़ोटो जोड़ें', gu: 'સાઇટ ફોટો ઉમેરો' },
  // deleting your own photo within the hour (Board, 14 Oct 2026)
  delete: { en: 'Delete', hi: 'हटाएँ', gu: 'કાઢી નાખો' },
  confirmDelete: { en: 'Delete this photo?', hi: 'यह फ़ोटो हटाएँ?', gu: 'આ ફોટો કાઢી નાખવો?' },
  keep: { en: 'Keep', hi: 'रखें', gu: 'રાખો' },
  deleted: { en: 'Photo deleted.', hi: 'फ़ोटो हटा दी गई।', gu: 'ફોટો કાઢી નાખ્યો.' },
  deleteOffline: { en: 'Connect to the internet to delete a photo.', hi: 'फ़ोटो हटाने के लिए इंटरनेट से जुड़ें।', gu: 'ફોટો કાઢવા માટે ઇન્ટરનેટ સાથે જોડાઓ.' },
} as const;

/** Whether the viewer may still delete this photo: the server marked it theirs to delete until `deletableUntil`
 *  (their own site photo, not on a sent log), and that time has not come (the server decides again on delete).
 *  `now` is the device's clock in ms. */
export function sitePhotoDeletable(p: { deletableUntil?: string }, now: number): boolean {
  if (!p.deletableUntil) return false;
  const until = Date.parse(p.deletableUntil);
  return !Number.isNaN(until) && now < until;
}

/** When a photo was added, in the project's time zone: "19 Oct, 3:00 PM" in English; in Hindi and Gujarati the
 *  day and month in that language and a 24-hour clock, as the photo stamps there read. Empty when unknown. */
export function sitePhotoAddedAt(at: string | null | undefined, lang: Lang, timeZone?: string | null): string {
  if (!at) return '';
  const when = new Date(at);
  if (Number.isNaN(when.getTime())) return '';
  const fmt = (locale: string, opts: Intl.DateTimeFormatOptions): string => {
    try {
      return new Intl.DateTimeFormat(locale, { ...opts, timeZone: timeZone ?? undefined }).format(when);
    } catch {
      return new Intl.DateTimeFormat(locale, opts).format(when); // an unknown zone: the device's own clock
    }
  };
  if (lang === 'en') {
    const day = fmt('en-GB', { day: 'numeric', month: 'short' });
    // newer ICU puts a narrow no-break space before AM/PM; this line keeps a plain one
    const clock = fmt('en-US', { hour: 'numeric', minute: '2-digit', hour12: true }).replace(/\s/g, ' ');
    return `${day}, ${clock}`;
  }
  const locale = lang === 'hi' ? 'hi-IN' : 'gu-IN';
  const day = fmt(locale, { day: 'numeric', month: 'short' });
  const clock = fmt('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false });
  return `${day}, ${clock}`;
}

/** "Ravi Patel · Contractor · 19 Oct, 3:00 PM": each part only when known. */
export function sitePhotoWho(p: { by?: string; byRole?: string; at?: string }, lang: Lang, timeZone?: string | null): string {
  const role = p.byRole && p.byRole in forYouRole ? forYouRole[p.byRole as Role][lang] : undefined;
  return [p.by?.trim() || undefined, role, sitePhotoAddedAt(p.at, lang, timeZone) || undefined].filter(Boolean).join(' · ');
}
