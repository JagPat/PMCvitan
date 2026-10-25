import 'fake-indexeddb/auto';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { act, render, screen, fireEvent } from '@testing-library/react';
import { useStore, getInitialState } from '@/store/store';
import type { ApiGateway, OutboxOp } from '@/data/apiGateway';
import { QueueUnreadable } from '@/layout/QueueUnreadable';
import { queueWritten, storedQueue } from './queueWrites';

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
const queueOne = async (k: string) => { useStore.setState((st) => { st.outbox = [...st.outbox, approve(k)]; }); act(() => { s().queueSiteVisitAct({ t: 'siteVisitEnd', visitId: '00000000-0000-4000-8000-000000000001', claimedAt: '2026-10-14T05:30:00.000Z', idempotencyKey: `${k}-v` }, 'saved offline'); }); await queueWritten(); };
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
    await queueOne('k-new');
    expect(localStorage.getItem(key)).toBe(raw);
    // the update this tab could not store there was copied aside beside the key (#1079 4344436665)
    expect(copiesOf(key)).toEqual([JSON.stringify([approve('k-new')])]);
    await act(async () => { await s().setAsideUnreadableQueue(); });
    // the key's bytes are copied aside; the update's own copy is removed once Set aside writes it to the key (#1096)
    expect(copiesOf(key)).toEqual([raw]);
    expect(s().queueUnreadable).toEqual([]);
    expect(storedQueue(localStorage.getItem(key)!)).toEqual([approve('k-new')]);
  });

  it('bytes that are not a list: listed, and never written over by this tab’s next save', async () => {
    onP1('{not a list');
    expect(s().queueUnreadable).toEqual([{ key, read: 'damaged', reloaded: false }]);
    await queueOne('k-new');
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
    expect(storedQueue(localStorage.getItem(key)!)).toEqual([both]);
  });

  it('a newer release’s act: Reload is offered, not Set aside; after a reload of this build the same bytes may be set aside', async () => {
    const raw = JSON.stringify([{ t: 'aKindFromANewerRelease', idempotencyKey: 'k-n' }]);
    onP1(raw);
    expect(s().queueUnreadable).toEqual([{ key, read: 'newer', reloaded: false }]);
    await act(async () => { await s().setAsideUnreadableQueue(); });
    expect(copiesOf(key)).toEqual([]);
    const reload = reloadStub();
    act(() => s().reloadForNewerQueue());
    expect(reload).toHaveBeenCalledTimes(1);
    // the page loads again, in this same build, and the key still holds the same bytes
    onP1(null);
    expect(s().queueUnreadable).toEqual([{ key, read: 'newer', reloaded: true }]);
    await act(async () => { await s().setAsideUnreadableQueue(); });
    expect(copiesOf(key)).toEqual([raw]);
    expect(s().queueUnreadable).toEqual([]);
  });

  it('guard: other bytes after the reload are offered Reload again, never Set aside', async () => {
    onP1(JSON.stringify([{ t: 'aKindFromANewerRelease', idempotencyKey: 'k-n' }]));
    reloadStub();
    act(() => s().reloadForNewerQueue());
    localStorage.setItem(key, JSON.stringify([{ t: 'aKindFromANewerRelease', idempotencyKey: 'k-other' }]));
    onP1(null);
    expect(s().queueUnreadable).toEqual([{ key, read: 'newer', reloaded: false }]);
  });

  it('Reload while an update is not saved on this phone asks first; Cancel reloads nothing and marks nothing', async () => {
    onP1(JSON.stringify([{ t: 'aKindFromANewerRelease', idempotencyKey: 'k-n' }]));
    await queueOne('k-new'); // the key cannot be written, so this update is not saved on this phone
    const ask = vi.fn(() => false);
    vi.stubGlobal('confirm', ask);
    const reload = reloadStub();
    act(() => s().reloadForNewerQueue());
    expect(ask).toHaveBeenCalledWith('1 updates aren’t saved on this phone and will be lost. Continue?');
    expect(reload).not.toHaveBeenCalled();
    expect(sessionStorage.getItem('vitan.queueReloaded')).toBeNull();
  });

  it('another tab’s write of bytes this release cannot read is listed and never answered; readable bytes un-list it', async () => {
    onP1(JSON.stringify([]));
    await queueOne('k-mine');
    expect(writesInAnswer('{damaged')).toBe(0);
    expect(localStorage.getItem(key)).toBe('{damaged');
    expect(s().queueUnreadable).toEqual([{ key, read: 'damaged', reloaded: false }]);
    expect(writesInAnswer(JSON.stringify([approve('k-mine')]))).toBe(0);
    expect(s().queueUnreadable).toEqual([]);
  });

  it('a Set aside whose copy cannot be stored changes nothing and says so', async () => {
    const raw = '{not a list';
    onP1(raw);
    const write = vi.spyOn(Storage.prototype, 'setItem').mockImplementation((k) => { if (k.startsWith('vitan.unreadable.')) throw new DOMException('full', 'QuotaExceededError'); });
    await act(async () => { await s().setAsideUnreadableQueue(); });
    write.mockRestore();
    expect(s().queueSetAsideFailed).toBe(true);
    expect(localStorage.getItem(key)).toBe(raw);
    expect(s().queueUnreadable).toEqual([{ key, read: 'damaged', reloaded: false }]);
  });

  it('gap-check 1: a Set aside whose second copy fails marks no key, so the first key is not written over either', async () => {
    localStorage.setItem(lane, '{bad lane');
    onP1('{bad general');
    expect(s().queueUnreadable.map((u) => u.key).sort()).toEqual([key, lane].sort());
    const real = Storage.prototype.setItem;
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, k: string, v: string) {
      if (k.startsWith(`vitan.unreadable.${lane}.`)) throw new DOMException('full', 'QuotaExceededError');
      return real.call(this, k, v);
    });
    await act(async () => { await s().setAsideUnreadableQueue(); });
    spy.mockRestore();
    expect(s().queueSetAsideFailed).toBe(true);
    await queueOne('k-1');
    expect(localStorage.getItem(key)).toBe('{bad general');
  });

  it('#1085 r2 (Codex 4346169602): that failed tap leaves no copy of the first key, and the tap after room is freed copies each key once', async () => {
    localStorage.setItem(lane, '{bad lane');
    onP1('{bad general');
    const real = Storage.prototype.setItem;
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, k: string, v: string) {
      if (k.startsWith(`vitan.unreadable.${lane}.`)) throw new DOMException('full', 'QuotaExceededError');
      return real.call(this, k, v);
    });
    await act(async () => { await s().setAsideUnreadableQueue(); });
    await act(async () => { await s().setAsideUnreadableQueue(); });
    spy.mockRestore();
    expect(s().queueSetAsideFailed).toBe(true);
    expect([copiesOf(key), copiesOf(lane)]).toEqual([[], []]);
    await act(async () => { await s().setAsideUnreadableQueue(); });
    expect(s().queueSetAsideFailed).toBe(false);
    expect([copiesOf(key), copiesOf(lane)]).toEqual([['{bad general'], ['{bad lane']]);
  });

  it('a visit lane holding a damaged visit act is listed by itself; the general key still loads', async () => {
    localStorage.setItem(lane, JSON.stringify([{ t: 'siteVisitEnd', visitId: '00000000-0000-4000-8000-000000000001', idempotencyKey: 'k-e' }]));
    onP1(JSON.stringify([approve('k-a')]));
    expect(s().queueUnreadable).toEqual([{ key: lane, read: 'damaged', reloaded: false }]);
    expect(s().outbox).toEqual([approve('k-a')]);
  });

  it('guard: a key holding acts this release reads is not listed and loads', async () => {
    onP1(JSON.stringify([approve('k-a')]));
    expect(s().queueUnreadable).toEqual([]);
    expect(s().outbox).toEqual([approve('k-a')]);
  });
});

