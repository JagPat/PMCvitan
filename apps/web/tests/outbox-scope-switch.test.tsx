import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';
import { useStore, getInitialState } from '@/store/store';
import type { ApiGateway, OutboxOp } from '@/data/apiGateway';
import { QW } from '@/lib/queueWords';
import { QueueUnreadable } from '@/layout/QueueUnreadable';
import { LeaveUnkept } from '@/layout/LeaveUnkept';

/**
 * WEB-02 (#792): the queue in memory belongs to one person on one project. A project switch loads the new project's
 * queue in its place. When that project's stored queue could not be read (bad JSON, or storage that refuses the
 * read), the load gave up whole and the previous project's acts stayed in memory: the next
 * write stored them under the new project's key and the next flush sent them through its gateway. The first test fails
 * at 130287e.
 */

const USER = 'u-eng';
const P1 = 'p-1';
const P2 = 'p-2';
const key = (project: string) => `vitan.outbox.dev:${USER}.${project}`;
const lane = (project: string) => `vitan.siteVisitQueue.dev:${USER}.${project}`;
const start = (activityId: string): OutboxOp => ({ t: 'startActivity', activityId, idempotencyKey: `k-${activityId}` });
const reserve = { t: 'reserveStock', input: { lotId: 'L-1', storeLocation: 'S', activityId: 'A-1', qty: '2' }, idempotencyKey: 'k-r', coalesceKey: 'c-r' } satisfies OutboxOp;
const end: OutboxOp = { t: 'siteVisitEnd', visitId: 'v-1', claimedAt: '2026-10-14T05:30:00.000Z', idempotencyKey: 'k-end' };

type Gw = { project: string; startActivity: ReturnType<typeof vi.fn>; endSiteVisit: ReturnType<typeof vi.fn>; listSiteVisits: ReturnType<typeof vi.fn> };
const gateway = (project: string): Gw => ({
  project,
  startActivity: vi.fn(async () => { throw new Error('not expected'); }),
  endSiteVisit: vi.fn(async () => { throw new Error('not expected'); }),
  listSiteVisits: vi.fn(async () => []),
});

/** signed in on P1, offline, with one generic act and one visit act queued and stored under P1's keys */
function onP1WithQueue(): Gw {
  localStorage.setItem(key(P1), JSON.stringify([start('A-1')]));
  localStorage.setItem(lane(P1), JSON.stringify([end]));
  useStore.setState({ ...getInitialState(), outbox: [], role: 'engineer', lang: 'en', sessionUserId: USER, activeProjectId: P1, online: false });
  const gw = gateway(P1);
  useStore.getState()._setGateway(gw as unknown as ApiGateway);
  useStore.getState().hydrateOutbox();
  expect(useStore.getState().outbox).toEqual([start('A-1'), end]);
  return gw;
}
/** the switch useApiSync makes: the new project, its gateway, its queue */
function switchTo(project: string): Gw {
  const gw = gateway(project);
  useStore.setState((s) => ({ activeProjectId: project, projectScopeGeneration: s.projectScopeGeneration + 1 }));
  useStore.getState()._setGateway(gw as unknown as ApiGateway);
  useStore.getState().hydrateOutbox();
  return gw;
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  useStore.getState()._setGateway(null);
  localStorage.clear();
});

