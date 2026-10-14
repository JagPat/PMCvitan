import { create } from 'zustand';
import type { Guide } from './guides';

/**
 * #482 — the guide's own small state, kept out of the app store: which guide is running and on
 * which step, and which guide "Guide me" can replay on the current screen. `GuideHost` (the
 * overlay, mounted once in the shell) writes it; `GuideMe` (the inline button) reads it.
 */
export interface GuideRun {
  guide: Guide;
  step: number;
  /** the `data-guide-key` of the control pressed in an earlier step, for a `keyed` step */
  key: string | null;
  /**
   * after an `outcome` step's press: waiting for the store's report, not stepping back. No time limit:
   * stepping back while the request is still on its way would guide the person into sending it twice.
   */
  waiting: boolean;
}

interface GuideState {
  run: GuideRun | null;
  /** the guide "Guide me" would start here, or null when this screen has none ready to point at */
  offer: Guide | null;
  start: (guide: Guide) => void;
  setStep: (step: number, key?: string | null) => void;
  stop: () => void;
  /** start or end the wait for an `outcome` step's report */
  setWait: (waiting: boolean) => void;
  setOffer: (guide: Guide | null) => void;
}

export const useGuideState = create<GuideState>()((set) => ({
  run: null,
  offer: null,
  start: (guide) => set({ run: { guide, step: 0, key: null, waiting: false } }),
  setStep: (step, key) => set((s) => (s.run ? { run: { ...s.run, step, key: key === undefined ? s.run.key : key, waiting: false } } : s)),
  stop: () => set({ run: null }),
  setWait: (waiting) => set((s) => (s.run ? { run: { ...s.run, waiting } } : s)),
  setOffer: (offer) => set((s) => (s.offer === offer ? s : { offer })),
}));
