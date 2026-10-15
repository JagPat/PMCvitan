/**
 * #482 QA item 3 — the site activity schedule in Hindi and Gujarati (English unchanged). Activity and phase
 * names, ids, places, people's names, blocker notes and override reasons are project data, shown as recorded.
 */

import type { ActivityStatus, Gate, Lang } from '../domain/types';
import type { GateSource, OverridableGate } from '../domain/readiness';

type Words = Record<Lang, string>;
type NonEn = Exclude<Lang, 'en'>;
const pick = (lang: Lang, en: string, hi: string, gu: string): string => (lang === 'hi' ? hi : lang === 'gu' ? gu : en);

export const scheduleLabels = {
  eyebrow: { en: 'SITE ACTIVITY SCHEDULE', hi: 'साइट काम का शेड्यूल', gu: 'સાઇટ કામનું શેડ્યૂલ' },
  loading: { en: 'Loading the schedule…', hi: 'शेड्यूल लोड हो रहा है…', gu: 'શેડ્યૂલ લોડ થઈ રહ્યું છે…' },
  returning: { en: 'Returning to the whole schedule…', hi: 'पूरे शेड्यूल पर लौट रहे हैं…', gu: 'આખા શેડ્યૂલ પર પાછા જઈએ છીએ…' },
  loadFailed: {
    en: 'Couldn\'t load the schedule — check your connection and access.',
    hi: 'शेड्यूल लोड नहीं हो सका — अपना इंटरनेट और पहुँच देखें।',
    gu: 'શેડ્યૂલ લોડ ન થયું — તમારું ઇન્ટરનેટ અને પરવાનગી તપાસો.',
  },
  retry: { en: 'Retry', hi: 'फिर कोशिश करें', gu: 'ફરી પ્રયાસ કરો' },
  what: { en: 'Activity', hi: 'काम', gu: 'કામ' },
  showAll: { en: 'Show the whole schedule', hi: 'पूरा शेड्यूल दिखाएँ', gu: 'આખું શેડ્યૂલ બતાવો' },
  title: {
    en: 'What is starting, running & ending on site',
    hi: 'साइट पर क्या शुरू हो रहा है, क्या चल रहा है और क्या ख़त्म हो रहा है',
    gu: 'સાઇટ પર શું શરૂ થાય છે, શું ચાલે છે અને શું પૂરું થાય છે',
  },
  running: { en: 'RUNNING', hi: 'चल रहे', gu: 'ચાલુ' },
  done: { en: 'DONE', hi: 'पूरे', gu: 'પૂરાં' },
  blocked: { en: 'BLOCKED', hi: 'रुके', gu: 'અટકેલાં' },
  gatesToStart: { en: 'GATES TO START:', hi: 'शुरू करने की शर्तें:', gu: 'શરૂ કરવાની શરતો:' },
  ready: { en: 'Ready', hi: 'तैयार', gu: 'તૈયાર' },
  waiting: { en: 'Waiting', hi: 'इंतज़ार', gu: 'રાહ' },
  failed: { en: 'Failed', hi: 'फ़ेल', gu: 'નાપાસ' },
  na: { en: 'N/A', hi: 'लागू नहीं', gu: 'લાગુ નથી' },
  planned: { en: 'Planned', hi: 'योजना', gu: 'યોજના' },
  actual: { en: 'Actual', hi: 'असल', gu: 'ખરેખર' },
  planActivity: { en: 'Plan activity', hi: 'काम की योजना बनाएँ', gu: 'કામનું આયોજન કરો' },
  addPhase: { en: 'Add phase', hi: 'चरण जोड़ें', gu: 'તબક્કો ઉમેરો' },
  removePhase: { en: 'Remove phase', hi: 'चरण हटाएँ', gu: 'તબક્કો હટાવો' },
  phaseDeleteNote: {
    en: 'Its activities stay in the schedule, under Unphased.',
    hi: 'इसके काम शेड्यूल में “बिना चरण” के नीचे रहेंगे।',
    gu: 'તેનાં કામ શેડ્યૂલમાં “તબક્કા વગર” હેઠળ રહેશે.',
  },
  place: { en: 'PLACE', hi: 'जगह', gu: 'જગ્યા' },
  allPlaces: { en: 'All places', hi: 'सभी जगहें', gu: 'બધી જગ્યા' },
  unphased: { en: 'UNPHASED', hi: 'बिना चरण', gu: 'તબક્કા વગર' },
  // the row
  completed: { en: 'Completed', hi: 'पूरा हुआ', gu: 'પૂરું થયું' },
  blockedButton: { en: 'Blocked', hi: 'रुका हुआ', gu: 'અટકેલું' },
  awaitingSignoff: { en: 'Awaiting sign-off', hi: 'मंज़ूरी बाकी', gu: 'મંજૂરી બાકી' },
  markComplete: { en: 'Mark complete', hi: 'पूरा दर्ज करें', gu: 'પૂરું નોંધો' },
  startActivity: { en: 'Start activity', hi: 'काम शुरू करें', gu: 'કામ શરૂ કરો' },
  notStarted: { en: 'Not started', hi: 'शुरू नहीं हुआ', gu: 'શરૂ થયું નથી' },
  blockedOnSite: {
    en: 'Blocked on site. Resolve the recorded blocker; the activity returns to the schedule once it clears.',
    hi: 'साइट पर रुका हुआ। दर्ज रुकावट दूर करें; दूर होते ही काम फिर से शेड्यूल में आ जाएगा।',
    gu: 'સાઇટ પર અટકેલું. નોંધાયેલી અડચણ દૂર કરો; દૂર થતાં કામ ફરી શેડ્યૂલમાં આવશે.',
  },
  claimed: {
    en: 'Completion is claimed — the PMC’s closing inspection sign-off is what marks it done.',
    hi: 'काम पूरा होने का दावा हुआ — PMC की आख़िरी निरीक्षण मंज़ूरी से ही यह पूरा माना जाएगा।',
    gu: 'કામ પૂરું થયાનો દાવો થયો — PMC ની છેલ્લી નિરીક્ષણ મંજૂરીથી જ તે પૂરું ગણાશે.',
  },
  overrideTitle: {
    en: 'Record a gate override (expires automatically)',
    hi: 'शर्त में छूट दर्ज करें (अपने-आप ख़त्म होगी)',
    gu: 'શરતમાં છૂટ નોંધો (આપમેળે પૂરી થશે)',
  },
  revokeTitle: { en: 'Revoke this override now', hi: 'यह छूट अभी हटाएँ', gu: 'આ છૂટ હમણાં હટાવો' },
  revokeAria: { en: 'Revoke override', hi: 'छूट हटाएँ', gu: 'છૂટ હટાવો' },
  // the override form
  overrideIntro: {
    en: 'An override is a recorded exception in your name: it needs a reason, it always expires, and the derived value returns when it does.',
    hi: 'छूट आपके नाम से दर्ज एक अपवाद है: इसके लिए कारण चाहिए, यह हमेशा ख़त्म होती है, और तब अपने-आप तय स्थिति लौट आती है।',
    gu: 'છૂટ તમારા નામે નોંધાયેલો અપવાદ છે: તેને કારણ જોઈએ, તે હંમેશાં પૂરી થાય છે, અને ત્યારે આપમેળે નક્કી થતી સ્થિતિ પાછી આવે છે.',
  },
  gate: { en: 'Gate', hi: 'शर्त', gu: 'શરત' },
  setTo: { en: 'Set to', hi: 'स्थिति', gu: 'સ્થિતિ' },
  expiresInDays: { en: 'Expires in (days)', hi: 'कितने दिन में ख़त्म', gu: 'કેટલા દિવસે પૂરી' },
  reasonPlaceholder: {
    en: 'Reason (required — e.g. construction set carried on site in print)',
    hi: 'कारण (ज़रूरी — जैसे निर्माण सेट साइट पर छपा हुआ है)',
    gu: 'કારણ (જરૂરી — જેમ કે બાંધકામ સેટ સાઇટ પર છાપેલો છે)',
  },
  cancel: { en: 'Cancel', hi: 'रद्द करें', gu: 'રદ કરો' },
  recordOverride: { en: 'Record override', hi: 'छूट दर्ज करें', gu: 'છૂટ નોંધો' },
  // the plan form
  dayNumbersNote: {
    en: 'Planned dates are day numbers on the schedule timeline; the bar renders from them.',
    hi: 'योजना की तारीख़ें शेड्यूल की समय-रेखा पर दिन के नंबर हैं; पट्टी इन्हीं से बनती है।',
    gu: 'યોજનાની તારીખો શેડ્યૂલની સમયરેખા પર દિવસના નંબર છે; પટ્ટી તેના પરથી બને છે.',
  },
  namePlaceholder: { en: 'Activity (e.g. Master Bath Tiling)', hi: 'काम (जैसे मास्टर बाथ टाइलिंग)', gu: 'કામ (જેમ કે માસ્ટર બાથ ટાઇલિંગ)' },
  zonePlaceholder: {
    en: 'Zone (free text — or pick a location below)',
    hi: 'ज़ोन (अपने शब्दों में — या नीचे जगह चुनें)',
    gu: 'ઝોન (તમારા શબ્દોમાં — અથવા નીચે જગ્યા પસંદ કરો)',
  },
  locationOptional: { en: 'LOCATION (OPTIONAL)', hi: 'जगह (वैकल्पिक)', gu: 'જગ્યા (વૈકલ્પિક)' },
  starts: { en: 'Starts', hi: 'शुरू', gu: 'શરૂ' },
  ends: { en: 'Ends', hi: 'ख़त्म', gu: 'પૂરું' },
  planStartDay: { en: 'Plan start (day)', hi: 'योजना शुरू (दिन)', gu: 'યોજના શરૂ (દિવસ)' },
  planEndDay: { en: 'Plan end (day)', hi: 'योजना ख़त्म (दिन)', gu: 'યોજના પૂરી (દિવસ)' },
  phase: { en: 'Phase', hi: 'चरण', gu: 'તબક્કો' },
  unphasedOption: { en: '— unphased —', hi: '— बिना चरण —', gu: '— તબક્કા વગર —' },
  linkedDecision: { en: 'Linked decision', hi: 'जुड़ा निर्णय', gu: 'જોડાયેલો નિર્ણય' },
  noneOption: { en: '— none —', hi: '— कोई नहीं —', gu: '— કોઈ નહીં —' },
  materialGate: { en: 'Material gate', hi: 'सामान की शर्त', gu: 'માલસામાનની શરત' },
  teamGate: { en: 'Team gate', hi: 'टीम की शर्त', gu: 'ટીમની શરત' },
  derivedNote: {
    en: 'The Decision, Inspection and Drawing gates are derived from the linked records — they cannot be set by hand (a PMC can record an expiring override from the schedule row).',
    hi: 'निर्णय, निरीक्षण और ड्रॉइंग की शर्तें जुड़े रिकॉर्ड से अपने-आप तय होती हैं — इन्हें हाथ से नहीं बदला जा सकता (PMC शेड्यूल की पंक्ति से समय-सीमा वाली छूट दर्ज कर सकते हैं)।',
    gu: 'નિર્ણય, નિરીક્ષણ અને ડ્રોઇંગની શરતો જોડાયેલા રેકોર્ડ પરથી આપમેળે નક્કી થાય છે — તેને હાથથી બદલી શકાતી નથી (PMC શેડ્યૂલની હરોળમાંથી સમયમર્યાદાવાળી છૂટ નોંધી શકે છે).',
  },
  delete: { en: 'Delete', hi: 'हटाएँ', gu: 'હટાવો' },
  save: { en: 'Save', hi: 'सहेजें', gu: 'સાચવો' },
  addToPlan: { en: 'Add to plan', hi: 'योजना में जोड़ें', gu: 'યોજનામાં ઉમેરો' },
  deleteActivity: { en: 'Delete activity', hi: 'काम हटाएँ', gu: 'કામ હટાવો' },
  deleteNote: {
    en: 'It is removed from the schedule for everyone. A drawing that governs it is kept and no longer linked to it. Once other records refer to it (an inspection, a material record, a gate override, a schedule link, recorded work or anything else), it can’t be deleted: the server refuses and nothing changes.',
    hi: 'यह सबके लिए शेड्यूल से हट जाएगा। इस पर लागू ड्रॉइंग बनी रहेगी, बस इससे जुड़ी नहीं रहेगी। अगर दूसरे रिकॉर्ड इसका ज़िक्र करते हैं (निरीक्षण, सामान का रिकॉर्ड, शर्त की छूट, शेड्यूल लिंक, दर्ज काम या कुछ और), तो इसे हटाया नहीं जा सकता: सर्वर मना कर देता है और कुछ नहीं बदलता।',
    gu: 'તે બધા માટે શેડ્યૂલમાંથી હટી જશે. તેના પર લાગુ ડ્રોઇંગ રહેશે, ફક્ત તેની સાથે જોડાયેલું નહીં રહે. જો બીજા રેકોર્ડ તેનો ઉલ્લેખ કરે (નિરીક્ષણ, માલસામાનનો રેકોર્ડ, શરતની છૂટ, શેડ્યૂલ લિંક, નોંધાયેલું કામ કે બીજું કંઈ), તો તેને હટાવી શકાતું નથી: સર્વર ના પાડે છે અને કંઈ બદલાતું નથી.',
  },
  phaseNamePlaceholder: { en: 'Phase name (e.g. Finishing)', hi: 'चरण का नाम (जैसे फ़िनिशिंग)', gu: 'તબક્કાનું નામ (જેમ કે ફિનિશિંગ)' },
  add: { en: 'Add', hi: 'जोड़ें', gu: 'ઉમેરો' },
} satisfies Record<string, Words>;

