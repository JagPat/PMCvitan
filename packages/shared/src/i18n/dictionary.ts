/**
 * i18n dictionaries (English / हिंदी / ગુજરાતી).
 *
 * Ported from the prototype's `L()` dictionary plus the trade/worker label maps
 * that were inlined in `renderVals()`. The site- and worker-facing flows are
 * fully translated; short simple English elsewhere. Exposed both as structured
 * objects and as an i18next `resources` bundle (namespaces: access, trades, workerTrades).
 */

import type { DeciderKind, Lang, ScreenKey } from '../domain/types';

export interface AccessStrings {
  who: string;
  pick: string;
  team: string;
  teamSub: string;
  trade: string;
  tradeSub: string;
  worker: string;
  workerSub: string;
  otp: string;
  sent: string;
  verify: string;
  phoneTitle: string;
  phoneSub: string;
  sendCode: string;
  sending: string;
  resend: string;
  verifying: string;
  wrongCode: string;
  demoCode: string;
  pickTrade: string;
  tapPhoto: string;
  badgeAlt: string;
  today: string;
  layThis: string;
  approved: string;
  listen: string;
  done: string;
  photo: string;
  problem: string;
  hi: string;
  back: string;
  signedIn: string;
  changeLang: string;
}

export const accessDict: Record<Lang, AccessStrings> = {
  en: { who: 'Who are you?', pick: 'Choose your language', team: 'Team member', teamSub: 'Architect · Engineer · Client', trade: 'Trade in-charge', tradeSub: 'Plumbing · Electrical · Carpentry', worker: 'Worker', workerSub: 'Tap your photo — no password', otp: 'Enter the 4-digit SMS code', sent: 'Code sent to', verify: 'Verify', phoneTitle: 'Your mobile number', phoneSub: "We'll text you a 4-digit code", sendCode: 'Send code', sending: 'Sending…', resend: 'Resend code', verifying: 'Verifying…', wrongCode: 'Wrong code — try again', demoCode: 'Demo code', pickTrade: 'Which trade?', tapPhoto: 'Tap your photo to start', badgeAlt: 'or scan your gate badge', today: "Today's work", layThis: 'Lay THIS', approved: 'Approved by architect', listen: 'Listen', done: 'Done', photo: 'Photo', problem: 'Problem', hi: 'Namaste', back: 'Back', signedIn: 'Signed in', changeLang: 'भाषा' },
  hi: { who: 'आप कौन हैं?', pick: 'अपनी भाषा चुनें', team: 'टीम सदस्य', teamSub: 'आर्किटेक्ट · इंजीनियर · क्लाइंट', trade: 'मिस्त्री / इंचार्ज', tradeSub: 'प्लंबिंग · बिजली · बढ़ई', worker: 'मज़दूर', workerSub: 'अपनी फ़ोटो दबाएँ — पासवर्ड नहीं', otp: 'SMS का 4 अंकों का कोड डालें', sent: 'कोड भेजा गया', verify: 'आगे बढ़ें', phoneTitle: 'आपका मोबाइल नंबर', phoneSub: 'हम आपको 4 अंकों का कोड भेजेंगे', sendCode: 'कोड भेजें', sending: 'भेज रहे हैं…', resend: 'कोड फिर भेजें', verifying: 'जाँच रहे हैं…', wrongCode: 'गलत कोड — फिर से', demoCode: 'डेमो कोड', pickTrade: 'कौन सा काम?', tapPhoto: 'शुरू करने के लिए अपनी फ़ोटो दबाएँ', badgeAlt: 'या अपना गेट बैज स्कैन करें', today: 'आज का काम', layThis: 'यह लगाएँ', approved: 'आर्किटेक्ट ने मंज़ूर किया', listen: 'सुनें', done: 'हो गया', photo: 'फ़ोटो', problem: 'दिक्कत', hi: 'नमस्ते', back: 'पीछे', signedIn: 'साइन इन', changeLang: 'Lang' },
  gu: { who: 'તમે કોણ છો?', pick: 'તમારી ભાષા પસંદ કરો', team: 'ટીમ સભ્ય', teamSub: 'આર્કિટેક્ટ · ઇજનેર · ક્લાયન્ટ', trade: 'મિસ્ત્રી / ઇન્ચાર્જ', tradeSub: 'પ્લમ્બિંગ · વીજળી · સુથારી', worker: 'કારીગર', workerSub: 'તમારો ફોટો દબાવો — પાસવર્ડ નહીં', otp: 'SMS નો 4 આંકડાનો કોડ નાખો', sent: 'કોડ મોકલ્યો', verify: 'આગળ વધો', phoneTitle: 'તમારો મોબાઇલ નંબર', phoneSub: 'અમે તમને 4 આંકડાનો કોડ મોકલીશું', sendCode: 'કોડ મોકલો', sending: 'મોકલી રહ્યા છીએ…', resend: 'કોડ ફરી મોકલો', verifying: 'ચકાસી રહ્યા છીએ…', wrongCode: 'ખોટો કોડ — ફરી પ્રયાસ કરો', demoCode: 'ડેમો કોડ', pickTrade: 'કયું કામ?', tapPhoto: 'શરૂ કરવા તમારો ફોટો દબાવો', badgeAlt: 'અથવા તમારો ગેટ બેજ સ્કેન કરો', today: 'આજનું કામ', layThis: 'આ લગાવો', approved: 'આર્કિટેક્ટે મંજૂર કર્યું', listen: 'સાંભળો', done: 'થઈ ગયું', photo: 'ફોટો', problem: 'તકલીફ', hi: 'નમસ્તે', back: 'પાછળ', signedIn: 'સાઇન ઇન', changeLang: 'Lang' },
};

/** Trade labels for the trade picker (5 trades). */
export const tradeLabels: Record<string, Record<Lang, string>> = {
  Plumbing: { en: 'Plumbing', hi: 'प्लंबिंग', gu: 'પ્લમ્બિંગ' },
  Electrical: { en: 'Electrical', hi: 'बिजली', gu: 'વીજળી' },
  Carpentry: { en: 'Carpentry', hi: 'बढ़ई', gu: 'સુથારી' },
  Tiling: { en: 'Tiling', hi: 'टाइल', gu: 'ટાઇલ' },
  Masonry: { en: 'Masonry', hi: 'चिनाई', gu: 'ચણતર' },
};

/** Worker trade display names (worker "tap your photo" grid). */
export const workerTradeLabels: Record<string, Record<Lang, string>> = {
  Mason: { en: 'Mason', hi: 'राजमिस्त्री', gu: 'કડિયો' },
  Plumber: { en: 'Plumber', hi: 'प्लंबर', gu: 'પ્લમ્બર' },
  Helper: { en: 'Helper', hi: 'हेल्पर', gu: 'હેલ્પર' },
  Electrician: { en: 'Electrician', hi: 'इलेक्ट्रिशियन', gu: 'ઇલેક્ટ્રિશિયન' },
};

/** Phase 4 Task 6 (§J) — site-facing labour labels (attendance is a field surface, so the
 *  worker-visible strings are fully translated like the access/trade dictionaries). */
export const labourLabels: Record<string, Record<Lang, string>> = {
  attendance: { en: 'Attendance', hi: 'हाज़िरी', gu: 'હાજરી' },
  present: { en: 'Present', hi: 'हाज़िर', gu: 'હાજર' },
  crew: { en: 'Crew', hi: 'टोली', gu: 'ટોળી' },
  worker: { en: 'Worker', hi: 'मज़दूर', gu: 'કારીગર' },
  shiftDay: { en: 'Day shift', hi: 'दिन की पाली', gu: 'દિવસની પાળી' },
  shiftNight: { en: 'Night shift', hi: 'रात की पाली', gu: 'રાતની પાળી' },
  mismatch: { en: 'Crew ≠ allocated', hi: 'टोली ≠ आवंटित', gu: 'ટોળી ≠ ફાળવેલ' },
};

/** UX foundations — the mobile tab bar and More sheet in the viewer's language. English keeps the
 *  existing short labels (`SCREEN_META.short`); hi/gu are plain words a site engineer uses.
 *  B9 (F-11): English names one screen one way everywhere — "Site Map" (not "Places") and
 *  "Decision Log" (not "Log"); hi/gu wording awaits a native speaker's review. */
