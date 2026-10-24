import type { OutboxOp } from '@/data/apiGateway';
import { queueActIdent } from '@/store/queueActIdent';

/**
 * WEB-02 B1 L1 (#1094, the Board's U1 re-plan after #1106 round 2): the occurrence ledger, the one place a queue key's
 * act occurrences are named and matched. Pure and synchronous: it reads a snapshot and returns what is owed, what a
 * write stores and which evidence may go; the caller does every storage read and write. No caller yet (L2 rewires the
 * queue key guard onto it).
 *
 * Why (round 2's audit): two byte-identical acts with no key (`json:` identities) can only be told apart by where they
 * are, and each source numbered them in its own frame: the key by position now, a settled mark by the flush's memory
 * order, a made record as beyond the key, a stranded act in memory only. Every round-2 finding read one frame in
 * another. Here each occurrence has one name (an occurrence id, `oid`) from the moment it is on this phone:
 * - in the key: the sidecar `vitan.occ.<key>` names each position, for the key bytes it was written with (`next`), and
 *   for the bytes before them (`prev`), so a page closed between the sidecar's write and the key's still reads exactly.
 *   `next` is written pending, then committed once the key's bytes read back; a pending side names nothing, as an
 *   earlier release may have written its bytes since, with other occurrences;
 * - in a made record: the record's name and the act's index in it (`recordOid`), so no record is reshaped;
 * - a settled mark: `vitan.settled.<key>.<tag>.o<oid>`, whose value stays the identity, as an earlier release reads it;
 * - stranded and memory: the caller keeps each act's oid beside it.
 *
 * The rules (B1 plan R1–R6):
 * - R1: nothing here changes state. A write's effects are returned for the caller to apply once the write lands.
 * - R2: an occurrence is taken by another tab only when the key is present, readable, read in an exact frame and no
 *   longer holds it. An absent key was cleared: memory's occurrences go back in.
 * - R3: occurrences are matched by oid, never by count or position; counts remain only in the fallback below.
 * - R5: `evidence` names records and marks to remove only from a snapshot read back after the write, and keeps a mark
 *   while a record it may guard is there.
 * - R6: every occurrence is owed, settled (marked or sent), or another tab's; one the ledger cannot place is owed.
 *
 * The fallback: a key with no side whose write token it carries (plan r3 v4, `frameOf`) was written by an earlier
 * release or main's guard, which leave the token out, as every key is before the ledger first writes it, or holds bytes
 * no side of that token names. Its positions get ids from its bytes and place (`f:<bytes tag>:<n>`), the same in every
 * tab that reads the same bytes, so a mark made on them holds while the bytes do; an identity found once in the last
 * side written under the key's token and once in the key keeps that side's id, unless a record there names it. An
 * occurrence whose id the bytes' change took away stays owed, and is not taken as another tab's send (R2): a repeat at
 * most, which the server refuses for every kind with no key, never a loss (plan r3 v4's residuals R-a and R-b). (An
 * earlier release that writes the same bytes back after a send and an identical new act can only make a mark hide that
 * new act, which is byte for byte the sent one: the server refuses it as a repeat.)
 */

/** an act occurrence and its name */
export type Occ = { oid: string; act: OutboxOp };
/** one sidecar side: the key bytes' tag, and each position's identity tag and oid. `pending`: written before the key,
 *  and not yet committed after the key's bytes read back, so the key may never have held them */
export type SidecarSide = { tag: string; occ: [string, string][]; pending?: true; nonce?: string };
export type Sidecar = { next: SidecarSide | null; prev: SidecarSide | null };
/** a key's marks: oids marked settled, and the identities an earlier release marked (one mark per identity) */
export type Marks = { ids: Set<string>; legacy: Set<string> };
/** what storage holds for one queue key, as the caller read it */
export type Snapshot = {
  key: string;
  /** the key's bytes; null when it is absent (cleared) */
  raw: string | null;
  /** the key's acts as this release reads them; null when it cannot read them */
  acts: OutboxOp[] | null;
  sidecar: Sidecar | null;
  marks: Marks;
  /** the key's readable made records, in made order, by their full names */
  records: { name: string; acts: OutboxOp[] }[];
  /** a record is there this release cannot read: it may guard any mark, so none goes */
  recordsUnread: boolean;
  /** B2f-2's answer (`ledgerMayWrite`, `windowGate.ts`): true only while every window the worker lists runs a release
   *  that knows the write token. The ledger writes and releases only then; it never decides whether the key's names
   *  hold (the token does), as the worker cannot list a frozen, discarded or bfcached page */
  fence?: boolean;
  /** the write token the key's bytes carry (`tokenOf`), or null: the nonce of the ledger write that wrote them */
  token?: string | null;
};

