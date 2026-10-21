import 'fake-indexeddb/auto';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { act } from '@testing-library/react';
import { useStore, getInitialState } from '@/store/store';
import type { ApiGateway, OutboxOp } from '@/data/apiGateway';

/**
 * WEB-02 step 1 (#482 6326129029). Every tab of one person on one project shares the stored queue keys, and so does an
 * older or newer release's tab. A tab used to write each key whole from its memory:
 * - Codex 4338427583: an act another tab stored after this tab loaded (a newer release's act among them) was gone at
 *   this tab's next write, and nothing said so.
 * - #1071 F3 (Codex 4341067925): another tab's write of the visit lane from a stale read left out this tab's act,
 *   after this tab had said it was saved offline, and nothing answered it.
 *
 * Now each write reads the key and merges by act identity, and a write by another tab that leaves out an act this tab
 * holds is answered by writing it back, once per act.
 *
 * Every test here fails at d8337d3 except the ones marked as guards.
 */

const USER = 'u-cons';
const P1 = 'p-1';
const key = `vitan.outbox.dev:${USER}.${P1}`;
const lane = `vitan.siteVisitQueue.dev:${USER}.${P1}`;
const s = () => useStore.getState();
const end = (visitId: string, k: string): OutboxOp => ({ t: 'siteVisitEnd', visitId, claimedAt: '2026-10-14T05:30:00.000Z', idempotencyKey: k });
const approve = (k: string): OutboxOp => ({ t: 'approve', decisionId: 'd-1', optionIndex: 0, idempotencyKey: k });
const keysOf = (k: string) => ((JSON.parse(localStorage.getItem(k) ?? '[]') ?? []) as { idempotencyKey?: string }[]).map((o) => o.idempotencyKey);

/** signed in on P1 (passwordless dev auth), offline, both keys as given */
function signedIn(stored: { general?: unknown[]; lane?: unknown[] } = {}) {
  localStorage.setItem(key, JSON.stringify(stored.general ?? []));
  localStorage.setItem(lane, JSON.stringify(stored.lane ?? []));
  useStore.setState({ ...getInitialState(), outbox: [], role: 'consultant', lang: 'en', sessionUserId: USER, activeProjectId: P1, online: false });
  s()._setGateway({ project: P1, listSiteVisits: vi.fn(async () => []) } as unknown as ApiGateway);
  s().hydrateOutbox();
}
/** another tab's write of `k`; `heard` gives this tab the storage event the browser gives it */
function otherTab(k: string, list: unknown[], heard = true) {
  const text = JSON.stringify(list);
  localStorage.setItem(k, text);
  if (heard) act(() => { window.dispatchEvent(new StorageEvent('storage', { key: k, newValue: text, storageArea: localStorage })); });
}
/** another tab's write of `k`, heard: how many writes of `k` this tab makes in answer */
function writesInAnswer(k: string, list: unknown[]): number {
  const text = JSON.stringify(list);
  localStorage.setItem(k, text);
  const write = vi.spyOn(Storage.prototype, 'setItem');
  try {
    act(() => { window.dispatchEvent(new StorageEvent('storage', { key: k, newValue: text, storageArea: localStorage })); });
    return write.mock.calls.filter(([w]) => w === k).length;
  } finally { write.mockRestore(); }
}

afterEach(() => {
  s().completeSignOut();
  vi.restoreAllMocks();
  s()._setGateway(null);
  localStorage.clear();
  sessionStorage.clear();
});