export const navLabels: Record<ScreenKey, Record<Lang, string>> = {
  inbox: { en: 'For You', hi: 'आपके लिए', gu: 'તમારા માટે' },
  dashboard: { en: 'Home', hi: 'होम', gu: 'હોમ' },
  drafts: { en: 'Drafts', hi: 'ड्राफ़्ट', gu: 'ડ્રાફ્ટ' },
  'site-schedule': { en: 'Schedule', hi: 'समय-सारणी', gu: 'સમયપત્રક' },
  'decision-log': { en: 'Decision Log', hi: 'निर्णय', gu: 'નિર્ણયો' },
  'inspect-review': { en: 'Review', hi: 'जाँच', gu: 'ચકાસણી' },
  'client-decisions': { en: 'Decisions', hi: 'मंज़ूरी', gu: 'મંજૂરી' },
  'client-health': { en: 'Health', hi: 'प्रगति', gu: 'પ્રગતિ' },
  'daily-log': { en: 'Daily', hi: 'रोज़ का लॉग', gu: 'રોજનો લોગ' },
  'engineer-check': { en: 'Checklist', hi: 'चेकलिस्ट', gu: 'ચેકલિસ્ટ' },
  drawings: { en: 'Drawings', hi: 'ड्रॉइंग', gu: 'ડ્રોઇંગ' },
  places: { en: 'Site Map', hi: 'जगहें', gu: 'સ્થળો' },
  team: { en: 'Team', hi: 'टीम', gu: 'ટીમ' },
  portfolio: { en: 'Portfolio', hi: 'पोर्टफ़ोलियो', gu: 'પોર્ટફોલિયો' },
  'team-access': { en: 'Access', hi: 'लॉगिन', gu: 'લૉગિન' },
  materials: { en: 'Materials', hi: 'सामान', gu: 'માલસામાન' },
  labour: { en: 'Labour', hi: 'मज़दूर', gu: 'મજૂરો' },
  commercial: { en: 'Money', hi: 'हिसाब', gu: 'હિસાબ' },
};

/** The engineer's two permanent tabs name the day, not the screen: For You is their "Today", and
 *  the daily site log is their "Site". */
export const engineerNavLabels: Partial<Record<ScreenKey, Record<Lang, string>>> = {
  inbox: { en: 'Today', hi: 'आज', gu: 'આજે' },
  'daily-log': { en: 'Site', hi: 'साइट', gu: 'સાઇટ' },
};

/** The engineer's Today screen: one "do this now" action and the day's four-step path. Plain
 *  words a site engineer reads at a glance; Gujarati and Hindi copy awaits a native speaker's check. */
export type EngineerTodayStep = 'checkIn' | 'crew' | 'photos' | 'send';
export type EngineerTodayAction = 'start' | EngineerTodayStep | 'done';
export const engineerTodayLabels = {
  doNow: { en: 'Do this now', hi: 'अभी यह करें', gu: 'હમણાં આ કરો' },
  path: { en: "Today's path", hi: 'आज के काम', gu: 'આજનાં કામ' },
  done: { en: 'Done', hi: 'हो गया', gu: 'થઈ ગયું' },
  next: { en: 'Next', hi: 'अगला', gu: 'હવે' },
  notRecorded: { en: 'Not recorded', hi: 'दर्ज नहीं', gu: 'નોંધાયું નથી' },
  sendAnyway: { en: 'Nothing more today — send to PMC', hi: 'आज और कुछ नहीं — PMC को भेजें', gu: 'આજે બીજું કંઈ નથી — PMC ને મોકલો' },
  sendThisLog: { en: 'Send this log to PMC', hi: 'यह लॉग PMC को भेजें', gu: 'આ લોગ PMC ને મોકલો' },
  crewThisLog: { en: "Add this log's crew", hi: 'इस लॉग की टीम जोड़ें', gu: 'આ લોગની ટીમ ઉમેરો' },
  crewThisLogDetail: { en: 'Who came, and what material arrived.', hi: 'कौन आया और कौन सा सामान आया।', gu: 'કોણ આવ્યું અને કયો માલ આવ્યો.' },
  alsoWaiting: { en: 'Also waiting on you', hi: 'यह भी आपका इंतज़ार कर रहा है', gu: 'આ પણ તમારી રાહ જુએ છે' },
  loading: { en: "Getting today's log…", hi: 'आज का लॉग आ रहा है…', gu: 'આજનો લોગ આવી રહ્યો છે…' },
  unavailable: { en: "Today's log didn't load", hi: 'आज का लॉग नहीं खुला', gu: 'આજનો લોગ ખૂલ્યો નહીં' },
  unavailableDetail: { en: 'Check your signal, then try again.', hi: 'सिग्नल देखें, फिर दोबारा कोशिश करें।', gu: 'સિગ્નલ તપાસો, પછી ફરી પ્રયાસ કરો.' },
  retry: { en: 'Try again', hi: 'फिर कोशिश करें', gu: 'ફરી પ્રયાસ કરો' },
  pendingStart: { en: "Starting today's log…", hi: 'आज का लॉग शुरू हो रहा है…', gu: 'આજનો લોગ શરૂ થઈ રહ્યો છે…' },
  pendingSend: { en: 'Sending to PMC…', hi: 'PMC को भेज रहे हैं…', gu: 'PMC ને મોકલી રહ્યા છીએ…' },
  savedOffline: { en: 'Saved on this phone. It will go when signal returns.', hi: 'इस फ़ोन पर सेव है। सिग्नल आने पर चला जाएगा।', gu: 'આ ફોનમાં સેવ છે. સિગ્નલ આવશે ત્યારે જશે.' },
  staleDetail: { en: 'Showing the last log we had. Check your signal, then try again.', hi: 'पिछला लॉग दिख रहा है। सिग्नल देखें, फिर दोबारा कोशिश करें।', gu: 'છેલ્લો લોગ દેખાય છે. સિગ્નલ તપાસો, પછી ફરી પ્રયાસ કરો.' },
  step: {
    checkIn: { en: 'Check in', hi: 'हाज़िरी', gu: 'હાજરી' },
    crew: { en: 'Crew & material', hi: 'टीम और सामान', gu: 'ટીમ અને માલ' },
    photos: { en: 'Progress photos', hi: 'काम की फ़ोटो', gu: 'કામના ફોટા' },
    send: { en: 'Send to PMC', hi: 'PMC को भेजें', gu: 'PMC ને મોકલો' },
  } satisfies Record<EngineerTodayStep, Record<Lang, string>>,
  estimate: {
    checkIn: { en: 'About 1 min', hi: 'लगभग 1 मिनट', gu: 'લગભગ 1 મિનિટ' },
    crew: { en: 'About 2 min', hi: 'लगभग 2 मिनट', gu: 'લગભગ 2 મિનિટ' },
    photos: { en: 'About 2 min', hi: 'लगभग 2 मिनट', gu: 'લગભગ 2 મિનિટ' },
    send: { en: 'One tap', hi: 'एक टैप', gu: 'એક ટેપ' },
  } satisfies Record<EngineerTodayStep, Record<Lang, string>>,
  action: {
    start: { en: "Start today's log", hi: 'आज का लॉग शुरू करें', gu: 'આજનો લોગ શરૂ કરો' },
    checkIn: { en: 'Check in at site', hi: 'साइट पर हाज़िरी लगाएँ', gu: 'સાઇટ પર હાજરી પૂરો' },
    crew: { en: "Add today's crew", hi: 'आज की टीम जोड़ें', gu: 'આજની ટીમ ઉમેરો' },
    photos: { en: 'Take progress photos', hi: 'काम की फ़ोटो लें', gu: 'કામના ફોટા લો' },
    send: { en: "Send today's log to PMC", hi: 'आज का लॉग PMC को भेजें', gu: 'આજનો લોગ PMC ને મોકલો' },
    done: { en: "Today's log is with PMC", hi: 'आज का लॉग PMC के पास है', gu: 'આજનો લોગ PMC પાસે છે' },
  } satisfies Record<EngineerTodayAction, Record<Lang, string>>,
  actionDetail: {
    start: { en: 'Begin when work starts on site.', hi: 'साइट पर काम शुरू होते ही शुरू करें।', gu: 'સાઇટ પર કામ શરૂ થાય ત્યારે શરૂ કરો.' },
    checkIn: { en: "Uses this phone's location and a selfie.", hi: 'यह फ़ोन आपकी जगह और एक सेल्फ़ी लेगा।', gu: 'આ ફોન તમારું સ્થાન અને એક સેલ્ફી લેશે.' },
    crew: { en: 'Who came today, and what material arrived.', hi: 'आज कौन आया और कौन सा सामान आया।', gu: 'આજે કોણ આવ્યું અને કયો માલ આવ્યો.' },
    photos: { en: "A few photos of today's work.", hi: 'आज के काम की कुछ फ़ोटो।', gu: 'આજના કામના થોડા ફોટા.' },
    send: { en: 'One tap. PMC sees it straight away.', hi: 'एक टैप। PMC को तुरंत दिखेगा।', gu: 'એક ટેપ. PMC ને તરત દેખાશે.' },
    done: { en: 'Nothing more to log today.', hi: 'आज और कुछ लिखना नहीं है।', gu: 'આજે વધુ કંઈ લખવાનું નથી.' },
  } satisfies Record<EngineerTodayAction, Record<Lang, string>>,
} as const;

/** An earlier day's log that was never sent: named by its own date, never as today's. */
export function engineerTodayOverdue(date: string, lang: Lang): string {
  if (lang === 'hi') return `यह ${date} का लॉग है और अभी भेजा नहीं गया।`;
  if (lang === 'gu') return `આ ${date} નો લોગ છે અને હજી મોકલાયો નથી.`;
  return `This log is for ${date} and hasn't been sent.`;
}

/** The path's title for an earlier day's log. */
export function engineerTodayLogFor(date: string, lang: Lang): string {
  if (lang === 'hi') return `${date} का लॉग`;
  if (lang === 'gu') return `${date} નો લોગ`;
  return `Log for ${date}`;
}

