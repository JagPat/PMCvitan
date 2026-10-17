/**
 * #482 QA item 3 — the Dashboard in Hindi and Gujarati (English unchanged). Project, phase and inspection
 * names are project data, shown as recorded. The photo block and the "Site photos on record" tile carry
 * their own words (the site-photos unit).
 */

import type { Lang } from '../domain/types';

type Words = Record<Lang, string>;
const pick = (lang: Lang, en: string, hi: string, gu: string): string => (lang === 'hi' ? hi : lang === 'gu' ? gu : en);

export const dashboardLabels = {
  eyebrow: { en: 'PROJECT DASHBOARD', hi: 'प्रोजेक्ट डैशबोर्ड', gu: 'પ્રોજેક્ટ ડેશબોર્ડ' },
  weeklyReport: { en: 'Generate Weekly Report', hi: 'साप्ताहिक रिपोर्ट बनाएँ', gu: 'સાપ્તાહિક રિપોર્ટ બનાવો' },
  weeklyReportDone: {
    en: 'Weekly report generated (PDF) — sent to client & contractor.',
    hi: 'साप्ताहिक रिपोर्ट (PDF) बन गई — क्लाइंट और ठेकेदार को भेज दी गई।',
    gu: 'સાપ્તાહિક રિપોર્ટ (PDF) બની ગયો — ક્લાયન્ટ અને કોન્ટ્રાક્ટરને મોકલાયો.',
  },
  milestones: { en: 'Milestone Progress', hi: 'माइलस्टोन की प्रगति', gu: 'માઇલસ્ટોનની પ્રગતિ' },
  progressRecorded: {
    en: 'No activities planned yet — this is the figure recorded on the project',
    hi: 'अभी कोई काम योजना में नहीं — यह प्रोजेक्ट पर दर्ज आँकड़ा है',
    gu: 'હજી કોઈ કામ આયોજનમાં નથી — આ પ્રોજેક્ટ પર નોંધાયેલો આંકડો છે',
  },
  progressUnavailable: {
    en: 'The activities could not be loaded, so progress is unavailable',
    hi: 'काम लोड नहीं हो सके, इसलिए प्रगति उपलब्ध नहीं है',
    gu: 'કામ લોડ ન થઈ શક્યાં, તેથી પ્રગતિ ઉપલબ્ધ નથી',
  },
  progressLoading: { en: 'Loading the activities…', hi: 'काम लोड हो रहे हैं…', gu: 'કામ લોડ થઈ રહ્યાં છે…' },
  retry: { en: 'Retry', hi: 'फिर कोशिश करें', gu: 'ફરી પ્રયાસ કરો' },
  liveFromSite: { en: 'LIVE FROM SITE', hi: 'साइट से अभी', gu: 'સાઇટ પરથી હમણાં' },
  logFailed: { en: 'The site log could not be loaded', hi: 'साइट लॉग लोड नहीं हो सका', gu: 'સાઇટ લૉગ લોડ ન થઈ શક્યો' },
  logLoading: { en: 'Loading the site log…', hi: 'साइट लॉग लोड हो रहा है…', gu: 'સાઇટ લૉગ લોડ થઈ રહ્યો છે…' },
  logSubmitted: { en: 'Daily log submitted', hi: 'दैनिक लॉग भेज दिया गया', gu: 'દૈનિક લૉગ મોકલાઈ ગયો' },
  logging: { en: 'Engineer on site · logging', hi: 'इंजीनियर साइट पर · दर्ज कर रहे हैं', gu: 'ઇજનેર સાઇટ પર · નોંધ કરી રહ્યા છે' },
  awaitingCheckIn: { en: 'Awaiting check-in', hi: 'चेक-इन का इंतज़ार', gu: 'ચેક-ઇનની રાહ' },
  workers: { en: 'WORKERS ON SITE', hi: 'साइट पर मज़दूर', gu: 'સાઇટ પર કામદારો' },
  materials: { en: 'MATERIALS LOGGED', hi: 'दर्ज सामान', gu: 'નોંધાયેલો માલસામાન' },
  viewSchedule: { en: 'View Schedule', hi: 'शेड्यूल देखें', gu: 'શેડ્યૂલ જુઓ' },
  pendingTile: { en: 'DECISIONS AWAITING APPROVAL', hi: 'मंज़ूरी की राह देखते निर्णय', gu: 'મંજૂરીની રાહ જોતા નિર્ણયો' },
  reviewTile: { en: 'INSPECTIONS AWAITING REVIEW', hi: 'जाँच की राह देखते निरीक्षण', gu: 'તપાસની રાહ જોતાં નિરીક્ષણો' },
  failedTile: { en: 'FAILED ITEMS AWAITING RE-INSPECTION', hi: 'दोबारा निरीक्षण की राह देखते फ़ेल बिंदु', gu: 'ફરી નિરીક્ષણની રાહ જોતા નિષ્ફળ મુદ્દા' },
  allCleared: { en: 'All cleared', hi: 'सब निपट गए', gu: 'બધું પતી ગયું' },
  onePending: { en: '1 pending', hi: '1 बाकी', gu: '1 બાકી' },
  nothingPending: { en: 'Nothing pending', hi: 'कुछ बाकी नहीं', gu: 'કંઈ બાકી નથી' },
  reinspectionUnknown: { en: 'Re-inspection status not reported', hi: 'दोबारा निरीक्षण की स्थिति नहीं मिली', gu: 'ફરી નિરીક્ષણની સ્થિતિ મળી નથી' },
  none: { en: 'None', hi: 'कोई नहीं', gu: 'કોઈ નહીં' },
  loadFailed: { en: 'Could not load — try again', hi: 'लोड नहीं हो सका — फिर कोशिश करें', gu: 'લોડ ન થયું — ફરી પ્રયાસ કરો' },
  loading: { en: 'Loading…', hi: 'लोड हो रहा है…', gu: 'લોડ થઈ રહ્યું છે…' },
  // Stage 1 redesign (#482, Rev 3.1 unit H2) — the Dashboard's one line pointing at For You
  nothingNeedsYou: { en: 'Nothing needs you', hi: 'अभी आपके लिए कुछ नहीं', gu: 'હમણાં તમારા માટે કંઈ નથી' },
  // Stage 1 redesign (#482, Rev 3.1 unit H3) — the site photo tile in every language, behind the home-nav switch
  photosTile: { en: 'SITE PHOTOS ON RECORD', hi: 'दर्ज साइट फ़ोटो', gu: 'નોંધાયેલા સાઇટ ફોટા' },
  photosNotPlaced: { en: 'Not placed on the site map yet', hi: 'अभी साइट मैप पर नहीं रखी गईं', gu: 'હજી સાઇટ મેપ પર મૂક્યા નથી' },
  photosNone: { en: 'None recorded yet', hi: 'अभी कोई दर्ज नहीं', gu: 'હજી કોઈ નોંધાયા નથી' },
} satisfies Record<string, Words>;

