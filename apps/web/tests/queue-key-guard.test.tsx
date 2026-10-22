import 'fake-indexeddb/auto';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { act } from '@testing-library/react';
import { useStore, getInitialState } from '@/store/store';
import { replayOutboxOp, type ApiGateway, type OutboxOp } from '@/data/apiGateway';
import { queueWritten } from './queueWrites';

/**
 * WEB-02 step A (#482 6333415419): what this release takes from a stored queue key, and what its writes keep.
 * - Codex 4344812918: a newer release's act kind was taken into memory, "replayed" as a success with no case for it, and
 *   then removed from storage.
 * - Codex 4344270652, 4344436672: a lane entry memory leaves out on purpose was dropped at this tab's next write, and at
 *   the flush's scope-moved write.
 * - Codex 4344270663, 4344812910: a list holding an entry that is not an act lost that entry at the next write, or had
 *   its acts replayed while the list itself could never be updated.
 *
 * Every store test here fails at 4711824 (main). Step B1: the writes run under the queue's lock, so each waits on them.
 */

const USER = 'u-cons';
const P1 = 'p-1';
const key = `vitan.outbox.dev:${USER}.${P1}`;
const lane = `vitan.siteVisitQueue.dev:${USER}.${P1}`;
const s = () => useStore.getState();
const end = (visitId: string, k: string): OutboxOp => ({ t: 'siteVisitEnd', visitId, claimedAt: '2026-10-14T05:30:00.000Z', idempotencyKey: k });
const approve = (k: string): OutboxOp => ({ t: 'approve', decisionId: 'd-1', optionIndex: 0, idempotencyKey: k });
const keysOf = (k: string) => ((JSON.parse(localStorage.getItem(k) ?? '[]') ?? []) as { idempotencyKey?: string }[]).map((o) => o.idempotencyKey);
const photo = { t: 'siteVisitAddFile', visitId: '00000000-0000-4000-8000-000000000001', scope: `dev:${USER}`, file: { id: 'f', mime: 'image/png' }, by: { name: 'n', role: 'pmc' }, placeName: null, idempotencyKey: 'k-photo' };

/** signed in on P1 (passwordless dev auth), offline, both keys as given */
function signedIn(stored: { general?: unknown[]; lane?: unknown[] } = {}, gw: Record<string, unknown> = {}) {
  localStorage.setItem(key, JSON.stringify(stored.general ?? []));
  localStorage.setItem(lane, JSON.stringify(stored.lane ?? []));
  useStore.setState({ ...getInitialState(), outbox: [], role: 'consultant', lang: 'en', sessionUserId: USER, activeProjectId: P1, online: false });
  s()._setGateway({ project: P1, listSiteVisits: vi.fn(async () => []), snapshot: vi.fn(async () => null), ...gw } as unknown as ApiGateway);
  s().hydrateOutbox();
}

afterEach(() => {
  s().completeSignOut();
  vi.restoreAllMocks();
  s()._setGateway(null);
  localStorage.clear();
  sessionStorage.clear();
});

describe('WEB-02 step A: what a stored queue key gives this release, and what its writes keep', () => {
  it('4344812918: a newer release’s act kind is never taken in or counted as sent, and stays stored', async () => {
    const newer = { t: 'aKindFromANewerRelease', idempotencyKey: 'k-new' };
    signedIn({ general: [newer] });
    expect(s().outbox).toEqual([]);
    expect(s().queueUnreadable).toEqual([{ key, read: 'newer', reloaded: false }]);
    useStore.setState({ online: true });
    await act(async () => { await s().flushOutbox(); });
    expect(JSON.parse(localStorage.getItem(key)!)).toEqual([newer]);
  });

  it('4344812918: a kind with no replay case is refused, never answered as sent', async () => {
    await expect(replayOutboxOp({ project: P1 } as unknown as ApiGateway, { t: 'aKindFromANewerRelease' } as unknown as OutboxOp)).rejects.toThrow('no replay for aKindFromANewerRelease');
  });

  it('4344270652: a lane photo act memory leaves out stays stored at this tab’s writes', async () => {
    signedIn({ lane: [photo] });
    act(() => { s().queueSiteVisitAct(end('v-2', 'k-mine'), 'saved offline'); });
    await queueWritten(); // step B1: the stored order is kept, and a new act goes last
    expect(keysOf(lane)).toEqual(['k-photo', 'k-mine']);
  });

  it('4344270652: a site visit act stored in the general key, which memory leaves out, stays stored there', async () => {
    signedIn({ general: [end('v-1', 'k-in-general'), approve('k-a')] });
    useStore.setState((st) => { st.outbox = [...st.outbox, approve('k-b')]; });
    act(() => { s().queueSiteVisitAct(end('v-2', 'k-v'), 'saved offline'); });
    await queueWritten();
    expect(keysOf(key)).toEqual(['k-in-general', 'k-a', 'k-b']);
  });

  it('4344270663, 4344812910: a list holding an entry that is not an act gives nothing to replay and is never written over', async () => {
    const newer = ['v3:queue-format', approve('k-n')];
    const approveDecision = vi.fn(async () => null);
    signedIn({ general: newer }, { approveDecision });
    expect(s().outbox).toEqual([]);
    useStore.setState((st) => { st.outbox = [...st.outbox, approve('k-mine')]; });
    act(() => { s().queueSiteVisitAct(end('v-2', 'k-v'), 'saved offline'); });
    await queueWritten();
    expect(JSON.parse(localStorage.getItem(key)!)).toEqual(newer);
    expect(keysOf(lane)).toEqual(['k-v']);
    // the act made here is copied aside beside the key, so it stays on this phone
    const asides = Object.keys(localStorage).filter((x) => x.startsWith(`vitan.unreadable.${key}.`)).map((x) => JSON.parse(localStorage.getItem(x)!) as OutboxOp[]);
    expect(asides).toEqual([[approve('k-mine')]]);
  });

  it('4344436672: a lane photo act memory leaves out stays stored through the flush’s scope-moved write', async () => {
    const approveDecision = vi.fn(async () => {
      useStore.setState({ activeProjectId: 'p-2', projectScopeGeneration: s().projectScopeGeneration + 1 });
      return null;
    });
    signedIn({ lane: [photo] }, { approveDecision });
    useStore.setState((st) => { st.outbox = [approve('a1'), approve('a2')]; st.online = true; });
    await act(async () => { await s().flushOutbox(); });
    expect(approveDecision).toHaveBeenCalledTimes(1);
    expect(keysOf(lane)).toEqual(['k-photo']);
  });

  it('a scope move mid-flush stores this tab’s unsent act once, by identity', async () => {
    const approveDecision = vi.fn(async () => {
      useStore.setState({ activeProjectId: 'p-2', projectScopeGeneration: s().projectScopeGeneration + 1 });
      return null;
    });
    signedIn({ general: [approve('a1'), approve('a2')] }, { approveDecision });
    useStore.setState({ online: true });
    await act(async () => { await s().flushOutbox(); });
    expect(approveDecision).toHaveBeenCalledTimes(1);
    expect(keysOf(key)).toEqual(['a2']);
  });
});
