/**
 * #482 — which guides a person has finished or skipped, remembered in this browser.
 *
 * Keyed like the language preference (`langPreferenceKey`): the signed-in user id, or the persona in
 * demo auth, so two people sharing a site phone each get their own first-time guides. Nothing here
 * reaches the server. Storage may be absent (private mode, a blocked quota): a read then answers
 * "not done" and a write is dropped, so the worst case is a guide shown again, never an error.
 */
const PREFIX = 'vitan.guide.done.v1:';

export function readGuidesDone(key: string): ReadonlySet<string> {
  try {
    const raw = globalThis.localStorage?.getItem(PREFIX + key);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : []);
  } catch {
    return new Set();
  }
}

export function markGuideDone(key: string, guideId: string): void {
  try {
    const done = new Set(readGuidesDone(key));
    if (done.has(guideId)) return;
    done.add(guideId);
    globalThis.localStorage?.setItem(PREFIX + key, JSON.stringify([...done]));
  } catch {
    /* storage unavailable — the guide may show again next time, nothing worse */
  }
}
