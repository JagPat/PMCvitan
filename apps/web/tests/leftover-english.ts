/**
 * #827 (Top 10 #5) — the automated leftover-English check Board asked for (13 Oct): a Hindi or
 * Gujarati screen must not hand off to English. Returns every Latin-letter word in the rendered
 * text and in the attributes a person reads or hears (placeholder, aria-label, title, alt), except
 * the words in `allowed` (data the person typed, such as a material name). Numbers, ₹ and
 * punctuation are not words. A test renders a screen in `hi` and `gu` and expects `[]`.
 */
const READ_ATTRIBUTES = ['placeholder', 'aria-label', 'title', 'alt'];

export function leftoverEnglish(root: HTMLElement, allowed: readonly string[] = []): string[] {
  const allow = new Set(allowed.flatMap((a) => a.match(/[A-Za-z]+/g) ?? []));
  // each text node on its own: `textContent` glues neighbours ("Kitchen" + "Main Door" → "KitchenMain")
  const texts: string[] = [];
  const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) texts.push(n.nodeValue ?? '');
  root.querySelectorAll('*').forEach((el) => {
    for (const name of READ_ATTRIBUTES) {
      const value = el.getAttribute(name);
      if (value) texts.push(value);
    }
  });
  const words = texts.flatMap((t) => t.match(/[A-Za-z]{2,}/g) ?? []);
  return [...new Set(words.filter((w) => !allow.has(w)))];
}
