import { sitePhotoLabels, type Lang, type ScreenKey } from '@vitan/shared';

/**
 * #482 — the guide's words, one short line per step, in English, Hindi and Gujarati. No long text:
 * the spotlight shows WHICH control, so a tip only says what pressing it does.
 */
type Words = Record<Lang, string>;

export const GUIDE_TIPS = {
  issueMarkFail: {
    en: 'Problem with an item? Tap Fail on it.',
    hi: 'किसी चीज़ में दिक्कत है? उस पर ख़राब दबाएँ।',
    gu: 'કોઈ વસ્તુમાં તકલીફ છે? તેના પર ખામી દબાવો.',
  },
  issueFailPhoto: {
    en: 'Add a photo of the problem.',
    hi: 'दिक्कत की फ़ोटो जोड़ें।',
    gu: 'તકલીફનો ફોટો ઉમેરો.',
  },
  issueSubmit: {
    en: 'When you are done, send it from here.',
    hi: 'पूरा होने पर यहाँ से भेजें।',
    gu: 'પૂરું થાય ત્યારે અહીંથી મોકલો.',
  },
  issueAdd: {
    en: 'Seen a problem on site? Tap + to raise it.',
    hi: 'साइट पर कोई दिक्कत दिखी? दर्ज करने के लिए + दबाएँ।',
    gu: 'સાઇટ પર કોઈ તકલીફ દેખાઈ? નોંધવા માટે + દબાવો.',
  },
  issueAskCheck: {
    en: 'Tap here to have the engineer check it.',
    hi: 'इंजीनियर से जाँच करवाने के लिए यहाँ दबाएँ।',
    gu: 'ઇજનેર પાસે તપાસ કરાવવા અહીં દબાવો.',
  },
  issueSend: {
    en: 'Say what to check and where, then tap here.',
    hi: 'क्या और कहाँ जाँचना है लिखें, फिर यहाँ दबाएँ।',
    gu: 'શું અને ક્યાં તપાસવું તે લખો, પછી અહીં દબાવો.',
  },
  decisionAdd: {
    en: 'Something to be decided? Tap +.',
    hi: 'कुछ तय करना है? + दबाएँ।',
    gu: 'કંઈ નક્કી કરવાનું છે? + દબાવો.',
  },
  decisionPick: {
    en: 'Tap here to set out the choices.',
    hi: 'विकल्प लिखने के लिए यहाँ दबाएँ।',
    gu: 'વિકલ્પો લખવા અહીં દબાવો.',
  },
  decisionPublish: {
    en: 'Add a title, place and options, then tap here.',
    hi: 'शीर्षक, जगह और विकल्प भरें, फिर यहाँ दबाएँ।',
    gu: 'શીર્ષક, જગ્યા અને વિકલ્પો ભરો, પછી અહીં દબાવો.',
  },
  photoAdd: {
    en: 'Tap here to add a photo of the site: take one or pick one from your phone.',
    hi: 'साइट की फ़ोटो जोड़ने के लिए यहाँ दबाएँ: नई खींचें या फ़ोन से चुनें।',
    gu: 'સાઇટનો ફોટો ઉમેરવા અહીં દબાવો: નવો પાડો અથવા ફોનમાંથી પસંદ કરો.',
  },
} satisfies Record<string, Words>;

export type GuideTip = keyof typeof GUIDE_TIPS;

/**
 * #482 — the one line an empty screen shows under its "nothing here yet", naming the button on that
 * screen that starts the work. Most such buttons are marked +, so those lines point at the + in every language; the
 * photo line names its button by the button's own label, so the two never drift apart.
 */
export const EMPTY_HINTS = {
  checklist: {
    en: 'To send the engineer something to check, tap + New checklist above.',
    hi: 'इंजीनियर से कुछ जँचवाना है? ऊपर + वाला बटन दबाएँ।',
    gu: 'એન્જિનિયર પાસે કંઈ તપાસાવવું છે? ઉપર + વાળું બટન દબાવો.',
  },
  decision: {
    en: 'To put choices to the client, tap + Issue decision above.',
    hi: 'क्लाइंट से कुछ चुनवाना है? ऊपर + वाला बटन दबाएँ।',
    gu: 'ક્લાયન્ટ પાસે કંઈ પસંદ કરાવવું છે? ઉપર + વાળું બટન દબાવો.',
  },
  photo: {
    en: `To add the first photo of the site, tap ${sitePhotoLabels.add.en} above.`,
    hi: `साइट की पहली फ़ोटो जोड़नी है? ऊपर "${sitePhotoLabels.add.hi}" दबाएँ।`,
    gu: `સાઇટનો પહેલો ફોટો ઉમેરવો છે? ઉપર "${sitePhotoLabels.add.gu}" દબાવો.`,
  },
} satisfies Record<string, Words>;

export type EmptyHintTask = keyof typeof EMPTY_HINTS;

