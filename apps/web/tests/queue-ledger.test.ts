import { describe, it, expect } from 'vitest';
import type { OutboxOp } from '@/data/apiGateway';
import { readStoredQueue } from '@/data/storedActs';
import { queueActIdent } from '@/store/queueActIdent';
import { queueActIdent as guardIdent } from '@/store/queueKeyGuard';
import { madeActs, markSettled, releaseMade, settledIdents } from '@/store/queueActRecord';
import {
  decodeSidecar, encodeSidecar, evidenceOf, ledgerTag, markName, owedOf, planWrite, readMarkName, recordName, recordOid, sidecarName, unkeptOf,
  type Occ, type Snapshot, type WritePlan,
} from '@/store/queueLedger';
import * as ledger from '@/store/queueLedger';

/**
 * WEB-02 B1 L1: the occurrence ledger, driven by a small writer over one phone's storage (what L2 wires into the queue
 * key guard), checked against the one right answer kept apart from it.
 *
 * The right answer follows each occurrence by a serial of its own, never by its bytes: which serials are unsent, which
 * the key holds in order, which a record holds. A fresh page owes the key's unsent serials in order, then the records'
 * the key lacks. A write stores memory's unsent serials the key lacks that memory holds ahead of every one the key holds
 * (stranded), then the key's unsent serials in its order, then memory's other unsent ones (records, new acts).
 *
 * The matrix: every key of 0 to 4 acts (each `U`, an unkeyed act, or a unique keyed act), 0 to 2 stranded `U`, 0 to 2
 * made records of a `U`, each partial flush counted in memory's order with its marks made or failing, another tab's
 * act (none, an append of `U` or of a keyed act, a send with its mark, a send and its write, a clear), a new `U` here
 * or none, the scope-move write's front or none, and this tab's write stopped at each of its steps: it lands; the
 * sidecar write fails; the page closes after the sidecar, after the key, or after the records went; the key write fails,
 * and then its sidecar is not put back, it closes before its record, or its record cannot be made. A landed write is
 * followed by another tab's clear and a refused restore.
 */

const K = 'vitan.outbox.dev:u-pmc.p-1';
/** a new record's bytes (`recordBytes`); the earlier heads these probes also run at (#1109's, 7f96531) have none, and
 *  their records are the acts alone */
const recordBytes = (acts: OutboxOp[], nonce: string): string => ledger.recordBytes?.(acts, nonce) ?? JSON.stringify(acts);
/** the ledger's fence: B2f-2's answer (plan r3 v4), no while a tab of an earlier release is listed; the matrix runs
 *  under yes */
let fenceNow = true;
const U = { t: 'submitInspection', inspectionId: 'i-1', items: [] } as unknown as OutboxOp;
const keyed = (k: string): OutboxOp => ({ t: 'approve', decisionId: 'd-1', optionIndex: 0, idempotencyKey: k });
/** a photo an earlier release queued with no client key: its identity is its bytes */
const keylessPhoto = { t: 'uploadMedia', input: { kind: 'progress', mime: 'image/jpeg', data: 'AAAA', takenAt: '2026-10-14T05:00:00.000Z' } } as unknown as OutboxOp;

/** one phone's storage; a name in `fail` refuses its write */
class Phone {
  items = new Map<string, string>();
  fail = new Set<string>();
  /** names whose removal does not happen */
  stuck = new Set<string>();
  get length() { return this.items.size; }
  key(i: number) { return [...this.items.keys()][i] ?? null; }
  getItem(n: string) { return this.items.get(n) ?? null; }
  setItem(n: string, v: string) { if ([...this.fail].some((f) => n.startsWith(f))) throw new DOMException('full', 'QuotaExceededError'); this.items.set(n, String(v)); }
  removeItem(n: string) { if (![...this.stuck].some((f) => n.startsWith(f))) this.items.delete(n); }
  names(prefix: string) { return [...this.items.keys()].filter((n) => n.startsWith(prefix)); }
}

/** L2's reader (plan r3 v4), here so these probes also run at #1109's heads: a first entry `{ t: TOKEN_KIND, n }` is
 *  the key's write token, never an act (`queue-ledger-token.test.ts` pins the ledger's `tokenOf` to it) */
const TOKEN_KIND = 'vitan.writeToken';
const tokenOf = (e: unknown[]): { token: string | null; rest: unknown[] } => {
  const f = e[0] as { t?: unknown; n?: unknown } | undefined;
  return f?.t === TOKEN_KIND && typeof f.n === 'string' && f.n !== '' ? { token: f.n, rest: e.slice(1) } : { token: null, rest: e };
};
/** a key's acts, without its write token */
const actsIn = (raw: string | null): OutboxOp[] => (raw === null ? [] : (tokenOf(JSON.parse(raw) as unknown[]).rest as OutboxOp[]));

function snapshot(p: Phone): Snapshot {
  const raw = p.getItem(K);
  // L2's reader: the token is the key's first entry, and never an act
  const parsed = raw === null ? null : (JSON.parse(raw) as unknown);
  const split = Array.isArray(parsed) ? tokenOf(parsed) : { token: null, rest: null };
  const read = readStoredQueue(raw === null ? null : split.rest ? JSON.stringify(split.rest) : raw);
  const ids = new Set<string>();
  const legacy = new Set<string>();
  for (const n of p.names(`vitan.settled.${K}.`)) {
    const m = readMarkName(K, n);
    if (m && 'oid' in m) ids.add(m.oid); else if (m) legacy.add(p.getItem(n)!);
  }
  const order = (n: string) => Number(n.slice(`vitan.made.${K}.`.length).split('.')[0]);
  const records = p.names(`vitan.made.${K}.`).sort((a, b) => order(a) - order(b)).map((name) => ({ name, acts: actsIn(p.getItem(name)) }));
  return { key: K, raw, acts: 'acts' in read ? read.acts : null, sidecar: decodeSidecar(p.getItem(sidecarName(K))), marks: { ids, legacy }, records, recordsUnread: false, fence: fenceNow, token: split.token };
}

