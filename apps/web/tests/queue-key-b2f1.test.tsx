import 'fake-indexeddb/auto';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { act } from '@testing-library/react';
import { useStore, getInitialState } from '@/store/store';
import type { ApiGateway, OutboxOp } from '@/data/apiGateway';
import { holdQueueLock, nextToast, queueWritten, releaseQueueLocks, storedQueue } from './queueWrites';

/**
 * WEB-02 step B2f-1 (plan r3 v4, #1094 6382477473): every write of a stored queue key runs under one cross-tab Web Lock
 * per key, around main's writer, and "saved" waits for that write. Each forced probe holds another tab's lock (or has
 * none to give), so this tab's write waits or cannot run, and checks what this phone keeps meanwhile: after a sign-out,
 * a page close or `pagehide` (a fresh store module over the same storage, as a reload is), and a project switch.
 * - #1086 4346778582: another tab's bytes, written between this tab's read of the key and its write, were written over.
 * - #1079 4344270659, #1084 4344812898: "saved offline" was said before any write, and with no lock to be had.
 * - #1099 r1 4358186338: a write with no lock left its acts only in memory; 4358186328: a write-ahead act was sent
 *   before its write had run. An act whose write ran and could not store it is still sent from memory, said not saved
 *   (#1113 r1 re-check: never held from the server).
 * - #1099 r2 4358855955: an act whose write waited for its lock was only in memory the whole wait; 4358855946 and r3
 *   4360928308: a late write's answer started a flush, or said "saved", in another project; review-body P1: the flush
 *   returned before its end write.
 * - #1113 r1 4367242045, 4367242052: an offline act's write was untracked, and "saved" was judged across both keys.
 * - #1113 r2 4367436925: an act queued while the flush's later attempt waited for its lock was sent before its own
 *   write had run. A flush now sends only the acts queued before its wait; the rest go to its drain pass.
 * The probes wait on the locks, the toasts and the gateway's calls, never a clock. Each forced probe is red at main
 * (main never waits, so the wait's own probes hold there) or with its part of this change taken out (probes/).
 */

const USER = 'u-pmc';
const P = 'p-1';
const keyOf = (p: string) => `vitan.outbox.dev:${USER}.${p}`;
const laneOf = (p: string) => `vitan.siteVisitQueue.dev:${USER}.${p}`;
const key = keyOf(P);
const lane = laneOf(P);
const s = () => useStore.getState();
const NOT_SAVED = 'Not saved on this phone yet. Keep Vitan open until it sends.';
const NEWER = JSON.stringify([{ t: 'aKindFromANewerRelease', idempotencyKey: 'k-newer' }]);
const approve = (k: string): OutboxOp => ({ t: 'approve', decisionId: 'd-1', optionIndex: 0, idempotencyKey: k });
const visitEnd = (k: string): OutboxOp => ({ t: 'siteVisitEnd', visitId: '00000000-0000-4000-8000-000000000001', claimedAt: '2026-10-14T05:30:00.000Z', idempotencyKey: k } as OutboxOp);
const idents = (raw: string | null) => ((storedQueue(raw ?? '[]') ?? []) as { idempotencyKey?: string; t?: string }[]).map((o) => o.idempotencyKey ?? o.t);
const named = (prefix: string) => Object.keys(localStorage).filter((x) => x.startsWith(prefix));
const copiesOf = (k: string) => named(`vitan.unreadable.${k}.`).map((x) => localStorage.getItem(x));
const madeHere = (store: typeof useStore = useStore) => store.getState().outbox.filter((o) => o.t === 'startActivity');

type Store = typeof useStore;
function signedIn(general: string | null, gw: Record<string, unknown> = {}, store: Store = useStore, p = P, online = false) {
  if (general !== null) localStorage.setItem(keyOf(p), general);
  store.setState({ ...getInitialState(), outbox: [], role: 'pmc', lang: 'en', sessionUserId: USER, activeProjectId: p, online });
  store.getState()._setGateway({ project: p, listSiteVisits: vi.fn(async () => []), snapshot: vi.fn(async () => null), ...gw } as unknown as ApiGateway);
  store.getState().hydrateOutbox();
}
/** A page opens: a fresh store module over this phone's storage, signed in. A page opened after another is that page
 *  reloaded, or opened while the other is hidden or frozen: the other page's write still waiting for its lock is never
 *  finished by this one. */
