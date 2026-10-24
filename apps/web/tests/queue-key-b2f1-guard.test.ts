import { describe, it, expect, afterEach } from 'vitest';
import type { OutboxOp } from '@/data/apiGateway';
import { createQueueKeyGuard, queueActIdent } from '@/store/queueKeyGuard';
import { underQueueLock, writeQueueKey } from '@/store/queueKeyLock';
import { holdQueueLock, releaseQueueLocks } from './queueWrites';

/**
 * WEB-02 step B2f-1: the locked writer (`queueKeyLock.ts`) around main's guard, and what the guard keeps while a write
 * waits for its lock (`ask`, `asked`, `unwritten`, `unsavedCount`). The writes themselves are main's, unchanged.
 */
const key = 'vitan.outbox.dev:u-pmc.p-1';
const approve = (k: string): OutboxOp => ({ t: 'approve', decisionId: 'd-1', optionIndex: 0, idempotencyKey: k });
const idents = (list: OutboxOp[]) => list.map(queueActIdent);
const named = (prefix: string) => Object.keys(localStorage).filter((x) => x.startsWith(prefix));

afterEach(() => {
  releaseQueueLocks();
  localStorage.clear();
});

describe('B2f-1: the lock', () => {
  it('a write runs only once another tab lets the key’s lock go, and two keys’ locks are apart', async () => {
    const other = holdQueueLock(key);
    await other.has;
    const order: string[] = [];
    const waiting = underQueueLock(key, () => { order.push('mine'); return 1; });
    expect(await underQueueLock('vitan.siteVisitQueue.dev:u-pmc.p-1', () => 2)).toBe(2);
    expect(order).toEqual([]);
    other.release();
    expect(await waiting).toBe(1);
    expect(order).toEqual(['mine']);
  });

  it('with no lock to be had it runs nothing and answers null', async () => {
    const locks = Object.getOwnPropertyDescriptor(navigator, 'locks')!;
    Object.defineProperty(navigator, 'locks', { value: undefined, configurable: true });
    try {
      let ran = false;
      expect(await underQueueLock(key, () => { ran = true; })).toBeNull();
      expect(ran).toBe(false);
    } finally {
      Object.defineProperty(navigator, 'locks', locks);
    }
  });

  it('a scope switch before the lock is granted does not keep an act this tab sent in the old key', async () => {
    const m = new Map<string, string>();
    const st = { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v); } };
    const legacy = { t: 'approve', decisionId: 'DL-9', optionIndex: 1 } as OutboxOp; // no key: sent again would be a second effect
    st.setItem(key, JSON.stringify([legacy]));
    const q = createQueueKeyGuard();
    q.load(st, key);
    // the flush sent it; its write of [] waits behind another tab, and the scope moves meanwhile
    const other = holdQueueLock(key);
    await other.has;
    const written = writeQueueKey(q, st, key, []);
    q.forget();
    q.load(st, 'vitan.outbox.dev:u-pmc.p-2');
    other.release();
    expect(await written).toBe(true);
    expect(st.getItem(key)).toBe('[]');
  });
});

describe('B2f-1: what the guard keeps while a write waits (B1a records)', () => {
  it('ask keeps the acts the key does not hold in a made record; the landed write lets it go', () => {
    localStorage.setItem(key, JSON.stringify([approve('k-1')]));
    const g = createQueueKeyGuard();
    g.load(localStorage, key);
    const n = g.ask(localStorage, key, [approve('k-1'), approve('k-2')]);
    const records = named(`vitan.made.${key}.`).map((x) => idents(JSON.parse(localStorage.getItem(x)!) as OutboxOp[]));
    expect(records).toEqual([[queueActIdent(approve('k-2'))]]);
    expect(g.unsavedCount()).toBe(1);
    g.asked(n);
    expect(g.unsavedCount()).toBe(0);
    expect(g.write(localStorage, key, [approve('k-1'), approve('k-2')])).toBe(true);
    expect(named(`vitan.made.${key}.`)).toEqual([]);
  });

  it('a write with no lock to be had keeps the made record its ask made, so a reload takes the act back', () => {
    localStorage.setItem(key, '[]');
    const g = createQueueKeyGuard();
    g.load(localStorage, key);
    const n = g.ask(localStorage, key, [approve('k-1')]);
    g.asked(n);
    g.unwritten(localStorage, key, [approve('k-1')]);
    expect(idents(createQueueKeyGuard().load(localStorage, key))).toEqual([queueActIdent(approve('k-1'))]);
  });

  it('the reload question counts one act both held stranded and waiting for its lock once', () => {
    const g = createQueueKeyGuard(() => {});
    expect(g.keepUnsent(null, key, [approve('k-a')], [], (l) => l)).toBe(false); // stranded
    g.ask(localStorage, key, [approve('k-a')]); // memory, handed it back, writes it again; the write waits
    expect(g.unsavedCount()).toBe(1);
  });
});
