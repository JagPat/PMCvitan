import 'fake-indexeddb/auto';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { act } from '@testing-library/react';
import { useStore, getInitialState } from '@/store/store';
import type { ApiGateway, OutboxOp } from '@/data/apiGateway';
import { createQueueKeyGuard } from '@/store/queueKeyGuard';
import { recordMade } from '@/store/queueActRecord';
import { holdQueueLock, queueWritten, releaseQueueLocks } from './queueWrites';

/**
 * WEB-02 L2b (plan r3 v4 step 4; Board R-L2-1 ruling, #1094 6392513851): every write of a stored queue key goes through
 * the occurrence ledger, with its write token, and every act this tab holds has one occurrence id. Replaces #1106 (B1
 * U1). Its findings, each a forced probe red at main 22f5560 by assertion (`probes/at-22f5560.txt`):
 * - Codex 4349463910 (#1086), 4338427583 (#1051), #1071 F3: another tab's act stored after this tab's load was written
 *   over at this tab's next save.
 * - Codex 4344812888 (#1084): this tab's acts went first, so a visit closed here was sent before a guest another tab
 *   added to it earlier.
 * - Codex 4360928298 (#1099 r3): an absent key was read as "every act taken".
 * - Codex 4360928338 (#1099 r3) and the B1a residual: two identical unkeyed acts shared one settled mark.
 * - #1106 r1: 4362814041, 4362814051, 4362814059 (identical acts matched as one).
 * - #1106 r2: 4363345408 (a made-record occurrence beside its stored twin), 4363345418 (a stale mark when restoring an
 *   absent key), 4363345429 (a stranded duplicate ahead of the stored queue).
 * Each probe waits on the queue's locks and the gateway's calls, never a clock.
 */
const USER = 'u-pmc';
const P = 'p-1';
const key = `vitan.outbox.dev:${USER}.${P}`;
const lane = `vitan.siteVisitQueue.dev:${USER}.${P}`;
const s = () => useStore.getState();
const approve = (k: string): OutboxOp => ({ t: 'approve', decisionId: 'd-1', optionIndex: 0, idempotencyKey: k });
const close = (k: string): OutboxOp => ({ t: 'siteVisitClose', visitId: 'v-1', reason: 'done', idempotencyKey: k });
const guest = (k: string): OutboxOp => ({ t: 'siteVisitAddAttendee', visitId: 'v-1', name: 'Mr Mehta', body: { id: '1c0d9e8f-7a6b-4c5d-9e3f-2a1b0c9d8e7f', guestName: 'Mr Mehta' }, idempotencyKey: k });
/** an act with no idempotency key: its identity is its bytes */
const U = { t: 'submitInspection', inspectionId: 'i-1', items: [] } as unknown as OutboxOp;
const A = approve('a');
/** the key's acts, without the write token a ledger write puts first (null when absent) */
const stored = (k = key) => {
  const v = JSON.parse(localStorage.getItem(k) ?? 'null') as { t?: string }[] | null;
  return v === null ? null : (v.filter((o) => o?.t !== 'vitan.writeToken') as OutboxOp[]);
};
const keysOf = (k = key) => (stored(k) ?? []).map((o) => (o as { idempotencyKey?: string }).idempotencyKey);
const marks = () => Object.keys(localStorage).filter((x) => x.startsWith(`vitan.settled.${key}.`));
const records = () => Object.keys(localStorage).filter((x) => x.startsWith(`vitan.made.${key}.`));
/** this phone's storage, refusing every write of the names `refused` takes (storage full) */
const refusing = (refused: (name: string) => boolean) => ({
  getItem: (n: string) => localStorage.getItem(n),
  setItem: (n: string, v: string) => { if (refused(n)) throw new DOMException('full', 'QuotaExceededError'); localStorage.setItem(n, v); },
  removeItem: (n: string) => localStorage.removeItem(n),
  key: (n: number) => localStorage.key(n),
  get length() { return localStorage.length; },
});