describe('a project switch onto a queue that cannot be read (WEB-02)', () => {
  it("carries none of the previous project's acts into the new one, and leaves both projects' stored queues as they were", async () => {
      const bad = '{not json';
      onP1WithQueue();
      localStorage.setItem(key(P2), bad);
      const p2 = switchTo(P2);
      expect(useStore.getState().outbox).toEqual([]);
      // a write in P2 (here: the flush) stores nothing of P1's under P2, and nothing of P1's goes to P2's server
      useStore.setState({ online: true });
      await useStore.getState().flushOutbox();
      expect(p2.startActivity).not.toHaveBeenCalled();
      expect(p2.endSiteVisit).not.toHaveBeenCalled();
      expect(localStorage.getItem(key(P2))).toBe(bad);
      expect(JSON.parse(localStorage.getItem(lane(P2)) ?? '[]')).toEqual([]);
      // P1's acts are still where they were stored, for P1's next load
      expect(JSON.parse(localStorage.getItem(key(P1)) ?? 'null')).toEqual([start('A-1')]);
      expect(JSON.parse(localStorage.getItem(lane(P1)) ?? 'null')).toEqual([end]);
  });

  it('carries nothing over when storage refuses every read', () => {
    onP1WithQueue();
    // what P1's queue showed: a reserve pending, a label waiting to sync, and an unsent day log
    localStorage.setItem(key(P1), JSON.stringify([start('A-1'), reserve]));
    useStore.getState().hydrateOutbox();
    useStore.setState({ dailyLogDraft: { projectId: P1 } as never, syncQueue: ['Start A-1'] });
    expect(useStore.getState().materialsPending).toEqual(['c-r']);
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new DOMException('denied', 'SecurityError'); });
    switchTo(P2);
    expect(useStore.getState().outbox).toEqual([]);
    expect(useStore.getState().syncQueue).toEqual([]);
    expect(useStore.getState().materialsPending).toEqual([]);
    expect(useStore.getState().dailyLogDraft).toBeNull();
    expect(useStore.getState().queueUnreadable?.keys).toEqual(expect.arrayContaining([key(P2), lane(P2)]));
    // the day-log draft keys could not be read either: they are listed too, so nothing writes or removes them
    expect(useStore.getState().queueUnreadable?.keys).toEqual(expect.arrayContaining([`vitan.dailyLogDraft.anon.${P2}`, `vitan.dailyLogDraft.legacy.anon.${P2}`]));
  });

  it('carries nothing over when this browser has no storage at all', () => {
    onP1WithQueue();
    useStore.setState({ syncQueue: ['Start A-1'] });
    vi.stubGlobal('localStorage', undefined);
    try {
      switchTo(P2);
      expect(useStore.getState().outbox).toEqual([]);
      expect(useStore.getState().syncQueue).toEqual([]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('a readable new scope drops the labels the previous queue showed', () => {
    onP1WithQueue();
    useStore.setState({ syncQueue: ['Start A-1'] });
    switchTo(P2);
    expect(useStore.getState().syncQueue).toEqual([]);
  });

  it('a visit lane that cannot be read carries nothing over either, and the new project’s readable acts still load', () => {
    onP1WithQueue();
    localStorage.setItem(key(P2), JSON.stringify([start('B-1')]));
    localStorage.setItem(lane(P2), '{not json');
    switchTo(P2);
    expect(useStore.getState().outbox).toEqual([start('B-1')]);
  });

  it('switching back to P1 loads its acts again', () => {
    onP1WithQueue();
    localStorage.setItem(key(P2), '{not json');
    switchTo(P2);
    switchTo(P1);
    expect(useStore.getState().outbox).toEqual([start('A-1'), end]);
  });
});

describe('a queue key this phone cannot read is never written, and the person is told (WEB-02)', () => {
  const offlineEnd: OutboxOp = { t: 'siteVisitEnd', visitId: 'v-2', claimedAt: '2026-10-14T06:00:00.000Z', idempotencyKey: 'k-end-2' };
  /** on P2 with its general key and/or visit lane unreadable; a gateway that answers every act */
  function onP2(general: string | null, visits: string | null, { online = false } = {}) {
    if (general !== null) localStorage.setItem(key(P2), general);
    if (visits !== null) localStorage.setItem(lane(P2), visits);
    useStore.setState({ ...getInitialState(), outbox: [], role: 'engineer', lang: 'en', sessionUserId: USER, activeProjectId: P2, online });
    const gw = { project: P2, startActivity: vi.fn(async () => ({})), endSiteVisit: vi.fn(async () => ({ id: 'v-2', status: 'ended' })), listSiteVisits: vi.fn(async () => []) };
    useStore.getState()._setGateway(gw as unknown as ApiGateway);
    useStore.getState().hydrateOutbox();
    return gw;
  }
  const toast = () => useStore.getState().toast;

  it('keeps a bad general key byte for byte through a new act, a flush and a visit-lane write, and says the act was not kept', async () => {
    const bad = '{not json';
    const gw = onP2(bad, null);
    useStore.getState().startActivity('B-1');
    expect(localStorage.getItem(key(P2))).toBe(bad);
    expect(toast()).toBe(QW.notKept.en);
    expect(useStore.getState().queueUnreadable).toEqual({ keys: [key(P2)], failed: false });
    // the visit lane is readable: its act is saved there, and said to be
    useStore.getState().queueSiteVisitAct(offlineEnd, 'Visit saved on this phone');
    expect(toast()).toBe('Visit saved on this phone');
    expect(JSON.parse(localStorage.getItem(lane(P2)) ?? 'null')).toEqual([offlineEnd]);
    // a flush that cannot reach the server writes the queue back: the bad key is still not touched
    gw.startActivity.mockRejectedValue(new Error('network'));
    gw.endSiteVisit.mockRejectedValue(new Error('network'));
    useStore.setState({ online: true });
    await useStore.getState().flushOutbox();
    expect(gw.startActivity).toHaveBeenCalled();
    expect(localStorage.getItem(key(P2))).toBe(bad);
  });

  it('keeps a bad visit lane byte for byte, says a visit act was not kept, and still loads and saves the general key', () => {
    const bad = '{"t":"siteVisitEnd"}';
    onP2(JSON.stringify([start('B-1')]), bad);
    expect(useStore.getState().outbox).toEqual([start('B-1')]);
    useStore.getState().queueSiteVisitAct(offlineEnd, 'Visit saved on this phone');
    expect(localStorage.getItem(lane(P2))).toBe(bad);
    expect(toast()).toBe(QW.notKept.en);
    expect(useStore.getState().queueUnreadable).toEqual({ keys: [lane(P2)], failed: false });
    useStore.getState().startActivity('B-2');
    expect(toast()).not.toBe(QW.notKept.en);
    expect((JSON.parse(localStorage.getItem(key(P2)) ?? '[]') as { activityId: string }[]).map((o) => o.activityId)).toEqual(['B-1', 'B-2']);
  });

  it('shows the strip; Set aside copies the bytes, checks them, clears the key, and writes what was held in memory', async () => {
    const bad = '{not json';
    onP2(bad, null);
    useStore.getState().startActivity('B-1');
    render(<QueueUnreadable />);
    expect(screen.getByRole('alert').textContent).toContain(QW.unreadable.en);
    fireEvent.click(screen.getByRole('button', { name: QW.setAside.en }));
    const aside = Object.keys(localStorage).filter((k) => k.startsWith(`vitan.unreadable.${key(P2)}.`));
    expect(aside).toHaveLength(1);
    expect(localStorage.getItem(aside[0])).toBe(bad);
    expect(useStore.getState().queueUnreadable).toBeNull();
    expect(JSON.parse(localStorage.getItem(key(P2)) ?? 'null')).toEqual([expect.objectContaining({ t: 'startActivity', activityId: 'B-1' })]);
    expect(screen.queryByRole('alert')).toBeNull();
    // and the next act is saved, and said to be
    useStore.getState().startActivity('B-2');
    expect(toast()).not.toBe(QW.notKept.en);
  });

  it('a copy that fails, or does not read back the same, changes nothing and says so', () => {
    const bad = '{not json';
    for (const fault of ['quota', 'differs'] as const) {
      localStorage.clear();
      onP2(bad, null);
      const write = Storage.prototype.setItem;
      const read = Storage.prototype.getItem;
      const spies = [
        vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, k: string, v: string) {
          if (fault === 'quota' && k.startsWith('vitan.unreadable.')) throw new DOMException('full', 'QuotaExceededError');
          return write.call(this, k, v);
        }),
        vi.spyOn(Storage.prototype, 'getItem').mockImplementation(function (this: Storage, k: string) {
          if (fault === 'differs' && k.startsWith('vitan.unreadable.')) return 'something else';
          return read.call(this, k);
        }),
      ];
      useStore.getState().setAsideUnreadableQueue();
      spies.forEach((s) => s.mockRestore());
      expect(localStorage.getItem(key(P2))).toBe(bad);
      expect(useStore.getState().queueUnreadable).toEqual({ keys: [key(P2)], failed: true });
      render(<QueueUnreadable />);
      expect(screen.getByTestId('queue-unreadable-failed').textContent).toBe(QW.setAsideFailed.en);
      cleanup();
    }
  });

  it('publishing drawing drafts offline says "saved" only when the publishes were stored', async () => {
    for (const refuse of [false, true]) {
      localStorage.clear();
      onP2(null, null);
      useStore.setState({ decisions: [], drawings: [{ id: 'd-1', number: 'A-101', title: 'Plan', draft: true }] as never, drawingsLoad: 'ready' });
      const spy = refuse ? vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('full', 'QuotaExceededError'); }) : null;
      useStore.getState().publishAllDrafts();
      await vi.waitFor(() => expect(toast()).toBe(refuse ? QW.notKept.en : 'Saved — drawing drafts will publish when you reconnect.'));
      spy?.mockRestore();
    }
  });

  it('when storage refuses every write, an offline act is not kept and an online act still goes straight to the server', async () => {
    const gw = onP2(null, null);
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('full', 'QuotaExceededError'); });
    useStore.getState().startActivity('B-1');
    expect(toast()).toBe(QW.notKept.en);
    useStore.getState().queueSiteVisitAct(offlineEnd, 'Visit saved on this phone');
    expect(toast()).toBe(QW.notKept.en);
    useStore.setState({ online: true, outbox: [] });
    useStore.getState().startActivity('B-2');
    await vi.waitFor(() => expect(gw.startActivity).toHaveBeenCalledWith('B-2', expect.any(String)));
  });
});

