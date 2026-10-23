import 'fake-indexeddb/auto';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { useStore, getInitialState } from '@/store/store';
import type { ApiGateway, OutboxOp } from '@/data/apiGateway';
import { act } from '@testing-library/react';
import { holdQueueLock, nextToast, queueWritten, releaseQueueLocks } from './queueWrites';

/**
 * #1099 round 1 (Codex review 5626524014): four ways an act was only in memory, or sent before it was on this phone.
 * - 4358186338: a write with no cross-tab lock left its acts only in memory; a scope change then lost them.
 * - 4358186328: a write-ahead act was sent although its write had not stored it.
 * - 4358186342: a key another tab cleared read as an empty key: nothing was asked at Reload, and the acts this tab had
 *   seen there were taken as sent.
 * - 4358186333: Set aside, after waiting for the locks, copied and wrote over bytes another tab changed meanwhile.
 * Each forced probe here fails with its fix taken out (probes/r1-*.txt).
 */

const USER = 'u-pmc';
const P = 'p-1';
const key = `vitan.outbox.dev:${USER}.${P}`;
const lane = `vitan.siteVisitQueue.dev:${USER}.${P}`;
const s = () => useStore.getState();
const approve = (k: string): OutboxOp => ({ t: 'approve', decisionId: 'd-1', optionIndex: 0, idempotencyKey: k });
const visitEnd = (k: string): OutboxOp => ({ t: 'siteVisitEnd', visitId: '00000000-0000-4000-8000-000000000001', claimedAt: '2026-10-14T05:30:00.000Z', idempotencyKey: k } as OutboxOp);
const NEWER = JSON.stringify([{ t: 'aKindFromANewerRelease', idempotencyKey: 'k-newer' }]);
const idents = (raw: string | null) => (JSON.parse(raw ?? '[]') as { idempotencyKey?: string; t?: string }[]).map((o) => o.idempotencyKey ?? o.t);
const copiesOf = (k: string) => Object.keys(localStorage).filter((x) => x.startsWith(`vitan.unreadable.${k}.`)).map((x) => localStorage.getItem(x));
const madeHere = () => s().outbox.filter((o) => o.t === 'startActivity');

function signedIn(general: string | null, gw: Record<string, unknown> = {}) {
  if (general !== null) localStorage.setItem(key, general);
  useStore.setState({ ...getInitialState(), outbox: [], role: 'pmc', lang: 'en', sessionUserId: USER, activeProjectId: P, online: false });
  s()._setGateway({ project: P, listSiteVisits: vi.fn(async () => []), snapshot: vi.fn(async () => null), ...gw } as unknown as ApiGateway);
  s().hydrateOutbox();
}
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
afterEach(() => {
  useStore.setState({ flushOutbox: realFlush });
  releaseQueueLocks();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  s().completeSignOut();
  s()._setGateway(null);
  localStorage.clear();
  sessionStorage.clear();
});

