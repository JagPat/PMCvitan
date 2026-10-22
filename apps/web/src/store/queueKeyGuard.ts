import type { OutboxOp } from '@/data/apiGateway';
import { readStoredQueue } from '@/data/storedActs';

/**
 * WEB-02 step A (#482 6333415419): the stored-act check at the writer of the stored queue keys, the general queue
 * `vitan.outbox.<sub>.<project>` and the visit lane `vitan.siteVisitQueue.<sub>.<project>`.
 *
 * A key holding any entry this release cannot fully read (`readStoredQueue`: not a list, an entry that is not an act,
 * an act missing a field or breaking a server rule, or a newer release's kind) is unreadable as a whole: nothing loads
 * from it, nothing in it is replayed or settled, and this release never writes it. Its bytes are this phone's only copy
 * of what it holds, so it is written again only once they are copied aside on the person's tap (`setAside`). A write it
 * refuses copies this tab's acts aside beside it, once each, so they stay on this phone.
 *
 * A key this release reads is written as before, from memory, with one change: an entry memory leaves out on purpose
 * (`takes`: a lane act of a kind the load does not take, a visit act in the general key) stays, byte for byte. How two
 * tabs' writes are ordered is step B's (a cross-tab lock).
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

/** what the key holds, as this release reads it: 'ok', or why it cannot be read */
export type KeyRead = 'ok' | 'newer' | 'damaged';
const readOf = (raw: string | null): KeyRead => { const r = readStoredQueue(raw); return 'acts' in r ? 'ok' : r.unreadable; };
/** the key's acts, or null when this release cannot read what it holds (an absent key is an empty list) */
function readKey(storage: Store, key: string): OutboxOp[] | null {
  const read = readStoredQueue(storage.getItem(key));
  return 'acts' in read ? read.acts : null;
}
/** the identities of the acts a key's bytes hold, read or not: an act already there is never copied aside again */
function identsIn(raw: string | null): Set<string> {
  try {
    const now: unknown = JSON.parse(raw ?? '[]');
    if (Array.isArray(now)) return new Set(now.filter((o) => o !== null && typeof o === 'object' && !Array.isArray(o)).map((o) => queueActIdent(o as OutboxOp)));
  } catch { /* not a list: none */ }
  return new Set();
}
/** the name a key's bytes are copied aside under: never one in use */
function asideName(storage: Store, key: string): string | null {
  const base = `vitan.unreadable.${key}.${Date.now()}`;
  let name = base;
  for (let n = 1; storage.getItem(name) !== null; n += 1) {
    if (n > 100) return null; // no free name: a storage that answers every name is not one to copy into
    name = `${base}.${n}`;
  }
  return name;
}
/** copy `raw` aside under a new name and read it back: true only when the copy holds the same bytes */
function copyAside(storage: Store, key: string, raw: string): boolean {
  try {
    const name = asideName(storage, key);
    if (name === null) return false;
    storage.setItem(name, raw);
    return storage.getItem(name) === raw;
  } catch {
    return false;
  }
}

/** The flush's write of the scope it no longer holds (a scope move during the flush): this flush's acts (`batch`, sent
 *  or not) leave the stored list, its unsent ones (`rest`) go first, and every other act stays, by identity. `after`
 *  (a move or drop of this release's own acts) sees only the acts `takes` accepts: an entry memory leaves out (a visit
 *  photo's act, another kind) stays byte for byte (Codex 4344436672). A key this release cannot read is never written
 *  over: the unsent acts are copied aside beside it, and a copy that cannot be made is said. */
export function keepUnsent(storage: Store, key: string, rest: OutboxOp[], batch: OutboxOp[], after: (l: OutboxOp[]) => OutboxOp[], takes: (o: OutboxOp) => boolean = () => true): void {
  const stored = readKey(storage, key);
  if (stored === null) {
    // counted against the key's own entries, so an act it already holds is not copied aside again
    const there = identsIn(storage.getItem(key));
    const fresh = rest.filter((o) => !there.has(queueActIdent(o)));
    if (fresh.length > 0 && !copyAside(storage, key, JSON.stringify(fresh))) console.warn('unsent acts not kept', key);
    return;
  }
  const flushed = new Set([...batch, ...rest].map(queueActIdent));
  const others = stored.filter((o) => !flushed.has(queueActIdent(o)));
  storage.setItem(key, JSON.stringify([...rest, ...after(others.filter(takes)), ...others.filter((o) => !takes(o))]));
}

