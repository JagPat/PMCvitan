/**
 * #1397 (Codex 4499008032): a row write in the evidence, site photo or visit photo store fires no `storage` event, so
 * another tab's switcher line (#1388) would not hear of a change kept for a project its person no longer holds until the
 * page is shown again. Each store tells the person's other tabs here once a row write settles, landed or not; the
 * store's listener checks the line again.
 *
 * One channel per person (`vitan.kept.<sub>`), made once and kept, and only for a person this page listens for (its
 * signed-in person, `listenRowWrites`): a person's tabs hear only their own writes, and a channel never hears what it
 * posts itself, so a tab's own writes start no check of its own. A write that settles for a person this page does not
 * listen for (one signed out since) opens nothing and says nothing (Stage 1 G3). The signal never throws, never waits
 * and never changes the write it follows: a page with no `BroadcastChannel`, or one that cannot make or post on it, says
 * nothing (the visibility re-check stays). A sign-out closes every channel (`closeKeptSignals`).
 *
 * One effect on the write's own promise: the signal's branch handles a rejection, so a failing write that no caller
 * awaits or catches is no longer reported as an unhandled rejection. A caller that awaits or catches it sees no change
 * (Stage 1 G4).
 */

const channels = new Map<string, BroadcastChannel>();
const listening = new Map<string, () => void>();

const channelOf = (sub: string): BroadcastChannel | null => {
  try {
    const made = channels.get(sub);
    if (made) return made;
    if (!listening.has(sub) || typeof BroadcastChannel !== 'function') return null;
    const ch = new BroadcastChannel(`vitan.kept.${sub}`);
    ch.onmessage = () => { try { listening.get(sub)?.(); } catch { /* the listener's own failure is its own */ } };
    channels.set(sub, ch);
    return ch;
  } catch {
    return null;
  }
};

/** Tell `sub`'s other tabs a row of theirs may have changed, when this page listens for `sub`. Never throws. */
export function signalRowWrite(sub: string): void {
  try { channelOf(sub)?.postMessage('row'); } catch { /* said nothing */ }
}

/** `write`, unchanged, with `sub`'s other tabs told once it settles (resolved or rejected). Not awaited: the caller gets
 *  the very promise it would have had. */
export function afterRowWrite<T>(sub: string, write: Promise<T>): Promise<T> {
  void write.then(() => signalRowWrite(sub), () => signalRowWrite(sub));
  return write;
}

/** Hear `sub`'s row writes from their other tabs: one listener per person, the latest replacing any before it. */
export function listenRowWrites(sub: string, hear: () => void): void {
  listening.set(sub, hear);
  channelOf(sub);
}

/** A sign-out: every channel closes, and nothing is heard until a listener is set again. */
export function closeKeptSignals(): void {
  for (const ch of channels.values()) { try { ch.close(); } catch { /* closed */ } }
  channels.clear();
  listening.clear();
}
