import 'fake-indexeddb/auto';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { act } from '@testing-library/react';
import { useStore, getInitialState } from '@/store/store';
import type { ApiGateway, OutboxOp } from '@/data/apiGateway';
import { createQueueKeyGuard } from '@/store/queueKeyGuard';
import { holdQueueLock, queueWritten, releaseQueueLocks, storedQueue } from './queueWrites';

/**
 * WEB-02 U3 (plan r3 v4; part of the #1099 replacement, U3 of 4): a key another tab makes unreadable, and Set aside's
 * commit point. Its findings, each a forced probe red at main 9a95dc5 by assertion (`probes/at-9a95dc5.txt`):
 * - Codex 4353751507 (#1086): after another tab made the key unreadable, this tab still sent the acts it had loaded
 *   from it. That tab's bytes may hold them.
 * - Codex 4344812904 (#1084): a key that turned unreadable on another tab's write left this tab's acts only in memory.
 * - Codex 4358186342 (#1099 r1): a key another tab cleared was read as nothing to lose: Reload asked nothing.
 * - Codex 4358186333 (#1099 r1): Set aside, after waiting for the locks, copied and wrote over bytes another tab changed
 *   meanwhile.
 * - Codex 4360928324 (#1099 r3): a Set aside that rolled back did not restore what it had withheld.
 * - Codex 4360928316 (#1099 r3): a rollback that could not put a key back ('some') was not shown as a failure.
 * - The transition audit: a Set aside that rolled back left the restored bytes marked as copied aside, so the next
 *   ordinary write wrote over them.
 * Each probe waits on the queue's locks and the gateway's calls, never a clock.
 */
const USER = 'u-pmc';
const P = 'p-1';
const key = `vitan.outbox.dev:${USER}.${P}`;
const lane = `vitan.siteVisitQueue.dev:${USER}.${P}`;
const s = () => useStore.getState();
const approve = (k: string): OutboxOp => ({ t: 'approve', decisionId: 'd-1', optionIndex: 0, idempotencyKey: k });
const end = (k: string): OutboxOp => ({ t: 'siteVisitEnd', visitId: '00000000-0000-4000-8000-000000000001', claimedAt: '2026-10-14T05:30:00.000Z', idempotencyKey: k });
const NEWER = JSON.stringify([{ t: 'aKindFromANewerRelease', idempotencyKey: 'k-newer' }]);
const DAMAGED = '{damaged';
/** an act with no idempotency key: its identity is its bytes */
const U = { t: 'submitInspection', inspectionId: 'i-1', items: [] } as unknown as OutboxOp;
const LANE_DAMAGED = '{lane damaged';
const keysIn = (raw: string | null) => storedQueue<{ idempotencyKey?: string; t?: string }>(raw).map((o) => o.idempotencyKey ?? o.t);
const copiesOf = (k: string) => Object.keys(localStorage).filter((x) => x.startsWith(`vitan.unreadable.${k}.`)).map((x) => localStorage.getItem(x));
const madeHere = () => s().outbox.filter((o) => o.t === 'startActivity');

function signedIn(general: string | null, visits: string | null = null, gw: Record<string, unknown> = {}) {
  if (general !== null) localStorage.setItem(key, general);
  if (visits !== null) localStorage.setItem(lane, visits);
  useStore.setState({ ...getInitialState(), outbox: [], role: 'pmc', lang: 'en', sessionUserId: USER, activeProjectId: P, online: false });
  s()._setGateway({ project: P, listSiteVisits: vi.fn(async () => []), snapshot: vi.fn(async () => null), ...gw } as unknown as ApiGateway);
  s().hydrateOutbox();
}
/** another tab writes `k` (null: removes it), and this tab hears it */
function otherTabWrites(k: string | null, raw: string | null) {
  if (k === null) localStorage.clear(); else if (raw === null) localStorage.removeItem(k); else localStorage.setItem(k, raw);
  act(() => { window.dispatchEvent(new StorageEvent('storage', { key: k, newValue: raw, storageArea: localStorage })); });
}
/** what the reload asks the person (nothing is reloaded) */
const reloadAsks = () => {
  const ask = vi.fn(() => false);
  vi.stubGlobal('confirm', ask);
  vi.stubGlobal('location', { ...window.location, reload: vi.fn() });
  act(() => s().reloadForNewerQueue());
  vi.unstubAllGlobals();
  return ask.mock.calls.map((c) => (c as unknown[])[0]);
};
/** this phone's storage refuses writes of the names `refused` takes (storage full), from now on */
const refusing = (refused: (name: string) => boolean) => {
  const real = Storage.prototype.setItem;
  return vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, n: string, v: string) {
    if (refused(n)) throw new DOMException('full', 'QuotaExceededError');
    real.call(this, n, v);
  });
};
const setAside = async () => { await act(async () => { await s().setAsideUnreadableQueue(); }); };
const goOnline = async () => { useStore.setState({ online: true }); await act(async () => { await s().flushOutbox(); }); };

