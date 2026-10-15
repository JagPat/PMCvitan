/**
 * #482 QA item 3 — the Site Map in Hindi and Gujarati (English unchanged). Place names, record ids and titles,
 * phase and activity names, material names and quantities, and blocker notes are project data, shown as recorded.
 */

import type { DecisionStatus, Lang, NodeKind } from '../domain/types';
import { placeKindLabels } from './dictionary';

type Words = Record<Lang, string>;
const pick = (lang: Lang, en: string, hi: string, gu: string): string => (lang === 'hi' ? hi : lang === 'gu' ? gu : en);

export const siteMapLabels = {
  eyebrow: { en: 'SITE MAP · BY LOCATION', hi: 'जगहें · जगह के हिसाब से', gu: 'સ્થળો · જગ્યા પ્રમાણે' },
  intro: {
    en: 'Walk the building by zone, room and object. Each place shows its decisions, the drawings that govern it, and photos of what\'s actually built — intent and reality on one coordinate.',
    hi: 'इमारत को ज़ोन, कमरे और चीज़ के हिसाब से देखें। हर जगह पर उसके निर्णय, उस पर लागू ड्रॉइंग और असल में बने काम की फ़ोटो दिखती हैं — जो सोचा और जो बना, एक ही जगह पर।',
    gu: 'ઇમારતને ઝોન, રૂમ અને વસ્તુ પ્રમાણે જુઓ. દરેક જગ્યાએ તેના નિર્ણયો, તેના પર લાગુ ડ્રોઇંગ અને ખરેખર બનેલા કામના ફોટા દેખાય છે — જે વિચાર્યું અને જે બન્યું, એક જ જગ્યાએ.',
  },
  noLocations: { en: 'No locations yet', hi: 'अभी कोई जगह नहीं', gu: 'હજી કોઈ જગ્યા નથી' },
  noLocationsManage: {
    en: 'Start with a zone — a floor, a wing or the site itself — then add its rooms and objects here.',
    hi: 'एक ज़ोन से शुरू करें — कोई मंज़िल, कोई हिस्सा या पूरी साइट — फिर यहीं उसके कमरे और चीज़ें जोड़ें।',
    gu: 'એક ઝોનથી શરૂ કરો — કોઈ માળ, કોઈ ભાગ કે આખી સાઇટ — પછી અહીં જ તેના રૂમ અને વસ્તુઓ ઉમેરો.',
  },
  noLocationsView: {
    en: 'Your PMC sets up the zones, rooms and objects. Decisions, drawings and photos are then filed to them.',
    hi: 'आपके PMC ज़ोन, कमरे और चीज़ें बनाते हैं। फिर निर्णय, ड्रॉइंग और फ़ोटो उनमें रखे जाते हैं।',
    gu: 'તમારા PMC ઝોન, રૂમ અને વસ્તુઓ બનાવે છે. પછી નિર્ણયો, ડ્રોઇંગ અને ફોટા તેમાં મુકાય છે.',
  },
  addHere: { en: 'Add here', hi: 'यहाँ जोड़ें', gu: 'અહીં ઉમેરો' },
  placesInside: { en: 'Places inside', hi: 'अंदर की जगहें', gu: 'અંદરની જગ્યાઓ' },
  statusUnavailable: {
    en: 'Status unavailable — the activities could not be loaded',
    hi: 'स्थिति नहीं दिख सकती — काम लोड नहीं हो सके',
    gu: 'સ્થિતિ દેખાતી નથી — કામ લોડ ન થઈ શક્યાં',
  },
  statusLoading: { en: 'Loading status…', hi: 'स्थिति लोड हो रही है…', gu: 'સ્થિતિ લોડ થઈ રહી છે…' },
  wholeProject: { en: 'Whole project', hi: 'पूरा प्रोजेक्ट', gu: 'આખો પ્રોજેક્ટ' },
  places: { en: 'Places', hi: 'जगहें', gu: 'જગ્યાઓ' },
  legendTitle: { en: 'Colours mean', hi: 'रंगों का मतलब', gu: 'રંગોનો અર્થ' },
  workRecords: { en: 'Work and records here', hi: 'यहाँ का काम और रिकॉर्ड', gu: 'અહીંનું કામ અને રેકોર્ડ' },
  acrossProject: { en: 'Across the whole project', hi: 'पूरे प्रोजेक्ट में', gu: 'આખા પ્રોજેક્ટમાં' },
  locked: { en: 'Locked after approval.', hi: 'मंज़ूरी के बाद लॉक।', gu: 'મંજૂરી પછી લૉક.' },
  lockedRequest: {
    en: 'Locked after approval. Open it to request a change.',
    hi: 'मंज़ूरी के बाद लॉक। बदलाव माँगने के लिए इसे खोलें।',
    gu: 'મંજૂરી પછી લૉક. ફેરફાર માગવા તેને ખોલો.',
  },
  activitiesUnavailable: {
    en: 'The activities could not be loaded — open Schedule to retry.',
    hi: 'काम लोड नहीं हो सके — फिर कोशिश करने के लिए शेड्यूल खोलें।',
    gu: 'કામ લોડ ન થઈ શક્યાં — ફરી પ્રયાસ કરવા શેડ્યૂલ ખોલો.',
  },
  activitiesLoading: { en: 'Loading the activities…', hi: 'काम लोड हो रहे हैं…', gu: 'કામ લોડ થઈ રહ્યાં છે…' },
  unphased: { en: 'Unphased', hi: 'बिना चरण', gu: 'તબક્કા વગર' },
  plan: { en: 'Plan', hi: 'योजना', gu: 'યોજના' },
  viewInSchedule: { en: 'View in schedule', hi: 'शेड्यूल में देखें', gu: 'શેડ્યૂલમાં જુઓ' },
  mismatch: { en: 'Mismatch', hi: 'मेल नहीं', gu: 'મેળ નથી' },
  rev: { en: 'Rev', hi: 'संशोधन', gu: 'સંશોધન' },
  noPhotos: { en: 'No photos filed here yet.', hi: 'यहाँ अभी कोई फ़ोटो नहीं रखी गई।', gu: 'અહીં હજી કોઈ ફોટો મુકાયો નથી.' },
  intentReality: { en: 'Intent vs Reality', hi: 'सोचा बनाम बना', gu: 'વિચાર્યું સામે બન્યું' },
  drawnVsBuilt: { en: 'drawn vs built', hi: 'ड्रॉइंग बनाम बना काम', gu: 'ડ્રોઇંગ સામે બનેલું' },
  intentDrawn: { en: 'INTENT · DRAWN', hi: 'सोचा · ड्रॉइंग', gu: 'વિચાર્યું · ડ્રોઇંગ' },
  realityBuilt: { en: 'REALITY · BUILT', hi: 'असल · बना', gu: 'ખરેખર · બન્યું' },
  versus: { en: 'VS', hi: 'बनाम', gu: 'સામે' },
  noRevision: { en: 'No current revision', hi: 'अभी कोई संशोधन नहीं', gu: 'હાલ કોઈ સંશોધન નથી' },
  latestPhoto: { en: 'Open the latest site photo', hi: 'साइट की सबसे नई फ़ोटो खोलें', gu: 'સાઇટનો સૌથી નવો ફોટો ખોલો' },
  noPhotoYet: { en: 'No site photo yet', hi: 'अभी साइट की कोई फ़ोटो नहीं', gu: 'હજી સાઇટનો કોઈ ફોટો નથી' },
  latest: { en: 'Latest', hi: 'सबसे नई', gu: 'સૌથી નવો' },
} satisfies Record<string, Words>;

