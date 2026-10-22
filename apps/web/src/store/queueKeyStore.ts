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
 * Another tab's write that leaves out an act made here is answered by writing it back, every time (#1071 F3 for the
 * lane, #1079 Codex 4344270659); an act the load read is listed as not kept (`notKept`) until this tab's next write.
 * A list holding an entry that is not an act (a newer release's format) is never written over (Codex 4344270663).
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

/** the key's acts; null when it holds bytes that are not a list; 'opaque' when it is a list holding an entry that is
 *  not an act (a newer release's format), which no write of this release touches (Codex 4344270663) */
function readKey(storage: Store, key: string): OutboxOp[] | null | 'opaque' {
  const raw = storage.getItem(key);
  if (raw === null) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    return parsed.every((o) => o !== null && typeof o === 'object' && !Array.isArray(o)) ? (parsed as OutboxOp[]) : 'opaque';
  } catch {
    return null;
  }
}
/** copy `text` under a name of its own beside `key` (never one in use), and read it back */
function copyAside(storage: Store, key: string, text: string): boolean {
  try {
    const base = `vitan.unreadable.${key}.${Date.now()}`;
    let name = base;
    for (let n = 1; storage.getItem(name) !== null; n += 1) name = `${base}.${n}`;
    storage.setItem(name, text);
    return storage.getItem(name) === text;
  } catch {
    return false;
  }
}

/** The flush's write of the scope it no longer holds (a scope move during the flush): this flush's acts (`batch`, sent
 *  or not) leave the stored list, its unsent ones (`rest`) go first, and every other act stays, by identity, through
 *  `after`. Another tab's merged write may put its own acts ahead of this tab's, so no position is trusted. */
export function keepUnsent(storage: Store, key: string, rest: OutboxOp[], batch: OutboxOp[], after: (l: OutboxOp[]) => OutboxOp[]): void {
  const stored = readKey(storage, key);
  // a newer release's format is never written over: the unsent acts are copied aside beside it
  if (stored === 'opaque') { if (rest.length > 0) copyAside(storage, key, JSON.stringify(rest)); return; }
  const flushed = new Set([...batch, ...rest].map(queueActIdent));
  const others = (stored ?? []).filter((o) => !flushed.has(queueActIdent(o)));
  storage.setItem(key, JSON.stringify([...rest, ...after(others)]));
}

export type QueueKeyStore = ReturnType<typeof createQueueKeyStore>;

export function createQueueKeyStore() {
  /** per key, every act this tab has held since that key's load */
  const known = new Map<string, Set<string>>();
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
    if (stored === 'opaque') throw new Error('a list this release does not write');
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
        try { const now = readKey(storage, key); there = new Set((Array.isArray(now) ? now : []).map(queueActIdent)); } catch { /* unreadable: none */ }
        const missing = setOf(unkept, key);
        missing.clear();
        for (const o of mine) { const i = queueActIdent(o); if (!there.has(i)) missing.add(i); }
        return false;
      }
    },
    /** Another tab wrote `key` (a storage event). An act made here since the load exists nowhere but this tab's memory
     *  and this key, so every write that leaves it out is answered by writing it back (#1079, Codex 4344270659): no tab
     *  of this release answers that write, since none holds the act or heals it, so the answers never chain. An act the
     *  load read is not written back (another tab most likely sent it): it is listed not kept until this tab's next
     *  write. An act made here and settled here that a stale write put back is taken off again, so it is not sent twice;
     *  one the load read is not, so two tabs that loaded it never answer each other. */
    heard(storage: Store, key: string, mine: OutboxOp[]): void {
      const stored = readKey(storage, key);
      if (!Array.isArray(stored)) return;
      const there = new Set(stored.map(queueActIdent));
      const held = new Set(mine.map(queueActIdent));
      const seen = setOf(known, key);
      const loadedHere = fromLoad.get(key) ?? new Set<string>();
      const gone = mine.map(queueActIdent).filter((i) => !there.has(i));
      const missing = gone.filter((i) => !loadedHere.has(i));
      const left = new Set(gone.filter((i) => loadedHere.has(i)));
      const notThere = setOf(unkept, key);
      for (const i of [...notThere]) if (!held.has(i) || there.has(i)) notThere.delete(i);
      for (const i of left) notThere.add(i);
      const settledBack = stored.some((o) => { const i = queueActIdent(o); return seen.has(i) && !held.has(i) && !loadedHere.has(i); });
      if (!settledBack && missing.length === 0) return;
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