async function page(gw: Record<string, unknown> = {}, online = false): Promise<Store> {
  vi.resetModules();
  const fresh = (await import('@/store/store')).useStore;
  signedIn(null, gw, fresh, P, online);
  return fresh;
}
/** every write asked for `k`'s lock before this has run */
const lockRan = (k: string) => navigator.locks.request(`vitan.queue.${k}`, () => undefined);
/** the browser refuses every Web Lock request */
const locksRefused = () => vi.spyOn(navigator.locks, 'request').mockImplementation((() => Promise.reject(new Error('no lock'))) as never);
/** this phone's storage takes no new copy aside (it is full) */
const copiesFail = () => {
  const real = Storage.prototype.setItem;
  return vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, k: string, v: string) {
    if (k.startsWith('vitan.unreadable.')) throw new DOMException('full', 'QuotaExceededError');
    return real.call(this, k, v);
  });
};
/** the Reload question, answered No: what it asked, if anything */
const reloadAsks = () => {
  const ask = vi.fn(() => false);
  vi.stubGlobal('confirm', ask);
  vi.stubGlobal('location', { ...window.location, reload: vi.fn() });
  act(() => s().reloadForNewerQueue());
  return ask.mock.calls.map((c) => (c as unknown[])[0]);
};
/** every flush the store starts, the act's own included, awaited: a probe waits on them, never on a clock */
const realFlush = useStore.getState().flushOutbox;
function flushesSettled(): () => Promise<void> {
  const started: Promise<unknown>[] = [];
  const real = s().flushOutbox;
  useStore.setState({ flushOutbox: ((...a: Parameters<typeof real>) => { const p = real(...a); started.push(p); return p; }) as typeof real });
  return async () => { while (started.length > 0) await Promise.all(started.splice(0)); };
}
/** each flush first reads this phone's visit photos: a test may act once that read is back (a signal). `visitRead()`
 *  settles when a read begun after it is back, never on a read already in flight (the load's own read, #1113 r2) */
let visitReadsBegun = 0;
const visitReads: { after: number; done: () => void }[] = [];
vi.mock('@/data/visitPhotoStore', async (importOriginal) => {
  const m = await importOriginal<typeof import('@/data/visitPhotoStore')>();
  return { ...m, listVisitPhotos: (...a: Parameters<typeof m.listVisitPhotos>) => {
    const n = ++visitReadsBegun;
    return m.listVisitPhotos(...a).then((rows) => {
      for (const w of visitReads.filter((x) => x.after < n)) { visitReads.splice(visitReads.indexOf(w), 1); w.done(); }
      return rows;
    });
  } };
});
const visitRead = () => new Promise<void>((done) => { visitReads.push({ after: visitReadsBegun, done }); });
/** every promise job queued so far has run (one task turn, not a duration): what a flush does after its read without
 *  waiting on anything outside this document has happened. "Not sent yet" has no signal of its own. */
const drained = () => new Promise<void>((r) => { setTimeout(r, 0); });

afterEach(async () => {
  releaseQueueLocks();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  // a write still waiting for its lock runs now, before the next test's storage
  for (const p of ['p-1', 'p-2']) { await lockRan(keyOf(p)); await lockRan(laneOf(p)); }
  useStore.setState({ flushOutbox: realFlush });
  s().completeSignOut();
  s()._setGateway(null);
  localStorage.clear();
  sessionStorage.clear();
});

