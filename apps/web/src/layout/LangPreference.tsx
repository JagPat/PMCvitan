import { useLayoutEffect, useRef, useSyncExternalStore } from 'react';
import type { Lang } from '@vitan/shared';
import { useStore } from '@/store/store';
import {
  defaultLangFor,
  langChoiceVersion,
  langPreferenceKey,
  readLangPreference,
  subscribeLangChoice,
  takeLangChoice,
  writeLangPreference,
} from '@/lib/langPreference';

/**
 * Applies and remembers the viewer's language. It acts on an EXPLICIT choice (`noteLangChoice`, set by
 * every picker) and never infers one from an identity change — inference is what confused a
 * language the viewer picked with a default this component applied.
 *
 * When the identity or the role changes (sign-in, persona switch, a project switch that re-issues
 * the role), in order:
 *   1. a choice the viewer just made with no console identity (the sign-in screen) is theirs: it is
 *      applied and saved under the new identity;
 *   2. otherwise that person's saved choice;
 *   3. otherwise the role's default — applied, never written back, so it can change later.
 * With the identity stable, a change the viewer makes is saved under it. A GUEST's pick (the Team
 * Access picker, used by a worker signing in on the host's phone) is shown while the guest is on that
 * screen but never saved; leaving the screen gives the host their own language back.
 *
 * Mounted inside the console only; the sign-in screen's picker records its choice for step 1.
 */
export function LangPreference() {
  const role = useStore((s) => s.role);
  const userId = useStore((s) => s.sessionUserId);
  const lang = useStore((s) => s.lang);
  const setLang = useStore((s) => s.setLang);
  const screen = useStore((s) => s.screen);
  // a pick re-runs the effect even when it leaves the language unchanged
  const choice = useSyncExternalStore(subscribeLangChoice, langChoiceVersion);
  const key = langPreferenceKey(userId, role);
  const applied = useRef<{ key: string; role: string; lang: Lang } | null>(null);
  // the language a guest picked and is looking at; null when the host's own language is on screen
  const guestLang = useRef<Lang | null>(null);

  // layout effect: the restored language paints on the first frame, never after an English flash
  useLayoutEffect(() => {
    // the ROLE is tracked beside the key: a project switch can keep the same user (same key) under
    // a different role, and a person with no saved choice then takes the new role's default
    if (applied.current?.key !== key || applied.current.role !== role) {
      // a pick noted with no console identity yet is the person now signing in (at the gate a
      // guest IS that person); a guest pick made inside a console never follows its identity change
      const noted = takeLangChoice();
      const chosen = noted && (noted.source === 'viewer' || applied.current === null) ? noted : null;
      if (chosen) writeLangPreference(key, chosen.lang);
      const next = chosen?.lang ?? readLangPreference(key) ?? defaultLangFor(role);
      applied.current = { key, role, lang: next };
      guestLang.current = null;
      if (next !== lang) setLang(next);
      return;
    }
    // with the identity stable, act on the pick that just happened — never infer one from a
    // language change: every language change here is either a picker's (noted) or this
    // component's own restore, and a pick may leave the language exactly as it was
    const noted = takeLangChoice();
    if (noted?.source === 'viewer') {
      applied.current = { key, role, lang: noted.lang };
      guestLang.current = null;
      writeLangPreference(key, noted.lang);
      if (lang !== noted.lang) setLang(noted.lang);
      return;
    }
    if (noted?.source === 'guest') {
      // shown for the guest, never saved as the host's preference
      guestLang.current = noted.lang === applied.current.lang ? null : noted.lang;
      return;
    }
    // the guest has left Team Access: the host's own language comes back
    if (guestLang.current !== null && screen !== 'team-access') {
      guestLang.current = null;
      if (lang !== applied.current.lang) setLang(applied.current.lang);
    }
  }, [key, lang, role, screen, choice, setLang]);

  return null;
}