/** "2 of 4 done", in the reader's language. */
export function engineerTodayProgress(done: number, total: number, lang: Lang): string {
  if (lang === 'hi') return `${total} में से ${done} हो गए`;
  if (lang === 'gu') return `${total} માંથી ${done} થયાં`;
  return `${done} of ${total} done`;
}

/** The crew step asked one trade at a time. Trade names are the site's own words (each log carries
 *  its trades forward), so they are shown as recorded; Gujarati and Hindi copy awaits a native
 *  speaker's check. */
export const engineerCrewLabels = {
  back: { en: 'Back to Today', hi: 'आज पर वापस', gu: 'આજે પર પાછા' },
  less: { en: 'One less', hi: 'एक कम', gu: 'એક ઓછો' },
  more: { en: 'One more', hi: 'एक और', gu: 'એક વધુ' },
  next: { en: 'Next', hi: 'आगे', gu: 'આગળ' },
  finish: { en: 'Done — back to Today', hi: 'हो गया — आज पर वापस', gu: 'થઈ ગયું — આજે પર પાછા' },
  nobody: { en: 'Nobody today', hi: 'आज कोई नहीं आया', gu: 'આજે કોઈ નથી આવ્યું' },
  /** the same answer for an earlier day's unsent log, which is not today's */
  nobodyEarlier: { en: 'Nobody came', hi: 'कोई नहीं आया', gu: 'કોઈ નથી આવ્યું' },
  laterAsk: { en: "Next we'll ask", hi: 'आगे पूछेंगे', gu: 'પછી પૂછીશું' },
} as const;

/** The one question on screen: how many of this trade came. An earlier day's unsent log is asked
 *  about without "today". */
export function engineerCrewQuestion(trade: string, lang: Lang, today = true): string {
  if (lang === 'hi') return today ? `${trade}: आज कितने आए?` : `${trade}: कितने आए?`;
  if (lang === 'gu') return today ? `${trade}: આજે કેટલા આવ્યા?` : `${trade}: કેટલા આવ્યા?`;
  return today ? `${trade}: how many came today?` : `${trade}: how many came?`;
}

/** "Question 2 of 5", for the stepper's progress. */
export function engineerCrewPosition(at: number, total: number, lang: Lang): string {
  if (lang === 'hi') return `${total} में से सवाल ${at}`;
  if (lang === 'gu') return `${total} માંથી સવાલ ${at}`;
  return `Question ${at} of ${total}`;
}

/** U1b — set this trade's count to the last log's: "Same as yesterday (6)" when that log was the day
 *  before today's, else "Same as last time (6)" (a gap of days, or an earlier day's unsent log). */
export function engineerCrewSame(n: number, lang: Lang, yesterday: boolean): string {
  if (lang === 'hi') return yesterday ? `कल जितने (${n})` : `पिछली बार जितने (${n})`;
  if (lang === 'gu') return yesterday ? `ગઈકાલ જેટલા (${n})` : `છેલ્લી વખત જેટલા (${n})`;
  return yesterday ? `Same as yesterday (${n})` : `Same as last time (${n})`;
}

/** Owner ruling (#692) — unsent work saved by a release before the log carried its id. It is never
 *  added to a log on its own; the engineer sees it here and adds it to this log or discards it. */
export const engineerLegacyDraftLabels = {
  title: { en: 'Unsent work saved before the app updated', hi: 'ऐप अपडेट से पहले सहेजा गया, न भेजा गया काम', gu: 'ઍપ અપડેટ પહેલાં સાચવેલું, ન મોકલેલું કામ' },
  check: { en: 'Add it only if it is this log\'s.', hi: 'इसे तभी जोड़ें जब यह इसी लॉग का हो।', gu: 'આ લૉગનું જ હોય તો જ ઉમેરો.' },
  /** it was for another day, or this log is already sent: it can be read and discarded, not added */
  otherDay: { en: 'It cannot be added to this log: it was for another day, or this log is already sent.', hi: 'यह इस लॉग में नहीं जुड़ सकता: यह किसी और दिन का था, या यह लॉग भेजा जा चुका है।', gu: 'આ લૉગમાં ઉમેરી શકાતું નથી: આ બીજા દિવસનું હતું, અથવા આ લૉગ મોકલાઈ ગયો છે.' },
  add: { en: 'Add it to this log', hi: 'इस लॉग में जोड़ें', gu: 'આ લૉગમાં ઉમેરો' },
  discard: { en: 'Discard', hi: 'हटाएँ', gu: 'કાઢી નાખો' },
  discardSure: { en: 'Discard it for good?', hi: 'हमेशा के लिए हटाएँ?', gu: 'કાયમ માટે કાઢી નાખવું?' },
  discardYes: { en: 'Yes, discard', hi: 'हाँ, हटाएँ', gu: 'હા, કાઢી નાખો' },
  keep: { en: 'Keep it', hi: 'रखें', gu: 'રાખો' },
} as const;

/** "Saved for 2 October" — the day the kept-aside work was written for. */
export function engineerLegacyDraftFor(date: string, lang: Lang): string {
  if (lang === 'hi') return `${date} के लिए सहेजा गया`;
  if (lang === 'gu') return `${date} માટે સાચવેલું`;
  return `Saved for ${date}`;
}

/** The kept-aside work, in one line: "Checked in 9:05 AM · Plumber 4, Mason 2 · 1 photo". */
export function engineerLegacyDraftSummary(
  s: { checkinTime: string | null; crew: readonly { trade: string; count: number }[]; photos: number },
  lang: Lang,
): string {
  const parts: string[] = [];
  if (s.checkinTime) parts.push(lang === 'hi' ? `चेक-इन ${s.checkinTime}` : lang === 'gu' ? `ચેક-ઇન ${s.checkinTime}` : `Checked in ${s.checkinTime}`);
  if (s.crew.length) parts.push(s.crew.map((c) => `${c.trade} ${c.count}`).join(', '));
  if (s.photos) parts.push(lang === 'hi' ? `${s.photos} फ़ोटो` : lang === 'gu' ? `${s.photos} ફોટો` : `${s.photos} photo${s.photos === 1 ? '' : 's'}`);
  return parts.join(' · ');
}

/** "3 more", after the next trade names. */
export function engineerCrewMore(n: number, lang: Lang): string {
  if (lang === 'hi') return `${n} और`;
  if (lang === 'gu') return `${n} વધુ`;
  return `${n} more`;
}

/** U2a — the client's Pulse (design review, Client · Pulse board). No schedule verdict: there is no
 *  field or rule for one yet. */
export const clientPulseLabels = {
  done: { en: 'done', hi: 'पूरा', gu: 'પૂર્ણ' },
  underWay: { en: 'Under way', hi: 'अभी चल रहा है', gu: 'હાલ ચાલુ છે' },
  needsOne: { en: 'One thing needs you', hi: 'एक काम आपका इंतज़ार कर रहा है', gu: 'એક કામ તમારી રાહ જુએ છે' },
  reopened: { en: 'Reopened by a change request — please approve it again.', hi: 'बदलाव के अनुरोध से फिर खुला — कृपया फिर से मंज़ूर करें।', gu: 'ફેરફારની વિનંતીથી ફરી ખુલ્યું — કૃપા કરી ફરી મંજૂર કરો.' },
  open: { en: 'Open it', hi: 'खोलें', gu: 'ખોલો' },
  nothing: { en: 'Nothing needs you right now', hi: 'अभी आपके लिए कुछ बाकी नहीं', gu: 'હમણાં તમારે કંઈ કરવાનું નથી' },
  next: { en: 'What happens next', hi: 'आगे क्या होगा', gu: 'આગળ શું થશે' },
  also: { en: 'Also waiting on you', hi: 'यह भी आपका इंतज़ार कर रहा है', gu: 'આ પણ તમારી રાહ જુએ છે' },
} as const;

/** "Ambli, this week" — the Pulse heading, named for the project on screen. */
export function clientPulseHeading(project: string, lang: Lang): string {
  if (lang === 'hi') return `${project}, इस हफ़्ते`;
  if (lang === 'gu') return `${project}, આ અઠવાડિયે`;
  return `${project}, this week`;
}

/** "Week 18 of 40", counted from the schedule's own start date. */
export function clientPulseWeek(at: number, of: number, lang: Lang): string {
  if (lang === 'hi') return `${of} में से हफ़्ता ${at}`;
  if (lang === 'gu') return `${of} માંથી અઠવાડિયું ${at}`;
  return `Week ${at} of ${of}`;
}

/** "3 things need you", when more than one decision waits on the client. */
export function clientPulseNeedsMany(n: number, lang: Lang): string {
  if (lang === 'hi') return `${n} काम आपका इंतज़ार कर रहे हैं`;
  if (lang === 'gu') return `${n} કામ તમારી રાહ જુએ છે`;
  return `${n} things need you`;
}

/** "See all 3" — the way from the one decision the Pulse shows to the full list waiting on the client. */
export function clientPulseSeeAll(n: number, lang: Lang): string {
  if (lang === 'hi') return `सभी ${n} देखें`;
  if (lang === 'gu') return `બધા ${n} જુઓ`;
  return `See all ${n}`;
}