describe('the scope change itself, before the new scope loads (WEB-02)', () => {
  const token = `h.${btoa(JSON.stringify({ sub: USER }))}.s`;
  const tkey = (project: string) => `vitan.outbox.${USER}.${project}`;
  /** signed in by token on P1, offline, P1's queue loaded; the server grants a switch to P2 */
  function signedInOnP1(stored: OutboxOp[]) {
    localStorage.setItem(tkey(P1), JSON.stringify(stored));
    useStore.setState({ ...getInitialState(), outbox: [], role: 'engineer', lang: 'en', sessionToken: token, sessionUserId: USER, activeProjectId: P1, online: false });
    const gw = { switchProject: vi.fn(async (projectId: string) => ({ role: 'engineer', token, projectId })), startActivity: vi.fn(async () => ({})) };
    useStore.getState()._setGateway(gw as unknown as ApiGateway);
    useStore.getState().hydrateOutbox();
    expect(useStore.getState().outbox).toEqual(stored);
    return gw;
  }

  it('the switch lets go of the previous queue at once, and nothing is written under the new key until it loads', async () => {
    signedInOnP1([start('A-1'), reserve]);
    expect(await useStore.getState().switchProject(P2)).toBe(true);
    // the server's answer has moved this tab to P2; useApiSync's load has not run yet
    expect(useStore.getState().activeProjectId).toBe(P2);
    expect(useStore.getState().outbox).toEqual([]);
    expect(useStore.getState().materialsPending).toEqual([]);
    useStore.getState().startActivity('B-1');
    expect(localStorage.getItem(tkey(P2))).toBeNull();
    expect(JSON.parse(localStorage.getItem(tkey(P1)) ?? 'null')).toEqual([start('A-1'), reserve]);
    // the load: what P2 stored, then the act made before it, now written under P2's key
    localStorage.setItem(tkey(P2), JSON.stringify([start('B-0')]));
    useStore.getState().hydrateOutbox();
    const ids = (k: string) => (JSON.parse(localStorage.getItem(k) ?? '[]') as { activityId: string }[]).map((o) => o.activityId);
    expect(useStore.getState().outbox.map((o) => (o as { activityId: string }).activityId)).toEqual(['B-0', 'B-1']);
    expect(ids(tkey(P2))).toEqual(['B-0', 'B-1']);
    expect(useStore.getState().queueUnkept).toEqual([]);
  });

  it('a switch with acts this phone did not keep asks first; Cancel stays, Continue switches and says how many were lost', async () => {
    const gw = signedInOnP1([]);
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('full', 'QuotaExceededError'); });
    useStore.getState().startActivity('A-2');
    expect(useStore.getState().toast).toBe(QW.notKept.en);
    expect(await useStore.getState().switchProject(P2)).toBe(false);
    expect(gw.switchProject).not.toHaveBeenCalled();
    render(<LeaveUnkept />);
    expect(screen.getByTestId('leave-unkept').textContent).toContain(QW.leaveTitle.en.replace('{n}', '1'));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(useStore.getState().leaveConfirm).toBeNull();
    expect(useStore.getState().activeProjectId).toBe(P1);
    expect(useStore.getState().outbox).toEqual([expect.objectContaining({ activityId: 'A-2' })]);
    act(() => { void useStore.getState().switchProject(P2); });
    fireEvent.click(screen.getByRole('button', { name: QW.leaveContinue.en }));
    await vi.waitFor(() => expect(useStore.getState().activeProjectId).toBe(P2));
    expect(gw.switchProject).toHaveBeenCalledWith(P2);
    expect(useStore.getState().outbox).toEqual([]);
    expect(useStore.getState().toast).toBe(QW.unkeptLost.en.replace('{n}', '1'));
  });

  it('sign-out with acts this phone did not keep asks first; with none it signs out at once', () => {
    signedInOnP1([]);
    const write = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('full', 'QuotaExceededError'); });
    useStore.getState().startActivity('A-2');
    write.mockRestore();
    useStore.getState().requestSignOut();
    expect(useStore.getState().leaveConfirm).toEqual({ action: 'signOut' });
    expect(useStore.getState().sessionToken).toBe(token);
    useStore.getState().confirmLeave();
    expect(useStore.getState().sessionToken).toBeNull();
    expect(useStore.getState().outbox).toEqual([]);
    expect(useStore.getState().toast).toBe(QW.unkeptLost.en.replace('{n}', '1'));
    // nothing unkept: no question
    signedInOnP1([start('A-1')]);
    useStore.getState().requestSignOut();
    expect(useStore.getState().leaveConfirm).toBeNull();
    expect(useStore.getState().sessionToken).toBeNull();
  });

  it('sign-out lets go of the queue, its list and its marks, and leaves the stored queue for the next sign-in', () => {
    signedInOnP1([start('A-1'), reserve]);
    localStorage.setItem(lane(P1), '{not json');
    useStore.setState({ syncQueue: ['Start A-1'], queueUnkept: ['k:k-x'] });
    useStore.getState().signOut();
    const s = useStore.getState();
    expect([s.outbox, s.syncQueue, s.queueUnkept, s.queueUnreadable, s.queueScope]).toEqual([[], [], [], null, null]);
    expect(JSON.parse(localStorage.getItem(tkey(P1)) ?? 'null')).toEqual([start('A-1'), reserve]);
  });
});

