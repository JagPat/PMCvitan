/**
 * #482 QA item 3 — the Decision Log in Hindi and Gujarati (English unchanged): the register, its filters and
 * groups, each decision row with its edit state, consultation thread and countersign controls, the decisions
 * awaiting the client, and "Withdraw request". Decision titles and ids, option and material names, people's
 * names, place names and typed reasons, questions and advice are project data, shown as recorded.
 */

import type { DeciderKind, DecisionStatus, Lang } from '../domain/types';
import { deciderNoun } from '../domain/readiness';
import { signed } from '../lib/format';
import { forYouRole } from './actionItems';
import { servedDayIn } from './schedule';

type Words = Record<Lang, string>;
const pick = (lang: Lang, en: string, hi: string, gu: string): string => (lang === 'hi' ? hi : lang === 'gu' ? gu : en);

/** Who decides, inside a Hindi or Gujarati sentence (English is the shared `deciderNoun`). */
const DECIDER: Record<DeciderKind, Words> = {
  client: { en: 'the client', hi: 'क्लाइंट', gu: 'ક્લાયન્ટ' },
  none: { en: 'the client', hi: 'क्लाइंट', gu: 'ક્લાયન્ટ' },
  pmc: { en: 'the PMC', hi: 'प्रोजेक्ट मैनेजर (PMC)', gu: 'પ્રોજેક્ટ મેનેજર (PMC)' },
  member: { en: 'the named decider', hi: 'तय किए गए निर्णयकर्ता', gu: 'નક્કી કરેલા નિર્ણયકર્તા' },
  architect: { en: 'the architect', hi: 'आर्किटेक्ट', gu: 'આર્કિટેક્ટ' },
};
const decider = (kind: DeciderKind, lang: Lang): string => (lang === 'en' ? deciderNoun(kind) : (DECIDER[kind] ?? DECIDER.client)[lang]);

/** A member's role as the chooser lists it: English keeps the role's own key, as it always showed. */
export function memberRoleIn(role: string, lang: Lang): string {
  if (lang === 'en') return role;
  return (forYouRole as Record<string, Words>)[role]?.[lang] ?? role;
}

