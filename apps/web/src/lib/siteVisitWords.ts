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
  queued: {
    en: 'No signal: saved on this phone. It is sent when you are back online.',
    hi: 'नेटवर्क नहीं: इस फ़ोन पर सहेजा गया। ऑनलाइन होने पर भेजा जाएगा।',
    gu: 'નેટવર્ક નથી: આ ફોન પર સાચવ્યું. ઓનલાઇન થશો ત્યારે મોકલાશે.',
  },
  waiting: { en: 'waiting to send', hi: 'भेजना बाकी', gu: 'મોકલવાનું બાકી' },
  waitingCount: {
    en: 'Changes waiting to send:',
    hi: 'भेजने के लिए बाकी बदलाव:',
    gu: 'મોકલવાના બાકી ફેરફારો:',
  },
  sendNow: { en: 'Send now', hi: 'अभी भेजें', gu: 'હમણાં મોકલો' },
  moved: {
    en: 'You already had a visit open, so the places, people, photos and end from the visit started without signal were put on it.',
    hi: 'आपकी एक विज़िट पहले से खुली थी, इसलिए बिना नेटवर्क शुरू की गई विज़िट की जगहें, लोग, फ़ोटो और ख़त्म करना उसी में जोड़े गए।',
    gu: 'તમારી એક મુલાકાત પહેલેથી ખુલ્લી હતી, તેથી નેટવર્ક વગર શરૂ કરેલી મુલાકાતની જગ્યાઓ, લોકો, ફોટા અને પૂરી કરવાનું તેમાં ઉમેર્યું.',
  },
  adjusted: { en: 'time set by the server', hi: 'समय सर्वर ने रखा', gu: 'સમય સર્વરે રાખ્યો' },
  refused: { en: 'This was not saved.', hi: 'यह सहेजा नहीं गया।', gu: 'આ સચવાયું નથી.' },
  // SV2 (#792): photos on a visit
  photos: { en: 'Photos', hi: 'फ़ोटो', gu: 'ફોટા' },
  addPhoto: { en: 'Add photo', hi: 'फ़ोटो जोड़ें', gu: 'ફોટો ઉમેરો' },
  photoNote: { en: 'Note (optional)', hi: 'टिप्पणी (ज़रूरी नहीं)', gu: 'નોંધ (જરૂરી નથી)' },
  photoPlace: { en: 'Place (optional)', hi: 'जगह (ज़रूरी नहीं)', gu: 'જગ્યા (જરૂરી નથી)' },
  photoRating: { en: 'How is it? (optional)', hi: 'कैसा है? (ज़रूरी नहीं)', gu: 'કેવું છે? (જરૂરી નથી)' },
  fine: { en: 'Fine', hi: 'ठीक', gu: 'બરાબર' },
  concern: { en: 'Concern', hi: 'चिंता', gu: 'ચિંતા' },
  actionNeeded: { en: 'Action needed', hi: 'कार्रवाई ज़रूरी', gu: 'પગલાં જરૂરી' },
  photoBy: { en: 'Added by', hi: 'जोड़ने वाले', gu: 'ઉમેરનાર' },
  photoTaken: { en: 'taken', hi: 'खींची गई', gu: 'લીધેલો' },
  photoUnreadable: { en: 'This photo could not be read. Try another.', hi: 'यह फ़ोटो पढ़ी नहीं जा सकी। दूसरी आज़माएँ।', gu: 'આ ફોટો વાંચી શકાયો નહીં. બીજો અજમાવો.' },
  photoTooBig: {
    en: 'This photo is too large to send. Try a smaller one.',
    hi: 'यह फ़ोटो भेजने के लिए बहुत बड़ी है। छोटी फ़ोटो आज़माएँ।',
    gu: 'આ ફોટો મોકલવા માટે બહુ મોટો છે. નાનો ફોટો અજમાવો.',
  },
  photoNoStorage: {
    en: 'This photo was not added: this browser cannot save photos on the phone (private browsing cannot). Open the app in a normal browser window and add it again.',
    hi: 'यह फ़ोटो नहीं जोड़ी गई: यह ब्राउज़र फ़ोन पर फ़ोटो सहेज नहीं सकता (प्राइवेट ब्राउज़िंग नहीं कर सकती)। ऐप को सामान्य ब्राउज़र विंडो में खोलें और फिर से जोड़ें।',
    gu: 'આ ફોટો ઉમેરાયો નથી: આ બ્રાઉઝર ફોન પર ફોટા સાચવી શકતું નથી (પ્રાઇવેટ બ્રાઉઝિંગ નથી સાચવી શકતું). ઍપ સામાન્ય બ્રાઉઝર વિન્ડોમાં ખોલો અને ફરી ઉમેરો.',
  },
  photoNotKept: {
    en: 'This photo was not added: it could not be saved on this phone. Free some space on the phone, then add it again.',
    hi: 'यह फ़ोटो नहीं जोड़ी गई: इसे इस फ़ोन पर सहेजा नहीं जा सका। फ़ोन में कुछ जगह खाली करें, फिर से जोड़ें।',
    gu: 'આ ફોટો ઉમેરાયો નથી: તેને આ ફોન પર સાચવી શકાયો નહીં. ફોનમાં થોડી જગ્યા ખાલી કરો, પછી ફરી ઉમેરો.',
  },
  photoMaybeNotKept: {
    en: 'This photo may not have been saved: the phone did not say in time. If it does not appear on the visit soon, add it again.',
    hi: 'हो सकता है यह फ़ोटो सहेजी न गई हो: फ़ोन ने समय पर नहीं बताया। अगर यह जल्द ही विज़िट पर न दिखे, तो इसे फिर से जोड़ें।',
    gu: 'આ ફોટો કદાચ સચવાયો ન હોય: ફોને સમયસર જણાવ્યું નહીં. જો તે થોડી વારમાં મુલાકાત પર ન દેખાય, તો તેને ફરી ઉમેરો.',
  },
  photoPlaceGone: {
    en: 'The place you chose was removed from this visit. Choose the place again, then add the photo.',
    hi: 'आपकी चुनी जगह इस विज़िट से हटा दी गई। जगह फिर से चुनें, फिर फ़ोटो जोड़ें।',
    gu: 'તમે પસંદ કરેલી જગ્યા આ મુલાકાતમાંથી દૂર કરાઈ. જગ્યા ફરી પસંદ કરો, પછી ફોટો ઉમેરો.',
  },
  heldStorage: {
    en: 'Updates to this visit are waiting: this phone’s storage cannot be read right now, and a photo may still be waiting on it.',
    hi: 'इस विज़िट के बदलाव रुके हुए हैं: इस फ़ोन की स्टोरेज अभी पढ़ी नहीं जा सकती, और उसमें कोई फ़ोटो अभी भेजनी बाकी हो सकती है।',
    gu: 'આ મુલાકાતના ફેરફારો રોકાયેલા છે: આ ફોનનો સ્ટોરેજ હમણાં વાંચી શકાતો નથી, અને તેમાં કોઈ ફોટો હજી મોકલવાનો બાકી હોઈ શકે છે.',
  },
  sendAnyway: { en: 'Send anyway', hi: 'फिर भी भेजें', gu: 'તો પણ મોકલો' },
  notSent: { en: 'Photos, voice notes and videos not sent', hi: 'फ़ोटो, वॉइस नोट और वीडियो जो नहीं भेजे गए', gu: 'ન મોકલાયેલા ફોટા, વૉઇસ નોટ અને વીડિયો' },
  dismiss: { en: 'Dismiss', hi: 'हटाएँ', gu: 'દૂર કરો' },
  photoOpen: { en: 'Open photo', hi: 'फ़ोटो खोलें', gu: 'ફોટો ખોલો' },
  // Stage 1 voice notes: a spoken note on the visit, up to two minutes, kept and sent the way a photo is
  files: { en: 'Photos, voice notes and videos', hi: 'फ़ोटो, वॉइस नोट और वीडियो', gu: 'ફોટા, વૉઇસ નોટ અને વીડિયો' },
  voiceNote: { en: 'Voice note', hi: 'वॉइस नोट', gu: 'વૉઇસ નોટ' },
  recordVoice: { en: 'Record voice note', hi: 'वॉइस नोट रिकॉर्ड करें', gu: 'વૉઇસ નોટ રેકોર્ડ કરો' },
  recording: { en: 'Recording', hi: 'रिकॉर्ड हो रहा है', gu: 'રેકોર્ડ થઈ રહ્યું છે' },
  // the running time against the cap: "0:12 of 2:00"
  recordingOf: { en: 'of', hi: '/', gu: '/' },
  voiceStop: { en: 'Stop and add', hi: 'रोकें और जोड़ें', gu: 'રોકો અને ઉમેરો' },
  voiceDiscard: { en: 'Discard', hi: 'रद्द करें', gu: 'રદ કરો' },
  voiceCapped: {
    en: 'The recording stopped at two minutes and was added.',
    hi: 'रिकॉर्डिंग दो मिनट पर रुक गई और जोड़ दी गई।',
    gu: 'રેકોર્ડિંગ બે મિનિટે અટકી ગયું અને ઉમેરાઈ ગયું.',
  },
  play: { en: 'Play', hi: 'चलाएँ', gu: 'વગાડો' },
  playFailed: { en: 'This voice note could not be played.', hi: 'यह वॉइस नोट चल नहीं सका।', gu: 'આ વૉઇસ નોટ વાગી શકી નહીં.' },
  voiceDenied: {
    en: 'Voice notes need the microphone. Allow the microphone for this site in the browser settings, then try again.',
    hi: 'वॉइस नोट के लिए माइक्रोफ़ोन चाहिए। ब्राउज़र सेटिंग में इस साइट के लिए माइक्रोफ़ोन की अनुमति दें, फिर से कोशिश करें।',
    gu: 'વૉઇસ નોટ માટે માઇક્રોફોન જોઈએ. બ્રાઉઝર સેટિંગમાં આ સાઇટ માટે માઇક્રોફોનની મંજૂરી આપો, પછી ફરી પ્રયત્ન કરો.',
  },
  voiceUnavailable: {
    en: 'This phone could not start recording. Check that no other app is using the microphone, then try again.',
    hi: 'यह फ़ोन रिकॉर्डिंग शुरू नहीं कर सका। देखें कि कोई दूसरा ऐप माइक्रोफ़ोन इस्तेमाल न कर रहा हो, फिर से कोशिश करें।',
    gu: 'આ ફોન રેકોર્ડિંગ શરૂ કરી શક્યો નહીં. જુઓ કે બીજી કોઈ ઍપ માઇક્રોફોન વાપરતી ન હોય, પછી ફરી પ્રયત્ન કરો.',
  },
  voiceTooShort: {
    en: 'This recording was too short to add. Record for at least a second.',
    hi: 'यह रिकॉर्डिंग जोड़ने के लिए बहुत छोटी थी। कम से कम एक सेकंड रिकॉर्ड करें।',
    gu: 'આ રેકોર્ડિંગ ઉમેરવા માટે બહુ ટૂંકું હતું. ઓછામાં ઓછી એક સેકન્ડ રેકોર્ડ કરો.',
  },
  voiceTooLong: {
    en: 'This recording ran past two minutes and was not added. Record a shorter note.',
    hi: 'यह रिकॉर्डिंग दो मिनट से लंबी थी और जोड़ी नहीं गई। छोटा नोट रिकॉर्ड करें।',
    gu: 'આ રેકોર્ડિંગ બે મિનિટથી લાંબું હતું અને ઉમેરાયું નથી. નાની નોટ રેકોર્ડ કરો.',
  },
  voiceFormat: {
    en: 'This browser records voice in a format Vitan cannot send. Try another browser, such as Chrome or Safari.',
    hi: 'यह ब्राउज़र आवाज़ ऐसे फ़ॉर्मेट में रिकॉर्ड करता है जिसे Vitan भेज नहीं सकता। कोई दूसरा ब्राउज़र आज़माएँ, जैसे Chrome या Safari।',
    gu: 'આ બ્રાઉઝર અવાજ એવા ફોર્મેટમાં રેકોર્ડ કરે છે જે Vitan મોકલી શકતું નથી. બીજું બ્રાઉઝર અજમાવો, જેમ કે Chrome અથવા Safari.',
  },
  voiceUnreadable: {
    en: 'This recording could not be read. Record it again.',
    hi: 'यह रिकॉर्डिंग पढ़ी नहीं जा सकी। फिर से रिकॉर्ड करें।',
    gu: 'આ રેકોર્ડિંગ વાંચી શકાયું નહીં. ફરી રેકોર્ડ કરો.',
  },
  voiceTooBig: {
    en: 'This recording is too large to send. Record a shorter note.',
    hi: 'यह रिकॉर्डिंग भेजने के लिए बहुत बड़ी है। छोटा नोट रिकॉर्ड करें।',
    gu: 'આ રેકોર્ડિંગ મોકલવા માટે બહુ મોટું છે. નાની નોટ રેકોર્ડ કરો.',
  },
  voiceNoStorage: {
    en: 'This voice note was not added: this browser cannot save it on the phone (private browsing cannot). Open the app in a normal browser window and record it again.',
    hi: 'यह वॉइस नोट नहीं जोड़ा गया: यह ब्राउज़र इसे फ़ोन पर सहेज नहीं सकता (प्राइवेट ब्राउज़िंग नहीं कर सकती)। ऐप को सामान्य ब्राउज़र विंडो में खोलें और फिर से रिकॉर्ड करें।',
    gu: 'આ વૉઇસ નોટ ઉમેરાઈ નથી: આ બ્રાઉઝર તેને ફોન પર સાચવી શકતું નથી (પ્રાઇવેટ બ્રાઉઝિંગ નથી સાચવી શકતું). ઍપ સામાન્ય બ્રાઉઝર વિન્ડોમાં ખોલો અને ફરી રેકોર્ડ કરો.',
  },
  voiceNotKept: {
    en: 'This voice note was not added: it could not be saved on this phone. Free some space on the phone, then record it again.',
    hi: 'यह वॉइस नोट नहीं जोड़ा गया: इसे इस फ़ोन पर सहेजा नहीं जा सका। फ़ोन में कुछ जगह खाली करें, फिर से रिकॉर्ड करें।',
    gu: 'આ વૉઇસ નોટ ઉમેરાઈ નથી: તેને આ ફોન પર સાચવી શકાઈ નહીં. ફોનમાં થોડી જગ્યા ખાલી કરો, પછી ફરી રેકોર્ડ કરો.',
  },
  voiceMaybeNotKept: {
    en: 'This voice note may not have been saved: the phone did not say in time. If it does not appear on the visit soon, record it again.',
    hi: 'हो सकता है यह वॉइस नोट सहेजा न गया हो: फ़ोन ने समय पर नहीं बताया। अगर यह जल्द ही विज़िट पर न दिखे, तो इसे फिर से रिकॉर्ड करें।',
    gu: 'આ વૉઇસ નોટ કદાચ સચવાઈ ન હોય: ફોને સમયસર જણાવ્યું નહીં. જો તે થોડી વારમાં મુલાકાત પર ન દેખાય, તો તેને ફરી રેકોર્ડ કરો.',
  },
  voicePlaceGone: {
    en: 'The place you chose was removed from this visit. Choose the place again, then record the note.',
    hi: 'आपकी चुनी जगह इस विज़िट से हटा दी गई। जगह फिर से चुनें, फिर नोट रिकॉर्ड करें।',
    gu: 'તમે પસંદ કરેલી જગ્યા આ મુલાકાતમાંથી દૂર કરાઈ. જગ્યા ફરી પસંદ કરો, પછી નોટ રેકોર્ડ કરો.',
  },
  // #995 V2b: a video clip on the visit, up to a minute, recorded in the app and kept and sent the way a voice note is
  videoClip: { en: 'Video', hi: 'वीडियो', gu: 'વીડિયો' },
  recordVideo: { en: 'Record video', hi: 'वीडियो रिकॉर्ड करें', gu: 'વીડિયો રેકોર્ડ કરો' },
  // said while the camera starts, before the clip records from its first picture (29 Oct)
  videoStarting: { en: 'Starting the camera…', hi: 'कैमरा शुरू हो रहा है…', gu: 'કૅમેરા શરૂ થઈ રહ્યો છે…' },
  videoCapped: {
    en: 'The video stopped at one minute and was added.',
    hi: 'वीडियो एक मिनट पर रुक गया और जोड़ दिया गया।',
    gu: 'વીડિયો એક મિનિટે અટકી ગયો અને ઉમેરાઈ ગયો.',
  },
  videoPlayFailed: { en: 'This video could not be played.', hi: 'यह वीडियो चल नहीं सका।', gu: 'આ વીડિયો ચાલી શક્યો નહીં.' },
  videoDenied: {
    en: 'Videos need the camera. Allow the camera for this site in the browser settings, then try again.',
    hi: 'वीडियो के लिए कैमरा चाहिए। ब्राउज़र सेटिंग में इस साइट के लिए कैमरे की अनुमति दें, फिर से कोशिश करें।',
    gu: 'વીડિયો માટે કૅમેરા જોઈએ. બ્રાઉઝર સેટિંગમાં આ સાઇટ માટે કૅમેરાની મંજૂરી આપો, પછી ફરી પ્રયત્ન કરો.',
  },
  videoUnavailable: {
    en: 'This phone could not start recording. Check that no other app is using the camera, then try again.',
    hi: 'यह फ़ोन रिकॉर्डिंग शुरू नहीं कर सका। देखें कि कोई दूसरा ऐप कैमरा इस्तेमाल न कर रहा हो, फिर से कोशिश करें।',
    gu: 'આ ફોન રેકોર્ડિંગ શરૂ કરી શક્યો નહીં. જુઓ કે બીજી કોઈ ઍપ કૅમેરા વાપરતી ન હોય, પછી ફરી પ્રયત્ન કરો.',
  },
  videoTooLong: {
    en: 'This video ran past one minute and was not added. Record a shorter video.',
    hi: 'यह वीडियो एक मिनट से लंबा था और जोड़ा नहीं गया। छोटा वीडियो रिकॉर्ड करें।',
    gu: 'આ વીડિયો એક મિનિટથી લાંબો હતો અને ઉમેરાયો નથી. નાનો વીડિયો રેકોર્ડ કરો.',
  },
  videoFormat: {
    en: 'This browser records video in a format Vitan cannot send. Try another browser, such as Chrome or Safari.',
    hi: 'यह ब्राउज़र वीडियो ऐसे फ़ॉर्मेट में रिकॉर्ड करता है जिसे Vitan भेज नहीं सकता। कोई दूसरा ब्राउज़र आज़माएँ, जैसे Chrome या Safari।',
    gu: 'આ બ્રાઉઝર વીડિયો એવા ફોર્મેટમાં રેકોર્ડ કરે છે જે Vitan મોકલી શકતું નથી. બીજું બ્રાઉઝર અજમાવો, જેમ કે Chrome અથવા Safari.',
  },
  videoTooBig: {
    en: 'This video is too large to send. Record a shorter video.',
    hi: 'यह वीडियो भेजने के लिए बहुत बड़ा है। छोटा वीडियो रिकॉर्ड करें।',
    gu: 'આ વીડિયો મોકલવા માટે બહુ મોટો છે. નાનો વીડિયો રેકોર્ડ કરો.',
  },
  videoNoStorage: {
    en: 'This video was not added: this browser cannot save it on the phone (private browsing cannot). Open the app in a normal browser window and record it again.',
    hi: 'यह वीडियो नहीं जोड़ा गया: यह ब्राउज़र इसे फ़ोन पर सहेज नहीं सकता (प्राइवेट ब्राउज़िंग नहीं कर सकती)। ऐप को सामान्य ब्राउज़र विंडो में खोलें और फिर से रिकॉर्ड करें।',
    gu: 'આ વીડિયો ઉમેરાયો નથી: આ બ્રાઉઝર તેને ફોન પર સાચવી શકતું નથી (પ્રાઇવેટ બ્રાઉઝિંગ નથી સાચવી શકતું). ઍપ સામાન્ય બ્રાઉઝર વિન્ડોમાં ખોલો અને ફરી રેકોર્ડ કરો.',
  },
  videoNotKept: {
    en: 'This video was not added: it could not be saved on this phone. Free some space on the phone, then record it again.',
    hi: 'यह वीडियो नहीं जोड़ा गया: इसे इस फ़ोन पर सहेजा नहीं जा सका। फ़ोन में कुछ जगह खाली करें, फिर से रिकॉर्ड करें।',
    gu: 'આ વીડિયો ઉમેરાયો નથી: તેને આ ફોન પર સાચવી શકાયો નહીં. ફોનમાં થોડી જગ્યા ખાલી કરો, પછી ફરી રેકોર્ડ કરો.',
  },
  videoMaybeNotKept: {
    en: 'This video may not have been saved: the phone did not say in time. If it does not appear on the visit soon, record it again.',
    hi: 'हो सकता है यह वीडियो सहेजा न गया हो: फ़ोन ने समय पर नहीं बताया। अगर यह जल्द ही विज़िट पर न दिखे, तो इसे फिर से रिकॉर्ड करें।',
    gu: 'આ વીડિયો કદાચ સચવાયો ન હોય: ફોને સમયસર જણાવ્યું નહીં. જો તે થોડી વારમાં મુલાકાત પર ન દેખાય, તો તેને ફરી રેકોર્ડ કરો.',
  },
  videoPlaceGone: {
    en: 'The place you chose was removed from this visit. Choose the place again, then record the video.',
    hi: 'आपकी चुनी जगह इस विज़िट से हटा दी गई। जगह फिर से चुनें, फिर वीडियो रिकॉर्ड करें।',
    gu: 'તમે પસંદ કરેલી જગ્યા આ મુલાકાતમાંથી દૂર કરાઈ. જગ્યા ફરી પસંદ કરો, પછી વીડિયો રેકોર્ડ કરો.',
  },
  // M3: marking up a photo on the visit; the copy is a new photo, the original stays as it was
  markUp: { en: 'Mark up', hi: 'निशान लगाएँ', gu: 'નિશાન કરો' },
  markupCopy: { en: 'Marked-up copy', hi: 'निशान लगी कॉपी', gu: 'નિશાનવાળી નકલ' },
  // a copy on a visit card names its original by its place in that visit's photos ({n})
  markupCopyOf: { en: 'Marked-up copy of photo {n}', hi: 'फ़ोटो {n} की निशान लगी कॉपी', gu: 'ફોટો {n} ની નિશાનવાળી નકલ' },
  markupSourceGone: {
    en: 'Marked-up copy · original no longer available',
    hi: 'निशान लगी कॉपी · मूल फ़ोटो अब उपलब्ध नहीं है',
    gu: 'નિશાનવાળી નકલ · મૂળ ફોટો હવે ઉપલબ્ધ નથી',
  },
  markupOpening: { en: 'Opening the photo…', hi: 'फ़ोटो खुल रही है…', gu: 'ફોટો ખૂલી રહ્યો છે…' },
  markupCannotOpen: {
    en: 'This phone cannot open this photo for marking.',
    hi: 'यह फ़ोन इस फ़ोटो को निशान लगाने के लिए नहीं खोल सकता।',
    gu: 'આ ફોન આ ફોટાને નિશાન કરવા માટે ખોલી શકતો નથી.',
  },
  markupOpenFailed: {
    en: 'The photo could not be opened. Check the signal, then try again.',
    hi: 'फ़ोटो खुल नहीं सकी। सिग्नल देखें, फिर से कोशिश करें।',
    gu: 'ફોટો ખૂલી શક્યો નહીં. સિગ્નલ તપાસો, પછી ફરી પ્રયત્ન કરો.',
  },
  markupTooBig: {
    en: 'This marked-up copy is too large to send.',
    hi: 'निशान लगी यह कॉपी भेजने के लिए बहुत बड़ी है।',
    gu: 'આ નિશાનવાળી નકલ મોકલવા માટે બહુ મોટી છે.',
  },
  // #1179: taking a file off a visit (online only), and the visit's lines for the files taken off it
  removeAsk: {
    en: 'This file will be removed for everyone. This can’t be undone.',
    hi: 'यह फ़ाइल सबके लिए हटा दी जाएगी। इसे वापस नहीं लाया जा सकता।',
    gu: 'આ ફાઇલ બધા માટે કાઢી નાખવામાં આવશે. તેને પાછી લાવી શકાશે નહીં.',
  },
  removeReason: { en: 'Why are you removing it?', hi: 'आप इसे क्यों हटा रहे हैं?', gu: 'તમે તેને કેમ કાઢો છો?' },
  removeReasonLong: {
    en: 'Keep the reason to 300 characters.',
    hi: 'कारण 300 अक्षरों तक रखें।',
    gu: 'કારણ 300 અક્ષરો સુધી રાખો.',
  },
  removeYes: { en: 'Remove file', hi: 'फ़ाइल हटाएँ', gu: 'ફાઇલ કાઢો' },
  removeKeep: { en: 'Keep it', hi: 'रहने दें', gu: 'રહેવા દો' },
  removeUntil: { en: 'You can remove it until', hi: 'आप इसे इस समय तक हटा सकते हैं:', gu: 'તમે તેને આ સમય સુધી કાઢી શકો છો:' },
  fileRemoved: { en: 'File removed.', hi: 'फ़ाइल हटा दी गई।', gu: 'ફાઇલ કાઢી નાખી.' },
  notRemoved: { en: 'The file was not removed.', hi: 'फ़ाइल नहीं हटी।', gu: 'ફાઇલ કઢાઈ નથી.' },
  removeOffline: {
    en: 'No signal. Removing a file needs a connection.',
    hi: 'सिग्नल नहीं है। फ़ाइल हटाने के लिए इंटरनेट चाहिए।',
    gu: 'સિગ્નલ નથી. ફાઇલ કાઢવા માટે ઇન્ટરનેટ જોઈએ.',
  },
  removeUnreachable: {
    en: 'No answer from the server. If the file is still listed, try again.',
    hi: 'सर्वर से जवाब नहीं आया। अगर फ़ाइल अब भी दिख रही है, तो फिर कोशिश करें।',
    gu: 'સર્વર તરફથી જવાબ ન આવ્યો. જો ફાઇલ હજી દેખાય છે, તો ફરી પ્રયત્ન કરો.',
  },
  removals: { en: 'Removed files', hi: 'हटाई गई फ़ाइलें', gu: 'કાઢેલી ફાઇલો' },
  removedBy: { en: 'Removed by', hi: 'हटाने वाले', gu: 'કાઢનાર' },
  removedOwn: {
    en: 'Removed by the person who added it.',
    hi: 'जोड़ने वाले ने ख़ुद हटाई।',
    gu: 'ઉમેરનારે પોતે કાઢી.',
  },
  removalReason: { en: 'Reason:', hi: 'कारण:', gu: 'કારણ:' },
  photo: { en: 'Photo', hi: 'फ़ोटो', gu: 'ફોટો' },
  file: { en: 'File', hi: 'फ़ाइल', gu: 'ફાઇલ' },
} satisfies Record<string, Words>;