afterEach(() => {
  releaseQueueLocks();
  s().completeSignOut();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  s()._setGateway(null);
  localStorage.clear();
  sessionStorage.clear();
});

describe('Codex 4353751507, 4344812904: a key another tab makes unreadable', () => {
  it('forced probe (4353751507): the act this tab loaded from it is copied aside, held in memory, and not sent', async () => {
    const approveDecision = vi.fn(async () => null);
    signedIn(JSON.stringify([approve('k-a')]), null, { approveDecision });
    expect(s().outbox).toEqual([approve('k-a')]);
    otherTabWrites(key, DAMAGED);
    expect(copiesOf(key)).toEqual([JSON.stringify([approve('k-a')])]);
    await goOnline();
    expect(approveDecision).not.toHaveBeenCalled();
    expect(localStorage.getItem(key)).toBe(DAMAGED);
    expect(s().outbox).toEqual([approve('k-a')]);
  });

  it('forced probe (4353751507, R3): two identical acts with no key loaded from it are both held, through the flush’s records', async () => {
    const submitInspection = vi.fn(async () => null);
    signedIn(JSON.stringify([U, U]), null, { submitInspection });
    expect(s().outbox).toEqual([U, U]);
    otherTabWrites(key, NEWER);
    await goOnline();
    await goOnline();
    expect(submitInspection).not.toHaveBeenCalled();
    expect(s().outbox).toEqual([U, U]);
  });

  it('forced probe (4344812904): this tab’s act the newer bytes do not hold is copied aside beside them', async () => {
    signedIn(null);
    act(() => { s().queueSiteVisitAct(end('k-mine'), 'saved offline'); });
    await queueWritten();
    otherTabWrites(lane, NEWER);
    expect(localStorage.getItem(lane)).toBe(NEWER);
    expect(copiesOf(lane)).toEqual([JSON.stringify([end('k-mine')])]);
    expect(s().queueUnreadable).toEqual([{ key: lane, read: 'newer', reloaded: false }]);
  });

  it('forced probe (gap check of 3302f45, gap 1): a general act made after a withheld one waits behind it, unsent', async () => {
    const startActivity = vi.fn(async () => null);
    signedIn(JSON.stringify([approve('k-a')]), null, { startActivity, approveDecision: vi.fn(async () => null) });
    otherTabWrites(key, DAMAGED);
    s().startActivity('B-1');
    await queueWritten();
    await goOnline();
    expect(startActivity).not.toHaveBeenCalled();
    expect(s().outbox.map((o) => o.t)).toEqual(['approve', 'startActivity']);
  });

  it('forced probe (gap check of 3302f45, gap 1): a later act of a withheld visit is not sent ahead of its start', async () => {
    const VID = '0b9c8d7e-6f5a-4b3c-8d2e-1f0a9b8c7d6e';
    const start = { t: 'siteVisitStart', idempotencyKey: 'k-s', visitor: { name: 'Priya Shah', role: 'pmc', placeName: null }, body: { id: VID, claimedAt: '2026-10-14T04:30:00.000Z' } } as unknown as OutboxOp;
    const close = { t: 'siteVisitEnd', visitId: VID, claimedAt: '2026-10-14T05:30:00.000Z', idempotencyKey: 'k-e' } as OutboxOp;
    const startSiteVisit = vi.fn(async () => ({ id: VID }));
    const endSiteVisit = vi.fn(async () => { throw Object.assign(new Error('no such visit'), { status: 404 }); });
    signedIn(null, null, { startSiteVisit, endSiteVisit });
    act(() => { s().queueSiteVisitAct(start, 'saved offline'); });
    await queueWritten();
    otherTabWrites(lane, NEWER);
    act(() => { s().queueSiteVisitAct(close, 'saved offline'); });
    await queueWritten();
    await goOnline();
    expect(startSiteVisit).not.toHaveBeenCalled();
    expect(endSiteVisit).not.toHaveBeenCalled();
    expect(s().outbox.map((o) => o.t)).toEqual(['siteVisitStart', 'siteVisitEnd']);
  });

  it('guard: an act made after the key turned unreadable, with nothing of this tab’s withheld, is sent', async () => {
    const startActivity = vi.fn(async () => null);
    signedIn(null, null, { startActivity });
    otherTabWrites(key, DAMAGED);
    s().startActivity('B-1');
    await queueWritten();
    await goOnline();
    expect(startActivity).toHaveBeenCalledTimes(1);
  });

  it('guard: once the key reads again, the act is sent', async () => {
    const approveDecision = vi.fn(async () => null);
    signedIn(JSON.stringify([approve('k-a')]), null, { approveDecision });
    otherTabWrites(key, DAMAGED);
    otherTabWrites(key, JSON.stringify([approve('k-a')]));
    await goOnline();
    expect(approveDecision).toHaveBeenCalledTimes(1);
  });
});