export const decisionLogLabels = {
  eyebrow: { en: 'CLIENT DECISION LOG', hi: 'क्लाइंट निर्णय रजिस्टर', gu: 'ક્લાયન્ટ નિર્ણય રજિસ્ટર' },
  history: { en: 'History', hi: 'इतिहास', gu: 'ઇતિહાસ' },
  register: { en: 'Decision Register', hi: 'निर्णय रजिस्टर', gu: 'નિર્ણય રજિસ્ટર' },
  decisions: { en: 'Decisions', hi: 'निर्णय', gu: 'નિર્ણયો' },
  loadFailed: {
    en: 'Couldn\'t load decisions — check your connection and access.',
    hi: 'निर्णय लोड नहीं हो सके — अपना इंटरनेट और पहुँच देखें।',
    gu: 'નિર્ણયો લોડ ન થયા — તમારું ઇન્ટરનેટ અને પરવાનગી તપાસો.',
  },
  retry: { en: 'Retry', hi: 'फिर कोशिश करें', gu: 'ફરી પ્રયાસ કરો' },
  loading: { en: 'Loading decisions…', hi: 'निर्णय लोड हो रहे हैं…', gu: 'નિર્ણયો લોડ થઈ રહ્યા છે…' },
  what: { en: 'Decision', hi: 'निर्णय', gu: 'નિર્ણય' },
  showAll: { en: 'Show all decisions', hi: 'सभी निर्णय दिखाएँ', gu: 'બધા નિર્ણયો બતાવો' },
  issue: { en: 'Issue decision', hi: 'निर्णय जारी करें', gu: 'નિર્ણય જારી કરો' },
  groupBy: { en: 'Group by', hi: 'समूह बनाएँ', gu: 'જૂથ બનાવો' },
  searchHint: { en: 'Search decisions…', hi: 'निर्णय खोजें…', gu: 'નિર્ણયો શોધો…' },
  search: { en: 'Search decisions', hi: 'निर्णय खोजें', gu: 'નિર્ણયો શોધો' },
  noMatch: {
    en: 'No decisions match your filters.',
    hi: 'आपके फ़िल्टर से कोई निर्णय मेल नहीं खाता।',
    gu: 'તમારા ફિલ્ટર સાથે કોઈ નિર્ણય મેળ ખાતો નથી.',
  },
  withdrawDecision: { en: 'Withdraw decision', hi: 'निर्णय वापस लें', gu: 'નિર્ણય પાછો ખેંચો' },
  requestChange: { en: 'Request change', hi: 'बदलाव माँगें', gu: 'ફેરફાર માગો' },
  withdrawRequest: { en: 'Withdraw request', hi: 'अनुरोध वापस लें', gu: 'વિનંતી પાછી ખેંચો' },
  locked: {
    en: 'Locked after approval — the approved choice is the record.',
    hi: 'मंज़ूरी के बाद लॉक — मंज़ूर चुनाव ही रिकॉर्ड है।',
    gu: 'મંજૂરી પછી લૉક — મંજૂર પસંદગી જ રેકોર્ડ છે.',
  },
  recorded: { en: 'Issue recorded — no approval required', hi: 'मुद्दा दर्ज — मंज़ूरी की ज़रूरत नहीं', gu: 'મુદ્દો નોંધાયો — મંજૂરીની જરૂર નથી' },
  recordedLine: {
    en: 'Filed on the register — nothing approvable',
    hi: 'रजिस्टर में दर्ज — मंज़ूर करने को कुछ नहीं',
    gu: 'રજિસ્ટરમાં નોંધાયું — મંજૂર કરવા જેવું કંઈ નથી',
  },
  tagRecorded: { en: 'RECORDED', hi: 'दर्ज', gu: 'નોંધાયેલો' },
  tagOptions: { en: 'OPTIONS', hi: 'विकल्प', gu: 'વિકલ્પો' },
  tagProvisional: { en: 'PROVISIONAL', hi: 'अस्थायी', gu: 'કામચલાઉ' },
  tagApproved: { en: 'APPROVED', hi: 'मंज़ूर', gu: 'મંજૂર' },
  withdrawn: { en: 'Withdrawn:', hi: 'वापस लिया:', gu: 'પાછો ખેંચ્યો:' },
  sentBack: { en: 'Sent back by the architect:', hi: 'आर्किटेक्ट ने वापस भेजा:', gu: 'આર્કિટેક્ટે પાછું મોકલ્યું:' },
  changeRequested: { en: 'Change requested:', hi: 'बदलाव माँगा:', gu: 'ફેરફાર માગ્યો:' },
  noScheduleImpact: { en: 'no schedule impact', hi: 'समय पर कोई असर नहीं', gu: 'સમય પર કોઈ અસર નહીં' },
  noCostChange: { en: 'No cost change', hi: 'खर्च में कोई बदलाव नहीं', gu: 'ખર્ચમાં કોઈ ફેરફાર નથી' },
  // a group the register's own grouping names (not a place)
  noRoom: { en: 'No room', hi: 'कोई कमरा नहीं', gu: 'કોઈ રૂમ નથી' },
  noObject: { en: 'No object', hi: 'कोई चीज़ नहीं', gu: 'કોઈ વસ્તુ નથી' },
  unfiled: { en: 'Unfiled', hi: 'बिना जगह', gu: 'જગ્યા વગર' },
  allDecisions: { en: 'All decisions', hi: 'सभी निर्णय', gu: 'બધા નિર્ણયો' },
} satisfies Record<string, Words>;

/** The register's group-by lenses. */
export const decisionGroupByLabels = {
  location: { en: 'Location', hi: 'जगह', gu: 'જગ્યા' },
  room: { en: 'Room', hi: 'कमरा', gu: 'રૂમ' },
  element: { en: 'Object', hi: 'चीज़', gu: 'વસ્તુ' },
  status: { en: 'Status', hi: 'स्थिति', gu: 'સ્થિતિ' },
  flat: { en: 'All', hi: 'सभी', gu: 'બધા' },
} satisfies Record<string, Words>;

type StatusWords = { filter: Words; group: Words; rollup: Words };

