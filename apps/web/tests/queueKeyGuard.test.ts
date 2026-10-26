import { describe, it, expect } from 'vitest';
import { createQueueKeyGuard, queueActIdent, type KeyRead } from '@/store/queueKeyGuard';
import type { OutboxOp } from '@/data/apiGateway';

/** WEB-02 step A (#482 6333415419): the stored-act check at the queue key writer, on a storage of its own */

const K = 'vitan.outbox.u.p';
const a = (k: string): OutboxOp => ({ t: 'approve', decisionId: 'd', optionIndex: 0, idempotencyKey: k });
const visitEnd = (k: string): OutboxOp => ({ t: 'siteVisitEnd', visitId: '00000000-0000-4000-8000-00000000000a', claimedAt: '2026-10-14T05:30:00.000Z', idempotencyKey: k });
function storage(init: Record<string, string> = {}) {
  const m = new Map(Object.entries(init));
  const writes: string[] = [];
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => { writes.push(k); m.set(k, v); },
    // L2b: a key the ledger writes starts with its write token, which is no act
    keys: (k: string) => (JSON.parse(m.get(k) ?? '[]') as { t: string; idempotencyKey: string }[]).filter((o) => o.t !== 'vitan.writeToken').map((o) => o.idempotencyKey),
    writes,
  };
}
/** U3c: Set aside copies only the bytes `heard` last reconciled a key from, so each tap here hears its keys first */
const heard = <S extends { getItem(k: string): string | null }>(st: S, keys: string[], q = createQueueKeyGuard()) => { for (const k of keys) q.heard(st as never, k); return q; };
const full = () => ({ getItem: () => '{bad', setItem: () => { throw new DOMException('full', 'QuotaExceededError'); } });

