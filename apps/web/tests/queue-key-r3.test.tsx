import 'fake-indexeddb/auto';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { act } from '@testing-library/react';
import { useStore, getInitialState } from '@/store/store';
import { createQueueKeyGuard } from '@/store/queueKeyGuard';
import type { ApiGateway, OutboxOp } from '@/data/apiGateway';

/**
 * #1085 round 3, Codex 4346778591: unsent acts a scope-moved write held stranded (their key unreadable, no copy aside
 * possible) came back into memory on the return to their scope, and the guard let go of them there, so nothing counted
 * them any more (a later reload asked about none and lost them). They stay held, and counted, until a write puts them
 * on this phone or they are settled.
 *
 * The guard's "a load hands the act back and still counts it" fails at c21b993.
 */

const USER = 'u-pmc';
const keyOf = (p: string) => `vitan.outbox.dev:${USER}.${p}`;
const s = () => useStore.getState();
const approve = (k: string): OutboxOp => ({ t: 'approve', decisionId: 'd-1', optionIndex: 0, idempotencyKey: k });
const moveTo = (p: string) => useStore.setState({ activeProjectId: p, projectScopeGeneration: s().projectScopeGeneration + 1 });
/** bytes a newer release wrote: a kind this release does not know */
const NEWER = JSON.stringify([{ t: 'someNewerKind', idempotencyKey: 'k-new' }]);

function onProject(p: string, gw: Record<string, unknown> = {}) {
  useStore.setState({ ...getInitialState(), outbox: [], role: 'pmc', lang: 'en', sessionUserId: USER, activeProjectId: p, online: false });
  s()._setGateway({ project: p, listSiteVisits: vi.fn(async () => []), snapshot: vi.fn(async () => null), ...gw } as unknown as ApiGateway);
  s().hydrateOutbox();
}

afterEach(() => {
  s().completeSignOut();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  s()._setGateway(null);
  localStorage.clear();
  sessionStorage.clear();
});

describe('#1085 r3, Codex 4346778591: acts held stranded stay counted until they are on this phone', () => {
  it('back on a project whose key a newer release now holds, the act held there is in memory again and the key is kept', async () => {
    const real = Storage.prototype.setItem;
    const approveDecision = vi.fn(async () => {
      // while a1 is sent: a newer release's tab writes p-1's key, and this tab moves to p-2
      real.call(localStorage, keyOf('p-1'), NEWER);
      moveTo('p-2');
      return null;
    });
    localStorage.setItem(keyOf('p-1'), JSON.stringify([approve('a1'), approve('a2')]));
    onProject('p-1', { approveDecision });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, k: string, v: string) {
      if (k.startsWith('vitan.unreadable.')) throw new DOMException('full', 'QuotaExceededError');
      return real.call(this, k, v);
    });
    useStore.setState({ online: true });
    await act(async () => { await s().flushOutbox(); });
    expect(approveDecision).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem(keyOf('p-1'))).toBe(NEWER);
    // back on p-1: a2 is in memory again; the key is a newer release's, so the strip lists it
    moveTo('p-1');
    useStore.setState({ online: false });
    act(() => { s().hydrateOutbox(); });
    expect(s().outbox).toEqual([approve('a2')]);
    expect(s().queueUnreadable.map((u) => [u.key, u.read])).toEqual([[keyOf('p-1'), 'newer']]);
    expect(localStorage.getItem(keyOf('p-1'))).toBe(NEWER);
  });
});

describe('#1085 r3: the guard lets go of a stranded act only once it is on this phone or settled', () => {
  const K = 'vitan.outbox.u.p';
  const a = (k: string): OutboxOp => approve(k);
  function storage(init: Record<string, string> = {}, copies = false) {
    const m = new Map(Object.entries(init));
    return {
      getItem: (k: string) => m.get(k) ?? null,
      setItem: (k: string, v: string) => { if (!copies && k.startsWith('vitan.unreadable.')) throw new DOMException('full', 'QuotaExceededError'); m.set(k, v); },
      map: m,
    };
  }

  it('a load hands the act back and still counts it; a write that stores it lets it go', () => {
    const st = storage({ [K]: NEWER });
    const q = createQueueKeyGuard();
    expect(q.keepUnsent(st, K, [a('a2')], [], (l) => l)).toBe(false);
    expect(q.strandedCount()).toBe(1);
    q.forget();
    expect(q.load(st, K)).toEqual([a('a2')]);
    expect(q.load(st, K)).toEqual([a('a2')]); // a load again hands it back again, once
    expect(q.strandedCount()).toBe(1);
    // the key turns readable (the newer tab's own write), and this tab's write stores the act
    st.map.set(K, '[]');
    expect(q.write(st, K, [a('a2')])).toBe(true);
    expect(q.strandedCount()).toBe(0);
  });

  it('a refused write lists it not kept and does not count it twice', () => {
    const st = storage({ [K]: NEWER });
    const q = createQueueKeyGuard();
    q.keepUnsent(st, K, [a('a2')], [], (l) => l);
    q.forget();
    q.load(st, K);
    expect(q.write(st, K, [a('a2'), a('b1')])).toBe(false);
    expect(q.notKept(K).length + q.strandedCount()).toBe(2);
  });

  it('an act memory no longer holds after the load (it was sent) is let go at the next write', () => {
    const st = storage({ [K]: NEWER });
    const q = createQueueKeyGuard();
    q.keepUnsent(st, K, [a('a2')], [], (l) => l);
    q.forget();
    q.load(st, K);
    q.write(st, K, []);
    expect(q.strandedCount()).toBe(0);
  });

  it('a copy aside that lands lets it go: it is on this phone', () => {
    const st = storage({ [K]: NEWER });
    const q = createQueueKeyGuard();
    q.keepUnsent(st, K, [a('a2')], [], (l) => l);
    q.forget();
    q.load(st, K);
    const ok = storage({ [K]: NEWER }, true);
    expect(q.keepUnsent(ok, K, [a('a2')], [], (l) => l)).toBe(true);
    expect(q.strandedCount()).toBe(0);
  });
});