describe('Codex 4358186342: a key another tab cleared is not saved, never empty and sent', () => {
  for (const [how, which] of [['its key removed', key], ['storage cleared', null]] as const) {
    it(`forced probe (${how}): Reload asks about the act, and the next write puts it back`, async () => {
      signedIn(JSON.stringify([approve('k-a')]));
      expect(s().outbox).toEqual([approve('k-a')]);
      otherTabWrites(which, null);
      expect(reloadAsks()).toEqual(['1 updates aren’t saved on this phone and will be lost. Continue?']);
      s().startActivity('B-1');
      await queueWritten();
      expect(keysIn(localStorage.getItem(key))).toEqual(['k-a', madeHere()[0].idempotencyKey]);
      expect(reloadAsks()).toEqual([]);
    });
  }
});

describe('Codex 4358186342: what this tab saw in a cleared key says nothing of what was sent', () => {
  it('forced probe: another tab then stores its own act there, and this tab’s next write still puts its act back', async () => {
    signedIn(JSON.stringify([approve('k-a')]));
    otherTabWrites(key, null);
    // another tab of this release stores its own act in the cleared key, through the ledger
    const other = createQueueKeyGuard();
    other.load(localStorage, key);
    expect(other.write(localStorage, key, [approve('k-b')])).toBe(true);
    otherTabWrites(key, localStorage.getItem(key));
    // no made record can be kept while this tab's write waits for its lock, so `k-a` keeps the name this tab knew it by
    const full = refusing((n) => n.startsWith('vitan.made.'));
    s().startActivity('B-1');
    await queueWritten();
    full.mockRestore();
    expect(keysIn(localStorage.getItem(key))).toEqual(['k-b', 'k-a', madeHere()[0].idempotencyKey]);
  });
});

describe('Codex 4358186333: Set aside reads every key again once it holds the locks', () => {
  for (const told of [true, false]) {
    it(`forced probe: a damaged key replaced by a newer release's bytes while the tap waited is not touched${told ? '' : ' (its storage event not yet heard)'}`, async () => {
      signedIn(DAMAGED);
      expect(s().queueUnreadable).toEqual([{ key, read: 'damaged', reloaded: false }]);
      const other = holdQueueLock(key);
      await other.has;
      const tap = s().setAsideUnreadableQueue(); // waits behind the other tab's lock
      if (told) otherTabWrites(key, NEWER); else localStorage.setItem(key, NEWER);
      other.release();
      await act(async () => { await tap; });
      expect(localStorage.getItem(key)).toBe(NEWER);
      expect(copiesOf(key)).toEqual([]);
      expect(s().queueUnreadable).toEqual([{ key, read: 'newer', reloaded: false }]);
      expect(s().queueSetAsideFailed).toBe(false);
    });
  }

  it('forced probe (gap check of 3302f45, note 3): that tap takes down an earlier tap’s failure line', async () => {
    signedIn(DAMAGED);
    useStore.setState({ queueSetAsideFailed: true }); // an earlier tap failed
    const other = holdQueueLock(key);
    await other.has;
    const tap = s().setAsideUnreadableQueue();
    otherTabWrites(key, NEWER);
    other.release();
    await act(async () => { await tap; });
    expect(localStorage.getItem(key)).toBe(NEWER);
    expect(s().queueSetAsideFailed).toBe(false);
  });

  it('guard: an unchanged key is still set aside after the wait', async () => {
    signedIn(DAMAGED);
    const other = holdQueueLock(key);
    await other.has;
    const tap = s().setAsideUnreadableQueue();
    other.release();
    await act(async () => { await tap; });
    expect(copiesOf(key)).toEqual([DAMAGED]);
    expect(s().queueUnreadable).toEqual([]);
    expect(s().queueSetAsideFailed).toBe(false);
  });
});

