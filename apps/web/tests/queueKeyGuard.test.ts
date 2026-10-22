import { describe, it, expect } from 'vitest';
import { createQueueKeyGuard, queueActIdent, type KeyRead } from '@/store/queueKeyGuard';
import type { OutboxOp } from '@/data/apiGateway';

/** WEB-02 step A (#482 6333415419): the stored-act check at the queue key writer, on a storage of its own */

const K = 'vitan.outbox.u.p';
const a = (k: string): OutboxOp => ({ t: 'approve', decisionId: 'd', optionIndex: 0, idempotencyKey: k });
const visitEnd = (k: string): OutboxOp => ({ t: 'siteVisitEnd', visitId: 'v', claimedAt: '2026-10-14T05:30:00.000Z', idempotencyKey: k });
function storage(init: Record<string, string> = {}) {
  const m = new Map(Object.entries(init));
  const writes: string[] = [];
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => { writes.push(k); m.set(k, v); },
    keys: (k: string) => (JSON.parse(m.get(k) ?? '[]') as { idempotencyKey: string }[]).map((o) => o.idempotencyKey),
    writes,
  };
}
const full = () => ({ getItem: () => '{bad', setItem: () => { throw new DOMException('full', 'QuotaExceededError'); } });

describe('queueKeyGuard: a key this release reads', () => {
  it('a write stores memory’s acts, and keeps byte for byte every stored entry memory leaves out on purpose (Codex 4344270652)', () => {
    const st = storage({ [K]: JSON.stringify([a('old'), visitEnd('in-general')]) });
    const q = createQueueKeyGuard();
    expect(q.write(st, K, [a('mine')], (o) => o.t !== 'siteVisitEnd')).toBe(true);
    expect(st.keys(K)).toEqual(['mine', 'in-general']);
  });

  it('a write that changes nothing writes nothing', () => {
    const st = storage({ [K]: JSON.stringify([a('x')]) });
    expect(createQueueKeyGuard().write(st, K, [a('x')])).toBe(true);
    expect(st.writes).toEqual([]);
  });

  it('a load reports the read and gives the acts; an unreadable key gives none', () => {
    const reads: KeyRead[] = [];
    const q = createQueueKeyGuard((_k, read) => { reads.push(read); });
    expect(q.load(storage({ [K]: JSON.stringify([a('x')]) }), K)).toEqual([a('x')]);
    expect(q.load(storage({ [K]: JSON.stringify(['v3:format', a('x')]) }), K)).toEqual([]);
    expect(reads).toEqual(['ok', 'damaged']);
  });

  it('the flush’s scope-moved write moves or drops only the acts `takes` accepts; the others stay byte for byte (Codex 4344436672)', () => {
    const st = storage({ [K]: JSON.stringify([a('sent'), visitEnd('left'), a('other')]) });
    createQueueKeyGuard().keepUnsent(st, K, [], [a('sent')], () => [], (o) => o.t === 'approve');
    expect(st.keys(K)).toEqual(['left']);
  });

  it('a refused write whose copy aside cannot be stored lists its acts not kept', () => {
    const q = createQueueKeyGuard();
    expect(q.write(full(), K, [a('m1')])).toBe(false);
    expect(q.notKept(K)).toEqual([queueActIdent(a('m1'))]);
  });
});