/** The activity status chip. */
export const activityStatusLabels: Record<ActivityStatus, Words> = {
  done: { en: 'DONE', hi: 'पूरा', gu: 'પૂરું' },
  'in-progress': { en: 'IN PROGRESS', hi: 'चल रहा', gu: 'ચાલુ' },
  'awaiting-signoff': { en: 'AWAITING SIGN-OFF', hi: 'मंज़ूरी बाकी', gu: 'મંજૂરી બાકી' },
  'not-started': { en: 'NOT STARTED', hi: 'शुरू नहीं', gu: 'શરૂ નથી' },
  blocked: { en: 'BLOCKED', hi: 'रुका', gu: 'અટકેલું' },
};

/** A phase's count chips. */
export const phaseCountLabels = {
  running: { en: 'running', hi: 'चल रहे', gu: 'ચાલુ' },
  awaitingSignoff: { en: 'awaiting sign-off', hi: 'मंज़ूरी बाकी', gu: 'મંજૂરી બાકી' },
  blocked: { en: 'blocked', hi: 'रुके', gu: 'અટકેલાં' },
  toStart: { en: 'to start', hi: 'शुरू होने बाकी', gu: 'શરૂ થવાનાં' },
} satisfies Record<string, Words>;

/** The five readiness gates: the dot's short key, its name, and the override form's choice. */
export type GateKey = 'D' | 'M' | 'T' | 'I' | 'DRW';
export const gateNames: Record<GateKey, { short: Words; label: Words }> = {
  D: { short: { en: 'D', hi: 'नि', gu: 'નિ' }, label: { en: 'Decision locked', hi: 'निर्णय लॉक', gu: 'નિર્ણય લૉક' } },
  M: { short: { en: 'M', hi: 'सा', gu: 'મા' }, label: { en: 'Material on site', hi: 'सामान साइट पर', gu: 'માલસામાન સાઇટ પર' } },
  T: { short: { en: 'T', hi: 'टी', gu: 'ટી' }, label: { en: 'Team present', hi: 'टीम मौजूद', gu: 'ટીમ હાજર' } },
  I: { short: { en: 'I', hi: 'जाँ', gu: 'તપ' }, label: { en: 'Inspection passed', hi: 'निरीक्षण पास', gu: 'નિરીક્ષણ પાસ' } },
  DRW: { short: { en: 'DRW', hi: 'ड्रॉ', gu: 'ડ્રો' }, label: { en: 'Drawings acknowledged', hi: 'ड्रॉइंग की पुष्टि', gu: 'ડ્રોઇંગની પુષ્ટિ' } },
};
/** The gate an override names, as a choice; English keeps the stored key, as before. */
export const overrideGateNames: Record<OverridableGate, Words> = {
  decision: { en: 'decision', hi: 'निर्णय', gu: 'નિર્ણય' },
  material: { en: 'material', hi: 'सामान', gu: 'માલસામાન' },
  team: { en: 'team', hi: 'टीम', gu: 'ટીમ' },
  inspection: { en: 'inspection', hi: 'निरीक्षण', gu: 'નિરીક્ષણ' },
  drawing: { en: 'drawing', hi: 'ड्रॉइंग', gu: 'ડ્રોઇંગ' },
};
/** A gate value, as a choice; English keeps the stored key, as before. */
export const gateValueNames: Record<Gate, Words> = {
  na: { en: 'na', hi: 'लागू नहीं', gu: 'લાગુ નથી' },
  wait: { en: 'wait', hi: 'इंतज़ार', gu: 'રાહ' },
  ok: { en: 'ok', hi: 'तैयार', gu: 'તૈયાર' },
  fail: { en: 'fail', hi: 'फ़ेल', gu: 'નાપાસ' },
};

