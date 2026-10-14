import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { useStore } from '@/store/store';
import { langPreferenceKey } from '@/lib/langPreference';
import { projectDataUsable } from '@/store/projectScope';
import { guidesFor, type Guide } from './guides';
import { readGuidesDone, markGuideDone } from './guideDone';
import { useGuideState } from './guideState';
import { findGuideTarget, GUIDE_REWIND_MS, GUIDE_TICK_MS, type Box } from './guideTarget';
import { GUIDE_TIPS, GUIDE_WORDS } from './words';
import styles from './Guide.module.css';

const enabled = (el: HTMLElement | null): el is HTMLElement => el !== null && !(el as HTMLButtonElement).disabled;

function sameBox(a: Box | null, b: Box | null): boolean {
  return a === b || (!!a && !!b && a.top === b.top && a.left === b.left && a.width === b.width && a.height === b.height && a.inDialog === b.inDialog);
}

/**
 * #482 (board decision 14 Oct) — coach marks on the live screen.
 *
 * Mounted once in the shell. While a guide runs it dims the screen around the step's real control,
 * shows one short tip beside it with a one-tap Skip, and moves to the next step when the person
 * presses that control. Nothing blocks the screen: the dimming lets every tap through, so the person
 * is always doing the real task, never a demo of it.
 *
 * - The first time a person reaches a guided screen, its first unfinished guide starts by itself,
 *   once its first control is on screen and pressable. At most ONE guide starts per screen visit,
 *   so a screen with several guides offers them one visit at a time instead of stacking them.
 * - Finishing the last step, or Skip, marks the guide done for this person in this browser.
 * - Leaving the screen, signing out or a project reload ends the run without marking it done, so it
 *   comes back next time.
 * - When a step's control goes away (a menu closed, a modal cancelled) the guide steps back to the
 *   latest earlier step whose control is still there, so the person can pick the task up again.
 */
