import type { OutboxOp } from '@/data/apiGateway';
import { readLedgerQueue, type QueueScopes } from '@/data/storedActs';
import { queueActIdent } from '@/store/queueActIdent';
import {
  decodeSidecar, encodeSidecar, evidenceOf, frameOf, ledgerTag, markName, owedOf, planWrite, readMarkName, recordBytes, recordName,
  recordOid, sidecarName, tokenOf,
  type Memory, type Occ, type Snapshot, type WritePlan,
} from '@/store/queueLedger';

/**
 * WEB-02 step A (#482 6333415419): the stored-act check at the writer of the stored queue keys, the general queue
 * `vitan.outbox.<sub>.<project>` and the visit lane `vitan.siteVisitQueue.<sub>.<project>`.
 *
 * A key holding any entry this release cannot fully read (`readLedgerQueue`: not a list, an entry that is not an act,
 * an act missing a field or breaking a server rule, a newer release's kind, or a misplaced or malformed write token) is
 * unreadable as a whole: nothing loads from it, nothing in it is replayed or settled, and this release never writes it.
 * Its bytes are this phone's only copy of what it holds, so it is written again only once they are copied aside on the
 * person's tap (`setAside`). A write it refuses copies this tab's acts aside beside it, once each, so they stay on this
 * phone.
 *
 * WEB-02 L2b (plan r3 v4 step 4, #1094 6392513851): a key this release reads is written through the occurrence ledger
 * (`queueLedger.ts`), with its write token, under B2f-1's lock. Every act this tab holds has one occurrence id (oid)
 * from the moment it is on this phone (`oidOf`), so two byte-identical acts with no key are never matched by identity
 * (#1106 rounds 1 and 2). The ledger writes every readable key (the fence is `true`): tabs of an earlier release are not
 * supported (R-L2-1 as the Board reworded it), and a tab of an earlier release from step A1 on reads a tokened key as a
 * newer release's and never writes it. An entry memory leaves out on purpose (`takes`: a lane act of a kind the load
 * does not take, a visit act in the general key) stays, byte for byte.
 */

// an act's identity lives in a leaf both queue modules import (#1109 r2); kept exported here for this module's importers
export { queueActIdent };

type Store = Pick<Storage, 'getItem' | 'setItem'> & Partial<Pick<Storage, 'removeItem' | 'key'>> & { readonly length?: number };

/** what the key holds, as this release reads it: 'ok', or why it cannot be read */
export type KeyRead = 'ok' | 'newer' | 'damaged';
const readOf = (raw: string | null, scopes: QueueScopes | undefined): KeyRead => { const r = readLedgerQueue(raw, scopes); return 'acts' in r ? 'ok' : r.unreadable; };
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
/** every stored name under `prefix` (the key's records or marks) */
function namesUnder(storage: Store, prefix: string): string[] {
  const out: string[] = [];
  try {
    const n = storage.length ?? 0;
    for (let i = 0; i < n; i += 1) {
      const k = storage.key?.(i);
      if (typeof k === 'string' && k.startsWith(prefix)) out.push(k);
    }
  } catch { /* none to be read */ }
  return out;
}
/** true only once `name` reads back as gone */
function remove(storage: Store, name: string): boolean {
  try {
    storage.removeItem?.(name);
    return storage.getItem(name) === null;
  } catch {
    return false; // left: a record or mark is never a loss
  }
}
/** set `name` to `value` and read it back */
function put(storage: Store, name: string, value: string): boolean {
  try {
    storage.setItem(name, value);
    return storage.getItem(name) === value;
  } catch {
    return false;
  }
}
const newNonce = (): string => Array.from(globalThis.crypto.getRandomValues(new Uint32Array(4)), (n) => n.toString(16).padStart(8, '0')).join('');
/** an identity no other act shares: an idempotency key, or a photo's client key */
const unique = (o: OutboxOp): boolean => !queueActIdent(o).startsWith('json:');

/** A key's snapshot for the ledger, read whole (reads only), with each mark's stored name by what it marks */
type Read = Snapshot & { markNames: Map<string, string>; legacyNames: Map<string, string[]> };
function snapshotOf(storage: Store, key: string, scopes: QueueScopes | undefined): Read {
  const raw = storage.getItem(key);
  const read = readLedgerQueue(raw, scopes);
  let sidecar = null;
  try { sidecar = decodeSidecar(storage.getItem(sidecarName(key))); } catch { sidecar = null; }
  const ids = new Set<string>();
  const legacy = new Set<string>();
  const markNames = new Map<string, string>();
  const legacyNames = new Map<string, string[]>();
  for (const name of namesUnder(storage, `vitan.settled.${key}.`)) {
    let v: string | null = null;
    try { v = storage.getItem(name); } catch { continue; }
    const m = readMarkName(key, name);
    if (v === null || m === null) continue;
    if ('oid' in m) { ids.add(m.oid); markNames.set(m.oid, name); } else { legacy.add(v); legacyNames.set(v, [...(legacyNames.get(v) ?? []), name]); }
  }
  const prefix = `vitan.made.${key}.`;
  const order = (n: string) => { const v = Number(n.slice(prefix.length).split('.')[0]); return Number.isSafeInteger(v) && v > 0 ? v : 0; };
  const records: { name: string; acts: OutboxOp[] }[] = [];
  let recordsUnread = false;
  for (const name of namesUnder(storage, prefix).sort((a, b) => order(a) - order(b) || (a < b ? -1 : a > b ? 1 : 0))) {
    let r: string | null = null;
    try { r = storage.getItem(name); } catch { recordsUnread = true; continue; }
    if (r === null) continue; // gone since it was listed
    const rec = readLedgerQueue(r, scopes);
    if ('acts' in rec) records.push({ name, acts: rec.acts }); else recordsUnread = true;
  }
  // L2b: the ledger writes every key this release reads (R-L2-1 as reworded: earlier releases are not supported)
  return { key, raw, acts: 'acts' in read ? read.acts : null, token: 'acts' in read ? read.token : null, sidecar, marks: { ids, legacy }, records, recordsUnread, fence: true, markNames, legacyNames };
}