/** plan r3 v4: the write token, the key's first entry, in the same `setItem` as its acts. Its nonce is new for each
 *  write, so only the write whose side carries that nonce can have put it there. An earlier release never carries it
 *  on: one before step A1 replays it first as an act of no kind it knows (no request; taken as sent) and leaves it
 *  out of every write after a send, and one from step A1 on cannot read the key and never writes it */
export const TOKEN_KIND = 'vitan.writeToken';
/** a key's entries split: the token (the first entry, when it is one) and the acts after it */
export function tokenOf(entries: unknown[]): { token: string | null; rest: unknown[] } {
  const first = entries[0] as { t?: unknown; n?: unknown } | undefined;
  if (first && typeof first === 'object' && first.t === TOKEN_KIND && typeof first.n === 'string' && first.n !== '') return { token: first.n, rest: entries.slice(1) };
  return { token: null, rest: entries };
}
const newNonce = (): string => Array.from(globalThis.crypto.getRandomValues(new Uint32Array(4)), (n) => n.toString(16).padStart(8, '0')).join('');

/** a name for `text`: its length and two 32-bit FNV-1a hashes. The same as `queueActRecord`'s, so a mark's tag is the
 *  one an earlier release wrote (pinned by a test) */
export function ledgerTag(text: string): string {
  let a = 0x811c9dc5;
  let b = 0x01000193;
  for (let i = 0; i < text.length; i += 1) {
    const c = text.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193);
    b = Math.imul(b ^ c, 0x811c9dc5);
  }
  return `${text.length}-${(a >>> 0).toString(36)}${(b >>> 0).toString(36)}`;
}

const identTag = (o: OutboxOp): string => ledgerTag(queueActIdent(o));
/** an identity no other act shares: an idempotency key, or a photo's client key */
const unique = (o: OutboxOp): boolean => !queueActIdent(o).startsWith('json:');

export const sidecarName = (key: string): string => `vitan.occ.${key}`;
export const markName = (key: string, act: OutboxOp, oid: string): string => `vitan.settled.${key}.${identTag(act)}.o${oid}`;
/** the oid of the `n`-th act of the made record `name` */
export const recordOid = (key: string, name: string, n: number): string => `r:${name.slice(`vitan.made.${key}.`.length)}#${n}`;
/** A new made record's name: after every record the key has (`names`), and never a name a record had before, so its
 *  occurrences' oids are new too (`nonce`: unique to this record, such as an idempotency key). An earlier release reads
 *  it as its own: it orders records by the first part and reads every name under the key's prefix */
export const recordName = (key: string, names: string[], raw: string, nonce: string): string => {
  const prefix = `vitan.made.${key}.`;
  const order = Math.max(0, ...names.map((n) => Number(n.slice(prefix.length).split('.')[0])).filter(Number.isSafeInteger)) + 1;
  return `${prefix}${order}.${nonce}.${ledgerTag(raw)}`;
};

/** a mark's name read: an oid mark, a mark an earlier release wrote (the identity's tag alone), or none of `key`'s */
export function readMarkName(key: string, name: string): { oid: string } | { legacy: true } | null {
  const prefix = `vitan.settled.${key}.`;
  if (!name.startsWith(prefix)) return null;
  const rest = name.slice(prefix.length);
  const dot = rest.indexOf('.');
  if (dot < 0) return { legacy: true };
  return rest[dot + 1] === 'o' && dot + 2 < rest.length ? { oid: rest.slice(dot + 2) } : null;
}

export function encodeSidecar(s: Sidecar): string {
  return JSON.stringify(s);
}
const isSide = (v: unknown): v is SidecarSide => {
  if (v === null || typeof v !== 'object') return false;
  const s = v as { tag?: unknown; occ?: unknown; pending?: unknown };
  if (typeof s.tag !== 'string' || !Array.isArray(s.occ) || (s.pending !== undefined && s.pending !== true)) return false;
  if ((v as { nonce?: unknown }).nonce !== undefined && typeof (v as { nonce?: unknown }).nonce !== 'string') return false;
  // each position its own non-empty oid (#1109 r1, Codex 4365534639): a side naming two positions alike is damaged
  const oids = new Set<string>();
  return s.occ.every((p) => Array.isArray(p) && p.length === 2 && typeof p[0] === 'string' && typeof p[1] === 'string' && p[1] !== '' && !oids.has(p[1]) && Boolean(oids.add(p[1])));
};
/** a sidecar's bytes read; anything else (absent, damaged, a newer shape, a side naming two positions alike) is none,
 *  which reads the key as the fallback */
