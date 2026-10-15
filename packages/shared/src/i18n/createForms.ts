/**
 * #482 QA item 3 (Codex review of #922) — the inspection and decision forms the Add menu opens, in Hindi
 * and Gujarati (English unchanged). Titles, item text, materials and member names are typed data, shown
 * as written.
 */

import type { Lang } from '../domain/types';

type Words = Record<Lang, string>;
const pick = (lang: Lang, en: string, hi: string, gu: string): string => (lang === 'hi' ? hi : lang === 'gu' ? gu : en);

/** The PMC's "Issue checklist" form. */
export const issueChecklistLabels = {
  title: { en: 'Issue checklist', hi: 'चेकलिस्ट भेजें', gu: 'ચેકલિસ્ટ મોકલો' },
  intro: {
    en: 'The site engineer fills this in the field with photos, then submits it back here for your review.',
    hi: 'साइट इंजीनियर इसे साइट पर फ़ोटो के साथ भरेगा, फिर आपकी जाँच के लिए यहीं वापस भेजेगा।',
    gu: 'સાઇટ ઇજનેર આને સાઇટ પર ફોટા સાથે ભરશે, પછી તમારી તપાસ માટે અહીં પાછું મોકલશે.',
  },
  titlePlaceholder: {
    en: 'Title (e.g. Waterproofing — 2nd coat)',
    hi: 'शीर्षक (जैसे वॉटरप्रूफ़िंग — दूसरा कोट)',
    gu: 'શીર્ષક (જેમ કે વોટરપ્રૂફિંગ — બીજો કોટ)',
  },
  items: { en: 'CHECKLIST ITEMS', hi: 'चेकलिस्ट के बिंदु', gu: 'ચેકલિસ્ટના મુદ્દા' },
  itemPlaceholder: { en: 'Item to verify on site', hi: 'साइट पर जाँचने का बिंदु', gu: 'સાઇટ પર તપાસવાનો મુદ્દો' },
  addItem: { en: '+ Add item', hi: '+ बिंदु जोड़ें', gu: '+ મુદ્દો ઉમેરો' },
  cancel: { en: 'Cancel', hi: 'रद्द करें', gu: 'રદ કરો' },
  issue: { en: 'Issue to engineer', hi: 'इंजीनियर को भेजें', gu: 'ઇજનેરને મોકલો' },
} satisfies Record<string, Words>;

export const issueChecklistText = {
  removeItem: (n: number, lang: Lang): string => pick(lang, `Remove item ${n}`, `बिंदु ${n} हटाएँ`, `મુદ્દો ${n} કાઢો`),
};

