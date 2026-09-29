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

/** Shell chrome shared by every role: the More tab and the language control. */
export const shellLabels: Record<'more' | 'language' | 'close', Record<Lang, string>> = {
  more: { en: 'More', hi: 'और', gu: 'વધુ' },
  language: { en: 'Language', hi: 'भाषा', gu: 'ભાષા' },
  close: { en: 'Close', hi: 'बंद करें', gu: 'બંધ કરો' },
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
