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
}

interface GuideState {
  run: GuideRun | null;
  /** the guide "Guide me" would start here, or null when this screen has none ready to point at */
  offer: Guide | null;
  start: (guide: Guide) => void;
  setStep: (step: number) => void;
  stop: () => void;
  setOffer: (guide: Guide | null) => void;
}

export const useGuideState = create<GuideState>()((set) => ({
  run: null,
  offer: null,
  start: (guide) => set({ run: { guide, step: 0 } }),
  setStep: (step) => set((s) => (s.run ? { run: { ...s.run, step } } : s)),
  stop: () => set({ run: null }),
  setOffer: (offer) => set((s) => (s.offer === offer ? s : { offer })),
}));
