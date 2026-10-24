import { describe, it, expect } from 'vitest';
import type { OutboxOp } from '@/data/apiGateway';
import { readStoredQueue } from '@/data/storedActs';
import { queueActIdent } from '@/store/queueKeyGuard';
import { madeActs, markSettled, settledIdents } from '@/store/queueActRecord';
import {
  decodeSidecar, encodeSidecar, evidenceOf, ledgerTag, markName, owedOf, planWrite, readMarkName, recordName, recordOid, sidecarName, unkeptOf,
  type Occ, type Snapshot,
} from '@/store/queueLedger';

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
 * made records of a `U`, each partial flush counted in memory's order, another tab's act (none, an append of `U` or of
 * a keyed act, a send with its mark, a send and its write, a clear), a new `U` here or none, and this tab's write
 * (lands, the key write fails, the sidecar write fails, the page closes between the sidecar's write and the key's).
 */

const K = 'vitan.outbox.dev:u-pmc.p-1';
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

function snapshot(p: Phone): Snapshot {
  const raw = p.getItem(K);
  const read = readStoredQueue(raw);
  const ids = new Set<string>();
  const legacy = new Set<string>();
  for (const n of p.names(`vitan.settled.${K}.`)) {
    const m = readMarkName(K, n);
    if (m && 'oid' in m) ids.add(m.oid); else if (m) legacy.add(p.getItem(n)!);
  }
  const order = (n: string) => Number(n.slice(`vitan.made.${K}.`.length).split('.')[0]);
  const records = p.names(`vitan.made.${K}.`).sort((a, b) => order(a) - order(b)).map((name) => ({ name, acts: JSON.parse(p.getItem(name)!) as OutboxOp[] }));
  return { key: K, raw, acts: 'acts' in read ? read.acts : null, sidecar: decodeSidecar(p.getItem(sidecarName(K))), marks: { ids, legacy }, records, recordsUnread: false };
}

/** the truth: each occurrence's serial, and which are sent */
class World {
  phone = new Phone();
  serial = 0;
  sent = new Set<string>();
  /** the serials the key holds in order, and each record's */
  key: string[] = [];
  records = new Map<string, string[]>();
  alias = new Map<string, string>();
  of = (oid: string) => this.alias.get(oid) ?? oid;
  fresh(act: OutboxOp): Occ { this.serial += 1; return { oid: `s${this.serial}`, act: { ...act } }; }
  /** what a page opened now owes, by the truth */
  owed(): string[] {
    const inKey = new Set(this.key);
    return [...this.key, ...[...this.records.values()].flat().filter((s) => !inKey.has(s))].filter((s) => !this.sent.has(s));
  }
  /** a key and sidecar this release wrote */
  seed(occs: Occ[], sidecar = true) {
    const raw = JSON.stringify(occs.map((o) => o.act));
    this.phone.setItem(K, raw);
    if (sidecar) this.phone.setItem(sidecarName(K), encodeSidecar({ next: { tag: ledgerTag(raw), occ: occs.map((o) => [ledgerTag(queueActIdent(o.act)), o.oid]) }, prev: null }));
    this.key = occs.map((o) => o.oid);
  }
  /** a made record of `occs`, always a record of its own (`recordName`): two records of the same bytes are two, and a
   *  name is never used twice (main's writer takes the same bytes for one record, which L2 changes); their oids become
   *  the record's */
  record(occs: Occ[]): boolean {
    const raw = JSON.stringify(occs.map((o) => o.act));
    this.serial += 1;
    const name = recordName(K, this.phone.names(`vitan.made.${K}.`), raw, `m${this.serial}`);
    try { this.phone.setItem(name, raw); } catch { return false; }
    occs.forEach((o, n) => { const was = this.of(o.oid); o.oid = recordOid(K, name, n); this.alias.set(o.oid, was); });
    this.records.set(name, occs.map((o) => this.of(o.oid)));
    return true;
  }
}

type Tab = { mem: Occ[]; known: Set<string>; sent: Set<string>; stranded: Occ[]; loadedKey: string[] };
const tab = (): Tab => ({ mem: [], known: new Set(), sent: new Set(), stranded: [], loadedKey: [] });

