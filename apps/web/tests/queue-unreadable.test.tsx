import 'fake-indexeddb/auto';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { act, render, screen, fireEvent } from '@testing-library/react';
import { useStore, getInitialState } from '@/store/store';
import type { ApiGateway, OutboxOp } from '@/data/apiGateway';
import { QueueUnreadable } from '@/layout/QueueUnreadable';

/**
 * WEB-02 step 2 (#482 6326129029). A stored queue key holding bytes this release cannot read (not a list, an act of a
 * known kind missing a field its replay reads, an act breaking a server rule, or a newer release's act) used to be
 * loaded as far as it parsed, sent, refused for good and dropped, or written over at the next save: its bytes were lost
 * and nobody was told (Codex 4336713248, #1071 F4 4341067934).
 *
 * Now such a key loads nothing, is never sent or written over, and is listed on a strip. A damaged key is offered Set
 * aside, which copies its bytes under a new name, reads the copy back, and only then lets new updates be saved there.
 * A newer release's key is offered Reload first, and Set aside once a reload of this same build still cannot read it.
 *
 * Every test here fails at 4711824 (main). The two guards fail there only because the list they read does not exist;
 * each also fails under its own break.
 */

const USER = 'u-pmc';
const P1 = 'p-1';
const key = `vitan.outbox.dev:${USER}.${P1}`;
const lane = `vitan.siteVisitQueue.dev:${USER}.${P1}`;
const s = () => useStore.getState();
const approve = (k: string): OutboxOp => ({ t: 'approve', decisionId: 'd-1', optionIndex: 0, idempotencyKey: k });
const copiesOf = (k: string) => Object.keys(localStorage).filter((x) => x.startsWith(`vitan.unreadable.${k}.`)).map((x) => localStorage.getItem(x));

/** signed in on P1 (passwordless dev auth), offline, the general key holding `raw` */
function onP1(raw: string | null, gw: Record<string, unknown> = {}) {
  if (raw !== null) localStorage.setItem(key, raw);
  useStore.setState({ ...getInitialState(), outbox: [], role: 'pmc', lang: 'en', sessionUserId: USER, activeProjectId: P1, online: false });
  s()._setGateway({ project: P1, listSiteVisits: vi.fn(async () => []), snapshot: vi.fn(async () => null), ...gw } as unknown as ApiGateway);
  s().hydrateOutbox();
}
/** this tab queues an approval offline */
const queueOne = (k: string) => { useStore.setState((st) => { st.outbox = [...st.outbox, approve(k)]; }); act(() => { s().queueSiteVisitAct({ t: 'siteVisitEnd', visitId: 'v-1', claimedAt: '2026-10-14T05:30:00.000Z', idempotencyKey: `${k}-v` }, 'saved offline'); }); };
/** another tab's write of the general key, heard: how many writes of it this tab makes in answer */
function writesInAnswer(text: string): number {
  localStorage.setItem(key, text);
  const write = vi.spyOn(Storage.prototype, 'setItem');
  try {
    act(() => { window.dispatchEvent(new StorageEvent('storage', { key, newValue: text, storageArea: localStorage })); });
    return write.mock.calls.filter(([w]) => w === key).length;
  } finally { write.mockRestore(); }
}
const reloadStub = () => {
  const reload = vi.fn();
  vi.stubGlobal('location', { ...window.location, reload });
  return reload;
};

afterEach(() => {
  s().completeSignOut();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  s()._setGateway(null);
  localStorage.clear();
  sessionStorage.clear();
});