describe('queueKeyGuard: a key this release reads', () => {
  it('a write stores memory’s acts, and keeps byte for byte every stored entry memory leaves out on purpose (Codex 4344270652)', () => {
    const st = storage({ [K]: JSON.stringify([a('old'), visitEnd('in-general')]) });
    const q = createQueueKeyGuard();
    expect(q.write(st, K, [a('mine')], (o) => o.t !== 'siteVisitEnd')).toBe(true);
    // L2b (#1106, Codex 4349463910): an act this tab never held is another tab's, and stays; this tab's new act goes
    // after the stored ones (Codex 4344812888)
    expect(st.keys(K)).toEqual(['old', 'in-general', 'mine']);
  });

  it('a write that changes nothing writes nothing', () => {
    const st = storage({ [K]: JSON.stringify([a('x')]) });
    const q = createQueueKeyGuard();
    // L2b: a key with no write token is written once, so the ledger names its occurrences
    expect(q.write(st, K, [a('x')])).toBe(true);
    st.writes.length = 0;
    expect(q.write(st, K, [a('x')])).toBe(true);
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
    const q = heard(st, [K]);
    expect(q.setAside(st, [K])).toBe('ok');
    expect(asides(st, K)).toEqual(['{bad']);
    expect(q.write(st, K, [a('mine')])).toBe(true);
    expect(st.keys(K)).toEqual(['mine']);
  });

  it('bytes that changed after Set aside are not written over: only the bytes copied are', () => {
    const st = storage({ [K]: '{bad' });
    const q = heard(st, [K]);
    expect(q.setAside(st, [K])).toBe('ok');
    st.setItem(K, '{other');
    expect(q.write(st, K, [a('mine')])).toBe(false);
    expect(st.getItem(K)).toBe('{other');
  });

  it('a Set aside whose copy does not read back changes nothing', () => {
    const m = new Map([[K, '{bad']]);
    const st = { getItem: (k: string) => (k.startsWith('vitan.unreadable.') ? null : m.get(k) ?? null), setItem: (k: string, v: string) => { m.set(k, v); } };
    const q = heard(st, [K]);
    expect(q.setAside(st, [K])).toBe('none');
    expect(q.write(st, K, [a('mine')])).toBe(false);
    expect(m.get(K)).toBe('{bad');
  });

  it('#1085 r1 (Codex 4345664686): after Set aside, the key reads as fixed only once the write over it has landed', () => {
    const m = new Map([[K, '{bad']]);
    let fail = true;
    const st = { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { if (k === K && fail) throw new DOMException('full', 'QuotaExceededError'); m.set(k, v); } };
    const reads: KeyRead[] = [];
    const q = heard(st, [K], createQueueKeyGuard((_k, read) => { reads.push(read); }));
    expect(q.setAside(st, [K])).toBe('ok');
    expect(q.write(st, K, [a('mine')])).toBe(false);
    expect(reads).not.toContain('ok');
    expect(m.get(K)).toBe('{bad');
    fail = false;
    expect(q.write(st, K, [a('mine')])).toBe(true);
    expect(reads.at(-1)).toBe('ok');
  });

  it('U3c: Set aside copies only the bytes heard last reconciled: bytes it never heard, or bytes changed since, are copied by nobody and the tap says changed', () => {
    const st = storage({ [K]: '{bad' });
    expect(createQueueKeyGuard().setAside(st, [K])).toBe('changed'); // never heard
    const q = heard(st, [K]);
    st.setItem(K, '{newer');
    st.writes.length = 0;
    expect(q.setAside(st, [K])).toBe('changed');
    expect(st.writes).toEqual([]);
    expect(q.write(st, K, [a('mine')])).toBe(false);
    expect(st.getItem(K)).toBe('{newer');
  });

  it('#1136 r1: a key holding other bytes than the person tapped for is changed, even when heard reconciled them: nothing is copied', () => {
    const st = storage({ [K]: '{bad', [`${K}x`]: '{bad2' });
    const q = heard(st, [K, `${K}x`]);
    st.writes.length = 0;
    expect(q.setAside(st, [`${K}x`, K], new Map([[K, '{bad'], [`${K}x`, '{tapped for']]))).toBe('changed');
    expect(st.writes).toEqual([]);
    expect(q.setAside(st, [K, `${K}x`], new Map([[K, '{bad'], [`${K}x`, '{bad2']]))).toBe('ok');
  });

  it('U3c: a Set aside whose read of a later key throws removes the copies it made, and says none', () => {
    const M = 'vitan.outbox.u.q';
    const m = new Map([[K, '{bad'], [M, '{bad2']]);
    let throwOn: string | null = null;
    const st = {
      getItem: (k: string) => { if (k === throwOn) throw new DOMException('denied', 'SecurityError'); return m.get(k) ?? null; },
      setItem: (k: string, v: string) => { m.set(k, v); },
      removeItem: (k: string) => { m.delete(k); },
    };
    const q = heard(st, [K, M]);
    throwOn = M;
    expect(q.setAside(st, [K, M])).toBe('none');
    expect([...m.keys()].sort()).toEqual([K, M].sort());
    throwOn = null;
    expect(q.write(st, K, [a('mine')])).toBe(false);
    expect(m.get(K)).toBe('{bad');
  });

  it('a Set aside of a key that reads is nothing to do', () => {
    const st = storage({ [K]: JSON.stringify([a('x')]) });
    const q = heard(st, [K]);
    expect(q.setAside(st, [K])).toBe('ok');
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
    expect(q.strandedCount()).toBe(1); // and still counts it: no write has stored it (#1085 r3, Codex 4346778591)
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

describe('#1085 r2 (Codex 4346169602): a Set aside that fails part way leaves no copy, and the same bytes are copied once', () => {
  const L = 'vitan.siteVisitQueue.u.p';
  /** a storage with room for `room` more copies aside; a key's own writes always fit */
  function tight(init: Record<string, string>, room: number) {
    const m = new Map(Object.entries(init));
    const st = {
      room,
      getItem: (k: string) => m.get(k) ?? null,
      setItem: (k: string, v: string) => {
        if (k.startsWith('vitan.unreadable.')) { if (st.room <= 0) throw new DOMException('full', 'QuotaExceededError'); st.room -= 1; }
        m.set(k, v);
      },
      removeItem: (k: string) => { if (m.delete(k) && k.startsWith('vitan.unreadable.')) st.room += 1; },
      copies: (k: string) => [...m.keys()].filter((x) => x.startsWith(`vitan.unreadable.${k}.`)).map((x) => m.get(x)),
    };
    return st;
  }

  it('both keys unreadable, room for one copy: the tap fails and removes the copy it made; once room is freed the next tap copies each key once', () => {
    const st = tight({ [K]: '{bad', [L]: '{bad2' }, 1);
    const q = heard(st, [K, L]);
    expect(q.setAside(st, [K, L])).toBe('none');
    expect([st.copies(K), st.copies(L), st.room]).toEqual([[], [], 1]); // the room it had is the room it has
    st.room = 2; // the person frees room for both
    expect(q.setAside(st, [K, L])).toBe('ok');
    expect([st.copies(K), st.copies(L)]).toEqual([['{bad'], ['{bad2']]);
  });

  it('a copy of the same bytes already there is that copy: a second tap, or a tab after a reload, makes none', () => {
    const st = tight({ [K]: '{bad', [L]: '{bad2' }, 2);
    expect(heard(st, [K, L]).setAside(st, [K, L])).toBe('ok');
    expect(heard(st, [K, L]).setAside(st, [K, L])).toBe('ok'); // the write after the first failed; the person taps again
    expect([st.copies(K), st.copies(L), st.room]).toEqual([['{bad'], ['{bad2'], 0]);
  });

  it('a refused write in two tabs copies the same acts aside once', () => {
    const st = tight({ [K]: '{bad' }, 5);
    expect(createQueueKeyGuard().write(st, K, [a('m1')])).toBe(false);
    expect(createQueueKeyGuard().write(st, K, [a('m1')])).toBe(false);
    expect(st.copies(K)).toEqual([JSON.stringify([a('m1')])]);
  });

  it('a copy that does not read back as written is removed, and the tap fails', () => {
    const m = new Map<string, string>([[K, '{bad']]);
    const removed: string[] = [];
    const st = {
      getItem: (k: string) => m.get(k) ?? null,
      setItem: (k: string, v: string) => { m.set(k, k.startsWith('vitan.unreadable.') ? v.slice(1) : v); },
      removeItem: (k: string) => { removed.push(k); m.delete(k); },
    };
    expect(heard(st, [K]).setAside(st, [K])).toBe('none');
    expect([...m.keys()]).toEqual([K]);
    expect(removed.length).toBe(1);
  });

  it('a name already holding other bytes is never taken for the copy: the copy goes beside it, and both stay', () => {
    // the name the key's bytes are copied under, as a first tap makes it
    const first = new Map<string, string>([[K, '{bad']]);
    const once = { getItem: (k: string) => first.get(k) ?? null, setItem: (k: string, v: string) => { first.set(k, v); } };
    expect(heard(once, [K]).setAside(once, [K])).toBe('ok');
    const name = [...first.keys()].find((k) => k !== K)!;
    const st = tight({ [K]: '{bad', [name]: 'other bytes' }, 5);
    expect(heard(st, [K]).setAside(st, [K])).toBe('ok');
    expect([st.getItem(name), st.getItem(`${name}.1`)]).toEqual(['other bytes', '{bad']);
  });
});

describe('cross-tab drain (xtab-drain plan §3′): what another tab took from the key', () => {
  const ids = (st: ReturnType<typeof storage>) => st.keys(K);
  it('forced probe: a write after another tab drained k-a keeps it out, and so does every write after it', () => {
    const st = storage();
    expect(createQueueKeyGuard().write(st, K, [a('k-a')])).toBe(true);
    const mine = createQueueKeyGuard();
    const other = createQueueKeyGuard();
    const [ka] = mine.load(st, K); // memory's own act, as the store keeps it
    expect(ka).toEqual(a('k-a'));
    expect(other.load(st, K)).toEqual([a('k-a')]);
    expect(other.write(st, K, [])).toBe(true); // it sent k-a
    expect(mine.write(st, K, [ka, a('n1')])).toBe(true); // memory still holds k-a: no event heard yet
    expect(ids(st)).toEqual(['n1']);
    expect(mine.write(st, K, [ka, a('n1'), a('n2')])).toBe(true); // the write before moved on what the key holds
    expect(ids(st)).toEqual(['n1', 'n2']);
    expect(mine.taken(K, ka)).toBe(true);
  });

  it('forced probe (re-check r2, gap 1): another tab keeps this tab\'s act across two of its own writes', () => {
    const st = storage();
    const A = createQueueKeyGuard();
    const B = createQueueKeyGuard();
    A.load(st, K);
    B.load(st, K);
    const ka = a('k-a');
    expect(A.write(st, K, [ka])).toBe(true);
    expect(B.write(st, K, [a('k-b')])).toBe(true); // it carries k-a, never held it
    expect(B.write(st, K, [a('k-b'), a('k-c')])).toBe(true);
    expect(ids(st)).toEqual(['k-a', 'k-b', 'k-c']);
    A.heard(st, K, [ka]);
    expect(A.taken(K, ka)).toBe(false);
  });

  /** this tab's write to the damaged key is refused; another tab, which loaded k-a before the damage, sets the key
   *  aside, then sends k-a and drains it; this tab hears it */
  const refusedThenTaken = (block: (k: string) => boolean) => {
    const m = new Map<string, string>();
    let blocking = true;
    const st = {
      getItem: (k: string) => m.get(k) ?? null,
      setItem: (k: string, v: string) => { if (blocking && block(k)) throw new DOMException('full', 'QuotaExceededError'); m.set(k, v); },
      removeItem: (k: string) => { m.delete(k); },
    };
    expect(createQueueKeyGuard().write(st, K, [a('k-a')])).toBe(true);
    const mine = createQueueKeyGuard();
    const [ka] = mine.load(st, K);
    const other = createQueueKeyGuard();
    const theirs = other.load(st, K);
    m.set(K, '{damaged');
    expect(mine.write(st, K, [ka])).toBe(false);
    const refused = { copies: [...m.keys()].filter((k) => k.startsWith('vitan.unreadable.') || k.startsWith('vitan.made.')).length, notKept: mine.notKeptCount() };
    blocking = false;
    other.heard(st, K, theirs);
    expect(other.setAside(st, [K])).toBe('ok');
    expect(other.writeAll(st, [{ key: K, mine: theirs, takes: () => true }])).toBe('all');
    expect(other.settled(st, K, theirs[0])).toBe(true);
    expect(other.write(st, K, [])).toBe(true);
    mine.heard(st, K, [ka]);
    expect(mine.taken(K, ka)).toBe(true);
    return { m, st, mine, refused };
  };

  it('forced probe (#1138 r1, Codex 4382389315): an act held stranded that another tab then takes is let go; a later load does not hand it back', () => {
    const { st, mine, refused } = refusedThenTaken((k) => k.startsWith('vitan.unreadable.') || k.startsWith('vitan.made.'));
    expect(refused.copies).toBe(0); // neither copied aside nor recorded: held stranded
    mine.forget();
    expect(mine.load(st, K)).toEqual([]);
    expect(mine.strandedCount()).toBe(0);
  });

  it('forced probe (#1138 r1, Codex 4382389303): a copy aside this tab made of an act another tab then takes is removed', () => {
    const { m, refused } = refusedThenTaken(() => false);
    expect(refused.copies).toBeGreaterThan(0);
    const holding = [...m.entries()].filter(([k, v]) => (k.startsWith('vitan.unreadable.') || k.startsWith('vitan.made.')) && v.includes('"k-a"'));
    expect(holding).toEqual([]);
  });

  it('forced probe (#1138 r1, root-cause audit): an act this tab listed not kept that another tab then takes is no longer counted', () => {
    const { mine, refused } = refusedThenTaken(() => false);
    expect(refused.notKept).toBe(1);
    expect(mine.notKeptCount()).toBe(0);
  });

  it('forced probe (Stage 1 watch item): an act queued after the take with the same key is a new act: stored, not taken', () => {
    const st = storage();
    expect(createQueueKeyGuard().write(st, K, [a('k-a')])).toBe(true);
    const mine = createQueueKeyGuard();
    const other = createQueueKeyGuard();
    const [ka] = mine.load(st, K);
    other.load(st, K);
    expect(other.write(st, K, [])).toBe(true); // it sent k-a
    expect(mine.write(st, K, [ka])).toBe(true);
    expect(mine.taken(K, ka)).toBe(true);
    const again = a('k-a'); // the store dropped k-a; this tab now queues an act with the same key
    expect(mine.write(st, K, [again])).toBe(true);
    expect(ids(st)).toEqual(['k-a']);
    expect(mine.taken(K, again)).toBe(false);
  });

  it('forced probe (gap 1, R-a): a write over bytes its writer read in no exact frame takes nothing: k-a stays this tab\'s', () => {
    const st = storage();
    expect(createQueueKeyGuard().write(st, K, [a('k-a')])).toBe(true);
    const mine = createQueueKeyGuard();
    const [ka] = mine.load(st, K);
    // a hand adds an act and keeps the write token: the key is read by the fallback, where k-a keeps its name
    st.setItem(K, JSON.stringify([...JSON.parse(st.getItem(K)!), a('k-b')]));
    const other = createQueueKeyGuard();
    const theirs = other.load(st, K);
    expect(theirs.length).toBe(2);
    expect(other.settled(st, K, theirs[0])).toBe(true); // it sent k-a
    expect(other.write(st, K, [theirs[1]])).toBe(true);
    expect(mine.write(st, K, [ka])).toBe(true);
    expect(mine.taken(K, ka)).toBe(false);
  });

  it('guard (R-a): bytes a hand wrote after a ledger write that dropped nothing take nothing, whatever the sidecar names', () => {
    const st = storage();
    expect(createQueueKeyGuard().write(st, K, [a('k-a')])).toBe(true);
    const mine = createQueueKeyGuard();
    const [ka] = mine.load(st, K);
    const other = createQueueKeyGuard();
    const theirs = other.load(st, K);
    expect(other.write(st, K, [...theirs, a('k-other')])).toBe(true); // the sidecar's earlier side names k-a
    st.setItem(K, JSON.stringify([a('k-other')])); // a hand writes bytes with no token
    expect(mine.write(st, K, [ka])).toBe(true);
    expect(mine.taken(K, ka)).toBe(false);
  });

  it('forced probe (Stage 1 gap-check, gap 1): a write over set-aside bytes takes nothing: k-a stays this tab\'s', () => {
    const st = storage();
    expect(createQueueKeyGuard().write(st, K, [a('k-a')])).toBe(true);
    const mine = createQueueKeyGuard();
    const [ka] = mine.load(st, K);
    st.setItem(K, '{damaged');
    const other = createQueueKeyGuard(); // opened after the damage: it never held k-a
    expect(other.load(st, K)).toEqual([]);
    other.heard(st, K, []);
    expect(other.setAside(st, [K])).toBe('ok');
    expect(other.writeAll(st, [{ key: K, mine: [a('k-other')], takes: () => true }])).toBe('all');
    expect(mine.write(st, K, [ka])).toBe(true);
    expect(mine.taken(K, ka)).toBe(false);
    expect(ids(st)).toEqual(['k-other', 'k-a']);
  });

  it('guard: a load of the key ends what was taken: k-a stored there again is this tab\'s again', () => {
    const st = storage();
    expect(createQueueKeyGuard().write(st, K, [a('k-a')])).toBe(true);
    const mine = createQueueKeyGuard();
    const other = createQueueKeyGuard();
    mine.load(st, K);
    other.load(st, K);
    expect(other.write(st, K, [])).toBe(true);
    expect(mine.write(st, K, [a('k-a'), a('n1')])).toBe(true);
    expect(createQueueKeyGuard().write(st, K, [a('k-a'), a('n1')])).toBe(true); // a third tab stores k-a again
    expect(mine.load(st, K).map((o) => (o as { idempotencyKey: string }).idempotencyKey)).toEqual(['k-a', 'n1']);
    expect(mine.write(st, K, [a('k-a'), a('n1')])).toBe(true);
    expect(ids(st)).toEqual(['k-a', 'n1']);
  });
});
