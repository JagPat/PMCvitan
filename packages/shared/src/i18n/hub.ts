/**
 * #1118 U7a L2 — the words of a project's Hub link, in English, Hindi and Gujarati: the "Hub 24-017" label beside the
 * Site Code, "Open in Hub", and the Hub project row a company owner or admin links and unlinks from. Hub's project
 * numbers and names are Hub's data, shown as Hub gave them.
 */

import type { Lang } from '../domain/types';

const pick = (lang: Lang, en: string, hi: string, gu: string): string => (lang === 'hi' ? hi : lang === 'gu' ? gu : en);

export const hubLabels = {
  eyebrow: { en: 'HUB PROJECT', hi: 'Hub प्रोजेक्ट', gu: 'Hub પ્રોજેક્ટ' },
  intro: {
    en: 'The Hub project this site belongs to. Hub keeps the project, plan, drawings and BOQ; PMC keeps the site work. Linking only joins the two.',
    hi: 'यह साइट जिस Hub प्रोजेक्ट की है। प्रोजेक्ट, प्लान, ड्रॉइंग और BOQ Hub में रहते हैं; साइट का काम PMC में। लिंक करने से दोनों बस जुड़ जाते हैं।',
    gu: 'આ સાઇટ જે Hub પ્રોજેક્ટની છે. પ્રોજેક્ટ, પ્લાન, ડ્રોઇંગ અને BOQ Hubમાં રહે છે; સાઇટનું કામ PMCમાં. લિંક કરવાથી બંને માત્ર જોડાય છે.',
  },
  notLinked: { en: 'Not linked to a Hub project yet.', hi: 'अभी किसी Hub प्रोजेक्ट से लिंक नहीं है।', gu: 'હજી કોઈ Hub પ્રોજેક્ટ સાથે લિંક નથી.' },
  choose: { en: 'Link to a Hub project', hi: 'Hub प्रोजेक्ट से लिंक करें', gu: 'Hub પ્રોજેક્ટ સાથે લિંક કરો' },
  pickerTitle: { en: 'Choose the Hub project', hi: 'Hub प्रोजेक्ट चुनें', gu: 'Hub પ્રોજેક્ટ પસંદ કરો' },
  loading: { en: 'Loading Hub projects…', hi: 'Hub प्रोजेक्ट लोड हो रहे हैं…', gu: 'Hub પ્રોજેક્ટ લોડ થઈ રહ્યા છે…' },
  empty: { en: 'Hub has no open projects PMC can reach.', hi: 'Hub में ऐसा कोई खुला प्रोजेक्ट नहीं जिस तक PMC पहुँच सके।', gu: 'Hubમાં એવો કોઈ ખુલ્લો પ્રોજેક્ટ નથી જ્યાં PMC પહોંચી શકે.' },
  link: { en: 'Link', hi: 'लिंक करें', gu: 'લિંક કરો' },
  linking: { en: 'Linking…', hi: 'लिंक हो रहा है…', gu: 'લિંક થઈ રહ્યું છે…' },
  thisSite: { en: 'This site', hi: 'यही साइट', gu: 'આ જ સાઇટ' },
  otherSite: { en: 'Linked to another site', hi: 'दूसरी साइट से लिंक', gu: 'બીજી સાઇટ સાથે લિંક' },
  unlink: { en: 'Unlink', hi: 'लिंक हटाएँ', gu: 'લિંક હટાવો' },
  unlinking: { en: 'Unlinking…', hi: 'लिंक हट रहा है…', gu: 'લિંક હટી રહી છે…' },
  confirmUnlinkTitle: { en: 'Unlink this site from Hub?', hi: 'इस साइट का Hub से लिंक हटाएँ?', gu: 'આ સાઇટની Hub સાથેની લિંક હટાવવી?' },
  confirmUnlinkBody: {
    en: 'Hub stops sending this site its drawing updates. Nothing in Hub or PMC is deleted, and you can link again later.',
    hi: 'Hub इस साइट को ड्रॉइंग के अपडेट भेजना बंद कर देगा। Hub या PMC में कुछ नहीं मिटेगा, और बाद में फिर लिंक कर सकते हैं।',
    gu: 'Hub આ સાઇટને ડ્રોઇંગના અપડેટ મોકલવાનું બંધ કરશે. Hub કે PMCમાં કંઈ નહીં ભૂંસાય, અને પછી ફરી લિંક કરી શકાય.',
  },
  cancel: { en: 'Cancel', hi: 'रद्द करें', gu: 'રદ કરો' },
  close: { en: 'Close', hi: 'बंद करें', gu: 'બંધ કરો' },
  retry: { en: 'Try again', hi: 'फिर कोशिश करें', gu: 'ફરી પ્રયાસ કરો' },
  openInHub: { en: 'Open in Hub', hi: 'Hub में खोलें', gu: 'Hubમાં ખોલો' },
  linked: { en: 'Linked to Hub.', hi: 'Hub से लिंक हो गया।', gu: 'Hub સાથે લિંક થઈ ગયું.' },
  unlinked: { en: 'Unlinked from Hub.', hi: 'Hub से लिंक हट गया।', gu: 'Hub સાથેની લિંક હટી ગઈ.' },
  hubNotCleared: {
    en: 'Unlinked in PMC, but Hub may still show the link. Try again to clear it in Hub.',
    hi: 'PMC में लिंक हट गया, पर Hub में अभी भी दिख सकता है। Hub में हटाने के लिए फिर कोशिश करें।',
    gu: 'PMCમાં લિંક હટી ગઈ, પણ Hubમાં હજી દેખાઈ શકે. Hubમાં હટાવવા ફરી પ્રયાસ કરો.',
  },
  closed: {
    en: 'Hub is not connected for this company yet.',
    hi: 'इस कंपनी के लिए Hub अभी जुड़ा नहीं है।',
    gu: 'આ કંપની માટે Hub હજી જોડાયેલું નથી.',
  },
  unavailable: { en: "Hub isn't answering. Try again in a moment.", hi: 'Hub जवाब नहीं दे रहा। थोड़ी देर में फिर कोशिश करें।', gu: 'Hub જવાબ નથી આપતું. થોડી વારમાં ફરી પ્રયાસ કરો.' },
  keyRefused: {
    en: "Hub refused PMC's key. An administrator needs to renew it.",
    hi: 'Hub ने PMC की चाबी (key) नहीं मानी। किसी एडमिन को इसे नया करना होगा।',
    gu: 'Hubએ PMCની ચાવી (key) ન સ્વીકારી. કોઈ એડમિને તેને નવી કરવી પડશે.',
  },
  hubRefused: { en: 'Hub could not do this. Try again later.', hi: 'Hub यह नहीं कर सका। बाद में फिर कोशिश करें।', gu: 'Hub આ ન કરી શક્યું. પછી ફરી પ્રયાસ કરો.' },
  forbidden: {
    en: 'Only a company owner or admin can link a project to Hub.',
    hi: 'केवल कंपनी का मालिक या एडमिन ही प्रोजेक्ट को Hub से लिंक कर सकता है।',
    gu: 'ફક્ત કંપનીના માલિક કે એડમિન જ પ્રોજેક્ટને Hub સાથે લિંક કરી શકે.',
  },
  linkedElsewhere: {
    en: 'This site is already linked to another Hub project. Unlink it first.',
    hi: 'यह साइट पहले से किसी दूसरे Hub प्रोजेक्ट से लिंक है। पहले वह लिंक हटाएँ।',
    gu: 'આ સાઇટ પહેલેથી બીજા Hub પ્રોજેક્ટ સાથે લિંક છે. પહેલાં એ લિંક હટાવો.',
  },
  projectTaken: {
    en: 'That Hub project is already linked to another site.',
    hi: 'वह Hub प्रोजेक्ट पहले से दूसरी साइट से लिंक है।',
    gu: 'એ Hub પ્રોજેક્ટ પહેલેથી બીજી સાઇટ સાથે લિંક છે.',
  },
  drawingsElsewhere: {
    en: "This site already holds drawings from another Hub project, so it can't be linked to this one.",
    hi: 'इस साइट पर पहले से दूसरे Hub प्रोजेक्ट की ड्रॉइंग हैं, इसलिए इसे इस प्रोजेक्ट से लिंक नहीं कर सकते।',
    gu: 'આ સાઇટ પર પહેલેથી બીજા Hub પ્રોજેક્ટનાં ડ્રોઇંગ છે, તેથી તેને આ પ્રોજેક્ટ સાથે લિંક ન કરી શકાય.',
  },
  notLinkedNow: { en: 'This site is not linked to Hub any more.', hi: 'यह साइट अब Hub से लिंक नहीं है।', gu: 'આ સાઇટ હવે Hub સાથે લિંક નથી.' },
  projectUnavailable: {
    en: "That Hub project is archived, or PMC's Hub key doesn't reach it.",
    hi: 'वह Hub प्रोजेक्ट आर्काइव हो चुका है, या PMC की Hub key उस तक नहीं पहुँचती।',
    gu: 'એ Hub પ્રોજેક્ટ આર્કાઇવ થઈ ગયો છે, અથવા PMCની Hub key ત્યાં પહોંચતી નથી.',
  },
  failed: { en: 'Could not reach PMC. Try again.', hi: 'PMC तक नहीं पहुँच सके। फिर कोशिश करें।', gu: 'PMC સુધી પહોંચી ન શક્યા. ફરી પ્રયાસ કરો.' },
} satisfies Record<string, Record<Lang, string>>;

export const hubText = {
  /** The project's Hub label: "Hub 24-017", Hub's name when Hub gave no number, else just "Hub". */
  label: (number: string | null, name: string | null): string => {
    const id = number ?? name;
    return id ? `Hub ${id}` : 'Hub';
  },
  /** One Hub project in the picker: "24-017 · Patel residence". */
  choice: (number: string | null, name: string | null): string => [number, name].filter((x): x is string => !!x).join(' · '),
  linkedTo: (label: string, lang: Lang): string => pick(lang, `Linked to ${label}`, `${label} से लिंक`, `${label} સાથે લિંક`),
};
