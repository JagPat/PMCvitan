import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act } from '@testing-library/react';
import { useStore, getInitialState } from '@/store/store';
import type { ApiGateway, OutboxOp } from '@/data/apiGateway';
import { createQueueKeyGuard } from '@/store/queueKeyGuard';
import { queueWritten, releaseQueueLocks, storedQueue, unwatchFlushes, watchFlushes } from './queueWrites';

/**
 * xtab-drain redesign U1 (`notes/site-visits/web-02-U3/xtab-drain/redesign/plan.md` §3): a writer never drops an act
 * it only carried. After a landed write a tab's `known` held the write's whole `next`, so another tab's act the write
 * carried counted as one this tab held; its next write found memory no longer holding it and dropped it from the key.
 * `known` now holds only the occurrences memory held. Rows wait on storage events, queue locks and the store's flush
 * calls; acts are found by identity.
 */
const USER = 'u-pmc';
const P = 'p-1';
const key = `vitan.outbox.dev:${USER}.${P}`;
const s = () => useStore.getState();
const approve = (k: string): OutboxOp => ({ t: 'approve', decisionId: 'd-1', optionIndex: 0, idempotencyKey: k });
const DAMAGED = '{damaged';
const keysIn = (raw: string | null) => storedQueue<{ idempotencyKey?: string; t?: string }>(raw).map((o) => o.idempotencyKey ?? o.t);
const started = () => storedQueue<{ t?: string }>(localStorage.getItem(key)).filter((o) => o.t === 'startActivity').length;

function signedIn(gw: Record<string, unknown> = {}) {
  useStore.setState({ ...getInitialState(), outbox: [], role: 'pmc', lang: 'en', sessionUserId: USER, activeProjectId: P, online: false });
  s()._setGateway({ project: P, listSiteVisits: vi.fn(async () => []), snapshot: vi.fn(async () => null), ...gw } as unknown as ApiGateway);
  s().hydrateOutbox();
}
const hear = () => { act(() => { window.dispatchEvent(new StorageEvent('storage', { key, newValue: localStorage.getItem(key), storageArea: localStorage })); }); };

let flushes: ReturnType<typeof watchFlushes>;
beforeEach(() => { flushes = watchFlushes(); });
afterEach(async () => {
  releaseQueueLocks();
  await flushes.atRest();
  unwatchFlushes();
  s().completeSignOut();
  vi.restoreAllMocks();
  s()._setGateway(null);
  localStorage.clear();
  sessionStorage.clear();
});

describe('a writer never drops an act it only carried (xtab-drain redesign U1)', () => {
  it('forced probe (Stage 1 re-check of 82df57d, zz-twowrites): another tab keeps this tab\'s act across two of its own writes', () => {
    const A = createQueueKeyGuard();
    const B = createQueueKeyGuard();
    A.load(localStorage, key);
    B.load(localStorage, key);
    expect(A.write(localStorage, key, [approve('k-a')])).toBe(true);
    expect(B.write(localStorage, key, [approve('k-b')])).toBe(true); // it carries k-a, never held it
    expect(B.write(localStorage, key, [approve('k-b'), approve('k-c')])).toBe(true);
    expect(keysIn(localStorage.getItem(key))).toEqual(['k-a', 'k-b', 'k-c']);
  });

  it('guard: a writer still drops its own act it let go (sent here): its next write leaves it out', () => {
    const A = createQueueKeyGuard();
    A.load(localStorage, key);
    const ka = approve('k-a');
    expect(A.write(localStorage, key, [ka, approve('k-b')])).toBe(true);
    expect(A.settled(localStorage, key, ka)).toBe(true);
    expect(A.write(localStorage, key, [approve('k-b')])).toBe(true);
    expect(keysIn(localStorage.getItem(key))).toEqual(['k-b']);
  });

  for (const heardBetween of [false, true]) {
    it(`forced probe TW: this tab's offline act survives the other tab's two writes, and a reload still sends it once${heardBetween ? ' (first write heard)' : ''}`, async () => {
      const startActivity = vi.fn(async () => null);
      signedIn({ startActivity });
      const other = createQueueKeyGuard();
      expect(other.load(localStorage, key)).toEqual([]);
      s().startActivity('B-1');
      await queueWritten();
      expect(other.write(localStorage, key, [approve('k-b')])).toBe(true);
      if (heardBetween) hear();
      expect(other.write(localStorage, key, [approve('k-b'), approve('k-c')])).toBe(true);
      hear();
      expect(started()).toBe(1);
      // the page is opened again: what it sends is what the key kept
      act(() => { s().hydrateOutbox(); });
      await flushes.atRest();
      useStore.setState({ online: true });
      await act(async () => { await s().flushOutbox(); });
      await flushes.atRest();
      expect(startActivity).toHaveBeenCalledTimes(1);
    });
  }

  for (const second of [false, true]) {
    it(`${second ? 'forced probe' : 'guard'} TW2: a tab loaded after the damage, this tab sets aside, then that tab writes normally ${second ? 'twice' : 'once'}: k-a stays in the key`, async () => {
      expect(createQueueKeyGuard().write(localStorage, key, [approve('k-a')])).toBe(true);
      signedIn();
      localStorage.setItem(key, DAMAGED);
      hear();
      const other = createQueueKeyGuard();
      expect(other.load(localStorage, key)).toEqual([]);
      await act(async () => { await s().setAsideUnreadableQueue(); });
      other.heard(localStorage, key, []);
      expect(other.write(localStorage, key, [approve('k-b')])).toBe(true);
      hear();
      if (second) { expect(other.write(localStorage, key, [approve('k-b'), approve('k-c')])).toBe(true); hear(); }
      expect(keysIn(localStorage.getItem(key))).toContain('k-a');
    });
  }
});
