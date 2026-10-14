import type { Lang, Role } from '../domain/types';

/**
 * #827 (Top 10 #5, "Also waiting" cards) — the For You cards in the viewer's language.
 *
 * `selectActionItems` (web) builds each card's English title, detail and button from live state. Beside them it
 * now records the card's FACTS (how many, which date, which kind of decider): the Hindi and Gujarati text is built
 * from those facts here, never read back out of the English. Names, titles and reasons the card quotes are data and
 * are shown as written. English is the builder's own text, unchanged.
 */

type Words = Record<Lang, string>;
type NonEn = Exclude<Lang, 'en'>;

/** What a card says beyond its key. Every field is optional; each key reads only its own. */
export interface ActionItemFacts {
  /** how many things the title counts */
  n?: number;
  /** pmc-pending: who the decisions wait on */
  who?: 'client' | 'decider';
  /** eng-log: the engineer has checked in */
  checkedIn?: boolean;
  /** eng-checklist: the checklist's title, its item count and zone (data) */
  title?: string;
  items?: number;
  zone?: string;
  /** pmc-reinspections: the names the detail lists (data) and the next civil due day (YYYY-MM-DD) */
  names?: string;
  due?: string;
  /** pmc-override-expiry: when the first override lapses (ISO instant), its activity (data), how many lapse */
  expiresAt?: string;
  activity?: string;
  expiring?: number;
  /** material-shortage / labour-shortage: how many are blocked and at risk */
  blocked?: number;
  atRisk?: number;
  /** commercial-over-budget: the worst head (data) and by how much (data) */
  head?: string;
  over?: string;
  /** cons-review: the discipline's drawing bucket */
  bucket?: 'architectural' | 'structural' | 'mep' | 'other';
}

export interface ActionItemWords {
  title: string;
  detail?: string;
  cta: string;
}

const CTA: Record<string, Words> = {
  'client-pending': { en: 'Review & approve', hi: 'देखें और मंज़ूर करें', gu: 'જુઓ અને મંજૂર કરો' },
  'decider-pending': { en: 'Review & approve', hi: 'देखें और मंज़ूर करें', gu: 'જુઓ અને મંજૂર કરો' },
  'client-reapprove': { en: 'Re-approve', hi: 'फिर से मंज़ूर करें', gu: 'ફરી મંજૂર કરો' },
  'decider-reapprove': { en: 'Re-approve', hi: 'फिर से मंज़ूर करें', gu: 'ફરી મંજૂર કરો' },
  'arch-countersign': { en: 'Review & countersign', hi: 'देखें और प्रति-हस्ताक्षर करें', gu: 'જુઓ અને પ્રતિ-સહી કરો' },
  'pmc-stranded': { en: 'Resolve', hi: 'सुलझाएँ', gu: 'ઉકેલો' },
  'pmc-countersign': { en: 'View', hi: 'देखें', gu: 'જુઓ' },
  'eng-checklist': { en: 'Fill & submit', hi: 'भरें और भेजें', gu: 'ભરો અને મોકલો' },
  'eng-log': { en: 'Open daily log', hi: 'आज का लॉग खोलें', gu: 'આજનો લોગ ખોલો' },
  'eng-ack': { en: 'Acknowledge current set', hi: 'मौजूदा सेट की पुष्टि करें', gu: 'હાલના સેટની પુષ્ટિ કરો' },
  'con-ack': { en: 'Acknowledge current set', hi: 'मौजूदा सेट की पुष्टि करें', gu: 'હાલના સેટની પુષ્ટિ કરો' },
  'con-change': { en: 'View', hi: 'देखें', gu: 'જુઓ' },
  'pmc-drafts': { en: 'Review & publish', hi: 'देखें और जारी करें', gu: 'જુઓ અને જાહેર કરો' },
  'pmc-reviews': { en: 'Review', hi: 'जाँचें', gu: 'તપાસો' },
  'pmc-change': { en: 'Open', hi: 'खोलें', gu: 'ખોલો' },
  'pmc-blocked': { en: 'Open schedule', hi: 'शेड्यूल खोलें', gu: 'શેડ્યૂલ ખોલો' },
  'pmc-pending': { en: 'View', hi: 'देखें', gu: 'જુઓ' },
  'pmc-reinspections': { en: 'Follow up', hi: 'पता करें', gu: 'તપાસ કરો' },
  'pmc-drawing-gate': { en: 'Open schedule', hi: 'शेड्यूल खोलें', gu: 'શેડ્યૂલ ખોલો' },
  'pmc-override-expiry': { en: 'Review overrides', hi: 'छूट देखें', gu: 'છૂટ જુઓ' },
  'material-shortage': { en: 'Open materials', hi: 'सामग्री खोलें', gu: 'સામગ્રી ખોલો' },
  'commercial-over-budget': { en: 'Open commercial', hi: 'खर्च खोलें', gu: 'ખર્ચ ખોલો' },
  'labour-shortage': { en: 'Open labour', hi: 'मज़दूर खोलें', gu: 'મજૂર ખોલો' },
  'cons-review': { en: 'Review drawings', hi: 'ड्रॉइंग देखें', gu: 'ડ્રોઇંગ જુઓ' },
};

