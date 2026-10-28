import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { useStore } from '@/store/store';
import { langPreferenceKey } from '@/lib/langPreference';
import { projectDataUsable } from '@/store/projectScope';
import { guidesFor, guideOnScreen, type Guide } from './guides';
import { readGuidesDone, markGuideDone, clearGuidesDone } from './guideDone';
import { useGuideState } from './guideState';
import { findStepTarget, guideKeyMatches, guideStartable, GUIDE_ARRIVE_MS, GUIDE_REWIND_MS, GUIDE_TICK_MS, type Box } from './guideTarget';
import { subscribeGuideOutcome } from './outcomes';
import { GUIDE_TIPS, GUIDE_WORDS, HELP_WORDS } from './words';
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

/**
 * The guide "Guide me" starts when a screen has several ready: one not done yet first, else the one
 * after the guide started last, so pressing it again in later visits reaches each in turn.
 */
function replayOffer(ready: readonly Guide[], done: ReadonlySet<string>, lastStarted: string | null): Guide | null {
  const notDone = ready.find((g) => !done.has(g.id));
  if (notDone) return notDone;
  const last = ready.findIndex((g) => g.id === lastStarted);
  return ready[(last + 1) % ready.length] ?? null;
}

function sameBox(a: Box | null, b: Box | null): boolean {
  return a === b || (!!a && !!b && a.top === b.top && a.left === b.left && a.width === b.width && a.height === b.height && a.dialog === b.dialog && a.vw === b.vw && a.vh === b.vh);
}

