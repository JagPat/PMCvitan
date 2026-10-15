/**
 * #482 QA item 3 — the Drawings register in Hindi and Gujarati (English unchanged). Drawing numbers,
 * titles, revision letters, place names and people's names are project data, shown as recorded.
 */

import type { Discipline, Lang } from '../domain/types';

type Words = Record<Lang, string>;

export const drawingsLabels = {
  eyebrow: { en: 'DRAWINGS · REGISTER', hi: 'ड्रॉइंग · रजिस्टर', gu: 'ડ્રોઇંગ · રજિસ્ટર' },
  loadFailed: {
    en: 'Couldn\'t load the drawing register — check your connection and access.',
    hi: 'ड्रॉइंग रजिस्टर लोड नहीं हो सका — अपना इंटरनेट और पहुँच देखें।',
    gu: 'ડ્રોઇંગ રજિસ્ટર લોડ ન થયું — તમારું ઇન્ટરનેટ અને પરવાનગી તપાસો.',
  },
  retry: { en: 'Retry', hi: 'फिर कोशिश करें', gu: 'ફરી પ્રયાસ કરો' },
  loading: { en: 'Loading the drawing register…', hi: 'ड्रॉइंग रजिस्टर लोड हो रहा है…', gu: 'ડ્રોઇંગ રજિસ્ટર લોડ થઈ રહ્યું છે…' },
  what: { en: 'Drawing', hi: 'ड्रॉइंग', gu: 'ડ્રોઇંગ' },
  showAll: { en: 'Show all drawings', hi: 'सभी ड्रॉइंग दिखाएँ', gu: 'બધા ડ્રોઇંગ બતાવો' },
  issue: { en: 'Issue drawing', hi: 'ड्रॉइंग जारी करें', gu: 'ડ્રોઇંગ જારી કરો' },
  stale: {
    en: 'Showing the last-known register — the latest couldn\'t load. Actions are paused until it refreshes.',
    hi: 'पिछला ज्ञात रजिस्टर दिख रहा है — नया लोड नहीं हो सका। ताज़ा होने तक बदलाव रुके हैं।',
    gu: 'છેલ્લું જાણીતું રજિસ્ટર દેખાય છે — નવું લોડ ન થયું. તાજું થાય ત્યાં સુધી ફેરફારો અટક્યા છે.',
  },
  showing: { en: 'SHOWING', hi: 'दिखा रहे हैं', gu: 'બતાવીએ છીએ' },
  allDisciplines: { en: 'All disciplines', hi: 'सभी विभाग', gu: 'બધા વિભાગ' },
  showAllDisciplines: { en: 'Show all disciplines', hi: 'सभी विभाग दिखाएँ', gu: 'બધા વિભાગ બતાવો' },
  unavailableTitle: { en: 'Drawing register unavailable.', hi: 'ड्रॉइंग रजिस्टर उपलब्ध नहीं है।', gu: 'ડ્રોઇંગ રજિસ્ટર ઉપલબ્ધ નથી.' },
  unavailableDetail: {
    en: 'Check your connection and access, then retry.',
    hi: 'अपना इंटरनेट और पहुँच देखें, फिर दोबारा कोशिश करें।',
    gu: 'તમારું ઇન્ટરનેટ અને પરવાનગી તપાસો, પછી ફરી પ્રયાસ કરો.',
  },
  none: { en: 'No drawings issued yet.', hi: 'अभी कोई ड्रॉइंग जारी नहीं हुई।', gu: 'હજી કોઈ ડ્રોઇંગ જારી થયું નથી.' },
  noAcks: {
    en: 'No one has acknowledged this revision yet.',
    hi: 'अभी किसी ने इस संशोधन की पुष्टि नहीं की।',
    gu: 'હજી કોઈએ આ સંસ્કરણની પુષ્ટિ કરી નથી.',
  },
  outstanding: { en: 'Issued to — not yet confirmed', hi: 'जिन्हें भेजा — अभी पुष्टि नहीं', gu: 'જેમને મોકલ્યું — હજી પુષ્ટિ નથી' },
  close: { en: 'Close', hi: 'बंद करें', gu: 'બંધ કરો' },
  cadNote: {
    en: 'CAD source (DWG) — not previewable in the browser. Download it, or view the issued PDF.',
    hi: 'CAD फ़ाइल (DWG) — ब्राउज़र में नहीं दिखती। डाउनलोड करें, या जारी की गई PDF देखें।',
    gu: 'CAD ફાઇલ (DWG) — બ્રાઉઝરમાં દેખાતી નથી. ડાઉનલોડ કરો, અથવા જારી કરેલી PDF જુઓ.',
  },
  noPreview: {
    en: 'This file type can’t be previewed. Download to open it.',
    hi: 'यह फ़ाइल यहाँ नहीं दिखती। खोलने के लिए डाउनलोड करें।',
    gu: 'આ ફાઇલ અહીં દેખાતી નથી. ખોલવા માટે ડાઉનલોડ કરો.',
  },
  download: { en: 'Download', hi: 'डाउनलोड', gu: 'ડાઉનલોડ' },
  history: { en: 'REVISION HISTORY', hi: 'संशोधनों का इतिहास', gu: 'સંસ્કરણોનો ઇતિહાસ' },
  location: { en: 'LOCATION', hi: 'जगह', gu: 'જગ્યા' },
  unfiled: {
    en: 'Not filed to a location (project-wide)',
    hi: 'किसी जगह पर नहीं रखी (पूरे प्रोजेक्ट के लिए)',
    gu: 'કોઈ જગ્યાએ મૂકેલું નથી (આખા પ્રોજેક્ટ માટે)',
  },
  onlyPmcFiles: {
    en: 'Only the PMC files a drawing to a location.',
    hi: 'ड्रॉइंग को जगह पर सिर्फ़ PMC रखते हैं।',
    gu: 'ડ્રોઇંગને જગ્યાએ ફક્ત PMC મૂકે છે.',
  },
  locationPaused: {
    en: 'The drawing register is still loading — location changes are paused until it refreshes.',
    hi: 'ड्रॉइंग रजिस्टर अभी लोड हो रहा है — ताज़ा होने तक जगह के बदलाव रुके हैं।',
    gu: 'ડ્રોઇંગ રજિસ્ટર હજી લોડ થાય છે — તાજું થાય ત્યાં સુધી જગ્યાના ફેરફાર અટક્યા છે.',
  },
  canMove: {
    en: 'You can move this drawing to another location.',
    hi: 'आप इस ड्रॉइंग को दूसरी जगह रख सकते हैं।',
    gu: 'તમે આ ડ્રોઇંગ બીજી જગ્યાએ મૂકી શકો છો.',
  },
  notFiled: {
    en: 'This drawing is not filed to a place yet.',
    hi: 'यह ड्रॉइंग अभी किसी जगह पर नहीं रखी गई।',
    gu: 'આ ડ્રોઇંગ હજી કોઈ જગ્યાએ મૂક્યું નથી.',
  },
  move: { en: 'Move', hi: 'जगह बदलें', gu: 'જગ્યા બદલો' },
  fileTo: { en: 'File to a location', hi: 'जगह पर रखें', gu: 'જગ્યાએ મૂકો' },
  unfile: { en: 'Unfile', hi: 'जगह से हटाएँ', gu: 'જગ્યાએથી હટાવો' },
  done: { en: 'Done', hi: 'हो गया', gu: 'થઈ ગયું' },
  newTitle: { en: 'New drawing', hi: 'नई ड्रॉइंग', gu: 'નવું ડ્રોઇંગ' },
  numberPlaceholder: { en: 'Number (A-201)', hi: 'नंबर (A-201)', gu: 'નંબર (A-201)' },
  revPlaceholder: { en: 'Rev', hi: 'संशोधन', gu: 'સંસ્કરણ' },
  titlePlaceholder: { en: 'Title', hi: 'शीर्षक', gu: 'શીર્ષક' },
  locationOptional: { en: 'LOCATION (OPTIONAL)', hi: 'जगह (वैकल्पिक)', gu: 'જગ્યા (વૈકલ્પિક)' },
  locationHint: {
    en: 'File it at its level — a floor plan on the zone, a detail on the object. Rooms below inherit it.',
    hi: 'इसे सही स्तर पर रखें — फ़्लोर प्लान ज़ोन पर, डिटेल वस्तु पर। नीचे के कमरों को यह अपने-आप मिलती है।',
    gu: 'તેને યોગ્ય સ્તરે મૂકો — ફ્લોર પ્લાન ઝોન પર, ડિટેલ વસ્તુ પર. નીચેના રૂમને તે આપમેળે મળે છે.',
  },
  cancel: { en: 'Cancel', hi: 'रद्द करें', gu: 'રદ કરો' },
  saveDraft: { en: 'Save as draft', hi: 'ड्राफ़्ट सहेजें', gu: 'ડ્રાફ્ટ સાચવો' },
  publish: { en: 'Publish', hi: 'जारी करें', gu: 'જારી કરો' },
} satisfies Record<string, Words>;

