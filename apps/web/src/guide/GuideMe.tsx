import { useStore } from '@/store/store';
import { useGuideState } from './guideState';
import { GUIDE_WORDS } from './words';
import styles from './Guide.module.css';

/**
 * #482 — "Guide me": replays the current screen's guide. It sits IN the page flow at the top of a
 * guided screen (never floating), so at any width it cannot cover one of the screen's own buttons.
 * Shown only where a guide for this role can start right now, and hidden while one runs.
 */
export function GuideMe() {
  const lang = useStore((s) => s.lang);
  const offer = useGuideState((s) => s.offer);
  const running = useGuideState((s) => s.run !== null);
  const start = useGuideState((s) => s.start);
  if (!offer || running) return null;
  return (
    <div className={styles.guideMeRow}>
      <button type="button" className={styles.guideMe} onClick={() => start(offer)} data-testid="guide-me">
        <span aria-hidden="true" className={styles.guideMeMark}>?</span>
        {GUIDE_WORDS.guideMe[lang]}
      </button>
    </div>
  );
}
