import type { Guide, GuideStep } from './guides';

/** how often the overlay re-finds its control (it also re-measures on every scroll and resize) */
export const GUIDE_TICK_MS = 300;

/** how long a step's control may be missing before the guide steps back (a menu still opening is not gone) */
export const GUIDE_REWIND_MS = 900;

/** how long a guide asked for from Help may wait on its screen for its first control before the ask is dropped */
export const GUIDE_ARRIVE_MS = 3000;

export interface Box {
  top: number;
  left: number;
  width: number;
  height: number;
  /** the dialog the control is in, if any: it already dims the page, and its focus trap must reach Skip */
  dialog: HTMLElement | null;
  /** the viewport when measured: the tip goes below or above the control by the room left in it, so a
   *  resize (or an on-screen keyboard) that leaves the control where it was still re-places the tip */
  vw: number;
  vh: number;
}

/**
 * Does a control's `data-guide-key` belong to the run's key? Equal keys match, and so does a control
 * keyed by the record the run's key is part of: the Submit of checklist `C` (key `C`) belongs to a run
 * that failed item `C:3`.
 */
export function guideKeyMatches(elKey: string | null, runKey: string | null): boolean {
  if (elKey === null || runKey === null) return false;
  return elKey === runKey || runKey.startsWith(`${elKey}:`);
}

/** The first SHOWN control carrying this `data-guide` value: the phone and desktop shells each render
 *  their own Add button and hide the other with CSS, so the hidden twin must not win. */
export function findGuideTarget(name: string, key: string | null = null): HTMLElement | null {
  for (const el of document.querySelectorAll<HTMLElement>(`[data-guide="${name}"]`)) {
    if (key !== null && !guideKeyMatches(el.getAttribute('data-guide-key'), key)) continue;
    if (el.getClientRects().length > 0) return el;
  }
  return null;
}

/** The control a step of a run points at: a `keyed` step only matches the earlier press's key. */
export function findStepTarget(step: GuideStep, key: string | null): HTMLElement | null {
  return findGuideTarget(step.target, step.keyed ? key : null);
}


/** A guide can start here now: its first control is on screen and pressable (the overlay and the welcome both ask this).
 *  A step already done (its `skip` holds) is passed over when the run starts, so the first step left is the one that
 *  counts (Codex 4400711812). */
export function guideStartable(guide: Guide): boolean {
  const first = guide.steps.find((step) => !step.skip?.()) ?? guide.steps[guide.steps.length - 1]!;
  const el = findGuideTarget(first.target);
  return el !== null && !(el as HTMLButtonElement).disabled;
}