export type QueueKeyGuard = ReturnType<typeof createQueueKeyGuard>;

export function createQueueKeyGuard(onRead: (key: string, read: KeyRead, raw: string | null) => void = () => {}) {
  /** per key, the acts held in memory that the key does not hold now */
  const unkept = new Map<string, Set<string>>();
  /** per key, the acts a refused write already copied aside */
  const asideDone = new Map<string, Set<string>>();
  /** per key, the bytes the person's tap copied aside: the key may be written over while it still holds them */
  const setAsideRaw = new Map<string, string>();
  const setOf = (m: Map<string, Set<string>>, key: string): Set<string> => {
    let s = m.get(key);
    if (!s) m.set(key, (s = new Set()));
    return s;
  };

  return {
    /** a load of `key`: its acts when this release can read them, else none (it is reported to `onRead`, and kept) */
    load(storage: Store, key: string): OutboxOp[] {
      const raw = storage.getItem(key);
      const read = readStoredQueue(raw);
      onRead(key, 'acts' in read ? 'ok' : read.unreadable, raw);
      unkept.delete(key);
      return 'acts' in read ? read.acts : [];
    },
    /** another tab wrote `key` (a storage event): it is read and reported, never answered */
    heard(storage: Store, key: string): void {
      const raw = storage.getItem(key);
      onRead(key, readOf(raw), raw);
    },
    /** every key's memory goes (the scope moved, or the person signed out) */
    forget(): void {
      unkept.clear();
      asideDone.clear();
      setAsideRaw.clear();
    },
    /** Write this tab's acts (`mine`) for `key`, and every stored entry `takes` refuses (memory left it out on purpose).
     *  False when nothing was stored: the acts it could not store are then copied aside beside the key, once each, so
     *  they stay on this phone, and are listed not kept. */
    write(storage: Store, key: string, mine: OutboxOp[], takes: (o: OutboxOp) => boolean = () => true): boolean {
      const raw = storage.getItem(key);
      try {
        const readAs = readOf(raw);
        const copied = readAs !== 'ok' && raw === setAsideRaw.get(key);
        onRead(key, copied ? 'ok' : readAs, raw);
        // bytes this release cannot read are never written over, unless the person's tap copied them aside
        if (readAs !== 'ok' && !copied) throw new Error('unreadable queue key');
        const left = copied ? [] : (readKey(storage, key) ?? []).filter((o) => !takes(o));
        const text = JSON.stringify([...mine, ...left]);
        if (raw !== text) storage.setItem(key, text);
        unkept.delete(key);
        return true;
      } catch {
        // not kept: every act memory holds that the key, unchanged by the refused write, does not hold now
        let there = new Set<string>();
        try { there = identsIn(storage.getItem(key)); } catch { /* unreadable: none */ }
        const missing = setOf(unkept, key);
        missing.clear();
        for (const o of mine) { const i = queueActIdent(o); if (!there.has(i)) missing.add(i); }
        const done = setOf(asideDone, key);
        const fresh = mine.filter((o) => missing.has(queueActIdent(o)) && !done.has(queueActIdent(o)));
        if (fresh.length > 0) {
          if (copyAside(storage, key, JSON.stringify(fresh))) for (const o of fresh) done.add(queueActIdent(o));
          else console.warn('acts not kept', key);
        }
        return false;
      }
    },
    /** The person's tap: copy every key's unreadable bytes aside under a new name and read each copy back; only when
     *  every copy succeeded are those exact bytes let be written over. False when one could not be made: nothing
     *  changes. */
    setAside(storage: Store, keys: string[]): boolean {
      const copied = new Map<string, string>();
      for (const key of keys) {
        const raw = storage.getItem(key);
        if (raw === null || readOf(raw) === 'ok') continue;
        if (!copyAside(storage, key, raw)) return false; // no key is marked, so none is written over
        copied.set(key, raw);
      }
      for (const [key, raw] of copied) setAsideRaw.set(key, raw);
      return true;
    },
    /** the acts memory holds for `key` that the key does not hold now */
    notKept(key: string): string[] {
      return [...(unkept.get(key) ?? [])];
    },
  };
}