function load(w: World, t: Tab) {
  const { owed, frame } = owedOf(snapshot(w.phone), t.stranded);
  t.mem = owed.map((o) => ({ ...o }));
  t.known = new Set(frame.occs.map((o) => o.oid));
  t.sent = new Set();
  t.loadedKey = [...w.key];
}
function settle(w: World, t: Tab, o: Occ) {
  w.phone.setItem(markName(K, o.act, o.oid), queueActIdent(o.act));
  t.sent.add(o.oid);
  w.sent.add(w.of(o.oid));
  // a stranded act settled is held no more
  t.stranded = t.stranded.filter((x) => w.of(x.oid) !== w.of(o.oid));
}

/** the one right answer for `t`'s write now, by the truth */
function rightWrite(w: World, t: Tab): string[] {
  const mine = t.mem.map((o) => w.of(o.oid)).filter((s) => !w.sent.has(s));
  if (w.phone.getItem(K) === null) return mine;
  const inKey = new Set(w.key);
  const first = mine.findIndex((s) => inKey.has(s));
  const out = mine.filter((s, n) => !inKey.has(s) && (first < 0 || n < first));
  out.push(...w.key.filter((s) => !w.sent.has(s)));
  out.push(...mine.filter((s, n) => !inKey.has(s) && first >= 0 && n > first));
  return out;
}

type Mode = 'lands' | 'key fails' | 'sidecar fails' | 'closes between';
/** `t`'s write, as L2 does it: sidecar, key, read back, then the evidence (records first, then marks). A write that does
 *  not land keeps memory's unsent occurrences the key lacks in a made record, and held stranded */
function write(w: World, t: Tab, mode: Mode = 'lands'): 'landed' | 'refused' | 'closed' {
  const s = snapshot(w.phone);
  const plan = planWrite(s, { mine: t.mem, known: t.known, sent: t.sent });
  if (!plan) throw new Error('unreadable');
  const want = rightWrite(w, t);
  expect(plan.next.map((o) => w.of(o.oid)), 'the write stores the right occurrences in order').toEqual(want);
  const refuse = () => {
    // the record's own occurrences are in it already
    const left = unkeptOf(s, { mine: t.mem, known: t.known, sent: t.sent }).filter((o) => !o.oid.startsWith('r:'));
    const was = new Set(left.map((o) => w.of(o.oid)));
    // recorded, they are also held stranded, under the record's ids, so a scope move or sign-out keeps them
    if (left.length > 0 && w.record(left)) t.stranded = [...t.stranded.filter((o) => !was.has(w.of(o.oid))), ...left.map((o) => ({ ...o }))];
    return 'refused' as const;
  };
  if (mode === 'sidecar fails') { w.phone.fail.add(sidecarName(K)); try { w.phone.setItem(sidecarName(K), encodeSidecar(plan.sidecar)); } catch { w.phone.fail.clear(); return refuse(); } }
  w.phone.setItem(sidecarName(K), encodeSidecar(plan.sidecar));
  // the same bytes are not written again: the sidecar alone names them anew, and the write has landed with it
  const same = plan.raw === s.raw;
  if (mode === 'closes between') { if (same) w.key = want; return 'closed'; }
  if (mode === 'key fails' && !same) return refuse();
  if (!same) w.phone.setItem(K, plan.raw);
  w.key = want;
  expect(w.phone.getItem(K)).toBe(plan.raw);
  const first = evidenceOf(snapshot(w.phone), plan.legacySpent);
  for (const n of first.records) { w.phone.removeItem(n); if (w.phone.getItem(n) === null) w.records.delete(n); }
  const then = evidenceOf(snapshot(w.phone), plan.legacySpent);
  for (const n of w.phone.names(`vitan.settled.${K}.`)) {
    const m = readMarkName(K, n);
    if ((m && 'oid' in m && then.marks.includes(m.oid)) || (m && 'legacy' in m && then.legacy.includes(w.phone.getItem(n)!))) w.phone.removeItem(n);
  }
  t.mem = plan.next;
  t.known = new Set(plan.next.map((o) => o.oid));
  t.sent = new Set();
  t.stranded = t.stranded.filter((o) => !t.known.has(o.oid));
  t.loadedKey = [...w.key];
  return 'landed';
}