/** the truth: each occurrence's serial, and which are sent */
class World {
  phone = new Phone();
  serial = 0;
  sent = new Set<string>();
  /** sent, but the mark could not be made: only the sending tab knows */
  unmarked = new Set<string>();
  /** the serials the key holds in order, and each record's */
  key: string[] = [];
  records = new Map<string, string[]>();
  alias = new Map<string, string>();
  of = (oid: string) => this.alias.get(oid) ?? oid;
  /** each serial's act */
  acts = new Map<string, OutboxOp>();
  fresh(act: OutboxOp): Occ { this.serial += 1; this.acts.set(`s${this.serial}`, act); return { oid: `s${this.serial}`, act: { ...act } }; }
  /** what a page opened now owes, by the truth */
  owed(): string[] {
    const inKey = new Set(this.key);
    return [...this.key, ...[...this.records.values()].flat().filter((s) => !inKey.has(s))].filter((s) => !this.sent.has(s));
  }
  /** a key and sidecar this release wrote */
  seed(occs: Occ[], sidecar = true) {
    // with its sidecar, a key this release wrote, so it carries that write's token; without, an earlier release's
    const raw = JSON.stringify([...(sidecar ? [{ t: TOKEN_KIND, n: 'seed' }] : []), ...occs.map((o) => o.act)]);
    this.phone.setItem(K, raw);
    if (sidecar) this.phone.setItem(sidecarName(K), encodeSidecar({ next: { tag: ledgerTag(raw), occ: occs.map((o) => [ledgerTag(queueActIdent(o.act)), o.oid]), nonce: 'seed' }, prev: null }));
    this.key = occs.map((o) => o.oid);
  }
  /** a made record of `occs`, always a record of its own (`recordName`): two records of the same bytes are two, and a
   *  name is never used twice (main's writer takes the same bytes for one record, which L2 changes); their oids become
   *  the record's */
  record(occs: Occ[]): boolean {
    this.serial += 1;
    const raw = recordBytes(occs.map((o) => o.act), `m${this.serial}`);
    const name = recordName(K, this.phone.names(`vitan.made.${K}.`), raw, `m${this.serial}`);
    try { this.phone.setItem(name, raw); } catch { return false; }
    occs.forEach((o, n) => { const was = this.of(o.oid); o.oid = recordOid(K, name, n); this.alias.set(o.oid, was); });
    this.records.set(name, occs.map((o) => this.of(o.oid)));
    return true;
  }
}

/** `front`: the scope-move write's unsent acts, put first (until that write lands) */
type Tab = { mem: Occ[]; known: Set<string>; sent: Set<string>; stranded: Occ[]; loadedKey: string[]; front?: Set<string> };
const tab = (): Tab => ({ mem: [], known: new Set(), sent: new Set(), stranded: [], loadedKey: [] });

function load(w: World, t: Tab) {
  const { owed, frame } = owedOf(snapshot(w.phone), t.stranded);
  t.mem = owed.map((o) => ({ ...o }));
  t.known = new Set(frame.occs.map((o) => o.oid));
  t.sent = new Set();
  t.loadedKey = [...w.key];
}
/** the flush settles `o`: marked (unless the mark cannot be made: `marks` false), and known sent here */
function settle(w: World, t: Tab, o: Occ, marks = true) {
  if (marks) w.phone.setItem(markName(K, o.act, o.oid), queueActIdent(o.act)); else w.unmarked.add(w.of(o.oid));
  t.sent.add(o.oid);
  w.sent.add(w.of(o.oid));
  // a stranded act settled is held no more
  t.stranded = t.stranded.filter((x) => w.of(x.oid) !== w.of(o.oid));
}

/** the one right answer for `t`'s write now, by the truth */
function rightWrite(w: World, t: Tab): string[] {
  // what `t` can know is sent: marked, or sent by `t` itself (another tab's send whose mark failed it cannot know)
  const here = new Set([...t.sent].map(w.of));
  const gone = (s: string) => w.sent.has(s) && (!w.unmarked.has(s) || here.has(s));
  // memory's place for each act counts the sent ones too: a new act after a sent one the key holds goes after the key's
  const all = t.mem.map((o) => w.of(o.oid));
  if (w.phone.getItem(K) === null) return all.filter((s) => !gone(s));
  // the scope-move write's unsent acts go first, in memory order, wherever the key holds them
  const front = new Set([...(t.front ?? [])].map(w.of));
  const inKey = new Set(w.key);
  const first = all.findIndex((s) => inKey.has(s));
  const out = all.filter((s) => front.has(s) && !gone(s));
  out.push(...all.filter((s, n) => !front.has(s) && !gone(s) && !inKey.has(s) && (first < 0 || n < first)));
  out.push(...w.key.filter((s) => !front.has(s) && !gone(s)));
  out.push(...all.filter((s, n) => !front.has(s) && !gone(s) && !inKey.has(s) && first >= 0 && n > first));
  return out;
}

/** the matrix case running, for messages */
let current = '';
type Mode =
  | 'lands' | 'key fails' | 'sidecar fails' | 'closes between' | 'closes before the commit' | 'the commit fails'
  | 'closes after the commit' | 'closes after records'
  // the refused write's own steps: its sidecar is not put back, it closes before its record, its record cannot be made
  | 'key fails, the sidecar stays' | 'key fails, closes before the record' | 'key fails, the record fails';
/** the last write's plan, for the rows that follow it */
let lastPlan: WritePlan | null = null;

/** `t`'s write, as L2 does it: the sidecar with its `next` side pending, then the key (not written again when its bytes
 *  are the same), then the sidecar committed, each read back; then the evidence, records first, then marks. A write
 *  whose key does not land puts the sidecar back as it was, and keeps memory's occurrences the key lacks and no record
 *  holds in a new made record, held stranded too. A commit that cannot be written is a write that did not land: the
 *  same, against the key as it now reads (by `prev` when its bytes are the same, else as the fallback). The `closes`
 *  modes stop there: the page is gone, with its memory */