describe('B2f-1: the write runs under the key’s lock, and "saved" waits for it', () => {
  it('forced probe (#1086 4346778582): another tab’s unreadable bytes, written right after this tab read the key, are never written over', async () => {
    signedIn(JSON.stringify([approve('k-a')]));
    // the names of the queue locks this tab runs under now: another tab that respects the lock writes the key only while
    // no tab runs under it; with none held it may write at any moment, here the worst one
    const running = new Set<string>();
    const request = navigator.locks.request.bind(navigator.locks) as (name: string, opts: unknown, cb?: () => unknown) => Promise<unknown>;
    vi.spyOn(navigator.locks, 'request').mockImplementation(((name: string, opts: unknown, cb?: () => unknown) => {
      const fn = (typeof opts === 'function' ? opts : cb) as () => unknown;
      return request(name, typeof opts === 'function' ? {} : opts, async () => {
        running.add(name);
        try { return await fn(); } finally { running.delete(name); }
      });
    }) as typeof navigator.locks.request);
    const real = { get: Storage.prototype.getItem, set: Storage.prototype.setItem };
    let armed = true;
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(function (this: Storage, k: string) {
      const read = real.get.call(this, k);
      if (armed && k === key) {
        armed = false;
        const theirs = () => real.set.call(localStorage, key, NEWER);
        if (running.has(`vitan.queue.${key}`)) void navigator.locks.request(`vitan.queue.${key}`, theirs);
        else theirs();
      }
      return read;
    });
    s().startActivity('B-1');
    await queueWritten();
    expect(localStorage.getItem(key)).toBe(NEWER);
    expect(madeHere()).toHaveLength(1); // still held here
  });

  it('forced probe (#1084 4344812898): “saved” is said only once the act is written on this phone', async () => {
    signedIn(null);
    const other = holdQueueLock(lane);
    await other.has;
    const said = nextToast();
    act(() => { s().queueSiteVisitAct(visitEnd('k-mine'), 'saved offline'); });
    expect(s().toast).toBeNull();
    expect(localStorage.getItem(lane)).toBeNull();
    other.release();
    expect(await said).toBe('saved offline');
    expect(idents(localStorage.getItem(lane))).toEqual(['k-mine']);
  });

  it('forced probe (#1079 4344270659): with no cross-tab lock nothing is written, and the person is told it is not saved yet', async () => {
    signedIn('[]');
    const locks = Object.getOwnPropertyDescriptor(navigator, 'locks')!;
    Object.defineProperty(navigator, 'locks', { value: undefined, configurable: true });
    try {
      const said = nextToast();
      act(() => { s().startActivity('B-1'); });
      expect(await said).toBe(NOT_SAVED);
      expect(localStorage.getItem(key)).toBe('[]');
      expect(madeHere()).toHaveLength(1); // still held here, and sent when online (below)
    } finally {
      Object.defineProperty(navigator, 'locks', locks);
    }
  });

  it('forced probe (#1113 r1 re-check): with no cross-tab lock, an offline act is sent from memory on reconnect in the same tab', async () => {
    const startActivity = vi.fn(async () => null);
    signedIn('[]', { startActivity });
    const locks = Object.getOwnPropertyDescriptor(navigator, 'locks')!;
    Object.defineProperty(navigator, 'locks', { value: undefined, configurable: true });
    try {
      const said = nextToast();
      act(() => { s().startActivity('B-1'); });
      expect(await said).toBe(NOT_SAVED);
      useStore.setState({ online: true });
      await act(async () => { await s().flushOutbox(); });
      expect(startActivity).toHaveBeenCalledTimes(1);
    } finally {
      Object.defineProperty(navigator, 'locks', locks);
    }
  });

  it('forced probe (#1113 r1 re-check): with its own key full, an offline act is sent from memory on reconnect in the same tab', async () => {
    const startActivity = vi.fn(async () => null);
    signedIn('[]', { startActivity });
    const real = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, k: string, v: string) {
      if (k === key) throw new DOMException('full', 'QuotaExceededError');
      return real.call(this, k, v);
    });
    const said = nextToast();
    act(() => { s().startActivity('B-1'); });
    expect(await said).toBe(NOT_SAVED);
    useStore.setState({ online: true });
    await act(async () => { await s().flushOutbox(); });
    expect(startActivity).toHaveBeenCalledTimes(1);
  });

  it('forced probe: an act whose write waits for the lock is counted, so Reload asks with N=1', async () => {
    signedIn(JSON.stringify([approve('k-a')]));
    const other = holdQueueLock(key);
    await other.has;
    s().startActivity('B-1'); // its write waits
    expect(reloadAsks()).toEqual(['1 updates aren’t saved on this phone and will be lost. Continue?']);
    other.release();
    await queueWritten();
    expect(reloadAsks()).toEqual([]); // once written, nothing is left to ask about
  });
});

