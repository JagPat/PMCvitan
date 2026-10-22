import type { OutboxOp } from '@/data/apiGateway';
import type { QueueKeyGuard } from '@/store/queueKeyGuard';

/**
 * WEB-02 step B1 (#482 6333415419): every write of a stored queue key runs in one cross-tab Web Lock per key, so two
 * tabs of this release never read, merge and write the same list at once. With no lock (no `navigator.locks`, or the
 * browser refused it) nothing is written: the acts stay in memory and are listed not kept, the same fail-closed shape
 * as the project-create hold (`projectCreateHold.ts` `underLock`).
 */

type Store = Pick<Storage, 'getItem' | 'setItem'>;

/** Run `fn` under `key`'s exclusive Web Lock; `null` when there is no lock or the browser refused it. */
export async function underQueueLock<T>(key: string, fn: () => T | Promise<T>): Promise<T | null> {
  const locks = (globalThis.navigator as (Navigator & { locks?: LockManager }) | undefined)?.locks;
  if (typeof locks?.request !== 'function') return null;
  try {
    return (await locks.request(`vitan.queue.${key}`, { mode: 'exclusive' }, async () => fn())) as T;
  } catch {
    return null;
  }
}

/** Run `fn` under every one of `keys`' locks, taken one at a time in sorted order, so two tabs asking for the same keys
 *  never wait on each other; `null` when one could not be had. */
export async function underQueueLocks<T>(keys: string[], fn: () => T | Promise<T>): Promise<T | null> {
  const sorted = [...new Set(keys)].sort();
  const take = async (i: number): Promise<T | null> => (i === sorted.length ? fn() : underQueueLock(sorted[i], () => take(i + 1)));
  const out = await take(0);
  return out ?? null;
}

/** Merge `mine` into `key` under its lock. True only when the key then holds every act of `mine`; without the lock
 *  nothing is written and `mine`'s acts the key does not hold are listed not kept. */
export async function writeQueueKey(guard: QueueKeyGuard, storage: Store, key: string, mine: OutboxOp[]): Promise<boolean> {
  const epoch = guard.epoch(key); // a load of the key before the lock is granted makes this write stale
  const ask = guard.ask(storage, key, mine); // counted not kept while it waits for the lock
  const out = await underQueueLock(key, () => { guard.asked(ask); return guard.write(storage, key, mine, epoch); });
  if (out === null) { guard.asked(ask); guard.unwritten(storage, key, mine); }
  return out === true;
}

/** The flush's write of a scope it no longer holds (`keepUnsent`), under the key's lock; without the lock the unsent
 *  acts are copied aside beside the key instead, so they stay on this phone. Acts that can be neither written nor
 *  copied are held stranded by the guard (Codex 4345664670). True only once they are on this phone. */
export async function keepUnsentLocked(guard: QueueKeyGuard, storage: Store | null, key: string, ...args: [rest: OutboxOp[], batch: OutboxOp[], after: (l: OutboxOp[]) => OutboxOp[], takes: (o: OutboxOp) => boolean]): Promise<boolean> {
  const ask = guard.ask(storage, key, args[0]); // the unsent acts are in no memory now: counted while this waits
  const out = await underQueueLock(key, () => { guard.asked(ask); return guard.keepUnsent(storage, key, ...args); });
  guard.asked(ask);
  return out ?? guard.copyUnsentAside(storage, key, args[0]);
}
