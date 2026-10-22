import 'fake-indexeddb/auto';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { useStore, getInitialState } from '@/store/store';
import type { ApiGateway, OutboxOp } from '@/data/apiGateway';
import { QueueUnreadable } from '@/layout/QueueUnreadable';
import { queueWritten } from './queueWrites';

/**
 * #1085 round 4. Codex 4348114926: after a project switch and before that project's load, the strip and memory were
 * still the old project's, but Reload counted what it would lose over the new project's keys: it asked nothing and
 * the old project's unsaved acts were lost. Codex 4348114913: Set aside copied only the keys it could set aside, then
 * wrote both, so a damaged key was written over while the other key refused, and the person was told nothing changed.
 *
 * Reload and Set aside now act only for the scope the strip was read for (`bindScope`), and Set aside sets every
 * listed key aside or none. The three forced probes fail at 8e548f5, and each fails under its own break on main
 * after #1096 (the Reload probe now answers yes, so only the scope binding stops the reload).
 */

const USER = 'u-pmc';
const keyOf = (p: string) => `vitan.outbox.dev:${USER}.${p}`;
const laneOf = (p: string) => `vitan.siteVisitQueue.dev:${USER}.${p}`;
const key = keyOf('p-1');
const lane = laneOf('p-1');
const s = () => useStore.getState();
const approve = (k: string): OutboxOp => ({ t: 'approve', decisionId: 'd-1', optionIndex: 0, idempotencyKey: k });
const NEWER = JSON.stringify([{ t: 'someNewerKind', idempotencyKey: 'k-new' }]);
const copiesOf = (k: string) => Object.keys(localStorage).filter((x) => x.startsWith(`vitan.unreadable.${k}.`)).map((x) => localStorage.getItem(x));

function onProject(p: string) {
  useStore.setState({ ...getInitialState(), outbox: [], role: 'pmc', lang: 'en', sessionUserId: USER, activeProjectId: p, online: false });
  s()._setGateway({ project: p, listSiteVisits: vi.fn(async () => []), snapshot: vi.fn(async () => null) } as unknown as ApiGateway);
  s().hydrateOutbox();
}
const queueOne = async (k: string) => { act(() => { s().queueSiteVisitAct({ t: 'siteVisitEnd', visitId: '00000000-0000-4000-8000-000000000001', claimedAt: '2026-10-14T05:30:00.000Z', idempotencyKey: k }, 'saved offline'); }); await queueWritten(); };
const reloadStub = () => {
  const reload = vi.fn();
  vi.stubGlobal('location', { ...window.location, reload });
  return reload;
};
/** setItem refuses `refused` keys; every other write lands */
function refusing(refused: (k: string, v: string) => boolean) {
  const real = Storage.prototype.setItem;
  return vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, k: string, v: string) {
    if (refused(k, v)) throw new DOMException('full', 'QuotaExceededError');
    return real.call(this, k, v);
  });
}

afterEach(() => {
  s().completeSignOut();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  s()._setGateway(null);
  localStorage.clear();
  sessionStorage.clear();
});

describe('#1085 r4, Codex 4348114926: Reload acts only for the scope the strip was read for', () => {
  it('forced probe: after a project switch and before its load, Reload neither reloads nor marks', async () => {
    localStorage.setItem(lane, NEWER);
    onProject('p-1');
    await queueOne('k-v'); // the lane is a newer release's: this act is not saved on this phone
    expect(s().queueUnreadable.map((u) => u.key)).toEqual([lane]);
    const ask = vi.fn(() => true); // even a person who would say yes is not asked: the tap does nothing yet
    vi.stubGlobal('confirm', ask);
    const reload = reloadStub();
    useStore.setState({ activeProjectId: 'p-2' }); // the switch; p-2's load has not run
    act(() => s().reloadForNewerQueue());
    expect(ask).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
    expect(sessionStorage.getItem('vitan.queueReloaded')).toBeNull();
  });

  it('guard: once the project’s load has run, Reload asks about every act not saved on this phone', async () => {
    localStorage.setItem(lane, NEWER);
    onProject('p-1');
    await queueOne('k-v');
    const ask = vi.fn(() => false);
    vi.stubGlobal('confirm', ask);
    const reload = reloadStub();
    act(() => s().reloadForNewerQueue());
    expect(ask).toHaveBeenCalledWith('1 updates aren’t saved on this phone and will be lost. Continue?');
    expect(reload).not.toHaveBeenCalled();
  });
});