/** One "Work and records here" section: its title, the line beside it, and the line when it is empty. */
export const placeSectionLabels = {
  inspections: {
    title: { en: 'Inspections', hi: 'निरीक्षण', gu: 'નિરીક્ષણ' },
    sub: { en: 'quality checks here', hi: 'यहाँ की गुणवत्ता जाँच', gu: 'અહીંની ગુણવત્તા તપાસ' },
    empty: { en: 'No inspections here yet.', hi: 'यहाँ अभी कोई निरीक्षण नहीं।', gu: 'અહીં હજી કોઈ નિરીક્ષણ નથી.' },
  },
  decisions: {
    title: { en: 'Decisions', hi: 'निर्णय', gu: 'નિર્ણયો' },
    sub: { en: 'choices recorded here', hi: 'यहाँ दर्ज चुनाव', gu: 'અહીં નોંધાયેલી પસંદગીઓ' },
    empty: { en: 'No decisions recorded here yet.', hi: 'यहाँ अभी कोई निर्णय दर्ज नहीं।', gu: 'અહીં હજી કોઈ નિર્ણય નોંધાયો નથી.' },
  },
  work: {
    title: { en: 'Work', hi: 'काम', gu: 'કામ' },
    sub: { en: 'site activities here', hi: 'यहाँ साइट के काम', gu: 'અહીં સાઇટનાં કામ' },
    empty: { en: 'No activities planned here yet.', hi: 'यहाँ अभी कोई काम तय नहीं।', gu: 'અહીં હજી કોઈ કામ નક્કી નથી.' },
  },
  drawings: {
    title: { en: 'Drawings', hi: 'ड्रॉइंग', gu: 'ડ્રોઇંગ' },
    sub: { en: 'what governs this place', hi: 'इस जगह पर क्या लागू है', gu: 'આ જગ્યાએ શું લાગુ છે' },
    empty: { en: 'No drawings apply here yet.', hi: 'यहाँ अभी कोई ड्रॉइंग लागू नहीं।', gu: 'અહીં હજી કોઈ ડ્રોઇંગ લાગુ નથી.' },
  },
  materials: {
    title: { en: 'Materials', hi: 'सामान', gu: 'માલસામાન' },
    sub: { en: 'delivered to this place', hi: 'इस जगह पर पहुँचा', gu: 'આ જગ્યાએ પહોંચેલો' },
    empty: { en: 'No materials delivered here yet.', hi: 'यहाँ अभी कोई सामान नहीं पहुँचा।', gu: 'અહીં હજી કોઈ માલસામાન પહોંચ્યો નથી.' },
  },
  photos: {
    title: { en: 'Reality', hi: 'असल', gu: 'ખરેખર' },
    sub: { en: "photos of what's built", hi: 'जो बना उसकी फ़ोटो', gu: 'જે બન્યું તેના ફોટા' },
    empty: { en: 'No photos filed here yet.', hi: 'यहाँ अभी कोई फ़ोटो नहीं रखी गई।', gu: 'અહીં હજી કોઈ ફોટો મુકાયો નથી.' },
  },
} satisfies Record<string, Record<'title' | 'sub' | 'empty', Words>>;

