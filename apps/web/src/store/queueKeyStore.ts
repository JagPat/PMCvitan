import type { OutboxOp } from '@/data/apiGateway';

/**
 * WEB-02 step 1 (#482 6326129029): the one writer of the stored queue keys, the general queue
 * `vitan.outbox.<sub>.<project>` and the visit lane `vitan.siteVisitQueue.<sub>.<project>`.
 *
 * Every tab of one person on one project, and an older or newer release's tab, shares these keys. So a key is never
 * written from memory alone: each write reads what the key holds now and merges by act identity (Codex 4338427583).
 * An act this tab holds is written; one it held and holds no more (sent, dropped for good) goes; one it never held is
 * another tab's and stays where it is. A write never takes another tab's acts into memory: that tab sends them, or
 * the next load does.
 *
 * Another tab's write that leaves out an act this tab holds is answered by writing the merge back, once per act
 * (#1071 F3 for the lane). An act left out again is not written back a second time, so two tabs never answer each
 * other for ever: it stays in memory, is sent from here, and is listed as not kept (`notKept`) until this tab's next
 * write stores it.
 */

/** an act's identity: its idempotency key, else a photo's client key, else its bytes */
export const queueActIdent = (o: OutboxOp): string => {
  const key = (o as { idempotencyKey?: unknown }).idempotencyKey;
  if (typeof key === 'string') return `k:${key}`;
  const clientKey = (o as { input?: { clientKey?: unknown } }).input?.clientKey;
  if (o.t === 'uploadMedia' && typeof clientKey === 'string') return `photo:${clientKey}`;
  return `json:${JSON.stringify(o)}`;
};

type Store = Pick<Storage, 'getItem' | 'setItem'>;

/** the key's acts, or null when it holds bytes that are not a list (an absent key is an empty list). `whole`: null
 *  too when the list holds an entry that is not an act (a newer release's shape), so it is never written over unasked */
function readKey(storage: Store, key: string, whole = false): OutboxOp[] | null {
  const raw = storage.getItem(key);
  if (raw === null) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    const acts = (parsed as OutboxOp[]).filter((o) => o !== null && typeof o === 'object');
    return whole && acts.length !== parsed.length ? null : acts;
  } catch {
    return null;
  }
}

/** The flush's write of the scope it no longer holds (a scope move during the flush): this flush's acts (`batch`, sent
 *  or not) leave the stored list, its unsent ones (`rest`) go first, and every other act stays, by identity, through
 *  `after`. Another tab's merged write may put its own acts ahead of this tab's, so no position is trusted. */
export function keepUnsent(storage: Store, key: string, rest: OutboxOp[], batch: OutboxOp[], after: (l: OutboxOp[]) => OutboxOp[]): void {
  const stored = readKey(storage, key);
  const flushed = new Set([...batch, ...rest].map(queueActIdent));
  const others = (stored ?? []).filter((o) => !flushed.has(queueActIdent(o)));
  storage.setItem(key, JSON.stringify([...rest, ...after(others)]));
}

export type QueueKeyStore = ReturnType<typeof createQueueKeyStore>;