/**
 * #482 (board decision 14 Oct) — coach marks on the live screen.
 *
 * Mounted once in the shell. While a guide runs it dims the screen around the step's real control,
 * shows one short tip beside it with a one-tap Skip, and moves to the next step when the person
 * presses that control; for a step that must really happen, only once it has: a photo attached (the
 * control marks itself `data-guide-done`), or a submit or issue the store reports as accepted. Nothing blocks the screen: the dimming lets every tap through, so the person
 * is always doing the real task, never a demo of it.
 *
 * - The first time a person reaches a guided screen, its first unfinished guide starts by itself,
 *   once its first control is on screen and pressable. At most ONE guide starts per screen visit,
 *   so a screen with several guides offers them one visit at a time instead of stacking them.
 * - Finishing the last step, or Skip, marks the guide done for this person in this browser.
 * - Leaving the screen, signing out or a project reload ends the run without marking it done, so it
 *   comes back next time.
 * - When a step's control goes away (a menu closed, a modal cancelled) the guide steps back to the
 *   latest earlier step whose control is still there, so the person can pick the task up again; with
 *   none left (the first control itself went away) the run ends, not done, and "Guide me" offers it.
 *   While a pressed action's outcome is awaited it neither steps back nor ends.
 * - A guide asked for from the Help sheet starts once its first control is on its screen, ahead of any
 *   automatic start. When that control does not come (nothing to do it on yet), the ask is dropped with a
 *   short note, so the press is never silently lost.
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
  // when a guide asked for from Help was first found unable to start on its screen
  const arrive = useRef<{ guide: Guide; since: number } | null>(null);
  const tipsEpoch = useGuideState((s) => s.tipsEpoch);

  // a new visit, a new person or a project reload: end the run (not done) and allow one auto start
  useEffect(() => {
    autoUsed.current = false;
    useGuideState.getState().stop();
  }, [screen, key, ready, tipsEpoch]);

  // a guide asked for from Help belongs to the visit to its screen: going elsewhere, or another person, drops it
  useEffect(() => {
    const asked = useGuideState.getState().requested;
    if (asked && !guideOnScreen(asked, screen)) useGuideState.getState().request(null);
  }, [screen]);
  useEffect(() => () => useGuideState.getState().request(null), [key]);

  // "first-time tips again" pressed before a dev-auth sign-in settled reset the persona's key; once the
  // signed-in key arrives it is the same person, so it is reset too. Any other change of person drops it.
  useEffect(() => {
    const g = useGuideState.getState();
    const from = g.tipsResetKey;
    if (from === null || from === key) return;
    if (from.startsWith('persona:') && key.startsWith('user:')) clearGuidesDone(key);
    g.clearTipsReset();
  }, [key]);

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
        const startable = guideStartable;
        const done = readGuidesDone(key);
        g.setOffer(replayOffer(guides.filter(startable), done, g.lastStarted));
        // read from the store, not this effect's `screen`: Help asks and then moves to the guide's screen in one
        // press, and a tick queued by that ask runs before this effect is rebuilt for the new screen
        const asked = g.requested;
        // asked for under another role (a project switch can change it): never point this role at that task
        if (asked && !asked.roles.includes(useStore.getState().role)) {
          arrive.current = null;
          g.request(null);
        } else if (asked && guideOnScreen(asked, useStore.getState().screen)) {
          if (startable(asked)) {
            arrive.current = null;
            autoUsed.current = true;
            g.request(null);
            g.start(asked);
            return;
          }
          const now = Date.now();
          if (!arrive.current || arrive.current.guide !== asked) {
            arrive.current = { guide: asked, since: now };
          } else if (now - arrive.current.since >= GUIDE_ARRIVE_MS) {
            arrive.current = null;
            const [next, ...rest] = g.fallbacks;
            if (next) {
              // "Show me around": nothing to show this one on yet, so the next one, on its own screen
              g.request(next, rest);
              useStore.getState().setScreen(next.screen);
            } else {
              g.request(null);
              useStore.getState().flash(HELP_WORDS.notHere[useStore.getState().lang]);
            }
          }
          return;
        }
        arrive.current = null;
        // the first-time welcome asks first: nothing starts by itself under it, nor after "Not now" on this visit
        if (g.welcomeOpen) autoUsed.current = true;
        if (autoUsed.current) return;
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
        const next = { top: r.top, left: r.left, width: r.width, height: r.height, dialog, vw: window.innerWidth, vh: window.innerHeight };
        setBox((prev) => (sameBox(prev, next) ? prev : next));
      };
      // a pressed action the store has since confirmed some other way (a live refresh that showed the
      // checklist submitted before the request's own answer arrived) is done, also after that answer said it failed:
      // the request can fail on the way back after the server took it, and the store's record wins over the reply.
      // Only after this run pressed the control: another tab's submit is not this run's act
      const settled = guide.steps[step]!.settled;
      if (g.run.pressed && settled?.(runKey)) {
        completeStep(key, g, null);
        return;
      }
      const current = guide.steps[step]!;
      // a step already done before the run reached it (a visit already open) is passed over, unpressed
      if (!g.run.pressed && current.skip?.()) {
        completeStep(key, g, null);
        return;
      }
      // a text box already focused when its step began (tapped before the guide started) is reached: no later
      // `focusin` would say so
      if (current.until === 'focus' && document.activeElement instanceof Element) {
        const focused = document.activeElement.closest(`[data-guide="${current.target}"]`);
        if (focused && (!current.keyed || runKey === null || guideKeyMatches(focused.getAttribute('data-guide-key'), runKey))) {
          completeStep(key, g, focused.getAttribute('data-guide-key'));
          return;
        }
      }
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
      // a pressed action is on its way: its control may leave while it is (the issue form closes on
      // save). Wait for its outcome however long it takes; stepping back now would guide a second send.
      if (g.run.waiting) {
        missing.current = null;
        return;
      }
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
      // nothing of this guide is on screen any more: end the run (not done) so "Guide me" can offer it
      missing.current = null;
      g.stop();
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
      // (a keyed first step has no key yet: any of its controls starts it)
      if (current.keyed && g.run.key !== null && !guideKeyMatches(pressed.getAttribute('data-guide-key'), g.run.key)) return;
      // an action that can fail waits for the store's report (this runs before the control's own
      // handler, so even a report made at once, as in demo mode, finds the wait in place)
      if (current.until === 'outcome') {
        if (!(pressed as HTMLButtonElement).disabled) g.setWait(true);
        return;
      }
      completeStep(key, g, pressed.getAttribute('data-guide-key'));
    };
    // a text box (`focus`) is reached by a tap or from the keyboard alike
    const onFocus = (e: FocusEvent) => {
      const g = useGuideState.getState();
      if (!g.run) return;
      const current = g.run.guide.steps[g.run.step]!;
      if (current.until !== 'focus') return;
      const target = e.target instanceof Element ? e.target : null;
      const reached = target?.closest(`[data-guide="${current.target}"]`);
      if (!reached) return;
      // the first step has no key yet: any of its boxes starts it
      if (current.keyed && g.run.key !== null && !guideKeyMatches(reached.getAttribute('data-guide-key'), g.run.key)) return;
      completeStep(key, g, reached.getAttribute('data-guide-key'));
    };
    document.addEventListener('click', onClick, true);
    document.addEventListener('focusin', onFocus, true);
    return () => {
      document.removeEventListener('click', onClick, true);
      document.removeEventListener('focusin', onFocus, true);
    };
  }, [key]);

  // the store's report on an `outcome` step: success moves the guide on; failure ends the wait, so a
  // control that went away (a dialog closed on a refusal) steps the guide back as usual
  useEffect(
    () =>
      subscribeGuideOutcome((outcome, outcomeKey, outcomeRun) => {
        const g = useGuideState.getState();
        if (!g.run) return;
        // a reply to a request sent under an earlier run (before a replay) is not this run's
        if (outcomeRun !== null && outcomeRun !== g.run.id) return;
        const current = g.run.guide.steps[g.run.step]!;
        if (current.until !== 'outcome' || !current.outcome) return;
        // a keyed step follows one record: another checklist's submit is not this guide's
        if (current.keyed && !guideKeyMatches(outcomeKey, g.run.key)) return;
        // a failure report never undoes what the store already shows done (a refresh that showed it first)
        const notOk = outcome === current.outcome.failed || outcome === current.outcome.held;
        if (outcome === current.outcome.ok || (notOk && g.run.pressed && current.settled?.(g.run.key))) completeStep(key, g, null);
        else if (outcome === current.outcome.held) g.stop();
        else if (outcome === current.outcome.failed) {
          if (current.retryFrom !== undefined) g.setStep(current.retryFrom);
          else g.setWait(false);
        }
      }),
    [key],
  );

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