/** A decision status on the register: its filter chip, its group heading and its count in a group's rollup. */
export const decisionStatusWords: Record<DecisionStatus, StatusWords> = {
  pending: {
    filter: { en: 'Pending', hi: 'बाकी', gu: 'બાકી' },
    group: { en: 'Pending', hi: 'बाकी', gu: 'બાકી' },
    rollup: { en: 'pending', hi: 'बाकी', gu: 'બાકી' },
  },
  approved: {
    filter: { en: 'Approved', hi: 'मंज़ूर', gu: 'મંજૂર' },
    group: { en: 'Approved', hi: 'मंज़ूर', gu: 'મંજૂર' },
    rollup: { en: 'approved', hi: 'मंज़ूर', gu: 'મંજૂર' },
  },
  change: {
    filter: { en: 'Change', hi: 'बदलाव', gu: 'ફેરફાર' },
    group: { en: 'Change requested', hi: 'बदलाव माँगा', gu: 'ફેરફાર માગ્યો' },
    rollup: { en: 'change', hi: 'बदलाव', gu: 'ફેરફાર' },
  },
  withdrawn: {
    filter: { en: 'Withdrawn', hi: 'वापस लिया', gu: 'પાછો ખેંચ્યો' },
    group: { en: 'Withdrawn', hi: 'वापस लिया', gu: 'પાછો ખેંચ્યો' },
    rollup: { en: 'withdrawn', hi: 'वापस लिया', gu: 'પાછો ખેંચ્યો' },
  },
  recorded: {
    filter: { en: 'Recorded', hi: 'दर्ज', gu: 'નોંધાયેલો' },
    group: { en: 'Recorded', hi: 'दर्ज', gu: 'નોંધાયેલો' },
    rollup: { en: 'recorded', hi: 'दर्ज', gu: 'નોંધાયેલો' },
  },
  awaiting_countersign: {
    filter: { en: 'Awaiting countersign', hi: 'प्रति-हस्ताक्षर बाकी', gu: 'પ્રતિ-સહી બાકી' },
    group: { en: 'Awaiting countersign', hi: 'प्रति-हस्ताक्षर बाकी', gu: 'પ્રતિ-સહી બાકી' },
    rollup: { en: 'awaiting countersign', hi: 'प्रति-हस्ताक्षर बाकी', gu: 'પ્રતિ-સહી બાકી' },
  },
};

