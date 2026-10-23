import type { OutboxOp } from '@/data/apiGateway';
import { readStoredQueue, type QueueScopes } from '@/data/storedActs';

/**
 * WEB-02 step A (#482 6333415419): the stored-act check at the writer of the stored queue keys, the general queue
 * `vitan.outbox.<sub>.<project>` and the visit lane `vitan.siteVisitQueue.<sub>.<project>`.
 *
 * A key holding any entry this release cannot fully read (`readStoredQueue`: not a list, an entry that is not an act,
 * an act missing a field or breaking a server rule, or a newer release's kind) is unreadable as a whole: nothing loads
 * from it, nothing in it is replayed or settled, and this release never writes it. Its bytes are this phone's only copy
 * of what it holds, so it is never written by this release. A write it refuses copies this tab's acts aside beside it,
 * once each, so they stay on this phone.
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

type Store = Pick<Storage, 'getItem' | 'setItem'> & Partial<Pick<Storage, 'removeItem'>>;

/** what the key holds, as this release reads it: 'ok', or why it cannot be read */
export type KeyRead = 'ok' | 'newer' | 'damaged';
const readOf = (raw: string | null, scopes: QueueScopes | undefined): KeyRead => { const r = readStoredQueue(raw, scopes); return 'acts' in r ? 'ok' : r.unreadable; };
/** the key's acts, or null when this release cannot read what it holds (an absent key is an empty list) */
function readKey(storage: Store, key: string, scopes: QueueScopes | undefined): OutboxOp[] | null {
  const read = readStoredQueue(storage.getItem(key), scopes);
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
/** the bytes' length and 32-bit FNV-1a hash: the name of their copy, so the same bytes are copied once */
function contentTag(raw: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < raw.length; i += 1) h = Math.imul(h ^ raw.charCodeAt(i), 0x01000193);
  return `${raw.length}-${(h >>> 0).toString(36)}`;
}
/** Copy `raw` aside and read it back: true only when a copy holding the same bytes is there. A copy of these bytes
 *  already there is that copy, made again by nothing; one that does not read back as written is removed. `made` hears
 *  the name of a copy this call wrote */
function copyAside(storage: Store, key: string, raw: string, made: (name: string) => void = () => {}): boolean {
  const base = `vitan.unreadable.${key}.${contentTag(raw)}`;
  let name: string | null = null;
  try {
    for (let n = 0; n <= 100; n += 1) {
      const at = n === 0 ? base : `${base}.${n}`;
      const there = storage.getItem(at);
      if (there === raw) return true; // read back already: the same bytes, kept
      if (there === null) { name = at; break; }
    }
    if (name === null) return false; // no free name: a storage that answers every name is not one to copy into
    storage.setItem(name, raw);
    if (storage.getItem(name) === raw) { made(name); return true; }
  } catch { /* not copied */ }
  // best effort: a copy that cannot be removed holds bytes still held elsewhere, never a loss
  if (name !== null) try { storage.removeItem?.(name); } catch { /* left */ }
  return false;
}

export type QueueKeyGuard = ReturnType<typeof createQueueKeyGuard>;
/** one queue key's write from memory: this tab's acts for it, and which stored entries memory takes (`write`) */
export type QueueWrite = { key: string; mine: OutboxOp[]; takes: (o: OutboxOp) => boolean };

/** `scopesOf`: the user scopes each key's acts may name (`QueueScopes`), as the store derived them with the key's name.
 *  A key it names none for reads a scope-bearing act as damaged */
