import 'fake-indexeddb/auto';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { act } from '@testing-library/react';
import { useStore, getInitialState } from '@/store/store';
import type { ApiGateway, OutboxOp } from '@/data/apiGateway';

/**
 * #1085 round 1, Codex 4345664670: a flush whose scope moved wrote its unsent acts beside the old scope's key; when that
 * key had turned unreadable and the copy aside could not be stored, they were dropped with only a console line. They are
 * now held, and loaded again when the person returns to that scope.
 *
 * The test fails at 85d1827.
 */

const USER = 'u-pmc';
const keyOf = (p: string) => `vitan.outbox.dev:${USER}.${p}`;
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
  it('the old key turned unreadable and no copy can be stored: the unsent act is held and comes back with its project', async () => {
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
    // p-2 loads; back on p-1, memory holds a2 again, and the key is still never written over
    act(() => { s().hydrateOutbox(); });
    vi.mocked(Storage.prototype.setItem).mockRestore();
    moveTo('p-1');
    useStore.setState({ online: false });
    act(() => { s().hydrateOutbox(); });
    expect(s().outbox).toEqual([approve('a2')]);
    expect(localStorage.getItem(keyOf('p-1'))).toBe('{bad');
  });
});