const BUCKET: Record<NonNullable<ActionItemFacts['bucket']>, Record<NonEn, string>> = {
  architectural: { hi: 'आर्किटेक्चरल', gu: 'આર્કિટેક્ચરલ' },
  structural: { hi: 'स्ट्रक्चरल', gu: 'સ્ટ્રક્ચરલ' },
  mep: { hi: 'MEP', gu: 'MEP' },
  other: { hi: 'अन्य', gu: 'અન્ય' },
};

const LOCALE: Record<NonEn, string> = { hi: 'hi-IN', gu: 'gu-IN' };

/** A civil day (YYYY-MM-DD) as "14 अक्तूबर", formatted as-is (UTC) so no zone moves the day. */
function civilDay(day: string, lang: NonEn): string {
  const at = new Date(`${day}T00:00:00Z`);
  return Number.isNaN(at.getTime()) ? day : new Intl.DateTimeFormat(LOCALE[lang], { day: 'numeric', month: 'short', timeZone: 'UTC' }).format(at);
}

/** An instant as its local day, the way the English card shows it ("14 Oct"). */
function localDay(iso: string, lang: NonEn): string {
  const at = new Date(iso);
  return Number.isNaN(at.getTime()) ? iso : new Intl.DateTimeFormat(LOCALE[lang], { day: 'numeric', month: 'short' }).format(at);
}

/** "(2 blocked, 1 at-risk)" in the viewer's language. */
function split(f: ActionItemFacts, lang: NonEn): string {
  const parts: string[] = [];
  if (f.blocked) parts.push(lang === 'hi' ? `${f.blocked} ${f.blocked === 1 ? 'रुका' : 'रुके'}` : `${f.blocked} ${f.blocked === 1 ? 'અટક્યું' : 'અટક્યાં'}`);
  if (f.atRisk) parts.push(lang === 'hi' ? `${f.atRisk} जोखिम में` : `${f.atRisk} જોખમમાં`);
  return parts.length ? ` (${parts.join(', ')})` : '';
}