type Store = typeof useStore;
function signedIn(st: Store, online = false, gw: Record<string, unknown> = {}) {
  st.setState({ ...getInitialState(), outbox: [], role: 'pmc', lang: 'en', sessionUserId: USER, activeProjectId: P, online });
  st.getState()._setGateway({ project: P, listSiteVisits: vi.fn(async () => []), snapshot: vi.fn(async () => null), ...gw } as unknown as ApiGateway);
  st.getState().hydrateOutbox();
}
/** a page opens (or reloads): a fresh store module over this phone's storage, signed in */
async function page(online: boolean, gw: Record<string, unknown> = {}): Promise<Store> {
  vi.resetModules();
  const fresh = (await import('@/store/store')).useStore;
  signedIn(fresh, online, gw);
  return fresh;
}

afterEach(() => {
  vi.restoreAllMocks();
  s().completeSignOut();
  s()._setGateway(null);
  localStorage.clear();
});

describe('L2b: forced probes through the store', () => {
  it('forced probe (4349463910, 4338427583, #1071 F3): an act another tab stored after this tab loaded the key stays at this tab’s next save', async () => {
    localStorage.setItem(key, JSON.stringify([approve('k-a')]));
    signedIn(useStore);
    localStorage.setItem(key, JSON.stringify([approve('k-a'), approve('k-other')])); // another tab, after this one loaded
    act(() => { s().startActivity('B-1'); });
    await queueWritten();
    expect(keysOf()).toContain('k-other');
    expect(keysOf()[0]).toBe('k-a');
  });

  it('forced probe (4344812888): a guest another tab added first stays first; this tab’s close goes after it', async () => {
    signedIn(useStore);
    localStorage.setItem(lane, JSON.stringify([guest('k-guest')])); // another tab, after this one loaded
    act(() => { s().queueSiteVisitAct(close('k-close'), 'saved offline'); });
    await queueWritten();
    expect(keysOf(lane)).toEqual(['k-guest', 'k-close']);
  });

  it('forced probe (4360928338, the B1a residual): the first of two identical unkeyed acts is sent and the second fails; the key holds one, and a reload sends one', async () => {
    localStorage.setItem(key, JSON.stringify([U, U]));
    const submitInspection = vi.fn().mockResolvedValueOnce(null).mockRejectedValueOnce(new TypeError('Failed to fetch')).mockResolvedValue(null);
    const first = await page(true, { submitInspection });
    await first.getState().flushOutbox();
    await queueWritten();
    expect(submitInspection).toHaveBeenCalledTimes(2);
    expect(stored()).toEqual([U]);
    const reloaded = await page(true, { submitInspection });
    expect(reloaded.getState().outbox).toEqual([U]);
    await reloaded.getState().flushOutbox();
    await queueWritten();
    expect(submitInspection).toHaveBeenCalledTimes(3);
    expect(stored()).toEqual([]);
    expect(marks()).toEqual([]);
  });

  it('forced probe (the B1a residual, the flush’s marks): both identical unkeyed acts are sent and the key cannot be written after; a reload sends neither again', async () => {
    localStorage.setItem(key, JSON.stringify([U, U]));
    let full = false;
    const submitInspection = vi.fn().mockResolvedValueOnce(null).mockImplementationOnce(async () => { full = true; return null; }).mockResolvedValue(null);
    const setItem = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, k: string, v: string) {
      if (full && (k === key || k.startsWith('vitan.occ.'))) throw new DOMException('full', 'QuotaExceededError');
      setItem.call(this, k, v);
    });
    const first = await page(true, { submitInspection });
    await first.getState().flushOutbox();
    await queueWritten();
    expect(submitInspection).toHaveBeenCalledTimes(2);
    expect(stored()).toEqual([U, U]); // the end write did not land
    vi.restoreAllMocks();
    const reloaded = await page(false);
    expect(reloaded.getState().outbox).toEqual([]);
  });
});

