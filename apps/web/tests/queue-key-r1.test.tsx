import 'fake-indexeddb/auto';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { act } from '@testing-library/react';
import { useStore, getInitialState } from '@/store/store';
import type { ApiGateway, OutboxOp } from '@/data/apiGateway';
import { storedQueue } from './queueWrites';

/**
 * #1085 round 1. Three ways the queue key writer said an update was safe, or let it go, before it was on this phone:
 * - 4345664670: a flush whose scope moved wrote its unsent acts beside the old scope's key; when that key had turned
 *   unreadable and the copy aside could not be stored, they were dropped with only a console line. They are now held,
 *   counted by the reload question, and loaded again when the person returns to that scope.
 * - 4345664679: a Set aside tapped after the project changed and before its load copied the old project's key and wrote
 *   the old project's updates under the new project's keys. It now changes nothing until the load has run.
 * - 4345664686: Set aside cleared the strip before the write over the copied bytes; a write that failed left the strip
 *   gone and nothing saying so. The strip clears only once the write lands, and a failed one says so.
 *
 * Each test fails at 85d1827.
 */

const USER = 'u-pmc';
const keyOf = (p: string) => `vitan.outbox.dev:${USER}.${p}`;
const laneOf = (p: string) => `vitan.siteVisitQueue.dev:${USER}.${p}`;
const s = () => useStore.getState();
const approve = (k: string): OutboxOp => ({ t: 'approve', decisionId: 'd-1', optionIndex: 0, idempotencyKey: k });
const copiesOf = (k: string) => Object.keys(localStorage).filter((x) => x.startsWith(`vitan.unreadable.${k}.`));
const moveTo = (p: string) => useStore.setState({ activeProjectId: p, projectScopeGeneration: s().projectScopeGeneration + 1 });

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

describe('#1085 r1, Codex 4345664670: unsent acts of a scope left mid-flush are never dropped', () => {
  it('the old key turned unreadable and no copy can be stored: the unsent act is held, asked about, and comes back with its project', async () => {
    const real = Storage.prototype.setItem;
    const approveDecision = vi.fn(async () => {
      // while the first act is sent: another tab makes p-1's key unreadable, and this tab moves to p-2
      real.call(localStorage, keyOf('p-1'), '{bad');
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
    expect(localStorage.getItem(keyOf('p-1'))).toBe('{bad');
    expect(copiesOf(keyOf('p-1'))).toEqual([]);
    // on p-2, a reload asks first: a2 is on no key of this phone
    act(() => { s().hydrateOutbox(); });
    const ask = vi.fn(() => false);
    vi.stubGlobal('confirm', ask);
    const reload = vi.fn();
    vi.stubGlobal('location', { ...window.location, reload });
    act(() => s().reloadForNewerQueue());
    expect(ask).toHaveBeenCalledWith('1 updates aren’t saved on this phone and will be lost. Continue?');
    expect(reload).not.toHaveBeenCalled();
    // back on p-1, memory holds a2 again, and Set aside then stores it
    vi.mocked(Storage.prototype.setItem).mockRestore();
    moveTo('p-1');
    useStore.setState({ online: false });
    act(() => { s().hydrateOutbox(); });
    expect(s().outbox).toEqual([approve('a2')]);
    await act(async () => { await s().setAsideUnreadableQueue(); });
    expect(storedQueue(localStorage.getItem(keyOf('p-1'))!)).toEqual([approve('a2')]);
  });
});

describe('#1085 r1, Codex 4345664679: Set aside acts only for the scope its load ran for', () => {
  it('a tap after the project changed and before its load copies nothing and writes nothing under the new project', async () => {
    localStorage.setItem(keyOf('p-1'), '{bad');
    onProject('p-1');
    useStore.setState((st) => { st.outbox = [approve('k-p1')]; });
    expect(s().queueUnreadable.map((u) => u.key)).toEqual([keyOf('p-1')]);
    moveTo('p-2'); // the sign-in moved; p-2's load has not run yet
    await act(async () => { await s().setAsideUnreadableQueue(); });
    expect(copiesOf(keyOf('p-1'))).toEqual([]);
    expect(localStorage.getItem(keyOf('p-2'))).toBeNull();
    expect(localStorage.getItem(laneOf('p-2'))).toBeNull();
    expect(localStorage.getItem(keyOf('p-1'))).toBe('{bad');
  });

  it('guard: once the load has run, Set aside works as before', async () => {
    localStorage.setItem(keyOf('p-1'), '{bad');
    onProject('p-1');
    await act(async () => { await s().setAsideUnreadableQueue(); });
    expect(copiesOf(keyOf('p-1'))).toHaveLength(1);
    expect(s().queueUnreadable).toEqual([]);
    expect(s().queueSetAsideFailed).toBe(false);
  });
});

describe('#1085 r1, Codex 4345664686: Set aside is said done only once the write over the copied bytes lands', () => {
  it('the copy is made but the write over the key fails: the key stays listed and the strip says it could not be done', async () => {
    const raw = '{bad';
    localStorage.setItem(keyOf('p-1'), raw);
    onProject('p-1');
    useStore.setState((st) => { st.outbox = [approve('k-mine')]; });
    const real = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, k: string, v: string) {
      if (k === keyOf('p-1')) throw new DOMException('full', 'QuotaExceededError');
      return real.call(this, k, v);
    });
    await act(async () => { await s().setAsideUnreadableQueue(); });
    expect(localStorage.getItem(keyOf('p-1'))).toBe(raw);
    expect(s().queueUnreadable.map((u) => u.key)).toEqual([keyOf('p-1')]);
    expect(s().queueSetAsideFailed).toBe(true);
  });
});
