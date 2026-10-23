import type { Lang } from '@vitan/shared';

/** WEB-02 (#792): what the person is told when this phone's saved updates for a project cannot be read */
type Words = Record<Lang, string>;

export const QW = {
  unreadable: {
    en: 'Updates saved on this phone for this project can’t be read.',
    hi: 'इस प्रोजेक्ट के लिए इस फ़ोन पर सहेजे गए बदलाव पढ़े नहीं जा सकते।',
    gu: 'આ પ્રોજેક્ટ માટે આ ફોન પર સાચવેલા ફેરફારો વાંચી શકાતા નથી.',
  },
  newerRelease: {
    en: 'Updates saved on this phone by a newer version of Vitan can’t be read here.',
    hi: 'Vitan के नए संस्करण ने इस फ़ोन पर जो बदलाव सहेजे हैं, वे यहाँ पढ़े नहीं जा सकते।',
    gu: 'Vitanના નવા સંસ્કરણે આ ફોન પર સાચવેલા ફેરફારો અહીં વાંચી શકાતા નથી.',
  },
} satisfies Record<string, Words>;
