import { describe, it, expect, vi } from 'vitest';
import { createQueueKeyStore, keepUnsent, queueActIdent } from '@/store/queueKeyStore';
import type { OutboxOp } from '@/data/apiGateway';

/** WEB-02 step 1: the merge rules of the one queue key writer, on a storage of its own */

const K = 'vitan.outbox.u.p';
const a = (k: string): OutboxOp => ({ t: 'approve', decisionId: 'd', optionIndex: 0, idempotencyKey: k });
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
const full = () => ({ getItem: () => '[]', setItem: () => { throw new DOMException('full', 'QuotaExceededError'); } });

const asidesOf = (st: { writes: string[]; getItem: (k: string) => string | null }) => st.writes.filter((w) => w.startsWith(`vitan.unreadable.${K}.`)).map((w) => st.getItem(w));

describe('queueKeyStore', () => {
  it('a write keeps the acts it never held, after its own, and drops the ones it held and settled', () => {
    const st = storage({ [K]: JSON.stringify([a('x'), a('y')]) });
    const q = createQueueKeyStore();
    q.loaded(K, [a('x'), a('y')]);
    st.setItem(K, JSON.stringify([a('x'), a('y'), a('other')]));
    q.write(st, K, [a('y'), a('mine')]);
    expect(st.keys(K)).toEqual(['y', 'mine', 'other']);
  });

  it('a write that changes nothing writes nothing', () => {
    const st = storage({ [K]: JSON.stringify([a('x')]) });
    const q = createQueueKeyStore();
    q.loaded(K, [a('x')]);
    q.write(st, K, [a('x')]);
    expect(st.writes).toEqual([]);
  });

  it('a stale write that put back an act made and settled here is answered by taking it off', () => {
    const st = storage();
    const q = createQueueKeyStore();
    q.loaded(K, []);
    q.write(st, K, [a('sent')]);
    q.write(st, K, []);
    st.setItem(K, JSON.stringify([a('sent'), a('theirs')]));
    q.heard(st, K, []);
    expect(st.keys(K)).toEqual(['theirs']);
  });

  it('an act the load read and this tab settled, put back by another tab, is not taken off by the listener', () => {
    const st = storage();
    const q = createQueueKeyStore();
    q.loaded(K, [a('loaded')]);
    q.write(st, K, []);
    st.setItem(K, JSON.stringify([a('loaded')]));
    st.writes.length = 0;
    q.heard(st, K, []);
    expect(st.writes).toEqual([]);
  });

  it('an act made here is written back at every write that leaves it out, and is never listed not kept', () => {
    const st = storage();
    const q = createQueueKeyStore();
    q.loaded(K, []);
    q.write(st, K, [a('mine')]);
    for (let n = 0; n < 3; n += 1) {
      st.setItem(K, '[]');
      q.heard(st, K, [a('mine')]);
      expect(st.keys(K)).toEqual(['mine']);
      expect(q.notKept(K)).toEqual([]);
    }
  });

  it('bounded across this release’s tabs: one that loaded an act made in another, and sent it, does not answer its writing back', () => {
    const m = new Map<string, string>();
    const tabs: { q: ReturnType<typeof createQueueKeyStore>; mine: OutboxOp[] }[] = [];
    const heardBy: number[] = [];
    const st = (me: number) => ({
      getItem: (k: string) => m.get(k) ?? null,
      setItem: (k: string, v: string) => { m.set(k, v); tabs.forEach((_, i) => { if (i !== me) heardBy.push(i); }); },
    });
    const made = createQueueKeyStore();
    made.loaded(K, []);
    tabs.push({ q: made, mine: [a('x')] });
    made.write(st(0), K, [a('x')]);
    heardBy.length = 0;
    const loader = createQueueKeyStore();
    loader.loaded(K, [a('x')]);
    tabs.push({ q: loader, mine: [] });
    loader.write(st(1), K, []); // the loading tab sent x
    let answers = 0;
    while (heardBy.length && answers < 50) { const i = heardBy.shift()!; answers += 1; tabs[i].q.heard(st(i), K, tabs[i].mine); }
    expect(answers).toBeLessThan(5);
    expect(JSON.parse(m.get(K)!)).toEqual([a('x')]);
  });

  it('a list holding an entry that is not an act is never written over: the write says so and lists its acts not kept', () => {
    const newer = JSON.stringify(['v3:queue-format', a('n')]);
    const st = storage({ [K]: newer });
    const q = createQueueKeyStore();
    q.loaded(K, []);
    expect(q.write(st, K, [a('mine')])).toBe(false);
    expect(st.getItem(K)).toBe(newer);
    expect(q.notKept(K)).toEqual([queueActIdent(a('mine'))]);
  });

  it('the flush’s write of a scope it left never writes over such a list: its unsent acts are copied aside beside it', () => {
    const newer = JSON.stringify(['v3:queue-format', a('n')]);
    const st = storage({ [K]: newer });
    keepUnsent(st, K, [a('unsent')], [a('sent'), a('unsent')], (l) => l);
    expect(st.getItem(K)).toBe(newer);
    expect(st.writes.filter((w) => w.startsWith(`vitan.unreadable.${K}.`)).map((w) => st.getItem(w))).toEqual([JSON.stringify([a('unsent')])]);
  });

  it('a write that fails says so and lists its acts not kept, but not one the key still holds', () => {
    const q = createQueueKeyStore();
    q.loaded(K, []);
    expect(q.write(full(), K, [a('mine')])).toBe(false);
    expect(q.notKept(K)).toEqual([queueActIdent(a('mine'))]);
    const stillThere = { getItem: () => JSON.stringify([a('x')]), setItem: () => { throw new DOMException('full', 'QuotaExceededError'); } };
    expect(q.write(stillThere, K, [a('x'), a('y')])).toBe(false);
    expect(q.notKept(K)).toEqual([queueActIdent(a('y'))]);
  });

  it('notKept lists only acts memory holds and the key does not: a sent act, or one stored again, leaves it', () => {
    const st = storage();
    const q = createQueueKeyStore();
    q.loaded(K, []);
    q.write(full(), K, [a('m1'), a('m2')]);
    expect(q.notKept(K).sort()).toEqual([queueActIdent(a('m1')), queueActIdent(a('m2'))]);
    // another tab's write stores m1 again; m2 was sent meanwhile, so memory holds only m1
    st.setItem(K, JSON.stringify([a('m1')]));
    q.heard(st, K, [a('m1')]);
    expect(q.notKept(K)).toEqual([]);
    q.write(full(), K, [a('m3')]);
    q.write(st, K, []); // m3 sent: memory holds nothing, and a write that leaves nothing out lists nothing
    expect(q.notKept(K)).toEqual([]);
  });

  it('a heard list holding an entry that is not an act (a newer release’s shape) is not answered', () => {
    const newer = JSON.stringify(['v3:queue-format', { t: 'aKindFromANewerRelease', idempotencyKey: 'k-new' }]);
    const st = storage({ [K]: newer });
    const q = createQueueKeyStore();
    q.loaded(K, []);
    q.heard(st, K, [a('mine')]);
    expect(st.writes).toEqual([]);
    expect(st.getItem(K)).toBe(newer);
  });

  it('bytes that are not a list are not answered by a heard write', () => {
    const st = storage({ [K]: '{not a list' });
    const q = createQueueKeyStore();
    q.loaded(K, []);
    q.heard(st, K, [a('mine')]);
    expect(st.writes).toEqual([]);
  });

  it('only a key whose load ran is held, and forget lets every key go', () => {
    const q = createQueueKeyStore();
    expect(q.holds(K)).toBe(false);
    q.loaded(K, []);
    expect(q.holds(K)).toBe(true);
    q.forget();
    expect(q.holds(K)).toBe(false);
  });

  it('no ping-pong: two tabs that each settled an act the other still holds stop after one answer each', () => {
    const m = new Map<string, string>([[K, JSON.stringify([a('x'), a('y')])]]);
    const tabs: { q: ReturnType<typeof createQueueKeyStore>; mine: OutboxOp[] }[] = [];
    const heardBy: number[] = [];
    const st = (me: number) => ({
      getItem: (k: string) => m.get(k) ?? null,
      setItem: (k: string, v: string) => { m.set(k, v); tabs.forEach((_, i) => { if (i !== me) heardBy.push(i); }); },
    });
    for (const mine of [[a('y')], [a('x')]]) { const q = createQueueKeyStore(); q.loaded(K, [a('x'), a('y')]); tabs.push({ q, mine }); }
    tabs[0].q.write(st(0), K, tabs[0].mine); // tab 0 sent x; tab 1 sent y
    let answers = 0;
    while (heardBy.length && answers < 50) { const i = heardBy.shift()!; answers += 1; tabs[i].q.heard(st(i), K, tabs[i].mine); }
    expect(answers).toBeLessThan(10);
    expect(heardBy).toEqual([]);
  });

  it('an act the load read that another tab’s write leaves out (that tab most likely sent it) is not written back, and is listed not kept', () => {
    const st = storage({ [K]: JSON.stringify([a('shared')]) });
    const q = createQueueKeyStore();
    q.loaded(K, [a('shared')]);
    st.setItem(K, '[]');
    st.writes.length = 0;
    q.heard(st, K, [a('shared')]);
    expect(st.writes).toEqual([]);
    expect(q.notKept(K)).toEqual([queueActIdent(a('shared'))]);
  });

  it('#1079 4344436665: a refused write copies the acts it could not store aside, once each', () => {
    const newer = JSON.stringify(['v3:queue-format', a('n')]);
    const st = storage({ [K]: newer });
    const q = createQueueKeyStore();
    q.loaded(K, []);
    expect(q.write(st, K, [a('m1')])).toBe(false);
    expect(q.write(st, K, [a('m1'), a('m2')])).toBe(false);
    expect(st.getItem(K)).toBe(newer);
    expect(asidesOf(st)).toEqual([JSON.stringify([a('m1')]), JSON.stringify([a('m2')])]);
  });

  it('#1079 4344436665: a refused write whose copy aside cannot be stored says so', () => {
    const q = createQueueKeyStore();
    q.loaded(K, []);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(q.write(full(), K, [a('m1')])).toBe(false);
      expect(warn).toHaveBeenCalledWith('acts not kept', K);
    } finally { warn.mockRestore(); }
  });

  it('#1079 4344436669: a heard write this tab’s own write went over is put back, only while the key holds that write', () => {
    const st = storage({ [K]: '[]' });
    const q = createQueueKeyStore();
    q.loaded(K, []);
    q.write(st, K, [a('mine')]);
    q.heard(st, K, [a('mine')], JSON.stringify([a('old')]));
    expect(st.keys(K)).toEqual(['mine', 'old']);
    // a heard write older than a later write by another tab is not put back
    st.setItem(K, JSON.stringify([a('mine'), a('other')]));
    q.heard(st, K, [a('mine')], JSON.stringify([a('gone')]));
    expect(st.keys(K)).toEqual(['mine', 'other']);
  });

  it('#1079 4344436672: the flush’s scope-moved write moves or drops only the acts `takes` accepts; the others stay byte for byte', () => {
    const newer = { t: 'aKindFromANewerRelease', idempotencyKey: 'n' } as unknown as OutboxOp;
    const st = storage({ [K]: JSON.stringify([a('sent'), newer, a('other')]) });
    keepUnsent(st, K, [], [a('sent')], () => [], (o) => o.t === 'approve');
    expect(JSON.parse(st.getItem(K)!)).toEqual([newer]);
  });

  it('the flush’s scope-moved write beside such a list says so when its copy aside cannot be stored', () => {
    const newer = JSON.stringify(['v3:queue-format', a('n')]);
    const m = new Map([[K, newer]]);
    const st = { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { if (k.startsWith('vitan.unreadable.')) throw new DOMException('full', 'QuotaExceededError'); m.set(k, v); } };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      keepUnsent(st, K, [a('unsent')], [a('unsent')], (l) => l);
      expect(warn).toHaveBeenCalledWith('unsent acts not kept', K);
      expect(m.get(K)).toBe(newer);
    } finally { warn.mockRestore(); }
  });

  it('re-check G1: an act this tab read, since sent by its owner, is not put back by a late heard write', () => {
    const st = storage();
    const tabA = createQueueKeyStore();
    const tabC = createQueueKeyStore();
    tabA.loaded(K, []);
    tabC.loaded(K, []);
    tabC.write(st, K, [a('c1')]);
    const ev1 = st.getItem(K)!; // its event reaches A late
    tabA.write(st, K, [a('a1')]); // A reads [c1] and merges
    tabC.write(st, K, []); // C sent c1
    tabA.write(st, K, [a('a1'), a('a2')]); // the key now holds A's last write
    tabA.heard(st, K, [a('a1'), a('a2')], ev1);
    expect(st.keys(K)).not.toContain('c1');
  });
});
