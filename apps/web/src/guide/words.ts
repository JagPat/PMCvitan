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
} satisfies Record<string, Words>;

export type GuideTip = keyof typeof GUIDE_TIPS;

export const GUIDE_WORDS = {
  skip: { en: 'Skip', hi: 'छोड़ें', gu: 'છોડો' },
  guideMe: { en: 'Guide me', hi: 'मुझे दिखाएँ', gu: 'મને બતાવો' },
} satisfies Record<string, Words>;