export type QueueKeyGuard = ReturnType<typeof createQueueKeyGuard>;
/** one queue key's write from memory: this tab's acts for it, and which stored entries memory takes (`write`) */
export type QueueWrite = { key: string; mine: OutboxOp[]; takes: (o: OutboxOp) => boolean };

/** `scopesOf`: the user scopes each key's acts may name (`QueueScopes`), as the store derived them with the key's name.
 *  A key it names none for reads a scope-bearing act as damaged */
export function createQueueKeyGuard(onRead: (key: string, read: KeyRead, raw: string | null) => void = () => {}, scopesOf: (key: string) => QueueScopes | undefined = () => undefined) {
  /** each act object this tab holds, and its occurrence id: given at the load that read it, at the record that kept
   *  it, or at its first write (a new act). The store keeps a queued act as the same object until the flush removes it
   *  (`notes/site-visits/web-02-L2b/identity-map.md`); an act it re-creates has a key, and is found by it (`oidOf`) */
  const oids = new WeakMap<OutboxOp, string>();
  /** per key, the occurrences this tab read in the key at its last load or landed write (the ledger's `known`) */
  const known = new Map<string, Map<string, OutboxOp>>();
  /** per key, the occurrences this tab marked settled since its last landed write (the ledger's `sent`) */
  const sent = new Map<string, Set<string>>();
  /** per key, the occurrences this tab's load took as another occurrence of the same act (an identity no other act
   *  shares): a record holding one is spent at the next landed write (re-check N2) */
  const merged = new Map<string, Set<string>>();
  /** per key, the occurrences held in memory that the key does not hold now */
  const unkept = new Map<string, Set<string>>();
  /** step B2f-1: each locked write still waiting for its lock (`ask`): its key, and the occurrences it carries that the
   *  key did not hold when it was asked. They are in a made record the whole wait, and counted by the reload question */
  const waiting = new Map<number, { key: string; oids: Set<string> }>();
  let asks = 0;
  /** per key, the occurrences a refused write already copied aside */
  const asideDone = new Map<string, Set<string>>();
  /** per key, the bytes the person's tap copied aside: the key may be written over while it still holds them */
  const setAsideRaw = new Map<string, string>();
  /** per key, the occurrences this tab last saw in it, held from sending once another tab made the key unreadable: that
   *  tab's bytes may hold them (Codex 4353751507). Let go once the key is loaded, written, or heard readable again */
  const withheld = new Map<string, Set<string>>();
  /** per key, the bytes this tab's last landed write left there: bytes a write finds that are still these are this
   *  tab's own, not another tab's, and hold nothing (#1122 r1) */
  const ownRaw = new Map<string, string>();
  /** the keys loaded since the last `forget`: the scope a load ran for (Codex 4345664679) */
  const loaded = new Set<string>();
  /** per key, the unsent occurrences of a scope this tab moved off that could be neither written there nor copied
   *  aside (Codex 4345664670). They are held here for the tab's life, whatever scope it moves to, counted by the reload
   *  question, and loaded again with their key, first; they stay held until a write or a copy aside puts them on this
   *  phone, or they are settled (`unstrand`). `forget` keeps them; they are sent only from their own key, whose name
   *  holds the person's sub, so never under another person. */
  const stranded = new Map<string, Occ[]>();
  /** the keys whose stranded occurrences a load since the last `forget` handed back to memory: a write of such a key
   *  whose memory no longer holds one has settled it */
  const handed = new Set<string>();
  /** per key, the copies a refused write of this tab made of occurrences memory held (Codex 4356145036) */
  const madeAside = new Map<string, { name: string; raw: string; oids: string[] }[]>();
  const setOf = <T,>(m: Map<string, Set<T>>, key: string): Set<T> => {
    let s = m.get(key);
    if (!s) m.set(key, (s = new Set()));
    return s;
  };

  /** `o`'s occurrence id in `key`. One this tab named keeps its name. One the store re-created (a keyed act: a visit
   *  move, a legacy coalesce key) is the one occurrence of its identity this tab knows in the key or holds stranded.
   *  Any other is a new act, named now */
  const oidOf = (key: string, o: OutboxOp, frame: Occ[] = []): string => {
    let oid: string | null = null;
    if (unique(o)) {
      // an identity no other act shares is one occurrence: wherever the key holds it now, that is its name there
      const ident = queueActIdent(o);
      const inKey = frame.find((f) => queueActIdent(f.act) === ident);
      if (inKey) oid = inKey.oid;
    }
    oid ??= oids.get(o) ?? null;
    if (oid === null && unique(o)) {
      const ident = queueActIdent(o);
      const of = [...(known.get(key) ?? new Map<string, OutboxOp>()).entries(), ...(stranded.get(key) ?? []).map((s) => [s.oid, s.act] as const)]
        .find(([, a]) => queueActIdent(a) === ident);
      oid = of ? of[0] : `u:${ledgerTag(ident)}`;
    }
    oid ??= `n:${newNonce()}`;
    oids.set(o, oid);
    identOf.set(oid, queueActIdent(o));
    return oid;
  };
  /** `acts` named, each occurrence once; `frame`: the key's occurrences as read now */
  const occsOf = (key: string, acts: OutboxOp[], frame: Occ[] = []): Occ[] => {
    const seen = new Set<string>();
    const out: Occ[] = [];
    for (const act of acts) { const oid = oidOf(key, act, frame); if (!seen.has(oid)) { seen.add(oid); out.push({ oid, act }); } }
    return out;
  };
  /** what each occurrence id names, as an identity (the not-kept list is read by identity) */
  const identOf = new Map<string, string>();
  const memoryOf = (key: string, mine: Occ[], front?: Set<string>): Memory =>
    ({ mine, known: new Set((known.get(key) ?? new Map()).keys()), sent: new Set(sent.get(key) ?? []), front });

  const strand = (key: string, occs: Occ[]): void => {
    const was = stranded.get(key) ?? [];
    const there = new Set(was.map((o) => o.oid));
    stranded.set(key, [...was, ...occs.filter((o) => !there.has(o.oid))]);
  };
  /** A stranded occurrence stays held, and counted, until it is on this phone (a write or a copy aside holds it) or
   *  settled. `drop` names the ones to let go */
  const unstrand = (key: string, drop: (oid: string) => boolean): void => {
    const held = stranded.get(key);
    if (!held) return;
    const left = held.filter((o) => !drop(o.oid));
    if (left.length > 0) stranded.set(key, left); else stranded.delete(key);
  };
  /** the copies of `key` this tab made whose occurrences memory (`held`) no longer holds are removed, and they may be
   *  copied again; a copy whose bytes changed, or that cannot be removed, stays */
  const releaseAside = (storage: Store, key: string, held: Set<string>): void => {
    const made = madeAside.get(key);
    if (!made) return;
    const left = made.filter((c) => {
      if (c.oids.some((i) => held.has(i))) return true;
      try { if (storage.getItem(c.name) === c.raw) storage.removeItem?.(c.name); } catch { /* left: kept bytes are never a loss */ }
      for (const i of c.oids) asideDone.get(key)?.delete(i);
      return false;
    });
    if (left.length > 0) madeAside.set(key, left); else madeAside.delete(key);
  };

  /** step B1a: `occs` the key does not hold go into a new made record (`recordBytes`, `recordName`), all but those a
   *  record already holds; each then has the record's name (`recordOid`), so a write that lands names it in the key and
   *  its release lets the record go. False when it was not kept */
  const keepMade = (storage: Store, key: string, s: Snapshot, occs: Occ[]): boolean => {
    const inRecords = new Set(s.records.flatMap((r) => r.acts.map((_, n) => recordOid(key, r.name, n))));
    const fresh = occs.filter((o) => !inRecords.has(o.oid));
    if (fresh.length === 0) return true;
    const nonce = newNonce();
    const raw = recordBytes(fresh.map((o) => o.act), nonce);
    const name = recordName(key, namesUnder(storage, `vitan.made.${key}.`), raw, nonce);
    if (!put(storage, name, raw)) return false;
    fresh.forEach((o, n) => {
      const oid = recordOid(key, name, n);
      oids.set(o.act, oid);
      identOf.set(oid, queueActIdent(o.act));
      // a stranded or waiting occurrence takes its record's name with it
      const held = stranded.get(key);
      if (held) stranded.set(key, held.map((h) => (h.oid === o.oid ? { oid, act: h.act } : h)));
      for (const w of waiting.values()) if (w.key === key && w.oids.delete(o.oid)) w.oids.add(oid);
      const un = unkept.get(key);
      if (un?.delete(o.oid)) un.add(oid);
      const hold = withheld.get(key);
      if (hold?.delete(o.oid)) hold.add(oid);
      o.oid = oid;
    });
    return true;
  };

  /** Plan r3 v4 §2, the release after a landed write (R5): the records the write made redundant go, then the marks,
   *  each pass read back after the write, and each checked against the key's token after its removals. A token that
   *  changed (another writer since) puts every removed name back, byte for byte; a record that cannot be put back keeps
   *  its occurrences held stranded here, counted and sent (“saved on this phone” only after a real write) */
  const release = (storage: Store, key: string, plan: Pick<WritePlan, 'legacySpent' | 'sent'>): void => {
    const tokenNow = (): string | null => {
      try { const v: unknown = JSON.parse(storage.getItem(key) ?? '[]'); return Array.isArray(v) ? tokenOf(v).token : null; } catch { return null; }
    };
    const s = snapshotOf(storage, key, scopesOf(key));
    const ev = evidenceOf(s, plan);
    // a record's act with an identity no other act shares is done once the key holds that identity (an earlier
    // release's record names it by its bytes, so its oid is not the key's)
    const frame = frameOf(s);
    if (frame.exact && s.acts !== null) {
      const inKey = new Set(frame.occs.map((o) => o.oid));
      const keyIdents = new Set(frame.occs.filter((o) => unique(o.act)).map((o) => queueActIdent(o.act)));
      const sentHere = new Set(plan.sent);
      for (const r of s.records) {
        if (ev.records.includes(r.name)) continue;
        // or once this tab's load took it as the same act as another occurrence (merged): that one is in the key now, or
        // memory let it go (sent or removed), and either way this copy is spent (re-check N2)
        const into = merged.get(key) ?? new Set<string>();
        const done = r.acts.every((act, n) => { const oid = recordOid(key, r.name, n); return inKey.has(oid) || s.marks.ids.has(oid) || sentHere.has(oid) || into.has(oid) || (unique(act) && keyIdents.has(queueActIdent(act))); });
        if (done) ev.records.push(r.name);
      }
    }
    const removed: { name: string; raw: string; occs: Occ[] }[] = [];
    for (const name of ev.records) {
      const raw = storage.getItem(name);
      const rec = s.records.find((r) => r.name === name);
      if (raw === null || !rec) continue;
      if (remove(storage, name)) removed.push({ name, raw, occs: rec.acts.map((act, n) => ({ oid: recordOid(key, name, n), act })) });
    }
    if (tokenNow() !== s.token) {
      for (const r of removed) if (!put(storage, r.name, r.raw)) { strand(key, r.occs); for (const o of r.occs) setOf(unkept, key).add(o.oid); }
      return;
    }
    const s2 = snapshotOf(storage, key, scopesOf(key));
    const ev2 = evidenceOf(s2, plan);
    const gone: { name: string; value: string }[] = [];
    const drop = (name: string) => { const value = storage.getItem(name); if (value !== null && remove(storage, name)) gone.push({ name, value }); };
    for (const oid of ev2.marks) { const name = s2.markNames.get(oid); if (name) drop(name); }
    for (const ident of ev2.legacy) for (const name of s2.legacyNames.get(ident) ?? []) drop(name);
    if (tokenNow() !== s2.token) for (const g of gone) put(storage, g.name, g.value); // a mark put back is a repeat at most
  };

  /** A write of `key` that did not land: every occurrence memory holds (`mine`) that the key, unchanged, does not hold
   *  now is listed not kept and copied aside beside it, once each, so it stays on this phone. When the copy cannot be
   *  made (storage full), they are held stranded and kept in a made record, so a scope change, sign-out or closed page
   *  never loses them (Codex 4353751499) */
  const refuse = (storage: Store, key: string, mine: Occ[]): void => {
    let s: Read | null = null;
    try { s = snapshotOf(storage, key, scopesOf(key)); } catch { s = null; }
    const missing = setOf(unkept, key);
    missing.clear();
    const notHere = s ? notOnPhone(s, mine) : mine;
    for (const o of notHere) missing.add(o.oid);
    const done = setOf(asideDone, key);
    const fresh = notHere.filter((o) => !done.has(o.oid));
    const raw = JSON.stringify(fresh.map((o) => o.act));
    const record = (name: string) => { const list = madeAside.get(key) ?? []; list.push({ name, raw, oids: fresh.map((o) => o.oid) }); madeAside.set(key, list); };
    if (fresh.length > 0 && copyAside(storage, key, raw, record)) for (const o of fresh) done.add(o.oid);
    else if (fresh.length > 0) { strand(key, fresh); handed.add(key); if (s) keepMade(storage, key, s, fresh); }
    // a stranded occurrence the key or a copy aside now holds is on this phone; one memory no longer holds since the
    // load that handed it back is settled
    const inKey = new Set(s ? frameOids(s) : []);
    const held = new Set(mine.map((o) => o.oid));
    unstrand(key, (i) => inKey.has(i) || done.has(i) || (handed.has(key) && !held.has(i)));
    releaseAside(storage, key, held);
  };
  /** the oids the key holds, as the ledger names them */
  const frameOids = (s: Snapshot): string[] => frameOf(s).occs.map((o) => o.oid);
  /** `mine`'s occurrences the key does not hold: the ones a refused write lists not kept and copies aside. As at
   *  22f5560 only the key counts, so an act a made record also keeps is still copied (Codex 4353751499). A key this
   *  release cannot read is counted by the identities its bytes hold (its occurrences cannot be named) */
  const notOnPhone = (s: Read, mine: Occ[]): Occ[] => {
    if (s.acts === null) {
      const there = identsIn(s.raw);
      return mine.filter((o) => !there.has(queueActIdent(o.act)));
    }
    const there = new Set(frameOids(s));
    return mine.filter((o) => !there.has(o.oid));
  };

  /** `rest`'s occurrences the key does not hold are copied aside beside it (a key this release cannot read, or one this
   *  tab could not take the lock of); true once they are on this phone. Those that can be neither copied nor recorded
   *  are held stranded (Codex 4345664670) */
  const copyUnsentAside = (storage: Store | null, key: string, rest: OutboxOp[]): boolean => {
    let occs = occsOf(key, rest);
    let left = occs;
    try {
      if (!storage) throw new Error('no storage');
      const s = snapshotOf(storage, key, scopesOf(key));
      occs = occsOf(key, rest, frameOf(s).occs);
      left = notOnPhone(s, occs);
      if (left.length === 0 || copyAside(storage, key, JSON.stringify(left.map((o) => o.act)))) {
        const kept = new Set(occs.map((o) => o.oid));
        unstrand(key, (i) => kept.has(i));
        return true;
      }
      strand(key, left);
      keepMade(storage, key, s, left); // step B1a: neither written nor copied, they come back with the key's next load
      return false;
    } catch { /* no storage: none is there */ }
    strand(key, left);
    return false;
  };

  /** Write `plan` (plan r3 v4): the sidecar with its next side pending, the key (when its bytes change), then the
   *  committed sidecar. True once the key holds `plan.raw`: a pending side carrying the key's token names it too */
  const apply = (storage: Store, key: string, plan: WritePlan, raw: string | null): boolean => {
    try {
      storage.setItem(sidecarName(key), encodeSidecar(plan.sidecar));
      if (raw !== plan.raw) storage.setItem(key, plan.raw);
      if (storage.getItem(key) !== plan.raw) return false;
    } catch {
      try { return storage.getItem(key) === plan.raw; } catch { return false; }
    }
    put(storage, sidecarName(key), encodeSidecar(plan.commit));
    return true;
  };
  /** a landed write's memory: the key holds `next`. A settled occurrence memory (`mine`) still holds stays settled
   *  here until memory lets it go (a write-ahead during the flush, before its end write: L2b gap check 2), so no later
   *  write puts it back once its mark has gone */
  const landed = (key: string, next: Occ[], mine: Occ[], raw: string): void => {
    known.set(key, new Map(next.map((o) => [o.oid, o.act])));
    ownRaw.set(key, raw);
    const held = new Set(mine.map((o) => o.oid));
    const was = sent.get(key);
    if (was) { for (const oid of [...was]) if (!held.has(oid)) was.delete(oid); if (was.size === 0) sent.delete(key); }
    unkept.delete(key);
    withheld.delete(key);
  };

  /** U3 (R1): while Set aside's writes are tentative (`writeAll`), what each would tell the strip waits here; the strip
   *  hears it only at the tap's commit point */
  let tentative: [string, KeyRead, string | null][] | null = null;
  const report = (key: string, read: KeyRead, raw: string | null): void => { if (tentative) tentative.push([key, read, raw]); else onRead(key, read, raw); };
  const copySets = (m: Map<string, Set<string>>) => new Map([...m].map(([k, v]) => [k, new Set(v)] as const));
  /** every cell a write or a refusal changes, copied; `tap`: the keys whose `setAsideRaw` the tap itself set */
  const cells = (tap: string[]) => ({
    known: new Map([...known].map(([k, v]) => [k, new Map(v)] as const)),
    ownRaw: new Map(ownRaw),
    sent: copySets(sent), merged: copySets(merged), unkept: copySets(unkept), asideDone: copySets(asideDone), withheld: copySets(withheld),
    stranded: new Map([...stranded].map(([k, v]) => [k, v.map((o) => ({ ...o }))] as const)),
    handed: new Set(handed),
    madeAside: new Map([...madeAside].map(([k, v]) => [k, [...v]] as const)),
    setAsideRaw: new Map([...setAsideRaw].filter(([k]) => !tap.includes(k))),
    lastPlan: new Map(lastPlan),
  });
  const refill = <K, V>(m: Map<K, V>, from: Map<K, V>): void => { m.clear(); for (const [k, v] of from) m.set(k, v); };
  const restore = (c: ReturnType<typeof cells>): void => {
    refill(known, c.known); refill(sent, c.sent); refill(merged, c.merged); refill(unkept, c.unkept); refill(asideDone, c.asideDone);
    refill(withheld, c.withheld); refill(stranded, c.stranded); refill(madeAside, c.madeAside); refill(setAsideRaw, c.setAsideRaw);
    refill(lastPlan, c.lastPlan); refill(ownRaw, c.ownRaw);
    handed.clear(); for (const k of c.handed) handed.add(k);
  };

  /** a key found unreadable: the occurrences this tab last saw in it are held from sending, as another tab's bytes may
   *  hold them (Codex 4353751507), however this tab came to read it (#1122 r1, 4370036882) */
  const holdSeen = (key: string, raw?: string | null): void => {
    if (raw !== undefined && raw !== null && raw === ownRaw.get(key)) return; // this tab's own bytes: no other tab's write
    for (const oid of known.get(key)?.keys() ?? []) setOf(withheld, key).add(oid);
  };

  const guard = {
    /** a load of `key`: its acts when this release can read them, else none (it is reported to `onRead`, and kept) */
    load(storage: Store, key: string): OutboxOp[] {
      const s = snapshotOf(storage, key, scopesOf(key));
      const readAs = readOf(s.raw, scopesOf(key));
      onRead(key, readAs, s.raw);
      unkept.delete(key);
      sent.delete(key);
      withheld.delete(key);
      loaded.add(key);
      const held = stranded.get(key) ?? [];
      // a key this release cannot read: its records' acts come back, but not one its bytes may hold (its occurrences
      // cannot be named), and none is written over
      const snap: Snapshot = s.acts === null && s.raw !== null
        ? { ...s, records: s.records.map((r) => ({ ...r, acts: r.acts.filter((o) => !identsIn(s.raw).has(queueActIdent(o))) })) }
        : s;
      const all = owedOf(snap, held);
      const frame = all.frame;
      // an identity no other act shares is one occurrence: one a record holds beside the key's (or another record's)
      // is the same act, taken once (an earlier release's record names it by its bytes, not as the key does)
      const once = new Set<string>();
      const into = new Set<string>();
      merged.set(key, into);
      const owed = all.owed.filter((o) => { if (!unique(o.act)) return true; const i = queueActIdent(o.act); if (once.has(i)) { into.add(o.oid); return false; } once.add(i); return true; });
      known.set(key, new Map(frame.occs.map((o) => [o.oid, o.act])));
      for (const o of owed) { oids.set(o.act, o.oid); identOf.set(o.oid, queueActIdent(o.act)); }
      // a stranded occurrence the key now holds, or one marked settled, is on this phone or with the server: let go
      const inKey = new Set(frame.occs.map((o) => o.oid));
      unstrand(key, (i) => inKey.has(i) || s.marks.ids.has(i));
      if (stranded.has(key)) handed.add(key);
      return owed.map((o) => o.act);
    },
    /** Another tab wrote `key` (a storage event): it is read and reported, never written back. Once memory holds the
     *  key's scope (its load ran), a key that can no longer be read gets this tab's acts (`mine`) it does not hold copied
     *  aside beside it (Codex 4344812904), and the occurrences this tab last saw in it are held from sending (Codex
     *  4353751507). A key another tab cleared holds none of memory's acts: they are not kept until a write stores them,
     *  and what this tab saw there says nothing of what was sent (R2, Codex 4358186342) */
    heard(storage: Store, key: string, mine: OutboxOp[] = []): KeyRead | null {
      // #1122 r1: every read of a key's bytes by another tab's hand (a storage event, or Set aside's read under its
      // locks) reconciles here, so none can list a key without holding what it held (4370036882). A read that throws
      // says nothing: what is listed and held stays as it is (4370036888)
      let raw: string | null;
      try { raw = storage.getItem(key); } catch { return null; }
      const readAs = readOf(raw, scopesOf(key));
      onRead(key, readAs, raw);
      if (!loaded.has(key)) return readAs;
      const occs = occsOf(key, mine);
      if (raw === null) {
        known.delete(key);
        withheld.delete(key);
      } else if (readAs === 'ok') {
        withheld.delete(key);
        // what the key holds again is kept again: an act listed not kept that it holds is no longer counted (4370036886)
        const un = unkept.get(key);
        if (un && un.size > 0) {
          try {
            const frame = frameOf(snapshotOf(storage, key, scopesOf(key))).occs;
            const inKey = new Set(frame.map((o) => o.oid));
            const idents = new Set(frame.filter((o) => unique(o.act)).map((o) => queueActIdent(o.act)));
            for (const o of occs) if (un.has(o.oid) && (inKey.has(o.oid) || (unique(o.act) && idents.has(queueActIdent(o.act))))) un.delete(o.oid);
          } catch { /* unread: still listed, never fewer than it should be */ }
        }
        return readAs;
      } else holdSeen(key);
      refuse(storage, key, occs);
      return readAs;
    },
    /** whether `o`, an act memory holds for `key`, is held from sending (`heard`); a keyed act the store re-created is
     *  found by its identity */
    withholds(key: string, o: OutboxOp): boolean {
      const w = withheld.get(key);
      if (!w) return false;
      const oid = oids.get(o);
      if (oid !== undefined && w.has(oid)) return true;
      if (!unique(o)) return false;
      const ident = queueActIdent(o);
      return [...w].some((i) => identOf.get(i) === ident);
    },
    /** every key's memory goes (the scope moved, or the person signed out) */
    forget(): void {
      madeAside.clear();
      unkept.clear();
      asideDone.clear();
      setAsideRaw.clear();
      withheld.clear();
      loaded.clear();
      handed.clear();
      // `known` and `sent` stay, by key: a write of the scope left that runs late (it waited for its lock) still knows
      // which stored occurrences this tab held and sent, so it never keeps one as another tab's (B2f-1). A load sets them
    },
    /** whether every one of `keys` was loaded since the last `forget`: memory holds their scope's acts */
    holds(keys: string[]): boolean {
      return keys.every((k) => loaded.has(k));
    },
    /** The flush's write of the scope it no longer holds (a scope move during the flush): this flush's acts (`batch`,
     *  sent or not) leave the stored list, its unsent ones (`rest`) go first, and every other act stays. `after` (a move
     *  or drop of this release's own acts) sees only the acts `takes` accepts: an entry memory leaves out stays byte for
     *  byte (Codex 4344436672). A key this release cannot read is never written over: the unsent acts are copied aside
     *  beside it. True only once they are on this phone. When neither can be made, they are held stranded */
    keepUnsent(storage: Store | null, key: string, rest: OutboxOp[], batch: OutboxOp[], after: (l: OutboxOp[]) => OutboxOp[], takes: (o: OutboxOp) => boolean = () => true): boolean {
      let restOccs = occsOf(key, rest);
      let s: Read | null = null;
      try {
        if (!storage) throw new Error('no storage');
        s = snapshotOf(storage, key, scopesOf(key));
        if (s.acts === null && s.raw !== null) return copyUnsentAside(storage, key, rest);
        const frame = frameOf(s);
        restOccs = occsOf(key, rest, frame.occs);
        const restIds = new Set(restOccs.map((o) => o.oid));
        const batchIds = new Set(occsOf(key, batch, frame.occs).map((o) => o.oid));
        const others = frame.occs.filter((o) => !restIds.has(o.oid) && !batchIds.has(o.oid) && takes(o.act));
        for (const o of others) oids.set(o.act, o.oid);
        const moved = after(others.map((o) => o.act));
        const mine = [...restOccs, ...occsOf(key, moved, frame.occs)];
        // every stored occurrence is this tab's to place: one `after` dropped, or the batch sent, goes
        const m: Memory = { mine, known: new Set(frame.occs.map((o) => o.oid)), sent: new Set([...(sent.get(key) ?? [])]), front: restIds };
        const plan = planWrite(s, m, takes);
        if (plan === null || !apply(storage, key, plan, s.raw)) throw new Error('not written');
        landed(key, plan.next, mine, plan.raw);
        const kept = new Set(plan.next.map((o) => o.oid));
        unstrand(key, (i) => kept.has(i));
        release(storage, key, plan);
        return true;
      } catch {
        // the key, unchanged, holds what it held: an unsent occurrence it does not hold is stranded, and kept in a made
        // record when storage takes one
        const left = s ? notOnPhone(s, restOccs) : restOccs;
        strand(key, left);
        if (storage && s) keepMade(storage, key, s, left);
        return false;
      }
    },
    /** step B1a: an act of `key` the server now has (sent) or refused for good, marked so, by its occurrence, before
     *  the flush goes on: a load before the key is written without it does not take it again. False when the mark could
     *  not be made */
    settled(storage: Store | null, key: string, o: OutboxOp): boolean {
      let read: Read | null = null;
      try { if (storage) read = snapshotOf(storage, key, scopesOf(key)); } catch { read = null; }
      const frame = read ? frameOf(read).occs : [];
      const oid = oidOf(key, o, frame);
      // an identity no other act shares is one act wherever this phone keeps it: each occurrence of it the key or a made
      // record holds is marked too, so a load by any tab takes none of them again
      const ident = queueActIdent(o);
      const held = read ? [...frame, ...read.records.flatMap((r) => r.acts.map((act, n) => ({ oid: recordOid(key, r.name, n), act })))] : [];
      // (only those: a name nothing on this phone holds would leave a mark no tidy lets go)
      const there = unique(o) ? held.filter((x) => queueActIdent(x.act) === ident).map((x) => x.oid) : [];
      const ids = there.length > 0 ? there : [oid];
      for (const id of new Set([oid, ...ids])) setOf(sent, key).add(id);
      if (!storage) return false;
      return ids.every((id) => put(storage, markName(key, o, id), ident));
    },
    /** how many occurrences are held stranded, over every key */
    strandedCount(): number {
      // one this tab also lists not kept for its key is counted there, not twice
      let n = 0;
      for (const [key, occs] of stranded) n += occs.filter((o) => !unkept.get(key)?.has(o.oid)).length;
      return n;
    },
    /** Write this tab's acts (`mine`) for `key` through the ledger, and every stored entry `takes` refuses (memory left
     *  it out on purpose). False when nothing was stored: the acts it could not store are then copied aside beside the
     *  key, once each, so they stay on this phone, and are listed not kept. */
    write(storage: Store, key: string, mine: OutboxOp[], takes: (o: OutboxOp) => boolean = () => true, tidyNow = true): boolean {
      let occs = occsOf(key, mine);
      try {
        let s = snapshotOf(storage, key, scopesOf(key));
        occs = occsOf(key, mine, frameOf(s).occs);
        const readAs = readOf(s.raw, scopesOf(key));
        const copied = readAs !== 'ok' && s.raw === setAsideRaw.get(key);
        // bytes this release cannot read are never written over, unless the person's tap copied them aside: then the
        // key is written as one another tab cleared (its bytes are in their copy)
        if (readAs !== 'ok' && !copied) { report(key, readAs, s.raw); holdSeen(key, s.raw); throw new Error('unreadable queue key'); }
        const raw = s.raw;
        if (copied) s = { ...s, raw: null, acts: [], token: null, sidecar: null };
        const plan = planWrite(s, memoryOf(key, occs), takes);
        if (plan === null) throw new Error('not written');
        // a write that changes nothing writes nothing: the key holds these occurrences, in this order, as they are, under
        // this release's token (a key with none is written once, so its occurrences are named and its records can go)
        const at = frameOf(s);
        const was = at.occs;
        const same = !copied && s.raw !== null && s.token !== null && at.exact && was.length === plan.next.length
          && plan.next.every((o, n) => o.oid === was[n].oid && JSON.stringify(o.act) === JSON.stringify(was[n].act));
        if (!same && !apply(storage, key, plan, raw)) throw new Error('not written');
        report(key, 'ok', same ? raw : plan.raw);
        landed(key, plan.next, occs, same && raw !== null ? raw : plan.raw);
        // a stranded occurrence is let go once the key holds it, or once memory, since the load that handed it back,
        // no longer holds it (settled)
        const kept = new Set(plan.next.map((o) => o.oid));
        unstrand(key, (i) => kept.has(i) || handed.has(key));
        // A write of Set aside's all-or-nothing lets records and copies go only once every key's write has landed
        // (`writeAll`): until then a key may be put back (#1101 r1, Codex 4359759846)
        if (tidyNow) {
          releaseAside(storage, key, new Set());
          release(storage, key, plan);
        } else lastPlan.set(key, plan);
        return true;
      } catch {
        refuse(storage, key, occs);
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
     *  4348114913). U3 (R1): the commit point is every write landed. Until then each write is tentative: it tells the
     *  strip nothing and lets no record, mark or copy go, and what it changes in memory is undone by a rollback. A write that does not land puts each key written before it
     *  back to the bytes it held, with its sidecar, and every cell is restored as it was before the tap: what was
     *  withheld stays withheld (Codex 4360928324), and the tap's keys are no longer marked copied aside, so no later
     *  write lands over the restored bytes. Memory's acts no key then holds are listed not kept and copied aside, as a
     *  refused write's are. 'all' when every write landed, 'none' when nothing is changed, 'some' when a
     *  key could not be put back: it holds memory's acts, and its bytes are in their copy aside */
    writeAll(storage: Store, writes: QueueWrite[]): 'all' | 'none' | 'some' {
      const keys = writes.map((w) => w.key);
      const before = cells(keys);
      const done: { key: string; raw: string | null; side: string | null }[] = [];
      tentative = [];
      let told: [string, KeyRead, string | null][];
      try {
        for (const w of writes) {
          // the bytes a put-back restores are read inside the same rule: a read that throws is a write that did not land
          // (Stage 1 gap check of 3302f45, note 2)
          let landedHere = false;
          try {
            const raw = storage.getItem(w.key);
            const side = storage.getItem(sidecarName(w.key));
            if (guard.write(storage, w.key, w.mine, w.takes, false)) { done.push({ key: w.key, raw, side }); landedHere = true; }
          } catch { landedHere = false; }
          if (landedHere) continue;
          let back = true;
          for (const { key, raw: bytes, side: sideBytes } of done.reverse()) {
            try {
              if (bytes === null) storage.removeItem?.(key); else storage.setItem(key, bytes);
              if (sideBytes === null) storage.removeItem?.(sidecarName(key)); else storage.setItem(sidecarName(key), sideBytes);
              if (storage.getItem(key) !== bytes) throw new Error('not put back');
            } catch { back = false; }
          }
          restore(before);
          tentative = null;
          // then, as a refused write's, memory's acts no key holds now are listed not kept and copied aside, once each
          for (const w2 of writes) {
            // a read that throws leaves the key listed as it was (#1122 r1, 4370036888)
            let now: string | null = null;
            let read = true;
            try { now = storage.getItem(w2.key); } catch { read = false; }
            if (read) onRead(w2.key, readOf(now, scopesOf(w2.key)), now);
            try { refuse(storage, w2.key, occsOf(w2.key, w2.mine)); } catch { /* held in memory, listed by the next write */ }
          }
          return back ? 'none' : 'some';
        }
      } finally {
        told = tentative ?? [];
        tentative = null;
      }
      // every write landed: the strip hears each, and the copies, records and marks they settle go now
      for (const [key, read, raw] of told) onRead(key, read, raw);
      for (const { key } of done) {
        releaseAside(storage, key, new Set());
        const plan = lastPlan.get(key);
        lastPlan.delete(key);
        try { if (plan) release(storage, key, plan); } catch { /* kept: a record is never a loss */ }
      }
      return 'all';
    },
    copyUnsentAside,
    /** step B2f-1: a write that could not run (no cross-tab lock): the key is not written; `mine`'s occurrences it does
     *  not hold are listed not kept and copied aside beside it, once each, or held stranded and recorded when no copy
     *  can be made, as a refused write's are (#1099 r1, Codex 4358186338) */
    unwritten(storage: Store, key: string, mine: OutboxOp[]): void {
      refuse(storage, key, occsOf(key, mine));
    },
    /** how many occurrences memory holds that their key does not hold now, over every key, and those of a write still
     *  waiting for its lock that their key did not hold when it was asked; each once */
    notKeptCount(): number {
      const counted = new Map<string, Set<string>>();
      for (const [key, s] of unkept) for (const i of s) setOf(counted, key).add(i);
      for (const { key, oids: w } of waiting.values()) for (const i of w) setOf(counted, key).add(i);
      let n = 0;
      for (const s of counted.values()) n += s.size;
      return n;
    },
    /** what a reload would lose, each occurrence once by key: those listed not kept, those of a write still waiting
     *  for its lock, and those held stranded */
    unsavedCount(): number {
      const counted = new Map<string, Set<string>>();
      for (const [key, s] of unkept) for (const i of s) setOf(counted, key).add(i);
      for (const { key, oids: w } of waiting.values()) for (const i of w) setOf(counted, key).add(i);
      for (const [key, occs] of stranded) for (const o of occs) setOf(counted, key).add(o.oid);
      let n = 0;
      for (const s of counted.values()) n += s.size;
      return n;
    },
    /** step B2f-1: a locked write of `acts` to `key` is asked for: until `asked` is called with its number, its
     *  occurrences the key does not hold now are counted not kept, and kept in a made record */
    ask(storage: Store | null, key: string, acts: OutboxOp[]): number {
      let occs = occsOf(key, acts);
      asks += 1;
      let s: Read | null = null;
      try { if (storage) s = snapshotOf(storage, key, scopesOf(key)); } catch { s = null; }
      if (s) occs = occsOf(key, acts, frameOf(s).occs);
      const fresh = s ? notOnPhone(s, occs) : occs;
      waiting.set(asks, { key, oids: new Set(fresh.map((o) => o.oid)) });
      // step B1a: while it waits, its occurrences the key does not hold are kept in a made record, which needs no lock,
      // so a sign-out, a project switch or a closed page during the wait loses none; the landed write's release lets
      // it go (#1099 r2, Codex 4358855955)
      try { if (storage && s && fresh.length > 0) keepMade(storage, key, s, fresh); } catch { /* not recorded: counted while it waits */ }
      return asks;
    },
    /** the write asked as `ask` has run (or could not): its acts are counted where it left them */
    asked(ask: number): void {
      waiting.delete(ask);
    },
    /** the occurrences memory holds for `key` that the key does not hold now */
    notKept(key: string): string[] {
      return [...(unkept.get(key) ?? [])].map((oid) => identOf.get(oid) ?? oid);
    },
    /** G1 (plan r3 v4): the store re-created `from` as `to` (a queued photo given its key at load): the same occurrence */
    adopt(key: string, from: OutboxOp, to: OutboxOp): void {
      if (from !== to) oids.set(to, oidOf(key, from));
    },
    /** `acts`, read from the old unscoped queue's bytes `raw`, are adopted into this tab's key: each occurrence is named from
     *  those bytes and its place in them, so every tab that adopts the same bytes names the same occurrences, and the
     *  writes of two tabs that both adopted them store each once (Stage 1 gap check of d500f0d, gap 1) */
    adoptLegacy(raw: string, acts: OutboxOp[]): void {
      const tag = ledgerTag(raw);
      acts.forEach((o, n) => { const oid = `a:${tag}:${n}`; oids.set(o, oid); identOf.set(oid, queueActIdent(o)); });
    },
    /** the load took `dropped`, an occurrence of an identity no other act shares, as `kept`, the same act (the store's
     *  keyed photo dedupe): `dropped` is never this tab's to write, and a record holding it goes at the next landed
     *  write, whatever memory then holds (re-check N2) */
    merge(key: string, dropped: OutboxOp): void {
      setOf(merged, key).add(oidOf(key, dropped));
    },
  };
  /** per key, a Set aside write's plan, released once every key's write has landed (`writeAll`) */
  const lastPlan = new Map<string, WritePlan>();
  return guard;
}
