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

  it('#1079 4344270659: every stale write that leaves out an act made here is answered, once each, so the act stays stored', () => {
    signedIn();
    act(() => { s().queueSiteVisitAct(end('v-2', 'k-b'), 'saved offline'); });
    const stale = [end('v-1', 'k-a')];
    // an older release writes the lane whole from a read before this tab's act, three times: each write is answered once
    for (let n = 0; n < 3; n += 1) {
      expect(writesInAnswer(lane, stale)).toBe(1);
      expect(keysOf(lane)).toEqual(['k-b', 'k-a']);
    }
  });

  it('#1079 4344270652: a lane entry of a kind this release leaves out of memory stays stored at this tab’s writes', () => {
    const newer = { t: 'visitVoiceNote', visitId: 'v-1', idempotencyKey: 'k-newer' };
    const photo = { t: 'siteVisitAddFile', visitId: 'v-1', scope: 's', file: { id: 'f', mime: 'image/png' }, by: { name: 'n', role: 'pmc' }, placeName: null, idempotencyKey: 'k-photo' };
    signedIn({ lane: [newer, photo] });
    act(() => { s().queueSiteVisitAct(end('v-2', 'k-mine'), 'saved offline'); });
    expect(keysOf(lane)).toEqual(['k-mine', 'k-newer', 'k-photo']);
  });

  it('#1079 4344270652: a site visit act stored in the general key, which memory leaves out, stays stored there', () => {
    signedIn({ general: [end('v-1', 'k-in-general'), approve('k-a')] });
    useStore.setState((st) => { st.outbox = [...st.outbox, approve('k-b')]; });
    act(() => { s().queueSiteVisitAct(end('v-2', 'k-v'), 'saved offline'); });
    expect(keysOf(key)).toEqual(['k-a', 'k-b', 'k-in-general']);
  });

  it('#1079 4344270663: a newer release’s list holding an entry that is not an act is never written over by this tab', () => {
    const newer = ['v3:queue-format', approve('k-n')];
    signedIn();
    localStorage.setItem(key, JSON.stringify(newer));
    useStore.setState((st) => { st.outbox = [...st.outbox, approve('k-mine')]; });
    act(() => { s().queueSiteVisitAct(end('v-2', 'k-v'), 'saved offline'); });
    expect(JSON.parse(localStorage.getItem(key)!)).toEqual(newer);
    expect(keysOf(lane)).toEqual(['k-v']);
  });

  it('#1079 4344436665: an act this tab cannot store beside a newer release’s list is copied aside, once, so it stays on this phone', () => {
    signedIn();
    const newer = JSON.stringify(['v3:queue-format', approve('k-n')]);
    localStorage.setItem(key, newer);
    useStore.setState((st) => { st.outbox = [...st.outbox, approve('k-mine')]; });
    act(() => { s().queueSiteVisitAct(end('v-1', 'k-v'), 'saved offline'); });
    act(() => { s().queueSiteVisitAct(end('v-2', 'k-v2'), 'saved offline'); });
    expect(localStorage.getItem(key)).toBe(newer);
    const asides = Object.keys(localStorage).filter((x) => x.startsWith(`vitan.unreadable.${key}.`)).map((x) => JSON.parse(localStorage.getItem(x)!) as OutboxOp[]);
    expect(asides).toEqual([[approve('k-mine')]]);
  });

  it('#1079 4344436669: an older tab’s write landing between this tab’s read and its write is put back once its event is heard', () => {
    signedIn();
    const realSet = Storage.prototype.setItem;
    let armed = true;
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, k: string, v: string) {
      // the older tab's write lands after this tab's read of the key, just before this tab's write
      if (armed && k === key) { armed = false; realSet.call(this, key, JSON.stringify([approve('k-old')])); }
      realSet.call(this, k, v);
    });
    useStore.setState((st) => { st.outbox = [...st.outbox, approve('k-mine')]; });
    act(() => { s().queueSiteVisitAct(end('v-1', 'k-v'), 'saved offline'); });
    vi.restoreAllMocks();
    expect(keysOf(key)).toEqual(['k-mine']); // this tab's write went over it
    act(() => { window.dispatchEvent(new StorageEvent('storage', { key, newValue: JSON.stringify([approve('k-old')]), storageArea: localStorage })); });
    expect(keysOf(key)).toEqual(['k-mine', 'k-old']);
  });

  it('guard: a heard write whose act another write since has taken off is not put back', () => {
    signedIn();
    useStore.setState((st) => { st.outbox = [...st.outbox, approve('k-mine')]; });
    act(() => { s().queueSiteVisitAct(end('v-1', 'k-v'), 'saved offline'); });
    // another tab wrote k-x, then sent it and wrote k-other instead; this tab hears the first of those writes late
    localStorage.setItem(key, JSON.stringify([approve('k-mine'), approve('k-other')]));
    const write = vi.spyOn(Storage.prototype, 'setItem');
    act(() => { window.dispatchEvent(new StorageEvent('storage', { key, newValue: JSON.stringify([approve('k-mine'), approve('k-x')]), storageArea: localStorage })); });
    expect(write.mock.calls.filter(([w]) => w === key)).toEqual([]);
    write.mockRestore();
    expect(keysOf(key)).toEqual(['k-mine', 'k-other']);
  });

  it('#1079 4344436672: lane entries memory leaves out stay stored through the flush’s scope-moved write', async () => {
    const newer = { t: 'visitVoiceNote', visitId: 'v-1', idempotencyKey: 'k-newer' };
    const photo = { t: 'siteVisitAddFile', visitId: 'v-1', scope: 's', file: { id: 'f', mime: 'image/png' }, by: { name: 'n', role: 'pmc' }, placeName: null, idempotencyKey: 'k-photo' };
    signedIn({ lane: [newer, photo] });
    const approveDecision = vi.fn(async () => {
      useStore.setState({ activeProjectId: 'p-2', projectScopeGeneration: s().projectScopeGeneration + 1 });
      return null;
    });
    s()._setGateway({ project: P1, approveDecision, snapshot: vi.fn(async () => null), listSiteVisits: vi.fn(async () => []) } as unknown as ApiGateway);
    useStore.setState((st) => { st.outbox = [approve('a1'), approve('a2')]; st.online = true; });
    await act(async () => { await s().flushOutbox(); });
    expect(approveDecision).toHaveBeenCalledTimes(1);
    expect(keysOf(lane)).toEqual(['k-newer', 'k-photo']);
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

  it('guard: after the project moved and before its load, another tab’s write of the new project’s lane is not answered', () => {
    signedIn();
    act(() => { s().queueSiteVisitAct(end('v-1', 'k-p1'), 'saved offline'); });
    useStore.setState({ activeProjectId: 'p-2' }); // the switch is adopted; the load runs later, from useApiSync's effect
    const p2 = `vitan.siteVisitQueue.dev:${USER}.p-2`;
    otherTab(p2, [end('v-9', 'k-p2')]);
    expect(keysOf(p2)).toEqual(['k-p2']);
  });

  it('guard: an act kept through sign-out is not deleted when the same person is back on the project before its load', () => {
    signedIn({ general: [approve('k-kept')] });
    act(() => { s().completeSignOut(); });
    useStore.setState({ sessionUserId: USER, activeProjectId: P1, role: 'consultant' }); // the load runs later
    otherTab(key, [approve('k-kept'), approve('k-other')]);
    expect(keysOf(key)).toEqual(['k-kept', 'k-other']);
  });

  it('a scope move mid-flush keeps another tab’s act and stores this tab’s unsent act once, by identity', async () => {
    signedIn();
    const approveDecision = vi.fn(async () => {
      // another tab, loaded before a1 and a2, writes its act merged with what it read; then the project moves
      localStorage.setItem(key, JSON.stringify([approve('b1'), approve('a1'), approve('a2')]));
      useStore.setState({ activeProjectId: 'p-2', projectScopeGeneration: s().projectScopeGeneration + 1 });
      return null;
    });
    s()._setGateway({ project: P1, approveDecision, snapshot: vi.fn(async () => null), listSiteVisits: vi.fn(async () => []) } as unknown as ApiGateway);
    useStore.setState((st) => { st.outbox = [approve('a1'), approve('a2')]; st.online = true; });
    await act(async () => { await s().flushOutbox(); });
    expect(approveDecision).toHaveBeenCalledTimes(1);
    expect(keysOf(key)).toEqual(['a2', 'b1']);
  });
});