/** "See the 2 options" — the decision's own options, the way into choosing one. */
export function clientPulseSeeOptions(n: number, lang: Lang): string {
  if (lang === 'hi') return `${n} विकल्प देखें`;
  if (lang === 'gu') return `${n} વિકલ્પ જુઓ`;
  return `See the ${n} options`;
}

/** "From about 5 October" — an activity's planned start, never promised to the day. */
export function clientPulseFrom(date: string, lang: Lang): string {
  if (lang === 'hi') return `लगभग ${date} से`;
  if (lang === 'gu') return `આશરે ${date} થી`;
  return `From about ${date}`;
}

/** "Waits on your choice: Kitchen countertop" — an upcoming activity held by a decision of theirs. */
export function clientPulseWaitsOn(title: string, lang: Lang): string {
  if (lang === 'hi') return `आपके फ़ैसले का इंतज़ार: ${title}`;
  if (lang === 'gu') return `તમારા નિર્ણયની રાહ: ${title}`;
  return `Waits on your choice: ${title}`;
}

/** U2b — one decision on its own screen (design review, Client · Decision board). There is no due
 *  date, per-option note or client question path behind the board's other elements, so none is drawn. */
export const clientDecisionLabels = {
  back: { en: 'All your decisions', hi: 'आपके सभी फ़ैसले', gu: 'તમારા બધા નિર્ણયો' },
  pick: { en: 'Pick one. The price shown is the change to your budget.', hi: 'एक चुनें। दिखाई गई कीमत आपके बजट में बदलाव है।', gu: 'એક પસંદ કરો. બતાવેલી કિંમત તમારા બજેટમાં ફેરફાર છે.' },
  recommends: { en: 'Architect recommends', hi: 'आर्किटेक्ट की सलाह', gu: 'આર્કિટેક્ટની ભલામણ' },
  noChange: { en: 'No change to budget', hi: 'बजट में कोई बदलाव नहीं', gu: 'બજેટમાં કોઈ ફેરફાર નહીં' },
  reopened: { en: 'Reopened by a change request — please decide again.', hi: 'बदलाव के अनुरोध से फिर खुला — कृपया फिर से तय करें।', gu: 'ફેરફારની વિનંતીથી ફરી ખુલ્યું — કૃપા કરી ફરી નક્કી કરો.' },
  lock: { en: 'Once you approve, this choice is locked. You can still ask for a change later; your architect will show what it costs.', hi: 'मंज़ूरी के बाद यह चुनाव लॉक हो जाएगा। बाद में भी बदलाव माँग सकते हैं; आर्किटेक्ट उसकी लागत बताएँगे।', gu: 'મંજૂરી પછી આ પસંદગી લૉક થઈ જશે. પછીથી પણ ફેરફાર માગી શકો છો; આર્કિટેક્ટ તેનો ખર્ચ બતાવશે.' },
  lockCountersign: { en: 'Once you approve, it goes to the architect to countersign, and is then locked. You can still ask for a change later.', hi: 'मंज़ूरी के बाद यह आर्किटेक्ट के प्रतिहस्ताक्षर के लिए जाएगा, फिर लॉक होगा। बाद में भी बदलाव माँग सकते हैं।', gu: 'મંજૂરી પછી તે આર્કિટેક્ટની સહી માટે જશે, પછી લૉક થશે. પછીથી પણ ફેરફાર માગી શકો છો.' },
  pickFirst: { en: 'Pick one to approve', hi: 'मंज़ूर करने के लिए एक चुनें', gu: 'મંજૂર કરવા એક પસંદ કરો' },
} as const;

/** "Approve Italian Marble" — the primary action names the option chosen. */
export function clientDecisionApprove(material: string, lang: Lang): string {
  if (lang === 'hi') return `${material} मंज़ूर करें`;
  if (lang === 'gu') return `${material} મંજૂર કરો`;
  return `Approve ${material}`;
}

/** "+ ₹20,000" / "− ₹5,000" — an option's change to the budget (Indian digit grouping), or the
 *  no-change label at zero. */
export function clientDecisionDelta(delta: number, lang: Lang): string {
  if (delta === 0) return clientDecisionLabels.noChange[lang];
  return `${delta > 0 ? '+' : '\u2212'} \u20b9${Math.abs(delta).toLocaleString('en-IN')}`;
}

/** U3b — the PMC's daily brief across their projects (design review, PMC · Brief board). No schedule
 *  verdict ("Watch", "At risk") and no nudge: no rule or command stands behind either yet. */
export const pmcBriefLabels = {
  heading: { en: 'Today’s brief', hi: 'आज की रिपोर्ट', gu: 'આજનો અહેવાલ' },
  first: { en: 'Do these first', hi: 'पहले ये करें', gu: 'પહેલાં આ કરો' },
  clear: { en: 'Nothing is waiting on you across your projects', hi: 'आपके किसी प्रोजेक्ट में कुछ बाकी नहीं', gu: 'તમારા કોઈ પ્રોજેક્ટમાં કંઈ બાકી નથી' },
  since: { en: 'Since yesterday', hi: 'कल से अब तक', gu: 'ગઈકાલથી અત્યાર સુધી' },
  projects: { en: 'Your projects', hi: 'आपके प्रोजेक्ट', gu: 'તમારા પ્રોજેક્ટ' },
  logSent: { en: 'Today’s log sent', hi: 'आज की लॉग भेजी गई', gu: 'આજનો લૉગ મોકલાયો' },
  logOpen: { en: 'Today’s log started, not sent', hi: 'आज की लॉग शुरू, भेजी नहीं', gu: 'આજનો લૉગ શરૂ, મોકલ્યો નથી' },
  logMissing: { en: 'No site log yet today', hi: 'आज अभी साइट लॉग नहीं', gu: 'આજે હજી સાઇટ લૉગ નથી' },
  openDecisions: { en: 'Decisions', hi: 'फ़ैसले', gu: 'નિર્ણયો' },
  openReviews: { en: 'Review', hi: 'जाँचें', gu: 'તપાસો' },
  openSite: { en: 'Site', hi: 'साइट', gu: 'સાઇટ' },
} as const;

/** "Ambli: 2 decisions waiting on the client, oldest 5 days" — client-held decisions not yet answered. */
export function pmcBriefClientWaiting(n: number, days: number, lang: Lang): string {
  const age = days > 0 ? days : 0;
  if (lang === 'hi') return `${n} फ़ैसले क्लाइंट के इंतज़ार में${age ? `, सबसे पुराना ${age} दिन` : ''}`;
  if (lang === 'gu') return `${n} નિર્ણય ક્લાયન્ટની રાહમાં${age ? `, સૌથી જૂનો ${age} દિવસ` : ''}`;
  return `${n} decision${n === 1 ? '' : 's'} waiting on the client${age ? `, oldest ${age} day${age === 1 ? '' : 's'}` : ''}`;
}

/** "3 inspections to review". */
export function pmcBriefReviews(n: number, lang: Lang): string {
  if (lang === 'hi') return `${n} निरीक्षण जाँचने हैं`;
  if (lang === 'gu') return `${n} નિરીક્ષણ તપાસવાના છે`;
  return `${n} inspection${n === 1 ? '' : 's'} to review`;
}

/** "4 projects · 3 of 4 logs sent today". */
export function pmcBriefSummary(projects: number, logsSent: number, lang: Lang): string {
  if (lang === 'hi') return `${projects} प्रोजेक्ट · आज ${projects} में से ${logsSent} लॉग भेजी गईं`;
  if (lang === 'gu') return `${projects} પ્રોજેક્ટ · આજે ${projects} માંથી ${logsSent} લૉગ મોકલાયા`;
  return `${projects} project${projects === 1 ? '' : 's'} · ${logsSent} of ${projects} logs sent today`;
}

/** "and 2 more", under "Do these first" when more tasks wait than it names. */
export function pmcBriefMore(n: number, lang: Lang): string {
  if (lang === 'hi') return `और ${n} काम`;
  if (lang === 'gu') return `અને ${n} કામ`;
  return `and ${n} more`;
}

/** The "Since yesterday" figures: client approvals, progress photos, inspections rejected. */
export function pmcBriefSince(kind: 'approvals' | 'photos' | 'rejected', n: number, lang: Lang): string {
  if (kind === 'approvals') {
    if (lang === 'hi') return `क्लाइंट मंज़ूरियाँ`;
    if (lang === 'gu') return `ક્લાયન્ટ મંજૂરીઓ`;
    return `client approval${n === 1 ? '' : 's'}`;
  }
  if (kind === 'photos') {
    if (lang === 'hi') return `प्रगति फ़ोटो`;
    if (lang === 'gu') return `પ્રગતિ ફોટો`;
    return `progress photo${n === 1 ? '' : 's'}`;
  }
  if (lang === 'hi') return `निरीक्षण अस्वीकृत`;
  if (lang === 'gu') return `નિરીક્ષણ નામંજૂર`;
  return `inspection${n === 1 ? '' : 's'} rejected`;
}

