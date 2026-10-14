/**
 * #482 — what really happened after a guided press, told to the guide by the store.
 *
 * A step that must really happen (a submit accepted or queued, a checklist issued) cannot finish on the
 * press alone: the request can still fail or be refused. The store says the outcome here, the guide
 * listens, and nothing else in the app depends on it. Emitting with no listener is a no-op.
 */
export type GuideOutcome = 'inspection-submitted' | 'inspection-submit-failed' | 'checklist-issued' | 'checklist-issue-failed';

const listeners = new Set<(outcome: GuideOutcome) => void>();

export function emitGuideOutcome(outcome: GuideOutcome): void {
  for (const listener of [...listeners]) {
    try {
      listener(outcome);
    } catch {
      // the guide must never break the action it is watching
    }
  }
}

export function subscribeGuideOutcome(listener: (outcome: GuideOutcome) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