function write(w: World, t: Tab, mode: Mode = 'lands'): 'landed' | 'refused' | 'closed' {
  const s = snapshot(w.phone);
  const mem = { mine: t.mem, known: t.known, sent: t.sent, front: t.front };
  const plan = planWrite(s, mem);
  if (!plan) throw new Error('unreadable');
  lastPlan = plan;
  const want = rightWrite(w, t);
  expect(plan.next.map((o) => w.of(o.oid)), `${current}: the write stores the right occurrences in order`).toEqual(want);
  const sidecarWas = w.phone.getItem(sidecarName(K));
  const refuse = (now: Snapshot = s): 'refused' | 'closed' => {
    // the sidecar is put back, so no side names bytes the key never held (best effort: a side that does not match the
    // key's bytes is never read)
    if (mode !== 'key fails, the sidecar stays') try { if (sidecarWas === null) w.phone.removeItem(sidecarName(K)); else w.phone.setItem(sidecarName(K), sidecarWas); } catch { /* kept */ }
    if (mode === 'key fails, closes before the record') return 'closed';
    const left = unkeptOf(now, mem);
    const was = new Set(left.map((o) => w.of(o.oid)));
    if (mode === 'key fails, the record fails') w.phone.fail.add(`vitan.made.${K}.`);
    // recorded, they are also held stranded, under the record's ids, so a scope move or sign-out keeps them
    const kept = left.length > 0 && w.record(left);
    w.phone.fail.clear();
    if (kept) t.stranded = [...t.stranded.filter((o) => !was.has(w.of(o.oid))), ...left.map((o) => ({ ...o }))];
    return 'refused';
  };
  if (mode === 'sidecar fails') { w.phone.fail.add(sidecarName(K)); try { w.phone.setItem(sidecarName(K), encodeSidecar(plan.sidecar)); } catch { w.phone.fail.clear(); return refuse(); } }
  w.phone.setItem(sidecarName(K), encodeSidecar(plan.sidecar));
  // the same bytes are not written again: the sidecar alone names them anew, and the write has landed with it
  const same = plan.raw === s.raw;
  if (mode === 'closes between') return 'closed';
  if (mode.startsWith('key fails') && !same) return refuse();
  // the key's new bytes hold the plan's occurrences once written; the same bytes are renamed only by the commit
  if (!same) { w.phone.setItem(K, plan.raw); w.key = want; }
  expect(w.phone.getItem(K)).toBe(plan.raw);
  if (mode === 'closes before the commit') return 'closed';
  if (mode === 'the commit fails') {
    // the write has not landed: as a refused write, against the key as it now reads (by `prev`, or as the fallback)
    w.phone.fail.add(sidecarName(K));
    try { w.phone.setItem(sidecarName(K), encodeSidecar(plan.commit)); } catch { /* the commit is not written */ }
    return refuse(snapshot(w.phone));
  }
  w.phone.setItem(sidecarName(K), encodeSidecar(plan.commit));
  if (same) w.key = want;
  if (mode === 'closes after the commit') return 'closed';
  const first = evidenceOf(snapshot(w.phone), Object.assign([...plan.legacySpent], plan));
  release(w.phone, first.records, (n) => w.records.delete(n));
  if (mode === 'closes after records') return 'closed';
  const then = evidenceOf(snapshot(w.phone), Object.assign([...plan.legacySpent], plan));
  for (const n of w.phone.names(`vitan.settled.${K}.`)) {
    const m = readMarkName(K, n);
    if ((m && 'oid' in m && then.marks.includes(m.oid)) || (m && 'legacy' in m && then.legacy.includes(w.phone.getItem(n)!))) w.phone.removeItem(n);
  }
  t.mem = plan.next;
  t.known = new Set(plan.next.map((o) => o.oid));
  t.sent = new Set();
  t.front = undefined;
  t.stranded = t.stranded.filter((o) => !t.known.has(o.oid));
  t.loadedKey = [...w.key];
  return 'landed';
}

/** a plan written as L2 writes it, with no right-answer check (the fallback rows check their own) */
function land(w: World, plan: Pick<WritePlan, 'raw' | 'sidecar' | 'commit'>) {
  w.phone.setItem(sidecarName(K), encodeSidecar(plan.sidecar));
  w.phone.setItem(K, plan.raw);
  w.phone.setItem(sidecarName(K), encodeSidecar(plan.commit));
}

/** plan r3 v4: L2's record release. The records go, then the key's token is read again: when another writer
 *  changed the key in between, every record removed is put back as it was, so nothing a record held is lost */
function release(p: Phone, names: string[], gone: (n: string) => void = () => {}) {
  const tokenBefore = snapshot(p).token;
  const kept = names.map((n) => [n, p.getItem(n)] as const);
  for (const [n] of kept) p.removeItem(n);
  if (snapshot(p).token !== tokenBefore || tokenBefore == null && p.getItem(K) !== null) { for (const [n, v] of kept) if (v !== null) p.setItem(n, v); return; }
  for (const [n] of kept) if (p.getItem(n) === null) gone(n);
}

const freshOwed = (w: World) => owedOf(snapshot(w.phone)).owed.map((o) => w.of(o.oid));

const idents = (acts: OutboxOp[]) => acts.map(queueActIdent).sort();
const contains = (big: string[], small: string[]) => [...new Set(small)].every((i) => big.filter((x) => x === i).length >= small.filter((x) => x === i).length);

/** plan r3: what an earlier release, or main's guard path, may do to a key the ledger does not fence: its bytes only,
 *  from memory, with no sidecar */
type Earlier = 'appends U' | 'sends its last act and appends the same bytes' | 'sends its first act with its mark' | 'clears';
const EARLIER: Earlier[] = ['appends U', 'sends its last act and appends the same bytes', 'sends its first act with its mark', 'clears'];
function earlier(w: World, op: Earlier) {
  const raw = w.phone.getItem(K);
  // a tab before step A1 that loaded the key holds its token as an act (step A1 on cannot read it, so never writes):
  // offline, an append carries it on; any send starts its flush at the front, where the token is taken as sent
  // with no request, so every write after a send leaves it out
  const entries = raw === null ? [] : (JSON.parse(raw) as OutboxOp[]);
  const acts = actsIn(raw);
  if (raw === null) w.key = [];
  if (op === 'clears') { w.phone.removeItem(K); w.key = []; return; }
  if (op === 'appends U') { w.key.push(w.fresh(U).oid); w.phone.setItem(K, JSON.stringify([...entries, U])); return; }
  if (acts.length === 0) return;
  const at = op === 'sends its first act with its mark' ? 0 : acts.length - 1;
  const act = acts[at];
  // a keyed act made again is the same act: only an act with no key can come back as the same bytes
  if (op !== 'sends its first act with its mark' && JSON.stringify(act) !== JSON.stringify(U)) return;
  w.sent.add(w.key[at]);
  markSettled(w.phone, K, queueActIdent(act));
  if (op === 'sends its first act with its mark') { w.key.splice(0, 1); w.phone.setItem(K, JSON.stringify(acts.slice(1))); return; }
  // the same bytes, its own new occurrence in place of the sent one
  w.key[at] = w.fresh(act).oid;
  w.phone.setItem(K, JSON.stringify(acts));
}

/** a page of this release loads the key and writes it as L2 does (sidecar pending, key, commit, then the evidence in
 *  two passes); returns the key's bytes and what a page opened after owes */