describe('#1085 r4, Codex 4348114913: Set aside sets every listed key aside, or none', () => {
  it('forced probe: a damaged key beside a newer release’s not yet reloaded is not set aside, and the strip offers Reload only', async () => {
    localStorage.setItem(lane, NEWER);
    localStorage.setItem(key, '{damaged');
    onProject('p-1');
    expect(s().queueUnreadable.map((u) => u.key).sort()).toEqual([key, lane].sort());
    await act(async () => { s().setAsideUnreadableQueue(); await queueWritten(); });
    expect(localStorage.getItem(key)).toBe('{damaged');
    expect(localStorage.getItem(lane)).toBe(NEWER);
    expect([copiesOf(key), copiesOf(lane)]).toEqual([[], []]);
    expect(s().queueSetAsideFailed).toBe(false);
    render(<QueueUnreadable />);
    expect(screen.getByRole('button', { name: 'Reload' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Set aside and continue' })).toBeNull();
  });

  it('guard: after a reload of this build, both keys are set aside in one tap', async () => {
    localStorage.setItem(lane, NEWER);
    localStorage.setItem(key, '{damaged');
    onProject('p-1');
    reloadStub();
    act(() => s().reloadForNewerQueue());
    onProject('p-1');
    await act(async () => { s().setAsideUnreadableQueue(); await queueWritten(); });
    expect([copiesOf(key), copiesOf(lane)]).toEqual([['{damaged'], [NEWER]]);
    expect([localStorage.getItem(key), localStorage.getItem(lane)]).toEqual(['[]', '[]']);
    expect(s().queueUnreadable).toEqual([]);
    expect(s().queueSetAsideFailed).toBe(false);
  });

  it('forced probe: when the second key’s write is refused, the first is put back and the person is told nothing changed', async () => {
    localStorage.setItem(lane, '{bad lane');
    localStorage.setItem(key, '{bad general');
    onProject('p-1');
    useStore.setState((st) => { st.outbox = [approve('k-a')]; });
    const spy = refusing((k) => k === lane);
    await act(async () => { s().setAsideUnreadableQueue(); await queueWritten(); });
    spy.mockRestore();
    expect(localStorage.getItem(key)).toBe('{bad general');
    expect(localStorage.getItem(lane)).toBe('{bad lane');
    expect(s().queueSetAsideFailed).toBe(true);
    expect(s().queueUnreadable.map((u) => u.key).sort()).toEqual([key, lane].sort());
    // the act memory holds is copied aside beside the key put back, so it stays on this phone
    expect(copiesOf(key)).toEqual(expect.arrayContaining(['{bad general', JSON.stringify([approve('k-a')])]));
    // the next tap, with room, sets both aside
    await act(async () => { s().setAsideUnreadableQueue(); await queueWritten(); });
    expect(JSON.parse(localStorage.getItem(key)!)).toEqual([approve('k-a')]);
    expect(localStorage.getItem(lane)).toBe('[]');
    expect(s().queueUnreadable).toEqual([]);
  });

  it('guard: a key that cannot be put back holds memory’s acts and is no longer listed; the person is not told nothing changed', async () => {
    localStorage.setItem(lane, '{bad lane');
    localStorage.setItem(key, '{bad general');
    onProject('p-1');
    const spy = refusing((k, v) => k === lane || (k === key && v === '{bad general'));
    await act(async () => { s().setAsideUnreadableQueue(); await queueWritten(); });
    spy.mockRestore();
    expect(localStorage.getItem(key)).toBe('[]');
    expect(copiesOf(key)).toEqual(['{bad general']);
    expect(s().queueUnreadable.map((u) => u.key)).toEqual([lane]);
    expect(s().queueSetAsideFailed).toBe(false);
  });
});

describe('step A2 on #1088 head 6 and #1096: Set aside and Reload keep every act that a copy aside holds or that is held stranded', () => {
  it('a Set aside put back re-copies the act whose earlier copy its landed write removed, and the next tap removes both act copies', async () => {
    localStorage.setItem(lane, '{bad lane');
    localStorage.setItem(key, '{bad general');
    onProject('p-1');
    useStore.setState((st) => { st.outbox = [approve('k-a')]; });
    await queueOne('k-v'); // both keys refuse the write: each act is copied aside beside its key
    expect(copiesOf(key)).toEqual([JSON.stringify([approve('k-a')])]);
    expect(copiesOf(lane)).toHaveLength(1);
    const spy = refusing((k) => k === lane);
    await act(async () => { s().setAsideUnreadableQueue(); await queueWritten(); });
    spy.mockRestore();
    // the general key's write landed (its act's copy removed, #1096), then it was put back: the act is copied again
    expect(localStorage.getItem(key)).toBe('{bad general');
    expect(copiesOf(key)).toEqual(expect.arrayContaining(['{bad general', JSON.stringify([approve('k-a')])]));
    expect(copiesOf(key)).toHaveLength(2);
    expect(s().queueSetAsideFailed).toBe(true);
    await act(async () => { s().setAsideUnreadableQueue(); await queueWritten(); });
    expect(JSON.parse(localStorage.getItem(key)!)).toEqual([approve('k-a')]);
    expect((JSON.parse(localStorage.getItem(lane)!) as OutboxOp[]).map((o) => o.t)).toEqual(['siteVisitEnd']);
    expect([copiesOf(key), copiesOf(lane)]).toEqual([['{bad general'], ['{bad lane']]);
    expect(s().queueUnreadable).toEqual([]);
  });

  it('Reload counts an act held stranded because its copy aside failed (#1088 head 6), after a switch away and back', async () => {
    localStorage.setItem(lane, NEWER);
    onProject('p-1');
    const spy = refusing((k) => k === lane || k.startsWith('vitan.unreadable.'));
    await queueOne('k-v'); // neither the write nor the copy can be made: the act is held stranded
    spy.mockRestore();
    expect(copiesOf(lane)).toEqual([]);
    onProject('p-2');
    onProject('p-1');
    const ask = vi.fn(() => false);
    vi.stubGlobal('confirm', ask);
    const reload = reloadStub();
    act(() => s().reloadForNewerQueue());
    expect(ask).toHaveBeenCalledWith('1 updates aren’t saved on this phone and will be lost. Continue?');
    expect(reload).not.toHaveBeenCalled();
  });
});