describe('queueKeyGuard: a key this release cannot read', () => {
  const asides = (st: ReturnType<typeof storage>, k: string) => [...st.writes].filter((w) => w.startsWith(`vitan.unreadable.${k}.`)).map((w) => st.getItem(w));
  it('is never written over: the write says so, lists every act memory holds as not kept, and reports the read', () => {
    const st = storage({ [K]: '[{"t":"approve"}]' });
    const reads: [string, KeyRead][] = [];
    const q = createQueueKeyGuard((key, read) => { reads.push([key, read]); });
    expect(q.write(st, K, [a('mine')])).toBe(false);
    expect(st.getItem(K)).toBe('[{"t":"approve"}]');
    expect(q.notKept(K)).toEqual([queueActIdent(a('mine'))]);
    expect(reads).toEqual([[K, 'damaged']]);
  });

  it('a newer release’s act is read as newer, and a heard write of it is never answered', () => {
    const raw = JSON.stringify([a('x'), { t: 'aKindFromANewerRelease', idempotencyKey: 'n' }]);
    const st = storage({ [K]: raw });
    const reads: KeyRead[] = [];
    const q = createQueueKeyGuard((_k, read) => { reads.push(read); });
    q.heard(st, K);
    expect(st.writes).toEqual([]);
    expect(reads).toEqual(['newer']);
  });

  it('Set aside copies the bytes under a new name and reads them back; only then is the key written over', () => {
    const st = storage({ [K]: '{bad' });
    const q = createQueueKeyGuard();
    expect(q.setAside(st, [K])).toBe(true);
    expect(asides(st, K)).toEqual(['{bad']);
    expect(q.write(st, K, [a('mine')])).toBe(true);
    expect(st.keys(K)).toEqual(['mine']);
  });

  it('bytes that changed after Set aside are not written over: only the bytes copied are', () => {
    const st = storage({ [K]: '{bad' });
    const q = createQueueKeyGuard();
    q.setAside(st, [K]);
    st.setItem(K, '{other');
    expect(q.write(st, K, [a('mine')])).toBe(false);
    expect(st.getItem(K)).toBe('{other');
  });

  it('a Set aside whose copy does not read back changes nothing', () => {
    const m = new Map([[K, '{bad']]);
    const st = { getItem: (k: string) => (k.startsWith('vitan.unreadable.') ? null : m.get(k) ?? null), setItem: (k: string, v: string) => { m.set(k, v); } };
    const q = createQueueKeyGuard();
    expect(q.setAside(st, [K])).toBe(false);
    expect(q.write(st, K, [a('mine')])).toBe(false);
    expect(m.get(K)).toBe('{bad');
  });

  it('#1085 r1 (Codex 4345664686): after Set aside, the key reads as fixed only once the write over it has landed', () => {
    const m = new Map([[K, '{bad']]);
    let fail = true;
    const st = { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { if (k === K && fail) throw new DOMException('full', 'QuotaExceededError'); m.set(k, v); } };
    const reads: KeyRead[] = [];
    const q = createQueueKeyGuard((_k, read) => { reads.push(read); });
    expect(q.setAside(st, [K])).toBe(true);
    expect(q.write(st, K, [a('mine')])).toBe(false);
    expect(reads).not.toContain('ok');
    expect(m.get(K)).toBe('{bad');
    fail = false;
    expect(q.write(st, K, [a('mine')])).toBe(true);
    expect(reads.at(-1)).toBe('ok');
  });

  it('a Set aside of a key that reads is nothing to do', () => {
    const st = storage({ [K]: JSON.stringify([a('x')]) });
    const q = createQueueKeyGuard();
    expect(q.setAside(st, [K])).toBe(true);
    expect(st.writes).toEqual([]);
  });

  it('the flush’s write of a scope it left never writes over an unreadable key: its unsent acts are copied aside beside it', () => {
    const st = storage({ [K]: '{bad' });
    expect(createQueueKeyGuard().keepUnsent(st, K, [a('unsent')], [a('sent'), a('unsent')], (l) => l)).toBe(true);
    expect(st.getItem(K)).toBe('{bad');
    expect(asides(st, K)).toEqual([JSON.stringify([a('unsent')])]);
  });

  it('#1085 r1 (Codex 4345664670): an unsent act whose copy aside cannot be stored is held, counted, and loaded again with its key; the key is still not written over', () => {
    const m = new Map([[K, '{bad']]);
    const st = { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { if (k.startsWith('vitan.unreadable.')) throw new DOMException('full', 'QuotaExceededError'); m.set(k, v); } };
    const q = createQueueKeyGuard();
    expect(q.keepUnsent(st, K, [a('unsent')], [a('sent'), a('unsent')], (l) => l)).toBe(false);
    expect(m.get(K)).toBe('{bad');
    expect(q.strandedCount()).toBe(1);
    q.forget(); // the scope moved on: the held acts are not forgotten with it
    expect(q.strandedCount()).toBe(1);
    expect(q.load(st, K)).toEqual([a('unsent')]); // the return to that scope holds it again
    expect(q.strandedCount()).toBe(0);
  });

  it('#1085 r1 (Codex 4345664670): with no storage to be had, or a key that reads but cannot be written, the unsent acts are held', () => {
    const q = createQueueKeyGuard();
    expect(q.keepUnsent(null, K, [a('u1')], [a('u1')], (l) => l)).toBe(false);
    const stored = JSON.stringify([a('u2'), a('there')]);
    const st = { getItem: (k: string) => (k === K ? stored : null), setItem: () => { throw new DOMException('full', 'QuotaExceededError'); } };
    expect(q.keepUnsent(st, K, [a('u2'), a('u3')], [a('u2'), a('u3')], (l) => l)).toBe(false);
    // u2 is in the unchanged key: only u1 and u3 are held, and the load gives them back once each
    expect(q.strandedCount()).toBe(2);
    expect(q.load(st, K).map(queueActIdent)).toEqual(['k:u1', 'k:u3', 'k:u2', 'k:there']);
  });

  it('gap-check 2: a refused write does not copy aside an act the unreadable key already holds', () => {
    const newer = { t: 'aKindFromANewerRelease', idempotencyKey: 'n1' } as unknown as OutboxOp;
    const st = storage({ [K]: JSON.stringify([a('a1'), newer]) }); // a newer tab merged a1 and added its own kind
    const q = createQueueKeyGuard();
    expect(q.write(st, K, [a('a1'), a('a2')])).toBe(false);
    expect(st.writes.filter((w) => w.startsWith(`vitan.unreadable.${K}.`)).map((w) => st.getItem(w))).toEqual([JSON.stringify([a('a2')])]);
    expect(q.notKept(K)).toEqual([queueActIdent(a('a2'))]);
  });

  it('a list holding an entry that is not an act is never written over (Codex 4344270663, 4344812910)', () => {
    const newer = JSON.stringify(['v3:queue-format', a('n')]);
    const st = storage({ [K]: newer });
    const q = createQueueKeyGuard();
    expect(q.write(st, K, [a('mine')])).toBe(false);
    expect(st.getItem(K)).toBe(newer);
    expect(q.notKept(K)).toEqual([queueActIdent(a('mine'))]);
  });

  it('a refused write copies the acts it could not store aside, once each (Codex 4344436665)', () => {
    const newer = JSON.stringify([{ t: 'aKindFromANewerRelease', idempotencyKey: 'n' }]);
    const st = storage({ [K]: newer });
    const q = createQueueKeyGuard();
    expect(q.write(st, K, [a('m1')])).toBe(false);
    expect(q.write(st, K, [a('m1'), a('m2')])).toBe(false);
    expect(st.getItem(K)).toBe(newer);
    expect(st.writes.filter((w) => w.startsWith(`vitan.unreadable.${K}.`)).map((w) => st.getItem(w))).toEqual([JSON.stringify([a('m1')]), JSON.stringify([a('m2')])]);
  });

  it('re-check: the flush’s write beside an unreadable key copies aside only acts the key does not hold', () => {
    const raw = JSON.stringify([a('a1'), { t: 'aKindFromANewerRelease', idempotencyKey: 'n' }]);
    const st = storage({ [K]: raw });
    const q = createQueueKeyGuard();
    q.write(st, K, [a('a1'), a('a2')]); // refused write: a2 copied aside
    q.keepUnsent(st, K, [a('a1'), a('a2')], [a('a1'), a('a2')], (l) => l); // a1 is in the key, so only a2 can be copied again
    const all = st.writes.filter((w) => w.startsWith(`vitan.unreadable.${K}.`)).flatMap((w) => (JSON.parse(st.getItem(w)!) as OutboxOp[]).map(queueActIdent));
    expect(st.getItem(K)).toBe(raw);
    expect(all).not.toContain('k:a1');
    expect(all.filter((i) => i === 'k:a2').length).toBeLessThanOrEqual(2);
  });
});