/** The register's lines that carry a number, a name, a date or the decider. */
export const decisionLogText = {
  count: (n: number, lang: Lang): string => pick(lang, `${n} ${n === 1 ? 'DECISION' : 'DECISIONS'}`, `${n} निर्णय`, `${n} નિર્ણય`),
  link: (id: string, lang: Lang): string => pick(lang, `Link to decision ${id}`, `निर्णय ${id} की लिंक`, `નિર્ણય ${id}ની લિંક`),
  /** `date` is the English day ("05 Oct 2026"); Hindi and Gujarati read it in their month names */
  withdrawnBy: (by: string | undefined, date: string | null, lang: Lang): string => {
    const at = date ? ` · ${servedDayIn(date, lang)}` : '';
    if (lang === 'en') return `Withdrawn by ${by ?? 'the PMC'}${at}`;
    return pick(lang, '', `${by ?? 'PMC'} द्वारा वापस लिया गया${at}`, `${by ?? 'PMC'} દ્વારા પાછો ખેંચાયો${at}`);
  },
  approvedAwaiting: (approver: string | undefined, kind: DeciderKind, lang: Lang): string => {
    const who = approver ?? decider(kind, lang);
    return pick(lang, `Approved by ${who} — awaiting the architect’s countersign`, `${who} द्वारा मंज़ूर — आर्किटेक्ट के प्रति-हस्ताक्षर की राह`, `${who} દ્વારા મંજૂર — આર્કિટેક્ટની પ્રતિ-સહીની રાહ`);
  },
  approvedBy: (approver: string, onBehalfOf: string | undefined, date: string | undefined, lang: Lang): string => {
    if (lang === 'en') return `Approved by ${approver}${onBehalfOf ? ` (on behalf of the ${onBehalfOf})` : ''} · ${date}`;
    const day = date === undefined ? '' : servedDayIn(date, lang);
    const holder = onBehalfOf ? memberRoleIn(onBehalfOf, lang) : '';
    return lang === 'hi'
      ? `${approver}${holder ? ` (${holder} की ओर से)` : ''} द्वारा मंज़ूर · ${day}`
      : `${approver}${holder ? ` (${holder} વતી)` : ''} દ્વારા મંજૂર · ${day}`;
  },
  ageing: (days: number | undefined, kind: DeciderKind, lang: Lang): string => {
    if (lang === 'en') return `Ageing ${days} days · ${kind === 'client' ? 'awaiting client' : `awaiting ${deciderNoun(kind)}`}`;
    const who = decider(kind, lang);
    return pick(lang, '', `${days ?? ''} दिन से बाकी · ${who} की राह`, `${days ?? ''} દિવસથી બાકી · ${who}ની રાહ`);
  },
  optionsPresented: (n: number, lang: Lang): string => pick(lang, `${n} options presented`, `${n} विकल्प दिखाए गए`, `${n} વિકલ્પો બતાવ્યા`),
  /** a signed rupee change; nothing changing reads in the language */
  cost: (n: number, lang: Lang): string => (n === 0 ? decisionLogLabels.noCostChange[lang] : signed(n)),
  costUpTo: (n: number, lang: Lang): string => {
    if (lang === 'en') return 'up to ' + signed(n);
    if (n === 0) return decisionLogLabels.noCostChange[lang];
    return pick(lang, '', `${signed(n)} तक`, `${signed(n)} સુધી`);
  },
  scheduleImpact: (days: number, lang: Lang): string => {
    if (days === 0) return decisionLogLabels.noScheduleImpact[lang];
    return pick(lang, `${days} day${days === 1 ? '' : 's'}`, `${days} दिन`, `${days} દિવસ`);
  },
  awaitingReapproval: (kind: DeciderKind, lang: Lang): string => {
    const who = decider(kind, lang);
    return pick(lang, ` · awaiting ${who}’s re-approval`, ` · ${who} की दोबारा मंज़ूरी की राह`, ` · ${who}ની ફરી મંજૂરીની રાહ`);
  },
  changeWithDecider: (kind: DeciderKind, lang: Lang): string => {
    const who = decider(kind, lang);
    return pick(
      lang,
      `A change request is with ${who} — the decision reopens when they answer.`,
      `बदलाव का अनुरोध ${who} के पास है — उनके जवाब देने पर निर्णय फिर खुलेगा।`,
      `ફેરફારની વિનંતી ${who} પાસે છે — તેઓ જવાબ આપે ત્યારે નિર્ણય ફરી ખૂલશે.`,
    );
  },
  rollup: (n: number, label: string): string => `${n} ${label}`,
};

/** "Withdraw request" on a change the viewer may withdraw, and why. */
export const withdrawChangeLabels = {
  mine: {
    en: 'You asked for this change. Withdraw it to keep the approved choice.',
    hi: 'यह बदलाव आपने माँगा था। मंज़ूर चुनाव रखने के लिए इसे वापस लें।',
    gu: 'આ ફેરફાર તમે માગ્યો હતો. મંજૂર પસંદગી રાખવા તેને પાછો ખેંચો.',
  },
  others: {
    en: 'Another member asked for this change. As PMC you can withdraw it to keep the approved choice.',
    hi: 'यह बदलाव किसी और सदस्य ने माँगा था। PMC होने के नाते आप मंज़ूर चुनाव रखने के लिए इसे वापस ले सकते हैं।',
    gu: 'આ ફેરફાર બીજા સભ્યે માગ્યો હતો. PMC તરીકે તમે મંજૂર પસંદગી રાખવા તેને પાછો ખેંચી શકો છો.',
  },
} satisfies Record<string, Words>;

