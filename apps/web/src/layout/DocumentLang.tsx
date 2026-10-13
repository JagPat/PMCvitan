import { useLayoutEffect } from 'react';
import { useStore } from '@/store/store';

/**
 * #827 (Top 10 #5) — the page's `<html lang>` follows the chosen language, on the sign-in screen
 * and inside the console alike. Screen readers then read Hindi and Gujarati in the right voice,
 * and `global.css` can drop the Latin-only capitals and letter spacing under `:lang(hi)` and
 * `:lang(gu)`, which break those scripts' joined letters. A layout effect, so the first painted
 * frame already carries the language.
 */
export function DocumentLang() {
  const lang = useStore((s) => s.lang);
  useLayoutEffect(() => {
    document.documentElement.lang = lang;
  }, [lang]);
  return null;
}
