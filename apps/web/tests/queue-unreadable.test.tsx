import 'fake-indexeddb/auto';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { useStore, getInitialState } from '@/store/store';
import type { ApiGateway, OutboxOp } from '@/data/apiGateway';
import { QueueUnreadable } from '@/layout/QueueUnreadable';

/**
 * WEB-02 step 2 (#482 6326129029). A stored queue key holding bytes this release cannot read (not a list, an act of a
 * known kind missing a field its replay reads, an act breaking a server rule, or a newer release's act) used to be
 * loaded as far as it parsed, sent, refused for good and dropped, or written over at the next save: its bytes were lost
 * and nobody was told (Codex 4336713248, #1071 F4 4341067934).
 *
 * Now such a key loads nothing, is never sent or written over, and is listed on a strip that says so, a newer
 * release's key in words of its own. An update this tab cannot store there is copied aside beside it.
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
const queueOne = (k: string) => { useStore.setState((st) => { st.outbox = [...st.outbox, approve(k)]; }); act(() => { s().queueSiteVisitAct({ t: 'siteVisitEnd', visitId: '00000000-0000-4000-8000-000000000001', claimedAt: '2026-10-14T05:30:00.000Z', idempotencyKey: `${k}-v` }, 'saved offline'); }); };
/** another tab's write of the general key, heard: how many writes of it this tab makes in answer */
function writesInAnswer(text: string): number {
  localStorage.setItem(key, text);
  const write = vi.spyOn(Storage.prototype, 'setItem');
  try {
    act(() => { window.dispatchEvent(new StorageEvent('storage', { key, newValue: text, storageArea: localStorage })); });
    return write.mock.calls.filter(([w]) => w === key).length;
  } finally { write.mockRestore(); }
}

afterEach(() => {
  s().completeSignOut();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  s()._setGateway(null);
  localStorage.clear();
  sessionStorage.clear();
});