/** A place card's kind, in capitals in English as before. */
export function placeKindTag(kind: string, lang: Lang): string {
  const words = (placeKindLabels as Record<string, Words>)[kind];
  if (!words) return kind.toUpperCase();
  return lang === 'en' ? words.en.toUpperCase() : words[lang];
}

/** How a drawing applies to the place: filed here, inherited from a place above, or a detail below. */
export const drawingRelationLabels = {
  here: { en: 'Here', hi: 'यहाँ', gu: 'અહીં' },
  inherited: { en: 'Inherited', hi: 'ऊपर से', gu: 'ઉપરથી' },
  detail: { en: 'Detail', hi: 'विवरण', gu: 'વિગત' },
} satisfies Record<string, Words>;

/** A placed inspection's status. */
export const placeInspectionStatusLabels = {
  open: { en: 'Open', hi: 'खुला', gu: 'ખુલ્લું' },
  inReview: { en: 'In review', hi: 'जाँच में', gu: 'તપાસમાં' },
  failed: { en: 'Failed', hi: 'फ़ेल', gu: 'નાપાસ' },
  passed: { en: 'Passed', hi: 'पास', gu: 'પાસ' },
} satisfies Record<string, Words>;

/** Where a space stands, from its work. */
export const spaceStatusLabels = {
  'not-started': { en: 'Not started', hi: 'शुरू नहीं', gu: 'શરૂ નથી' },
  'in-progress': { en: 'Under way', hi: 'चल रहा', gu: 'ચાલુ' },
  blocked: { en: 'Blocked', hi: 'रुका', gu: 'અટકેલું' },
  done: { en: 'Done', hi: 'पूरा', gu: 'પૂરું' },
} satisfies Record<string, Words>;