export function decodeSidecar(raw: string | null): Sidecar | null {
  if (raw === null) return null;
  try {
    const v = JSON.parse(raw) as { next?: unknown; prev?: unknown };
    if (v === null || typeof v !== 'object') return null;
    const next = v.next === null ? null : isSide(v.next) ? v.next : undefined;
    const prev = v.prev === null ? null : isSide(v.prev) ? v.prev : undefined;
    return next === undefined || prev === undefined ? null : { next, prev };
  } catch {
    return null;
  }
}

/** each made record's occurrences, named */
const recordOccs = (s: Snapshot): Occ[] => s.records.flatMap((r) => r.acts.map((act, n) => ({ oid: recordOid(s.key, r.name, n), act })));

/** the key's occurrences, each named; `exact` when a sidecar side names these bytes; `side` names them as read */
export type Frame = { occs: Occ[]; exact: boolean; side: SidecarSide | null };

export function frameOf(s: Snapshot): Frame {
  const acts = s.acts ?? [];
  if (s.raw === null) return { occs: [], exact: true, side: null };
  const tag = ledgerTag(s.raw);
  const tags = acts.map(identTag);
  // a pending side never names the key: the page may have closed before the key's write, and an earlier release may
  // since have written the same bytes with other occurrences (#1109 r1 re-check of 4365534649)
  // plan r3 v4: a side names the key only when the key carries its write's token. Only that write put the token there,
  // and every other writer drops it, so its bytes are that write's occurrences, pending or committed
  const under = (side: SidecarSide | null | undefined): side is SidecarSide => Boolean(side) && s.token != null && side!.nonce === s.token;
  const committed = [s.sidecar?.next, s.sidecar?.prev].filter(under);
  for (const side of committed) {
    if (side.tag === tag && side.occ.length === acts.length && side.occ.every(([t], n) => t === tags[n])) {
      return { occs: acts.map((act, n) => ({ oid: side.occ[n][1], act })), exact: true, side };
    }
  }
  // fallback: ids from the bytes, but an identity once in the last side written (pending or not) and once here keeps its
  // id, unless a record there names it (then the key's act may be another occurrence, and the record's stays owed)
  const base = [s.sidecar?.next, s.sidecar?.prev].find(under) ?? null;
  const recorded = new Set(recordOccs(s).map((o) => o.oid));
  const count = (list: string[], t: string) => list.reduce((n, x) => n + (x === t ? 1 : 0), 0);
  const baseTags = base ? base.occ.map(([t]) => t) : [];
  const occs = acts.map((act, n) => {
    const kept = base && count(baseTags, tags[n]) === 1 && count(tags, tags[n]) === 1 && !recorded.has(base.occ[baseTags.indexOf(tags[n])][1]);
    return { oid: kept ? base.occ[baseTags.indexOf(tags[n])][1] : `f:${tag}:${n}`, act };
  });
  return { occs, exact: false, side: { tag, occ: occs.map((o, n) => [tags[n], o.oid]) } };
}

/** the occurrences of the key and its records an earlier release's one-per-identity mark settles: the only one of a
 *  shared identity, or every one of a unique identity. Two or more shared ones: none (it cannot say which) */
function legacySettled(s: Snapshot, all: Occ[]): Set<string> {
  const out = new Set<string>();
  for (const ident of s.marks.legacy) {
    const of = all.filter((o) => queueActIdent(o.act) === ident);
    // a shared identity a record this release cannot read may also hold: which occurrence the mark settled is unknown
    if (of.length > 0 && !unique(of[0].act) && s.recordsUnread) continue;
    if (of.length === 1 || (of.length > 1 && unique(of[0].act))) for (const o of of) out.add(o.oid);
  }
  return out;
}


/** the occurrences an earlier release's marks settle, over the key and its records' beyond it */
function settledByEarlier(s: Snapshot, frame: Frame): Set<string> {
  const inKey = new Set(frame.occs.map((o) => o.oid));
  return legacySettled(s, [...frame.occs, ...recordOccs(s).filter((o) => !inKey.has(o.oid))]);
}