const DECIDER: Record<string, Record<NonEn, string>> = {
  'the PMC': { hi: 'PMC', gu: 'PMC' },
  'the named decider': { hi: 'नामित निर्णयकर्ता', gu: 'નામિત નિર્ણય લેનાર' },
  'the architect': { hi: 'आर्किटेक्ट', gu: 'આર્કિટેક્ટ' },
  'the client': { hi: 'क्लाइंट', gu: 'ક્લાયન્ટ' },
};
const NOUN = '(the PMC|the named decider|the architect|the client)';

const EXACT: Record<string, Record<NonEn, string>> = {
  'No linked inspection': { hi: 'कोई जुड़ा निरीक्षण नहीं', gu: 'કોઈ જોડાયેલું નિરીક્ષણ નથી' },
  'All linked inspections accepted': { hi: 'सभी जुड़े निरीक्षण स्वीकार', gu: 'બધાં જોડાયેલાં નિરીક્ષણ સ્વીકાર્યાં' },
  'No linked drawing': { hi: 'कोई जुड़ी ड्रॉइंग नहीं', gu: 'કોઈ જોડાયેલું ડ્રોઇંગ નથી' },
  'No linked decision': { hi: 'कोई जुड़ा निर्णय नहीं', gu: 'કોઈ જોડાયેલો નિર્ણય નથી' },
  'Decision approved and locked': { hi: 'निर्णय मंज़ूर और लॉक', gu: 'નિર્ણય મંજૂર અને લૉક' },
  'The linked decision was withdrawn — re-issue or relink': {
    hi: 'जुड़ा निर्णय वापस लिया गया — फिर से जारी करें या दूसरा जोड़ें',
    gu: 'જોડાયેલો નિર્ણય પાછો ખેંચાયો — ફરી જારી કરો અથવા બીજો જોડો',
  },
  'Awaiting the PMC on the linked decision': { hi: 'जुड़े निर्णय पर PMC का इंतज़ार', gu: 'જોડાયેલા નિર્ણય પર PMC ની રાહ' },
  'Record only — no approval required': { hi: 'सिर्फ़ रिकॉर्ड — मंज़ूरी ज़रूरी नहीं', gu: 'ફક્ત રેકોર્ડ — મંજૂરી જરૂરી નથી' },
  'The linked record is unpublished — publish it': {
    hi: 'जुड़ा रिकॉर्ड अभी जारी नहीं हुआ — इसे जारी करें',
    gu: 'જોડાયેલો રેકોર્ડ હજી જારી થયો નથી — તેને જારી કરો',
  },
  'Stored site flag — material on site': { hi: 'साइट पर दर्ज निशान — सामान साइट पर', gu: 'સાઇટ પર નોંધાયેલ નિશાન — માલસામાન સાઇટ પર' },
  'Stored site flag — team present': { hi: 'साइट पर दर्ज निशान — टीम मौजूद', gu: 'સાઇટ પર નોંધાયેલ નિશાન — ટીમ હાજર' },
  'Stored site flag (demo)': { hi: 'साइट पर दर्ज निशान (डेमो)', gu: 'સાઇટ પર નોંધાયેલ નિશાન (ડેમો)' },
  // the material and labour pilots' own fixed sentences (api material-readiness.ts, team-readiness.ts,
  // labour-coverage.service.ts) — Codex #912
  'Material ≠ approved — unresolved site mismatch (§A)': {
    hi: 'सामान मंज़ूर से अलग — साइट पर गड़बड़ी अभी सुलझी नहीं (§A)',
    gu: 'માલસામાન મંજૂરથી અલગ — સાઇટ પરની ગડબડ હજી ઉકલી નથી (§A)',
  },
  'No material requirement for this activity': { hi: 'इस काम के लिए सामान की कोई ज़रूरत नहीं', gu: 'આ કામ માટે માલસામાનની કોઈ જરૂર નથી' },
  'Crew ≠ allocated — unresolved labour mismatch (§A)': {
    hi: 'टीम तय से अलग — मज़दूरों की गड़बड़ी अभी सुलझी नहीं (§A)',
    gu: 'ટીમ ફાળવણીથી અલગ — મજૂરોની ગડબડ હજી ઉકલી નથી (§A)',
  },
  'No labour requirement for this activity': { hi: 'इस काम के लिए मज़दूरों की कोई ज़रूरत नहीं', gu: 'આ કામ માટે મજૂરોની કોઈ જરૂર નથી' },
  "Labour present for today's demand (§A)": { hi: 'आज की ज़रूरत के मज़दूर मौजूद (§A)', gu: 'આજની જરૂરિયાતના મજૂરો હાજર (§A)' },
  'Every demanded labour slice up to today is fulfilled (§A)': {
    hi: 'आज तक की हर माँगी गई मज़दूर पाली पूरी (§A)',
    gu: 'આજ સુધીની દરેક માગેલી મજૂર પાળી પૂરી (§A)',
  },
};