/** "Also in Ambli" — what else waits on the PMC in the project on screen. */
export function pmcBriefAlsoIn(project: string, lang: Lang): string {
  if (lang === 'hi') return `${project} में और`;
  if (lang === 'gu') return `${project} માં વધુ`;
  return `Also in ${project}`;
}

/** Shell chrome shared by every role: the More tab and the language control. */
export const shellLabels: Record<'more' | 'language' | 'close' | 'screens', Record<Lang, string>> = {
  more: { en: 'More', hi: 'और', gu: 'વધુ' },
  language: { en: 'Language', hi: 'भाषा', gu: 'ભાષા' },
  close: { en: 'Close', hi: 'बंद करें', gu: 'બંધ કરો' },
  screens: { en: 'SCREENS', hi: 'स्क्रीन', gu: 'સ્ક્રીન' },
};

/** #827 (Top 10 #5) — the approve-and-lock confirmation, one of the paths the Board named. The English
 *  strings are byte-identical to the modal's original copy. */
export const approveModalLabels = {
  eyebrow: { en: 'CONFIRM APPROVAL', hi: 'मंज़ूरी की पुष्टि करें', gu: 'મંજૂરીની પુષ્ટિ કરો' },
  costImpact: { en: 'Cost impact', hi: 'खर्च पर असर', gu: 'ખર્ચ પર અસર' },
  decision: { en: 'Decision', hi: 'निर्णय', gu: 'નિર્ણય' },
  toCountersign: { en: 'Will be sent to the architect for countersign', hi: 'आर्किटेक्ट के हस्ताक्षर के लिए भेजा जाएगा', gu: 'આર્કિટેક્ટની સહી માટે મોકલાશે' },
  willLock: { en: 'Will be locked', hi: 'लॉक हो जाएगा', gu: 'લૉક થઈ જશે' },
  explainCountersign: {
    en: 'This decision will be recorded against your name, time-stamped, and sent to the architect for countersign. It locks when the architect countersigns; a rejection reopens it as a change request.',
    hi: 'यह निर्णय आपके नाम और समय के साथ दर्ज होगा और आर्किटेक्ट के हस्ताक्षर के लिए भेजा जाएगा। आर्किटेक्ट के हस्ताक्षर करने पर यह लॉक होगा; अस्वीकार होने पर यह बदलाव के अनुरोध के रूप में फिर खुलेगा।',
    gu: 'આ નિર્ણય તમારા નામ અને સમય સાથે નોંધાશે અને આર્કિટેક્ટની સહી માટે મોકલાશે. આર્કિટેક્ટ સહી કરે ત્યારે તે લૉક થશે; નકારાય તો તે ફેરફારની વિનંતી તરીકે ફરી ખૂલશે.',
  },
  explainLock: {
    en: 'This decision will be recorded against your name, time-stamped, and locked. Any later change needs a formal Change Request.',
    hi: 'यह निर्णय आपके नाम और समय के साथ दर्ज होकर लॉक हो जाएगा। बाद में कोई भी बदलाव करने के लिए बदलाव का औपचारिक अनुरोध चाहिए।',
    gu: 'આ નિર્ણય તમારા નામ અને સમય સાથે નોંધાઈને લૉક થઈ જશે. પછી કોઈ પણ ફેરફાર માટે ફેરફારની ઔપચારિક વિનંતી જોઈએ.',
  },
  cancel: { en: 'Cancel', hi: 'रद्द करें', gu: 'રદ કરો' },
  approveCountersign: { en: 'Approve & send for countersign', hi: 'मंज़ूर करें और हस्ताक्षर के लिए भेजें', gu: 'મંજૂર કરો અને સહી માટે મોકલો' },
  approveLock: { en: 'Approve & Lock', hi: 'मंज़ूर करें और लॉक करें', gu: 'મંજૂર કરો અને લૉક કરો' },
} satisfies Record<string, Record<Lang, string>>;

/** The approve confirmation's heading: the option and its material, in the viewer's language. */
export function approveModalTitle(option: string, material: string, lang: Lang): string {
  if (lang === 'hi') return `आप ${option} — ${material} मंज़ूर कर रहे हैं`;
  if (lang === 'gu') return `તમે ${option} — ${material} મંજૂર કરી રહ્યા છો`;
  return `You are approving ${option} — ${material}`;
}

/** #827 (Top 10 #5) — the change-request form against a locked decision, the other modal Board named.
 *  English is byte-identical to the form's original copy. */
export const changeModalLabels = {
  eyebrow: { en: 'CHANGE REQUEST', hi: 'बदलाव का अनुरोध', gu: 'ફેરફારની વિનંતી' },
  reason: { en: 'REASON FOR CHANGE', hi: 'बदलाव का कारण', gu: 'ફેરફારનું કારણ' },
  reasonHint: { en: 'e.g. Client prefers a lighter tone…', hi: 'जैसे: क्लाइंट को हल्का रंग पसंद है…', gu: 'જેમ કે: ક્લાયન્ટને હળવો રંગ ગમે છે…' },
  cost: { en: 'COST IMPACT (₹)', hi: 'खर्च पर असर (₹)', gu: 'ખર્ચ પર અસર (₹)' },
  costAria: { en: 'Cost impact (₹)', hi: 'खर्च पर असर (₹)', gu: 'ખર્ચ પર અસર (₹)' },
  time: { en: 'TIME IMPACT (DAYS)', hi: 'समय पर असर (दिन)', gu: 'સમય પર અસર (દિવસ)' },
  timeAria: { en: 'Time impact (days)', hi: 'समय पर असर (दिन)', gu: 'સમય પર અસર (દિવસ)' },
  cancel: { en: 'Cancel', hi: 'रद्द करें', gu: 'રદ કરો' },
  submit: { en: 'Submit for Re-approval', hi: 'फिर से मंज़ूरी के लिए भेजें', gu: 'ફરી મંજૂરી માટે મોકલો' },
} satisfies Record<string, Record<Lang, string>>;

/** Who re-approves a changed decision, in the viewer's language (English matches `deciderNoun`). */
const DECIDER_NOUN: Record<DeciderKind, Record<Lang, string>> = {
  client: { en: 'the client', hi: 'क्लाइंट', gu: 'ક્લાયન્ટ' },
  // `deciderNoun` reads any kind it does not name as the client
  none: { en: 'the client', hi: 'क्लाइंट', gu: 'ક્લાયન્ટ' },
  pmc: { en: 'the PMC', hi: 'प्रोजेक्ट मैनेजर (PMC)', gu: 'પ્રોજેક્ટ મેનેજર (PMC)' },
  member: { en: 'the named decider', hi: 'तय किए गए निर्णयकर्ता', gu: 'નક્કી કરેલા નિર્ણયકર્તા' },
  architect: { en: 'the architect', hi: 'आर्किटेक्ट', gu: 'આર્કિટેક્ટ' },
};

/** The form's explanation: the decision is locked and who must re-approve the change. */
export function changeModalExplainer(kind: DeciderKind, lang: Lang): string {
  // an unrecognised kind reads as the client, as `deciderNoun` does
  const who = (DECIDER_NOUN[kind] ?? DECIDER_NOUN.client)[lang];
  if (lang === 'hi') return `यह निर्णय लॉक है। बदलाव को खर्च और समय पर असर के साथ ${who} से फिर मंज़ूर कराना होगा।`;
  if (lang === 'gu') return `આ નિર્ણય લૉક છે. ફેરફારને ખર્ચ અને સમય પરની અસર સાથે ${who} પાસે ફરી મંજૂર કરાવવો પડશે.`;
  return `This decision is locked. A change must be re-approved by ${who} with cost & time impact.`;
}

/** #827 (Top 10 #5) — the engineer's daily site log, a Board-named path. English is byte-identical to the
 *  screen's original copy. Crew trades, dates, material names and places are project data, shown as recorded. */