export function createQueueKeyGuard(onRead: (key: string, read: KeyRead, raw: string | null) => void = () => {}, scopesOf: (key: string) => QueueScopes | undefined = () => undefined) {
  /** per key, the acts held in memory that the key does not hold now */
  const unkept = new Map<string, Set<string>>();
  /** per key, the acts a refused write already copied aside */
  const asideDone = new Map<string, Set<string>>();
  /** per key, the unsent acts of a scope this tab moved off that could be neither written there nor copied aside (Codex
   *  4345664670). They are held here for the tab's life, whatever scope it moves to, counted (`strandedCount`, for
   *  plan step 4's leave question), and loaded again with their key, so a return to that scope holds them as before;
   *  they stay held, and counted, until a write or a copy aside puts them on this phone, or they are settled
   *  (`unstrand`). They are lost when the tab closes or reloads (no leave gate yet: residual, ended by plan step 4).
   *  `forget` keeps them; they are sent only from their own key, whose name holds the person's sub, so never under
   *  another person. */
  const stranded = new Map<string, OutboxOp[]>();
  const strand = (key: string, acts: OutboxOp[]): void => {
    const was = stranded.get(key) ?? [];
    const there = new Set(was.map(queueActIdent));
    stranded.set(key, [...was, ...acts.filter((o) => !there.has(queueActIdent(o)))]);
  };
  /** A stranded act stays held, and counted, until it is on this phone (a write or a copy aside holds it) or settled.
   *  A load hands it back to memory but never lets go of it (Codex 4346778591: let go there, a later reload asked
   *  about none and lost it). `drop` names the acts to let go */
  const unstrand = (key: string, drop: (ident: string) => boolean): void => {
    const held = stranded.get(key);
    if (!held) return;
    const left = held.filter((o) => !drop(queueActIdent(o)));
    if (left.length > 0) stranded.set(key, left); else stranded.delete(key);
  };
  /** the keys whose stranded acts a load since the last `forget` handed back to memory: a write of such a key whose
   *  memory no longer holds one has settled it (sent, or refused and kept on its row) */
  const handed = new Set<string>();
  /** per key, the copies a refused write of this tab made of acts memory held (Codex 4356145036). Memory sends them from
   *  here, so a copy is removed once memory holds none of its acts (each sent or settled), or once its key is written;
   *  until then it is this phone's copy of them. `forget` keeps the copies and only forgets these: what memory held is
   *  gone, so the copy is again the only one */
  const madeAside = new Map<string, { name: string; raw: string; idents: string[] }[]>();
  /** the copies of `key` this tab made whose acts memory (`held`) no longer holds are removed, and their acts may be
   *  copied again; a copy whose bytes changed, or that cannot be removed, stays */
  const releaseAside = (storage: Store, key: string, held: Set<string>): void => {
    const made = madeAside.get(key);
    if (!made) return;
    const left = made.filter((c) => {
      if (c.idents.some((i) => held.has(i))) return true;
      try { if (storage.getItem(c.name) === c.raw) storage.removeItem?.(c.name); } catch { /* left: kept bytes are never a loss */ }
      for (const i of c.idents) asideDone.get(key)?.delete(i);
      return false;
    });
    if (left.length > 0) madeAside.set(key, left); else madeAside.delete(key);
  };
  const setOf = (m: Map<string, Set<string>>, key: string): Set<string> => {
    let s = m.get(key);
    if (!s) m.set(key, (s = new Set()));
    return s;
  };

  /** A write of `key` that did not land: every act memory holds (`mine`) that the key, unchanged, does not hold now is
   *  listed not kept and copied aside beside it, once each, so it stays on this phone. When the copy cannot be made
   *  (storage full), they are held stranded as `keepUnsent` holds them, so a scope change or sign-out that clears memory
   *  never loses them (Codex 4353751499) */
  const refuse = (storage: Store, key: string, mine: OutboxOp[]): void => {
    // not kept: every act memory holds that the key, unchanged by the refused write, does not hold now
    let there = new Set<string>();
    try { there = identsIn(storage.getItem(key)); } catch { /* unreadable: none */ }
    const missing = setOf(unkept, key);
    missing.clear();
    for (const o of mine) { const i = queueActIdent(o); if (!there.has(i)) missing.add(i); }
    const done = setOf(asideDone, key);
    const fresh = mine.filter((o) => missing.has(queueActIdent(o)) && !done.has(queueActIdent(o)));
    // a copy that cannot be made leaves them in memory, listed not kept, and copied at the next write that cannot store
    // them; they are also held stranded, as memory holds them now, so one memory then settles (sent) is let go below
    const raw = JSON.stringify(fresh);
    const record = (name: string) => { const list = madeAside.get(key) ?? []; list.push({ name, raw, idents: fresh.map(queueActIdent) }); madeAside.set(key, list); };
    if (fresh.length > 0 && copyAside(storage, key, raw, record)) for (const o of fresh) done.add(queueActIdent(o));
    else if (fresh.length > 0) { strand(key, fresh); handed.add(key); }
    // a stranded act the key's bytes or a copy aside now hold is on this phone; one memory no longer holds since
    // the load that handed it back is settled
    const held = new Set(mine.map(queueActIdent));
    unstrand(key, (i) => there.has(i) || done.has(i) || (handed.has(key) && !held.has(i)));
    releaseAside(storage, key, held);
  };

  const guard = {
    /** a load of `key`: its acts when this release can read them, else none (it is reported to `onRead`, and kept) */
    load(storage: Store, key: string): OutboxOp[] {
      const raw = storage.getItem(key);
      const read = readStoredQueue(raw, scopesOf(key));
      onRead(key, 'acts' in read ? 'ok' : read.unreadable, raw);
      unkept.delete(key);
      const acts = 'acts' in read ? read.acts : [];
      // this key's stranded acts come back first, as the scope-move write puts its unsent acts first; one the key now
      // holds (read or not) is not taken twice
      // one the key now holds is on this phone, so let go; the rest stay held until a write stores them (`unstrand`)
      const there = 'acts' in read ? new Set(acts.map(queueActIdent)) : identsIn(raw);
      unstrand(key, (i) => there.has(i));
      const held = stranded.get(key);
      if (!held) return acts;
      handed.add(key);
      return [...held, ...acts];
    },
    /** another tab wrote `key` (a storage event): it is read and reported, never answered */
    heard(storage: Store, key: string): void {
      const raw = storage.getItem(key);
      onRead(key, readOf(raw, scopesOf(key)), raw);
    },
    /** every key's memory goes (the scope moved, or the person signed out) */
    forget(): void {
      madeAside.clear();
      unkept.clear();
      asideDone.clear();
      handed.clear();
    },
    /** The flush's write of the scope it no longer holds (a scope move during the flush): this flush's acts (`batch`,
     *  sent or not) leave the stored list, its unsent ones (`rest`) go first, and every other act stays, by identity.
     *  `after` (a move or drop of this release's own acts) sees only the acts `takes` accepts: an entry memory leaves
     *  out (a visit photo's act, another kind) stays byte for byte (Codex 4344436672). A key this release cannot read is
     *  never written over: the unsent acts are copied aside beside it. True only once they are on this phone. When
     *  neither the write nor the copy can be made (`storage` null: none to be had), they are held stranded, never
     *  dropped (Codex 4345664670). */
    keepUnsent(storage: Store | null, key: string, rest: OutboxOp[], batch: OutboxOp[], after: (l: OutboxOp[]) => OutboxOp[], takes: (o: OutboxOp) => boolean = () => true): boolean {
      let there = new Set<string>();
      try {
        if (!storage) throw new Error('no storage');
        const stored = readKey(storage, key, scopesOf(key));
        if (stored === null) {
          // counted against the key's own entries, so an act it already holds is not copied aside again
          there = identsIn(storage.getItem(key));
          const fresh = rest.filter((o) => !there.has(queueActIdent(o)));
          if (fresh.length === 0 || copyAside(storage, key, JSON.stringify(fresh))) {
            const kept = new Set(rest.map(queueActIdent));
            unstrand(key, (i) => kept.has(i));
            return true;
          }
          strand(key, fresh);
          return false;
        }
        there = new Set(stored.map(queueActIdent));
        const flushed = new Set([...batch, ...rest].map(queueActIdent));
        const others = stored.filter((o) => !flushed.has(queueActIdent(o)));
        const next = [...rest, ...after(others.filter(takes)), ...others.filter((o) => !takes(o))];
        storage.setItem(key, JSON.stringify(next));
        const kept = new Set(next.map(queueActIdent));
        unstrand(key, (i) => kept.has(i));
        return true;
      } catch {
        // the key, unchanged, holds what it held: an unsent act it does not hold is stranded
        strand(key, rest.filter((o) => !there.has(queueActIdent(o))));
        return false;
      }
    },
    /** how many acts are held stranded, over every key */
    strandedCount(): number {
      // one this tab also lists not kept for its key is counted there, not twice
      let n = 0;
      for (const [key, acts] of stranded) n += acts.filter((o) => !unkept.get(key)?.has(queueActIdent(o))).length;
      return n;
    },
    /** Write this tab's acts (`mine`) for `key`, and every stored entry `takes` refuses (memory left it out on purpose).
     *  False when nothing was stored: the acts it could not store are then copied aside beside the key, once each, so
     *  they stay on this phone, and are listed not kept. */
    write(storage: Store, key: string, mine: OutboxOp[], takes: (o: OutboxOp) => boolean = () => true): boolean {
      const raw = storage.getItem(key);
      try {
        const readAs = readOf(raw, scopesOf(key));
        // bytes this release cannot read are never written over
        if (readAs !== 'ok') { onRead(key, readAs, raw); throw new Error('unreadable queue key'); }
        const left = (readKey(storage, key, scopesOf(key)) ?? []).filter((o) => !takes(o));
        const text = JSON.stringify([...mine, ...left]);
        if (raw !== text) storage.setItem(key, text);
        onRead(key, 'ok', text);
        unkept.delete(key);
        // a stranded act is let go once the key holds it, or once memory, since the load that handed it back, no longer
        // holds it (settled)
        const kept = new Set(mine.map(queueActIdent));
        unstrand(key, (i) => kept.has(i) || handed.has(key));
        // the key now holds what memory holds, so this tab's copies of it are not needed
        releaseAside(storage, key, new Set());
        return true;
      } catch {
        refuse(storage, key, mine);
        return false;
      }
    },
    /** the acts memory holds for `key` that the key does not hold now */
    notKept(key: string): string[] {
      return [...(unkept.get(key) ?? [])];
    },
  };
  return guard;
}