function loadAndLand(w: World): { raw: string | null; owed: string[]; records: number } {
  const s = snapshot(w.phone);
  const { owed, frame } = owedOf(s);
  const plan = planWrite(s, { mine: owed, known: new Set(frame.occs.map((o) => o.oid)), sent: new Set() });
  if (plan) {
    land(w, plan);
    const pass = () => evidenceOf(snapshot(w.phone), Object.assign([...plan.legacySpent], plan));
    release(w.phone, pass().records);
    const then = pass();
    for (const n of w.phone.names(`vitan.settled.${K}.`)) {
      const m = readMarkName(K, n);
      if ((m && 'oid' in m && then.marks.includes(m.oid)) || (m && 'legacy' in m && then.legacy.includes(w.phone.getItem(n)!))) w.phone.removeItem(n);
    }
  }
  // the key's acts (its token is new at every write)
  return { raw: w.phone.getItem(K) === null ? null : JSON.stringify(actsIn(w.phone.getItem(K))), owed: idents(owedOf(snapshot(w.phone)).owed.map((o) => o.act)), records: w.phone.names(`vitan.made.${K}.`).length };
}

/** plan r3: the same phone, with the key no longer fenced (a tab of an earlier release is open), then an earlier
 *  release's write, then the key fenced again. Unfenced, the ledger writes nothing and releases
 *  nothing, and a page owes every act the truth owes, at most again. Fenced anew, no side whose nonce the key no longer carries is read:
 *  the first write repeats at most what a record or a send held, once, and the loads after it are steady */
function unfencedThenRefenced(w: World, label: string, op: Earlier, plan: WritePlan | null) {
  fenceNow = false;
  const unfenced = (at: string) => {
    const s = snapshot(w.phone);
    const { owed, frame } = owedOf(s);
    expect(planWrite(s, { mine: owed, known: new Set(frame.occs.map((o) => o.oid)), sent: new Set() }), `${label}: ${at}: no ledger write`).toBeNull();
    if (plan) expect(evidenceOf(s, Object.assign([...plan.legacySpent], plan)), `${label}: ${at}: no evidence goes`).toEqual({ records: [], marks: [], legacy: [] });
    covers(w, `${label}: ${at}`, w.sent.size, true);
  };
  unfenced('unfenced');
  // plan r3 v4: a frozen tab of an earlier release wakes while the key is still fenced (B2f never saw it) and writes;
  // a page of this release then releases what a fresh read allows: nothing a record or the key held is lost
  fenceNow = true;
  earlier(w, op);
  if (plan) {
    const ev = evidenceOf(snapshot(w.phone), Object.assign([...plan.legacySpent], plan));
    release(w.phone, ev.records, (n) => w.records.delete(n));
  }
  covers(w, `${label}: fenced, a frozen earlier-release tab ${op}s`, w.sent.size, true);
  fenceNow = false;
  unfenced(`unfenced, then an earlier release ${op}`);
  // fenced anew: no tab of an earlier release is left
  fenceNow = true;
  const legacy = snapshot(w.phone).marks.legacy;
  const all = idents(w.owed().map((x) => w.acts.get(x)!));
  // less one occurrence of each identity an earlier release marked (see `covers`)
  const truth = all.filter((i, n) => !(legacy.has(i) && all.indexOf(i) === n));
  const spare = [...w.records.values()].flat().length + w.sent.size;
  const first = loadAndLand(w);
  expect(contains(first.owed, truth), `${label}: refenced: every unsent act owed`).toBe(true);
  expect(first.owed.length, `${label}: refenced: a repeat at most, once`).toBeLessThanOrEqual(truth.length + spare);
  const second = loadAndLand(w);
  const third = loadAndLand(w);
  expect(second, `${label}: refenced: the next load is steady`).toEqual(first);
  expect(third, `${label}: refenced: and the one after`).toEqual(first);
  fenceNow = true;
}

/** a page opened on a key read as the fallback owes every act the truth owes, by identity, and at most repeats: of
 *  what a record holds, or of what was sent */
function covers(w: World, label: string, spare: number, earlierMarks = false) {
  const s = snapshot(w.phone);
  const owed = owedOf(s).owed.map((o) => queueActIdent(o.act));
  const truth = w.owed().map((x) => queueActIdent(w.acts.get(x)!));
  const n = (list: string[], i: string) => list.filter((x) => x === i).length;
  // `earlierMarks`: an earlier release's one mark per identity settles one occurrence of an act with no key without
  // saying which, so it may hide one other occurrence (main hides every one: B1a's residual, while an earlier release
  // can write the key)
  const less = (i: string) => (earlierMarks && s.marks.legacy.has(i) ? 1 : 0);
  for (const i of new Set(truth)) expect(n(owed, i), `${label}: ${i} owed`).toBeGreaterThanOrEqual(n(truth, i) - less(i));
  const recorded = [...w.records.values()].flat().length;
  expect(owed.length, `${label}: repeats only of records or sends`).toBeLessThanOrEqual(truth.length + recorded + spare);
}

type Other = 'none' | 'appends U' | 'appends a keyed act' | 'sends with its mark' | 'sends and writes' | 'clears';
const OTHERS: Other[] = ['none', 'appends U', 'appends a keyed act', 'sends with its mark', 'sends and writes', 'clears'];
const MODES: Mode[] = [
  'lands', 'key fails', 'sidecar fails', 'closes between', 'closes before the commit', 'the commit fails',
  'closes after the commit', 'closes after records',
  'key fails, the sidecar stays', 'key fails, closes before the record', 'key fails, the record fails',
];

function other(w: World, op: Other) {
  if (op === 'none') return;
  if (op === 'clears') { w.phone.removeItem(K); w.key = []; return; }
  const o = tab();
  load(w, o);
  if (op === 'appends U' || op === 'appends a keyed act') { o.mem.push(w.fresh(op === 'appends U' ? U : keyed('other'))); write(w, o); return; }
  const first = o.mem.find((x) => w.key.includes(w.of(x.oid)));
  if (!first) return;
  settle(w, o, first);
  if (op === 'sends and writes') { o.mem = o.mem.filter((x) => x !== first); write(w, o); }
}

/** every key of up to four acts */
function shapes(): string[] {
  const out = [''];
  for (let len = 1; len <= 4; len++) for (let bits = 0; bits < 1 << len; bits++) out.push(Array.from({ length: len }, (_, n) => ((bits >> n) & 1 ? 'U' : 'K')).join(''));
  return out;
}