const SHIFT: Record<string, Record<NonEn, string>> = { day: { hi: 'दिन', gu: 'દિવસ' }, night: { hi: 'रात', gu: 'રાત' } };
const shiftIn = (shift: string, lang: NonEn): string => SHIFT[shift]?.[lang] ?? shift;
const isoIn = (iso: string, lang: NonEn): string => (/^\d{4}-\d{2}-\d{2}$/.test(iso) ? civilDateIn(iso, lang) : iso);

/** The material and labour coverage sentences with their quantities, units and dates (kept as served). */
const COVERAGE: [RegExp, (m: RegExpExecArray, lang: NonEn) => string][] = [
  [/^Labour window has not begun — first demand slice is (\S+) \(§A\)$/, (m, l) => pick(l, '',
    `मज़दूरों का समय अभी शुरू नहीं हुआ — पहली माँग ${isoIn(m[1], l)} को (§A)`,
    `મજૂરોનો સમય હજી શરૂ થયો નથી — પહેલી માગ ${isoIn(m[1], l)} ના રોજ (§A)`)],
  [/^Overdue labour slice (\S+) unfulfilled — (\d+) of (\d+) person-shifts covered \(§A\)$/, (m, l) => pick(l, '',
    `${isoIn(m[1], l)} की मज़दूर पाली अधूरी — ${m[3]} में से ${m[2]} व्यक्ति-पाली पूरी (§A)`,
    `${isoIn(m[1], l)} ની મજૂર પાળી અધૂરી — ${m[3]} માંથી ${m[2]} વ્યક્તિ-પાળી પૂરી (§A)`)],
  [/^Crew allocated for today — muster pending \((\d+) of (\d+) present, (\S+) (\S+)\) \(§A\)$/, (m, l) => pick(l, '',
    `आज के लिए टीम तय — हाज़िरी बाकी (${m[2]} में से ${m[1]} मौजूद, ${isoIn(m[3], l)} ${shiftIn(m[4], l)}) (§A)`,
    `આજ માટે ટીમ ફાળવી — હાજરી બાકી (${m[2]} માંથી ${m[1]} હાજર, ${isoIn(m[3], l)} ${shiftIn(m[4], l)}) (§A)`)],
  [/^Under-allocated for today's labour demand — (\d+) of (\d+) person-shifts allocated \((\S+) (\S+)\) \(§A\)$/, (m, l) => pick(l, '',
    `आज की मज़दूर माँग के लिए कम लोग — ${m[2]} में से ${m[1]} व्यक्ति-पाली तय (${isoIn(m[3], l)} ${shiftIn(m[4], l)}) (§A)`,
    `આજની મજૂર માગ માટે ઓછા લોકો — ${m[2]} માંથી ${m[1]} વ્યક્તિ-પાળી ફાળવી (${isoIn(m[3], l)} ${shiftIn(m[4], l)}) (§A)`)],
  [/^Covered (\S+) of (\S+) (.+) \(reserved \+ issued\)$/, (m, l) => pick(l, '',
    `${m[2]} ${m[3]} में से ${m[1]} उपलब्ध (आरक्षित + जारी)`,
    `${m[2]} ${m[3]} માંથી ${m[1]} ઉપલબ્ધ (અનામત + આપેલું)`)],
  [/^Short by (\S+) (.+); covering deliveries meet the activity's demand by (\S+)$/, (m, l) => pick(l, '',
    `${m[1]} ${m[2]} कम; आने वाली डिलीवरी ${isoIn(m[3], l)} तक ज़रूरत पूरी करेगी`,
    `${m[1]} ${m[2]} ઓછું; આવનારી ડિલિવરી ${isoIn(m[3], l)} સુધીમાં જરૂર પૂરી કરશે`)],
  [/^Covered (\S+) of (\S+) (.+); the activity is at-risk on another requirement \(covering delivery by (\S+)\)$/, (m, l) => pick(l, '',
    `${m[2]} ${m[3]} में से ${m[1]} उपलब्ध; काम किसी दूसरी ज़रूरत पर जोखिम में है (डिलीवरी ${isoIn(m[4], l)} तक)`,
    `${m[2]} ${m[3]} માંથી ${m[1]} ઉપલબ્ધ; કામ બીજી જરૂરિયાત પર જોખમમાં છે (ડિલિવરી ${isoIn(m[4], l)} સુધીમાં)`)],
  [/^Short by (\S+) (.+) — inbound commitments cannot cover the activity's demand$/, (m, l) => pick(l, '',
    `${m[1]} ${m[2]} कम — आने वाली डिलीवरी से ज़रूरत पूरी नहीं होगी`,
    `${m[1]} ${m[2]} ઓછું — આવનારી ડિલિવરીથી જરૂર પૂરી નહીં થાય`)],
  [/^Covered (\S+) of (\S+) (.+); the activity is blocked on another requirement$/, (m, l) => pick(l, '',
    `${m[2]} ${m[3]} में से ${m[1]} उपलब्ध; काम किसी दूसरी ज़रूरत पर रुका है`,
    `${m[2]} ${m[3]} માંથી ${m[1]} ઉપલબ્ધ; કામ બીજી જરૂરિયાત પર અટક્યું છે`)],
];