/** The discipline groups (and the issue form's choices). "MEP" stays the acronym sites use. */
export const drawingDisciplineLabels: Record<Discipline, Words> = {
  architectural: { en: 'Architectural', hi: 'आर्किटेक्चरल', gu: 'આર્કિટેક્ચરલ' },
  structural: { en: 'Structural', hi: 'स्ट्रक्चरल', gu: 'સ્ટ્રક્ચરલ' },
  mep: { en: 'MEP', hi: 'MEP', gu: 'MEP' },
  other: { en: 'Sketches & References', hi: 'स्केच और संदर्भ', gu: 'સ્કેચ અને સંદર્ભ' },
};

/** A revision's chip. `inReview` is a drawing whose only live revisions are review copies. */
export const drawingStatusLabels = {
  for_construction: { en: 'FOR CONSTRUCTION', hi: 'निर्माण के लिए', gu: 'બાંધકામ માટે' },
  for_review: { en: 'FOR REVIEW', hi: 'समीक्षा के लिए', gu: 'સમીક્ષા માટે' },
  superseded: { en: 'SUPERSEDED', hi: 'पुराना (बदला गया)', gu: 'જૂનું (બદલાયું)' },
  inReview: { en: 'IN REVIEW — NOT FOR CONSTRUCTION', hi: 'समीक्षा में — निर्माण के लिए नहीं', gu: 'સમીક્ષામાં — બાંધકામ માટે નહીં' },
} satisfies Record<string, Words>;

