import { useState } from 'react';
import { useStore } from '@/store/store';
import { langPreferenceKey } from '@/lib/langPreference';
import { CircleHelp, ChevronRight, RefreshCw } from '@/lib/icons';
import { MobileSheet } from '@/layout/MobileSheet';
import sheetStyles from '@/layout/MobileSheet.module.css';
import { useNavItems } from '@/layout/useNavItems';
import { guidesForRole, type Guide } from './guides';
import { clearGuidesDone } from './guideDone';
import { useGuideState } from './guideState';
import { GuideMe } from './GuideMe';
import { GUIDE_TITLES, HELP_WORDS, SCREEN_HELP } from './words';
import styles from './Guide.module.css';

/**
 * #482 — the row at the top of the stage on every screen of every project, for every role: "Guide me" when this
 * screen has a guide ready, and Help always. The shell mounts it OUTSIDE the project-load boundary, so Help stays
 * while a project loads or fails to. It is in the page flow, never floating, for the reason `GuideMe` gives; the
 * phone's top bar has no room left for one more 44px button at 320px.
 */
export function HelpRow() {
  return (
    <div className={styles.guideMeRow}>
      <GuideMe />
      <HelpButton />
    </div>
  );
}

export function HelpButton() {
  const lang = useStore((s) => s.lang);
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        className={styles.guideMe}
        onClick={() => setOpen(true)}
        aria-haspopup="dialog"
        aria-expanded={open}
        data-testid="help-open"
      >
        <CircleHelp size={18} aria-hidden="true" />
        {HELP_WORDS.help[lang]}
      </button>
      {open && <HelpSheet onClose={() => setOpen(false)} />}
    </>
  );
}

/**
 * What Help offers: one line on what this screen is for (every screen has one), "Show me how" for each task
 * this role has a guide for (only on screens this role can open, so it never sends anyone where the nav would
 * not), and the first-time tips again. A guide on another screen moves there first and starts once its first
 * control is on screen (`GuideHost`).
 */
export function HelpSheet({ onClose }: { onClose: () => void }) {
  const lang = useStore((s) => s.lang);
  const role = useStore((s) => s.role);
  const screen = useStore((s) => s.screen);
  const userId = useStore((s) => s.sessionUserId);
  const setScreen = useStore((s) => s.setScreen);
  const reachable = new Set(useNavItems().map((n) => n.key));
  const guides = guidesForRole(role).filter((g) => g.screen === screen || reachable.has(g.screen));

  const show = (guide: Guide) => {
    onClose();
    useGuideState.getState().request(guide);
    if (guide.screen !== useStore.getState().screen) setScreen(guide.screen);
  };
  const tipsAgain = () => {
    clearGuidesDone(langPreferenceKey(userId, role));
    useGuideState.getState().tipsAgain();
    onClose();
    useStore.getState().flash(HELP_WORDS.tipsAgainDone[lang]);
  };

  return (
    <MobileSheet title={HELP_WORDS.help[lang]} onClose={onClose} testId="help-sheet">
      <div className={sheetStyles.note} style={{ textAlign: 'left' }}>
        <strong>{HELP_WORDS.thisScreen[lang]}</strong>
        <div data-testid="help-screen-line" style={{ fontSize: 13.5, color: 'var(--ink)' }}>{SCREEN_HELP[screen][lang]}</div>
      </div>
      <div className={sheetStyles.note} style={{ textAlign: 'left', paddingBottom: 0 }}>
        <strong>{HELP_WORDS.showMeHow[lang]}</strong>
      </div>
      {guides.length === 0 && (
        <div className={sheetStyles.note} style={{ textAlign: 'left' }} data-testid="help-no-guides">
          {HELP_WORDS.noGuides[lang]}
        </div>
      )}
      {guides.map((g) => (
        <button key={g.id} type="button" className={sheetStyles.row} onClick={() => show(g)} data-testid={`help-guide-${g.id}`}>
          <span className={sheetStyles.rowLabel} style={{ whiteSpace: 'normal' }}>{GUIDE_TITLES[g.title][lang]}</span>
          <ChevronRight size={16} aria-hidden="true" />
        </button>
      ))}
      {guides.length > 0 && (
        <button type="button" className={sheetStyles.row} onClick={tipsAgain} data-testid="help-tips-again">
          <RefreshCw size={16} aria-hidden="true" />
          <span className={sheetStyles.rowLabel} style={{ whiteSpace: 'normal' }}>{HELP_WORDS.tipsAgain[lang]}</span>
        </button>
      )}
    </MobileSheet>
  );
}