/** The fixed endings of the drawing gate's per-drawing reasons (`<number>: <ending>`). */
const DRAWING_ENDINGS: [RegExp, (m: RegExpExecArray, lang: NonEn) => string][] = [
  [/^no construction revision governs \(review-only or superseded out\)$/, (_m, l) => pick(l, '', 'निर्माण के लिए कोई संशोधन लागू नहीं (सिर्फ़ समीक्षा या पुराना)', 'બાંધકામ માટે કોઈ સંસ્કરણ લાગુ નથી (ફક્ત સમીક્ષા કે જૂનું)')],
  [/^legacy revision acknowledged$/, (_m, l) => pick(l, '', 'पुराने संशोधन की पुष्टि हुई', 'જૂના સંસ્કરણની પુષ્ટિ થઈ')],
  [/^legacy revision awaiting a first acknowledgement$/, (_m, l) => pick(l, '', 'पुराने संशोधन की पहली पुष्टि का इंतज़ार', 'જૂના સંસ્કરણની પહેલી પુષ્ટિની રાહ')],
  [/^nobody currently on the project confirmed the governing set — re-issue or override$/, (_m, l) => pick(l, '', 'अभी प्रोजेक्ट पर किसी ने लागू सेट की पुष्टि नहीं की — फिर से जारी करें या छूट दें', 'હાલ પ્રોજેક્ટ પર કોઈએ લાગુ સેટની પુષ્ટિ કરી નથી — ફરી જારી કરો અથવા છૂટ આપો')],
  [/^awaiting acknowledgement \((\d+)\/(\d+)\)$/, (m, l) => pick(l, '', `पुष्टि का इंतज़ार (${m[1]}/${m[2]})`, `પુષ્ટિની રાહ (${m[1]}/${m[2]})`)],
  [/^current set acknowledged by every active recipient$/, (_m, l) => pick(l, '', 'सभी मौजूदा लोगों ने ताज़ा सेट की पुष्टि की', 'બધા હાજર લોકોએ તાજા સેટની પુષ્ટિ કરી')],
];

/**
 * A gate's reason in the reader's language. The reasons are the readiness tables' own fixed sentences
 * (`domain/readiness.ts`, served as text), so each is matched whole against that closed set; ids and drawing
 * numbers inside them are kept exactly as served. An override's reason is what the PMC typed, and anything
 * unrecognised (a newer server's sentence) is shown as served.
 */