/** Sentences around project data (revision letters, numbers, names, dates). */
export const drawingsText = {
  rev: (rev: string, lang: Lang): string => (lang === 'hi' ? `संशोधन ${rev}` : lang === 'gu' ? `સંસ્કરણ ${rev}` : `Rev ${rev}`),
  myDiscipline: (label: string, lang: Lang): string =>
    lang === 'hi' ? `मेरा विभाग · ${label}` : lang === 'gu' ? `મારો વિભાગ · ${label}` : `My discipline · ${label}`,
  noneInScope: (label: string, lang: Lang): string =>
    lang === 'hi' ? `अभी ${label} की कोई ड्रॉइंग नहीं है।` : lang === 'gu' ? `હજી ${label} નું કોઈ ડ્રોઇંગ નથી.` : `No ${label} drawings filed yet.`,
  governs: (activityId: string, lang: Lang): string =>
    lang === 'hi' ? ` · ${activityId} पर लागू` : lang === 'gu' ? ` · ${activityId} પર લાગુ` : ` · governs ${activityId}`,
  /** only shown when there is more than one revision */
  revisions: (n: number, lang: Lang): string =>
    lang === 'hi' ? ` · ${n} संशोधन` : lang === 'gu' ? ` · ${n} સંસ્કરણ` : ` · ${n} revisions`,
  buildingTo: (rev: string, lang: Lang): string =>
    lang === 'hi' ? `संशोधन ${rev} से काम` : lang === 'gu' ? `સંસ્કરણ ${rev} પ્રમાણે કામ` : `BUILDING TO REV ${rev}`,
  youBuild: (rev: string, lang: Lang): string =>
    lang === 'hi' ? `आप संशोधन ${rev} से काम कर रहे हैं` : lang === 'gu' ? `તમે સંસ્કરણ ${rev} પ્રમાણે કામ કરો છો` : `You’re building to Rev ${rev}`,
  ackButton: (rev: string, lang: Lang): string =>
    lang === 'hi' ? `संशोधन ${rev} से काम की पुष्टि करें` : lang === 'gu' ? `સંસ્કરણ ${rev} પ્રમાણે કામની પુષ્ટિ કરો` : `I’m building to Rev ${rev}`,
  issuedLine: (rev: string, by: string, at: string, lang: Lang): string =>
    lang === 'hi'
      ? `संशोधन ${rev} · ${by} ने जारी किया · ${at}`
      : lang === 'gu'
        ? `સંસ્કરણ ${rev} · ${by} એ જારી કર્યું · ${at}`
        : `Rev ${rev} · issued by ${by} · ${at}`,
  /** the issue form's lead, split around its two bold button names */
  newIntro: (lang: Lang): [string, string, string, string, string] =>
    lang === 'hi'
      ? ['वही नंबर देने पर नया संशोधन जुड़ता है और पुराना बदल जाता है। निजी तौर पर तैयार करने के लिए ', 'ड्राफ़्ट सहेजें', ' दबाएँ, या काम करने वाली टीम को जारी करने के लिए ', 'जारी करें', ' दबाएँ।']
      : lang === 'gu'
        ? ['એ જ નંબર આપવાથી નવું સંસ્કરણ ઉમેરાય છે અને જૂનું બદલાય છે. ખાનગી રીતે તૈયાર કરવા ', 'ડ્રાફ્ટ સાચવો', ' દબાવો, અથવા કામ કરતી ટીમને જારી કરવા ', 'જારી કરો', ' દબાવો.']
        : ['A matching number adds a revision and supersedes the prior. ', 'Save as draft', ' to prepare it privately, or ', 'Publish', ' to issue it to the build team.'],
  /** the register's lead, split around its two bold phrases */
  intro: (lang: Lang): [string, string, string, string, string] =>
    lang === 'hi'
      ? ['टीम इसी ताज़ा जारी सेट से काम करती है। नया संशोधन पुराने की जगह लेता है — साइट पर हमेशा नया ', 'निर्माण के लिए', ' सेट दिखता है। आप जो ड्रॉइंग खोलते हैं, वे साइट पर ', 'ऑफ़लाइन', ' देखने के लिए सहेजी जाती हैं।']
      : lang === 'gu'
        ? ['ટીમ આ તાજા જારી સેટ પરથી કામ કરે છે. નવું સંસ્કરણ જૂનાની જગ્યા લે છે — સાઇટ પર હંમેશાં નવો ', 'બાંધકામ માટે', ' સેટ દેખાય છે. તમે ખોલો તે ડ્રોઇંગ સાઇટ પર ', 'ઓફલાઇન', ' જોવા માટે સચવાય છે.']
        : ['The current issue the team builds from. New revisions supersede the old — the field always sees the latest ', 'For Construction', ' set. Drawings you open are cached for ', 'offline', ' viewing on site.'],
};