describe('a flush, a second tab and the day-log draft around an unreadable key (WEB-02)', () => {
  it('a flush that sees the scope move never writes a key listed when it began, nor one it cannot read now', async () => {
    const notAList = '{"t":"startActivity"}';
    for (const other of ['untouched', 'rewritten', 'broken mid-flush'] as const) {
      localStorage.clear();
      // listed at load, or (the third case) readable at load and broken by another tab during the flush
      localStorage.setItem(key(P1), other === 'broken mid-flush' ? '[]' : notAList);
      useStore.setState({ ...getInitialState(), outbox: [], role: 'engineer', lang: 'en', sessionUserId: USER, activeProjectId: P1, online: false });
      let fail!: (e: Error) => void;
      const gw = { ...gateway(P1), startActivity: vi.fn(() => new Promise((_, reject) => { fail = reject; })) };
      useStore.getState()._setGateway(gw as unknown as ApiGateway);
      useStore.getState().hydrateOutbox();
      expect(useStore.getState().queueUnreadable?.keys ?? []).toEqual(other === 'broken mid-flush' ? [] : [key(P1)]);
      useStore.getState().startActivity('B-1');
      useStore.setState({ online: true });
      const flushing = useStore.getState().flushOutbox();
      await vi.waitFor(() => expect(gw.startActivity).toHaveBeenCalled());
      // the other tab: sets the bad bytes aside and queues its own act, or writes bytes this tab cannot read
      const theirs = other === 'rewritten' ? JSON.stringify([start('X-1')]) : notAList;
      if (other !== 'untouched') localStorage.setItem(key(P1), theirs);
      switchTo(P2); // P2's keys read, so the list now is P2's (empty)
      expect(useStore.getState().queueUnreadable).toBeNull();
      fail(new TypeError('Failed to fetch'));
      await flushing;
      expect(localStorage.getItem(key(P1))).toBe(theirs);
    }
  });

  it('Set aside leaves a key another tab has already set aside or rewritten, and loads what it holds', () => {
    for (const other of ['rewritten', 'removed'] as const) {
      localStorage.clear();
      localStorage.setItem(key(P2), '{not json');
      useStore.setState({ ...getInitialState(), outbox: [], role: 'engineer', lang: 'en', sessionUserId: USER, activeProjectId: P2, online: false });
      useStore.getState()._setGateway(gateway(P2) as unknown as ApiGateway);
      useStore.getState().hydrateOutbox();
      useStore.getState().startActivity('B-1'); // held, not kept
      // the other tab: set the bad bytes aside and queued an act of its own, or set them aside only
      if (other === 'rewritten') localStorage.setItem(key(P2), JSON.stringify([start('X-1')]));
      else localStorage.removeItem(key(P2));
      useStore.getState().setAsideUnreadableQueue();
      expect(Object.keys(localStorage).filter((k) => k.startsWith('vitan.unreadable.'))).toEqual([]);
      expect(useStore.getState().queueUnreadable).toBeNull();
      const want = other === 'rewritten' ? ['X-1', 'B-1'] : ['B-1'];
      expect(useStore.getState().outbox.map((o) => (o as { activityId: string }).activityId)).toEqual(want);
      expect((JSON.parse(localStorage.getItem(key(P2)) ?? '[]') as { activityId: string }[]).map((o) => o.activityId)).toEqual(want);
      expect(useStore.getState().queueUnkept).toEqual([]);
    }
  });

  it('a day-log draft key that cannot be read is listed, never written or removed, and can be set aside', () => {
    const draftKey = `vitan.dailyLogDraft.anon.${P2}`; // dev auth: no token, so the anonymous draft scope
    const bad = '{"projectId":';
    localStorage.setItem(draftKey, bad);
    useStore.setState({ ...getInitialState(), outbox: [], role: 'engineer', lang: 'en', sessionUserId: USER, activeProjectId: P2, online: false });
    useStore.getState()._setGateway(gateway(P2) as unknown as ApiGateway);
    useStore.getState().hydrateOutbox();
    expect(useStore.getState().queueUnreadable?.keys).toEqual([draftKey]);
    // a write of the (empty) draft would remove it; the queue keys still save
    useStore.getState().discardLegacyDailyLogDraft();
    useStore.getState().startActivity('B-1');
    expect(localStorage.getItem(draftKey)).toBe(bad);
    expect(useStore.getState().toast).not.toBe(QW.notKept.en);
    useStore.getState().setAsideUnreadableQueue();
    expect(useStore.getState().queueUnreadable).toBeNull();
    const aside = Object.keys(localStorage).filter((k) => k.startsWith(`vitan.unreadable.${draftKey}.`));
    expect(aside.map((k) => localStorage.getItem(k))).toEqual([bad]);
    expect(localStorage.getItem(draftKey)).toBeNull();
  });
});