export function gateReasonIn(reason: string, source: GateSource, lang: Lang): string {
  if (lang === 'en' || source === 'override') return reason;
  const exact = EXACT[reason];
  if (exact) return exact[lang];
  for (const [re, say] of COVERAGE) {
    const c = re.exec(reason);
    if (c) return say(c, lang);
  }
  let m = /^Awaiting inspection (\S+)$/.exec(reason);
  if (m) return pick(lang, '', `निरीक्षण ${m[1]} का इंतज़ार`, `નિરીક્ષણ ${m[1]} ની રાહ`);
  m = /^Correction chain open — the rejection of (\S+) is not yet made good$/.exec(reason);
  if (m) return pick(lang, '', `सुधार बाकी — ${m[1]} की नामंज़ूरी अभी ठीक नहीं हुई`, `સુધારો બાકી — ${m[1]} નો અસ્વીકાર હજી સુધર્યો નથી`);
  m = new RegExp(`^Change requested — awaiting ${NOUN}’s re-approval$`).exec(reason);
  if (m) return pick(lang, '', `बदलाव माँगा गया — ${DECIDER[m[1]].hi} की दोबारा मंज़ूरी का इंतज़ार`, `ફેરફાર માગ્યો — ${DECIDER[m[1]].gu} ની ફરી મંજૂરીની રાહ`);
  m = new RegExp(`^Approved by ${NOUN} — awaiting the architect’s countersign$`).exec(reason);
  if (m) return pick(lang, '', `${DECIDER[m[1]].hi} ने मंज़ूर किया — आर्किटेक्ट के प्रति-हस्ताक्षर का इंतज़ार`, `${DECIDER[m[1]].gu} એ મંજૂર કર્યું — આર્કિટેક્ટની સહીની રાહ`);
  m = new RegExp(`^Awaiting ${NOUN}’s approval$`).exec(reason);
  if (m) return pick(lang, '', `${DECIDER[m[1]].hi} की मंज़ूरी का इंतज़ार`, `${DECIDER[m[1]].gu} ની મંજૂરીની રાહ`);
  // `<number>: <ending>` — the number is everything before the LAST ": " whose ending is one of the fixed ones
  const cut = reason.lastIndexOf(': ');
  if (cut > 0) {
    const ending = reason.slice(cut + 2);
    for (const [re, say] of DRAWING_ENDINGS) {
      const e = re.exec(ending);
      if (!e) continue;
      const number = reason.slice(0, cut);
      return `${number === 'drawing' ? pick(lang, '', 'ड्रॉइंग', 'ડ્રોઇંગ') : number}: ${say(e, lang)}`;
    }
  }
  return reason;
}

/** A dot's full line: "Decision locked — Decision approved and locked (OVERRIDE)". */
export function gateLineIn(k: GateKey, reason: string, source: GateSource, lang: Lang): string {
  const mark = source === 'override'
    ? pick(lang, ' (OVERRIDE)', ' (छूट)', ' (છૂટ)')
    : source === 'stored' ? pick(lang, ' (stored flag)', ' (दर्ज निशान)', ' (નોંધાયેલ નિશાન)') : '';
  return `${gateNames[k].label[lang]} — ${gateReasonIn(reason, source, lang)}${mark}`;
}

/**
 * The blockers the server itself writes into `Activity.block` (api activity.participant.ts) read in the language;
 * a note someone typed is shown as recorded (Codex, #912).
 */
const SYSTEM_BLOCK: Record<string, { hi: string; gu: string }> = {
  'Material ≠ approved': { hi: 'सामान मंज़ूर से अलग', gu: 'માલસામાન મંજૂરથી અલગ' },
  'Crew ≠ allocated': { hi: 'टीम तय से अलग', gu: 'ટીમ ફાળવણીથી અલગ' },
};

function blockIn(block: string, lang: Lang): string {
  if (lang === 'en') return block;
  return SYSTEM_BLOCK[block]?.[lang] ?? block;
}

