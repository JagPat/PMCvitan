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
  /** step B2f-1: an act made while this tab could not write it to this phone (no cross-tab lock, an unreadable key) */
  notSavedYet: {
    en: 'Not saved on this phone yet. Keep Vitan open until it sends.',
    hi: 'अभी इस फ़ोन पर सहेजा नहीं गया। भेजे जाने तक Vitan खुला रखें।',
    gu: 'હજુ આ ફોન પર સાચવાયું નથી. મોકલાય ત્યાં સુધી Vitan ખુલ્લું રાખો.',
  },
  /** #1373: the person lost the project they were in. `{project}` is its name; `{n}` the changes this device keeps for it
   *  (in its own queue keys, under its own scope), sent by the flush if their access returns (#1388 tracks a discard) */
  roleChanged: {
    en: 'Your role on {project} changed.',
    hi: '{project} पर आपकी भूमिका बदल गई है।',
    gu: '{project} પર તમારી ભૂમિકા બદલાઈ ગઈ છે.',
  },
  accessLost: {
    en: 'You no longer have access to {project}.',
    hi: 'अब आपके पास {project} की पहुँच नहीं है।',
    gu: 'હવે તમારી પાસે {project}નો પ્રવેશ નથી.',
  },
  keptForLost: {
    en: '{n} changes for {project} are kept on this device and will be sent if your access returns.',
    hi: '{project} के लिए {n} बदलाव इस डिवाइस पर रखे गए हैं और आपकी पहुँच वापस मिलने पर भेजे जाएँगे।',
    gu: '{project} માટેના {n} ફેરફારો આ ઉપકરણ પર રાખેલા છે અને તમારો પ્રવેશ પાછો મળશે ત્યારે મોકલાશે.',
  },
  keptForLostOne: {
    en: '1 change for {project} is kept on this device and will be sent if your access returns.',
    hi: '{project} के लिए 1 बदलाव इस डिवाइस पर रखा गया है और आपकी पहुँच वापस मिलने पर भेजा जाएगा।',
    gu: '{project} માટેનો 1 ફેરફાર આ ઉપકરણ પર રાખેલો છે અને તમારો પ્રવેશ પાછો મળશે ત્યારે મોકલાશે.',
  },
  /** #1388 (unit 1): the list of changes this device keeps for projects the person no longer holds */
  keptElsewhere: {
    en: 'Changes kept for {n} projects you no longer have',
    hi: '{n} प्रोजेक्ट के बदलाव रखे गए हैं जिनकी पहुँच अब आपके पास नहीं है',
    gu: '{n} પ્રોજેક્ટના ફેરફારો રાખેલા છે જેનો પ્રવેશ હવે તમારી પાસે નથી',
  },
  keptElsewhereOne: {
    en: 'Changes kept for a project you no longer have',
    hi: 'एक प्रोजेक्ट के बदलाव रखे गए हैं जिसकी पहुँच अब आपके पास नहीं है',
    gu: 'એક પ્રોજેક્ટના ફેરફારો રાખેલા છે જેનો પ્રવેશ હવે તમારી પાસે નથી',
  },
  keptTitle: { en: 'Changes kept on this device', hi: 'इस डिवाइस पर रखे गए बदलाव', gu: 'આ ઉપકરણ પર રાખેલા ફેરફારો' },
  keptIntro: {
    en: 'These were never sent. They will be sent if your access returns and you open the project on this device.',
    hi: 'ये कभी भेजे नहीं गए। आपकी पहुँच वापस मिलने पर, इस डिवाइस पर प्रोजेक्ट खोलते ही ये भेज दिए जाएँगे।',
    gu: 'આ ક્યારેય મોકલાયા નથી. તમારો પ્રવેશ પાછો મળે અને તમે આ ઉપકરણ પર પ્રોજેક્ટ ખોલો ત્યારે તે મોકલાશે.',
  },
  keptUnknownProject: {
    en: 'A project you no longer have access to',
    hi: 'एक प्रोजेक्ट जिसकी पहुँच अब आपके पास नहीं है',
    gu: 'એક પ્રોજેક્ટ જેનો પ્રવેશ હવે તમારી પાસે નથી',
  },
  keptCount: { en: '{n} changes', hi: '{n} बदलाव', gu: '{n} ફેરફારો' },
  keptCountOne: { en: '1 change', hi: '1 बदलाव', gu: '1 ફેરફાર' },
  keptSaved: { en: 'Saved {date}', hi: '{date} को सहेजा गया', gu: '{date}ના રોજ સાચવ્યું' },
  keptUnreadable: {
    en: 'Some changes saved for this project can’t be read by this version.',
    hi: 'इस प्रोजेक्ट के लिए सहेजे गए कुछ बदलाव यह संस्करण नहीं पढ़ सकता।',
    gu: 'આ પ્રોજેક્ટ માટે સાચવેલા કેટલાક ફેરફારો આ સંસ્કરણ વાંચી શકતું નથી.',
  },
  keptClose: { en: 'Close', hi: 'बंद करें', gu: 'બંધ કરો' },
  keptKindDecision: { en: 'Decision', hi: 'निर्णय', gu: 'નિર્ણય' },
  keptKindDrawing: { en: 'Drawing', hi: 'ड्रॉइंग', gu: 'ડ્રોઇંગ' },
  keptKindInspection: { en: 'Inspection', hi: 'निरीक्षण', gu: 'નિરીક્ષણ' },
  keptKindActivity: { en: 'Activity', hi: 'गतिविधि', gu: 'પ્રવૃત્તિ' },
  keptKindDailyLog: { en: 'Daily log', hi: 'दैनिक लॉग', gu: 'દૈનિક લૉગ' },
  keptKindSiteVisit: { en: 'Site visit', hi: 'साइट विज़िट', gu: 'સાઇટ મુલાકાત' },
  keptKindPhoto: { en: 'Photo or file', hi: 'फ़ोटो या फ़ाइल', gu: 'ફોટો અથવા ફાઇલ' },
  keptKindMaterials: { en: 'Materials', hi: 'सामग्री', gu: 'સામગ્રી' },
  keptKindLabour: { en: 'Labour', hi: 'श्रमिक', gu: 'મજૂરી' },
  keptKindCommercial: { en: 'Measurements, bills and payments', hi: 'माप, बिल और भुगतान', gu: 'માપ, બિલ અને ચુકવણી' },
  keptKindBudget: { en: 'Budget', hi: 'बजट', gu: 'બજેટ' },
} satisfies Record<string, Words>;

/** a QW line in `lang`, each `{name}` filled from `vars` */
export const qwFill = (w: Words, lang: Lang, vars: Record<string, string | number>): string =>
  w[lang].replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m));

/** #1388: the switcher's line, for `n` projects this device keeps changes for that the person no longer holds */
export const keptElsewhereLine = (n: number, lang: Lang): string =>
  n === 1 ? QW.keptElsewhereOne[lang] : qwFill(QW.keptElsewhere, lang, { n });
