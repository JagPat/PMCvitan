import type { Lang } from '@vitan/shared';

/**
 * WEB-02 (#792): what the person is told when this phone's saved updates for a project cannot be read, or a new update
 * could not be kept on this phone. "Not kept" is said only when nothing was written.
 */
type Words = Record<Lang, string>;

export const QW = {
  unreadable: {
    en: 'Updates saved on this phone for this project can’t be read.',
    hi: 'इस प्रोजेक्ट के लिए इस फ़ोन पर सहेजे गए बदलाव पढ़े नहीं जा सकते।',
    gu: 'આ પ્રોજેક્ટ માટે આ ફોન પર સાચવેલા ફેરફારો વાંચી શકાતા નથી.',
  },
  setAside: { en: 'Set aside and continue', hi: 'अलग रखें और जारी रखें', gu: 'અલગ રાખો અને ચાલુ રાખો' },
  setAsideFailed: {
    en: 'They could not be set aside on this phone, so nothing was changed.',
    hi: 'उन्हें इस फ़ोन पर अलग नहीं रखा जा सका, इसलिए कुछ नहीं बदला गया।',
    gu: 'તેમને આ ફોન પર અલગ રાખી શકાયા નહીં, તેથી કંઈ બદલાયું નથી.',
  },
  notKept: {
    en: 'Not kept on this phone: this update is sent only if you stay on this project with this page open.',
    hi: 'इस फ़ोन पर नहीं रखा गया: यह बदलाव तभी भेजा जाएगा जब आप इसी प्रोजेक्ट पर रहें और यह पेज खुला रहे।',
    gu: 'આ ફોન પર રાખ્યું નથી: આ ફેરફાર ત્યારે જ મોકલાશે જો તમે આ જ પ્રોજેક્ટ પર રહો અને આ પેજ ખુલ્લું રહે.',
  },
  leaveTitle: {
    en: '{n} updates aren’t saved on this phone and will be lost. Continue?',
    hi: '{n} बदलाव इस फ़ोन पर सहेजे नहीं गए हैं और खो जाएँगे। जारी रखें?',
    gu: '{n} ફેરફારો આ ફોન પર સચવાયા નથી અને ખોવાઈ જશે. ચાલુ રાખવું છે?',
  },
  leaveContinue: { en: 'Continue', hi: 'जारी रखें', gu: 'ચાલુ રાખો' },
  unkeptLost: {
    en: '{n} updates that were not kept on this phone were lost.',
    hi: '{n} बदलाव जो इस फ़ोन पर नहीं रखे गए थे, खो गए।',
    gu: '{n} ફેરફારો જે આ ફોન પર રાખ્યા ન હતા, ખોવાઈ ગયા.',
  },
} satisfies Record<string, Words>;