describe('Codex 4360928324, 4360928316, the audit: a Set aside that rolls back leaves every cell as it was', () => {
  /** both keys listed: the general one made unreadable by another tab after this tab loaded `k-a` from it */
  const twoListed = (gw: Record<string, unknown> = {}) => {
    signedIn(JSON.stringify([approve('k-a')]), LANE_DAMAGED, gw);
    otherTabWrites(key, DAMAGED);
    expect(s().queueUnreadable.map((u) => u.key).sort()).toEqual([key, lane].sort());
  };

  it('forced probe (4360928324): the second key’s write fails, and the act withheld before the tap is still not sent', async () => {
    const approveDecision = vi.fn(async () => null);
    twoListed({ approveDecision });
    const full = refusing((n) => n === lane);
    // R1: the strip hears nothing of a write that is not yet the tap's commit; the general key is never un-listed
    const seen: string[][] = [];
    const stop = useStore.subscribe((st) => { seen.push(st.queueUnreadable.map((u) => u.key)); });
    await setAside();
    stop();
    full.mockRestore();
    expect(seen.every((l) => l.includes(key))).toBe(true);
    expect(localStorage.getItem(key)).toBe(DAMAGED);
    expect(s().queueSetAsideFailed).toBe(true);
    await goOnline();
    expect(approveDecision).not.toHaveBeenCalled();
    expect(s().outbox).toEqual([approve('k-a')]);
  });

  it('forced probe (audit): after that rollback the next ordinary write does not write over the restored bytes', async () => {
    twoListed();
    const full = refusing((n) => n === lane);
    await setAside();
    full.mockRestore();
    s().startActivity('B-1');
    await queueWritten();
    expect(localStorage.getItem(key)).toBe(DAMAGED);
    expect(s().queueUnreadable.map((u) => u.key)).toContain(key);
    expect(copiesOf(key).some((c) => c !== null && c.includes(madeHere()[0].idempotencyKey!))).toBe(true);
  });

  it('forced probe (4360928316): a rollback whose put-back fails shows Set aside failed', async () => {
    twoListed();
    let wrote = 0;
    // the general key takes the tap's write, then refuses its put-back; the lane refuses every write
    const full = refusing((n) => n === lane || (n === key && (wrote += 1) > 1));
    await setAside();
    full.mockRestore();
    expect(s().queueSetAsideFailed).toBe(true);
  });

  it('forced probe (gap check of 3302f45, note 2): a read that throws after the first key landed still rolls it back', async () => {
    twoListed();
    const real = Storage.prototype.getItem;
    let tapWroteKey = false;
    const realSet = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, n: string, v: string) {
      if (n === key && v !== DAMAGED) tapWroteKey = true;
      realSet.call(this, n, v);
    });
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(function (this: Storage, n: string) {
      if (tapWroteKey && n === lane) throw new DOMException('gone', 'SecurityError');
      return real.call(this, n);
    });
    await setAside();
    vi.restoreAllMocks();
    expect(localStorage.getItem(key)).toBe(DAMAGED);
    expect(s().queueSetAsideFailed).toBe(true);
    s().startActivity('B-1');
    await queueWritten();
    expect(localStorage.getItem(key)).toBe(DAMAGED);
  });

  it('guard (R1): a failed write whose act can be kept only in a made record is counted once at Reload', async () => {
    signedIn(DAMAGED, LANE_DAMAGED);
    act(() => { s().queueSiteVisitAct(end('k-v'), 'saved offline'); });
    await queueWritten();
    expect(reloadAsks()).toEqual(['1 updates aren’t saved on this phone and will be lost. Continue?']); // listed not kept, copied aside
    for (const c of Object.keys(localStorage).filter((x) => x.startsWith(`vitan.unreadable.${lane}.`))) localStorage.removeItem(c);
    // the lane takes no write and no copy aside: only a made record can keep the act
    const full = refusing((n) => n === lane || n.startsWith(`vitan.unreadable.${lane}.`));
    await setAside();
    full.mockRestore();
    expect(s().queueSetAsideFailed).toBe(true);
    expect(reloadAsks()).toEqual(['1 updates aren’t saved on this phone and will be lost. Continue?']);
  });

  it('guard: a Set aside that lands sends what was withheld, once', async () => {
    const approveDecision = vi.fn(async () => null);
    twoListed({ approveDecision });
    await setAside();
    expect(s().queueSetAsideFailed).toBe(false);
    expect(s().queueUnreadable).toEqual([]);
    expect(copiesOf(key)).toContain(DAMAGED);
    expect(copiesOf(lane)).toContain(LANE_DAMAGED);
    await goOnline();
    expect(approveDecision).toHaveBeenCalledTimes(1);
  });
});
