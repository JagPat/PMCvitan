import type { OutboxOp } from '@/data/apiGateway';
import { readStoredQueue, type QueueScopes } from '@/data/storedActs';
import { madeActs, markSettled, recordMade, releaseMade, releaseSettled, settledIdents } from '@/store/queueActRecord';

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
 *  already there is that copy, made again by nothing (Codex 4346169602: each retry of a Set aside that failed part way
 *  made another copy of the same key, taking the room the person freed). `made` hears the name of a copy this call
 *  wrote; one that does not read back as written is removed */
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
  if (name !== null) removeCopies(storage, [name]);
  return false;
}
/** remove copies this tab made, best effort: one that cannot be removed is a copy of bytes the key still holds */
function removeCopies(storage: Store, names: string[]): void {
  for (const name of names) {
    try { storage.removeItem?.(name); } catch { /* left: a duplicate, never a loss */ }
  }
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
  /** per key, the bytes the person's tap copied aside: the key may be written over while it still holds them */
  const setAsideRaw = new Map<string, string>();
  /** the keys loaded since the last `forget`: the scope a load ran for (Codex 4345664679) */
  const loaded = new Set<string>();
  /** per key, the unsent acts of a scope this tab moved off that could be neither written there nor copied aside (Codex
   *  4345664670). They are held here for the tab's life, whatever scope it moves to, counted by the reload question,
   *  and loaded again with their key, so a return to that scope holds them as before; they stay held, and counted,
   *  until a write or a copy aside puts them on this phone, or they are settled (`unstrand`). They are lost when the tab closes
   *  or reloads without asking (no leave gate yet: residual, ended by plan step 4). `forget` keeps them, so after a
   *  sign-out the next person's reload question counts them too; they are sent only from their own key, whose name
   *  holds the person's sub, so never under another person. */
  const stranded = new Map<string, OutboxOp[]>();
  const strand = (key: string, acts: OutboxOp[]): void => {
    const was = stranded.get(key) ?? [];
    const there = new Set(was.map(queueActIdent));
    stranded.set(key, [...was, ...acts.filter((o) => !there.has(queueActIdent(o)))]);
  };
  /** A stranded act stays held, and counted, until it is on this phone (a write or a copy aside holds it) or settled.
   *  A load hands it back to memory but never lets go of it (Codex 4346778591: let go there, a Reload over a newer
   *  release's key asked about none and lost it). `drop` names the acts to let go */
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

  /** step B1a: `acts` the key does not hold go into a made record, all but those a record already holds */
  const keepMade = (storage: Store, key: string, acts: OutboxOp[]): void => {
    const recorded = new Set(madeActs(storage, key, scopesOf(key)).map(queueActIdent));
    recordMade(storage, key, acts.filter((o) => !recorded.has(queueActIdent(o))));
  };
  /** step B1a: the key holds `there` now: the made records whose acts it holds or that are settled go, and so do the
   *  settled marks of acts it no longer holds */
  const tidy = (storage: Store, key: string, there: Set<string>): void => {
    const settled = settledIdents(storage, key);
    releaseMade(storage, key, (i) => there.has(i) || settled.has(i), queueActIdent, scopesOf(key));
    releaseSettled(storage, key, there);
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
    // step B1a: not copied, they are also kept in a made record, which a load takes back: a closed page loses them no
    // more than a sign-out or a project switch does
    else if (fresh.length > 0) { strand(key, fresh); handed.add(key); keepMade(storage, key, fresh); }
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
      loaded.add(key);
      // step B1a: an act marked settled is not loaded (sent, or refused for good, before the key was written without
      // it); the acts of this key's made records the key does not hold come back after its own
      const settled = settledIdents(storage, key);
      const stored = 'acts' in read ? read.acts : [];
      const there = 'acts' in read ? new Set(stored.map(queueActIdent)) : identsIn(raw);
      // a made act is taken once, and never beside the same act in the key
      const seen = new Set(there);
      const made = madeActs(storage, key, scopesOf(key)).filter((o) => { const i = queueActIdent(o); if (seen.has(i)) return false; seen.add(i); return true; });
      const acts = [...stored, ...made].filter((o) => !settled.has(queueActIdent(o)));
      tidy(storage, key, there);
      // this key's stranded acts come back first, as the scope-move write puts its unsent acts first; one the key now
      // holds (read or not) is not taken twice
      // one the key now holds is on this phone, so let go; the rest stay held until a write stores them (`unstrand`)
      unstrand(key, (i) => there.has(i));
      const held = stranded.get(key);
      if (!held) return acts;
      handed.add(key);
      const kept = new Set(held.map(queueActIdent));
      return [...held, ...acts.filter((o) => !kept.has(queueActIdent(o)))];
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
      setAsideRaw.clear();
      loaded.clear();
      handed.clear();
    },
    /** whether every one of `keys` was loaded since the last `forget`: memory holds their scope's acts */
    holds(keys: string[]): boolean {
      return keys.every((k) => loaded.has(k));
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
          keepMade(storage, key, fresh); // step B1a: neither written nor copied, they come back with the key's next load
          return false;
        }
        there = new Set(stored.map(queueActIdent));
        const flushed = new Set([...batch, ...rest].map(queueActIdent));
        const others = stored.filter((o) => !flushed.has(queueActIdent(o)));
        const next = [...rest, ...after(others.filter(takes)), ...others.filter((o) => !takes(o))];
        const text = JSON.stringify(next);
        storage.setItem(key, text);
        const kept = new Set(next.map(queueActIdent));
        unstrand(key, (i) => kept.has(i));
        tidy(storage, key, identsIn(text));
        return true;
      } catch {
        // the key, unchanged, holds what it held: an unsent act it does not hold is stranded, and kept in a made record
        // when storage takes one
        const left = rest.filter((o) => !there.has(queueActIdent(o)));
        strand(key, left);
        if (storage) keepMade(storage, key, left);
        return false;
      }
    },
    /** step B1a: an act of `key` the server now has (sent) or refused for good, marked so before the flush goes on: a
     *  load before the key is written without it does not take it again. False when the mark could not be made */
    settled(storage: Store | null, key: string, o: OutboxOp): boolean {
      return storage ? markSettled(storage, key, queueActIdent(o)) : false;
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
        const copied = readAs !== 'ok' && raw === setAsideRaw.get(key);
        // bytes this release cannot read are never written over, unless the person's tap copied them aside
        if (readAs !== 'ok' && !copied) { onRead(key, readAs, raw); throw new Error('unreadable queue key'); }
        const left = copied ? [] : (readKey(storage, key, scopesOf(key)) ?? []).filter((o) => !takes(o));
        const text = JSON.stringify([...mine, ...left]);
        if (raw !== text) storage.setItem(key, text);
        // read as it now is, only once the write has landed: a set-aside key stays listed until it is written over
        // (Codex 4345664686)
        onRead(key, 'ok', text);
        unkept.delete(key);
        // a stranded act is let go once the key holds it, or once memory, since the load that handed it back, no longer
        // holds it (settled)
        const kept = new Set(mine.map(queueActIdent));
        unstrand(key, (i) => kept.has(i) || handed.has(key));
        // the key now holds what memory holds, so this tab's copies of it are not needed
        releaseAside(storage, key, new Set());
        tidy(storage, key, identsIn(text));
        return true;
      } catch {
        refuse(storage, key, mine);
        return false;
      }
    },
    /** The person's tap: copy every key's unreadable bytes aside and read each copy back (a copy of the same bytes
     *  already there is kept as it is); only when every copy succeeded are those exact bytes let be written over.
     *  False when one could not be made: no key is marked, and the copies this tap made are removed, so a retry finds
     *  the room it had (Codex 4346169602). */
    setAside(storage: Store, keys: string[]): boolean {
      const copied = new Map<string, string>();
      const made: string[] = [];
      for (const key of keys) {
        const raw = storage.getItem(key);
        if (raw === null || readOf(raw, scopesOf(key)) === 'ok') continue;
        if (!copyAside(storage, key, raw, (n) => made.push(n))) { removeCopies(storage, made); return false; }
        copied.set(key, raw);
      }
      for (const [key, raw] of copied) setAsideRaw.set(key, raw);
      return true;
    },
    /** The writes of the person's Set aside tap, after `setAside` copied each key: all of them, or none (Codex
     *  4348114913: one key written over and the other refused, the person was told nothing was changed). A write that
     *  does not land puts each key written before it back to the bytes it held, whose copy aside holds them too, and
     *  lists its acts not kept. 'all' when every write landed, 'none' when nothing is changed, 'some' when a key could
     *  not be put back: it holds memory's acts and is no longer listed */
    writeAll(storage: Store, writes: QueueWrite[]): 'all' | 'none' | 'some' {
      const landed: { w: QueueWrite; raw: string | null }[] = [];
      for (const w of writes) {
        const raw = storage.getItem(w.key);
        if (guard.write(storage, w.key, w.mine, w.takes)) { landed.push({ w, raw }); continue; }
        let back = true;
        for (const { w: done, raw: was } of landed.reverse()) {
          try {
            if (was === null) storage.removeItem?.(done.key); else storage.setItem(done.key, was);
            if (storage.getItem(done.key) !== was) throw new Error('not put back');
            onRead(done.key, readOf(was, scopesOf(done.key)), was);
            refuse(storage, done.key, done.mine);
          } catch { back = false; }
        }
        return back ? 'none' : 'some';
      }
      return 'all';
    },
    /** how many acts memory holds that their key does not hold now, over every key */
    notKeptCount(): number {
      let n = 0;
      for (const s of unkept.values()) n += s.size;
      return n;
    },
    /** the acts memory holds for `key` that the key does not hold now */
    notKept(key: string): string[] {
      return [...(unkept.get(key) ?? [])];
    },
  };
  return guard;
}