describe('L2b: forced probes at the guard', () => {
  it('forced probe (the B1a residual): the first of two identical unkeyed acts is sent and marked; the next load still owes the second', () => {
    const g = createQueueKeyGuard();
    localStorage.setItem(key, JSON.stringify([U, U]));
    const [first, second] = g.load(localStorage, key);
    expect(g.settled(localStorage, key, first)).toBe(true);
    // a page closed before the flush's end write: the key still holds both
    expect(createQueueKeyGuard().load(localStorage, key)).toEqual([U]);
    expect(g.write(localStorage, key, [second])).toBe(true);
    expect(stored()).toEqual([U]);
    expect(createQueueKeyGuard().load(localStorage, key)).toEqual([U]);
    expect(marks()).toEqual([]);
  });

  it('forced probe (4360928298): a key another tab cleared before this tab’s write gets every memory act back', () => {
    const g = createQueueKeyGuard();
    localStorage.setItem(key, JSON.stringify([approve('a')]));
    const mine = g.load(localStorage, key);
    localStorage.removeItem(key);
    expect(g.write(localStorage, key, [...mine, approve('b')])).toBe(true);
    expect(keysOf()).toEqual(['a', 'b']);
  });

  it('R2: an act this tab held that another tab sent and wrote out of the key is not put back by this tab’s next write', () => {
    const g = createQueueKeyGuard();
    g.load(localStorage, key);
    const mine = [approve('a'), approve('b')];
    expect(g.write(localStorage, key, mine)).toBe(true);
    // another tab of this release sends b and writes the key without it
    const other = createQueueKeyGuard();
    const theirs = other.load(localStorage, key);
    expect(other.settled(localStorage, key, theirs[1])).toBe(true);
    expect(other.write(localStorage, key, [theirs[0]])).toBe(true);
    expect(g.write(localStorage, key, [...mine, approve('c')])).toBe(true);
    expect(keysOf()).toEqual(['a', 'c']);
  });

  it('forced probe (4362814041): [U, A, U], the first U sent and A failed; the end write stores [A, U]', () => {
    localStorage.setItem(key, JSON.stringify([U, A, U]));
    const g = createQueueKeyGuard();
    const [u1, a, u2] = g.load(localStorage, key);
    expect(g.settled(localStorage, key, u1)).toBe(true);
    expect(g.write(localStorage, key, [a, u2])).toBe(true);
    expect(stored()).toEqual([A, U]);
    expect(createQueueKeyGuard().load(localStorage, key)).toEqual([A, U]);
  });

  it('forced probe (4362814041, during the flush): memory still holds the sent U; a write stores [A, U]', () => {
    localStorage.setItem(key, JSON.stringify([U, A, U]));
    const g = createQueueKeyGuard();
    const loaded = g.load(localStorage, key);
    expect(g.settled(localStorage, key, loaded[0])).toBe(true);
    expect(g.write(localStorage, key, loaded)).toBe(true);
    expect(stored()).toEqual([A, U]);
  });

  it('forced probe (4362814051): two stranded U beside one U in the key both come back', () => {
    localStorage.setItem(key, JSON.stringify([U]));
    const g = createQueueKeyGuard();
    g.load(localStorage, key);
    // the scope moved with storage out of reach: both unsent acts are held stranded
    expect(g.keepUnsent(null, key, [{ ...U }, { ...U }], [], (l) => l)).toBe(false);
    expect(g.load(localStorage, key)).toEqual([U, U, U]);
  });

  it('forced probe (4362814059): another tab appends an identical U after this tab loaded one; this tab’s write keeps both', () => {
    const g = createQueueKeyGuard();
    g.load(localStorage, key);
    const mine = [{ ...U }];
    expect(g.write(localStorage, key, mine)).toBe(true);
    // another tab of this release loads it and appends an identical one
    const other = createQueueKeyGuard();
    expect(other.write(localStorage, key, [...other.load(localStorage, key), { ...U }])).toBe(true);
    expect(g.write(localStorage, key, mine)).toBe(true);
    expect(stored()).toEqual([U, U]);
  });

  it('forced probe (4363345408): a made-record occurrence beside its stored twin comes back, and is written once', () => {
    localStorage.setItem(key, JSON.stringify([U]));
    const g = createQueueKeyGuard();
    const mine = g.load(localStorage, key);
    // a second, identical act; the key write and the copy aside both fail, so it is kept in a made record
    const full = refusing((n) => n === key || n.startsWith('vitan.unreadable.') || n.startsWith('vitan.occ.'));
    expect(g.write(full, key, [...mine, { ...U }])).toBe(false);
    expect(records()).toHaveLength(1);
    const reloaded = createQueueKeyGuard();
    const back = reloaded.load(localStorage, key);
    expect(back).toEqual([U, U]);
    expect(reloaded.write(localStorage, key, back)).toBe(true);
    expect(stored()).toEqual([U, U]);
    expect(records()).toEqual([]);
    expect(createQueueKeyGuard().load(localStorage, key)).toEqual([U, U]);
  });

  it('forced probe (4363345418): the first of two identical acts settles, another tab clears the key, and the restored second is still owed', () => {
    localStorage.setItem(key, JSON.stringify([U, U]));
    const g = createQueueKeyGuard();
    const [first, second] = g.load(localStorage, key);
    expect(g.settled(localStorage, key, first)).toBe(true);
    localStorage.removeItem(key); // another tab cleared the queue before this flush's end write
    expect(g.write(localStorage, key, [second])).toBe(true);
    expect(stored()).toEqual([U]);
    expect(createQueueKeyGuard().load(localStorage, key)).toEqual([U]);
  });

  it('forced probe (4363345429): a stranded duplicate stays ahead of the stored queue', () => {
    localStorage.setItem(key, JSON.stringify([U, A]));
    const g = createQueueKeyGuard();
    const loaded = g.load(localStorage, key);
    // the scope moved during the flush with storage out of reach: the loaded U and A and a new U are held stranded
    expect(g.keepUnsent(null, key, [{ ...U }, ...loaded], [], (l) => l)).toBe(false);
    const back = g.load(localStorage, key);
    expect(back).toEqual([U, U, A]);
    expect(g.write(localStorage, key, back)).toBe(true);
    expect(stored()).toEqual([U, U, A]);
  });

  it('two identical unkeyed acts a full key cannot store are two not kept, and none is counted twice', () => {
    localStorage.setItem(key, '[]');
    const g = createQueueKeyGuard();
    g.load(localStorage, key);
    const full = refusing((n) => n === key || n.startsWith('vitan.unreadable.') || n.startsWith('vitan.occ.'));
    expect(g.write(full, key, [{ ...U }, { ...U }])).toBe(false);
    expect(g.notKeptCount()).toBe(2);
    expect(g.notKeptCount() + g.strandedCount()).toBe(2);
  });
});