/** The decisions awaiting the client, read-only, above the engineer's, contractor's and consultant's register. */
export const awaitingClientLabels = {
  title: { en: 'Awaiting client', hi: 'क्लाइंट की राह में', gu: 'ક્લાયન્ટની રાહમાં' },
  intro: {
    en: 'New decisions the client still has to make, shown so you can plan around them. Reopened ones are in the list below.',
    hi: 'नए निर्णय जो क्लाइंट को अभी लेने हैं, ताकि आप उनके हिसाब से योजना बना सकें। फिर से खुले निर्णय नीचे की सूची में हैं।',
    gu: 'નવા નિર્ણયો જે ક્લાયન્ટે હજી લેવાના છે, જેથી તમે તે મુજબ આયોજન કરી શકો. ફરી ખૂલેલા નિર્ણયો નીચેની યાદીમાં છે.',
  },
  loading: { en: 'Loading…', hi: 'लोड हो रहा है…', gu: 'લોડ થઈ રહ્યું છે…' },
  failed: {
    en: 'Couldn\'t load what the client is deciding. Check your connection.',
    hi: 'क्लाइंट किन निर्णयों पर विचार कर रहे हैं, यह लोड नहीं हो सका। अपना इंटरनेट देखें।',
    gu: 'ક્લાયન્ટ કયા નિર્ણયો પર વિચારે છે તે લોડ ન થયું. તમારું ઇન્ટરનેટ તપાસો.',
  },
  tryAgain: { en: 'Try again', hi: 'फिर कोशिश करें', gu: 'ફરી પ્રયાસ કરો' },
  empty: { en: 'No new decision is waiting on the client.', hi: 'कोई नया निर्णय क्लाइंट की राह में नहीं है।', gu: 'કોઈ નવો નિર્ણય ક્લાયન્ટની રાહમાં નથી.' },
  waiting: { en: 'Waiting on the client', hi: 'क्लाइंट की राह में', gu: 'ક્લાયન્ટની રાહમાં' },
} satisfies Record<string, Words>;

export function awaitingClientWaited(days: number, lang: Lang): string {
  return pick(lang, `Waiting ${days} ${days === 1 ? 'day' : 'days'}`, `${days} दिन से राह में`, `${days} દિવસથી રાહમાં`);
}

/** The advice thread under a decision. */
export const consultationLabels = {
  advice: { en: 'Advice', hi: 'सलाह', gu: 'સલાહ' },
  someone: { en: 'a team member', hi: 'टीम का एक सदस्य', gu: 'ટીમના એક સભ્ય' },
  awaiting: { en: 'Awaiting their advice', hi: 'उनकी सलाह की राह', gu: 'તેમની સલાહની રાહ' },
  yourAdvice: { en: 'Your advice', hi: 'आपकी सलाह', gu: 'તમારી સલાહ' },
  recommend: { en: 'Recommend an option', hi: 'कोई विकल्प सुझाएँ', gu: 'કોઈ વિકલ્પ સૂચવો' },
  noRecommendation: { en: 'No recommendation', hi: 'कोई सुझाव नहीं', gu: 'કોઈ સૂચન નહીં' },
  sendAdvice: { en: 'Send advice', hi: 'सलाह भेजें', gu: 'સલાહ મોકલો' },
  askMember: { en: 'Ask a member', hi: 'किसी सदस्य से पूछें', gu: 'કોઈ સભ્યને પૂછો' },
  whoToAsk: { en: 'Who to ask', hi: 'किससे पूछें', gu: 'કોને પૂછવું' },
  chooseMember: { en: 'Choose a member…', hi: 'सदस्य चुनें…', gu: 'સભ્ય પસંદ કરો…' },
  yourQuestion: { en: 'Your question', hi: 'आपका सवाल', gu: 'તમારો સવાલ' },
  ask: { en: 'Ask', hi: 'पूछें', gu: 'પૂછો' },
  cancel: { en: 'Cancel', hi: 'रद्द करें', gu: 'રદ કરો' },
} satisfies Record<string, Words>;

export const consultationText = {
  /** "<asker> asked <consultee>: " — the words between and after the two names */
  asked: (lang: Lang): { between: string; after: string } =>
    lang === 'hi' ? { between: ' ने ', after: ' से पूछा: ' } : lang === 'gu' ? { between: ' એ ', after: ' ને પૂછ્યું: ' } : { between: ' asked ', after: ': ' },
  leansTo: (key: string, lang: Lang): string => pick(lang, ` · leans to option ${key}`, ` · विकल्प ${key} की ओर झुकाव`, ` · વિકલ્પ ${key} તરફ ઝોક`),
};

