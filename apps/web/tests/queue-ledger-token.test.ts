import { describe, it, expect } from 'vitest';
import type { OutboxOp } from '@/data/apiGateway';
import { queueActIdent } from '@/store/queueActIdent';
import { madeActs, recordMade } from '@/store/queueActRecord';
import * as ledger from '@/store/queueLedger';
import { decodeSidecar, encodeSidecar, evidenceOf, ledgerTag, owedOf, planWrite, recordName, type Snapshot } from '@/store/queueLedger';

/**
 * WEB-02 L1' (plan r3 v4): the write token. Each ledger write puts its token, `{ t: 'vitan.writeToken', n: <nonce> }`,
 * first in the key, in the same setItem as its acts; a side names the key only while the key carries that side's nonce.
 * The fence is B2f-2's yes/no answer (`ledgerMayWrite`): with no, the ledger plans no write and releases nothing. The
 * reader (`split`) and the release (`release`) here are L2's, as the plan sets them out; the ledger is unwired until L2.
 * At #1109's last head 0d5b1bd every row is red by assertion but the three that head already got right.
 */
const K = 'vitan.outbox.dev:u-pmc.p-1';
/** a new record's bytes (`recordBytes`); the earlier heads these probes also run at (#1109's, 7f96531) have none, and
 *  their records are the acts alone */
const recordBytes = (acts: OutboxOp[], nonce: string): string => ledger.recordBytes?.(acts, nonce) ?? JSON.stringify(acts);
const TOKEN = 'vitan.writeToken';
const U = { t: 'submitInspection', inspectionId: 'i-1', items: [] } as unknown as OutboxOp;
const P = { t: 'uploadMedia', input: { projectId: 'p-1', evidenceId: 'e-1', mime: 'image/jpeg' } } as unknown as OutboxOp;

class Phone {
  items = new Map<string, string>();
  get length() { return this.items.size; }
  key(i: number) { return [...this.items.keys()][i] ?? null; }
  getItem(n: string) { return this.items.get(n) ?? null; }
  setItem(n: string, v: string) { this.items.set(n, String(v)); }
  removeItem(n: string) { this.items.delete(n); }
  names(prefix: string) { return [...this.items.keys()].filter((n) => n.startsWith(prefix)); }
}
/** L2's reader: the token is the key's first entry, never an act */
const split = (raw: string | null): { token: string | null; acts: OutboxOp[] | null } => {
  if (raw === null) return { token: null, acts: null };
  const all = JSON.parse(raw) as { t?: string; n?: string }[];
  return all[0]?.t === TOKEN ? { token: all[0].n ?? null, acts: all.slice(1) as unknown as OutboxOp[] } : { token: null, acts: all as unknown as OutboxOp[] };
};
const snap = (p: Phone, fence: boolean, over: Partial<Snapshot> = {}): Snapshot => {
  const raw = p.getItem(K);
  const { token, acts } = split(raw);
  const order = (n: string) => Number(n.slice(`vitan.made.${K}.`.length).split('.')[0]);
  const records = p.names(`vitan.made.${K}.`).sort((a, b) => order(a) - order(b)).map((name) => ({ name, acts: split(p.getItem(name)).acts! }));
  return { key: K, raw, acts, sidecar: decodeSidecar(p.getItem(`vitan.occ.${K}`)), marks: { ids: new Set(), legacy: new Set() }, records, recordsUnread: false, fence, token, ...over } as Snapshot;
};
const withRecord = (act: OutboxOp) => {
  const p = new Phone();
  p.setItem(K, '[]');
  const raw = recordBytes([act], 'm1');
  p.setItem(recordName(K, [], raw, 'm1'), raw);
  return p;
};
/** L2's record release: remove, read the token again, and put every record back if the key changed meanwhile */
function release(p: Phone, fence: boolean, plan: { legacySpent: string[]; sent: string[] }, between?: () => void) {
  const before = snap(p, fence);
  const names = evidenceOf(before, plan).records;
  const kept = names.map((n) => [n, p.getItem(n)!] as const);
  between?.();
  for (const [n] of kept) p.removeItem(n);
  if (snap(p, fence).token !== before.token) for (const [n, v] of kept) p.setItem(n, v);
}
type Stop = 'none' | 'afterKey' | 'afterCommit';
function load(p: Phone, fence: boolean, stop: Stop = 'none', mapAct: (o: OutboxOp) => OutboxOp = (o) => o, between?: () => void) {
  const s0 = snap(p, fence);
  const { owed, frame } = owedOf(s0);
  const plan = planWrite(s0, { mine: owed.map((o) => ({ ...o, act: mapAct(o.act) })), known: new Set(frame.occs.map((o) => o.oid)), sent: new Set() });
  if (!plan) return null;
  p.setItem(`vitan.occ.${K}`, encodeSidecar(plan.sidecar));
  p.setItem(K, plan.raw);
  if (stop === 'afterKey') return plan;
  p.setItem(`vitan.occ.${K}`, encodeSidecar(plan.commit));
  if (stop === 'afterCommit') return plan;
  release(p, fence, plan, between);
  return plan;
}
const owedN = (p: Phone, fence: boolean) => owedOf(snap(p, fence)).owed.length;
const keyLen = (p: Phone) => split(p.getItem(K)).acts?.length ?? 0;
const recs = (p: Phone) => p.names(`vitan.made.${K}.`).length;
const keyPhotos = (ops: OutboxOp[]) => {
  const seen = new Map<string, number>();
  return ops.map((o) => {
    const i = (o as unknown as { input: Record<string, unknown> }).input;
    if (o.t !== 'uploadMedia' || i.clientKey) return o;
    const content = JSON.stringify(i);
    const nth = seen.get(content) ?? 0;
    seen.set(content, nth + 1);
    return { ...o, input: { ...i, clientKey: `legacy-photo-${content.length}-${nth}` } } as unknown as OutboxOp;
  });
};
const serverRows = (ops: OutboxOp[]) => new Set(keyPhotos(ops).map((o) => (o as unknown as { input: { clientKey: string } }).input.clientKey)).size;
const keyIt = (o: OutboxOp) => keyPhotos([o])[0];

