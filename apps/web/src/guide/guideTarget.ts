import type { GuideStep } from './guides';

/** how often the overlay re-finds its control (it also re-measures on every scroll and resize) */
export const GUIDE_TICK_MS = 300;

/** how long a step's control may be missing before the guide steps back (a menu still opening is not gone) */
export const GUIDE_REWIND_MS = 900;

export interface Box {
  top: number;
  left: number;
  width: number;
  height: number;
  /** the dialog the control is in, if any: it already dims the page, and its focus trap must reach Skip */
  dialog: HTMLElement | null;
}

/** The first SHOWN control carrying this `data-guide` value: the phone and desktop shells each render
 *  their own Add button and hide the other with CSS, so the hidden twin must not win. */
export function findGuideTarget(name: string, key: string | null = null): HTMLElement | null {
  for (const el of document.querySelectorAll<HTMLElement>(`[data-guide="${name}"]`)) {
    if (key !== null && el.getAttribute('data-guide-key') !== key) continue;
    if (el.getClientRects().length > 0) return el;
  }
  return null;
}

/** The control a step of a run points at: a `keyed` step only matches the earlier press's key. */
export function findStepTarget(step: GuideStep, key: string | null): HTMLElement | null {
  return findGuideTarget(step.target, step.keyed ? key : null);
}