export function createQueueKeyStore() {
  /** per key, every act this tab has held since that key's load */
  const known = new Map<string, Set<string>>();
  /** per key, the acts this tab has written back once after another tab's write left them out */
  const putBack = new Map<string, Set<string>>();
  /** per key, the acts held in memory that the key does not hold now */
  const unkept = new Map<string, Set<string>>();
  /** per key, the acts its load read: every tab of this scope may hold them, so another tab's write that leaves one out
   *  most likely sent it, and it is not written back (it is stored again with this tab's next write, as before) */
  const fromLoad = new Map<string, Set<string>>();
  /** the keys whose acts memory holds now (their load ran, and no scope move since) */
  const loadedKeys = new Set<string>();
  const setOf = (m: Map<string, Set<string>>, key: string): Set<string> => {
    let s = m.get(key);
    if (!s) m.set(key, (s = new Set()));
    return s;
  };

  /** read now, merge `mine` over it, write if that changes it. False when nothing was stored. */
  const writeMerged = (storage: Store, key: string, mine: OutboxOp[], skip: Set<string> = new Set()): boolean => {
    const stored = readKey(storage, key);
    const held = new Set(mine.map(queueActIdent));
    const seen = setOf(known, key);
    for (const i of held) seen.add(i);
    // bytes that are not a list are written over, as before this module (step 2 of the plan owns unreadable keys)
    const others = (stored ?? []).filter((o) => { const i = queueActIdent(o); return !held.has(i) && !seen.has(i); });
    const next = [...mine.filter((o) => !skip.has(queueActIdent(o))), ...others];
    const text = JSON.stringify(next);
    if (storage.getItem(key) !== text) storage.setItem(key, text);
    // not kept: what memory holds and this write left out; an act memory no longer holds is not listed
    const missing = setOf(unkept, key);
    for (const i of [...missing]) if (!held.has(i) || !skip.has(i)) missing.delete(i);
    return true;
  };

  return {
    /** a load read `stored` from `key`: those acts are this tab's from now on */
    loaded(key: string, stored: unknown): void {
      known.set(key, new Set(Array.isArray(stored) ? (stored as OutboxOp[]).filter((o) => o && typeof o === 'object').map(queueActIdent) : []));
      fromLoad.set(key, new Set(known.get(key)));
      putBack.delete(key);
      unkept.delete(key);
      loadedKeys.add(key);
    },
    /** whether memory holds `key`'s acts: another tab's write of a key memory does not hold is never answered */
    holds(key: string): boolean {
      return loadedKeys.has(key);
    },
    /** every key's memory goes (the scope moved, or the person signed out): the next load sets it again */
    forget(): void {
      known.clear();
      fromLoad.clear();
      putBack.clear();
      unkept.clear();
      loadedKeys.clear();
    },
    /** write this tab's acts for `key`, merged with what it holds now. False when the write failed. */
    write(storage: Store, key: string, mine: OutboxOp[]): boolean {
      try {
        return writeMerged(storage, key, mine);
      } catch {
        // not kept: every act memory holds that the key, unchanged by the failed write, does not hold now
        let there = new Set<string>();
        try { there = new Set((readKey(storage, key) ?? []).map(queueActIdent)); } catch { /* unreadable: none */ }
        const missing = setOf(unkept, key);
        missing.clear();
        for (const o of mine) { const i = queueActIdent(o); if (!there.has(i)) missing.add(i); }
        return false;
      }
    },
    /** Another tab wrote `key` (a storage event). Writes the merge back when that write left out an act this tab holds
     *  for the first time, or put back an act this tab settled; never twice for the same act. */
    heard(storage: Store, key: string, mine: OutboxOp[]): void {
      const stored = readKey(storage, key, true);
      if (stored === null) return;
      const there = new Set(stored.map(queueActIdent));
      const held = new Set(mine.map(queueActIdent));
      const seen = setOf(known, key);
      const once = setOf(putBack, key);
      const loadedHere = fromLoad.get(key) ?? new Set<string>();
      const gone = mine.map(queueActIdent).filter((i) => !there.has(i));
      const missing = gone.filter((i) => !loadedHere.has(i));
      const again = new Set(missing.filter((i) => once.has(i)));
      // not written back now: an act left out again, and an act the load read (another tab most likely sent it)
      const left = new Set([...again, ...gone.filter((i) => loadedHere.has(i))]);
      const notThere = setOf(unkept, key);
      for (const i of [...notThere]) if (!held.has(i) || there.has(i)) notThere.delete(i);
      for (const i of left) notThere.add(i);
      // an act this tab settled that a stale write put back is taken off again, so it is not sent twice
      const settledBack = stored.some((o) => { const i = queueActIdent(o); return seen.has(i) && !held.has(i); });
      if (!settledBack && missing.length === again.size) return;
      for (const i of missing) once.add(i);
      try {
        writeMerged(storage, key, mine, left);
      } catch {
        for (const i of missing) setOf(unkept, key).add(i);
      }
    },
    /** the acts memory holds for `key` that the key does not hold now */
    notKept(key: string): string[] {
      return [...(unkept.get(key) ?? [])];
    },
  };
}