const LOCALE: Record<Exclude<Lang, 'en'>, string> = { hi: 'hi-IN', gu: 'gu-IN' };
const MONTH = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** A served "15 Oct 2026" (the register's fixed date format) in the reader's month names. Anything that is
 *  not that format is shown as recorded. */
export function drawingDateIn(text: string, lang: Lang): string {
  if (lang === 'en') return text;
  if (text === 'just now') return lang === 'hi' ? 'अभी' : 'હમણાં'; // the demo's own stamp
  const m = /^(\d{1,2}) ([A-Z][a-z]{2}) (\d{4})$/.exec(text.trim());
  const month = m ? MONTH.indexOf(m[2]) : -1;
  if (!m || month < 0) return text;
  const at = new Date(Date.UTC(Number(m[3]), month, Number(m[1])));
  return new Intl.DateTimeFormat(LOCALE[lang], { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(at);
}

/** What the drawing actions say back. */
export const drawingToast = {
  stillLoading: {
    en: 'The drawing register is still loading — try again once it settles.',
    hi: 'ड्रॉइंग रजिस्टर अभी लोड हो रहा है — पूरा होने पर फिर कोशिश करें।',
    gu: 'ડ્રોઇંગ રજિસ્ટર હજી લોડ થાય છે — પૂરું થાય પછી ફરી પ્રયાસ કરો.',
  },
  prepareFailed: {
    en: 'Could not prepare the drawing for upload — check your connection and try again.',
    hi: 'ड्रॉइंग अपलोड के लिए तैयार नहीं हो सकी — इंटरनेट देखें और फिर कोशिश करें।',
    gu: 'ડ્રોઇંગ અપલોડ માટે તૈયાર ન થયું — ઇન્ટરનેટ તપાસો અને ફરી પ્રયાસ કરો.',
  },
  rejected: {
    en: 'The drawing was rejected — check the details and try again.',
    hi: 'ड्रॉइंग स्वीकार नहीं हुई — जानकारी जाँचें और फिर कोशिश करें।',
    gu: 'ડ્રોઇંગ સ્વીકારાયું નહીં — વિગતો તપાસો અને ફરી પ્રયાસ કરો.',
  },
  filed: { en: 'Drawing filed to location.', hi: 'ड्रॉइंग जगह पर रखी गई।', gu: 'ડ્રોઇંગ જગ્યાએ મુકાયું.' },
  unfiled: { en: 'Drawing unfiled.', hi: 'ड्रॉइंग जगह से हटाई गई।', gu: 'ડ્રોઇંગ જગ્યાએથી હટાવાયું.' },
  filedDemo: { en: 'Drawing filed to location (demo).', hi: 'ड्रॉइंग जगह पर रखी गई (डेमो)।', gu: 'ડ્રોઇંગ જગ્યાએ મુકાયું (ડેમો).' },
  unfiledDemo: { en: 'Drawing unfiled (demo).', hi: 'ड्रॉइंग जगह से हटाई गई (डेमो)।', gu: 'ડ્રોઇંગ જગ્યાએથી હટાવાયું (ડેમો).' },
  /** the queued command's name in the "saved offline" line */
  fileCommand: { en: 'File drawing', hi: 'ड्रॉइंग जगह पर रखना', gu: 'ડ્રોઇંગ જગ્યાએ મૂકવું' },
  unfileCommand: { en: 'Unfile drawing', hi: 'ड्रॉइंग जगह से हटाना', gu: 'ડ્રોઇંગ જગ્યાએથી હટાવવું' },
} satisfies Record<string, Words>;

export const drawingToastText = {
  issued: (number: string, rev: string, lang: Lang): string =>
    lang === 'hi'
      ? `ड्रॉइंग जारी हुई: ${number} संशोधन ${rev} — टीम को बताया गया।`
      : lang === 'gu'
        ? `ડ્રોઇંગ જારી થયું: ${number} સંસ્કરણ ${rev} — ટીમને જાણ કરી.`
        : `Drawing issued: ${number} Rev ${rev} — team notified.`,
  issuedDemo: (number: string, rev: string, lang: Lang): string =>
    lang === 'hi'
      ? `ड्रॉइंग जारी हुई: ${number} संशोधन ${rev} (डेमो)।`
      : lang === 'gu'
        ? `ડ્રોઇંગ જારી થયું: ${number} સંસ્કરણ ${rev} (ડેમો).`
        : `Drawing issued: ${number} Rev ${rev} (demo).`,
  draftSavedDemo: (number: string, lang: Lang): string =>
    lang === 'hi'
      ? `ड्राफ़्ट सहेजा: ${number} — जारी करने तक सिर्फ़ आपको दिखेगा (डेमो)।`
      : lang === 'gu'
        ? `ડ્રાફ્ટ સાચવ્યો: ${number} — જારી કરો ત્યાં સુધી ફક્ત તમને દેખાશે (ડેમો).`
        : `Draft saved: ${number} — visible only to you until you publish it (demo).`,
  acknowledged: (number: string, rev: string, demo: boolean, lang: Lang): string =>
    lang === 'hi'
      ? `पुष्टि हुई — ${number} संशोधन ${rev} से काम${demo ? ' (डेमो)' : ''}।`
      : lang === 'gu'
        ? `પુષ્ટિ થઈ — ${number} સંસ્કરણ ${rev} પ્રમાણે કામ${demo ? ' (ડેમો)' : ''}.`
        : `Acknowledged — building to ${number} Rev ${rev}${demo ? ' (demo)' : ''}.`,
  ackCommand: (number: string, lang: Lang): string =>
    lang === 'hi' ? `पुष्टि ${number}` : lang === 'gu' ? `પુષ્ટિ ${number}` : `Acknowledge ${number}`,
};

/** The way back to the Site Map place a record (a drawing, a decision, …) was opened from. The place name is
 *  project data; with no place it returns to the Site Map itself. */
export function returnToPlaceText(place: string | null, lang: Lang): string {
  if (lang === 'hi') return place ? `← ${place} पर वापस` : '← साइट मैप पर वापस';
  if (lang === 'gu') return place ? `← ${place} પર પાછા` : '← સાઇટ મેપ પર પાછા';
  return `← Back to ${place ?? 'the Site Map'}`;
}
