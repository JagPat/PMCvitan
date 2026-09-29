import { useLayoutEffect, useRef } from 'react';
import { useStore } from '@/store/store';
import { defaultLangFor, langPreferenceKey, readLangPreference, takeLangChoice, writeLangPreference } from '@/lib/langPreference';

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
 * With the identity stable, a change the viewer makes is saved under it.
 *
 * Mounted inside the console only; the sign-in screen's picker records its choice for step 1.
 */
export function LangPreference() {
  const role = useStore((s) => s.role);
  const userId = useStore((s) => s.sessionUserId);
  const lang = useStore((s) => s.lang);
  const setLang = useStore((s) => s.setLang);
  const key = langPreferenceKey(userId, role);
  const applied = useRef<{ key: string; role: string; lang: string } | null>(null);

  // layout effect: the restored language paints on the first frame, never after an English flash
  useLayoutEffect(() => {
    // the ROLE is tracked beside the key: a project switch can keep the same user (same key) under
    // a different role, and a person with no saved choice then takes the new role's default
    if (applied.current?.key !== key || applied.current.role !== role) {
      const chosen = takeLangChoice();
      if (chosen) writeLangPreference(key, chosen);
      const next = chosen ?? readLangPreference(key) ?? defaultLangFor(role);
      applied.current = { key, role, lang: next };
      if (next !== lang) setLang(next);
      return;
    }
    if (lang !== applied.current.lang) {
      applied.current = { key, role, lang };
      writeLangPreference(key, lang);
      // saved under this identity — the note must not carry into the next one
      takeLangChoice();
    }
  }, [key, lang, role, setLang]);

  return null;
}
