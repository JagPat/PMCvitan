/**
 * i18next initialisation. The app's live language lives in the Zustand store
 * (mirroring the prototype); this keeps i18next's active language in sync so
 * general/future translated strings resolve correctly. Domain labels for the
 * access flow are read directly from the shared dictionaries via useT().
 */
import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import { resources } from '@vitan/shared';
import { useStore } from '@/store/store';

void i18n.use(initReactI18next).init({
  resources,
  lng: useStore.getState().lang,
  fallbackLng: 'en',
  ns: ['access', 'trades', 'workerTrades'],
  defaultNS: 'access',
  interpolation: { escapeValue: false },
});

useStore.subscribe((s) => {
  if (i18n.language !== s.lang) void i18n.changeLanguage(s.lang);
});

export default i18n;
