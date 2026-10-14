/**
 * #482 — what really happened after a guided press, told to the guide by the store.
 *
 * A step that must really happen (a submit accepted or queued, a checklist issued) cannot finish on the
 * press alone: the request can still fail or be refused. The store says the outcome here, the guide
 * listens, and nothing else in the app depends on it. Emitting with no listener is a no-op.
 */
export type GuideOutcome = 'inspection-submitted' | 'inspection-submit-failed' | 'checklist-issued' | 'checklist-issue-failed';

/** `key`: which record the outcome is about (the submitted inspection's id), so a guide following one
 *  checklist ignores the submit of another */
type Listener = (outcome: GuideOutcome, key: string | null) => void;

const listeners = new Set<Listener>();

export function emitGuideOutcome(outcome: GuideOutcome, key: string | null = null): void {
  for (const listener of [...listeners]) {
    try {
      listener(outcome, key);
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
