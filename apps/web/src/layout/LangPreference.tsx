import { useLayoutEffect, useRef } from 'react';
import { useStore } from '@/store/store';
import { defaultLangFor, langPreferenceKey, readLangPreference, writeLangPreference } from '@/lib/langPreference';

/**
 * Applies and remembers the viewer's language. When the identity changes (sign-in, persona
 * switch) it restores that person's saved choice, or their role's default; after that, a change
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
  const applied = useRef<{ key: string; lang: string } | null>(null);

  // layout effect: the restored language paints on the first frame, never after an English flash
  useLayoutEffect(() => {
    if (applied.current?.key !== key) {
      const next = readLangPreference(key) ?? defaultLangFor(role);
      applied.current = { key, lang: next };
      if (next !== lang) setLang(next);
      return;
    }
    if (lang !== applied.current.lang) {
      applied.current = { key, lang };
      writeLangPreference(key, lang);
    }
  }, [key, lang, role, setLang]);

  return null;
}