export const GUIDE_WORDS = {
  skip: { en: 'Skip', hi: 'छोड़ें', gu: 'છોડો' },
  guideMe: { en: 'Guide me', hi: 'मुझे दिखाएँ', gu: 'મને બતાવો' },
} satisfies Record<string, Words>;

/** #482 — each guide's name in the Help sheet's "Show me how" list: the task, in the person's words. */
export const GUIDE_TITLES = {
  raiseIssueEngineer: {
    en: 'Raise an issue on a checklist',
    hi: 'चेकलिस्ट पर दिक्कत दर्ज करें',
    gu: 'ચેકલિસ્ટ પર તકલીફ નોંધો',
  },
  raiseIssuePmc: {
    en: 'Raise an issue for the engineer to check',
    hi: 'इंजीनियर से जाँच के लिए दिक्कत दर्ज करें',
    gu: 'ઇજનેર પાસે તપાસ માટે તકલીફ નોંધો',
  },
  recordDecision: {
    en: 'Put a decision to the client',
    hi: 'क्लाइंट से फ़ैसला करवाएँ',
    gu: 'ક્લાયન્ટ પાસે નિર્ણય કરાવો',
  },
  addSitePhoto: {
    en: 'Add a site photo',
    hi: 'साइट की फ़ोटो जोड़ें',
    gu: 'સાઇટનો ફોટો ઉમેરો',
  },
} satisfies Record<string, Words>;

export type GuideTitle = keyof typeof GUIDE_TITLES;

/**
 * #482 — the Help sheet's one line on what the current screen is for, for EVERY screen, so help never
 * disappears: a screen with no step-by-step guide still says what it is for.
 */
