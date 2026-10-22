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
    en: 'Updates saved on this phone by a newer version of Vitan can’t be read here. Reload the page to send them.',
    hi: 'Vitan के नए संस्करण ने इस फ़ोन पर जो बदलाव सहेजे हैं, वे यहाँ पढ़े नहीं जा सकते। उन्हें भेजने के लिए पेज फिर से लोड करें।',
    gu: 'Vitanના નવા સંસ્કરણે આ ફોન પર સાચવેલા ફેરફારો અહીં વાંચી શકાતા નથી. તેમને મોકલવા માટે પેજ ફરીથી લોડ કરો.',
  },
  reload: { en: 'Reload', hi: 'फिर से लोड करें', gu: 'ફરીથી લોડ કરો' },
  newerReloaded: {
    en: 'These updates were saved by a newer version of Vitan. This version can’t send them. Set them aside to keep working. They stay on this phone.',
    hi: 'ये बदलाव Vitan के नए संस्करण ने सहेजे थे। यह संस्करण उन्हें नहीं भेज सकता। काम जारी रखने के लिए इन्हें अलग रखें। ये इस फ़ोन पर रहेंगे।',
    gu: 'આ ફેરફારો Vitanના નવા સંસ્કરણે સાચવ્યા હતા. આ સંસ્કરણ તેમને મોકલી શકતું નથી. કામ ચાલુ રાખવા માટે તેમને અલગ રાખો. તે આ ફોન પર રહેશે.',
  },
  setAside: { en: 'Set aside and continue', hi: 'अलग रखें और जारी रखें', gu: 'અલગ રાખો અને ચાલુ રાખો' },
  setAsideFailed: {
    en: 'They could not be set aside on this phone, so nothing was changed.',
    hi: 'उन्हें इस फ़ोन पर अलग नहीं रखा जा सका, इसलिए कुछ नहीं बदला गया।',
    gu: 'તેમને આ ફોન પર અલગ રાખી શકાયા નહીં, તેથી કંઈ બદલાયું નથી.',
  },
  leaveTitle: {
    en: '{n} updates aren’t saved on this phone and will be lost. Continue?',
    hi: '{n} बदलाव इस फ़ोन पर सहेजे नहीं गए हैं और खो जाएँगे। जारी रखें?',
    gu: '{n} ફેરફારો આ ફોન પર સચવાયા નથી અને ખોવાઈ જશે. ચાલુ રાખવું છે?',
  },
} satisfies Record<string, Words>;
