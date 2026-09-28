import { LANG_SWITCH, shellLabels } from '@vitan/shared';
import { useStore } from '@/store/store';
import { noteLangChoice } from '@/lib/langPreference';
import styles from './LanguageSwitch.module.css';

/**
 * UX foundations — the rail's language switch (ગુજ / हिं / EN), shown to every role on tablet and
 * desktop. Each option carries its language's own name as a tooltip and `lang` attribute, and the
 * current one is `aria-pressed` and filled — never colour alone. The phone uses the top bar's
 * button and `LanguageSheet` instead; both write the same store value, which `LangPreference`
 * remembers for this person.
 */
export function LanguageSwitch() {
  const lang = useStore((s) => s.lang);
  const setLang = useStore((s) => s.setLang);
  return (
    <div className={styles.group} role="group" aria-label={shellLabels.language[lang]} data-testid="lang-segmented">
      {LANG_SWITCH.map((l) => {
        const on = l.key === lang;
        return (
          <button
            key={l.key}
            type="button"
            lang={l.key}
            title={l.name}
            aria-pressed={on}
            data-testid={`lang-seg-${l.key}`}
            className={on ? `${styles.option} ${styles.optionOn}` : styles.option}
            onClick={() => {
              noteLangChoice(l.key);
              setLang(l.key);
            }}
          >
            {l.mark}
          </button>
        );
      })}
    </div>
  );
}