export const SCREEN_HELP: Record<ScreenKey, Words> = {
  inbox: {
    en: 'The things waiting on you. Tap one to open it.',
    hi: 'जो काम आपका इंतज़ार कर रहे हैं। खोलने के लिए किसी पर दबाएँ।',
    gu: 'જે કામ તમારી રાહ જુએ છે. ખોલવા માટે કોઈ પર દબાવો.',
  },
  dashboard: {
    en: 'Your project at a glance: what needs doing, recent photos and progress.',
    hi: 'आपका प्रोजेक्ट एक नज़र में: क्या करना है, नई फ़ोटो और प्रगति।',
    gu: 'તમારો પ્રોજેક્ટ એક નજરમાં: શું કરવાનું છે, નવા ફોટા અને પ્રગતિ.',
  },
  'site-schedule': {
    en: 'The planned work on site, day by day, and what is running late.',
    hi: 'साइट का तय काम, दिन-ब-दिन, और क्या देर से चल रहा है।',
    gu: 'સાઇટનું નક્કી કામ, દિવસે-દિવસે, અને શું મોડું ચાલે છે.',
  },
  drafts: {
    en: 'Decisions and drawings you started but have not sent yet.',
    hi: 'फ़ैसले और ड्रॉइंग जो आपने शुरू किए पर अभी भेजे नहीं।',
    gu: 'નિર્ણયો અને ડ્રોઇંગ જે તમે શરૂ કર્યા પણ હજી મોકલ્યા નથી.',
  },
  'decision-log': {
    en: 'Every decision on this project and where each one stands.',
    hi: 'इस प्रोजेक्ट के सारे फ़ैसले और हर एक की स्थिति।',
    gu: 'આ પ્રોજેક્ટના બધા નિર્ણયો અને દરેકની સ્થિતિ.',
  },
  'inspect-review': {
    en: 'Checklists the engineer has sent back, for you to review.',
    hi: 'इंजीनियर की भेजी चेकलिस्ट, आपके देखने के लिए।',
    gu: 'ઇજનેરે પાછી મોકલેલી ચેકલિસ્ટ, તમારે જોવા માટે.',
  },
  'client-decisions': {
    en: 'Decisions waiting for an answer. Open one to see the options and reply.',
    hi: 'जिन फ़ैसलों का जवाब बाकी है। विकल्प देखने और जवाब देने के लिए एक खोलें।',
    gu: 'જે નિર્ણયોનો જવાબ બાકી છે. વિકલ્પો જોવા અને જવાબ આપવા એક ખોલો.',
  },
  'client-health': {
    en: 'How the project is doing overall.',
    hi: 'प्रोजेक्ट कुल मिलाकर कैसा चल रहा है।',
    gu: 'પ્રોજેક્ટ એકંદરે કેવો ચાલે છે.',
  },
  'daily-log': {
    en: "The day's record of the site: work done, people on site and photos.",
    hi: 'साइट का रोज़ का रिकॉर्ड: हुआ काम, साइट पर लोग और फ़ोटो।',
    gu: 'સાઇટનો રોજનો રેકોર્ડ: થયેલું કામ, સાઇટ પરના લોકો અને ફોટા.',
  },
  'engineer-check': {
    en: 'The checklists sent to you. Check each item, then send it back.',
    hi: 'आपको भेजी गई चेकलिस्ट। हर चीज़ जाँचें, फिर वापस भेजें।',
    gu: 'તમને મોકલેલી ચેકલિસ્ટ. દરેક વસ્તુ તપાસો, પછી પાછી મોકલો.',
  },
  drawings: {
    en: "The project's drawings. Open one to see its latest version.",
    hi: 'प्रोजेक्ट की ड्रॉइंग। नया रूप देखने के लिए एक खोलें।',
    gu: 'પ્રોજેક્ટના ડ્રોઇંગ. નવું રૂપ જોવા એક ખોલો.',
  },
  places: {
    en: "The site's floors and rooms. Tap a place to see what is happening there.",
    hi: 'साइट की मंज़िलें और कमरे। वहाँ क्या चल रहा है देखने के लिए किसी जगह पर दबाएँ।',
    gu: 'સાઇટના માળ અને ઓરડા. ત્યાં શું ચાલે છે તે જોવા કોઈ જગ્યા પર દબાવો.',
  },
  team: {
    en: 'The people on this project and what each one does.',
    hi: 'इस प्रोजेक्ट के लोग और हर एक का काम।',
    gu: 'આ પ્રોજેક્ટના લોકો અને દરેકનું કામ.',
  },
  portfolio: {
    en: 'All your projects in one place. Tap one to open it.',
    hi: 'आपके सारे प्रोजेक्ट एक जगह। खोलने के लिए किसी पर दबाएँ।',
    gu: 'તમારા બધા પ્રોજેક્ટ એક જગ્યાએ. ખોલવા માટે કોઈ પર દબાવો.',
  },
  'team-access': {
    en: 'Who can sign in to this project, and how.',
    hi: 'इस प्रोजेक्ट में कौन और कैसे साइन इन कर सकता है।',
    gu: 'આ પ્રોજેક્ટમાં કોણ અને કેવી રીતે સાઇન ઇન કરી શકે.',
  },
  materials: {
    en: 'Materials needed, ordered, delivered and in stock.',
    hi: 'ज़रूरी, मँगाया गया, पहुँचा और रखा हुआ माल।',
    gu: 'જરૂરી, મંગાવેલો, આવેલો અને પડેલો માલ.',
  },
  labour: {
    en: 'Workers needed, booked and on site.',
    hi: 'ज़रूरी, बुक किए गए और साइट पर मौजूद मज़दूर।',
    gu: 'જરૂરી, નક્કી કરેલા અને સાઇટ પર હાજર મજૂરો.',
  },
  commercial: {
    en: "The project's money: budget, commitments and payments.",
    hi: 'प्रोजेक्ट का पैसा: बजट, वादे और भुगतान।',
    gu: 'પ્રોજેક્ટના પૈસા: બજેટ, વાયદા અને ચુકવણી.',
  },
  'site-visits': {
    en: 'Visits to the site, with their notes, photos and voice notes.',
    hi: 'साइट के दौरे, उनके नोट, फ़ोटो और आवाज़ वाले नोट के साथ।',
    gu: 'સાઇટની મુલાકાતો, તેની નોંધ, ફોટા અને અવાજની નોંધ સાથે.',
  },
};

/** #482 — the Help button and sheet, reachable from every screen of every project, for every role. */
export const HELP_WORDS = {
  help: { en: 'Help', hi: 'मदद', gu: 'મદદ' },
  thisScreen: { en: 'On this screen', hi: 'इस स्क्रीन पर', gu: 'આ સ્ક્રીન પર' },
  showMeHow: { en: 'Show me how', hi: 'करके दिखाएँ', gu: 'કરીને બતાવો' },
  noGuides: {
    en: 'No step-by-step help for your role yet.',
    hi: 'आपकी भूमिका के लिए अभी क़दम-दर-क़दम मदद नहीं है।',
    gu: 'તમારી ભૂમિકા માટે હજી પગલે-પગલે મદદ નથી.',
  },
  tipsAgain: {
    en: 'Show the first-time tips again',
    hi: 'पहली बार वाले सुझाव फिर से दिखाएँ',
    gu: 'પહેલી વારની ટીપ્સ ફરી બતાવો',
  },
  tipsAgainDone: {
    en: 'First-time tips are back on.',
    hi: 'पहली बार वाले सुझाव फिर से चालू हैं।',
    gu: 'પહેલી વારની ટીપ્સ ફરી ચાલુ છે.',
  },
  notHere: {
    en: "Can't show that right now: there is nothing here to do it on yet.",
    hi: 'अभी यह नहीं दिखा सकते: यहाँ अभी इसके लिए कुछ नहीं है।',
    gu: 'હમણાં આ બતાવી શકાતું નથી: અહીં હજી આ માટે કંઈ નથી.',
  },
} satisfies Record<string, Words>;
