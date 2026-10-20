/**
 * A timeout a browser will keep: `setTimeout` takes at most 2^31−1 ms (about 24.8 days) and fires at once for any
 * longer wait, so a long wait would turn into a loop (Codex 4323657327). The wait is clamped to [0, ∞) (NaN counts as
 * 0) and set as a wall-clock deadline once. It is waited out in steps of at most 2^31−1 ms; each step, as it fires,
 * takes as left the lesser of the clock's remainder and the steps' own, so a phone that slept through a step is not
 * pushed later, and `fn` runs as soon as nothing is left. Every SV2 timer goes through it: the visit photo retry and the flush's wait for its read
 * (store.ts), and the photo link refresh (useSiteVisits.ts).
 */
export const MAX_TIMER_MS = 2 ** 31 - 1;

export type ClampedTimer = { clear: () => void };

export function setClampedTimeout(fn: () => void, ms: number): ClampedTimer {
  let planned = Number.isNaN(ms) ? 0 : Math.max(0, ms);
  const deadline = Date.now() + planned;
  let handle: ReturnType<typeof setTimeout> | undefined;
  const arm = (left: number): void => {
    const step = Math.min(left, MAX_TIMER_MS);
    handle = setTimeout(() => {
      planned -= step;
      // what is left by the clock, or by the steps already waited, whichever is less: a step that fired late (a phone
      // that slept) never pushes the deadline out
      const rest = Math.min(planned, deadline - Date.now());
      if (rest > 0) arm(rest);
      else fn();
    }, step);
  };
  arm(planned);
  return { clear: () => clearTimeout(handle) };
}
