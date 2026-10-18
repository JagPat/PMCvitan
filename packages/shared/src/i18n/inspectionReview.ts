/**
 * #482 V-1018-2 — the PMC's Inspection Review and the client's Project Health in the viewer's language. English
 * is byte-identical to the screens' original copy. Review titles, item names, notes, people and activity names
 * are project data, shown as recorded.
 */
import type { InspectionResult, Lang } from '../domain/types';
import { servedDayIn } from './schedule';

const pick = (lang: Lang, en: string, hi: string, gu: string): string => (lang === 'hi' ? hi : lang === 'gu' ? gu : en);

export const inspectionReviewLabels = {
  eyebrow: { en: 'INSPECTION REVIEW', hi: 'निरीक्षण की जाँच', gu: 'નિરીક્ષણની તપાસ' },
  queue: { en: 'Review queue', hi: 'जाँच की कतार', gu: 'તપાસની કતાર' },
  returning: { en: 'Returning to the inspection queue…', hi: 'निरीक्षण की कतार पर लौट रहे हैं…', gu: 'નિરીક્ષણની કતાર પર પાછા જઈ રહ્યા છીએ…' },
  showAwaiting: { en: 'Show inspections awaiting review', hi: 'जाँच की राह देख रहे निरीक्षण दिखाएँ', gu: 'તપાસની રાહ જોતાં નિરીક્ષણ બતાવો' },
  loadFailed: { en: "Couldn't load inspections — check your connection and access.", hi: 'निरीक्षण नहीं खुल सके — नेटवर्क और अपनी अनुमति जाँचें।', gu: 'નિરીક્ષણ ખૂલી શક્યાં નહીં — નેટવર્ક અને તમારી પરવાનગી તપાસો.' },
  retry: { en: 'Retry', hi: 'फिर कोशिश करें', gu: 'ફરી પ્રયાસ કરો' },
  loading: { en: 'Loading inspections…', hi: 'निरीक्षण खुल रहे हैं…', gu: 'નિરીક્ષણ ખૂલી રહ્યાં છે…' },
  what: { en: 'Inspection', hi: 'निरीक्षण', gu: 'નિરીક્ષણ' },
  showAll: { en: 'Show all inspections', hi: 'सभी निरीक्षण दिखाएँ', gu: 'બધાં નિરીક્ષણ બતાવો' },
  empty: {
    en: 'No inspections awaiting review. Submitted checklists and closing inspections land here.',
    hi: 'कोई निरीक्षण जाँच की राह नहीं देख रहा। भेजी गई चेकलिस्ट और समापन निरीक्षण यहाँ आते हैं।',
    gu: 'કોઈ નિરીક્ષણ તપાસની રાહ જોતું નથી. મોકલેલી ચેકલિસ્ટ અને સમાપન નિરીક્ષણ અહીં આવે છે.',
  },
  awaiting: { en: 'AWAITING REVIEW', hi: 'जाँच बाकी', gu: 'તપાસ બાકી' },
  reviewed: { en: 'REVIEWED', hi: 'जाँच हो गई', gu: 'તપાસ થઈ ગઈ' },
  noItems: {
    en: 'No checklist items were recorded for this inspection — approve to sign it off, or send it back for a re-inspection.',
    hi: 'इस निरीक्षण में चेकलिस्ट का कोई आइटम दर्ज नहीं हुआ — पूरा करने के लिए मंज़ूर करें, या दोबारा निरीक्षण के लिए वापस भेजें।',
    gu: 'આ નિરીક્ષણમાં ચેકલિસ્ટની કોઈ આઇટમ નોંધાઈ નથી — પૂરું કરવા મંજૂર કરો, અથવા ફરી નિરીક્ષણ માટે પાછું મોકલો.',
  },
  /** V-1018-1 — an item with no photo says so, so its placeholder is never taken for a photo */
  noPhoto: { en: 'No photo', hi: 'कोई फ़ोटो नहीं', gu: 'કોઈ ફોટો નથી' },
  reject: { en: 'Reject item', hi: 'आइटम नामंज़ूर करें', gu: 'આઇટમ નામંજૂર કરો' },
  rejected: { en: 'Rejected ✕', hi: 'नामंज़ूर ✕', gu: 'નામંજૂર ✕' },
  sendBack: { en: 'Send back for re-inspection', hi: 'दोबारा निरीक्षण के लिए वापस भेजें', gu: 'ફરી નિરીક્ષણ માટે પાછું મોકલો' },
  approve: { en: 'Approve Inspection', hi: 'निरीक्षण मंज़ूर करें', gu: 'નિરીક્ષણ મંજૂર કરો' },
  confirmTitle: { en: 'Approve with failed items?', hi: 'ख़राब आइटम के साथ मंज़ूर करें?', gu: 'ખામીવાળી આઇટમ સાથે મંજૂર કરવું?' },
  confirmLabel: { en: 'Approve anyway', hi: 'फिर भी मंज़ूर करें', gu: 'તોય મંજૂર કરો' },
  decided: { en: 'Decision recorded ✓', hi: 'फ़ैसला दर्ज हुआ ✓', gu: 'નિર્ણય નોંધાયો ✓' },
  decidedReason: {
    en: 'Reviewed — this inspection has been decided; its outcome and any re-inspection it created are recorded.',
    hi: 'जाँच हो गई — इस निरीक्षण पर फ़ैसला हो चुका है; उसका नतीजा और उससे बना कोई भी दोबारा निरीक्षण दर्ज है।',
    gu: 'તપાસ થઈ ગઈ — આ નિરીક્ષણ પર નિર્ણય થઈ ગયો છે; તેનું પરિણામ અને તેનાથી બનેલું કોઈ પણ ફરી નિરીક્ષણ નોંધાયેલું છે.',
  },
  newChecklist: { en: 'New checklist', hi: 'नई चेकलिस्ट', gu: 'નવી ચેકલિસ્ટ' },
  noneRejected: {
    en: 'No items rejected. Use Approve Inspection instead.',
    hi: 'कोई आइटम नामंज़ूर नहीं। इसके बजाय “निरीक्षण मंज़ूर करें” दबाएँ।',
    gu: 'કોઈ આઇટમ નામંજૂર નથી. તેના બદલે “નિરીક્ષણ મંજૂર કરો” દબાવો.',
  },
  /** what an offline-queued decision is called in the "saved offline" line */
  approveQueued: { en: 'Approve inspection', hi: 'निरीक्षण की मंज़ूरी', gu: 'નિરીક્ષણની મંજૂરી' },
  sendBackQueued: { en: 'Send re-inspection', hi: 'दोबारा निरीक्षण भेजना', gu: 'ફરી નિરીક્ષણ મોકલવું' },
} satisfies Record<string, Record<Lang, string>>;

