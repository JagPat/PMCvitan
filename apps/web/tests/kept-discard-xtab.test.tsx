import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act } from '@testing-library/react';
import { useStore, getInitialState } from '@/store/store';
import type { ApiGateway, OutboxOp } from '@/data/apiGateway';
import { discardKept } from '@/store/keptElsewhere';
import { createQueueKeyGuard } from '@/store/queueKeyGuard';
import { queueActIdent } from '@/store/queueActIdent';
import { releaseQueueLocks, storedQueue, unwatchFlushes, watchFlushes } from './queueWrites';

/**
 * #1388 U2 (Stage 1 G5): a discard in one tab, of an act another tab still holds in memory. The discard writes a done
 * fact for each act with an identity of its own, so the other tab's flush settles it unsent (`settleDone`) and never
 * sends it, whether or not it heard the key change. The other tab is this page's store; the discarding tab is a second
 * queue key guard on the same storage. Rows wait on queue locks and the store's flush calls, never a clock.
 */
const USER = 'u-pmc';
const SUB = `dev:${USER}`;
const P = 'p-1';
const key = `vitan.outbox.${SUB}.${P}`;
const s = () => useStore.getState();
const approve = (k: string, d = 'd-1'): OutboxOp => ({ t: 'approve', decisionId: d, optionIndex: 0, idempotencyKey: k });
const sentWith = (fn: ReturnType<typeof vi.fn>, k: string) => fn.mock.calls.filter((c) => JSON.stringify(c).includes(k)).length;
const hear = () => { act(() => { window.dispatchEvent(new StorageEvent('storage', { key, newValue: localStorage.getItem(key), storageArea: localStorage })); }); };
/** the discarding tab's guard: it reads the person's keys with their scopes, as its store does */
const theirs = () => createQueueKeyGuard(undefined, () => ({ evidence: SUB, visitPhoto: SUB }));

/** this tab holds `acts` in memory, loaded from the key */
function holding(acts: OutboxOp[], gw: Record<string, unknown>) {
  expect(createQueueKeyGuard().write(localStorage, key, acts)).toBe(true);
  useStore.setState({ ...getInitialState(), outbox: [], role: 'pmc', lang: 'en', sessionUserId: USER, activeProjectId: P, online: false });
  s()._setGateway({ project: P, listSiteVisits: vi.fn(async () => []), snapshot: vi.fn(async () => null), ...gw } as unknown as ApiGateway);
  s().hydrateOutbox();
  expect(s().outbox.map((o) => queueActIdent(o))).toEqual(acts.map((o) => queueActIdent(o)));
}

let flushes: ReturnType<typeof watchFlushes>;
const online = async () => { await flushes.atRest(); useStore.setState({ online: true }); await act(async () => { await s().flushOutbox(); }); await flushes.atRest(); };
beforeEach(() => { flushes = watchFlushes(); });
afterEach(async () => {
  vi.restoreAllMocks();
  releaseQueueLocks();
  await flushes.atRest();
  unwatchFlushes();
  s().completeSignOut();
  s()._setGateway(null);
  localStorage.clear();
});

describe('a discarded act another tab holds in memory is never sent (Stage 1 U2 G5)', () => {
  it('the other tab hears the key change: it sends only what was not discarded', async () => {
    const approveDecision = vi.fn(async () => null);
    holding([approve('k-a'), approve('k-b', 'd-2')], { approveDecision });
    const line = `act:${queueActIdent(approve('k-a'))}`;
    expect((await discardKept(localStorage, theirs(), SUB, P, line)).ok).toBe(true);
    hear();
    await online();
    expect(sentWith(approveDecision, 'k-a')).toBe(0);
    expect(sentWith(approveDecision, 'k-b')).toBe(1);
  });

  it('the other tab never hears it: its flush still does not send the discarded act', async () => {
    const approveDecision = vi.fn(async () => null);
    holding([approve('k-a')], { approveDecision });
    expect((await discardKept(localStorage, theirs(), SUB, P, null)).ok).toBe(true);
    expect(storedQueue(localStorage.getItem(key))).toEqual([]);
    await online();
    expect(sentWith(approveDecision, 'k-a')).toBe(0);
  });
});