describe('B2f-1: an act whose write had no lock is never only in memory (#1099 r1, Codex 4358186338)', () => {
  it('forced probe: it is copied aside beside its key, so a sign-out does not lose it', async () => {
    signedIn(null);
    locksRefused();
    const toast = nextToast();
    s().startActivity('B-1');
    expect(await toast).toBe(NOT_SAVED);
    expect(localStorage.getItem(key)).toBeNull();
    expect(copiesOf(key).map(idents)).toEqual([[madeHere()[0].idempotencyKey]]);
    vi.restoreAllMocks();
    s().completeSignOut();
    signedIn(null);
    expect(copiesOf(key)).toHaveLength(1); // still on this phone after the scope went
  });

  it('forced probe: when no copy can be made it is kept in a made record and comes back after a sign-out and sign-in', async () => {
    signedIn(null);
    locksRefused();
    copiesFail();
    const toast = nextToast();
    s().startActivity('B-1');
    expect(await toast).toBe(NOT_SAVED);
    const made = madeHere()[0].idempotencyKey;
    vi.restoreAllMocks();
    s().completeSignOut();
    const startActivity = vi.fn(async () => null);
    signedIn(null, { startActivity });
    expect(s().outbox.map((o) => (o as { idempotencyKey?: string }).idempotencyKey)).toEqual([made]);
    // and once sent it is let go
    useStore.setState({ online: true });
    await act(async () => { await s().flushOutbox(); });
    expect(startActivity).toHaveBeenCalledTimes(1);
    s().completeSignOut();
    signedIn(null);
    expect(s().outbox).toEqual([]);
  });

  it('audit (project switch): an act whose write had no lock is still on this phone after the switch', async () => {
    signedIn(null, { switchProject: vi.fn(async () => ({ role: 'pmc', token: 't-2', projectId: 'p-2' })) });
    locksRefused();
    const toast = nextToast();
    s().startActivity('B-1');
    await toast;
    const made = madeHere()[0].idempotencyKey;
    vi.restoreAllMocks();
    await act(async () => { await s().switchProject('p-2'); });
    expect(s().activeProjectId).toBe('p-2');
    expect(copiesOf(key).map(idents)).toEqual([[made]]);
  });

  /** this tab's flush whose reply lands after the project moved: `a2` is in memory only, its write never ran */
  const lateReply = () => {
    const approveDecision = vi.fn(async () => {
      useStore.setState({ activeProjectId: 'p-2', projectScopeGeneration: s().projectScopeGeneration + 1 });
      return null;
    });
    signedIn(JSON.stringify([approve('a1')]), { approveDecision });
    useStore.setState((st) => { st.outbox = [approve('a1'), approve('a2')]; st.online = true; });
    return approveDecision;
  };

  it('audit (late async reply, waiting for the lock): the unsent act is counted at Reload until its write runs, then kept', async () => {
    const other = holdQueueLock(key);
    await other.has;
    lateReply();
    // the flush's write of the key it left asks for the lock, and waits behind the other tab
    let asked!: () => void;
    const asks = new Promise<void>((r) => { asked = r; });
    const real = navigator.locks.request.bind(navigator.locks) as (...a: unknown[]) => Promise<unknown>;
    vi.spyOn(navigator.locks, 'request').mockImplementation(((...a: unknown[]) => { if (a[0] === `vitan.queue.${key}`) asked(); return real(...a); }) as never);
    let done = false;
    const flush = s().flushOutbox().then(() => { done = true; });
    // whichever comes first: the write asking for the lock (it waits), or the flush returning (its write did not wait)
    await act(async () => { await Promise.race([asks, flush]); });
    expect(done).toBe(false);
    act(() => s().hydrateOutbox()); // the new project's load: the strip now acts for it
    expect(reloadAsks()).toEqual(['1 updates aren’t saved on this phone and will be lost. Continue?']);
    other.release();
    await act(async () => { await flush; await queueWritten(); });
    expect(idents(localStorage.getItem(key))).toEqual(['a2']);
  });

  it('audit (late async reply, no lock): the unsent act is copied aside beside its key', async () => {
    lateReply();
    locksRefused();
    await act(async () => { await s().flushOutbox(); });
    expect(idents(localStorage.getItem(key))).toEqual(['a1']);
    expect(copiesOf(key).map(idents)).toEqual([['a2']]);
  });
});