/** The result chip's word: the engineer's checklist names the same marks Pass / Fail. */
const RESULT: Record<InspectionResult, Record<Lang, string>> = {
  PASS: { en: 'PASS', hi: 'ठीक', gu: 'બરાબર' },
  FAIL: { en: 'FAIL', hi: 'ख़राब', gu: 'ખામી' },
};

export const inspectionReviewText = {
  /** a result this bundle does not know reads as recorded */
  result: (result: InspectionResult, lang: Lang): string => RESULT[result]?.[lang] ?? String(result),
  pending: (n: number, lang: Lang): string => pick(lang, ` · ${n} PENDING`, ` · ${n} बाकी`, ` · ${n} બાકી`),
  opening: (id: string, lang: Lang): string => pick(lang, `Opening ${id}…`, `${id} खुल रहा है…`, `${id} ખૂલી રહ્યું છે…`),
  /** `activity` null: the review names no activity */
  closing: (activity: string | null, lang: Lang): string =>
    pick(
      lang,
      `CLOSING SIGN-OFF · ${activity ?? 'ACTIVITY'} — APPROVAL MARKS IT DONE`,
      `समापन मंज़ूरी · ${activity ?? 'काम'} — मंज़ूरी से यह पूरा माना जाएगा`,
      `સમાપન મંજૂરી · ${activity ?? 'કામ'} — મંજૂરીથી તે પૂરું ગણાશે`,
    ),
  submittedBy: (by: string, lang: Lang): string => pick(lang, `Submitted by ${by}`, `${by} ने भेजा`, `${by} એ મોકલ્યું`),
  evidenceAlt: (name: string, lang: Lang): string => pick(lang, `Evidence — ${name}`, `सबूत — ${name}`, `પુરાવો — ${name}`),
  marked: (n: number, lang: Lang): string =>
    pick(lang, `${n} item(s) marked for rejection`, `${n} आइटम नामंज़ूरी के लिए चुने गए`, `${n} આઇટમ નામંજૂરી માટે પસંદ થઈ`),
  failedConfirm: (n: number, lang: Lang): string =>
    pick(
      lang,
      `${n === 1 ? '1 item failed' : `${n} items failed`}. Approving signs this inspection off without a re-inspection.`,
      `${n} आइटम ख़राब ${n === 1 ? 'है' : 'हैं'}। मंज़ूर करने पर यह निरीक्षण बिना दोबारा निरीक्षण के पूरा हो जाएगा।`,
      `${n} આઇટમમાં ખામી છે. મંજૂર કરવાથી આ નિરીક્ષણ ફરી નિરીક્ષણ વગર પૂરું થશે.`,
    ),
  /** `activity` null: the review names no activity */
  decidedClosing: (activity: string | null, lang: Lang): string =>
    pick(
      lang,
      `Reviewed — the closing decision for ${activity ?? 'this activity'} is recorded. Its outcome shows on that activity in the Schedule.`,
      `जाँच हो गई — ${activity ?? 'इस काम'} का समापन फ़ैसला दर्ज है। उसका नतीजा शेड्यूल में उस काम पर दिखता है।`,
      `તપાસ થઈ ગઈ — ${activity ?? 'આ કામ'}નો સમાપન નિર્ણય નોંધાયો છે. તેનું પરિણામ શેડ્યૂલમાં તે કામ પર દેખાય છે.`,
    ),
  outOnSite: (n: number, lang: Lang): string =>
    pick(lang, `OUT ON SITE · ${n} AWAITING THE ENGINEER`, `साइट पर · ${n} इंजीनियर की राह में`, `સાઇટ પર · ${n} ઇજનેરની રાહમાં`),
  items: (n: number, lang: Lang): string => pick(lang, `${n} item${n === 1 ? '' : 's'}`, `${n} आइटम`, `${n} આઇટમ`),
  approvedToast: (id: string, lang: Lang): string =>
    pick(lang, `Inspection ${id} approved. Contractor and client notified.`, `निरीक्षण ${id} मंज़ूर हुआ। ठेकेदार और क्लाइंट को सूचना दी गई।`, `નિરીક્ષણ ${id} મંજૂર થયું. કોન્ટ્રાક્ટર અને ક્લાયન્ટને જાણ કરી.`),
  signedOffToast: (activity: string, lang: Lang): string =>
    pick(lang, `Signed off: ${activity} is complete.`, `मंज़ूरी दी: ${activity} पूरा हुआ।`, `મંજૂરી આપી: ${activity} પૂર્ણ થયું.`),
  reinspectionsToast: (n: number, lang: Lang): string =>
    pick(
      lang,
      `${n} re-inspection task(s) created with due dates.`,
      n === 1 ? 'दोबारा निरीक्षण का 1 काम नियत तारीख़ के साथ बना।' : `दोबारा निरीक्षण के ${n} काम नियत तारीख़ के साथ बने।`,
      n === 1 ? 'ફરી નિરીક્ષણનું 1 કામ નિયત તારીખ સાથે બન્યું.' : `ફરી નિરીક્ષણનાં ${n} કામ નિયત તારીખ સાથે બન્યાં.`,
    ),
};

