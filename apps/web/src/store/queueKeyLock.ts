import type { OutboxOp } from '@/data/apiGateway';
import type { QueueKeyGuard } from '@/store/queueKeyGuard';

/**
 * WEB-02 step B2f-1 (plan r3 v4, #1094 6382477473): every write of a stored queue key runs in one cross-tab Web Lock per
 * key, so two tabs of this release never write the same list at once. The write it runs is main's (`QueueKeyGuard`
 * `write` and `keepUnsent`), unchanged. With no lock (no `navigator.locks`, or the browser refused it) nothing is
 * written: the acts are copied aside beside the key, or kept in a made record, and listed not kept, the same fail-closed
 * shape as the project-create hold (`projectCreateHold.ts` `underLock`).
 *
 * While a write waits for its lock its acts the key does not hold are kept in a made record (`ask`), which needs no
 * lock: a page closed, hidden or frozen during the wait loses none, as the next load takes them back.
 */

type Store = Pick<Storage, 'getItem' | 'setItem'> & Partial<Pick<Storage, 'removeItem'>>;

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

/** Write `mine` and the stored entries `takes` refuses to `key` under its lock (`QueueKeyGuard.write`). True only when
 *  the write landed; without the lock nothing is written and `mine`'s acts the key does not hold are copied aside or
 *  recorded, and listed not kept. */
export async function writeQueueKey(guard: QueueKeyGuard, storage: Store, key: string, mine: OutboxOp[], takes: (o: OutboxOp) => boolean = () => true): Promise<boolean> {
  const ask = guard.ask(storage, key, mine); // counted not kept, and kept in a made record, while it waits for the lock
  const out = await underQueueLock(key, () => { guard.asked(ask); return guard.write(storage, key, mine, takes); });
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

/** Run `fn` holding every one of `keys`' locks, taken in one fixed order (by name) so two tabs never wait on each other;
 *  `null` when a lock could not be had. Set aside writes, and may put back, both of a scope's keys at once (L2b gap
 *  check 5: a put-back outside the lock could remove an act another tab's locked write had just stored) */
export async function underQueueLocks<T>(keys: string[], fn: () => T | Promise<T>): Promise<T | null> {
  const order = [...new Set(keys)].sort();
  const run = async (n: number): Promise<{ v: T } | null> => {
    if (n === order.length) return { v: await fn() };
    const inner = await underQueueLock(order[n], () => run(n + 1));
    return inner ?? null;
  };
  const out = await run(0);
  return out === null ? null : out.v;
}
