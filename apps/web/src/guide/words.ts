import type { Lang } from '@vitan/shared';

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
} satisfies Record<string, Words>;

export type GuideTip = keyof typeof GUIDE_TIPS;

/**
 * #482 — the one line an empty screen shows under its "nothing here yet", naming the button on that
 * screen that starts the work. The button is marked +, so the line points at the + in every language.
 */
export const EMPTY_HINTS = {
  checklist: {
    en: 'To send the engineer something to check, tap + New checklist above.',
    hi: 'इंजीनियर से कुछ जँचवाना है? ऊपर + वाला बटन दबाएँ।',
    gu: 'એન્જિનિયર પાસે કંઈ તપાસાવવું છે? ઉપર + વાળું બટન દબાવો.',
  },
} satisfies Record<string, Words>;

export type EmptyHintTask = keyof typeof EMPTY_HINTS;

export const GUIDE_WORDS = {
  skip: { en: 'Skip', hi: 'छोड़ें', gu: 'છોડો' },
  guideMe: { en: 'Guide me', hi: 'मुझे दिखाएँ', gu: 'મને બતાવો' },
} satisfies Record<string, Words>;