/** A load: what this key owes, in order: the stranded occurrences memory holds (`stranded`, first, as the scope-move
 *  write puts its unsent ones first), then the key's, then its records' beyond the key. A settled occurrence is not
 *  owed. `frame` is the key as read, for the caller to keep each act's oid with it */
export function owedOf(s: Snapshot, stranded: Occ[] = []): { owed: Occ[]; frame: Frame } {
  const frame = frameOf(s);
  const inKey = new Set(frame.occs.map((o) => o.oid));
  const records = recordOccs(s).filter((o) => !inKey.has(o.oid));
  const legacy = settledByEarlier(s, frame);
  const fromKey = frame.occs.filter((o) => !legacy.has(o.oid) && !s.marks.ids.has(o.oid));
  const held = stranded.filter((o) => !inKey.has(o.oid) && !s.marks.ids.has(o.oid) && !legacy.has(o.oid));
  const heldIds = new Set(held.map((o) => o.oid));
  const fromRecords = records.filter((o) => !heldIds.has(o.oid) && !s.marks.ids.has(o.oid) && !legacy.has(o.oid));
  return { owed: [...held, ...fromKey, ...fromRecords], frame };
}

/** memory's occurrences the key does not hold, in memory order, and not settled (sent here, or marked) or taken by
 *  another tab (R2: one this tab read in the key that a present key, read exactly, no longer holds): those memory holds
 *  ahead of every one the key holds (`head`: stranded ones) and the rest (`tail`: records' and new ones). `front`
 *  occurrences are always head, wherever the key holds them */
function beyondKey(s: Snapshot, frame: Frame, m: Memory): { head: Occ[]; tail: Occ[] } {
  const inKey = new Set(frame.occs.map((o) => o.oid));
  // an occurrence an earlier release's mark settles is settled here too, wherever memory holds it (#1109 r1, Codex
  // 4365534635: one loaded from a record was written back into the key)
  const legacy = settledByEarlier(s, frame);
  const front = m.front ?? new Set<string>();
  const taken = (o: Occ) => s.raw !== null && frame.exact && m.known.has(o.oid) && !front.has(o.oid);
  const firstInKey = m.mine.findIndex((o) => inKey.has(o.oid));
  const head: Occ[] = [];
  const tail: Occ[] = [];
  m.mine.forEach((o, n) => {
    if (inKey.has(o.oid) && !front.has(o.oid)) return;
    if (m.sent.has(o.oid) || s.marks.ids.has(o.oid) || legacy.has(o.oid) || taken(o)) return;
    (front.has(o.oid) || firstInKey < 0 || n < firstInKey ? head : tail).push(o);
  });
  return { head, tail };
}

/** A refused write: memory's occurrences the key, unchanged, does not hold, no record there holds, and that are neither
 *  settled nor taken by another tab, in memory order: the ones to keep in a new made record and hold stranded */
export function unkeptOf(s: Snapshot, m: Memory): Occ[] {
  const frame = frameOf(s);
  const { head, tail } = beyondKey(s, frame, m);
  // one the key or a record still there holds is on this phone (a `front` one the key holds is head, for the write to
  // move); one whose record went (its key held it) is not (#1109 r1, Codex 4365534650: the `r:` id outlives its record)
  const onPhone = new Set([...frame.occs, ...recordOccs(s)].map((o) => o.oid));
  return [...head, ...tail].filter((o) => !onPhone.has(o.oid));
}

/** what this tab's memory holds for the key: its occurrences in order (`mine`), the oids it read in the key at its last
 *  load or landed write (`known`), the ones it marked settled since (`sent`; a flush keeps them in memory until its
 *  end), and the ones to put first (`front`: the scope-move write's unsent ones) */
export type Memory = { mine: Occ[]; known: Set<string>; sent: Set<string>; front?: Set<string> };
/** a write's plan: the key's next occurrences (`raw`: the exact bytes to write), the sidecar to write first (its `next`
 *  side pending), the sidecar to write once the key's bytes read back (`commit`: the same, committed), the earlier
 *  release's marks this write settles for good, and the occurrences this tab sent (`sent`: a record holding one goes
 *  with the write, even when its mark could not be made). When `raw` is the key's bytes now, the key is not written
 *  again: the committed sidecar names them anew (a stranded act in the place of an identical sent one). The write has
 *  landed once the committed sidecar reads back; until then the key reads by `prev` or as the fallback */
export type WritePlan = { next: Occ[]; raw: string; sidecar: Sidecar; commit: Sidecar; legacySpent: string[]; sent: string[] };

