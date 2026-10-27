import { create } from 'zustand';
import type { Guide } from './guides';
import { beginGuideRun } from './outcomes';

/**
 * #482 — the guide's own small state, kept out of the app store: which guide is running and on
 * which step, and which guide "Guide me" can replay on the current screen. `GuideHost` (the
 * overlay, mounted once in the shell) writes it; `GuideMe` (the inline button) reads it.
 */
export interface GuideRun {
  guide: Guide;
  /** this run's number from `beginGuideRun`: an outcome sent under another run is not this one's */
  id: number;
  step: number;
  /** the `data-guide-key` of the control pressed in an earlier step, for a `keyed` step */
  key: string | null;
  /**
   * after an `outcome` step's press: waiting for the store's report, not stepping back. No time limit:
   * stepping back while the request is still on its way would guide the person into sending it twice.
   */
  waiting: boolean;
  /** this run pressed the current step's control: what the store later shows done is this run's own act only then.
   *  Kept after a failure report (the request may still have landed), cleared on a new step */
  pressed: boolean;
}

interface GuideState {
  run: GuideRun | null;
  /** the guide "Guide me" would start here, or null when this screen has none ready to point at */
  offer: Guide | null;
  /** the id of the guide started last (automatically or by "Guide me"), so replays take turns */
  lastStarted: string | null;
  start: (guide: Guide) => void;
  setStep: (step: number, key?: string | null) => void;
  stop: () => void;
  /** start or end the wait for an `outcome` step's report */
  setWait: (waiting: boolean) => void;
  setOffer: (guide: Guide | null) => void;
  /**
   * a guide asked for from the Help sheet: it starts as soon as its first control is on screen on its own
   * screen (the sheet moves there first), and is dropped when the person goes elsewhere or it cannot start
   */
  requested: Guide | null;
  request: (guide: Guide | null) => void;
  /** bumped when the person asks for the first-time tips again: the overlay allows a new automatic start */
  tipsEpoch: number;
  tipsAgain: () => void;
}

export const useGuideState = create<GuideState>()((set) => ({
  run: null,
  offer: null,
  lastStarted: null,
  start: (guide) => set({ run: { guide, id: beginGuideRun(), step: 0, key: null, waiting: false, pressed: false }, lastStarted: guide.id }),
  setStep: (step, key) => set((s) => (s.run ? { run: { ...s.run, step, key: key === undefined ? s.run.key : key, waiting: false, pressed: false } } : s)),
  stop: () => set({ run: null }),
  setWait: (waiting) => set((s) => (s.run ? { run: { ...s.run, waiting, pressed: s.run.pressed || waiting } } : s)),
  setOffer: (offer) => set((s) => (s.offer === offer ? s : { offer })),
  requested: null,
  // a new request ends whatever runs now: the person asked for this one
  request: (requested) => set(requested ? { requested, run: null } : { requested }),
  tipsEpoch: 0,
  tipsAgain: () => set((s) => ({ tipsEpoch: s.tipsEpoch + 1 })),
}));
