import type { OutboxOp } from '@/data/apiGateway';
import { readStoredQueue, type QueueScopes } from '@/data/storedActs';
import { madeActs, markSettled, recordMade, releaseMade, releaseSettled, settledMarks } from '@/store/queueActRecord';

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
 * A key this release reads is merged into, never written from memory alone (B1 U1, `write`): the stored order is kept,
 * another tab's acts stay, and an entry memory leaves out on purpose (`takes`: a lane act of a kind the load does not
 * take, a visit act in the general key) stays, byte for byte. How two tabs' writes are ordered is B1 U2's (a cross-tab
 * lock).
 *
 * The rules every change here keeps (B1 plan, #1094 6370350429):
 * - R1 commit point: a step that can still be undone (a write inside `writeAll`) changes no memory and releases no
 *   evidence; that waits until every write has landed.
 * - R2 no inference from absence: an act is taken by another tab only when its key is present and readable and no
 *   longer holds it. An absent key was cleared, and memory's acts go back in.
 * - R3 identity is a multiset: an identity that is not unique (`json:<bytes>`) is matched by count, one stored
 *   occurrence per held one, in merges, dedupes, records and marks.
 * - R4 bound continuations: work resumed after an await does nothing once its scope, session or key has moved.
 * - R5 evidence after read-back: a record, mark or copy goes only once a read-back shows what it guards is gone or held.
 * - R6 outcomes are total: every result of an all-or-nothing step other than "all" is a failure to the person.
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
/** how many times each identity occurs in a key's bytes, read or not: an act already there is never copied aside
 *  again, and one of two identical acts there holds only one of them (B1 U1, R3) */
function countsIn(raw: string | null): Map<string, number> {
  try {
    const now: unknown = JSON.parse(raw ?? '[]');
    if (Array.isArray(now)) return identityCounts(now.filter((o) => o !== null && typeof o === 'object' && !Array.isArray(o)) as OutboxOp[]);
  } catch { /* not a list: none */ }
  return new Map();
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

/** how many times each identity occurs in `acts` (B1 U1, R3): identity is a multiset, since two identical acts a
 *  release queued with no key (or a `submitInspection`, which has none) share one */
export function identityCounts(acts: OutboxOp[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const o of acts) { const i = queueActIdent(o); out.set(i, (out.get(i) ?? 0) + 1); }
  return out;
}
/** take one occurrence of `i` from `counts`; false when none is left */
function takeOne(counts: Map<string, number>, i: string): boolean {
  const n = counts.get(i) ?? 0;
  if (n === 0) return false;
  counts.set(i, n - 1);
  return true;
}
/** each act's occurrence of its identity, in order: 1 for the first, 2 for an identical one after it */
function ordinals(acts: OutboxOp[]): number[] {
  const seen = new Map<string, number>();
  return acts.map((o) => { const i = queueActIdent(o); const n = (seen.get(i) ?? 0) + 1; seen.set(i, n); return n; });
}

export type QueueKeyGuard = ReturnType<typeof createQueueKeyGuard>;
/** one queue key's write from memory: this tab's acts for it, and which stored entries memory takes (`write`) */
export type QueueWrite = { key: string; mine: OutboxOp[]; takes: (o: OutboxOp) => boolean };

/** `scopesOf`: the user scopes each key's acts may name (`QueueScopes`), as the store derived them with the key's name.
 *  A key it names none for reads a scope-bearing act as damaged */
export function createQueueKeyGuard(onRead: (key: string, read: KeyRead, raw: string | null) => void = () => {}, scopesOf: (key: string) => QueueScopes | undefined = () => undefined) {
  /** per key, the acts held in memory that the key does not hold now */
  const unkept = new Map<string, Set<string>>();
  /** per key, how many times this tab held each act at its last load or landed write of it (B1 U1). A write leaves out
   *  an act the key still holds that this tab held and no longer does: this tab settled it (sent, or dropped). One this
   *  tab never held is another tab's, and stays (#1086, Codex 4349463910) */
  const known = new Map<string, Map<string, number>>();
  /** per key, how many occurrences of each act a refused write already copied aside (counted: R3) */
  const asideDone = new Map<string, Map<string, number>>();
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
    // each occurrence once: an act already held is not held twice, and a second identical one is a second act (R3)
    const there = identityCounts(was);
    stranded.set(key, [...was, ...acts.filter((o) => !takeOne(there, queueActIdent(o)))]);
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
    const recorded = identityCounts(madeActs(storage, key, scopesOf(key)));
    recordMade(storage, key, acts.filter((o) => !takeOne(recorded, queueActIdent(o))));
  };
  /** step B1a: the key holds `there` now (each identity's occurrences): the made records whose acts it holds or that
   *  are settled go first, then the settled marks of occurrences neither the key nor a record left there holds. A mark
   *  goes only once nothing it guards is left: a record whose removal failed keeps its acts' marks, and a record this
   *  release cannot read keeps them all (#1101 r2, Codex 4360012661). `dropped`: identities a landed write took sent
   *  occurrences of out of the key; their marks go (B1 U1, `releaseSettled`) */
  const tidy = (storage: Store, key: string, there: Map<string, number>, dropped: Set<string> = new Set()): void => {
    const done = new Map(there);
    for (const [i, marks] of settledMarks(storage, key)) if (!dropped.has(i)) done.set(i, (done.get(i) ?? 0) + marks.size);
    const left = releaseMade(storage, key, done, queueActIdent, scopesOf(key));
    if (left === null) return;
    const held = new Map(there);
    for (const [i, n] of left) held.set(i, (held.get(i) ?? 0) + n);
    releaseSettled(storage, key, held, dropped);
  };

  /** A write of `key` that did not land: every act memory holds (`mine`) that the key, unchanged, does not hold now is
   *  listed not kept and copied aside beside it, once each, so it stays on this phone. When the copy cannot be made
   *  (storage full), they are held stranded as `keepUnsent` holds them, so a scope change or sign-out that clears memory
   *  never loses them (Codex 4353751499) */
  const refuse = (storage: Store, key: string, mine: OutboxOp[]): void => {
    // not kept: every act memory holds that the key, unchanged by the refused write, does not hold now
    // counted (R3): the key holding one of two identical acts memory holds leaves the second not kept
    let there = new Map<string, number>();
    try { there = countsIn(storage.getItem(key)); } catch { /* unreadable: none */ }
    const unheld = new Map(there);
    const notThere = mine.filter((o) => !takeOne(unheld, queueActIdent(o)));
    const missing = setOf(unkept, key);
    missing.clear();
    for (const o of notThere) missing.add(queueActIdent(o));
    // an occurrence already copied aside is not copied again; a further identical one is (R3)
    const done = asideDone.get(key) ?? new Map<string, number>();
    asideDone.set(key, done);
    const copiedLeft = new Map(done);
    const fresh = notThere.filter((o) => !takeOne(copiedLeft, queueActIdent(o)));
    // a copy that cannot be made leaves them in memory, listed not kept, and copied at the next write that cannot store
    // them; they are also held stranded, as memory holds them now, so one memory then settles (sent) is let go below
    // A copy holds every occurrence the key lacks of each identity it copies: copies are named by their bytes, so a
    // copy of only the further occurrence would be the earlier copy's bytes, and no new copy (R3)
    const ids = new Set(fresh.map(queueActIdent));
    const copy = notThere.filter((o) => ids.has(queueActIdent(o)));
    const raw = JSON.stringify(copy);
    const record = (name: string) => { const list = madeAside.get(key) ?? []; list.push({ name, raw, idents: copy.map(queueActIdent) }); madeAside.set(key, list); };
    if (fresh.length > 0 && copyAside(storage, key, raw, record)) for (const [i, n] of identityCounts(copy)) done.set(i, Math.max(done.get(i) ?? 0, n));
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
      const marks = settledMarks(storage, key);
      const settled = new Set(marks.keys());
      const stored = 'acts' in read ? read.acts : [];
      known.set(key, identityCounts(stored)); // made and stranded acts are not known: the key never held them
      const thereCounts = 'acts' in read ? identityCounts(stored) : countsIn(raw);
      const there = new Set(thereCounts.keys());
      // a made act is taken once, and never beside the same act in the key: counted, so a second identical act is a
      // second act (B1 U1, R3)
      const seen = new Map(thereCounts);
      const made = madeActs(storage, key, scopesOf(key)).filter((o) => !takeOne(seen, queueActIdent(o)));
      // an occurrence marked settled is not loaded: the n-th of an identity only by the n-th's mark (the B1a residual:
      // one mark left out every identical act)
      const all = [...stored, ...made];
      const nth = ordinals(all);
      const acts = all.filter((o, n) => !marks.get(queueActIdent(o))?.has(nth[n]));
      tidy(storage, key, thereCounts);
      // this key's stranded acts come back first, as the scope-move write puts its unsent acts first; one the key now
      // holds (read or not) is not taken twice
      // one the key now holds is on this phone, so let go; the rest stay held until a write stores them (`unstrand`).
      // One marked settled is let go too: the server has it, so it is never handed back (#1101 r1, Codex 4359759858)
      unstrand(key, (i) => there.has(i) || settled.has(i));
      const held = stranded.get(key);
      if (!held) return acts;
      handed.add(key);
      const kept = identityCounts(held);
      return [...held, ...acts.filter((o) => !takeOne(kept, queueActIdent(o)))];
    },
    /** another tab wrote `key` (a storage event): it is read and reported, never answered */
    heard(storage: Store, key: string): void {
      const raw = storage.getItem(key);
      onRead(key, readOf(raw, scopesOf(key)), raw);
    },
    /** every key's memory goes (the scope moved, or the person signed out) */
    forget(): void {
      known.clear();
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
      // counted (R3): a key holding one of two identical unsent acts holds only one of them
      let there = new Map<string, number>();
      const notIn = (acts: OutboxOp[]) => { const unheld = new Map(there); return acts.filter((o) => !takeOne(unheld, queueActIdent(o))); };
      try {
        if (!storage) throw new Error('no storage');
        const stored = readKey(storage, key, scopesOf(key));
        if (stored === null) {
          // counted against the key's own entries, so an act it already holds is not copied aside again
          there = countsIn(storage.getItem(key));
          const fresh = notIn(rest);
          if (fresh.length === 0 || copyAside(storage, key, JSON.stringify(fresh))) {
            const kept = new Set(rest.map(queueActIdent));
            unstrand(key, (i) => kept.has(i));
            return true;
          }
          strand(key, fresh);
          keepMade(storage, key, fresh); // step B1a: neither written nor copied, they come back with the key's next load
          return false;
        }
        there = identityCounts(stored);
        // this flush's acts leave the stored list once each, the first occurrences in its order (R3): an identical act
        // this flush did not take stays
        const flushed = identityCounts(batch);
        const unsent = identityCounts(rest);
        for (const [i, n] of unsent) if (n > (flushed.get(i) ?? 0)) flushed.set(i, n);
        const sent = new Set([...identityCounts(batch)].filter(([i, n]) => n > (unsent.get(i) ?? 0)).map(([i]) => i));
        const others = stored.filter((o) => !takeOne(flushed, queueActIdent(o)));
        const next = [...rest, ...after(others.filter(takes)), ...others.filter((o) => !takes(o))];
        const text = JSON.stringify(next);
        storage.setItem(key, text);
        const kept = new Set(next.map(queueActIdent));
        unstrand(key, (i) => kept.has(i));
        tidy(storage, key, countsIn(text), sent);
        return true;
      } catch {
        // the key, unchanged, holds what it held: an unsent act it does not hold is stranded, and kept in a made record
        // when storage takes one
        const left = notIn(rest);
        strand(key, left);
        if (storage) keepMade(storage, key, left);
        return false;
      }
    },
    /** step B1a: an act of `key` the server now has (sent) or refused for good, marked so before the flush goes on: a
     *  load before the key is written without it does not take it again. False when the mark could not be made */
    settled(storage: Store | null, key: string, o: OutboxOp, ordinal = 1): boolean {
      return storage ? markSettled(storage, key, queueActIdent(o), ordinal) : false;
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
    write(storage: Store, key: string, mine: OutboxOp[], takes: (o: OutboxOp) => boolean = () => true, tidyNow = true): boolean {
      const raw = storage.getItem(key);
      try {
        const readAs = readOf(raw, scopesOf(key));
        const copied = readAs !== 'ok' && raw === setAsideRaw.get(key);
        // bytes this release cannot read are never written over, unless the person's tap copied them aside
        if (readAs !== 'ok' && !copied) { onRead(key, readAs, raw); throw new Error('unreadable queue key'); }
        // B1 U1: memory is merged into the key as it holds it now, in its stored order (#1084, Codex 4344812888): an
        // act memory holds is memory's version; one this tab held and no longer does, or that is marked settled, goes;
        // every other act (another tab's) stays (#1086, Codex 4349463910); then memory's new acts. Identity is counted
        // (R3): each held occurrence answers one stored occurrence (#1099 r3, Codex 4360928338). An absent key was
        // cleared, never sent: nothing in it was taken, so all of memory goes back in (R2, #1099 r3, Codex 4360928298)
        const stored = copied || raw === null ? [] : (readKey(storage, key, scopesOf(key)) ?? []);
        const knew = copied || raw === null ? new Map<string, number>() : known.get(key) ?? new Map<string, number>();
        const had = new Map(knew);
        const marks = settledMarks(storage, key);
        const nth = ordinals(stored);
        const mineNth = ordinals(mine);
        const answered = new Map<string, number>();
        const dropped = new Set<string>();
        const next: OutboxOp[] = [];
        stored.forEach((o, n) => {
          if (!takes(o)) { next.push(o); return; }
          const i = queueActIdent(o);
          const k = (answered.get(i) ?? 0) + 1;
          const mineOne = mine.find((m, j) => mineNth[j] === k && queueActIdent(m) === i);
          if (mineOne) { answered.set(i, k); next.push(mineOne); return; }
          if (takeOne(had, i) || marks.get(i)?.has(nth[n])) { dropped.add(i); return; }
          next.push(o);
        });
        // memory's other acts go last, all but those this tab held at its last load or write that the key, present and
        // read, no longer holds: another tab took them (sent, or dropped for good), so they are not put back (R2)
        mine.forEach((m, j) => {
          const i = queueActIdent(m);
          if (mineNth[j] > (answered.get(i) ?? 0) && mineNth[j] > (knew.get(i) ?? 0)) next.push(m);
        });
        const text = JSON.stringify(next);
        if (raw !== text) storage.setItem(key, text);
        // read as it now is, only once the write has landed: a set-aside key stays listed until it is written over
        // (Codex 4345664686)
        onRead(key, 'ok', text);
        unkept.delete(key);
        // a stranded act is let go once the key holds it, or once memory, since the load that handed it back, no longer
        // holds it (settled)
        const kept = new Set(mine.map(queueActIdent));
        unstrand(key, (i) => kept.has(i) || handed.has(key));
        // the key now holds what memory holds, so this tab's copies of it are not needed, nor its records and marks.
        // A write of Set aside's all-or-nothing lets them go only once every key's write has landed (`writeAll`): until
        // then a key may be put back, and its copies and made records with it are still its acts' only record (#1101
        // r1, Codex 4359759846; r2 audit: the copies aside too)
        if (tidyNow) {
          known.set(key, identityCounts(mine));
          releaseAside(storage, key, new Set());
          tidy(storage, key, identityCounts(next), dropped);
        }
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
        if (guard.write(storage, w.key, w.mine, w.takes, false)) { landed.push({ w, raw }); continue; }
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
      // every write landed: what this tab holds of each key, and the copies, records and marks they settle, change
      // only now (R1: a write that may still be put back changes nothing in memory)
      for (const { w } of landed) {
        known.set(w.key, identityCounts(w.mine));
        releaseAside(storage, w.key, new Set());
        try { tidy(storage, w.key, countsIn(storage.getItem(w.key))); } catch { /* kept: a record is never a loss */ }
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