describe('L2b: the write and its release (plan r3 v4 §2)', () => {
  it('a landed write carries a write token first, and a load reads the key back exactly', () => {
    const g = createQueueKeyGuard();
    g.load(localStorage, key);
    expect(g.write(localStorage, key, [{ ...U }, { ...U }])).toBe(true);
    const raw = JSON.parse(localStorage.getItem(key)!) as { t: string }[];
    expect(raw[0].t).toBe('vitan.writeToken');
    expect(createQueueKeyGuard().load(localStorage, key)).toEqual([U, U]);
  });

  it('forced probe (the re-check): a write that lands between the token check and the record removal puts the record back', () => {
    localStorage.setItem(key, JSON.stringify([]));
    const g = createQueueKeyGuard();
    g.load(localStorage, key);
    // a write that waited for its lock kept its act in a made record
    const ask = g.ask(localStorage, key, [approve('k-1')]);
    expect(records()).toHaveLength(1);
    const kept = records()[0];
    const keptRaw = localStorage.getItem(kept)!;
    // another writer lands on the key the moment the record is removed (the record's removal is the gap)
    const st = {
      ...refusing(() => false),
      removeItem: (n: string) => { localStorage.removeItem(n); if (n === kept) localStorage.setItem(key, JSON.stringify([{ t: 'vitan.writeToken', n: 'ffffffffffffffffffffffffffffffff' }])); },
    };
    g.asked(ask);
    expect(g.write(st, key, [approve('k-1')])).toBe(true);
    expect(localStorage.getItem(kept), 'the record is put back, byte for byte').toBe(keptRaw);
  });

  it('G1: a keyless photo keyed at load keeps its occurrence and its place', () => {
    const photo = { t: 'uploadMedia', input: { kind: 'progress', mime: 'image/jpeg', data: 'AAAA', nodeId: 'slab-1' } } as unknown as OutboxOp;
    localStorage.setItem(key, JSON.stringify([photo, A]));
    const g = createQueueKeyGuard();
    const [p, a] = g.load(localStorage, key);
    const keyedPhoto = { ...p, input: { ...(p as { input: object }).input, clientKey: 'legacy-photo-x-0' } } as OutboxOp;
    g.adopt?.(key, p, keyedPhoto); // main has no adopt: its write is memory whole, so this row is a guard there
    expect(g.write(localStorage, key, [keyedPhoto, a])).toBe(true);
    expect(stored()).toEqual([keyedPhoto, A]);
  });
});