/** #1179: the server's refusals of a removal (site-visit-files.participant.ts, media.service.ts), in each language. The
 *  English is the server's own words. */
const REMOVAL_REFUSALS: Record<string, Words> = {
  'Say why you are removing this file': {
    en: 'Say why you are removing this file',
    hi: 'बताइए कि आप यह फ़ाइल क्यों हटा रहे हैं',
    gu: 'તમે આ ફાઇલ કેમ કાઢો છો તે જણાવો',
  },
  'Only the person who added this file, or the PMC, may remove it': {
    en: 'Only the person who added this file, or the PMC, may remove it',
    hi: 'यह फ़ाइल वही हटा सकता है जिसने इसे जोड़ा, या PMC',
    gu: 'આ ફાઇલ તે જ કાઢી શકે જેણે તે ઉમેરી હતી, અથવા PMC',
  },
  'This site visit was closed by the PMC; ask the PMC to remove the file': {
    en: 'This site visit was closed by the PMC; ask the PMC to remove the file',
    hi: 'यह साइट विज़िट PMC ने बंद कर दी है; फ़ाइल हटाने के लिए PMC से कहें',
    gu: 'આ સાઇટ મુલાકાત PMCએ બંધ કરી છે; ફાઇલ કાઢવા PMCને કહો',
  },
  'This site visit has ended; ask the PMC to remove the file': {
    en: 'This site visit has ended; ask the PMC to remove the file',
    hi: 'यह साइट विज़िट ख़त्म हो चुकी है; फ़ाइल हटाने के लिए PMC से कहें',
    gu: 'આ સાઇટ મુલાકાત પૂરી થઈ ગઈ છે; ફાઇલ કાઢવા PMCને કહો',
  },
  'A file can be removed only within an hour of adding it; ask the PMC': {
    en: 'A file can be removed only within an hour of adding it; ask the PMC',
    hi: 'फ़ाइल जोड़ने के एक घंटे के अंदर ही हटाई जा सकती है; PMC से कहें',
    gu: 'ફાઇલ ઉમેર્યાના એક કલાકમાં જ કાઢી શકાય છે; PMCને કહો',
  },
  'This file was just cited as evidence on another record, so it cannot be removed': {
    en: 'This file was just cited as evidence on another record, so it cannot be removed',
    hi: 'यह फ़ाइल अभी किसी दूसरे रिकॉर्ड में सबूत के तौर पर जोड़ी गई है, इसलिए हटाई नहीं जा सकती',
    gu: 'આ ફાઇલ હમણાં જ બીજા રેકોર્ડમાં પુરાવા તરીકે જોડાઈ છે, તેથી કાઢી શકાય નહીં',
  },
};