/** a plan written as L2 writes it, with no right-answer check (the fallback rows check their own) */
function land(w: World, plan: { raw: string; sidecar: Parameters<typeof encodeSidecar>[0] }) {
  w.phone.setItem(sidecarName(K), encodeSidecar(plan.sidecar));
  w.phone.setItem(K, plan.raw);
}

const freshOwed = (w: World) => owedOf(snapshot(w.phone)).owed.map((o) => w.of(o.oid));

type Other = 'none' | 'appends U' | 'appends a keyed act' | 'sends with its mark' | 'sends and writes' | 'clears';
const OTHERS: Other[] = ['none', 'appends U', 'appends a keyed act', 'sends with its mark', 'sends and writes', 'clears'];
const MODES: Mode[] = ['lands', 'key fails', 'sidecar fails', 'closes between'];

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
  it.each(shapes().map((shape) => ({ shape: shape || '(empty)' })))('key $shape', ({ shape }) => {
    let cases = 0;
    for (let stranded = 0; stranded <= 2; stranded++) for (let records = 0; records <= 2; records++) {
      const len = shape.replace('(empty)', '').length + stranded + records;
      for (let sent = 0; sent <= len; sent++) for (const op of OTHERS) for (const extra of [false, true]) for (const mode of MODES) {
        const name = `${shape} stranded ${stranded} records ${records} sent ${sent} other ${op} new ${extra ? 'U' : 'none'} write ${mode}`;
        const w = new World();
        w.seed(shape.replace('(empty)', '').split('').filter(Boolean).map((c, n) => w.fresh(c === 'U' ? U : keyed(`q${n}`))));
        // a page closed after a write it could not make: its acts are in made records
        for (let r = 0; r < records; r++) w.record([w.fresh(U)]);
        const t = tab();
        // the scope moved away and back: unsent acts neither written nor recorded are held stranded
        for (let n = 0; n < stranded; n++) t.stranded.push(w.fresh(U));
        load(w, t);
        expect(t.mem.map((o) => w.of(o.oid)), name).toEqual([...t.stranded.map((o) => w.of(o.oid)), ...w.owed()]);
        // the flush sends from the front of memory, marking each as it goes
        for (const o of t.mem.slice(0, sent)) settle(w, t, o);
        expect(freshOwed(w), `${name}: a page opened mid-flush`).toEqual(w.owed());
        other(w, op);
        if (extra) t.mem.push(w.fresh(U));
        const unsentHere = t.mem.map((o) => w.of(o.oid)).filter((s) => !w.sent.has(s));
        const result = write(w, t, mode);
        expect(freshOwed(w), `${name}: a page opened after`).toEqual(w.owed());
        if (result !== 'closed') {
          // nothing unsent this tab held is lost: the key or a record holds it, or this tab still does
          const durable = new Set(w.owed());
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
        }
        cases += 1;
      }
    }
    expect(cases).toBeGreaterThan(0);
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
    expect(JSON.parse(w.phone.getItem(K)!)).toEqual([keyed('a'), U]);
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
    expect(JSON.parse(w.phone.getItem(K)!)).toEqual([U, U]);
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
    expect(JSON.parse(w.phone.getItem(K)!)).toEqual([U, U, keyed('a')]);
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

  it('an earlier release reads a record this release names, as its own', () => {
    const p = new Phone();
    const raw = JSON.stringify([U, U]);
    p.setItem(recordName(K, [], raw, 'm1'), raw);
    p.setItem(recordName(K, p.names(`vitan.made.${K}.`), raw, 'm2'), raw);
    expect(madeActs(p, K, undefined)).toEqual([U, U, U, U]);
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
    expect(JSON.parse(w.phone.getItem(K)!)).toEqual([U]);
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
    expect(owedOf(snapshot(w.phone)).owed.map((o) => o.act)).toEqual([U, keyed('z')]);
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
