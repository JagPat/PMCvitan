import { useLayoutEffect, useRef } from 'react';
import { useStore } from '@/store/store';
import { defaultLangFor, langPreferenceKey, readLangPreference, writeLangPreference } from '@/lib/langPreference';

/**
 * Applies and remembers the viewer's language. When the identity or the role changes (sign-in,
 * persona switch, a project switch that re-issues the role) it restores that person's saved choice, or their role's default; after that, a change
 * the viewer makes is saved under the same identity. A default that was only applied is never
 * written back, so the role default can change later without being frozen into storage.
 *
 * Mounted inside the console only — the sign-in gate keeps its own language picker.
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
      const next = readLangPreference(key) ?? defaultLangFor(role);
      applied.current = { key, role, lang: next };
      if (next !== lang) setLang(next);
      return;
    }
    if (lang !== applied.current.lang) {
      applied.current = { key, role, lang };
      writeLangPreference(key, lang);
    }
  }, [key, lang, role, setLang]);

  return null;
}