/** The decision status chip. English keeps the chip's capitals. */
export const decisionStatusChipLabels: Record<DecisionStatus, Words> = {
  pending: { en: 'PENDING', hi: 'बाकी', gu: 'બાકી' },
  approved: { en: 'APPROVED & LOCKED', hi: 'मंज़ूर और लॉक', gu: 'મંજૂર અને લૉક' },
  change: { en: 'CHANGE REQUESTED', hi: 'बदलाव माँगा', gu: 'ફેરફાર માગ્યો' },
  withdrawn: { en: 'WITHDRAWN', hi: 'वापस लिया', gu: 'પાછો ખેંચ્યો' },
  recorded: { en: 'RECORDED', hi: 'दर्ज', gu: 'નોંધાયેલો' },
  awaiting_countersign: { en: 'AWAITING COUNTERSIGN', hi: 'प्रति-हस्ताक्षर बाकी', gu: 'પ્રતિ-સહી બાકી' },
};

/** "What the status colours mean" key on the Site Map. */
export const siteMapLegendLabels = {
  done: { en: 'Done, passed, or approved and locked', hi: 'पूरा, पास, या मंज़ूर और लॉक', gu: 'પૂરું, પાસ, અથવા મંજૂર અને લૉક' },
  'under-way': {
    en: 'Under way, or waiting on a decision or review',
    hi: 'चल रहा, या किसी निर्णय या जाँच की राह में',
    gu: 'ચાલુ, અથવા કોઈ નિર્ણય કે તપાસની રાહમાં',
  },
  'with-reviewer': {
    en: 'Change requested, or waiting for sign-off',
    hi: 'बदलाव माँगा गया, या मंज़ूरी की राह में',
    gu: 'ફેરફાર માગ્યો, અથવા મંજૂરીની રાહમાં',
  },
  attention: { en: 'Blocked, failed or an open issue', hi: 'रुका, फ़ेल या कोई खुली समस्या', gu: 'અટકેલું, નાપાસ કે કોઈ ખુલ્લી સમસ્યા' },
  neutral: {
    en: 'Not started, withdrawn or only recorded',
    hi: 'शुरू नहीं, वापस लिया या सिर्फ़ दर्ज',
    gu: 'શરૂ નથી, પાછું ખેંચ્યું કે ફક્ત નોંધાયેલું',
  },
} satisfies Record<string, Words>;

export type PlaceCountKey = 'openIssues' | 'decisions' | 'drawings' | 'photos' | 'activities' | 'materials' | 'inspections';

/** [one, many] for each count noun. */
const COUNT_NOUNS: Record<PlaceCountKey, Record<Lang, [string, string]>> = {
  openIssues: { en: ['open issue', 'open issues'], hi: ['खुली समस्या', 'खुली समस्याएँ'], gu: ['ખુલ્લી સમસ્યા', 'ખુલ્લી સમસ્યાઓ'] },
  inspections: { en: ['inspection', 'inspections'], hi: ['निरीक्षण', 'निरीक्षण'], gu: ['નિરીક્ષણ', 'નિરીક્ષણો'] },
  decisions: { en: ['decision', 'decisions'], hi: ['निर्णय', 'निर्णय'], gu: ['નિર્ણય', 'નિર્ણયો'] },
  drawings: { en: ['drawing', 'drawings'], hi: ['ड्रॉइंग', 'ड्रॉइंग'], gu: ['ડ્રોઇંગ', 'ડ્રોઇંગ'] },
  photos: { en: ['photo', 'photos'], hi: ['फ़ोटो', 'फ़ोटो'], gu: ['ફોટો', 'ફોટા'] },
  activities: { en: ['activity', 'activities'], hi: ['काम', 'काम'], gu: ['કામ', 'કામ'] },
  materials: { en: ['material', 'materials'], hi: ['सामान', 'सामान'], gu: ['માલસામાન', 'માલસામાન'] },
};