describe('plan r3 v4: the write token', () => {
  it('a ledger write puts its token first in the key and its nonce on its side; the ledger reads it as the reader here does', () => {
    const p = withRecord(U);
    const plan = load(p, true, 'afterCommit');
    const entries = JSON.parse(p.getItem(K)!) as unknown[];
    const nonce = (entries[0] as { t?: string; n?: string }).n;
    expect(entries[0], 'the first entry is the token').toEqual({ t: TOKEN, n: expect.stringMatching(/^[0-9a-f]{32}$/) });
    expect(plan?.commit.next?.nonce, 'the committed side carries its nonce').toBe(nonce);
    expect(ledger.tokenOf?.(entries), 'tokenOf').toEqual({ token: nonce, rest: [U] });
    expect(split(p.getItem(K))).toEqual({ token: nonce, acts: [U] });
    expect(ledger.tokenOf?.([{ t: TOKEN, n: '' }, U]), 'an empty nonce is no token').toEqual({ token: null, rest: [{ t: TOKEN, n: '' }, U] });
  });

  it('4366320603, a frozen earlier-release tab wakes after the fence is set and writes its own U after the commit: the record stays, both U owed', () => {
    const p = withRecord(U);
    load(p, true, 'afterCommit');
    // the frozen tab (before step A1) loaded the empty key long ago; it writes its memory, with no token
    p.setItem(K, JSON.stringify([U]));
    expect(evidenceOf(snap(p, true), { legacySpent: [], sent: [] }).records, 'nothing goes').toEqual([]);
    expect(owedN(p, true), 'both U owed').toBe(2);
  });

  it('4366320603, the frozen tab writes between the token check and the record removal: the record is put back, both U owed', () => {
    const p = withRecord(U);
    load(p, true, 'none', undefined, () => p.setItem(K, JSON.stringify([U])));
    expect(recs(p), 'the record is back').toBe(1);
    expect(owedN(p, true), 'both U owed').toBe(2);
  });

  it('a frozen tab before step A1 that loaded the fenced key offline appends a U: the token stays, but no side names those bytes', () => {
    const p = withRecord(U);
    load(p, true);
    const raw = p.getItem(K)!;
    p.setItem(K, JSON.stringify([...(JSON.parse(raw) as unknown[]), U]));
    expect(owedOf(snap(p, true)).frame.exact).toBe(false);
    expect(owedN(p, true), 'the key U and the new U').toBe(2);
  });

  it('a frozen tab before step A1 that loaded the fenced key sends: its flush takes the token first (as sent), so its write has none', () => {
    const p = withRecord(U);
    load(p, true);
    // it sends the U and queues an identical one: the same acts, its own occurrence, and no token
    p.setItem(K, JSON.stringify([U]));
    expect(owedOf(snap(p, true)).frame.exact).toBe(false);
    expect(owedN(p, true), 'the new U owed').toBe(1);
  });

  it('fenced again after an earlier release’s write, no act is lost: that write carries no token', () => {
    const p = withRecord(U);
    load(p, true, 'afterCommit');
    p.setItem(K, JSON.stringify([U]));
    expect(owedN(p, true)).toBe(2);
    expect(evidenceOf(snap(p, true), { legacySpent: [], sent: [] }).records).toEqual([]);
  });

  it('gap check steady-state row: unfenced, three loads write nothing; fenced, the key holds the U once', () => {
    const u = withRecord(U);
    expect([0, 1, 2].map(() => { load(u, false); return keyLen(u) * 10 + recs(u); })).toEqual([1, 1, 1]);
    const f = withRecord(U);
    expect([0, 1, 2].map(() => { load(f, true); return keyLen(f) * 10 + recs(f); })).toEqual([10, 10, 10]);
  });

  it('R-c ends: closes between the key write and the commit repeat nothing, the token names the key', () => {
    const p = withRecord(U);
    const seq: number[] = [];
    for (let i = 0; i < 3; i++) { load(p, true, 'afterKey'); seq.push(owedN(p, true)); }
    expect(seq).toEqual([1, 1, 1]);
    load(p, true);
    expect({ key: keyLen(p), recs: recs(p) }).toEqual({ key: 1, recs: 0 });
  });

  it('R-b narrows: a close after the commit and a later fenced load repeat nothing while the token is still in the key', () => {
    const p = withRecord(U);
    load(p, true, 'afterCommit');
    expect(owedN(p, true)).toBe(1);
  });

  it('R-b remains when an unfenced write took the token out meanwhile: one repeat, then steady', () => {
    const p = withRecord(U);
    load(p, true, 'afterCommit');
    // unfenced, main's guard path (in this release or an earlier one) writes the key's acts back, with no token
    p.setItem(K, JSON.stringify([U]));
    expect(owedN(p, true), 'the key U and the record U: one repeat').toBe(2);
    const steady = [0, 1, 2].map(() => { load(p, true); return [owedN(p, true), keyLen(p), recs(p)]; });
    expect(steady).toEqual([[2, 2, 0], [2, 2, 0], [2, 2, 0]]);
  });

  it('G1: with the keying, that repeat of a keyless photo is one server row', () => {
    const p = withRecord(P);
    load(p, true, 'afterCommit', keyIt);
    p.setItem(K, JSON.stringify(split(p.getItem(K)).acts));
    expect(serverRows(owedOf(snap(p, true)).owed.map((o) => o.act))).toBe(1);
  });

  it('4366320605 (Q2): an earlier release’s mark beside a key U settles no U while a record is unread, and neither once it is read', () => {
    const p = withRecord(U);
    p.setItem(K, JSON.stringify([U]));
    const legacy = { ids: new Set<string>(), legacy: new Set([queueActIdent(U)]) };
    const unread = snap(p, true, { recordsUnread: true, records: [], marks: legacy });
    expect(owedOf(unread).owed.map((o) => o.act), 'unread: the key U owed').toEqual([U]);
    expect(evidenceOf(unread, { legacySpent: [], sent: [] }).legacy, 'unread: the mark stays').toEqual([]);
    expect(owedOf(snap(p, true, { marks: legacy })).owed.map((o) => o.act), 'read: both U owed').toEqual([U, U]);
  });

  it('4366320607: an earlier release cannot load the acts of a record this release named, so it never saves them again', () => {
    const p = withRecord(U);
    const [name] = p.names(`vitan.made.${K}.`);
    expect(madeActs(p, K, undefined), 'it loads none').toEqual([]);
    expect(name.endsWith(`.m1.${ledgerTag(p.getItem(name)!)}`), 'the name ends in its bytes’ tag (#1111)').toBe(true);
  });

  it('4368074449: an earlier release’s tab whose key write fails keeps its own byte-identical U in a record of its own: both U owed', () => {
    const p = new Phone();
    const raw = recordBytes([U], 'm1');
    p.setItem(recordName(K, [], raw, 'm1'), raw);
    // a frozen B1a-era tab queued its own U; its key write fails, so it keeps the U with its recordMade
    expect(recordMade(p, K, [U]), 'its save reads back').toBe(true);
    expect(p.names(`vitan.made.${K}.`), 'a record of its own').toHaveLength(2);
    expect(owedOf(snap(p, true)).owed.map((o) => o.act), 'both U owed').toEqual([U, U]);
  });
});

describe('L1′: the fence is B2f-2’s yes/no answer', () => {
  it('with no answer or a no, the ledger plans no write and lets no evidence go; with yes it does', () => {
    const p = withRecord(U);
    load(p, true, 'afterCommit'); // the key holds the record's U, named by its token; the record is still there
    for (const fence of [undefined, false] as const) {
      const s = snap(p, true, { fence });
      const { owed, frame } = owedOf(s);
      expect(planWrite(s, { mine: owed, known: new Set(frame.occs.map((o) => o.oid)), sent: new Set() }), `${fence}: no write`).toBeNull();
      expect(evidenceOf(s, { legacySpent: [], sent: [] }), `${fence}: nothing goes`).toEqual({ records: [], marks: [], legacy: [] });
    }
    expect(evidenceOf(snap(p, true), { legacySpent: [], sent: [] }).records, 'yes: the record may go').toHaveLength(1);
    expect(load(p, true), 'yes: the ledger writes').not.toBeNull();
    expect({ key: keyLen(p), recs: recs(p) }).toEqual({ key: 1, recs: 0 });
  });
});
