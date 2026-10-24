import { setClampedTimeout, type ClampedTimer } from '@/lib/clampedTimer';

/**
 * WEB-02 step B2f-2 (plan r3 v4, #1094): whether the queue ledger may write on this phone, asked of the service worker.
 * Yes only while every window the worker lists announced this level or above (`sw.js`, `ledgerMayWrite`). No worker,
 * no answer within the wait, a worker of an earlier release (it never answers), or a `controllerchange` during the ask
 * gives no. The answer only decides when the ledger writes, to keep open tabs of an earlier release off the "newer
 * version" strip; no safety rests on it, as the worker cannot list a frozen, discarded or bfcached page (the write
 * token covers those, L1' and L2). Nothing in this release reads it: L1' does.
 */

/** The level this release announces: it knows the queue key's write token. */
export const WINDOW_LEVEL = 1;
/** How long a page waits for the worker's word before it takes no answer as no. */
export const WINDOW_ANSWER_MS = 3000;

type Container = Pick<ServiceWorkerContainer, 'ready' | 'addEventListener' | 'removeEventListener'>;

const container = (): Container | null =>
  (typeof navigator !== 'undefined' && 'serviceWorker' in navigator ? navigator.serviceWorker : null);

/** One wait for a whole exchange: `waited` settles with null once `WINDOW_ANSWER_MS` has passed. */
function deadline(): { waited: Promise<null>; clear: () => void } {
  let timer: ClampedTimer | undefined;
  const waited = new Promise<null>((resolve) => { timer = setClampedTimeout(() => resolve(null), WINDOW_ANSWER_MS); });
  return { waited, clear: () => timer?.clear() };
}

/** One message to the active worker, and its answer on a port of its own; null once `waited` settles first (it covers
 *  the worker becoming ready too: one that never does gives no), for a controllerchange, or for anything that goes
 *  wrong. */
async function askWorker(sw: Container, message: { type: string; level: number }, waited: Promise<null>): Promise<Record<string, unknown> | null> {
  let changed = false;
  const onChange = () => { changed = true; };
  sw.addEventListener('controllerchange', onChange);
  let channel: MessageChannel | undefined;
  try {
    const worker = await Promise.race([Promise.resolve(sw.ready).then((r) => r.active), waited]);
    if (!worker || changed) return null;
    const ch = new MessageChannel();
    channel = ch;
    const answer = await Promise.race([
      new Promise<Record<string, unknown> | null>((resolve) => {
        ch.port1.onmessage = (e: MessageEvent) => {
          resolve(e.data && typeof e.data === 'object' ? (e.data as Record<string, unknown>) : null);
        };
        worker.postMessage(message, [ch.port2]);
      }),
      waited,
    ]);
    return changed ? null : answer;
  } catch {
    return null;
  } finally {
    channel?.port1.close();
    sw.removeEventListener('controllerchange', onChange);
  }
}

const announced = (answer: Record<string, unknown> | null): boolean => answer?.type === 'vitan.window.announced' && answer.ok === true;
const announcement = { type: 'vitan.window.announce', level: WINDOW_LEVEL };

/** This window says which release it is; true once the worker has kept that, within one wait. */
export async function announceWindow(sw: Container | null = container()): Promise<boolean> {
  if (!sw) return false;
  const wait = deadline();
  try {
    return announced(await askWorker(sw, announcement, wait.waited));
  } finally {
    wait.clear();
  }
}

/** Whether the ledger may write now: this window announces itself first (it may have been forgotten while hidden), and
 *  both steps share one wait, so the answer comes within `WINDOW_ANSWER_MS`. */
export async function ledgerMayWrite(sw: Container | null = container()): Promise<boolean> {
  if (!sw) return false;
  const wait = deadline();
  try {
    if (!announced(await askWorker(sw, announcement, wait.waited))) return false;
    const answer = await askWorker(sw, { type: 'vitan.window.ask', level: WINDOW_LEVEL }, wait.waited);
    return answer?.type === 'vitan.window.answer' && answer.yes === true;
  } finally {
    wait.clear();
  }
}

/** Announced on load, to a new worker after a `controllerchange`, and again when the page comes back from the bfcache,
 *  so other windows' asks see this one */
export function startWindowAnnouncements(sw: Container | null = container(), win: Pick<Window, 'addEventListener'> = window): void {
  if (!sw) return;
  void announceWindow(sw);
  sw.addEventListener('controllerchange', () => { void announceWindow(sw); });
  win.addEventListener('pageshow', (e) => { if ((e as PageTransitionEvent).persisted) void announceWindow(sw); });
}
