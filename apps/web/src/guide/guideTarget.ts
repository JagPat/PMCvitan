/** how often the overlay re-finds its control (it also re-measures on every scroll and resize) */
export const GUIDE_TICK_MS = 300;

/** how long a step's control may be missing before the guide steps back (a menu still opening is not gone) */
export const GUIDE_REWIND_MS = 900;

export interface Box {
  top: number;
  left: number;
  width: number;
  height: number;
  /** the control is inside a dialog, which already dims the page behind it */
  inDialog: boolean;
}

/** The first SHOWN control carrying this `data-guide` value: the phone and desktop shells each render
 *  their own Add button and hide the other with CSS, so the hidden twin must not win. */
export function findGuideTarget(name: string): HTMLElement | null {
  for (const el of document.querySelectorAll<HTMLElement>(`[data-guide="${name}"]`)) {
    if (el.getClientRects().length > 0) return el;
  }
  return null;
}