describe('L2b: the old unscoped queue is adopted through the locked write (gap check 9)', () => {
  afterEach(() => { releaseQueueLocks(); });
  const legacy = { t: 'startActivity', activityId: 'ACT-31' } as unknown as OutboxOp;

  it('guard: two loads of the scope while the adoption’s write waits for its lock take the act once, and send it once', async () => {
    const startActivity = vi.fn(async () => null);
    localStorage.setItem('vitan.outbox', JSON.stringify([legacy]));
    const other = holdQueueLock(key);
    await other.has;
    signedIn(useStore, false, { startActivity });
    act(() => { s().hydrateOutbox(); });
    expect(s().outbox).toEqual([legacy]);
    other.release();
    await queueWritten();
    expect(stored()).toEqual([legacy]);
    expect(localStorage.getItem('vitan.outbox')).toBeNull();
    useStore.setState({ online: true });
    await act(async () => { await s().flushOutbox(); });
    expect(startActivity).toHaveBeenCalledTimes(1);
  });

  it('audit (gap check 9): a load after the adoption’s write was refused takes the act once, from the record that write kept', async () => {
    localStorage.setItem('vitan.outbox', JSON.stringify([legacy]));
    const real = Storage.prototype.setItem;
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, k: string, v: string) {
      if (k === key) throw new DOMException('full', 'QuotaExceededError');
      return real.call(this, k, v);
    });
    signedIn(useStore);
    await queueWritten();
    spy.mockRestore();
    expect(records()).toHaveLength(1);
    act(() => { s().hydrateOutbox(); });
    await queueWritten();
    expect(s().outbox).toEqual([legacy]);
    // the old bytes are copied aside, never adopted again; the record keeps the act until a write stores it
    expect(localStorage.getItem('vitan.outbox')).toBeNull();
    expect(records()).toHaveLength(1);
    act(() => { s().hydrateOutbox(); });
    expect(s().outbox).toEqual([legacy]);
  });
});