describe('B2f-1: a write-ahead act is not sent while its write runs, and its write is on this phone when sent (#1099 r1, Codex 4358186328; #1113 r1 re-check)', () => {
  /** the visit acts the lane's made records hold when `endSiteVisit` is called */
  const recordedAtSend = () => {
    const at: (string | undefined)[][] = [];
    const endSiteVisit = vi.fn(async () => { at.push(named(`vitan.made.${lane}.`).flatMap((x) => idents(localStorage.getItem(x)))); return null; });
    return { endSiteVisit, at };
  };

  it('forced probe: its key cannot be written (storage refuses): it is said not saved, and sent from memory with its made record on this phone', async () => {
    const { endSiteVisit, at } = recordedAtSend();
    signedIn(null, { endSiteVisit });
    useStore.setState({ online: true });
    const real = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, k: string, v: string) {
      if (k === lane) throw new DOMException('full', 'QuotaExceededError');
      return real.call(this, k, v);
    });
    const flushed = flushesSettled();
    const said = nextToast();
    act(() => { s().queueSiteVisitAct(visitEnd('k-end'), 'queued'); });
    expect(await said).toBe(NOT_SAVED);
    await act(async () => { await queueWritten(); await flushed(); });
    expect(endSiteVisit).toHaveBeenCalledTimes(1);
    expect(at).toEqual([['k-end']]); // its retry record was on this phone when it was sent
  });

  it('forced probe: no lock can be had: it is said not saved, and sent from memory with its made record on this phone', async () => {
    const { endSiteVisit, at } = recordedAtSend();
    signedIn(null, { endSiteVisit });
    useStore.setState({ online: true });
    locksRefused();
    const flushed = flushesSettled();
    const said = nextToast();
    act(() => { s().queueSiteVisitAct(visitEnd('k-end'), 'queued'); });
    expect(await said).toBe(NOT_SAVED);
    await act(async () => { await flushed(); });
    expect(endSiteVisit).toHaveBeenCalledTimes(1);
    expect(at).toEqual([['k-end']]);
  });

  it('guard: an act its own key stored is sent although the other key could not be written', async () => {
    const endSiteVisit = vi.fn(async () => null);
    signedIn('{damaged', { endSiteVisit, approveDecision: vi.fn(async () => null) });
    useStore.setState({ online: true });
    useStore.setState((st) => { st.outbox = [approve('k-held')]; });
    const flushed = flushesSettled();
    act(() => { s().queueSiteVisitAct(visitEnd('k-end-own'), 'queued'); });
    await queueWritten();
    await act(async () => { await s().flushOutbox(); await flushed(); });
    expect(endSiteVisit).toHaveBeenCalledTimes(1);
  });

  it('forced probe (C2b): a drawing publish is sent only once its locked write has stored it', async () => {
    signedIn('[]');
    let atSend: string | null | undefined;
    let sent!: () => void;
    const send = new Promise<void>((r) => { sent = r; });
    const publishDrawing = vi.fn(async () => { atSend ??= localStorage.getItem(key); sent(); return null; });
    s()._setGateway({ project: P, listSiteVisits: vi.fn(async () => []), snapshot: vi.fn(async () => null), publishDrawing } as unknown as ApiGateway);
    const other = holdQueueLock(key);
    await other.has;
    const read = visitRead();
    useStore.setState((st) => { st.online = true; st.projectLoadState = 'ready'; st.drawings = [{ id: 'DWG-1', number: 'A-1', draft: true, current: { id: 'r' }, revisions: [] } as never]; });
    act(() => { s().publishAllDrafts(); });
    await read; // the flush has read; its write still waits behind the other tab
    await drained();
    expect(publishDrawing).not.toHaveBeenCalled();
    other.release();
    await send;
    expect(storedQueue<{ t: string }>(atSend ?? '[]').map((o) => o.t)).toEqual(['publishDrawing']);
  });

  it('forced probe (C2b): an act whose write waits behind another tab is not sent by an earlier act’s flush', async () => {
    signedIn('[]');
    let atSend: string | null | undefined;
    let sent!: () => void;
    const send = new Promise<void>((r) => { sent = r; });
    const publishDrawing = vi.fn(async () => { atSend ??= localStorage.getItem(key); sent(); return null; });
    s()._setGateway({ project: P, listSiteVisits: vi.fn(async () => []), snapshot: vi.fn(async () => null), startDailyLog: vi.fn(async () => null), publishDrawing } as unknown as ApiGateway);
    const first = holdQueueLock(key);
    await first.has;
    useStore.setState({ online: true });
    act(() => { s().startDailyLog(); }); // its write waits behind the other tab
    const second = holdQueueLock(key); // the other tab asks again, ahead of the next write
    useStore.setState((st) => { st.projectLoadState = 'ready'; st.drawings = [{ id: 'DWG-1', number: 'A-1', draft: true, current: { id: 'r' }, revisions: [] } as never]; });
    const read = visitRead(); // the flush the publish starts reads this phone's visit photos first
    act(() => { s().publishAllDrafts(); }); // its write waits behind that
    first.release();
    await second.has;
    await read; // the first act's flush has read; the publish's write still waits
    await drained();
    expect(publishDrawing).not.toHaveBeenCalled();
    second.release();
    await send;
    expect(storedQueue<{ t: string }>(atSend ?? '[]').map((o) => o.t)).toContain('publishDrawing');
  });
});

