/**
 * #482 — which guides a person has finished or skipped, remembered in this browser.
 *
 * Keyed like the language preference (`langPreferenceKey`): the signed-in user id, or the persona in
 * demo auth, so two people sharing a site phone each get their own first-time guides. Nothing here
 * reaches the server. Storage may be absent (private mode, a blocked quota): a read then answers
 * "not done" and a write is dropped, so the worst case is a guide shown again, never an error.
 */
const PREFIX = 'vitan.guide.done.v1:';
const WELCOME_PREFIX = 'vitan.guide.welcome.v1:';

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

/** "Show the first-time tips again": this person's guides all count as not done in this browser, and the
 *  first-time welcome shows again. */
export function clearGuidesDone(key: string): void {
  try {
    globalThis.localStorage?.removeItem(PREFIX + key);
    globalThis.localStorage?.removeItem(WELCOME_PREFIX + key);
  } catch {
    /* storage unavailable — nothing was remembered to forget */
  }
}

/** #482 — whether this person has closed the first-time welcome in this browser (keyed as above). */
export function readWelcomeSeen(key: string): boolean {
  try {
    return globalThis.localStorage?.getItem(WELCOME_PREFIX + key) === '1';
  } catch {
    return false;
  }
}

export function markWelcomeSeen(key: string): void {
  try {
    globalThis.localStorage?.setItem(WELCOME_PREFIX + key, '1');
  } catch {
    /* storage unavailable — the welcome may show again next time, nothing worse */
  }
}
