/**
 * #482 site photos, "Who fixes this?" (RM-w1) — the picker the PMC and the engineer use to name the contractor or
 * consultant member who fixes an inspection's failed work. Member names are project data, shown as recorded.
 *
 * The role words follow the ones already in use: hi ठेकेदार / सलाहकार, gu કોન્ટ્રાક્ટર / સલાહકાર. Jagrut may reword any
 * line later; the PR body lists all five in the three languages.
 */
import type { Lang } from '../domain/types';

type Words = Record<Lang, string>;

export const responsibleMemberLabels = {
  label: { en: 'Who fixes this?', hi: 'इसे कौन ठीक करेगा?', gu: 'આ કોણ સુધારશે?' },
  nobody: { en: 'Nobody yet', hi: 'अभी कोई नहीं', gu: 'હજી કોઈ નહીં' },
  hint: {
    en: 'Only contractors and consultants on this project can be chosen.',
    hi: 'इस प्रोजेक्ट के ठेकेदार और सलाहकार ही चुने जा सकते हैं।',
    gu: 'આ પ્રોજેક્ટના કોન્ટ્રાક્ટર અને સલાહકાર જ પસંદ કરી શકાય છે.',
  },
  offline: {
    en: 'Choosing who fixes this needs a connection.',
    hi: 'इसे कौन ठीक करेगा, यह चुनने के लिए नेटवर्क चाहिए।',
    gu: 'આ કોણ સુધારશે તે પસંદ કરવા નેટવર્ક જોઈએ.',
  },
  saveFailed: {
    en: 'Could not save who fixes this. Try again.',
    hi: 'इसे कौन ठीक करेगा, यह सहेजा नहीं जा सका। फिर कोशिश करें।',
    gu: 'આ કોણ સુધારશે તે સાચવી શકાયું નહીં. ફરી પ્રયાસ કરો.',
  },
} satisfies Record<string, Words>;
