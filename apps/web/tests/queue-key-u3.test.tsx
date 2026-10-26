import 'fake-indexeddb/auto';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { act } from '@testing-library/react';
import { useStore, getInitialState } from '@/store/store';
import type { ApiGateway, OutboxOp } from '@/data/apiGateway';
import { createQueueKeyGuard } from '@/store/queueKeyGuard';
import { visitPhotoScope } from '@/data/visitPhotoStore';
import { queueWritten, releaseQueueLocks, storedQueue } from './queueWrites';

/**
 * WEB-02 U3a (plan `notes/site-visits/web-02-U3/r2/plan.md`, replacing #1122): what this tab holds when another tab
 * changes a queue key. Its findings, each a forced probe red at main by assertion:
 * - Codex 4353751507 (#1086): after another tab made the key unreadable, this tab still sent the acts it had loaded
 *   from it. That tab's bytes may hold them.
 * - Codex 4344812904 (#1084): a key that turned unreadable on another tab's write left this tab's acts only in memory.
 * - Codex 4358186342 (#1099 r1): a key another tab cleared was read as nothing to lose: Reload asked nothing.
 * - Codex 4370036882, 4370036886, 4370036888 (#1122 r1) and 4370280895 (#1122 r2): every read of a key's bytes
 *   reconciles from one snapshot, confirmed by a read again of the key, its sidecar and its marks.
 * Each probe waits on the queue's locks, a storage event or the gateway's calls, never a clock; acts are found by
 * their identity, never their place.
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
});