describe('WEB-02 step 2: the strip', () => {
  it('a damaged key shows the words and Set aside; a newer release’s shows Reload, then Set aside after a reload', async () => {
    onP1('{damaged');
    const { unmount } = render(<QueueUnreadable />);
    expect(screen.getByRole('alert').textContent).toContain('Updates saved on this phone for this project can’t be read.');
    expect(screen.getByRole('button', { name: 'Set aside and continue' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Reload' })).toBeNull();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Set aside and continue' })); await queueWritten(); });
    expect(screen.queryByRole('alert')).toBeNull();
    unmount();
    localStorage.setItem(key, JSON.stringify([{ t: 'aKindFromANewerRelease', idempotencyKey: 'k-n' }]));
    onP1(null);
    render(<QueueUnreadable />);
    expect(screen.getByTestId('queue-newer')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Reload' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Set aside and continue' })).toBeNull();
  });

  it('guard: a key this release reads shows no strip', async () => {
    onP1(JSON.stringify([approve('k-a')]));
    render(<QueueUnreadable />);
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

describe('#1088 r3: a scoped key holding bytes is never adopted over, and sign-out takes the list with it', () => {
  it('forced probe (Codex 4351662034): a scoped key holding "" is kept and listed; the legacy queue is copied aside, not written over it', async () => {
    const legacy = JSON.stringify([approve('k-legacy')]);
    localStorage.setItem('vitan.outbox', legacy);
    onP1('');
    expect(localStorage.getItem(key)).toBe('');
    expect(s().queueUnreadable).toEqual([{ key, read: 'damaged', reloaded: false }]);
    expect(localStorage.getItem(`vitan.unreadable.vitan.outbox.${key}`)).toBe(legacy);
    expect(localStorage.getItem('vitan.outbox')).toBeNull();
  });

  it('guard: an absent scoped key still adopts the legacy queue', async () => {
    localStorage.setItem('vitan.outbox', JSON.stringify([approve('k-legacy')]));
    onP1(null);
    await queueWritten(); // L2b (gap check 9): the migration writes through the locked ledger write
    expect(storedQueue(localStorage.getItem(key)!)).toEqual([approve('k-legacy')]);
    expect(s().outbox).toEqual([approve('k-legacy')]);
  });

  it('forced probe (Codex 4351662045): sign-out clears the list and the strip, with no load after it', async () => {
    onP1('{damaged');
    render(<QueueUnreadable />);
    expect(screen.getByRole('alert')).toBeTruthy();
    act(() => s().completeSignOut());
    expect(s().queueUnreadable).toEqual([]);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('forced probe (re-check of head 4): a dev-auth persona switch clears the list with the scope, with no load after it', async () => {
    onP1('{damaged');
    render(<QueueUnreadable />);
    expect(screen.getByRole('alert')).toBeTruthy();
    act(() => s().setRole('engineer'));
    expect(s().sessionUserId).toBeNull();
    expect(s().queueUnreadable).toEqual([]);
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

describe('#1088 r4 (Codex 4351952392): every scope change clears the list before it touches storage', () => {
  /** this phone's storage refuses every access from now on (its permission withdrawn) */
  const storageThrows = () => vi.spyOn(window, 'localStorage', 'get').mockImplementation(() => { throw new DOMException('denied', 'SecurityError'); });

  it('forced probe, the finding’s case: a load of another project with storage throwing leaves no list from the last one', async () => {
    onP1('{damaged');
    render(<QueueUnreadable />);
    expect(screen.getByRole('alert')).toBeTruthy();
    storageThrows();
    act(() => { useStore.setState({ activeProjectId: 'p-2' }); s().hydrateOutbox(); });
    expect(s().queueUnreadable).toEqual([]);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('forced probe: a project switch the server confirms clears the list, with storage throwing and no load after it', async () => {
    onP1('{damaged', { switchProject: vi.fn(async () => ({ role: 'pmc', token: 't-2', projectId: 'p-2' })) });
    expect(s().queueUnreadable).toEqual([{ key, read: 'damaged', reloaded: false }]);
    storageThrows();
    await act(async () => { await s().switchProject('p-2'); });
    expect(s().activeProjectId).toBe('p-2');
    expect(s().queueUnreadable).toEqual([]);
  });

  it.each([
    ['sign-out', () => s().completeSignOut()],
    ['a persona switch', () => s().setRole('engineer')],
  ])('%s with storage throwing clears the list', (_how, change) => {
    onP1('{damaged');
    storageThrows();
    act(() => change());
    expect(s().queueUnreadable).toEqual([]);
  });
});

describe('Codex 4353751499: an act made beside an unreadable key whose copy aside fails is held, never lost', () => {
  /** this phone's storage takes no new copy aside (it is full) */
  const copiesFail = () => {
    const real = Storage.prototype.setItem;
    return vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, k: string, v: string) {
      if (k.startsWith('vitan.unreadable.')) throw new DOMException('full', 'QuotaExceededError');
      return real.call(this, k, v);
    });
  };
  const signInAgain = () => { s().completeSignOut(); onP1(null); };

  it('forced probe, the finding’s case: it comes back after a sign-out and sign-in in this tab', async () => {
    onP1('{damaged');
    copiesFail();
    await queueOne('k-1');
    expect(copiesOf(key)).toEqual([]);
    signInAgain();
    expect(localStorage.getItem(key)).toBe('{damaged');
    // the approval, held for the unreadable general key; the visit act, written to its own readable lane
    expect(s().outbox.map((o) => (o as { idempotencyKey?: string }).idempotencyKey).sort()).toEqual(['k-1', 'k-1-v']);
  });

  it('one sent meanwhile is let go: it does not come back after a sign-out and sign-in', async () => {
    onP1('{damaged', { approveDecision: vi.fn(async () => null), endSiteVisit: vi.fn(async () => null) });
    copiesFail();
    await queueOne('k-2');
    useStore.setState({ online: true });
    await act(async () => { await s().flushOutbox(); });
    expect(s().outbox).toEqual([]);
    useStore.setState({ online: false });
    signInAgain();
    expect(s().outbox).toEqual([]);
  });

  it('guard: when the copy can be made it is made, and nothing is held twice', async () => {
    onP1('{damaged');
    await queueOne('k-3');
    signInAgain();
    expect(copiesOf(key).map((c) => JSON.parse(c!))).toEqual([[approve('k-3')]]);
    // the approval stays in its copy aside, and is not held stranded as well. It loads once, from the made record its
    // write kept while it waited for the lock (#1099 r2, Codex 4358855955): a copy aside alone is never loaded, so it is
    // not the act's actionable record (#1101, Codex 4359759846). The visit act loads from its lane
    expect(s().outbox.map((o) => o.t).sort()).toEqual(['approve', 'siteVisitEnd']);
  });
});

describe('Codex 4356145036: a copy aside this tab made is removed once its acts settle, and kept until then', () => {
  const sendable = (approveDecision: ReturnType<typeof vi.fn>) => ({ approveDecision, endSiteVisit: vi.fn(async () => null) });

  it('forced probe, the finding’s case: once the act is sent, its copy beside the unreadable key is removed', async () => {
    const approveDecision = vi.fn(async () => null);
    onP1('{damaged', sendable(approveDecision));
    await queueOne('p2-1');
    expect(copiesOf(key).map((c) => JSON.parse(c!))).toEqual([[approve('p2-1')]]);
    useStore.setState({ online: true });
    await act(async () => { await s().flushOutbox(); });
    expect(approveDecision).toHaveBeenCalledTimes(1);
    expect(copiesOf(key)).toEqual([]);
    expect(localStorage.getItem(key)).toBe('{damaged');
  });

  it('a copy whose act is not sent yet stays', async () => {
    const approveDecision = vi.fn(async () => { throw Object.assign(new Error('down'), { status: 503 }); });
    onP1('{damaged', sendable(approveDecision));
    await queueOne('p2-2');
    useStore.setState({ online: true });
    await act(async () => { await s().flushOutbox(); });
    expect(s().outbox.map((o) => o.t)).toContain('approve');
    expect(copiesOf(key).map((c) => JSON.parse(c!))).toEqual([[approve('p2-2')]]);
  });

  it('a copy outlives a sign-out before its act is sent: it is then this phone’s only copy', async () => {
    onP1('{damaged');
    await queueOne('p2-3');
    s().completeSignOut();
    onP1(null, sendable(vi.fn(async () => null)));
    useStore.setState({ online: true });
    await act(async () => { await s().flushOutbox(); });
    expect(copiesOf(key).map((c) => JSON.parse(c!))).toEqual([[approve('p2-3')]]);
  });
});