export const scheduleText = {
  blockedWith: (block: string, lang: Lang): string => pick(lang,
    `Blocked — ${block}. Resolve the blocker on site; the activity returns to the schedule once it clears.`,
    `रुका हुआ — ${blockIn(block, lang)}। साइट पर रुकावट दूर करें; दूर होते ही काम फिर से शेड्यूल में आ जाएगा।`,
    `અટકેલું — ${blockIn(block, lang)}. સાઇટ પર અડચણ દૂર કરો; દૂર થતાં કામ ફરી શેડ્યૂલમાં આવશે.`),
  /** one gate holds the activity: its name and its reason (English lower-cases the name, as before) */
  cannotStartOne: (label: string, reason: string, lang: Lang): string => pick(lang,
    `Cannot start yet — ${label.toLowerCase()}: ${reason}`,
    `अभी शुरू नहीं हो सकता — ${label}: ${reason}`,
    `હજી શરૂ થઈ શકતું નથી — ${label}: ${reason}`),
  cannotStartMany: (labels: string[], lang: Lang): string => {
    const names = lang === 'en' ? labels.map((l) => l.toLowerCase()) : labels;
    const head = names.slice(0, -1).join(', ');
    const last = names[names.length - 1];
    return pick(lang,
      `Cannot start yet — waiting on ${head} and ${last}.`,
      `अभी शुरू नहीं हो सकता — ${head} और ${last} का इंतज़ार।`,
      `હજી શરૂ થઈ શકતું નથી — ${head} અને ${last} ની રાહ.`);
  },
  editAria: (name: string, lang: Lang): string => pick(lang, `Edit ${name}`, `${name} बदलें`, `${name} બદલો`),
  governedTitle: (number: string, lang: Lang): string =>
    pick(lang, `Governed by ${number} — open this drawing`, `${number} पर आधारित — यह ड्रॉइंग खोलें`, `${number} પર આધારિત — આ ડ્રોઇંગ ખોલો`),
  rev: (rev: string, lang: Lang): string => pick(lang, `Rev ${rev}`, `संशोधन ${rev}`, `સંસ્કરણ ${rev}`),
  plan: (window: string, lang: Lang): string => pick(lang, `Plan ${window}`, `योजना ${window}`, `યોજના ${window}`),
  actual: (start: string, end: string | null, lang: Lang): string =>
    pick(lang, `Actual ${start} → ${end ?? 'ongoing'}`, `असल ${start} → ${end ?? 'जारी'}`, `ખરેખર ${start} → ${end ?? 'ચાલુ'}`),
  gatesAria: (name: string, open: boolean, lang: Lang): string => pick(lang,
    `Readiness gates for ${name} — ${open ? 'hide' : 'show'} reasons`,
    `${name} की तैयारी की शर्तें — कारण ${open ? 'छिपाएँ' : 'दिखाएँ'}`,
    `${name} ની તૈયારીની શરતો — કારણો ${open ? 'છુપાવો' : 'બતાવો'}`),
  overrideAria: (name: string, lang: Lang): string => pick(lang, `Override a gate on ${name}`, `${name} की शर्त में छूट दें`, `${name} ની શરતમાં છૂટ આપો`),
  overrideChip: (gate: OverridableGate, state: Gate, actor: string, expires: string, reason: string, lang: Lang): string => {
    const g = overrideGateNames[gate]?.[lang] ?? gate;
    const v = gateValueNames[state]?.[lang] ?? state;
    return pick(lang,
      `OVERRIDE · ${gate} → ${state} · ${actor} · expires ${expires} · ${reason}`,
      `छूट · ${g} → ${v} · ${actor} · ${expires} तक · ${reason}`,
      `છૂટ · ${g} → ${v} · ${actor} · ${expires} સુધી · ${reason}`);
  },
  overrideTitle: (name: string, lang: Lang): string => pick(lang, `Override a gate — ${name}`, `शर्त में छूट — ${name}`, `શરતમાં છૂટ — ${name}`),
  phaseWindow: (window: string, lang: Lang): string => pick(lang, `PHASE · ${window}`, `चरण · ${window}`, `તબક્કો · ${window}`),
  removePhaseAria: (name: string, lang: Lang): string => pick(lang, `Remove phase ${name}`, `चरण ${name} हटाएँ`, `તબક્કો ${name} હટાવો`),
  phaseDone: (done: number, total: number, pct: number, lang: Lang): string =>
    pick(lang, `${done}/${total} done · ${pct}%`, `${done}/${total} पूरे · ${pct}%`, `${done}/${total} પૂરાં · ${pct}%`),
  opening: (id: string, lang: Lang): string => pick(lang, `Opening ${id}…`, `${id} खुल रहा है…`, `${id} ખૂલી રહ્યું છે…`),
  projectSpan: (start: string, end: string, lang: Lang): string => pick(lang, `Project ${start} → ${end}`, `प्रोजेक्ट ${start} → ${end}`, `પ્રોજેક્ટ ${start} → ${end}`),
  elapsed: (pct: number, lang: Lang): string => pick(lang, `${pct}% time elapsed`, `${pct}% समय बीता`, `${pct}% સમય વીત્યો`),
  removePhaseTitle: (name: string, lang: Lang): string => pick(lang, `Remove the ${name} phase?`, `${name} चरण हटाएँ?`, `${name} તબક્કો હટાવીએ?`),
  placeCount: (n: number, place: string, lang: Lang): string =>
    pick(lang, `${n} ${n === 1 ? 'activity' : 'activities'} at ${place} and inside it`, `${place} और उसके अंदर ${n} काम`, `${place} અને તેની અંદર ${n} કામ`),
  placeEmpty: (place: string, lang: Lang): string =>
    pick(lang, `No activities are placed at ${place} yet.`, `${place} पर अभी कोई काम नहीं रखा गया।`, `${place} પર હજી કોઈ કામ મૂક્યું નથી.`),
  editTitle: (id: string, lang: Lang): string => pick(lang, `Edit ${id}`, `${id} बदलें`, `${id} બદલો`),
  deleteTitle: (id: string, name: string, lang: Lang): string => pick(lang, `Delete ${id} · ${name}?`, `${id} · ${name} हटाएँ?`, `${id} · ${name} હટાવીએ?`),
  days: (n: number, lang: Lang): string => pick(lang, n === 1 ? '1 day' : `${n} days`, `${n} दिन`, `${n} દિવસ`),
  /** the closing line, as [text, bold] pieces */
  footer: (lang: Lang): [string, boolean][] =>
    lang === 'hi'
      ? [['हर काम तभी ', false], ['शुरू', true], [' हो सकता है जब चारों शर्तें पूरी हों — ', false], ['निर्णय', true], [' लॉक हो, मंज़ूर ', false], ['सामान', true], [' साइट पर हो, ', false], ['टीम', true], [' मौजूद हो, और काम से पहले का ', false], ['निरीक्षण', true], [' पास हो। आख़िरी निरीक्षण के बाद ही इसे ', false], ['पूरा', true], [' माना जा सकता है।', false]]
      : lang === 'gu'
        ? [['દરેક કામ ત્યારે જ ', false], ['શરૂ', true], [' થઈ શકે જ્યારે ચારેય શરતો પૂરી થાય — ', false], ['નિર્ણય', true], [' લૉક હોય, મંજૂર ', false], ['માલસામાન', true], [' સાઇટ પર હોય, ', false], ['ટીમ', true], [' હાજર હોય, અને કામ પહેલાંનું ', false], ['નિરીક્ષણ', true], [' પાસ થયું હોય. છેલ્લા નિરીક્ષણ પછી જ તેને ', false], ['પૂરું', true], [' ગણી શકાય.', false]]
        : [['Each activity can only ', false], ['Start', true], [' when its four gates align — the ', false], ['Decision', true], [' is locked, the approved ', false], ['Material', true], [' is on site, the ', false], ['Team', true], [' is present, and the pre-work ', false], ['Inspection', true], [' has passed. It can only be marked ', false], ['Done', true], [' after its closing inspection.', false]],
};

