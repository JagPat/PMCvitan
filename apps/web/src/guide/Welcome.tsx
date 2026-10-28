import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useStore } from '@/store/store';
import { langPreferenceKey } from '@/lib/langPreference';
import { projectDataUsable } from '@/store/projectScope';
import { useNavItems } from '@/layout/useNavItems';
import { guidesForRole, type Guide } from './guides';
import { guideStartable } from './guideTarget';
import { markWelcomeSeen, readGuidesDone, readWelcomeSeen } from './guideDone';
import { useGuideState } from './guideState';
import { WELCOME_ROLE, WELCOME_WORDS } from './words';
import styles from './Guide.module.css';

/**
 * #482 — the first-time welcome: the first time a person opens a project (in this browser), one card at the top
 * of the stage says what Vitan is for, for their role, and that Help is at the top of every screen. "Show me
 * around" starts their first guide (on its own screen, through Help's ask); "Not now" or "Got it" closes it for
 * good. It is a card in the page flow, never a dialog, so it blocks nothing on the screen below it.
 *
 * Shown once per person, keyed like the guides' done list; "Show the first-time tips again" brings it back. A
 * dev sign-in still settling moves the person from their persona's key to their user key: a welcome closed under
 * the persona stays closed for that user.
 */
export function Welcome() {
  const lang = useStore((s) => s.lang);
  const role = useStore((s) => s.role);
  const userId = useStore((s) => s.sessionUserId);
  const ready = useStore((s) => projectDataUsable(s.projectLoadState));
  const setScreen = useStore((s) => s.setScreen);
  const tipsEpoch = useGuideState((s) => s.tipsEpoch);
  const reachable = new Set(useNavItems().map((n) => n.key));
  const key = langPreferenceKey(userId, role);
  // re-read the stored mark after a close, a "tips again" or a change of person
  const [, setRead] = useState(0);
  const closedUnder = useRef<string | null>(null);

  useEffect(() => {
    const from = closedUnder.current;
    if (from !== null && from !== key && from.startsWith('persona:') && key.startsWith('user:')) markWelcomeSeen(key);
    closedUnder.current = null;
    setRead((n) => n + 1);
  }, [key, tipsEpoch]);

  const open = ready && !readWelcomeSeen(key);
  // set before the overlay's first look (a layout effect runs ahead of its passive one), so no guide starts under the card
  useLayoutEffect(() => {
    useGuideState.getState().setWelcomeOpen(open);
  }, [open]);
  useLayoutEffect(() => () => useGuideState.getState().setWelcomeOpen(false), []);

  if (!open) return null;

  const close = () => {
    markWelcomeSeen(key);
    closedUnder.current = key;
    setRead((n) => n + 1);
  };
  const guides = guidesForRole(role).filter((g) => reachable.has(g.screen));
  const first = guides[0] ?? null;
  const showMeAround = () => {
    const pick = pickGuide(guides, readGuidesDone(key), useStore.getState().screen);
    if (!pick) return;
    close();
    useGuideState.getState().request(pick);
    setScreen(pick.screen);
  };

  return (
    <section className={styles.welcome} aria-labelledby="welcome-title" data-testid="welcome">
      <h2 id="welcome-title" className={styles.welcomeTitle}>{WELCOME_WORDS.title[lang]}</h2>
      <p className={styles.welcomeText}>{WELCOME_ROLE[role][lang]}</p>
      <p className={styles.welcomeText}>{WELCOME_WORDS.help[lang]}</p>
      <div className={styles.welcomeActions}>
        {first ? (
          <>
            <button type="button" className={styles.welcomePrimary} onClick={showMeAround} data-testid="welcome-tour">
              {WELCOME_WORDS.showMeAround[lang]}
            </button>
            <button type="button" className={styles.welcomeSecondary} onClick={close} data-testid="welcome-close">
              {WELCOME_WORDS.notNow[lang]}
            </button>
          </>
        ) : (
          <button type="button" className={styles.welcomePrimary} onClick={close} data-testid="welcome-close">
            {WELCOME_WORDS.gotIt[lang]}
          </button>
        )}
      </div>
    </section>
  );
}

/**
 * The guide "Show me around" starts: the first one not done yet that can start, i.e. on this screen with its first
 * control there and pressable now, or on another screen with something to show it on; failing that the first that can start at
 * all, done or not; failing that the first not done (Help's note then says there is nothing to show it on yet).
 */
function pickGuide(guides: readonly Guide[], done: ReadonlySet<string>, screen: string): Guide | null {
  const canStart = (g: Guide) =>
    g.screen === screen ? guideStartable(g) : (g.available?.() ?? true);
  const notDone = guides.filter((g) => !done.has(g.id));
  return notDone.find(canStart) ?? guides.find(canStart) ?? notDone[0] ?? guides[0] ?? null;
}