describe('B2f-1: an act whose write waits for its lock is on this phone the whole wait (#1099 r2, Codex 4358855955)', () => {
  it('forced probe: an offline act waiting behind another tab comes back after a sign-out and sign-in, while the lock is still held', async () => {
    signedIn(null);
    const other = holdQueueLock(key);
    await other.has;
    s().startActivity('B-1');
    const made = madeHere()[0].idempotencyKey;
    s().completeSignOut();
    signedIn(null);
    expect(s().outbox.map((o) => (o as { idempotencyKey?: string }).idempotencyKey)).toEqual([made]);
  });

  it('forced probe (close): a page closed while its write waits for the lock has the act back after the reload', async () => {
    const first = await page();
    const other = holdQueueLock(key);
    await other.has;
    first.getState().startActivity('B-1');
    const made = madeHere(first)[0].idempotencyKey;
    // the page closes: its write never runs. The other tab still holds the lock
    const next = await page();
    expect(next.getState().outbox.map((o) => (o as { idempotencyKey?: string }).idempotencyKey)).toEqual([made]);
  });

  it('forced probe (pagehide): a page hidden while its write waits has the act on this phone; restored, its write lands once', async () => {
    const first = await page();
    const other = holdQueueLock(key);
    await other.has;
    const said = nextToastOf(first);
    first.getState().startActivity('B-1');
    const made = madeHere(first)[0].idempotencyKey;
    // the page is hidden (put in the back-forward cache, or frozen): nothing of it runs, and nothing said it was saved
    window.dispatchEvent(new Event('pagehide'));
    expect(first.getState().toast).toBeNull();
    // a page opened meanwhile takes the act from this phone
    const next = await page();
    expect(next.getState().outbox.map((o) => (o as { idempotencyKey?: string }).idempotencyKey)).toEqual([made]);
    // the hidden page comes back: its waiting write runs, once, and only then is the act said saved
    window.dispatchEvent(new Event('pageshow'));
    other.release();
    expect(await said).toContain('saved offline');
    await lockRan(key);
    expect(idents(localStorage.getItem(key))).toEqual([made]);
    expect(named(`vitan.made.${key}.`)).toEqual([]);
  });

  it('forced probe (review-body P1): a sent act is not loaded again by a page closed before the flush removes it, and the flush returns only once it is removed', async () => {
    localStorage.setItem(key, JSON.stringify([approve('k-sent')]));
    const approveDecision = vi.fn(async () => null);
    const first = await page({ approveDecision }, true);
    const other = holdQueueLock(key);
    await other.has;
    let done = false;
    const flushed = first.getState().flushOutbox().then(() => { done = true; });
    await vi.waitFor(() => expect(approveDecision).toHaveBeenCalledTimes(1));
    await act(async () => {});
    // the key still holds the sent act (its removal waits for the lock), and the flush has not returned
    expect(idents(localStorage.getItem(key))).toEqual(['k-sent']);
    expect(done).toBe(false);
    // a page opened now (the first one closed) does not load it: it is marked settled
    const next = await page();
    expect(next.getState().outbox).toEqual([]);
    other.release();
    await flushed;
    expect(idents(localStorage.getItem(key))).toEqual([]);
    expect(named('vitan.settled.')).toEqual([]);
  });
});

describe('B2f-1: a late write’s answer stays in its scope (#1099 r2 4358855946, r3 4360928308)', () => {
  it('forced probe: a write-ahead act made in one project never starts a flush (with its success line) after a switch to another', async () => {
    signedIn(null, { endSiteVisit: vi.fn(async () => null) }, useStore, P, true);
    const other = holdQueueLock(lane);
    await other.has;
    act(() => { s().queueSiteVisitAct(visitEnd('k-end-a'), 'queued'); });
    // the person moves to project p-2, which has its own queued act
    const approveB = vi.fn(async () => null);
    localStorage.setItem(keyOf('p-2'), JSON.stringify([approve('k-b')]));
    useStore.setState({ activeProjectId: 'p-2', projectScopeGeneration: s().projectScopeGeneration + 1 });
    s()._setGateway({ project: 'p-2', listSiteVisits: vi.fn(async () => []), snapshot: vi.fn(async () => null), approveDecision: approveB } as unknown as ApiGateway);
    s().hydrateOutbox();
    const afterSwitch: unknown[] = [];
    useStore.setState({ flushOutbox: ((o?: unknown) => { afterSwitch.push(o); return realFlush(o as never); }) as typeof realFlush });
    other.release();
    await act(async () => { await lockRan(lane); await Promise.resolve(); });
    await act(async () => {});
    expect({ startedOnB: afterSwitch.length, sentB: approveB.mock.calls.length }).toEqual({ startedOnB: 0, sentB: 0 });
    // A's act is in its own lane, sent from p-1's next flush
    expect(idents(localStorage.getItem(lane))).toEqual(['k-end-a']);
  });

  it('forced probe: an offline act’s “saved” line, after a switch to another project, is not said there', async () => {
    signedIn(null);
    const other = holdQueueLock(key);
    await other.has;
    s().startActivity('B-1');
    useStore.setState({ activeProjectId: 'p-2', projectScopeGeneration: s().projectScopeGeneration + 1, toast: null });
    s()._setGateway({ project: 'p-2', listSiteVisits: vi.fn(async () => []), snapshot: vi.fn(async () => null) } as unknown as ApiGateway);
    s().hydrateOutbox();
    other.release();
    await act(async () => { await lockRan(key); await Promise.resolve(); });
    expect(s().toast).toBeNull();
    expect(idents(localStorage.getItem(key))).toHaveLength(1); // written to its own project's key
  });
});