/** The countersign chain's controls on a register row. */
export const countersignLabels = {
  working: { en: 'Working…', hi: 'काम चल रहा है…', gu: 'કામ ચાલુ છે…' },
  forward: { en: 'Forward', hi: 'आगे भेजें', gu: 'આગળ મોકલો' },
  countersign: { en: 'Countersign', hi: 'प्रति-हस्ताक्षर करें', gu: 'પ્રતિ-સહી કરો' },
  rejectBack: { en: 'Reject back', hi: 'नामंज़ूर कर वापस भेजें', gu: 'નામંજૂર કરી પાછું મોકલો' },
  forwardOn: { en: 'Forward on', hi: 'आगे बढ़ाएँ', gu: 'આગળ વધારો' },
  completeWithout: { en: 'Complete without countersign', hi: 'प्रति-हस्ताक्षर के बिना पूरा करें', gu: 'પ્રતિ-સહી વગર પૂરું કરો' },
  returnToDecider: { en: 'Return to the decider', hi: 'निर्णयकर्ता को लौटाएँ', gu: 'નિર્ણયકર્તાને પાછું આપો' },
  forwardTo: { en: 'Forward to', hi: 'किसे भेजें', gu: 'કોને મોકલવું' },
  rejectBackTitle: { en: 'Reject back to the decider', hi: 'नामंज़ूर कर निर्णयकर्ता को वापस भेजें', gu: 'નામંજૂર કરી નિર્ણયકર્તાને પાછું મોકલો' },
  forwardOnTo: { en: 'Forward on to', hi: 'किसे आगे बढ़ाएँ', gu: 'કોને આગળ વધારવું' },
  rehomeTo: { en: 'Re-home to', hi: 'किसे सौंपें', gu: 'કોને સોંપવું' },
  keepDecider: { en: 'Keep the current decider', hi: 'अभी के निर्णयकर्ता को रखें', gu: 'હાલના નિર્ણયકર્તાને રાખો' },
  chooseWho: { en: 'Choose who decides…', hi: 'चुनें कौन निर्णय लेगा…', gu: 'પસંદ કરો કોણ નિર્ણય લેશે…' },
  kindClient: { en: 'The client', hi: 'क्लाइंट', gu: 'ક્લાયન્ટ' },
  kindPmc: { en: 'The practice (PMC)', hi: 'प्रैक्टिस (PMC)', gu: 'પ્રેક્ટિસ (PMC)' },
  kindMember: { en: 'A named member', hi: 'कोई नामित सदस्य', gu: 'કોઈ નામવાળા સભ્ય' },
  kindArchitect: { en: 'The architect', hi: 'आर्किटेक्ट', gu: 'આર્કિટેક્ટ' },
  namedMember: { en: 'Named member', hi: 'नामित सदस्य', gu: 'નામવાળા સભ્ય' },
  chooseMember: { en: 'Choose a member…', hi: 'सदस्य चुनें…', gu: 'સભ્ય પસંદ કરો…' },
  reason: { en: 'Reason', hi: 'कारण', gu: 'કારણ' },
  reasonHint: { en: 'Reason (required)', hi: 'कारण (ज़रूरी)', gu: 'કારણ (જરૂરી)' },
  cost: { en: 'Cost impact', hi: 'खर्च पर असर', gu: 'ખર્ચ પર અસર' },
  costHint: { en: 'Cost impact (₹, optional)', hi: 'खर्च पर असर (₹, वैकल्पिक)', gu: 'ખર્ચ પર અસર (₹, વૈકલ્પિક)' },
  days: { en: 'Schedule impact (days)', hi: 'समय पर असर (दिन)', gu: 'સમય પર અસર (દિવસ)' },
  daysHint: { en: 'Days (optional)', hi: 'दिन (वैकल्पिक)', gu: 'દિવસ (વૈકલ્પિક)' },
  sendBack: { en: 'Send back', hi: 'वापस भेजें', gu: 'પાછું મોકલો' },
  complete: { en: 'Complete', hi: 'पूरा करें', gu: 'પૂરું કરો' },
  return: { en: 'Return', hi: 'लौटाएँ', gu: 'પાછું આપો' },
  cancel: { en: 'Cancel', hi: 'रद्द करें', gu: 'રદ કરો' },
} satisfies Record<string, Words>;