/** The title and detail for a non-English viewer, or null when the key is not one this release knows. */
function translated(key: string, f: ActionItemFacts, detail: string | undefined, lang: NonEn): Omit<ActionItemWords, 'cta'> | null {
  const n = f.n ?? 0;
  const hi = lang === 'hi';
  // one thing takes the singular verb ("1 निर्णय … देख रहा है", not "देख रहे हैं")
  const one = n === 1;
  switch (key) {
    case 'client-pending':
    case 'decider-pending':
      return { title: hi ? `${n} निर्णय आपकी मंज़ूरी की राह देख ${one ? 'रहा है' : 'रहे हैं'}` : `${n} નિર્ણય તમારી મંજૂરીની રાહ જુએ છે`, detail };
    case 'client-reapprove':
    case 'decider-reapprove':
      return { title: hi ? `${n} बदलाव के अनुरोध पर आपकी दोबारा मंज़ूरी चाहिए` : `${n} ફેરફારની વિનંતી પર તમારી ફરી મંજૂરી જોઈએ`, detail };
    case 'arch-countersign':
      return { title: hi ? `${n} निर्णय आपके प्रति-हस्ताक्षर की राह देख ${one ? 'रहा है' : 'रहे हैं'}` : `${n} નિર્ણય તમારી પ્રતિ-સહીની રાહ જુએ છે`, detail };
    case 'pmc-stranded':
      return { title: hi ? `${n} निर्णय ${one ? 'अटका' : 'अटके'} — प्रति-हस्ताक्षर के लिए कोई आर्किटेक्ट नहीं` : `${n} નિર્ણય ${one ? 'અટક્યો' : 'અટક્યા'} — પ્રતિ-સહી માટે કોઈ આર્કિટેક્ટ નથી`, detail };
    case 'pmc-countersign':
      return { title: hi ? `${n} निर्णय आर्किटेक्ट के प्रति-हस्ताक्षर की राह देख ${one ? 'रहा है' : 'रहे हैं'}` : `${n} નિર્ણય આર્કિટેક્ટની પ્રતિ-સહીની રાહ જુએ છે`, detail };
    case 'eng-checklist':
      if (f.title === undefined || f.items === undefined) return null;
      return {
        title: hi ? `भरने के लिए चेकलिस्ट: ${f.title}` : `ભરવા માટે ચેકલિસ્ટ: ${f.title}`,
        detail: `${f.items} ${hi ? 'आइटम' : 'આઇટમ'} · ${f.zone ?? ''}`,
      };
    case 'eng-log':
      return {
        title: hi ? 'आज का साइट लॉग नहीं भेजा गया' : 'આજનો સાઇટ લોગ મોકલ્યો નથી',
        detail: f.checkedIn
          ? (hi ? 'हाज़िरी लग गई — दिन का काम दर्ज होने पर भेजें' : 'હાજરી પુરાઈ — દિવસનું કામ નોંધાય ત્યારે મોકલો')
          : (hi ? 'साइट पर हाज़िरी लगाएँ, फिर भेजें' : 'સાઇટ પર હાજરી પુરો, પછી મોકલો'),
      };
    case 'eng-ack':
    case 'con-ack':
      return { title: hi ? `${n} ड्रॉइंग की पुष्टि करनी है` : `${n} ડ્રોઇંગની પુષ્ટિ કરવાની છે`, detail };
    case 'con-change':
      return { title: hi ? `${n} बदलाव के अनुरोध ${one ? 'खुला है' : 'खुले हैं'}` : `${n} ફેરફારની વિનંતી ખુલ્લી છે`, detail: hi ? 'PMC की राह' : 'PMC ની રાહ' };
    case 'pmc-drafts':
      return { title: hi ? `${n} ड्राफ़्ट पर काम चल रहा है` : `${n} ડ્રાફ્ટ પર કામ ચાલુ છે`, detail };
    case 'pmc-reviews':
      return { title: hi ? `${n} निरीक्षण आपकी जाँच की राह देख ${one ? 'रहा है' : 'रहे हैं'}` : `${n} નિરીક્ષણ તમારી તપાસની રાહ જુએ છે`, detail };
    case 'pmc-change':
      return { title: hi ? `${n} बदलाव के अनुरोध ${one ? 'सुलझाना है' : 'सुलझाने हैं'}` : `${n} ફેરફારની વિનંતી ઉકેલવાની છે`, detail };
    case 'pmc-blocked':
      return { title: hi ? `${n} काम ${one ? 'रुका हुआ है' : 'रुके हुए हैं'}` : `${n} કામ ${one ? 'અટકેલું છે' : 'અટકેલાં છે'}`, detail };
    case 'pmc-pending': {
      const client = f.who === 'client';
      return {
        title: hi
          ? `${n} निर्णय ${client ? 'क्लाइंट' : one ? 'निर्णय लेने वाले' : 'निर्णय लेने वालों'} की राह देख ${one ? 'रहा है' : 'रहे हैं'}`
          : `${n} નિર્ણય ${client ? 'ક્લાયન્ટ' : one ? 'નિર્ણય લેનાર' : 'નિર્ણય લેનારાઓ'}ની રાહ જુએ છે`,
        detail: client
          ? (hi ? 'जारी — क्लाइंट की मंज़ूरी की राह' : 'જારી — ક્લાયન્ટની મંજૂરીની રાહ')
          : (hi ? 'जारी — हर निर्णय लेने वाले की मंज़ूरी की राह' : 'જારી — દરેક નિર્ણય લેનારની મંજૂરીની રાહ'),
      };
    }
    case 'pmc-reinspections': {
      const due = f.due ? (hi ? `अगली तारीख ${civilDay(f.due, lang)}` : `આગલી તારીખ ${civilDay(f.due, lang)}`) : '';
      return {
        title: hi ? `${n} दोबारा निरीक्षण इंजीनियर के पास` : `${n} ફરી નિરીક્ષણ ઇજનેર પાસે`,
        detail: [f.names ?? '', due].filter(Boolean).join(' · '),
      };
    }
    case 'pmc-drawing-gate':
      return { title: hi ? `रुका: ${n} काम पर ड्रॉइंग की पुष्टि बाकी` : `અટક્યું: ${n} કામ પર ડ્રોઇંગની પુષ્ટિ બાકી`, detail };
    case 'pmc-override-expiry':
      if (f.expiresAt === undefined || f.activity === undefined) return null;
      return {
        title: hi ? `छूट ${localDay(f.expiresAt, lang)} को खत्म — ${f.activity}` : `છૂટ ${localDay(f.expiresAt, lang)} એ પૂરી — ${f.activity}`,
        // one lapsing override shows its own reason (data); several are counted
        detail: (f.expiring ?? 1) > 1 ? (hi ? `${f.expiring} छूट एक हफ़्ते में खत्म होंगी` : `${f.expiring} છૂટ એક અઠવાડિયામાં પૂરી થશે`) : detail,
      };
    case 'material-shortage':
      return { title: (hi ? `${n} सामग्री की कमी` : `${n} સામગ્રીની અછત`) + split(f, lang), detail };
    case 'labour-shortage':
      return { title: (hi ? `${n} मज़दूरों की कमी` : `${n} મજૂરોની અછત`) + split(f, lang), detail };
    case 'commercial-over-budget':
      return {
        title: hi ? `${n} खर्च मद बजट से ऊपर` : `${n} ખર્ચ મથાળાં બજેટથી ઉપર`,
        detail: f.head !== undefined && f.over !== undefined
          ? (hi ? `${f.head} ${f.over} से ऊपर है — लगाया गया पैसा मंज़ूर बजट से ज़्यादा है।` : `${f.head} ${f.over} થી ઉપર છે — લગાવેલા પૈસા મંજૂર બજેટથી વધુ છે.`)
          : (hi ? 'लगाया गया पैसा मंज़ूर बजट से ज़्यादा है।' : 'લગાવેલા પૈસા મંજૂર બજેટથી વધુ છે.'),
      };
    case 'cons-review':
      if (!f.bucket) return null;
      return {
        title: hi ? `मौजूदा सेट में ${n} ${BUCKET[f.bucket].hi} ड्रॉइंग` : `હાલના સેટમાં ${n} ${BUCKET[f.bucket].gu} ડ્રોઇંગ`,
        detail: hi ? 'अपने विषय का जारी सेट देखें' : 'તમારા વિષયનો જારી સેટ જુઓ',
      };
    default:
      return null;
  }
}