describe('Codex 4358186338: an act whose write had no lock is never only in memory', () => {
  it('forced probe: it is copied aside beside its key, so a sign-out does not lose it', async () => {
    signedIn(null);
    locksRefused();
    const toast = nextToast();
    s().startActivity('B-1');
    await toast;
    expect(localStorage.getItem(key)).toBeNull();
    expect(copiesOf(key).map(idents)).toEqual([[madeHere()[0].idempotencyKey]]);
    vi.restoreAllMocks();
    s().completeSignOut();
    signedIn(null);
    expect(copiesOf(key)).toHaveLength(1); // still on this phone after the scope went
  });

  it('forced probe: when no copy can be made it is held stranded and comes back after a sign-out and sign-in', async () => {
    signedIn(null);
    locksRefused();
    copiesFail();
    const toast = nextToast();
    s().startActivity('B-1');
    await toast;
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
});

describe('Codex 4358186328: a write-ahead act is sent only once its write has stored it', () => {
  it('forced probe: its key cannot be written (storage refuses), so it is not sent; it is sent once a write stores it', async () => {
    const endSiteVisit = vi.fn(async () => null);
    signedIn(null, { endSiteVisit });
    useStore.setState({ online: true });
    const real = Storage.prototype.setItem;
    const refuse = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, k: string, v: string) {
      if (k === lane) throw new DOMException('full', 'QuotaExceededError');
      return real.call(this, k, v);
    });
    const flushed = flushesSettled();
    act(() => { s().queueSiteVisitAct(visitEnd('k-end'), 'queued'); });
    await act(async () => { await queueWritten(); });
    expect(s().toast).toBe('Not saved on this phone yet. Keep Vitan open until it sends.');
    await act(async () => { await s().flushOutbox(); await flushed(); });
    expect(endSiteVisit).not.toHaveBeenCalled();
    expect(s().outbox).toEqual([visitEnd('k-end')]);
    refuse.mockRestore();
    await act(async () => { await s().flushOutbox(); await flushed(); });
    expect(endSiteVisit).toHaveBeenCalledTimes(1);
  });

  it('forced probe: no lock can be had, so it is not sent', async () => {
    const endSiteVisit = vi.fn(async () => null);
    signedIn(null, { endSiteVisit });
    useStore.setState({ online: true });
    locksRefused();
    const flushed = flushesSettled();
    act(() => { s().queueSiteVisitAct(visitEnd('k-end'), 'queued'); });
    await act(async () => { await queueWritten(); });
    expect(s().toast).toBe('Not saved on this phone yet. Keep Vitan open until it sends.');
    await act(async () => { await s().flushOutbox(); await flushed(); });
    expect(endSiteVisit).not.toHaveBeenCalled();
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
});

describe('Codex 4358186342: a key another tab cleared reads as not saved, never as empty and sent', () => {
  for (const [how, heard] of [['its key removed', key], ['storage cleared', null]] as const) {
    it(`forced probe (${how}): Reload asks about the act, and the next write puts it back`, async () => {
      signedIn(JSON.stringify([approve('k-a')]));
      expect(s().outbox).toEqual([approve('k-a')]);
      if (heard === null) localStorage.clear(); else localStorage.removeItem(key);
      act(() => { window.dispatchEvent(new StorageEvent('storage', { key: heard, newValue: null, storageArea: localStorage })); });
      await queueWritten();
      expect(reloadAsks()).toEqual(['1 updates aren’t saved on this phone and will be lost. Continue?']);
      s().startActivity('B-1');
      await queueWritten();
      expect(idents(localStorage.getItem(key))).toEqual(['k-a', madeHere()[0].idempotencyKey]);
      expect(reloadAsks()).toEqual([]);
    });
  }
});

describe('Codex 4358186333: Set aside reads every key again once it holds the locks', () => {
  for (const told of [true, false]) {
    it(`forced probe: a damaged key replaced by a newer release's bytes while the tap waited is not touched${told ? '' : ' (its storage event not yet heard)'}`, async () => {
      signedIn('{damaged');
      expect(s().queueUnreadable).toEqual([{ key, read: 'damaged', reloaded: false }]);
      const other = holdQueueLock(key);
      await other.has;
      act(() => s().setAsideUnreadableQueue()); // waits behind the other tab's lock
      localStorage.setItem(key, NEWER);
      if (told) act(() => { window.dispatchEvent(new StorageEvent('storage', { key, newValue: NEWER, storageArea: localStorage })); });
      other.release();
      await act(async () => { await queueWritten(); });
      expect(localStorage.getItem(key)).toBe(NEWER);
      expect(copiesOf(key)).toEqual([]);
      expect(s().queueUnreadable).toEqual([{ key, read: 'newer', reloaded: false }]);
      expect(s().queueSetAsideFailed).toBe(false);
    });
  }

  it('guard: unchanged keys are still set aside after the wait', async () => {
    signedIn('{damaged');
    const other = holdQueueLock(key);
    await other.has;
    act(() => s().setAsideUnreadableQueue());
    other.release();
    await act(async () => { await queueWritten(); });
    expect(copiesOf(key)).toEqual(['{damaged']);
    expect(s().queueUnreadable).toEqual([]);
  });
});

describe('#1099 r1 root-cause audit: every path where an act could be only in memory', () => {
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
    await act(async () => { await asks; });
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