export const siteMapText = {
  /** "3 drawings", "1 open issue"; `recent` for a photo count read from the newest photos only */
  count: (key: PlaceCountKey, n: number, lang: Lang, recent = false): string => {
    const noun = COUNT_NOUNS[key][lang][n === 1 ? 0 : 1];
    if (!recent) return `${n} ${noun}`;
    return pick(lang, `${n} recent ${noun}`, `${n} हाल की ${noun}`, n === 1 ? `${n} તાજેતરનો ${noun}` : `${n} તાજેતરના ${noun}`);
  },
  doneOf: (done: number, total: number, lang: Lang): string => pick(lang, `${done}/${total} done`, `${done}/${total} पूरे`, `${done}/${total} પૂરાં`),
  blocked: (n: number, lang: Lang): string => pick(lang, `${n} blocked`, `${n} रुके`, `${n} અટકેલાં`),
  openInspection: (id: string, lang: Lang): string => pick(lang, `Open inspection ${id}`, `निरीक्षण ${id} खोलें`, `નિરીક્ષણ ${id} ખોલો`),
  openDecision: (id: string, lang: Lang): string => pick(lang, `Open decision ${id}`, `निर्णय ${id} खोलें`, `નિર્ણય ${id} ખોલો`),
  viewInScheduleAria: (name: string, lang: Lang): string =>
    pick(lang, `View ${name} in the schedule`, `${name} शेड्यूल में देखें`, `${name} શેડ્યૂલમાં જુઓ`),
  openPhoto: (i: number, n: number, lang: Lang): string =>
    pick(lang, `Open site photo ${i} of ${n}`, `साइट फ़ोटो ${i} / ${n} खोलें`, `સાઇટ ફોટો ${i} / ${n} ખોલો`),
  openEarlierPhoto: (i: number, lang: Lang): string =>
    pick(lang, `Open earlier site photo ${i}`, `साइट की पिछली फ़ोटो ${i} खोलें`, `સાઇટનો પાછલો ફોટો ${i} ખોલો`),
  photosCappedSub: (limit: number, lang: Lang): string =>
    pick(lang, `among the latest ${limit} photos on record`, `दर्ज सबसे नई ${limit} फ़ोटो में से`, `નોંધાયેલા સૌથી નવા ${limit} ફોટામાંથી`),
  photosCappedEmpty: (limit: number, lang: Lang): string =>
    pick(
      lang,
      `No photos filed here among the latest ${limit} on record.`,
      `दर्ज सबसे नई ${limit} फ़ोटो में से कोई यहाँ नहीं रखी गई।`,
      `નોંધાયેલા સૌથી નવા ${limit} ફોટામાંથી કોઈ અહીં મુકાયો નથી.`,
    ),
  at: (place: string, inside: boolean, lang: Lang): string =>
    inside
      ? pick(lang, `At ${place} and the places inside it`, `${place} और उसके अंदर की जगहों पर`, `${place} અને તેની અંદરની જગ્યાઓએ`)
      : pick(lang, `At ${place}`, `${place} पर`, `${place} પર`),
  buildingTo: (rev: string, n: number, lang: Lang): string =>
    pick(lang, `Building to Rev ${rev} · ${n} acknowledged`, `संशोधन ${rev} के हिसाब से बन रहा · ${n} ने माना`, `સંશોધન ${rev} પ્રમાણે બને છે · ${n}એ સ્વીકાર્યું`),
  notAcknowledged: (rev: string, lang: Lang): string =>
    pick(lang, `Rev ${rev} · not yet acknowledged`, `संशोधन ${rev} · अभी किसी ने नहीं माना`, `સંશોધન ${rev} · હજી કોઈએ સ્વીકાર્યું નથી`),
};

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** A photo's recorded "03 Jul 2026 · 9:12 AM" (the capture stamp's fixed shape) in the reader's month names
 *  and a 24-hour clock; anything else is shown as recorded. */
