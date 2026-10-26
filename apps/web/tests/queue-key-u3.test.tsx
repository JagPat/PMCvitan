import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act } from '@testing-library/react';
import { useStore, getInitialState } from '@/store/store';
import type { ApiGateway, OutboxOp } from '@/data/apiGateway';
import { createQueueKeyGuard } from '@/store/queueKeyGuard';
import { visitPhotoScope } from '@/data/visitPhotoStore';
import { holdQueueLock, queueLockAsked, queueWritten, releaseQueueLocks, storedQueue, unwatchFlushes, watchFlushes } from './queueWrites';

/**
 * WEB-02 U3a (plan `notes/site-visits/web-02-U3/r2/plan.md`, replacing #1122): what this tab holds when another tab
 * changes a queue key. Its findings, each a forced probe red at main by assertion:
 * - Codex 4353751507 (#1086): after another tab made the key unreadable, this tab still sent the acts it had loaded
 *   from it. That tab's bytes may hold them.
 * - Codex 4344812904 (#1084): a key that turned unreadable on another tab's write left this tab's acts only in memory.
 * - Codex 4358186342 (#1099 r1): a key another tab cleared was read as nothing to lose: Reload asked nothing.
 * - Codex 4370036882, 4370036886, 4370036888 (#1122 r1) and 4370280895 (#1122 r2): every read of a key's bytes
 *   reconciles from one snapshot, confirmed by a read again of the key, its sidecar and its marks.
 * Each probe waits on the queue's locks, a storage event, the store's flush calls or the gateway's calls, never a
 * clock or a count of turns (#1134 r1, Codex 4376641821); acts are found by their identity, never their place.
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
const goOnline = async () => { useStore.setState({ online: true }); await act(async () => { await s().flushOutbox(); }); };

/** every flush the store asks in a row; each row ends once they have all settled, so none runs into the next row */
let flushes: ReturnType<typeof watchFlushes>;
beforeEach(() => { flushes = watchFlushes(); });
afterEach(async () => {
  releaseQueueLocks();
  await flushes.atRest();
  unwatchFlushes();
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

describe('#1122 round 1: every read of an unreadable key reconciles what this tab holds', () => {
  it('forced probe (4370036882): a key this tab’s own write finds unreadable, with no storage event, withholds what it loaded', async () => {
    const approveDecision = vi.fn(async () => null);
    signedIn(JSON.stringify([approve('k-a')]), null, { approveDecision });
    localStorage.setItem(key, DAMAGED); // another tab's write, its event not yet delivered
    s().startActivity('B-1');
    await queueWritten();
    expect(s().queueUnreadable.map((u) => u.key)).toEqual([key]);
    await goOnline();
    expect(approveDecision).not.toHaveBeenCalled();
  });
  it('forced probe (4370036886): a key another tab makes readable again, holding the act, is no longer counted unsaved', async () => {
    signedIn(JSON.stringify([approve('k-a')]));
    otherTabWrites(key, DAMAGED);
    expect(reloadAsks()).toEqual(['1 updates aren’t saved on this phone and will be lost. Continue?']);
    otherTabWrites(key, JSON.stringify([approve('k-a')]));
    expect(reloadAsks()).toEqual([]);
  });
  it('guard: a key made readable again without the act still counts it unsaved', async () => {
    signedIn(JSON.stringify([approve('k-a')]));
    otherTabWrites(key, DAMAGED);
    otherTabWrites(key, JSON.stringify([approve('k-b')]));
    expect(reloadAsks()).toEqual(['1 updates aren’t saved on this phone and will be lost. Continue?']);
  });
  it('guard (4370036888): a storage event whose read of the key throws changes nothing listed or held', async () => {
    const approveDecision = vi.fn(async () => null);
    signedIn(JSON.stringify([approve('k-a')]), null, { approveDecision });
    otherTabWrites(key, DAMAGED);
    const realGet = Storage.prototype.getItem;
    const spy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(function (this: Storage, n: string) {
      if (n === key) throw new DOMException('gone', 'SecurityError');
      return realGet.call(this, n);
    });
    act(() => { window.dispatchEvent(new StorageEvent('storage', { key, newValue: null, storageArea: localStorage })); });
    spy.mockRestore();
    expect(s().queueUnreadable.map((u) => u.key)).toEqual([key]);
    await goOnline();
    expect(approveDecision).not.toHaveBeenCalled();
  });
});

describe('#1122 round 2: each read is one pinned observation, confirmed by a read again', () => {
  it('forced probe (4370280895): a key that changes again while heard reads it ends held by its last bytes', async () => {
    const approveDecision = vi.fn(async () => null);
    signedIn(JSON.stringify([approve('k-a')]), null, { approveDecision });
    otherTabWrites(key, DAMAGED);
    // another tab makes it readable, then damages it again while this tab is still reading it; the second write's
    // event is not yet delivered
    const readable = JSON.stringify([approve('k-a')]);
    localStorage.setItem(key, DAMAGED);
    const realGet = Storage.prototype.getItem;
    let first = true;
    const spy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(function (this: Storage, n: string) {
      if (n === key && first) { first = false; return readable; }
      return realGet.call(this, n);
    });
    act(() => { window.dispatchEvent(new StorageEvent('storage', { key, newValue: readable, storageArea: localStorage })); });
    spy.mockRestore();
    expect(s().queueUnreadable.map((u) => u.key)).toEqual([key]);
    await goOnline();
    expect(approveDecision).not.toHaveBeenCalled();
  });
  it('forced probe (4370280895): a key whose bytes never settle while heard reads it holds what this tab saw there', async () => {
    const approveDecision = vi.fn(async () => null);
    signedIn(JSON.stringify([approve('k-a')]), null, { approveDecision });
    otherTabWrites(key, DAMAGED);
    // other tabs keep writing it: each read of it finds the other bytes than the one before
    const readable = JSON.stringify([approve('k-a')]);
    localStorage.setItem(key, DAMAGED);
    const realGet = Storage.prototype.getItem;
    let reads = 0;
    const spy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(function (this: Storage, n: string) {
      if (n === key) { reads += 1; return reads % 2 === 1 ? readable : DAMAGED; }
      return realGet.call(this, n);
    });
    act(() => { window.dispatchEvent(new StorageEvent('storage', { key, newValue: readable, storageArea: localStorage })); });
    spy.mockRestore();
    await goOnline();
    expect(approveDecision).not.toHaveBeenCalled();
    expect(reads).toBeGreaterThan(2);
  });
  it('forced probe (4370280895): what a heard key is refused from is the snapshot it was read from, not a later read', async () => {
    signedIn(null);
    act(() => { s().queueSiteVisitAct(end('k-mine'), 'saved offline'); });
    await queueWritten();
    const mineRaw = localStorage.getItem(lane);
    // another tab writes a newer release's bytes; once this tab has read them twice alike, a later read finds this
    // tab's own bytes for a moment (a third tab put them back and wrote the newer bytes again)
    localStorage.setItem(lane, NEWER);
    const realGet = Storage.prototype.getItem;
    let reads = 0;
    const spy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(function (this: Storage, n: string) {
      if (n === lane) { reads += 1; if (reads === 3) return mineRaw; }
      return realGet.call(this, n);
    });
    act(() => { window.dispatchEvent(new StorageEvent('storage', { key: lane, newValue: NEWER, storageArea: localStorage })); });
    spy.mockRestore();
    expect(localStorage.getItem(lane)).toBe(NEWER);
    expect(copiesOf(lane)).toEqual([JSON.stringify([end('k-mine')])]);
  });
  it('forced probe (plan gap-check, gap 3): a sidecar that changes while heard reads the key is read again', async () => {
    // a keyless act is this tab's occurrence only by the id the key's sidecar gives it
    signedIn(JSON.stringify([U]));
    s().startActivity('B-1');
    await queueWritten();
    const raw = localStorage.getItem(key)!;
    const side = localStorage.getItem(`vitan.occ.${key}`)!;
    otherTabWrites(key, DAMAGED);
    expect(reloadAsks()).toEqual(['2 updates aren’t saved on this phone and will be lost. Continue?']);
    // another tab puts the bytes back, and its sidecar lands just after this tab's first read of it
    localStorage.setItem(key, raw);
    localStorage.setItem(`vitan.occ.${key}`, side);
    const realGet = Storage.prototype.getItem;
    let first = true;
    const spy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(function (this: Storage, n: string) {
      if (n === `vitan.occ.${key}` && first) { first = false; return null; }
      return realGet.call(this, n);
    });
    act(() => { window.dispatchEvent(new StorageEvent('storage', { key, newValue: raw, storageArea: localStorage })); });
    spy.mockRestore();
    expect(reloadAsks()).toEqual([]);
  });
  it('forced probe (plan re-check, gap 2): a read again that throws confirms nothing', async () => {
    // the guard alone: Set aside (U3c) reads a null answer as a read that failed
    const guard = createQueueKeyGuard();
    localStorage.setItem(key, JSON.stringify([approve('k-a')]));
    const acts = guard.load(localStorage, key);
    const realGet = Storage.prototype.getItem;
    let reads = 0;
    const spy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(function (this: Storage, n: string) {
      if (n === key && ++reads === 2) throw new DOMException('gone', 'SecurityError');
      return realGet.call(this, n);
    });
    const answer = guard.heard(localStorage, key, acts);
    spy.mockRestore();
    expect(reads).toBe(2);
    expect(answer).toBeNull();
  });
  it('forced probe (U3a gap-check, gap 1): a read again that throws after a readable first read keeps the hold', async () => {
    const approveDecision = vi.fn(async () => null);
    signedIn(JSON.stringify([approve('k-a')]), null, { approveDecision });
    otherTabWrites(key, DAMAGED);
    // another tab writes readable bytes; this tab's read again of them throws, so nothing confirms them
    const readable = JSON.stringify([approve('k-a')]);
    localStorage.setItem(key, readable);
    const realGet = Storage.prototype.getItem;
    let reads = 0;
    const spy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(function (this: Storage, n: string) {
      if (n === key && ++reads === 2) throw new DOMException('gone', 'SecurityError');
      return realGet.call(this, n);
    });
    act(() => { window.dispatchEvent(new StorageEvent('storage', { key, newValue: readable, storageArea: localStorage })); });
    spy.mockRestore();
    await goOnline();
    expect(approveDecision).not.toHaveBeenCalled();
  });
  it('guard (4370280911, withheld variant): a withheld start the photo hold also holds still holds its visit after Send anyway', async () => {
    const VID = '0b9c8d7e-6f5a-4b3c-8d2e-1f0a9b8c7d6e';
    const start = { t: 'siteVisitStart', idempotencyKey: 'k-s', visitor: { name: 'Priya Shah', role: 'pmc', placeName: null }, body: { id: VID, claimedAt: '2026-10-14T04:30:00.000Z' } } as unknown as OutboxOp;
    const close = { t: 'siteVisitEnd', visitId: VID, claimedAt: '2026-10-14T05:30:00.000Z', idempotencyKey: 'k-e' } as OutboxOp;
    const startSiteVisit = vi.fn(async () => ({ id: VID }));
    const endSiteVisit = vi.fn(async () => { throw Object.assign(new Error('no such visit'), { status: 404 }); });
    // the person taps Send anyway for the visit while another act is on its way
    const startActivity = vi.fn(async () => { s().sendSiteVisitAnyway(VID); return null; });
    signedIn(null, null, { startSiteVisit, endSiteVisit, startActivity });
    act(() => { s().queueSiteVisitAct(start, 'saved offline'); });
    await queueWritten();
    otherTabWrites(lane, NEWER); // the start is withheld
    s().startActivity('B-1');
    await queueWritten();
    act(() => { s().queueSiteVisitAct(close, 'saved offline'); });
    await queueWritten();
    // a photo may be kept on this visit and the photo database cannot be read: the photo hold holds the visit too
    localStorage.setItem(`vitan.visitPhotoHeld.${visitPhotoScope(s().sessionToken, USER)}.${P}.k-photo`, JSON.stringify([VID]));
    vi.spyOn(indexedDB, 'open').mockImplementation(() => { throw new DOMException('blocked', 'SecurityError'); });
    await goOnline();
    expect(startActivity).toHaveBeenCalledTimes(1);
    expect(startSiteVisit).not.toHaveBeenCalled();
    expect(endSiteVisit).not.toHaveBeenCalled();
  });
});

describe('#1132 round 1', () => {
  it('forced probe (4374102392): a confirming read that throws leaves the key listed and its act counted unsaved', async () => {
    signedIn(JSON.stringify([approve('k-a')]));
    otherTabWrites(key, DAMAGED);
    expect(reloadAsks()).toEqual(['1 updates aren’t saved on this phone and will be lost. Continue?']);
    // another tab writes readable bytes; this tab's confirming read of them throws, so nothing confirms them
    const readable = JSON.stringify([approve('k-a')]);
    localStorage.setItem(key, readable);
    const realGet = Storage.prototype.getItem;
    let reads = 0;
    const spy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(function (this: Storage, n: string) {
      if (n === key && ++reads === 2) throw new DOMException('gone', 'SecurityError');
      return realGet.call(this, n);
    });
    act(() => { window.dispatchEvent(new StorageEvent('storage', { key, newValue: readable, storageArea: localStorage })); });
    spy.mockRestore();
    expect(reads).toBe(2);
    expect(s().queueUnreadable.map((u) => u.key)).toEqual([key]);
    expect(reloadAsks()).toEqual(['1 updates aren’t saved on this phone and will be lost. Continue?']);
  });
  it('forced probe (4374102398): two identical keyless acts, bytes another tab cannot let this release read holding one: the other is counted and copied aside', async () => {
    signedIn(JSON.stringify([U, U]));
    const theirs = JSON.stringify([U, { t: 'aKindFromANewerRelease', idempotencyKey: 'k-newer' }]);
    otherTabWrites(key, theirs);
    expect(s().queueUnreadable).toEqual([{ key, read: 'newer', reloaded: false }]);
    expect(reloadAsks()).toEqual(['1 updates aren’t saved on this phone and will be lost. Continue?']);
    expect(copiesOf(key)).toEqual([JSON.stringify([U])]);
  });
  it('guard (fail closed): a readable key whose bytes never settle while heard reads them holds what this tab saw', async () => {
    const approveDecision = vi.fn(async () => null);
    signedIn(JSON.stringify([approve('k-a')]), null, { approveDecision });
    const readable = JSON.stringify([approve('k-a')]);
    const realGet = Storage.prototype.getItem;
    let reads = 0;
    const spy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(function (this: Storage, n: string) {
      if (n === key) { reads += 1; return reads % 2 === 1 ? readable : DAMAGED; }
      return realGet.call(this, n);
    });
    act(() => { window.dispatchEvent(new StorageEvent('storage', { key, newValue: DAMAGED, storageArea: localStorage })); });
    spy.mockRestore();
    localStorage.setItem(key, DAMAGED);
    await goOnline();
    expect(approveDecision).not.toHaveBeenCalled();
  });
  it('guard (fail closed): a readable key whose confirming read throws holds what this tab saw', async () => {
    const approveDecision = vi.fn(async () => null);
    signedIn(JSON.stringify([approve('k-a')]), null, { approveDecision });
    const realGet = Storage.prototype.getItem;
    let reads = 0;
    const spy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(function (this: Storage, n: string) {
      if (n === key && ++reads === 2) throw new DOMException('gone', 'SecurityError');
      return realGet.call(this, n);
    });
    act(() => { window.dispatchEvent(new StorageEvent('storage', { key, newValue: DAMAGED, storageArea: localStorage })); });
    spy.mockRestore();
    localStorage.setItem(key, DAMAGED);
    await goOnline();
    expect(approveDecision).not.toHaveBeenCalled();
  });
  it('guard: two identical keyless acts, bytes holding both: neither is counted', async () => {
    signedIn(JSON.stringify([U, U]));
    otherTabWrites(key, JSON.stringify([U, U, { t: 'aKindFromANewerRelease', idempotencyKey: 'k-newer' }]));
    expect(reloadAsks()).toEqual([]);
    expect(copiesOf(key)).toEqual([]);
  });
  it('guard (first read throws): a readable key whose every read throws while heard reads it holds nothing', async () => {
    const approveDecision = vi.fn(async () => null);
    signedIn(JSON.stringify([approve('k-a')]), null, { approveDecision });
    const realGet = Storage.prototype.getItem;
    const spy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(function (this: Storage, n: string) {
      if (n === key) throw new DOMException('gone', 'SecurityError');
      return realGet.call(this, n);
    });
    act(() => { window.dispatchEvent(new StorageEvent('storage', { key, newValue: DAMAGED, storageArea: localStorage })); });
    spy.mockRestore();
    expect(s().queueUnreadable).toEqual([]);
    await goOnline();
    expect(approveDecision).toHaveBeenCalled();
  });
  it('guard (first read throws): a first read that throws once, damaged bytes behind it, lists and copies nothing', async () => {
    signedIn(JSON.stringify([approve('k-a')]));
    localStorage.setItem(key, DAMAGED);
    const realGet = Storage.prototype.getItem;
    let reads = 0;
    const spy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(function (this: Storage, n: string) {
      if (n === key && ++reads === 1) throw new DOMException('gone', 'SecurityError');
      return realGet.call(this, n);
    });
    act(() => { window.dispatchEvent(new StorageEvent('storage', { key, newValue: DAMAGED, storageArea: localStorage })); });
    spy.mockRestore();
    expect(s().queueUnreadable).toEqual([]);
    expect(copiesOf(key)).toEqual([]);
  });
  it('forced probe (load, R3): a made record holding two identical keyless acts beside unreadable bytes holding one loads the other', async () => {
    localStorage.setItem(`vitan.made.${key}.1.a`, JSON.stringify([U, U]));
    signedIn(JSON.stringify([U, { t: 'aKindFromANewerRelease', idempotencyKey: 'k-newer' }]));
    // the record keeps it on this phone; the act the bytes do not cover is loaded to be sent
    expect(s().outbox.filter((o) => o.t === U.t)).toHaveLength(1);
  });
  it('guard (load, R3): a keyed act the unreadable bytes hold covers it in every record', async () => {
    localStorage.setItem(`vitan.made.${key}.1.a`, JSON.stringify([approve('k-a')]));
    localStorage.setItem(`vitan.made.${key}.2.b`, JSON.stringify([approve('k-a')]));
    signedIn(JSON.stringify([approve('k-a'), { t: 'aKindFromANewerRelease', idempotencyKey: 'k-newer' }]));
    expect(s().outbox).toEqual([]);
  });
});

describe('#1132 round 2', () => {
  /** an entry this release cannot read that keeps a valid act's idempotency key (no decisionId, no optionIndex) */
  const malformed = (k: string) => JSON.stringify([{ t: 'approve', idempotencyKey: k }]);
  it('forced probe (4374538867, heard): another tab writes unreadable bytes whose malformed entry keeps k-a: the valid k-a is counted and copied aside', async () => {
    signedIn(JSON.stringify([approve('k-a')]));
    otherTabWrites(key, malformed('k-a'));
    expect(s().queueUnreadable.map((u) => u.key)).toEqual([key]);
    expect(reloadAsks()).toEqual(['1 updates aren’t saved on this phone and will be lost. Continue?']);
    expect(copiesOf(key)).toEqual([JSON.stringify([approve('k-a')])]);
  });
  it('guard (4374538867, heard): the same with the malformed entry keeping another key (k-z)', async () => {
    signedIn(JSON.stringify([approve('k-a')]));
    otherTabWrites(key, malformed('k-z'));
    expect(s().queueUnreadable.map((u) => u.key)).toEqual([key]);
    expect(reloadAsks()).toEqual(['1 updates aren’t saved on this phone and will be lost. Continue?']);
    expect(copiesOf(key)).toEqual([JSON.stringify([approve('k-a')])]);
  });
  it('forced probe (4374538867, write): this tab’s own write finds such bytes (no event): the valid k-a is counted and copied aside', async () => {
    signedIn(JSON.stringify([approve('k-a')]));
    localStorage.setItem(key, malformed('k-a'));
    s().startActivity('B-1');
    await queueWritten();
    expect(s().queueUnreadable.map((u) => u.key)).toEqual([key]);
    expect(reloadAsks()).toEqual(['2 updates aren’t saved on this phone and will be lost. Continue?']);
    expect(copiesOf(key).some((c) => (c ?? '').includes('"decisionId":"d-1"'))).toBe(true);
  });
  it('guard (4374538867, write): the same with the malformed entry keeping k-z', async () => {
    signedIn(JSON.stringify([approve('k-a')]));
    localStorage.setItem(key, malformed('k-z'));
    s().startActivity('B-1');
    await queueWritten();
    expect(s().queueUnreadable.map((u) => u.key)).toEqual([key]);
    expect(reloadAsks()).toEqual(['2 updates aren’t saved on this phone and will be lost. Continue?']);
    expect(copiesOf(key).some((c) => (c ?? '').includes('"decisionId":"d-1"'))).toBe(true);
  });
  it('forced probe (4374538874, heard): online, a withheld act whose key another tab repairs is sent with no further command', async () => {
    const approveDecision = vi.fn(async () => null);
    signedIn(JSON.stringify([approve('k-a')]), null, { approveDecision });
    otherTabWrites(key, DAMAGED);
    await goOnline();
    expect(approveDecision).not.toHaveBeenCalled(); // held: precondition
    otherTabWrites(key, JSON.stringify([approve('k-a')]));
    await flushes.atRest();
    expect(approveDecision).toHaveBeenCalled();
  });
  it('guard (4374538874, heard): after the repair an explicit flush sends it (it is sendable)', async () => {
    const approveDecision = vi.fn(async () => null);
    signedIn(JSON.stringify([approve('k-a')]), null, { approveDecision });
    otherTabWrites(key, DAMAGED);
    await goOnline();
    expect(approveDecision).not.toHaveBeenCalled();
    otherTabWrites(key, JSON.stringify([approve('k-a')]));
    await act(async () => { await s().flushOutbox(); });
    expect(approveDecision).toHaveBeenCalled();
  });
  it('forced probe (4374538874, persist): a hold the flush’s own end write lets go is followed by a send with no further command', async () => {
    const approveDecision = vi.fn(async () => null);
    signedIn(JSON.stringify([approve('k-a')]), null, { approveDecision });
    otherTabWrites(key, DAMAGED);
    localStorage.setItem(key, JSON.stringify([approve('k-a')])); // repaired, its event not yet delivered
    await goOnline();
    await flushes.atRest();
    expect(approveDecision).toHaveBeenCalled();
  });
  it('guard (4374538874, persist): the resumed flush sends the act once and empties the queue; nothing runs again', async () => {
    const approveDecision = vi.fn(async () => null);
    signedIn(JSON.stringify([approve('k-a')]), null, { approveDecision });
    otherTabWrites(key, DAMAGED);
    localStorage.setItem(key, JSON.stringify([approve('k-a')]));
    await goOnline();
    await flushes.atRest();
    expect(approveDecision).toHaveBeenCalledTimes(1);
    expect(s().outbox).toEqual([]);
    expect(s()._outboxFlushing()).toBe(false);
  });
  it('forced probe (4374538867, load): a made record’s act beside unreadable bytes whose malformed entry keeps its key is loaded', async () => {
    localStorage.setItem(`vitan.made.${key}.1.a`, JSON.stringify([approve('k-a')]));
    signedIn(malformed('k-a'));
    expect(s().outbox.map((o) => (o as { idempotencyKey?: string }).idempotencyKey)).toEqual(['k-a']);
  });
  it('guard (4374538867, equal entry): an entry holding the act with its fields in another order still covers it', async () => {
    signedIn(JSON.stringify([approve('k-a')]));
    otherTabWrites(key, JSON.stringify([{ idempotencyKey: 'k-a', optionIndex: 0, decisionId: 'd-1', t: 'approve' }, { t: 'aKindFromANewerRelease', idempotencyKey: 'k-newer' }]));
    expect(reloadAsks()).toEqual([]);
    expect(copiesOf(key)).toEqual([]);
  });
  it('guard (4374538874, ends): one release with nothing to send runs one flush, then nothing more', async () => {
    signedIn(JSON.stringify([approve('k-a')]));
    otherTabWrites(key, DAMAGED);
    useStore.setState({ outbox: [] }); // memory let the act go; the hold remains
    useStore.setState({ online: true });
    const from = flushes.calls.length;
    otherTabWrites(key, '[]');
    await flushes.atRest();
    expect(flushes.calls.length - from).toBe(1);
    expect(s()._outboxFlushing()).toBe(false);
  });
  it('guard (4374538874, running flush): a release during a running flush reruns it once, which sends the released act', async () => {
    let unblock: () => void = () => {};
    const blocked = new Promise<void>((r) => { unblock = r; });
    let reached: () => void = () => {};
    const sending = new Promise<void>((r) => { reached = r; });
    const approveDecision = vi.fn(async () => { reached(); await blocked; return null; });
    const endSiteVisit = vi.fn(async () => null);
    signedIn(JSON.stringify([approve('k-a')]), JSON.stringify([end('k-v')]), { approveDecision, endSiteVisit });
    otherTabWrites(lane, DAMAGED);
    useStore.setState({ online: true });
    const from = flushes.calls.length;
    let first: Promise<unknown> = Promise.resolve();
    act(() => { first = s().flushOutbox(); });
    await sending;
    expect(approveDecision).toHaveBeenCalledTimes(1); // the flush is running, waiting on the gateway
    expect(endSiteVisit).not.toHaveBeenCalled();
    otherTabWrites(lane, JSON.stringify([end('k-v')]));
    await flushes.asked(undefined, from + 2); // the release's flush is asked while the first runs
    unblock();
    await act(async () => { await first; });
    await flushes.atRest();
    expect(endSiteVisit).toHaveBeenCalledTimes(1);
    expect(flushes.calls.length - from).toBeLessThanOrEqual(3);
    expect(s()._outboxFlushing()).toBe(false);
  });
  it('guard (4374538874, offline): a release while offline runs no flush and sends nothing', async () => {
    const approveDecision = vi.fn(async () => null);
    signedIn(JSON.stringify([approve('k-a')]), null, { approveDecision });
    otherTabWrites(key, DAMAGED);
    const from = flushes.calls.length;
    otherTabWrites(key, JSON.stringify([approve('k-a')]));
    await flushes.atRest();
    expect(flushes.calls.length - from).toBe(0);
    expect(approveDecision).not.toHaveBeenCalled();
  });
});

describe('U3b', () => {
  const VID = '0b9c8d7e-6f5a-4b3c-8d2e-1f0a9b8c7d6e';
  const start = { t: 'siteVisitStart', idempotencyKey: 'k-s', visitor: { name: 'Priya Shah', role: 'pmc', placeName: null }, body: { id: VID, claimedAt: '2026-10-14T04:30:00.000Z' } } as unknown as OutboxOp;
  const close = { t: 'siteVisitEnd', visitId: VID, claimedAt: '2026-10-14T05:30:00.000Z', idempotencyKey: 'k-e' } as OutboxOp;
  const photo = { t: 'siteVisitAddFile', visitId: VID, scope: 'any', idempotencyKey: 'k-f', by: { name: 'Priya Shah', role: 'pmc' }, placeName: null, file: { id: 'c-1', mime: 'image/png' } } as unknown as OutboxOp;
  const snap = () => ({ project: { id: P, name: 'P', short: 'P', descriptor: '', stage: '', siteCode: '', location: '', projStart: '', projEnd: '', elapsedPct: 0, todayDay: 0, milestonePct: 0 }, decisions: [], activities: [], placedInspections: [], checklist: null, reviews: [], review: null, reinspectionCreated: false, drawings: [], phases: [], dailyLog: null, notifications: [], companies: [], nodes: [], photos: [], materials: [] });
  const STARTED = 'New daily log started — crew carried over at zero.';
  const DISCARDED = '1 could not be applied and was discarded.';
  const PENDING = '1 still pending — will retry when you reconnect.';
  /** a command's line with the plain act this flush also sent (k-a, which has no line), counted (#1134 r2) */
  const WITH_SYNCED = `${STARTED} 1 offline update synced.`;
  const refused = () => Object.assign(new Error('409'), { status: 409, serverMessage: 'Refused' });
  const unavailable = () => Object.assign(new Error('503'), { status: 503 });
  /** the daily log command's own flush call (made once its write has run) */
  const command = (o: Parameters<ReturnType<typeof s>['flushOutbox']>[0]) => o?.act?.t === 'startDailyLog';
  /** a photo may be kept on the visit and the photo database cannot be read: the photo hold holds the visit */
  const photoHold = () => {
    localStorage.setItem(`vitan.visitPhotoHeld.${visitPhotoScope(s().sessionToken, USER)}.${P}.k-photo`, JSON.stringify([VID]));
    vi.spyOn(indexedDB, 'open').mockImplementation(() => { throw new DOMException('blocked', 'SecurityError'); });
  };
  const order = (...fns: ReturnType<typeof vi.fn>[]) => fns.map((f) => f.mock.invocationCallOrder[0] ?? Infinity);
  /** each line the store says from here on */
  const lines = () => {
    const said: string[] = [];
    const flash = s().flash;
    useStore.setState({ flash: (m: string) => { said.push(m); flash(m); } });
    return said;
  };
  /** the command's act's gateway call: refused or failed as `fail` says, once each, then accepted */
  const startDailyLogThat = (...fail: (() => Error)[]) => vi.fn(async () => { const f = fail.shift(); if (f) throw f(); return snap(); });

  it('forced probe (4374997251, #1133): a command whose write lets go of a queue-key hold still says its own success line', async () => {
    const gw = { snapshot: vi.fn(async () => snap()), approveDecision: vi.fn(async () => snap()), startDailyLog: vi.fn(async () => snap()) };
    signedIn(JSON.stringify([approve('k-a')]), null, gw);
    otherTabWrites(key, DAMAGED); // k-a is held
    localStorage.setItem(key, JSON.stringify([approve('k-a')])); // repaired, its event not yet delivered
    useStore.setState({ online: true });
    s().startDailyLog(); // its write-ahead lands, which lets the hold go
    await flushes.asked(command);
    await flushes.atRest();
    expect(gw.approveDecision).toHaveBeenCalledTimes(1);
    expect(gw.startDailyLog).toHaveBeenCalledTimes(1);
    expect(s().outbox).toEqual([]);
    expect(s().toast).toBe(WITH_SYNCED);
  });
  it('guard (4374997251): the same command with no hold says its own success line', async () => {
    const gw = { snapshot: vi.fn(async () => snap()), approveDecision: vi.fn(async () => snap()), startDailyLog: vi.fn(async () => snap()) };
    signedIn(JSON.stringify([approve('k-a')]), null, gw);
    useStore.setState({ online: true });
    s().startDailyLog();
    await flushes.asked(command);
    await flushes.atRest();
    expect(s().outbox).toEqual([]);
    expect(s().toast).toBe(WITH_SYNCED);
  });
  it('guard (4374997251): once a command has flushed, a hold let go by another tab still resumes sending', async () => {
    const gw = { snapshot: vi.fn(async () => snap()), approveDecision: vi.fn(async () => snap()), startDailyLog: vi.fn(async () => snap()) };
    signedIn(null, null, gw);
    useStore.setState({ online: true });
    s().startDailyLog(); // a command asked and flushed: no command waits now
    await flushes.asked(command);
    await flushes.atRest();
    expect(s().outbox).toEqual([]);
    useStore.setState({ online: false });
    localStorage.setItem(key, JSON.stringify([approve('k-a')]));
    s().hydrateOutbox();
    otherTabWrites(key, DAMAGED);
    useStore.setState({ online: true });
    otherTabWrites(key, JSON.stringify([approve('k-a')]));
    await flushes.atRest();
    expect(gw.approveDecision).toHaveBeenCalledTimes(1);
    expect(s().outbox).toEqual([]);
  });

  it('forced probe (4374997251, heard): another tab lets go of a hold while a command’s write waits: the command still says its line', async () => {
    const gw = { snapshot: vi.fn(async () => snap()), approveDecision: vi.fn(async () => snap()), startDailyLog: vi.fn(async () => snap()) };
    signedIn(JSON.stringify([approve('k-a')]), null, gw);
    otherTabWrites(key, DAMAGED); // k-a is held
    const other = holdQueueLock(key); // another tab holds the queue lock: the command's write waits
    await other.has;
    useStore.setState({ online: true });
    const waits = queueLockAsked(key);
    s().startDailyLog();
    await waits; // the command's write asks for the lock the other tab holds
    const from = flushes.calls.length;
    otherTabWrites(key, JSON.stringify([approve('k-a')])); // repaired and heard: the hold is let go
    await flushes.asked(undefined, from + 1); // the release's flush
    other.release();
    await flushes.asked(command);
    await flushes.atRest();
    expect(gw.approveDecision).toHaveBeenCalledTimes(1);
    expect(gw.startDailyLog).toHaveBeenCalledTimes(1);
    expect(s().toast).toBe(WITH_SYNCED);
  });
  it('forced probe (4374997251, rerun): a command asked while a flush is sending says its line from the flush that sends it', async () => {
    let go!: () => void;
    const gate = new Promise<void>((r) => { go = r; });
    let reached!: () => void;
    const sending = new Promise<void>((r) => { reached = r; });
    const gw = { snapshot: vi.fn(async () => snap()), approveDecision: vi.fn(async () => { reached(); await gate; return snap(); }), startDailyLog: vi.fn(async () => snap()) };
    signedIn(JSON.stringify([approve('k-a')]), null, gw);
    // each line said, with whether the command's act had been sent by then
    const said: [string, number][] = [];
    const flash = s().flash;
    useStore.setState({ flash: (m: string) => { said.push([m, gw.startDailyLog.mock.calls.length]); flash(m); } });
    useStore.setState({ online: true });
    void s().flushOutbox();
    await sending; // the flush is sending k-a
    s().startDailyLog(); // its own flush call joins the running one, which took its queue before the command
    await flushes.asked(command);
    const rest = flushes.atRest(); // asked while the first flush runs: its rerun is asked during this wait
    go();
    await act(async () => { await rest; });
    expect(gw.startDailyLog).toHaveBeenCalledTimes(1);
    expect(s().outbox).toEqual([]);
    expect(s().toast).toBe(STARTED);
    // said once, and only by the flush that sent the command's act
    expect(said.filter(([m]) => m === STARTED)).toEqual([[STARTED, 1]]);
  });
  it('forced probe (4374997251, refused, own flush): a command whose act the server refuses for good is not told it succeeded', async () => {
    const gw = { snapshot: vi.fn(async () => snap()), approveDecision: vi.fn(async () => snap()), startDailyLog: startDailyLogThat(refused) };
    signedIn(JSON.stringify([approve('k-a')]), null, gw);
    useStore.setState({ online: true });
    const said = lines();
    s().startDailyLog();
    await flushes.asked(command);
    await flushes.atRest();
    expect(gw.startDailyLog).toHaveBeenCalledTimes(1);
    expect(s().outbox).toEqual([]); // k-a sent, the start dropped as refused
    expect(said.some((m) => m.includes(STARTED))).toBe(false);
  });
  it('forced probe (4374997251, refused, joined): a command that joined a flush whose act the server refuses is not told it succeeded', async () => {
    const gw = { snapshot: vi.fn(async () => snap()), approveDecision: vi.fn(async () => snap()), startDailyLog: startDailyLogThat(refused) };
    signedIn(JSON.stringify([approve('k-a')]), null, gw);
    otherTabWrites(key, DAMAGED);
    localStorage.setItem(key, JSON.stringify([approve('k-a')]));
    useStore.setState({ online: true });
    const said = lines();
    s().startDailyLog(); // its write lets the hold go: the release's flush runs first, and the command joins it
    await flushes.asked(command);
    await flushes.atRest();
    expect(gw.startDailyLog).toHaveBeenCalledTimes(1);
    expect(s().outbox).toEqual([]);
    expect(said.some((m) => m.includes(STARTED))).toBe(false);
  });
  it('guard (4374997251, scope moved, Stage 1 G1): a hold let go in the new project while the old project’s command still waits resumes sending', async () => {
    const approveDecision = vi.fn(async () => snap());
    signedIn(null, null, { snapshot: vi.fn(async () => snap()), approveDecision, startDailyLog: vi.fn(async () => snap()) });
    const other = holdQueueLock(key); // the command's write waits
    await other.has;
    useStore.setState({ online: true });
    const waits = queueLockAsked(key);
    s().startDailyLog();
    await waits;
    const key2 = `vitan.outbox.dev:${USER}.p-2`;
    useStore.setState({ online: false });
    localStorage.setItem(key2, JSON.stringify([approve('k-b')]));
    useStore.setState({ activeProjectId: 'p-2', projectScopeGeneration: s().projectScopeGeneration + 1 });
    act(() => s().hydrateOutbox());
    otherTabWrites(key2, DAMAGED); // k-b is held
    useStore.setState({ online: true });
    const from = flushes.calls.length;
    otherTabWrites(key2, JSON.stringify([approve('k-b')])); // repaired and heard: the hold is let go
    await flushes.asked(undefined, from + 1); // the release's flush
    other.release();
    await flushes.atRest();
    expect(approveDecision).toHaveBeenCalledTimes(1);
  });

  it('forced probe (4376641802, joined): a joined command sent beside an act refused for good says its line and the refusal, in one line', async () => {
    const gw = { snapshot: vi.fn(async () => snap()), approveDecision: vi.fn(async () => { throw refused(); }), startDailyLog: vi.fn(async () => snap()) };
    signedIn(JSON.stringify([approve('k-a')]), null, gw);
    otherTabWrites(key, DAMAGED);
    localStorage.setItem(key, JSON.stringify([approve('k-a')]));
    useStore.setState({ online: true });
    const said = lines();
    s().startDailyLog(); // the release's flush sends k-a and the start; the command's call joins it
    await flushes.asked(command);
    await flushes.atRest();
    expect(gw.startDailyLog).toHaveBeenCalledTimes(1);
    expect(s().toast).toBe(`${STARTED} ${DISCARDED}`);
    expect(said.filter((m) => m.includes(STARTED))).toEqual([`${STARTED} ${DISCARDED}`]);
  });
  it('forced probe (4376641802, own flush): a command sent beside an act refused for good says its line and the refusal, in one line', async () => {
    const gw = { snapshot: vi.fn(async () => snap()), approveDecision: vi.fn(async () => { throw refused(); }), startDailyLog: vi.fn(async () => snap()) };
    signedIn(JSON.stringify([approve('k-a')]), null, gw);
    useStore.setState({ online: true });
    const said = lines();
    s().startDailyLog();
    await flushes.asked(command);
    await flushes.atRest();
    expect(s().toast).toBe(`${STARTED} ${DISCARDED}`);
    expect(said.filter((m) => m.includes(STARTED))).toEqual([`${STARTED} ${DISCARDED}`]);
  });
  it('forced probe (4376641802, pending): a command sent while a held visit’s act stays queued says its line and what is pending, in one line', async () => {
    const gw = { snapshot: vi.fn(async () => snap()), startDailyLog: vi.fn(async () => snap()), startSiteVisit: vi.fn(async () => ({ id: VID })) };
    signedIn(null, null, gw);
    act(() => { s().queueSiteVisitAct(start, 'saved offline'); });
    await queueWritten();
    photoHold();
    useStore.setState({ online: true });
    s().startDailyLog();
    await flushes.asked(command);
    await flushes.atRest();
    expect(gw.startSiteVisit).not.toHaveBeenCalled(); // held: precondition
    expect(gw.startDailyLog).toHaveBeenCalledTimes(1);
    expect(s().toast).toBe(`${STARTED} ${PENDING}`);
  });
  it('forced probe (4376641802, chain refusal, Stage 1 re-check of 62c8d1e): a command sent beside a countersign the server refuses says its line and the refusal, in one line', async () => {
    const gw = { snapshot: vi.fn(async () => snap()), countersignDecision: vi.fn(async () => { throw refused(); }), startDailyLog: vi.fn(async () => snap()) };
    signedIn(JSON.stringify([{ t: 'countersignDecision', decisionId: 'd-1', idempotencyKey: 'k-c' }]), null, gw);
    useStore.setState({ online: true });
    const said = lines();
    s().startDailyLog();
    await flushes.asked(command);
    await flushes.atRest();
    expect(gw.countersignDecision).toHaveBeenCalledTimes(1);
    expect(gw.startDailyLog).toHaveBeenCalledTimes(1);
    expect(s().toast).toBe(`${STARTED} Countersign d-1 refused — Refused.`);
    expect(said.filter((m) => m.includes(STARTED))).toEqual([`${STARTED} Countersign d-1 refused — Refused.`]);
  });
  it('forced probe (4377928188): two commands whose acts one flush sends each say their line, in one line', async () => {
    const gw = { snapshot: vi.fn(async () => snap()), startDailyLog: vi.fn(async () => snap()), addSiteMaterial: vi.fn(async () => snap()) };
    signedIn(null, null, gw);
    const other = holdQueueLock(key); // another tab holds the queue lock: both commands' writes wait behind it
    await other.has;
    useStore.setState({ online: true });
    const said = lines();
    s().startDailyLog();
    s().addSiteMaterial({ name: 'Cement', qty: '10 bags' });
    other.release();
    await flushes.asked(command);
    await flushes.asked((o) => o?.act?.t === 'addSiteMaterial');
    await flushes.atRest();
    expect(gw.startDailyLog).toHaveBeenCalledTimes(1);
    expect(gw.addSiteMaterial).toHaveBeenCalledTimes(1);
    expect(s().outbox).toEqual([]);
    expect(said).toEqual([`${STARTED} Material recorded: Cement.`]);
  });
  describe('4377928188 (root-cause audit): each flush says one line: every sent command’s line once, in send order, then the count of every act without a line', () => {
    const M = 'Material recorded: Cement.';
    const SYNCED = '1 offline update synced';
    const D1 = '1 could not be applied and was discarded';
    const D2 = '2 could not be applied and were discarded';
    const P1 = '1 still pending — will retry when you reconnect';
    const P2 = '2 still pending — will retry when you reconnect';
    type Outcome = 'sent' | 'refused' | 'pending';
    // each case: how many commands, what the server does with their acts, whose flush sends them; then every line said.
    // The queue also holds k-a, a plain act with no line, which the server accepts. `own`: the first command's own flush
    // call takes the queue (k-a and every command; a second command's call joins it). `joined`: a flush already sending
    // k-a when the commands ask; their calls join it, and its rerun sends them
    const cases: [number, Outcome, 'own' | 'joined', string[]][] = [
      [0, 'sent', 'own', [`${SYNCED}.`]],
      [1, 'sent', 'own', [`${STARTED} ${SYNCED}.`]],
      [2, 'sent', 'own', [`${STARTED} ${M} ${SYNCED}.`]],
      [3, 'sent', 'own', [`${STARTED} 3 offline updates synced.`]],
      [1, 'refused', 'own', [`${SYNCED}; ${D1}.`]],
      [2, 'refused', 'own', [`${SYNCED}; ${D2}.`]],
      [1, 'pending', 'own', [`${SYNCED}; ${P1}.`]],
      [2, 'pending', 'own', [`${SYNCED}; ${P2}.`, `${P2}.`]],
      [1, 'sent', 'joined', [`${SYNCED}.`, STARTED]],
      [2, 'sent', 'joined', [`${SYNCED}.`, `${STARTED} ${M}`]],
      [1, 'refused', 'joined', [`${SYNCED}.`, `${D1}.`]],
      [2, 'refused', 'joined', [`${SYNCED}.`, `${D2}.`]],
      [1, 'pending', 'joined', [`${SYNCED}.`, `${P1}.`]],
      [2, 'pending', 'joined', [`${SYNCED}.`, `${P2}.`]],
    ];
    it.each(cases)('forced probe: %i command(s), %s, %s flush', async (n, outcome, mode, expected) => {
      let go: () => void = () => {};
      const gate = new Promise<void>((r) => { go = r; });
      let reached: () => void = () => {};
      const sending = new Promise<void>((r) => { reached = r; });
      const answer = async () => {
        if (outcome === 'refused') throw refused();
        if (outcome === 'pending') throw unavailable();
        return snap();
      };
      const gw = {
        snapshot: vi.fn(async () => snap()),
        approveDecision: vi.fn(async () => { reached(); if (mode === 'joined') await gate; return snap(); }),
        startDailyLog: vi.fn(answer),
        addSiteMaterial: vi.fn(answer),
      };
      signedIn(JSON.stringify([approve('k-a')]), null, gw);
      useStore.setState({ online: true });
      const said = lines();
      const commands = [
        () => s().startDailyLog(),
        () => s().addSiteMaterial({ name: 'Cement', qty: '10 bags' }),
        () => s().addSiteMaterial({ name: 'Sand', qty: '2 tonnes' }),
      ].slice(0, n);
      if (n === 0) {
        await act(async () => { await s().flushOutbox(); });
      } else if (mode === 'own') {
        const other = holdQueueLock(key); // every command's write waits behind it, so one flush takes them all
        await other.has;
        for (const c of commands) c();
        other.release();
      } else {
        void s().flushOutbox();
        await sending; // the flush is sending k-a
        for (const c of commands) c();
      }
      const kinds = ['startDailyLog', 'addSiteMaterial', 'addSiteMaterial'].slice(0, n);
      for (const [i, t] of kinds.entries()) await flushes.asked((o) => o?.act?.t === t, kinds.slice(0, i + 1).filter((k) => k === t).length);
      const rest = flushes.atRest();
      go();
      await act(async () => { await rest; });
      expect(said).toEqual(expected);
    });
  });
  it('guard (4376641802): a command sent alone says its line alone', async () => {
    signedIn(null, null, { snapshot: vi.fn(async () => snap()), startDailyLog: vi.fn(async () => snap()) });
    useStore.setState({ online: true });
    const said = lines();
    s().startDailyLog();
    await flushes.asked(command);
    await flushes.atRest();
    expect(said).toEqual([STARTED]);
  });

  it('forced probe (4376641813, offline): a joined command whose flush ends offline says its line when the reconnect sends it', async () => {
    let go!: () => void;
    const gate = new Promise<void>((r) => { go = r; });
    let reached!: () => void;
    const sending = new Promise<void>((r) => { reached = r; });
    const gw = { snapshot: vi.fn(async () => snap()), approveDecision: vi.fn(async () => { reached(); await gate; return snap(); }), startDailyLog: vi.fn(async () => snap()) };
    signedIn(JSON.stringify([approve('k-a')]), null, gw);
    useStore.setState({ online: true });
    const first = s().flushOutbox();
    await sending;
    s().startDailyLog(); // joins the running flush, which took its queue before the command
    await flushes.asked(command);
    useStore.setState({ online: false }); // the connection drops: no rerun starts
    go();
    await act(async () => { await first; });
    await flushes.atRest();
    expect(gw.startDailyLog).not.toHaveBeenCalled(); // still queued: precondition
    const said = lines();
    await goOnline(); // the reconnect's plain flush sends it
    await flushes.atRest();
    expect(gw.startDailyLog).toHaveBeenCalledTimes(1);
    expect(said).toEqual([STARTED]);
  });
  it('forced probe (4376641813, failed rerun): a joined command whose rerun fails to send says its line when a later flush sends it', async () => {
    let go!: () => void;
    const gate = new Promise<void>((r) => { go = r; });
    let reached!: () => void;
    const sending = new Promise<void>((r) => { reached = r; });
    const gw = { snapshot: vi.fn(async () => snap()), approveDecision: vi.fn(async () => { reached(); await gate; return snap(); }), startDailyLog: startDailyLogThat(unavailable) };
    signedIn(JSON.stringify([approve('k-a')]), null, gw);
    useStore.setState({ online: true });
    const first = s().flushOutbox();
    await sending;
    s().startDailyLog();
    await flushes.asked(command);
    go();
    await act(async () => { await first; });
    await flushes.atRest();
    expect(gw.startDailyLog).toHaveBeenCalledTimes(1); // the rerun's send failed: precondition
    expect(s().outbox.map((o) => o.t)).toEqual(['startDailyLog']);
    const said = lines();
    await act(async () => { await s().flushOutbox(); });
    await flushes.atRest();
    expect(gw.startDailyLog).toHaveBeenCalledTimes(2);
    expect(said).toEqual([STARTED]);
  });
  it('forced probe (4376641813, own flush failed): a command whose own flush fails to send says its line when a later flush sends it', async () => {
    const gw = { snapshot: vi.fn(async () => snap()), startDailyLog: startDailyLogThat(unavailable) };
    signedIn(null, null, gw);
    useStore.setState({ online: true });
    s().startDailyLog();
    await flushes.asked(command);
    await flushes.atRest();
    expect(s().outbox.map((o) => o.t)).toEqual(['startDailyLog']); // precondition
    const said = lines();
    await act(async () => { await s().flushOutbox(); });
    await flushes.atRest();
    expect(said).toEqual([STARTED]);
  });
  it('guard (4376641813): a kept line whose act is later refused for good is never said', async () => {
    const gw = { snapshot: vi.fn(async () => snap()), startDailyLog: startDailyLogThat(unavailable, refused) };
    signedIn(null, null, gw);
    useStore.setState({ online: true });
    s().startDailyLog();
    await flushes.asked(command);
    await flushes.atRest();
    const said = lines();
    await act(async () => { await s().flushOutbox(); });
    await act(async () => { await s().flushOutbox(); });
    await flushes.atRest();
    expect(gw.startDailyLog).toHaveBeenCalledTimes(2);
    expect(s().outbox).toEqual([]);
    expect(said).toEqual([DISCARDED]);
  });

  it('forced probe (4370280911 control): Send anyway during an earlier await does not send the visit’s End ahead of its photo-held Start', async () => {
    const startSiteVisit = vi.fn(async () => ({ id: VID }));
    const endSiteVisit = vi.fn(async () => null);
    // the person taps Send anyway for the visit while another act is on its way
    const startActivity = vi.fn(async () => { s().sendSiteVisitAnyway(VID); return null; });
    signedIn(null, null, { startSiteVisit, endSiteVisit, startActivity });
    act(() => { s().queueSiteVisitAct(start, 'saved offline'); });
    await queueWritten();
    s().startActivity('B-1');
    await queueWritten();
    act(() => { s().queueSiteVisitAct(close, 'saved offline'); });
    await queueWritten();
    photoHold();
    await goOnline();
    expect(startActivity).toHaveBeenCalledTimes(1);
    // the End is never sent ahead of its Start; Send anyway takes effect at the next flush (the tap's own, run once this
    // one ends): the Start, then the End
    await flushes.atRest();
    const [startAt, endAt] = order(startSiteVisit, endSiteVisit);
    expect(startAt).toBeLessThan(endAt);
    expect(endAt).toBeLessThan(Infinity);
  });
  it('guard (4370280911): Send anyway before the flush sends the visit in that flush, the Start before the End', async () => {
    const startSiteVisit = vi.fn(async () => ({ id: VID }));
    const endSiteVisit = vi.fn(async () => null);
    signedIn(null, null, { startSiteVisit, endSiteVisit, startActivity: vi.fn(async () => null) });
    act(() => { s().queueSiteVisitAct(start, 'saved offline'); });
    await queueWritten();
    s().startActivity('B-1');
    await queueWritten();
    act(() => { s().queueSiteVisitAct(close, 'saved offline'); });
    await queueWritten();
    photoHold();
    s().sendSiteVisitAnyway(VID);
    await goOnline();
    const [startAt, endAt] = order(startSiteVisit, endSiteVisit);
    expect(startAt).toBeLessThan(endAt);
    expect(endAt).toBeLessThan(Infinity);
  });
  it('guard (4370280911): a held photo’s own act latches nothing: after Send anyway the visit’s End still goes', async () => {
    const startSiteVisit = vi.fn(async () => ({ id: VID }));
    const endSiteVisit = vi.fn(async () => null);
    const uploadMedia = vi.fn(async () => ({ id: 'm-1', url: '/media/m-1' }));
    signedIn(null, null, { startSiteVisit, endSiteVisit, uploadMedia });
    useStore.setState({ outbox: [start, photo, close] });
    photoHold();
    s().sendSiteVisitAnyway(VID);
    await goOnline();
    expect(uploadMedia).not.toHaveBeenCalled();
    const [startAt, endAt] = order(startSiteVisit, endSiteVisit);
    expect(startAt).toBeLessThan(endAt);
    expect(endAt).toBeLessThan(Infinity);
  });
});