describe('L2b: a page closed mid-write keeps every act once (plan r3 v4 frozen-tab rows, through the store)', () => {
  const side = `vitan.occ.${key}`;
  /** the page closes at the storage call `at` names: that call and every one after it reach no storage */
  const closesAt = (at: (op: 'set' | 'remove', name: string, nth: number) => boolean) => {
    let closed = false;
    const seen = new Map<string, number>();
    const gone = (op: 'set' | 'remove', name: string) => {
      const n = (seen.get(`${op}:${name}`) ?? 0) + 1;
      seen.set(`${op}:${name}`, n);
      if (!closed && at(op, name, n)) closed = true;
      if (closed) throw new DOMException('the page is gone', 'InvalidStateError');
    };
    const realSet = Storage.prototype.setItem;
    const realRemove = Storage.prototype.removeItem;
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, k: string, v: string) { gone('set', k); return realSet.call(this, k, v); });
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(function (this: Storage, k: string) { gone('remove', k); return realRemove.call(this, k); });
    return { closed: () => closed, restore: () => { vi.restoreAllMocks(); } };
  };
  /** this tab queues a start offline beside the stored approval, and the page closes at `at` */
  const queuedThenClosed = async (at: Parameters<typeof closesAt>[0]) => {
    localStorage.setItem(key, JSON.stringify([approve('k-a')]));
    const first = await page(false);
    const page1 = closesAt(at);
    act(() => { first.getState().startActivity('B-1'); });
    await queueWritten();
    expect(page1.closed()).toBe(true);
    page1.restore();
  };
  /** the next page sends each act once, and the key ends empty */
  const sentOnce = async () => {
    const approveDecision = vi.fn(async () => null);
    const startActivity = vi.fn(async () => null);
    const next = await page(true, { approveDecision, startActivity });
    expect(next.getState().outbox.map((o) => o.t).sort()).toEqual(['approve', 'startActivity']);
    await next.getState().flushOutbox();
    await queueWritten();
    expect([approveDecision.mock.calls.length, startActivity.mock.calls.length]).toEqual([1, 1]);
    expect(stored()).toEqual([]);
    const after = await page(true, { approveDecision, startActivity });
    expect(after.getState().outbox).toEqual([]);
  };

  it('closed between the pending sidecar and the key: the next page takes the start from its made record, once', async () => {
    await queuedThenClosed((op, name) => op === 'set' && name === key);
    expect(keysOf()).toEqual(['k-a']);
    await sentOnce();
  });

  it('closed between the key and the commit: the pending side carries the key’s token, so the key names its acts; each once', async () => {
    await queuedThenClosed((op, name, n) => op === 'set' && name === side && n === 2);
    expect(stored()?.map((o) => o.t)).toEqual(['approve', 'startActivity']);
    await sentOnce();
  });

  it('closed between the commit and the release: the sent approval’s mark stays, and it is never sent again', async () => {
    localStorage.setItem(key, JSON.stringify([approve('k-a')]));
    const approveDecision = vi.fn(async () => null);
    const first = await page(true, { approveDecision });
    const page1 = closesAt((op, name) => op === 'remove' && name.startsWith(`vitan.settled.${key}.`));
    await first.getState().flushOutbox();
    await queueWritten();
    expect(page1.closed()).toBe(true);
    page1.restore();
    expect(stored()).toEqual([]);
    expect(marks()).toHaveLength(1);
    const next = await page(true, { approveDecision });
    expect(next.getState().outbox).toEqual([]);
    await next.getState().flushOutbox();
    expect(approveDecision).toHaveBeenCalledTimes(1);
  });
});