export function photoTakenAtIn(text: string, lang: Lang): string {
  if (lang === 'en') return text;
  const m = /^(\d{1,2}) ([A-Z][a-z]{2}) (\d{4}) · (\d{1,2}):(\d{2}) ([AP])M$/.exec(text.trim());
  const month = m ? MONTHS.indexOf(m[2]) : -1;
  if (!m || month < 0) return text;
  const day = new Intl.DateTimeFormat(lang === 'hi' ? 'hi-IN' : 'gu-IN', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' })
    .format(new Date(Date.UTC(Number(m[3]), month, Number(m[1]))));
  const hour = (Number(m[4]) % 12) + (m[6] === 'P' ? 12 : 0);
  return `${day} · ${String(hour).padStart(2, '0')}:${m[5]}`;
}

/** The PMC's place editor on the Site Map. */
export const placeStructureLabels = {
  rename: { en: 'Rename', hi: 'नाम बदलें', gu: 'નામ બદલો' },
  delete: { en: 'Delete', hi: 'हटाएँ', gu: 'કાઢી નાખો' },
  allLocations: { en: 'All locations', hi: 'सभी जगहें', gu: 'બધી જગ્યાઓ' },
  save: { en: 'Save', hi: 'सेव करें', gu: 'સેવ કરો' },
  adding: { en: 'Adding…', hi: 'जोड़ रहे हैं…', gu: 'ઉમેરી રહ્યાં છીએ…' },
  add: { en: 'Add', hi: 'जोड़ें', gu: 'ઉમેરો' },
  cancel: { en: 'Cancel', hi: 'रद्द करें', gu: 'રદ કરો' },
  theProject: { en: 'the project', hi: 'प्रोजेक्ट', gu: 'પ્રોજેક્ટ' },
  TheProject: { en: 'The project', hi: 'प्रोजेक्ट', gu: 'પ્રોજેક્ટ' },
} satisfies Record<string, Words>;

/** Example names in the new-place field. */
export const placeNameExamples: Record<NodeKind, Words> = {
  zone: { en: 'e.g. Ground Floor', hi: 'जैसे ग्राउंड फ़्लोर', gu: 'જેમ કે ગ્રાઉન્ડ ફ્લોર' },
  room: { en: 'e.g. Kitchen', hi: 'जैसे रसोई', gu: 'જેમ કે રસોડું' },
  element: { en: 'e.g. Main Door', hi: 'जैसे मुख्य दरवाज़ा', gu: 'જેમ કે મુખ્ય દરવાજો' },
};

export const placeStructureText = {
  renameAria: (name: string, lang: Lang): string => pick(lang, `Rename ${name}`, `${name} का नाम बदलें`, `${name}નું નામ બદલો`),
  deleteAria: (name: string, lang: Lang): string => pick(lang, `Delete ${name}`, `${name} हटाएँ`, `${name} કાઢી નાખો`),
  newIn: (kind: NodeKind, place: string, lang: Lang): string => {
    if (lang === 'en') return `New ${{ zone: 'zone', room: 'room', element: 'object' }[kind]} in ${place}`;
    const k = placeKindLabels[kind][lang];
    return lang === 'hi' ? `${place} में नया ${k}` : `${place}માં નવો ${k}`;
  },
  duplicate: (place: string, name: string, lang: Lang): string =>
    pick(lang, `${place} already has “${name}”.`, `${place} में “${name}” पहले से है।`, `${place}માં “${name}” પહેલેથી છે.`),
  deleteTitle: (name: string, lang: Lang): string => pick(lang, `Delete ${name}?`, `${name} हटाएँ?`, `${name} કાઢી નાખવું?`),
};

/** What deleting a place does, said before it runs (the server's rule, never a count it cannot vouch for). */
export const locationDeleteText = {
  describe: (kind: NodeKind, lang: Lang): string => {
    if (lang === 'en') {
      const kept = 'Activities, drawings, inspections, material deliveries and photos filed';
      return kind === 'element'
        ? `${kept} here are kept, but no longer filed to a location. If a decision is filed here, the server refuses and says why.`
        : `Every room and object inside it is deleted too, including private drafts other people are preparing. ${kept} here or inside it are kept, but no longer filed to a location. If a decision is filed anywhere inside it, the server refuses and says why.`;
    }
    if (lang === 'hi') {
      return kind === 'element'
        ? 'यहाँ रखे काम, ड्रॉइंग, निरीक्षण, सामान की डिलीवरी और फ़ोटो बने रहते हैं, पर किसी जगह में नहीं रहते। अगर यहाँ कोई निर्णय रखा है, तो सर्वर मना कर देता है और कारण बताता है।'
        : 'इसके अंदर का हर कमरा और चीज़ भी हट जाती है, दूसरों के निजी ड्राफ़्ट भी। यहाँ या इसके अंदर रखे काम, ड्रॉइंग, निरीक्षण, सामान की डिलीवरी और फ़ोटो बने रहते हैं, पर किसी जगह में नहीं रहते। अगर इसके अंदर कहीं भी कोई निर्णय रखा है, तो सर्वर मना कर देता है और कारण बताता है।';
    }
    return kind === 'element'
      ? 'અહીં મુકેલાં કામ, ડ્રોઇંગ, નિરીક્ષણ, માલસામાનની ડિલિવરી અને ફોટા રહે છે, પણ કોઈ જગ્યામાં નથી રહેતાં. જો અહીં કોઈ નિર્ણય મુકેલો હોય, તો સર્વર ના પાડે છે અને કારણ કહે છે.'
      : 'તેની અંદરનો દરેક રૂમ અને વસ્તુ પણ કાઢી નખાય છે, બીજાના ખાનગી ડ્રાફ્ટ પણ. અહીં કે તેની અંદર મુકેલાં કામ, ડ્રોઇંગ, નિરીક્ષણ, માલસામાનની ડિલિવરી અને ફોટા રહે છે, પણ કોઈ જગ્યામાં નથી રહેતાં. જો તેની અંદર ક્યાંય કોઈ નિર્ણય મુકેલો હોય, તો સર્વર ના પાડે છે અને કારણ કહે છે.';
  },
  blocked: (n: number, lang: Lang): string => {
    const one = n === 1;
    return pick(
      lang,
      `${n} ${one ? 'decision is' : 'decisions are'} filed here. Move or remove ${one ? 'it' : 'them'} in the Decision Log first.`,
      `यहाँ ${n} निर्णय रखे हैं। पहले निर्णय स्क्रीन में ${one ? 'उसे' : 'उन्हें'} हटाएँ या कहीं और रखें।`,
      `અહીં ${n} ${one ? 'નિર્ણય મુકેલો છે' : 'નિર્ણયો મુકેલા છે'}. પહેલાં નિર્ણયો સ્ક્રીનમાં ${one ? 'તેને' : 'તેમને'} હટાવો કે બીજે મૂકો.`,
    );
  },
  unsettled: {
    en: "The decisions filed here haven't finished loading, so this delete can't be checked yet. Try again in a moment.",
    hi: 'यहाँ रखे निर्णय अभी लोड हो रहे हैं, इसलिए यह हटाना अभी जाँचा नहीं जा सकता। थोड़ी देर में फिर कोशिश करें।',
    gu: 'અહીં મુકેલા નિર્ણયો હજી લોડ થઈ રહ્યા છે, તેથી આ કાઢવાનું હજી તપાસી શકાતું નથી. થોડી વારમાં ફરી પ્રયાસ કરો.',
  } satisfies Words,
};

/** The Add menu's options and why one cannot be picked yet. */
export const createOptionLabels = {
  inspection: {
    label: { en: 'Check something here', hi: 'यहाँ कुछ जाँचें', gu: 'અહીં કંઈક તપાસો' },
    detail: { en: 'Issue a checklist for the site engineer to fill in', hi: 'साइट इंजीनियर के भरने के लिए चेकलिस्ट भेजें', gu: 'સાઇટ એન્જિનિયર ભરે તે માટે ચેકલિસ્ટ મોકલો' },
  },
  material: {
    label: { en: 'Material delivered here', hi: 'यहाँ सामान पहुँचा', gu: 'અહીં માલસામાન પહોંચ્યો' },
    detail: { en: 'Record what arrived and how much', hi: 'क्या और कितना आया, दर्ज करें', gu: 'શું અને કેટલું આવ્યું તે નોંધો' },
  },
  decision: {
    label: { en: 'Something to decide here', hi: 'यहाँ कुछ तय करना है', gu: 'અહીં કંઈક નક્કી કરવાનું છે' },
    detail: { en: 'Put options to the client to choose between', hi: 'क्लाइंट के चुनने के लिए विकल्प रखें', gu: 'ક્લાયન્ટ પસંદ કરે તે માટે વિકલ્પો મૂકો' },
  },
} satisfies Record<string, Record<'label' | 'detail', Words>>;

export const materialBlockedLabels = {
  logFailed: {
    en: 'Today’s log could not be loaded, so a delivery cannot be recorded yet — open the Daily Log and retry.',
    hi: 'आज का लॉग लोड नहीं हो सका, इसलिए अभी डिलीवरी दर्ज नहीं हो सकती — रोज़ का लॉग खोलकर फिर कोशिश करें।',
    gu: 'આજનો લોગ લોડ ન થયો, તેથી હજી ડિલિવરી નોંધી શકાતી નથી — રોજનો લોગ ખોલીને ફરી પ્રયાસ કરો.',
  },
  noLog: {
    en: 'Start today’s site log first — a delivery is recorded onto it.',
    hi: 'पहले आज का साइट लॉग शुरू करें — डिलीवरी उसी में दर्ज होती है।',
    gu: 'પહેલાં આજનો સાઇટ લોગ શરૂ કરો — ડિલિવરી તેમાં જ નોંધાય છે.',
  },
  submitted: {
    en: 'Today’s log is already submitted — start a new day to record a delivery.',
    hi: 'आज का लॉग भेजा जा चुका है — डिलीवरी दर्ज करने के लिए नया दिन शुरू करें।',
    gu: 'આજનો લોગ મોકલાઈ ગયો છે — ડિલિવરી નોંધવા નવો દિવસ શરૂ કરો.',
  },
} satisfies Record<string, Words>;

/** The Add menu's heading from the header button. */
export const createMenuLabels = {
  add: { en: 'Add', hi: 'जोड़ें', gu: 'ઉમેરો' },
  againstProject: { en: 'Recorded against this project', hi: 'इस प्रोजेक्ट में दर्ज होगा', gu: 'આ પ્રોજેક્ટમાં નોંધાશે' },
} satisfies Record<string, Words>;

/** What renaming or deleting a place says back. */
export const placeToastText = {
  renamed: (name: string, lang: Lang): string => pick(lang, `Renamed to ${name}.`, `नया नाम: ${name}।`, `નવું નામ: ${name}.`),
  removed: { en: 'Location removed.', hi: 'जगह हटाई गई।', gu: 'જગ્યા કાઢી નાખી.' } satisfies Words,
  deleteRefused: (why: string, lang: Lang): string =>
    pick(lang, `Couldn't delete this location — ${why}`, `यह जगह हटाई नहीं जा सकी — ${why}`, `આ જગ્યા કાઢી શકાઈ નહીં — ${why}`),
};
