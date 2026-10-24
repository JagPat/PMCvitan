import { useStore } from '@/store/store';

/** WEB-02 step B1: a stored queue key is written under its cross-tab lock, after the act. These wait on that write
 *  (every queue lock requested so far has run, through the test LockManager's `query`), never on a clock. */
export async function queueWritten(): Promise<void> {
  for (;;) {
    const { pending = [] } = await navigator.locks.query();
    const names = [...new Set(pending.map((l) => l.name ?? ''))].filter((n) => n.startsWith('vitan.queue.'));
    if (names.length === 0) return;
    await Promise.all(names.map((n) => navigator.locks.request(n, () => undefined)));
  }
}

/** the next toast the store shows (an offline act's line comes once its write is done); subscribe before the act */
export function nextToast(): Promise<string | null> {
  return new Promise((resolve) => {
    const stop = useStore.subscribe((s, was) => { if (s.toast !== was.toast && s.toast) { stop(); resolve(s.toast); } });
  });
}

const heldLocks: (() => void)[] = [];
/** another tab of this release holds `key`'s queue lock until `release` (or `releaseQueueLocks`) is called; `has`
 *  settles once it holds it */
export function holdQueueLock(key: string): { has: Promise<void>; release: () => void } {
  let release!: () => void;
  const out = new Promise<void>((r) => { release = r; });
  heldLocks.push(release);
  let taken!: () => void;
  const has = new Promise<void>((r) => { taken = r; });
  void navigator.locks.request(`vitan.queue.${key}`, async () => { taken(); await out; });
  return { has, release };
}
/** every lock `holdQueueLock` took is let go (a test's cleanup, so a failed test never blocks the next) */
export function releaseQueueLocks(): void {
  for (const release of heldLocks.splice(0)) release();
}