describe('a flush, a Set aside and a load that overlap, and acts kept elsewhere (WEB-02 r3)', () => {
  const bad = '{not json';
  const endV: OutboxOp = { t: 'siteVisitEnd', visitId: 'v-9', claimedAt: '2026-10-14T06:00:00.000Z', idempotencyKey: 'k-end-9' };
  const ids = () => useStore.getState().outbox.map((o) => (o as { idempotencyKey: string }).idempotencyKey);
  /** what the server answers a sent act with: P2's snapshot */
  const snap = () => ({
    project: { id: P2, name: P2, short: P2, descriptor: '', stage: '', siteCode: '', location: '', projStart: '', projEnd: '', elapsedPct: 0, todayDay: 0, milestonePct: 0 },
    decisions: [], activities: [], placedInspections: [], checklist: null, reviews: [], review: null, reinspectionCreated: false,
    drawings: [], phases: [], dailyLog: null, notifications: [], companies: [], nodes: [], photos: [], materials: [],
  });
  const storedIds = (k: string) => (JSON.parse(localStorage.getItem(k) ?? '[]') as { idempotencyKey: string }[]).map((o) => o.idempotencyKey);
  /** on P2 with its visit lane unreadable: G1 stored, a visit act held only in memory, and G1 being sent when G2 is
   *  made offline and Set aside is tapped */
  async function setAsideMidSend() {
    localStorage.setItem(lane(P2), bad);
    useStore.setState({ ...getInitialState(), outbox: [], role: 'engineer', lang: 'en', sessionUserId: USER, activeProjectId: P2, online: false });
    let settle!: (ok: boolean) => void;
    const gw = {
      project: P2,
      startActivity: vi.fn((id: string, _key?: string) => (id === 'G1' ? new Promise((done, fail) => { settle = (ok) => (ok ? done(snap()) : fail(new TypeError('Failed to fetch'))); }) : Promise.resolve(snap()))),
      endSiteVisit: vi.fn(async () => ({ id: 'v-9', status: 'ended' })),
      listSiteVisits: vi.fn(async () => []),
    };
    useStore.getState()._setGateway(gw as unknown as ApiGateway);
    useStore.getState().hydrateOutbox();
    useStore.getState().startActivity('G1');
    useStore.getState().queueSiteVisitAct(endV, 'saved');
    const g1 = ids()[0];
    useStore.setState({ online: true });
    const flushing = useStore.getState().flushOutbox();
    await vi.waitFor(() => expect(gw.startActivity).toHaveBeenCalled());
    // the signal drops: G2 is made, and said to be saved
    useStore.setState({ online: false });
    useStore.getState().startActivity('G2');
    const g2 = ids().find((k) => k !== g1 && k !== 'k-end-9')!;
    expect(storedIds(key(P2))).toEqual([g1, g2]);
    useStore.getState().setAsideUnreadableQueue();
    expect(ids()).toEqual([g1, g2, 'k-end-9']);
    return { gw, settle, flushing, g1, g2 };
  }

  it('Set aside while a send is out, the send succeeding: the act made meanwhile stays queued and stored, and nothing sent comes back', async () => {
    const { gw, settle, flushing, g1, g2 } = await setAsideMidSend();
    settle(true);
    await flushing;
    expect(gw.startActivity.mock.calls.map((c) => c[1])).toEqual([g1]);
    expect(ids()).toEqual([g2]);
    expect(storedIds(key(P2))).toEqual([g2]);
    expect(storedIds(lane(P2))).toEqual([]);
  });

  it('Set aside while a send is out, the send failing: every act is queued once, and stored once', async () => {
    const { settle, flushing, g1, g2 } = await setAsideMidSend();
    settle(false);
    await flushing;
    // the acts the failed send took go back ahead of the one made during it, in the order they were made
    expect(ids()).toEqual([g1, 'k-end-9', g2]);
    expect(storedIds(key(P2))).toEqual([g1, g2]);
    expect(storedIds(lane(P2))).toEqual(['k-end-9']);
  });

  it('a load during a send keeps what another tab stored before the sent act, and does not queue the sent act again', async () => {
    useStore.setState({ ...getInitialState(), outbox: [], role: 'engineer', lang: 'en', sessionUserId: USER, activeProjectId: P2, online: false });
    let done!: () => void;
    const gw = { project: P2, startActivity: vi.fn(() => new Promise((r) => { done = () => r(snap()); })), listSiteVisits: vi.fn(async () => []) };
    useStore.getState()._setGateway(gw as unknown as ApiGateway);
    useStore.getState().hydrateOutbox();
    useStore.getState().startActivity('X');
    const x = ids()[0];
    useStore.setState({ online: true });
    const flushing = useStore.getState().flushOutbox();
    await vi.waitFor(() => expect(gw.startActivity).toHaveBeenCalled());
    // memory lets go and loads again (the carry), and another tab has stored B-0 ahead of X
    localStorage.setItem(key(P2), JSON.stringify([start('B-0'), { t: 'startActivity', activityId: 'X', idempotencyKey: x }]));
    useStore.setState({ queueScope: null });
    useStore.getState().hydrateOutbox();
    done();
    await flushing;
    expect(ids()).toEqual(['k-B-0']);
    expect(storedIds(key(P2))).toEqual(['k-B-0']);
  });

  it('a visit photo kept in the phone\'s database is never counted as not kept, nor said to be, whether or not the visit lane reads', () => {
    const photo = { t: 'siteVisitAddFile', visitId: 'v-9', idempotencyKey: 'k-ph', scope: USER, file: { id: 'f-1', mime: 'image/jpeg' }, by: { name: '', role: 'engineer' }, placeName: null, queuedAt: 0 } as unknown as OutboxOp;
    for (const visits of [null, bad]) {
      localStorage.clear();
      if (visits) localStorage.setItem(lane(P2), visits);
      useStore.setState({ ...getInitialState(), outbox: [], role: 'engineer', lang: 'en', sessionUserId: USER, activeProjectId: P2, online: false });
      useStore.getState()._setGateway({ project: P2, listSiteVisits: vi.fn(async () => []) } as unknown as ApiGateway);
      useStore.getState().hydrateOutbox();
      useStore.getState().queueSiteVisitAct(photo, 'Photo saved on this phone');
      expect(useStore.getState().toast).toBe('Photo saved on this phone');
      expect(useStore.getState().queueUnkept).toEqual([]);
    }
  });

  it('a load of the same project keeps the acts this phone did not keep, still marked, and stores them once it can', () => {
    const gw = onP1WithQueue();
    void gw;
    const write = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('full', 'QuotaExceededError'); });
    useStore.getState().startActivity('A-2');
    expect(useStore.getState().queueUnkept).toHaveLength(1);
    // the same project loads again (a sign-in again), storage still full: the act stays, still marked
    useStore.getState().hydrateOutbox();
    expect(useStore.getState().outbox.map((o) => (o as { activityId?: string }).activityId)).toEqual(['A-1', undefined, 'A-2']);
    expect(useStore.getState().queueUnkept).toHaveLength(1);
    // and once storage takes writes, the next load stores it
    write.mockRestore();
    useStore.getState().hydrateOutbox();
    expect(useStore.getState().queueUnkept).toEqual([]);
    expect((JSON.parse(localStorage.getItem(key(P1)) ?? '[]') as { activityId: string }[]).map((o) => o.activityId)).toEqual(['A-1', 'A-2']);
  });

  it('Set aside keeps a visit photo ahead of its visit’s close, though the close was not kept and the photo was', () => {
    const photo = { t: 'siteVisitAddFile', visitId: 'v-9', idempotencyKey: 'k-ph', scope: USER, file: { id: 'f-1', mime: 'image/jpeg' }, by: { name: '', role: 'engineer' }, placeName: null, queuedAt: 0 } as unknown as OutboxOp;
    localStorage.setItem(lane(P2), bad);
    useStore.setState({ ...getInitialState(), outbox: [], role: 'engineer', lang: 'en', sessionUserId: USER, activeProjectId: P2, online: false });
    useStore.getState()._setGateway({ project: P2, listSiteVisits: vi.fn(async () => []) } as unknown as ApiGateway);
    useStore.getState().hydrateOutbox();
    useStore.getState().queueSiteVisitAct(photo, 'Photo saved on this phone');
    useStore.getState().queueSiteVisitAct(endV, 'saved');
    expect(useStore.getState().queueUnkept).toEqual(['k:k-end-9']);
    useStore.getState().setAsideUnreadableQueue();
    expect(ids()).toEqual(['k-ph', 'k-end-9']);
    expect(storedIds(lane(P2))).toEqual(['k-end-9']);
    expect(useStore.getState().queueUnkept).toEqual([]);
  });

  it('a load of the same project holds an act it did not keep once, when another tab has stored it meanwhile', () => {
    onP1WithQueue();
    const write = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('full', 'QuotaExceededError'); });
    useStore.getState().startActivity('A-2');
    write.mockRestore();
    const a2 = useStore.getState().outbox.find((o) => (o as { activityId?: string }).activityId === 'A-2')!;
    expect(useStore.getState().queueUnkept).toEqual([`k:${(a2 as { idempotencyKey: string }).idempotencyKey}`]);
    // another tab stores the same act (it took it in from this tab's memory as it was sent to it)
    const theirs = JSON.parse(localStorage.getItem(key(P1)) ?? '[]') as unknown[];
    localStorage.setItem(key(P1), JSON.stringify([...theirs, a2]));
    useStore.getState().hydrateOutbox();
    expect(useStore.getState().outbox.filter((o) => (o as { activityId?: string }).activityId === 'A-2')).toHaveLength(1);
    expect(useStore.getState().queueUnkept).toEqual([]);
  });

  it('Set aside keeps a kept-aside day-log draft held while its key could not be read', () => {
    const legacyKey = `vitan.dailyLogDraft.legacy.anon.${P2}`;
    localStorage.setItem(legacyKey, '{"projectId":');
    useStore.setState({ ...getInitialState(), outbox: [], role: 'engineer', lang: 'en', sessionUserId: USER, activeProjectId: P2, online: false });
    useStore.getState()._setGateway(gateway(P2) as unknown as ApiGateway);
    useStore.getState().hydrateOutbox();
    expect(useStore.getState().queueUnreadable?.keys).toEqual([legacyKey]);
    const kept = { projectId: P2, note: 'kept aside while unreadable' } as never;
    useStore.setState({ legacyDailyLogDraft: kept });
    useStore.getState().setAsideUnreadableQueue();
    expect(useStore.getState().queueUnreadable).toBeNull();
    expect(useStore.getState().legacyDailyLogDraft).toEqual(kept);
  });

  it('Set aside keeps a day-log draft typed while its key could not be read, and stores it', () => {
    const draftKey = `vitan.dailyLogDraft.anon.${P2}`;
    localStorage.setItem(draftKey, '{"projectId":');
    useStore.setState({ ...getInitialState(), outbox: [], role: 'engineer', lang: 'en', sessionUserId: USER, activeProjectId: P2, online: false });
    useStore.getState()._setGateway(gateway(P2) as unknown as ApiGateway);
    useStore.getState().hydrateOutbox();
    const typed = { projectId: P2, note: 'typed while unreadable' } as never;
    useStore.setState({ dailyLogDraft: typed });
    useStore.getState().setAsideUnreadableQueue();
    expect(useStore.getState().dailyLogDraft).toEqual(typed);
    expect(JSON.parse(localStorage.getItem(draftKey) ?? 'null')).toEqual(typed);
  });

  it('between a switch and its load, the day-log draft of the project switched to is never written or removed', async () => {
    const token = `h.${btoa(JSON.stringify({ sub: USER }))}.s`;
    const draftKey = `vitan.dailyLogDraft.${USER}.${P2}`;
    const theirs = JSON.stringify({ projectId: P2, note: 'kept on P2' });
    localStorage.setItem(draftKey, theirs);
    useStore.setState({ ...getInitialState(), outbox: [], role: 'engineer', lang: 'en', sessionToken: token, sessionUserId: USER, activeProjectId: P1, online: false });
    useStore.getState()._setGateway({ switchProject: vi.fn(async (projectId: string) => ({ role: 'engineer', token, projectId })) } as unknown as ApiGateway);
    useStore.getState().hydrateOutbox();
    expect(await useStore.getState().switchProject(P2)).toBe(true);
    expect(useStore.getState().queueScope).toBeNull();
    // memory holds no draft: a draft write now would remove P2's
    useStore.getState().discardLegacyDailyLogDraft();
    expect(localStorage.getItem(draftKey)).toBe(theirs);
  });
});