export function GuideHost() {
  const role = useStore((s) => s.role);
  const userId = useStore((s) => s.sessionUserId);
  const screen = useStore((s) => s.screen);
  const lang = useStore((s) => s.lang);
  // the same test the + button uses: project data on screen is the project's own
  const ready = useStore((s) => projectDataUsable(s.projectLoadState));
  const run = useGuideState((s) => s.run);
  const key = langPreferenceKey(userId, role);
  const [box, setBox] = useState<Box | null>(null);
  // one automatic start per screen visit (per person); "Guide me" also uses it up
  const autoUsed = useRef(false);
  // when the running step's control was first found missing (see the step-back rule in `tick`)
  const missing = useRef<{ guideId: string; step: number; since: number } | null>(null);

  // a new visit, a new person or a project reload: end the run (not done) and allow one auto start
  useEffect(() => {
    autoUsed.current = false;
    useGuideState.getState().stop();
  }, [screen, key, ready]);

  useEffect(() => {
    if (!ready) {
      useGuideState.getState().setOffer(null);
      setBox(null);
      return;
    }
    let live = true;
    const tick = () => {
      if (!live) return;
      const g = useGuideState.getState();
      const guides = guidesFor(role, screen);
      if (!g.run) {
        setBox(null);
        missing.current = null;
        const startable = (guide: Guide) => enabled(findGuideTarget(guide.steps[0]!.target));
        g.setOffer(guides.find(startable) ?? null);
        if (autoUsed.current) return;
        const done = readGuidesDone(key);
        const next = guides.find((guide) => !done.has(guide.id));
        if (next && startable(next)) {
          autoUsed.current = true;
          g.start(next);
        }
        return;
      }
      const { guide, step } = g.run;
      const show = (el: HTMLElement) => {
        const r = el.getBoundingClientRect();
        const next = { top: r.top, left: r.left, width: r.width, height: r.height, inDialog: el.closest('[role="dialog"]') !== null };
        setBox((prev) => (sameBox(prev, next) ? prev : next));
      };
      const here = findGuideTarget(guide.steps[step]!.target);
      if (here) {
        missing.current = null;
        show(here);
        return;
      }
      // The step's control is not on screen. Right after a press it is usually still being drawn (the
      // menu the + opens), so wait a moment before deciding it went away; then step back to the latest
      // earlier step whose control is still there. Hidden meanwhile.
      setBox(null);
      const now = Date.now();
      if (!missing.current || missing.current.step !== step || missing.current.guideId !== guide.id) {
        missing.current = { guideId: guide.id, step, since: now };
        return;
      }
      if (now - missing.current.since < GUIDE_REWIND_MS) return;
      for (let i = step - 1; i >= 0; i--) {
        const el = findGuideTarget(guide.steps[i]!.target);
        if (!el) continue;
        missing.current = null;
        g.setStep(i);
        show(el);
        return;
      }
    };
    tick();
    const id = window.setInterval(tick, GUIDE_TICK_MS);
    window.addEventListener('scroll', tick, true);
    window.addEventListener('resize', tick);
    // a new run or step is measured at once, not on the next tick
    const unsubscribe = useGuideState.subscribe((s, prev) => {
      if (s.run !== prev.run) queueMicrotask(tick);
    });
    return () => {
      live = false;
      window.clearInterval(id);
      window.removeEventListener('scroll', tick, true);
      window.removeEventListener('resize', tick);
      unsubscribe();
    };
  }, [ready, role, screen, key]);

  // pressing the step's control moves the guide on; pressing the last one finishes it
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      const g = useGuideState.getState();
      if (!g.run) return;
      const { guide, step } = g.run;
      const target = e.target instanceof Element ? e.target : null;
      if (!target?.closest(`[data-guide="${guide.steps[step]!.target}"]`)) return;
      if (step + 1 < guide.steps.length) {
        g.setStep(step + 1);
      } else {
        markGuideDone(key, guide.id);
        g.stop();
      }
    };
    document.addEventListener('click', onClick, true);
    return () => document.removeEventListener('click', onClick, true);
  }, [key]);

  // "Guide me" replays a guide: that is this visit's one start, so nothing auto-starts after it
  useEffect(() => {
    if (run) autoUsed.current = true;
  }, [run]);

  // scroll a step's control into view once, when the step begins
  const stepTarget = run ? run.guide.steps[run.step]!.target : null;
  useEffect(() => {
    if (!stepTarget) return;
    const el = findGuideTarget(stepTarget);
    if (el && typeof el.scrollIntoView === 'function') el.scrollIntoView({ block: 'nearest' });
  }, [stepTarget]);

  if (!run || !box || !ready) return null;

  const skip = () => {
    markGuideDone(key, run.guide.id);
    useGuideState.getState().stop();
  };
  const tip = GUIDE_TIPS[run.guide.steps[run.step]!.tip][lang];

  return createPortal(
    <>
      <div
        className={box.inDialog ? `${styles.spot} ${styles.spotInDialog}` : styles.spot}
        aria-hidden="true"
        data-testid="guide-spot"
        style={{ top: box.top - 6, left: box.left - 6, width: box.width + 12, height: box.height + 12 }}
      />
      <div className={styles.tip} style={tipPosition(box)} role="status" data-testid="guide-tip" data-guide-id={run.guide.id} data-guide-step={run.step}>
        <p className={styles.tipText}>{tip}</p>
        <button type="button" className={styles.skip} onClick={skip} data-testid="guide-skip">
          {GUIDE_WORDS.skip[lang]}
        </button>
      </div>
    </>,
    document.body,
  );
}

const TIP_WIDTH = 280;
const TIP_ROOM = 90;

/** Below the control when there is room, otherwise above it; never past either edge. */
function tipPosition(box: Box): CSSProperties {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const width = Math.min(TIP_WIDTH, vw - 24);
  const left = Math.max(12, Math.min(box.left + box.width / 2 - width / 2, vw - width - 12));
  const below = box.top + box.height + 12;
  return below + TIP_ROOM <= vh
    ? { width, left, top: below }
    : { width, left, bottom: Math.max(12, vh - box.top + 12) };
}