/** A server's reason for refusing a removal, in the viewer's language when it is one of the removal refusals above; any
 *  other reason is shown in the server's own words. */
export function removalRefusalWords(reason: string, lang: Lang): string {
  // a refusal of the request's own fields names the field first ("reason: …")
  return REMOVAL_REFUSALS[reason.trim().replace(/^reason:\s*/u, '')]?.[lang] ?? reason;
}

/** Stage 1 voice notes: the server's refusals of a voice note (and a video clip) it reads (#1025, media.service.ts), in each language. The
 *  English is the server's own words, so a refusal reads the same whichever language the reason came through. */
const VOICE_REFUSALS: Record<string, Words> = {
  'This file is not the voice recording its type says': {
    en: 'This file is not the voice recording its type says',
    hi: 'यह फ़ाइल वैसी वॉइस रिकॉर्डिंग नहीं है जैसी इसका प्रकार बताता है',
    gu: 'આ ફાઇલ તેના પ્રકાર મુજબની વૉઇસ રેકોર્ડિંગ નથી',
  },
  'A voice note is at most two minutes long': {
    en: 'A voice note is at most two minutes long',
    hi: 'वॉइस नोट ज़्यादा से ज़्यादा दो मिनट का होता है',
    gu: 'વૉઇસ નોટ વધુમાં વધુ બે મિનિટની હોય છે',
  },
  'This voice note is not as long as its upload says': {
    en: 'This voice note is not as long as its upload says',
    hi: 'यह वॉइस नोट उतना लंबा नहीं है जितना इसके अपलोड में बताया गया है',
    gu: 'આ વૉઇસ નોટ તેના અપલોડમાં કહ્યા જેટલી લાંબી નથી',
  },
  'A voice note is added on a site visit': {
    en: 'A voice note is added on a site visit',
    hi: 'वॉइस नोट साइट विज़िट पर ही जोड़ा जाता है',
    gu: 'વૉઇસ નોટ સાઇટ મુલાકાત પર જ ઉમેરાય છે',
  },
  // #995 V1: the same refusals of a video clip
  // (only ever a clip recorded in the app, so said as a recording that went wrong, with what to do: 29 Oct)
  'This file is not the video its type says': {
    en: 'This video didn’t record properly. Please record it again.',
    hi: 'यह वीडियो ठीक से रिकॉर्ड नहीं हुआ। कृपया इसे फिर से रिकॉर्ड करें।',
    gu: 'આ વીડિયો બરાબર રેકોર્ડ થયો નથી. કૃપા કરીને તેને ફરી રેકોર્ડ કરો.',
  },
  'A video is at most a minute long': {
    en: 'A video is at most a minute long',
    hi: 'वीडियो ज़्यादा से ज़्यादा एक मिनट का होता है',
    gu: 'વીડિયો વધુમાં વધુ એક મિનિટનો હોય છે',
  },
  'This video is not as long as its upload says': {
    en: 'This video is not as long as its upload says',
    hi: 'यह वीडियो उतना लंबा नहीं है जितना इसके अपलोड में बताया गया है',
    gu: 'આ વીડિયો તેના અપલોડમાં કહ્યા જેટલો લાંબો નથી',
  },
  'A video is added on a site visit': {
    en: 'A video is added on a site visit',
    hi: 'वीडियो साइट विज़िट पर ही जोड़ा जाता है',
    gu: 'વીડિયો સાઇટ મુલાકાત પર જ ઉમેરાય છે',
  },
};

/** A server's reason for refusing a visit file, in the viewer's language when it is one of the voice refusals above;
 *  any other reason is shown in the server's own words. */
export function refusalWords(reason: string, lang: Lang): string {
  return VOICE_REFUSALS[reason.trim()]?.[lang] ?? reason;
}

/** A server time as the viewer reads it, in India's time: "14 Oct, 15:30" in the viewer's language. */
export function visitTime(iso: string, lang: Lang): string {
  const locale = lang === 'hi' ? 'hi-IN' : lang === 'gu' ? 'gu-IN' : 'en-IN';
  return new Intl.DateTimeFormat(locale, {
    day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: 'Asia/Kolkata',
  }).format(new Date(iso));
}