/** #482 6248989265 — the client's Project Health screen. */
export const clientHealthLabels = {
  eyebrow: { en: 'PROJECT HEALTH', hi: 'प्रोजेक्ट की स्थिति', gu: 'પ્રોજેક્ટની સ્થિતિ' },
  siteOpens: { en: 'Site opens shortly today', hi: 'साइट आज थोड़ी देर में खुलेगी', gu: 'સાઇટ આજે થોડી વારમાં ખૂલશે' },
  /** demo only: the prototype's stage line (a live project shows its recorded stage) */
  demoStage: { en: 'Finishing stage · On track', hi: 'अंतिम चरण · समय पर', gu: 'અંતિમ તબક્કો · સમયસર' },
  photos: { en: 'Progress photos', hi: 'प्रगति की फ़ोटो', gu: 'પ્રગતિના ફોટા' },
  overall: { en: 'Overall progress', hi: 'कुल प्रगति', gu: 'કુલ પ્રગતિ' },
  actionNeeded: { en: 'ACTION NEEDED', hi: 'आपका काम बाकी', gu: 'તમારું કામ બાકી' },
  recentlyApproved: { en: 'RECENTLY APPROVED', hi: 'हाल में मंज़ूर', gu: 'તાજેતરમાં મંજૂર' },
} satisfies Record<string, Record<Lang, string>>;

export const clientHealthText = {
  siteActive: (workers: number, lang: Lang): string =>
    pick(lang, `Site active today · ${workers} workers`, `आज साइट पर काम चल रहा है · ${workers} मज़दूर`, `આજે સાઇટ પર કામ ચાલુ છે · ${workers} કામદાર`),
  decisionsWaiting: (n: number, lang: Lang): string =>
    pick(
      lang,
      `${n} ${n === 1 ? 'decision waiting' : 'decisions waiting'} for you`,
      `${n} निर्णय आपकी राह देख ${n === 1 ? 'रहा है' : 'रहे हैं'}`,
      `${n} નિર્ણય તમારી રાહ જુએ છે`,
    ),
  /** the approver is a person's name (data); a served "02 Jul 2026" day reads in the viewer's calendar */
  approvedBy: (approver: string | undefined, date: string | undefined, lang: Lang): string => {
    if (lang === 'en') return `By ${approver} · ${date}`;
    const day = date === undefined ? '' : servedDayIn(date, lang);
    return lang === 'hi' ? `${approver ?? ''} द्वारा · ${day}` : `${approver ?? ''} દ્વારા · ${day}`;
  },
  openDecision: (title: string, lang: Lang): string => pick(lang, `Open decision ${title}`, `निर्णय खोलें: ${title}`, `નિર્ણય ખોલો: ${title}`),
};