export const dailyLogLabels = {
  eyebrow: { en: 'DAILY SITE LOG', hi: 'रोज़ का साइट लॉग', gu: 'રોજનો સાઇટ લૉગ' },
  what: { en: 'Daily log', hi: 'रोज़ का लॉग', gu: 'રોજનો લૉગ' },
  boundaryLoading: { en: 'Loading the site log…', hi: 'साइट लॉग खुल रहा है…', gu: 'સાઇટ લૉગ ખૂલી રહ્યો છે…' },
  boundaryUnavailable: {
    en: "Couldn't load the site log — check your connection and access.",
    hi: 'साइट लॉग नहीं खुला — अपना इंटरनेट और अनुमति जाँचें।',
    gu: 'સાઇટ લૉગ ન ખૂલ્યો — તમારું ઇન્ટરનેટ અને પરવાનગી તપાસો.',
  },
  openCurrent: { en: 'Open the current log', hi: 'आज का लॉग खोलें', gu: 'હાલનો લૉગ ખોલો' },
  loadingTitle: { en: "Loading today's log…", hi: 'आज का लॉग खुल रहा है…', gu: 'આજનો લૉગ ખૂલી રહ્યો છે…' },
  loadingDetail: { en: "Fetching this project's daily site log.", hi: 'इस प्रोजेक्ट का रोज़ का साइट लॉग ला रहे हैं।', gu: 'આ પ્રોજેક્ટનો રોજનો સાઇટ લૉગ લાવી રહ્યા છીએ.' },
  unavailableTitle: { en: 'Daily log unavailable', hi: 'रोज़ का लॉग अभी नहीं मिल रहा', gu: 'રોજનો લૉગ હાલ મળતો નથી' },
  unavailableDetail: {
    en: "We couldn't load this project's site log. Check your connection and access, then retry.",
    hi: 'इस प्रोजेक्ट का साइट लॉग नहीं खुला। अपना इंटरनेट और अनुमति जाँचें, फिर दोबारा कोशिश करें।',
    gu: 'આ પ્રોજેક્ટનો સાઇટ લૉગ ન ખૂલ્યો. તમારું ઇન્ટરનેટ અને પરવાનગી તપાસો, પછી ફરી પ્રયાસ કરો.',
  },
  retry: { en: 'Retry', hi: 'फिर कोशिश करें', gu: 'ફરી પ્રયાસ કરો' },
  noLogTitle: { en: 'No daily log started', hi: 'आज का लॉग शुरू नहीं हुआ', gu: 'આજનો લૉગ શરૂ થયો નથી' },
  noLogDetail: {
    en: "Start today's log when site work begins — attendance, crew, materials and progress photos all record onto it.",
    hi: 'साइट पर काम शुरू होते ही आज का लॉग शुरू करें — हाज़िरी, कारीगर, सामान और काम की फ़ोटो सब इसी में दर्ज होते हैं।',
    gu: 'સાઇટ પર કામ શરૂ થાય ત્યારે આજનો લૉગ શરૂ કરો — હાજરી, કારીગરો, માલસામાન અને કામના ફોટા બધું તેમાં નોંધાય છે.',
  },
  starting: { en: 'Starting today’s log…', hi: 'आज का लॉग शुरू हो रहा है…', gu: 'આજનો લૉગ શરૂ થઈ રહ્યો છે…' },
  startToday: { en: "Start today's log", hi: 'आज का लॉग शुरू करें', gu: 'આજનો લૉગ શરૂ કરો' },
  stale: {
    en: "Showing the last-known log — the latest couldn't load. Actions are paused until it refreshes.",
    hi: 'पिछला मिला हुआ लॉग दिख रहा है — नया नहीं खुला। ताज़ा होने तक बटन रुके हैं।',
    gu: 'છેલ્લો મળેલો લૉગ દેખાય છે — નવો ન ખૂલ્યો. તાજો થાય ત્યાં સુધી બટન બંધ છે.',
  },
  startNewDay: { en: 'Start new day', hi: 'नया दिन शुरू करें', gu: 'નવો દિવસ શરૂ કરો' },
  online: { en: 'Online · all synced', hi: 'ऑनलाइन · सब भेजा जा चुका', gu: 'ઓનલાઇન · બધું મોકલાઈ ગયું' },
  simulateOffline: { en: 'Simulate offline', hi: 'ऑफ़लाइन करके देखें', gu: 'ઓફલાઇન કરી જુઓ' },
  backOnline: { en: 'Back online', hi: 'फिर ऑनलाइन', gu: 'ફરી ઓનલાઇન' },
  checkOut: { en: 'Check out', hi: 'साइट से निकलें', gu: 'સાઇટ પરથી નીકળો' },
  checkIn: { en: 'Check in at site', hi: 'साइट पर हाज़िरी लगाएँ', gu: 'સાઇટ પર હાજરી પૂરો' },
  proof: {
    en: "Uses this phone's GPS + a selfie as proof of presence",
    hi: 'हाज़िरी के सबूत के लिए इस फ़ोन का GPS और एक सेल्फ़ी लेता है',
    gu: 'હાજરીના પુરાવા માટે આ ફોનનું GPS અને એક સેલ્ફી લે છે',
  },
  crewTitle: { en: 'CREW PRESENT TODAY', hi: 'आज मौजूद कारीगर', gu: 'આજે હાજર કારીગરો' },
  qr: { en: 'Worker self check-in (scan QR)', hi: 'कारीगर खुद हाज़िरी लगाएँ (QR स्कैन)', gu: 'કારીગર જાતે હાજરી પૂરે (QR સ્કેન)' },
  materialTitle: { en: 'MATERIAL ON SITE', hi: 'साइट पर सामान', gu: 'સાઇટ પર માલસામાન' },
  matches: { en: '✓ Matches locked decision ', hi: '✓ लॉक निर्णय से मेल खाता है ', gu: '✓ લૉક નિર્ણય સાથે મેળ ખાય છે ' },
  mismatch: { en: '⚠ MISMATCH — not the approved ', hi: '⚠ मेल नहीं — यह मंज़ूर किया हुआ नहीं ', gu: '⚠ મેળ નથી — આ મંજૂર કરેલું નથી ' },
  flagMismatch: { en: 'Flag mismatch', hi: 'मेल नहीं — बताएँ', gu: 'મેળ નથી — જણાવો' },
  recordDelivery: { en: 'Record material delivery', hi: 'सामान की डिलीवरी दर्ज करें', gu: 'માલસામાનની ડિલિવરી નોંધો' },
  progressTitle: { en: "TODAY'S PROGRESS", hi: 'आज का काम', gu: 'આજનું કામ' },
  stamped: {
    en: 'Stamped with the time and place the photo itself recorded',
    hi: 'फ़ोटो में दर्ज समय और जगह के साथ',
    gu: 'ફોટામાં નોંધાયેલા સમય અને જગ્યા સાથે',
  },
  add: { en: 'Add', hi: 'जोड़ें', gu: 'ઉમેરો' },
  placePhoto: { en: 'PLACE THIS PHOTO', hi: 'यह फ़ोटो कहाँ की है', gu: 'આ ફોટો ક્યાંનો છે' },
  optional: { en: '(OPTIONAL)', hi: '(ज़रूरी नहीं)', gu: '(જરૂરી નથી)' },
  nextPhoto: { en: 'Next photo →', hi: 'अगली फ़ोटो →', gu: 'આગળનો ફોટો →' },
  submitted: { en: 'Submitted ✓ — sent to PMC', hi: 'भेज दिया ✓ — PMC को', gu: 'મોકલી દીધું ✓ — PMC ને' },
  sending: { en: 'Sending to PMC…', hi: 'PMC को भेज रहे हैं…', gu: 'PMC ને મોકલી રહ્યા છીએ…' },
  submit: { en: 'Submit Daily Log to PMC', hi: 'रोज़ का लॉग PMC को भेजें', gu: 'રોજનો લૉગ PMC ને મોકલો' },
} satisfies Record<string, Record<Lang, string>>;

/** The daily log's counted and filled-in lines, in the viewer's language (English as before). */
export const dailyLogText = {
  offline: (n: number, lang: Lang): string =>
    lang === 'hi' ? `ऑफ़लाइन · ${n} अपडेट भेजने बाकी` : lang === 'gu' ? `ઓફલાઇન · ${n} અપડેટ મોકલવાના બાકી` : `Offline · ${n} update${n === 1 ? '' : 's'} queued`,
  // a check-in with no recorded time says so without one, never "· null"
  checkedIn: (time: string | null, lang: Lang): string => {
    const at = time ? ` · ${clockTimeIn(time, lang)}` : '';
    return lang === 'hi' ? `हाज़िरी लगी${at}` : lang === 'gu' ? `હાજરી પુરાઈ${at}` : `Checked in${at}`;
  },
  checkedInWhere: (site: string, lang: Lang): string =>
    lang === 'hi' ? `${site} · 60 मी के अंदर · GPS + सेल्फ़ी` : lang === 'gu' ? `${site} · 60 મી ની અંદર · GPS + સેલ્ફી` : `${site} · within 60 m · GPS + selfie`,
  workers: (n: number, lang: Lang): string =>
    lang === 'hi' ? `${n} कारीगर` : lang === 'gu' ? `${n} કારીગરો` : `${n} workers`,
  removeTrade: (trade: string, lang: Lang): string =>
    lang === 'hi' ? `${trade} एक कम करें` : lang === 'gu' ? `${trade} એક ઓછો કરો` : `Remove ${trade}`,
  addTrade: (trade: string, lang: Lang): string =>
    lang === 'hi' ? `${trade} एक बढ़ाएँ` : lang === 'gu' ? `${trade} એક વધારો` : `Add ${trade}`,
  photos: (n: number, lang: Lang): string =>
    lang === 'hi' ? `काम की ${n} फ़ोटो` : lang === 'gu' ? `કામના ${n} ફોટા` : `${n} progress photos`,
  photoAlt: (i: number, lang: Lang): string =>
    lang === 'hi' ? `काम की फ़ोटो ${i}` : lang === 'gu' ? `કામનો ફોટો ${i}` : `Progress photo ${i}`,
};

/** The place picker (zone → room → object) the daily log, drawings and plan forms share. English keeps the
 *  picker's original words: the kind is lower-cased inside a sentence. */
export const placeKindLabels = {
  zone: { en: 'Zone', hi: 'ज़ोन', gu: 'ઝોન' },
  room: { en: 'Room', hi: 'कमरा', gu: 'રૂમ' },
  element: { en: 'Object', hi: 'चीज़', gu: 'વસ્તુ' },
} satisfies Record<string, Record<Lang, string>>;

