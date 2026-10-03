/**
 * i18n dictionaries (English / हिंदी / ગુજરાતી).
 *
 * Ported from the prototype's `L()` dictionary plus the trade/worker label maps
 * that were inlined in `renderVals()`. The site- and worker-facing flows are
 * fully translated; short simple English elsewhere. Exposed both as structured
 * objects and as an i18next `resources` bundle (namespaces: access, trades, workerTrades).
 */

import type { Lang, ScreenKey } from '../domain/types';

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
 *  existing short labels (`SCREEN_META.short`); hi/gu are plain words a site engineer uses. */
export const navLabels: Record<ScreenKey, Record<Lang, string>> = {
  inbox: { en: 'For You', hi: 'आपके लिए', gu: 'તમારા માટે' },
  dashboard: { en: 'Dashboard', hi: 'डैशबोर्ड', gu: 'ડેશબોર્ડ' },
  drafts: { en: 'Drafts', hi: 'ड्राफ़्ट', gu: 'ડ્રાફ્ટ' },
  'site-schedule': { en: 'Schedule', hi: 'समय-सारणी', gu: 'સમયપત્રક' },
  'decision-log': { en: 'Log', hi: 'निर्णय', gu: 'નિર્ણયો' },
  'inspect-review': { en: 'Review', hi: 'जाँच', gu: 'ચકાસણી' },
  'client-decisions': { en: 'Decisions', hi: 'मंज़ूरी', gu: 'મંજૂરી' },
  'client-health': { en: 'Health', hi: 'प्रगति', gu: 'પ્રગતિ' },
  'daily-log': { en: 'Daily', hi: 'रोज़ का लॉग', gu: 'રોજનો લોગ' },
  'engineer-check': { en: 'Checklist', hi: 'चेकलिस्ट', gu: 'ચેકલિસ્ટ' },
  drawings: { en: 'Drawings', hi: 'ड्रॉइंग', gu: 'ડ્રોઇંગ' },
  places: { en: 'Places', hi: 'जगहें', gu: 'સ્થળો' },
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

/** Shell chrome shared by every role: the More tab and the language control. */
export const shellLabels: Record<'more' | 'language' | 'close' | 'screens', Record<Lang, string>> = {
  more: { en: 'More', hi: 'और', gu: 'વધુ' },
  language: { en: 'Language', hi: 'भाषा', gu: 'ભાષા' },
  close: { en: 'Close', hi: 'बंद करें', gu: 'બંધ કરો' },
  screens: { en: 'SCREENS', hi: 'स्क्रीन', gu: 'સ્ક્રીન' },
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