describe('#1113 r1: an offline act’s write is tracked, and judged by its own key', () => {
  it('forced probe (Codex 4367242045): an offline act whose write waits behind another tab is not sent by a reconnect flush first', async () => {
    let atSend: string | null | undefined;
    let sent!: () => void;
    const send = new Promise<void>((r) => { sent = r; });
    const startActivity = vi.fn(async () => { atSend ??= localStorage.getItem(key); sent(); return null; });
    signedIn('[]', { startActivity });
    const other = holdQueueLock(key);
    await other.has;
    s().startActivity('B-1'); // offline: its write waits behind the other tab
    const made = madeHere()[0].idempotencyKey;
    // the phone comes back online before the other tab lets the lock go
    useStore.setState({ online: true });
    const read = visitRead();
    const flushed = s().flushOutbox();
    await read; // the flush has read this phone's visit photos
    await drained();
    expect(startActivity).not.toHaveBeenCalled();
    other.release();
    await send;
    await flushed;
    expect(idents(atSend ?? null)).toEqual([made]); // its key held it when it was sent
    expect(startActivity).toHaveBeenCalledTimes(1);
  });

  it('forced probe (Codex 4367242052): an offline act its own key stored is said saved although the other key could not be written', async () => {
    localStorage.setItem(lane, NEWER); // the visit lane holds a newer release's bytes: its write is refused
    signedIn('[]');
    const said = nextToast();
    s().startActivity('B-1');
    expect(await said).toContain('saved offline');
    expect(idents(localStorage.getItem(key))).toEqual([madeHere()[0].idempotencyKey]);
  });

  it('guard: an offline act its own key could not store is said not saved, whatever the other key did', async () => {
    signedIn(NEWER);
    const said = nextToast();
    s().startActivity('B-1');
    expect(await said).toBe(NOT_SAVED);
    expect(localStorage.getItem(key)).toBe(NEWER);
  });
});

/** the next toast `store` shows */
function nextToastOf(store: Store): Promise<string | null> {
  return new Promise((resolve) => {
    const stop = store.subscribe((st, was) => { if (st.toast !== was.toast && st.toast) { stop(); resolve(st.toast); } });
  });
}