/**
 * A card's words in the viewer's language. English is the builder's own text; a key or a card whose facts this
 * release does not know is shown in English as built, never guessed at.
 */
export function actionItemText(item: { key: string; title: string; detail?: string; cta: string; facts?: ActionItemFacts }, lang: Lang): ActionItemWords {
  const english = { title: item.title, detail: item.detail, cta: item.cta };
  if (lang === 'en' || !item.facts) return english;
  const words = translated(item.key, item.facts, item.detail, lang);
  const cta = CTA[item.key]?.[lang];
  return words && cta ? { ...words, cta } : english;
}

/** The For You screen's own words (the list shown to roles without a Today, Pulse or brief home). */
export const forYouLabels = {
  eyebrow: { en: 'FOR YOU', hi: 'आपके लिए', gu: 'તમારા માટે' },
  caughtUp: { en: 'You’re all caught up', hi: 'आपका सब काम हो गया', gu: 'તમારું બધું કામ થઈ ગયું' },
  nothing: { en: 'Nothing needs you right now', hi: 'अभी आपके लिए कुछ बाकी नहीं', gu: 'હમણાં તમારે કંઈ કરવાનું નથી' },
  nothingDetail: {
    en: 'When a decision, drawing or inspection is waiting on you, it’ll show up here.',
    hi: 'जब कोई निर्णय, ड्रॉइंग या निरीक्षण आपकी राह देखेगा, वह यहाँ दिखेगा।',
    gu: 'જ્યારે કોઈ નિર્ણય, ડ્રોઇંગ કે નિરીક્ષણ તમારી રાહ જોશે, તે અહીં દેખાશે.',
  },
} satisfies Record<string, Words>;

