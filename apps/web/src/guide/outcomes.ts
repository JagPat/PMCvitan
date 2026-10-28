/**
 * #482 — what really happened after a guided press, told to the guide by the store.
 *
 * A step that must really happen (a submit accepted or queued, a checklist issued) cannot finish on the
 * press alone: the request can still fail or be refused. The store says the outcome here, the guide
 * listens, and nothing else in the app depends on it. Emitting with no listener is a no-op.
 */
export type GuideOutcome =
  | 'inspection-submitted'
  | 'inspection-submit-failed'
  | 'checklist-issued'
  | 'checklist-issue-failed'
  | 'decision-published'
  | 'decision-publish-failed'
  | 'decision-approved'
  | 'decision-approve-failed'
  | 'decision-approve-not-kept'
  | 'advice-sent'
  | 'advice-send-failed'
  | 'advice-not-kept'
  | 'site-photo-added'
  | 'site-photo-add-failed'
  | 'site-photo-not-kept';

/** `key`: which record the outcome is about (the submitted inspection's id), so a guide following one
 *  checklist ignores the submit of another. `run`: the guide run the request was sent under (see
 *  `guideRunToken`), or null when the outcome is not tied to one */
type Listener = (outcome: GuideOutcome, key: string | null, run: number | null) => void;

const listeners = new Set<Listener>();

/** Each guide start takes a new run number. A request captures the current one when it is sent, so its
 *  late reply cannot finish a later run of the guide (a replay started while it was still on its way). */
let currentRun = 0;

export function beginGuideRun(): number {
  currentRun += 1;
  // a photo picked under an earlier run is not this run's
  guidedPhotoPicks.clear();
  return currentRun;
}

/** The upload keys of the photos picked under each guide run, so the photo guide can see one of them on record even when
 *  its upload's own answer never comes back (a live refresh brought it first). */
const guidedPhotoPicks = new Map<number, Set<string>>();

export function recordGuidedPhotoPick(run: number, clientKey: string): void {
  const keys = guidedPhotoPicks.get(run) ?? new Set<string>();
  keys.add(clientKey);
  guidedPhotoPicks.set(run, keys);
}

export function guidedPhotoPicksOf(run: number): ReadonlySet<string> {
  return guidedPhotoPicks.get(run) ?? new Set<string>();
}

export function guideRunToken(): number {
  return currentRun;
}

export function emitGuideOutcome(outcome: GuideOutcome, key: string | null = null, run: number | null = null): void {
  for (const listener of [...listeners]) {
    try {
      listener(outcome, key, run);
    } catch {
      // the guide must never break the action it is watching
    }
  }
}

export function subscribeGuideOutcome(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