/** The PMC's "New decision" form. */
export const issueDecisionLabels = {
  title: { en: 'New decision', hi: 'नया निर्णय', gu: 'નવો નિર્ણય' },
  titlePlaceholder: {
    en: 'Title (e.g. Veneer finish, Lock & hardware)',
    hi: 'शीर्षक (जैसे विनियर फ़िनिश, ताला और हार्डवेयर)',
    gu: 'શીર્ષક (જેમ કે વિનિયર ફિનિશ, તાળું અને હાર્ડવેર)',
  },
  whoDecides: { en: 'WHO DECIDES', hi: 'कौन तय करेगा', gu: 'કોણ નક્કી કરશે' },
  whoDecidesAria: { en: 'Who decides', hi: 'कौन तय करेगा', gu: 'કોણ નક્કી કરશે' },
  deciderClient: { en: 'The client', hi: 'क्लाइंट', gu: 'ક્લાયન્ટ' },
  deciderPmc: { en: 'The practice (PMC)', hi: 'हमारी फ़र्म (PMC)', gu: 'અમારી ફર્મ (PMC)' },
  deciderMember: { en: 'A named member', hi: 'कोई चुना हुआ सदस्य', gu: 'કોઈ પસંદ કરેલ સભ્ય' },
  deciderArchitect: { en: 'The architect', hi: 'आर्किटेक्ट', gu: 'આર્કિટેક્ટ' },
  deciderNone: { en: 'Nobody — record only', hi: 'कोई नहीं — सिर्फ़ रिकॉर्ड', gu: 'કોઈ નહીં — ફક્ત રેકોર્ડ' },
  namedDeciderAria: { en: 'Named decider', hi: 'चुना हुआ निर्णयकर्ता', gu: 'પસંદ કરેલ નિર્ણયકર્તા' },
  chooseMember: { en: 'Choose a member…', hi: 'सदस्य चुनें…', gu: 'સભ્ય પસંદ કરો…' },
  recordNote: {
    en: 'A record files the issue for the team — no options, and nobody is asked to approve it.',
    hi: 'रिकॉर्ड इस मुद्दे को टीम के लिए दर्ज करता है — कोई विकल्प नहीं, और किसी से मंज़ूरी नहीं माँगी जाती।',
    gu: 'રેકોર્ડ આ મુદ્દાને ટીમ માટે નોંધે છે — કોઈ વિકલ્પ નહીં, અને કોઈની મંજૂરી માગવામાં આવતી નથી.',
  },
  materialPlaceholder: { en: 'Material (e.g. Italian Marble)', hi: 'सामान (जैसे इटालियन मार्बल)', gu: 'માલસામાન (જેમ કે ઇટાલિયન માર્બલ)' },
  deltaPlaceholder: { en: '₹ delta (0 = base)', hi: '₹ फ़र्क (0 = मूल)', gu: '₹ ફરક (0 = મૂળ)' },
  swatchAria: { en: 'Swatch', hi: 'रंग-नमूना', gu: 'રંગ-નમૂનો' },
  changePhoto: { en: 'Change photo', hi: 'फ़ोटो बदलें', gu: 'ફોટો બદલો' },
  addPhoto: { en: 'Add sample photo', hi: 'नमूने की फ़ोटो जोड़ें', gu: 'નમૂનાનો ફોટો ઉમેરો' },
  recommended: { en: 'Recommended', hi: 'सुझाया गया', gu: 'ભલામણ કરેલ' },
  priceDelta: { en: 'Price delta', hi: 'क़ीमत का फ़र्क', gu: 'કિંમતનો ફરક' },
  addOption: { en: '+ Add another option', hi: '+ एक और विकल्प जोड़ें', gu: '+ બીજો વિકલ્પ ઉમેરો' },
  cancel: { en: 'Cancel', hi: 'रद्द करें', gu: 'રદ કરો' },
  saveDraft: { en: 'Save as draft', hi: 'ड्राफ़्ट के रूप में रखें', gu: 'ડ્રાફ્ટ તરીકે રાખો' },
  publishRecord: { en: 'Publish record', hi: 'रिकॉर्ड प्रकाशित करें', gu: 'રેકોર્ડ પ્રકાશિત કરો' },
  publishClient: { en: 'Publish to client', hi: 'क्लाइंट को भेजें', gu: 'ક્લાયન્ટને મોકલો' },
  publishDecider: { en: 'Publish to decider', hi: 'निर्णयकर्ता को भेजें', gu: 'નિર્ણયકર્તાને મોકલો' },
} satisfies Record<string, Words>;

export const issueDecisionText = {
  /** The intro, split so the three named controls stay bold: [before, MoreDetails, between, Save as draft, between, Publish, after]. */
  intro: (lang: Lang): [string, string, string, string, string, string, string] =>
    lang === 'hi'
      ? ['क्या तय होना है, और किन विकल्पों में से। क़ीमत का फ़र्क, रंग-नमूना और नमूने की फ़ोटो हर विकल्प के ', 'और जानकारी', ' में हैं। निजी तौर पर काम जारी रखने के लिए ', 'ड्राफ़्ट के रूप में रखें', ', या क्लाइंट को चुनने के लिए भेजने को ', 'प्रकाशित करें', ' दबाएँ।']
      : lang === 'gu'
        ? ['શું નક્કી કરવાનું છે, અને કયા વિકલ્પોમાંથી. કિંમતનો ફરક, રંગ-નમૂનો અને નમૂનાનો ફોટો દરેક વિકલ્પની ', 'વધુ વિગતો', ' માં છે. ખાનગી રીતે કામ ચાલુ રાખવા ', 'ડ્રાફ્ટ તરીકે રાખો', ', અથવા ક્લાયન્ટને પસંદ કરવા મોકલવા ', 'પ્રકાશિત કરો', ' દબાવો.']
        : ["What is being decided, and between which options. A price delta, a swatch and a sample photo sit under each option's ", 'More details', '. ', 'Save as draft', ' to keep working privately, or ', 'Publish', ' to send it to the client to choose.'],
  option: (i: number, lang: Lang): string => {
    const letter = String.fromCharCode(65 + i);
    return pick(lang, `OPTION ${letter}`, `विकल्प ${letter}`, `વિકલ્પ ${letter}`);
  },
  removeOption: (n: number, lang: Lang): string => pick(lang, `Remove option ${n}`, `विकल्प ${n} हटाएँ`, `વિકલ્પ ${n} કાઢો`),
  deltaAria: (n: number, lang: Lang): string =>
    pick(lang, `Option ${n} price delta (₹)`, `विकल्प ${n} की क़ीमत का फ़र्क (₹)`, `વિકલ્પ ${n} ની કિંમતનો ફરક (₹)`),
};