describe('the ledger matrix: key, made records, stranded acts, marks and memory together', () => {
  // one test per key, stranded count, record count and marks made or failing, so each stays small
  const rows = shapes().flatMap((shape) => [0, 1, 2].flatMap((stranded) => [0, 1, 2].flatMap((records) => [true, false].map((marks) => ({ shape: shape || '(empty)', stranded, records, marks })))));
  it.each(rows)('key $shape, stranded $stranded, records $records, marks made $marks', ({ shape, stranded, records, marks }) => {
    let cases = 0;
    {
      const len = shape.replace('(empty)', '').length + stranded + records;
      for (let sent = 0; sent <= len; sent++) for (const op of OTHERS) for (const extra of [false, true]) for (const front of op === 'none' && marks && !extra ? [false, true] : [false]) for (const mode of MODES) {
        const name = `${shape} stranded ${stranded} records ${records} sent ${sent}${marks ? '' : ' (marks fail)'} other ${op} new ${extra ? 'U' : 'none'}${front ? ' front' : ''} write ${mode}`;
        current = name;
        fenceNow = true;
        const w = new World();
        w.seed(shape.replace('(empty)', '').split('').filter(Boolean).map((c, n) => w.fresh(c === 'U' ? U : keyed(`q${n}`))));
        // a page closed after a write it could not make: its acts are in made records
        for (let r = 0; r < records; r++) w.record([w.fresh(U)]);
        const t = tab();
        // the scope moved away and back: unsent acts neither written nor recorded are held stranded
        for (let n = 0; n < stranded; n++) t.stranded.push(w.fresh(U));
        load(w, t);
        expect(t.mem.map((o) => w.of(o.oid)), name).toEqual([...t.stranded.map((o) => w.of(o.oid)), ...w.owed()]);
        // the flush sends from the front of memory, marking each as it goes (or failing to)
        const unmarked = new Set<string>();
        for (const o of t.mem.slice(0, sent)) { settle(w, t, o, marks); if (!marks) unmarked.add(w.of(o.oid)); }
        // a page opened mid-flush owes every unsent act; one sent whose mark failed it may send again, never more
        const mid = freshOwed(w);
        expect(mid.filter((x) => !unmarked.has(x)), `${name}: a page opened mid-flush`).toEqual(w.owed());
        other(w, op);
        if (extra) t.mem.push(w.fresh(U));
        // the scope-move write: memory's last unsent act goes first, wherever the key holds it
        if (front) { const last = [...t.mem].reverse().find((o) => !w.sent.has(w.of(o.oid))); if (last) t.front = new Set([last.oid]); }
        const unsentHere = t.mem.map((o) => w.of(o.oid)).filter((s) => !w.sent.has(s));
        const durableBefore = new Set(w.owed());
        const rawBefore = w.phone.getItem(K);
        const result = write(w, t, mode);
        // a write stopped after its key, before its commit, reads as the fallback: a repeat at most
        const fallback = lastPlan!.raw !== rawBefore && (mode === 'closes before the commit' || mode === 'the commit fails');
        if (fallback) covers(w, `${name}: a page opened after`, w.sent.size);
        else expect(freshOwed(w).filter((x) => !unmarked.has(x) || result === 'landed'), `${name}: a page opened after`).toEqual(w.owed());
        // nothing that was on this phone before the write is lost, at any point it stops
        const durable = new Set(w.owed());
        for (const s of durableBefore) expect(durable.has(s) || w.sent.has(s), `${name}: ${s} was on the phone`).toBe(true);
        if (result === 'closed') {
          // a page closed during the write loses only what memory alone held, as a close just before it would: what
          // memory held that the key or a record did not (stranded, new acts) was never on this phone
          for (const s of unsentHere) expect(durable.has(s) || !durableBefore.has(s), `${name}: ${s}`).toBe(true);
        } else {
          // nothing unsent this tab held is lost: the key or a record holds it, or this tab still does
          for (const s of unsentHere) expect(durable.has(s) || t.mem.some((o) => w.of(o.oid) === s), `${name}: ${s} kept`).toBe(true);
        }
        if (result === 'landed') {
          // no evidence is left that guards nothing: every mark names an occurrence a record still holds
          const held = new Set([...w.records.values()].flat());
          for (const n of w.phone.names(`vitan.settled.${K}.`)) {
            const m = readMarkName(K, n);
            expect(m && 'oid' in m && held.has(w.of(m.oid)), `${name}: mark ${n} left`).toBe(true);
          }
          for (const [rname, serials] of w.records) expect(serials.some((s) => !w.sent.has(s) && !w.key.includes(s)), `${name}: record ${rname} left`).toBe(true);
          // and this tab's next load owes the same
          load(w, t);
          expect(t.mem.map((o) => w.of(o.oid)), `${name}: this tab's next load`).toEqual([...t.stranded.map((o) => w.of(o.oid)).filter((s) => !w.key.includes(s)), ...w.owed()]);
          // then another tab clears the key and this tab's restoring write is refused: every unsent act is still on
          // this phone, in a record (#1109 r1, Codex 4365534650: a record-born act whose record went with the write)
          other(w, 'clears');
          write(w, t, 'key fails');
          const after = new Set(w.owed());
          for (const o of t.mem) expect(after.has(w.of(o.oid)) || w.sent.has(w.of(o.oid)), `${name}: ${w.of(o.oid)} after a clear and a refused restore`).toBe(true);
          expect(freshOwed(w), `${name}: a page opened after a clear and a refused restore`).toEqual(w.owed());
        }
        // the pending side left behind, then an earlier release writing those same bytes with occurrences of its own
        // (#1109 r1 re-check of 4365534649): the pending side names nothing, so nothing is hidden and nothing goes
        if ((mode === 'closes between' || mode === 'key fails, the sidecar stays') && lastPlan!.raw !== rawBefore) {
          const had = actsIn(w.phone.getItem(K));
          // an earlier release cannot carry this write's token (it never held it): it writes the plan's acts alone
        const want = actsIn(lastPlan!.raw);
          if (had.every((a, n) => JSON.stringify(a) === JSON.stringify(want[n]))) {
            if (w.phone.getItem(K) === null) w.key = [];
            for (const act of want.slice(had.length)) w.key.push(w.fresh(act).oid);
            w.phone.setItem(K, JSON.stringify(want));
            covers(w, `${name}: then an earlier release writes the same bytes`, w.sent.size);
            const ev = evidenceOf(snapshot(w.phone), Object.assign([...lastPlan!.legacySpent], lastPlan!));
            expect(ev, `${name}: then an earlier release writes the same bytes: no evidence goes`).toEqual({ records: [], marks: [], legacy: [] });
          }
        }
        // plan r3: the same phone unfenced, an earlier release's write, then fenced anew
        unfencedThenRefenced(w, name, EARLIER[cases % EARLIER.length], lastPlan);
        cases += 1;
      }
    }
    expect(cases).toBeGreaterThan(0);
  });
});