export const placePickerText = {
  add: { en: 'Add', hi: 'जोड़ें', gu: 'ઉમેરો' },
  cancel: { en: 'Cancel', hi: 'रद्द करें', gu: 'રદ કરો' },
  newName: (kind: keyof typeof placeKindLabels, lang: Lang): string =>
    lang === 'en' ? `New ${placeKindLabels[kind].en.toLowerCase()} name` : lang === 'hi' ? `नए ${placeKindLabels[kind].hi} का नाम` : `નવા ${placeKindLabels[kind].gu}નું નામ`,
  addNew: (kind: keyof typeof placeKindLabels, lang: Lang): string =>
    lang === 'en' ? `+ New ${placeKindLabels[kind].en.toLowerCase()}…` : lang === 'hi' ? `+ नया ${placeKindLabels[kind].hi} जोड़ें…` : `+ નવો ${placeKindLabels[kind].gu} ઉમેરો…`,
  objectTag: (lang: Lang): string => (lang === 'en' ? placeKindLabels.element.en.toLowerCase() : placeKindLabels.element[lang]),
};

/** A clock time as the viewer reads it: Hindi and Gujarati read a 12-hour "8:12 AM" (the time the check-in
 *  writer records) as 24-hour "08:12", so no English AM/PM is left; English, and any other text, is unchanged. */
export function clockTimeIn(time: string, lang: Lang): string {
  if (lang === 'en') return time;
  const m = /^(\d{1,2}):(\d{2})\s*([AaPp])\.?[Mm]\.?$/.exec(time.trim());
  if (!m) return time;
  const h = Number(m[1]) % 12 + (m[3].toLowerCase() === 'p' ? 12 : 0);
  return `${String(h).padStart(2, '0')}:${m[2]}`;
}

/** What the daily log's actions say back (the toast after a tap). English is byte-identical to the store's
 *  original messages. */
export const dailyLogToast = {
  noLog: { en: 'No daily log yet — start today’s log first.', hi: 'अभी आज का लॉग नहीं है — पहले आज का लॉग शुरू करें।', gu: 'હજી આજનો લૉગ નથી — પહેલાં આજનો લૉગ શરૂ કરો.' },
  startNeedsServer: { en: 'Starting a new log needs the server.', hi: 'नया लॉग शुरू करने के लिए सर्वर चाहिए।', gu: 'નવો લૉગ શરૂ કરવા સર્વર જોઈએ.' },
  startInFlight: { en: 'Today’s log is already being started.', hi: 'आज का लॉग शुरू हो रहा है।', gu: 'આજનો લૉગ શરૂ થઈ રહ્યો છે.' },
  started: { en: 'New daily log started — crew carried over at zero.', hi: 'नया लॉग शुरू हुआ — कारीगरों की गिनती शून्य से।', gu: 'નવો લૉગ શરૂ થયો — કારીગરોની ગણતરી શૂન્યથી.' },
  materialNeedsServer: { en: 'Recording materials needs the server.', hi: 'सामान दर्ज करने के लिए सर्वर चाहिए।', gu: 'માલસામાન નોંધવા સર્વર જોઈએ.' },
  checkedInOffline: { en: 'Checked in offline — will sync when signal returns.', hi: 'ऑफ़लाइन हाज़िरी लगी — नेटवर्क आते ही भेज दी जाएगी।', gu: 'ઓફલાઇન હાજરી પુરાઈ — નેટવર્ક આવતાં મોકલાશે.' },
  checkedOut: { en: 'Checked out. Shift hours logged.', hi: 'साइट से निकले। काम के घंटे दर्ज हुए।', gu: 'સાઇટ પરથી નીકળ્યા. કામના કલાક નોંધાયા.' },
  noCrewRows: { en: 'No crew rows on this log yet — add trades on the daily log first.', hi: 'इस लॉग में अभी कारीगरों की पंक्तियाँ नहीं हैं — पहले काम के प्रकार जोड़ें।', gu: 'આ લૉગમાં હજી કારીગરોની હાર નથી — પહેલાં કામના પ્રકાર ઉમેરો.' },
  qrScanned: { en: 'Worker checked in via QR · Helper · 9:03 AM · face verified.', hi: 'कारीगर की QR से हाज़िरी लगी · हेल्पर · 09:03 · चेहरा जाँचा गया।', gu: 'કારીગરની QR થી હાજરી પુરાઈ · હેલ્પર · 09:03 · ચહેરો ચકાસાયો.' },
  photoUnreadable: { en: 'Could not read that photo — please try again.', hi: 'यह फ़ोटो पढ़ी नहीं जा सकी — फिर कोशिश करें।', gu: 'આ ફોટો વાંચી ન શકાયો — ફરી પ્રયાસ કરો.' },
  photoOffline: { en: 'Photo saved offline — will upload when signal returns.', hi: 'फ़ोटो ऑफ़लाइन सहेजी — नेटवर्क आते ही अपलोड होगी।', gu: 'ફોટો ઓફલાઇન સાચવ્યો — નેટવર્ક આવતાં અપલોડ થશે.' },
  photoUploadedStamped: { en: 'Progress photo uploaded — stamped from the photo, visible to PMC.', hi: 'काम की फ़ोटो अपलोड हुई — फ़ोटो के समय-जगह के साथ, PMC देख सकते हैं।', gu: 'કામનો ફોટો અપલોડ થયો — ફોટાના સમય-જગ્યા સાથે, PMC જોઈ શકે છે.' },
  photoUploaded: { en: 'Progress photo uploaded — visible to PMC.', hi: 'काम की फ़ोटो अपलोड हुई — PMC देख सकते हैं।', gu: 'કામનો ફોટો અપલોડ થયો — PMC જોઈ શકે છે.' },
  photoUploadFailed: { en: 'Could not upload the photo — please try again.', hi: 'फ़ोटो अपलोड नहीं हुई — फिर कोशिश करें।', gu: 'ફોટો અપલોડ ન થયો — ફરી પ્રયાસ કરો.' },
  photoAddedStamped: { en: 'Progress photo added — stamped from the photo.', hi: 'काम की फ़ोटो जुड़ी — फ़ोटो के समय-जगह के साथ।', gu: 'કામનો ફોટો ઉમેરાયો — ફોટાના સમય-જગ્યા સાથે.' },
  photoAdded: { en: 'Progress photo added.', hi: 'काम की फ़ोटो जुड़ी।', gu: 'કામનો ફોટો ઉમેરાયો.' },
  submitNeedsCheckIn: { en: 'Please check in at site before submitting the daily log.', hi: 'लॉग भेजने से पहले साइट पर हाज़िरी लगाएँ।', gu: 'લૉગ મોકલતાં પહેલાં સાઇટ પર હાજરી પૂરો.' },
  alreadySent: { en: 'Today’s log is already with PMC.', hi: 'आज का लॉग PMC के पास पहुँच चुका है।', gu: 'આજનો લૉગ PMC પાસે પહોંચી ગયો છે.' },
  alreadyOnItsWay: { en: 'Today’s log is already on its way to PMC.', hi: 'आज का लॉग PMC को जा रहा है।', gu: 'આજનો લૉગ PMC ને જઈ રહ્યો છે.' },
  sent: { en: 'Daily site log sent to PMC — attendance, materials & photos attached.', hi: 'रोज़ का लॉग PMC को भेजा — हाज़िरी, सामान और फ़ोटो साथ में।', gu: 'રોજનો લૉગ PMC ને મોકલ્યો — હાજરી, માલસામાન અને ફોટા સાથે.' },
  sentOffline: { en: 'Saved offline — log will upload to PMC when signal returns.', hi: 'ऑफ़लाइन सहेजा — नेटवर्क आते ही लॉग PMC को जाएगा।', gu: 'ઓફલાઇન સાચવ્યું — નેટવર્ક આવતાં લૉગ PMC ને જશે.' },
  flagged: { en: 'Mismatch flagged — PMC alerted and the linked activity is now blocked.', hi: 'मेल न होने की सूचना दी — PMC को बताया गया और जुड़ा काम रोका गया।', gu: 'મેળ ન હોવાની જાણ કરી — PMC ને જણાવ્યું અને જોડાયેલું કામ રોક્યું.' },
  signalLost: { en: 'Signal lost — the app keeps working, updates will queue.', hi: 'नेटवर्क चला गया — ऐप चलता रहेगा, बदलाव कतार में रहेंगे।', gu: 'નેટવર્ક ગયું — ઍપ ચાલુ રહેશે, ફેરફારો કતારમાં રહેશે.' },
} satisfies Record<string, Record<Lang, string>>;

