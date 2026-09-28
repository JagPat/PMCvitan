import type { Lang, Role } from '@vitan/shared';

/**
 * UX foundations — the viewer's chosen language, remembered per person on this device.
 *
 * A real session is keyed by the signed-in user id, so two people sharing a site phone each keep
 * their own language. Dev/demo auth has no user id, so it keys by persona. Nothing here widens
 * access or reaches the server: it is a display preference and the storage may be absent
 * (private mode, a blocked quota) — every read and write fails closed to "no preference".
 */

const PREFIX = 'vitan.lang.v1:';
const LANGS: readonly Lang[] = ['en', 'hi', 'gu'];

export function langPreferenceKey(userId: string | null, role: Role): string {
  return userId ? `user:${userId}` : `persona:${role}`;
}

/** Engineer screens default to Gujarati (the site's language); every other role to English. */
export function defaultLangFor(role: Role): Lang {
  return role === 'engineer' ? 'gu' : 'en';
}

export function readLangPreference(key: string): Lang | null {
  try {
    const v = globalThis.localStorage?.getItem(PREFIX + key);
    return LANGS.includes(v as Lang) ? (v as Lang) : null;
  } catch {
    return null;
  }
}

export function writeLangPreference(key: string, lang: Lang): void {
  try {
    globalThis.localStorage?.setItem(PREFIX + key, lang);
  } catch {
    /* storage unavailable — the choice still holds for this session */
  }
}

/**
 * The viewer's EXPLICIT choice, recorded at every language picker. `LangPreference` cannot infer
 * intent from identity changes alone — a language on screen may be one the viewer picked or a
 * default it applied — so a picker says so here. A choice made before the viewer has a console
 * identity (the sign-in screen) waits here until the next identity takes it and saves it; a choice
 * made inside the console is saved at once and the note is cleared.
 */
let pendingChoice: Lang | null = null;

export function noteLangChoice(lang: Lang): void {
  pendingChoice = lang;
}

export function takeLangChoice(): Lang | null {
  const choice = pendingChoice;
  pendingChoice = null;
  return choice;
}