describe('#1109 round 1 (review 5636193453): each finding as its own probe', () => {
  it('4365534649: a page closed between the sidecar’s write and the key’s owes what it owed before; only memory’s new act, never on this phone, is gone', () => {
    const w = new World();
    w.seed([w.fresh(U), w.fresh(keyed('a'))]);
    const t = tab();
    load(w, t);
    settle(w, t, t.mem[0]);
    const before = freshOwed(w);
    t.mem.push(w.fresh(U));
    expect(write(w, t, 'closes between')).toBe('closed');
    expect(freshOwed(w)).toEqual(before);
    expect(owedOf(snapshot(w.phone)).frame.exact).toBe(true);
  });

  it('4365534649: a page closed after the commit owes the new act, read exactly, before any evidence goes', () => {
    const w = new World();
    w.seed([w.fresh(U)]);
    w.record([w.fresh(U)]);
    const t = tab();
    load(w, t);
    settle(w, t, t.mem[0]);
    t.mem.push(w.fresh(keyed('n')));
    expect(write(w, t, 'closes after the commit')).toBe('closed');
    expect(owedOf(snapshot(w.phone)).owed.map((o) => o.act)).toEqual([U, keyed('n')]);
    expect(owedOf(snapshot(w.phone)).frame.exact).toBe(true);
  });

  it('4365534650: an act its record held, written into the key (the record goes), then cleared there and refused here, is kept in a new record', () => {
    const w = new World();
    w.seed([]);
    w.record([w.fresh(U)]);
    const t = tab();
    load(w, t);
    expect(write(w, t)).toBe('landed');
    expect(w.phone.names(`vitan.made.${K}.`)).toEqual([]);
    other(w, 'clears');
    expect(write(w, t, 'key fails')).toBe('refused');
    expect(owedOf(snapshot(w.phone)).owed.map((o) => o.act)).toEqual([U]);
  });

  it('4365534650: a refused write keeps in a new record only what no record there holds already', () => {
    const w = new World();
    w.seed([]);
    w.record([w.fresh(U)]);
    const t = tab();
    load(w, t);
    t.mem.push(w.fresh(keyed('n')));
    expect(unkeptOf(snapshot(w.phone), { mine: t.mem, known: t.known, sent: t.sent }).map((o) => o.act)).toEqual([keyed('n')]);
  });

  it('4365534650 sibling (the round-1 pass): a refused scope-move write keeps in a new record no act the key holds', () => {
    const w = new World();
    w.seed([w.fresh(U), w.fresh(keyed('a'))]);
    const t = tab();
    load(w, t);
    t.front = new Set([t.mem[1].oid]);
    expect(unkeptOf(snapshot(w.phone), { mine: t.mem, known: t.known, sent: t.sent, front: t.front })).toEqual([]);
    expect(write(w, t, 'sidecar fails')).toBe('refused');
    expect(w.phone.names(`vitan.made.${K}.`)).toEqual([]);
    expect(freshOwed(w)).toEqual(w.owed());
  });

  it('4365534639: a sidecar naming two positions alike is damaged; the key reads by its bytes, and a mark hides neither', () => {
    const w = new World();
    const raw = JSON.stringify([U, U]);
    w.phone.setItem(K, raw);
    const t = ledgerTag(queueActIdent(U));
    w.phone.setItem(sidecarName(K), encodeSidecar({ next: { tag: ledgerTag(raw), occ: [[t, 'x'], [t, 'x']] }, prev: null }));
    expect(decodeSidecar(w.phone.getItem(sidecarName(K)))).toBeNull();
    expect(decodeSidecar(encodeSidecar({ next: { tag: ledgerTag(raw), occ: [[t, ''], [t, 'y']] }, prev: null }))).toBeNull();
    w.phone.setItem(markName(K, U, 'x'), queueActIdent(U));
    expect(owedOf(snapshot(w.phone)).owed.map((o) => o.act)).toEqual([U, U]);
  });

  it('4365534644: an act from a record, sent here with its mark not made, goes with the record at the write; a fresh page does not send it again', () => {
    const w = new World();
    w.seed([]);
    w.record([w.fresh(U)]);
    const t = tab();
    load(w, t);
    settle(w, t, t.mem[0], false);
    expect(write(w, t)).toBe('landed');
    expect(w.phone.names(`vitan.made.${K}.`)).toEqual([]);
    expect(owedOf(snapshot(w.phone)).owed).toEqual([]);
  });

  it('4365534644: evidence from a landed write lets the record of an act sent here go, though its mark was not made (call shape b09cb52 also takes)', () => {
    const w = new World();
    w.seed([]);
    w.record([w.fresh(U)]);
    const t = tab();
    load(w, t);
    settle(w, t, t.mem[0], false);
    const plan = planWrite(snapshot(w.phone), { mine: t.mem, known: t.known, sent: t.sent })!;
    expect(plan.next).toEqual([]);
    w.phone.setItem(sidecarName(K), encodeSidecar((plan as Partial<WritePlan>).commit ?? plan.sidecar));
    // the plan as an array of its spent marks, carrying its fields: b09cb52's evidenceOf takes the array, this one the plan
    const ev = evidenceOf(snapshot(w.phone), Object.assign([...plan.legacySpent], plan));
    expect(ev.records).toEqual([...w.records.keys()]);
  });

  it('#1109 r1 re-check of 4365534649: a pending side left by a close, then an earlier release writing those bytes, hides no record act and lets no record go', () => {
    for (const mode of ['closes between', 'key fails, the sidecar stays'] as const) {
      current = mode;
      const w = new World();
      w.seed([w.fresh(U)]);
      w.record([w.fresh(U)]);
      const t = tab();
      load(w, t);
      expect(write(w, t, mode)).toBe(mode === 'closes between' ? 'closed' : 'refused');
      expect(actsIn(lastPlan!.raw)).toEqual([U, U]);
      // an earlier release's tab appends its own U: the key's bytes are now the pending side's
      w.key.push(w.fresh(U).oid);
      w.phone.setItem(K, JSON.stringify([U, U]));
      expect(freshOwed(w).length, mode).toBe(w.owed().length);
      expect(w.owed().length).toBe(3);
      expect(evidenceOf(snapshot(w.phone), Object.assign([...lastPlan!.legacySpent], lastPlan!)).records, mode).toEqual([]);
    }
  });

  it('plan r3 v4: a page closed after the key, before the commit, reads the key exactly by its token: no repeat, and the record may go', () => {
    const w = new World();
    w.seed([w.fresh(U)]);
    w.record([w.fresh(U)]);
    const t = tab();
    load(w, t);
    expect(write(w, t, 'closes before the commit')).toBe('closed');
    const after = owedOf(snapshot(w.phone));
    // the key carries this write's token, so its pending side names it: both U owed once each (R-c ends)
    expect(after.frame.exact).toBe(true);
    expect(after.owed.map((o) => w.of(o.oid))).toEqual(w.owed());
    expect(evidenceOf(snapshot(w.phone), Object.assign([...lastPlan!.legacySpent], lastPlan!)).records).toEqual([...w.records.keys()]);
  });

  it('#1109 r2: the queue key guard exports the leaf’s identity, unchanged', () => {
    expect(guardIdent).toBe(queueActIdent);
  });

  it('a pending side is read as written; a side whose pending is anything but true is damaged', () => {
    const side = { tag: ledgerTag('[]'), occ: [] as [string, string][] };
    expect(decodeSidecar(JSON.stringify({ next: { ...side, pending: true }, prev: null }))?.next?.pending).toBe(true);
    expect(decodeSidecar(JSON.stringify({ next: { ...side, pending: 'yes' }, prev: null }))).toBeNull();
  });

  it('4365534635: an act from a record an earlier release marked sent is not written into the key, and a fresh page does not send it again', () => {
    const w = new World();
    w.seed([w.fresh(keyed('a'))]);
    w.record([w.fresh(U)]);
    const t = tab();
    load(w, t);
    // an earlier release's tab sent the recorded act and marked it, one mark per identity
    markSettled(w.phone, K, queueActIdent(U));
    w.sent.add(w.of(t.mem[1].oid));
    expect(write(w, t)).toBe('landed');
    expect(actsIn(w.phone.getItem(K))).toEqual([keyed('a')]);
    expect(owedOf(snapshot(w.phone)).owed.map((o) => o.act)).toEqual([keyed('a')]);
  });

  it('4365534635: a stranded act held under its record’s id, which an earlier release marked sent, is not owed', () => {
    const w = new World();
    w.seed([]);
    const held = w.fresh(U);
    w.record([held]);
    markSettled(w.phone, K, queueActIdent(U));
    expect(owedOf(snapshot(w.phone), [{ ...held }]).owed).toEqual([]);
  });
});

