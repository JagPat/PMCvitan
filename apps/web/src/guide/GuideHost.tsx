import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { useStore } from '@/store/store';
import { langPreferenceKey } from '@/lib/langPreference';
import { projectDataUsable } from '@/store/projectScope';
import { guidesFor, type Guide } from './guides';
import { readGuidesDone, markGuideDone } from './guideDone';
import { useGuideState } from './guideState';
import { findGuideTarget, findStepTarget, GUIDE_REWIND_MS, GUIDE_TICK_MS, type Box } from './guideTarget';
import { GUIDE_TIPS, GUIDE_WORDS } from './words';
import styles from './Guide.module.css';

/** Move the run past its current step (finishing the guide after the last one). */
function completeStep(doneKey: string, g: ReturnType<typeof useGuideState.getState>, pressedKey: string | null): void {
  if (!g.run) return;
  const { guide, step } = g.run;
  if (step + 1 < guide.steps.length) {
    g.setStep(step + 1, pressedKey ?? undefined);
  } else {
    markGuideDone(doneKey, guide.id);
    g.stop();
  }
}

const enabled = (el: HTMLElement | null): el is HTMLElement => el !== null && !(el as HTMLButtonElement).disabled;

function sameBox(a: Box | null, b: Box | null): boolean {
  return a === b || (!!a && !!b && a.top === b.top && a.left === b.left && a.width === b.width && a.height === b.height && a.dialog === b.dialog);
}

/**
 * #482 (board decision 14 Oct) — coach marks on the live screen.
 *
 * Mounted once in the shell. While a guide runs it dims the screen around the step's real control,
 * shows one short tip beside it with a one-tap Skip, and moves to the next step when the person
 * presses that control, or, for a step that must really happen (a photo attached, a submit accepted),
 * when the control marks itself `data-guide-done`. Nothing blocks the screen: the dimming lets every tap through, so the person
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
      const { guide, step, key: runKey } = g.run;
      const show = (el: HTMLElement) => {
        const dialog = el.closest<HTMLElement>('[role="dialog"]');
        // a dialog still sliding in is a moving containing block for the tip: wait for it to settle
        if (dialog && typeof dialog.getAnimations === 'function' && dialog.getAnimations().length > 0) {
          setBox(null);
          return;
        }
        const r = el.getBoundingClientRect();
        const next = { top: r.top, left: r.left, width: r.width, height: r.height, dialog };
        setBox((prev) => (sameBox(prev, next) ? prev : next));
      };
      const here = findStepTarget(guide.steps[step]!, runKey);
      if (here) {
        missing.current = null;
        if (guide.steps[step]!.until === 'done' && here.getAttribute('data-guide-done') === 'true') {
          completeStep(key, g, null);
          return;
        }
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
        const el = findStepTarget(guide.steps[i]!, runKey);
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
    // a control saying its step is done (a photo attached, a submit accepted) is seen at once, before
    // a later render can take it away
    const observer = new MutationObserver(tick);
    observer.observe(document.body, { subtree: true, attributes: true, attributeFilter: ['data-guide-done'] });
    return () => {
      live = false;
      window.clearInterval(id);
      window.removeEventListener('scroll', tick, true);
      window.removeEventListener('resize', tick);
      observer.disconnect();
      unsubscribe();
    };
  }, [ready, role, screen, key]);

  // pressing a `press` step's control moves the guide on (carrying that control's key to a `keyed`
  // step); pressing the last one finishes it
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      const g = useGuideState.getState();
      if (!g.run) return;
      const current = g.run.guide.steps[g.run.step]!;
      if (current.until === 'done') return;
      const target = e.target instanceof Element ? e.target : null;
      const pressed = target?.closest(`[data-guide="${current.target}"]`);
      if (!pressed) return;
      if (current.keyed && pressed.getAttribute('data-guide-key') !== g.run.key) return;
      completeStep(key, g, pressed.getAttribute('data-guide-key'));
    };
    document.addEventListener('click', onClick, true);
    return () => document.removeEventListener('click', onClick, true);
  }, [key]);

  // "Guide me" replays a guide: that is this visit's one start, so nothing auto-starts after it
  useEffect(() => {
    if (run) autoUsed.current = true;
  }, [run]);

  // scroll a step's control into view once, when the step begins
  const step = run ? run.guide.steps[run.step]! : null;
  const runKey = run?.key ?? null;
  useEffect(() => {
    if (!step) return;
    const el = findStepTarget(step, runKey);
    if (el && typeof el.scrollIntoView === 'function') el.scrollIntoView({ block: 'nearest' });
  }, [step, runKey]);

  if (!run || !box || !ready) return null;

  const skip = () => {
    markGuideDone(key, run.guide.id);
    useGuideState.getState().stop();
  };
  const tip = GUIDE_TIPS[run.guide.steps[run.step]!.tip][lang];

  return createPortal(
    <>
      <div
        className={box.dialog ? `${styles.spot} ${styles.spotInDialog}` : styles.spot}
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
    // inside a dialog, the tip lives IN it: the dialog's focus trap and `aria-modal` then include Skip
    box.dialog ?? document.body,
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