describe('L2b: the plan draft 2 re-check (notes/coordinator/web02-L2b-plan-recheck.md)', () => {
  afterEach(() => { releaseQueueLocks(); });

  it('N1: the old scope’s write keeps another tab’s act, after this tab’s unsent one', () => {
    localStorage.setItem(key, JSON.stringify([approve('k-a'), approve('k-b')]));
    const g = createQueueKeyGuard();
    const [a, b] = g.load(localStorage, key);
    const other = createQueueKeyGuard();
    expect(other.write(localStorage, key, [...other.load(localStorage, key), approve('k-x')])).toBe(true);
    // the flush sent a; b is unsent; the scope moved
    expect(g.keepUnsent(localStorage, key, [b], [a], (l) => l)).toBe(true);
    expect(keysOf()).toEqual(['k-b', 'k-x']);
  });

  it('N1: `after` moves a stored act this tab held, and another tab’s act stays', () => {
    localStorage.setItem(lane, JSON.stringify([close('k-a'), guest('k-moved')]));
    const g = createQueueKeyGuard();
    const [a] = g.load(localStorage, lane);
    const other = createQueueKeyGuard();
    expect(other.write(localStorage, lane, [...other.load(localStorage, lane), guest('k-x')])).toBe(true);
    // the flush sent a; its move drops the act it re-made on the open visit (remapVisits)
    expect(g.keepUnsent(localStorage, lane, [], [a], (l) => l.filter((o) => (o as { idempotencyKey?: string }).idempotencyKey !== 'k-moved'))).toBe(true);
    expect(keysOf(lane)).toEqual(['k-x']);
  });

  it('N2: a 22f5560 record holding a keyed act the key also holds is spent at the next write, even once the act is removed', () => {
    localStorage.setItem(key, JSON.stringify([approve('k-p')]));
    expect(recordMade(localStorage, key, [approve('k-p')])).toBe(true);
    const g = createQueueKeyGuard();
    expect(g.load(localStorage, key)).toEqual([approve('k-p')]);
    // the person removes it (a deleted photo, say) before any write: memory holds none
    expect(g.write(localStorage, key, [])).toBe(true);
    expect(records()).toEqual([]);
    expect(createQueueKeyGuard().load(localStorage, key)).toEqual([]);
  });

  it('N2: the store’s keyed-photo dedupe hands the guard the dropped copy, and its record goes at the next write', () => {
    localStorage.setItem(key, JSON.stringify([approve('k-p')]));
    expect(recordMade(localStorage, key, [approve('k-p')])).toBe(true);
    const g = createQueueKeyGuard();
    const loaded = g.load(localStorage, key);
    // as the store's dedupe does for a photo keyed at load beside its record's keyed copy
    const dropped = { ...loaded[0] } as OutboxOp;
    g.merge?.(key, dropped); // main has no merge: there this row is red by assertion
    expect(g.write(localStorage, key, [])).toBe(true);
    expect(records()).toEqual([]);
  });

  it('gap check 2: a write during the flush leaves out the act it sent, even when that act’s mark could not be made', () => {
    localStorage.setItem(key, JSON.stringify([approve('k-a'), approve('k-s')]));
    const g = createQueueKeyGuard();
    const [a, k] = g.load(localStorage, key);
    // the flush sent a; its mark is refused (storage full for marks)
    expect(g.settled(refusing((n) => n.startsWith(`vitan.settled.${key}.`)), key, a)).toBe(false);
    // a new act's write-ahead while memory still holds a (the flush's end write has not run)
    expect(g.write(localStorage, key, [a, k, approve('k-new')])).toBe(true);
    expect(keysOf(), 'the sent act is not written back').toEqual(['k-s', 'k-new']);
    expect(createQueueKeyGuard().load(localStorage, key).map((o) => (o as { idempotencyKey: string }).idempotencyKey)).toEqual(['k-s', 'k-new']);
  });

  it('gap check 9: two loads while the adoption’s write waits and its record cannot be made take the act once, and send it once', async () => {
    const legacy = { t: 'startActivity', activityId: 'ACT-31' } as unknown as OutboxOp;
    const startActivity = vi.fn(async () => null);
    localStorage.setItem('vitan.outbox', JSON.stringify([legacy]));
    const real = Storage.prototype.setItem;
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, k: string, v: string) {
      if (k.startsWith('vitan.made.')) throw new DOMException('full', 'QuotaExceededError');
      return real.call(this, k, v);
    });
    const other = holdQueueLock(key);
    await other.has;
    signedIn(useStore, false, { startActivity });
    act(() => { s().hydrateOutbox(); }); // the second load, while the first adoption's write still waits
    spy.mockRestore();
    other.release();
    await queueWritten();
    expect(stored(), 'the key holds it once').toEqual([legacy]);
    expect(s().outbox).toEqual([legacy]);
    useStore.setState({ online: true });
    await act(async () => { await s().flushOutbox(); });
    expect(startActivity).toHaveBeenCalledTimes(1);
    expect(stored()).toEqual([]);
  });
});