const LOCALE: Record<NonEn, string> = { hi: 'hi-IN', gu: 'gu-IN' };
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** An ISO civil date as the schedule shows it ("14 Oct 2026"), in the reader's month names. */
export function civilDateIn(iso: string, lang: NonEn): string {
  const at = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(at.getTime())) return iso;
  return new Intl.DateTimeFormat(LOCALE[lang], { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(at);
}

/** A served "14 Oct 2026" or "3 Jul" (the project's own fixed formats) in the reader's month names; anything
 *  else is shown as served. A day with no year is formatted without one. */
export function servedDayIn(text: string, lang: Lang): string {
  if (lang === 'en') return text;
  const m = /^(\d{1,2}) ([A-Z][a-z]{2})(?: (\d{4}))?$/.exec(text.trim());
  const month = m ? MONTHS.indexOf(m[2]) : -1;
  if (!m || month < 0) return text;
  const at = new Date(Date.UTC(m[3] ? Number(m[3]) : 2026, month, Number(m[1])));
  // a day the calendar does not have ("31 Feb") is shown as recorded, never rolled into the next month (Codex, #912)
  if (at.getUTCMonth() !== month || at.getUTCDate() !== Number(m[1])) return text;
  return new Intl.DateTimeFormat(LOCALE[lang], { day: 'numeric', month: 'short', ...(m[3] ? { year: 'numeric' } : {}), timeZone: 'UTC' }).format(at);
}

/** What the schedule's actions say back. */
export const scheduleToast = {
  planningNeedsServer: { en: 'Planning needs the server.', hi: 'योजना बनाने के लिए सर्वर चाहिए।', gu: 'આયોજન માટે સર્વર જોઈએ.' },
  updated: { en: 'Schedule updated.', hi: 'शेड्यूल अपडेट हुआ।', gu: 'શેડ્યૂલ અપડેટ થયું.' },
  removed: { en: 'Activity removed from the plan.', hi: 'काम योजना से हटाया गया।', gu: 'કામ યોજનામાંથી હટાવ્યું.' },
  overridesNeedServer: { en: 'Gate overrides need the server.', hi: 'शर्त की छूट के लिए सर्वर चाहिए।', gu: 'શરતની છૂટ માટે સર્વર જોઈએ.' },
  overrideRecorded: { en: 'Override recorded — it expires automatically.', hi: 'छूट दर्ज हुई — यह अपने-आप ख़त्म होगी।', gu: 'છૂટ નોંધાઈ — તે આપમેળે પૂરી થશે.' },
  overrideRevoked: {
    en: 'Override revoked — derived readiness applies again.',
    hi: 'छूट हटाई गई — अब फिर से अपने-आप तय तैयारी लागू है।',
    gu: 'છૂટ હટાવી — હવે ફરી આપમેળે નક્કી તૈયારી લાગુ છે.',
  },
  phaseRemoved: { en: 'Phase removed — its activities stay in the flat list.', hi: 'चरण हटाया — इसके काम सूची में बने रहेंगे।', gu: 'તબક્કો હટાવ્યો — તેનાં કામ યાદીમાં રહેશે.' },
  started: {
    en: 'Activity started — planned dates now tracking against actual.',
    hi: 'काम शुरू हुआ — अब योजना की तारीख़ें असल से मिलाई जा रही हैं।',
    gu: 'કામ શરૂ થયું — હવે યોજનાની તારીખો ખરેખર સાથે સરખાવાય છે.',
  },
  claimed: {
    en: 'Completion claimed — the PMC’s closing sign-off will mark it done.',
    hi: 'पूरा होने का दावा भेजा — PMC की आख़िरी मंज़ूरी से यह पूरा होगा।',
    gu: 'પૂરું થયાનો દાવો મોકલ્યો — PMC ની છેલ્લી મંજૂરીથી તે પૂરું થશે.',
  },
} satisfies Record<string, Words>;

/**
 * The server's own refusals of an activity or phase removal (api activities.service.ts / phases.service.ts),
 * plus the client's fallback for a refusal with no message, matched whole; the activity id stays as served and anything else is shown as served (Codex, #912).
 */
function refusalIn(why: string, lang: Lang): string {
  if (lang === 'en') return why;
  if (why === 'This activity has linked records (inspections/materials) — it can no longer be deleted') {
    return pick(lang, '', 'इस काम से रिकॉर्ड जुड़े हैं (निरीक्षण/सामान) — अब इसे हटाया नहीं जा सकता', 'આ કામ સાથે રેકોર્ડ જોડાયેલા છે (નિરીક્ષણ/માલસામાન) — હવે તેને હટાવી શકાય નહીં');
  }
  if (why === 'Phase not found') return pick(lang, '', 'चरण नहीं मिला', 'તબક્કો મળ્યો નહીં');
  const m = /^Activity (\S+) not found$/.exec(why);
  if (m) return pick(lang, '', `काम ${m[1]} नहीं मिला`, `કામ ${m[1]} મળ્યું નહીં`);
  // the web client's own words when a refusal carries no readable message (store.ts runRemote)
  if (why === 'the server refused it') return pick(lang, '', 'सर्वर ने मना कर दिया', 'સર્વરે ના પાડી');
  return why;
}

export const scheduleToastText = {
  planned: (name: string, lang: Lang): string => pick(lang, `Planned: ${name}.`, `योजना में जोड़ा: ${name}।`, `યોજનામાં ઉમેર્યું: ${name}.`),
  deleteRefused: (why: string, lang: Lang): string =>
    pick(lang, `Couldn't delete this activity — ${why}`, `यह काम हटाया नहीं जा सका — ${refusalIn(why, lang)}`, `આ કામ હટાવી શકાયું નહીં — ${refusalIn(why, lang)}`),
  phaseAdded: (name: string, lang: Lang): string => pick(lang, `Phase added: ${name}.`, `चरण जोड़ा: ${name}।`, `તબક્કો ઉમેર્યો: ${name}.`),
  phaseRefused: (why: string, lang: Lang): string =>
    pick(lang, `Couldn't remove this phase — ${why}`, `यह चरण हटाया नहीं जा सका — ${refusalIn(why, lang)}`, `આ તબક્કો હટાવી શકાયો નહીં — ${refusalIn(why, lang)}`),
  /** the queued command's name in the "saved offline" line */
  startCommand: (id: string, lang: Lang): string => pick(lang, `Start ${id}`, `${id} शुरू करना`, `${id} શરૂ કરવું`),
  completeCommand: (id: string, lang: Lang): string => pick(lang, `Complete ${id}`, `${id} पूरा करना`, `${id} પૂરું કરવું`),
};

/** The date picker's own words. */
export const datePickerText = {
  previous: { en: 'Previous month', hi: 'पिछला महीना', gu: 'પાછલો મહિનો' },
  next: { en: 'Next month', hi: 'अगला महीना', gu: 'આગલો મહિનો' },
  calendar: (label: string, lang: Lang): string => pick(lang, `${label} calendar`, `${label} कैलेंडर`, `${label} કૅલેન્ડર`),
};

/** "Cancel" / "Close" on the shared confirmation dialog. */
export const confirmDialogLabels = {
  cancel: { en: 'Cancel', hi: 'रद्द करें', gu: 'રદ કરો' },
  close: { en: 'Close', hi: 'बंद करें', gu: 'બંધ કરો' },
} satisfies Record<string, Words>;