describe('the findings, each as its own probe', () => {
  it('#1106 r1 4362814041: [U, A, U], the first U sent and A failed: the write stores [A, U]', () => {
    const w = new World();
    w.seed([w.fresh(U), w.fresh(keyed('a')), w.fresh(U)]);
    const t = tab();
    load(w, t);
    settle(w, t, t.mem[0]);
    write(w, t);
    expect(actsIn(w.phone.getItem(K))).toEqual([keyed('a'), U]);
  });

  it('#1106 r1 4362814051: two stranded U beside one in the key all come back', () => {
    const w = new World();
    w.seed([w.fresh(U)]);
    const t = tab();
    t.stranded.push(w.fresh(U), w.fresh(U));
    load(w, t);
    expect(t.mem).toHaveLength(3);
  });

  it('#1106 r1 4362814059: another tab appends an identical U after this tab loaded one: the write keeps both', () => {
    const w = new World();
    w.seed([w.fresh(U)]);
    const t = tab();
    load(w, t);
    other(w, 'appends U');
    write(w, t);
    expect(actsIn(w.phone.getItem(K))).toEqual([U, U]);
  });

  it('#1106 r2 4363345408 (a): a failed [U, U] write over a stored U: a fresh page owes both', () => {
    const w = new World();
    w.seed([w.fresh(U)]);
    const t = tab();
    load(w, t);
    t.mem.push(w.fresh(U));
    expect(write(w, t, 'key fails')).toBe('refused');
    expect(owedOf(snapshot(w.phone)).owed.map((o) => o.act)).toEqual([U, U]);
  });

  it('#1106 r2 4363345429 (b): two stranded U beside [U, A]: the write stores [U, U, A]', () => {
    const w = new World();
    w.seed([w.fresh(U), w.fresh(keyed('a'))]);
    const t = tab();
    t.stranded.push(w.fresh(U));
    load(w, t);
    write(w, t);
    expect(actsIn(w.phone.getItem(K))).toEqual([U, U, keyed('a')]);
  });

  it('#1106 r2 4363345418 (c): [U, U], the first sent, another tab clears the key: the restored U is owed, and no mark is left', () => {
    const w = new World();
    w.seed([w.fresh(U), w.fresh(U)]);
    const t = tab();
    load(w, t);
    settle(w, t, t.mem[0]);
    other(w, 'clears');
    write(w, t);
    expect(owedOf(snapshot(w.phone)).owed.map((o) => o.act)).toEqual([U]);
    expect(w.phone.names(`vitan.settled.${K}.`)).toEqual([]);
  });

  it('#1106 r2 audit sibling: a stranded U handed back first is sent; a fresh page still owes the key’s U', () => {
    const w = new World();
    w.seed([w.fresh(U), w.fresh(keyed('a'))]);
    const t = tab();
    t.stranded.push(w.fresh(U));
    load(w, t);
    settle(w, t, t.mem[0]);
    expect(owedOf(snapshot(w.phone)).owed.map((o) => o.act)).toEqual([U, keyed('a')]);
  });
});

describe('the writers the guard keeps', () => {
  it('an act memory let go without a mark (a visit start refused for good takes its later acts with it) leaves the key', () => {
    const w = new World();
    w.seed([w.fresh(U), w.fresh(keyed('a'))]);
    const t = tab();
    load(w, t);
    const plan = planWrite(snapshot(w.phone), { mine: t.mem.slice(0, 1), known: t.known, sent: t.sent })!;
    expect(plan.next.map((o) => o.act)).toEqual([U]);
  });

  it('the scope-move write puts its unsent acts first (`front`), wherever the key holds them, and keeps every other act', () => {
    const w = new World();
    w.seed([w.fresh(keyed('a')), w.fresh(U), w.fresh(keyed('b'))]);
    const t = tab();
    load(w, t);
    const [a, u, b] = t.mem;
    settle(w, t, a);
    const plan = planWrite(snapshot(w.phone), { mine: t.mem, known: t.known, sent: t.sent, front: new Set([b.oid, u.oid]) })!;
    expect(plan.next.map((o) => o.oid)).toEqual([u.oid, b.oid]);
  });

  it('an earlier release reads a record this release names as newer: it loads none of its acts, and keeps it', () => {
    const p = new Phone();
    const raw = recordBytes([U, U], 'm1');
    p.setItem(recordName(K, [], raw, 'm1'), raw);
    expect(madeActs(p, K, undefined)).toEqual([]);
    expect(releaseMade(p, K, () => true, queueActIdent, undefined), 'every mark of the key stays').toBeNull();
    expect(p.names(`vitan.made.${K}.`)).toHaveLength(1);
  });
});

