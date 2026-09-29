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
 *
 * WHO chose it matters too. The Team Access picker is a GUEST's: inside a signed-in console it is the
 * worker or trade in-charge about to sign in on the host's phone, so their pick is shown while they
 * sign in but never saved as the host's preference (at the sign-in gate there is no host, and the
 * guest is the person who signs in, so the pick is theirs and is carried as before).
 */
export type LangChoiceSource = 'viewer' | 'guest';

let pendingChoice: { lang: Lang; source: LangChoiceSource } | null = null;
// every note bumps the version, so a pick that leaves the language unchanged (the host choosing the
// language already on screen) still reaches `LangPreference` — it is a choice, not a no-op
let choiceVersion = 0;
const listeners = new Set<() => void>();

export function noteLangChoice(lang: Lang, source: LangChoiceSource = 'viewer'): void {
  pendingChoice = { lang, source };
  choiceVersion += 1;
  for (const listener of listeners) listener();
}

/** Drop a pending pick that nobody will take: at the gate a worker's or trade in-charge's flow is
 *  terminal (it never signs in), so a pick made for it must not wait for the next person who does. */
export function discardLangChoice(): void {
  pendingChoice = null;
}

export function subscribeLangChoice(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function langChoiceVersion(): number {
  return choiceVersion;
}

export function takeLangChoice(): { lang: Lang; source: LangChoiceSource } | null {
  const choice = pendingChoice;
  pendingChoice = null;
  return choice;
}