/** A write of memory into the key as it holds it now. Null when this release cannot read the key: it is never written
 *  over. In stored order: an entry memory does not take (`takes`) stays byte for byte; a settled one goes; one memory
 *  holds is memory's version; one this tab held and no longer does goes (it settled it); another tab's stays. Memory's
 *  occurrences the key does not hold come before the stored ones when memory holds them ahead of every stored one
 *  (stranded first), else after (made records, new acts), unless settled, or taken by another tab (R2) */
export function planWrite(s: Snapshot, m: Memory, takes: (o: OutboxOp) => boolean = () => true, nonce: string = newNonce()): WritePlan | null {
  if (s.acts === null && s.raw !== null) return null;
  // an unfenced key is never written through the ledger: an earlier release may write it at any moment (plan r3)
  if (s.fence !== true) return null;
  const frame = frameOf(s);
  const mine = new Map(m.mine.map((o) => [o.oid, o]));
  const legacy = settledByEarlier(s, frame);
  const settled = (o: Occ) => m.sent.has(o.oid) || legacy.has(o.oid) || s.marks.ids.has(o.oid);
  const front = m.front ?? new Set<string>();
  const stored: Occ[] = [];
  for (const o of frame.occs) {
    if (!takes(o.act)) { stored.push(o); continue; }
    if (settled(o) || front.has(o.oid)) continue;
    const held = mine.get(o.oid);
    if (held) { stored.push(held); continue; }
    if (m.known.has(o.oid)) continue; // this tab held it and no longer does: settled here
    stored.push(o); // another tab's
  }
  const { head, tail } = beyondKey(s, frame, m);
  const lead = [...head.filter((o) => front.has(o.oid)), ...head.filter((o) => !front.has(o.oid))];
  const next = [...lead, ...stored, ...tail];
  const raw = JSON.stringify([{ t: TOKEN_KIND, n: nonce }, ...next.map((o) => o.act)]);
  const prev = s.raw === null ? null : frame.side;
  const legacySpent = [...s.marks.legacy].filter((i) => !frame.occs.some((o) => !takes(o.act) && queueActIdent(o.act) === i));
  const side: SidecarSide = { tag: ledgerTag(raw), occ: next.map((o) => [identTag(o.act), o.oid]), nonce };
  return { next, raw, sidecar: { next: { ...side, pending: true }, prev }, commit: { next: side, prev }, legacySpent, sent: [...m.sent] };
}

/** The evidence a snapshot read back after a landed write shows is no longer needed (R5): records whose every
 *  occurrence the key holds or is settled (marked, or sent by the write's tab), then marks whose occurrence neither the
 *  key nor a record still there holds, and the earlier release's marks the write settled for good (from its plan)
 *  that no record still there holds an act of. Run it again after the records are removed and read back: a mark a
 *  record there may guard stays until then. Nothing goes while the key is not read exactly (another release wrote
 *  it), and no mark while a record is unreadable */
export function evidenceOf(s: Snapshot, plan: Pick<WritePlan, 'legacySpent' | 'sent'> = { legacySpent: [], sent: [] }): { records: string[]; marks: string[]; legacy: string[] } {
  const frame = frameOf(s);
  // unfenced, nothing goes: the ledger wrote nothing there, and an earlier release may write the key at any moment
  if (s.acts === null || s.fence !== true || !frame.exact) return { records: [], marks: [], legacy: [] };
  const inKey = new Set(frame.occs.map((o) => o.oid));
  const occs = recordOccs(s);
  const legacy = settledByEarlier(s, frame);
  // sent by the write's tab: settled, whether or not its mark could be made (#1109 r1, Codex 4365534644)
  const sent = new Set(plan.sent);
  const done = (oid: string) => inKey.has(oid) || s.marks.ids.has(oid) || legacy.has(oid) || sent.has(oid);
  const records = s.records.filter((r) => r.acts.every((_, n) => done(recordOid(s.key, r.name, n)))).map((r) => r.name);
  if (s.recordsUnread) return { records, marks: [], legacy: [] };
  const guarded = new Set(occs.map((o) => o.oid));
  const heldIdents = new Set(occs.map((o) => queueActIdent(o.act)));
  return {
    records,
    marks: [...s.marks.ids].filter((oid) => !inKey.has(oid) && !guarded.has(oid)),
    legacy: plan.legacySpent.filter((i) => s.marks.legacy.has(i) && !heldIdents.has(i)),
  };
}