describe('WEB-02 step 2: a queue key this release cannot read is never sent or written over', () => {
  it('a known kind missing a field: listed, nothing loaded or sent, the key kept, and Set aside copies it', async () => {
    const raw = JSON.stringify([{ t: 'approve' }]);
    const approveDecision = vi.fn(async () => null);
    onP1(raw, { approveDecision });
    expect(s().queueUnreadable).toEqual([{ key, read: 'damaged', reloaded: false }]);
    expect(s().outbox).toEqual([]);
    useStore.setState({ online: true });
    await act(async () => { await s().flushOutbox(); });
    expect(approveDecision).not.toHaveBeenCalled();
    useStore.setState({ online: false });
    queueOne('k-new');
    expect(localStorage.getItem(key)).toBe(raw);
    // the update this tab could not store there was copied aside beside the key (#1079 4344436665)
    expect(copiesOf(key)).toEqual([JSON.stringify([approve('k-new')])]);
    act(() => s().setAsideUnreadableQueue());
    expect(copiesOf(key)).toEqual(expect.arrayContaining([raw, JSON.stringify([approve('k-new')])]));
    expect(copiesOf(key)).toHaveLength(2);
    expect(s().queueUnreadable).toEqual([]);
    expect(JSON.parse(localStorage.getItem(key)!)).toEqual([approve('k-new')]);
  });

  it('bytes that are not a list: listed, and never written over by this tab’s next save', () => {
    onP1('{not a list');
    expect(s().queueUnreadable).toEqual([{ key, read: 'damaged', reloaded: false }]);
    queueOne('k-new');
    expect(localStorage.getItem(key)).toBe('{not a list');
  });

  it('an act breaking a server rule across its fields (both a worker and a crew) is listed, never sent', async () => {
    const both = { t: 'allocateLabour', input: { activityId: 'a', requirementId: 'r', civilDate: '2026-10-21', workerId: 'w', crewId: 'c' }, idempotencyKey: 'k', coalesceKey: 'c' };
    const allocateLabour = vi.fn(async () => ({}));
    onP1(JSON.stringify([both]), { allocateLabour });
    expect(s().queueUnreadable.map((u) => u.key)).toEqual([key]);
    useStore.setState({ online: true });
    await act(async () => { await s().flushOutbox(); });
    expect(allocateLabour).not.toHaveBeenCalled();
    expect(JSON.parse(localStorage.getItem(key)!)).toEqual([both]);
  });

  it('a newer release’s act: Reload is offered, not Set aside; after a reload of this build the same bytes may be set aside', () => {
    const raw = JSON.stringify([{ t: 'aKindFromANewerRelease', idempotencyKey: 'k-n' }]);
    onP1(raw);
    expect(s().queueUnreadable).toEqual([{ key, read: 'newer', reloaded: false }]);
    act(() => s().setAsideUnreadableQueue());
    expect(copiesOf(key)).toEqual([]);
    const reload = reloadStub();
    act(() => s().reloadForNewerQueue());
    expect(reload).toHaveBeenCalledTimes(1);
    // the page loads again, in this same build, and the key still holds the same bytes
    onP1(null);
    expect(s().queueUnreadable).toEqual([{ key, read: 'newer', reloaded: true }]);
    act(() => s().setAsideUnreadableQueue());
    expect(copiesOf(key)).toEqual([raw]);
    expect(s().queueUnreadable).toEqual([]);
  });

  it('guard: other bytes after the reload are offered Reload again, never Set aside', () => {
    onP1(JSON.stringify([{ t: 'aKindFromANewerRelease', idempotencyKey: 'k-n' }]));
    reloadStub();
    act(() => s().reloadForNewerQueue());
    localStorage.setItem(key, JSON.stringify([{ t: 'aKindFromANewerRelease', idempotencyKey: 'k-other' }]));
    onP1(null);
    expect(s().queueUnreadable).toEqual([{ key, read: 'newer', reloaded: false }]);
  });

  it('Reload while an update is not saved on this phone asks first; Cancel reloads nothing and marks nothing', () => {
    onP1(JSON.stringify([{ t: 'aKindFromANewerRelease', idempotencyKey: 'k-n' }]));
    queueOne('k-new'); // the key cannot be written, so this update is not saved on this phone
    const ask = vi.fn(() => false);
    vi.stubGlobal('confirm', ask);
    const reload = reloadStub();
    act(() => s().reloadForNewerQueue());
    expect(ask).toHaveBeenCalledWith('1 updates aren’t saved on this phone and will be lost. Continue?');
    expect(reload).not.toHaveBeenCalled();
    expect(sessionStorage.getItem('vitan.queueReloaded')).toBeNull();
  });

  it('another tab’s write of bytes this release cannot read is listed and never answered; readable bytes un-list it', () => {
    onP1(JSON.stringify([]));
    queueOne('k-mine');
    expect(writesInAnswer('{damaged')).toBe(0);
    expect(localStorage.getItem(key)).toBe('{damaged');
    expect(s().queueUnreadable).toEqual([{ key, read: 'damaged', reloaded: false }]);
    expect(writesInAnswer(JSON.stringify([approve('k-mine')]))).toBe(0);
    expect(s().queueUnreadable).toEqual([]);
  });

  it('a Set aside whose copy cannot be stored changes nothing and says so', () => {
    const raw = '{not a list';
    onP1(raw);
    const write = vi.spyOn(Storage.prototype, 'setItem').mockImplementation((k) => { if (k.startsWith('vitan.unreadable.')) throw new DOMException('full', 'QuotaExceededError'); });
    act(() => s().setAsideUnreadableQueue());
    write.mockRestore();
    expect(s().queueSetAsideFailed).toBe(true);
    expect(localStorage.getItem(key)).toBe(raw);
    expect(s().queueUnreadable).toEqual([{ key, read: 'damaged', reloaded: false }]);
  });

  it('gap-check 1: a Set aside whose second copy fails marks no key, so the first key is not written over either', () => {
    localStorage.setItem(lane, '{bad lane');
    onP1('{bad general');
    expect(s().queueUnreadable.map((u) => u.key).sort()).toEqual([key, lane].sort());
    const real = Storage.prototype.setItem;
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, k: string, v: string) {
      if (k.startsWith(`vitan.unreadable.${lane}.`)) throw new DOMException('full', 'QuotaExceededError');
      return real.call(this, k, v);
    });
    act(() => s().setAsideUnreadableQueue());
    spy.mockRestore();
    expect(s().queueSetAsideFailed).toBe(true);
    queueOne('k-1');
    expect(localStorage.getItem(key)).toBe('{bad general');
  });

  it('a visit lane holding a damaged visit act is listed by itself; the general key still loads', () => {
    localStorage.setItem(lane, JSON.stringify([{ t: 'siteVisitEnd', visitId: 'v-1', idempotencyKey: 'k-e' }]));
    onP1(JSON.stringify([approve('k-a')]));
    expect(s().queueUnreadable).toEqual([{ key: lane, read: 'damaged', reloaded: false }]);
    expect(s().outbox).toEqual([approve('k-a')]);
  });

  it('guard: a key holding acts this release reads is not listed and loads', () => {
    onP1(JSON.stringify([approve('k-a')]));
    expect(s().queueUnreadable).toEqual([]);
    expect(s().outbox).toEqual([approve('k-a')]);
  });
});

describe('WEB-02 step 2: the strip', () => {
  it('a damaged key shows the words and Set aside; a newer release’s shows Reload, then Set aside after a reload', () => {
    onP1('{damaged');
    const { unmount } = render(<QueueUnreadable />);
    expect(screen.getByRole('alert').textContent).toContain('Updates saved on this phone for this project can’t be read.');
    expect(screen.getByRole('button', { name: 'Set aside and continue' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Reload' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Set aside and continue' }));
    expect(screen.queryByRole('alert')).toBeNull();
    unmount();
    localStorage.setItem(key, JSON.stringify([{ t: 'aKindFromANewerRelease', idempotencyKey: 'k-n' }]));
    onP1(null);
    render(<QueueUnreadable />);
    expect(screen.getByTestId('queue-newer')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Reload' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Set aside and continue' })).toBeNull();
  });
});