/** Stage 1 H3 — who a tile's items wait on; `several` when they wait on more than one party. */
export type WaitParty = 'you' | 'client' | 'pmc' | 'engineer' | 'architect' | 'decider' | 'several';
const WAIT_PARTY: Record<WaitParty, Words> = {
  you: { en: 'Waiting on you', hi: 'आपकी राह', gu: 'તમારી રાહ' },
  client: { en: 'Waiting on the client', hi: 'क्लाइंट की राह', gu: 'ક્લાયન્ટની રાહ' },
  pmc: { en: 'Waiting on the PMC', hi: 'PMC की राह', gu: 'PMCની રાહ' },
  engineer: { en: 'Waiting on the engineer', hi: 'इंजीनियर की राह', gu: 'ઇજનેરની રાહ' },
  architect: { en: 'Waiting on the architect', hi: 'आर्किटेक्ट की राह', gu: 'આર્કિટેક્ટની રાહ' },
  decider: { en: 'Waiting on the named decider', hi: 'तय करने वाले की राह', gu: 'નિર્ણય લેનારની રાહ' },
  several: { en: 'Waiting on more than one person', hi: 'एक से ज़्यादा लोगों की राह', gu: 'એકથી વધુ લોકોની રાહ' },
};

export const dashboardText = {
  siteCode: (code: string, lang: Lang): string => pick(lang, `Site Code ${code}`, `साइट कोड ${code}`, `સાઇટ કોડ ${code}`),
  percentComplete: (pct: number, lang: Lang): string => pick(lang, `${pct}% complete`, `${pct}% पूरा`, `${pct}% પૂર્ણ`),
  activitiesAccepted: (done: number, total: number, lang: Lang): string =>
    pick(lang, `${done} of ${total} activities accepted as done`, `${total} में से ${done} काम पूरे माने गए`, `${total} માંથી ${done} કામ પૂર્ણ સ્વીકારાયાં`),
  phaseSummary: (phase: string, done: number, total: number, lang: Lang): string =>
    pick(lang, `${phase}: ${done} of ${total} activities done`, `${phase}: ${total} में से ${done} काम पूरे`, `${phase}: ${total} માંથી ${done} કામ પૂર્ણ`),
  oldestAgeing: (days: number, lang: Lang): string =>
    pick(lang, `Oldest ageing ${days} days`, `सबसे पुराना ${days} दिन से रुका`, `સૌથી જૂનો ${days} દિવસથી અટકેલો`),
  /** Stage 1 H2 — `n` is the For You badge; `'—'` while it is not yet known (never a false 0). */
  youHaveActions: (n: number | '—', lang: Lang): string =>
    pick(lang, `You have ${n} action${n === 1 ? '' : 's'}`, `आपके लिए ${n} काम`, `તમારા માટે ${n} કામ`),
  /** Stage 1 H3 — whom a Dashboard tile's items wait on. */
  waitingOn: (party: WaitParty, lang: Lang): string => WAIT_PARTY[party][lang],
  /** Stage 1 H3 — the site photo tile's sub-line: a full snapshot window is "the latest n", never the total. */
  photosLatest: (n: number, lang: Lang): string => pick(lang, `Latest ${n} shown`, `नवीनतम ${n} दिखाई गईं`, `તાજેતરના ${n} બતાવ્યા`),
  /** `after`: the clause follows another on the same line, so English starts it in lower case */
  photosAcross: (places: number, lang: Lang, after = false): string =>
    pick(lang, `${after ? 'across' : 'Across'} ${places} place${places === 1 ? '' : 's'}`, `${places} ${places === 1 ? 'जगह' : 'जगहों'} पर`, `${places} જગ્યાએ`),
  inQueue: (n: number, lang: Lang): string => pick(lang, `${n} in the queue`, `कतार में ${n}`, `કતારમાં ${n}`),
  inReinspections: (n: number, lang: Lang): string =>
    pick(lang, `In ${n} open re-inspection${n === 1 ? '' : 's'}`, `${n} खुले दोबारा निरीक्षण में`, `${n} ખુલ્લા ફરી નિરીક્ષણમાં`),
};