export const dailyLogToastText = {
  checkedIn: (site: string, lang: Lang): string =>
    lang === 'hi' ? `${site} पर हाज़िरी लगी · 60 मी के अंदर · सेल्फ़ी + समय दर्ज।` : lang === 'gu' ? `${site} પર હાજરી પુરાઈ · 60 મી ની અંદર · સેલ્ફી + સમય નોંધાયો.` : `Checked in at ${site} · within 60 m · selfie + time stamped.`,
  materialRecorded: (name: string, lang: Lang): string =>
    lang === 'hi' ? `सामान दर्ज हुआ: ${name}।` : lang === 'gu' ? `માલસામાન નોંધાયો: ${name}.` : `Material recorded: ${name}.`,
  savedOffline: (label: string, lang: Lang): string =>
    lang === 'hi' ? `${label} — ऑफ़लाइन सहेजा, नेटवर्क आते ही भेजा जाएगा।` : lang === 'gu' ? `${label} — ઓફલાઇન સાચવ્યું, નેટવર્ક આવતાં મોકલાશે.` : `${label} — saved offline, will sync when you reconnect.`,
  synced: (n: number, lang: Lang): string =>
    lang === 'hi' ? `${n} ऑफ़लाइन बदलाव सर्वर पर भेजे गए।` : lang === 'gu' ? `${n} ઓફલાઇન ફેરફારો સર્વર પર મોકલાયા.` : n + ' offline update' + (n > 1 ? 's' : '') + ' synced to server.',
};

/** The names of the daily log's write-ahead commands, as the "saved offline" toast says them. */
export const dailyLogCommandLabels = {
  start: { en: 'New daily log', hi: 'नया लॉग', gu: 'નવો લૉગ' },
  material: { en: 'Record material', hi: 'सामान दर्ज', gu: 'માલસામાન નોંધ' },
  submit: { en: 'Submit daily log', hi: 'लॉग भेजना', gu: 'લૉગ મોકલવો' },
  flag: { en: 'Flag', hi: 'मेल नहीं', gu: 'મેળ નથી' },
} satisfies Record<string, Record<Lang, string>>;

/** The material-delivery form the daily log opens. */
export const addMaterialLabels = {
  title: { en: 'Record material delivery', hi: 'सामान की डिलीवरी दर्ज करें', gu: 'માલસામાનની ડિલિવરી નોંધો' },
  introBefore: { en: 'What arrived, how much, and where. Under ', hi: 'क्या आया, कितना और कहाँ। ', gu: 'શું આવ્યું, કેટલું અને ક્યાં. ' },
  introAfter: {
    en: ': how it is stored, and a link to a locked decision so the PMC can confirm the delivery matches what the client approved.',
    hi: ' में: कैसे रखा है, और लॉक निर्णय से जोड़ें ताकि PMC देख सके कि सामान क्लाइंट की मंज़ूरी से मेल खाता है।',
    gu: ' માં: કેવી રીતે રાખ્યું છે, અને લૉક નિર્ણય સાથે જોડો જેથી PMC જોઈ શકે કે માલ ક્લાયન્ટની મંજૂરી સાથે મેળ ખાય છે.',
  },
  name: { en: 'Material (e.g. Italian Marble slabs)', hi: 'सामान (जैसे इटालियन मार्बल की स्लैब)', gu: 'માલસામાન (જેમ કે ઇટાલિયન માર્બલની સ્લેબ)' },
  qty: { en: 'Qty (e.g. 40 sqm)', hi: 'मात्रा (जैसे 40 वर्ग मी)', gu: 'જથ્થો (જેમ કે 40 ચો.મી.)' },
  storage: { en: 'Stored how? (e.g. covered, on pallets)', hi: 'कैसे रखा है? (जैसे ढका हुआ, पैलेट पर)', gu: 'કેવી રીતે રાખ્યું છે? (જેમ કે ઢાંકેલું, પૅલેટ પર)' },
  linkTitle: { en: 'LINK TO DECISION', hi: 'निर्णय से जोड़ें', gu: 'નિર્ણય સાથે જોડો' },
  linkAria: { en: 'Link to decision', hi: 'निर्णय से जोड़ें', gu: 'નિર્ણય સાથે જોડો' },
  noLink: { en: '— No linked decision —', hi: '— कोई निर्णय नहीं जुड़ा —', gu: '— કોઈ નિર્ણય જોડાયો નથી —' },
  swatchAria: { en: 'Material swatch', hi: 'सामान का रंग-नमूना', gu: 'માલસામાનનો રંગ-નમૂનો' },
  cancel: { en: 'Cancel', hi: 'रद्द करें', gu: 'રદ કરો' },
  save: { en: 'Record delivery', hi: 'डिलीवरी दर्ज करें', gu: 'ડિલિવરી નોંધો' },
} satisfies Record<string, Record<Lang, string>>;

/** The swatch names a material picks from; English is the swatch's own key, as the picker always showed. */
export const swatchLabels = {
  marble: { en: 'marble', hi: 'मार्बल', gu: 'માર્બલ' },
  vitrified: { en: 'vitrified', hi: 'विट्रिफ़ाइड', gu: 'વિટ્રિફાઇડ' },
  teak: { en: 'teak', hi: 'सागौन', gu: 'સાગ' },
  walnut: { en: 'walnut', hi: 'अखरोट', gu: 'અખરોટ' },
  chrome: { en: 'chrome', hi: 'क्रोम', gu: 'ક્રોમ' },
  glass: { en: 'glass', hi: 'काँच', gu: 'કાચ' },
  quartz: { en: 'quartz', hi: 'क्वार्ट्ज़', gu: 'ક્વાર્ટ્ઝ' },
  water: { en: 'water', hi: 'पानी', gu: 'પાણી' },
  concrete: { en: 'concrete', hi: 'कंक्रीट', gu: 'કોંક્રિટ' },
  tile: { en: 'tile', hi: 'टाइल', gu: 'ટાઇલ' },
  paint: { en: 'paint', hi: 'पेंट', gu: 'પેઇન્ટ' },
} satisfies Record<string, Record<Lang, string>>;

/** The shared form pieces a capture form uses: the inherited place chip and the folded "More details". */
export const formPieceLabels = {
  location: { en: 'LOCATION', hi: 'जगह', gu: 'જગ્યા' },
  change: { en: 'Change', hi: 'बदलें', gu: 'બદલો' },
  moreDetails: { en: 'More details', hi: 'और जानकारी', gu: 'વધુ વિગતો' },
} satisfies Record<string, Record<Lang, string>>;

/** The full-screen photo viewer. */
export const photoViewerLabels = {
  dialog: { en: 'Photo', hi: 'फ़ोटो', gu: 'ફોટો' },
  close: { en: 'Close photo', hi: 'फ़ोटो बंद करें', gu: 'ફોટો બંધ કરો' },
  image: { en: 'Site photo, full size', hi: 'साइट की फ़ोटो, पूरे आकार में', gu: 'સાઇટનો ફોટો, પૂરા કદમાં' },
} satisfies Record<string, Record<Lang, string>>;

/** What a hub says under a record link while that record cannot be shown (every hub shares it). */
export const recordBoundaryText = {
  opening: (id: string, lang: Lang): string => (lang === 'hi' ? `${id} खुल रहा है…` : lang === 'gu' ? `${id} ખૂલી રહ્યું છે…` : `Opening ${id}…`),
  returning: { en: 'Returning…', hi: 'वापस जा रहे हैं…', gu: 'પાછા જઈ રહ્યા છીએ…' } as Record<Lang, string>,
  retry: { en: 'Retry', hi: 'फिर कोशिश करें', gu: 'ફરી પ્રયાસ કરો' } as Record<Lang, string>,
  /** "<what> <id> isn't available": the words after the id, which keeps its own type face */
  missingAfter: { en: " isn't available", hi: ' अभी नहीं मिल रहा', gu: ' હાલ મળતું નથી' } as Record<Lang, string>,
  missingDetail: {
    en: 'It may have been completed or removed, or you may not have access to it.',
    hi: 'शायद यह पूरा हो गया या हटा दिया गया, या आपको इसे देखने की अनुमति नहीं है।',
    gu: 'કદાચ તે પૂરું થયું કે દૂર કરાયું, અથવા તમને તે જોવાની પરવાનગી નથી.',
  } as Record<Lang, string>,
};

/** The language switch's own labels: a short mark for the control, and each language's name
 *  written in that language, so a reader finds theirs without reading the others. Ordered as the
 *  switch shows them — Gujarati first, the site's default. */
export const LANG_SWITCH: { key: Lang; mark: string; name: string }[] = [
  { key: 'gu', mark: 'ગુજ', name: 'ગુજરાતી' },
  { key: 'hi', mark: 'हिं', name: 'हिंदी' },
  { key: 'en', mark: 'EN', name: 'English' },
];

export const LANGS: { key: Lang; label: string }[] = [
  { key: 'en', label: 'English' },
  { key: 'hi', label: 'हिंदी' },
  { key: 'gu', label: 'ગુજરાતી' },
];

const ns = (lang: Lang) => ({
  access: accessDict[lang] as unknown as Record<string, string>,
  trades: Object.fromEntries(Object.entries(tradeLabels).map(([k, v]) => [k, v[lang]])),
  workerTrades: Object.fromEntries(Object.entries(workerTradeLabels).map(([k, v]) => [k, v[lang]])),
  labour: Object.fromEntries(Object.entries(labourLabels).map(([k, v]) => [k, v[lang]])),
});

/** i18next-ready resource bundle. */
export const resources = {
  en: ns('en'),
  hi: ns('hi'),
  gu: ns('gu'),
};
