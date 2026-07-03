import { accessDict, tradeLabels, workerTradeLabels, type AccessStrings, type Lang } from '@vitan/shared';
import { useStore } from '@/store/store';

export interface Translator {
  lang: Lang;
  t: AccessStrings;
  trade: (key: string) => string;
  workerTrade: (key: string) => string;
}

/** Current-language labels for the site/worker access flow (live-switching). */
export function useT(): Translator {
  const lang = useStore((s) => s.lang);
  return {
    lang,
    t: accessDict[lang],
    trade: (key) => tradeLabels[key]?.[lang] ?? key,
    workerTrade: (key) => workerTradeLabels[key]?.[lang] ?? key,
  };
}