/** The role on the eyebrow ("FOR YOU · ENGINEER"). */
export const forYouRole: Record<Role, Words> = {
  pmc: { en: 'PMC', hi: 'PMC', gu: 'PMC' },
  client: { en: 'Client', hi: 'क्लाइंट', gu: 'ક્લાયન્ટ' },
  engineer: { en: 'Engineer', hi: 'इंजीनियर', gu: 'ઇજનેર' },
  contractor: { en: 'Contractor', hi: 'ठेकेदार', gu: 'કોન્ટ્રાક્ટર' },
  consultant: { en: 'Consultant', hi: 'सलाहकार', gu: 'સલાહકાર' },
  architect: { en: 'Architect', hi: 'आर्किटेक्ट', gu: 'આર્કિટેક્ટ' },
};

/** "3 things need you", in the viewer's language. */
export function forYouCount(n: number, lang: Lang): string {
  if (lang === 'hi') return n === 1 ? '1 काम आपकी राह देख रहा है' : `${n} काम आपकी राह देख रहे हैं`;
  if (lang === 'gu') return n === 1 ? '1 કામ તમારી રાહ જુએ છે' : `${n} કામ તમારી રાહ જુએ છે`;
  return `${n} thing${n === 1 ? ' needs' : 's need'} you`;
}

/** The intro line under the heading, split around the project's short name (data, shown bold between them). */
export function forYouIntro(lang: Lang): { before: string; after: string } {
  if (lang === 'hi') return { before: '', after: ' में आपकी राह देख रहा सब कुछ — निर्णय, ड्रॉइंग, निरीक्षण और साइट लॉग — एक जगह। सीधे वहाँ जाने के लिए कार्ड दबाएँ। दूसरा प्रोजेक्ट देखने के लिए प्रोजेक्ट बदलें।' };
  if (lang === 'gu') return { before: '', after: ' માં તમારી રાહ જોતું બધું — નિર્ણય, ડ્રોઇંગ, નિરીક્ષણ અને સાઇટ લોગ — એક જગ્યાએ. સીધા ત્યાં જવા કાર્ડ દબાવો. બીજો પ્રોજેક્ટ જોવા પ્રોજેક્ટ બદલો.' };
  return {
    before: 'Everything waiting on you in ',
    after: ' — decisions, drawings, inspections and the site log — in one place. Tap a card to go straight there. Use the project switcher to see another project.',
  };
}