describe('WEB-02 step 2: a queue key this release cannot read is never sent or written over', () => {
  it('a known kind missing a field: listed, nothing loaded or sent, and the key kept', async () => {
    const raw = JSON.stringify([{ t: 'approve' }]);
    const approveDecision = vi.fn(async () => null);
    onP1(raw, { approveDecision });
    expect(s().queueUnreadable).toEqual([{ key, read: 'damaged' }]);
    expect(s().outbox).toEqual([]);
    useStore.setState({ online: true });
    await act(async () => { await s().flushOutbox(); });
    expect(approveDecision).not.toHaveBeenCalled();
    useStore.setState({ online: false });
    queueOne('k-new');
    expect(localStorage.getItem(key)).toBe(raw);
    // the update this tab could not store there was copied aside beside the key (#1079 4344436665)
    expect(copiesOf(key)).toEqual([JSON.stringify([approve('k-new')])]);
    expect(s().queueUnreadable).toEqual([{ key, read: 'damaged' }]);
  });

  it('bytes that are not a list: listed, and never written over by this tab’s next save', () => {
    onP1('{not a list');
    expect(s().queueUnreadable).toEqual([{ key, read: 'damaged' }]);
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

  it('a newer release’s act: listed as a newer release’s, nothing loaded, and never written over', () => {
    const raw = JSON.stringify([{ t: 'aKindFromANewerRelease', idempotencyKey: 'k-n' }]);
    onP1(raw);
    expect(s().queueUnreadable).toEqual([{ key, read: 'newer' }]);
    expect(s().outbox).toEqual([]);
    queueOne('k-new');
    expect(localStorage.getItem(key)).toBe(raw);
    expect(copiesOf(key)).toEqual([JSON.stringify([approve('k-new')])]);
  });

  it('another tab’s write of bytes this release cannot read is listed and never answered; readable bytes un-list it', () => {
    onP1(JSON.stringify([]));
    queueOne('k-mine');
    expect(writesInAnswer('{damaged')).toBe(0);
    expect(localStorage.getItem(key)).toBe('{damaged');
    expect(s().queueUnreadable).toEqual([{ key, read: 'damaged' }]);
    expect(writesInAnswer(JSON.stringify([approve('k-mine')]))).toBe(0);
    expect(s().queueUnreadable).toEqual([]);
  });

  it('a visit lane holding a damaged visit act is listed by itself; the general key still loads', () => {
    localStorage.setItem(lane, JSON.stringify([{ t: 'siteVisitEnd', visitId: '00000000-0000-4000-8000-000000000001', idempotencyKey: 'k-e' }]));
    onP1(JSON.stringify([approve('k-a')]));
    expect(s().queueUnreadable).toEqual([{ key: lane, read: 'damaged' }]);
    expect(s().outbox).toEqual([approve('k-a')]);
  });

  it('guard: a key holding acts this release reads is not listed and loads', () => {
    onP1(JSON.stringify([approve('k-a')]));
    expect(s().queueUnreadable).toEqual([]);
    expect(s().outbox).toEqual([approve('k-a')]);
  });
});

describe('WEB-02 step 2: the strip', () => {
  it('a damaged key shows its words, a newer release’s shows its own, and the strip offers no action', () => {
    onP1('{damaged');
    const { unmount } = render(<QueueUnreadable />);
    expect(screen.getByRole('alert').textContent).toContain('Updates saved on this phone for this project can’t be read.');
    expect(screen.queryByTestId('queue-newer')).toBeNull();
    expect(screen.queryAllByRole('button')).toEqual([]);
    unmount();
    localStorage.setItem(key, JSON.stringify([{ t: 'aKindFromANewerRelease', idempotencyKey: 'k-n' }]));
    onP1(null);
    render(<QueueUnreadable />);
    expect(screen.getByTestId('queue-newer').textContent).toBe('Updates saved on this phone by a newer version of Vitan can’t be read here.');
    expect(screen.queryAllByRole('button')).toEqual([]);
  });

  it('guard: a key this release reads shows no strip', () => {
    onP1(JSON.stringify([approve('k-a')]));
    render(<QueueUnreadable />);
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

describe('#1088 r3: a scoped key holding bytes is never adopted over, and sign-out takes the list with it', () => {
  it('forced probe (Codex 4351662034): a scoped key holding "" is kept and listed; the legacy queue is copied aside, not written over it', () => {
    const legacy = JSON.stringify([approve('k-legacy')]);
    localStorage.setItem('vitan.outbox', legacy);
    onP1('');
    expect(localStorage.getItem(key)).toBe('');
    expect(s().queueUnreadable).toEqual([{ key, read: 'damaged' }]);
    expect(localStorage.getItem(`vitan.unreadable.vitan.outbox.${key}`)).toBe(legacy);
    expect(localStorage.getItem('vitan.outbox')).toBeNull();
  });

  it('guard: an absent scoped key still adopts the legacy queue', () => {
    localStorage.setItem('vitan.outbox', JSON.stringify([approve('k-legacy')]));
    onP1(null);
    expect(JSON.parse(localStorage.getItem(key)!)).toEqual([approve('k-legacy')]);
    expect(s().outbox).toEqual([approve('k-legacy')]);
  });

  it('forced probe (Codex 4351662045): sign-out clears the list and the strip, with no load after it', () => {
    onP1('{damaged');
    render(<QueueUnreadable />);
    expect(screen.getByRole('alert')).toBeTruthy();
    act(() => s().completeSignOut());
    expect(s().queueUnreadable).toEqual([]);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('forced probe (re-check of head 4): a dev-auth persona switch clears the list with the scope, with no load after it', () => {
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

  it('forced probe, the finding’s case: a load of another project with storage throwing leaves no list from the last one', () => {
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
    expect(s().queueUnreadable).toEqual([{ key, read: 'damaged' }]);
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

  it('forced probe, the finding’s case: it comes back after a sign-out and sign-in in this tab', () => {
    onP1('{damaged');
    copiesFail();
    queueOne('k-1');
    expect(copiesOf(key)).toEqual([]);
    signInAgain();
    expect(localStorage.getItem(key)).toBe('{damaged');
    // the approval, held for the unreadable general key; the visit act, written to its own readable lane
    expect(s().outbox.map((o) => (o as { idempotencyKey?: string }).idempotencyKey).sort()).toEqual(['k-1', 'k-1-v']);
  });

  it('one sent meanwhile is let go: it does not come back after a sign-out and sign-in', async () => {
    onP1('{damaged', { approveDecision: vi.fn(async () => null), endSiteVisit: vi.fn(async () => null) });
    copiesFail();
    queueOne('k-2');
    useStore.setState({ online: true });
    await act(async () => { await s().flushOutbox(); });
    expect(s().outbox).toEqual([]);
    useStore.setState({ online: false });
    signInAgain();
    expect(s().outbox).toEqual([]);
  });

  it('guard: when the copy can be made it is made, and nothing is held twice', () => {
    onP1('{damaged');
    queueOne('k-3');
    signInAgain();
    expect(copiesOf(key).map((c) => JSON.parse(c!))).toEqual([[approve('k-3')]]);
    // the approval stays in its copy aside, not held as well; only the visit act, from its lane, loads
    expect(s().outbox.map((o) => o.t)).toEqual(['siteVisitEnd']);
  });
});

