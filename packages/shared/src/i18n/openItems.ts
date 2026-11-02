/**
 * #482 proof photos, "Your open items" (RM-w2b) — the Dashboard block a contractor or consultant sees: the open
 * inspections they are named to fix, each failed item with "Add proof photo". Inspection titles, zones and item names
 * are project data, shown as recorded.
 *
 * The words follow the ones already in use: फ़ेल बिंदु / નિષ્ફળ મુદ્દા (the failed-items tile), दोबारा निरीक्षण / ફરી
 * નિરીક્ષણ (re-inspection), "Waiting on the …" (`dashboardText.waitingOn`). Jagrut may reword any line later; the PR
 * body lists them all in the three languages.
 */
import type { Lang } from '../domain/types';

type Words = Record<Lang, string>;

export const openItemsLabels = {
  title: { en: 'Your open items', hi: 'आपके खुले काम', gu: 'તમારાં ખુલ્લાં કામ' },
  hint: { en: 'Inspections you are named to fix.', hi: 'वे निरीक्षण जिन्हें ठीक करने के लिए आपका नाम दिया गया है।', gu: 'જે નિરીક્ષણો સુધારવા માટે તમારું નામ અપાયું છે.' },
  none: { en: 'Nothing open for you.', hi: 'आपके लिए कुछ खुला नहीं है।', gu: 'તમારા માટે કંઈ ખુલ્લું નથી.' },
  issued: { en: 'Waiting on the engineer', hi: 'इंजीनियर की राह', gu: 'ઇજનેરની રાહ' },
  inReview: { en: 'Waiting on the PMC', hi: 'PMC की राह', gu: 'PMCની રાહ' },
  reinspection: { en: 'Sent back for re-inspection', hi: 'दोबारा निरीक्षण के लिए वापस भेजा गया', gu: 'ફરી નિરીક્ષણ માટે પાછું મોકલ્યું' },
  noFailed: { en: 'No failed items yet.', hi: 'अभी कोई फ़ेल बिंदु नहीं।', gu: 'હજી કોઈ નિષ્ફળ મુદ્દો નથી.' },
  addProof: { en: 'Add proof photo', hi: 'सबूत फ़ोटो जोड़ें', gu: 'પુરાવાનો ફોટો ઉમેરો' },
  sending: { en: 'Sending…', hi: 'भेजा जा रहा है…', gu: 'મોકલાઈ રહ્યું છે…' },
  offline: { en: 'Adding a proof photo needs a connection.', hi: 'सबूत फ़ोटो जोड़ने के लिए नेटवर्क चाहिए।', gu: 'પુરાવાનો ફોટો ઉમેરવા નેટવર્ક જોઈએ.' },
  added: { en: 'Proof photo added.', hi: 'सबूत फ़ोटो जुड़ गई।', gu: 'પુરાવાનો ફોટો ઉમેરાયો.' },
  failed: { en: 'Could not add the proof photo. Try again.', hi: 'सबूत फ़ोटो नहीं जुड़ सकी। फिर कोशिश करें।', gu: 'પુરાવાનો ફોટો ઉમેરી શકાયો નહીં. ફરી પ્રયાસ કરો.' },
  full: { en: 'This item already has all its proof photos.', hi: 'इस बिंदु पर सारी सबूत फ़ोटो पहले से हैं।', gu: 'આ મુદ્દા પર બધા પુરાવાના ફોટા પહેલેથી છે.' },
} satisfies Record<string, Words>;

/** "3 of 10 proof photos" in the viewer's language (`cap` is `PROOF_PHOTOS_PER_ITEM`). */
export function openItemsProofCount(n: number, cap: number, lang: Lang): string {
  if (lang === 'hi') return `${cap} में से ${n} सबूत फ़ोटो`;
  if (lang === 'gu') return `${cap} માંથી ${n} પુરાવાના ફોટા`;
  return `${n} of ${cap} proof photo${cap === 1 ? '' : 's'}`;
}
