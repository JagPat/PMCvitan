import type { Lang } from '@vitan/shared';

/**
 * Site Visits SV1-c (#792, QA item 6): the screen's words in English, Hindi and Gujarati. Names of people and
 * places are project data and show as recorded.
 */
type Words = Record<Lang, string>;

export const SV = {
  title: { en: 'Site Visits', hi: 'साइट विज़िट', gu: 'સાઇટ મુલાકાત' },
  intro: {
    en: 'Who visited the site, when, the places walked and the people there.',
    hi: 'साइट पर कौन आया, कब, कौन-सी जगहें देखीं और साथ में कौन था।',
    gu: 'સાઇટ પર કોણ આવ્યું, ક્યારે, કઈ જગ્યાઓ જોઈ અને સાથે કોણ હતું.',
  },
  start: { en: 'Start visit', hi: 'विज़िट शुरू करें', gu: 'મુલાકાત શરૂ કરો' },
  startPlace: { en: 'Starting place (optional)', hi: 'शुरुआत की जगह (ज़रूरी नहीं)', gu: 'શરૂઆતની જગ્યા (જરૂરી નથી)' },
  noPlace: { en: 'No place', hi: 'कोई जगह नहीं', gu: 'કોઈ જગ્યા નહીં' },
  locationNote: {
    en: 'Your phone’s location is saved if it shares one. You can start without it.',
    hi: 'फ़ोन जगह बताए तो वह सहेजी जाती है। उसके बिना भी शुरू कर सकते हैं।',
    gu: 'ફોન જગ્યા આપે તો તે સાચવાય છે. તેના વગર પણ શરૂ કરી શકો છો.',
  },
  open: { en: 'On site now', hi: 'अभी साइट पर', gu: 'હમણાં સાઇટ પર' },
  ended: { en: 'Ended', hi: 'ख़त्म', gu: 'પૂરી' },
  closed: { en: 'Closed', hi: 'बंद', gu: 'બંધ' },
  startedAt: { en: 'Started', hi: 'शुरू', gu: 'શરૂ' },
  endedAt: { en: 'Ended', hi: 'ख़त्म', gu: 'પૂરી' },
  closedAt: { en: 'Closed', hi: 'बंद की', gu: 'બંધ કરી' },
  closedBecause: { en: 'Closed by the project manager:', hi: 'प्रोजेक्ट मैनेजर ने बंद की:', gu: 'પ્રોજેક્ટ મેનેજરે બંધ કરી:' },
  lateEnd: { en: 'Visitor ended it later', hi: 'विज़िटर ने बाद में ख़त्म की', gu: 'મુલાકાતીએ પછી પૂરી કરી' },
  location: { en: 'Location saved', hi: 'जगह सहेजी गई', gu: 'જગ્યા સાચવી' },
  approximate: { en: 'approximate', hi: 'अंदाज़न', gu: 'અંદાજિત' },
  places: { en: 'Places walked', hi: 'देखी गई जगहें', gu: 'જોયેલી જગ્યાઓ' },
  people: { en: 'People there', hi: 'साथ के लोग', gu: 'સાથેના લોકો' },
  none: { en: 'None yet', hi: 'अभी कोई नहीं', gu: 'હજી કોઈ નહીં' },
  choosePlace: { en: 'Choose a place', hi: 'जगह चुनें', gu: 'જગ્યા પસંદ કરો' },
  addPlace: { en: 'Add place', hi: 'जगह जोड़ें', gu: 'જગ્યા ઉમેરો' },
  choosePerson: { en: 'Choose a team member', hi: 'टीम का सदस्य चुनें', gu: 'ટીમનો સભ્ય પસંદ કરો' },
  addPerson: { en: 'Add member', hi: 'सदस्य जोड़ें', gu: 'સભ્ય ઉમેરો' },
  guestName: { en: 'Guest’s name', hi: 'मेहमान का नाम', gu: 'મહેમાનનું નામ' },
  addGuest: { en: 'Add guest', hi: 'मेहमान जोड़ें', gu: 'મહેમાન ઉમેરો' },
  guest: { en: 'Guest', hi: 'मेहमान', gu: 'મહેમાન' },
  remove: { en: 'Remove', hi: 'हटाएँ', gu: 'કાઢો' },
  removed: { en: 'removed', hi: 'हटाया गया', gu: 'કાઢ્યું' },
  addedAfterEnd: { en: 'added after the visit ended', hi: 'विज़िट ख़त्म होने के बाद जोड़ा', gu: 'મુલાકાત પૂરી થયા પછી ઉમેર્યું' },
  end: { en: 'End visit', hi: 'विज़िट ख़त्म करें', gu: 'મુલાકાત પૂરી કરો' },
  close: { en: 'Close visit', hi: 'विज़िट बंद करें', gu: 'મુલાકાત બંધ કરો' },
  closeReason: { en: 'Why are you closing it?', hi: 'आप इसे क्यों बंद कर रहे हैं?', gu: 'તમે તેને કેમ બંધ કરો છો?' },
  closeConfirm: { en: 'Close it', hi: 'बंद करें', gu: 'બંધ કરો' },
  cancel: { en: 'Cancel', hi: 'रद्द करें', gu: 'રદ કરો' },
  empty: { en: 'No site visits yet.', hi: 'अभी कोई साइट विज़िट नहीं।', gu: 'હજી કોઈ સાઇટ મુલાકાત નથી.' },
  loading: { en: 'Loading visits…', hi: 'विज़िट खुल रही हैं…', gu: 'મુલાકાતો ખૂલે છે…' },
  loadFailed: { en: 'Could not load the visits.', hi: 'विज़िट नहीं खुल सकीं।', gu: 'મુલાકાતો ખૂલી નહીં.' },
  teamFailed: { en: 'Could not load the team.', hi: 'टीम नहीं खुल सकी।', gu: 'ટીમ ખૂલી નહીં.' },
  retry: { en: 'Try again', hi: 'फिर कोशिश करें', gu: 'ફરી પ્રયત્ન કરો' },
  older: { en: 'Show older visits', hi: 'पुरानी विज़िट दिखाएँ', gu: 'જૂની મુલાકાતો બતાવો' },
  needsServer: { en: 'Site visits need the server.', hi: 'साइट विज़िट के लिए सर्वर चाहिए।', gu: 'સાઇટ મુલાકાત માટે સર્વર જોઈએ.' },
  offline: {
    en: 'No signal, so this is not confirmed. Try again when you are online; it is saved only once.',
    hi: 'नेटवर्क नहीं है, इसलिए यह पक्का नहीं हुआ। ऑनलाइन होने पर फिर कोशिश करें; यह एक ही बार सहेजा जाएगा।',
    gu: 'નેટવર્ક નથી, તેથી આ પાકું થયું નથી. ઓનલાઇન થાઓ ત્યારે ફરી પ્રયત્ન કરો; તે એક જ વાર સચવાશે.',
  },
  unconfirmed: {
    en: 'The server did not confirm this. Try again; it is saved only once.',
    hi: 'सर्वर ने इसकी पुष्टि नहीं की। फिर कोशिश करें; यह एक ही बार सहेजा जाएगा।',
    gu: 'સર્વરે આની પુષ્ટિ કરી નથી. ફરી પ્રયત્ન કરો; તે એક જ વાર સચવાશે.',
  },
  refused: { en: 'This was not saved.', hi: 'यह सहेजा नहीं गया।', gu: 'આ સચવાયું નથી.' },
} satisfies Record<string, Words>;

/** A server time as the viewer reads it, in India's time: "14 Oct, 15:30" in the viewer's language. */
export function visitTime(iso: string, lang: Lang): string {
  const locale = lang === 'hi' ? 'hi-IN' : lang === 'gu' ? 'gu-IN' : 'en-IN';
  return new Intl.DateTimeFormat(locale, {
    day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: 'Asia/Kolkata',
  }).format(new Date(iso));
}