describe('WEB-02 step 1: a stored queue key keeps every tab’s acts', () => {
  it('4338427583: an act another tab stored after this load, not heard, stays at this tab’s next write', () => {
    signedIn();
    otherTab(key, [approve('k-other')], false);
    act(() => { s().queueSiteVisitAct(end('v-1', 'k-mine'), 'saved offline'); });
    // this tab writes both keys again with an act of its own in each, and the other tab's act is still there
    useStore.setState((st) => { st.outbox = [...st.outbox, approve('k-mine-2')]; });
    act(() => { s().queueSiteVisitAct(end('v-2', 'k-mine-3'), 'saved offline'); });
    expect(keysOf(key)).toContain('k-other');
    expect(keysOf(key)).toContain('k-mine-2');
    expect(keysOf(lane)).toEqual(expect.arrayContaining(['k-mine', 'k-mine-3']));
  });

  it('4338427583: a newer release’s act kind stored after this load stays, unchanged', () => {
    signedIn();
    const newer = { t: 'aKindFromANewerRelease', idempotencyKey: 'k-new', extra: { a: 1 } };
    otherTab(key, [newer], false);
    useStore.setState((st) => { st.outbox = [...st.outbox, approve('k-mine')]; });
    act(() => { s().queueSiteVisitAct(end('v-1', 'k-v'), 'saved offline'); });
    const stored = JSON.parse(localStorage.getItem(key)!) as unknown[];
    expect(stored).toContainEqual(newer);
    expect(keysOf(key)).toContain('k-mine');
  });

  it('#1071 F3: another tab’s stale lane write, heard, has this tab’s act written back with the other tab’s', () => {
    signedIn();
    act(() => { s().queueSiteVisitAct(end('v-2', 'k-b'), 'saved offline'); });
    expect(keysOf(lane)).toEqual(['k-b']);
    otherTab(lane, [end('v-1', 'k-a')]);
    expect(keysOf(lane)).toEqual(['k-b', 'k-a']);
  });

  it('a stale write of the general key, heard, has this tab’s act written back with the other tab’s', () => {
    signedIn();
    useStore.setState((st) => { st.outbox = [...st.outbox, approve('k-b')]; });
    act(() => { s().queueSiteVisitAct(end('v-1', 'k-v'), 'saved offline'); });
    expect(keysOf(key)).toEqual(['k-b']);
    otherTab(key, [approve('k-a')]);
    expect(keysOf(key)).toEqual(['k-b', 'k-a']);
  });

  it('no write loop: an act left out again is not written back a second time, and this tab’s next write stores it', () => {
    signedIn();
    act(() => { s().queueSiteVisitAct(end('v-2', 'k-b'), 'saved offline'); });
    const stale = [end('v-1', 'k-a')];
    expect(writesInAnswer(lane, stale)).toBe(1);
    expect(keysOf(lane)).toEqual(['k-b', 'k-a']);
    // the other tab (an older release writing the lane whole) leaves it out again
    expect(writesInAnswer(lane, stale)).toBe(0);
    expect(writesInAnswer(lane, stale)).toBe(0);
    // memory still holds it, so it is sent from here, and this tab's own next write stores it again
    expect(s().outbox.map((o) => (o as { idempotencyKey?: string }).idempotencyKey)).toContain('k-b');
    act(() => { s().queueSiteVisitAct(end('v-3', 'k-c'), 'saved offline'); });
    expect(keysOf(lane)).toEqual(['k-b', 'k-c', 'k-a']);
  });

  it('guard: another tab’s write that keeps every act this tab holds is not answered', () => {
    signedIn();
    act(() => { s().queueSiteVisitAct(end('v-2', 'k-b'), 'saved offline'); });
    expect(writesInAnswer(lane, [end('v-2', 'k-b'), end('v-1', 'k-a')])).toBe(0);
    expect(keysOf(lane)).toEqual(['k-b', 'k-a']);
  });

  it('guard: a write of another project’s key is never answered from this project’s memory', () => {
    signedIn();
    act(() => { s().queueSiteVisitAct(end('v-2', 'k-b'), 'saved offline'); });
    const elsewhere = `vitan.siteVisitQueue.dev:${USER}.p-2`;
    expect(writesInAnswer(elsewhere, [])).toBe(0);
    expect(localStorage.getItem(elsewhere)).toBe('[]');
  });

  it('guard: an act this tab loaded and no longer holds is not kept by its next write', () => {
    signedIn({ general: [approve('k-gone'), approve('k-stays')] });
    expect(keysOf(key)).toEqual(['k-gone', 'k-stays']);
    useStore.setState((st) => { st.outbox = st.outbox.filter((o) => (o as { idempotencyKey?: string }).idempotencyKey !== 'k-gone'); });
    act(() => { s().queueSiteVisitAct(end('v-1', 'k-v'), 'saved offline'); });
    expect(keysOf(key)).toEqual(['k-stays']);
  });
});