describe('evidence goes only after a read-back (R5)', () => {
  it('a sent act’s mark stays while the record it was in cannot be removed, so a fresh page does not send it again', () => {
    const w = new World();
    w.seed([]);
    w.record([w.fresh(U)]);
    const t = tab();
    load(w, t);
    settle(w, t, t.mem[0]);
    w.phone.stuck.add(`vitan.made.${K}.`);
    expect(write(w, t)).toBe('landed');
    expect(w.phone.names(`vitan.made.${K}.`)).toHaveLength(1);
    expect(freshOwed(w)).toEqual([]);
  });

  it('an act sent here whose mark could not be made is still left out of this tab’s write', () => {
    const w = new World();
    w.seed([w.fresh(U), w.fresh(U)]);
    const t = tab();
    load(w, t);
    // the mark's write fails; the flush still knows it sent the first
    t.sent.add(t.mem[0].oid);
    w.sent.add(w.of(t.mem[0].oid));
    write(w, t);
    expect(actsIn(w.phone.getItem(K))).toEqual([U]);
  });
});

describe('an earlier release beside this one (the fallback: a repeat at most, never a loss)', () => {
  it('a key with no sidecar (every key before L2) reads in order, and an act settled in it is not loaded again', () => {
    const w = new World();
    w.seed([w.fresh(keyed('a')), w.fresh(U)], false);
    const t = tab();
    load(w, t);
    expect(t.mem.map((o) => o.act)).toEqual([keyed('a'), U]);
    settle(w, t, t.mem[0]);
    settle(w, t, t.mem[1]);
    // the bytes' own ids hold while the bytes do
    expect(owedOf(snapshot(w.phone)).owed).toEqual([]);
  });

  it('two identical U in a key with no sidecar: one sent here is hidden by the bytes’ own ids, and this tab’s write keeps the other', () => {
    const w = new World();
    w.seed([w.fresh(U), w.fresh(U)], false);
    const t = tab();
    load(w, t);
    settle(w, t, t.mem[0]);
    expect(owedOf(snapshot(w.phone)).owed.map((o) => o.act)).toEqual([U]);
    land(w, planWrite(snapshot(w.phone), { mine: t.mem, known: t.known, sent: t.sent })!);
    expect(owedOf(snapshot(w.phone)).owed.map((o) => o.act)).toEqual([U]);
    expect(owedOf(snapshot(w.phone)).frame.exact).toBe(true);
  });

  it('an earlier release rewrites the key with an identical U added: nothing unsent is lost (one repeat at most)', () => {
    const w = new World();
    w.seed([w.fresh(U)]);
    const t = tab();
    load(w, t);
    // an earlier release writes its memory whole, with one more identical U, and no sidecar
    w.phone.setItem(K, JSON.stringify([U, U]));
    expect(owedOf(snapshot(w.phone)).owed.map((o) => o.act)).toEqual([U, U]);
    const plan = planWrite(snapshot(w.phone), { mine: t.mem, known: t.known, sent: t.sent })!;
    // this tab's U is not taken as another tab's send (R2): it goes back in beside both
    expect(plan.next.map((o) => o.act)).toEqual([U, U, U]);
  });

  it('a photo with no client key that an earlier release sent and marked is not sent again', () => {
    const w = new World();
    w.seed([w.fresh(keylessPhoto)], false);
    expect(markSettled(w.phone, K, queueActIdent(keylessPhoto))).toBe(true); // main's own mark, one per identity
    expect(owedOf(snapshot(w.phone)).owed).toEqual([]);
  });

  it('a photo with no client key this release marked is not sent again after an earlier release rewrites the key', () => {
    const w = new World();
    w.seed([w.fresh(keylessPhoto), w.fresh(U)]);
    const t = tab();
    load(w, t);
    settle(w, t, t.mem[0]);
    // an earlier release writes its memory whole (it still held the photo), with no sidecar
    w.phone.setItem(K, JSON.stringify([keylessPhoto, U, keyed('z')]));
    // plan r3 v4: the bytes carry no token, so no side names them and no id is kept from one: the sent photo is owed
    // again, a repeat. L2 keys it in memory before its write (G1), so its replay carries the same key and the server
    // keeps one row; a mark never hides an occurrence the key cannot be shown to hold
    expect(owedOf(snapshot(w.phone)).owed.map((o) => o.act)).toEqual([keylessPhoto, U, keyed('z')]);
  });

  it('a photo with no client key, unmarked, is owed once', () => {
    const w = new World();
    w.seed([w.fresh(keylessPhoto)], false);
    expect(owedOf(snapshot(w.phone)).owed.map((o) => o.act)).toEqual([keylessPhoto]);
  });

  it('an earlier release’s mark beside two identical U hides neither (a repeat, refused by the server); a landed write lets it go', () => {
    const w = new World();
    w.seed([w.fresh(U), w.fresh(U)]);
    markSettled(w.phone, K, queueActIdent(U));
    const t = tab();
    load(w, t);
    expect(t.mem).toHaveLength(2);
    w.sent.clear();
    write(w, t);
    expect(w.phone.names(`vitan.settled.${K}.`)).toEqual([]);
  });

  it('marks: this release’s mark is read by an earlier release by its value, as one mark per identity (no worse than main)', () => {
    const p = new Phone();
    p.setItem(markName(K, U, 's9'), queueActIdent(U));
    expect(settledIdents(p, K)).toEqual(new Set([queueActIdent(U)]));
    // and the earlier release's own mark is read here as its own kind, by the same tag
    const q = new Phone();
    markSettled(q, K, queueActIdent(U));
    const [n] = q.names(`vitan.settled.${K}.`);
    expect(readMarkName(K, n)).toEqual({ legacy: true });
    expect(n).toBe(`vitan.settled.${K}.${ledgerTag(queueActIdent(U))}`);
  });

  it('a sidecar this release cannot read is none: the key reads as the fallback', () => {
    for (const bad of ['', '{', '[]', '{"next":1,"prev":null}', '{"next":{"tag":"x","occ":[[1,2]]},"prev":null}']) expect(decodeSidecar(bad)).toBeNull();
  });

  it('a key this release cannot read is never written over', () => {
    const w = new World();
    w.phone.setItem(K, JSON.stringify([{ t: 'aKindFromANewerRelease' }]));
    expect(planWrite(snapshot(w.phone), { mine: [], known: new Set(), sent: new Set() })).toBeNull();
  });
});