describe('#1113 r2: an act queued while a flush waits for writes is sent only after its own write, and always sent (Codex 4367436925)', () => {
  const VA = '00000000-0000-4000-8000-00000000000a';
  const VB = '00000000-0000-4000-8000-00000000000b';
  const endOf = (visitId: string, k: string): OutboxOp => ({ t: 'siteVisitEnd', visitId, claimedAt: '2026-10-14T05:30:00.000Z', idempotencyKey: k } as OutboxOp);
  /** each visit End sent: its key, and the keys its lane held at that moment */
  const recordedSends = (onSend: (k: string) => Promise<void> | void = () => undefined) => {
    const sends: { key: string; laneAtSend: (string | undefined)[] }[] = [];
    const endSiteVisit = vi.fn(async (...a: unknown[]) => { sends.push({ key: a[2] as string, laneAtSend: idents(localStorage.getItem(lane)) }); await onSend(a[2] as string); return null; });
    return { endSiteVisit, sends };
  };
  /** `laneAsk()`: settles at the next request for the lane's lock made after it is called (a signal), whoever asks. An
   *  act's own write asks synchronously when the act is queued */
  const laneAsks = () => {
    const waiting: (() => void)[] = [];
    const request = navigator.locks.request.bind(navigator.locks) as (...a: unknown[]) => Promise<unknown>;
    vi.spyOn(navigator.locks, 'request').mockImplementation(((...a: unknown[]) => {
      if (a[0] === `vitan.queue.${lane}`) for (const w of waiting.splice(0)) w();
      return request(...a);
    }) as never);
    return () => new Promise<void>((r) => { waiting.push(r); });
  };
  /** an act its lane refuses to store (storage full for that key): it waits for a flush's later attempt */
  const unstoredAct = async (op: OutboxOp) => {
    const real = Storage.prototype.setItem;
    const refuse = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, k: string, v: string) {
      if (k === lane) throw new DOMException('full', 'QuotaExceededError');
      return real.call(this, k, v);
    });
    act(() => { s().queueSiteVisitAct(op, 'queued'); });
    await lockRan(lane);
    await lockRan(keyOf(P));
    refuse.mockRestore();
  };
  /** every act sent once its own lane held it, each act sent once, and nothing left */
  const sentAfterItsWrite = (sends: { key: string; laneAtSend: (string | undefined)[] }[], keys: string[]) => {
    expect(sends.map((x) => x.key).sort()).toEqual(keys);
    for (const x of sends) expect(x.laneAtSend, x.key).toContain(x.key);
    expect(s().outbox).toEqual([]);
  };

  it('forced probe (Codex 4367436925): queued while the flush’s later attempt waits behind another tab, it is not sent before its write, and is sent once it has run', async () => {
    const { endSiteVisit, sends } = recordedSends();
    signedIn(null, { endSiteVisit });
    await unstoredAct(endOf(VA, 'k-a'));
    const other = holdQueueLock(lane);
    await other.has;
    const laneAsk = laneAsks();
    const settled = flushesSettled();
    act(() => { useStore.setState({ online: true }); });
    const retryAsks = laneAsk();
    void s().flushOutbox();
    await retryAsks; // the flush's later attempt for k-a waits behind the other tab
    const again = holdQueueLock(lane); // the other tab asks again, behind that attempt: k-b's write waits after it
    act(() => { s().queueSiteVisitAct(endOf(VB, 'k-b'), 'queued'); });
    const flushWrites = laneAsk(); // the flush's own end write, once it has sent what it took
    other.release();
    await act(async () => { await flushWrites; });
    const laneHad = idents(localStorage.getItem(lane));
    again.release();
    await act(async () => { await settled(); await queueWritten(); });
    expect(laneHad).not.toContain('k-b'); // the probe ran: k-b's write was still waiting
    sentAfterItsWrite(sends, ['k-a', 'k-b']);
  });

  it('forced probe (audit W2): an act queued while the flush waits for a running write does not hold back the earlier act, and is sent after its own write', async () => {
    const { endSiteVisit, sends } = recordedSends();
    signedIn(null, { endSiteVisit });
    const other = holdQueueLock(lane);
    await other.has;
    const settled = flushesSettled();
    act(() => { useStore.setState({ online: true }); s().queueSiteVisitAct(endOf(VA, 'k-a'), 'queued'); }); // its write waits
    const read = visitRead();
    void s().flushOutbox(); // a flush (a reconnect's) waits for k-a's write, once its photo read is back
    await read;
    await drained();
    const again = holdQueueLock(lane); // behind k-a's write: k-b's write waits after it
    act(() => { s().queueSiteVisitAct(endOf(VB, 'k-b'), 'queued'); });
    other.release();
    await again.has; // k-a's write has run; k-b's write still waits
    await act(async () => { await drained(); }); // what the flush does next without waiting on anything outside has happened
    const whileWaiting = { sent: sends.map((x) => x.key), laneHas: idents(localStorage.getItem(lane)) };
    // released and settled before any assertion, so a red here leaves no lock or flush behind for the next test
    again.release();
    await act(async () => { await settled(); await queueWritten(); });
    expect(whileWaiting.laneHas).not.toContain('k-b'); // the probe ran: k-b's write was still waiting
    expect(whileWaiting.sent).toEqual(['k-a']); // the earlier act went out without waiting for k-b's write
    sentAfterItsWrite(sends, ['k-a', 'k-b']);
  });

  it('guard (audit W4): an act queued while an earlier act is on its way is sent after its own write, by the drain pass', async () => {
    let answer!: () => void;
    const first = new Promise<void>((r) => { answer = r; });
    let sending!: () => void;
    const onItsWay = new Promise<void>((r) => { sending = r; });
    const { endSiteVisit, sends } = recordedSends(async (k) => { if (k === 'k-a') { sending(); await first; } });
    signedIn(null, { endSiteVisit }, useStore, P, true);
    const settled = flushesSettled();
    act(() => { s().queueSiteVisitAct(endOf(VA, 'k-a'), 'queued'); });
    await onItsWay;
    const other = holdQueueLock(lane); // k-b's write waits behind another tab while k-a is on its way
    await other.has;
    const laneAsk = laneAsks();
    act(() => { s().queueSiteVisitAct(endOf(VB, 'k-b'), 'queued'); });
    const flushWrites = laneAsk();
    answer();
    await act(async () => { await flushWrites; });
    const laneHad = idents(localStorage.getItem(lane));
    other.release();
    await act(async () => { await settled(); await queueWritten(); });
    expect(laneHad).not.toContain('k-b'); // the guard ran: k-b's write was still waiting when the flush wrote
    sentAfterItsWrite(sends, ['k-a', 'k-b']);
  });
});
